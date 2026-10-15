'use strict';
// T34 (S25) tests (test-first): `worktree_session_open` in
// extensions/gentle-worktree-tools.ts.
//
// Loading pattern mirrors tools/worktree-create.test.js: the TypeScript
// extension is plain JS under the hood (// @ts-nocheck, no type
// annotations), so the test copies it to a temporary .mjs path with exactly
// the two package import lines stubbed and import()s it with a fake `pi`
// object that records registrations. Production is untouched.
//
// Every test builds its own isolated fixture repository under os.tmpdir()
// (real `git init` + one commit, real `git worktree add` for registered
// rows), a stub `herdr` binary reached through the documented
// HERDR_BIN_PATH override, and drives the tool through its public
// `execute`. Only observable behavior is asserted: result text, details,
// and the exact argv the shim observed. The user's real checkouts and the
// user's running Herdr session are never touched; only the fixture dirs
// tracked in `roots` are removed.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
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

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-session-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function addRegistered(root, branch, { thread = 'thread-1', issues = [35] } = {}) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-sess-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const registryLib = require('../lib/worktree-registry.js');
  assert.equal(registryLib.upsertWorktree(root, {
    branch, path: target, thread, issues, odd: [],
  }).ok, true);
  return fs.realpathSync(target);
}

// Stub `herdr`: logs every argv line to $HERDR_SHIM_LOG, then answers the
// four composed calls from fixture JSON files the test writes:
//   $HERDR_STUB_WORKTREE_LIST -> `worktree list` stdout
//   $HERDR_STUB_WORKTREE_OPEN -> `worktree open` stdout
//   $HERDR_STUB_PANE_LIST     -> `pane list` stdout
// `agent start` succeeds with `{}` unless $HERDR_SHIM_AGENT_START_EXIT is
// non-zero. Each family fails independently through its own EXIT var so a
// single failing leg can be observed while the others succeed.
function makeHerdrStub() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-herdr-')));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$HERDR_SHIM_LOG"',
      'if [ "$1" = "worktree" ] && [ "$2" = "list" ]; then',
      '  if [ "${HERDR_SHIM_WORKTREE_LIST_EXIT:-0}" != "0" ]; then echo "shim worktree list failure" >&2; exit 1; fi',
      '  cat "$HERDR_STUB_WORKTREE_LIST"; exit 0',
      'fi',
      'if [ "$1" = "worktree" ] && [ "$2" = "open" ]; then',
      '  if [ "${HERDR_SHIM_OPEN_EXIT:-0}" != "0" ]; then echo "shim worktree open failure" >&2; exit 1; fi',
      '  cat "$HERDR_STUB_WORKTREE_OPEN"; exit 0',
      'fi',
      'if [ "$1" = "pane" ] && [ "$2" = "list" ]; then',
      '  if [ "${HERDR_SHIM_PANE_LIST_EXIT:-0}" != "0" ]; then echo "shim pane list failure" >&2; exit 1; fi',
      '  cat "$HERDR_STUB_PANE_LIST"; exit 0',
      'fi',
      'if [ "$1" = "agent" ] && [ "$2" = "start" ]; then',
      '  if [ "${HERDR_SHIM_AGENT_START_EXIT:-0}" != "0" ]; then echo "shim agent start failure" >&2; exit 1; fi',
      '  echo "{}"; exit 0',
      'fi',
      'echo "herdr stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const log = path.join(dir, 'herdr-argv.log');
  return { bin, log };
}

function shimArgv(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function writeJson(dir, name, doc) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `${JSON.stringify(doc)}\n`);
  return file;
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-mode-'))) };
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    on: () => () => {},
  };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return { tools, commands };
}

function makeCtx(repoRoot) {
  return {
    cwd: repoRoot,
    hasUI: false,
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: { confirm: async () => true, notify: () => {} },
  };
}

async function callSessionOpen(tools, params, ctx) {
  const tool = tools.get('worktree_session_open');
  assert.ok(tool, 'expected worktree_session_open to be registered');
  return tool.execute('call-1', params, undefined, undefined, ctx);
}

// A stub world where the registered worktree already has a Herdr
// workspace: `worktree list` names it, `pane list` names two panes (listed
// out of order so the ROOT-pane rule is observable), `agent start`
// succeeds.
function workspaceWorld(root, branch, target, { workspaceId = 'ws-1' } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-world-')));
  const worktreeList = writeJson(dir, 'worktree-list.json', {
    result: { worktrees: [{ path: target, branch, open_workspace_id: workspaceId }] },
  });
  const paneList = writeJson(dir, 'pane-list.json', {
    result: { panes: [{ pane_id: `${workspaceId}:p2` }, { pane_id: `${workspaceId}:p1` }] },
  });
  return { dir, worktreeList, paneList };
}

