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
  const messageRenderers = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    registerMessageRenderer: (customType, renderer) => { messageRenderers.set(customType, renderer); },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  const mod = await import(pathToFileURL(copy).href);
  return { tools, commands, handlers, messageRenderers, mod };
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
function makeFakeSM(calls, { entries = [], targetEntries = [], sourceEntries = null } = {}) {
  void entries;
  // Like the real SessionManager.forkFrom, the fork inherits the source
  // entries verbatim: tests that need the post-transition target read
  // pass them explicitly; every other caller keeps the previous shape.
  const inherited = Array.isArray(sourceEntries) ? [...sourceEntries] : null;
  class FakeTarget {
    constructor(cwd, dir, file, carried) {
      this.cwd = cwd;
      this.dir = dir;
      this.file = file;
      this.appended = [];
      this.carried = Array.isArray(carried) ? carried : [];
    }
    getSessionFile() { return this.file; }
    getEntries() { return this.carried; }
    getLeafId() { return this.leaf === undefined ? null : this.leaf; }
    branch(id) { calls.push(['branch', id]); this.leaf = id; }
    resetLeaf() { calls.push(['resetLeaf']); this.leaf = null; }
    // Like the real SessionManager, bookkeeping appends advance the leaf
    // and stay visible in later getEntries() reads (S23).
    appendCustomEntry(type, data) {
      calls.push(['appendCustomEntry', type, data]);
      const id = `warp-entry-${calls.length}`;
      this.carried.push({ id, parentId: this.leaf === undefined ? null : this.leaf, type: 'custom', customType: type, data });
      this.leaf = id;
      return id;
    }
    appendSessionInfo(name) {
      calls.push(['appendSessionInfo', name]);
      const id = `session-info-${calls.length}`;
      this.carried.push({ id, parentId: this.leaf === undefined ? null : this.leaf, type: 'session_info', name });
      this.leaf = id;
      return id;
    }
    _appendEntry(entry) { calls.push(['_appendEntry', entry.id]); this.appended.push(entry); }
  }
  return class FakeSM {
    static forkFrom(sourcePath, targetCwd, sessionDir) {
      calls.push(['forkFrom', sourcePath, targetCwd, sessionDir]);
      const file = path.join(targetCwd, 'forked-session.jsonl');
      // Like the real SessionManager.forkFrom, the forked FILE carries the
      // source entries verbatim (header plus every non-header entry), so
      // file reads after the switch see the actual destination state.
      const carried = inherited !== null ? [...inherited] : targetEntries;
      const lines = ['{"type":"session"}', ...carried.map((entry) => JSON.stringify(entry))].join('\n') + '\n';
      fs.writeFileSync(file, lines);
      return new FakeTarget(targetCwd, sessionDir, file, carried);
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
  const sent = [];
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
        const replaced = {
          ui: { setStatus: () => {} },
          sendMessage: async (message, sendOptions) => { sent.push([message, sendOptions]); },
        };
        await options.withSession(replaced);
      }
      return switchResult;
    },
  };
  return { ctx, notes, selects, waited, switches, sent };
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

// S18/S19: the warp result is the two-line moved/to compact, never the old
// single-line arrow and never a paragraph dump.
function principalBranch(root) {
  return git(root, ['branch', '--show-current']);
}

function assertWarpMove(out, { name, branch, moved }) {
  const lines = String(out.text).split('\n');
  assert.equal(lines.length, 2, 'the warp result is exactly the moved/to compact: ' + JSON.stringify(out.text));
  assert.equal(lines[0], 'moved: ' + moved, 'first line names the checkout left');
  assert.equal(lines[1], 'to: ' + name + ' \u00B7 ' + branch, 'second line names the checkout entered');
  assert.ok(!out.text.includes('\x1b'), 'no ANSI in the warp result');
}

function assertNotifyMove(notes, expected) {
  assert.ok(notes.length > 0, 'expected at least one notification');
  assertWarpMove({ text: notes[notes.length - 1][0] }, expected);
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
      // Host semantics (agent-session-runtime.js switchSession): a switch
      // refused by the before-switch hook returns {cancelled:true} BEFORE
      // withSession ever runs, so a cancelled switch sends no notice.
      if (switchResult && switchResult.cancelled === true) return switchResult;
      if (typeof options?.withSession === 'function') {
        replaced = {
          ui: { setStatus: (key, text) => { statuses.push(['replaced:' + key, text]); } },
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

describe('herdr-gentle:warp command (S11)', { concurrency: false }, () => {
  test('the command is registered under the exact name even while the mode says disabled', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib().writeMode(false, process.env);
      const { tools, commands } = await loadExtension();
      assert.ok(commands.has('herdr-gentle:warp'), `exact name, got ${JSON.stringify([...commands.keys()])}`);
      assert.ok(commands.has('herdr-gentle:worktree'), 'the toggle itself stays registered');
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
      assert.deepEqual(options, [`feat-first — ${first}`, `feat-second — ${second}`, 'Create new worktree…']); // S44: create entry last (S47: no `+` prefix)
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
      assert.deepEqual(options, [`principal — ${root}`, `feat-second — ${second}`, 'Create new worktree…']); // S44: create entry last (S47: no `+` prefix)
    } finally {
      restoreEnv();
    }
  });

  test('unregistered live checkouts are offered after the registered rows (S14)', async () => {
    const root = makeRepo('selector-unreg');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const reg = addRegistered(root, 'feat/reg');
      const unreg = path.join(path.dirname(root), `${path.basename(root)}-cwarp-unreg`);
      track(unreg);
      git(root, ['worktree', 'add', '-b', 'feat/unreg', unreg, 'HEAD']);
      const unregReal = fs.realpathSync(unreg);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, selects } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.equal(selects.length, 1, 'exactly one selector opened');
      assert.deepEqual(selects[0][1], [`feat-reg — ${reg}`, `feat-unreg — ${unregReal}`, 'Create new worktree…']); // S44: create entry last (S47: no `+` prefix)
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
      const { ctx, notes, selects, waited, switches, sent } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
        selectImpl: (title, options) => options[0],
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.equal(selects.length, 1, 'the selector opened');
      assert.deepEqual(notes, [], 'S20: a real move notifies nothing itself; the card is the confirmation');
      assert.equal(waited.length, 1, 'the warp waited for idle');
      assert.equal(switches.length, 1, 'the session really switched');
      assert.equal(calls[0][0], 'forkFrom', 'the warp forked the session');
      assert.equal(calls[0][2], target, 'the fork landed in the chosen checkout');
      assert.equal(sent.length, 1, 'the single confirmation is the warp message');
      assert.equal(sent[0][0].customType, 'worktree-warp', 'the confirmation carries the card key');
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
      const { ctx, notes, selects, switches, sent } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('feat-warp-target', ctx);
      assert.deepEqual(selects, [], 'no selector opened for an explicit name');
      assert.deepEqual(notes, [], 'S20: a real move stays silent; the card is the confirmation');
      assert.equal(switches.length, 1, 'the session really switched');
      assert.equal(sent.length, 1, 'the single confirmation is the warp message');
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
  function makeFakeSM(calls, { entries = [], targetEntries = [] } = {}) {
    void entries;
    class FakeTarget {
      constructor(cwd, dir, file, carried) {
        this.cwd = cwd;
        this.dir = dir;
        this.file = file;
        this.appended = [];
        this.carried = Array.isArray(carried) ? carried : [];
      }
      getSessionFile() { return this.file; }
      getEntries() { return this.carried; }
      getLeafId() { return this.leaf === undefined ? null : this.leaf; }
      branch(id) { calls.push(['branch', id]); this.leaf = id; }
      resetLeaf() { calls.push(['resetLeaf']); this.leaf = null; }
      // Like the real SessionManager, bookkeeping appends advance the leaf
      // and stay visible in later getEntries() reads (S23).
      appendCustomEntry(type, data) {
        calls.push(['appendCustomEntry', type, data]);
        const id = `warp-entry-${calls.length}`;
        this.carried.push({ id, parentId: this.leaf === undefined ? null : this.leaf, type: 'custom', customType: type, data });
        this.leaf = id;
        return id;
      }
      appendSessionInfo(name) {
        calls.push(['appendSessionInfo', name]);
        const id = `session-info-${calls.length}`;
        this.carried.push({ id, parentId: this.leaf === undefined ? null : this.leaf, type: 'session_info', name });
        this.leaf = id;
        return id;
      }
      _appendEntry(entry) { calls.push(['_appendEntry', entry.id]); this.appended.push(entry); }
    }
    return class FakeSM {
      static forkFrom(sourcePath, targetCwd, sessionDir) {
        calls.push(['forkFrom', sourcePath, targetCwd, sessionDir]);
        const file = path.join(targetCwd, 'forked-session.jsonl');
        // Like the real SessionManager.forkFrom, the forked FILE carries the
        // source entries verbatim (header plus every non-header entry), so
        // file reads after the switch see the actual destination state.
        const lines = ['{"type":"session"}', ...targetEntries.map((entry) => JSON.stringify(entry))].join('\n') + '\n';
        fs.writeFileSync(file, lines);
        return new FakeTarget(targetCwd, sessionDir, file, targetEntries);
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
      assertWarpMove(out, { name: 'feat-warp-target', branch: 'feat/warp-target', moved: 'principal \u00B7 ' + principalBranch(root) });
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
      assert.equal(sent.length, 1, 'one transition notice sent');
      assert.equal(sent[0][1].triggerTurn, false, 'no turn triggered');
      assert.equal(String(sent[0][0].content || ''), `Worktree warp: now in ${target} (branch 'feat/warp-target').`);
      assert.ok(!String(sent[0][0].content || '').includes('Revalidate every cwd-dependent path and assumption.'), 'S41: the filler sentence is gone');
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
      assertWarpMove(out, { name: 'feat-mem-target', branch: 'feat/mem-target', moved: 'principal \u00B7 ' + principalBranch(root) });
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

  // NOTE (customize-command T2/S7): the `warp` verb of the removed
  // `/herdr-gentle:worktree` command died with it. Its usage-error
  // coverage lives on `/herdr-gentle:warp`: no argument opens the
  // selector ('with only the active checkout...', 'outside a git
  // repository...') and more than one name is a usage error
  // ('more than one name is a usage error that moves nothing').

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
      assertWarpMove(out, { name: 'principal', branch: principalBranch(root), moved: 'feat-nested \u00B7 feat/nested' });
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
      const out = await mod.executeWorktreeWarp('feat-mix', ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: oscFake(false) });
      assert.equal(out.isError, undefined, `a name the listing prints once still moves: ${out.text}`);
      assertWarpMove(out, { name: 'feat-mix', branch: 'feat/mix', moved: 'principal \u00B7 ' + principalBranch(root) });
      assert.equal(switches.length, 1, 'the session really switched');
    } finally {
      restoreEnv();
    }
  });
});

describe('S14 startup discovery + unregistered warp (T7 RED)', { concurrency: false }, () => {
  test('S28: session_start registers the missing repository worktrees, never the principal', async () => {
    const root = makeRepo('s14-startup');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const unreg = path.join(path.dirname(root), `${path.basename(root)}-s14-unreg`);
      track(unreg);
      git(root, ['worktree', 'add', '-b', 'feat/s14-unreg', unreg, 'HEAD']);
      const realUnreg = fs.realpathSync(unreg);
      const { handlers } = await loadExtension();
      assert.ok(handlers.has('session_start'), 'the extension observes session_start for startup discovery');
      const registryLib = require('../lib/worktree-registry.js');
      const fire = handlers.get('session_start');
      assert.ok(Array.isArray(fire) && fire.length > 0, 'at least one session_start handler');
      for (const handler of fire) {
        await handler({ reason: 'startup' }, { cwd: root, sessionManager: { getSessionId: () => 's14' } });
      }
      // S28: every repository worktree through git is registered when
      // missing — the creation path is only where new ones are born.
      const entry = registryLib.findByBranch(root, 'feat/s14-unreg');
      assert.ok(entry, 'discovery registered the missing worktree');
      assert.equal(entry.path, realUnreg, 'the checkout path is registered');
      // The principal checkout is never registered by discovery (S31:
      // its record is created on demand by an explicit edit).
      const principalBranch = git(root, ['branch', '--show-current']);
      const read = registryLib.readRegistry(root);
      assert.ok(read.ok, 'registry readable after discovery');
      assert.ok(
        !read.worktrees.some((row) => row.path === root || row.path === fs.realpathSync(root)),
        `discovery never registers the principal: ${JSON.stringify(read.worktrees)}`,
      );
      void principalBranch;
    } finally {
      restoreEnv();
    }
  });

  test('an explicit warp to an unregistered live checkout moves the session', async () => {
    const root = makeRepo('s14-explicit-unreg');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const unreg = path.join(path.dirname(root), `${path.basename(root)}-s14-explicit`);
      track(unreg);
      git(root, ['worktree', 'add', '-b', 'feat/s14-explicit', unreg, 'HEAD']);
      const target = fs.realpathSync(unreg);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, notes, selects, switches, sent } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('feat-s14-explicit', ctx);
      assert.deepEqual(selects, [], 'no selector opened for an explicit name');
      assert.deepEqual(notes, [], 'S20: no duplicate notification on a real move');
      assert.equal(sent.length, 1, 'the single confirmation is the warp message');
      assert.equal(switches.length, 1, 'the session really switched to the unregistered checkout');
    } finally {
      restoreEnv();
    }
  });

  test('the selector offers unregistered live checkouts after the registered rows', async () => {
    const root = makeRepo('s14-selector-unreg');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const reg = addRegistered(root, 'feat/reg');
      const unreg = path.join(path.dirname(root), `${path.basename(root)}-s14-sel-unreg`);
      track(unreg);
      git(root, ['worktree', 'add', '-b', 'feat/s14-sel', unreg, 'HEAD']);
      const target = fs.realpathSync(unreg);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, selects } = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      const { commands } = await loadExtension();
      await warpDef(commands).handler('', ctx);
      assert.equal(selects.length, 1, 'exactly one selector opened');
      const [title, options] = selects[0];
      assert.equal(title, `Warp session · current: principal ${root}`);
      assert.deepEqual(options, [`feat-reg — ${reg}`, `feat-s14-sel — ${target}`, 'Create new worktree…']); // S44: create entry last (S47: no `+` prefix)
    } finally {
      restoreEnv();
    }
  });
});

