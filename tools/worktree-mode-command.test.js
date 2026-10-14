'use strict';
// P2-S6 tests (test-first): the `/herdr-gentle:worktree` mode command (S10,
// D9) in extensions/gentle-worktree-tools.ts.
//
// Loading pattern mirrors tools/worktree-create.test.js: the TypeScript
// extension is plain JS under the hood (// @ts-nocheck, no type
// annotations), so the test copies it to a temporary .mjs path with the
// package import lines stubbed and import()s it with a fake `pi` object
// that records tool/command/event registrations. Only observable behavior
// is asserted: the registered command name, the exact bytes written to the
// shared mode file, the notification text, and which tools are registered
// at load for each mode state.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');

const TYPE_STUB = [
  'const Type = {',
  '  Object: (props) => ({ type: "object", properties: props }),',
  '  String: (opts) => ({ type: "string", ...(opts || {}) }),',
  '  Number: (opts) => ({ type: "number", ...(opts || {}) }),',
  '  Array: (items, opts) => ({ type: "array", items, ...(opts || {}) }),',
  '  Boolean: (opts) => ({ type: "boolean", ...(opts || {}) }),',
  '  Optional: (schema) => ({ ...schema, optional: true }),',
  '};',
].join('\n');

const srcText = fs.readFileSync(SRC, 'utf8');
const stubbed = srcText
  .replace(
    'import { Type } from "@earendil-works/pi-ai";',
    TYPE_STUB,
  )
  .replace(
    'import { defineTool } from "@earendil-works/pi-coding-agent";',
    'const defineTool = (def) => def;',
  );
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

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

// Isolated mode state per load: the mode file resolution follows
// GENTLE_STATUS_STATE_DIR exactly like the sidebar's.
function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mode-cmd-'))) };
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

// Import the stubbed extension copy with the lib override in place.
async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mode-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return { tools, commands, handlers };
}

function commandDef(commands) {
  const def = commands.get('herdr-gentle:worktree');
  assert.ok(def, 'expected the herdr-gentle:worktree command to be registered');
  assert.equal(typeof def.handler, 'function');
  return def;
}

function makeCtx() {
  const notes = [];
  return {
    ctx: { ui: { notify: (message, level) => { notes.push([message, level]); } } },
    notes,
  };
}

function lastMessage(notes) {
  assert.ok(notes.length > 0, 'expected at least one notification');
  return notes[notes.length - 1][0];
}

function modeLib() {
  return require('../lib/worktree-mode.js');
}

