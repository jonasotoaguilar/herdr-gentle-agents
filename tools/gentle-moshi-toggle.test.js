'use strict';
// The Pi-side switch for the optional Moshi notification mirror (DESIGN §7),
// now reached through the `/herdr-gentle:customize` panel (customize-command
// T2/S7: the `/herdr-gentle:moshi` command is removed outright). These tests
// keep every state-level assertion of the old command suite — flag file
// bytes, settings exclusion entries, untouched-settings cases, fail-closed
// behaviour — repointed at the provider slot the state extension registers
// (`globalThis[Symbol.for("herdr-gentle.customize.v1")].moshi`), whose
// `apply` reuses the same `writeMoshiFlag` / `setMoshiExclusion` /
// `moshiFlagEnabled` paths unchanged. Only the command-handler UX tests
// (selector, unknown verb, `status` text) are gone with the command; the
// read-only reporting they offered lives on as `customize status`.
//
// Enabling writes the flag file the consumer daemon reads
// (`$GENTLE_STATUS_STATE_DIR/gentle-moshi.json`) AND excludes the
// Moshi-managed Pi hook (`-extensions/moshi-hooks.ts` in the Pi
// settings.json `extensions` list) so Moshi stops notifying per prompt and
// per turn; disabling removes that exclusion again. Both settings edits
// happen only while `extensions/moshi-hooks.ts` exists.
//
// The extension is TypeScript with one package import that is unresolvable
// under plain node, so the test loads a renamed copy with exactly that
// import line stubbed — production is untouched, same approach as
// tools/gentle-herdr-state.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-moshi-toggle-'));
const copy = path.join(root, 'gentle-herdr-state.mjs');
fs.writeFileSync(copy, stubbed);
const copyUrl = pathToFileURL(copy).href;

const SLOT_KEY = 'herdr-gentle.customize.v1';
const EXCLUSION_ENTRY = '-extensions/moshi-hooks.ts';
const OTHER_ENTRY = '-extensions/herdr-agent-state.ts';

const stateDir = path.join(root, 'state');
const agentDir = path.join(root, 'agent');
const flagFile = path.join(stateDir, 'gentle-moshi.json');
const settingsFile = path.join(agentDir, 'settings.json');
const moshiHooks = path.join(agentDir, 'extensions', 'moshi-hooks.ts');

process.env.GENTLE_STATUS_STATE_DIR = stateDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.GENTLE_PI_AGENT_HOME;

const factoryPromise = import(copyUrl);

function resetAgentDir({ hooksInstalled = true, settings } = {}) {
  fs.rmSync(agentDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(agentDir, 'extensions'), { recursive: true });
  if (hooksInstalled) fs.writeFileSync(moshiHooks, '// moshi hook\n');
  if (settings !== undefined) {
    fs.writeFileSync(settingsFile, typeof settings === 'string' ? settings : `${JSON.stringify(settings, null, 2)}\n`);
  }
}

function resetState() {
  fs.rmSync(stateDir, { recursive: true, force: true });
}

function readFlag() {
  try {
    return JSON.parse(fs.readFileSync(flagFile, 'utf8'));
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

// Minimal fake Pi: only the surfaces the provider path touches (plus the
// event registries the rest of the factory uses). `registerCommand` is
// optional on purpose — installed harnesses without it must keep loading
// the extension.
function harness({ withCommand = true } = {}) {
  const commands = new Map();
  const notices = [];
  const pi = {
    on: () => {},
    events: { on: () => {}, emit: () => {} },
  };
  if (withCommand) {
    pi.registerCommand = (name, spec) => {
      commands.set(name, spec);
    };
  }
  const ctx = {
    ui: {
      notify: (message, kind) => notices.push([message, kind]),
    },
  };
  return { pi, commands, notices, ctx };
}

function slotOf() {
  const slot = globalThis[Symbol.for(SLOT_KEY)];
  assert.ok(slot && typeof slot === 'object', 'expected the provider slot to be registered at load');
  assert.equal(typeof slot.moshi.read, 'function', 'moshi.read');
  assert.equal(typeof slot.moshi.apply, 'function', 'moshi.apply');
  return slot;
}

test('no /herdr-gentle:moshi command; the mirror stays off by default', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  assert.ok(!h.commands.has('herdr-gentle:moshi'), 'the command is removed outright (S7)');
  assert.equal(slotOf().moshi.read(), 'off', 'no flag file means off');
  assert.equal(readFlag(), null, 'read writes nothing');
});

test('on/off apply writes the flag file and reports the exclusion verdict', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const turnedOn = await slot.moshi.apply('on', h.ctx);
  assert.equal(readFlag().enabled, true);
  assert.deepEqual(
    { changed: turnedOn.changed, needsReload: turnedOn.needsReload },
    { changed: true, needsReload: true },
    'the exclusion entry actually changed, so a reload is needed (S6)',
  );
  assert.ok(!turnedOn.text.includes('/reload'), 'the panel never asks the user to run /reload');

  const turnedOff = await slot.moshi.apply('off', h.ctx);
  assert.equal(readFlag().enabled, false);
  assert.deepEqual(
    { changed: turnedOff.changed, needsReload: turnedOff.needsReload },
    { changed: true, needsReload: true },
    'removing the entry is a change too',
  );
});

