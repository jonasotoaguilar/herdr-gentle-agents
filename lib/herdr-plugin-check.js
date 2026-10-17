'use strict';
// Startup check of the installed `herdr-gentle-shell` Herdr plugin
// (customize-command S22).
//
// At extension startup the Pi side compares the installed Herdr plugin
// for id `herdr-gentle-shell` against the version this package ships in
// herdr-plugin/herdr-plugin.toml. Missing, wrong id (the retired
// `herdr-gentle-agents` only), disabled, or a different version notifies
// ONCE per session with one short alert naming the mismatch and the real
// install command. A locally linked plugin (source.kind === "local")
// counts as installed and is reported as linked, never as missing.
//
// Every entry point never throws: an absent or erroring Herdr CLI and
// unreadable metadata fail silent and harmless — no loading block, no
// user-config write, no repeated alert, and no mention of /reload (the
// panel applies changes itself per S5, so /reload advice is always wrong
// here).
//
// Command text is read from the real sources, never invented:
// - install: `herdr plugin install
//   jonasotoaguilar/herdr-gentle-agents/herdr-plugin --ref herdr-vX.Y.Z`
//   then `herdr plugin enable herdr-gentle-shell` (install.sh steps 6-7;
//   the herdr-vX.Y.Z ref tracks the shipped manifest version per
//   scripts/release-preflight, e.g. --ref herdr-v0.4.0 in the README).
// - update: `herdr plugin update herdr-gentle-shell` (install.sh update
//   story, README update section).
// - enable: `herdr plugin enable herdr-gentle-shell` (install.sh step 6).
// The list query reuses the verified read-only shape the sidebar lookup
// already uses: `herdr plugin list --plugin <id> --json` with
// result.plugins[] carrying plugin_id/id, plugin_root, version,
// enabled, and source.kind (install.sh plugin_info, and the live shape
// where a linked checkout reports source.kind "local").

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PLUGIN_ID = 'herdr-gentle-shell';
const LEGACY_PLUGIN_ID = 'herdr-gentle-agents';
// install.sh: REPO="jonasotoaguilar/herdr-gentle-agents",
// PLUGIN_SUBDIR="herdr-plugin".
const PLUGIN_REPO_PATH = 'jonasotoaguilar/herdr-gentle-agents/herdr-plugin';

function defaultManifestPath() {
  return path.join(__dirname, '..', 'herdr-plugin', 'herdr-plugin.toml');
}

// The shipped version straight from the manifest this package carries.
// Null when the file is missing or carries no version: unreadable
// metadata fails silent upstream.
function readShippedVersion(manifestPath) {
  try {
    const text = fs.readFileSync(manifestPath || defaultManifestPath(), 'utf8');
    const match = text.match(/^\s*version\s*=\s*"([^"]*)"/m);
    const version = match ? match[1].trim() : '';
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

// Same binary convention as the sidebar lookup and lib/gentle-sidebar.js:
// HERDR_BIN_PATH wins (tests), else `herdr` on PATH.
function herdrBin(env = process.env) {
  const override = env && typeof env.HERDR_BIN_PATH === 'string' ? env.HERDR_BIN_PATH : '';
  return override.length > 0 ? override : 'herdr';
}

function installCommand(shippedVersion) {
  return (
    `herdr plugin install ${PLUGIN_REPO_PATH} --ref herdr-v${shippedVersion}` +
    ` && herdr plugin enable ${PLUGIN_ID}`
  );
}

function enableCommand() {
  return `herdr plugin enable ${PLUGIN_ID}`;
}

function updateCommand() {
  return `herdr plugin update ${PLUGIN_ID}`;
}

function defaultRun(bin, args) {
  try {
    const result = spawnSync(bin, args, { encoding: 'utf8', timeout: 10000, windowsHide: true });
    return {
      status: result.status,
      stdout: typeof result.stdout === 'string' ? result.stdout : '',
      stderr: typeof result.stderr === 'string' ? result.stderr : '',
      error: result.error || null,
    };
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error };
  }
}

// One read-only list query for a single plugin id. Never throws: any
// spawn, exit, or parse failure yields { ok: false } (fail silent).
function queryPluginEntries(run, bin, wantId) {
  try {
    const result = run(bin, ['plugin', 'list', '--plugin', wantId, '--json']);
    if (!result || result.error || result.status !== 0) return { ok: false, entries: [] };
    const doc = JSON.parse(result.stdout || '');
    const container = (doc && doc.result && doc.result.plugins) || doc.plugins;
    if (!Array.isArray(container)) return { ok: false, entries: [] };
    return {
      ok: true,
      entries: container.filter((item) => item && (item.plugin_id === wantId || item.id === wantId)),
    };
  } catch {
    return { ok: false, entries: [] };
  }
}

