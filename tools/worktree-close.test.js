'use strict';
// P2-S4 tests (test-first): `worktree_list` + `worktree_close` in
// extensions/gentle-worktree-tools.ts.
//
// Loading pattern mirrors tools/worktree-create.test.js: the TypeScript
// extension is plain JS under the hood (// @ts-nocheck, no type
// annotations), so the test copies it to a temporary .mjs path with the
// package import lines stubbed (plus Type.Optional/Boolean for the new
// tools) and import()s it with a fake `pi` object that records
// registrations.
//
// Every test builds its own isolated fixture repository under os.tmpdir()
// (real `git init` + commits) with real linked worktrees created through
// fixed git argv. A stub `herdr` binary (node script) reached through the
// documented HERDR_BIN_PATH override records every argv line and emulates
// `worktree list` (JSON with workspace ids plus a state file mapping
// workspace -> path) and `worktree remove` (translating the workspace id
// back to a path, then running a real `git worktree remove`). A stub `gh`
// binary mirrors the create-test fixture style. Only observable behavior
// is asserted: result text, registry content inside the git common dir,
// real checkouts on disk, branch survival, and the argv the shim observed.
// The user's real checkouts are never touched; only the fixture dirs
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

function gitStatus(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

// Fresh fixture repository with one commit (including a tracked file so a
// "dirty" checkout can hold both a modification and an untracked file).
function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-close-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'hello\n');
  git(dir, ['add', 'README.md']);
  git(dir, ['commit', '-m', 'init']);
  return fs.realpathSync(dir);
}

// Stub `gh` mirroring the create-test fixture style (unused by the list /
// close paths, which never verify issues, but kept so the fixture matches).
function makeGhStub(knownIssues) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-gh-')));
  const bin = path.join(dir, 'gh');
  const cases = knownIssues
    .map((n) => `    ${n}) printf '{"number":${n},"title":"Test issue ${n}","state":"OPEN"}\\n'; exit 0;;`)
    .join('\n');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
      '  case "$3" in',
      cases,
      '    *) echo "could not resolve to an Issue" >&2; exit 1;;',
      '  esac',
      'fi',
      'echo "gh stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return bin;
}

