'use strict';
// Pi-side switch for OUR sidebar integration versus the native Herdr
// sidebar (S7), now reached through the `/herdr-gentle:customize` panel
// (customize-command T2/S7: the `/herdr-gentle:sidebar` command is removed
// outright). These tests keep every state-level assertion of the old
// command suite — mode file bytes, owned exclusion entries, verified
// configure rows, rollback, fail-closed behaviour — repointed at the
// provider slot the state extension registers
// (`globalThis[Symbol.for("herdr-gentle.customize.v1")].sidebar`), whose
// `apply` reuses the same `sidebarEnable` / `sidebarDisable` paths
// unchanged. Only the command-handler UX tests (selector, toggle verb,
// unknown verb, `status` text) are gone with the command; the read-only
// reporting they offered lives on as `customize status`.
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
    '  want=""',
    '  prev=""',
    '  for a in "$@"; do',
    '    if [ "$prev" = "--plugin" ]; then want="$a"; fi',
    '    prev="$a"',
    '  done',
    '  [ -n "$want" ] || want="herdr-gentle-agents"',
    '  ids="${HERDR_SHIM_LIST_IDS:-herdr-gentle-agents herdr-gentle-shell}"',
    '  hit=0',
    '  for id in $ids; do',
    '    if [ "$id" = "$want" ]; then hit=1; fi',
    '  done',
    '  if [ "${HERDR_SHIM_LIST_MODE:-single}" = "multiple" ] && [ "$hit" = "1" ]; then',
    '    printf \'{"id":"cli:plugin","result":{"plugins":[{"plugin_id":"%s","plugin_root":"%s-a"},{"plugin_id":"%s","plugin_root":"%s-b"}]}}\\n\' "$want" "$HERDR_SHIM_PLUGIN_ROOT" "$want" "$HERDR_SHIM_PLUGIN_ROOT"',
    '    exit 0',
    '  fi',
    '  if [ "$hit" = "1" ]; then',
    '    printf \'{"id":"cli:plugin","result":{"plugins":[{"plugin_id":"%s","plugin_root":"%s"}]}}\\n\' "$want" "$HERDR_SHIM_PLUGIN_ROOT"',
    '  else',
    '    printf \'{"id":"cli:plugin","result":{"plugins":[]}}\n\'',
    '  fi',
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
fs.copyFileSync(path.resolve(__dirname, '../herdr-plugin/bin/configure.js'), path.join(pluginRoot, 'bin', 'configure.js'));
process.env.HERDR_SHIM_PLUGIN_ROOT = pluginRoot;

const SLOT_KEY = 'herdr-gentle.customize.v1';
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
function harness({ withCommand = true } = {}) {
  const commands = new Map();
  const notices = [];
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
    },
  };
  return { pi, commands, notices, handlers, emitted, ctx };
}

function slotOf() {
  const slot = globalThis[Symbol.for(SLOT_KEY)];
  assert.ok(slot && typeof slot === 'object', 'expected the provider slot to be registered at load');
  assert.equal(typeof slot.sidebar.read, 'function', 'sidebar.read');
  assert.equal(typeof slot.sidebar.apply, 'function', 'sidebar.apply');
  return slot;
}

test('no /herdr-gentle:sidebar command; missing mode reads as gentle and read writes nothing', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  assert.ok(!h.commands.has('herdr-gentle:sidebar'), 'the command is removed outright (S7)');
  assert.equal(slotOf().sidebar.read(), 'gentle', 'missing mode reports enabled for compatibility');
  assert.equal(readMode(), null, 'read must not create the mode file');
  assert.ok(!fs.existsSync(stateDir), 'read must not mkdir the state dir');
  assert.equal(settingsRaw(), null, 'read must not create settings.json');
  assert.equal(configRaw(), null, 'read must not create the Herdr config');
  assert.deepEqual(shimCalls(), [], 'read must not invoke herdr');
});

