'use strict';
// T1 (customize-command S6) tests: the provider slot the state extension
// registers for the customize panel.
//
// The sidebar and moshi actions are NOT reimplemented and NOT extracted:
// they stay inline in extensions/gentle-herdr-state.ts, which registers
// them once at load into the single provider slot
// `globalThis[Symbol.for("herdr-gentle.customize.v1")]` as
// `{sidebar:{read,apply}, moshi:{read,apply}}`, where read() returns the
// active value id and apply(value, ctx) returns
// {changed, needsReload, text} through the existing sidebarEnable /
// sidebarDisable and writeMoshiFlag / setMoshiExclusion /
// moshiFlagEnabled paths unchanged.
//
// Only observable behavior is asserted: the slot shape, the value ids,
// the returned verdicts, the state files, and the registered commands.
// Never internal function names.
//
// Loading pattern mirrors tools/gentle-sidebar-toggle.test.js: the
// TypeScript extension is plain JS under the hood, so the test copies it
// to a fresh temporary .mjs path per load with the single package import
// line stubbed and import()s it with a fake `pi` object.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const SRC = path.resolve(__dirname, '../extensions/gentle-herdr-state.ts');
const CONFIGURE_SRC = path.resolve(__dirname, '../herdr-plugin/bin/configure.js');

const srcText = fs.readFileSync(SRC, 'utf8');
const stubbed = srcText.replace(
  /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
  'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
);
assert.ok(stubbed !== srcText, 'expected the package import line to be stubbed');

const SLOT_KEY = 'herdr-gentle.customize.v1';

const roots = [];
after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

const savedEnv = { ...process.env };
function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

// Fresh module copy per load (import() caches by URL): the slot closure
// always belongs to this load.
async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-prov-')));
  const copy = path.join(dir, 'gentle-herdr-state.mjs');
  fs.writeFileSync(copy, stubbed);
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
    events: { on: () => {}, emit: () => {} },
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { commands, mod };
}

function takeSlot() {
  const key = Symbol.for(SLOT_KEY);
  const slot = globalThis[key];
  delete globalThis[key];
  return slot;
}

function makeCtx() {
  const notes = [];
  return {
    ctx: { ui: { notify: (message, level) => { notes.push([message, level]); } } },
    notes,
  };
}