describe('S17 one warp session per checkout (T11 RED)', { concurrency: false }, () => {
  // Bounded T11 contract: at most ONE fork per checkout. The first warp
  // forks and records the session file keyed by the checkout realpath;
  // later warps to the same checkout switch to the recorded file with
  // no new fork. Only observable behavior is asserted: recorded fork
  // calls and the exact session file each switch lands on.

  function oscOff() {
    return { isTTY: false, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  }

  function warpLib() {
    return require('../lib/worktree-warp-sessions.js');
  }

  async function warpTo(name, { cwd, sessionFile, FakeSM, calls }) {
    const { ctx, notes, waited, switches } = makeSelectorCtx({
      cwd, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
    });
    const { mod } = await loadExtension();
    const out = await mod.executeWorktreeWarp(name, ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
    return { out, notes, waited, switches };
  }

  function forkKinds(calls) {
    // S23: the fork path renames through SessionManager.open + appendSessionInfo,
    // so only forkFrom allocation counts as forking here; the rename is pinned separately.
    return calls.map((call) => call[0]).filter((kind) => kind === 'forkFrom');
  }

  test('first warp to a checkout forks exactly once and records the session', async () => {
    const root = makeRepo('s17-first');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/first');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { out, switches } = await warpTo('feat-first', { cwd: root, sessionFile, FakeSM, calls });
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      assertWarpMove(out, { name: 'feat-first', branch: 'feat/first', moved: 'principal \u00B7 ' + principalBranch(root) });
      assert.deepEqual(forkKinds(calls), ['forkFrom'], 'exactly one fork allocation');
      assert.equal(switches.length, 1, 'the session really switched');
      const recorded = warpLib().getWarpSession(root, target);
      assert.ok(recorded, 'the warp recorded a session for the checkout');
      assert.equal(recorded.sessionFile, switches[0][0], 'the record names the file the switch landed on');
    } finally {
      restoreEnv();
    }
  });

  test('second warp to the same checkout reuses the recorded session without forking', async () => {
    const root = makeRepo('s17-reuse');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/reuse');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const first = await warpTo('feat-reuse', { cwd: root, sessionFile: sessionFileIn(), FakeSM, calls });
      assert.equal(first.out.isError, undefined, `first warp succeeds: ${first.out.text}`);
      const firstFile = first.switches[0][0];
      calls.length = 0;
      // A later session (fresh file, back in the principal) warps again.
      const second = await warpTo('feat-reuse', { cwd: root, sessionFile: sessionFileIn(), FakeSM, calls });
      assert.equal(second.out.isError, undefined, `second warp succeeds: ${second.out.text}`);
      assertWarpMove(second.out, { name: 'feat-reuse', branch: 'feat/reuse', moved: 'principal \u00B7 ' + principalBranch(root) });
      assert.deepEqual(forkKinds(calls), [], 'no second fork: the recorded session is resumed');
      assert.equal(second.switches.length, 1, 'the session still switched');
      assert.equal(second.switches[0][0], firstFile, 'the switch landed on the recorded session file');
    } finally {
      restoreEnv();
    }
  });

  test('warp to a different checkout forks its own session; returning reuses the first', async () => {
    const root = makeRepo('s17-two');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const first = addRegistered(root, 'feat/one');
      const second = addRegistered(root, 'feat/two');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const toOne = await warpTo('feat-one', { cwd: root, sessionFile: sessionFileIn(), FakeSM, calls });
      const fileOne = toOne.switches[0][0];
      calls.length = 0;
      const toTwo = await warpTo('feat-two', { cwd: first, sessionFile: fileOne, FakeSM, calls });
      assert.equal(toTwo.out.isError, undefined, `warp to the second checkout succeeds: ${toTwo.out.text}`);
      const fileTwo = toTwo.switches[0][0];
      assert.notEqual(fileTwo, fileOne, 'each checkout owns its session file');
      assert.deepEqual(forkKinds(calls), ['forkFrom'], 'the new checkout forked once');
      calls.length = 0;
      const back = await warpTo('feat-one', { cwd: second, sessionFile: fileTwo, FakeSM, calls });
      assert.equal(back.out.isError, undefined, `returning succeeds: ${back.out.text}`);
      assert.deepEqual(forkKinds(calls), [], 'returning forks nothing');
      assert.equal(back.switches[0][0], fileOne, 'returning lands on the first checkout’s recorded file');
    } finally {
      restoreEnv();
    }
  });

  test('principal warps resume the recorded principal session', async () => {
    const root = makeRepo('s17-principal');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const worktree = addRegistered(root, 'feat/away');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const toPrincipal = await warpTo('principal', { cwd: worktree, sessionFile: sessionFileIn(), FakeSM, calls });
      assert.equal(toPrincipal.out.isError, undefined, `warp to principal succeeds: ${toPrincipal.out.text}`);
      assertWarpMove(toPrincipal.out, { name: 'principal', branch: principalBranch(root), moved: 'feat-away \u00B7 feat/away' });
      const principalFile = toPrincipal.switches[0][0];
      calls.length = 0;
      const away = await warpTo('feat-away', { cwd: root, sessionFile: principalFile, FakeSM, calls });
      assert.equal(away.out.isError, undefined, `warp away succeeds: ${away.out.text}`);
      calls.length = 0;
      const back = await warpTo('principal', { cwd: worktree, sessionFile: away.switches[0][0], FakeSM, calls });
      assert.equal(back.out.isError, undefined, `returning to principal succeeds: ${back.out.text}`);
      assert.deepEqual(forkKinds(calls), [], 'returning to principal forks nothing');
      assert.equal(back.switches[0][0], principalFile, 'principal resumes its recorded session file');
    } finally {
      restoreEnv();
    }
  });

  test('a deleted recorded session file forks again and overwrites the record', async () => {
    const root = makeRepo('s17-stale');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/stale');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const first = await warpTo('feat-stale', { cwd: root, sessionFile: sessionFileIn(), FakeSM, calls });
      const firstFile = first.switches[0][0];
      assert.equal(fs.existsSync(firstFile), true, 'the recorded session file exists');
      fs.unlinkSync(firstFile);
      calls.length = 0;
      const second = await warpTo('feat-stale', { cwd: root, sessionFile: sessionFileIn(), FakeSM, calls });
      assert.equal(second.out.isError, undefined, `warp after deletion succeeds: ${second.out.text}`);
      assert.deepEqual(forkKinds(calls), ['forkFrom'], 'a missing session file forks again');
      assert.equal(second.switches[0][0], firstFile, 'the fork lands on the same checkout path');
      assert.equal(warpLib().getWarpSession(root, target).sessionFile, firstFile, 'the record names the fresh file');
    } finally {
      restoreEnv();
    }
  });

  test('a corrupt record file forks again without throwing', async () => {
    const root = makeRepo('s17-corrupt');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/corrupt');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const first = await warpTo('feat-corrupt', { cwd: root, sessionFile: sessionFileIn(), FakeSM, calls });
      assert.equal(first.out.isError, undefined, `first warp succeeds: ${first.out.text}`);
      fs.writeFileSync(warpLib().warpSessionsPath(root), '{not json\n');
      calls.length = 0;
      const second = await warpTo('feat-corrupt', { cwd: root, sessionFile: sessionFileIn(), FakeSM, calls });
      assert.equal(second.out.isError, undefined, `warp over a corrupt record succeeds: ${second.out.text}`);
      assert.deepEqual(forkKinds(calls), ['forkFrom'], 'a corrupt record forks again');
      assert.equal(second.switches.length, 1, 'the session still switched');
    } finally {
      restoreEnv();
    }
  });

  test('already-there warps fork nothing and write no record', async () => {
    const root = makeRepo('s17-there');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/here');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { mod } = await loadExtension();
      const { ctx } = makeSelectorCtx({
        cwd: target, FakeSM, sessionFile: sessionFileIn(), sessionDir: os.tmpdir(), calls, selectImpl: undefined,
      });
      const out = await mod.executeWorktreeWarp('feat-here', ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(out.text, 'worktree warp: feat-here (already there)');
      assert.deepEqual(forkKinds(calls), [], 'no fork');
      assert.equal(warpLib().getWarpSession(root, target), null, 'no record written');
      assert.equal(fs.existsSync(warpLib().warpSessionsPath(root)), false, 'no record file created');
    } finally {
      restoreEnv();
    }
  });

  test('refusals and Esc write no warp-session record', async () => {
    const root = makeRepo('s17-nothing');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/kept');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { mod } = await loadExtension();
      const refusedCtx = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile: '/tmp/nope.jsonl', sessionDir: '/tmp', calls, selectImpl: undefined,
      });
      const refused = await mod.executeWorktreeWarp('feat-nope', refusedCtx.ctx,
        { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(refused.isError, true, 'unknown names still fail closed');
      assert.deepEqual(forkKinds(calls), [], 'no fork on refusal');
      const { commands } = await loadExtension();
      const escCtx = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile: sessionFileIn(), sessionDir: os.tmpdir(), calls, selectImpl: () => undefined,
      });
      await warpDef(commands).handler('', escCtx.ctx);
      assert.deepEqual(escCtx.notes, [], 'Esc stays silent');
      assert.equal(fs.existsSync(warpLib().warpSessionsPath(root)), false, 'neither refusal nor Esc writes a record');
    } finally {
      restoreEnv();
    }
  });
});

describe('warp single notice + compact text (S18/S19 RED)', { concurrency: false }, () => {
  function warpCommit(root) {
    return principalBranch(root);
  }

  function noticeContent(sent) {
    assert.equal(sent.length, 1, 'exactly one agent-facing transition notice per real move');
    const message = sent[0][0];
    assert.equal(sent[0][1].triggerTurn, false, 'the notice never triggers a turn');
    const content = String(message.content || '');
    const lines = content.split('\n').filter((line) => line.trim().length > 0);
    assert.equal(lines.length, 1, 'the notice is one line: ' + JSON.stringify(content));
    assert.match(content, /^Worktree warp: now in .* \(branch '.*'\)\.$/, 'the notice names the checkout and branch: ' + JSON.stringify(content));
    assert.ok(!content.includes('Revalidate every cwd-dependent path and assumption.'), 'S41: the filler sentence is gone');
    assert.ok(!content.includes('this session moved from'), 'no repeated paragraph: ' + JSON.stringify(content));
    assert.ok(!content.includes('\x1b'), 'no ANSI in the notice');
    return content;
  }

  test('a forked move emits exactly one short notice plus the two-line result', async () => {
    const root = makeRepo('s18-fork');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/s18-fork');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, sent, switches } = makeWarpCtx({
        cwd: root, sessionFile, leaf: 'leaf-1', entries: [], sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-s18-fork', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(out.isError, undefined, 'expected success: ' + out.text);
      assertWarpMove(out, { name: 'feat-s18-fork', branch: 'feat/s18-fork', moved: 'principal \u00B7 ' + warpCommit(root) });
      assert.equal(switches.length, 1, 'the session really switched');
      const content = noticeContent(sent);
      assert.ok(content.includes(target), 'the notice names the new checkout');
      const appends = calls.filter((call) => call[0] === 'appendCustomEntry');
      assert.equal(appends.length, 1, 'the fresh fork records the transition exactly once');
    } finally {
      restoreEnv();
    }
  });

  // R2/S43: a resume re-enters the recorded session and appends no
  // extra confirmation — the moved session already carries its single
  // notice. Only an equal destination point resumes (S43 pins the fork on
  // advancement in the R3 tests below).
  test('a resumed move at the same point sends no extra notice', async () => {
    const root = makeRepo('s18-resume');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/s18-resume');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { mod } = await loadExtension();
      const firstCtx = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const first = await mod.executeWorktreeWarp('feat-s18-resume', firstCtx.ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(first.isError, undefined, 'first warp succeeds: ' + first.text);
      calls.length = 0;
      const secondCtx = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const second = await mod.executeWorktreeWarp('feat-s18-resume', secondCtx.ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(second.isError, undefined, 'resume succeeds: ' + second.text);
      assertWarpMove(second, { name: 'feat-s18-resume', branch: 'feat/s18-resume', moved: 'principal \u00B7 ' + warpCommit(root) });
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom'), [], 'resume forks nothing');
      assert.deepEqual(calls.filter((call) => call[0] === 'appendCustomEntry'), [], 'resume appends no fresh record');
      assert.deepEqual(secondCtx.sent, [], 'resume at the same point sends no extra confirmation');
    } finally {
      restoreEnv();
    }
  });

  test('already-there, refused and cancelled warps emit no notice', async () => {
    const root = makeRepo('s18-quiet');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/quiet');
      const { mod } = await loadExtension();
      const there = makeWarpCtx({ cwd: target, sessionFile: sessionFileIn(), calls: [] });
      const thereOut = await mod.executeWorktreeWarp('feat-quiet', there.ctx, { sessionManagerClass: makeFakeSM([]), oscStream: oscFake(false) });
      assert.equal(thereOut.details.alreadyThere, true);
      assert.deepEqual(there.sent, [], 'already-there sends no notice');
      const refused = makeWarpCtx({ cwd: root, sessionFile: '/tmp/nope.jsonl', calls: [] });
      const refusedOut = await mod.executeWorktreeWarp('feat-nope', refused.ctx, { sessionManagerClass: makeFakeSM([]), oscStream: oscFake(false) });
      assert.equal(refusedOut.isError, true);
      assert.deepEqual(refused.sent, [], 'a refusal sends no notice');
      const calls = [];
      const cancelled = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), calls, switchResult: { cancelled: true },
      });
      const cancelledOut = await mod.executeWorktreeWarp('feat-quiet', cancelled.ctx, { sessionManagerClass: makeFakeSM(calls), oscStream: oscFake(false) });
      assert.equal(cancelledOut.details.cancelled, true);
      assert.deepEqual(cancelled.sent, [], 'a cancelled switch sends no notice');
    } finally {
      restoreEnv();
    }
  });

  test('a fork skips the stored transition record when the target already carries it', async () => {
    const root = makeRepo('s18-dedupe');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/dedupe');
      const seed = [{
        type: 'custom', customType: 'worktree-warp', id: 'e0', parentId: null,
        data: { from: root, to: target, name: 'feat-dedupe', branch: 'feat/dedupe' },
      }];
      const calls = [];
      const FakeSM = makeFakeSM(calls, { targetEntries: seed });
      const { ctx, sent, switches } = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-dedupe', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(out.isError, undefined, 'expected success: ' + out.text);
      assert.deepEqual(calls.filter((call) => call[0] === 'appendCustomEntry'), [], 'no duplicate record for the same transition');
      assert.equal(switches.length, 1, 'the session still switched');
      noticeContent(sent);
    } finally {
      restoreEnv();
    }
  });
});

describe('warp styled single confirmation (S20)', { concurrency: false }, () => {
  function warpCommit(root) {
    return principalBranch(root);
  }

  function assertSingleStyledMessage(sent, { target, name, branch, moved }) {
    assert.equal(sent.length, 1, 'exactly one sendMessage per real move');
    const [message, sendOptions] = sent[0];
    assert.equal(message.customType, 'worktree-warp', 'the card renderer key travels on the message');
    assert.equal(message.display, true, 'the confirmation stays visible in the switched-to session');
    assert.equal(sendOptions.triggerTurn, false, 'the notice never triggers a turn');
    assert.deepStrictEqual(message.details, {
      from: moved.raw,
      to: target,
      fromDesc: moved.desc,
      fromName: moved.name,
      name,
      branch,
    }, 'the renderer reads the compact rows from details, never by parsing text');
    assert.ok(!String(message.content).includes('Revalidate every cwd-dependent path and assumption.'), 'S41: the filler sentence is gone');
    assert.ok(String(message.content).includes(target), 'the notice names the new checkout');
    assert.ok(!String(message.content).includes('[worktree-warp]'), 'no bracket label in the payload');
  }

  test('the extension registers a worktree-warp message renderer', async () => {
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { messageRenderers } = await loadExtension();
      assert.ok(messageRenderers.has('worktree-warp'), 'the warp card renderer is registered');
      assert.equal(typeof messageRenderers.get('worktree-warp'), 'function');
    } finally {
      restoreEnv();
    }
  });

  test('a forked move sends one styled message with the card details', async () => {
    const root = makeRepo('s20-fork');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/s20-fork');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, sent, switches } = makeWarpCtx({
        cwd: root, sessionFile, leaf: 'leaf-1', entries: [], sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-s20-fork', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(out.isError, undefined, 'expected success: ' + out.text);
      assert.equal(switches.length, 1, 'the session really switched');
      assertSingleStyledMessage(sent, {
        target,
        name: 'feat-s20-fork',
        branch: 'feat/s20-fork',
        moved: { raw: root, desc: 'principal \u00B7 ' + warpCommit(root), name: 'principal' },
      });
    } finally {
      restoreEnv();
    }
  });

  // R2/S43: a resume switches silently — the recorded session already
  // carries its single styled confirmation, so no second message is sent.
  // Only an equal destination point resumes (S43 pins the fork on
  // advancement in the R3 tests below).
  test('a resumed move at the same point sends no second message', async () => {
    const root = makeRepo('s20-resume');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/s20-resume');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { mod } = await loadExtension();
      const first = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const firstOut = await mod.executeWorktreeWarp('feat-s20-resume', first.ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(firstOut.isError, undefined, 'first warp succeeds: ' + firstOut.text);
      calls.length = 0;
      const second = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const secondOut = await mod.executeWorktreeWarp('feat-s20-resume', second.ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(secondOut.isError, undefined, 'resume succeeds: ' + secondOut.text);
      assert.equal(second.switches.length, 1, 'the session still switched to the recorded file');
      assert.deepEqual(second.sent, [], 'resume at the same point sends no second message');
    } finally {
      restoreEnv();
    }
  });

  test('refusals still notify and send no message', async () => {
    const root = makeRepo('s20-quiet');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/s20-quiet');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands } = await loadExtension();
      const refused = makeSelectorCtx({
        cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      await warpDef(commands).handler('feat-nope', refused.ctx);
      assert.equal(refused.notes.length, 1, 'refusals still notify');
      assert.deepEqual(refused.sent, [], 'refusals send no message');
    } finally {
      restoreEnv();
    }
  });
});

