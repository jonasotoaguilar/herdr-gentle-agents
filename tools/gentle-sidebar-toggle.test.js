'use strict';
// Pi-side switch for OUR sidebar integration versus the native Herdr
// sidebar (S7): `/herdr-gentle:sidebar toggle|enable|disable|status`
// (no argument opens a selector, following the Moshi convention).
//
// Enable means OUR sidebar (owned native exclusion +
// `configure` rows apply); disable means NATIVE (owned exclusion removed +
// `unconfigure`, only the plugin-owned row override). The shared mode file
// is `$GENTLE_STATUS_STATE_DIR/gentle-sidebar-mode.json`
// ({version:1,enabled:boolean}); missing defaults to enabled for
// current-install compatibility.
//
// The extension is TypeScript with one package import that is unresolvable
// under plain node, so the test loads a renamed copy with exactly that
// import line stubbed — production is untouched, same approach as
// tools/gentle-moshi-toggle.test.js. A `herdr` shim on PATH plus
// HERDR_BIN_PATH isolates every subprocess (metadata CLI fallback, the
// read-only plugin-root lookup, and the direct configure.js run);
// HERDR_CONFIG_PATH isolates the rows effect. The shim models queued
// acceptance vs actual effect: `plugin action invoke` always exits 0 and
// writes nothing, `plugin list` reports the fixture plugin root, and
// `server reload-config` exits $HERDR_SHIM_RELOAD_EXIT. No live settings,
// sidebar, daemon, or metadata is ever touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = path.resolve(__dirname, '../extensions/gentle-herdr-state.ts');
const srcText = fs.readFileSync(src, 'utf8');
const stubbed = srcText.replace(
  /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
  'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
);
assert.ok(stubbed !== srcText, 'expected the package import line to be stubbed');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-sidebar-toggle-'));
const copy = path.join(root, 'gentle-herdr-state.mjs');
fs.writeFileSync(copy, stubbed);
const copyUrl = pathToFileURL(copy).href;