describe('worktree_session_open registration (S25)', { concurrency: false }, () => {
  test('registers beside the other three tools with the exact params', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      const { tools } = await loadExtension();
      assert.deepEqual(
        [...tools.keys()].sort(),
        ['worktree_close', 'worktree_create', 'worktree_list', 'worktree_session_open'],
      );
      const params = tools.get('worktree_session_open').parameters;
      assert.deepEqual(Object.keys(params.properties).sort(), ['name', 'notify', 'session', 'worktree']);
      assert.equal(params.properties.worktree.type, 'string');
    } finally {
      restoreEnv();
    }
  });

  test('with the mode disabled at load the session tool is not registered either', async () => {
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      require('../lib/worktree-mode.js').writeMode(false, process.env);
      const { tools, commands } = await loadExtension();
      assert.deepEqual([...tools.keys()], [], 'no worktree tool is registered while disabled');
      assert.ok(commands.has('herdr-gentle:worktree'), 'the toggle itself stays registered');
    } finally {
      restoreEnv();
    }
  });

  test('a disabled mode at execute time refuses naming the toggle', async () => {
    const root = makeRepo('mode-exec');
    addRegistered(root, 'feat/gated');
    const herdr = makeHerdrStub();
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const { tools } = await loadExtension();
      require('../lib/worktree-mode.js').writeMode(false, process.env);
      const result = await callSessionOpen(tools, { worktree: 'feat-gated' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.ok(resultText(result).includes('/herdr-gentle:worktree enabled'), `names the toggle: ${resultText(result)}`);
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked');
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_session_open scope guard (S25)', { concurrency: false }, () => {
  test('an absolute PATH is refused with an actionable message before any backend runs', async () => {
    const root = makeRepo('abspath');
    const target = addRegistered(root, 'feat/real');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/real', target);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: target }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /not a path|refuses a path|pass the (worktree )?name/i);
      assert.ok(resultText(result).includes('worktree list'), `names the listing: ${resultText(result)}`);
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked for a path');
    } finally {
      restoreEnv();
    }
  });

  test('a relative PATH is refused with an actionable message before any backend runs', async () => {
    const root = makeRepo('relpath');
    const target = addRegistered(root, 'feat/real');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/real', target);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
    });
    try {
      const { tools } = await loadExtension();
      for (const rel of ['../outside', './local']) {
        const result = await callSessionOpen(tools, { worktree: rel }, makeCtx(root));
        assert.equal(result.isError, true, `expected refusal: ${rel}`);
        assert.match(resultText(result), /not a path|refuses a path|pass the (worktree )?name/i);
        assert.ok(resultText(result).includes('worktree list'), `names the listing: ${resultText(result)}`);
      }
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked for a path');
    } finally {
      restoreEnv();
    }
  });

  test('the principal checkout is refused: a session there delegates nothing', async () => {
    const root = makeRepo('principal');
    addRegistered(root, 'feat/other');
    const herdr = makeHerdrStub();
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'principal' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /principal/i);
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked for the principal');
    } finally {
      restoreEnv();
    }
  });

  test('an unknown name fails closed naming the known ones', async () => {
    const root = makeRepo('unknown');
    addRegistered(root, 'feat/known');
    const herdr = makeHerdrStub();
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-nope' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /no registered worktree for "feat-nope"/);
      assert.ok(resultText(result).includes('feat-known'), `names the known ones: ${resultText(result)}`);
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked for an unknown name');
    } finally {
      restoreEnv();
    }
  });

  test('a branch name resolves through the one resolver to its printed slug', async () => {
    const root = makeRepo('bybranch');
    const target = addRegistered(root, 'feat/by-branch');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/by-branch', target);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat/by-branch' }, makeCtx(root));
      assert.equal(result.isError, undefined, `a branch name resolves: ${resultText(result)}`);
      assert.match(resultText(result), /^worktree session open: feat-by-branch [0-9a-f-]{36}$/);
      assert.equal(result.details.worktree, 'feat-by-branch');
      assert.equal(result.details.branch, 'feat/by-branch');
    } finally {
      restoreEnv();
    }
  });

  test('a registered row whose checkout is gone is refused as not live', async () => {
    const root = makeRepo('stale');
    const target = addRegistered(root, 'feat/stale');
    fs.rmSync(target, { recursive: true, force: true });
    assert.equal(fs.existsSync(target), false);
    const herdr = makeHerdrStub();
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-stale' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /not.*live|stale|missing/i);
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked for a dead checkout');
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_session_open workspace reuse (S25)', { concurrency: false }, () => {
  test('an existing workspace reuses its ROOT pane: pane list runs, worktree open never runs', async () => {
    const root = makeRepo('reuse');
    const target = addRegistered(root, 'feat/reuse');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/reuse', target, { workspaceId: 'ws-reuse' });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-reuse' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const calls = shimArgv(herdr.log);
      assert.equal(calls.length, 3, `worktree list, pane list, agent start: ${JSON.stringify(calls)}`);
      assert.ok(calls[0].startsWith('worktree list --cwd '), `list first: ${calls[0]}`);
      assert.ok(calls[0].includes(root), `list scoped to the repo: ${calls[0]}`);
      assert.ok(!calls[0].includes('trust'), `never --trust-repository: ${calls[0]}`);
      assert.equal(calls[1], 'pane list --workspace ws-reuse', `pane list on the workspace: ${calls[1]}`);
      assert.ok(!calls.some((line) => line.startsWith('worktree open')), 'worktree open never runs on reuse');
      // The ROOT pane is the lowest index even though p2 was listed first.
      assert.ok(calls[2].includes('--pane ws-reuse:p1'), `root pane selected: ${calls[2]}`);
      assert.equal(result.details.paneId, 'ws-reuse:p1');
      assert.equal(result.details.workspaceId, 'ws-reuse');
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_session_open workspace creation (S25)', { concurrency: false }, () => {
  test('no workspace opens one with --branch --cwd --no-focus and uses its root pane', async () => {
    const root = makeRepo('mkws');
    const target = addRegistered(root, 'feat/mk-ws');
    const herdr = makeHerdrStub();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-mkws-')));
    const worktreeList = writeJson(dir, 'worktree-list.json', { result: { worktrees: [] } });
    const opened = writeJson(dir, 'worktree-open.json', {
      result: { workspace: { workspace_id: 'ws-new' }, root_pane: { pane_id: 'ws-new:p1' } },
    });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: worktreeList,
      HERDR_STUB_WORKTREE_OPEN: opened,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-mk-ws' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const calls = shimArgv(herdr.log);
      assert.equal(calls.length, 3, `worktree list, worktree open, agent start: ${JSON.stringify(calls)}`);
      const [open] = calls.filter((line) => line.startsWith('worktree open'));
      assert.ok(open, 'worktree open ran');
      assert.ok(open.includes('--branch feat/mk-ws'), `branch as separate argv: ${open}`);
      assert.ok(open.includes(`--cwd ${root}`), `cwd as separate argv: ${open}`);
      assert.ok(open.includes('--no-focus'), `never steals focus: ${open}`);
      assert.ok(!/(^| )--focus( |$)/.test(open), `never --focus: ${open}`);
      assert.ok(!open.includes('trust'), `never --trust-repository: ${open}`);
      assert.ok(!open.includes('='), `never --flag=value: ${open}`);
      assert.ok(!calls.some((line) => line.startsWith('pane list')), 'pane list never runs on the create route');
      assert.equal(result.details.paneId, 'ws-new:p1');
      assert.equal(result.details.workspaceId, 'ws-new');
    } finally {
      restoreEnv();
    }
  });

  test('a worktree LISTED WITHOUT a workspace id is opened, never refused as ambiguous', async () => {
    const root = makeRepo('mkws-noid');
    const target = addRegistered(root, 'feat/mk-noid');
    const herdr = makeHerdrStub();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-noid-')));
    // The real `herdr worktree list` omits `open_workspace_id` entirely for a
    // worktree Herdr has not opened, so the entry matches with no workspace
    // and the tool must open one instead of failing closed.
    const worktreeList = writeJson(dir, 'worktree-list.json', {
      result: { worktrees: [{ path: target, branch: 'feat/mk-noid' }] },
    });
    const opened = writeJson(dir, 'worktree-open.json', {
      result: { workspace: { workspace_id: 'ws-noid' }, root_pane: { pane_id: 'ws-noid:p1' } },
    });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: worktreeList,
      HERDR_STUB_WORKTREE_OPEN: opened,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-mk-noid' }, makeCtx(root));
      assert.equal(result.isError, undefined, `a listed worktree with no workspace must open one: ${resultText(result)}`);
      const calls = shimArgv(herdr.log);
      assert.ok(calls.some((line) => line.startsWith('worktree open')), `worktree open ran: ${JSON.stringify(calls)}`);
      assert.ok(!calls.some((line) => line.startsWith('pane list')), 'the create route uses the pane the open returned');
      assert.equal(result.details.paneId, 'ws-noid:p1');
      assert.equal(result.details.workspaceId, 'ws-noid');
    } finally {
      restoreEnv();
    }
  });

  test('two DIFFERENT workspace ids for one worktree fail closed, nothing runs', async () => {
    const root = makeRepo('mkws-conflict');
    const target = addRegistered(root, 'feat/mk-conflict');
    const herdr = makeHerdrStub();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-conflict-')));
    const worktreeList = writeJson(dir, 'worktree-list.json', {
      result: {
        worktrees: [
          { path: target, branch: 'feat/mk-conflict', open_workspace_id: 'ws-a' },
          { path: target, branch: 'feat/mk-conflict', open_workspace_id: 'ws-b' },
        ],
      },
    });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: worktreeList,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-mk-conflict' }, makeCtx(root));
      assert.equal(result.isError, true, 'a genuine disagreement never picks one');
      assert.match(resultText(result), /different workspaces/i, resultText(result));
      const calls = shimArgv(herdr.log);
      assert.ok(!calls.some((line) => line.startsWith('worktree open')), `never opens a second workspace: ${JSON.stringify(calls)}`);
      assert.ok(!calls.some((line) => line.startsWith('agent start')), `never starts an agent: ${JSON.stringify(calls)}`);
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_session_open agent argv (S25)', { concurrency: false }, () => {
  test('a new session mints a UUID and passes --name plus --session-id, never --session-dir', async () => {
    const root = makeRepo('newsess');
    const target = addRegistered(root, 'feat/new-sess');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/new-sess', target, { workspaceId: 'ws-arg' });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-new-sess' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const calls = shimArgv(herdr.log);
      const [start] = calls.filter((line) => line.startsWith('agent start'));
      assert.ok(start, 'agent start ran');
      assert.ok(start.includes('--kind pi'), `kind pi: ${start}`);
      assert.ok(start.includes('--pane ws-arg:p1'), `pane: ${start}`);
      assert.ok(start.includes('--timeout '), `timeout: ${start}`);
      assert.ok(!start.includes('trust'), `never --trust-repository: ${start}`);
      assert.ok(!/(^| )--focus( |$)/.test(start), `never --focus: ${start}`);
      // The Pi argv after `--`: --name plus a minted --session-id.
      const afterDash = start.split(' -- ').slice(1).join(' -- ');
      assert.ok(afterDash.length > 0, `Pi argv travels after --: ${start}`);
      assert.ok(afterDash.includes('--name feat-new-sess'), `agent name defaults to the worktree name: ${afterDash}`);
      const minted = /--session-id ([A-Za-z0-9._-]+)/.exec(afterDash);
      assert.ok(minted, `--session-id minted: ${afterDash}`);
      assert.match(minted[1], /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'a UUID');
      assert.ok(!afterDash.includes('--session '), `new session never resumes: ${afterDash}`);
      assert.ok(!afterDash.includes('--session-dir'), `the pane cwd is the worktree: ${afterDash}`);
      assert.equal(result.details.sessionId, minted[1], 'the minted id is returned');
      assert.equal(result.details.resumed, false);
      assert.equal(result.details.agentName, 'feat-new-sess');
      assert.match(resultText(result), new RegExp(`^worktree session open: feat-new-sess ${minted[1]}$`));
    } finally {
      restoreEnv();
    }
  });

  test('a resume passes --session and never mints --session-id', async () => {
    const root = makeRepo('resume');
    const target = addRegistered(root, 'feat/resume');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/resume', target, { workspaceId: 'ws-resume' });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(
        tools,
        { worktree: 'feat-resume', session: 'abc123', name: 'delegate-1', notify: false },
        makeCtx(root),
      );
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const calls = shimArgv(herdr.log);
      const [start] = calls.filter((line) => line.startsWith('agent start'));
      assert.ok(start, 'agent start ran');
      assert.ok(start.startsWith('agent start delegate-1 '), `agent name travels first: ${start}`);
      const afterDash = start.split(' -- ').slice(1).join(' -- ');
      assert.ok(afterDash.includes('--name delegate-1'), `pi --name: ${afterDash}`);
      assert.ok(afterDash.includes('--session abc123'), `resume id: ${afterDash}`);
      assert.ok(!afterDash.includes('--session-id'), `never mints on resume: ${afterDash}`);
      assert.ok(!afterDash.includes('--session-dir'), `the pane cwd is the worktree: ${afterDash}`);
      assert.equal(resultText(result), 'worktree session open: feat-resume abc123');
      assert.equal(result.details.sessionId, 'abc123');
      assert.equal(result.details.resumed, true);
      assert.equal(result.details.agentName, 'delegate-1');
      assert.equal(result.details.notify, false, 'notify:false is accepted and reported');
    } finally {
      restoreEnv();
    }
  });

  test('notify defaults to true', async () => {
    const root = makeRepo('notify');
    const target = addRegistered(root, 'feat/notify');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/notify', target, { workspaceId: 'ws-notify' });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-notify' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.equal(result.details.notify, true);
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_session_open exact texts and details (S25)', { concurrency: false }, () => {
  test('details carry exactly the nine documented keys', async () => {
    const root = makeRepo('details');
    const target = addRegistered(root, 'feat/details');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/details', target, { workspaceId: 'ws-details' });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-details' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.deepEqual(Object.keys(result.details).sort(), [
        'agentName', 'branch', 'notify', 'paneId', 'path',
        'resumed', 'sessionId', 'workspaceId', 'worktree',
      ]);
      assert.deepEqual(
        { ...result.details, sessionId: 'ID' },
        {
          worktree: 'feat-details', branch: 'feat/details', path: target,
          paneId: 'ws-details:p1', workspaceId: 'ws-details', sessionId: 'ID',
          resumed: false, agentName: 'feat-details', notify: true,
        },
      );
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_session_open failures name the herdr call (S25)', { concurrency: false }, () => {
  test('a failing worktree list names the call and its exit', async () => {
    const root = makeRepo('faillist');
    addRegistered(root, 'feat/fail-list');
    const herdr = makeHerdrStub();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-faillist-')));
    const worktreeList = writeJson(dir, 'worktree-list.json', { result: { worktrees: [] } });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: worktreeList,
      HERDR_SHIM_WORKTREE_LIST_EXIT: '1',
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-fail-list' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /herdr worktree list/);
      assert.match(resultText(result), /exited 1/);
    } finally {
      restoreEnv();
    }
  });

  test('a failing pane list names the call and never reaches agent start', async () => {
    const root = makeRepo('failpane');
    const target = addRegistered(root, 'feat/fail-pane');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/fail-pane', target, { workspaceId: 'ws-failpane' });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
      HERDR_SHIM_PANE_LIST_EXIT: '1',
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-fail-pane' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /herdr pane list/);
      assert.match(resultText(result), /exited 1/);
      assert.ok(!shimArgv(herdr.log).some((line) => line.startsWith('agent start')), 'agent start never runs');
    } finally {
      restoreEnv();
    }
  });

  test('a failing worktree open names the call and its exit', async () => {
    const root = makeRepo('failopen');
    addRegistered(root, 'feat/fail-open');
    const herdr = makeHerdrStub();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-failopen-')));
    const worktreeList = writeJson(dir, 'worktree-list.json', { result: { worktrees: [] } });
    const opened = writeJson(dir, 'worktree-open.json', { result: {} });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: worktreeList,
      HERDR_STUB_WORKTREE_OPEN: opened,
      HERDR_SHIM_OPEN_EXIT: '1',
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-fail-open' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /herdr worktree open/);
      assert.match(resultText(result), /exited 1/);
      assert.ok(!shimArgv(herdr.log).some((line) => line.startsWith('agent start')), 'agent start never runs');
    } finally {
      restoreEnv();
    }
  });

  test('a failing agent start after a created workspace names the call and the workspace', async () => {
    const root = makeRepo('failagent');
    addRegistered(root, 'feat/fail-agent');
    const herdr = makeHerdrStub();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-failagent-')));
    const worktreeList = writeJson(dir, 'worktree-list.json', { result: { worktrees: [] } });
    const opened = writeJson(dir, 'worktree-open.json', {
      result: { workspace: { workspace_id: 'ws-half' }, root_pane: { pane_id: 'ws-half:p1' } },
    });
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: worktreeList,
      HERDR_STUB_WORKTREE_OPEN: opened,
      HERDR_SHIM_AGENT_START_EXIT: '1',
    });
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-fail-agent' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.match(resultText(result), /herdr agent start/);
      assert.match(resultText(result), /exited 1/);
      assert.ok(resultText(result).includes('ws-half'), `the half-created workspace is named: ${resultText(result)}`);
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_session_open allowlist (S25)', { concurrency: false }, () => {
  test('herdrArgv builds the exact session argv and still refuses trust and focus', async () => {
    const gitLib = require('../lib/worktree-git.js');
    assert.deepEqual(gitLib.herdrArgv('open', { branch: 'feat/x', cwd: '/repo', noFocus: true }), [
      'worktree', 'open', '--branch', 'feat/x', '--cwd', '/repo', '--no-focus',
    ]);
    assert.deepEqual(
      gitLib.herdrArgv('agent-start', {
        name: 'delegate-1', kind: 'pi', pane: 'ws-1:p1', timeout: '120000',
        agentArgs: ['--name', 'delegate-1', '--session-id', 'abc'],
      }),
      [
        'agent', 'start', 'delegate-1',
        '--kind', 'pi', '--pane', 'ws-1:p1', '--timeout', '120000',
        '--', '--name', 'delegate-1', '--session-id', 'abc',
      ],
    );
    assert.deepEqual(gitLib.herdrArgv('agent-list', {}), ['agent', 'list']);
    assert.deepEqual(gitLib.herdrArgv('agent-get', { target: 'delegate-1' }), ['agent', 'get', 'delegate-1']);
    for (const argv of [
      gitLib.herdrArgv('open', { branch: 'a b', cwd: '/repo', noFocus: true }),
      gitLib.herdrArgv('agent-start', {
        name: 'a=b', kind: 'pi', pane: 'ws-1:p1', timeout: '120000', agentArgs: ['--name', 'a=b'],
      }),
    ]) {
      for (const element of argv) {
        assert.ok(!element.startsWith('--') || !element.includes('='),
          `must not use --flag=value: ${element}`);
      }
    }
    assert.throws(() => gitLib.herdrArgv('agent-start', { name: 'x', kind: 'pi', trustRepository: true }));
    assert.throws(() => gitLib.herdrArgv('agent-start', { name: 'x', kind: 'pi', focus: true }));
    assert.throws(() => gitLib.herdrArgv('open', { branch: 'x', trustRepository: true }));
  });

  test('the existing worktree argv contracts still hold', async () => {
    const gitLib = require('../lib/worktree-git.js');
    assert.deepEqual(gitLib.herdrArgv('list', { cwd: '/repo' }), [
      'worktree', 'list', '--cwd', '/repo',
    ]);
    assert.deepEqual(gitLib.herdrArgv('create', { branch: 'feat/x', path: '/wt' }), [
      'worktree', 'create', '--branch', 'feat/x', '--path', '/wt',
    ]);
    assert.deepEqual(gitLib.herdrArgv('remove', { workspace: 'abc', force: true }), [
      'worktree', 'remove', '--workspace', 'abc', '--force',
    ]);
    assert.deepEqual(gitLib.herdrArgv('open', { path: '/wt' }), [
      'worktree', 'open', '--path', '/wt',
    ]);
    assert.throws(() => gitLib.herdrArgv('destroy-everything', {}));
    assert.throws(() => gitLib.herdrArgv('create', { branch: 'x', shellEscape: '; rm -rf ~' }));
  });
});

describe('worktree_session_open preserves the existing tools (S25)', { concurrency: false }, () => {
  test('create, list and close keep their names, params and success texts', async () => {
    const root = makeRepo('preserve');
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      const { tools, commands } = await loadExtension();
      assert.deepEqual(
        [...tools.keys()].sort(),
        ['worktree_close', 'worktree_create', 'worktree_list', 'worktree_session_open'],
      );
      assert.deepEqual(
        Object.keys(tools.get('worktree_create').parameters.properties).sort(),
        ['branch', 'issues'],
      );
      assert.deepEqual(
        Object.keys(tools.get('worktree_close').parameters.properties).sort(),
        ['branch', 'force', 'name', 'path'],
      );
      assert.ok(tools.get('worktree_list'), 'worktree_list stays registered');
      assert.ok(commands.has('herdr-gentle:worktree'), 'the mode command stays registered');
      // List still answers the principal line when nothing else is registered.
      const listResult = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, makeCtx(root));
      assert.equal(listResult.isError, undefined);
      assert.match(resultText(listResult), /^worktree list: principal /);
    } finally {
      restoreEnv();
    }
  });
});
