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
      assert.deepEqual([...tools.keys()], ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open']);
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
      assert.deepEqual(
        {
          path: result.details.path, branch: result.details.branch,
          issues: result.details.issues, created: result.details.created,
        },
        { path: target, branch: 'feat/create-ok', issues: [35], created: true },
      );
      // Creation hooks (S8) report their steps beside the creation facts.
      assert.equal(result.details.hooks.ok, true);
      assert.ok(Array.isArray(result.details.hooks.steps) && result.details.hooks.steps.length > 0);
      assert.ok(Array.isArray(result.details.warnings));
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
        resultText(disabled).includes('/herdr-gentle:customize'),
        `names the toggle: ${resultText(disabled)}`,
      );

      fs.writeFileSync(modeLib.modePath(process.env), '{ malformed {{{');
      const malformed = await callCreate(tools, { branch: 'feat/off', issues: [35] }, ctx);
      assert.equal(malformed.isError, true, 'malformed mode never enables');
      assert.ok(
        resultText(malformed).includes('/herdr-gentle:customize'),
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
      assert.deepEqual(
        {
          path: result.details.path, branch: result.details.branch,
          issues: result.details.issues, created: result.details.created,
        },
        { path: target, branch: 'feat/fallback', issues: [12], created: true },
      );
      assert.equal(result.details.hooks.ok, true);
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

describe('worktree_create never unregisters a live checkout (S14)', { concurrency: false }, () => {
  test('a hand-written row carrying the created branch keeps its live checkout registered', async () => {
    const root = makeRepo('dupbranch');
    // A live checkout owned by another thread, registered under the branch
    // this call is about to create (a hand-written duplicate-branch row).
    const liveDir = path.join(path.dirname(root), `${path.basename(root)}-live`);
    track(liveDir);
    git(root, ['worktree', 'add', '-b', 'feat-live', liveDir, 'HEAD']);
    const liveAbs = fs.realpathSync(liveDir);
    const registryLib = require('../lib/worktree-registry.js');
    assert.equal(registryLib.upsertWorktree(root, {
      branch: 'feat/new', path: liveAbs, thread: 'other-thread', issues: [7], odd: [],
    }).ok, true);
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
      const target = expectedTarget(root, 'feat-new');
      const result = await callCreate(tools, { branch: 'feat/new', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      // The other checkout is still on disk, still listed, still registered.
      assert.ok(fs.existsSync(liveAbs), 'live checkout survives on disk');
      assert.ok(listWorktreePaths(root).includes(liveAbs), 'live checkout still listed by git');
      const after = registryLib.readRegistry(root);
      assert.equal(after.ok, true);
      assert.ok(
        after.worktrees.some((entry) => entry.branch === 'feat/new' && path.resolve(entry.path) === liveAbs),
        `the conflicting row keeps its registration: ${JSON.stringify(after.worktrees)}`,
      );
      assert.ok(
        after.worktrees.some((entry) => entry.branch === 'feat/new' && path.resolve(entry.path) === target),
        `the new checkout is registered too: ${JSON.stringify(after.worktrees)}`,
      );
      // The conflict is reported as a warning naming the kept checkout.
      assert.ok(Array.isArray(result.details.warnings), 'warnings travel in details');
      assert.ok(
        result.details.warnings.join('\n').includes(liveAbs),
        `the warning names the kept checkout ${liveAbs}: ${JSON.stringify(result.details.warnings)}`,
      );
    } finally {
      restoreEnv();
    }
  });

  test('F2a: a same-branch row that is a SYMLINK to a live checkout is kept and warned about', async () => {
    const root = makeRepo('symlink-conflict');
    const liveDir = path.join(path.dirname(root), `${path.basename(root)}-live`);
    track(liveDir);
    git(root, ['worktree', 'add', '-b', 'feat-live', liveDir, 'HEAD']);
    const liveAbs = fs.realpathSync(liveDir);
    // A hand-written row whose path is a SYMLINK reaching the live checkout.
    const linkAbs = path.join(path.dirname(root), `${path.basename(root)}-link`);
    track(linkAbs);
    fs.symlinkSync(liveAbs, linkAbs);
    const registryLib = require('../lib/worktree-registry.js');
    assert.equal(registryLib.upsertWorktree(root, {
      branch: 'feat/new', path: linkAbs, thread: 'other-thread', issues: [7], odd: [],
    }).ok, true);
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
      const target = expectedTarget(root, 'feat-new');
      const result = await callCreate(tools, { branch: 'feat/new', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      const after = registryLib.readRegistry(root);
      assert.equal(after.ok, true);
      assert.ok(
        after.worktrees.some((entry) => entry.branch === 'feat/new' && entry.path === linkAbs),
        `the symlink row keeps its registration: ${JSON.stringify(after.worktrees)}`,
      );
      assert.ok(
        after.worktrees.some((entry) => entry.branch === 'feat/new' && path.resolve(entry.path) === target),
        `the new checkout is registered too: ${JSON.stringify(after.worktrees)}`,
      );
      assert.ok(
        result.details.warnings.join('\n').includes(linkAbs),
        `the warning names the kept symlink path ${linkAbs}: ${JSON.stringify(result.details.warnings)}`,
      );
    } finally {
      restoreEnv();
    }
  });

  test('F2b: thread stale cleanup keeps an owned SYMLINK to a live checkout', async () => {
    const root = makeRepo('symlink-stale');
    const liveDir = path.join(path.dirname(root), `${path.basename(root)}-live`);
    track(liveDir);
    git(root, ['worktree', 'add', '-b', 'feat-lived', liveDir, 'HEAD']);
    const liveAbs = fs.realpathSync(liveDir);
    const linkAbs = path.join(path.dirname(root), `${path.basename(root)}-owned-link`);
    track(linkAbs);
    fs.symlinkSync(liveAbs, linkAbs);
    const registryLib = require('../lib/worktree-registry.js');
    assert.equal(registryLib.upsertWorktree(root, {
      branch: 'feat/owned', path: linkAbs, thread: 'creator', issues: [7], odd: [],
    }).ok, true);
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: 'creator',
    });
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'creator' });
      const result = await callCreate(tools, { branch: 'feat/whatever', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected idempotent return, got: ${text}`);
      assert.equal(result.details.created, false, 'no second checkout is created');
      assert.equal(result.details.path, linkAbs, 'the owned symlink checkout is returned');
      const after = registryLib.readRegistry(root);
      assert.ok(
        after.worktrees.some((entry) => entry.thread === 'creator' && entry.path === linkAbs),
        `the owned symlink row survives: ${JSON.stringify(after.worktrees)}`,
      );
      assert.ok(fs.existsSync(liveAbs), 'live checkout survives on disk');
    } finally {
      restoreEnv();
    }
  });

  test('F3: dead-first/live-second same-branch rows still warn naming the live path', async () => {
    const root = makeRepo('dead-first');
    const liveDir = path.join(path.dirname(root), `${path.basename(root)}-live`);
    track(liveDir);
    git(root, ['worktree', 'add', '-b', 'feat-lived', liveDir, 'HEAD']);
    const liveAbs = fs.realpathSync(liveDir);
    const registryLib = require('../lib/worktree-registry.js');
    const deadAbs = path.join(path.dirname(root), `${path.basename(root)}-dead-gone`);
    // DEAD row first: same branch, absolute path that names no checkout.
    assert.equal(registryLib.upsertWorktree(root, {
      branch: 'feat/new', path: deadAbs, thread: 'other-thread', issues: [7], odd: [],
    }).ok, true);
    // LIVE row second: append (upsert would replace the dead row).
    assert.equal(registryLib.appendWorktree(root, {
      branch: 'feat/new', path: liveAbs, thread: 'other-thread', issues: [7], odd: [],
    }).ok, true);
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
      const target = expectedTarget(root, 'feat-new');
      const result = await callCreate(tools, { branch: 'feat/new', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      const after = registryLib.readRegistry(root);
      assert.ok(
        after.worktrees.some((entry) => entry.branch === 'feat/new' && path.resolve(entry.path) === liveAbs),
        `the live row survives: ${JSON.stringify(after.worktrees)}`,
      );
      assert.ok(
        result.details.warnings.join('\n').includes(liveAbs),
        `the warning names the kept live path ${liveAbs}: ${JSON.stringify(result.details.warnings)}`,
      );
    } finally {
      restoreEnv();
    }
  });
});

describe('consolidated checkout liveness: ghost idempotency + conflict guard', { concurrency: false }, () => {
  test('GHOST: tool-created row hand-deleted but still listed is stale, same thread creates fresh', async () => {
    const root = makeRepo('ghost-idem');
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
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-ghost' });
      const first = await callCreate(tools, { branch: 'feat/ghost-a', issues: [35] }, ctx);
      assert.equal(first.isError, undefined);
      const deadTarget = first.details.path;
      // Hand-delete: git still records it, the path no longer exists.
      fs.rmSync(deadTarget, { recursive: true, force: true });
      assert.equal(fs.existsSync(deadTarget), false, 'checkout hand-deleted');
      assert.ok(listWorktreePaths(root).includes(deadTarget), 'git still lists the deleted checkout');

      // Same thread asks for a NEW branch: must not return the ghost.
      const second = await callCreate(tools, { branch: 'feat/ghost-b', issues: [7] }, ctx);
      const text = resultText(second);
      assert.equal(second.isError, undefined, `expected fresh success, got: ${text}`);
      assert.notEqual(second.details.path, deadTarget, 'must not answer the missing path');
      assert.equal(second.details.created, true, 'must create fresh, not created:false at a ghost');
      assert.ok(fs.existsSync(second.details.path), 'the new checkout exists on disk');
      const registryLib = require('../lib/worktree-registry.js');
      const owned = registryLib.findByThread(root, 'thread-ghost');
      assert.ok(owned, 'registry holds a row for the thread');
      assert.equal(owned.path, second.details.path, 'registry holds the NEW row');
      assert.ok(fs.existsSync(owned.path), 'registry row points at a real checkout');
    } finally {
      restoreEnv();
    }
  });

  test('CONFLICT: a git-listed-but-missing path is never a live conflict to keep', async () => {
    const root = makeRepo('conflict-ghost');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    // Ghost checkout with its own branch, hand-deleted so git still lists it.
    const ghostDir = path.join(path.dirname(root), `${path.basename(root)}-ghostdir`);
    track(ghostDir);
    git(root, ['worktree', 'add', '-b', 'feat-ghosted', ghostDir, 'HEAD']);
    const ghostAbs = fs.realpathSync(ghostDir);
    fs.rmSync(ghostAbs, { recursive: true, force: true });
    assert.equal(fs.existsSync(ghostAbs), false);
    assert.ok(listWorktreePaths(root).includes(ghostAbs), 'git still lists the deleted checkout');
    // Hand-written row carrying the REQUESTED branch but pointing at the ghost.
    const registryLib = require('../lib/worktree-registry.js');
    assert.equal(registryLib.upsertWorktree(root, {
      branch: 'feat/new', path: ghostAbs, thread: 'other-thread', issues: [7], odd: [],
    }).ok, true);
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
      const result = await callCreate(tools, { branch: 'feat/new', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      const warnings = (result.details.warnings || []).join('\n');
      assert.ok(!warnings.includes(ghostAbs), `must not warn keeping ghost ${ghostAbs}: ${JSON.stringify(result.details.warnings)}`);
    } finally {
      restoreEnv();
    }
  });
});

describe('H1: a stale git record never blocks a create (prune + recover)', { concurrency: false }, () => {
  test('same-branch recreate after a hand-delete succeeds, reports the prune, and close can act on the new row', async () => {
    const root = makeRepo('h1-same');
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
      const first = await callCreate(tools, { branch: 'feat/h1-same', issues: [35] }, makeCtx({ repoRoot: root, thread: 'thread-h1' }).ctx);
      assert.equal(first.isError, undefined, `setup create failed: ${resultText(first)}`);
      const target = first.details.path;
      // The user deletes the checkout by hand: git still records it.
      fs.rmSync(target, { recursive: true, force: true });
      assert.equal(fs.existsSync(target), false, 'checkout hand-deleted');
      assert.ok(listWorktreePaths(root).includes(target), 'git still records the deleted checkout');

      const second = await callCreate(tools, { branch: 'feat/h1-same', issues: [35] }, makeCtx({ repoRoot: root, thread: 'thread-h1' }).ctx);
      const text = resultText(second);
      assert.equal(second.isError, undefined, `expected stale-record recovery, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      assert.equal(second.details.created, true, 'a fresh checkout is created, never created:false at a ghost');
      assert.ok(fs.existsSync(target), 'a real checkout is back on disk');
      assert.ok(listWorktreePaths(root).includes(target), 'git lists the new checkout');
      const registryLib = require('../lib/worktree-registry.js');
      const row = registryLib.findByBranch(root, 'feat/h1-same');
      assert.ok(row, 'the registry row is back');
      assert.equal(path.resolve(row.path), path.resolve(target));
      assert.ok(fs.existsSync(row.path), 'the row points at a real checkout');
      assert.ok(Array.isArray(second.details.pruned) && second.details.pruned.length > 0, `the prune is reported in details: ${JSON.stringify(second.details)}`);
      assert.ok(
        (second.details.warnings || []).join('\n').includes('prune'),
        `the warning names the recovery: ${JSON.stringify(second.details.warnings)}`,
      );

      // The recovered row is closable: close acts on it and keeps the branch.
      const closed = await tools.get('worktree_close').execute(
        'call-9', { branch: 'feat/h1-same', force: true }, undefined, undefined,
        makeCtx({ repoRoot: root, thread: 'thread-h1' }).ctx,
      );
      assert.equal(closed.isError, undefined, `close must act on the new row, got: ${resultText(closed)}`);
      assert.equal(resultText(closed), `worktree close: ${target}`);
      assert.ok(!listWorktreePaths(root).includes(target), 'checkout removed');
    } finally {
      restoreEnv();
    }
  });

  test('slug collision with a deleted checkout succeeds instead of refusing the stale path', async () => {
    const root = makeRepo('h1-slug');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    // `feat/foo` and `feat-foo` flatten to the same target. Occupy it,
    // then hand-delete it so git still records a checkout that is gone.
    const target = expectedTarget(root, 'feat-foo');
    track(target);
    git(root, ['worktree', 'add', '-b', 'feat/foo', target, 'HEAD']);
    fs.rmSync(target, { recursive: true, force: true });
    assert.equal(fs.existsSync(target), false, 'checkout hand-deleted');
    assert.ok(listWorktreePaths(root).includes(target), 'git still records the deleted checkout');
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
      const result = await callCreate(tools, { branch: 'feat-foo', issues: [35] }, makeCtx({ repoRoot: root, thread: 'thread-new' }).ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected slug-collision recovery, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      assert.ok(fs.existsSync(target), 'a real checkout is on disk');
      assert.ok(listWorktreePaths(root).includes(target), 'git lists the new checkout');
      const registryLib = require('../lib/worktree-registry.js');
      const row = registryLib.findByBranch(root, 'feat-foo');
      assert.ok(row && fs.existsSync(row.path), 'the registry row points at a real checkout');
      assert.ok(Array.isArray(result.details.pruned) && result.details.pruned.length > 0, `the prune is reported: ${JSON.stringify(result.details)}`);
    } finally {
      restoreEnv();
    }
  });
});