// Isolated state/agent/config dirs plus a fake `herdr` shim whose
// `plugin list` reports the fixture plugin root (a copy of the real
// self-contained bin/configure.js), mirroring
// tools/gentle-sidebar-toggle.test.js.
function fixture() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-fix-')));
  const stateDir = path.join(dir, 'state');
  const agentDir = path.join(dir, 'agent');
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  const configFile = path.join(dir, 'herdr-config.toml');
  const pluginRoot = path.join(dir, 'plugin');
  fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
  fs.copyFileSync(CONFIGURE_SRC, path.join(pluginRoot, 'bin', 'configure.js'));
  const shimDir = path.join(dir, 'shimbin');
  fs.mkdirSync(shimDir, { recursive: true });
  const shimLog = path.join(dir, 'herdr-argv.log');
  const shim = path.join(shimDir, 'herdr');
  fs.writeFileSync(
    shim,
    [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> "${shimLog}"`,
      'if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then',
      '  printf \'{"id":"cli:plugin","result":{"plugins":[{"plugin_id":"herdr-gentle-agents","plugin_root":"%s"}]}}\\n\' "$HERDR_SHIM_PLUGIN_ROOT"',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { dir, stateDir, agentDir, configFile, pluginRoot, shimDir, shim, shimLog };
}

function shimCalls(shimLog) {
  try {
    return fs.readFileSync(shimLog, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

describe('customize provider slot', { concurrency: false }, () => {
  test('the state extension registers the slot once at load with the exact shape', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      assert.ok(slot && typeof slot === 'object', 'expected the provider slot to be registered');
      assert.deepEqual(Object.keys(slot).sort(), ['moshi', 'sidebar'], 'the slot carries exactly the two inline providers');
      for (const name of ['sidebar', 'moshi']) {
        assert.equal(typeof slot[name].read, 'function', `${name}.read`);
        assert.equal(typeof slot[name].apply, 'function', `${name}.apply`);
      }
    } finally {
      restoreEnv();
    }
  });

  test('the old sidebar and moshi commands are gone (S7)', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      const { commands } = await loadExtension();
      assert.ok(!commands.has('herdr-gentle:sidebar'), 'the sidebar toggle is removed outright (S7)');
      assert.ok(!commands.has('herdr-gentle:moshi'), 'the moshi toggle is removed outright (S7)');
    } finally {
      restoreEnv();
    }
  });

  test('sidebar read reports the active value id (missing mode means gentle)', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      assert.equal(slot.sidebar.read(), 'gentle', 'missing mode defaults to enabled, like the command');
      fs.mkdirSync(fix.stateDir, { recursive: true });
      fs.writeFileSync(path.join(fix.stateDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
      assert.equal(slot.sidebar.read(), 'native');
      fs.writeFileSync(path.join(fix.stateDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":true}\n');
      assert.equal(slot.sidebar.read(), 'gentle');
    } finally {
      restoreEnv();
    }
  });

  test('sidebar apply reuses the existing disable path: writes the mode file and always needs reload', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
      PATH: `${fix.shimDir}${path.delimiter}${savedEnv.PATH ?? ''}`,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      const result = await slot.sidebar.apply('native', ctx);
      assert.equal(result.changed, true);
      assert.equal(result.needsReload, true, 'S6: the sidebar switch always reloads');
      assert.equal(typeof result.text, 'string');
      assert.ok(!result.text.includes('/reload'), 'the panel never asks the user to run /reload');
      assert.deepEqual(
        readJson(path.join(fix.stateDir, 'gentle-sidebar-mode.json')),
        { version: 1, enabled: false },
        'the existing disable path wrote the mode file',
      );
    } finally {
      restoreEnv();
    }
  });

  test('sidebar apply with the already-active value changes nothing and runs nothing', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
      PATH: `${fix.shimDir}${path.delimiter}${savedEnv.PATH ?? ''}`,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      const result = await slot.sidebar.apply('gentle', ctx);
      assert.equal(result.changed, false);
      assert.equal(result.needsReload, false);
      assert.deepEqual(shimCalls(fix.shimLog), [], 'no configure run for a no-op');
      assert.equal(readJson(path.join(fix.stateDir, 'gentle-sidebar-mode.json')), null, 'no mode file is created');
    } finally {
      restoreEnv();
    }
  });

  test('sidebar apply fails closed when the plugin root cannot be resolved', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      // No herdr binary and no shim root: resolution fails.
      HERDR_BIN_PATH: path.join(fix.dir, 'no-such-herdr'),
      PATH: savedEnv.PATH ?? '',
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      const result = await slot.sidebar.apply('native', ctx);
      assert.equal(result.changed, false);
      assert.equal(result.needsReload, false);
      assert.equal(readJson(path.join(fix.stateDir, 'gentle-sidebar-mode.json')), null, 'failure writes nothing');
    } finally {
      restoreEnv();
    }
  });

  test('moshi read reports the active value id (default off)', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      assert.equal(slot.moshi.read(), 'off', 'missing flag defaults to off');
    } finally {
      restoreEnv();
    }
  });

  test('moshi apply reuses the existing flag path and needs no reload while the hook is not installed', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      const result = await slot.moshi.apply('on', ctx);
      assert.equal(result.changed, true);
      assert.equal(result.needsReload, false, 'S6: no exclusion change without the hook means no reload');
      assert.equal(typeof result.text, 'string');
      assert.ok(!result.text.includes('/reload'), 'the panel never asks the user to run /reload');
      const flag = readJson(path.join(fix.stateDir, 'gentle-moshi.json'));
      assert.equal(flag && flag.enabled, true, 'the existing flag path wrote the file');
      assert.equal(slot.moshi.read(), 'on', 'read follows the write');
    } finally {
      restoreEnv();
    }
  });

  test('moshi apply with the already-active value writes nothing', async () => {
    const fix = fixture();
    setEnv({
      GENTLE_STATUS_STATE_DIR: fix.stateDir,
      PI_CODING_AGENT_DIR: fix.agentDir,
      HERDR_CONFIG_PATH: fix.configFile,
      HERDR_BIN_PATH: fix.shim,
      HERDR_SHIM_PLUGIN_ROOT: fix.pluginRoot,
    });
    takeSlot();
    try {
      await loadExtension();
      const slot = takeSlot();
      const { ctx } = makeCtx();
      const result = await slot.moshi.apply('off', ctx);
      assert.equal(result.changed, false);
      assert.equal(result.needsReload, false);
      assert.ok(!fs.existsSync(path.join(fix.stateDir, 'gentle-moshi.json')), 'a no-op creates no flag file');
    } finally {
      restoreEnv();
    }
  });
});
