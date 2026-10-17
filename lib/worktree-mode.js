'use strict';
// Shared worktree mode flag (P2-S1 foundation).
//
// A JSON mode file in the plugin state directory, default enabled (same
// shape and resolution as the sidebar's in lib/gentle-sidebar.js) —
// GENTLE_STATUS_STATE_DIR first (HERDR_PLUGIN_STATE_DIR as fallback),
// else $XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents. Missing means
// enabled; malformed content never enables.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

// Stored state segment. Deliberately NOT renamed with the S15 plugin id
// (herdr-gentle-shell): the rename keeps the existing directory so
// upgrades keep their mode flag with no migration step. Note this
// constant alone does NOT preserve override behavior: HERDR_PLUGIN_STATE_DIR
// is Herdr-injected and changes with the plugin id, so stateDir() below
// falls back to the stored dir when the injected one holds none of our
// files (same decision as the sidebar/daemon/diagnostics resolvers).
const PLUGIN_ID = 'herdr-gentle-agents';
const MODE_VERSION = 1;
const MODE_NAME = 'gentle-worktree-mode.json';
// Family of files proving a state dir is ours. This list intentionally
// extends the sidebar/daemon/diagnostics family with the worktree flag
// itself: a stored dir holding ONLY this flag (a worktree-only toggle by
// a user who never ran the installer or touched the other switches) must
// still win over an empty injected dir. That is also why this module does
// not reuse lib/gentle-sidebar.js's stateDir: its probe set cannot see
// this file, and requiring that heavier module would add a cross-lib
// dependency for wrong semantics. No new dependency is introduced here.
const STATE_KNOWN_FILES = [
  'gentle-sidebar-mode.json',
  'gentle-moshi.json',
  'pi-extension-exclusion-owned',
  'gentle-status.pid',
  'gentle-interruptions.json',
  'installer-state',
  'gentle-worktree-mode.json',
];

function storedStateDir(env = process.env) {
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'herdr')
    : path.join(os.homedir(), '.local', 'state', 'herdr');
  return path.join(base, 'plugins', PLUGIN_ID);
}

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

function stateDir(env = process.env) {
  const explicit = env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  // Historical quirk, preserved exactly: an explicit-but-empty (or
  // non-string) value ignores every override and uses the stored default.
  // This differs from the sidebar/daemon/diagnostics resolvers, which
  // consider the injected dir in that case (admitted in the prior S15
  // handoff and reported for independent verification); the delta is not
  // extended here.
  if (explicit !== undefined && explicit !== null) return storedStateDir(env);
  const injected = env.HERDR_PLUGIN_STATE_DIR;
  const stored = storedStateDir(env);
  if (typeof injected !== 'string' || injected.length === 0) return stored;
  if (injected === stored) return injected;
  try {
    if (dirHasKnownFiles(injected)) return injected;
    if (dirHasKnownFiles(stored)) return stored;
  } catch {
    // Fall through to the injected dir on unexpected failure.
  }
  return injected;
}

function modePath(env = process.env) {
  return path.join(stateDir(env), MODE_NAME);
}

// Missing means enabled (compatibility); malformed never enables.
function readMode(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(modePath(env), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing', enabled: true };
    return { state: 'malformed', enabled: false };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch {
    return { state: 'malformed', enabled: false };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { state: 'malformed', enabled: false };
  if (doc.version !== MODE_VERSION || typeof doc.enabled !== 'boolean') return { state: 'malformed', enabled: false };
  return doc.enabled ? { state: 'enabled', enabled: true } : { state: 'disabled', enabled: false };
}

function writeMode(enabled, env = process.env) {
  const file = modePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Inspect the destination BEFORE writing: writeFileSync follows a
  // symlink, so a symlinked mode path would overwrite its target. A
  // symlinked or non-regular destination is refused and nothing is
  // touched. The normal path stays atomic: a sibling temp file renamed
  // into place.
  let stat = null;
  try {
    stat = fs.lstatSync(file);
  } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (stat) {
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing to write worktree mode: ${file} is a symlink; remove it or replace it with a regular file first`);
    }
    if (!stat.isFile()) {
      throw new Error(`refusing to write worktree mode: ${file} is not a regular file`);
    }
  }
  const tmpPayload = `${JSON.stringify({ version: MODE_VERSION, enabled: Boolean(enabled) })}\n`;
  // The sibling temp file is created exclusively (`wx`) with an
  // unpredictable suffix so a planted symlink or file is never followed
  // or reused: on collision a new name is retried a bounded number of
  // times, then the write is refused with a clear message.
  let tmp = null;
  let wrote = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix;
    try {
      suffix = crypto.randomBytes(8).toString('hex');
    } catch (err) {
      throw new Error(`cannot write worktree mode ${file}: cannot generate a temporary file name: ${(err && err.message) || err}`);
    }
    tmp = `${file}.tmp.${process.pid}.${Date.now()}.${suffix}`;
    try {
      fs.writeFileSync(tmp, tmpPayload, { flag: 'wx' });
      wrote = true;
      break;
    } catch (err) {
      // A non-EEXIST failure may still have created the temp file
      // (e.g. ENOSPC mid-write): unlink it best-effort so a failed
      // write never leaves litter behind, then rethrow (never success).
      const failedTmp = tmp;
      tmp = null;
      if (err && err.code === 'EEXIST') continue;
      if (failedTmp) {
        try {
          fs.unlinkSync(failedTmp);
        } catch {
          // Best effort: the rethrow below is what matters.
        }
      }
      throw err;
    }
  }
  if (!wrote || !tmp) {
    throw new Error(`cannot write worktree mode ${file}: could not create a unique temporary file after 10 attempts; refusing to follow or reuse an existing path`);
  }
  try {
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Either renamed (gone) or never created; nothing to clean.
    }
  }
}

module.exports = {
  PLUGIN_ID,
  MODE_VERSION,
  stateDir,
  modePath,
  readMode,
  writeMode,
};