// Fake `herdr` shim: logs argv lines; `server reload-config` exits
// $HERDR_SHIM_RELOAD_EXIT, `plugin list` prints the fixture root (or exits
// $HERDR_SHIM_LIST_EXIT), `plugin action invoke` models queued acceptance
// (exit 0, writes nothing), everything else exits $HERDR_SHIM_EXIT.
const shimDir = path.join(root, 'shimbin');
fs.mkdirSync(shimDir, { recursive: true });
const shimLog = path.join(root, 'herdr-argv.log');
const shim = path.join(shimDir, 'herdr');
fs.writeFileSync(
  shim,
  [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> "${shimLog}"`,
    'if [ "$1" = "server" ] && [ "$2" = "reload-config" ]; then',
    '  exit "${HERDR_SHIM_RELOAD_EXIT:-${HERDR_SHIM_EXIT:-0}}"',
    'fi',
    'if [ "$1" = "plugin" ] && [ "$2" = "list" ]; then',
    '  code="${HERDR_SHIM_LIST_EXIT:-${HERDR_SHIM_EXIT:-0}}"',
    '  [ "$code" = "0" ] || exit "$code"',
    '  printf \'{"id":"cli:plugin","result":{"plugins":[{"plugin_id":"herdr-gentle-agents","plugin_root":"%s"}]}}\\n\' "$HERDR_SHIM_PLUGIN_ROOT"',
    '  exit 0',
    'fi',
    '# plugin action invoke: queued acceptance only, never an effect.',
    'exit "${HERDR_SHIM_EXIT:-0}"',
    '',
  ].join('\n'),
  { mode: 0o755 },
);

// Fixture "installed" plugin root: a copy of the real self-contained
// bin/configure.js, so the direct synchronous configure run is the
// production script against the isolated HERDR_CONFIG_PATH.
const pluginRoot = path.join(root, 'plugin');
fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
fs.copyFileSync(path.resolve(__dirname, '../bin/configure.js'), path.join(pluginRoot, 'bin', 'configure.js'));
process.env.HERDR_SHIM_PLUGIN_ROOT = pluginRoot;

const COMMAND = 'herdr-gentle:sidebar';
const MOSHI_COMMAND = 'herdr-gentle:moshi';
const NATIVE_ENTRY = '-extensions/herdr-agent-state.ts';
const OTHER_ENTRY = '-extensions/other-state.ts';
const MANAGED_BEGIN = '# BEGIN herdr-gentle-agents (managed; do not edit)';
const MANAGED_END = '# END herdr-gentle-agents';

const stateDir = path.join(root, 'state');
const agentDir = path.join(root, 'agent');
const modeFile = path.join(stateDir, 'gentle-sidebar-mode.json');
const markerFile = path.join(stateDir, 'pi-extension-exclusion-owned');
const settingsFile = path.join(agentDir, 'settings.json');
const nativeHook = path.join(agentDir, 'extensions', 'herdr-agent-state.ts');
const configFile = path.join(root, 'herdr-config.toml');
// Bounded AF_UNIX path: the socket name must stay far under the ~108
// byte sun_path limit even when TMPDIR/the worktree prefix is long, and
// this checkout's repo dir rejects bind(EPERM), so a repo-relative name
// cannot work here. Preference order keeps the socket inside the test
// fixture root when it fits, else a test-owned unique name under the
// user runtime dir (or /tmp as a last resort). The chosen path is fixed
// before the extension import below (the producer reads it at load);
// listen errors reject loudly, the file is always unlinked, and the test
// asserts it is gone — never a hang, never silently skipped.
function pickSocketPath() {
  const unique = `gs-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`;
  const inRoot = path.join(root, 's.sock');
  if (Buffer.byteLength(inRoot) < 90) return inRoot;
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (typeof xdg === 'string' && xdg.length > 0) {
    const candidate = path.join(xdg, unique);
    if (Buffer.byteLength(candidate) < 90) return candidate;
  }
  return path.join('/tmp', unique);
}
const socketPath = pickSocketPath();

process.env.GENTLE_STATUS_STATE_DIR = stateDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.GENTLE_PI_AGENT_HOME;
delete process.env.HERDR_PLUGIN_STATE_DIR;
process.env.HERDR_CONFIG_PATH = configFile;
process.env.HERDR_BIN_PATH = shim;
process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = socketPath;
process.env.HERDR_PANE_ID = 'test-pane';
process.env.PATH = `${shimDir}${path.delimiter}${process.env.PATH}`;

const factoryPromise = import(copyUrl);

function shimCalls() {
  try {
    return fs.readFileSync(shimLog, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function clearShimLog() {
  fs.rmSync(shimLog, { force: true });
}

function resetAgentDir({ nativeInstalled = true, settings } = {}) {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  if (nativeInstalled) fs.writeFileSync(nativeHook, '// native hook\n');
  if (settings !== undefined) {
    fs.writeFileSync(settingsFile, typeof settings === 'string' ? settings : `${JSON.stringify(settings, null, 2)}\n`);
  }
}

function resetState() {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(configFile, { force: true });
  clearShimLog();
  delete process.env.HERDR_SHIM_EXIT;
  delete process.env.HERDR_SHIM_RELOAD_EXIT;
  delete process.env.HERDR_SHIM_LIST_EXIT;
}

function readMode() {
  try {
    return JSON.parse(fs.readFileSync(modeFile, 'utf8'));
  } catch {
    return null;
  }
}

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  } catch {
    return null;
  }
}

function settingsRaw() {
  try {
    return fs.readFileSync(settingsFile, 'utf8');
  } catch {
    return null;
  }
}

function configRaw() {
  try {
    return fs.readFileSync(configFile, 'utf8');
  } catch {
    return null;
  }
}

function seedManagedConfig() {
  fs.writeFileSync(configFile, `# user\n${MANAGED_BEGIN}\n[ui.sidebar.agents.rows_by_agent]\n${MANAGED_END}\n`);
}

// Minimal fake Pi: only the surfaces this feature touches (plus the event
// registries the rest of the factory uses). `registerCommand` is optional on
// purpose — installed harnesses without it must keep loading the extension.
function harness({ withCommand = true, select = undefined } = {}) {
  const commands = new Map();
  const notices = [];
  const selects = [];
  const handlers = new Map();
  const emitted = [];
  const pi = {
    on: (event, handler) => {
      handlers.set(event, handler);
    },
    events: {
      on: () => {},
      emit: (event, payload) => {
        emitted.push([event, payload]);
      },
    },
  };
  if (withCommand) {
    pi.registerCommand = (name, spec) => {
      commands.set(name, spec);
    };
  }
  const ctx = {
    mode: 'tui',
    sessionManager: {
      getSessionId: () => 'test-session',
      getSessionFile: () => path.join(root, 'session.jsonl'),
      getEntries: () => [],
    },
    isIdle: () => false,
    ui: {
      notify: (message, kind) => notices.push([message, kind]),
      select: async (title, items) => {
        selects.push([title, items]);
        if (typeof select === 'function') return select(title, items);
        return select;
      },
    },
  };
  return { pi, commands, notices, selects, handlers, emitted, ctx };
}

async function run(h, args) {
  await h.commands.get(COMMAND).handler(args, h.ctx);
}

test('registers /herdr-gentle:sidebar; missing mode defaults to enabled and status writes nothing', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  assert.ok(h.commands.has(COMMAND), `expected the /${COMMAND} command`);

  await run(h, 'status');
  assert.equal(readMode(), null, 'status must not create the mode file');
  assert.ok(!fs.existsSync(stateDir), 'status must not mkdir the state dir');
  assert.equal(settingsRaw(), null, 'status must not create settings.json');
  assert.equal(configRaw(), null, 'status must not create the Herdr config');
  assert.deepEqual(shimCalls(), [], 'status must not invoke herdr');
  assert.match(h.notices.at(-1)[0], /enabled|ours/i, 'missing mode reports enabled for compatibility');
});