// Stub `herdr` as a node script: logs every argv line to $HERDR_SHIM_LOG,
// then emulates `worktree list` (real `git worktree list`, re-emitted as
// the JSON shape the real CLI prints, with deterministic workspace ids
// ws-<n> by sorted path, plus a JSON workspace->path map at
// $HERDR_SHIM_STATE) and `worktree remove` (workspace id back to a path,
// then a real `git worktree remove [--force]` run from the main checkout
// so git's own dirty refusal surfaces verbatim). $HERDR_SHIM_EXIT != 0
// makes every invocation fail.
const HERDR_STUB_SRC = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const EOL = String.fromCharCode(10);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_SHIM_LOG, argv.join(' ') + EOL);
function fail(msg) { console.error(msg); process.exit(1); }
if (process.env.HERDR_SHIM_EXIT && process.env.HERDR_SHIM_EXIT !== '0') fail('herdr shim failure');
const scope = argv[0];
const op = argv[1];
const rest = argv.slice(2);
function flag(name) {
  const i = rest.indexOf(name);
  if (i < 0 || i + 1 >= rest.length) return null;
  return rest[i + 1];
}
if (scope !== 'worktree') fail('herdr stub: unexpected argv ' + argv.join(' '));
if (op === 'list') {
  const cwd = flag('--cwd');
  if (!cwd) fail('herdr stub list: missing --cwd');
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: cwd, encoding: 'utf8' });
  if (r.status !== 0) fail('herdr stub list: git failed');
  const records = [];
  let cur = null;
  const lines = r.stdout.split(EOL);
  for (const line of lines) {
    if (line.indexOf('worktree ') === 0) {
      if (cur && cur.path) records.push(cur);
      cur = { path: line.slice(9), branch: null };
    } else if (cur && line.indexOf('branch ') === 0) {
      const ref = line.slice(7);
      cur.branch = ref.indexOf('refs/heads/') === 0 ? ref.slice(11) : ref;
    } else if (line === '' && cur && cur.path) {
      records.push(cur);
      cur = null;
    }
  }
  if (cur && cur.path) records.push(cur);
  records.sort(function (a, b) { return a.path < b.path ? -1 : a.path > b.path ? 1 : 0; });
  const map = {};
  const worktrees = records.map(function (rec, i) {
    const id = 'ws-' + i;
    map[id] = rec.path;
    return { path: rec.path, branch: rec.branch, open_workspace_id: id };
  });
  fs.writeFileSync(process.env.HERDR_SHIM_STATE, JSON.stringify(map));
  console.log(JSON.stringify({ result: { worktrees: worktrees } }));
  process.exit(0);
}
if (op === 'remove') {
  const ws = flag('--workspace');
  const force = rest.indexOf('--force') >= 0;
  if (!ws) fail('herdr stub remove: missing --workspace');
  let map = null;
  try { map = JSON.parse(fs.readFileSync(process.env.HERDR_SHIM_STATE, 'utf8')); } catch (e) { map = null; }
  if (!map) fail('herdr stub remove: no state');
  const target = map[ws];
  if (!target) fail('herdr stub remove: unknown workspace ' + ws);
  const l = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: target, encoding: 'utf8' });
  let main = null;
  if (l.status === 0) {
    const ls = l.stdout.split(EOL);
    for (const line of ls) {
      if (line.indexOf('worktree ') === 0) { main = line.slice(9); break; }
    }
  }
  if (!main) fail('herdr stub remove: cannot locate main checkout');
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(target);
  const r = spawnSync('git', args, { cwd: main, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status === null || r.status === undefined ? 1 : r.status);
}
fail('herdr stub: unexpected argv ' + argv.join(' '));
`;

function makeHerdrStub() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-herdr-')));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, HERDR_STUB_SRC, { mode: 0o755 });
  return { bin, log: path.join(dir, 'herdr-argv.log'), state: path.join(dir, 'herdr-state.json') };
}

function shimArgv(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function commonDirOf(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
}

function livePaths(root) {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function branchExists(root, branch) {
  const result = gitStatus(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
  return result.status === 0;
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

// Isolated mode state per test: missing file means enabled.
function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-mode-'))) };
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = { registerTool: (tool) => { tools.set(tool.name, tool); } };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
}

function makeCtx({ repoRoot, hasUI = false, confirm = true }) {
  const confirms = [];
  const ctx = {
    cwd: repoRoot,
    hasUI,
    mode: 'tui',
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: {
      confirm: async (title, message) => {
        confirms.push([title, message]);
        return confirm;
      },
      notify: () => {},
    },
  };
  return { ctx, confirms };
}

async function callList(tools, params, ctx) {
  const tool = tools.get('worktree_list');
  assert.ok(tool, 'expected worktree_list to be registered');
  return tool.execute('call-1', params, undefined, undefined, ctx);
}

async function callClose(tools, params, ctx) {
  const tool = tools.get('worktree_close');
  assert.ok(tool, 'expected worktree_close to be registered');
  return tool.execute('call-1', params, undefined, undefined, ctx);
}

// Register a linked worktree directly (real checkout + registry entry, no
// creation hooks), returning its absolute path. `dirty: true` leaves a
// modified tracked file plus an untracked file behind.
function addRegistered(root, branch, { thread = 'thread-1', issues = [35], dirty = false } = {}) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-wt-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const registryLib = require('../lib/worktree-registry.js');
  const stored = registryLib.upsertWorktree(root, {
    branch, path: target, thread, issues, odd: [],
  });
  assert.equal(stored.ok, true);
  if (dirty) {
    fs.appendFileSync(path.join(target, 'README.md'), 'local edit\n');
    fs.writeFileSync(path.join(target, 'scratch.txt'), 'untracked\n');
  }
  return fs.realpathSync(target);
}

// An unregistered live checkout: real, but the registry never hears of it.
function addUnregistered(root, branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-wt-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  return fs.realpathSync(target);
}

function registryBytes(root) {
  const registryLib = require('../lib/worktree-registry.js');
  try {
    return fs.readFileSync(registryLib.registryPath(root));
  } catch {
    return null;
  }
}

function registryLeftovers(root) {
  return fs.readdirSync(commonDirOf(root)).filter((name) => name !== 'pi-worktrees.json'
    && (name.startsWith('pi-worktrees.json.tmp') || name === 'pi-worktrees.lock'));
}

function stdEnv(overrides) {
  const herdr = overrides.herdr;
  const modeEnv = overrides.modeEnv;
  return {
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
    HERDR_BIN_PATH: herdr.bin,
    HERDR_SHIM_LOG: herdr.log,
    HERDR_SHIM_STATE: herdr.state,
    HERDR_SHIM_EXIT: undefined,
    GH_BIN_PATH: overrides.gh,
    GENTLE_WORKTREE_THREAD: undefined,
  };
}

describe('worktree_list registration', { concurrency: false }, () => {
  test('registers all three tools with the expected parameter shapes', async () => {
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const tools = await loadExtension();
      assert.deepEqual([...tools.keys()].sort(), ['worktree_close', 'worktree_create', 'worktree_list', 'worktree_session_open', 'worktree_warp']);
      const listParams = tools.get('worktree_list').parameters;
      assert.deepEqual(Object.keys(listParams.properties), ['all']);
      assert.equal(listParams.properties.all.type, 'boolean');
      const closeParams = tools.get('worktree_close').parameters;
      assert.deepEqual(Object.keys(closeParams.properties).sort(), ['branch', 'force', 'name', 'path']);
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_list output', { concurrency: false }, () => {
  test('an empty registry lists exactly the principal line (`none` is retired)', async () => {
    const root = makeRepo('list-empty');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      // S19 retires `worktree list: none`: with no agent worktrees the
      // output is exactly the principal line.
      const branch = git(root, ['branch', '--show-current']);
      const expected = `worktree list: principal ${branch} principal`;
      const plain = await callList(tools, {}, ctx);
      assert.equal(plain.isError, undefined);
      assert.equal(resultText(plain), expected);
      const withAll = await callList(tools, { all: true }, ctx);
      assert.equal(withAll.isError, undefined);
      assert.equal(resultText(withAll), expected);
      // Listing never creates the registry file.
      assert.equal(registryBytes(root), null);
    } finally {
      restoreEnv();
    }
  });

  test('registered live worktrees list one exact line each, in registry order', async () => {
    const root = makeRepo('list-reg');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35, 7]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const first = addRegistered(root, 'feat/one', { thread: 'thread-1', issues: [35] });
      const second = addRegistered(root, 'feat/two', { thread: 'thread-2', issues: [35, 7] });
      const before = registryBytes(root);
      assert.ok(before, 'expected a registry file to exist');

      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callList(tools, {}, ctx);
      assert.equal(result.isError, undefined);
      const branch = git(root, ['branch', '--show-current']);
      assert.equal(
        resultText(result),
        `worktree list: principal ${branch} principal\n`
        + `worktree list: feat-one feat/one thread=thread-1 issues=35\n`
        + `worktree list: feat-two feat/two thread=thread-2 issues=35,7`,
      );
      // The list never mutates the registry file and leaves no lock behind.
      assert.deepEqual(registryBytes(root), before);
      assert.deepEqual(registryLeftovers(root), []);
    } finally {
      restoreEnv();
    }
  });

  test('a registered path deleted out of band is excluded from the listing and pruned (S16)', async () => {
    const root = makeRepo('list-drift');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/drifted', { thread: 'thread-1', issues: [35] });
      git(root, ['worktree', 'remove', target]);
      assert.ok(!livePaths(root).includes(target), 'the checkout is really gone');

      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callList(tools, {}, ctx);
      assert.equal(result.isError, undefined);
      // S16 self-heal: nothing registered and real, so the listing is the
      // principal line alone — and the dead row is pruned from the
      // registry, named in details.pruned and in the warning (which also
      // says git may still record the checkout until `git worktree prune`).
      const branch = git(root, ['branch', '--show-current']);
      assert.equal(resultText(result), `worktree list: principal ${branch} principal`);
      assert.deepEqual(result.details.worktrees.map((item) => item.kind), ['principal']);
      assert.deepEqual(result.details.pruned, [target]);
      assert.ok(
        result.details.warnings.join('\n').includes(target),
        `the warning names the pruned path: ${JSON.stringify(result.details.warnings)}`,
      );
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/drifted'), null);
      assert.deepEqual(registryLib.readRegistry(root).worktrees, []);
    } finally {
      restoreEnv();
    }
  });

  test('an unregistered live checkout only appears when `all` is requested', async () => {
    const root = makeRepo('list-all');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const known = addRegistered(root, 'feat/known', { thread: 'thread-1', issues: [35] });
      const ghost = addUnregistered(root, 'feat/ghost');
      const before = registryBytes(root);

      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const branch = git(root, ['branch', '--show-current']);
      const plain = await callList(tools, {}, ctx);
      assert.equal(
        resultText(plain),
        `worktree list: principal ${branch} principal\n`
        + `worktree list: feat-known feat/known thread=thread-1 issues=35`,
      );
      const all = await callList(tools, { all: true }, ctx);
      assert.equal(
        resultText(all),
        `worktree list: principal ${branch} principal\n`
        + `worktree list: feat-known feat/known thread=thread-1 issues=35\n`
        + `worktree list: feat-ghost feat/ghost unregistered`,
      );
      assert.deepEqual(registryBytes(root), before, 'listing never mutates the registry');
    } finally {
      restoreEnv();
    }
  });

  test('a disabled or malformed mode file refuses the list', async () => {
    const root = makeRepo('list-mode');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeLib = require('../lib/worktree-mode.js');
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      addRegistered(root, 'feat/gated', { thread: 'thread-1', issues: [35] });
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });

      modeLib.writeMode(false, process.env);
      const disabled = await callList(tools, {}, ctx);
      assert.equal(disabled.isError, true);
      assert.ok(
        resultText(disabled).includes('/herdr-gentle:worktree enabled'),
        `names the toggle: ${resultText(disabled)}`,
      );

      fs.writeFileSync(modeLib.modePath(process.env), '{ malformed {{{');
      const malformed = await callList(tools, { all: true }, ctx);
      assert.equal(malformed.isError, true, 'malformed mode never enables');
      assert.ok(
        resultText(malformed).includes('/herdr-gentle:worktree enabled'),
        `names the toggle: ${resultText(malformed)}`,
      );
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree_close', { concurrency: false }, () => {
  test('closing by branch removes the checkout, keeps the branch, drops the entry', async () => {
    const root = makeRepo('close-branch');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/bye', { thread: 'thread-1', issues: [35] });
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { branch: 'feat/bye' }, ctx);

      assert.equal(result.isError, undefined);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-bye · feat/bye',
        'branch kept',
      ]);
      assert.deepEqual(result.details, {
        path: target, branch: 'feat/bye', removed: true, branchKept: true, thread: 'thread-1',
      });
      // The checkout is gone but the branch survives.
      assert.ok(!livePaths(root).includes(target), 'checkout removed');
      assert.equal(fs.existsSync(target), false);
      assert.equal(branchExists(root, 'feat/bye'), true, 'the branch is kept');
      // The registry entry is gone.
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/bye'), null);
      assert.deepEqual(registryLib.readRegistry(root).worktrees, []);
      // herdr listed first (workspace resolution), then removed by id with
      // fixed argv: separate elements, never --flag=value, never
      // --trust-repository, never --force, never --focus.
      const calls = shimArgv(herdr.log);
      const listAt = calls.findIndex((line) => line.startsWith('worktree list '));
      const removeAt = calls.findIndex((line) => line.startsWith('worktree remove '));
      assert.ok(listAt >= 0, `herdr list ran: ${JSON.stringify(calls)}`);
      assert.ok(removeAt > listAt, `remove runs after list: ${JSON.stringify(calls)}`);
      assert.ok(calls[listAt].includes(`--cwd ${root}`), `list pins the repo: ${calls[listAt]}`);
      const tokens = calls[removeAt].split(' ');
      assert.ok(tokens.includes('--workspace'), `workspace by id: ${calls[removeAt]}`);
      assert.ok(/ws-\d+/.test(calls[removeAt]), `workspace id value: ${calls[removeAt]}`);
      assert.ok(!calls[removeAt].includes('='), `never --flag=value: ${calls[removeAt]}`);
      assert.ok(!calls[removeAt].includes('trust'), `never --trust-repository: ${calls[removeAt]}`);
      assert.ok(!tokens.includes('--force'), `never --force unless requested: ${calls[removeAt]}`);
      assert.ok(!tokens.includes('--focus'), `never --focus: ${calls[removeAt]}`);
    } finally {
      restoreEnv();
    }
  });

  test('closing by path resolves the same registered entry', async () => {
    const root = makeRepo('close-path');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/by-path', { thread: 'thread-1', issues: [35] });
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { path: target }, ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-by-path · feat/by-path',
        'branch kept',
      ]);
      assert.deepEqual(result.details, {
        path: target, branch: 'feat/by-path', removed: true, branchKept: true, thread: 'thread-1',
      });
      assert.ok(!livePaths(root).includes(target));
      assert.equal(branchExists(root, 'feat/by-path'), true);
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/by-path'), null);
    } finally {
      restoreEnv();
    }
  });

  test('a call with neither path nor branch is rejected with no mutation', async () => {
    const root = makeRepo('close-neither');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/stays', { thread: 'thread-1', issues: [35] });
      const beforeLive = livePaths(root);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      for (const params of [{}, { force: true }, { path: '', branch: '' }]) {
        const refused = await callClose(tools, params, ctx);
        assert.equal(refused.isError, true, `expected rejection: ${JSON.stringify(params)}`);
        assert.match(resultText(refused), /path or.*branch|branch.*or.*path/i);
      }
      assert.deepEqual(livePaths(root), beforeLive, 'no checkout touched');
      assert.deepEqual(registryBytes(root), beforeRegistry, 'registry untouched');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr never invoked');
      assert.ok(livePaths(root).includes(target));
    } finally {
      restoreEnv();
    }
  });

  test('an unregistered target is refused with candidates and no mutation', async () => {
    const root = makeRepo('close-unknown');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/known-target', { thread: 'thread-1', issues: [35] });
      const ghost = addUnregistered(root, 'feat/ghost');
      const beforeLive = livePaths(root);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });

      const byBranch = await callClose(tools, { branch: 'feat/nope' }, ctx);
      assert.equal(byBranch.isError, true);
      assert.match(resultText(byBranch), /no registered worktree/i);
      assert.ok(
        resultText(byBranch).includes('feat/known-target'),
        `names the closest candidate: ${resultText(byBranch)}`,
      );

      const byPath = await callClose(tools, { path: ghost }, ctx);
      assert.equal(byPath.isError, true, 'a live but unregistered checkout is never removed');
      assert.match(resultText(byPath), /no registered worktree/i);

      const byName = await callClose(tools, { name: 'feat-ghost' }, ctx);
      assert.equal(byName.isError, true);
      assert.equal(resultText(byName), `no registered worktree for "feat-ghost": 'feat/ghost' at ${ghost} is unregistered, and neither close nor warp acts on an unregistered checkout`);

      // Nothing moved: both checkouts live, registry identical, herdr idle.
      assert.deepEqual(livePaths(root), beforeLive);
      assert.deepEqual(registryBytes(root), beforeRegistry);
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr never invoked');
      assert.ok(livePaths(root).includes(target));
      assert.ok(livePaths(root).includes(ghost));
    } finally {
      restoreEnv();
    }
  });

  test('a dirty checkout without force is refused with the repository reason', async () => {
    const root = makeRepo('close-dirty');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/dirty', { thread: 'thread-1', issues: [35], dirty: true });
      const beforeLive = livePaths(root);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const refused = await callClose(tools, { branch: 'feat/dirty' }, ctx);
      assert.equal(refused.isError, true);
      assert.match(resultText(refused), /modified or untracked files|use --force/i);
      // Both the checkout and the registry entry survive untouched.
      assert.deepEqual(livePaths(root), beforeLive);
      assert.deepEqual(registryBytes(root), beforeRegistry);
      assert.ok(livePaths(root).includes(target));
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/dirty').path, target);
      assert.equal(fs.readFileSync(path.join(target, 'scratch.txt'), 'utf8'), 'untracked\n');
    } finally {
      restoreEnv();
    }
  });

  test('S21: a tool-created checkout with no env files closes WITHOUT force', async () => {
    // S21 removed every symlink step from the creation hooks, so a
    // fixture with no .env files, no lockfiles and no `codegraph` binary
    // yields a clean checkout: git's own dirty refusal never fires and no
    // --force is needed. (With env copies or a `codegraph init` laying
    // down untracked files, force is still required.) PATH is filtered so
    // any installed `codegraph` cannot dirty the fixture.
    const root = makeRepo('close-clean-created');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    const cleanPath = String(process.env.PATH || '').split(path.delimiter).filter((dir) => {
      try {
        fs.accessSync(path.join(dir, 'codegraph'), fs.constants.X_OK);
        return false;
      } catch {
        return true;
      }
    }).join(path.delimiter);
    setEnv({ ...stdEnv({ herdr, gh, modeEnv }), PATH: cleanPath });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const created = await tools.get('worktree_create').execute(
        'call-1', { branch: 'feat/clean-close', issues: [35] }, undefined, undefined, ctx,
      );
      assert.equal(created.isError, undefined, `setup create failed: ${resultText(created)}`);
      const target = created.details.path;
      assert.equal(fs.existsSync(path.join(target, 'odd')), false, 'no hook-created odd symlink dirties the checkout');
      const result = await callClose(tools, { branch: 'feat/clean-close' }, ctx);
      assert.equal(result.isError, undefined, `clean tool-created checkout closes without force, got: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-clean-close · feat/clean-close',
        'branch kept',
      ]);
      assert.ok(!livePaths(root).includes(target), 'checkout removed');
      assert.equal(branchExists(root, 'feat/clean-close'), true, 'the branch is kept');
      const calls = shimArgv(herdr.log);
      const removeLine = calls.find((line) => line.startsWith('worktree remove '));
      assert.ok(removeLine, `herdr remove ran: ${JSON.stringify(calls)}`);
      assert.ok(!removeLine.split(' ').includes('--force'), `no --force was passed: ${removeLine}`);
    } finally {
      restoreEnv();
    }
  });

  test('force closes a dirty checkout and passes --force as a separate element', async () => {
    const root = makeRepo('close-force');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/force-me', { thread: 'thread-1', issues: [35], dirty: true });
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { branch: 'feat/force-me', force: true }, ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-force-me · feat/force-me',
        'branch kept',
      ]);
      assert.deepEqual(result.details, {
        path: target, branch: 'feat/force-me', removed: true, branchKept: true, thread: 'thread-1',
      });
      assert.ok(!livePaths(root).includes(target), 'dirty checkout removed');
      assert.equal(branchExists(root, 'feat/force-me'), true, 'the branch is kept');
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/force-me'), null);
      const calls = shimArgv(herdr.log);
      const removeLine = calls.find((line) => line.startsWith('worktree remove '));
      assert.ok(removeLine, `herdr remove ran: ${JSON.stringify(calls)}`);
      assert.ok(removeLine.split(' ').includes('--force'), `separate --force: ${removeLine}`);
      assert.ok(!removeLine.includes('='), `never --flag=value: ${removeLine}`);
      assert.ok(!removeLine.includes('trust'), `never --trust-repository: ${removeLine}`);
    } finally {
      restoreEnv();
    }
  });

  test('a declined approval cancels with no mutation and no registry change', async () => {
    const root = makeRepo('close-decline');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/keep-me', { thread: 'thread-1', issues: [35] });
      const beforeLive = livePaths(root);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, hasUI: true, confirm: false });
      const result = await callClose(tools, { branch: 'feat/keep-me' }, ctx);
      assert.equal(result.isError, true);
      assert.match(resultText(result), /cancel/i);
      assert.equal(result.details.cancelled, true);
      assert.deepEqual(livePaths(root), beforeLive, 'checkout untouched');
      assert.deepEqual(registryBytes(root), beforeRegistry, 'registry untouched');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr never invoked');
      assert.ok(livePaths(root).includes(target));
    } finally {
      restoreEnv();
    }
  });

  test('an approved confirmation names path, branch, and that the branch is kept', async () => {
    const root = makeRepo('close-approve');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/approved-close', { thread: 'thread-1', issues: [35] });
      const tools = await loadExtension();
      const { ctx, confirms } = makeCtx({ repoRoot: root, hasUI: true, confirm: true });
      const result = await callClose(tools, { branch: 'feat/approved-close' }, ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-approved-close · feat/approved-close',
        'branch kept',
      ]);
      assert.equal(confirms.length, 1);
      const [title, message] = confirms[0];
      assert.ok(title.includes('feat/approved-close'), `title names the branch: ${title}`);
      assert.ok(message.includes(target), `message names the path: ${message}`);
      assert.ok(message.includes('feat/approved-close'), `message names the branch: ${message}`);
      assert.match(message, /kept|keep|surviv/i, `message says the branch survives: ${message}`);
    } finally {
      restoreEnv();
    }
  });

  test('a disabled or malformed mode file refuses the close with no mutation', async () => {
    const root = makeRepo('close-mode');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeLib = require('../lib/worktree-mode.js');
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/gated-close', { thread: 'thread-1', issues: [35] });
      const beforeLive = livePaths(root);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });

      modeLib.writeMode(false, process.env);
      const disabled = await callClose(tools, { branch: 'feat/gated-close' }, ctx);
      assert.equal(disabled.isError, true);
      assert.ok(
        resultText(disabled).includes('/herdr-gentle:worktree enabled'),
        `names the toggle: ${resultText(disabled)}`,
      );

      fs.writeFileSync(modeLib.modePath(process.env), '{ malformed {{{');
      const malformed = await callClose(tools, { branch: 'feat/gated-close' }, ctx);
      assert.equal(malformed.isError, true, 'malformed mode never enables');
      assert.ok(
        resultText(malformed).includes('/herdr-gentle:worktree enabled'),
        `names the toggle: ${resultText(malformed)}`,
      );

      assert.deepEqual(livePaths(root), beforeLive, 'checkout untouched');
      assert.deepEqual(registryBytes(root), beforeRegistry, 'registry untouched');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr never invoked');
      assert.ok(livePaths(root).includes(target));
    } finally {
      restoreEnv();
    }
  });

  test('an unavailable herdr falls back to `git worktree remove` and keeps the branch', async () => {
    const root = makeRepo('close-fallback');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      ...stdEnv({ herdr, gh, modeEnv }),
      HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-xyz'),
    });
    try {
      const target = addRegistered(root, 'feat/fallback-close', { thread: 'thread-1', issues: [35] });
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { branch: 'feat/fallback-close' }, ctx);
      assert.equal(result.isError, undefined);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-fallback-close · feat/fallback-close',
        'branch kept',
      ]);
      assert.deepEqual(result.details, {
        path: target, branch: 'feat/fallback-close', removed: true, branchKept: true, thread: 'thread-1',
      });
      assert.ok(!livePaths(root).includes(target), 'checkout removed via git');
      assert.equal(branchExists(root, 'feat/fallback-close'), true, 'the branch is kept');
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/fallback-close'), null);
      assert.equal(fs.existsSync(herdr.log), false, 'herdr was never invoked');
    } finally {
      restoreEnv();
    }
  });
});

