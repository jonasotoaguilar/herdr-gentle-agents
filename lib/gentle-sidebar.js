#!/usr/bin/env node
'use strict';

// Package-side sidebar control helper for herdr-gentle-agents (S7).
//
// Same contract as the sidebar rows of `/herdr-gentle:customize` in the Pi
// extension (driven there through the provider slot in
// extensions/gentle-herdr-state.ts), for use outside Pi (humans, Herdr
// actions, isolated checks). Unlike the extension copy — which must stay a
// single file and therefore mirrors the exclusion inline — this helper
// drives the authoritative contracts directly: lib/pi-extension-exclusion.js
// for the owned native exclusion and bin/configure.js for the managed
// pi-only rows. Mode flag shape and missing-defaults-enabled semantics are
// identical on both sides; the extension never imports this file.
//
// Completion proof, not acceptance: bin/configure.js runs synchronously
// and the managed-row effect is re-read from the Herdr config before the
// exclusion or mode changes. A failed run restores the prior owned-rows
// state through the marker-scoped reverse operation (never a byte restore,
// so user tables and concurrent edits outside our markers survive).
// Strict verbs only; every failure reports an explicit recoverable state.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ACTIVE_PLUGIN_ID = 'herdr-gentle-shell';
const LEGACY_PLUGIN_ID = 'herdr-gentle-agents';
// Stored state location. Deliberately NOT the active id: the S15 rename
// keeps the existing directory so upgrades keep their mode flag, marker
// and installer state with no migration step.
const STATE_PLUGIN_ID = 'herdr-gentle-agents';
// Family of files proving a state dir is ours: when the Herdr-injected
// dir (which changes with the plugin id) holds none of these while the
// stored dir does, the stored dir wins so pre-rename flags stay readable.
const STATE_KNOWN_FILES = [
  'gentle-sidebar-mode.json',
  'gentle-moshi.json',
  'pi-extension-exclusion-owned',
  'gentle-status.pid',
  'gentle-interruptions.json',
  'installer-state',
  'gentle-worktree-mode.json',
];
// Backwards-compatible alias: the active plugin lookup identity.
const PLUGIN_ID = ACTIVE_PLUGIN_ID;
const MODE_VERSION = 1;
const NATIVE_REL = 'extensions/herdr-agent-state.ts';
const NATIVE_ENTRY = `-${NATIVE_REL}`;
const MARKER_NAME = 'pi-extension-exclusion-owned';

function storedStateDir(env = process.env) {
  const base = env.XDG_STATE_HOME
    ? path.join(env.XDG_STATE_HOME, 'herdr')
    : path.join(os.homedir(), '.local', 'state', 'herdr');
  return path.join(base, 'plugins', STATE_PLUGIN_ID);
}
const MODE_NAME = 'gentle-sidebar-mode.json';
const MANAGED_BEGIN = '# BEGIN herdr-gentle-agents (managed; do not edit)';
const MANAGED_END = '# END herdr-gentle-agents';

function stateDir(env = process.env) {
  const explicit = env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  const stored = storedStateDir(env);
  // HEAD parity: an explicit-but-empty (or otherwise invalid non-nullish)
  // value ignores every override and uses the stored default. Only an
  // omitted (null/undefined) explicit falls through to the injected dir.
  if (explicit !== undefined && explicit !== null) return stored;
  const injected = env.HERDR_PLUGIN_STATE_DIR;
  if (typeof injected !== 'string' || injected.length === 0) return stored;
  if (injected === stored) return injected;
  try {
    let injectedHas = false;
    for (const name of STATE_KNOWN_FILES) {
      try {
        if (fs.existsSync(path.join(injected, name))) {
          injectedHas = true;
          break;
        }
      } catch {
        // A single unreadable entry never decides; keep scanning.
      }
    }
    if (injectedHas) return injected;
    for (const name of STATE_KNOWN_FILES) {
      try {
        if (fs.existsSync(path.join(stored, name))) return stored;
      } catch {
        // A single unreadable entry never decides; keep scanning.
      }
    }
  } catch {
    // Fall through to the injected dir on unexpected failure.
  }
  return injected;
}

function modePath(env) {
  return path.join(stateDir(env), MODE_NAME);
}