test('apply gentle converges: mode, owned exclusion, verified rows, always reloads', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { theme: 'x', extensions: [OTHER_ENTRY] } });
  // Seed disabled: applying the already-read value is a no-op by design,
  // so the full path needs a real change.
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const result = await slot.sidebar.apply('gentle', h.ctx);
  assert.deepEqual({ changed: result.changed, needsReload: result.needsReload }, { changed: true, needsReload: true },
    'S6: the sidebar switch always reloads');
  assert.match(result.text, /ours/, 'the verdict says what changed');
  assert.ok(!result.text.includes('/reload'), 'the panel never asks the user to run /reload');
  assert.deepEqual(readMode(), { version: 1, enabled: true });
  const settings = readSettings();
  assert.deepEqual(settings.extensions, [OTHER_ENTRY, NATIVE_ENTRY]);
  assert.equal(settings.theme, 'x', 'unrelated keys are preserved');
  const body = configRaw() ?? '';
  assert.ok(body.includes(MANAGED_BEGIN) && body.includes(MANAGED_END), 'managed rows were actually written');
  const calls = shimCalls();
  assert.ok(calls.some((c) => c.includes('plugin list')), 'installed root resolved via read-only plugin list');
  assert.ok(!calls.some((c) => c.includes('action invoke')), 'no acceptance-based action invoke drives the outcome');
});

test('apply refuses when the installed plugin root cannot be resolved', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  const before = settingsRaw();
  process.env.HERDR_SHIM_LIST_EXIT = '1';
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const result = await slot.sidebar.apply('gentle', h.ctx);
  delete process.env.HERDR_SHIM_LIST_EXIT;
  assert.deepEqual({ changed: result.changed, needsReload: result.needsReload }, { changed: false, needsReload: false });
  assert.match(result.text, /plugin root|resolve/i);
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'mode never committed without completion proof');
  assert.equal(settingsRaw(), before, 'settings untouched');
  assert.equal(configRaw(), null, 'config untouched');
});

test('apply is idempotent: single entry, converged state, no duplication', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  seedManagedConfig();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const first = await slot.sidebar.apply('gentle', h.ctx);
  assert.equal(first.changed, true);
  const second = await slot.sidebar.apply('gentle', h.ctx);
  assert.deepEqual({ changed: second.changed, needsReload: second.needsReload }, { changed: false, needsReload: false },
    'the already-active value changes nothing');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'no duplicate entry');
  assert.deepEqual(readMode(), { version: 1, enabled: true });
});

test('apply native converges: mode false, only the owned entry removed, rows verified', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY], model: 'm' } });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const enabled = await slot.sidebar.apply('gentle', h.ctx);
  assert.equal(enabled.changed, true, 'staging apply converges first');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'apply stages the owned entry');
  clearShimLog();
  const disabled = await slot.sidebar.apply('native', h.ctx);
  assert.deepEqual({ changed: disabled.changed, needsReload: disabled.needsReload }, { changed: true, needsReload: true },
    'S6: the sidebar switch always reloads');
  assert.deepEqual(readMode(), { version: 1, enabled: false });
  const settings = readSettings();
  assert.deepEqual(settings.extensions, [OTHER_ENTRY], 'only the owned entry is removed');
  assert.equal(settings.model, 'm', 'unrelated keys are preserved');
  const body = configRaw() ?? '';
  assert.ok(!(body.includes(MANAGED_BEGIN) && body.includes(MANAGED_END)), 'managed rows were actually removed');
});

test('apply native reload failure restores exclusion, mode, and rows', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const enabled = await slot.sidebar.apply('gentle', h.ctx);
  assert.equal(enabled.changed, true, 'staging apply converges first');
  assert.deepEqual(readMode(), { version: 1, enabled: true }, 'seeded enabled');
  process.env.HERDR_SHIM_RELOAD_EXIT = '1';
  const result = await slot.sidebar.apply('native', h.ctx);
  delete process.env.HERDR_SHIM_RELOAD_EXIT;
  assert.deepEqual({ changed: result.changed, needsReload: result.needsReload }, { changed: false, needsReload: false });
  assert.match(result.text, /customize|converge/i, 'explicit recoverable state');
  assert.deepEqual(readMode(), { version: 1, enabled: true }, 'mode unchanged');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'owned exclusion restored');
  assert.ok(fs.existsSync(markerFile), 'ownership record kept');
  const body = configRaw() ?? '';
  assert.ok(body.includes(MANAGED_BEGIN) && body.includes(MANAGED_END), 'prior owned rows restored');
});