test('on adds the moshi-hooks exclusion and preserves other entries', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { theme: 'x', extensions: [OTHER_ENTRY] } });
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  await slot.moshi.apply('on', h.ctx);
  const settings = readSettings();
  assert.deepEqual(settings.extensions, [OTHER_ENTRY, EXCLUSION_ENTRY]);
  assert.equal(settings.theme, 'x', 'unrelated keys are preserved');

  await slot.moshi.apply('on', h.ctx);
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, EXCLUSION_ENTRY], 'idempotent');
});

test('on leaves settings.json untouched when moshi-hooks.ts is absent', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ hooksInstalled: false, settings: { extensions: [OTHER_ENTRY] } });
  const before = settingsRaw();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const result = await slot.moshi.apply('on', h.ctx);
  assert.equal(readFlag().enabled, true, 'the mirror still turns on');
  assert.equal(settingsRaw(), before, 'settings bytes are unchanged');
  assert.equal(result.needsReload, false, 'no exclusion change means no reload (S6)');
});

test('off removes the exclusion and preserves the rest', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY, EXCLUSION_ENTRY], model: 'm' } });
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  // Reach the removal through the converged flow: on stages the owned
  // entry, off removes it again (apply is a no-op when already there).
  await slot.moshi.apply('on', h.ctx);
  await slot.moshi.apply('off', h.ctx);
  const settings = readSettings();
  assert.deepEqual(settings.extensions, [OTHER_ENTRY]);
  assert.equal(settings.model, 'm');
  assert.equal(readFlag().enabled, false);
});

test('off leaves settings.json untouched when moshi-hooks.ts is absent', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ hooksInstalled: false, settings: { extensions: [OTHER_ENTRY, EXCLUSION_ENTRY] } });
  const before = settingsRaw();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  await slot.moshi.apply('on', h.ctx);
  assert.equal(readFlag().enabled, true, 'the mirror turns on first');
  await slot.moshi.apply('off', h.ctx);
  assert.equal(settingsRaw(), before, 'a stale exclusion is left alone by design');
  assert.equal(readFlag().enabled, false);
});

test('invalid settings.json fails closed: no settings write, mirror still toggles', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: '{ not json' });
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const result = await slot.moshi.apply('on', h.ctx);
  assert.equal(readFlag().enabled, true);
  assert.equal(settingsRaw(), '{ not json', 'the unparseable file is never rewritten');
  assert.equal(result.changed, true, 'the flag still flipped');
  assert.equal(result.needsReload, false, 'the exclusion did not change');
  assert.match(result.text, /could not update/, 'the failure is reported');
});

test('an unknown value changes nothing', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  const result = await slot.moshi.apply('banana', h.ctx);
  assert.deepEqual(
    { changed: result.changed, needsReload: result.needsReload },
    { changed: false, needsReload: false },
  );
  assert.equal(readFlag(), null, 'no flag file is created');
  assert.equal(settingsRaw(), null, 'no settings file is created');
});

test('read follows the writes', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  const slot = slotOf();

  assert.equal(slot.moshi.read(), 'off');
  await slot.moshi.apply('on', h.ctx);
  assert.equal(slot.moshi.read(), 'on');
  await slot.moshi.apply('off', h.ctx);
  assert.equal(slot.moshi.read(), 'off');
});

test('loads without registerCommand (older/limited hosts)', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness({ withCommand: false });
  assert.doesNotThrow(() => factory(h.pi));
  assert.ok(slotOf().moshi, 'the provider slot registers without commands');
});