describe('bounded warp fix R1/R2/R3 (four explicit rules)', { concurrency: false }, () => {
  function warpLib() {
    return require('../lib/worktree-warp-sessions.js');
  }

  function oscOff() {
    return { isTTY: false, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  }

  // R1: warping to the checkout the session already runs in emits NOTHING
  // visible and writes nothing. The returned text stays byte-identical
  // (the failure-text contract), but no notify, no switch, no message,
  // no OSC and no record file may result.
  test('R1 already-there is silent and writes nothing', async () => {
    const root = makeRepo('r1-silent');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/r1-here');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands } = await loadExtension();
      const there = makeSelectorCtx({
        cwd: target, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls, selectImpl: undefined,
      });
      await warpDef(commands).handler('feat-r1-here', there.ctx);
      assert.deepEqual(there.notes, [], 'R1: no visible notification when already there');
      assert.deepEqual(there.sent, [], 'R1: no warp message when already there');
      assert.deepEqual(calls, [], 'R1: no fork when already there');
      assert.equal(fs.existsSync(warpLib().warpSessionsPath(root)), false, 'R1: no record file written');
      assert.deepEqual(there.ctx.ui ? [] : [], [], 'R1: harness sanity');
    } finally {
      restoreEnv();
    }
  });

  test('R1 already-there core text stays byte-identical', async () => {
    const root = makeRepo('r1-text');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/r1-text');
      const { mod } = await loadExtension();
      const ctx = makeWarpCtx({ cwd: target, sessionFile: sessionFileIn(), calls: [] });
      const out = await mod.executeWorktreeWarp('feat-r1-text', ctx.ctx, { sessionManagerClass: makeFakeSM([]), oscStream: oscOff() });
      assert.equal(out.text, 'worktree warp: feat-r1-text (already there)');
      assert.equal(out.details.alreadyThere, true);
      assert.deepEqual(ctx.sent, [], 'R1: core emits no message');
    } finally {
      restoreEnv();
    }
  });

  // R2: every REAL move carries exactly ONE visible confirmation, and
  // re-entering an already-moved session appends no copy.
  test('R2 fork carries exactly one visible confirmation', async () => {
    const root = makeRepo('r2-fork');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/r2-fork');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, sent, switches } = makeWarpCtx({
        cwd: root, sessionFile, leaf: 'leaf-1', entries: [], sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-r2-fork', ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(out.isError, undefined, 'expected success: ' + out.text);
      assert.equal(switches.length, 1, 'the session really switched');
      assert.equal(sent.length, 1, 'R2: exactly one visible confirmation per real move');
      assert.equal(sent[0][0].customType, 'worktree-warp');
    } finally {
      restoreEnv();
    }
  });

  test('R2 resume at the same point sends no extra confirmation', async () => {
    const root = makeRepo('r2-resume');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/r2-resume');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { mod } = await loadExtension();
      const first = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const firstOut = await mod.executeWorktreeWarp('feat-r2-resume', first.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(firstOut.isError, undefined, 'first warp succeeds: ' + firstOut.text);
      assert.equal(first.sent.length, 1, 'first move carries its single confirmation');
      calls.length = 0;
      const second = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const secondOut = await mod.executeWorktreeWarp('feat-r2-resume', second.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(secondOut.isError, undefined, 'resume succeeds: ' + secondOut.text);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom'), [], 'resume forks nothing');
      assert.deepEqual(second.sent, [], 'R2: re-entering appends no extra confirmation');
    } finally {
      restoreEnv();
    }
  });

  // S43: fork vs resume by destination point comparison. A checkout with
  // a usable recorded session file resumes it only while its filtered
  // point equals the current session's; a different point forks.
  // A bare leaf change with no new entries resumes like everything else.
  test('R3 same point resumes the same file with no extra confirmation', async () => {
    const root = makeRepo('r3-same');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/r3-same');
      const calls = [];
      const { mod } = await loadExtension();
      const entries = [{ id: 'e1', type: 'message' }];
      // Like the real SessionManager.forkFrom, the fake fork inherits the
      // source entries verbatim, so the recorded destination point names the
      // post-transition position faithfully.
      const FakeSM = makeFakeSM(calls, { sourceEntries: entries });
      const first = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries, sessionDir: os.tmpdir(), calls,
      });
      const firstOut = await mod.executeWorktreeWarp('feat-r3-same', first.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(firstOut.isError, undefined, 'first warp succeeds: ' + firstOut.text);
      const firstFile = first.switches[0][0];
      calls.length = 0;
      const second = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [{ id: 'e1', type: 'message' }], sessionDir: os.tmpdir(), calls,
      });
      const secondOut = await mod.executeWorktreeWarp('feat-r3-same', second.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(secondOut.isError, undefined, 'resume succeeds: ' + secondOut.text);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom'), [], 'same point forks nothing');
      assert.equal(second.switches[0][0], firstFile, 'same point lands on the same recorded file');
      assert.deepEqual(second.sent, [], 'same point sends no extra confirmation');
    } finally {
      restoreEnv();
    }
  });

  // The filtered-point helpers still back the records (our own marker and
  // rename appends never move the filtered point); the S43 gate compares
  // those points — equal resumes, different forks.
  test('R3 a bare leaf change with no new entries resumes without forking', async () => {
    const root = makeRepo('r3-leaf');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/r3-leaf');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { mod } = await loadExtension();
      const first = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const firstOut = await mod.executeWorktreeWarp('feat-r3-leaf', first.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(firstOut.isError, undefined, 'first warp succeeds: ' + firstOut.text);
      const firstFile = first.switches[0][0];
      calls.length = 0;
      const second = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-2', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const secondOut = await mod.executeWorktreeWarp('feat-r3-leaf', second.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(secondOut.isError, undefined, 'second warp succeeds: ' + secondOut.text);
      assert.deepStrictEqual(calls.filter((call) => call[0] === 'forkFrom'), [], 'S23: a leaf that moved with no new entries is our own bookkeeping, not advancement');
      assert.equal(second.switches[0][0], firstFile, 'the same recorded file is resumed');
      assert.deepStrictEqual(second.sent, [], 'resuming sends no extra confirmation');
      assert.deepStrictEqual(
        [warpLib().getWarpSession(root, target).tipId, warpLib().getWarpSession(root, target).count],
        [null, 0], 'S23: the record still names the filtered point',
      );
    } finally {
      restoreEnv();
    }
  });

  // S43 (point comparison back at the gate): an advanced current session
  // forks its own child — no resume, a new file and a fresh confirmation —
  // and the work stays in the thread where it was written.
  test('R3 an advanced current session forks its own child with a fresh confirmation', async () => {
    const root = makeRepo('r3-entries');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/r3-entries');
      const calls = [];
      const { mod } = await loadExtension();
      // Real entry shape: every entry links its parent, so the active
      // branch is the full chain (an unlinked array would read as one leg).
      const firstEntries = [{ id: 'e1', parentId: null, type: 'message' }];
      const first = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: firstEntries, sessionDir: os.tmpdir(), calls,
      });
      const firstOut = await mod.executeWorktreeWarp('feat-r3-entries', first.ctx, { sessionManagerClass: makeFakeSM(calls, { sourceEntries: firstEntries }), oscStream: oscOff() });
      assert.equal(firstOut.isError, undefined, 'first warp succeeds: ' + firstOut.text);
      const firstFile = first.switches[0][0];
      calls.length = 0;
      // Real work after the first visit: the current session advanced past
      // the destination's recorded point, so S43 forks its own child.
      const advancedFile = sessionFileIn();
      const secondEntries = [{ id: 'e1', parentId: null, type: 'message' }, { id: 'e2', parentId: 'e1', type: 'message' }];
      const second = makeWarpCtx({
        cwd: root, sessionFile: advancedFile, leaf: 'leaf-1',
        entries: secondEntries,
        sessionDir: os.tmpdir(), calls,
      });
      const secondOut = await mod.executeWorktreeWarp('feat-r3-entries', second.ctx, { sessionManagerClass: makeFakeSM(calls, { sourceEntries: secondEntries }), oscStream: oscOff() });
      assert.equal(secondOut.isError, undefined, 'advanced warp succeeds: ' + secondOut.text);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom').length, 1, 'S43: an advanced session forks its own child');
      assert.equal(second.switches.length, 1, 'the session still switched');
      const forkFile = second.switches[0][0];
      // The fake fork reuses one path per checkout, so the new fork is
      // proven by its source, its confirmation and its recorded point.
      assert.equal(calls.filter((call) => call[0] === 'forkFrom')[0][1], advancedFile, 'the fork branches from the advanced session file');
      assert.equal(second.sent.length, 1, 'S43: a real move carries its single confirmation');
      assert.deepEqual(fs.readdirSync(target).filter((f) => f.endsWith('.jsonl')), ['forked-session.jsonl'], 'S43: the new fork is the checkout\u2019s session file');
      const lib = warpLib();
      assert.deepStrictEqual(
        [lib.getWarpSession(root, target).tipId, lib.getWarpSession(root, target).count],
        ['e2', 2], 'the destination now names the new fork\u2019s point, not the old record');
      assert.equal(lib.getWarpSession(root, target).sessionFile, forkFile, 'the destination now names the new fork');
      assert.equal(lib.getWarpSession(root, root).sessionFile, advancedFile, 'the source side still recorded the file just left');
    } finally {
      restoreEnv();
    }
  });
});

describe('S23 filtered session identity (T16 RED)', { concurrency: false }, () => {
  function warpLib() {
    return require('../lib/worktree-warp-sessions.js');
  }

  function oscOff() {
    return { isTTY: false, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  }

  async function warpOnce(name, { cwd, sessionFile, leaf, entries, sessionDir, calls, sourceEntries }) {
    const { mod } = await loadExtension();
    // Like the real forkFrom, the fake fork inherits the source entries
    // verbatim unless a test says otherwise.
    const FakeSM = makeFakeSM(calls, { sourceEntries: sourceEntries !== undefined ? sourceEntries : entries });
    const wctx = makeWarpCtx({ cwd, sessionFile, leaf, entries, sessionDir, calls });
    const out = await mod.executeWorktreeWarp(name, wctx.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
    return { out, wctx, FakeSM };
  }

  function forked(calls) {
    return calls.filter((call) => call[0] === 'forkFrom');
  }

  test('a fresh fork filtered point equals its source (the identical-fork property)', () => {
    const lib = warpLib();
    const src = [
      { id: 'e1', parentId: null, type: 'message' },
      { id: 'e2', parentId: 'e1', type: 'message' },
    ];
    // forkFrom copies entries verbatim, then the warp appends exactly one
    // marker plus the checkout rename: none of that is real work.
    const after = [...src,
      { id: 'm1', parentId: 'e2', type: 'custom', customType: 'worktree-warp', data: { from: '/a', to: '/b' } },
      { id: 's1', parentId: 'm1', type: 'session_info', name: 'notes \u00B7 feat-x' },
    ];
    assert.deepStrictEqual(lib.sessionPoint(after), lib.sessionPoint(src));
    assert.deepStrictEqual(lib.sessionPoint(after), { tipId: 'e2', count: 2 });
    assert.deepStrictEqual(lib.sessionPoint([]), { tipId: null, count: 0 });
  });

  test('records written before the fix still read through the filtered point', () => {
    const root = makeRepo('s23-legacy');
    const lib = warpLib();
    const doc = { version: 1, sessions: {} };
    doc.sessions[root] = {
      sessionFile: '/tmp/old-session.jsonl', leafId: 'e9', entryCount: 3,
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
    fs.writeFileSync(lib.warpSessionsPath(root), `${JSON.stringify(doc, null, 2)}\n`);
    const rec = lib.getWarpSession(root, root);
    assert.ok(rec, 'a legacy-shaped record still resolves');
    assert.equal(rec.tipId, 'e9', 'leafId reads as the filtered tip');
    assert.equal(rec.count, 3, 'entryCount reads as the filtered count');
  });

  test('every transition records both sides at their post-transition points', async () => {
    const root = makeRepo('s23-both');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/both');
      const calls = [];
      const sessionFile = sessionFileIn();
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      const first = await warpOnce('feat-both', {
        cwd: root, sessionFile, leaf: 'e1', entries: [e1], sessionDir: path.dirname(sessionFile), calls,
      });
      assert.equal(first.out.isError, undefined, `expected success: ${first.out.text}`);
      const forkFile = first.wctx.switches[0][0];
      const lib = warpLib();
      const dest = lib.getWarpSession(root, target);
      assert.ok(dest, 'the destination checkout is recorded');
      assert.equal(dest.sessionFile, forkFile, 'the destination record names the forked file');
      assert.deepStrictEqual([dest.tipId, dest.count], ['e1', 1], 'destination at its post-transition point');
      const src = lib.getWarpSession(root, root);
      assert.ok(src, 'the source checkout is recorded too, not just the destination');
      assert.equal(src.sessionFile, sessionFile, 'the source record names the session file left behind');
      assert.deepStrictEqual([src.tipId, src.count], ['e1', 1], 'source at its own point');
    } finally {
      restoreEnv();
    }
  });

  test('warp out and straight back resumes the same file with no new file and no notice', async () => {
    const root = makeRepo('s23-back');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/back');
      const calls = [];
      const sessionFile = sessionFileIn();
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      // Faithful file: the resume gate reads the destination FILE's actual
      // point, so the recorded session holds its logical entries on disk.
      fs.appendFileSync(sessionFile, `${JSON.stringify(e1)}\n`);
      const first = await warpOnce('feat-back', {
        cwd: root, sessionFile, leaf: 'e1', entries: [e1], sessionDir: path.dirname(sessionFile), calls,
      });
      assert.equal(first.out.isError, undefined, `expected success: ${first.out.text}`);
      const forkFile = first.wctx.switches[0][0];
      // The live fork carries the warp marker plus its checkout rename and
      // its leaf moved on: under the old raw leaf/count comparison that
      // alone always forced a second fork (the duplicate chain).
      const backEntries = [e1,
        { id: 'm1', parentId: 'e1', type: 'custom', customType: 'worktree-warp', data: { from: root, to: target } },
      ];
      for (const call of calls) {
        if (call[0] === 'appendSessionInfo') {
          backEntries.push({ id: 's1', parentId: 'm1', type: 'session_info', name: call[1] });
        }
      }
      calls.length = 0;
      const second = await warpOnce('principal', {
        cwd: target, sessionFile: forkFile, leaf: backEntries[backEntries.length - 1].id,
        entries: backEntries, sessionDir: path.dirname(forkFile), calls,
      });
      assert.equal(second.out.isError, undefined, `returning succeeds: ${second.out.text}`);
      assert.deepStrictEqual(forked(calls), [], 'no new fork on the way back: the marker and rename are not advancement');
      assert.equal(second.wctx.switches[0][0], sessionFile, 'the way back lands on the exact source file');
      assert.deepStrictEqual(second.wctx.sent, [], 'resuming sends no second notice');
    } finally {
      restoreEnv();
    }
  });

  // S43: real work in between forks its own child with a fresh
  // confirmation — the points differ, so the destination's old record
  // never wins back.
  test('real work in between forks its own child with a fresh confirmation', async () => {
    const root = makeRepo('s23-work');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/work');
      const calls = [];
      const sessionFile = sessionFileIn();
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      const first = await warpOnce('feat-work', {
        cwd: root, sessionFile, leaf: 'e1', entries: [e1], sessionDir: path.dirname(sessionFile), calls,
      });
      assert.equal(first.out.isError, undefined, `expected success: ${first.out.text}`);
      const firstFile = first.wctx.switches[0][0];
      calls.length = 0;
      // Genuine follow-up work: a new entry the bookkeeping filter keeps —
      // S43 forks its own child instead of resuming the old record.
      const e2 = { id: 'e2', parentId: 'e1', type: 'message' };
      const advancedFile = sessionFileIn();
      const second = await warpOnce('feat-work', {
        cwd: root, sessionFile: advancedFile, leaf: 'e2', entries: [e1, e2],
        sessionDir: os.tmpdir(), calls,
      });
      assert.equal(second.out.isError, undefined, `advanced warp succeeds: ${second.out.text}`);
      const forks = forked(calls);
      assert.deepStrictEqual(forks.length, 1, 'S43: real work elsewhere forks its own child');
      assert.equal(second.wctx.switches.length, 1, 'the session still switched');
      const forkFile = second.wctx.switches[0][0];
      // The fake fork reuses one path per checkout, so the new fork is
      // proven by its confirmation and its recorded point.
      assert.equal(second.wctx.sent.length, 1, 'S43: the real move carries its single confirmation');
      const rec = warpLib().getWarpSession(root, target);
      assert.deepStrictEqual([rec.tipId, rec.count], ['e2', 2], 'the destination now names the new fork\u2019s point');
      assert.equal(rec.sessionFile, forkFile, 'the destination now names the new fork');
    } finally {
      restoreEnv();
    }
  });

  test('each fork is renamed to carry the checkout, never on resume', async () => {
    const root = makeRepo('s23-named');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/named');
      const calls = [];
      const sessionFile = sessionFileIn();
      const entries = [
        { id: 'e1', parentId: null, type: 'message' },
        { id: 's0', parentId: 'e1', type: 'session_info', name: 'field notes' },
      ];
      // Faithful file: the resume gate reads the destination FILE's actual
      // point, so the recorded session holds its logical entries on disk.
      for (const entry of entries) fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      const first = await warpOnce('feat-named', {
        cwd: root, sessionFile, leaf: 's0', entries, sessionDir: path.dirname(sessionFile), calls,
      });
      assert.equal(first.out.isError, undefined, `expected success: ${first.out.text}`);
      const forkFile = first.wctx.switches[0][0];
      const renames = calls.filter((call) => call[0] === 'appendSessionInfo');
      assert.equal(renames.length, 1, 'the fork is renamed exactly once');
      assert.equal(renames[0][1], 'field notes · feat-named');
      assert.ok(calls.some((call) => call[0] === 'open' && call[1] === forkFile),
        'the rename goes through SessionManager.open on the forked file');
      // The way back resumes the recorded file: no fork, no rename, no notice.
      calls.length = 0;
      const backEntries = [...entries,
        { id: 'm1', parentId: 's0', type: 'custom', customType: 'worktree-warp', data: { from: root, to: target } },
        { id: 's1', parentId: 'm1', type: 'session_info', name: renames[0][1] },
      ];
      const second = await warpOnce('principal', {
        cwd: target, sessionFile: forkFile, leaf: 's1', entries: backEntries,
        sessionDir: path.dirname(forkFile), calls,
      });
      assert.equal(second.out.isError, undefined, `returning succeeds: ${second.out.text}`);
      assert.deepStrictEqual(forked(calls), [], 'resume forks nothing');
      assert.deepStrictEqual(calls.filter((call) => call[0] === 'appendSessionInfo'), [], 'resume never renames');
      assert.deepStrictEqual(second.wctx.sent, [], 'resume sends no second notice');
    } finally {
      restoreEnv();
    }
  });

  test('a fork that already carries the checkout name is not renamed again', async () => {
    const root = makeRepo('s23-named-twice');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/named');
      const calls = [];
      const entries = [
        { id: 'e1', parentId: null, type: 'message' },
        { id: 's0', parentId: 'e1', type: 'session_info', name: 'field notes · feat-named' },
      ];
      const first = await warpOnce('feat-named', {
        cwd: root, sessionFile: sessionFileIn(), leaf: 's0', entries,
        sessionDir: os.tmpdir(), calls,
      });
      assert.equal(first.out.isError, undefined, `expected success: ${first.out.text}`);
      assert.deepStrictEqual(calls.filter((call) => call[0] === 'appendSessionInfo'), [],
        'a name that already carries the checkout is left alone');
    } finally {
      restoreEnv();
    }
  });
});