describe('F4: vanished checkout named even when the post-removal listing fails', { concurrency: false }, () => {
  function makeFailingListGitShim({ root, victim, exitCode }) {
    const which = spawnSync('which', ['git'], { encoding: 'utf8' });
    assert.equal(which.status, 0);
    const realGit = which.stdout.trim();
    const shimDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-f4-gitshim-')));
    const marker = path.join(shimDir, 'removed.marker');
    fs.writeFileSync(path.join(shimDir, 'git'), [
      '#!/bin/sh',
      'case "$*" in',
      '  *"worktree list"*)',
      `    if [ -f "${marker}" ]; then echo "git worktree list failed: boom" >&2; exit 1; fi`,
      '    exec "$REAL_GIT" "$@";;',
      '  *"worktree remove"*)',
      `    "$REAL_GIT" -C "${root}" worktree remove --force "${victim}" >/dev/null 2>&1`,
      `    touch "${marker}"`,
      '    echo "lying remover failed" >&2',
      `    exit ${exitCode};;`,
      '  *) exec "$REAL_GIT" "$@";;',
      'esac',
      '',
    ].join('\n'), { mode: 0o755 });
    return { shimDir, realGit };
  }

  test('exit 0 with post-list failing names the vanished path, registry unchanged', async () => {
    const root = makeRepo('f4-zero');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    const dirV = path.join(path.dirname(root), `${path.basename(root)}-victim`);
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-victim', dirV, 'HEAD']);
    git(root, ['worktree', 'add', '-b', 'feat-target', dirT, 'HEAD']);
    const realV = fs.realpathSync(dirV); track(realV);
    const realT = fs.realpathSync(dirT); track(realT);
    const registryLib = require('../lib/worktree-registry.js');
    assert.equal(registryLib.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    const beforeBytes = registryBytes(root);
    const shim = makeFailingListGitShim({ root, victim: realV, exitCode: 0 });
    const savedPath = process.env.PATH;
    setEnv({
      ...stdEnv({ herdr, gh, modeEnv }),
      HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-f4'),
      PATH: `${shim.shimDir}${path.delimiter}${savedPath}`,
      REAL_GIT: shim.realGit,
    });
    // The shim reads REAL_GIT from its own env: re-export explicitly.
    process.env.REAL_GIT = shim.realGit;
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { path: realT, force: true }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, true, `expected loud failure, got: ${text}`);
      assert.ok(text.includes(realV), `error names the vanished path ${realV}: ${text}`);
      assert.deepEqual(registryBytes(root), beforeBytes, 'registry bytes unchanged (entry kept)');
    } finally {
      delete process.env.REAL_GIT;
      restoreEnv();
    }
  });

  test('non-zero exit with post-list failing names the vanished path, registry unchanged', async () => {
    const root = makeRepo('f4-nonzero');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    const dirV = path.join(path.dirname(root), `${path.basename(root)}-victim`);
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-victim', dirV, 'HEAD']);
    git(root, ['worktree', 'add', '-b', 'feat-target', dirT, 'HEAD']);
    const realV = fs.realpathSync(dirV); track(realV);
    const realT = fs.realpathSync(dirT); track(realT);
    const registryLib = require('../lib/worktree-registry.js');
    assert.equal(registryLib.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    const beforeBytes = registryBytes(root);
    const shim = makeFailingListGitShim({ root, victim: realV, exitCode: 1 });
    const savedPath = process.env.PATH;
    setEnv({
      ...stdEnv({ herdr, gh, modeEnv }),
      HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-f4'),
      PATH: `${shim.shimDir}${path.delimiter}${savedPath}`,
    });
    process.env.REAL_GIT = shim.realGit;
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { path: realT, force: true }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, true, `expected loud failure, got: ${text}`);
      assert.ok(text.includes(realV), `error names the vanished path ${realV}, not a bare failure: ${text}`);
      assert.deepEqual(registryBytes(root), beforeBytes, 'registry bytes unchanged (entry kept)');
    } finally {
      delete process.env.REAL_GIT;
      restoreEnv();
    }
  });
});