test('enable converges: mode, owned exclusion, verified rows, /reload notice', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { theme: 'x', extensions: [OTHER_ENTRY] } });
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  assert.deepEqual(readMode(), { version: 1, enabled: true });
  const settings = readSettings();
  assert.deepEqual(settings.extensions, [OTHER_ENTRY, NATIVE_ENTRY]);
  assert.equal(settings.theme, 'x', 'unrelated keys are preserved');
  const body = configRaw() ?? '';
  assert.ok(body.includes(MANAGED_BEGIN) && body.includes(MANAGED_END), 'managed rows were actually written');
  const calls = shimCalls();
  assert.ok(calls.some((c) => c.includes('plugin list')), 'installed root resolved via read-only plugin list');
  assert.ok(!calls.some((c) => c.includes('action invoke')), 'no acceptance-based action invoke drives the outcome');
  assert.match(h.notices.at(-1)[0], /enabled \(ours\)/);
  assert.match(h.notices.at(-1)[0], /Managed rows applied and verified/);
  assert.doesNotMatch(h.notices.at(-1)[0], /accepted|reload applied through/i, 'never claims completion on acceptance');
  assert.match(h.notices.at(-1)[0], /\/reload/, 'enable warns that running sessions need /reload');
  assert.equal(h.notices.at(-1)[1], 'info');
});

test('enable refuses when the installed plugin root cannot be resolved', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  const before = settingsRaw();
  process.env.HERDR_SHIM_LIST_EXIT = '1';
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  delete process.env.HERDR_SHIM_LIST_EXIT;
  assert.equal(h.notices.at(-1)[1], 'error');
  assert.match(h.notices.at(-1)[0], /plugin root|resolve/i);
  assert.equal(readMode(), null, 'mode never committed without completion proof');
  assert.equal(settingsRaw(), before, 'settings untouched');
  assert.equal(configRaw(), null, 'config untouched');
});

test('enable is idempotent: single entry, converged state, no duplication', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  seedManagedConfig();
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  await run(h, 'enable');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'no duplicate entry');
  assert.deepEqual(readMode(), { version: 1, enabled: true });
});