describe('S23 fork name from the base name (accumulation fix)', { concurrency: false }, () => {
  function oscOff() {
    return { isTTY: false, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  }

  async function warpTo(name, { cwd, sessionFile, leaf, entries, sessionDir, calls, extraSession }) {
    const FakeSM = makeFakeSM(calls, { sourceEntries: entries });
    const wctx = makeWarpCtx({ cwd, sessionFile, leaf, entries, sessionDir, calls });
    if (extraSession) Object.assign(wctx.ctx.sessionManager, extraSession);
    const { mod } = await loadExtension();
    const out = await mod.executeWorktreeWarp(name, wctx.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
    return { out, wctx };
  }

  function renames(calls) {
    return calls.filter((call) => call[0] === 'appendSessionInfo');
  }

  test('a fork of a session whose name already carries one appended checkout is named from the base only', async () => {
    const root = makeRepo('base-only');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/named');
      const calls = [];
      const sessionFile = sessionFileIn();
      // As an earlier fork left it: the original base plus one appended
      // checkout segment. The next fork must re-derive from the base.
      const entries = [
        { id: 'e1', parentId: null, type: 'message' },
        { id: 's0', parentId: 'e1', type: 'session_info', name: 'field notes' },
        { id: 's1', parentId: 's0', type: 'session_info', name: 'field notes · feat-old' },
      ];
      const { out } = await warpTo('feat-named', {
        cwd: root, sessionFile, leaf: 's1', entries, sessionDir: path.dirname(sessionFile), calls,
      });
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      const named = renames(calls);
      assert.equal(named.length, 1, 'the fork is renamed exactly once');
      assert.equal(named[0][1], 'field notes · feat-named',
        'named from the ORIGINAL base with the checkout written once');
      assert.ok(!named[0][1].includes('feat-old'), 'no segment of the previous checkout repeats');
      assert.equal(named[0][1].split(' · ').length, 2, 'exactly base plus one checkout segment');
    } finally {
      restoreEnv();
    }
  });

  test('the second hop does not stack a third checkout segment', async () => {
    const root = makeRepo('no-stack');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const firstTarget = addRegistered(root, 'feat/first');
      addRegistered(root, 'feat/second');
      const calls = [];
      const sessionFile = sessionFileIn();
      const firstEntries = [
        { id: 'e1', parentId: null, type: 'message' },
        { id: 's0', parentId: 'e1', type: 'session_info', name: 'field notes' },
      ];
      const first = await warpTo('feat-first', {
        cwd: root, sessionFile, leaf: 's0', entries: firstEntries,
        sessionDir: path.dirname(sessionFile), calls,
      });
      assert.equal(first.out.isError, undefined, `first hop succeeds: ${first.out.text}`);
      const forkFile = first.wctx.switches[0][0];
      assert.equal(renames(calls)[0][1], 'field notes · feat-first', 'first hop names base plus one segment');
      // Second hop with no new work but to a checkout with no record yet:
      // it forks once, named from the same base — never stacked.
      calls.length = 0;
      const secondEntries = [...firstEntries,
        { id: 'm1', parentId: 's0', type: 'custom', customType: 'worktree-warp', data: { from: root, to: firstTarget } },
        { id: 's1', parentId: 'm1', type: 'session_info', name: 'field notes · feat-first' },
      ];
      const second = await warpTo('feat-second', {
        cwd: firstTarget, sessionFile: forkFile, leaf: 's1', entries: secondEntries,
        sessionDir: path.dirname(forkFile), calls,
      });
      assert.equal(second.out.isError, undefined, `second hop succeeds: ${second.out.text}`);
      const named = renames(calls);
      assert.equal(named.length, 1, 'the second fork is renamed exactly once');
      assert.equal(named[0][1], 'field notes · feat-second',
        'second hop re-derives from the base, dropping the previous checkout');
      assert.ok(!named[0][1].includes('feat-first'), 'the previous checkout segment does not repeat');
    } finally {
      restoreEnv();
    }
  });

  test('a resume never renames, even when the name already carries a checkout', async () => {
    const root = makeRepo('resume-quiet');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/back');
      const calls = [];
      const sessionFile = sessionFileIn();
      const entries = [
        { id: 'e1', parentId: null, type: 'message' },
        { id: 's0', parentId: 'e1', type: 'session_info', name: 'field notes' },
      ];
      // Faithful file: the resume gate reads the destination FILE's actual
      // point, so the recorded session holds its logical entries on disk.
      for (const entry of entries) fs.appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
      const first = await warpTo('feat-back', {
        cwd: root, sessionFile, leaf: 's0', entries, sessionDir: path.dirname(sessionFile), calls,
      });
      assert.equal(first.out.isError, undefined, `expected success: ${first.out.text}`);
      const forkFile = first.wctx.switches[0][0];
      // The way back resumes the recorded file: no fork, no rename, no
      // notice — even though the carried name holds a checkout segment.
      calls.length = 0;
      const backEntries = [...entries,
        { id: 'm1', parentId: 's0', type: 'custom', customType: 'worktree-warp', data: { from: root, to: target } },
        { id: 's1', parentId: 'm1', type: 'session_info', name: 'field notes · feat-back' },
      ];
      const second = await warpTo('principal', {
        cwd: target, sessionFile: forkFile, leaf: 's1', entries: backEntries,
        sessionDir: path.dirname(forkFile), calls,
      });
      assert.equal(second.out.isError, undefined, `returning succeeds: ${second.out.text}`);
      assert.deepStrictEqual(calls.filter((call) => call[0] === 'forkFrom'), [], 'resume forks nothing');
      assert.deepStrictEqual(renames(calls), [], 'resume never renames');
      assert.deepStrictEqual(second.wctx.sent, [], 'resume sends no second notice');
    } finally {
      restoreEnv();
    }
  });

  test('an unnamed session still gets a usable name', async () => {
    const root = makeRepo('unnamed');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/unnamed');
      const calls = [];
      const sessionFile = sessionFileIn();
      // Content but no session_info entry anywhere, and no manager name:
      // the checkout label alone is the stable default.
      const entries = [{ id: 'e1', parentId: null, type: 'message' }];
      const { out } = await warpTo('feat-unnamed', {
        cwd: root, sessionFile, leaf: 'e1', entries, sessionDir: path.dirname(sessionFile), calls,
      });
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      const named = renames(calls);
      assert.equal(named.length, 1, 'the fork is renamed exactly once');
      assert.equal(named[0][1], 'feat-unnamed', 'no name at all falls back to the checkout label alone');
    } finally {
      restoreEnv();
    }
  });

  test('no session_info entry falls back to the current manager name', async () => {
    const root = makeRepo('current-name');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/cur');
      const calls = [];
      const sessionFile = sessionFileIn();
      const entries = [{ id: 'e1', parentId: null, type: 'message' }];
      const { out } = await warpTo('feat-cur', {
        cwd: root, sessionFile, leaf: 'e1', entries, sessionDir: path.dirname(sessionFile), calls,
        extraSession: { getSessionName: () => 'live name' },
      });
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      const named = renames(calls);
      assert.equal(named.length, 1, 'the fork is renamed exactly once');
      assert.equal(named[0][1], 'live name · feat-cur',
        'entries without session_info fall back to the current name as base');
    } finally {
      restoreEnv();
    }
  });
});

describe('S43 destination point comparison (T33 RED)', { concurrency: false }, () => {
  // S43 restores the point comparison at the resume gate: the destination's
  // usable record resumes only while its filtered point equals the current
  // session's filtered point (the warp's own markers and renames excluded
  // from both); a different point forks. Records are crafted directly
  // through the public registry; every warp still runs through the public
  // `executeWorktreeWarp` harness only.
  function oscOff() {
    return { isTTY: false, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  }

  function warpLib() {
    return require('../lib/worktree-warp-sessions.js');
  }

  test('resume needs no own record: an equal destination point resumes', async () => {
    const root = makeRepo('s37-no-own');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/no-own');
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      // A destination recorded earlier at this exact filtered point, with a live file ...
      const destFile = sessionFileIn();
      // Faithful file: the resume gate reads the destination FILE's actual
      // point, so the live file holds the recorded content on disk.
      fs.appendFileSync(destFile, `${JSON.stringify(e1)}\n`);
      assert.equal(warpLib().recordWarpSession(root, target, { sessionFile: destFile, tipId: 'e1', count: 1 }).ok, true);
      // ... while the checkout being left was NEVER recorded: no own record at all.
      assert.equal(warpLib().getWarpSession(root, root), null, 'no own record exists');
      const calls = [];
      const sessionFile = sessionFileIn();
      const wctx = makeWarpCtx({
        cwd: root, sessionFile, leaf: 'e1', entries: [e1], sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-no-own', wctx.ctx,
        { sessionManagerClass: makeFakeSM(calls, { sourceEntries: [e1] }), oscStream: oscOff() });
      assert.equal(out.isError, undefined, 'expected success: ' + out.text);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom'), [],
        'S43: an equal destination point resumes even with no own record');
      assert.equal(wctx.switches.length, 1, 'the session still switched');
      assert.equal(wctx.switches[0][0], destFile, 'the switch landed on the recorded destination file');
      assert.deepEqual(wctx.sent, [], 'S43: the resume sends no fresh confirmation');
      assert.deepEqual(calls.filter((call) => call[0] === 'appendCustomEntry'), [],
        'S43: the resume appends no new marker');
    } finally {
      restoreEnv();
    }
  });

  // S43: a diverged destination forks — the point comparison is back at
  // the gate, so any usable destination record whose point differs from
  // the current session's forks its own child with a fresh confirmation.
  test('a diverged destination forks its own child with a fresh confirmation', async () => {
    const root = makeRepo('s37-diverged');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/diverged');
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      const sessionFile = sessionFileIn();
      // The checkout being left matches its own record exactly ...
      assert.equal(warpLib().recordWarpSession(root, root, { sessionFile, tipId: 'e1', count: 1 }).ok, true);
      // ... but the destination holds other content at another point.
      const destFile = sessionFileIn();
      // Faithful file: the live file holds that other content (the gate
      // reads the file's actual point, so a stale cached fingerprint
      // cannot win back).
      for (const entry of [
        { id: 'e8', parentId: null, type: 'message' },
        { id: 'e9', parentId: 'e8', type: 'message' },
      ]) fs.appendFileSync(destFile, `${JSON.stringify(entry)}\n`);
      assert.equal(warpLib().recordWarpSession(root, target, { sessionFile: destFile, tipId: 'e9', count: 9 }).ok, true);
      const calls = [];
      const wctx = makeWarpCtx({
        cwd: root, sessionFile, leaf: 'e1', entries: [e1], sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-diverged', wctx.ctx,
        { sessionManagerClass: makeFakeSM(calls, { sourceEntries: [e1] }), oscStream: oscOff() });
      assert.equal(out.isError, undefined, 'expected success: ' + out.text);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom').length, 1,
        'S43: a diverged destination forks its own child');
      assert.equal(wctx.switches.length, 1, 'the session still switched');
      assert.notEqual(wctx.switches[0][0], destFile, 'the switch lands on the new fork, not the diverged record');
      assert.equal(wctx.sent.length, 1, 'S43: the real move carries its single confirmation');
      assert.deepEqual(calls.filter((call) => call[0] === 'appendCustomEntry').length, 1,
        'S43: the new fork records its own transition');
    } finally {
      restoreEnv();
    }
  });

  // S43 three hops: main -> worktree forks once (first visit); real work
  // in the worktree then warping back to main forks again (the points
  // differ, so the advanced session yields its own child); warping to the
  // worktree once the points match again resumes its own session — and
  // the new work stays in the thread where it was written.
  test('three hops: main -> worktree forks once, advance -> main forks, matching points resume', async () => {
    const root = makeRepo('s37-hops');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/hops');
      const calls = [];
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      const e2 = { id: 'e2', parentId: 'e1', type: 'message' };
      const { mod } = await loadExtension();
      const hop = async (name, { cwd, sessionFile, leaf, entries }) => {
        const wctx = makeWarpCtx({
          cwd, sessionFile, leaf, entries, sessionDir: path.dirname(sessionFile), calls,
        });
        const out = await mod.executeWorktreeWarp(name, wctx.ctx,
          { sessionManagerClass: makeFakeSM(calls, { sourceEntries: entries }), oscStream: oscOff() });
        return { out, wctx };
      };
      // Hop 1: main -> worktree forks (the destination has no record yet).
      const mainFile = sessionFileIn();
      const first = await hop('feat-hops', { cwd: root, sessionFile: mainFile, leaf: 'e1', entries: [e1] });
      assert.equal(first.out.isError, undefined, 'hop 1 succeeds: ' + first.out.text);
      const workFile = first.wctx.switches[0][0];
      assert.equal(calls.filter((call) => call[0] === 'forkFrom').length, 1, 'hop 1 forks once');
      assert.equal(first.wctx.sent.length, 1, 'hop 1 carries its single confirmation');
      // Hop 2: real work in the worktree, then warp back to main FORKS —
      // S43: the current point moved past principal's recorded point, so
      // the advanced session yields its own child with a confirmation.
      calls.length = 0;
      const second = await hop('principal', { cwd: target, sessionFile: workFile, leaf: 'e2', entries: [e1, e2] });
      assert.equal(second.out.isError, undefined, 'hop 2 succeeds: ' + second.out.text);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom').length, 1,
        'hop 2 forks: the points differ after real work');
      assert.equal(second.wctx.switches.length, 1, 'hop 2 still switched');
      assert.notEqual(second.wctx.switches[0][0], mainFile, 'hop 2 lands on the new fork, not principal\u2019s old file');
      assert.equal(second.wctx.sent.length, 1, 'hop 2 carries its single confirmation');
      const mainForkFile = second.wctx.switches[0][0];
      // Faithful file: the real work between the hops persisted into the
      // worktree's session (the live runtime appends through its reopened
      // manager), so the destination FILE reads at the recorded point.
      const workLines = fs.readFileSync(workFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const workLast = workLines[workLines.length - 1].id;
      fs.appendFileSync(workFile, `${JSON.stringify({ id: 'e2', parentId: workLast, type: 'message' })}\n`);
      // Hop 3: warp to the worktree again with entries at the worktree's
      // recorded point RESUMES its own session with no copy and no notice.
      calls.length = 0;
      const liveForkEntries = [e1, e2,
        { id: 'm1', parentId: 'e2', type: 'custom', customType: 'worktree-warp', data: { from: target, to: root } },
        { id: 's1', parentId: 'm1', type: 'session_info', name: 'notes \u00B7 feat-hops' },
      ];
      const third = await hop('feat-hops', { cwd: root, sessionFile: mainForkFile, leaf: 's1', entries: liveForkEntries });
      assert.equal(third.out.isError, undefined, 'hop 3 succeeds: ' + third.out.text);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom'), [],
        'hop 3 forks nothing: the destination has a usable record');
      assert.deepEqual(calls.filter((call) => call[0] === 'appendCustomEntry'), [],
        'hop 3 appends no new marker');
      assert.equal(third.wctx.switches.length, 1, 'hop 3 still switched');
      assert.equal(third.wctx.switches[0][0], workFile, 'hop 3 landed on the worktree\u2019s own recorded file');
      assert.deepEqual(third.wctx.sent, [], 'hop 3 sends no new notice');
      // Dual-side records after the resume: the destination keeps the resumed
      // file, and the source records the file just left.
      const lib = warpLib();
      const dest = lib.getWarpSession(root, target);
      assert.equal(dest.sessionFile, workFile, 'the destination still names the resumed file');
      const src = lib.getWarpSession(root, root);
      assert.equal(src.sessionFile, mainForkFile, 'the source side records the file just left');
    } finally {
      restoreEnv();
    }
  });
});