test('apply is a no-op for the already-active value; apply cycles missing -> native -> gentle -> native', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  // Missing mode reads as gentle, so the first real change is to native.
  // (The old `toggle` verb is gone with the command; the panel rows carry
  // the same cycle through explicit values.)
  const first = await slot.sidebar.apply('native', h.ctx);
  assert.equal(first.changed, true);
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'missing (gentle) applies to native');
  await slot.sidebar.apply('gentle', h.ctx);
  assert.deepEqual(readMode(), { version: 1, enabled: true }, 'native applies to gentle');
  await slot.sidebar.apply('native', h.ctx);
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'gentle applies to native');
  const repeat = await slot.sidebar.apply('native', h.ctx);
  assert.deepEqual({ changed: repeat.changed, needsReload: repeat.needsReload }, { changed: false, needsReload: false },
    'repeat native is a no-op state');
  assert.deepEqual(readMode(), { version: 1, enabled: false });
});

test('an unknown value changes nothing', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  fs.writeFileSync(configFile, '# user config\n');
  const beforeSettings = settingsRaw();
  const beforeConfig = configRaw();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const result = await slot.sidebar.apply('banana', h.ctx);
  assert.deepEqual({ changed: result.changed, needsReload: result.needsReload }, { changed: false, needsReload: false });
  assert.equal(readMode(), null, 'mode untouched');
  assert.equal(settingsRaw(), beforeSettings, 'settings untouched');
  assert.equal(configRaw(), beforeConfig, 'config untouched');
  assert.deepEqual(shimCalls(), [], 'herdr never invoked');
});

// NOTE (customize-command T2/S7): the no-argument selector, the
// no-selector status fallback, and the `status` verb died with the
// command. Panel selection coverage lives in tools/customize-panel.test.js
// and the read-only reporting lives on as `customize status` (pinned
// there as `customize status: sidebar=… moshi=… worktree=…`).
test('foreign or misbound marker refuses with everything preserved', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  // Seed disabled so both applies below take the changing path (applying
  // the already-read value is a no-op by design).
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  const before = settingsRaw();
  // Foreign record: authorizes a different entry.
  fs.writeFileSync(
    markerFile,
    `${JSON.stringify({ version: 1, entry: '-extensions/someone-else.ts', settings: settingsFile })}\n`,
  );
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const foreign = await slot.sidebar.apply('gentle', h.ctx);
  assert.deepEqual({ changed: foreign.changed, needsReload: foreign.needsReload }, { changed: false, needsReload: false });
  assert.match(foreign.text, /foreign|invalid|resolving/i);
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'mode untouched on foreign marker');
  assert.equal(settingsRaw(), before, 'settings untouched on foreign marker');
  assert.deepEqual(shimCalls(), [], 'herdr untouched on foreign marker');

  // Misbound record: bound to another settings file.
  fs.writeFileSync(
    markerFile,
    `${JSON.stringify({ version: 1, entry: NATIVE_ENTRY, settings: '/elsewhere/settings.json' })}\n`,
  );
  const misbound = await slot.sidebar.apply('gentle', h.ctx);
  assert.deepEqual({ changed: misbound.changed, needsReload: misbound.needsReload }, { changed: false, needsReload: false });
  assert.match(misbound.text, /misbound|bound|resolving/i);
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'mode untouched on misbound marker');
  assert.equal(settingsRaw(), before, 'settings untouched on misbound marker');
});

test('preexisting user exclusion is preserved: native keeps it, gentle does not adopt it', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY, NATIVE_ENTRY] } });
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const native = await slot.sidebar.apply('native', h.ctx);
  assert.equal(native.changed, true, 'missing reads as gentle, so native is a change');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'user entry preserved');
  assert.ok(!fs.existsSync(markerFile), 'no ownership taken on remove');
  assert.deepEqual(readMode(), { version: 1, enabled: false });

  await slot.sidebar.apply('gentle', h.ctx);
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, NATIVE_ENTRY], 'user entry left as-is');
  assert.ok(!fs.existsSync(markerFile), 'foreign entry is never adopted');
  assert.deepEqual(readMode(), { version: 1, enabled: true });
});

