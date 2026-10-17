#!/usr/bin/env node
'use strict';

// Gentle status consumer daemon: snapshot → reduce → sidebar tokens.
//
// Polls `agent list`, reduces each pane with lib/gentle-tokens.js (DESIGN
// §5.2), publishes the owned `gentle_*` family (chunked ≤ 16 per report),
// and sweeps only its own token names on handover/uninstall (DESIGN §3 O5).
// Desktop attention is native Herdr (ask + finish toasts, DESIGN §7): this
// daemon emits no notification for any display.
//
// Usage:
//   node bin/gentle-status.js          ensure the daemon is running
//   node bin/gentle-status.js --run    BE the daemon (Herdr [[startup]])
//   node bin/gentle-status.js --once   single frame, then exit (debugging)
//   node bin/gentle-status.js --refresh ensure one daemon + coalesced
//                                        immediate refresh (event hooks)
//   node bin/gentle-status.js --stop   stop the daemon (scoped sweep of live
//   node bin/gentle-status.js --stop --purge   also clear every owned token)
//
// S7 sidebar gate: the sibling sidebar writer owns
// <stateDir>/gentle-sidebar-mode.json ({version:1,enabled:boolean}); this
// daemon only reads it. Missing defaults to enabled (current installs
// unchanged); enabled:false (or malformed, fail-closed) suppresses all
// sidebar publishes and clears only the owned family once per pane. No
// daemon path — including --refresh — ever writes the flag.
//
// Transport mirrors herdr-pi-tree lib/ipc.js + lib/herdr.js: socket calls
// with one CLI fallback each, so a misbehaving socket degrades to slow, not
// broken. A failed snapshot is "no data", never "empty": nothing is
// published or swept on a failed read.

var MIN_MAJOR = 18;
var major = Number(String(process.versions.node).split('.')[0]);
if (major < MIN_MAJOR) {
  process.stderr.write(
    'herdr-gentle-shell: Node ' + MIN_MAJOR + ' or newer is required (running ' + process.versions.node + ').\n',
  );
  process.exit(1);
}

const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const contract = require('../lib/gentle-tokens');
const interruptions = require('../lib/gentle-interruptions');

// This daemon's token source tag. The producer extension reports under
// `gentle:v1`; the daemon writes under the plugin convention
// `plugin:<id>` (same as herdr-pi-tree's herdr.source()), so a clear
// touches only this writer's tokens even where names collide.
// Active plugin lookup identity (S15 rename): the manifest id is now
// herdr-gentle-shell, so Herdr injects HERDR_PLUGIN_ID/HERDR_PLUGIN_STATE_DIR
// for the new id. The SOURCE fallback follows the install; the stored
// state dir below deliberately keeps the pre-rename segment so upgrades
// keep their flags, pidfile and ledger with no migration step.
const PLUGIN_ID = 'herdr-gentle-shell';
const STATE_PLUGIN_ID = 'herdr-gentle-agents';
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

// Family of files proving a state dir is ours: when the Herdr-injected
// dir (which changes with the plugin id) holds none of these while the
// stored dir does, the stored dir wins so pre-rename flags stay readable.
// Fresh installs with no stored files converge on the injected dir.
// GENTLE_STATUS_STATE_DIR (explicit user override) is always used as-is.
const STATE_KNOWN_FILES = [
  'gentle-sidebar-mode.json',
  'gentle-moshi.json',
  'pi-extension-exclusion-owned',
  'gentle-status.pid',
  'gentle-interruptions.json',
  'installer-state',
  'gentle-worktree-mode.json',
];

function dirHasKnownFiles(dir) {
  for (const name of STATE_KNOWN_FILES) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      // A single unreadable entry never decides; keep scanning.
    }
  }
  return false;
}

function storedStateRoot() {
  return path.join(herdrStateDir(), 'plugins', STATE_PLUGIN_ID);
}