describe('H2: a file at a path is never a live checkout in the close', { concurrency: false }, () => {
  test('a checkout replaced by a file is stale, the entry is kept and nothing is removed', async () => {
    const root = makeRepo('h2-file-close');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/filed', { thread: 'thread-1', issues: [35] });
      // The checkout directory becomes a FILE git still records: the same
      // path list reports `missing` must never read `live` here either.
      fs.rmSync(target, { recursive: true, force: true });
      fs.writeFileSync(target, 'not a checkout\n');
      assert.ok(livePaths(root).includes(target), 'git still records the path');
      const beforeRegistry = registryBytes(root);

      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { branch: 'feat/filed', force: true }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, true, `a file is never a live checkout, got: ${text}`);
      assert.match(text, /not a live checkout.*stale registry entry/i, `the stale entry is named and kept: ${text}`);
      assert.deepEqual(registryBytes(root), beforeRegistry, 'registry untouched: the row stays for inspection');
      assert.ok(fs.existsSync(target), 'the file is left alone');
    } finally {
      restoreEnv();
    }
  });
});

describe('S24: worktree_close accepts name (T33 RED)', { concurrency: false }, () => {
  test('closing by name removes the checkout, keeps the branch, drops the entry', async () => {
    const root = makeRepo('close-name');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/by-name', { thread: 'thread-1', issues: [35] });
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { name: 'feat-by-name' }, ctx);
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-by-name · feat/by-name',
        'branch kept',
      ]);
      assert.ok(!livePaths(root).includes(target), 'checkout removed');
      assert.equal(branchExists(root, 'feat/by-name'), true, 'the branch is kept');
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/by-name'), null);
    } finally {
      restoreEnv();
    }
  });

  test('an unknown name fails closed naming the closest names, nothing moves', async () => {
    const root = makeRepo('close-unknown-name');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/known-target', { thread: 'thread-1', issues: [35] });
      const beforeLive = livePaths(root);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const refused = await callClose(tools, { name: 'feat-nope' }, ctx);
      assert.equal(refused.isError, true, 'unknown name is an error');
      assert.match(resultText(refused), /no registered worktree for "feat-nope"/);
      assert.ok(resultText(refused).includes('feat-known-target'), `names the closest names: ${resultText(refused)}`);
      assert.deepEqual(livePaths(root), beforeLive, 'no checkout touched');
      assert.deepEqual(registryBytes(root), beforeRegistry, 'registry untouched');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr never invoked');
      assert.ok(livePaths(root).includes(target));
    } finally {
      restoreEnv();
    }
  });

  test('two rows flattening to one name are ambiguous and fail closed naming both', async () => {
    const root = makeRepo('close-ambiguous');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const first = addRegistered(root, 'feat/amb', { thread: 'thread-1', issues: [35] });
      // A second branch flattening to the same slug, registered by hand.
      const slug = 'feat-amb';
      const other = path.join(path.dirname(root), `${path.basename(root)}-wt-${slug}-other`);
      track(other);
      git(root, ['worktree', 'add', '-b', 'feat-amb', other, 'HEAD']);
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.appendWorktree(root, {
        branch: 'feat-amb', path: fs.realpathSync(other), thread: 'thread-2', issues: [7], odd: [],
      }).ok, true);
      const beforeLive = livePaths(root);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const refused = await callClose(tools, { name: 'feat-amb' }, ctx);
      assert.equal(refused.isError, true, 'ambiguous name never picks one');
      assert.match(resultText(refused), /ambiguous/i);
      assert.ok(resultText(refused).includes('feat/amb'), `names the first row: ${resultText(refused)}`);
      assert.ok(resultText(refused).includes('feat-amb'), `names the second row: ${resultText(refused)}`);
      assert.deepEqual(livePaths(root), beforeLive, 'no checkout touched');
      assert.deepEqual(registryBytes(root), beforeRegistry, 'registry untouched');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr never invoked');
      assert.ok(livePaths(root).includes(first));
    } finally {
      restoreEnv();
    }
  });

  test('name combined with path or branch is rejected: pass only one', async () => {
    const root = makeRepo('close-name-exclusive');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      addRegistered(root, 'feat/solo', { thread: 'thread-1', issues: [35] });
      const beforeLive = livePaths(root);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      for (const params of [{ name: 'feat-solo', path: 'x' }, { name: 'feat-solo', branch: 'feat/solo' }]) {
        const refused = await callClose(tools, params, ctx);
        assert.equal(refused.isError, true, `expected rejection: ${JSON.stringify(params)}`);
        assert.match(resultText(refused), /only one/i);
      }
      assert.deepEqual(livePaths(root), beforeLive, 'no checkout touched');
      assert.deepEqual(registryBytes(root), beforeRegistry, 'registry untouched');
    } finally {
      restoreEnv();
    }
  });

  test('a branch whose slug is the reserved name principal makes that name ambiguous', async () => {
    const root = makeRepo('close-principal-clash');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      // `principal` is a valid branch name, so the tool can register it; the
      // listing then shows that name on two different checkouts.
      const clash = addRegistered(root, 'principal', { thread: 'thread-1', issues: [35] });
      const beforeLive = livePaths(root);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const refused = await callClose(tools, { name: 'principal' }, ctx);
      assert.equal(refused.isError, true, 'the reserved name never picks one');
      assert.match(resultText(refused), /ambiguous/i);
      assert.ok(resultText(refused).includes('principal'), `names the clash: ${resultText(refused)}`);
      assert.deepEqual(livePaths(root), beforeLive, 'no checkout touched');
      assert.deepEqual(registryBytes(root), beforeRegistry, 'registry untouched');
      assert.ok(livePaths(root).includes(clash));
      // The row stays reachable by branch, which is unambiguous.
      const byBranch = await callClose(tools, { branch: 'principal' }, ctx);
      assert.equal(byBranch.isError, undefined, `the branch still resolves: ${resultText(byBranch)}`);
      assert.equal(resultText(byBranch), `removed: principal · principal\nbranch kept`);
    } finally {
      restoreEnv();
    }
  });

  test('an unregistered checkout sharing the printed name makes it ambiguous', async () => {
    const root = makeRepo('close-unregistered-clash');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const registered = addRegistered(root, 'feat/mix', { thread: 'thread-1', issues: [35] });
      // A second live checkout whose branch flattens to the same name; it is
      // printed by `all: true` under that name but is never registered.
      const other = path.join(path.dirname(root), `${path.basename(root)}-unreg-mix`);
      track(other);
      git(root, ['worktree', 'add', '-b', 'feat-mix', other, 'HEAD']);
      const unregistered = fs.realpathSync(other);
      const beforeRegistry = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const refused = await callClose(tools, { name: 'feat-mix' }, ctx);
      assert.equal(refused.isError, true, 'a name two live checkouts share never picks one');
      assert.match(resultText(refused), /ambiguous/i);
      const text = resultText(refused);
      assert.ok(text.includes('feat/mix') && text.includes('feat-mix'), `names both rows: ${text}`);
      assert.match(text, /unregistered/, `says which one is unregistered: ${text}`);
      assert.ok(livePaths(root).includes(registered), 'the registered checkout survives');
      assert.ok(livePaths(root).includes(unregistered), 'the unregistered checkout survives');
      assert.deepEqual(registryBytes(root), beforeRegistry, 'registry untouched');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr never invoked');
    } finally {
      restoreEnv();
    }
  });

  test('a name is not ambiguous merely because the principal branch flattens to it', async () => {
    const root = makeRepo('close-principal-slug');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      // The principal prints as `principal`, never by its branch, so a branch
      // whose slug equals the principal's own branch slug leaves the name
      // unique. The principal branch is renamed first because `git worktree
      // add -b` cannot reuse a branch that is already checked out.
      git(root, ['branch', '-m', 'release/1']);
      const target = addRegistered(root, 'release-1', { thread: 'thread-1', issues: [35] });
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { name: 'release-1' }, ctx);
      assert.equal(result.isError, undefined, `the name is unique in the listing: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: release-1 · release-1',
        'branch kept',
      ]);
    } finally {
      restoreEnv();
    }
  });

  test('a prunable git record is not a second live checkout', async () => {
    const root = makeRepo('dead-unreg');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const registered = addRegistered(root, 'feat/mix', { thread: 'thread-1', issues: [35] });
      // A git record whose directory was deleted by hand: git still lists it
      // as prunable, and the listing does NOT print it as a live checkout.
      const dead = path.join(path.dirname(root), `${path.basename(root)}-dead-mix`);
      track(dead);
      git(root, ['worktree', 'add', '-b', 'feat-mix', dead, 'HEAD']);
      fs.rmSync(dead, { recursive: true, force: true });
      const before = registryBytes(root);
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const listed = await callList(tools, { all: true }, ctx);
      assert.equal((resultText(listed).match(/feat-mix/g) || []).length, 1, `printed once: ${resultText(listed)}`);
      const result = await callClose(tools, { name: 'feat-mix' }, ctx);
      assert.equal(result.isError, undefined, `a name the listing prints once still closes: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-mix · feat/mix',
        'branch kept',
      ]);
      assert.equal(fs.existsSync(dead), false, 'the dead path was never a checkout');
      assert.notDeepEqual(registryBytes(root), before, 'the registered row was closed');
    } finally {
      restoreEnv();
    }
  });
});

