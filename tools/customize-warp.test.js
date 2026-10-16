'use strict';
// T3 (customize-command S11) tests: the `/herdr-gentle:warp` command in
// extensions/gentle-worktree-tools.ts.
//
// Selector contract (S11): no argument opens `ctx.ui.select` with the
// active checkout as TITLE text (`Warp session · current: <name> <path>`)
// and every OTHER live checkout as `<name> — <path>` options in listing
// order (the principal first when the session is not in it, then the
// registry rows). Choosing one reuses the existing `executeWorktreeWarp`
// unchanged; an explicit name skips the selector. `Esc` changes nothing;
// nothing to offer notifies and opens no selector.
//
// The second describe block is the warp suite moved verbatim from
// tools/worktree-mode-command.test.js: it covers the shared
// `executeWorktreeWarp` core both commands reuse, so its assertions did
// not change in the move.
//
// Loading pattern mirrors tools/worktree-mode-command.test.js: the
// TypeScript extension is plain JS under the hood (// @ts-nocheck, no type
// annotations), so the test copies it to a temporary .mjs path with the
// package import lines stubbed and import()s it with a fake `pi` object.
// Only observable behavior is asserted: registered command names, the
// exact select title and option strings, notification text, and written
// state.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

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
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-cmd-'))) };
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-ext-')));
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
  const mod = await import(pathToFileURL(copy).href);
  return { tools, commands, handlers, mod };
}

function warpDef(commands) {
  const def = commands.get('herdr-gentle:warp');
  assert.ok(def, 'expected the herdr-gentle:warp command to be registered');
  assert.equal(typeof def.handler, 'function');
  return def;
}

function modeLib() {
  return require('../lib/worktree-mode.js');
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-cwarp-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function addRegistered(root, branch, { thread = 'thread-1', issues = [35] } = {}) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-cwarp-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const registryLib = require('../lib/worktree-registry.js');
  assert.equal(registryLib.upsertWorktree(root, {
    branch, path: target, thread, issues, odd: [],
  }).ok, true);
  return fs.realpathSync(target);
}

// Fake SessionManager class (forkFrom/create/open) injected through the
// session instance's own constructor, so no real Pi runtime is needed:
// the warp resolves the class from `ctx.sessionManager.constructor` when
// the package import does not resolve (plain-node test copies).
function makeFakeSM(calls, { entries = [] } = {}) {
  class FakeTarget {
    constructor(cwd, dir, file) {
      this.cwd = cwd;
      this.dir = dir;
      this.file = file;
      this.appended = [];
    }
    getSessionFile() { return this.file; }
    branch(id) { calls.push(['branch', id]); this.leaf = id; }
    resetLeaf() { calls.push(['resetLeaf']); this.leaf = null; }
    appendCustomEntry(type, data) { calls.push(['appendCustomEntry', type, data]); return 'entry-1'; }
    _appendEntry(entry) { calls.push(['_appendEntry', entry.id]); this.appended.push(entry); }
  }
  return class FakeSM {
    static forkFrom(sourcePath, targetCwd, sessionDir) {
      calls.push(['forkFrom', sourcePath, targetCwd, sessionDir]);
      const file = path.join(targetCwd, 'forked-session.jsonl');
      fs.writeFileSync(file, '{"type":"session"}\n');
      return new FakeTarget(targetCwd, sessionDir, file);
    }
    static create(cwd, sessionDir) {
      calls.push(['create', cwd, sessionDir]);
      const file = path.join(cwd, 'created-session.jsonl');
      // The real `create` allocates the file without writing it; the warp
      // writes the header and the carried entries itself.
      return { getSessionFile: () => file, getHeader: () => ({ type: 'session', cwd }) };
    }
    static open(file, sessionDir, cwdOverride) {
      calls.push(['open', file, sessionDir, cwdOverride]);
      return new FakeTarget(cwdOverride, sessionDir, file);
    }
  };
}

