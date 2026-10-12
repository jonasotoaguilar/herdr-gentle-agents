#!/usr/bin/env node
'use strict';

// Gentle status consumer daemon: snapshot → reduce → sidebar tokens.
//
// Polls `agent list`, reduces each pane with lib/gentle-tokens.js (DESIGN
// §5.2), publishes the owned `gentle_*` family (chunked ≤ 16 per report),
// notifies ask exactly once per intentId (DESIGN §7), and sweeps only its
// own token names on handover/uninstall (DESIGN §3 O5).
//
// Usage:
//   node bin/gentle-status.js          ensure the daemon is running
//   node bin/gentle-status.js --run    BE the daemon (Herdr [[startup]])
//   node bin/gentle-status.js --once   single frame, then exit (debugging)
//   node bin/gentle-status.js --stop   stop the daemon (scoped sweep of live
//   node bin/gentle-status.js --stop --purge   also clear every owned token
//                                      plus the notification ledger)
//
// Transport mirrors herdr-pi-tree lib/ipc.js + lib/herdr.js: socket calls
// with one CLI fallback each, so a misbehaving socket degrades to slow, not
// broken. A failed snapshot is "no data", never "empty": nothing is
// published, notified, or swept on a failed read.

var MIN_MAJOR = 18;
var major = Number(String(process.versions.node).split('.')[0]);
if (major < MIN_MAJOR) {
  process.stderr.write(
    'herdr-gentle-agents: Node ' + MIN_MAJOR + ' or newer is required (running ' + process.versions.node + ').\n',
  );
  process.exit(1);
}

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const contract = require('../lib/gentle-tokens');

// This daemon's token source tag. The producer extension reports under
// `gentle:v1`; the daemon writes under the plugin convention
// `plugin:<id>` (same as herdr-pi-tree's herdr.source()), so a clear
// touches only this writer's tokens even where names collide.
const PLUGIN_ID = 'herdr-gentle-agents';
const SOURCE = `plugin:${process.env.HERDR_PLUGIN_ID ?? PLUGIN_ID}`;

// DESIGN §10 U2 is unresolved (no normative cadence); the provisional poll
// is comfortably below the 60 s token TTL and the producer's 15 s beat so
// every beat is observed at least once. Env-overridable, documented here
// rather than normatively fixed. P1 adaptive poll: the loop idles at the
// baseline cadence and drops to a fast cycle while recent ask activity or
// send/publish failures are observed, recovering after N quiet frames or
// when the TTL-bounded fast window expires. Single setTimeout chain with a
// dynamic delay — never a busy loop, never setInterval.
const POLL_MS = Number(process.env.GENTLE_STATUS_POLL_MS ?? 10000) || 10000;
const POLL_MIN_MS = 250;