describe('S19: bounded close compact (agent text)', { concurrency: false }, () => {
  test('close returns exactly the ordered removed/branch-kept lines', async () => {
    const root = makeRepo('s19-close');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/s19-bye', { thread: 'thread-1', issues: [35] });
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await callClose(tools, { branch: 'feat/s19-bye' }, ctx);
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-s19-bye · feat/s19-bye',
        'branch kept',
      ]);
      assert.equal(target, result.details.path);
      assert.equal(result.details.branchKept, true);
      assert.equal(branchExists(root, 'feat/s19-bye'), true, 'the branch is kept');
    } finally {
      restoreEnv();
    }
  });
});

describe('S33/S34: worktree_close sequence (warp, Herdr workspace, remove)', { concurrency: false }, () => {
  // Pure-helper tests below require the new lib lazily (inside each
  // test) so the RED run fails per-test instead of breaking the file
  // load for every other suite in this file.
  function lib() {
    return require('../lib/worktree-close-herdr.js');
  }

  function listDoc(worktrees) {
    return JSON.stringify({ result: { worktrees } });
  }

  test('workspace lookup resolves the entry at the target path only', () => {
    const { workspaceEntryForPath } = lib();
    const target = '/repo/wt-a';
    const stdout = listDoc([
      { path: target, branch: 'feat/a', open_workspace_id: 'ws-a' },
      { path: '/repo/wt-b', branch: 'feat/b', open_workspace_id: 'ws-b' },
    ]);
    assert.deepStrictEqual(
      workspaceEntryForPath(stdout, target, '/repo'),
      { id: 'ws-a', path: target },
    );
    // A foreign workspace never resolves for our target.
    assert.equal(workspaceEntryForPath(stdout, '/repo/wt-missing', '/repo'), null);
    // Conflicting ids for one path are ambiguity: no workspace is named.
    assert.equal(workspaceEntryForPath(listDoc([
      { path: target, branch: 'feat/a', open_workspace_id: 'ws-1' },
      { path: target, branch: 'feat/a', open_workspace_id: 'ws-2' },
    ]), target, '/repo'), null);
    // A match without an id resolves nothing, and garbage is null.
    assert.equal(workspaceEntryForPath(listDoc([{ path: target, branch: 'feat/a' }]), target, '/repo'), null);
    assert.equal(workspaceEntryForPath('not json', target, '/repo'), null);
  });

  test('foreign live sessions are detected by checkout containment only', () => {
    const { agentsInCheckout } = lib();
    const target = '/repo/wt-a';
    const stdout = JSON.stringify({ result: { agents: [
      { cwd: target, session_id: 'other' },
      { cwd: `${target}/sub/dir`, session_id: 'nested' },
      { cwd: '/repo/elsewhere', session_id: 'away' },
      { cwd: 'relative/path', session_id: 'rel' },
      { cwd: target, session_id: 'mine' },
    ] } });
    const found = agentsInCheckout(stdout, target, '/repo', 'mine');
    assert.deepStrictEqual(found.map((agent) => agent.cwd).sort(), [target, `${target}/sub/dir`]);
    // Our own session is excluded by id match; unknown shapes are empty.
    assert.deepStrictEqual(agentsInCheckout(stdout, '/repo/elsewhere', '/repo', 'away'), []);
    assert.deepStrictEqual(agentsInCheckout('garbage', target, '/repo', 'mine'), []);
    assert.deepStrictEqual(agentsInCheckout(JSON.stringify({ result: {} }), target, '/repo', 'mine'), []);
  });

  test('reconcile closes the workspace and reopens normal at the principal', () => {
    const { reconcileHerdrWorkspace } = lib();
    const calls = [];
    const run = (argv) => {
      calls.push(argv.join(' '));
      if (argv[0] === 'worktree' && argv[1] === 'list') {
        return { status: 0, stdout: listDoc([{ path: '/repo/wt-a', open_workspace_id: 'ws-a' }]), stderr: '', error: null };
      }
      // S35: the group is resolved through a bare `workspace list`
      // (JSON by default, never --json); no group entry here degrades to
      // the linked member alone.
      if (argv[0] === 'workspace' && argv[1] === 'list') {
        assert.deepStrictEqual(argv, ['workspace', 'list']);
        return { status: 0, stdout: JSON.stringify({ result: { workspaces: [] } }), stderr: '', error: null };
      }
      if (argv[0] === 'workspace' && argv[1] === 'close') {
        assert.deepStrictEqual(argv, ['workspace', 'close', '--workspace', 'ws-a']);
        return { status: 0, stdout: '{}', stderr: '', error: null };
      }
      if (argv[0] === 'workspace' && argv[1] === 'create') {
        assert.deepStrictEqual(argv, ['workspace', 'create', '--cwd', '/repo', '--no-focus']);
        return { status: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: 'ws-new' } } }), stderr: '', error: null };
      }
      throw new Error(`unexpected argv ${argv.join(' ')}`);
    };
    const out = reconcileHerdrWorkspace({
      run, repoRoot: '/repo', resolvedTarget: '/repo/wt-a', principalPath: '/repo',
      session: { file: '/sessions/warped.jsonl', id: 'sess-1' }, force: false,
    });
    assert.deepStrictEqual(out, {
      status: 'reconciled', closedWorkspace: 'ws-a', closedWorkspaces: ['ws-a'], openedWorkspace: 'ws-new',
      session: { file: '/sessions/warped.jsonl', id: 'sess-1' },
    });
    assert.deepStrictEqual(calls, [
      'worktree list --cwd /repo',
      'workspace list',
      'workspace close --workspace ws-a',
      'workspace create --cwd /repo --no-focus',
    ]);
  });

  test('reconcile never touches a foreign workspace and skips with notice when Herdr fails', () => {
    const { reconcileHerdrWorkspace } = lib();
    // Absent: a workspace exists, but for another checkout only.
    const absentCalls = [];
    const absent = reconcileHerdrWorkspace({
      run: (argv) => {
        absentCalls.push(argv.join(' '));
        return { status: 0, stdout: listDoc([{ path: '/repo/wt-other', open_workspace_id: 'ws-x' }]), stderr: '', error: null };
      },
      repoRoot: '/repo', resolvedTarget: '/repo/wt-a', principalPath: '/repo',
      session: { file: null, id: null }, force: false,
    });
    assert.deepStrictEqual(absent, { status: 'absent' });
    assert.deepStrictEqual(absentCalls, ['worktree list --cwd /repo']);
    // Skipped: Herdr unavailable, close failing, create failing, runner throwing.
    for (const [tag, run] of [
      ['list', () => ({ status: 1, stdout: '', stderr: 'nope', error: null })],
      ['throw', () => { throw new Error('spawn ENOENT'); }],
      ['close', (argv) => {
        if (argv[0] === 'workspace' && argv[1] === 'close') return { status: 1, stdout: '', stderr: 'busy', error: null };
        return { status: 0, stdout: listDoc([{ path: '/repo/wt-a', open_workspace_id: 'ws-a' }]), stderr: '', error: null };
      }],
      ['create', (argv) => {
        if (argv[0] === 'workspace' && argv[1] === 'create') return { status: 1, stdout: '', stderr: 'busy', error: null };
        if (argv[0] === 'workspace' && argv[1] === 'close') return { status: 0, stdout: '{}', stderr: '', error: null };
        return { status: 0, stdout: listDoc([{ path: '/repo/wt-a', open_workspace_id: 'ws-a' }]), stderr: '', error: null };
      }],
    ]) {
      const out = reconcileHerdrWorkspace({
        run, repoRoot: '/repo', resolvedTarget: '/repo/wt-a', principalPath: '/repo',
        session: { file: null, id: null }, force: false,
      });
      assert.ok(out.status === 'skipped' || out.status === 'reconciled-partial', `${tag} skips: ${JSON.stringify(out)}`);
      assert.equal(typeof out.notice, 'string', `${tag} carries a notice`);
      assert.ok(out.notice.length > 0 && out.notice.length < 200, `${tag} notice is short: ${JSON.stringify(out.notice)}`);
    }
  });
});