describe('S39/S43 pins (T29/T33)', { concurrency: false }, () => {
  function warpLib() {
    return require('../lib/worktree-warp-sessions.js');
  }

  function oscOff() {
    return { isTTY: false, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  }

  function staleBranchRow(root, staleBranch) {
    const registryLib = require('../lib/worktree-registry.js');
    const file = registryLib.registryPath(root);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.worktrees.length, 1, 'one registered row to stale');
    doc.worktrees[0].branch = staleBranch;
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  }

  test('warp shows the checkout CURRENT branch from git, never the stale row', async () => {
    const root = makeRepo('s39-branch');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/current-branch');
      staleBranchRow(root, 'feat/stale-branch');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, sent, switches } = makeWarpCtx({
        cwd: root, sessionFile, leaf: 'leaf-1', entries: [], sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-stale-branch', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      assert.equal(out.details.branch, 'feat/current-branch', 'S39: the CURRENT git branch wins over the stale row');
      assert.equal(out.details.name, 'feat-current-branch', 'S39: the name follows the current branch');
      assert.ok(out.text.includes('feat/current-branch'), `the agent text names the current branch: ${out.text}`);
      assert.ok(!out.text.includes('stale'), `no stale branch leaks: ${out.text}`);
      assert.equal(switches.length, 1, 'the session still switched');
      assert.equal(sent.length, 1, 'the first visit carries its single confirmation');
      // The refreshed CURRENT name stays warpable too (resolver live-slug
      // match) and resumes the same recorded session.
      calls.length = 0;
      const again = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const againOut = await mod.executeWorktreeWarp('feat-current-branch', again.ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(againOut.isError, undefined, `warp by the current name succeeds: ${againOut.text}`);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom'), [], 'the current name resumes, never forks');
      assert.equal(again.switches[0][0], switches[0][0], 'both names land on the same recorded session file');
    } finally {
      restoreEnv();
    }
  });

  test('warp to a checkout whose path is gone fails closed with no fork, no notice and no record', async () => {
    const root = makeRepo('s39-missing');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/gone');
      git(root, ['worktree', 'remove', '--force', target]);
      assert.equal(fs.existsSync(target), false, 'the checkout path is really gone');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const w = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-gone', w.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(out.isError, true, 'a missing target fails closed');
      assert.match(out.text, /no live checkout/, `actionable refusal names the cause: ${out.text}`);
      assert.match(out.text, /git worktree list/, `actionable refusal names the fix: ${out.text}`);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom'), [], 'S39: no fork for a missing target');
      assert.equal(w.switches.length, 0, 'S39: no switch for a missing target');
      assert.deepEqual(w.sent, [], 'S39: no notice for a missing target');
      assert.equal(fs.existsSync(warpLib().warpSessionsPath(root)), false, 'S39: no record written for a missing target');
    } finally {
      restoreEnv();
    }
  });

  test('warp to a path that is not a checkout of this repository fails closed', async () => {
    const root = makeRepo('s39-foreign');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const gone = addRegistered(root, 'feat/there');
      git(root, ['worktree', 'remove', '--force', gone]);
      const outside = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-s39-foreign-')));
      const registryLib = require('../lib/worktree-registry.js');
      const file = registryLib.registryPath(root);
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.worktrees[0].path = outside;
      fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const w = makeWarpCtx({
        cwd: root, sessionFile: sessionFileIn(), leaf: 'leaf-1', entries: [], sessionDir: os.tmpdir(), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-there', w.ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(out.isError, true, 'a foreign target fails closed');
      assert.match(out.text, /no live checkout/, `actionable refusal names the cause: ${out.text}`);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom'), [], 'S39: no fork for a foreign target');
      assert.equal(w.switches.length, 0, 'S39: no switch for a foreign target');
      assert.deepEqual(w.sent, [], 'S39: no notice for a foreign target');
      assert.equal(fs.existsSync(warpLib().warpSessionsPath(root)), false, 'S39: no record written for a foreign target');
    } finally {
      restoreEnv();
    }
  });

  test('first visit forks exactly once with exactly one confirmation', async () => {
    const root = makeRepo('s40-first');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/first-visit');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, sent, switches } = makeWarpCtx({
        cwd: root, sessionFile, leaf: 'leaf-1', entries: [], sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarp('feat-first-visit', ctx, { sessionManagerClass: FakeSM, oscStream: oscOff() });
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      assert.deepEqual(calls.filter((call) => call[0] === 'forkFrom').length, 1, 'S43: the first visit forks exactly once');
      assert.equal(switches.length, 1, 'the session really switched');
      assert.equal(sent.length, 1, 'S43: exactly one visible confirmation per real first move');
      assert.ok(warpLib().getWarpSession(root, target), 'the destination side is recorded');
      assert.ok(warpLib().getWarpSession(root, root), 'the source side is still recorded');
    } finally {
      restoreEnv();
    }
  });
});

describe('S43 point comparison + topmost identical ancestor (T33 RED)', { concurrency: false }, () => {
  // S43 rule for a warp from session S (in checkout X) to checkout Y:
  // already-there stays silent (R1); otherwise compare filtered points —
  // Y usable with an EQUAL point resumes R with no fork and no notice,
  // Y missing/unusable or with a DIFFERENT point forks. Every fork
  // branches from topmostIdentical(S): climb the parentSession chain
  // while the ancestor's filtered point equals S's, fork from the
  // highest such ancestor. All warps run through the public
  // `executeWorktreeWarp` harness; the session tree arrives through the
  // `warpSessionFileOpen` seam as open(file) -> {entries, parentSession}
  // shaped exactly like the real format (header parentSession + entries).
  function warpLib() {
    return require('../lib/worktree-warp-sessions.js');
  }

  function oscOff() {
    return { isTTY: false, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  }

  function treeOpen(tree) {
    return (file) => {
      const node = tree[file];
      if (!node) return null;
      return {
        entries: Array.isArray(node.entries) ? [...node.entries] : null,
        parentSession: node.parent !== undefined && node.parent !== null ? node.parent : null,
      };
    };
  }

  async function warpTo(name, { cwd, sessionFile, leaf, entries, sessionDir, calls, open }) {
    const FakeSM = makeFakeSM(calls, { sourceEntries: entries });
    const wctx = makeWarpCtx({ cwd, sessionFile, leaf, entries, sessionDir, calls });
    const { mod } = await loadExtension();
    const options = { sessionManagerClass: FakeSM, oscStream: oscOff() };
    if (open) options.warpSessionFileOpen = open;
    const out = await mod.executeWorktreeWarp(name, wctx.ctx, options);
    return { out, wctx };
  }

  function forksOf(calls) {
    return calls.filter((call) => call[0] === 'forkFrom');
  }

  // Shared opener: main -> worktree forks once (first visit), returning
  // the live fork file, its bookkeeping-carrying entries and the rename.
  async function openFirstFork(root, wtName, branch, calls) {
    const e1 = { id: 'e1', parentId: null, type: 'message' };
    const mainFile = sessionFileIn();
    const first = await warpTo(wtName, {
      cwd: root, sessionFile: mainFile, leaf: 'e1',
      entries: [e1], sessionDir: path.dirname(mainFile), calls,
    });
    assert.equal(first.out.isError, undefined, 'hop 1 succeeds: ' + first.out.text);
    assert.equal(forksOf(calls).length, 1, 'hop 1 forks once (first visit)');
    const forkFile = first.wctx.switches[0][0];
    const renames = calls.filter((call) => call[0] === 'appendSessionInfo');
    assert.equal(renames.length, 1, 'hop 1 renames once');
    const forkEntries = [e1,
      { id: 'm1', parentId: 'e1', type: 'custom', customType: 'worktree-warp', data: { from: root, to: branch } },
      { id: 's1', parentId: 'm1', type: 'session_info', name: renames[0][1] },
    ];
    return { e1, mainFile, forkFile, forkEntries };
  }

  test('untouched fork warping back to main resumes the original (no fork, no notice, no new file)', async () => {
    const root = makeRepo('s43-back');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/s43-back');
      const calls = [];
      const { e1, mainFile, forkFile, forkEntries } = await openFirstFork(root, 'feat-s43-back', target, calls);
      assert.equal(firstSent(calls), 1, 'hop 1 carries its single confirmation');
      const tree = {
        [forkFile]: { entries: forkEntries, parent: mainFile },
        [mainFile]: { entries: [e1], parent: null },
      };
      calls.length = 0;
      const before = fs.readdirSync(target).filter((f) => f.endsWith('.jsonl')).sort();
      const second = await warpTo('principal', {
        cwd: target, sessionFile: forkFile, leaf: 's1',
        entries: forkEntries, sessionDir: path.dirname(forkFile), calls, open: treeOpen(tree),
      });
      assert.equal(second.out.isError, undefined, 'hop 2 succeeds: ' + second.out.text);
      assert.deepEqual(forksOf(calls), [], 'identical points resume: no new fork');
      assert.equal(second.wctx.switches[0][0], mainFile, 'the way back lands on the exact original file');
      assert.deepEqual(second.wctx.sent, [], 'resuming sends no second notice');
      assert.deepEqual(fs.readdirSync(target).filter((f) => f.endsWith('.jsonl')).sort(), before, 'no new session file in the checkout');
    } finally {
      restoreEnv();
    }
  });

  test('untouched fork warping to a second worktree forks from the original: siblings', async () => {
    const root = makeRepo('s43-sibling');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const first = addRegistered(root, 'feat/s43-first');
      const second = addRegistered(root, 'feat/s43-second');
      const calls = [];
      const { e1, mainFile, forkFile, forkEntries } = await openFirstFork(root, 'feat-s43-first', first, calls);
      const tree = {
        [forkFile]: { entries: forkEntries, parent: mainFile },
        [mainFile]: { entries: [e1], parent: null },
      };
      calls.length = 0;
      const hop = await warpTo('feat-s43-second', {
        cwd: first, sessionFile: forkFile, leaf: 's1',
        entries: forkEntries, sessionDir: path.dirname(forkFile), calls, open: treeOpen(tree),
      });
      assert.equal(hop.out.isError, undefined, 'hop to the second worktree succeeds: ' + hop.out.text);
      const forks = forksOf(calls);
      assert.equal(forks.length, 1, 'one fork for the unvisited checkout');
      assert.equal(forks[0][1], mainFile, 'the sibling forks from the ORIGINAL, not from the untouched fork');
      assert.equal(hop.wctx.sent.length, 1, 'the real move carries its single confirmation');
      assert.equal(hop.wctx.switches.length, 1, 'the session really switched');
      void second;
    } finally {
      restoreEnv();
    }
  });

  test('an advanced session forks its own child, to main or to another worktree', async () => {
    const root = makeRepo('s43-advanced');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const wt = addRegistered(root, 'feat/s43-adv');
      const other = addRegistered(root, 'feat/s43-other');
      const calls = [];
      const { e1, mainFile, forkFile, forkEntries } = await openFirstFork(root, 'feat-s43-adv', wt, calls);
      void forkEntries;
      // Real work in the fork: a new entry the bookkeeping filter keeps.
      const e2 = { id: 'e2', parentId: 'e1', type: 'message' };
      const advanced = [e1, e2];
      const tree = {
        [forkFile]: { entries: advanced, parent: mainFile },
        [mainFile]: { entries: [e1], parent: null },
      };
      // To main: the points differ, so fork with the advanced session as parent.
      calls.length = 0;
      const toMain = await warpTo('principal', {
        cwd: wt, sessionFile: forkFile, leaf: 'e2',
        entries: advanced, sessionDir: path.dirname(forkFile), calls, open: treeOpen(tree),
      });
      assert.equal(toMain.out.isError, undefined, 'warp to main succeeds: ' + toMain.out.text);
      const mainForks = forksOf(calls);
      assert.equal(mainForks.length, 1, 'different points fork instead of resuming');
      assert.equal(mainForks[0][1], forkFile, 'the fork branches from the advanced session itself');
      assert.notEqual(toMain.wctx.switches[0][0], mainFile, 'the switch lands on a new file, not the original');
      assert.equal(toMain.wctx.sent.length, 1, 'the real move carries its single confirmation');
      // To another worktree: the same rule, the same parent.
      calls.length = 0;
      const toOther = await warpTo('feat-s43-other', {
        cwd: wt, sessionFile: forkFile, leaf: 'e2',
        entries: advanced, sessionDir: path.dirname(forkFile), calls, open: treeOpen(tree),
      });
      assert.equal(toOther.out.isError, undefined, 'warp to another worktree succeeds: ' + toOther.out.text);
      const otherForks = forksOf(calls);
      assert.equal(otherForks.length, 1, 'different points fork instead of resuming');
      assert.equal(otherForks[0][1], forkFile, 'the fork branches from the advanced session itself');
      assert.equal(toOther.wctx.sent.length, 1, 'the real move carries its single confirmation');
      void other;
    } finally {
      restoreEnv();
    }
  });

  test('a checkout with no record forks', async () => {
    const root = makeRepo('s43-first-visit');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/s43-fresh');
      assert.equal(warpLib().getWarpSession(root, target), null, 'no record exists yet');
      const calls = [];
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      const sessionFile = sessionFileIn();
      const out = await warpTo('feat-s43-fresh', {
        cwd: root, sessionFile, leaf: 'e1',
        entries: [e1], sessionDir: path.dirname(sessionFile), calls,
        open: treeOpen({ [sessionFile]: { entries: [e1], parent: null } }),
      });
      assert.equal(out.out.isError, undefined, 'expected success: ' + out.out.text);
      assert.equal(forksOf(calls).length, 1, 'no record forks exactly once');
      assert.equal(out.wctx.switches.length, 1, 'the session really switched');
      assert.equal(out.wctx.sent.length, 1, 'the first visit carries its single confirmation');
      assert.ok(warpLib().getWarpSession(root, target), 'the destination side is recorded');
    } finally {
      restoreEnv();
    }
  });

  test('a missing parent file falls back to the last good file without throwing', async () => {
    const root = makeRepo('s43-missing-parent');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/s43-orphan');
      const calls = [];
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      const current = '/fake/s43-missing-current.jsonl';
      const tree = { [current]: { entries: [e1], parent: '/fake/s43-gone.jsonl' } };
      const hop = await warpTo('feat-s43-orphan', {
        cwd: root, sessionFile: current, leaf: 'e1',
        entries: [e1], sessionDir: '/fake', calls, open: treeOpen(tree),
      });
      assert.equal(hop.out.isError, undefined, 'expected success: ' + hop.out.text);
      const forks = forksOf(calls);
      assert.equal(forks.length, 1, 'the unvisited checkout forks once');
      assert.equal(forks[0][1], current, 'an unreadable parent keeps the last good file');
    } finally {
      restoreEnv();
    }
  });

  test('a cyclic chain falls back to the last good file without throwing', async () => {
    const root = makeRepo('s43-cycle');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/s43-loop');
      const calls = [];
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      const current = '/fake/s43-cycle-current.jsonl';
      const other = '/fake/s43-cycle-other.jsonl';
      const tree = {
        [current]: { entries: [e1], parent: other },
        [other]: { entries: [e1], parent: current },
      };
      const hop = await warpTo('feat-s43-loop', {
        cwd: root, sessionFile: current, leaf: 'e1',
        entries: [e1], sessionDir: '/fake', calls, open: treeOpen(tree),
      });
      assert.equal(hop.out.isError, undefined, 'expected success: ' + hop.out.text);
      const forks = forksOf(calls);
      assert.equal(forks.length, 1, 'the unvisited checkout forks once');
      assert.equal(forks[0][1], other, 'the cycle stops at the last good identical ancestor');
    } finally {
      restoreEnv();
    }
  });

  test('the depth cap falls back to the last good file without throwing', async () => {
    const root = makeRepo('s43-depth');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/s43-deep');
      const calls = [];
      const e1 = { id: 'e1', parentId: null, type: 'message' };
      const lib = warpLib();
      const cap = lib.WARP_ANCESTOR_MAX_DEPTH;
      assert.ok(Number.isFinite(cap) && cap > 0 && cap <= 100, 'the climb is bounded by a small documented constant: ' + cap);
      // A chain far longer than the cap, every link at the same point.
      const files = [];
      for (let i = 0; i <= cap + 5; i += 1) files.push(`/fake/s43-deep-${i}.jsonl`);
      const tree = {};
      for (let i = 0; i < files.length; i += 1) {
        tree[files[i]] = { entries: [e1], parent: i + 1 < files.length ? files[i + 1] : null };
      }
      const hop = await warpTo('feat-s43-deep', {
        cwd: root, sessionFile: files[0], leaf: 'e1',
        entries: [e1], sessionDir: '/fake', calls, open: treeOpen(tree),
      });
      assert.equal(hop.out.isError, undefined, 'expected success: ' + hop.out.text);
      const forks = forksOf(calls);
      assert.equal(forks.length, 1, 'the unvisited checkout forks once');
      assert.equal(forks[0][1], files[cap], 'the climb stops at the depth cap with the last good file');
    } finally {
      restoreEnv();
    }
  });

  function firstSent(calls) {
    return calls.filter((call) => call[0] === 'appendCustomEntry').length;
  }
});