function toPollMs(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

// Pure and env-injectable so tests can assert overrides without reloading
// the module or touching live timers. fastMs is clamped to <= baselineMs
// so a misconfigured fast value can never poll faster than intended.
function resolvePollConfig(env = process.env) {
  const baselineMs = Math.max(POLL_MIN_MS, toPollMs(env?.GENTLE_STATUS_POLL_MS, 10000));
  const fastMs = Math.max(
    POLL_MIN_MS,
    Math.min(toPollMs(env?.GENTLE_STATUS_FAST_POLL_MS, 2000), baselineMs),
  );
  const quietFrames = Math.min(
    100,
    Math.max(1, toPollMs(env?.GENTLE_STATUS_FAST_QUIET_FRAMES, 3)),
  );
  const windowMs = Math.max(POLL_MIN_MS, toPollMs(env?.GENTLE_STATUS_FAST_WINDOW_MS, 60000));
  return { baselineMs, fastMs, quietFrames, windowMs };
}

function createPollState() {
  return { fastUntil: 0, quietFrames: 0 };
}

function createPollStateObserved() {
  return { askActivity: false, failure: false };
}

// Decide the next loop delay and advance pollState. Any ask activity or
// send/publish failure (re)arms the TTL-bounded fast window; N consecutive
// quiet frames inside the window recover to baseline early.
function nextPollDelay(pollState, now, observed = {}, config = resolvePollConfig()) {
  if (observed.askActivity || observed.failure) {
    pollState.fastUntil = now + config.windowMs;
    pollState.quietFrames = 0;
  } else if (pollState.fastUntil > now) {
    pollState.quietFrames += 1;
    if (pollState.quietFrames >= config.quietFrames) {
      pollState.fastUntil = 0;
      pollState.quietFrames = 0;
    }
  } else {
    pollState.fastUntil = 0;
    pollState.quietFrames = 0;
  }
  return pollState.fastUntil > now ? config.fastMs : config.baselineMs;
}
const MAX_TOKENS_PER_REPORT = 16;
const SOCKET_TIMEOUT_MS = 4000;
const CLI_TIMEOUT_MS = 5000;
const MAX_IN_FLIGHT = 16;

// DESIGN §5.3 pull marker: behind-upstream count per pane cwd, read from
// fixed-argv `git status --porcelain=2 --branch` ONLY (the `# branch.ab`
// line). No shell, no diff, no fetch. Bounded: 2 s timeout, 64 KiB cap,
// short-TTL per-cwd cache (default 30 s, env-overridable) with in-frame
// dedupe via the same cache, so N panes in one worktree cost ~1 git call
// per TTL window. Any failure (no cwd, no git, no upstream, timeout)
// resolves to 0 — fail-closed, the marker simply stays absent.
const PULL_TTL_MS = Number(process.env.GENTLE_PULL_TTL_MS ?? 30000) || 30000;
const PULL_CACHE_MAX = 128;
const pullCache = new Map(); // cwd -> { behind, at }

function branchBehind(cwd) {
  const now = Date.now();
  if (typeof cwd === 'string' && cwd.length > 0) {
    const hit = pullCache.get(cwd);
    if (hit && now - hit.at < PULL_TTL_MS) return hit.behind;
  }
  let behind = 0;
  try {
    if (typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 4096) {
      const result = spawnSync(
        'git',
        ['--no-optional-locks', '-c', 'core.fsmonitor=false', 'status', '--porcelain=2', '--branch', '--untracked-files=no'],
        { cwd, encoding: 'utf8', timeout: 2000, maxBuffer: 64 * 1024, windowsHide: true },
      );
      if (result.status === 0 && typeof result.stdout === 'string') {
        const ab = /^# branch\.ab \+(\d+) -(\d+)$/m.exec(result.stdout);
        if (ab) behind = Number(ab[2]) || 0;
      }
    }
  } catch {
    behind = 0;
  }
  if (typeof cwd === 'string' && cwd.length > 0) {
    if (pullCache.size >= PULL_CACHE_MAX) pullCache.clear();
    pullCache.set(cwd, { behind, at: now });
  }
  return behind;
}

function pullMarkerFor(entry) {
  const foreground = entry?.foreground_cwd;
  const base = entry?.cwd;
  const cwd =
    typeof foreground === 'string' && foreground.length > 0
      ? foreground
      : typeof base === 'string'
        ? base
        : '';
  const behind = branchBehind(cwd);
  return behind > 0 ? `↑${behind}` : '';
}

const DEBUG = process.env.GENTLE_STATUS_DEBUG === '1';
function debug(...args) {
  if (DEBUG) console.error('[gentle-status]', ...args);
}

/* ------------------------------------------------------------ paths */

function herdrConfigPath() {
  if (process.env.HERDR_CONFIG_PATH) return path.resolve(process.env.HERDR_CONFIG_PATH);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'herdr', 'config.toml');
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : path.join(os.homedir(), '.config');
  return path.join(base, 'herdr', 'config.toml');
}

function herdrStateDir() {
  if (process.env.XDG_STATE_HOME) return path.join(process.env.XDG_STATE_HOME, 'herdr');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'herdr');
  }
  return path.join(os.homedir(), '.local', 'state', 'herdr');
}