test('apply leaves settings.json untouched when the native hook is absent', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ nativeInstalled: false, settings: { extensions: [OTHER_ENTRY] } });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  const before = settingsRaw();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  await slot.sidebar.apply('gentle', h.ctx);
  assert.deepEqual(readMode(), { version: 1, enabled: true }, 'our sidebar still turns on');
  assert.equal(settingsRaw(), before, 'settings bytes are unchanged without the native target');
});

test('invalid settings.json fails closed with no mode write and no herdr invoke', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: '{ not json' });
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  // Missing mode reads as gentle, so native takes the changing path and
  // hits the unreadable-settings preflight before anything mutates.
  const result = await slot.sidebar.apply('native', h.ctx);
  assert.deepEqual({ changed: result.changed, needsReload: result.needsReload }, { changed: false, needsReload: false });
  assert.match(result.text, /unreadable|invalid/i, 'the failure is reported');
  assert.equal(readMode(), null, 'mode is not written when settings cannot be read');
  assert.equal(settingsRaw(), '{ not json', 'the unparseable file is never rewritten');
  assert.deepEqual(shimCalls(), [], 'configure is never invoked after a settings failure');
});

test('configure failure leaves mode, settings, and config untouched', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  const before = settingsRaw();
  process.env.HERDR_SHIM_EXIT = '1';
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const result = await slot.sidebar.apply('gentle', h.ctx);
  delete process.env.HERDR_SHIM_EXIT;
  assert.deepEqual({ changed: result.changed, needsReload: result.needsReload }, { changed: false, needsReload: false });
  assert.match(result.text, /customize|converge/i, 'explicit recoverable state');
  assert.deepEqual(readMode(), { version: 1, enabled: false }, 'mode never committed without completion proof');
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

test('malformed mode reads as native and a native apply writes nothing', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{ enabled: yes }');
  const beforeSettings = settingsRaw();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  // Malformed never enables (fail closed): the panel marks Gentle inactive
  // and applying the read value is a no-op (the old `toggle` refusal and
  // `status` report died with the command; read-only reporting lives on
  // as `customize status`).
  assert.equal(slot.sidebar.read(), 'native');
  const result = await slot.sidebar.apply('native', h.ctx);
  assert.deepEqual({ changed: result.changed, needsReload: result.needsReload }, { changed: false, needsReload: false });
  assert.equal(settingsRaw(), beforeSettings, 'no settings mutation on malformed mode');
  assert.deepEqual(shimCalls(), [], 'no herdr invoke on malformed mode');
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

test('sidebar work leaves the Moshi switch untouched; both providers share the slot', async () => {
  const loaded = await factoryPromise;
  const factory = loaded.default;
  // Stubbed S38 prerequisites (never a real spawn): CLI present, paired.
  loaded.setMoshiHookResolver(() => '/test-only/moshi-hook');
  loaded.setMoshiStatusRunner(() => ({ ok: true }));
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();
  assert.ok(slot.moshi && typeof slot.moshi.apply === 'function', 'the moshi provider shares the slot');

  const result = await slot.sidebar.apply('native', h.ctx);
  assert.equal(result.changed, true);
  assert.deepEqual(readMode(), { version: 1, enabled: false });
  const moshiFlag = path.join(stateDir, 'gentle-moshi.json');
  assert.ok(!fs.existsSync(moshiFlag), 'sidebar apply never writes the Moshi flag');

  const moshi = await slot.moshi.apply('on', h.ctx);
  assert.equal(moshi.changed, true, 'moshi apply still works through the slot');
  assert.equal(JSON.parse(fs.readFileSync(moshiFlag, 'utf8')).enabled, true);
  assert.equal(slot.moshi.read(), 'on');
  loaded.setMoshiHookResolver(null);
  loaded.setMoshiStatusRunner(null);
});

test('loads without registerCommand (older/limited hosts)', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness({ withCommand: false });
  assert.doesNotThrow(() => factory(h.pi));
  assert.ok(slotOf().sidebar, 'the provider slot registers without commands');
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

// S15 identity rename: the active plugin lookup uses herdr-gentle-shell
// while pre-rename installs (herdr-gentle-agents) keep resolving, and the
// stored state dir stays on the legacy segment even when Herdr injects a
// new-id state dir. HERDR_SHIM_LIST_IDS bounds which ids the fake list
// answers with; GENTLE_STATUS_STATE_DIR is the explicit user override and
// always wins (its semantics are preserved, no fallback).
test('provider resolves the active new plugin id', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  process.env.HERDR_SHIM_LIST_IDS = 'herdr-gentle-shell';
  try {
    const h = harness();
    factory(h.pi);
    const result = await slotOf().sidebar.apply('gentle', h.ctx);
    assert.equal(result.changed, true, `new-id lookup must converge: ${result.text}`);
    assert.deepEqual(readMode(), { version: 1, enabled: true });
  } finally {
    delete process.env.HERDR_SHIM_LIST_IDS;
  }
});

test('provider falls back to the retired plugin id', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  process.env.HERDR_SHIM_LIST_IDS = 'herdr-gentle-agents';
  try {
    const h = harness();
    factory(h.pi);
    const result = await slotOf().sidebar.apply('gentle', h.ctx);
    assert.equal(result.changed, true, `legacy-id lookup must keep converging: ${result.text}`);
    assert.deepEqual(readMode(), { version: 1, enabled: true });
  } finally {
    delete process.env.HERDR_SHIM_LIST_IDS;
  }
});

test('provider refuses on ambiguous plugin roots without touching state', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(modeFile, '{"version":1,"enabled":false}\n');
  const beforeSettings = settingsRaw();
  process.env.HERDR_SHIM_LIST_IDS = 'herdr-gentle-shell';
  process.env.HERDR_SHIM_LIST_MODE = 'multiple';
  try {
    const h = harness();
    factory(h.pi);
    const result = await slotOf().sidebar.apply('gentle', h.ctx);
    assert.deepEqual({ changed: result.changed, needsReload: result.needsReload }, { changed: false, needsReload: false });
    assert.match(result.text, /ambiguous|resolve/i);
    assert.deepEqual(readMode(), { version: 1, enabled: false }, 'mode untouched on ambiguity');
    assert.equal(settingsRaw(), beforeSettings, 'settings untouched on ambiguity');
  } finally {
    delete process.env.HERDR_SHIM_LIST_IDS;
    delete process.env.HERDR_SHIM_LIST_MODE;
  }
});

