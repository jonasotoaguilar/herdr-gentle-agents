'use strict';
// P2-S2 tests (test-first): `worktree_create` validation + creation WITHOUT
// hooks, plus lib/worktree-issues.js issue verification.
//
// Loading pattern mirrors tools/gentle-sidebar-toggle.test.js: the
// TypeScript extension is plain JS under the hood (// @ts-nocheck, no type
// annotations), so the test copies it to a temporary .mjs path with exactly
// the two package import lines stubbed and import()s it with a fake `pi`
// object that records registrations. Production is untouched.
//
// Every test builds its own isolated fixture repository under os.tmpdir()
// (real `git init` + one commit), a stub `herdr` binary reached through the
// documented HERDR_BIN_PATH override, and a stub `gh` binary reached
// through GH_BIN_PATH. Only observable behavior is asserted: result text,
// the registry entry inside the git common dir, real checkouts on disk,
// and the argv the shims observed. The user's real checkouts are never
// touched; only the fixture dirs tracked in `roots` are removed.

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

function git(cwd, args, extraEnv) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(extraEnv || {}) },
  });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

// Fresh fixture repository with one empty commit.
function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-create-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

// Stub `gh`: answers `issue view <n> --json ...` for the known issues,
// fails for everything else (like a nonexistent issue).
function makeGhStub(knownIssues) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gh-')));
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

// Stub `herdr`: logs every argv line to $HERDR_SHIM_LOG, then emulates
// `worktree create` with a real `git worktree add`. $HERDR_SHIM_EXIT != 0
// makes every invocation fail (drives the git fallback).
function makeHerdrStub() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-herdr-')));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(
    bin,
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$HERDR_SHIM_LOG"',
      'if [ "${HERDR_SHIM_EXIT:-0}" != "0" ]; then echo "herdr shim failure" >&2; exit 1; fi',
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

function commonDirOf(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
}

