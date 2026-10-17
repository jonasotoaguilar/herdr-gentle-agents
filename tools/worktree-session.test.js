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
        ['worktree_close', 'worktree_create', 'worktree_list', 'worktree_session_open', 'worktree_warp'],
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
  test('S29: an absolute PATH of a project worktree resolves (name first, then path)', async () => {
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
      // The checkout path of a registered live worktree resolves to it.
      const result = await callSessionOpen(tools, { worktree: target }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected the path to resolve, got: ${resultText(result)}`);
      assert.equal(result.details.worktree, 'feat-real', 'the path resolves to its registered row');
      assert.equal(result.details.path, target, 'the checkout path is reported');
      assert.ok(shimArgv(herdr.log).length > 0, 'herdr runs for a project path');
      // A foreign path still fails closed before any backend runs.
      const foreign = await callSessionOpen(tools, { worktree: '/tmp/wt-ou-definitely-foreign' }, makeCtx(root));
      assert.equal(foreign.isError, true, 'a foreign path fails closed');
      assert.match(resultText(foreign), /not a path|refuses a path|pass the (worktree )?name/i);
      assert.ok(resultText(foreign).includes('worktree list'), `names the listing: ${resultText(foreign)}`);
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

  test('an unregistered name preserves its exact refusal without side effects', async () => {
    const root = makeRepo('unregistered-refusal');
    const target = track(path.join(path.dirname(root), `${path.basename(root)}-ghost`));
    git(root, ['worktree', 'add', '-b', 'feat/ghost', target, 'HEAD']);
    const registry = require('../lib/worktree-registry.js');
    const registryPath = registry.registryPath(root);
    const beforeRegistry = fs.existsSync(registryPath) ? fs.readFileSync(registryPath) : null;
    const beforeLive = git(root, ['worktree', 'list', '--porcelain']);
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
      const result = await callSessionOpen(tools, { worktree: 'feat-ghost' }, makeCtx(root));
      assert.equal(result.isError, true);
      assert.equal(resultText(result), `no registered worktree for "feat-ghost": 'feat/ghost' at ${fs.realpathSync(target)} is unregistered, and neither close nor warp acts on an unregistered checkout`);
      assert.deepEqual(shimArgv(herdr.log), [], 'no backend invocation');
      assert.equal(git(root, ['worktree', 'list', '--porcelain']), beforeLive);
      assert.deepEqual(fs.existsSync(registryPath) ? fs.readFileSync(registryPath) : null, beforeRegistry);
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
      assert.deepEqual(resultText(result).split('\n'), [
        `opened: feat-by-branch · ${result.details.sessionId}`,
        `path: ${target}`,
      ]);
      assert.match(result.details.sessionId, /^[0-9a-f-]{36}$/);
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
      assert.deepEqual(resultText(result).split('\n'), [
        `opened: feat-new-sess · ${minted[1]}`,
        `path: ${target}`,
      ]);
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
      assert.deepEqual(resultText(result).split('\n'), [
        'opened: feat-resume · abc123',
        'resumed',
      ]);
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
        ['worktree_close', 'worktree_create', 'worktree_list', 'worktree_session_open', 'worktree_warp'],
      );
      assert.deepEqual(
        Object.keys(tools.get('worktree_create').parameters.properties).sort(),
        ['branch', 'issues', 'odd'],
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

// T35 (S26) tests (test-first): the finish subscription is behaviour of
// `worktree_session_open`, not a new tool. With `notify !== false` the
// open starts ONE watcher for the pane it just opened; the watcher polls
// `herdr agent get <paneId>` on a bounded interval (grace before
// anything is concluded, maximum wait) and delivers one custom message
// via `pi.sendMessage(..., {deliverAs: "followUp", triggerTurn: true})`.
//
// Each test drives the tool through its public `execute` with a fake `pi`
// carrying `sendMessage`, and answers `agent get` from per-call JSON
// fixtures selected by a counter file — so a `working` -> `idle`
// sequence is observable and the notification can be shown to fire only
// after the `idle` poll. Watch timing comes from the
// GENTLE_WORKTREE_WATCH_*_MS env overrides so tests run in milliseconds.

function agentDoc(status, paneId) {
  return { result: { agent: { agent: 'pi', agent_status: status, pane_id: paneId, tokens: {} } } };
}

function vanishedDoc(paneId) {
  return { error: { code: 'agent_not_found', message: `agent target ${paneId} not found` } };
}

function writeAgentSequence(paneId, docs) {
  assert.ok(docs.length > 0, 'a sequence needs at least one answer');
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-agentseq-')));
  docs.forEach((doc, index) => writeJson(dir, `${index + 1}.json`, doc));
  const last = path.join(dir, 'last.json');
  fs.writeFileSync(last, `${JSON.stringify(docs[docs.length - 1])}\n`);
  const count = path.join(dir, 'count');
  fs.writeFileSync(count, '0\n');
  return { dir, last, count };
}

function readAgentGetCount(countFile) {
  try {
    return Number(fs.readFileSync(countFile, 'utf8').trim());
  } catch {
    return 0;
  }
}

// Stub `herdr` with the `agent get` leg added: every invocation logs its
// argv to $HERDR_SHIM_LOG, and `agent get` answers the Nth fixture in
// $HERDR_STUB_AGENT_GET_DIR (`<n>.json`, falling back to
// $HERDR_STUB_AGENT_GET_LAST once the sequence is exhausted) while
// counting invocations in $HERDR_STUB_AGENT_GET_COUNT.
function makeWatchHerdrStub() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-watch-herdr-')));
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
      'if [ "$1" = "agent" ] && [ "$2" = "get" ]; then',
      '  if [ "${HERDR_SHIM_AGENT_GET_SLEEP:-0}" != "0" ]; then sleep "$HERDR_SHIM_AGENT_GET_SLEEP"; fi',
      '  n=$(cat "$HERDR_STUB_AGENT_GET_COUNT" 2>/dev/null || echo 0)',
      '  n=$((n + 1)); echo "$n" > "$HERDR_STUB_AGENT_GET_COUNT"',
      '  f="$HERDR_STUB_AGENT_GET_DIR/$n.json"',
      '  if [ -f "$f" ]; then cat "$f"; exit 0; fi',
      '  cat "$HERDR_STUB_AGENT_GET_LAST"; exit 0',
      'fi',
      'echo "herdr stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const log = path.join(dir, 'herdr-argv.log');
  return { bin, log };
}

async function loadExtensionWithSender(overrides = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-watch-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const sent = [];
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    on: () => () => {},
    sendMessage: overrides.sendMessage
      ? (message, options) => overrides.sendMessage(message, options, sent)
      : async (message, options) => { sent.push([message, options]); return 'msg-1'; },
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { tools, commands, mod, pi, sent };
}

function watchEnv(modeEnv, herdr, world, seq) {
  return {
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
    HERDR_BIN_PATH: herdr.bin,
    HERDR_SHIM_LOG: herdr.log,
    HERDR_STUB_WORKTREE_LIST: world.worktreeList,
    HERDR_STUB_PANE_LIST: world.paneList,
    HERDR_STUB_AGENT_GET_DIR: seq.dir,
    HERDR_STUB_AGENT_GET_COUNT: seq.count,
    HERDR_STUB_AGENT_GET_LAST: seq.last,
    GENTLE_WORKTREE_WATCH_INTERVAL_MS: '15',
    GENTLE_WORKTREE_WATCH_GRACE_MS: '20',
    GENTLE_WORKTREE_WATCH_MAX_MS: '600',
  };
}

async function waitUntil(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function watchWorld(root, branch, target, workspaceId) {
  return workspaceWorld(root, branch, target, { workspaceId });
}

describe('worktree_session_open finish subscription (S26)', { concurrency: false }, () => {
  test('idle after working reports finished, only after the idle poll', async () => {
    const root = makeRepo('watch-finished');
    const target = addRegistered(root, 'feat/watch-finished');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-watch-fin:p1';
    const world = watchWorld(root, 'feat/watch-finished', target, 'ws-watch-fin');
    const seq = writeAgentSequence(paneId, [agentDoc('working', paneId), agentDoc('idle', paneId)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-watch-finished' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const sessionId = result.details.sessionId;
      assert.deepEqual(resultText(result).split('\n'), [
        `opened: feat-watch-finished · ${sessionId}`,
        `path: ${target}`,
      ]);
      // The first poll observes `working`: a finish is impossible yet, so
      // nothing may be delivered on that poll.
      await waitUntil(() => readAgentGetCount(seq.count) >= 1, 3000, 'the first agent get poll');
      assert.equal(sent.length, 0, 'no notification fires on the working poll');
      // The second poll observes `idle` after `working`: exactly one
      // finished notification follows.
      await waitUntil(() => sent.length >= 1, 3000, 'the finished notification');
      assert.equal(sent.length, 1, 'exactly one notification is delivered');
      const [message, options] = sent[0];
      assert.equal(message.customType, 'herdr-agent-sessions.finished');
      assert.equal(message.display, true);
      assert.deepEqual(options, { deliverAs: 'followUp', triggerTurn: true });
      assert.match(message.content, /finished/);
      assert.ok(message.content.includes('feat-watch-finished'), `names the worktree: ${message.content}`);
      assert.ok(message.content.includes(paneId), `names the pane: ${message.content}`);
      assert.ok(message.content.includes(sessionId), `names the session id: ${message.content}`);
      assert.equal(message.details.outcome, 'finished');
      assert.equal(message.details.worktree, 'feat-watch-finished');
      assert.equal(message.details.paneId, paneId);
      assert.equal(message.details.sessionId, sessionId);
      // The target is the pane id, never the kind name: every `agent get`
      // names the pane the tool returned.
      for (const line of shimArgv(herdr.log).filter((entry) => entry.startsWith('agent get'))) {
        assert.equal(line, `agent get ${paneId}`, `agent get targets the pane id: ${line}`);
      }
      assert.ok(shimArgv(herdr.log).filter((entry) => entry.startsWith('agent get')).length >= 2,
        'the watcher polled past the working observation to the idle one');
      assert.equal(typeof mod.clearSessionWatchers, 'function', 'tests can clear the pane-keyed watcher registry');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('idle without ever working reports never-started, never a finish', async () => {
    const root = makeRepo('watch-never');
    const target = addRegistered(root, 'feat/watch-never');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-watch-nev:p1';
    const world = watchWorld(root, 'feat/watch-never', target, 'ws-watch-nev');
    const seq = writeAgentSequence(paneId, [agentDoc('idle', paneId), agentDoc('idle', paneId)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-watch-never' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const sessionId = result.details.sessionId;
      await waitUntil(() => sent.length >= 1, 3000, 'the never-started notification');
      assert.equal(sent.length, 1);
      const [message, options] = sent[0];
      assert.equal(message.customType, 'herdr-agent-sessions.finished');
      assert.deepEqual(options, { deliverAs: 'followUp', triggerTurn: true });
      assert.equal(message.details.outcome, 'never-started');
      assert.match(message.content, /never[- ]started/);
      assert.ok(!/^worktree session finished:/.test(message.content), `never claims a finish: ${message.content}`);
      assert.ok(message.content.includes('feat-watch-never'));
      assert.ok(message.content.includes(paneId));
      assert.ok(message.content.includes(sessionId));
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a vanished pane reports vanished, never a finish', async () => {
    const root = makeRepo('watch-vanished');
    const target = addRegistered(root, 'feat/watch-vanished');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-watch-van:p1';
    const world = watchWorld(root, 'feat/watch-vanished', target, 'ws-watch-van');
    const seq = writeAgentSequence(paneId, [vanishedDoc(paneId)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-watch-vanished' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const sessionId = result.details.sessionId;
      await waitUntil(() => sent.length >= 1, 3000, 'the vanished notification');
      assert.equal(sent.length, 1);
      const [message, options] = sent[0];
      assert.equal(message.customType, 'herdr-agent-sessions.finished');
      assert.deepEqual(options, { deliverAs: 'followUp', triggerTurn: true });
      assert.equal(message.details.outcome, 'vanished');
      assert.match(message.content, /vanished/);
      assert.ok(!/^worktree session finished:/.test(message.content), `never claims a finish: ${message.content}`);
      assert.ok(message.content.includes('feat-watch-vanished'));
      assert.ok(message.content.includes(paneId));
      assert.ok(message.content.includes(sessionId));
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('no finish within the maximum wait reports timed-out, never a finish', async () => {
    const root = makeRepo('watch-timeout');
    const target = addRegistered(root, 'feat/watch-timeout');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-watch-tmo:p1';
    const world = watchWorld(root, 'feat/watch-timeout', target, 'ws-watch-tmo');
    // The delegate keeps working: the maximum wait, not a finish, ends it.
    const seq = writeAgentSequence(paneId, [agentDoc('working', paneId)]);
    const modeEnv = scratchModeEnv();
    const env = watchEnv(modeEnv, herdr, world, seq);
    env.GENTLE_WORKTREE_WATCH_MAX_MS = '120';
    setEnv(env);
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-watch-timeout' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const sessionId = result.details.sessionId;
      await waitUntil(() => sent.length >= 1, 3000, 'the timed-out notification');
      assert.equal(sent.length, 1);
      const [message, options] = sent[0];
      assert.equal(message.customType, 'herdr-agent-sessions.finished');
      assert.deepEqual(options, { deliverAs: 'followUp', triggerTurn: true });
      assert.equal(message.details.outcome, 'timed-out');
      assert.match(message.content, /timed out/);
      assert.ok(!/^worktree session finished:/.test(message.content), `never claims a finish: ${message.content}`);
      assert.ok(message.content.includes('feat-watch-timeout'));
      assert.ok(message.content.includes(paneId));
      assert.ok(message.content.includes(sessionId));
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('notify:false starts no watcher while the default subscribes', async () => {
    const root = makeRepo('watch-notify');
    const offTarget = addRegistered(root, 'feat/watch-off');
    const onTarget = addRegistered(root, 'feat/watch-on');
    const herdr = makeWatchHerdrStub();
    const offPane = 'ws-watch-off:p1';
    const offWorld = watchWorld(root, 'feat/watch-off', offTarget, 'ws-watch-off');
    const offSeq = writeAgentSequence(offPane, [agentDoc('working', offPane), agentDoc('idle', offPane)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, offWorld, offSeq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const off = await callSessionOpen(tools, { worktree: 'feat-watch-off', notify: false }, makeCtx(root));
      assert.equal(off.isError, undefined, `expected success: ${resultText(off)}`);
      assert.equal(off.details.notify, false);
      // Even a working -> idle delegate delivers nothing: no watcher runs.
      await sleep(250);
      assert.equal(sent.length, 0, 'notify:false delivers no notification');
      assert.ok(!shimArgv(herdr.log).some((line) => line.startsWith('agent get')),
        'notify:false never polls the delegate at all');
      // The default subscribes the same way the other tests observe.
      const onPane = 'ws-watch-on:p1';
      const onWorld = watchWorld(root, 'feat/watch-on', onTarget, 'ws-watch-on');
      const onSeq = writeAgentSequence(onPane, [agentDoc('working', onPane), agentDoc('idle', onPane)]);
      setEnv({
        HERDR_STUB_WORKTREE_LIST: onWorld.worktreeList,
        HERDR_STUB_PANE_LIST: onWorld.paneList,
        HERDR_STUB_AGENT_GET_DIR: onSeq.dir,
        HERDR_STUB_AGENT_GET_COUNT: onSeq.count,
        HERDR_STUB_AGENT_GET_LAST: onSeq.last,
      });
      const on = await callSessionOpen(tools, { worktree: 'feat-watch-on' }, makeCtx(root));
      assert.equal(on.isError, undefined, `expected success: ${resultText(on)}`);
      assert.equal(on.details.notify, true);
      await waitUntil(() => sent.length >= 1, 3000, 'the default subscription notification');
      assert.equal(sent.length, 1);
      assert.equal(sent[0][0].details.outcome, 'finished');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('blocked then idle without working is never-started, never a finish', async () => {
    const root = makeRepo('watch-blocked');
    const target = addRegistered(root, 'feat/watch-blocked');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-watch-blk:p1';
    const world = watchWorld(root, 'feat/watch-blocked', target, 'ws-watch-blk');
    // `blocked` is the delegate waiting for input: it must not count as
    // the `working` observation a finish requires.
    const seq = writeAgentSequence(paneId, [
      agentDoc('blocked', paneId),
      agentDoc('blocked', paneId),
      agentDoc('idle', paneId),
    ]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-watch-blocked' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      await waitUntil(() => sent.length >= 1, 3000, 'the never-started notification');
      assert.equal(sent.length, 1);
      const [message, options] = sent[0];
      assert.equal(message.customType, 'herdr-agent-sessions.finished');
      assert.deepEqual(options, { deliverAs: 'followUp', triggerTurn: true });
      assert.equal(message.details.outcome, 'never-started');
      assert.ok(!/^worktree session finished:/.test(message.content), `a blocked delegate never finishes: ${message.content}`);
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('the T34 tool contracts still hold: exact text, nine details keys, exact agent-start argv', async () => {
    const root = makeRepo('watch-t34');
    const target = addRegistered(root, 'feat/watch-t34');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-watch-t34:p1';
    const world = watchWorld(root, 'feat/watch-t34', target, 'ws-watch-t34');
    // The delegate never answers: with production timing no poll fires
    // before the assertions below run, and the registry is cleared after.
    const seq = writeAgentSequence(paneId, [agentDoc('working', paneId)]);
    const modeEnv = scratchModeEnv();
    const env = watchEnv(modeEnv, herdr, world, seq);
    delete env.GENTLE_WORKTREE_WATCH_INTERVAL_MS;
    delete env.GENTLE_WORKTREE_WATCH_GRACE_MS;
    delete env.GENTLE_WORKTREE_WATCH_MAX_MS;
    setEnv(env);
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-watch-t34' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        `opened: feat-watch-t34 · ${result.details.sessionId}`,
        `path: ${target}`,
      ]);
      assert.deepEqual(Object.keys(result.details).sort(), [
        'agentName', 'branch', 'notify', 'paneId', 'path',
        'resumed', 'sessionId', 'workspaceId', 'worktree',
      ]);
      assert.equal(result.details.paneId, paneId);
      assert.equal(result.details.workspaceId, 'ws-watch-t34');
      assert.equal(result.details.resumed, false);
      assert.equal(result.details.agentName, 'feat-watch-t34');
      assert.equal(result.details.notify, true);
      const calls = shimArgv(herdr.log);
      const [start] = calls.filter((line) => line.startsWith('agent start'));
      assert.ok(start, 'agent start ran');
      assert.ok(start.includes('--kind pi'), `kind pi: ${start}`);
      assert.ok(start.includes(`--pane ${paneId}`), `pane: ${start}`);
      const afterDash = start.split(' -- ').slice(1).join(' -- ');
      assert.ok(afterDash.includes('--name feat-watch-t34'), `pi --name: ${afterDash}`);
      assert.match(afterDash, /--session-id [0-9a-f-]{36}/i, 'a UUID is minted');
      assert.ok(!afterDash.includes('--session-dir'), 'the pane cwd is the worktree');
      assert.equal(sent.length, 0, 'no follow-up fires synchronously with the open');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });
});

// Adversarial regressions (the verification round)
//
// Each case below is a counterexample an independent verification round
// found on a NORMAL run, or an invariant measured against the installed
// herdr: a name herdr reads as an option, an observation attributed to
// whoever holds the pane, a synchronous poll that freezes the session, a
// delivery failure that became silence, a pane list believed without
// checking it belongs to the worktree's workspace, and a root pane whose
// shell moved elsewhere.

function watchEnvWith(modeEnv, herdr, world, seq, timing = {}) {
  return {
    ...watchEnv(modeEnv, herdr, world, seq),
    GENTLE_WORKTREE_WATCH_INTERVAL_MS: String(timing.intervalMs ?? 15),
    GENTLE_WORKTREE_WATCH_GRACE_MS: String(timing.graceMs ?? 20),
    GENTLE_WORKTREE_WATCH_MAX_MS: String(timing.maxWaitMs ?? 600),
  };
}

function paneListDoc(panes) {
  return { result: { panes } };
}

function boundDoc(status, paneId, sessionId) {
  return {
    result: {
      agent: {
        agent: 'pi',
        agent_status: status,
        pane_id: paneId,
        agent_session: {
          agent: 'pi',
          kind: 'path',
          source: 'herdr:pi',
          value: `/home/someone/.pi/agent/sessions/--x--/2026-01-01T00-00-00-000Z_${sessionId}.jsonl`,
        },
      },
    },
  };
}

function startCount(log) {
  return shimArgv(log).filter((line) => line.startsWith('agent start')).length;
}

describe('worktree_session_open adversarial regressions', { concurrency: false }, () => {
  test('an agent name herdr reads as an option is refused, never a false success', async () => {
    const root = makeRepo('adv-name');
    const target = addRegistered(root, 'feat/adv-name');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-adv-name:p1';
    const world = watchWorld(root, 'feat/adv-name', target, 'ws-adv-name');
    const seq = writeAgentSequence(paneId, [agentDoc('working', paneId)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      for (const name of ['--help', '-h']) {
        const result = await callSessionOpen(tools, { worktree: 'feat-adv-name', name }, makeCtx(root));
        assert.equal(result.isError, true, `'${name}' must open nothing: ${resultText(result)}`);
        assert.match(resultText(result), /invalid agent name/);
      }
      assert.equal(startCount(herdr.log), 0, 'no agent start runs for a name herdr would read as an option');
      await sleep(120);
      assert.equal(sent.length, 0, 'a refused name subscribes to nothing');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a pane holding another session is never reported as finished', async () => {
    const root = makeRepo('adv-foreign');
    const target = addRegistered(root, 'feat/adv-foreign');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-adv-foreign:p1';
    const world = watchWorld(root, 'feat/adv-foreign', target, 'ws-adv-foreign');
    const other = '11111111-2222-3333-4444-555555555555';
    const seq = writeAgentSequence(paneId, [boundDoc('working', paneId, other), boundDoc('idle', paneId, other)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-adv-foreign' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const sessionId = result.details.sessionId;
      await waitUntil(() => sent.length >= 1, 3000, 'the notification');
      assert.equal(sent.length, 1);
      const [message] = sent[0];
      assert.notEqual(message.details.outcome, 'finished', 'another session going idle is not our finish');
      assert.ok(!/is idle after working/.test(message.content), `never claims a finish: ${message.content}`);
      assert.ok(message.content.includes(sessionId), 'names our session id');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('an idle pane bound to our own session is still a finish', async () => {
    const root = makeRepo('adv-bound');
    const target = addRegistered(root, 'feat/adv-bound');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-adv-bound:p1';
    const world = watchWorld(root, 'feat/adv-bound', target, 'ws-adv-bound');
    const seq = writeAgentSequence(paneId, [agentDoc('working', paneId)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnvWith(modeEnv, herdr, world, seq, { intervalMs: 150, graceMs: 20, maxWaitMs: 2000 }));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-adv-bound' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const sessionId = result.details.sessionId;
      // The pane now publishes the binding this plugin owns: our session file.
      fs.writeFileSync(seq.last, `${JSON.stringify(boundDoc('idle', paneId, sessionId))}\n`);
      await waitUntil(() => sent.length >= 1, 3000, 'the finish');
      assert.equal(sent.length, 1);
      assert.equal(sent[0][0].details.outcome, 'finished');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a hung herdr agent get does not freeze the session that opened the delegate', async () => {
    const root = makeRepo('adv-hung');
    const target = addRegistered(root, 'feat/adv-hung');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-adv-hung:p1';
    const world = watchWorld(root, 'feat/adv-hung', target, 'ws-adv-hung');
    const seq = writeAgentSequence(paneId, [agentDoc('working', paneId)]);
    const modeEnv = scratchModeEnv();
    setEnv({
      ...watchEnvWith(modeEnv, herdr, world, seq, { intervalMs: 15, graceMs: 10, maxWaitMs: 5000 }),
      HERDR_SHIM_AGENT_GET_SLEEP: '1',
    });
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-adv-hung' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      // While a poll is in flight the event loop keeps turning: a
      // synchronous poll would block it for the stub's whole second.
      let ticks = 0;
      const ticker = setInterval(() => { ticks += 1; }, 10);
      await sleep(400);
      clearInterval(ticker);
      assert.ok(ticks >= 20, `the event loop kept turning during a hung poll: ${ticks} ticks`);
      assert.equal(sent.length, 0, 'nothing is concluded while the poll hangs');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a delivery failure is retried, not swallowed into silence', async () => {
    const root = makeRepo('adv-retry');
    const target = addRegistered(root, 'feat/adv-retry');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-adv-retry:p1';
    const world = watchWorld(root, 'feat/adv-retry', target, 'ws-adv-retry');
    const seq = writeAgentSequence(paneId, [agentDoc('working', paneId), agentDoc('idle', paneId)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      let attempts = 0;
      const loaded = await loadExtensionWithSender({
        sendMessage: async (message, options, sent) => {
          attempts += 1;
          if (attempts === 1) throw new Error('host refused the message');
          sent.push([message, options]);
          return 'msg-2';
        },
      });
      mod = loaded.mod;
      const { tools, sent } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-adv-retry' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      await waitUntil(() => sent.length >= 1, 3000, 'the retried notification');
      assert.equal(sent.length, 1);
      assert.ok(attempts >= 2, `the failure was retried: ${attempts} attempts`);
      assert.equal(sent[0][0].details.outcome, 'finished');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a pane of another workspace is never used, even when herdr lists it first', async () => {
    const root = makeRepo('adv-prefix');
    const target = addRegistered(root, 'feat/adv-prefix');
    const herdr = makeWatchHerdrStub();
    const world = watchWorld(root, 'feat/adv-prefix', target, 'ws-ours');
    fs.writeFileSync(world.paneList, JSON.stringify(paneListDoc([
      { pane_id: 'ws-foreign:p1', workspace_id: 'ws-foreign', cwd: '/tmp/elsewhere' },
      { pane_id: 'ws-ours:p1', workspace_id: 'ws-ours', cwd: target },
    ])));
    const seq = writeAgentSequence('ws-ours:p1', [agentDoc('working', 'ws-ours:p1')]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-adv-prefix' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const start = shimArgv(herdr.log).find((line) => line.startsWith('agent start'));
      assert.ok(start && start.includes('--pane ws-ours:p1'), `the worktree's own pane is used: ${start}`);
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a pane list holding only another workspace fails closed, starting nothing', async () => {
    const root = makeRepo('adv-onlyforeign');
    const target = addRegistered(root, 'feat/adv-onlyforeign');
    const herdr = makeWatchHerdrStub();
    const world = watchWorld(root, 'feat/adv-onlyforeign', target, 'ws-ours2');
    fs.writeFileSync(world.paneList, JSON.stringify(paneListDoc([
      { pane_id: 'ws-foreign:p1', workspace_id: 'ws-foreign', cwd: '/tmp/elsewhere' },
    ])));
    const seq = writeAgentSequence('ws-ours2:p1', [agentDoc('working', 'ws-ours2:p1')]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-adv-onlyforeign' }, makeCtx(root));
      assert.equal(result.isError, true, `expected a refusal: ${resultText(result)}`);
      assert.equal(startCount(herdr.log), 0, 'nothing is started in a foreign pane');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a root pane whose shell moved elsewhere is refused, starting nothing', async () => {
    const root = makeRepo('adv-cwd');
    const target = addRegistered(root, 'feat/adv-cwd');
    const herdr = makeWatchHerdrStub();
    const world = watchWorld(root, 'feat/adv-cwd', target, 'ws-adv-cwd');
    fs.writeFileSync(world.paneList, JSON.stringify(paneListDoc([
      { pane_id: 'ws-adv-cwd:p1', workspace_id: 'ws-adv-cwd', cwd: '/tmp/not-the-worktree' },
    ])));
    const seq = writeAgentSequence('ws-adv-cwd:p1', [agentDoc('working', 'ws-adv-cwd:p1')]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const { tools } = loaded;
      const result = await callSessionOpen(tools, { worktree: 'feat-adv-cwd' }, makeCtx(root));
      assert.equal(result.isError, true, `expected a refusal: ${resultText(result)}`);
      assert.match(resultText(result), /outside the worktree/);
      assert.equal(startCount(herdr.log), 0, 'nothing is started outside the worktree');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('the docs no longer claim what the code does not enforce', async () => {
    const docs = fs.readFileSync(path.resolve(LIB_DIR, '..', 'docs', 'worktree-tools.md'), 'utf8');
    assert.ok(!docs.includes('so no command can ever run outside a'),
      'the scope sentence must not promise more than the name guard enforces');
    assert.ok(docs.includes("The pane's id must carry the worktree's workspace"),
      'the pane claim must say the id carries its workspace');
    assert.ok(docs.includes('must be the worktree or inside it'),
      'the pane cwd claim must say it is checked');
    assert.ok(!docs.includes('never `--focus`'),
      'the allowlist accepts --focus for the calls that predate the session tool');
    assert.ok(docs.includes('only ever passes\n`--no-focus`') || docs.includes('only ever passes'),
      'the --focus sentence must state what the session tool actually passes');
  });
});

// Round 2 of the same verification: two defects stayed reachable through
// the tool's own parameters (an explicit empty name, and a binding match
// that accepted any file name CONTAINING the session id), plus three the
// round could only reach with an instrumented reply.

function createWorld(root, branch, target, openReply) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-sess-create-')));
  const worktreeList = writeJson(dir, 'worktree-list.json', {
    result: { worktrees: [{ path: target, branch }] },
  });
  const openFile = writeJson(dir, 'worktree-open.json', openReply);
  return { dir, worktreeList, openFile };
}

describe('worktree_session_open adversarial regressions (round 2)', { concurrency: false }, () => {
  test('an explicit empty agent name is refused, not replaced by the worktree name', async () => {
    const root = makeRepo('adv2-empty');
    const target = addRegistered(root, 'feat/adv2-empty');
    const herdr = makeWatchHerdrStub();
    const world = watchWorld(root, 'feat/adv2-empty', target, 'ws-adv2-empty');
    const seq = writeAgentSequence('ws-adv2-empty:p1', [agentDoc('working', 'ws-adv2-empty:p1')]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const result = await callSessionOpen(loaded.tools, { worktree: 'feat-adv2-empty', name: '' }, makeCtx(root));
      assert.equal(result.isError, true, `expected a refusal: ${resultText(result)}`);
      assert.match(resultText(result), /invalid agent name/);
      assert.equal(shimArgv(herdr.log).length, 0, 'a refused name runs no herdr command at all');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a binding whose file name merely CONTAINS the session id is not a finish', async () => {
    const root = makeRepo('adv2-substr');
    const target = addRegistered(root, 'feat/adv2-substr');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-adv2-substr:p1';
    const world = watchWorld(root, 'feat/adv2-substr', target, 'ws-adv2-substr');
    const seq = writeAgentSequence(paneId, [boundDoc('working', paneId, 'xabc'), boundDoc('idle', paneId, 'xabc')]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const result = await callSessionOpen(loaded.tools, { worktree: 'feat/adv2-substr', session: 'abc' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      await waitUntil(() => loaded.sent.length >= 1, 3000, 'the outcome');
      assert.equal(loaded.sent.length, 1);
      assert.notEqual(loaded.sent[0][0].details.outcome, 'finished',
        'a file name that only contains the id is another session');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a session id that is a bare dot never claims any file as ours', async () => {
    const root = makeRepo('adv2-dot');
    const target = addRegistered(root, 'feat/adv2-dot');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-adv2-dot:p1';
    const world = watchWorld(root, 'feat/adv2-dot', target, 'ws-adv2-dot');
    const real = '9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f';
    const seq = writeAgentSequence(paneId, [boundDoc('working', paneId, real), boundDoc('idle', paneId, real)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const result = await callSessionOpen(loaded.tools, { worktree: 'feat/adv2-dot', session: '.' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      await waitUntil(() => loaded.sent.length >= 1, 3000, 'the outcome');
      assert.notEqual(loaded.sent[0][0].details.outcome, 'finished',
        'every session file name contains a dot, so a dot id must not match');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('an open reply naming a pane of another workspace is refused', async () => {
    const root = makeRepo('adv2-openpair');
    const target = addRegistered(root, 'feat/adv2-openpair');
    const herdr = makeWatchHerdrStub();
    const world = createWorld(root, 'feat/adv2-openpair', target, {
      result: { workspace: { workspace_id: 'ws-new' }, root_pane: { pane_id: 'other:p1', cwd: target } },
    });
    const seq = writeAgentSequence('ws-new:p1', [agentDoc('working', 'ws-new:p1')]);
    const modeEnv = scratchModeEnv();
    setEnv({ ...watchEnv(modeEnv, herdr, world, seq), HERDR_STUB_WORKTREE_OPEN: world.openFile });
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const result = await callSessionOpen(loaded.tools, { worktree: 'feat/adv2-openpair' }, makeCtx(root));
      assert.equal(result.isError, true, `expected a refusal: ${resultText(result)}`);
      assert.equal(startCount(herdr.log), 0, 'nothing is started in a pane of another workspace');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('an open reply whose pane cwd is outside the worktree is refused', async () => {
    const root = makeRepo('adv2-opencwd');
    const target = addRegistered(root, 'feat/adv2-opencwd');
    const herdr = makeWatchHerdrStub();
    const world = createWorld(root, 'feat/adv2-opencwd', target, {
      result: { workspace: { workspace_id: 'ws-new2' }, root_pane: { pane_id: 'ws-new2:p1', cwd: '/tmp/not-the-worktree' } },
    });
    const seq = writeAgentSequence('ws-new2:p1', [agentDoc('working', 'ws-new2:p1')]);
    const modeEnv = scratchModeEnv();
    setEnv({ ...watchEnv(modeEnv, herdr, world, seq), HERDR_STUB_WORKTREE_OPEN: world.openFile });
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const result = await callSessionOpen(loaded.tools, { worktree: 'feat/adv2-opencwd' }, makeCtx(root));
      assert.equal(result.isError, true, `expected a refusal: ${resultText(result)}`);
      assert.match(resultText(result), /outside the worktree/);
      assert.equal(startCount(herdr.log), 0, 'nothing is started outside the worktree');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a pane claiming our workspace with a foreign pane id is not chosen', async () => {
    const root = makeRepo('adv2-owner');
    const target = addRegistered(root, 'feat/adv2-owner');
    const herdr = makeWatchHerdrStub();
    const world = watchWorld(root, 'feat/adv2-owner', target, 'ws-adv2-owner');
    fs.writeFileSync(world.paneList, JSON.stringify(paneListDoc([
      { pane_id: 'other:p1', workspace_id: 'ws-adv2-owner', cwd: target },
      { pane_id: 'ws-adv2-owner:p1', workspace_id: 'ws-adv2-owner', cwd: target },
    ])));
    const seq = writeAgentSequence('ws-adv2-owner:p1', [agentDoc('working', 'ws-adv2-owner:p1')]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const result = await callSessionOpen(loaded.tools, { worktree: 'feat/adv2-owner' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const start = shimArgv(herdr.log).find((line) => line.startsWith('agent start'));
      assert.ok(start && start.includes('--pane ws-adv2-owner:p1'), `the pane id must carry its workspace: ${start}`);
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });

  test('a slow host delivers the outcome once, not once per tick', async () => {
    const root = makeRepo('adv2-slow');
    const target = addRegistered(root, 'feat/adv2-slow');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-adv2-slow:p1';
    const world = watchWorld(root, 'feat/adv2-slow', target, 'ws-adv2-slow');
    const seq = writeAgentSequence(paneId, [agentDoc('working', paneId), agentDoc('idle', paneId)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnvWith(modeEnv, herdr, world, seq, { intervalMs: 25, graceMs: 20, maxWaitMs: 3000 }));
    let mod;
    try {
      const loaded = await loadExtensionWithSender({
        sendMessage: (message, options, sent) => new Promise((resolve) => {
          setTimeout(() => {
            sent.push([message, options]);
            resolve('msg-slow');
          }, 150);
        }),
      });
      mod = loaded.mod;
      const result = await callSessionOpen(loaded.tools, { worktree: 'feat/adv2-slow' }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      await waitUntil(() => loaded.sent.length >= 1, 3000, 'the slow delivery');
      await sleep(400);
      assert.equal(loaded.sent.length, 1, 'a send still in flight is not repeated');
    } finally {
      try {
        if (mod && typeof mod.clearSessionWatchers === 'function') mod.clearSessionWatchers();
      } catch {}
      restoreEnv();
    }
  });
});

// Round 3 of the same verification: the binding matcher was still a SUFFIX
// test, so a resume id that is only an underscore-suffix of the published
// id (`session: "def"` against `..._abc_def.jsonl`) or a stem-shaped id
// claimed a finish for a different session — both on a normal resume. The
// id is now compared against the SEGMENT the file names.

describe('worktree_session_open adversarial regressions (round 3)', { concurrency: false }, () => {
  const settle = (tag, bindingId, session) => ({
    root: makeRepo(tag),
    bindingId,
    session,
  });

  async function openAndRead({ root, bindingId, session, worktree, workspaceId, paneId }) {
    const target = addRegistered(root, worktree);
    const herdr = makeWatchHerdrStub();
    const world = watchWorld(root, worktree, target, workspaceId);
    const seq = writeAgentSequence(paneId, [boundDoc('working', paneId, bindingId), boundDoc('idle', paneId, bindingId)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    const loaded = await loadExtensionWithSender();
    const result = await callSessionOpen(loaded.tools, { worktree: worktree.replace(/\//g, '-'), session }, makeCtx(root));
    if (result.isError) return { result, loaded };
    await waitUntil(() => loaded.sent.length >= 1, 3000, 'the outcome');
    return { result, loaded };
  }

  test('a session id that is only an underscore-suffix of the published id is not a finish', async () => {
    const ctx = settle('adv3-suffix', 'abc_def', 'def');
    const { result, loaded } = await openAndRead({ ...ctx, worktree: 'feat/adv3-suffix', workspaceId: 'ws-adv3-suffix', paneId: 'ws-adv3-suffix:p1' });
    try {
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.notEqual(loaded.sent[0][0].details.outcome, 'finished', 'abc_def is a different session than def');
    } finally {
      try { if (loaded.mod && loaded.mod.clearSessionWatchers) loaded.mod.clearSessionWatchers(); } catch {}
      restoreEnv();
    }
  });

  test('a session id equal to the file stem is not that file session', async () => {
    const real = '9f8e7d6c-5b4a-4938-8271-0a1b2c3d4e5f';
    const stem = `2026-01-01T00-00-00-000Z_${real}`;
    const { result, loaded } = await openAndRead({
      root: makeRepo('adv3-stem'), bindingId: real, session: stem,
      worktree: 'feat/adv3-stem', workspaceId: 'ws-adv3-stem', paneId: 'ws-adv3-stem:p1',
    });
    try {
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.notEqual(loaded.sent[0][0].details.outcome, 'finished', 'the file names the id, not the stem');
    } finally {
      try { if (loaded.mod && loaded.mod.clearSessionWatchers) loaded.mod.clearSessionWatchers(); } catch {}
      restoreEnv();
    }
  });

  test('a resume id that itself contains an underscore still matches its own file', async () => {
    const { result, loaded } = await openAndRead({
      root: makeRepo('adv3-own'), bindingId: 'abc_def', session: 'abc_def',
      worktree: 'feat/adv3-own', workspaceId: 'ws-adv3-own', paneId: 'ws-adv3-own:p1',
    });
    try {
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.equal(loaded.sent[0][0].details.outcome, 'finished', 'an id containing _ is still its own file');
    } finally {
      try { if (loaded.mod && loaded.mod.clearSessionWatchers) loaded.mod.clearSessionWatchers(); } catch {}
      restoreEnv();
    }
  });

  test('an open reply whose root pane reports another workspace is refused', async () => {
    const root = makeRepo('adv3-panews');
    const target = addRegistered(root, 'feat/adv3-panews');
    const herdr = makeWatchHerdrStub();
    const world = createWorld(root, 'feat/adv3-panews', target, {
      result: {
        workspace: { workspace_id: 'ws-new3' },
        root_pane: { pane_id: 'ws-new3:p1', cwd: target, workspace_id: 'other-ws' },
      },
    });
    const seq = writeAgentSequence('ws-new3:p1', [agentDoc('working', 'ws-new3:p1')]);
    const modeEnv = scratchModeEnv();
    setEnv({ ...watchEnv(modeEnv, herdr, world, seq), HERDR_STUB_WORKTREE_OPEN: world.openFile });
    let mod;
    try {
      const loaded = await loadExtensionWithSender();
      mod = loaded.mod;
      const result = await callSessionOpen(loaded.tools, { worktree: 'feat/adv3-panews' }, makeCtx(root));
      assert.equal(result.isError, true, `expected a refusal: ${resultText(result)}`);
      assert.equal(startCount(herdr.log), 0, 'nothing is started when the reply disagrees with itself');
    } finally {
      try { if (mod && mod.clearSessionWatchers) mod.clearSessionWatchers(); } catch {}
      restoreEnv();
    }
  });

  test('a send that never settles stops the watcher at the maximum wait', async () => {
    const root = makeRepo('adv3-hang');
    const target = addRegistered(root, 'feat/adv3-hang');
    const herdr = makeWatchHerdrStub();
    const paneId = 'ws-adv3-hang:p1';
    const world = watchWorld(root, 'feat/adv3-hang', target, 'ws-adv3-hang');
    const seq = writeAgentSequence(paneId, [agentDoc('working', paneId), agentDoc('idle', paneId)]);
    const modeEnv = scratchModeEnv();
    setEnv(watchEnv(modeEnv, herdr, world, seq));
    let mod;
    try {
      const loaded = await loadExtensionWithSender({ sendMessage: () => new Promise(() => {}) });
      mod = loaded.mod;
      assert.equal(typeof mod.startAgentSessionWatcher, 'function', 'the watcher is exported for tests');
      const timer = mod.startAgentSessionWatcher(
        {
          paneId, worktree: 'feat-adv3-hang', branch: 'feat/adv3-hang', sessionId: 'session-adv3',
          agentName: 'feat-adv3-hang', workspaceId: 'ws-adv3-hang', path: target, repoRoot: root,
        },
        { intervalMs: 25, graceMs: 10, maxWaitMs: 150 },
      );
      await sleep(700);
      // `_idleTimeout` is -1 once the interval is cleared: a host whose send
      // never settles must not leave the watcher ticking forever.
      assert.equal(timer._idleTimeout, -1, 'the watcher stopped at the maximum wait');
    } finally {
      try { if (mod && mod.clearSessionWatchers) mod.clearSessionWatchers(); } catch {}
      restoreEnv();
    }
  });
});

describe('S19: bounded session_open compact (agent text)', { concurrency: false }, () => {
  function stdEnvS19(herdr, world, modeEnv) {
    return {
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_STUB_WORKTREE_LIST: world.worktreeList,
      HERDR_STUB_PANE_LIST: world.paneList,
    };
  }

  test('fresh open returns exactly the ordered opened/path lines', async () => {
    const root = makeRepo('s19-fresh');
    const target = addRegistered(root, 'feat/s19-fresh');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/s19-fresh', target, { workspaceId: 'ws-s19-fresh' });
    const modeEnv = scratchModeEnv();
    setEnv(stdEnvS19(herdr, world, modeEnv));
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(tools, { worktree: 'feat-s19-fresh', notify: false }, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const lines = resultText(result).split('\n');
      assert.equal(lines.length, 2, `exactly two ordered lines: ${JSON.stringify(resultText(result))}`);
      assert.equal(lines[0], `opened: feat-s19-fresh · ${result.details.sessionId}`);
      assert.equal(lines[1], `path: ${target}`);
      assert.equal(result.details.path, target);
      assert.equal(result.details.resumed, false);
    } finally {
      restoreEnv();
    }
  });

  test('resume returns exactly the ordered opened/resumed lines', async () => {
    const root = makeRepo('s19-resume');
    const target = addRegistered(root, 'feat/s19-resume');
    const herdr = makeHerdrStub();
    const world = workspaceWorld(root, 'feat/s19-resume', target, { workspaceId: 'ws-s19-resume' });
    const modeEnv = scratchModeEnv();
    setEnv(stdEnvS19(herdr, world, modeEnv));
    try {
      const { tools } = await loadExtension();
      const result = await callSessionOpen(
        tools,
        { worktree: 'feat-s19-resume', session: 'abc123', notify: false },
        makeCtx(root),
      );
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        'opened: feat-s19-resume · abc123',
        'resumed',
      ]);
      assert.equal(result.details.resumed, true);
    } finally {
      restoreEnv();
    }
  });
});