function markerPath(env) {
  return path.join(stateDir(env), MARKER_NAME);
}

function agentDir(env = process.env) {
  const selected = env.GENTLE_PI_AGENT_HOME ?? env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent');
  if (selected === '~') return os.homedir();
  if (selected.startsWith('~/')) return path.join(os.homedir(), selected.slice(2));
  return selected;
}

function settingsPath(env) {
  return path.join(agentDir(env), 'settings.json');
}

function nativePath(env) {
  return path.join(agentDir(env), NATIVE_REL);
}

// Read-only Herdr config location (same resolution as bin/configure.js).
function configPath(env = process.env) {
  if (env.HERDR_CONFIG_PATH) return path.resolve(env.HERDR_CONFIG_PATH);
  if (env.XDG_CONFIG_HOME) return path.join(env.XDG_CONFIG_HOME, 'herdr', 'config.toml');
  const base = process.platform === 'win32'
    ? (env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
    : path.join(os.homedir(), '.config');
  return path.join(base, 'herdr', 'config.toml');
}

function exclusionHelper() {
  return path.join(__dirname, 'pi-extension-exclusion.js');
}

// bin/configure.js belongs to the Herdr plugin, which is installed as its
// own package, so the Pi side resolves the installed plugin root exactly
// like the extension does (read-only `herdr plugin list --json`).
// GENTLE_HERDR_PLUGIN_ROOT overrides the lookup for tests and isolated use.
// The active (renamed) id is queried first; a zero match falls through to
// one explicit lookup by the retired id. Ambiguous roots fail closed on
// either id — the legacy lookup is never a silent weak fallback.
function queryPluginRoots(id, env) {
  const result = spawnSync(
    env.HERDR_BIN_PATH || 'herdr',
    ['plugin', 'list', '--plugin', id, '--json'],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  if (result.error) return { ok: false, note: `could not resolve the installed plugin root: ${result.error.message}.` };
  if (result.status !== 0) return { ok: false, note: `could not resolve the installed plugin root (plugin list exited ${result.status}).` };
  try {
    const doc = JSON.parse(result.stdout || '');
    const arr = (doc && doc.result && doc.result.plugins) || doc.plugins || [];
    if (!Array.isArray(arr)) throw new Error('no plugins array');
    const hits = arr.filter((p) => p && (p.plugin_id === id || p.id === id));
    const roots = [...new Set(hits.map((h) => h.plugin_root).filter((r) => typeof r === 'string' && r.length > 0))];
    return { ok: true, roots };
  } catch (err) {
    return { ok: false, note: `could not resolve the installed plugin root: malformed plugin list (${err.message}).` };
  }
}

function checkConfigureScript(roots) {
  if (roots.length !== 1 || !path.isAbsolute(roots[0])) {
    const why = roots.length === 0 ? 'no match' : 'ambiguous or non-absolute';
    return { ok: false, note: `could not resolve the installed plugin root (${why}).` };
  }
  const script = path.join(roots[0], 'bin', 'configure.js');
  if (!fs.existsSync(script)) {
    return { ok: false, note: `could not resolve the installed plugin root (${roots[0]} has no bin/configure.js).` };
  }
  return { ok: true, script };
}

function resolveConfigureScript(env = process.env) {
  if (env.GENTLE_HERDR_PLUGIN_ROOT) {
    const root = path.resolve(env.GENTLE_HERDR_PLUGIN_ROOT);
    return { ok: true, script: path.join(root, 'bin', 'configure.js') };
  }
  const active = queryPluginRoots(ACTIVE_PLUGIN_ID, env);
  if (!active.ok) return active;
  if (active.roots.length === 1) return checkConfigureScript(active.roots);
  if (active.roots.length > 1) {
    return { ok: false, note: `could not resolve the installed plugin root (ambiguous for ${ACTIVE_PLUGIN_ID}).` };
  }
  const legacy = queryPluginRoots(LEGACY_PLUGIN_ID, env);
  if (!legacy.ok) return legacy;
  if (legacy.roots.length === 1) return checkConfigureScript(legacy.roots);
  if (legacy.roots.length > 1) {
    return { ok: false, note: `could not resolve the installed plugin root (ambiguous for retired id ${LEGACY_PLUGIN_ID}).` };
  }
  return { ok: false, note: `could not resolve the installed plugin root (no match for ${ACTIVE_PLUGIN_ID} or ${LEGACY_PLUGIN_ID}).` };
}

// Missing means enabled (compatibility); malformed never enables.
function readMode(env = process.env) {
  let raw;
  try {
    raw = fs.readFileSync(modePath(env), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { state: 'missing', publish: true };
    return { state: 'malformed', publish: false };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return { state: 'malformed', publish: false };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return { state: 'malformed', publish: false };
  if (doc.version !== MODE_VERSION || typeof doc.enabled !== 'boolean') return { state: 'malformed', publish: false };
  return doc.enabled ? { state: 'enabled', publish: true } : { state: 'disabled', publish: false };
}

function writeMode(enabled, env = process.env) {
  const file = modePath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: MODE_VERSION, enabled })}\n`);
}

function readConfigSnapshot(env) {
  const file = configPath(env);
  try {
    return { ok: true, text: fs.readFileSync(file, 'utf8') };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: true, text: null };
    return { ok: false, text: null, note: `config ${file} unreadable: ${err.message}.` };
  }
}

function rowsManaged(text) {
  return typeof text === 'string' && text.includes(MANAGED_BEGIN) && text.includes(MANAGED_END);
}

function runExclusion(command, env) {
  const result = spawnSync(
    process.execPath,
    [exclusionHelper(), command, '--settings', settingsPath(env), '--entry', NATIVE_ENTRY, '--marker', markerPath(env)],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  if (result.error) return { ok: false, note: `exclusion helper failed: ${result.error.message}.` };
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    return { ok: false, note: detail || `exclusion helper exited ${result.status}.` };
  }
  return { ok: true, note: (result.stdout || '').trim() };
}

function runConfigure(command, env, reload) {
  const resolved = resolveConfigureScript(env);
  if (!resolved.ok) return { exit: -1, output: resolved.note };
  const args = [resolved.script, command];
  if (reload) args.push('--reload');
  const childEnv = { ...process.env };
  if (env.HERDR_CONFIG_PATH) childEnv.HERDR_CONFIG_PATH = env.HERDR_CONFIG_PATH;
  if (env.HERDR_BIN_PATH) childEnv.HERDR_BIN_PATH = env.HERDR_BIN_PATH;
  const result = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: 60000, windowsHide: true, env: childEnv,
  });
  if (result.error) return { exit: -1, output: `configure ${command} could not start: ${result.error.message}.` };
  if (result.status !== 0) {
    const detail = `${result.stderr || ''}${result.stdout || ''}`.trim().slice(0, 300);
    return { exit: result.status, output: detail || `configure ${command} exited ${result.status}.` };
  }
  return { exit: 0, output: (result.stdout || '').trim().slice(0, 300) };
}

function readModeRaw(env) {
  try {
    return { hadFile: true, raw: fs.readFileSync(modePath(env), 'utf8') };
  } catch (err) {
    if (err && err.code === 'ENOENT') return { hadFile: false, raw: null };
    return { hadFile: false, raw: null, unreadable: true, message: err.message };
  }
}

function enable(env = process.env) {
  const reRun = 'Re-run to converge.';
  const snapshot = readModeRaw(env);
  if (snapshot.unreadable) return { code: 1, message: `Could not enable: cannot read ${modePath(env)}: ${snapshot.message}.` };
  // With no native hook installed there is nothing to exclude: the mode
  // and rows still converge, settings.json stays untouched (same rule as
  // the Pi command).
  const nativeInstalled = fs.existsSync(nativePath(env));
  const snap = readConfigSnapshot(env);
  if (!snap.ok) return { code: 1, message: `Could not enable: ${snap.note} ${reRun}` };
  const hadManaged = rowsManaged(snap.text);
  const ran = runConfigure('--apply', env, true);
  const after = readConfigSnapshot(env);
  const nowManaged = after.ok && rowsManaged(after.text);
  if (ran.exit !== 0 || !nowManaged) {
    let restored = 'rows left as found';
    if (!hadManaged && nowManaged) {
      const undone = runConfigure('--uninstall', env, false);
      const check = readConfigSnapshot(env);
      restored = undone.exit === 0 && check.ok && !rowsManaged(check.text)
        ? 'stranded rows removed again'
        : 'rows could NOT be restored; remove the managed block manually or re-run enable';
    }
    const detail = ran.exit !== 0 ? `configure exited ${ran.exit}: ${ran.output}` : 'managed rows missing after configure.';
    return { code: 1, message: `Could not enable: ${detail} ${restored}; mode and exclusion unchanged. ${reRun}` };
  }
  const exclusion = nativeInstalled
    ? runExclusion('ensure', env)
    : { ok: true, note: `${NATIVE_REL} is not installed; settings.json untouched.` };
  if (!exclusion.ok) {
    if (!hadManaged) runConfigure('--uninstall', env, false);
    return { code: 1, message: `Could not enable: ${exclusion.note} Rows rolled back; mode unchanged. ${reRun}` };
  }
  try {
    writeMode(true, env);
  } catch (err) {
    runExclusion('remove', env);
    if (!hadManaged) runConfigure('--uninstall', env, false);
    return { code: 1, message: `Could not enable: cannot write ${modePath(env)}: ${err.message}. State rolled back; re-run to converge.` };
  }
  return { code: 0, message: `Gentle sidebar enabled (ours). ${exclusion.note} Managed rows applied and verified (configure exit 0). Running Pi sessions need /reload.` };
}

function disable(env = process.env) {
  const reRun = 'Re-run to converge.';
  const nativeInstalled = fs.existsSync(nativePath(env));
  const snap = readConfigSnapshot(env);
  if (!snap.ok) return { code: 1, message: `Could not disable: ${snap.note} ${reRun}` };
  const hadManaged = rowsManaged(snap.text);
  const ran = runConfigure('--uninstall', env, true);
  const after = readConfigSnapshot(env);
  const nowAbsent = after.ok && !rowsManaged(after.text);
  if (ran.exit !== 0 || !nowAbsent) {
    let restored = 'rows left as found';
    if (hadManaged && after.ok && !rowsManaged(after.text)) {
      const redone = runConfigure('--apply', env, false);
      const check = readConfigSnapshot(env);
      restored = redone.exit === 0 && check.ok && rowsManaged(check.text)
        ? 'prior owned rows restored'
        : 'rows could NOT be restored; re-run disable or apply the managed block manually';
    }
    const detail = ran.exit !== 0 ? `configure exited ${ran.exit}: ${ran.output}` : 'managed rows still present after configure.';
    return { code: 1, message: `Could not disable: ${detail} ${restored}; exclusion and mode unchanged. ${reRun}` };
  }
  const exclusion = nativeInstalled
    ? runExclusion('remove', env)
    : { ok: true, note: `${NATIVE_REL} is not installed; settings.json untouched.` };
  if (!exclusion.ok) {
    return { code: 1, message: `Could not disable: ${exclusion.note} Rows are native; mode unchanged. ${reRun}` };
  }
  try {
    writeMode(false, env);
  } catch (err) {
    return { code: 1, message: `Sidebar rows are native now but the mode file could not be written (${err.message}); re-run to converge.` };
  }
  return { code: 0, message: `Gentle sidebar disabled (native renders again). ${exclusion.note} Managed rows removed and verified (configure exit 0). Running Pi sessions need /reload.` };
}

function status(env = process.env) {
  const mode = readMode(env);
  const state = mode.state === 'missing' ? 'enabled (default; no mode file)' : mode.state;
  const which = mode.publish ? 'ours' : mode.state === 'disabled' ? 'native' : 'unknown';
  return { code: 0, message: `Gentle sidebar is ${state} (${which}; ${NATIVE_REL} handling via the owned exclusion marker).` };
}

module.exports = {
  PLUGIN_ID,
  ACTIVE_PLUGIN_ID,
  LEGACY_PLUGIN_ID,
  STATE_PLUGIN_ID,
  MODE_VERSION,
  NATIVE_ENTRY,
  stateDir,
  modePath,
  markerPath,
  settingsPath,
  nativePath,
  configPath,
  readMode,
  writeMode,
  enable,
  disable,
  status,
};