describe('S33/S34: close integration (warp, workspace, remove)', { concurrency: false }, () => {
  // Extended `herdr` stub: the original worktree list/remove behaviour
  // (stable ws-<n> ids by sorted path) plus `agent list` (agents from
  // $HERDR_SHIM_AGENTS), `workspace close` (drops the id from the list)
  // and `workspace create` (mints ws-new-<n>). $HERDR_SHIM_SKIP_WS hides
  // every path containing that substring from the list (no workspace).
  // $HERDR_SHIM_WORKSPACE_FAIL=close|create makes that op fail.
  const EXTENDED_HERDR_SRC = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const EOL = String.fromCharCode(10);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_SHIM_LOG, argv.join(' ') + EOL);
function fail(msg) { console.error(msg); process.exit(1); }
if (process.env.HERDR_SHIM_EXIT && process.env.HERDR_SHIM_EXIT !== '0') fail('herdr shim failure');
const scope = argv[0];
const op = argv[1];
const rest = argv.slice(2);
function flag(name) {
  const i = rest.indexOf(name);
  if (i < 0 || i + 1 >= rest.length) return null;
  return rest[i + 1];
}
function state() {
  try { return JSON.parse(fs.readFileSync(process.env.HERDR_SHIM_STATE, 'utf8')); }
  catch (e) { return { closed: [], created: [] }; }
}
function save(s) { fs.writeFileSync(process.env.HERDR_SHIM_STATE, JSON.stringify(s)); }
function liveRecords(cwd) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' });
  if (r.status !== 0) fail('herdr stub list: git failed');
  const records = [];
  let cur = null;
  for (const line of r.stdout.split(EOL)) {
    if (line.indexOf('worktree ') === 0) { if (cur && cur.path) records.push(cur); cur = { path: line.slice(9), branch: null }; }
    else if (cur && line.indexOf('branch ') === 0) { const ref = line.slice(7); cur.branch = ref.indexOf('refs/heads/') === 0 ? ref.slice(11) : ref; }
    else if (line === '' && cur && cur.path) { records.push(cur); cur = null; }
  }
  if (cur && cur.path) records.push(cur);
  records.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return records;
}
if (scope === 'agent' && op === 'list') {
  let agents = [];
  try { agents = JSON.parse(process.env.HERDR_SHIM_AGENTS || '[]'); } catch (e) { agents = []; }
  console.log(JSON.stringify({ result: { agents } }));
  process.exit(0);
}
if (scope === 'workspace' && op === 'close') {
  if (process.env.HERDR_SHIM_WORKSPACE_FAIL === 'close') fail('workspace close refused');
  const ws = flag('--workspace');
  if (!ws) fail('workspace close: missing --workspace');
  const s = state();
  if (s.closed.indexOf(ws) >= 0) fail('workspace close: unknown workspace ' + ws);
  s.closed.push(ws);
  save(s);
  console.log('{}');
  process.exit(0);
}
if (scope === 'workspace' && op === 'create') {
  if (process.env.HERDR_SHIM_WORKSPACE_FAIL === 'create') fail('workspace create refused');
  const cwd = flag('--cwd');
  if (!cwd) fail('workspace create: missing --cwd');
  const s = state();
  const id = 'ws-new-' + (s.created.length + 1);
  s.created.push({ id, cwd });
  save(s);
  console.log(JSON.stringify({ result: { workspace: { workspace_id: id } } }));
  process.exit(0);
}
if (scope !== 'worktree') fail('herdr stub: unexpected argv ' + argv.join(' '));
if (op === 'list') {
  const cwd = flag('--cwd');
  if (!cwd) fail('herdr stub list: missing --cwd');
  const skip = process.env.HERDR_SHIM_SKIP_WS || '';
  const s = state();
  const worktrees = liveRecords(cwd)
    .map((rec, i) => ({ path: rec.path, branch: rec.branch, open_workspace_id: 'ws-' + i }))
    .filter((entry) => s.closed.indexOf(entry.open_workspace_id) < 0)
    .filter((entry) => skip === '' || entry.path.indexOf(skip) < 0);
  console.log(JSON.stringify({ result: { worktrees } }));
  process.exit(0);
}
if (op === 'remove') {
  const ws = flag('--workspace');
  if (!ws) fail('herdr stub remove: missing --workspace');
  const m = ws.match(/^ws-(\\d+)$/);
  if (!m) fail('herdr stub remove: unknown workspace ' + ws);
  const cwd = flag('--cwd') || process.cwd();
  const records = liveRecords(cwd);
  const rec = records[Number(m[1])];
  if (!rec) fail('herdr stub remove: unknown workspace ' + ws);
  const l = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: rec.path, encoding: 'utf8' });
  let main = null;
  if (l.status === 0) {
    for (const line of l.stdout.split(EOL)) {
      if (line.indexOf('worktree ') === 0) { main = line.slice(9); break; }
    }
  }
  if (!main) fail('herdr stub remove: cannot locate main checkout');
  const args = ['worktree', 'remove'];
  if (rest.indexOf('--force') >= 0) args.push('--force');
  args.push(rec.path);
  const r = spawnSync('git', args, { cwd: main, encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status === null || r.status === undefined ? 1 : r.status);
}
fail('herdr stub: unexpected argv ' + argv.join(' '));
`;

  function makeExtendedHerdr() {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-closex-herdr-')));
    const bin = path.join(dir, 'herdr');
    fs.writeFileSync(bin, EXTENDED_HERDR_SRC, { mode: 0o755 });
    return { bin, log: path.join(dir, 'herdr-argv.log'), state: path.join(dir, 'herdr-state.json') };
  }

  function extEnv(herdr, modeEnv, extra) {
    return {
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_STATE: herdr.state,
      HERDR_SHIM_EXIT: undefined,
      HERDR_SHIM_AGENTS: '[]',
      HERDR_SHIM_SKIP_WS: undefined,
      HERDR_SHIM_WORKSPACE_FAIL: undefined,
      GH_BIN_PATH: makeGhStub([35]),
      GENTLE_WORKTREE_THREAD: undefined,
      ...(extra || {}),
    };
  }

  async function loadModule() {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-close-mod-')));
    const copy = path.join(dir, 'gentle-worktree-tools.mjs');
    fs.writeFileSync(copy, stubbed);
    const mod = await import(pathToFileURL(copy).href);
    const tools = new Map();
    mod.default({ registerTool: (tool) => tools.set(tool.name, tool) });
    return { mod, tools };
  }

  // Fake SessionManager class for the warp leg: forkFrom hands back a
  // session file in scratch (never inside the fixture), mirroring the
  // customize-warp.test.js fake without touching the fixture checkouts.
  function makeCloseFakeSM(calls, scratchFile) {
    class FakeTarget {
      constructor(file, carried) {
        this.file = file;
        this.carried = Array.isArray(carried) ? carried : [];
      }
      getSessionFile() { return this.file; }
      getEntries() { return this.carried; }
      getLeafId() { return 'leaf-1'; }
      branch(id) { calls.push(['branch', id]); }
      resetLeaf() { calls.push(['resetLeaf']); }
      appendCustomEntry(type, data) {
        calls.push(['appendCustomEntry', type, data]);
        this.carried.push({ id: `warp-${calls.length}`, type: 'custom', customType: type, data });
      }
      appendSessionInfo(name) {
        calls.push(['appendSessionInfo', name]);
        this.carried.push({ id: `info-${calls.length}`, type: 'session_info', name });
      }
    }
    return class FakeSM {
      static forkFrom(sourcePath, targetCwd, sessionDir) {
        calls.push(['forkFrom', sourcePath, targetCwd, sessionDir]);
        return new FakeTarget(scratchFile, []);
      }
      static create(cwd, sessionDir) {
        calls.push(['create', cwd, sessionDir]);
        return { getSessionFile: () => scratchFile, getHeader: () => ({ type: 'session', cwd }) };
      }
      static open(file, sessionDir, cwdOverride) {
        calls.push(['open', file, sessionDir, cwdOverride]);
        return new FakeTarget(file, []);
      }
    };
  }

  function scratchSessionFile(tag) {
    const file = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-closex-sess-${tag}-`))), 'session.jsonl');
    fs.writeFileSync(file, '{"type":"session"}\n');
    return file;
  }

  function oscFake() {
    return { isTTY: false, chunks: [], write(chunk) { this.chunks.push(String(chunk)); return true; } };
  }

  // Command-capable context: waitForIdle/switchSession plus a full
  // session-manager fake. switchSession moves the manager's file to the
  // switched-to file, like the host does after a successful switch.
  function makeCmdCtx({ cwd, FakeSM, sessionFile, sessionId = 'thread-1', switchImpl }) {
    let currentFile = sessionFile;
    const sm = new FakeSM();
    Object.assign(sm, {
      getSessionId: () => sessionId,
      getSessionFile: () => currentFile,
      getLeafId: () => 'leaf-1',
      getEntries: () => [],
      getSessionDir: () => undefined,
    });
    const switches = [];
    const ctx = {
      cwd,
      hasUI: false,
      mode: 'tui',
      sessionManager: sm,
      ui: { confirm: async () => true, notify: () => {} },
      waitForIdle: async () => {},
      switchSession: async (file, options) => {
        switches.push(file);
        if (typeof switchImpl === 'function') return switchImpl(file, options);
        currentFile = file;
        if (options && typeof options.withSession === 'function') {
          await options.withSession({
            ui: { setStatus: () => {} },
            sendMessage: async () => {},
          });
        }
        return { cancelled: false };
      },
    };
    return { ctx, switches };
  }

  test('a live own session warps to the principal before removal, then the workspace is reconciled', async () => {
    const root = makeRepo('close-seq');
    const herdr = makeExtendedHerdr();
    const modeEnv = scratchModeEnv();
    setEnv(extEnv(herdr, modeEnv));
    try {
      const target = addRegistered(root, 'feat/warp-close', { thread: 'thread-1', issues: [35] });
      const { mod } = await loadModule();
      const calls = [];
      const forkFile = scratchSessionFile('seq');
      const sessionFile = scratchSessionFile('seq-src');
      const FakeSM = makeCloseFakeSM(calls, forkFile);
      const { ctx, switches } = makeCmdCtx({ cwd: target, FakeSM, sessionFile });
      const result = await mod.executeWorktreeClose(
        { branch: 'feat/warp-close' }, ctx, { sessionManagerClass: FakeSM, oscStream: oscFake() });
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.deepStrictEqual(resultText(result).split('\n'), [
        'removed: feat-warp-close · feat/warp-close',
        'branch kept',
        'session warped to principal',
      ]);
      // The warp moved this session to the principal before anything was removed.
      assert.ok(calls.some((call) => call[0] === 'forkFrom' && call[2] === root), `warp forked into the principal: ${JSON.stringify(calls)}`);
      assert.equal(switches.length, 1, 'the session switched exactly once');
      assert.equal(switches[0], forkFile, 'the switch went to the forked session');
      // The checkout is gone but the branch survives, and the registry dropped the row.
      assert.ok(!livePaths(root).includes(target), 'checkout removed');
      assert.equal(fs.existsSync(target), false);
      assert.equal(branchExists(root, 'feat/warp-close'), true, 'the branch is kept');
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/warp-close'), null);
      // The warped session is carried through the details to the reopened workspace.
      assert.equal(result.details.warp.name, 'principal');
      assert.equal(result.details.warp.path, root);
      assert.equal(result.details.warp.sessionFile, forkFile);
      assert.equal(result.details.herdrWorkspace.status, 'reconciled');
      assert.match(result.details.herdrWorkspace.closedWorkspace, /^ws-\d+$/);
      assert.equal(result.details.herdrWorkspace.openedWorkspace, 'ws-new-1');
      assert.deepStrictEqual(result.details.herdrWorkspace.session, { file: forkFile, id: 'thread-1' });
      // Order: detect, find, close, reopen — and no worktree remove,
      // because the reconcile already closed the workspace.
      const lines = shimArgv(herdr.log);
      const at = (prefix) => lines.findIndex((line) => line.startsWith(prefix));
      assert.ok(at('agent list') >= 0, `live-session detection ran: ${JSON.stringify(lines)}`);
      assert.ok(at('workspace close ') > at('agent list'), 'close runs after detection');
      assert.ok(at('workspace create ') > at('workspace close '), 'reopen runs after close');
      assert.ok(lines[at('workspace create ')].includes(`--cwd ${root}`), `reopen pins the principal: ${lines[at('workspace create ')]}`);
      assert.ok(lines[at('workspace create ')].includes('--no-focus'), 'reopen never steals focus');
      assert.equal(at('worktree remove '), -1, 'no worktree remove once the workspace was reconciled');
    } finally {
      restoreEnv();
    }
  });

  test('a failed warp stops the close before anything is removed', async () => {
    const root = makeRepo('close-warpx');
    const herdr = makeExtendedHerdr();
    const modeEnv = scratchModeEnv();
    setEnv(extEnv(herdr, modeEnv));
    try {
      const target = addRegistered(root, 'feat/warp-fail', { thread: 'thread-1', issues: [35] });
      const beforeRegistry = registryBytes(root);
      const { mod } = await loadModule();
      const sessionFile = scratchSessionFile('warpfail');
      const { ctx } = makeCmdCtx({ cwd: target, FakeSM: class {}, sessionFile });
      // A session-manager class without forkFrom fails the warp.
      const result = await mod.executeWorktreeClose(
        { branch: 'feat/warp-fail' }, ctx, { sessionManagerClass: class {}, oscStream: oscFake() });
      assert.equal(result.isError, true, 'the close refuses');
      assert.match(resultText(result), /warp/i, 'the refusal names the warp');
      assert.match(resultText(result), /left untouched/, 'nothing was mutated');
      assert.ok(livePaths(root).includes(target), 'checkout still live');
      assert.equal(fs.existsSync(target), true);
      assert.equal(branchExists(root, 'feat/warp-fail'), true);
      assert.deepStrictEqual(registryBytes(root), beforeRegistry, 'registry untouched');
      const lines = shimArgv(herdr.log);
      assert.equal(lines.filter((line) => line.startsWith('worktree remove ')).length, 0, 'nothing was removed');
      assert.equal(lines.filter((line) => line.startsWith('workspace close')).length, 0, 'no workspace touched');
      assert.equal(lines.filter((line) => line.startsWith('workspace create')).length, 0, 'no workspace opened');
    } finally {
      restoreEnv();
    }
  });

  test("another session live in the checkout refuses and changes nothing", async () => {
    const root = makeRepo('close-foreign');
    const herdr = makeExtendedHerdr();
    const modeEnv = scratchModeEnv();
    try {
      const target = addRegistered(root, 'feat/foreign-live', { thread: 'thread-1', issues: [35] });
      const beforeRegistry = registryBytes(root);
      setEnv(extEnv(herdr, modeEnv, { HERDR_SHIM_AGENTS: JSON.stringify([{ cwd: target, session_id: 'someone-else' }]) }));
      const { mod } = await loadModule();
      // Our own session runs in the principal: the live one is not ours.
      const { ctx } = makeCtx({ repoRoot: root });
      const result = await mod.executeWorktreeClose({ branch: 'feat/foreign-live' }, ctx);
      assert.equal(result.isError, true, 'the close refuses');
      assert.match(resultText(result), /another live/i, 'the refusal names the live session');
      assert.ok(resultText(result).includes(target), 'the refusal names the checkout');
      assert.match(resultText(result), /left untouched/, 'nothing was mutated');
      assert.ok(livePaths(root).includes(target), 'checkout still live');
      assert.equal(branchExists(root, 'feat/foreign-live'), true);
      assert.deepStrictEqual(registryBytes(root), beforeRegistry, 'registry untouched');
      const lines = shimArgv(herdr.log);
      assert.ok(lines.some((line) => line.startsWith('agent list')), 'detection ran');
      assert.equal(lines.filter((line) => line.startsWith('worktree remove ')).length, 0, 'nothing was removed');
      assert.equal(lines.filter((line) => line.startsWith('workspace close')).length, 0, 'no workspace touched');
      assert.equal(lines.filter((line) => line.startsWith('workspace create')).length, 0, 'no workspace opened');
    } finally {
      restoreEnv();
    }
  });

  test('a missing Herdr skips the workspace step with a notice and still removes', async () => {
    const root = makeRepo('close-noherdr');
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: path.join(os.tmpdir(), 'wt-close-no-such-herdr-binary'),
      GH_BIN_PATH: makeGhStub([35]),
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const target = addRegistered(root, 'feat/herdr-missing', { thread: 'thread-1', issues: [35] });
      const { mod } = await loadModule();
      const calls = [];
      const forkFile = scratchSessionFile('noherdr');
      const sessionFile = scratchSessionFile('noherdr-src');
      const FakeSM = makeCloseFakeSM(calls, forkFile);
      const { ctx, switches } = makeCmdCtx({ cwd: target, FakeSM, sessionFile });
      const result = await mod.executeWorktreeClose(
        { branch: 'feat/herdr-missing' }, ctx, { sessionManagerClass: FakeSM, oscStream: oscFake() });
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      const lines = resultText(result).split('\n');
      assert.deepStrictEqual(lines.slice(0, 3), [
        'removed: feat-herdr-missing · feat/herdr-missing',
        'branch kept',
        'session warped to principal',
      ]);
      assert.match(lines[3], /^herdr workspace step skipped/, `skip notice is visible: ${JSON.stringify(lines)}`);
      assert.equal(switches.length, 1, 'the warp still ran before removal');
      assert.ok(!livePaths(root).includes(target), 'checkout removed');
      assert.equal(fs.existsSync(target), false);
      assert.equal(branchExists(root, 'feat/herdr-missing'), true, 'the branch is kept');
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/herdr-missing'), null);
      assert.equal(result.details.herdrWorkspace.status, 'skipped');
    } finally {
      restoreEnv();
    }
  });

  test('no workspace at the target means nothing is closed or opened', async () => {
    const root = makeRepo('close-nowork');
    const herdr = makeExtendedHerdr();
    const modeEnv = scratchModeEnv();
    // Hide the target from the Herdr listing: no workspace points at it.
    setEnv(extEnv(herdr, modeEnv, { HERDR_SHIM_SKIP_WS: '-wt-feat-no-workspace' }));
    try {
      const target = addRegistered(root, 'feat/no-workspace', { thread: 'thread-1', issues: [35] });
      assert.ok(target.includes('-wt-feat-no-workspace'), `skip filter matches the target: ${target}`);
      const { mod } = await loadModule();
      const calls = [];
      const forkFile = scratchSessionFile('nowork');
      const sessionFile = scratchSessionFile('nowork-src');
      const FakeSM = makeCloseFakeSM(calls, forkFile);
      const { ctx, switches } = makeCmdCtx({ cwd: target, FakeSM, sessionFile });
      const result = await mod.executeWorktreeClose(
        { branch: 'feat/no-workspace' }, ctx, { sessionManagerClass: FakeSM, oscStream: oscFake() });
      assert.equal(result.isError, undefined, `expected success: ${resultText(result)}`);
      assert.deepStrictEqual(resultText(result).split('\n'), [
        'removed: feat-no-workspace · feat/no-workspace',
        'branch kept',
        'session warped to principal',
      ]);
      assert.equal(switches.length, 1, 'the warp still ran before removal');
      assert.ok(!livePaths(root).includes(target), 'checkout removed');
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/no-workspace'), null);
      assert.equal(result.details.warp.name, 'principal');
      assert.ok(!('herdrWorkspace' in result.details), 'no workspace step to report');
      const lines = shimArgv(herdr.log);
      assert.equal(lines.filter((line) => line.startsWith('workspace close')).length, 0, 'no workspace closed');
      assert.equal(lines.filter((line) => line.startsWith('workspace create')).length, 0, 'no workspace opened');
    } finally {
      restoreEnv();
    }
  });
});