// Command context for the selector: the session manager is an instance of
// the fake class (so the warp resolves it via the constructor), and
// `ui.select` records its title and options before answering.
function makeSelectorCtx({ cwd, FakeSM, sessionFile, leaf = 'leaf-1', entries = [], sessionDir, switchResult = { cancelled: false }, calls, selectImpl }) {
  const notes = [];
  const selects = [];
  const waited = [];
  const switches = [];
  const sm = new FakeSM();
  Object.assign(sm, {
    getSessionFile: () => sessionFile,
    getLeafId: () => leaf,
    getEntries: () => entries,
    getSessionDir: () => sessionDir,
  });
  const ctx = {
    cwd,
    ui: {
      notify: (message, level) => { notes.push([message, level]); },
      setStatus: () => {},
      select: async (title, options) => {
        selects.push([title, options]);
        if (typeof selectImpl === 'function') return selectImpl(title, options);
        return selectImpl;
      },
    },
    sessionManager: sm,
    waitForIdle: async () => { waited.push(true); },
    switchSession: async (file, options) => {
      switches.push([file, typeof options?.withSession]);
      if (typeof options?.withSession === 'function') {
        const replaced = { ui: { setStatus: () => {} }, sendMessage: async () => {} };
        await options.withSession(replaced);
      }
      return switchResult;
    },
  };
  return { ctx, notes, selects, waited, switches };
}

function sessionFileIn(dir) {
  const file = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cwarp-sess-'))), 'session.jsonl');
  fs.writeFileSync(file, '{"type":"session"}\n');
  return file;
}

function lastMessage(notes) {
  assert.ok(notes.length > 0, 'expected at least one notification');
  return notes[notes.length - 1][0];
}