test('injected new-id state dir keeps pre-rename flags readable', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const savedGentleDir = process.env.GENTLE_STATUS_STATE_DIR;
  const savedHerdrDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const savedXdg = process.env.XDG_STATE_HOME;
  const sandbox = fs.mkdtempSync(path.join(root, 'xdg-'));
  const legacyDir = path.join(sandbox, 'herdr', 'plugins', 'herdr-gentle-agents');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
  delete process.env.GENTLE_STATUS_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(sandbox, 'injected-shell');
  process.env.XDG_STATE_HOME = sandbox;
  try {
    const h = harness();
    factory(h.pi);
    assert.equal(slotOf().sidebar.read(), 'native', 'the stored disabled flag must win over the empty injected dir');
    assert.equal(slotOf().moshi.read(), 'off', 'moshi flag resolution shares the stored dir');
  } finally {
    if (savedGentleDir === undefined) delete process.env.GENTLE_STATUS_STATE_DIR;
    else process.env.GENTLE_STATUS_STATE_DIR = savedGentleDir;
    if (savedHerdrDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = savedHerdrDir;
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
  }
});

test('explicit user state dir wins over injected and stored dirs', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const savedGentleDir = process.env.GENTLE_STATUS_STATE_DIR;
  const savedHerdrDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const savedXdg = process.env.XDG_STATE_HOME;
  const sandbox = fs.mkdtempSync(path.join(root, 'xdg-explicit-'));
  const legacyDir = path.join(sandbox, 'herdr', 'plugins', 'herdr-gentle-agents');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
  const explicitDir = path.join(sandbox, 'explicit');
  fs.mkdirSync(explicitDir, { recursive: true });
  fs.writeFileSync(path.join(explicitDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":true}\n');
  process.env.GENTLE_STATUS_STATE_DIR = explicitDir;
  process.env.HERDR_PLUGIN_STATE_DIR = path.join(sandbox, 'injected-shell');
  process.env.XDG_STATE_HOME = sandbox;
  try {
    const h = harness();
    factory(h.pi);
    assert.equal(slotOf().sidebar.read(), 'gentle', 'the explicit override keeps its semantics');
  } finally {
    if (savedGentleDir === undefined) delete process.env.GENTLE_STATUS_STATE_DIR;
    else process.env.GENTLE_STATUS_STATE_DIR = savedGentleDir;
    if (savedHerdrDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = savedHerdrDir;
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
  }
});

test('lib enable resolves the active new plugin id', async () => {
  const sidebar = require('../lib/gentle-sidebar.js');
  const libRoot = fs.mkdtempSync(path.join(root, 'libid-'));
  const env = {
    GENTLE_STATUS_STATE_DIR: path.join(libRoot, 'state'),
    PI_CODING_AGENT_DIR: path.join(libRoot, 'agent'),
    HERDR_CONFIG_PATH: path.join(libRoot, 'config.toml'),
  };
  fs.mkdirSync(path.join(env.PI_CODING_AGENT_DIR, 'extensions'), { recursive: true });
  fs.writeFileSync(path.join(env.PI_CODING_AGENT_DIR, 'extensions', 'herdr-agent-state.ts'), '// native\n');
  const savedConfig = process.env.HERDR_CONFIG_PATH;
  process.env.HERDR_CONFIG_PATH = env.HERDR_CONFIG_PATH;
  process.env.HERDR_SHIM_LIST_IDS = 'herdr-gentle-shell';
  try {
    const result = sidebar.enable(env);
    assert.equal(result.code, 0, `new-id lookup must converge: ${result.message}`);
    assert.deepEqual(sidebar.readMode(env), { state: 'enabled', publish: true });
  } finally {
    delete process.env.HERDR_SHIM_LIST_IDS;
    if (savedConfig === undefined) delete process.env.HERDR_CONFIG_PATH;
    else process.env.HERDR_CONFIG_PATH = savedConfig;
  }
});

test('lib stateDir keeps the stored legacy segment and honors explicit override', async () => {
  const sidebar = require('../lib/gentle-sidebar.js');
  const sandbox = fs.mkdtempSync(path.join(root, 'libstate-'));
  const legacyDir = path.join(sandbox, 'herdr', 'plugins', 'herdr-gentle-agents');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":false}\n');
  assert.equal(
    sidebar.stateDir({ XDG_STATE_HOME: sandbox }),
    legacyDir,
    'the stored dir is the default despite the rename',
  );
  assert.equal(sidebar.stateDir({ GENTLE_STATUS_STATE_DIR: '/explicit/dir' }), '/explicit/dir');
  assert.equal(
    sidebar.stateDir({ HERDR_PLUGIN_STATE_DIR: path.join(sandbox, 'injected-shell'), XDG_STATE_HOME: sandbox }),
    legacyDir,
    'an empty injected dir never orphans stored flags',
  );
});

test('provider sidebar write stays stored when stored holds only the worktree flag (S15)', async () => {
  const { default: factory } = await factoryPromise;
  const modeLib = require('../lib/worktree-mode.js');
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  const savedGentleDir = process.env.GENTLE_STATUS_STATE_DIR;
  const savedHerdrDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const savedXdg = process.env.XDG_STATE_HOME;
  const sandbox = fs.mkdtempSync(path.join(root, 'xdg-wtonly-'));
  const stored = path.join(sandbox, 'herdr', 'plugins', 'herdr-gentle-agents');
  fs.mkdirSync(stored, { recursive: true });
  fs.writeFileSync(path.join(stored, 'gentle-worktree-mode.json'), '{"version":1,"enabled":false}\n');
  const injected = path.join(sandbox, 'injected-shell');
  fs.mkdirSync(injected, { recursive: true });
  delete process.env.GENTLE_STATUS_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = injected;
  process.env.XDG_STATE_HOME = sandbox;
  try {
    const h = harness();
    factory(h.pi);
    // Missing sidebar mode reads as gentle, so native is a real change.
    const result = await slotOf().sidebar.apply('native', h.ctx);
    assert.equal(result.changed, true, `apply must converge: ${result.text}`);
    assert.ok(fs.existsSync(path.join(stored, 'gentle-sidebar-mode.json')), 'sidebar flag lands stored');
    assert.ok(!fs.existsSync(path.join(injected, 'gentle-sidebar-mode.json')), 'nothing lands injected');
    const wtEnv = { HERDR_PLUGIN_STATE_DIR: injected, XDG_STATE_HOME: sandbox };
    assert.deepEqual(modeLib.readMode(wtEnv), { state: 'disabled', enabled: false }, 'worktree stays disabled');
  } finally {
    if (savedGentleDir === undefined) delete process.env.GENTLE_STATUS_STATE_DIR;
    else process.env.GENTLE_STATUS_STATE_DIR = savedGentleDir;
    if (savedHerdrDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = savedHerdrDir;
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
  }
});

test('explicit empty GENTLE keeps provider writes stored (S15)', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY] } });
  const savedGentleDir = process.env.GENTLE_STATUS_STATE_DIR;
  const savedHerdrDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const savedXdg = process.env.XDG_STATE_HOME;
  const sandbox = fs.mkdtempSync(path.join(root, 'xdg-empty-'));
  const stored = path.join(sandbox, 'herdr', 'plugins', 'herdr-gentle-agents');
  fs.mkdirSync(stored, { recursive: true });
  fs.writeFileSync(path.join(stored, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":true}\n');
  fs.writeFileSync(path.join(stored, 'gentle-worktree-mode.json'), '{"version":1,"enabled":false}\n');
  const injected = path.join(sandbox, 'injected-shell');
  fs.mkdirSync(injected, { recursive: true });
  fs.writeFileSync(path.join(injected, 'gentle-status.pid'), '123456\n');
  process.env.GENTLE_STATUS_STATE_DIR = '';
  process.env.HERDR_PLUGIN_STATE_DIR = injected;
  process.env.XDG_STATE_HOME = sandbox;
  try {
    const h = harness();
    factory(h.pi);
    const result = await slotOf().sidebar.apply('native', h.ctx);
    assert.equal(result.changed, true, `apply must converge: ${result.text}`);
    assert.equal(
      fs.readFileSync(path.join(stored, 'gentle-sidebar-mode.json'), 'utf8'),
      '{"version":1,"enabled":false}\n',
      'stored flag updated',
    );
    assert.ok(!fs.existsSync(path.join(injected, 'gentle-sidebar-mode.json')), 'nothing lands injected');
  } finally {
    if (savedGentleDir === undefined) delete process.env.GENTLE_STATUS_STATE_DIR;
    else process.env.GENTLE_STATUS_STATE_DIR = savedGentleDir;
    if (savedHerdrDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = savedHerdrDir;
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
  }
});

test('omitted GENTLE still reads an injected flag (S15)', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const savedGentleDir = process.env.GENTLE_STATUS_STATE_DIR;
  const savedHerdrDir = process.env.HERDR_PLUGIN_STATE_DIR;
  const savedXdg = process.env.XDG_STATE_HOME;
  const sandbox = fs.mkdtempSync(path.join(root, 'xdg-omit-'));
  const injected = path.join(sandbox, 'injected-shell');
  fs.mkdirSync(injected, { recursive: true });
  fs.writeFileSync(path.join(injected, 'gentle-sidebar-mode.json'), '{"version":1,"enabled":true}\n');
  delete process.env.GENTLE_STATUS_STATE_DIR;
  process.env.HERDR_PLUGIN_STATE_DIR = injected;
  process.env.XDG_STATE_HOME = sandbox;
  try {
    const h = harness();
    factory(h.pi);
    assert.equal(slotOf().sidebar.read(), 'gentle', 'the injected enabled flag is honored');
  } finally {
    if (savedGentleDir === undefined) delete process.env.GENTLE_STATUS_STATE_DIR;
    else process.env.GENTLE_STATUS_STATE_DIR = savedGentleDir;
    if (savedHerdrDir === undefined) delete process.env.HERDR_PLUGIN_STATE_DIR;
    else process.env.HERDR_PLUGIN_STATE_DIR = savedHerdrDir;
    if (savedXdg === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedXdg;
  }
});