test('disable converges: mode false, only the owned entry removed, rows verified', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY], model: 'm' } });
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'enable stages the owned entry');
  clearShimLog();
  await run(h, 'disable');
  assert.deepEqual(readMode(), { version: 1, enabled: false });
  const settings = readSettings();
  assert.deepEqual(settings.extensions, [OTHER_ENTRY], 'only the owned entry is removed');
  assert.equal(settings.model, 'm', 'unrelated keys are preserved');
  const body = configRaw() ?? '';
  assert.ok(!(body.includes(MANAGED_BEGIN) && body.includes(MANAGED_END)), 'managed rows were actually removed');
  assert.match(h.notices.at(-1)[0], /disabled \(native/);
  assert.match(h.notices.at(-1)[0], /Managed rows removed and verified/);
  assert.doesNotMatch(h.notices.at(-1)[0], /accepted|reload applied through/i);
  assert.match(h.notices.at(-1)[0], /\/reload/);
});

test('disable reload failure restores exclusion, mode, and rows', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  assert.deepEqual(readMode(), { version: 1, enabled: true }, 'seeded enabled');
  process.env.HERDR_SHIM_RELOAD_EXIT = '1';
  await run(h, 'disable');
  delete process.env.HERDR_SHIM_RELOAD_EXIT;
  assert.equal(h.notices.at(-1)[1], 'error');
  assert.match(h.notices.at(-1)[0], /re-run \/herdr-gentle:sidebar disable/i, 'explicit recoverable state');
  assert.deepEqual(readMode(), { version: 1, enabled: true }, 'mode unchanged');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'owned exclusion restored');
  assert.ok(fs.existsSync(markerFile), 'ownership record kept');
  const body = configRaw() ?? '';
  assert.ok(body.includes(MANAGED_BEGIN) && body.includes(MANAGED_END), 'prior owned rows restored');
});

test('disable is idempotent and toggle cycles missing -> disable -> enable -> disable', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);

  await run(h, 'toggle');
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'missing (enabled) toggles to disabled');
  await run(h, 'toggle');
  assert.deepEqual(readMode(), { version: 1, enabled: true }, 'disabled toggles to enabled');
  await run(h, 'toggle');
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'enabled toggles to disabled');
  await run(h, 'disable');
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'repeat disable is a no-op state');
});

test('an unknown option changes nothing and says so', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  fs.writeFileSync(configFile, '# user config\n');
  const beforeSettings = settingsRaw();
  const beforeConfig = configRaw();
  const h = harness();
  factory(h.pi);

  await run(h, 'banana');
  assert.equal(readMode(), null, 'mode untouched');
  assert.equal(settingsRaw(), beforeSettings, 'settings untouched');
  assert.equal(configRaw(), beforeConfig, 'config untouched');
  assert.deepEqual(shimCalls(), [], 'herdr never invoked');
  assert.equal(h.notices.at(-1)[1], 'error');
  assert.match(h.notices.at(-1)[0], /toggle\|enable\|disable\|status/);
});

test('no argument opens the selector and applies the chosen option', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness({ select: () => 'Disable' });
  factory(h.pi);

  await run(h, '');
  assert.equal(h.selects.length, 1, 'a selector is offered');
  assert.equal(h.selects[0][1].length, 3);
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'the chosen option is applied');
});

test('no argument with no selector falls back to status without writes', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness({ select: undefined });
  delete h.ctx.ui.select;
  factory(h.pi);

  await run(h, '');
  assert.equal(readMode(), null, 'fallback status writes nothing');
  assert.match(h.notices.at(-1)[0], /enabled|ours/i);
});

test('status reports exclusion and managed-rows state', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [NATIVE_ENTRY] } });
  seedManagedConfig();
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  await run(h, 'status');
  const message = h.notices.at(-1)[0];
  assert.match(message, /enabled|ours/i);
  assert.match(message, /herdr-agent-state\.ts/);
  assert.match(message, /excluded yes/i);
  assert.match(message, /managed/i);
});

