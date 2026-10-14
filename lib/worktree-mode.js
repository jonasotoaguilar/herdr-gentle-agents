'use strict';
// Shared worktree mode flag (P2-S1 foundation).
//
// Follows the `/herdr-gentle:sidebar` pattern: a JSON mode file in the
// plugin state directory, default enabled. The state directory resolves
// exactly like the sidebar's in lib/gentle-sidebar.js —
// GENTLE_STATUS_STATE_DIR first (HERDR_PLUGIN_STATE_DIR as fallback),
// else $XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents. Missing means
// enabled; malformed content never enables.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PLUGIN_ID = 'herdr-gentle-agents';
const MODE_VERSION = 1;
const MODE_NAME = 'gentle-worktree-mode.json';

function stateDir(env = process.env) {
  const override = env.GENTLE_STATUS_STATE_DIR ?? env.HERDR_PLUGIN_STATE_DIR;
  if (typeof override === 'string' && override.length > 0) return override;
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'herdr')
    : path.join(os.homedir(), '.local', 'state', 'herdr');
  return path.join(base, 'plugins', PLUGIN_ID);
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
  fs.writeFileSync(file, `${JSON.stringify({ version: MODE_VERSION, enabled: Boolean(enabled) })}\n`);
}

module.exports = {
  PLUGIN_ID,
  MODE_VERSION,
  stateDir,
  modePath,
  readMode,
  writeMode,
};