function stateRoot() {
  const dir =
    process.env.GENTLE_STATUS_STATE_DIR ??
    process.env.HERDR_PLUGIN_STATE_DIR ??
    path.join(herdrStateDir(), 'plugins', PLUGIN_ID);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Callers degrade rather than crash; ledger/pid writes are best-effort.
  }
  return dir;
}

const PID_FILE = () => path.join(stateRoot(), 'gentle-status.pid');
const LEDGER_FILE = () => path.join(stateRoot(), 'gentle-status-notified.json');
const ERR_FILE = () => path.join(stateRoot(), 'gentle-status.err');

function logError(error) {
  try {
    try {
      if (fs.statSync(ERR_FILE()).size > 256 * 1024) fs.truncateSync(ERR_FILE(), 0);
    } catch {
      // No log yet.
    }
    fs.appendFileSync(ERR_FILE(), `${new Date().toISOString()} ${error?.stack ?? error}\n`, 'utf8');
  } catch {
    // Logging must never take the daemon down.
  }
}

/* ------------------------------------------------------------ transport */

function pipePath() {
  const sock =
    process.env.HERDR_SOCKET_PATH ?? path.join(path.dirname(herdrConfigPath()), 'herdr.sock');
  return process.platform === 'win32' ? `\\\\.\\pipe\\${sock}` : sock;
}

function rawSocketCall(method, params) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        stream.destroy();
      } catch {
        // Already gone.
      }
      resolve(value);
    };
    let stream;
    try {
      stream = net.connect({ path: pipePath() });
    } catch {
      resolve(null);
      return;
    }
    let body = '';
    stream.setTimeout(SOCKET_TIMEOUT_MS, () => finish(null));
    stream.on('error', () => finish(null));
    stream.on('connect', () => {
      try {
        stream.write(`${JSON.stringify({ id: 'gentle-status', method, params })}\n`);
      } catch {
        finish(null);
      }
    });
    stream.on('data', (chunk) => {
      body += chunk;
      if (body.indexOf('\n') < 0) return;
      try {
        finish(JSON.parse(body.slice(0, body.indexOf('\n'))));
      } catch {
        finish(null);
      }
    });
  });
}

let inFlight = 0;
const waiters = [];

async function socketCall(method, params) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((wake) => waiters.push(wake));
  inFlight += 1;
  try {
    return await rawSocketCall(method, params);
  } finally {
    inFlight -= 1;
    const wake = waiters.shift();
    if (wake) wake();
  }
}

function binary() {
  return process.env.HERDR_BIN_PATH ?? 'herdr';
}