function stateRoot() {
  const explicit = process.env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) {
    try {
      fs.mkdirSync(explicit, { recursive: true });
    } catch {
      // Callers degrade rather than crash; pid writes are best-effort.
    }
    return explicit;
  }
  const stored = storedStateRoot();
  // HEAD parity: an explicit-but-empty (or otherwise invalid non-nullish)
  // value ignores every override and uses the stored default. Only an
  // omitted (null/undefined) explicit falls through to the injected dir.
  if (explicit !== undefined && explicit !== null) {
    try {
      fs.mkdirSync(stored, { recursive: true });
    } catch {
      // Callers degrade rather than crash; pid writes are best-effort.
    }
    return stored;
  }
  const injected = process.env.HERDR_PLUGIN_STATE_DIR;
  let dir = stored;
  if (typeof injected === 'string' && injected.length > 0 && injected !== stored) {
    try {
      if (dirHasKnownFiles(injected)) dir = injected;
      else if (dirHasKnownFiles(stored)) dir = stored;
      else dir = injected;
    } catch {
      dir = injected;
    }
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    // Callers degrade rather than crash; pid writes are best-effort.
  }
  return dir;
}

const PID_FILE = () => path.join(stateRoot(), 'gentle-status.pid');
const SIDEBAR_MODE_FILE = () => path.join(stateRoot(), 'gentle-sidebar-mode.json');
const SIDEBAR_MODE_MAX_BYTES = 64 * 1024;

// S7 shared gate (sidebar writer owns writing this flag; the daemon only
// reads): {version:1,enabled:boolean}. Missing file defaults to enabled,
// preserving current installations. enabled:false selects the native
// sidebar: this daemon publishes no sidebar tokens and clears only its own
// family once per pane (retrying transport failures). Malformed content
// fails closed as disabled — a naive truthy check could otherwise silently
// reactivate a deliberately disabled mode — with one bounded error report
// per distinct content (see reportSidebarModeError). The flag carries no
// tokens or pane data, and no daemon path (including --refresh hooks)
// ever writes it.
function readSidebarMode() {
  let stat;
  try {
    stat = fs.statSync(SIDEBAR_MODE_FILE());
    if (stat.size > SIDEBAR_MODE_MAX_BYTES) return { enabled: false, malformed: true, raw: '<oversize>' };
  } catch {
    return { enabled: true, malformed: false, raw: null };
  }
  let raw;
  try {
    raw = fs.readFileSync(SIDEBAR_MODE_FILE(), 'utf8');
  } catch {
    return { enabled: true, malformed: false, raw: null };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { enabled: false, malformed: true, raw };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { enabled: false, malformed: true, raw };
  }
  if (parsed.version !== 1 || typeof parsed.enabled !== 'boolean') {
    return { enabled: false, malformed: true, raw };
  }
  return { enabled: parsed.enabled, malformed: false, raw: null };
}

// Bounded malformed-flag report: one stderr line plus one err-file entry
// per distinct flag content. Never throws; never spams per pane/frame.
function reportSidebarModeError(state, raw) {
  const key = `${String(raw).length}:${String(raw).slice(0, 1024)}`;
  if (state && state.sidebarModeErrorReported === key) return;
  if (state) state.sidebarModeErrorReported = key;
  const message = 'gentle-status: sidebar mode flag unreadable; sidebar publishing disabled';
  try {
    console.error(message);
  } catch {
    // stderr is best-effort; the err file below is the durable record.
  }
  logError(new Error(`${message} (raw: ${String(raw).slice(0, 200)})`));
}
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
// tokens or sweep over one timed-out read.
async function agentsAsync() {
  const reply = await socketCall('agent.list', {});
  if (reply && !reply.error && Array.isArray(reply.result?.agents)) return reply.result.agents;
  return cliJson('agent', 'list')?.result?.agents ?? null;
}