test('foreign or misbound marker refuses with everything preserved', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  const before = settingsRaw();
  // Foreign record: authorizes a different entry.
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    markerFile,
    `${JSON.stringify({ version: 1, entry: '-extensions/someone-else.ts', settings: settingsFile })}\n`,
  );
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  assert.equal(h.notices.at(-1)[1], 'error');
  assert.equal(readMode(), null, 'mode untouched on foreign marker');
  assert.equal(settingsRaw(), before, 'settings untouched on foreign marker');
  assert.deepEqual(shimCalls(), [], 'herdr untouched on foreign marker');

  // Misbound record: bound to another settings file.
  fs.writeFileSync(
    markerFile,
    `${JSON.stringify({ version: 1, entry: NATIVE_ENTRY, settings: '/elsewhere/settings.json' })}\n`,
  );
  await run(h, 'disable');
  assert.equal(h.notices.at(-1)[1], 'error');
  assert.equal(readMode(), null, 'mode untouched on misbound marker');
  assert.equal(settingsRaw(), before, 'settings untouched on misbound marker');
});

test('preexisting user exclusion is preserved: disable keeps it, enable does not adopt it', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY, NATIVE_ENTRY] } });
  const h = harness();
  factory(h.pi);

  await run(h, 'disable');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'user entry preserved');
  assert.ok(!fs.existsSync(markerFile), 'no ownership taken on remove');
  assert.deepEqual(readMode(), { version: 1, enabled: false });

  await run(h, 'enable');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'user entry left as-is');
  assert.ok(!fs.existsSync(markerFile), 'foreign entry is never adopted');
  assert.deepEqual(readMode(), { version: 1, enabled: true });
});

test('enable leaves settings.json untouched when the native hook is absent', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ nativeInstalled: false, settings: { extensions: [OTHER_ENTRY] } });
  const before = settingsRaw();
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  assert.deepEqual(readMode(), { version: 1, enabled: true }, 'our sidebar still turns on');
  assert.equal(settingsRaw(), before, 'settings bytes are unchanged without the native target');
});

test('invalid settings.json fails closed with no mode write and no herdr invoke', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: '{ not json' });
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  assert.equal(h.notices.at(-1)[1], 'error', 'the failure is reported');
  assert.equal(readMode(), null, 'mode is not written when settings cannot be read');
  assert.equal(settingsRaw(), '{ not json', 'the unparseable file is never rewritten');
  assert.deepEqual(shimCalls(), [], 'configure is never invoked after a settings failure');
});

test('configure failure leaves mode, settings, and config untouched', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  const before = settingsRaw();
  process.env.HERDR_SHIM_EXIT = '1';
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  delete process.env.HERDR_SHIM_EXIT;
  assert.equal(h.notices.at(-1)[1], 'error');
  assert.match(h.notices.at(-1)[0], /re-run|recover|resolve/i, 'explicit recoverable state');
  assert.equal(readMode(), null, 'mode never committed without completion proof');
  assert.equal(settingsRaw(), before, 'settings untouched when completion fails first');
  assert.ok(!fs.existsSync(markerFile), 'no orphaned ownership record');
  assert.equal(configRaw(), null, 'config untouched');
});