function cliJson(...args) {
  try {
    const result = spawnSync(binary(), args, {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || !result.stdout?.trim()) return null;
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

// Null on failure, not an empty list: acting on nothing-as-empty would clear
// tokens and fire (or skip) notifications over one timed-out read.
async function agentsAsync() {
  const reply = await socketCall('agent.list', {});
  if (reply && !reply.error && Array.isArray(reply.result?.agents)) return reply.result.agents;
  return cliJson('agent', 'list')?.result?.agents ?? null;
}

async function panesAsync() {
  const reply = await socketCall('pane.list', {});
  if (reply && !reply.error && Array.isArray(reply.result?.panes)) return reply.result.panes;
  return cliJson('pane', 'list')?.result?.panes ?? [];
}

function tokenPatch(tokens) {
  const patch = {};
  for (const [name, value] of Object.entries(tokens)) patch[name] = value ?? null;
  return patch;
}

function reportMetadataCli(paneId, source, tokens) {
  const args = ['pane', 'report-metadata', paneId, '--source', source];
  for (const [name, value] of Object.entries(tokens)) {
    if (value === null || value === undefined) args.push('--clear-token', name);
    else args.push('--token', `${name}=${value}`);
  }
  return cliJson(...args) !== null;
}

async function reportMetadataAsync(paneId, source, tokens) {
  const reply = await socketCall('pane.report_metadata', {
    pane_id: paneId,
    source,
    tokens: tokenPatch(tokens),
  });
  if (reply) return !reply.error;
  return reportMetadataCli(paneId, source, tokens);
}

async function reportChunked(source, paneId, tokens) {
  const names = Object.keys(tokens);
  const jobs = [];
  for (let at = 0; at < names.length; at += MAX_TOKENS_PER_REPORT) {
    const patch = {};
    for (const name of names.slice(at, at + MAX_TOKENS_PER_REPORT)) patch[name] = tokens[name];
    jobs.push(reportMetadataAsync(paneId, source, patch));
  }
  return (await Promise.all(jobs)).every(Boolean);
}

// DESIGN §7 + §10 U1: the consumer-side ¬ask→ask transition gate is the
// normative dedup mechanism (Herdr-side dedup is unconfirmed). `herdr
// notification show` flags verified against the installed CLI; review and
// error transitions never call this. Visible copy is the fixed title
// `Gentle needs response` plus a body naming the project
// (`<project> needs your input. Return to Pi to respond.`). The name comes
// from the snapshot's validated workspace group only — never a cwd-derived
// path segment, pane/intent ids, session material, or token values.
//
// P2 non-blocking send: async spawn with a bounded kill timeout, resolved
// true only on exit 0. Callers dispatch sends in agent-list order (one
// flight per intent key, tracked in state.pendingNotify) and run them
// concurrently with metadata publishes; the ledger is written only in the
// completion callback on observed success, so a slow or hanging notify
// binary can never head-of-line block sibling panes. paneId/intentId are
// accepted for call-site symmetry (as before); they never enter argv.
//
// Project name for the ask toast: the snapshot's validated workspace/group
// name only, sanitized and bounded, failing closed to `Gentle`. The
// cwd-derived fallback the sidebar uses is deliberately NOT used here: a
// desktop toast outlives the terminal (notification history, lock screen),
// so it never carries a path segment.
function askProjectName(entry) {
  const group = entry?.group;
  if (typeof group === 'string') {
    const clean = group.replace(/[\x00-\x1f\x7f-\x9f]/g, '').trim().slice(0, 64);
    if (clean) return clean;
  }
  return 'Gentle';
}

// Shared notification copy (DESIGN §7). One place builds the strings so the
// Herdr toast names the snapshot's validated workspace/group name only,
// sanitized and bounded by askProjectName, failing closed to `Gentle`.
function askNotifyCopy(project) {
  const projectName = typeof project === 'string' && project.length > 0 ? project : 'Gentle';
  return { title: 'Gentle needs response', body: `${projectName} needs your input. Return to Pi to respond.` };
}

function notifyAskAsync(paneId, intentId, project, timeoutMs = CLI_TIMEOUT_MS) {
  const copy = askNotifyCopy(project);
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        if (child) child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
      resolve(false);
    }, timeoutMs);
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    try {
      child = spawn(
        binary(),
        ['notification', 'show', copy.title, '--body', copy.body, '--sound', 'request'],
        { windowsHide: true, stdio: 'ignore' },
      );
    } catch {
      finish(false);
      return;
    }
    child.on('error', () => finish(false));
    child.on('close', (code) => finish(code === 0));
  });
}

/* ------------------------------------------------------------ ledger */