function listWorktreePaths(root) {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function expectedTarget(root, slug) {
  return path.join(path.dirname(root), `${path.basename(root)}-worktrees`, slug);
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

// Isolated mode state per test: missing file means enabled.
function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mode-'))) };
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = { registerTool: (tool) => { tools.set(tool.name, tool); } };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
}

function makeCtx({ repoRoot, thread = 'thread-1', hasUI = false, confirm = true }) {
  const confirms = [];
  const ctx = {
    cwd: repoRoot,
    hasUI,
    mode: 'tui',
    sessionManager: { getSessionId: () => thread },
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

async function callCreate(tools, params, ctx) {
  const tool = tools.get('worktree_create');
  assert.ok(tool, 'expected worktree_create to be registered');
  return tool.execute('call-1', params, undefined, undefined, ctx);
}

describe('worktree_create', { concurrency: false }, () => {
  test('registers exactly one tool with branch + issues parameters', async () => {
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const tools = await loadExtension();
      assert.deepEqual([...tools.keys()], ['worktree_create']);
      const params = tools.get('worktree_create').parameters;
      assert.deepEqual(Object.keys(params.properties).sort(), ['branch', 'issues']);
      assert.equal(params.properties.branch.type, 'string');
      assert.equal(params.properties.issues.type, 'array');
    } finally {
      restoreEnv();
    }
  });

  test('creates a worktree through herdr and returns the exact success text', async () => {
    const root = makeRepo('ok');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_EXIT: undefined,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-1' });
      const target = expectedTarget(root, 'feat-create-ok');
      const result = await callCreate(tools, { branch: 'feat/create-ok', issues: [35] }, ctx);

      assert.equal(result.isError, undefined);
      assert.equal(resultText(result), `worktree create: ${target}`);
      assert.deepEqual(result.details, {
        path: target, branch: 'feat/create-ok', issues: [35], created: true,
      });
      // The path exists and is a real checkout.
      assert.equal(git(target, ['rev-parse', '--show-toplevel']), target);
      assert.ok(listWorktreePaths(root).includes(target));
      // The exact registry entry lives inside the git common dir.
      const registryLib = require('../lib/worktree-registry.js');
      const entry = registryLib.findByBranch(root, 'feat/create-ok');
      assert.deepEqual({ ...entry, createdAt: 'T', updatedAt: 'T' }, {
        branch: 'feat/create-ok', path: target, thread: 'thread-1',
        issues: [35], odd: [], createdAt: 'T', updatedAt: 'T',
      });
      assert.equal(
        registryLib.registryPath(root),
        path.join(commonDirOf(root), 'pi-worktrees.json'),
      );
      // herdr saw one fixed-argv create: values as separate elements
      // (never --flag=value), --base resolved, no --focus, no trust flag.
      const calls = shimArgv(herdr.log);
      assert.equal(calls.length, 1);
      const [line] = calls;
      assert.match(line, /worktree create/);
      assert.ok(line.includes(`--branch feat/create-ok`), `separate argv: ${line}`);
      assert.ok(line.includes(`--path ${target}`), `separate argv: ${line}`);
      assert.ok(line.includes(`--cwd ${root}`), `separate argv: ${line}`);
      assert.ok(line.includes('--base '), `base resolved: ${line}`);
      assert.ok(!line.includes('='), `never --flag=value: ${line}`);
      assert.ok(!line.includes('--focus'), `never --focus: ${line}`);
      assert.ok(!line.includes('trust'), `never --trust-repository: ${line}`);
    } finally {
      restoreEnv();
    }
  });

  test('a repeat call from the same thread returns the existing checkout', async () => {
    const root = makeRepo('repeat');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-1' });
      const first = await callCreate(tools, { branch: 'feat/repeat', issues: [35] }, ctx);
      const before = listWorktreePaths(root);
      assert.equal(before.length, 2);

      const second = await callCreate(tools, { branch: 'feat/repeat', issues: [35] }, ctx);
      assert.equal(resultText(second), resultText(first));
      assert.equal(second.details.created, false);
      assert.equal(second.details.path, first.details.path);
      assert.deepEqual(listWorktreePaths(root), before, 'no second checkout is created');
      assert.equal(shimArgv(herdr.log).length, 1, 'herdr is not invoked again');
    } finally {
      restoreEnv();
    }
  });

  test('a different thread gets its own checkout and never adopts another checkout', async () => {
    const root = makeRepo('threads');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35, 7]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const first = makeCtx({ repoRoot: root, thread: 'thread-1' });
      const created = await callCreate(tools, { branch: 'feat/one', issues: [35] }, first.ctx);

      const second = makeCtx({ repoRoot: root, thread: 'thread-2' });
      const other = await callCreate(tools, { branch: 'feat/two', issues: [7] }, second.ctx);
      assert.equal(other.isError, undefined);
      assert.notEqual(other.details.path, created.details.path);
      assert.equal(other.details.created, true);
      assert.equal(listWorktreePaths(root).length, 3);

      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByThread(root, 'thread-1').path, created.details.path);
      assert.equal(registryLib.findByThread(root, 'thread-2').path, other.details.path);
    } finally {
      restoreEnv();
    }
  });

  test('GENTLE_WORKTREE_THREAD overrides the session identity', async () => {
    const root = makeRepo('threadenv');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: 'env-thread',
    });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'session-thread' });
      const result = await callCreate(tools, { branch: 'feat/env-thread', issues: [35] }, ctx);
      assert.equal(result.isError, undefined);
      const registryLib = require('../lib/worktree-registry.js');
      const entry = registryLib.findByBranch(root, 'feat/env-thread');
      assert.equal(entry.thread, 'env-thread', 'the env override wins over the session id');
    } finally {
      restoreEnv();
    }
  });

  test('a branch already checked out anywhere is refused with no mutation', async () => {
    const root = makeRepo('taken');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const owner = makeCtx({ repoRoot: root, thread: 'thread-1' });
      await callCreate(tools, { branch: 'feat/taken', issues: [35] }, owner.ctx);
      const before = listWorktreePaths(root);
      const callsBefore = shimArgv(herdr.log).length;

      const other = makeCtx({ repoRoot: root, thread: 'thread-2' });
      const refused = await callCreate(tools, { branch: 'feat/taken', issues: [35] }, other.ctx);
      assert.equal(refused.isError, true);
      assert.match(resultText(refused), /feat\/taken/);
      assert.match(resultText(refused), /already checked out/i);
      assert.deepEqual(listWorktreePaths(root), before, 'no checkout is added');
      assert.equal(shimArgv(herdr.log).length, callsBefore, 'herdr is not invoked');
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByThread(root, 'thread-2'), null, 'no registry entry');
    } finally {
      restoreEnv();
    }
  });

  test('a live target path from a slug collision is refused with no mutation', async () => {
    const root = makeRepo('collision');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      // `feat/foo` and `feat-foo` flatten to the same slug, hence the same
      // target path. Occupy the target with the first spelling so the
      // second spelling hits the live-path refusal (not the branch refusal).
      const target = expectedTarget(root, 'feat-foo');
      git(root, ['worktree', 'add', '-b', 'feat/foo', target, 'HEAD']);
      const before = listWorktreePaths(root);

      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-1' });
      const refused = await callCreate(tools, { branch: 'feat-foo', issues: [35] }, ctx);
      assert.equal(refused.isError, true);
      assert.match(resultText(refused), /already.*live worktree|live worktree/i);
      assert.deepEqual(listWorktreePaths(root), before, 'no checkout is added');
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat-foo'), null, 'no registry entry');
    } finally {
      restoreEnv();
    }
  });

  test('missing, empty, and nonexistent issues are refused with no mutation', async () => {
    const root = makeRepo('issues');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-1' });
      const before = listWorktreePaths(root);

      const missing = await callCreate(tools, { branch: 'feat/no-issues' }, ctx);
      assert.equal(missing.isError, true);
      assert.match(resultText(missing), /create or assign an issue first/i);

      const empty = await callCreate(tools, { branch: 'feat/no-issues', issues: [] }, ctx);
      assert.equal(empty.isError, true);
      assert.match(resultText(empty), /create or assign an issue first/i);

      const ghost = await callCreate(tools, { branch: 'feat/ghost', issues: [424242] }, ctx);
      assert.equal(ghost.isError, true);
      assert.ok(resultText(ghost).includes('424242'), `names the number: ${resultText(ghost)}`);

      assert.deepEqual(listWorktreePaths(root), before, 'no checkout is created');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked');
      const registryLib = require('../lib/worktree-registry.js');
      assert.deepEqual(registryLib.readRegistry(root).worktrees, [], 'no registry entry');
    } finally {
      restoreEnv();
    }
  });

  test('hostile branch names are refused with no mutation', async () => {
    const root = makeRepo('hostile');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-1' });
      const before = listWorktreePaths(root);
      for (const branch of ['-x', 'has space', 'bidi‮mark']) {
        const refused = await callCreate(tools, { branch, issues: [35] }, ctx);
        assert.equal(refused.isError, true, `expected refusal: ${JSON.stringify(branch)}`);
        assert.ok(resultText(refused).length > 0, 'a reason is returned');
      }
      assert.deepEqual(listWorktreePaths(root), before, 'no checkout is created');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked');
    } finally {
      restoreEnv();
    }
  });

  test('a disabled or malformed mode file refuses without creating anything', async () => {
    const root = makeRepo('mode');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeLib = require('../lib/worktree-mode.js');
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-1' });
      const before = listWorktreePaths(root);

      modeLib.writeMode(false, process.env);
      const disabled = await callCreate(tools, { branch: 'feat/off', issues: [35] }, ctx);
      assert.equal(disabled.isError, true);
      assert.ok(
        resultText(disabled).includes('/herdr-gentle:worktree enabled'),
        `names the toggle: ${resultText(disabled)}`,
      );

      fs.writeFileSync(modeLib.modePath(process.env), '{ malformed {{{');
      const malformed = await callCreate(tools, { branch: 'feat/off', issues: [35] }, ctx);
      assert.equal(malformed.isError, true, 'malformed mode never enables');
      assert.ok(
        resultText(malformed).includes('/herdr-gentle:worktree enabled'),
        `names the toggle: ${resultText(malformed)}`,
      );

      assert.deepEqual(listWorktreePaths(root), before, 'nothing is created');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked');
      assert.ok(!fs.existsSync(expectedTarget(root, 'feat-off')), 'no target dir');
    } finally {
      restoreEnv();
    }
  });

  test('an approved confirmation names branch, path, and issues', async () => {
    const root = makeRepo('approve');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35, 7]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const { ctx, confirms } = makeCtx({
        repoRoot: root, thread: 'thread-1', hasUI: true, confirm: true,
      });
      const target = expectedTarget(root, 'feat-approved');
      const result = await callCreate(tools, { branch: 'feat/approved', issues: [35, 7] }, ctx);
      assert.equal(result.isError, undefined);
      assert.equal(resultText(result), `worktree create: ${target}`);
      assert.equal(confirms.length, 1);
      const [title, message] = confirms[0];
      assert.ok(title.includes('feat/approved'), `title names the branch: ${title}`);
      assert.ok(message.includes(target), `message names the path: ${message}`);
      assert.ok(message.includes('35') && message.includes('7'), `message names issues: ${message}`);
    } finally {
      restoreEnv();
    }
  });

  test('a declined approval creates nothing and writes no registry entry', async () => {
    const root = makeRepo('decline');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({
        repoRoot: root, thread: 'thread-1', hasUI: true, confirm: false,
      });
      const before = listWorktreePaths(root);
      const result = await callCreate(tools, { branch: 'feat/declined', issues: [35] }, ctx);
      assert.equal(result.isError, true);
      assert.match(resultText(result), /cancel/i);
      assert.deepEqual(listWorktreePaths(root), before, 'no checkout is created');
      assert.deepEqual(shimArgv(herdr.log), [], 'herdr is never invoked');
      assert.ok(!fs.existsSync(expectedTarget(root, 'feat-declined')), 'no target dir');
      const registryLib = require('../lib/worktree-registry.js');
      assert.deepEqual(registryLib.readRegistry(root).worktrees, [], 'no registry entry');
    } finally {
      restoreEnv();
    }
  });

  test('the git fallback runs when herdr fails', async () => {
    const root = makeRepo('fallback');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([12]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_EXIT: '1',
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-1' });
      const target = expectedTarget(root, 'feat-fallback');
      const result = await callCreate(tools, { branch: 'feat/fallback', issues: [12] }, ctx);
      assert.equal(result.isError, undefined);
      assert.equal(resultText(result), `worktree create: ${target}`);
      assert.deepEqual(result.details, {
        path: target, branch: 'feat/fallback', issues: [12], created: true,
      });
      // herdr was attempted first with fixed argv, then git did the work.
      const calls = shimArgv(herdr.log);
      assert.equal(calls.length, 1);
      assert.ok(calls[0].includes('--branch feat/fallback'), `herdr attempted: ${calls[0]}`);
      assert.ok(!calls[0].includes('--focus'), `never --focus: ${calls[0]}`);
      assert.ok(!calls[0].includes('='), `never --flag=value: ${calls[0]}`);
      assert.equal(git(target, ['rev-parse', '--show-toplevel']), target);
      assert.ok(listWorktreePaths(root).includes(target));
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.findByBranch(root, 'feat/fallback').thread, 'thread-1');
    } finally {
      restoreEnv();
    }
  });
});