describe('worktree mode command', { concurrency: false }, () => {
  test('the command is registered under the exact name', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      const { commands } = await loadExtension();
      assert.ok(commands.has('herdr-gentle:worktree'), `exact name, got ${JSON.stringify([...commands.keys()])}`);
    } finally {
      restoreEnv();
    }
  });

  test('status reports the mode and writes nothing', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const before = fs.readFileSync(modeLib().modePath(process.env));
      const { commands } = await loadExtension();
      const { ctx, notes } = makeCtx();
      await commandDef(commands).handler('status', ctx);
      assert.equal(notes.length, 1);
      assert.match(lastMessage(notes), /enabled/, 'names the current mode');
      assert.match(lastMessage(notes), /registered/, 'says whether the tools are registered');
      assert.match(lastMessage(notes), /\/reload/, 'says whether /reload is needed');
      assert.deepEqual(fs.readFileSync(modeLib().modePath(process.env)), before, 'status never writes');
    } finally {
      restoreEnv();
    }
  });

  test('enabled writes exactly {"version":1,"enabled":true} and reports the reload requirement', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      const { commands } = await loadExtension();
      const { ctx, notes } = makeCtx();
      await commandDef(commands).handler('enabled', ctx);
      assert.equal(
        fs.readFileSync(modeLib().modePath(process.env), 'utf8'),
        '{"version":1,"enabled":true}\n',
      );
      assert.match(lastMessage(notes), /\/reload/, 'toggling states the /reload requirement');
    } finally {
      restoreEnv();
    }
  });

  test('enable is accepted as an alias of enabled', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      const { commands } = await loadExtension();
      const { ctx } = makeCtx();
      await commandDef(commands).handler('enable', ctx);
      assert.equal(
        fs.readFileSync(modeLib().modePath(process.env), 'utf8'),
        '{"version":1,"enabled":true}\n',
      );
    } finally {
      restoreEnv();
    }
  });

  test('disabled writes exactly {"version":1,"enabled":false} and reports the reload requirement', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const { commands } = await loadExtension();
      const { ctx, notes } = makeCtx();
      await commandDef(commands).handler('disabled', ctx);
      assert.equal(
        fs.readFileSync(modeLib().modePath(process.env), 'utf8'),
        '{"version":1,"enabled":false}\n',
      );
      assert.match(lastMessage(notes), /\/reload/, 'toggling states the /reload requirement');
    } finally {
      restoreEnv();
    }
  });

  test('disable is accepted as an alias of disabled', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      const { commands } = await loadExtension();
      const { ctx } = makeCtx();
      await commandDef(commands).handler('disable', ctx);
      assert.equal(
        fs.readFileSync(modeLib().modePath(process.env), 'utf8'),
        '{"version":1,"enabled":false}\n',
      );
    } finally {
      restoreEnv();
    }
  });

  test('an unknown verb prints usage and leaves the file untouched', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const before = fs.readFileSync(modeLib().modePath(process.env));
      const { commands } = await loadExtension();
      const { ctx, notes } = makeCtx();
      await commandDef(commands).handler('frobnicate', ctx);
      assert.match(lastMessage(notes), /enabled/, 'usage names the verbs');
      assert.match(lastMessage(notes), /disabled/, 'usage names the verbs');
      assert.match(lastMessage(notes), /status/, 'usage names the verbs');
      assert.deepEqual(fs.readFileSync(modeLib().modePath(process.env)), before, 'mutates nothing');
    } finally {
      restoreEnv();
    }
  });

  test('a missing verb prints usage and leaves the file untouched', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const before = fs.readFileSync(modeLib().modePath(process.env));
      const { commands } = await loadExtension();
      for (const missing of ['', undefined]) {
        const { ctx, notes } = makeCtx();
        await commandDef(commands).handler(missing, ctx);
        assert.match(lastMessage(notes), /enabled\|disabled\|status/, 'usage names the three verbs');
      }
      assert.deepEqual(fs.readFileSync(modeLib().modePath(process.env)), before, 'mutates nothing');
    } finally {
      restoreEnv();
    }
  });

  test('with the mode disabled at load the three worktree tools are not registered', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib().writeMode(false, process.env);
      const { tools, commands } = await loadExtension();
      assert.deepEqual([...tools.keys()], [], 'no worktree tool is registered while disabled');
      assert.ok(commands.has('herdr-gentle:worktree'), 'the toggle itself stays registered');
    } finally {
      restoreEnv();
    }
  });

  test('with the mode malformed at load the three worktree tools are not registered', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      fs.writeFileSync(modeLib().modePath(process.env), '{ malformed {{{');
      const { tools, commands } = await loadExtension();
      assert.deepEqual([...tools.keys()], [], 'malformed mode never enables');
      assert.ok(commands.has('herdr-gentle:worktree'), 'the toggle itself stays registered');
    } finally {
      restoreEnv();
    }
  });

  test('with the mode enabled at load all three worktree tools are registered', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const { tools } = await loadExtension();
      assert.deepEqual([...tools.keys()].sort(), ['worktree_close', 'worktree_create', 'worktree_list']);
    } finally {
      restoreEnv();
    }
  });

  test('status after a toggle reports that /reload is needed for the registration change', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      // Loaded while disabled: nothing registered in this session.
      modeLib().writeMode(false, process.env);
      const { commands } = await loadExtension();
      const toggled = makeCtx();
      await commandDef(commands).handler('enabled', toggled.ctx);
      assert.match(lastMessage(toggled.notes), /\/reload/);
      const { ctx, notes } = makeCtx();
      await commandDef(commands).handler('status', ctx);
      assert.match(lastMessage(notes), /enabled/, 'status sees the new mode');
      assert.match(lastMessage(notes), /\/reload/, 'status says a reload is needed to register');
    } finally {
      restoreEnv();
    }
  });
});