describe('S35/S36: group-aware Herdr reconciliation (T25/T26 RED)', { concurrency: false }, () => {
  function lib() {
    return require('../lib/worktree-close-herdr.js');
  }

  function worktreeDoc(worktrees) {
    return JSON.stringify({ result: { worktrees } });
  }

  function workspaceDoc(workspaces) {
    return JSON.stringify({ result: { workspaces } });
  }

  // S36 verbatim live `herdr workspace list` entry shape. Top-level keys
  // are EXACTLY active_tab_id, agent_status, focused, label, number,
  // pane_count, tab_count, workspace_id, worktree; nested worktree keys
  // are checkout_path, is_linked_worktree, repo_key, repo_name,
  // repo_root. There is NO group_id live, so the group derives from
  // worktree.repo_key and the root from checkout_path === repo_root
  // (equivalently is_linked_worktree === false).
  function liveEntry({ id, label, checkoutPath, linked, repoKey, repoRoot, repoName }) {
    return {
      active_tab_id: `${id}-t1`,
      agent_status: 'idle',
      focused: false,
      label,
      number: 1,
      pane_count: 1,
      tab_count: 1,
      workspace_id: id,
      worktree: {
        checkout_path: checkoutPath,
        is_linked_worktree: linked,
        repo_key: repoKey,
        repo_name: repoName,
        repo_root: repoRoot,
      },
    };
  }

  // Group fixture: the target's linked member, a second linked member of
  // the same repo_key at another checkout, the group root, plus a foreign
  // workspace under another repo_key that must never be touched.
  function groupRun({ closeImpl, createImpl } = {}) {
    const calls = [];
    const run = (argv) => {
      calls.push(argv.join(' '));
      if (argv[0] === 'worktree' && argv[1] === 'list') {
        return {
          status: 0,
          stdout: worktreeDoc([{ path: '/repo/wt-a', branch: 'feat/a', open_workspace_id: 'ws-linked-a' }]),
          stderr: '', error: null,
        };
      }
      if (argv[0] === 'workspace' && argv[1] === 'list') {
        return {
          status: 0,
          stdout: workspaceDoc([
            liveEntry({ id: 'ws-linked-a', label: 'wt-a', checkoutPath: '/repo/wt-a', linked: true, repoKey: 'repo-1', repoRoot: '/repo', repoName: 'repo' }),
            liveEntry({ id: 'ws-linked-b', label: 'wt-b', checkoutPath: '/repo/wt-b', linked: true, repoKey: 'repo-1', repoRoot: '/repo', repoName: 'repo' }),
            liveEntry({ id: 'ws-root', label: 'repo', checkoutPath: '/repo', linked: false, repoKey: 'repo-1', repoRoot: '/repo', repoName: 'repo' }),
            liveEntry({ id: 'ws-foreign', label: 'other', checkoutPath: '/elsewhere', linked: false, repoKey: 'repo-2', repoRoot: '/elsewhere', repoName: 'other' }),
          ]),
          stderr: '', error: null,
        };
      }
      if (argv[0] === 'workspace' && argv[1] === 'close') {
        if (typeof closeImpl === 'function') return closeImpl(argv);
        return { status: 0, stdout: '{}', stderr: '', error: null };
      }
      if (argv[0] === 'workspace' && argv[1] === 'create') {
        if (typeof createImpl === 'function') return createImpl(argv);
        return { status: 0, stdout: JSON.stringify({ result: { workspace: { workspace_id: 'ws-new' } } }), stderr: '', error: null };
      }
      throw new Error(`unexpected argv ${argv.join(' ')}`);
    };
    return { calls, run };
  }

  test('ORDER: linked members close before the root, then one normal reopen at the principal', () => {
    const { reconcileHerdrWorkspace } = lib();
    const { calls, run } = groupRun();
    const out = reconcileHerdrWorkspace({
      run, repoRoot: '/repo', resolvedTarget: '/repo/wt-a', principalPath: '/repo',
      session: { file: '/sessions/warped.jsonl', id: 'sess-1' }, force: false,
    });
    assert.equal(out.status, 'reconciled', `expected reconciled, got ${JSON.stringify(out)}`);
    // Every group member reconciled, linked first, root last.
    assert.deepStrictEqual(out.closedWorkspaces, ['ws-linked-a', 'ws-linked-b', 'ws-root']);
    assert.equal(out.openedWorkspace, 'ws-new');
    const closeIdx = (id) => calls.findIndex((line) => line === `workspace close --workspace ${id}`);
    assert.ok(closeIdx('ws-linked-a') >= 0, `target linked member closed: ${JSON.stringify(calls)}`);
    assert.ok(closeIdx('ws-linked-b') >= 0, `same-repo linked member closed: ${JSON.stringify(calls)}`);
    assert.ok(closeIdx('ws-root') > closeIdx('ws-linked-a') && closeIdx('ws-root') > closeIdx('ws-linked-b'), `root closes AFTER linked: ${JSON.stringify(calls)}`);
    // Single normal reopen at the principal, never with --focus.
    const creates = calls.filter((line) => line.startsWith('workspace create '));
    assert.deepStrictEqual(creates, ['workspace create --cwd /repo --no-focus']);
    // Foreign workspaces are never touched.
    assert.equal(closeIdx('ws-foreign'), -1, `foreign workspace never closed: ${JSON.stringify(calls)}`);
    // `workspace list` prints JSON by default: never pass --json.
    assert.ok(calls.includes('workspace list'), `workspace list ran bare: ${JSON.stringify(calls)}`);
    assert.ok(!calls.some((line) => line.includes('--json')), `never --json: ${JSON.stringify(calls)}`);
  });

  test('tolerate: a member that is already closed (workspace_not_found) still reconciles', () => {
    const { reconcileHerdrWorkspace } = lib();
    const { calls, run } = groupRun({
      closeImpl: (argv) => {
        const id = argv[argv.indexOf('--workspace') + 1];
        if (id === 'ws-linked-a') {
          return { status: 1, stdout: '', stderr: '{"error":{"code":"workspace_not_found","message":"workspace is already gone"}}', error: null };
        }
        return { status: 0, stdout: '{}', stderr: '', error: null };
      },
    });
    const out = reconcileHerdrWorkspace({
      run, repoRoot: '/repo', resolvedTarget: '/repo/wt-a', principalPath: '/repo',
      session: { file: null, id: null }, force: false,
    });
    assert.equal(out.status, 'reconciled', `already-closed member is tolerated: ${JSON.stringify(out)}`);
    assert.deepStrictEqual(out.closedWorkspaces, ['ws-linked-a', 'ws-linked-b', 'ws-root']);
    assert.equal(out.openedWorkspace, 'ws-new');
    assert.ok(calls.includes('workspace close --workspace ws-root'), `root still closed: ${JSON.stringify(calls)}`);
    assert.ok(calls.includes('workspace create --cwd /repo --no-focus'), `reopen still ran: ${JSON.stringify(calls)}`);
  });

  test('workspace_group_close_required is handled, never surfaced raw, as a partial-group report', () => {
    const { reconcileHerdrWorkspace } = lib();
    const raw = '{"error":{"code":"workspace_group_close_required","message":"workspace has linked workspaces"}}';
    const { calls, run } = groupRun({
      closeImpl: (argv) => {
        const id = argv[argv.indexOf('--workspace') + 1];
        if (id === 'ws-linked-a') return { status: 1, stdout: '', stderr: raw, error: null };
        return { status: 0, stdout: '{}', stderr: '', error: null };
      },
    });
    const out = reconcileHerdrWorkspace({
      run, repoRoot: '/repo', resolvedTarget: '/repo/wt-a', principalPath: '/repo',
      session: { file: null, id: null }, force: false,
    });
    assert.equal(out.status, 'reconciled-partial', `a failed member is partial, never success: ${JSON.stringify(out)}`);
    assert.equal(out.failedWorkspace, 'ws-linked-a', `names which member failed: ${JSON.stringify(out)}`);
    assert.match(out.notice, /partially reconciled/i, `says the group is partially reconciled: ${out.notice}`);
    assert.ok(out.notice.includes('ws-linked'), `notice names the member: ${out.notice}`);
    assert.ok(!out.notice.includes('"workspace_group_close_required"') || /close.*(order|group|first)/i.test(out.notice), `handled, not raw: ${out.notice}`);
    assert.equal(out.openedWorkspace || null, null, 'no reopen is claimed after a failed member');
    assert.ok(!calls.some((line) => line.startsWith('workspace create ')), `no reopen after partial: ${JSON.stringify(calls)}`);
  });

  test('partial: a failed reopen after group closes reports partial with the closed members', () => {
    const { reconcileHerdrWorkspace } = lib();
    const { calls, run } = groupRun({
      createImpl: () => ({ status: 1, stdout: '', stderr: 'busy', error: null }),
    });
    const out = reconcileHerdrWorkspace({
      run, repoRoot: '/repo', resolvedTarget: '/repo/wt-a', principalPath: '/repo',
      session: { file: null, id: null }, force: false,
    });
    assert.equal(out.status, 'reconciled-partial', `failed reopen is partial: ${JSON.stringify(out)}`);
    assert.deepStrictEqual(out.closedWorkspaces, ['ws-linked-a', 'ws-linked-b', 'ws-root']);
    assert.equal(out.openedWorkspace, null);
    assert.match(out.notice, /principal|open/i, `notice names the failed reopen: ${out.notice}`);
    assert.ok(calls.includes('workspace close --workspace ws-linked-a'));
    assert.ok(calls.includes('workspace close --workspace ws-linked-b'));
    assert.ok(calls.includes('workspace close --workspace ws-root'));
  });

  test('legacy: entries without any repo_key still group through the group_id fallback', () => {
    const { orderedGroupMembers } = lib();
    const members = orderedGroupMembers({
      linkedIds: ['ws-linked'],
      workspaceList: [
        { workspace_id: 'ws-linked', cwd: '/repo/wt-a', group_id: 'g-1' },
        { workspace_id: 'ws-root', cwd: '/repo', group_id: 'g-1' },
        { workspace_id: 'ws-foreign', cwd: '/elsewhere', group_id: 'g-2' },
      ],
      resolvedTarget: '/repo/wt-a', repoRoot: '/repo',
    });
    assert.deepStrictEqual(members, ['ws-linked', 'ws-root']);
  });
});