describe('I1: one owner per path (slug-collision stale row)', { concurrency: false }, () => {
  test('exact reproduction ends with one row; close of the old branch refuses; checkout survives', async () => {
    const root = makeRepo('i1-repro');
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
      const target = expectedTarget(root, 'feat-foo');
      // Thread t-owner creates feat/foo at the shared target path.
      const first = await callCreate(tools, { branch: 'feat/foo', issues: [35] }, makeCtx({ repoRoot: root, thread: 't-owner' }).ctx);
      assert.equal(first.isError, undefined, `setup create failed: ${resultText(first)}`);
      assert.equal(resultText(first), `worktree create: ${target}`);
      // A keeper row for another path must survive untouched.
      const keeper = await callCreate(tools, { branch: 'feat/keeper', issues: [7] }, makeCtx({ repoRoot: root, thread: 't-keeper' }).ctx);
      assert.equal(keeper.isError, undefined);
      const keeperPath = keeper.details.path;
      assert.notEqual(path.resolve(keeperPath), path.resolve(target));
      // The user deletes the feat/foo checkout by hand; git still records it.
      fs.rmSync(target, { recursive: true, force: true });
      assert.equal(fs.existsSync(target), false);
      assert.ok(listWorktreePaths(root).includes(target), 'git still records the deleted checkout');
      // Thread t-other creates feat-foo, landing on the SAME path.
      const second = await callCreate(tools, { branch: 'feat-foo', issues: [35] }, makeCtx({ repoRoot: root, thread: 't-other' }).ctx);
      const text = resultText(second);
      assert.equal(second.isError, undefined, `expected recovery, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      assert.ok(fs.existsSync(target), 'new checkout exists');
      // Exactly ONE registry row at that path: the one just created.
      const registryLib = require('../lib/worktree-registry.js');
      const after = registryLib.readRegistry(root);
      assert.equal(after.ok, true);
      const atTarget = after.worktrees.filter((e) => { try { return path.resolve(e.path) === path.resolve(target); } catch { return false; } });
      assert.equal(atTarget.length, 1, `one owner per path, got: ${JSON.stringify(after.worktrees)}`);
      assert.equal(atTarget[0].branch, 'feat-foo');
      // The keeper row survives untouched.
      assert.ok(after.worktrees.some((e) => e.branch === 'feat/keeper' && path.resolve(e.path) === path.resolve(keeperPath)), `keeper survives: ${JSON.stringify(after.worktrees)}`);
      // The replacement is reported in details and names the dropped branch.
      const warnings = (second.details.warnings || []).join('\n');
      assert.ok(warnings.includes('feat/foo'), `warning names dropped branch feat/foo: ${JSON.stringify(second.details.warnings)}`);
      assert.ok(second.details.replacedRows !== undefined || (Array.isArray(second.details.pruned)), 'replacement travels in details');
      // Closing the OLD branch refuses with no registered worktree and keeps the checkout.
      const closed = await tools.get('worktree_close').execute('call-9', { branch: 'feat/foo' }, undefined, undefined, makeCtx({ repoRoot: root, thread: 't-owner' }).ctx);
      assert.equal(closed.isError, true, `close of stale branch must refuse, got: ${resultText(closed)}`);
      assert.match(resultText(closed), /no registered worktree/i);
      assert.ok(fs.existsSync(target), 'new checkout still exists after refused close');
      assert.ok(listWorktreePaths(root).includes(target), 'checkout still listed');
    } finally {
      restoreEnv();
    }
  });

  test('symlink and trailing-slash spellings of the same path are also replaced', async () => {
    for (const variant of ['symlink', 'slash']) {
      const root = makeRepo(`i1-${variant}`);
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
        const target = expectedTarget(root, 'feat-foo');
        track(target);
        git(root, ['worktree', 'add', '-b', 'feat/foo', target, 'HEAD']);
        fs.rmSync(target, { recursive: true, force: true });
        const registryLib = require('../lib/worktree-registry.js');
        let stalePath;
        if (variant === 'symlink') {
          // Recreate the target so the symlink has a live referent, then
          // point the stale row at a symlink to it.
          git(root, ['worktree', 'remove', '--force', target].length ? ['worktree', 'prune'] : ['worktree', 'prune']);
          git(root, ['worktree', 'add', '-b', 'feat/real', target, 'HEAD']);
          const linkAbs = path.join(path.dirname(root), `${path.basename(root)}-i1-link`);
          track(linkAbs);
          try { fs.unlinkSync(linkAbs); } catch {}
          fs.symlinkSync(target, linkAbs);
          stalePath = linkAbs;
          assert.equal(registryLib.upsertWorktree(root, { branch: 'feat/foo', path: stalePath, thread: 't-owner', issues: [35], odd: [] }).ok, true);
          // Hand-delete the real target again so the create must recover it;
          // the symlink row dangles at create time but resolves to the
          // target once the create lands.
          fs.rmSync(target, { recursive: true, force: true });
        } else {
          stalePath = target + path.sep;
          assert.equal(registryLib.upsertWorktree(root, { branch: 'feat/foo', path: stalePath, thread: 't-owner', issues: [35], odd: [] }).ok, true);
        }
        const result = await callCreate(tools, { branch: 'feat-foo', issues: [35] }, makeCtx({ repoRoot: root, thread: 't-other' }).ctx);
        const text = resultText(result);
        assert.equal(result.isError, undefined, `[${variant}] expected success, got: ${text}`);
        const after = registryLib.readRegistry(root);
        assert.equal(after.ok, true);
        const atTarget = after.worktrees.filter((e) => {
          try {
            if (path.resolve(e.path) === path.resolve(target)) return true;
            try { if (fs.realpathSync(e.path) === fs.realpathSync(target)) return true; } catch {}
            return false;
          } catch { return false; }
        });
        assert.equal(atTarget.length, 1, `[${variant}] one owner per path, got: ${JSON.stringify(after.worktrees)}`);
        assert.equal(atTarget[0].branch, 'feat-foo');
        assert.ok((result.details.warnings || []).join('\n').includes('feat/foo'), `[${variant}] warning names feat/foo`);
      } finally {
        restoreEnv();
      }
    }
  });
});

describe('I2: one predicate at the remaining sites', { concurrency: false }, () => {
  test('isPathInAnyCheckout agrees for a symlink spelling and the real spelling', async () => {
    const root = makeRepo('i2-symlink');
    const wtDir = path.join(path.dirname(root), `${path.basename(root)}-wt`);
    track(wtDir);
    git(root, ['worktree', 'add', '-b', 'feat/i2', wtDir, 'HEAD']);
    const liveAbs = fs.realpathSync(wtDir);
    const linkAbs = path.join(path.dirname(root), `${path.basename(root)}-i2-link`);
    track(linkAbs);
    try { fs.unlinkSync(linkAbs); } catch {}
    fs.symlinkSync(liveAbs, linkAbs);
    const gitLib = require('../lib/worktree-git.js');
    const viaReal = gitLib.isPathInAnyCheckout(root, liveAbs);
    const viaLink = gitLib.isPathInAnyCheckout(root, linkAbs);
    assert.equal(viaReal, true, 'real spelling is inside a checkout');
    assert.equal(viaLink, true, 'symlink spelling must not be treated as a different checkout');
    const insideReal = gitLib.isPathInAnyCheckout(root, path.join(liveAbs, 'sub'));
    const insideLink = gitLib.isPathInAnyCheckout(root, path.join(linkAbs, 'sub'));
    assert.equal(insideReal, insideLink, 'inside-verdict agrees for both spellings');
  });

  test('a FILE occupant is judged not-live identically by list, create and close', async () => {
    const root = makeRepo('i2-file');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    const gitLib = require('../lib/worktree-git.js');
    const target = expectedTarget(root, 'feat-filed');
    track(target);
    git(root, ['worktree', 'add', '-b', 'feat/filed', target, 'HEAD']);
    fs.rmSync(target, { recursive: true, force: true });
    fs.writeFileSync(target, 'not a checkout\n');
    assert.ok(listWorktreePaths(root).includes(target), 'git still records the file path');
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
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.upsertWorktree(root, { branch: 'feat/filed', path: target, thread: 't-1', issues: [35], odd: [] }).ok, true);
      // LIST: file reads missing, never live, never pruned, never vanished.
      const listed = await tools.get('worktree_list').execute('c1', {}, undefined, undefined, makeCtx({ repoRoot: root, thread: 't-1' }).ctx);
      assert.equal(listed.isError, undefined);
      const row = listed.details.worktrees.find((i) => i.path === target);
      assert.ok(row, 'file row listed');
      assert.equal(row.status, 'missing', 'file is never live in the list');
      assert.deepEqual(listed.details.pruned, [], 'file never pruned');
      // CLOSE: file reads stale, entry kept.
      const closed = await tools.get('worktree_close').execute('c2', { branch: 'feat/filed', force: true }, undefined, undefined, makeCtx({ repoRoot: root, thread: 't-1' }).ctx);
      assert.equal(closed.isError, true);
      assert.match(resultText(closed), /not a live checkout/i, 'close agrees: stale, never live');
      // CREATE guard: the file path is never a live conflict.
      // A different branch colliding on the same slug must report the
      // occupant, never "already a live worktree".
      const created = await callCreate(tools, { branch: 'feat/filed', issues: [35] }, makeCtx({ repoRoot: root, thread: 't-2' }).ctx);
      assert.equal(created.isError, true);
      assert.ok(!/already.*live worktree/i.test(resultText(created)), `file must never read live in create: ${resultText(created)}`);
      // isPathInAnyCheckout skips the file record itself.
      assert.equal(gitLib.isPathInAnyCheckout(root, target), false, 'file record is not a live checkout');
    } finally {
      restoreEnv();
    }
  });
});

describe('I3: non-directory occupant at the target', { concurrency: false }, () => {
  test('a file at the target gives an actionable error and blocks no later create', async () => {
    const root = makeRepo('i3-file');
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
      const target = expectedTarget(root, 'feat-blocked');
      track(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'occupant\n');
      const before = listWorktreePaths(root);
      const failed = await callCreate(tools, { branch: 'feat/blocked', issues: [35] }, makeCtx({ repoRoot: root, thread: 't-1' }).ctx);
      assert.equal(failed.isError, true);
      const text = resultText(failed);
      assert.ok(text.includes(target), `names the occupant path: ${text}`);
      assert.match(text, /not a directory|occup|remove.*by hand|remove it/i, `actionable (name + what to do): ${text}`);
      assert.ok(!/fatal.*already exists/i.test(text), `never git raw fatal: ${text}`);
      const registryLib = require('../lib/worktree-registry.js');
      assert.deepEqual(registryLib.readRegistry(root).worktrees, [], 'no blocking registry state');
      // Removing the file lets the next create succeed at the same path.
      fs.unlinkSync(target);
      const retry = await callCreate(tools, { branch: 'feat/blocked', issues: [35] }, makeCtx({ repoRoot: root, thread: 't-1' }).ctx);
      assert.equal(retry.isError, undefined, `retry succeeds, got: ${resultText(retry)}`);
      assert.equal(resultText(retry), `worktree create: ${target}`);
      assert.ok(fs.existsSync(target) && fs.statSync(target).isDirectory(), 'checkout on disk');
      assert.deepEqual(listWorktreePaths(root).length, before.length + 1);
    } finally {
      restoreEnv();
    }
  });
});

describe('H3: relative git listing paths never resolve against the process cwd', { concurrency: false }, () => {
  test('isPathInAnyCheckout gives the same verdict from a decoy cwd', async () => {
    const root = makeRepo('decoy-cwd');
    const wtDir = path.join(path.dirname(root), `${path.basename(root)}-wt`);
    track(wtDir);
    git(root, ['worktree', 'add', '-b', 'feat/decoy', wtDir, 'HEAD']);
    const liveAbs = fs.realpathSync(wtDir);
    const rel = path.relative(root, liveAbs);
    assert.ok(!path.isAbsolute(rel), `expected a relative spelling, got: ${rel}`);
    const decoyBase = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-decoy-')));
    const decoy = path.join(decoyBase, 'sub', 'deep');
    fs.mkdirSync(decoy, { recursive: true });
    const gitLib = require('../lib/worktree-git.js');
    const origList = gitLib.listWorktrees;
    gitLib.listWorktrees = () => [{ path: rel, branch: 'feat/decoy', head: null, detached: false, bare: false }];
    const savedCwd = process.cwd();
    try {
      process.chdir(root);
      const atRoot = gitLib.isPathInAnyCheckout(root, liveAbs);
      process.chdir(decoy);
      const atDecoy = gitLib.isPathInAnyCheckout(root, liveAbs);
      assert.equal(atRoot, true, 'the relative listing blocks from the repository root');
      assert.equal(atDecoy, true, 'the same verdict holds from a decoy cwd (never resolved against process.cwd)');
    } finally {
      gitLib.listWorktrees = origList;
      try { process.chdir(savedCwd); } catch {}
    }
  });
});

describe('S20: an existing branch is adopted, never created', { concurrency: false }, () => {
  // Stub `herdr` with `worktree open` support: logs every argv line, then
  // emulates `worktree create` with `git worktree add -b` and answers
  // `worktree open` with `openExit` (0 = associated, non-zero = refused).
  function makeHerdrStubWithOpen(openExit) {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-herdr-open-')));
    const bin = path.join(dir, 'herdr');
    fs.writeFileSync(
      bin,
      [
        '#!/bin/sh',
        'printf \'%s\\n\' "$*" >> "$HERDR_SHIM_LOG"',
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
        'if [ "$1" = "worktree" ] && [ "$2" = "open" ]; then',
        '  shift 2',
        '  wtpath=""; cwd=""',
        '  while [ $# -gt 0 ]; do',
        '    case "$1" in',
        '      --path) wtpath="$2"; shift 2;;',
        '      --cwd) cwd="$2"; shift 2;;',
        '      *) shift;;',
        '    esac',
        '  done',
        `  [ -n "$wtpath" ] && [ -n "$cwd" ] || { echo "open: missing args" >&2; exit 1; }`,
        `  [ -d "$wtpath" ] || { echo "open: no checkout" >&2; exit 1; }`,
        `  exit ${openExit}`,
        'fi',
        'echo "herdr stub: unexpected argv $*" >&2; exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return { bin, log: path.join(dir, 'herdr-argv.log') };
  }

  function stdAdoptEnv(herdr, gh, modeEnv) {
    return {
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_EXIT: undefined,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    };
  }

  // Record every (bin, argv) the extension layer invokes, delegating to
  // the real runner so behavior is unchanged.
  function recordArgv() {
    const gitLib = require('../lib/worktree-git.js');
    const orig = gitLib.runArgv;
    const seen = [];
    gitLib.runArgv = (bin, args, opts) => {
      seen.push({ bin: String(bin), args: args.slice() });
      return orig(bin, args, opts);
    };
    return { gitLib, orig, seen };
  }

  test('a branch created by hand is adopted: no -b, ref untouched, branchCreated:false + warning', async () => {
    const root = makeRepo('adopt');
    git(root, ['branch', 'feat/adopted', 'HEAD']);
    const refBefore = git(root, ['rev-parse', 'refs/heads/feat/adopted']);
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdAdoptEnv(herdr, gh, modeEnv));
    const rec = recordArgv();
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-adopt' });
      const target = expectedTarget(root, 'feat-adopted');
      const result = await callCreate(tools, { branch: 'feat/adopted', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected adoption success, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      assert.equal(result.details.created, true);
      assert.equal(result.details.branchCreated, false, 'adoption reports branchCreated:false');
      assert.ok(
        (result.details.warnings || []).join('\n').includes('feat/adopted'),
        `a warning names the adopted branch: ${JSON.stringify(result.details.warnings)}`,
      );
      // The checkout is on that branch and the ref commit is unchanged.
      assert.equal(git(target, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/adopted');
      assert.equal(git(root, ['rev-parse', 'refs/heads/feat/adopted']), refBefore, 'the branch ref is never rewritten');
      assert.ok(listWorktreePaths(root).includes(target), 'checkout listed by git');
      // No `-b` in ANY git argv: the branch was never created.
      const gitArgs = rec.seen.filter((call) => call.bin === 'git').flatMap((call) => call.args);
      assert.ok(!gitArgs.includes('-b'), `no -b in any git argv: ${JSON.stringify(gitArgs)}`);
      // Herdr's create (which cannot adopt) never ran.
      assert.ok(
        !shimArgv(herdr.log).some((line) => line.includes('worktree create')),
        `herdr worktree create never ran: ${JSON.stringify(shimArgv(herdr.log))}`,
      );
    } finally {
      rec.gitLib.runArgv = rec.orig;
      restoreEnv();
    }
  });

  test('a fresh branch keeps the herdr-first -b path and reports branchCreated:true', async () => {
    const root = makeRepo('adopt-fresh');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdAdoptEnv(herdr, gh, modeEnv));
    const rec = recordArgv();
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-fresh' });
      const target = expectedTarget(root, 'feat-fresh');
      const result = await callCreate(tools, { branch: 'feat/fresh', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      assert.equal(result.details.branchCreated, true, 'a created branch reports branchCreated:true');
      assert.ok(
        shimArgv(herdr.log).some((line) => line.includes('worktree create')),
        `herdr ran first: ${JSON.stringify(shimArgv(herdr.log))}`,
      );
      const createLine = shimArgv(herdr.log).find((line) => line.includes('worktree create'));
      assert.ok(createLine.includes('--branch feat/fresh'), `herdr create names the branch: ${createLine}`);
      // Herdr succeeded, so the git fallback never ran: no `worktree add`
      // in any git argv the tool itself invoked.
      const gitArgs = rec.seen.filter((call) => call.bin === 'git').flatMap((call) => call.args);
      assert.ok(!gitArgs.includes('worktree'), `no git worktree argv when herdr wins: ${JSON.stringify(gitArgs)}`);
    } finally {
      rec.gitLib.runArgv = rec.orig;
      restoreEnv();
    }
  });

  test('adopt associates the Herdr workspace through worktree open when it works', async () => {
    const root = makeRepo('adopt-open-ok');
    git(root, ['branch', 'feat/open-ok', 'HEAD']);
    const herdr = makeHerdrStubWithOpen(0);
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdAdoptEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-open' });
      const target = expectedTarget(root, 'feat-open-ok');
      const result = await callCreate(tools, { branch: 'feat/open-ok', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      assert.equal(result.details.branchCreated, false);
      assert.equal(result.details.herdrAssociated, true, 'the open association is reported');
      const opens = shimArgv(herdr.log).filter((line) => line.includes('worktree open'));
      assert.equal(opens.length, 1, `exactly one herdr worktree open: ${JSON.stringify(shimArgv(herdr.log))}`);
      assert.ok(opens[0].includes(`--path ${target}`), `open names the path: ${opens[0]}`);
      assert.ok(opens[0].includes(`--cwd ${root}`), `open names the root: ${opens[0]}`);
      assert.ok(!opens[0].includes('='), `never --flag=value: ${opens[0]}`);
      assert.ok(fs.existsSync(target), 'the checkout exists either way');
    } finally {
      restoreEnv();
    }
  });

  test('adopt still succeeds when herdr open fails, reporting the outcome', async () => {
    const root = makeRepo('adopt-open-fail');
    git(root, ['branch', 'feat/open-fail', 'HEAD']);
    const refBefore = git(root, ['rev-parse', 'refs/heads/feat/open-fail']);
    const herdr = makeHerdrStubWithOpen(1);
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdAdoptEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 'thread-open-fail' });
      const target = expectedTarget(root, 'feat-open-fail');
      const result = await callCreate(tools, { branch: 'feat/open-fail', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, undefined, `the checkout never depends on herdr, got: ${text}`);
      assert.equal(text, `worktree create: ${target}`);
      assert.equal(result.details.branchCreated, false);
      assert.equal(result.details.herdrAssociated, false, 'the failed association is reported');
      assert.ok(
        (result.details.warnings || []).join('\n').match(/herdr/i),
        `a warning reports the herdr outcome: ${JSON.stringify(result.details.warnings)}`,
      );
      assert.equal(git(target, ['rev-parse', '--abbrev-ref', 'HEAD']), 'feat/open-fail');
      assert.equal(git(root, ['rev-parse', 'refs/heads/feat/open-fail']), refBefore);
    } finally {
      restoreEnv();
    }
  });
});

describe('S22: any pre-existing entry at the target is refused before any backend', { concurrency: false }, () => {
  function stdExistEnv(herdr, gh, modeEnv) {
    return {
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_EXIT: undefined,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    };
  }

  // An occupant refusal names the path, names what is there, and tells
  // the caller what to do — never git's raw fatal.
  function assertOccupantRefusal(result, target, kindPattern) {
    assert.equal(result.isError, true);
    const text = resultText(result);
    assert.ok(text.includes(target), `names the occupant path: ${text}`);
    assert.match(text, kindPattern, `names what is there: ${text}`);
    assert.match(text, /remove it by hand or pick another branch/i, `actionable: ${text}`);
    assert.ok(!/fatal.*already exists/i.test(text), `never git raw fatal: ${text}`);
    return text;
  }

  function assertNoBackendNoRegistry(root, herdr, params) {
    assert.deepEqual(shimArgv(herdr.log), [], `no backend ran for ${params.branch}`);
    const registryLib = require('../lib/worktree-registry.js');
    assert.deepEqual(registryLib.readRegistry(root).worktrees, [], 'no registry row is written');
  }

  test('an EMPTY directory at the target is refused (git would silently adopt it)', async () => {
    const root = makeRepo('exist-empty');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdExistEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-empty' });
      const target = expectedTarget(root, 'feat-occupied');
      track(target);
      fs.mkdirSync(target, { recursive: true });
      const before = listWorktreePaths(root);
      const refused = await callCreate(tools, { branch: 'feat/occupied', issues: [35] }, ctx);
      assertOccupantRefusal(refused, target, /occupied by an empty directory/i);
      assert.deepEqual(listWorktreePaths(root), before, 'no checkout is added');
      assert.ok(fs.existsSync(target), 'the occupant is left for the caller to remove');
      assertNoBackendNoRegistry(root, herdr, { branch: 'feat/occupied' });
      // Removing the occupant lets the next create succeed at the same path.
      fs.rmdirSync(target);
      const retry = await callCreate(tools, { branch: 'feat/occupied', issues: [35] }, ctx);
      assert.equal(retry.isError, undefined, `retry succeeds, got: ${resultText(retry)}`);
      assert.equal(resultText(retry), `worktree create: ${target}`);
    } finally {
      restoreEnv();
    }
  });

  test('a NON-empty directory at the target is refused, never git raw fatal', async () => {
    const root = makeRepo('exist-full');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdExistEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-full' });
      const target = expectedTarget(root, 'feat-full');
      track(target);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'hand-made.txt'), 'mine\n');
      const before = listWorktreePaths(root);
      const refused = await callCreate(tools, { branch: 'feat/full', issues: [35] }, ctx);
      assertOccupantRefusal(refused, target, /non-empty directory/i);
      assert.deepEqual(listWorktreePaths(root), before, 'no checkout is added');
      assertNoBackendNoRegistry(root, herdr, { branch: 'feat/full' });
    } finally {
      restoreEnv();
    }
  });

  test('a file at the target is refused with the same actionable message', async () => {
    const root = makeRepo('exist-file');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdExistEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-file' });
      const target = expectedTarget(root, 'feat-f');
      track(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, 'occupant\n');
      const refused = await callCreate(tools, { branch: 'feat/f', issues: [35] }, ctx);
      assertOccupantRefusal(refused, target, /file/i);
      assertNoBackendNoRegistry(root, herdr, { branch: 'feat/f' });
    } finally {
      restoreEnv();
    }
  });

  test('a FIFO at the target is refused with the same actionable message', async () => {
    const root = makeRepo('exist-fifo');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdExistEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-fifo' });
      const target = expectedTarget(root, 'feat-fifo');
      track(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const mk = spawnSync('mkfifo', [target], { encoding: 'utf8' });
      assert.equal(mk.status, 0, `mkfifo failed: ${mk.stderr}`);
      const refused = await callCreate(tools, { branch: 'feat/fifo', issues: [35] }, ctx);
      assertOccupantRefusal(refused, target, /fifo/i);
      assertNoBackendNoRegistry(root, herdr, { branch: 'feat/fifo' });
    } finally {
      restoreEnv();
    }
  });

  test('a dangling symlink at the target is refused with the same actionable message', async () => {
    const root = makeRepo('exist-dangle');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdExistEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-dangle' });
      const target = expectedTarget(root, 'feat-dangle');
      track(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.join(path.dirname(target), 'nowhere-gone'), target);
      const refused = await callCreate(tools, { branch: 'feat/dangle', issues: [35] }, ctx);
      // F4: a dangling link names no referent — a plain symlink refusal.
      const dangleText = assertOccupantRefusal(refused, target, /occupied by a symlink:/i);
      assert.ok(!/to a file|to a directory/i.test(dangleText), `names no referent: ${dangleText}`);
      assertNoBackendNoRegistry(root, herdr, { branch: 'feat/dangle' });
    } finally {
      restoreEnv();
    }
  });

  test('a symlink to a directory at the target is refused with the same actionable message', async () => {
    const root = makeRepo('exist-linkdir');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdExistEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-linkdir' });
      const target = expectedTarget(root, 'feat-linkdir');
      track(target);
      const elsewhere = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-elsewhere-')));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(elsewhere, target);
      const before = listWorktreePaths(root);
      const refused = await callCreate(tools, { branch: 'feat/linkdir', issues: [35] }, ctx);
      assertOccupantRefusal(refused, target, /symlink/i);
      assert.deepEqual(listWorktreePaths(root), before, 'no checkout is added');
      assertNoBackendNoRegistry(root, herdr, { branch: 'feat/linkdir' });
    } finally {
      restoreEnv();
    }
  });

  test('the thread own registered checkout stays the single idempotent exception', async () => {
    const root = makeRepo('exist-own');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdExistEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-own' });
      const first = await callCreate(tools, { branch: 'feat/own', issues: [35] }, ctx);
      assert.equal(first.isError, undefined, `setup create failed: ${resultText(first)}`);
      const target = first.details.path;
      assert.ok(fs.statSync(target).isDirectory(), 'the target exists on disk');
      const second = await callCreate(tools, { branch: 'feat/own', issues: [35] }, ctx);
      assert.equal(second.isError, undefined);
      assert.equal(resultText(second), `worktree create: ${target}`);
      assert.equal(second.details.created, false, 'the own checkout returns created:false, never a refusal');
    } finally {
      restoreEnv();
    }
  });
});

describe('F4: symlink occupant names its referent', { concurrency: false }, () => {
  function stdEnv(herdr, gh, modeEnv) {
    return {
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_EXIT: undefined,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
    };
  }

  test('a symlink to a FILE is refused as a symlink to a file', async () => {
    const root = makeRepo('f4-linkfile');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-f4-file' });
      const target = expectedTarget(root, 'feat-f4file');
      track(target);
      const referent = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-referent-')));
      const referentFile = path.join(referent, 'real.txt');
      fs.writeFileSync(referentFile, 'real\n');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(referentFile, target);
      const result = await callCreate(tools, { branch: 'feat/f4file', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, true);
      assert.ok(text.includes(target), `names the occupant path: ${text}`);
      assert.match(text, /occupied by a symlink to a file/i, `names the file referent: ${text}`);
      assert.match(text, /remove it by hand or pick another branch/i);
      assert.deepEqual(shimArgv(herdr.log), [], 'no backend ran');
      assert.deepEqual(require('../lib/worktree-registry.js').readRegistry(root).worktrees, [], 'no registry row is written');
    } finally {
      restoreEnv();
    }
  });

  test('a symlink to a DIRECTORY is refused as a symlink to a directory', async () => {
    const root = makeRepo('f4-linkdir');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-f4-dir' });
      const target = expectedTarget(root, 'feat-f4dir');
      track(target);
      const referent = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-referent-')));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(referent, target);
      const result = await callCreate(tools, { branch: 'feat/f4dir', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, true);
      assert.ok(text.includes(target), `names the occupant path: ${text}`);
      assert.match(text, /occupied by a symlink to a directory/i, `names the directory referent: ${text}`);
      assert.match(text, /remove it by hand or pick another branch/i);
      assert.deepEqual(shimArgv(herdr.log), [], 'no backend ran');
      assert.deepEqual(require('../lib/worktree-registry.js').readRegistry(root).worktrees, [], 'no registry row is written');
    } finally {
      restoreEnv();
    }
  });

  test('a DANGLING symlink is refused as a plain symlink', async () => {
    const root = makeRepo('f4-dangle');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv(stdEnv(herdr, gh, modeEnv));
    try {
      const tools = await loadExtension();
      const { ctx } = makeCtx({ repoRoot: root, thread: 't-f4-dangle' });
      const target = expectedTarget(root, 'feat-f4dangle');
      track(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.symlinkSync(path.join(path.dirname(target), 'nowhere-gone'), target);
      const result = await callCreate(tools, { branch: 'feat/f4dangle', issues: [35] }, ctx);
      const text = resultText(result);
      assert.equal(result.isError, true);
      assert.ok(text.includes(target), `names the occupant path: ${text}`);
      assert.match(text, /occupied by a symlink:/, `dangling stays a plain symlink: ${text}`);
      assert.ok(!/to a file|to a directory/i.test(text), `names no referent: ${text}`);
      assert.match(text, /remove it by hand or pick another branch/i);
      assert.deepEqual(shimArgv(herdr.log), [], 'no backend ran');
      assert.deepEqual(require('../lib/worktree-registry.js').readRegistry(root).worktrees, [], 'no registry row is written');
    } finally {
      restoreEnv();
    }
  });
});