describe('S45 warp create: change type first, then change name (T35 RED)', { concurrency: false }, () => {
  // The final selector entry (S44/S45): visually distinct from the
  // `<name> — <path>` checkout rows (plain action text with an ellipsis,
  // no em-dash path shape) and always last. S47 drops the old `+ `
  // prefix (it misaligned against the checkout rows); there is
  // deliberately NO separator row above it — the host selector takes a
  // plain string array where every row is selectable, so a fake blank
  // row would itself be pickable. S45 turns the entry into TWO steps —
  // the change TYPE first (single select over the branch-pr skill's types),
  // then the change NAME (text input) — deriving branch `<type>/<slug>`
  // and checkout `<type>-<slug>` from the pair.
  const CREATE_ENTRY = 'Create new worktree…';
  // The pinned type list (skills/branch-pr/SKILL.md): skill order, human
  // labels, `feat` first so the initial highlight lands on it. Eleven
  // data rows only: no selectable Back or Confirm row anywhere — Tab
  // alone goes back, Enter confirms, Esc cancels.
  const TYPE_TITLE = 'New worktree change type';
  const TYPE_OPTIONS = [
    'Feature (feat)',
    'Bug fix (fix)',
    'Chore (chore)',
    'Docs (docs)',
    'Style (style)',
    'Refactor (refactor)',
    'Performance (perf)',
    'Test (test)',
    'Build (build)',
    'CI (ci)',
    'Revert (revert)',
  ];
  const NAME_TITLE = 'New worktree change name';
  const NAME_PLACEHOLDER = 'name-change';

  // Minimal herdr stub: only `worktree create` is exercised here (fresh
  // branches through the herdr-first path); anything else fails loudly.
  function makeHerdrCreateStub() {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-warp-create-herdr-')));
    const bin = path.join(dir, 'herdr');
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "worktree" ] && [ "$2" = "create" ]; then',
      '  shift 2',
      '  branch=""; base=""; wtpath=""; cwd=""',
      '  while [ $# -gt 0 ]; do',
      '    case "$1" in',
      '      --branch) branch="$2"; shift 2;;',
      '      --base) base="$2"; shift 2;;',
      '      --path) wtpath="$2"; shift 2;;',
      '      --cwd) cwd="$2"; shift 2;;',
      '      *) shift;;',
      '    esac',
      '  done',
      '  [ -n "$branch" ] && [ -n "$wtpath" ] && [ -n "$cwd" ] || { echo "missing args" >&2; exit 1; }',
      '  exec git -C "$cwd" worktree add -b "$branch" "$wtpath" "$base"',
      'fi',
      'echo "herdr stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    return bin;
  }

  // The agreed sibling layout (lib/worktree-git.js worktreePath).
  function siblingTarget(root, slug) {
    return path.join(path.dirname(root), `${path.basename(root)}-worktrees`, slug);
  }

  function createEnv(herdrBin) {
    return {
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: scratchModeEnv().GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdrBin,
      GENTLE_WORKTREE_THREAD: 'warp-create-thread',
    };
  }

  function registryLib() {
    return require('../lib/worktree-registry.js');
  }

  function snapshotRegistry(root) {
    return registryLib().readRegistry(root);
  }

  function pickLast(title, options) {
    return options[options.length - 1];
  }

  // Run the no-argument warp with the selector answering `answer`. When
  // `hasTypeAsker` the injectable type-prompt seam answers `typeValue`
  // (and counts its calls); when `hasAsker` the injectable name-prompt
  // seam answers `askerValue` (and counts its calls); when `inputStub` is
  // set it rides on ctx.ui.input (the real default path). With neither
  // type seam nor input stub the real `ctx.ui.select`/`ctx.ui.input`
  // answer, routed by the `answer` function.
  async function runSelector({ root, answer, hasAsker = false, askerValue, hasTypeAsker = false, typeValue, inputStub = null }) {
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const sessionFile = sessionFileIn();
    const built = makeSelectorCtx({
      cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      selectImpl: answer,
    });
    if (inputStub !== null) built.ctx.ui.input = inputStub;
    const { commands, mod } = await loadExtension();
    let promptCount = 0;
    let typeCount = 0;
    if (hasTypeAsker) {
      assert.equal(typeof mod.setWarpCreateTypeAsker, 'function', 'S45 injectable type-prompt seam');
      mod.setWarpCreateTypeAsker(async () => { typeCount += 1; return typeValue; });
    }
    if (hasAsker) {
      assert.equal(typeof mod.setWarpCreateNameAsker, 'function', 'S45 injectable name-prompt seam');
      mod.setWarpCreateNameAsker(async () => { promptCount += 1; return askerValue; });
    }
    await warpDef(commands).handler('', built.ctx);
    return { ...built, calls, mod, sessionFile, promptCount: () => promptCount, typeCount: () => typeCount };
  }

  test('the selector ends with a visually distinct create entry; Esc asks nothing', async () => {
    const root = makeRepo('s45-entry');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    try {
      const first = addRegistered(root, 'feat/first');
      const before = snapshotRegistry(root);
      const r = await runSelector({ root, answer: undefined, hasTypeAsker: true, typeValue: 'unused', hasAsker: true, askerValue: 'unused' });
      assert.equal(r.selects.length, 1, 'the selector opened');
      const [title, options] = r.selects[0];
      assert.equal(title, `Warp session · current: principal ${root}`);
      assert.deepEqual(options, [`feat-first — ${first}`, CREATE_ENTRY]);
      assert.equal(CREATE_ENTRY, 'Create new worktree…', 'S47: no `+` prefix — it misaligned against the checkout rows');
      assert.ok(!options.some((o) => o.trim() === ''), 'S47: no separator row — the host has no non-selectable row, so every option is a real pick');
      assert.equal(r.typeCount(), 0, 'Esc never asks for a type');
      assert.equal(r.promptCount(), 0, 'Esc never asks for a name');
      assert.deepEqual(r.notes, [], 'Esc notifies nothing');
      assert.deepEqual(r.calls, [], 'no fork');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('the type step lists the branch-pr types in order with feat first, over the real selector; a Feature named name-change becomes feat/name-change in feat-name-change', async () => {
    const root = makeRepo('s45-feat');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    const target = siblingTarget(root, 'feat-name-change');
    track(target);
    try {
      const first = addRegistered(root, 'feat/first');
      assert.ok(first.length > 0);
      // No type seam: the real ctx.ui.select answers — checkout selector
      // takes the last option (the create entry), the type prompt the
      // first (feat). The name seam answers the change name.
      const r = await runSelector({
        root,
        answer: (title, options) => (title.startsWith('Warp session') ? options[options.length - 1] : options[0]),
        hasAsker: true,
        askerValue: 'name-change',
      });
      assert.equal(r.selects.length, 2, 'the checkout selector plus exactly one type prompt');
      assert.deepEqual(r.selects[1], [TYPE_TITLE, TYPE_OPTIONS], 'the pinned type list in skill order, feat first');
      assert.equal(r.typeCount(), 0, 'the seam stayed out: the real selector answered');
      assert.equal(r.promptCount(), 1, 'the name prompt was asked exactly once');
      // Registered exactly as the create tool does it: branch
      // feat/name-change in the agreed sibling path layout, empty issues,
      // no odd.
      const entry = registryLib().findByBranch(root, 'feat/name-change');
      assert.ok(entry, 'the new checkout is registered');
      assert.equal(entry.path, target);
      assert.deepEqual(entry.issues, []);
      assert.deepEqual(entry.odd || [], []);
      assert.equal(fs.realpathSync(target), fs.realpathSync(entry.path), 'the checkout really exists there');
      // Warped into the brand-new checkout: a fork (a fresh checkout has
      // no session yet) and exactly one visible confirmation.
      assert.equal(r.waited.length, 1, 'the warp waited for idle');
      assert.equal(r.switches.length, 1, 'the session really switched');
      assert.equal(r.calls[0][0], 'forkFrom', 'the warp forked the session');
      assert.equal(r.calls[0][2], fs.realpathSync(target), 'the fork landed in the new checkout');
      assert.deepEqual(r.notes, [], 'the card is the only visible confirmation');
      assert.equal(r.sent.length, 1, 'exactly one confirmation');
      assert.equal(r.sent[0][0].customType, 'worktree-warp', 'the confirmation carries the card key');
    } finally {
      restoreEnv();
    }
  });

  test('a fix type derives fix/<slug> and the fix-<slug> checkout', async () => {
    const root = makeRepo('s45-fix');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    const target = siblingTarget(root, 'fix-crash-on-empty');
    track(target);
    try {
      addRegistered(root, 'feat/first');
      // The seam answers the picked option string, as the real selector
      // would return it; the flow resolves it to the fix type.
      const r = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: 'Bug fix (fix)', hasAsker: true, askerValue: 'crash-on-empty' });
      assert.equal(r.typeCount(), 1, 'the type prompt was asked exactly once');
      assert.equal(r.promptCount(), 1, 'the name prompt was asked exactly once');
      const entry = registryLib().findByBranch(root, 'fix/crash-on-empty');
      assert.ok(entry, 'branch fix/crash-on-empty is registered');
      assert.equal(entry.path, target, 'checkout directory fix-crash-on-empty');
      assert.deepEqual(entry.issues, []);
      assert.deepEqual(entry.odd || [], []);
      assert.equal(r.switches.length, 1, 'the session really switched');
      assert.equal(r.calls[0][0], 'forkFrom', 'the warp forked the session');
      assert.equal(r.calls[0][2], fs.realpathSync(target), 'the fork landed in the new checkout');
      assert.deepEqual(r.notes, [], 'the card is the only visible confirmation');
      assert.equal(r.sent.length, 1, 'exactly one confirmation');
    } finally {
      restoreEnv();
    }
  });

  test('without the seams both steps use the real host prompts exactly once, slugging the name', async () => {
    const root = makeRepo('s45-input');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    const target = siblingTarget(root, 'fix-crash-on-empty');
    track(target);
    try {
      addRegistered(root, 'feat/first');
      const inputCalls = [];
      const r = await runSelector({
        root,
        answer: (title, options) => (title.startsWith('Warp session') ? options[options.length - 1] : options[1]),
        inputStub: async (title, placeholder) => {
          inputCalls.push([title, placeholder]);
          return 'crash on empty';
        },
      });
      assert.equal(r.selects.length, 2, 'the checkout selector plus exactly one type prompt');
      assert.deepEqual(r.selects[1], [TYPE_TITLE, TYPE_OPTIONS], 'the real selector carried the pinned type list');
      assert.deepEqual(inputCalls, [[NAME_TITLE, NAME_PLACEHOLDER]], 'the real text prompt, used exactly once');
      const entry = registryLib().findByBranch(root, 'fix/crash-on-empty');
      assert.ok(entry, 'the spaced name slugged to fix/crash-on-empty');
      assert.equal(entry.path, target);
      assert.equal(r.switches.length, 1, 'the session really switched');
      assert.equal(r.sent.length, 1, 'exactly one confirmation');
      assert.deepEqual(r.notes, [], 'the card is the only visible confirmation');
    } finally {
      restoreEnv();
    }
  });

  test('cancelling at the type step changes nothing and never asks for a name', async () => {
    const root = makeRepo('s45-cancel-type');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    try {
      addRegistered(root, 'feat/first');
      const before = snapshotRegistry(root);
      const r = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: undefined, hasAsker: true, askerValue: 'unused' });
      assert.equal(r.typeCount(), 1, 'the type prompt was asked, then cancelled');
      assert.equal(r.promptCount(), 0, 'the name prompt never opened');
      assert.deepEqual(r.notes, [], 'cancel notifies nothing');
      assert.deepEqual(r.calls, [], 'no fork');
      assert.deepEqual(r.switches, [], 'no session switch');
      assert.deepEqual(r.sent, [], 'no confirmation');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('cancelling at the name step changes nothing', async () => {
    const root = makeRepo('s45-cancel-name');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    try {
      addRegistered(root, 'feat/first');
      const before = snapshotRegistry(root);
      const r = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: 'feat', hasAsker: true, askerValue: undefined });
      assert.equal(r.typeCount(), 1, 'the type was picked');
      assert.equal(r.promptCount(), 1, 'the name prompt was asked, then cancelled');
      assert.deepEqual(r.notes, [], 'cancel notifies nothing');
      assert.deepEqual(r.calls, [], 'no fork');
      assert.deepEqual(r.switches, [], 'no session switch');
      assert.deepEqual(r.sent, [], 'no confirmation');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('the type step offers eleven data rows only; a Tab Back returns quietly with no writes', async () => {
    const root = makeRepo('s45-typeback');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    try {
      addRegistered(root, 'feat/first');
      const before = snapshotRegistry(root);
      // No seams and no custom UI: the fallback selector carries the
      // eleven data rows with no selectable Back row.
      const r = await runSelector({
        root,
        answer: (title, options) => options[options.length - 1],
      });
      assert.equal(r.selects.length, 2, 'the checkout selector plus exactly one type prompt');
      assert.equal(r.selects[1][1].length, 11, 'eleven data rows only');
      assert.ok(!r.selects[1][1].some((o) => String(o).includes('Back')), 'no selectable Back row anywhere');
      // The seam Back (the inline Tab path) exits quietly with no writes.
      const back = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: { back: true }, hasAsker: true, askerValue: 'unused' });
      assert.deepEqual(back.notes, [], 'Back notifies nothing');
      assert.deepEqual(back.calls, [], 'no fork');
      assert.deepEqual(back.switches, [], 'no session switch');
      assert.deepEqual(back.sent, [], 'no confirmation');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('an unknown change type refuses with an actionable message and creates nothing', async () => {
    const root = makeRepo('s45-badtype');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    try {
      addRegistered(root, 'feat/first');
      const before = snapshotRegistry(root);
      const r = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: 'nope', hasAsker: true, askerValue: 'unused' });
      assert.equal(r.typeCount(), 1, 'the type prompt was asked exactly once');
      assert.equal(r.promptCount(), 0, 'the name prompt never opened');
      assert.equal(r.notes.length, 1, 'exactly one refusal');
      assert.equal(r.notes[0][0], 'warp: unknown change type "nope"; nothing was created.');
      assert.equal(r.notes[0][1], 'error');
      assert.deepEqual(r.calls, [], 'no fork');
      assert.deepEqual(r.switches, [], 'no session switch');
      assert.deepEqual(r.sent, [], 'no confirmation');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('an empty name refuses with an actionable message and creates nothing', async () => {
    const root = makeRepo('s45-empty');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    try {
      addRegistered(root, 'feat/first');
      const before = snapshotRegistry(root);
      const r = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: 'feat', hasAsker: true, askerValue: '   ' });
      assert.equal(r.typeCount(), 1, 'the type was picked');
      assert.equal(r.promptCount(), 1, 'the name prompt was asked exactly once');
      assert.equal(r.notes.length, 1, 'exactly one refusal');
      assert.equal(r.notes[0][0], 'warp: invalid change name "   ": use at least one letter or digit (for example "name-change"); nothing was created.');
      assert.equal(r.notes[0][1], 'error');
      assert.deepEqual(r.calls, [], 'no fork');
      assert.deepEqual(r.switches, [], 'no session switch');
      assert.deepEqual(r.sent, [], 'no confirmation');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('a name with no representable slug refuses the same way and creates nothing', async () => {
    const root = makeRepo('s45-noslug');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    try {
      addRegistered(root, 'feat/first');
      const before = snapshotRegistry(root);
      const r = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: 'fix', hasAsker: true, askerValue: '!!!' });
      assert.equal(r.promptCount(), 1, 'the name prompt was asked exactly once');
      assert.equal(r.notes.length, 1, 'exactly one refusal');
      assert.equal(r.notes[0][0], 'warp: invalid change name "!!!": use at least one letter or digit (for example "name-change"); nothing was created.');
      assert.equal(r.notes[0][1], 'error');
      assert.deepEqual(r.calls, [], 'no fork');
      assert.deepEqual(r.switches, [], 'no session switch');
      assert.deepEqual(r.sent, [], 'no confirmation');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('a duplicate branch refuses byte-identical with the create path and creates nothing', async () => {
    const root = makeRepo('s45-dup');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    try {
      addRegistered(root, 'feat/first');
      addRegistered(root, 'feat/dup');
      const before = snapshotRegistry(root);
      // The pair derives the already-taken branch, which the SHARED
      // create path refuses: the refusal below is its text, not a copy.
      const r = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: 'feat', hasAsker: true, askerValue: 'dup' });
      assert.equal(r.typeCount(), 1, 'the type was picked');
      assert.equal(r.promptCount(), 1, 'the name prompt was asked exactly once');
      const direct = await r.mod.executeWorktreeCreate({ branch: 'feat/dup' }, { cwd: root });
      assert.ok(direct.isError, 'the create tool refuses the duplicate too');
      assert.equal(r.notes.length, 1, 'exactly one refusal');
      assert.equal(r.notes[0][0], direct.text, 'byte-identical to the create tool refusal');
      assert.deepEqual(r.calls, [], 'no fork');
      assert.deepEqual(r.switches, [], 'no session switch');
      assert.deepEqual(r.sent, [], 'no confirmation');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('an occupied target refuses byte-identical with no state change', async () => {
    const root = makeRepo('s45-occupied');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    const target = siblingTarget(root, 'feat-occ');
    track(target);
    try {
      addRegistered(root, 'feat/first');
      fs.mkdirSync(target, { recursive: true });
      const before = snapshotRegistry(root);
      const r = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: 'feat', hasAsker: true, askerValue: 'occ' });
      assert.equal(r.promptCount(), 1, 'the name prompt was asked exactly once');
      const direct = await r.mod.executeWorktreeCreate({ branch: 'feat/occ' }, { cwd: root });
      assert.ok(direct.isError, 'the create tool refuses the occupied target too');
      assert.equal(r.notes.length, 1, 'exactly one refusal');
      assert.equal(r.notes[0][0], direct.text, 'byte-identical to the create tool refusal');
      assert.deepEqual(fs.readdirSync(target), [], 'the occupant is untouched');
      assert.deepEqual(r.calls, [], 'no fork');
      assert.deepEqual(r.switches, [], 'no session switch');
      assert.deepEqual(r.sent, [], 'no confirmation');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('without a text prompt the command fails with an actionable message and changes nothing', async () => {
    const root = makeRepo('s45-noprompt');
    const herdrBin = makeHerdrCreateStub();
    setEnv(createEnv(herdrBin));
    try {
      addRegistered(root, 'feat/first');
      const before = snapshotRegistry(root);
      // Type seam answers, but no name seam and no ctx.ui.input: the host
      // truly has no text prompt.
      const r = await runSelector({ root, answer: pickLast, hasTypeAsker: true, typeValue: 'feat' });
      assert.equal(r.selects.length, 1, 'the selector opened');
      assert.equal(r.notes.length, 1, 'exactly one refusal');
      assert.equal(
        r.notes[0][0],
        'warp: the host UI cannot ask for a change name here (no text input); create one with the worktree_create tool first, then /herdr-gentle:warp <name>.',
      );
      assert.deepEqual(r.calls, [], 'no fork');
      assert.deepEqual(r.switches, [], 'no session switch');
      assert.deepEqual(r.sent, [], 'no confirmation');
      assert.deepEqual(snapshotRegistry(root), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_warp agent tool (T40/S49)', { concurrency: false }, () => {
  // The warp exists only as the /herdr-gentle:warp command and the agent
  // has no exposed warp tool, so this one is built FOR agent use: a
  // required name-or-path, no selector, no waitForIdle (self-deadlock),
  // switch through withSession emitting the S42 card plus a continuation
  // turn (triggerTurn:true, deliverAs:followUp).
  function warpTool(tools) {
    const tool = tools.get('worktree_warp');
    assert.ok(tool, 'expected worktree_warp to be registered');
    return tool;
  }

  function toolText(result) {
    return (result.content || []).map((part) => part.text || '').join('\n');
  }

  // Tool context: selectors are human-only, so no ui.select exists here.
  // waitForIdle is provided only as a spy the tool must never call.
  function makeToolCtx({ cwd, FakeSM, sessionFile, entries = [], switchResult = { cancelled: false }, calls }) {
    const waited = [];
    const switches = [];
    const sent = [];
    const sm = new FakeSM();
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
      getLeafId: () => 'leaf-1',
      getEntries: () => entries,
      getSessionDir: () => path.dirname(sessionFile),
    });
    const ctx = {
      cwd,
      sessionManager: sm,
      ui: { notify: () => {}, setStatus: () => {} },
      waitForIdle: async () => { waited.push(true); },
      switchSession: async (file, options) => {
        switches.push([file, typeof options?.withSession]);
        if (switchResult && switchResult.cancelled === true) return switchResult;
        if (typeof options?.withSession === 'function') {
          const replaced = {
            ui: { setStatus: () => {} },
            sendMessage: async (message, sendOptions) => { sent.push([message, sendOptions]); },
          };
          await options.withSession(replaced);
        }
        return switchResult;
      },
    };
    return { ctx, waited, switches, sent };
  }

  test('registers worktree_warp only when the worktree switch is on', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib().writeMode(true, process.env);
      const on = await loadExtension();
      assert.deepEqual(
        [...on.tools.keys()].sort(),
        ['worktree_close', 'worktree_create', 'worktree_list', 'worktree_session_open', 'worktree_warp'].sort(),
        'enabled registers all five tools including the agent warp',
      );
      modeLib().writeMode(false, process.env);
      const off = await loadExtension();
      assert.deepEqual([...off.tools.keys()], [], 'disabled registers no worktree tool at all');
    } finally {
      restoreEnv();
    }
  });

  test('warps by name without selectors or idle waits, then continues the turn', async () => {
    const root = makeRepo('wtool-move');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/agent-move');
      const { tools } = await loadExtension();
      const tool = warpTool(tools);
      const calls = [];
      const FakeSM = makeFakeSM(calls, { sourceEntries: [] });
      const sessionFile = sessionFileIn();
      const { ctx, waited, switches, sent } = makeToolCtx({ cwd: root, FakeSM, sessionFile, calls });
      const out = await tool.execute('call-1', { name: 'feat-agent-move' }, undefined, undefined, ctx);
      assert.equal(out.isError, undefined, `expected success: ${toolText(out)}`);
      assert.deepEqual(waited, [], 'the tool NEVER awaits waitForIdle (self-deadlock)');
      assert.equal(switches.length, 1, 'exactly one session switch');
      assert.equal(switches[0][1], 'function', 'the switch carries withSession');
      assert.ok(toolText(out).includes('feat-agent-move'), 'the result names the checkout');
      assert.ok(toolText(out).includes('feat/agent-move'), 'the result names the branch');
      const continued = sent.filter(([, opts]) => opts && opts.triggerTurn === true);
      assert.equal(continued.length, 1, 'exactly one continuation turn is requested');
      assert.equal(continued[0][1].deliverAs, 'followUp', 'the continuation is a followUp');
      const content = JSON.stringify(continued[0][0]);
      assert.ok(!content.includes('Revalidate every cwd-dependent path'), 'the continuation carries no filler');
      assert.ok(content.includes('feat-agent-move') || content.includes(target), 'the continuation says where the session now is');
      assert.match(content, /continue/i, 'the continuation tells the agent to continue');
    } finally {
      restoreEnv();
    }
  });

  test('a missing name refuses listing the available checkouts and switches nothing', async () => {
    const root = makeRepo('wtool-noname');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/listed');
      const { tools } = await loadExtension();
      const tool = warpTool(tools);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, waited, switches, sent } = makeToolCtx({ cwd: root, FakeSM, sessionFile, calls });
      const out = await tool.execute('call-1', {}, undefined, undefined, ctx);
      assert.equal(out.isError, true, 'a missing name is a refusal');
      assert.ok(toolText(out).includes('feat-listed'), 'the refusal lists the available checkout');
      assert.ok(toolText(out).includes(target), 'the refusal lists the checkout path');
      assert.deepEqual(waited, [], 'no idle wait on refusal');
      assert.deepEqual(switches, [], 'no session switch on refusal');
      assert.deepEqual(sent, [], 'no continuation on refusal');
    } finally {
      restoreEnv();
    }
  });

  test('an unknown name refuses listing the available checkouts and writes nothing', async () => {
    const root = makeRepo('wtool-unknown');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/known');
      const before = JSON.stringify(require('../lib/worktree-registry.js').readRegistry(root));
      const { tools } = await loadExtension();
      const tool = warpTool(tools);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { ctx, switches, sent } = makeToolCtx({ cwd: root, FakeSM, sessionFile, calls });
      const out = await tool.execute('call-1', { name: 'no-such-checkout' }, undefined, undefined, ctx);
      assert.equal(out.isError, true, 'an unknown name fails closed');
      assert.ok(toolText(out).includes('feat-known'), 'the refusal lists the available checkout');
      assert.deepEqual(switches, [], 'no session switch');
      assert.deepEqual(sent, [], 'no continuation');
      assert.equal(JSON.stringify(require('../lib/worktree-registry.js').readRegistry(root)), before, 'the registry is untouched');
    } finally {
      restoreEnv();
    }
  });

  test('a checkout path resolves after its name (name first, then path)', async () => {
    const root = makeRepo('wtool-path');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/by-path');
      const { tools } = await loadExtension();
      const tool = warpTool(tools);
      const calls = [];
      const FakeSM = makeFakeSM(calls, { sourceEntries: [] });
      const sessionFile = sessionFileIn();
      const { ctx, switches } = makeToolCtx({ cwd: root, FakeSM, sessionFile, calls });
      const out = await tool.execute('call-1', { name: target }, undefined, undefined, ctx);
      assert.equal(out.isError, undefined, `a live checkout path warps: ${toolText(out)}`);
      assert.equal(switches.length, 1, 'exactly one session switch');
    } finally {
      restoreEnv();
    }
  });

  test('an already-there target returns without switching', async () => {
    const root = makeRepo('wtool-there');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/stay');
      const { tools } = await loadExtension();
      const tool = warpTool(tools);
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const target = fs.realpathSync(path.join(path.dirname(root), `${path.basename(root)}-cwarp-feat-stay`));
      const { ctx, switches, sent } = makeToolCtx({ cwd: target, FakeSM, sessionFile, calls });
      const out = await tool.execute('call-1', { name: 'feat-stay' }, undefined, undefined, ctx);
      assert.ok(toolText(out).includes('already there'), 'the already-there text reports itself');
      assert.deepEqual(switches, [], 'no session switch when already there');
      assert.deepEqual(sent, [], 'no continuation when already there');
    } finally {
      restoreEnv();
    }
  });

  test('the tool card keeps the S42 shape: names only compact, path and branch expanded', () => {
    const card = require('../lib/worktree-card.js').createWorktreeCardRenderer('worktree_warp');
    assert.equal(card.renderShell, 'self', 'the warp tool renders through the tool-card contract');
    const result = {
      content: [{ type: 'text', text: 'moved: principal\nto: feat-target\npath: now in "/tmp/feat-target"\nbranch: now in "feat/target"' }],
      details: { fromName: 'principal', fromDesc: 'principal \u00b7 main', name: 'feat-target', branch: 'feat/target', path: '/tmp/feat-target', to: '/tmp/feat-target' },
    };
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const strip = (line) => String(line).replace(/\x1b\[[0-9;]*m/g, '');
    const compact = card.renderResult(result, {}, theme, {}).render(100).map(strip).join('\n');
    assert.ok(compact.includes('moved: principal'), 'compact names the source checkout');
    assert.ok(compact.includes('to: feat-target'), 'compact names the target checkout');
    assert.ok(!compact.includes('feat/target'), 'compact carries no branch');
    assert.ok(!compact.includes('/tmp/feat-target'), 'compact carries no path');
    const expanded = card.renderResult(result, { expanded: true }, theme, {}).render(100).map(strip).join('\n');
    assert.ok(expanded.includes('path: now in "/tmp/feat-target"'), 'expanded names the current path');
    assert.ok(expanded.includes('branch: now in "feat/target"'), 'expanded names the current branch');
  });

  test('the command path still awaits idle exactly once per warp', async () => {
    const root = makeRepo('wtool-cmdidle');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/cmd-idle');
      const { mod } = await loadExtension();
      const calls = [];
      const FakeSM = makeFakeSM(calls, { sourceEntries: [] });
      const sessionFile = sessionFileIn();
      const { ctx, waited, switches } = makeWarpCtx({ cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls });
      ctx.sessionManager = Object.assign(new FakeSM(), {
        getSessionFile: () => sessionFile,
        getLeafId: () => 'leaf-1',
        getEntries: () => [],
        getSessionDir: () => path.dirname(sessionFile),
      });
      const out = await mod.executeWorktreeWarp('feat-cmd-idle', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      assert.equal(waited.length, 1, 'the command awaits waitForIdle exactly once');
      assert.equal(switches.length, 1, 'the command switches once');
    } finally {
      restoreEnv();
    }
  });
});

describe('warp selector Ctrl+D delete (human selector)', { concurrency: false }, () => {
  const pickerLib = require('../lib/warp-create-picker.js');
  function makeDeleteCtx({ cwd, FakeSM, sessionFile, sessionDir, calls, customImpl, confirmImpl, selectImpl }) {
    const notes = [];
    const selects = [];
    const customs = [];
    const confirms = [];
    const waited = [];
    const switches = [];
    const sent = [];
    const sm = new FakeSM();
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
      getLeafId: () => 'leaf-1',
      getEntries: () => [],
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
        custom: async (factory, opts) => {
          customs.push(opts);
          return customImpl(factory, opts);
        },
        confirm: async (title, body) => {
          confirms.push([title, body]);
          if (typeof confirmImpl === 'function') return confirmImpl(title, body);
          return confirmImpl;
        },
      },
      sessionManager: sm,
      waitForIdle: async () => { waited.push(true); },
      switchSession: async (file, options) => {
        switches.push([file, typeof options?.withSession]);
        if (typeof options?.withSession === 'function') {
          await options.withSession({ ui: { setStatus: () => {} }, sendMessage: async (m, o) => { sent.push([m, o]); } });
        }
        return { cancelled: false };
      },
    };
    return { ctx, notes, selects, customs, confirms, waited, switches, sent };
  }
  // Drive the REAL picker the handler mounts through ctx.ui.custom with an
  // actual raw Ctrl+D byte (\\x04). The picker resolves
  // {delete:true} via the installed matcher or the raw fallback, then the
  // handler must close the selector FIRST and ask ctx.ui.confirm naming
  // the target and its absolute path. `drive` answers every mount: the
  // first mount sends Ctrl+D on the given focus moves, later mounts Esc.
  function driveWithKeys(tuiHelpers, moves, key) {
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    let n = 0;
    return (factory) => new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => reject(new Error('warp selector test did not settle')), 1000);
      const done = (value) => {
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      try {
        const view = factory(hostTui, null, {}, done);
        n += 1;
        if (n > 1) {
          view.handleInput('\x1b');
          return;
        }
        for (const m of moves) view.handleInput(m);
        void tuiHelpers;
        view.handleInput(key);
        // Protected rows correctly keep the selector open on Ctrl+D.
        // Finish this simulated interaction explicitly, like a human would.
        if (!settled) view.handleInput('\x1b');
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    });
  }
  test('the delete seam exists and the selector reuses the shared close path', async () => {
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { mod } = await loadExtension();
      assert.equal(typeof mod.setWarpCloseRunner, 'function', 'injectable close seam for tests');
      const src = fs.readFileSync(SRC, 'utf8');
      assert.ok(src.includes('executeWorktreeClose'), 'the warp delete path reuses executeWorktreeClose (no duplicated deletion)');
    } finally {
      restoreEnv();
    }
  });
  test('raw Ctrl+D invokes one explicit confirmation naming target and absolute path', async () => {
    const root = makeRepo('warpdel-confirm');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/del-target');
      addRegistered(root, 'feat/other');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      void pickerLib;
      let closeCalls = [];
      const { commands, mod } = await loadExtension();
      mod.setWarpCloseRunner(async () => { closeCalls.push(1); return { isError: false, text: 'removed: feat-del-target \u00B7 feat/del-target', details: {} }; });
      try {
        // The session sits in principal, so the first deletable row
        // ([feat-del-target, feat-other, Create]) is already focused at
        // index 0: raw Ctrl+D with no moves targets feat-del-target.
        const customImpl = driveWithKeys(null, [], '\x04');
        const built = makeDeleteCtx({
          cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
          customImpl, confirmImpl: () => false, selectImpl: undefined,
        });
        await warpDef(commands).handler('', built.ctx);
        assert.equal(built.customs.length, 2, 'selector closed first, then reopened after cancel (stable focus)');
        assert.equal(built.confirms.length, 1, 'exactly one destructive confirmation');
        assert.ok(built.confirms[0][0].includes('feat-del-target'), 'confirmation names the target');
        assert.ok(built.confirms[0][1].includes(target), 'confirmation names the absolute path');
        assert.deepEqual(closeCalls, [], 'cancel calls shared close zero times');
      } finally {
        mod.setWarpCloseRunner(null);
      }
    } finally {
      restoreEnv();
    }
  });
  test('cancel keeps every state and calls close zero times', async () => {
    const root = makeRepo('warpdel-cancel');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/cancel-me');
      const before = JSON.stringify(require('../lib/worktree-registry.js').readRegistry(root));
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands, mod } = await loadExtension();
      let closeCalls = 0;
      mod.setWarpCloseRunner(async () => { closeCalls += 1; return { isError: false, text: 'removed', details: {} }; });
      try {
        const customImpl = driveWithKeys(null, [], '\x04');
        const built = makeDeleteCtx({
          cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
          customImpl, confirmImpl: () => false, selectImpl: undefined,
        });
        await warpDef(commands).handler('', built.ctx);
        assert.equal(closeCalls, 0, 'rejected confirmation never reaches close');
        assert.equal(JSON.stringify(require('../lib/worktree-registry.js').readRegistry(root)), before, 'registry untouched');
        assert.ok(fs.existsSync(target), 'checkout untouched');
        assert.deepEqual(calls, [], 'no fork');
        assert.deepEqual(built.switches, [], 'no session switch');
        assert.equal(built.customs.length, 2, 'cancel reopens the selector instead of leaving');
      } finally {
        mod.setWarpCloseRunner(null);
      }
    } finally {
      restoreEnv();
    }
  });
  test('acceptance calls the shared close exactly once with the correct target', async () => {
    const root = makeRepo('warpdel-accept');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/accept-me');
      addRegistered(root, 'feat/stay');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands, mod } = await loadExtension();
      const seen = [];
      mod.setWarpCloseRunner(async (params, cctx) => {
        seen.push([params, !!(cctx && cctx.hasUI)]);
        return { isError: false, text: `removed: feat-accept-me \u00B7 feat/accept-me`, details: {} };
      });
      try {
        const customImpl = driveWithKeys(null, [], '\x04');
        const built = makeDeleteCtx({
          cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
          customImpl, confirmImpl: () => true, selectImpl: undefined,
        });
        await warpDef(commands).handler('', built.ctx);
        assert.equal(seen.length, 1, 'shared close called exactly once');
        assert.equal(seen[0][0].path, target, 'correct absolute target travels to close');
        assert.equal(seen[0][1], false, 'second approval suppressed deliberately (single confirmation, safety kept)');
        assert.equal(built.confirms.length, 1, 'exactly one destructive confirmation before any effect');
      } finally {
        mod.setWarpCloseRunner(null);
      }
    } finally {
      restoreEnv();
    }
  });
  test('principal and create rows are protected: no confirm and no close', async () => {
    const root = makeRepo('warpdel-protected');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const first = addRegistered(root, 'feat/keep');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands, mod } = await loadExtension();
      let closeCalls = 0;
      mod.setWarpCloseRunner(async () => { closeCalls += 1; return { isError: false, text: 'removed', details: {} }; });
      try {
        // Session inside the worktree: selector order is
        // [principal, Create]; focus starts on principal (index 0).
        const customImpl = driveWithKeys(null, [], '\x04');
        const built = makeDeleteCtx({
          cwd: first, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
          customImpl, confirmImpl: () => true, selectImpl: undefined,
        });
        await warpDef(commands).handler('', built.ctx);
        assert.deepEqual(built.confirms, [], 'principal Ctrl+D never confirms');
        assert.equal(closeCalls, 0, 'principal Ctrl+D never closes');
        assert.ok(fs.existsSync(root), 'the repo still exists');
        // Create row: session in principal, move to last row then Ctrl+D.
        const calls2 = [];
        const FakeSM2 = makeFakeSM(calls2);
        const createImpl = driveWithKeys(null, ['down'], '\x04');
        const built2 = makeDeleteCtx({
          cwd: root, FakeSM: FakeSM2, sessionFile, sessionDir: path.dirname(sessionFile), calls: calls2,
          customImpl: createImpl, confirmImpl: () => true, selectImpl: undefined,
        });
        await warpDef(commands).handler('', built2.ctx);
        assert.deepEqual(built2.confirms, [], 'create Ctrl+D never confirms');
        assert.equal(closeCalls, 0, 'create Ctrl+D never closes');
      } finally {
        mod.setWarpCloseRunner(null);
      }
    } finally {
      restoreEnv();
    }
  });
  test('Enter still warps, Esc still cancels, create stays last', async () => {
    const root = makeRepo('warpdel-keys');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/keep-keys');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands, mod } = await loadExtension();
      mod.setWarpCloseRunner(async () => ({ isError: false, text: 'removed', details: {} }));
      try {
        // Esc on the first mount exits silently with no confirm and no close.
        const escImpl = (factory) => new Promise((resolve) => {
          const view = factory({ requestRender: () => {}, terminal: { rows: 24 } }, null, {}, resolve);
          view.handleInput('\x1b');
        });
        const escBuilt = makeDeleteCtx({
          cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
          customImpl: escImpl, confirmImpl: () => true, selectImpl: undefined,
        });
        await warpDef(commands).handler('', escBuilt.ctx);
        assert.equal(escBuilt.customs.length, 1, 'Esc closes the selector');
        assert.deepEqual(escBuilt.confirms, [], 'Esc never confirms');
        assert.deepEqual(escBuilt.switches, [], 'Esc never switches');
        // Enter on the first checkout warps (no delete involved).
        const enterImpl = (factory) => new Promise((resolve) => {
          const view = factory({ requestRender: () => {}, terminal: { rows: 24 } }, null, {}, resolve);
          view.handleInput('\r');
        });
        const calls2 = [];
        const FakeSM2 = makeFakeSM(calls2);
        const enterBuilt = makeDeleteCtx({
          cwd: root, FakeSM: FakeSM2, sessionFile, sessionDir: path.dirname(sessionFile), calls: calls2,
          customImpl: enterImpl, confirmImpl: () => true, selectImpl: undefined,
        });
        await warpDef(commands).handler('', enterBuilt.ctx);
        assert.equal(enterBuilt.switches.length, 1, 'Enter warps the session');
        assert.deepEqual(enterBuilt.confirms, [], 'warp never asks the delete confirmation');
      } finally {
        mod.setWarpCloseRunner(null);
      }
    } finally {
      restoreEnv();
    }
  });
  test('close failure reports the existing refusal and changes nothing', async () => {
    const root = makeRepo('warpdel-fail');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/fail-me');
      const before = JSON.stringify(require('../lib/worktree-registry.js').readRegistry(root));
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands, mod } = await loadExtension();
      mod.setWarpCloseRunner(async () => ({ isError: true, text: `cannot close the worktree at ${target}: dirty checkout`, details: {} }));
      try {
        const customImpl = driveWithKeys(null, [], '\x04');
        const built = makeDeleteCtx({
          cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
          customImpl, confirmImpl: () => true, selectImpl: undefined,
        });
        await warpDef(commands).handler('', built.ctx);
        assert.equal(built.notes.length, 1, 'exactly one concise failure');
        assert.ok(built.notes[0][0].includes('dirty checkout'), 'the existing close refusal travels through');
        assert.equal(JSON.stringify(require('../lib/worktree-registry.js').readRegistry(root)), before, 'registry untouched');
        assert.ok(fs.existsSync(target), 'checkout untouched');
      } finally {
        mod.setWarpCloseRunner(null);
      }
    } finally {
      restoreEnv();
    }
  });
  test('success refreshes the listing before offering further choices (no stale rows)', async () => {
    const root = makeRepo('warpdel-refresh');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const gone = addRegistered(root, 'feat/gone');
      addRegistered(root, 'feat/stay-here');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands, mod } = await loadExtension();
      const registryLib = require('../lib/worktree-registry.js');
      const seenOptions = [];
      let mounts = 0;
      mod.setWarpCloseRunner(async (params) => {
        // Faithful to the shared close: the checkout leaves the git
        // listing as well as the registry, so the refresh offers no stale row.
        git(root, ['worktree', 'remove', '--force', params.path]);
        registryLib.removeWorktreeByPath(root, params.path);
        return { isError: false, text: 'removed: feat-gone \u00B7 feat/gone', details: {} };
      });
      try {
        const customImpl = (factory) => new Promise((resolve) => {
          mounts += 1;
          const view = factory({ requestRender: () => {}, terminal: { rows: 24 } }, null, {}, resolve);
          if (mounts === 1) {
            view.handleInput('\x04');
          } else {
            seenOptions.push(view.render(120).join('\n'));
            view.handleInput('\x1b');
          }
        });
        const built = makeDeleteCtx({
          cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
          customImpl, confirmImpl: () => true, selectImpl: undefined,
        });
        await warpDef(commands).handler('', built.ctx);
        assert.equal(mounts, 2, 'success reopens the selector');
        assert.equal(seenOptions.length, 1, 'the reopened selector rendered');
        assert.ok(!seenOptions[0].includes(gone), 'no stale row: the deleted checkout is gone');
        assert.ok(seenOptions[0].includes('feat-stay-here'), 'the remaining checkout stays');
        assert.ok(seenOptions[0].includes('Create new worktree…'), 'create stays last');
      } finally {
        mod.setWarpCloseRunner(null);
      }
    } finally {
      restoreEnv();
    }
  });