test('package enable reload failure restores mode, exclusion, and rows', async () => {
  const sidebar = require('../lib/gentle-sidebar.js');
  const libRoot = fs.mkdtempSync(path.join(root, 'libfix-'));
  const env = {
    GENTLE_STATUS_STATE_DIR: path.join(libRoot, 'state'),
    PI_CODING_AGENT_DIR: path.join(libRoot, 'agent'),
    HERDR_CONFIG_PATH: path.join(libRoot, 'config.toml'),
  };
  fs.mkdirSync(path.join(env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(env.PI_CODING_AGENT_DIR, 'extensions', 'herdr-agent-state.ts'), '// native\n');
  const savedConfig = process.env.HERDR_CONFIG_PATH;
  process.env.HERDR_CONFIG_PATH = env.HERDR_CONFIG_PATH;
  process.env.HERDR_SHIM_RELOAD_EXIT = '1';
  let result;
  try {
    result = sidebar.enable(env);
  } finally {
    delete process.env.HERDR_SHIM_RELOAD_EXIT;
    if (savedConfig === undefined) delete process.env.HERDR_CONFIG_PATH;
    else process.env.HERDR_CONFIG_PATH = savedConfig;
  }
  assert.equal(result.code, 1);
  assert.match(result.message, /re-run|converge/i);
  assert.ok(!fs.existsSync(path.join(env.GENTLE_STATUS_STATE_DIR, 'gentle-sidebar-mode.json')), 'mode rolled back');
  const body = fs.existsSync(env.HERDR_CONFIG_PATH) ? fs.readFileSync(env.HERDR_CONFIG_PATH, 'utf8') : '';
  assert.ok(!body.includes(MANAGED_BEGIN), 'stranded managed rows removed');
  const settings = fs.existsSync(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'))
    ? JSON.parse(fs.readFileSync(path.join(env.PI_CODING_AGENT_DIR, 'settings.json'), 'utf8'))
    : {};
  assert.ok(!((settings.extensions ?? []).includes(NATIVE_ENTRY)), 'exclusion rolled back');
  assert.ok(!fs.existsSync(path.join(env.GENTLE_STATUS_STATE_DIR, 'pi-extension-exclusion-owned')), 'no orphaned marker');
});

test('package disable reload failure restores exclusion, mode, and rows', async () => {
  const sidebar = require('../lib/gentle-sidebar.js');
  const libRoot = fs.mkdtempSync(path.join(root, 'libfix-'));
  const env = {
    GENTLE_STATUS_STATE_DIR: path.join(libRoot, 'state'),
    PI_CODING_AGENT_DIR: path.join(libRoot, 'agent'),
    HERDR_CONFIG_PATH: path.join(libRoot, 'config.toml'),
  };
  fs.mkdirSync(path.join(env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(env.PI_CODING_AGENT_DIR, 'extensions', 'herdr-agent-state.ts'), '// native\n');
  const savedConfig = process.env.HERDR_CONFIG_PATH;
  process.env.HERDR_CONFIG_PATH = env.HERDR_CONFIG_PATH;
  try {
    const seeded = sidebar.enable(env);
    assert.equal(seeded.code, 0, `seed enable must succeed: ${seeded.message}`);
    process.env.HERDR_SHIM_RELOAD_EXIT = '1';
    const result = sidebar.disable(env);
    assert.equal(result.code, 1);
    assert.match(result.message, /re-run|converge/i);
    assert.deepEqual(sidebar.readMode(env), { state: 'enabled', publish: true }, 'mode unchanged');
    const body = fs.readFileSync(env.HERDR_CONFIG_PATH, 'utf8');
    assert.ok(body.includes(MANAGED_BEGIN) && body.includes(MANAGED_END), 'prior owned rows restored');
  } finally {
    delete process.env.HERDR_SHIM_RELOAD_EXIT;
    if (savedConfig === undefined) delete process.env.HERDR_CONFIG_PATH;
    else process.env.HERDR_CONFIG_PATH = savedConfig;
  }
});

test('malformed mode is reported and never publishes: toggle refuses, producer stays silent', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{ enabled: yes }');
  const beforeSettings = settingsRaw();
  const h = harness();
  factory(h.pi);

  await run(h, 'toggle');
  assert.equal(h.notices.at(-1)[1], 'error');
  assert.match(h.notices.at(-1)[0], /malformed|invalid/i);
  assert.equal(settingsRaw(), beforeSettings, 'no settings mutation on malformed mode');
  assert.deepEqual(shimCalls(), [], 'no herdr invoke on malformed mode');

  await run(h, 'status');
  assert.match(h.notices.at(-1)[0], /malformed|invalid|unknown/i);
});

test('disabled producer publishes nothing and claims no native lifecycle', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  clearShimLog();
  // Bounded socket setup: the pre-selected short socketPath cannot exceed
  // the AF_UNIX limit; listen errors reject loudly instead of hanging.
  fs.rmSync(socketPath, { force: true });
  const serverHits = [];
  const server = net.createServer((socket) => {
    serverHits.push('connect');
    socket.on('data', () => {
      socket.write('{}\n');
    });
  });
  server.on('error', () => {}); // Rejection below carries the failure.
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });

  const feed = async (h) => {
    await h.handlers.get('session_start')({}, h.ctx);
    h.handlers.get('message_end')({
      message: {
        role: 'custom',
        customType: 'gentle-agents.result',
        details: { gentleAgents: { taskId: 't1', agent: 'worker', status: 'running' } },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 1500));
  };

  try {
    // Control: missing mode (enabled default) publishes over the socket.
    const enabledHarness = harness();
    factory(enabledHarness.pi);
    await feed(enabledHarness);
    assert.ok(serverHits.length > 0, 'control harness publishes while enabled');

    // Disabled: silence on every channel.
    serverHits.length = 0;
    clearShimLog();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(modeFile, `${JSON.stringify({ version: 1, enabled: false })}\n`);
    const disabledHarness = harness();
    factory(disabledHarness.pi);
    await feed(disabledHarness);
    assert.deepEqual(serverHits, [], 'no socket publish while disabled');
    assert.ok(
      !shimCalls().some((c) => c.includes('report-metadata')),
      `no CLI metadata fallback while disabled, saw: ${JSON.stringify(shimCalls())}`,
    );
    assert.deepEqual(
      disabledHarness.emitted.filter(([event]) => event === 'herdr:blocked'),
      [],
      'no herdr:blocked claims while disabled',
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(socketPath, { force: true });
    assert.ok(!fs.existsSync(socketPath), 'generated socket is cleaned up');
  }
});

test('sidebar work leaves the Moshi switch untouched and registered', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  assert.ok(h.commands.has(MOSHI_COMMAND), 'Moshi command still registered');

  await run(h, 'enable');
  assert.equal(readMode().enabled, true);
  const moshiFlag = path.join(stateDir, 'gentle-moshi.json');
  assert.ok(!fs.existsSync(moshiFlag), 'sidebar enable never writes the Moshi flag');

  await h.commands.get(MOSHI_COMMAND).handler('enable', h.ctx);
  assert.equal(JSON.parse(fs.readFileSync(moshiFlag, 'utf8')).enabled, true, 'Moshi enable still works');
  await h.commands.get(MOSHI_COMMAND).handler('status', h.ctx);
  assert.match(h.notices.at(-1)[0], /moshi/i);
});