describe('worktree-issues: verifyIssues', { concurrency: false }, () => {
  test('verifies existing issues through a fixed gh argv', async () => {
    const issuesLib = require('../lib/worktree-issues.js');
    const root = makeRepo('verify');
    const gh = makeGhStub([35, 7]);
    setEnv({ GH_BIN_PATH: gh, GENTLE_WORKTREE_THREAD: undefined });
    try {
      const result = issuesLib.verifyIssues([35, 7], { cwd: root });
      assert.equal(result.ok, true);
      assert.deepEqual(result.issues, [
        { number: 35, title: 'Test issue 35', state: 'OPEN' },
        { number: 7, title: 'Test issue 7', state: 'OPEN' },
      ]);
    } finally {
      restoreEnv();
    }
  });

  test('a missing or empty list fails telling the agent to create or assign an issue first', async () => {
    const issuesLib = require('../lib/worktree-issues.js');
    const root = makeRepo('missing');
    setEnv({ GH_BIN_PATH: makeGhStub([35]) });
    try {
      for (const numbers of [undefined, null, [], '35']) {
        const result = issuesLib.verifyIssues(numbers, { cwd: root });
        assert.equal(result.ok, false, `expected failure: ${JSON.stringify(numbers)}`);
        assert.match(result.reason, /create or assign an issue first/i);
      }
    } finally {
      restoreEnv();
    }
  });

  test('a nonexistent issue fails naming that number', async () => {
    const issuesLib = require('../lib/worktree-issues.js');
    const root = makeRepo('ghost');
    setEnv({ GH_BIN_PATH: makeGhStub([35]) });
    try {
      const result = issuesLib.verifyIssues([424242], { cwd: root });
      assert.equal(result.ok, false);
      assert.ok(result.reason.includes('424242'), `names the number: ${result.reason}`);
    } finally {
      restoreEnv();
    }
  });

  test('a missing gh binary fails closed with a clear reason', async () => {
    const issuesLib = require('../lib/worktree-issues.js');
    const root = makeRepo('nogh');
    setEnv({ GH_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-gh-binary-xyz') });
    try {
      const result = issuesLib.verifyIssues([35], { cwd: root });
      assert.equal(result.ok, false);
      assert.ok(result.reason.length > 0);
      assert.match(result.reason, /gh/i);
    } finally {
      restoreEnv();
    }
  });
});