async function panesAsync() {
  const reply = await socketCall('pane.list', {});
  if (reply && !reply.error && Array.isArray(reply.result?.panes)) return reply.result.panes;
  const viaCli = cliJson('pane', 'list')?.result?.panes;
  // Null on failure, never an empty list: a failed pane read is unknown
  // presence, not confirmed absence (interruption + sweep decisions must
  // tell the two apart). Malformed payloads fail closed the same way.
  return Array.isArray(viaCli) ? viaCli : null;
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

// DESIGN §7 notification ownership: desktop attention is native Herdr —
// this consumer emits `herdr notification` for nothing. The ask token still
// drives the sidebar ask display; the Moshi phone path lives in the
// producer extension. This daemon keeps no notification ledger and tracks
// no in-flight sends.

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
  const now = Date.now();
  if (state.pollObserved) {
    state.pollObserved.askActivity = false;
    state.pollObserved.failure = false;
  }
  const agents = await agentsAsync();
  if (agents === null) {
    debug('snapshot failed; skipping frame');
    return;
  }
  // S7 gate: read every frame so a sidebar toggle applies on the next
  // poll/event refresh without a daemon restart. Malformed fails closed.
  const sidebar = readSidebarMode();
  if (sidebar.malformed) reportSidebarModeError(state, sidebar.raw);
  const live = new Set();
  const liveOwned = []; // owned pane ids (disabled-mode clear-once)
  const sightings = {}; // paneId -> {entry, reduced} (ledger, daemon only)
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
    sightings[paneId] = { entry, reduced };
    if (!sidebar.enabled) {
      // Native sidebar selected (or malformed flag): never compose a
      // publish; the clear-once phase below handles owned leftovers.
      liveOwned.push(paneId);
      continue;
    }
    // Behind-upstream marker, resolved per cwd with TTL dedupe (no storm
    // across panes sharing a worktree). Absent on any failure.
    reduced.pull = pullMarkerFor(entry);
    // Ask activity keeps the P1 fast cycle armed while a question waits.
    // Desktop attention itself is native (DESIGN §7): no toast here.
    if (reduced.display === 'ask' && reduced.notify && state.pollObserved) {
      state.pollObserved.askActivity = true;
    }
    const patch = contract.displayTokens(reduced);
    const signature = JSON.stringify(patch);
    if (lastSent.get(paneId) === signature) continue;
    publishJobs.push({ paneId, patch, signature });
  }
  // Publishes land every frame; with no notification path nothing gates them.
  // Suppressed entirely while the native sidebar is selected (S7 gate).
  if (sidebar.enabled) {
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
  } else {
    // Disabled clear-once: remove ONLY the owned family from live panes
    // so native selection leaves no gentle_* residue, then stop — one
    // successful clear per pane per tracking window. Transport failure
    // leaves the pane unmarked for retry on the next frame (and arms the
    // fast poll cycle via pollObserved.failure). Producer and foreign
    // tokens are never touched: clearOwnedFamily is the single scoped
    // sweeper. clearOwnedFamily drops lastSent, so re-enable republishes.
    if (!state.clearedWhileDisabled || !(state.clearedWhileDisabled instanceof Set)) {
      state.clearedWhileDisabled = new Set();
    }
    // Bounded tracking: on overflow forget and re-clear once (harmless —
    // clears are idempotent and scoped to the owned family).
    if (state.clearedWhileDisabled.size > 512) state.clearedWhileDisabled.clear();
    for (const paneId of liveOwned) {
      if (state.clearedWhileDisabled.has(paneId)) continue;
      let ok = false;
      try {
        ok = await clearOwnedFamily(paneId);
      } catch (error) {
        logError(error);
      }
      if (ok) state.clearedWhileDisabled.add(paneId);
      else if (state.pollObserved) state.pollObserved.failure = true;
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
  // Diagnostic-only interruption ledger (daemon loop only): --once must
  // never become a second ledger writer, so it skips this entirely.
  if (opts.persistInterruptions === true) {
    try {
      await trackInterruptions(state, sightings, now);
    } catch (error) {
      logError(error);
    }
  }
}

// Daemon-side ledger update: needs pane presence to tell disappearance
// (pane listed, agent gone) from closure (pane gone). A failed pane read
// is unknown — callers pass null and updateInterruptions records nothing.
// Pane presence is fetched only when a previously fresh pane is missing
// from the snapshot, so steady-state frames cost no extra Herdr call.
async function trackInterruptions(state, sightings, now) {
  const prior = state.interruptionsPrior ?? {};
  const stored = state.interruptions ?? interruptions.blankInterruptions();
  const missing = Object.keys(prior).filter((id) => !(id in sightings));
  let paneIds = new Set();
  if (missing.length > 0) {
    const panes = await panesAsync();
    paneIds =
      panes === null
        ? null
        : new Set(panes.map((p) => p?.pane_id).filter((id) => typeof id === 'string'));
  }
  const next = interruptions.updateInterruptions({ prior, stored, live: sightings, paneIds, now });
  state.interruptionsPrior = next.prior;
  state.interruptions = next.stored;
  // Persist only ledger (record) changes: prior churn (last_fresh_ts per
  // frame) stays memory-only and rebuilds from fresh frames after a
  // restart, so steady-state frames cost no disk write.
  if (JSON.stringify(next.stored) !== JSON.stringify(stored)) {
    interruptions.saveInterruptions(stateRoot(), next.stored);
  }
}

// Scoped orphan sweep (DESIGN §3 O5): clear ONLY owned gentle_* names, only
// on panes outside `live`. Foreign tokens (pi-tree, native, other plugins)
// are never touched; the clear runs under this daemon's own source tag.
async function sweepOrphans(live) {
  const panes = await panesAsync();
  if (panes === null) {
    // Unknown presence, never empty: claiming a complete sweep over an
    // unread list would be a lie (callers report incomplete instead).
    debug('pane list failed; skipping sweep');
    return false;
  }
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

// PID-reuse guard: a stale pidfile pointing at a recycled PID must never
// be signalled or reported as live. On Linux the daemon cmdline still
// names this script; a mismatch means the pidfile is stale (removed
// best-effort). Where /proc is unavailable the kill(0) liveness check is
// the fallback.
function pidIsOurs(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('gentle-status.js');
  } catch {
    return true;
  }
}

function daemonAlive() {
  try {
    const pid = Number(fs.readFileSync(PID_FILE(), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0);
    if (!pidIsOurs(pid)) {
      try {
        fs.rmSync(PID_FILE(), { force: true });
      } catch {
        // Already gone.
      }
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

const REFRESH_FILE = () => path.join(stateRoot(), 'gentle-status.refresh');

// Coalesced immediate-refresh request: event hooks (and operators) touch
// this file; the daemon loop consumes it (delete) and runs one extra
// frame. N concurrent requests collapse to one frame. The file carries
// only a timestamp — never tokens, pane data, or sidebar mode — so an
// event-triggered wake cannot self-feedback: this daemon's own metadata
// writes emit no agent lifecycle events, --refresh itself publishes
// nothing, and the sidebar flag is never written here.
function requestRefresh() {
  try {
    fs.writeFileSync(REFRESH_FILE(), String(Date.now()), 'utf8');
    return true;
  } catch {
    return false;
  }
}

function takeRefresh() {
  try {
    if (!fs.existsSync(REFRESH_FILE())) return false;
    fs.rmSync(REFRESH_FILE(), { force: true });
    return true;
  } catch {
    return false;
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
  const state = {
    live: new Set(),
    pollObserved: createPollStateObserved(),
    interruptionsPrior: {},
    interruptions: interruptions.loadInterruptions(stateRoot()),
    clearedWhileDisabled: new Set(),
    sidebarModeErrorReported: null,
  };
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
      await frame(state, { persistInterruptions: true });
    } catch (error) {
      logError(error);
    }
    if (stopped) break;
    // Single-loop dynamic delay: fast cycle while recent ask activity or
    // failures were observed, baseline otherwise. No setInterval, no busy
    // loop (delays floored at POLL_MIN_MS via resolvePollConfig). The
    // sleep is interruptible: a coalesced --refresh request breaks the
    // wait early for one immediate frame. Sequential — the next frame
    // never overlaps the current one; concurrent requests collapse to one.
    const delay = nextPollDelay(pollState, Date.now(), state.pollObserved, pollConfig);
    const sliceMs = 250;
    let remaining = delay;
    while (remaining > 0 && !stopped) {
      if (takeRefresh()) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(sliceMs, remaining)));
      remaining -= sliceMs;
    }
  }
}

async function main() {
  const mode = process.argv.find((a) => a.startsWith('--'));
  if (mode === '--run') {
    await run();
    return;
  }
  if (mode === '--once') {
    const state = { live: new Set(), pollObserved: createPollStateObserved() };
    await frame(state);
    return;
  }
  if (mode === '--refresh') {
    // Recovery + acceleration: ensure exactly one daemon, then request a
    // coalesced immediate refresh. Never renders a frame here, so this
    // path can never become a second interruption-ledger writer; never
    // touches the S7 sidebar flag, so hooks cannot silently reactivate it.
    const live = daemonAlive();
    if (live !== null) {
      console.log(`gentle-status: already running (pid ${live})`);
    } else {
      ensureRunning();
    }
    if (requestRefresh()) console.log('gentle-status: refresh requested');
    else {
      console.error('gentle-status: cannot request refresh');
      process.exit(1);
    }
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
    resolvePollConfig,
    createPollState,
    createPollStateObserved,
    nextPollDelay,
    readSidebarMode,
  };
}