describe('close pending-changes summary (S61)', { concurrency: false }, () => {
  function resultText(result) {
    const blocks = result && Array.isArray(result.content) ? result.content : [];
    return blocks.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n');
  }

  test('a dirty target names its pending changes in the approval and keeps the force guard', async () => {
    const root = makeRepo('close-dirty-summary');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/dirty-summary', { dirty: true });
      const tools = await loadExtension();
      const { ctx, confirms } = makeCtx({ repoRoot: root, hasUI: true, confirm: true });
      const refused = await callClose(tools, { branch: 'feat/dirty-summary' }, ctx);
      assert.equal(confirms.length, 1, 'the existing confirmation still runs once');
      assert.match(confirms[0][1], /Pending changes: 2 files, \+2\/-0/, 'the dirty summary travels in the confirmation');
      assert.equal(refused.isError, true, 'an approved dirty close without force still refuses: no silent force');
      assert.ok(fs.existsSync(target), 'the checkout is kept');
    } finally {
      restoreEnv();
    }
  });

  test('an explicit force still closes a dirty target after the same approval', async () => {
    const root = makeRepo('close-dirty-force');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      const target = addRegistered(root, 'feat/dirty-force', { dirty: true });
      const tools = await loadExtension();
      const { ctx, confirms } = makeCtx({ repoRoot: root, hasUI: true, confirm: true });
      const out = await callClose(tools, { branch: 'feat/dirty-force', force: true }, ctx);
      assert.equal(out.isError, undefined, `expected success: ${resultText(out)}`);
      assert.equal(confirms.length, 1, 'the existing confirmation still runs once');
      assert.match(confirms[0][1], /Pending changes: 2 files, \+2\/-0/);
      assert.ok(!fs.existsSync(target), 'the approved checkout is removed');
    } finally {
      restoreEnv();
    }
  });

  test('a clean target omits the dirty warning', async () => {
    const root = makeRepo('close-clean-summary');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv({ herdr, gh, modeEnv }));
    try {
      addRegistered(root, 'feat/clean-summary');
      const tools = await loadExtension();
      const { ctx, confirms } = makeCtx({ repoRoot: root, hasUI: true, confirm: true });
      await callClose(tools, { branch: 'feat/clean-summary' }, ctx);
      assert.equal(confirms.length, 1, 'the existing confirmation still runs once');
      assert.ok(!confirms[0][1].includes('Pending changes'), 'a clean checkout omits the dirty warning');
    } finally {
      restoreEnv();
    }
  });
});
