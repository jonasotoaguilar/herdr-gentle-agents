'use strict';
// Regression tests (test-first) for C2: `writeMode` must never follow a
// symlink. The old implementation used `writeFileSync`, which follows the
// link, so a symlinked mode file overwrote its TARGET while the path stayed
// a symlink.
//
// Only observable behavior is asserted: the thrown refusal, the untouched
// canary bytes, the still-symlink path and the exact bytes of the normal path.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');
const modeLib = require('../lib/worktree-mode.js');

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

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-symlink-ext-')));
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
  const mod = await import(pathToFileURL(copy).href);
  const factory = mod.default;
  factory(pi);
  return { tools, commands, handlers, mod };
}

// A state dir whose mode path is a symlink to a canary file. Writing the
// mode must refuse and leave the canary alone.
function makeSymlinkedModeState() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-symlink-state-')));
  const canary = path.join(dir, 'precious-mode-target.txt');
  fs.writeFileSync(canary, 'do not destroy me\n');
  fs.symlinkSync(canary, path.join(dir, 'gentle-worktree-mode.json'));
  return { dir, canary };
}

describe('worktree writeMode symlink guard', { concurrency: false }, () => {
  test('writeMode refuses a symlinked mode path and touches nothing', () => {
    const { dir, canary } = makeSymlinkedModeState();
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    assert.throws(
      () => modeLib.writeMode(true, env),
      /symlink/i,
      'the refusal names the symlink',
    );
    assert.equal(
      fs.readFileSync(canary, 'utf8'),
      'do not destroy me\n',
      'the symlink target bytes are unchanged',
    );
    assert.equal(
      fs.lstatSync(modeLib.modePath(env)).isSymbolicLink(),
      true,
      'the path is still a symlink',
    );
  });

  test('writeMode refuses a non-regular mode path', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-symlink-dir-')));
    fs.mkdirSync(path.join(dir, 'gentle-worktree-mode.json'));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    assert.throws(
      () => modeLib.writeMode(false, env),
      /refus/i,
      'a non-regular destination is refused, never truncated',
    );
  });

  test('the normal path still writes exactly {"version":1,"enabled":true}', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-symlink-normal-')));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    modeLib.writeMode(true, env);
    assert.equal(
      fs.readFileSync(modeLib.modePath(env), 'utf8'),
      '{"version":1,"enabled":true}\n',
    );
    assert.equal(
      fs.lstatSync(modeLib.modePath(env)).isSymbolicLink(),
      false,
      'the normal path is a regular file, not a symlink',
    );
    modeLib.writeMode(false, env);
    assert.equal(
      fs.readFileSync(modeLib.modePath(env), 'utf8'),
      '{"version":1,"enabled":false}\n',
    );
  });
});