function isLinked(entry) {
  return !!(entry && entry.source && entry.source.kind === 'local');
}

function decideStatus({ shippedVersion, activeEntries, legacyEntries }) {
  const active = activeEntries.length > 0 ? activeEntries[0] : null;
  if (!active) {
    if (legacyEntries.length > 0) {
      return { status: 'wrong-id', linked: isLinked(legacyEntries[0]), installedVersion: null };
    }
    return { status: 'missing', linked: false, installedVersion: null };
  }
  if (active.enabled === false) {
    const installed = typeof active.version === 'string' && active.version.length > 0 ? active.version : null;
    return { status: 'disabled', linked: isLinked(active), installedVersion: installed };
  }
  if (typeof active.version !== 'string' || active.version.length === 0) {
    return { status: 'silent', linked: false, installedVersion: null };
  }
  if (active.version !== shippedVersion) {
    return {
      status: 'version-mismatch',
      linked: isLinked(active),
      installedVersion: active.version,
    };
  }
  return { status: 'ok', linked: isLinked(active), installedVersion: active.version };
}

function buildAlertMessage({ status, shippedVersion, installedVersion, linked }) {
  switch (status) {
    case 'missing':
      return (
        `Herdr plugin ${PLUGIN_ID} ${shippedVersion} is not installed; ` +
        `install it with: ${installCommand(shippedVersion)}`
      );
    case 'wrong-id':
      return (
        `Herdr plugin ${PLUGIN_ID} ${shippedVersion} is installed under the retired id ` +
        `${LEGACY_PLUGIN_ID}; install the current plugin with: ${installCommand(shippedVersion)}`
      );
    case 'disabled':
      return (
        `Herdr plugin ${PLUGIN_ID} is installed but disabled; ` +
        `enable it with: ${enableCommand()}`
      );
    case 'version-mismatch':
      if (linked) {
        return (
          `Herdr plugin ${PLUGIN_ID} is locally linked at ${installedVersion} but this package ` +
          `ships ${shippedVersion}; to replace the link run: ${installCommand(shippedVersion)}`
        );
      }
      return (
        `Herdr plugin ${PLUGIN_ID} is at ${installedVersion} but this package ` +
        `ships ${shippedVersion}; update it with: ${updateCommand()}`
      );
    default:
      return null;
  }
}

// Pure comparison: no session state, no notification. Never throws.
function checkHerdrPlugin({ env = process.env, manifestPath, run = defaultRun } = {}) {
  const base = { status: 'silent', message: null, notified: false, linked: false, installedVersion: null, shippedVersion: null };
  try {
    const shippedVersion = readShippedVersion(manifestPath || defaultManifestPath());
    if (!shippedVersion) return base;
    const bin = herdrBin(env);
    const active = queryPluginEntries(run, bin, PLUGIN_ID);
    if (!active.ok) return { ...base, shippedVersion };
    let legacyEntries = [];
    if (active.entries.length === 0) {
      const legacy = queryPluginEntries(run, bin, LEGACY_PLUGIN_ID);
      if (!legacy.ok) return { ...base, shippedVersion };
      legacyEntries = legacy.entries;
    }
    const decision = decideStatus({ shippedVersion, activeEntries: active.entries, legacyEntries });
    if (decision.status === 'ok' || decision.status === 'silent') {
      return { ...base, status: decision.status, shippedVersion, linked: decision.linked, installedVersion: decision.installedVersion };
    }
    return {
      ...base,
      status: decision.status,
      shippedVersion,
      linked: decision.linked,
      installedVersion: decision.installedVersion,
      message: buildAlertMessage({ ...decision, shippedVersion }),
    };
  } catch {
    return base;
  }
}

// Once-per-session delivery over the pure check. The flag flips only
// when an alert is actually handed to notify, so a startup without UI
// never consumes the session's single alert. Never throws.
let notifiedThisSession = false;

function checkAndNotifyHerdrPlugin({ notify, ...rest } = {}) {
  let result;
  try {
    result = checkHerdrPlugin(rest);
  } catch {
    return { status: 'silent', message: null, notified: false, linked: false, installedVersion: null, shippedVersion: null };
  }
  if (!result.message || notifiedThisSession || typeof notify !== 'function') {
    return { ...result, notified: false };
  }
  try {
    notify(result.message, 'info');
  } catch {
    return { ...result, notified: false };
  }
  notifiedThisSession = true;
  return { ...result, notified: true };
}

function resetHerdrPluginCheckForTests() {
  notifiedThisSession = false;
}

module.exports = {
  PLUGIN_ID,
  LEGACY_PLUGIN_ID,
  defaultManifestPath,
  readShippedVersion,
  installCommand,
  enableCommand,
  updateCommand,
  checkHerdrPlugin,
  checkAndNotifyHerdrPlugin,
  resetHerdrPluginCheckForTests,
};