describe('herdr-gentle:warp command (S11)', { concurrency: false }, () => {
  test('the command is registered under the exact name even while the mode says disabled', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib().writeMode(false, process.env);
      const { tools, commands } = await loadExtension();
      assert.ok(commands.has('herdr-gentle:warp'), `exact name, got ${JSON.stringify([...commands.keys()])}`);
      assert.ok(commands.has('herdr-gentle:worktree'), 'the existing command still registers');
      assert.deepEqual([...tools.keys()], [], 'the worktree tools stay gated while disabled');
    } finally {
      restoreEnv();
    }
  });

  test('no argument opens a selector titled with the active checkout, listing the others in order', async () => {
    const root = makeRepo('selector');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const first = addRegistered(root, 'feat/first');
      const second = addRegistered(root, 'feat/second');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      // selectImpl undefined: Esc. The selector still opened exactly once.
      const { ctx, notes, selects } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.equal(selects.length, 1, 'exactly one selector opened');
      const [title, options] = selects[0];
      assert.equal(title, `Warp session · current: principal ${root}`);
      assert.deepEqual(options, [`feat-first — ${first}`, `feat-second — ${second}`]);
      assert.deepEqual(notes, [], 'Esc notifies nothing');
    } finally {
      restoreEnv();
    }
  });

  test('inside a registered checkout the selector leads with the principal and excludes the active one', async () => {
    const root = makeRepo('selector-active');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const first = addRegistered(root, 'feat/first');
      const second = addRegistered(root, 'feat/second');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, selects } = makeSelectorCtx({
        cwd: first, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.equal(selects.length, 1, 'exactly one selector opened');
      const [title, options] = selects[0];
      assert.equal(title, `Warp session · current: feat-first ${first}`);
      assert.deepEqual(options, [`principal — ${root}`, `feat-second — ${second}`]);
    } finally {
      restoreEnv();
    }
  });

  test('unregistered live checkouts are never offered', async () => {
    const root = makeRepo('selector-unreg');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const reg = addRegistered(root, 'feat/reg');
      const unreg = path.join(path.dirname(root), `${path.basename(root)}-cwarp-unreg`);
      track(unreg);
      git(root, ['worktree', 'add', '-b', 'feat/unreg', unreg, 'HEAD']);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, selects } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.equal(selects.length, 1, 'exactly one selector opened');
      assert.deepEqual(selects[0][1], [`feat-reg — ${reg}`]);
    } finally {
      restoreEnv();
    }
  });

  test('choosing an option warps the session to that checkout', async () => {
    const root = makeRepo('selector-pick');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/warp-target');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, notes, selects, waited, switches } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        selectImpl: (title, options) => options[0],
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.equal(selects.length, 1, 'the selector opened');
      assert.equal(lastMessage(notes), `worktree warp: feat-warp-target -> ${target}`);
      assert.equal(waited.length, 1, 'the warp waited for idle');
      assert.equal(switches.length, 1, 'the session really switched');
      assert.equal(calls[0][0], 'forkFrom', 'the warp forked the session');
      assert.equal(calls[0][2], target, 'the fork landed in the chosen checkout');
    } finally {
      restoreEnv();
    }
  });

  test('Esc closes the selector silently and changes nothing', async () => {
    const root = makeRepo('selector-esc');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/target');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const registryLib = require('../lib/worktree-registry.js');
      const before = registryLib.readRegistry(root);
      const { ctx, notes, selects, waited, switches } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        selectImpl: () => undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.equal(selects.length, 1, 'the selector opened');
      assert.deepEqual(notes, [], 'no notification on Esc');
      assert.deepEqual(waited, [], 'no warp started');
      assert.deepEqual(switches, [], 'no session switch');
      assert.deepEqual(calls, [], 'no fork');
      assert.deepEqual(registryLib.readRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('with only the active checkout the command notifies and opens no selector', async () => {
    const root = makeRepo('selector-alone');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, notes, selects, switches } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.deepEqual(selects, [], 'no selector opened');
      assert.equal(notes.length, 1, 'exactly one notification');
      assert.equal(notes[0][0], 'warp: no other checkout to move the session to');
      assert.deepEqual(switches, [], 'no session switch');
      assert.deepEqual(calls, [], 'no fork');
    } finally {
      restoreEnv();
    }
  });

  test('an explicit name skips the selector and warps unchanged', async () => {
    const root = makeRepo('explicit');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/warp-target', { thread: 'thread-1', issues: [35] });
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, notes, selects, switches } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('feat-warp-target', ctx);
      assert.deepEqual(selects, [], 'no selector opened for an explicit name');
      assert.equal(lastMessage(notes), `worktree warp: feat-warp-target -> ${target}`);
      assert.equal(switches.length, 1, 'the session really switched');
    } finally {
      restoreEnv();
    }
  });

  test('an explicit ambiguous name fails closed and moves nothing', async () => {
    const root = makeRepo('explicit-ambiguous');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/amb', { thread: 'thread-1', issues: [35] });
      const other = path.join(path.dirname(root), `${path.basename(root)}-cwarp-feat-amb-other`);
      track(other);
      git(root, ['worktree', 'add', '-b', 'feat-amb', other, 'HEAD']);
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.appendWorktree(root, {
        branch: 'feat-amb', path: fs.realpathSync(other), thread: 'thread-2', issues: [7], odd: [],
      }).ok, true);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, notes, selects, switches } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile: '/tmp/nope.jsonl', sessionDir: '/tmp', calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('feat-amb', ctx);
      assert.deepEqual(selects, [], 'no selector opened for an explicit name');
      assert.match(lastMessage(notes), /ambiguous/i, 'fails closed naming the collision');
      assert.deepEqual(switches, [], 'no session switch');
      assert.deepEqual(calls, [], 'no fork');
    } finally {
      restoreEnv();
    }
  });

  test('a cancelled switch through the command reports it and keeps the source session', async () => {
    const root = makeRepo('explicit-cancelled');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/cancel-target');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, notes, selects } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile),
        switchResult: { cancelled: true }, calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('feat-cancel-target', ctx);
      assert.deepEqual(selects, [], 'no selector opened for an explicit name');
      assert.match(lastMessage(notes), /cancelled/i, 'the cancelled outcome is reported');
      assert.equal(fs.existsSync(path.join(target, 'forked-session.jsonl')), false, 'target session file removed');
      assert.equal(fs.existsSync(sessionFile), true, 'source session untouched');
    } finally {
      restoreEnv();
    }
  });

  test('more than one name is a usage error that moves nothing', async () => {
    const root = makeRepo('explicit-two');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/a');
      addRegistered(root, 'feat/b');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, notes, selects, switches } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('feat-a feat-b', ctx);
      assert.deepEqual(selects, [], 'no selector opened');
      assert.match(lastMessage(notes), /exactly one name/, 'usage names the single-name rule');
      assert.deepEqual(switches, [], 'no session switch');
      assert.deepEqual(calls, [], 'no fork');
    } finally {
      restoreEnv();
    }
  });

  test('outside a git repository the command fails closed without opening a selector', async () => {
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    const outside = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-cwarp-outside-')));
    try {
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, notes, selects, switches } = makeSelectorCtx({
        cwd: outside, FakeSM, sessionFile: '/tmp/nope.jsonl', sessionDir: '/tmp', calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.deepEqual(selects, [], 'no selector opened');
      assert.match(lastMessage(notes), /not a git repository/, 'the failure names the cause');
      assert.deepEqual(switches, [], 'no session switch');
      assert.deepEqual(calls, [], 'no fork');
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree warp command verb (S23, T32 RED)', { concurrency: false }, () => {
  const { spawnSync } = require('node:child_process');

  function git(cwd, args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return (result.stdout || '').trim();
  }

  function makeRepo(tag) {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-warp-${tag}-`)));
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['commit', '--allow-empty', '-m', 'init']);
    return fs.realpathSync(dir);
  }

  function addRegistered(root, branch, { thread = 'thread-1', issues = [35] } = {}) {
    const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
    const target = path.join(path.dirname(root), `${path.basename(root)}-warp-${slug}`);
    track(target);
    git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
    const registryLib = require('../lib/worktree-registry.js');
    assert.equal(registryLib.upsertWorktree(root, {
      branch, path: target, thread, issues, odd: [],
    }).ok, true);
    return fs.realpathSync(target);
  }

  // Fake SessionManager class (forkFrom/create/open) injected through the
  // warp options, so no real Pi runtime is needed.
  function makeFakeSM(calls, { entries = [] } = {}) {
    class FakeTarget {
      constructor(cwd, dir, file) {
        this.cwd = cwd;
        this.dir = dir;
        this.file = file;
        this.appended = [];
      }
      getSessionFile() { return this.file; }
      branch(id) { calls.push(['branch', id]); this.leaf = id; }
      resetLeaf() { calls.push(['resetLeaf']); this.leaf = null; }
      appendCustomEntry(type, data) { calls.push(['appendCustomEntry', type, data]); return 'entry-1'; }
      _appendEntry(entry) { calls.push(['_appendEntry', entry.id]); this.appended.push(entry); }
    }
    return class FakeSM {
      static forkFrom(sourcePath, targetCwd, sessionDir) {
        calls.push(['forkFrom', sourcePath, targetCwd, sessionDir]);
        const file = path.join(targetCwd, 'forked-session.jsonl');
        fs.writeFileSync(file, '{"type":"session"}\n');
        return new FakeTarget(targetCwd, sessionDir, file);
      }
      static create(cwd, sessionDir) {
        calls.push(['create', cwd, sessionDir]);
        const file = path.join(cwd, 'created-session.jsonl');
        // The real `create` allocates the file without writing it; the warp
        // writes the header and the carried entries itself.
        return { getSessionFile: () => file, getHeader: () => ({ type: 'session', cwd }) };
      }
      static open(file, sessionDir, cwdOverride) {
        calls.push(['open', file, sessionDir, cwdOverride]);
        return new FakeTarget(cwdOverride, sessionDir, file);
      }
    };
  }

  function makeWarpCtx({ cwd, sessionFile, leaf = 'leaf-1', entries = [], sessionDir, switchResult = { cancelled: false }, calls }) {
    const notes = [];
    const statuses = [];
    const sent = [];
    const waited = [];
    const switches = [];
    const session = {
      getSessionFile: () => sessionFile,
      getLeafId: () => leaf,
      getEntries: () => entries,
      getSessionDir: () => sessionDir,
    };
    let replaced = null;
    const ctx = {
      cwd,
      ui: {
        notify: (message, level) => { notes.push([message, level]); },
        setStatus: (key, text) => { statuses.push([key, text]); },
      },
      sessionManager: session,
      waitForIdle: async () => { waited.push(true); },
      switchSession: async (file, options) => {
        switches.push([file, typeof options?.withSession]);
        if (typeof options?.withSession === 'function') {
          replaced = {
            ui: { setStatus: (key, text) => { statuses.push([`replaced:${key}`, text]); } },
            sendMessage: async (message, sendOptions) => { sent.push([message, sendOptions]); },
          };
          await options.withSession(replaced);
        }
        return switchResult;
      },
    };
    return { ctx, notes, statuses, sent, waited, switches };
  }

  function oscFake(isTTY) {
    return { isTTY, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  }

  test('warp moves the session: fork, branch, transition record, switch, exact text', async () => {
    const root = makeRepo('warp-ok');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/warp-target', { thread: 'thread-1', issues: [35] });
      const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-sess-'))), 'session.jsonl');
      fs.writeFileSync(sessionFile, '{"type":"session"}\n');
      const sessionDir = path.dirname(sessionFile);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, notes, statuses, sent, waited, switches } = makeWarpCtx({
        cwd: root, sessionFile, leaf: 'leaf-1', entries: [], sessionDir, calls,
      });
      const osc = oscFake(true);
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-warp-target', ctx, { sessionManagerClass: FakeSM, oscStream: osc });
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      assert.equal(out.text, `worktree warp: feat-warp-target -> ${target}`);
      assert.deepEqual(out.details, {
        name: 'feat-warp-target', path: target, branch: 'feat/warp-target',
        kind: 'agent', alreadyThere: false, cancelled: false,
      });
      assert.equal(waited.length, 1, 'waitForIdle ran');
      assert.deepEqual(calls[0], ['forkFrom', sessionFile, target, sessionDir]);
      assert.deepEqual(calls[1], ['branch', 'leaf-1']);
      assert.equal(calls[2][0], 'appendCustomEntry');
      assert.ok(String(JSON.stringify(calls[2][2])).includes(root), 'transition names the old cwd');
      assert.ok(String(JSON.stringify(calls[2][2])).includes(target), 'transition names the new cwd');
      assert.equal(switches.length, 1, 'switchSession ran once');
      assert.equal(switches[0][1], 'function', 'withSession callback passed');
      assert.ok(statuses.length >= 1, 'status set on the replacement session');
      assert.equal(sent.length, 1, 'one revalidation message sent');
      assert.equal(sent[0][1].triggerTurn, false, 'no turn triggered');
      assert.match(String(sent[0][0].content || JSON.stringify(sent[0][0])), /revalidat/i);
      assert.deepEqual(osc.chunks, [`\x1b]7;file://${target}\x1b\\`], 'OSC-7 exact bytes');
    } finally {
      restoreEnv();
    }
  });

  test('warping to the current checkout reports already-there and changes nothing', async () => {
    const root = makeRepo('warp-there');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/here', { thread: 'thread-1', issues: [35] });
      const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-sess-'))), 'session.jsonl');
      fs.writeFileSync(sessionFile, '{"type":"session"}\n');
      const calls = [];
      const { ctx, switches } = makeWarpCtx({
        cwd: target, sessionFile, leaf: 'leaf-1', entries: [], sessionDir: path.dirname(sessionFile), calls,
      });
      const osc = oscFake(true);
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-here', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: osc });
      assert.equal(out.text, 'worktree warp: feat-here (already there)');
      assert.equal(out.details.alreadyThere, true);
      assert.deepEqual(calls, [], 'no fork');
      assert.deepEqual(switches, [], 'no switch');
      assert.deepEqual(osc.chunks, [], 'no OSC-7 when nothing changes');
    } finally {
      restoreEnv();
    }
  });

  test('an unknown name fails closed naming the known ones', async () => {
    const root = makeRepo('warp-unknown');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/known', { thread: 'thread-1', issues: [35] });
      const calls = [];
      const { ctx, switches, waited } = makeWarpCtx({
        cwd: root, sessionFile: '/tmp/nope.jsonl', leaf: 'leaf-1', entries: [], sessionDir: '/tmp', calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-nope', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: oscFake(true) });
      assert.equal(out.isError, true);
      assert.match(out.text, /no registered worktree for "feat-nope"/);
      assert.ok(out.text.includes('feat-known'), `names the known ones: ${out.text}`);
      assert.deepEqual(calls, [], 'no fork');
      assert.deepEqual(switches, [], 'no switch');
    } finally {
      restoreEnv();
    }
  });

  test('an ambiguous name fails closed naming both, never picking one', async () => {
    const root = makeRepo('warp-ambiguous');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/amb', { thread: 'thread-1', issues: [35] });
      const other = path.join(path.dirname(root), `${path.basename(root)}-warp-feat-amb-other`);
      track(other);
      git(root, ['worktree', 'add', '-b', 'feat-amb', other, 'HEAD']);
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.appendWorktree(root, {
        branch: 'feat-amb', path: fs.realpathSync(other), thread: 'thread-2', issues: [7], odd: [],
      }).ok, true);
      const calls = [];
      const { ctx, switches } = makeWarpCtx({
        cwd: root, sessionFile: '/tmp/nope.jsonl', leaf: 'leaf-1', entries: [], sessionDir: '/tmp', calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-amb', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: oscFake(true) });
      assert.equal(out.isError, true);
      assert.match(out.text, /ambiguous/i);
      assert.ok(out.text.includes('feat/amb') && out.text.includes('feat-amb'), `names both: ${out.text}`);
      assert.deepEqual(calls, [], 'no fork');
      assert.deepEqual(switches, [], 'no switch');
    } finally {
      restoreEnv();
    }
  });

  test('no persisted session and nothing in memory is refused', async () => {
    const root = makeRepo('warp-nofile');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/target', { thread: 'thread-1', issues: [35] });
      const calls = [];
      const { ctx, switches } = makeWarpCtx({
        cwd: root, sessionFile: undefined, leaf: null, entries: [], sessionDir: undefined, calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-target', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: oscFake(true) });
      assert.equal(out.isError, true);
      assert.match(out.text, /no persisted session|no session file/i);
      assert.deepEqual(calls, [], 'no fork');
      assert.deepEqual(switches, [], 'no switch');
    } finally {
      restoreEnv();
    }
  });

  test('an unwritten session clones its in-memory entries via create + open', async () => {
    const root = makeRepo('warp-memory');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/mem-target', { thread: 'thread-1', issues: [35] });
      const memEntries = [{ id: 'e1', parentId: null, type: 'message' }, { id: 'e2', parentId: 'e1', type: 'message' }];
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeWarpCtx({
        cwd: root, sessionFile: undefined, leaf: null, entries: memEntries, sessionDir: undefined, calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-mem-target', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      assert.equal(out.text, `worktree warp: feat-mem-target -> ${target}`);
      const kinds = calls.map((call) => call[0]);
      assert.ok(kinds.includes('create'), `create ran: ${JSON.stringify(kinds)}`);
      assert.ok(kinds.includes('open'), `open ran: ${JSON.stringify(kinds)}`);
      assert.ok(!kinds.includes('forkFrom'), 'no forkFrom for an unwritten session');
      const written = fs.readFileSync(path.join(target, 'created-session.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line));
      assert.equal(written.length, 3, `the header and both entries reached the file: ${JSON.stringify(written)}`);
      assert.equal(written[0].cwd, target, 'the header names the target cwd');
      assert.deepEqual(written.slice(1).map((entry) => entry.id), ['e1', 'e2'], 'both entries carried, in order');
      assert.equal(switches.length, 1);
    } finally {
      restoreEnv();
    }
  });

  test('cancelled removes the target session file, reports it, changes nothing else', async () => {
    const root = makeRepo('warp-cancelled');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/cancel-target', { thread: 'thread-1', issues: [35] });
      const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-sess-'))), 'session.jsonl');
      fs.writeFileSync(sessionFile, '{"type":"session"}\n');
      const calls = [];
      const { ctx } = makeWarpCtx({
        cwd: root, sessionFile, leaf: 'leaf-1', entries: [], sessionDir: path.dirname(sessionFile),
        switchResult: { cancelled: true }, calls,
      });
      const osc = oscFake(true);
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-cancel-target', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: osc });
      assert.match(out.text, /cancelled/i);
      assert.equal(out.details.cancelled, true);
      assert.equal(fs.existsSync(path.join(target, 'forked-session.jsonl')), false, 'target session file removed');
      assert.equal(fs.existsSync(sessionFile), true, 'source session untouched');
      assert.deepEqual(osc.chunks, [], 'no OSC-7 on cancel');
    } finally {
      restoreEnv();
    }
  });

  test('emitOsc7 writes the exact bytes only on a TTY', async () => {
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { mod } = await loadExtension();
      const tty = oscFake(true);
      assert.equal(mod.emitOsc7(tty, '/tmp/some-dir'), true);
      assert.deepEqual(tty.chunks, ['\x1b]7;file:///tmp/some-dir\x1b\\']);
      const notty = oscFake(false);
      assert.equal(mod.emitOsc7(notty, '/tmp/some-dir'), false);
      assert.deepEqual(notty.chunks, []);
      assert.equal(mod.emitOsc7(undefined, '/tmp/some-dir'), false);
    } finally {
      restoreEnv();
    }
  });

  test('the command exposes warp alongside the existing verbs', async () => {
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { commands } = await loadExtension();
      const def = commands.get('herdr-gentle:worktree');
      assert.ok(def, 'command registered');
      const notes = [];
      const ctx = { ui: { notify: (message, level) => { notes.push([message, level]); } }, cwd: process.cwd() };
      await def.handler('warp', ctx);
      assert.match(notes[notes.length - 1][0], /warp.*needs a name|warp <name>/i, 'missing name is a usage error');
    } finally {
      restoreEnv();
    }
  });

  test('warp refuses the reserved name principal when a branch shares it', async () => {
    const root = makeRepo('principal-clash');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      // `principal` is a valid branch name, so the tool can register it; the
      // listing then prints that name for two different checkouts.
      const clash = addRegistered(root, 'principal', { thread: 'thread-1', issues: [9] });
      const calls = [];
      const { ctx, switches } = makeWarpCtx({ cwd: clash, sessionFile: path.join(root, 's.jsonl'), calls });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('principal', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: oscFake(true) });
      assert.equal(out.isError, true, 'the reserved name never picks one');
      assert.match(out.text, /ambiguous/i);
      assert.equal(switches.length, 0, 'nothing switched');
    } finally {
      restoreEnv();
    }
  });

  test('a session inside a nested worktree is not already there for the principal', async () => {
    const root = makeRepo('nested');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const nested = path.join(root, 'nested-wt');
      track(nested);
      git(root, ['worktree', 'add', '-b', 'feat/nested', nested, 'HEAD']);
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.upsertWorktree(root, {
        branch: 'feat/nested', path: fs.realpathSync(nested), thread: 'thread-nested', issues: [1], odd: [],
      }).ok, true);
      const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-nested-sess-'))), 'session.jsonl');
      fs.writeFileSync(sessionFile, '{"type":"session"}\n');
      const calls = [];
      const { ctx, switches } = makeWarpCtx({ cwd: fs.realpathSync(nested), sessionFile, calls });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('principal', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: oscFake(true) });
      assert.equal(out.isError, undefined, `expected a real move, got: ${out.text}`);
      assert.equal(out.text, `worktree warp: principal -> ${root}`);
      assert.equal(out.details.path, root, 'the target is the principal checkout');
      assert.equal(switches.length, 1, 'the session really switched');
    } finally {
      restoreEnv();
    }
  });

  test('warp refuses a name an unregistered checkout also carries', async () => {
    const root = makeRepo('unreg-clash');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/mix', { thread: 'thread-1', issues: [35] });
      // A second live checkout whose branch flattens to the same printed name.
      const other = path.join(path.dirname(root), `${path.basename(root)}-unreg-mix`);
      track(other);
      git(root, ['worktree', 'add', '-b', 'feat-mix', other, 'HEAD']);
      const calls = [];
      const { ctx, switches } = makeWarpCtx({ cwd: root, sessionFile: path.join(root, 's.jsonl'), calls });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-mix', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: oscFake(true) });
      assert.equal(out.isError, true, 'a name two live checkouts share never picks one');
      assert.match(out.text, /ambiguous/i);
      assert.match(out.text, /unregistered/, `says which one is unregistered: ${out.text}`);
      assert.equal(switches.length, 0, 'nothing switched');
    } finally {
      restoreEnv();
    }
  });

  test('a prunable git record does not make a unique name ambiguous', async () => {
    const root = makeRepo('dead-unreg');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const registered = addRegistered(root, 'feat/mix', { thread: 'thread-1', issues: [35] });
      // Git still lists this record, but its directory is gone: the listing
      // never prints it as a live checkout, so it cannot collide either.
      const dead = path.join(path.dirname(root), `${path.basename(root)}-dead-mix`);
      track(dead);
      git(root, ['worktree', 'add', '-b', 'feat-mix', dead, 'HEAD']);
      fs.rmSync(dead, { recursive: true, force: true });
      const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-dead-sess-'))), 'session.jsonl');
      fs.writeFileSync(sessionFile, '{"type":"session"}\n');
      const calls = [];
      const { ctx, switches } = makeWarpCtx({ cwd: root, sessionFile, calls });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-mix', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: oscFake(true) });
      assert.equal(out.isError, undefined, `a name the listing prints once still moves: ${out.text}`);
      assert.equal(out.text, `worktree warp: feat-mix -> ${registered}`);
      assert.equal(switches.length, 1, 'the session really switched');
    } finally {
      restoreEnv();
    }
  });
});