describe('warp selector Ctrl+D deletion summary (S61)', { concurrency: false }, () => {
  test('a dirty target names its pending changes and the approval carries force for exactly that row', async () => {
    const root = makeRepo('warpdel-dirty');
    // A committed file, so the new worktrees carry it and the target can go dirty.
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
    git(root, ['add', 'a.txt']);
    git(root, ['commit', '-m', 'file']);
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/dirty-target');
      addRegistered(root, 'feat/dirty-other');
      fs.writeFileSync(path.join(target, 'a.txt'), 'one\nTWO\n');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands, mod } = await loadExtension();
      const seen = [];
      mod.setWarpCloseRunner(async (params, cctx) => {
        seen.push([params, !!(cctx && cctx.hasUI)]);
        return { isError: false, text: 'removed: feat-dirty-target \u00B7 feat/dirty-target', details: {} };
      });
      try {
        const customImpl = driveWithKeys(null, [], '\x04');
        const built = makeDeleteCtx({
          cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
          customImpl, confirmImpl: () => true, selectImpl: undefined,
        });
        await warpDef(commands).handler('', built.ctx);
        assert.equal(built.confirms.length, 1, 'exactly one destructive confirmation');
        assert.match(built.confirms[0][1], /Pending changes: 1 file, \+1\/-1/, 'the dirty summary travels in the confirmation');
        assert.equal(seen.length, 1, 'the shared close ran exactly once');
        assert.equal(seen[0][0].path, target, 'exactly the approved target');
        assert.equal(seen[0][0].force, true, 'the explicit Yes authorizes force for that approved row');
        assert.equal(seen[0][1], false, 'no second approval inside the close');
      } finally {
        mod.setWarpCloseRunner(null);
      }
    } finally {
      restoreEnv();
    }
  });

  test('a clean target omits the dirty warning and carries no force', async () => {
    const root = makeRepo('warpdel-clean-target');
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\n');
    git(root, ['add', 'a.txt']);
    git(root, ['commit', '-m', 'file']);
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/clean-target');
      addRegistered(root, 'feat/clean-other');
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const sessionFile = sessionFileIn();
      const { commands, mod } = await loadExtension();
      const seen = [];
      mod.setWarpCloseRunner(async (params, cctx) => {
        seen.push([params, !!(cctx && cctx.hasUI)]);
        return { isError: false, text: 'removed: feat-clean-target \u00B7 feat/clean-target', details: {} };
      });
      try {
        const customImpl = driveWithKeys(null, [], '\x04');
        const built = makeDeleteCtx({
          cwd: root, FakeSM, sessionFile, sessionDir: path.dirname(sessionFile), calls,
          customImpl, confirmImpl: () => true, selectImpl: undefined,
        });
        await warpDef(commands).handler('', built.ctx);
        assert.equal(built.confirms.length, 1, 'exactly one destructive confirmation');
        assert.ok(!built.confirms[0][1].includes('Pending changes'), 'a clean checkout omits the dirty warning');
        assert.equal(seen.length, 1, 'the shared close ran exactly once');
        assert.equal(seen[0][0].path, target, 'exactly the approved target');
        assert.equal(seen[0][0].force, undefined, 'no silent force on a clean row');
      } finally {
        mod.setWarpCloseRunner(null);
      }
    } finally {
      restoreEnv();
    }
  });
});
});