test('loads without registerCommand (older/limited hosts)', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness({ withCommand: false });
  assert.doesNotThrow(() => factory(h.pi));
});

test('package CLI status is read-only: exit 0, no writes', async () => {
  resetState();
  resetAgentDir();
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../bin/gentle-sidebar.js'), 'status'],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        GENTLE_STATUS_STATE_DIR: stateDir,
        PI_CODING_AGENT_DIR: agentDir,
        HERDR_CONFIG_PATH: configFile,
      },
    },
  );
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.match(result.stdout, /enabled \(default/);
  assert.equal(readMode(), null, 'status writes no mode file');
  assert.equal(settingsRaw(), null, 'status writes no settings');
  assert.equal(configRaw(), null, 'status writes no config');
});

test('package CLI rejects unknown verbs: exit 2, stores unchanged', async () => {
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  const before = settingsRaw();
  const { spawnSync } = require('node:child_process');
  const result = spawnSync(
    process.execPath,
    [path.resolve(__dirname, '../bin/gentle-sidebar.js'), 'banana'],
    {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        GENTLE_STATUS_STATE_DIR: stateDir,
        PI_CODING_AGENT_DIR: agentDir,
        HERDR_CONFIG_PATH: configFile,
      },
    },
  );
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage/);
  assert.equal(readMode(), null, 'mode untouched');
  assert.equal(settingsRaw(), before, 'settings untouched');
});