function loadLedger() {
  try {
    const raw = fs.readFileSync(LEDGER_FILE(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Missing or corrupt: start empty (a corrupt ledger may re-fire one
    // notification per intent; it never suppresses a new intent).
  }
  return {};
}

function saveLedger(ledger) {
  try {
    fs.writeFileSync(LEDGER_FILE(), JSON.stringify(ledger), 'utf8');
  } catch {
    // Best-effort: the in-memory ledger still dedups for this run.
  }
}

/* ------------------------------------------------------------ frame */

const lastSent = new Map(); // paneId -> JSON of last published family

// Single scoped sweeper (R3-orphan + R4-live-loop): the owned gentle_*
// family only, cleared under this daemon's own source tag. Foreign tokens
// (pi-tree, native, other plugins) are never touched. All sweep paths —
// per-frame departed-pane sweep, shutdown sweep, --stop handover/purge —
// go through clearOwnedFamily; no duplicated clear logic.
function ownedClearPatch() {
  const clear = {};
  for (const name of contract.SWEEP_TOKENS) clear[name] = null;
  return clear;
}

async function clearOwnedFamily(paneId) {
  lastSent.delete(paneId);
  return reportChunked(SOURCE, paneId, ownedClearPatch());
}

async function frame(state, opts = {}) {
  if (!(state.pendingNotify instanceof Map)) state.pendingNotify = new Map();
  // Daemon loop passes waitForNotify:false so the frame returns once
  // publishes land; --once (tests/debugging) drains in-flight sends for a
  // deterministic ledger. Either way the sends below never gate publishes.
  const waitForNotify = opts.waitForNotify !== false;
  const now = Date.now();
  if (state.pollObserved) {
    state.pollObserved.askActivity = false;
    state.pollObserved.failure = false;
  }
  const agents = await agentsAsync();
  if (agents === null) {
    debug('snapshot failed; skipping frame');
    if (waitForNotify && state.pendingNotify.size > 0) {
      await Promise.all([...state.pendingNotify.values()]);
      if (state.ledgerDirty) {
        saveLedger(state.ledger);
        state.ledgerDirty = false;
      }
    }
    return;
  }
  const askSessions = new Set();
  const live = new Set();
  // P2 dispatch: one flight per intent key, launched in agent-list order
  // (per-intent ordering preserved), concurrent with the publishes below.
  // Ledger write happens only in the completion callback on observed
  // success; a failed send leaves no ledger entry and retries next frame.
  // Dispatch itself counts as ask activity so P1 fast-cycle timing is
  // unchanged by send latency.
  const publishJobs = [];
  for (const entry of agents) {
    const paneId = entry?.pane_id;
    if (typeof paneId !== 'string') continue;
    live.add(paneId);
    const reduced = contract.reducePane(entry, now);
    if (!reduced.owned) {
      debug(`pane ${paneId}: pi-tree owns; yielding`);
      continue;
    }
    // Behind-upstream marker, resolved per cwd with TTL dedupe (no storm
    // across panes sharing a worktree). Absent on any failure.
    reduced.pull = pullMarkerFor(entry);
    if (reduced.display === 'ask' && reduced.notify) {
      askSessions.add(reduced.notify.sessionHash);
      const key = `${reduced.notify.sessionHash}:${reduced.notify.intentId}`;
      if (state.ledger[key]) {
        if (state.pollObserved) state.pollObserved.askActivity = true;
      } else if (state.pendingNotify.has(key)) {
        // Still asking (already notified): recent ask activity keeps the
        // fast cycle armed without re-firing the exactly-once toast.
        if (state.pollObserved) state.pollObserved.askActivity = true;
      } else {
        if (state.pollObserved) state.pollObserved.askActivity = true;
        const expiry = reduced.notify.expiry;
        const send = notifyAskAsync(paneId, reduced.notify.intentId, askProjectName(entry)).then(
          (ok) => {
            state.pendingNotify.delete(key);
            if (ok) {
              state.ledger[key] = { expiry };
              state.ledgerDirty = true;
              saveLedger(state.ledger);
              state.ledgerDirty = false;
              if (state.pollObserved) state.pollObserved.askActivity = true;
              debug(`notified ask ${key} on ${paneId}`);
            } else {
              if (state.pollObserved) state.pollObserved.failure = true;
              debug(`notify failed for ask ${key}; will retry next frame`);
            }
            return ok;
          },
          () => {
            state.pendingNotify.delete(key);
            if (state.pollObserved) state.pollObserved.failure = true;
            debug(`notify failed for ask ${key}; will retry next frame`);
            return false;
          },
        );
        state.pendingNotify.set(key, send);
        debug(`dispatching ask notify ${key} on ${paneId}`);
      }
    }
    const patch = contract.displayTokens(reduced);
    const signature = JSON.stringify(patch);
    if (lastSent.get(paneId) === signature) continue;
    publishJobs.push({ paneId, patch, signature });
  }
  // Publishes race the in-flight sends above: sibling panes and metadata
  // are never head-of-line blocked behind a slow notify binary.
  const publishResults = await Promise.all(
    publishJobs.map(async (job) => ({ job, ok: await reportChunked(SOURCE, job.paneId, job.patch) })),
  );
  for (const { job, ok } of publishResults) {
    if (ok) lastSent.set(job.paneId, job.signature);
    else {
      if (state.pollObserved) state.pollObserved.failure = true;
      debug(`publish failed for pane ${job.paneId}; will retry next frame`);
    }
  }
  // An intent re-arms only via a NEW intentId: ledger entries persist past
  // token TTL and are forgotten when their session is no longer asking (or
  // vanishes), so a re-asserted same intent is continuation (silent).
  let pruned = false;
  for (const key of Object.keys(state.ledger)) {
    const sessionHash = key.slice(0, key.indexOf(':'));
    if (!askSessions.has(sessionHash)) {
      delete state.ledger[key];
      pruned = true;
    }
  }
  if (pruned) state.ledgerDirty = true;
  if (state.ledgerDirty) {
    saveLedger(state.ledger);
    state.ledgerDirty = false;
  }
  if (waitForNotify && state.pendingNotify.size > 0) {
    // --once determinism: the daemon loop never waits here (its sends
    // reconcile the ledger from the completion callback instead).
    await Promise.all([...state.pendingNotify.values()]);
    if (state.ledgerDirty) {
      saveLedger(state.ledger);
      state.ledgerDirty = false;
    }
  }
  // Live-set-change orphan sweep (R3-orphan + R4-live-loop): panes that
  // dropped out of the live agent set keep presence-encoded owned tokens;
  // clear the owned family under our own source (never foreign tokens).
  const departed = [...state.live].filter((id) => !live.has(id));
  for (const id of departed) {
    try {
      await clearOwnedFamily(id);
    } catch (error) {
      logError(error);
    }
  }
  state.live = live;
}

// Scoped orphan sweep (DESIGN §3 O5): clear ONLY owned gentle_* names, only
// on panes outside `live`. Foreign tokens (pi-tree, native, other plugins)
// are never touched; the clear runs under this daemon's own source tag.
async function sweepOrphans(live) {
  const panes = await panesAsync();
  const jobs = [];
  for (const pane of panes) {
    const id = pane?.pane_id;
    if (typeof id !== 'string' || live.has(id)) continue;
    const tokens = pane?.tokens && typeof pane.tokens === 'object' ? pane.tokens : {};
    if (!contract.SWEEP_TOKENS.some((name) => name in tokens)) continue;
    jobs.push(clearOwnedFamily(id));
  }
  if (jobs.length === 0) return true;
  return (await Promise.all(jobs)).every(Boolean);
}

/* ------------------------------------------------------------ lifecycle */

function daemonAlive() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE(), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function ensureRunning() {
  const pid = daemonAlive();
  if (pid !== null) {
    console.log(`gentle-status: already running (pid ${pid})`);
    return;
  }
  const child = spawn(process.execPath, [__filename, '--run'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  console.log('gentle-status: daemon started');
}

async function run() {
  process.on('uncaughtException', (error) => {
    logError(error);
    process.exit(1);
  });
  process.on('unhandledRejection', (error) => {
    logError(error);
    process.exit(1);
  });
  if (daemonAlive() !== null) {
    console.error('gentle-status: another daemon owns the pidfile; exiting');
    process.exit(1);
  }
  try {
    fs.writeFileSync(PID_FILE(), String(process.pid), 'utf8');
  } catch (error) {
    console.error(`gentle-status: cannot write pidfile: ${error.message}`);
    process.exit(1);
  }
  const state = { ledger: loadLedger(), ledgerDirty: false, live: new Set(), pollObserved: createPollStateObserved(), pendingNotify: new Map() };
  const pollConfig = resolvePollConfig();
  const pollState = createPollState();
  let stopped = false;
  const shutdown = async () => {
    if (stopped) return;
    stopped = true;
    try {
      fs.rmSync(PID_FILE(), { force: true });
    } catch {
      // Already gone.
    }
    // Detached-child rollback (R4): terminate the poll loop and run the
    // scoped sweep over the last-known live set, so disable/uninstall/
    // shutdown leaves no polling child and no orphan owned tokens behind.
    // Best-effort: transport failure is logged, never thrown from a signal.
    try {
      await sweepOrphans(state.live ?? new Set());
    } catch (error) {
      logError(error);
    }
  };
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  for (;;) {
    if (stopped) break;
    try {
      // waitForNotify:false: dispatched sends complete in the background
      // and reconcile the ledger via callback; the next poll delay is
      // computed without waiting on the notify binary.
      await frame(state, { waitForNotify: false });
    } catch (error) {
      logError(error);
    }
    if (stopped) break;
    // Single-loop dynamic delay: fast cycle while recent ask activity or
    // failures were observed, baseline otherwise. No setInterval, no busy
    // loop (delays floored at POLL_MIN_MS via resolvePollConfig).
    const delay = nextPollDelay(pollState, Date.now(), state.pollObserved, pollConfig);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function main() {
  const mode = process.argv.find((a) => a.startsWith('--'));
  if (mode === '--run') {
    await run();
    return;
  }
  if (mode === '--once') {
    const state = { ledger: loadLedger(), ledgerDirty: false, live: new Set(), pollObserved: createPollStateObserved(), pendingNotify: new Map() };
    await frame(state);
    if (state.ledgerDirty) saveLedger(state.ledger);
    return;
  }
  if (mode === '--stop') {
    const purge = process.argv.includes('--purge');
    const pid = daemonAlive();
    if (pid !== null) {
      try {
        process.kill(pid, 'SIGTERM');
        console.log(`gentle-status: stopped daemon (pid ${pid})`);
      } catch (error) {
        console.error(`gentle-status: cannot stop pid ${pid}: ${error.message}`);
      }
    } else {
      console.log('gentle-status: no running daemon');
    }
    try {
      fs.rmSync(PID_FILE(), { force: true });
    } catch {
      // Already gone.
    }
    if (purge) {
      const ok = await sweepOrphans(new Set());
      try {
        fs.rmSync(LEDGER_FILE(), { force: true });
      } catch {
        // Already gone.
      }
      lastSent.clear();
      console.log(ok ? 'gentle-status: purged owned tokens' : 'gentle-status: purge incomplete (transport failure)');
      if (!ok) process.exit(1);
    } else {
      // Handover sweep: clear owned tokens only on panes with no live
      // agent; live panes keep their last reduced family until TTL or the
      // successor writer takes over (never touch foreign tokens).
      const agents = await agentsAsync();
      if (agents === null) {
        console.error('gentle-status: snapshot failed; skipping handover sweep');
        process.exit(1);
      }
      const live = new Set(
        agents.map((a) => a?.pane_id).filter((id) => typeof id === 'string'),
      );
      const ok = await sweepOrphans(live);
      console.log(ok ? 'gentle-status: handover sweep done' : 'gentle-status: handover sweep incomplete');
      if (!ok) process.exit(1);
    }
    return;
  }
  ensureRunning();
}

if (require.main === module) {
  main().catch((error) => {
    logError(error);
    console.error(`gentle-status: ${error?.message ?? error}`);
    process.exit(1);
  });
} else {
  module.exports = {
    POLL_MS,
    POLL_MIN_MS,
    CLI_TIMEOUT_MS,
    notifyAskAsync,
    resolvePollConfig,
    createPollState,
    createPollStateObserved,
    nextPollDelay,
  };
}