describe('warp pending-changes guard (S61)', { concurrency: false }, () => {
  function makeFileRepo(tag) {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-cwarp61-${tag}-`)));
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
    git(dir, ['add', 'a.txt']);
    git(dir, ['commit', '-m', 'init']);
    return fs.realpathSync(dir);
  }

  function makeFileWarpCtx({ cwd, sessionFile, sessionDir, calls, entries = [] }) {
    return makeWarpCtx({
      cwd, sessionFile, leaf: 'leaf-1', entries, sessionDir, calls,
    });
  }

  test('a clean source warps with no prompt and no copy', async () => {
    const root = makeFileRepo('clean-src');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/clean-dest');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeFileWarpCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      let asked = 0;
      mod.setWarpDirtyAsker(async () => { asked += 1; return 'yes'; });
      try {
        const out = await mod.executeWorktreeWarp('feat-clean-dest', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
        assert.equal(out.isError, undefined, `expected success: ${out.text}`);
        assert.equal(asked, 0, 'a clean checkout never prompts');
        assert.equal(switches.length, 1, 'the ordinary warp proceeds');
        assert.equal(fs.existsSync(path.join(target, 'a.txt')), true);
      } finally {
        mod.setWarpDirtyAsker(null);
      }
    } finally {
      restoreEnv();
    }
  });

  test('YES COPY copies every change, keeps the source and warps', async () => {
    const root = makeFileRepo('yes-copy');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/yes-dest');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(root, 'new.txt'), 'fresh\n');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeFileWarpCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      mod.setWarpDirtyAsker(async () => 'yes');
      try {
        const out = await mod.executeWorktreeWarp('feat-yes-dest', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
        assert.equal(out.isError, undefined, `expected success: ${out.text}`);
        assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n');
        assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'fresh\n');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n', 'the source is retained');
        assert.equal(switches.length, 1, 'the warp follows the copy');
      } finally {
        mod.setWarpDirtyAsker(null);
      }
    } finally {
      restoreEnv();
    }
  });

  test('NO COPY warps ordinarily with nothing copied', async () => {
    const root = makeFileRepo('no-copy');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/no-dest');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeFileWarpCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      mod.setWarpDirtyAsker(async () => 'no');
      try {
        const out = await mod.executeWorktreeWarp('feat-no-dest', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
        assert.equal(out.isError, undefined, `expected success: ${out.text}`);
        assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'nothing was copied');
        assert.equal(switches.length, 1, 'the ordinary warp proceeds');
      } finally {
        mod.setWarpDirtyAsker(null);
      }
    } finally {
      restoreEnv();
    }
  });

  test('Esc/Ctrl+C cancels with no switch and no copy', async () => {
    const root = makeFileRepo('cancel-copy');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/cancel-dest');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeFileWarpCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      mod.setWarpDirtyAsker(async () => null);
      try {
        const out = await mod.executeWorktreeWarp('feat-cancel-dest', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
        assert.equal(out.details.cancelled, true, 'cancel is a real outcome');
        assert.deepEqual(switches, [], 'no session switch');
        assert.deepEqual(calls, [], 'no fork');
        assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'no copy happened');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nTWO\n', 'the source is untouched');
      } finally {
        mod.setWarpDirtyAsker(null);
      }
    } finally {
      restoreEnv();
    }
  });

  test('a destination overlap rejects with no warp and no copy', async () => {
    const root = makeFileRepo('overlap');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/overlap-dest');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nSRC\n');
      fs.writeFileSync(path.join(target, 'a.txt'), 'one\nDEST\n');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeFileWarpCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      mod.setWarpDirtyAsker(async () => 'yes');
      try {
        const out = await mod.executeWorktreeWarp('feat-overlap-dest', ctx, { sessionManagerClass: FakeSM, oscStream: oscFake(false) });
        assert.equal(out.isError, true, 'the overlap refuses');
        assert.match(out.text, /destination already modifies/);
        assert.deepEqual(switches, [], 'no session switch');
        assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nDEST\n', 'the destination is untouched');
        assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'one\nSRC\n', 'the source is untouched');
      } finally {
        mod.setWarpDirtyAsker(null);
      }
    } finally {
      restoreEnv();
    }
  });

  function makeToolCtx({ cwd, sessionFile, sessionDir, calls, entries = [] }) {
    const notes = [];
    const switches = [];
    const session = {
      getSessionFile: () => sessionFile,
      getLeafId: () => 'leaf-1',
      getEntries: () => entries,
      getSessionDir: () => sessionDir,
    };
    const ctx = {
      cwd,
      ui: {
        notify: (message, level) => { notes.push([message, level]); },
        setStatus: () => {},
      },
      sessionManager: session,
      switchSession: async (file, options) => {
        switches.push([file, typeof options?.withSession]);
        if (typeof options?.withSession === 'function') {
          await options.withSession({ ui: { setStatus: () => {} }, sendMessage: async () => {} });
        }
        return { cancelled: false };
      },
    };
    return { ctx, notes, switches };
  }

  function toolText(out) {
    const blocks = out && Array.isArray(out.content) ? out.content : [];
    return blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  }

  test('tool: an invalid changes value fails closed with no switch', async () => {
    const root = makeFileRepo('tool-invalid');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      addRegistered(root, 'feat/tool-target');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeToolCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarpTool(
        { name: 'feat-tool-target', changes: 'some' }, ctx, { sessionManagerClass: FakeSM },
      );
      assert.equal(out.isError, true);
      assert.match(toolText(out), /invalid changes selection/);
      assert.deepEqual(switches, [], 'no session switch');
      assert.deepEqual(calls, [], 'no fork');
    } finally {
      restoreEnv();
    }
  });

  test('tool: omitted changes warps with nothing copied', async () => {
    const root = makeFileRepo('tool-omitted');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/tool-omitted-dest');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeToolCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarpTool(
        { name: 'feat-tool-omitted-dest' }, ctx, { sessionManagerClass: FakeSM },
      );
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      assert.equal(switches.length, 1, 'the warp proceeds');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\ntwo\n', 'nothing was copied');
    } finally {
      restoreEnv();
    }
  });

  test('tool: changes "all" copies everything before the switch', async () => {
    const root = makeFileRepo('tool-all');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/tool-all-dest');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(root, 'new.txt'), 'fresh\n');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeToolCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarpTool(
        { name: 'feat-tool-all-dest', changes: 'all' }, ctx, { sessionManagerClass: FakeSM },
      );
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.equal(fs.readFileSync(path.join(target, 'new.txt'), 'utf8'), 'fresh\n');
      assert.equal(switches.length, 1, 'the switch follows the copy');
    } finally {
      restoreEnv();
    }
  });

  test('tool: a paths list copies only those files', async () => {
    const root = makeFileRepo('tool-paths');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/tool-paths-dest');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(root, 'extra.txt'), 'extra\n');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeToolCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarpTool(
        { name: 'feat-tool-paths-dest', changes: ['a.txt'] }, ctx, { sessionManagerClass: FakeSM },
      );
      assert.equal(out.isError, undefined, `expected success: ${out.text}`);
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.equal(fs.existsSync(path.join(target, 'extra.txt')), false, 'unselected files stay out');
      assert.equal(switches.length, 1, 'the warp proceeds');
    } finally {
      restoreEnv();
    }
  });

  test('tool: a destination overlap rejects with no switch and no copy', async () => {
    const root = makeFileRepo('tool-overlap');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const target = addRegistered(root, 'feat/tool-overlap-dest');
      fs.writeFileSync(path.join(root, 'a.txt'), 'one\nSRC\n');
      fs.writeFileSync(path.join(target, 'a.txt'), 'one\nDEST\n');
      const sessionFile = sessionFileIn();
      const calls = [];
      const FakeSM = makeFakeSM(calls);
      const { ctx, switches } = makeToolCtx({
        cwd: root, sessionFile, sessionDir: path.dirname(sessionFile), calls,
      });
      const { mod } = await loadExtension();
      const out = await mod.executeWorktreeWarpTool(
        { name: 'feat-tool-overlap-dest', changes: 'all' }, ctx, { sessionManagerClass: FakeSM },
      );
      assert.equal(out.isError, true);
      assert.match(toolText(out), /destination already modifies/);
      assert.deepEqual(switches, [], 'no session switch');
      assert.deepEqual(calls, [], 'no fork');
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'one\nDEST\n');
    } finally {
      restoreEnv();
    }
  });
});