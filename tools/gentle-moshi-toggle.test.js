'use strict';
// The Pi-side switch for the optional Moshi notification mirror (DESIGN §7):
// `/herdr-gentle:moshi enable|disable|status` (no argument opens a selector).
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

const COMMAND = 'herdr-gentle:moshi';
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

// Minimal fake Pi: only the surfaces this feature touches (plus the event
// registries the rest of the factory uses). `registerCommand` is optional on
// purpose — installed harnesses without it must keep loading the extension.
function harness({ withCommand = true, select = undefined } = {}) {
  const commands = new Map();
  const notices = [];
  const selects = [];
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
      select: async (title, items) => {
        selects.push([title, items]);
        if (typeof select === 'function') return select(title, items);
        return select;
      },
    },
  };
  return { pi, commands, notices, selects, ctx };
}

async function run(h, args) {
  await h.commands.get(COMMAND).handler(args, h.ctx);
}

test('registers /herdr-gentle:moshi and leaves the mirror off by default', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);
  assert.ok(h.commands.has(COMMAND), `expected the /${COMMAND} command`);
  await run(h, 'status');
  assert.equal(readFlag(), null, 'no flag file means off');
  assert.match(h.notices.at(-1)[0], /off/i);
});

test('enable/disable write the flag file', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  assert.equal(readFlag().enabled, true);
  assert.match(h.notices.at(-1)[0], /enabled/i);

  await run(h, 'disable');
  assert.equal(readFlag().enabled, false);
  assert.match(h.notices.at(-1)[0], /disabled/i);
});

test('enable adds the moshi-hooks exclusion and preserves other entries', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { theme: 'x', extensions: [OTHER_ENTRY] } });
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  const settings = readSettings();
  assert.deepEqual(settings.extensions, [OTHER_ENTRY, EXCLUSION_ENTRY]);
  assert.equal(settings.theme, 'x', 'unrelated keys are preserved');

  await run(h, 'enable');
  assert.deepEqual(readSettings().extensions, [OTHER_ENTRY, EXCLUSION_ENTRY], 'idempotent');
});

test('enable leaves settings.json untouched when moshi-hooks.ts is absent', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ hooksInstalled: false, settings: { extensions: [OTHER_ENTRY] } });
  const before = settingsRaw();
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  assert.equal(readFlag().enabled, true, 'the mirror still turns on');
  assert.equal(settingsRaw(), before, 'settings bytes are unchanged');
});

test('disable removes the exclusion and preserves the rest', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [OTHER_ENTRY, EXCLUSION_ENTRY], model: 'm' } });
  const h = harness();
  factory(h.pi);

  await run(h, 'disable');
  const settings = readSettings();
  assert.deepEqual(settings.extensions, [OTHER_ENTRY]);
  assert.equal(settings.model, 'm');
  assert.equal(readFlag().enabled, false);
});

test('disable leaves settings.json untouched when moshi-hooks.ts is absent', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ hooksInstalled: false, settings: { extensions: [OTHER_ENTRY, EXCLUSION_ENTRY] } });
  const before = settingsRaw();
  const h = harness();
  factory(h.pi);

  await run(h, 'disable');
  assert.equal(settingsRaw(), before, 'a stale exclusion is left alone by design');
  assert.equal(readFlag().enabled, false);
});

test('invalid settings.json fails closed: no write, mirror still toggles', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: '{ not json' });
  const h = harness();
  factory(h.pi);

  await run(h, 'enable');
  assert.equal(readFlag().enabled, true);
  assert.equal(settingsRaw(), '{ not json', 'the unparseable file is never rewritten');
  assert.equal(h.notices.at(-1)[1], 'error', 'the failure is reported');
});

test('an unknown option changes nothing and says so', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness();
  factory(h.pi);

  await run(h, 'banana');
  assert.equal(readFlag(), null);
  assert.equal(h.notices.at(-1)[1], 'error');
  assert.match(h.notices.at(-1)[0], /enable\|disable\|status/);
});

test('no argument opens the selector and applies the chosen option', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness({ select: () => 'Enable' });
  factory(h.pi);

  await run(h, '');
  assert.equal(h.selects.length, 1, 'a selector is offered');
  assert.equal(h.selects[0][1].length, 3);
  assert.equal(readFlag().enabled, true, 'the chosen option is applied');
});

test('no argument with no selector falls back to status', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness({ select: undefined });
  delete h.ctx.ui.select;
  factory(h.pi);

  await run(h, '');
  assert.equal(readFlag(), null);
  assert.match(h.notices.at(-1)[0], /off/i);
});

test('status reports the hook and exclusion state', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir({ settings: { extensions: [EXCLUSION_ENTRY] } });
  const h = harness();
  factory(h.pi);

  await run(h, 'status');
  const message = h.notices.at(-1)[0];
  assert.match(message, /off/i);
  assert.match(message, /moshi-hooks\.ts/);
  assert.match(message, /excluded/i);
});

test('loads without registerCommand (older/limited hosts)', async () => {
  const { default: factory } = await factoryPromise;
  resetState();
  resetAgentDir();
  const h = harness({ withCommand: false });
  assert.doesNotThrow(() => factory(h.pi));
});
