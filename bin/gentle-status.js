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
// rather than normatively fixed.
const POLL_MS = Number(process.env.GENTLE_STATUS_POLL_MS ?? 10000) || 10000;
const MAX_TOKENS_PER_REPORT = 16;
const SOCKET_TIMEOUT_MS = 4000;
const CLI_TIMEOUT_MS = 5000;
const MAX_IN_FLIGHT = 16;

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
// error transitions never call this. No session material, paths, or token
// values enter the title/body — pane id + intent id only.
function notifyAsk(paneId, intentId) {
  try {
    const result = spawnSync(
      binary(),
      ['notification', 'show', 'Gentle: input needed', '--body', `Pane ${paneId} is waiting (ask ${intentId}).`, '--sound', 'request'],
      { encoding: 'utf8', timeout: CLI_TIMEOUT_MS, windowsHide: true },
    );
    return result.status === 0;
  } catch {
    return false;
  }
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
  for (const name of contract.OWNED_TOKENS) clear[name] = null;
  return clear;
}

async function clearOwnedFamily(paneId) {
  lastSent.delete(paneId);
  return reportChunked(SOURCE, paneId, ownedClearPatch());
}

async function frame(state) {
  const now = Date.now();
  const agents = await agentsAsync();
  if (agents === null) {
    debug('snapshot failed; skipping frame');
    return;
  }
  const askSessions = new Set();
  const live = new Set();
  for (const entry of agents) {
    const paneId = entry?.pane_id;
    if (typeof paneId !== 'string') continue;
    live.add(paneId);
    const reduced = contract.reducePane(entry, now);
    if (!reduced.owned) {
      debug(`pane ${paneId}: pi-tree owns; yielding`);
      continue;
    }
    if (reduced.display === 'ask' && reduced.notify) {
      askSessions.add(reduced.notify.sessionHash);
      const key = `${reduced.notify.sessionHash}:${reduced.notify.intentId}`;
      if (!state.ledger[key]) {
        if (notifyAsk(paneId, reduced.notify.intentId)) {
          state.ledger[key] = { expiry: reduced.notify.expiry };
          state.ledgerDirty = true;
          debug(`notified ask ${key} on ${paneId}`);
        } else {
          debug(`notify failed for ask ${key}; will retry next frame`);
        }
      }
    }
    const patch = contract.displayTokens(reduced);
    const signature = JSON.stringify(patch);
    if (lastSent.get(paneId) === signature) continue;
    const ok = await reportChunked(SOURCE, paneId, patch);
    if (ok) lastSent.set(paneId, signature);
    else debug(`publish failed for pane ${paneId}; will retry next frame`);
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
    if (!contract.OWNED_TOKENS.some((name) => name in tokens)) continue;
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
  const state = { ledger: loadLedger(), ledgerDirty: false, live: new Set() };
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
      await frame(state);
    } catch (error) {
      logError(error);
    }
    if (stopped) break;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function main() {
  const mode = process.argv.find((a) => a.startsWith('--'));
  if (mode === '--run') {
    await run();
    return;
  }
  if (mode === '--once') {
    const state = { ledger: loadLedger(), ledgerDirty: false, live: new Set() };
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

main().catch((error) => {
  logError(error);
  console.error(`gentle-status: ${error?.message ?? error}`);
  process.exit(1);
});
