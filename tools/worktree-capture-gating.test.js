'use strict';
// Regression tests (test-first) for M1 and M2.
//
// M1: the `odd/` capture is NOT gated by the mode — with the mode disabled
// the capture still wrote registry metadata. The capture handler must read
// the mode through lib/worktree-mode.js on every event and do nothing when
// the mode is disabled or malformed.
//
// M2: replacing a malformed registry loses its bytes. Before replacing a
// malformed registry, the existing bytes must be copied to a sibling backup
// named `<registry>.corrupt-<timestamp>` (best-effort, never fatal) and the
// backup path reported in the operation result. A valid registry is never
// backed up.
//
// Loading pattern mirrors tools/worktree-odd-capture.test.js: the
// TypeScript extension is plain JS under the hood (// @ts-nocheck), so the
// test copies it to a temporary .mjs path with the package import lines
// stubbed and import()s it with a fake `pi`.

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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-gate-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

// Fixture repository with a principal `odd/` directory, a real linked
// worktree whose `odd/` symlinks into the principal (exactly what the
// creation hooks build), and a registry entry owning that worktree.
function makeRepoWithWorktree(tag) {
  const root = makeRepo(tag);
  const branch = 'feat/odd';
  const principalOdd = path.join(root, 'odd');
  fs.mkdirSync(principalOdd, { recursive: true });
  fs.writeFileSync(path.join(principalOdd, 'notes.md'), '# notes\n');
  const target = path.join(path.dirname(root), `${path.basename(root)}-wt-feat-odd`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const realTarget = fs.realpathSync(target);
  fs.symlinkSync(principalOdd, path.join(realTarget, 'odd'));
  const registryLib = require('../lib/worktree-registry.js');
  assert.equal(registryLib.upsertWorktree(root, {
    branch, path: realTarget, thread: 'thread-1', issues: [35], odd: [],
  }).ok, true);
  return { root, target: realTarget, branch };
}

// Stub `gh`: answers `issue view <n>` for the known issues.
function makeGhStub(knownIssues) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gate-gh-')));
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

function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gate-mode-'))) };
}

function commonDirOf(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
}

function corruptSiblings(root) {
  return fs.readdirSync(commonDirOf(root)).filter((name) => name.startsWith('pi-worktrees.json.corrupt-'));
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-gate-ext-')));
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

function ctxFor(cwd) {
  return { cwd, sessionManager: { getSessionId: () => 'thread-1' }, ui: { notify: () => {} } };
}

async function dispatch(handlers, eventName, event, ctx) {
  const list = handlers.get(eventName) || [];
  assert.ok(list.length > 0, `expected a ${eventName} subscription`);
  const returns = [];
  for (const handler of list) {
    returns.push(await handler(event, ctx));
  }
  return returns;
}

function registryBytes(root) {
  const registryLib = require('../lib/worktree-registry.js');
  return fs.readFileSync(registryLib.registryPath(root));
}

describe('worktree odd-capture mode gating', { concurrency: false }, () => {
  test('with the mode disabled, a read/edit of odd/*.md writes nothing', async () => {
    const { root, target, branch } = makeRepoWithWorktree('disabled');
    const modeLib = require('../lib/worktree-mode.js');
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib.writeMode(false, process.env);
      const { handlers } = await loadExtension();
      const before = registryBytes(root);
      const ctx = ctxFor(target);
      const full = path.join(target, 'odd', 'notes.md');
      for (const toolName of ['read', 'edit']) {
        const returns = await dispatch(handlers, 'tool_call', { toolName, args: { path: full } }, ctx);
        for (const value of returns) assert.equal(value, undefined);
      }
      assert.deepEqual(registryBytes(root), before, 'a disabled mode produces no registry write at all');
      assert.deepEqual(require('../lib/worktree-registry.js').findByBranch(root, branch).odd, []);
    } finally {
      restoreEnv();
    }
  });

  test('with a malformed mode file, a read/edit of odd/*.md writes nothing', async () => {
    const { root, target, branch } = makeRepoWithWorktree('malformed');
    const modeLib = require('../lib/worktree-mode.js');
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      fs.writeFileSync(modeLib.modePath(process.env), '{ malformed {{{');
      const { handlers } = await loadExtension();
      const before = registryBytes(root);
      const returns = await dispatch(
        handlers, 'tool_call',
        { toolName: 'read', args: { path: path.join(target, 'odd', 'notes.md') } },
        ctxFor(target),
      );
      for (const value of returns) assert.equal(value, undefined);
      assert.deepEqual(registryBytes(root), before, 'a malformed mode never enables the capture');
      assert.deepEqual(require('../lib/worktree-registry.js').findByBranch(root, branch).odd, []);
    } finally {
      restoreEnv();
    }
  });

  test('with the mode enabled, the same event records the document', async () => {
    const { root, target, branch } = makeRepoWithWorktree('enabled');
    const modeLib = require('../lib/worktree-mode.js');
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR });
    try {
      modeLib.writeMode(true, process.env);
      const { handlers } = await loadExtension();
      const returns = await dispatch(
        handlers, 'tool_call',
        { toolName: 'read', args: { path: path.join(target, 'odd', 'notes.md') } },
        ctxFor(target),
      );
      for (const value of returns) assert.equal(value, undefined);
      assert.deepEqual(
        require('../lib/worktree-registry.js').findByBranch(root, branch).odd,
        ['odd/notes.md'],
      );
    } finally {
      restoreEnv();
    }
  });
});

describe('malformed registry backup', { concurrency: false }, () => {
  test('a successful create over a malformed registry preserves the old bytes beside it', async () => {
    const root = makeRepo('corrupt');
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    // No herdr binary: the git fallback performs the creation. Hooks still
    // run (env copies, installs, symlinks) exactly like production.
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-xyz'),
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: 'thread-1',
    });
    try {
      const registryLib = require('../lib/worktree-registry.js');
      const file = registryLib.registryPath(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{"not json');
      const { tools } = await loadExtension();
      const create = tools.get('worktree_create');
      assert.ok(create, 'expected worktree_create to be registered');
      const ctx = ctxFor(root);
      const result = await create.execute('call-1', { branch: 'feat/kept', issues: [35] }, undefined, undefined, ctx);
      assert.equal(result.isError, undefined, `expected success: ${(result.content || []).map((p) => p.text).join('\n')}`);
      track(result.details.path);
      // The entry is written …
      assert.equal(registryLib.findByBranch(root, 'feat/kept').path, result.details.path);
      // … AND the previous bytes survive beside the registry.
      const siblings = corruptSiblings(root);
      assert.equal(siblings.length, 1, `expected one .corrupt-* sibling, got ${JSON.stringify(siblings)}`);
      assert.equal(
        fs.readFileSync(path.join(commonDirOf(root), siblings[0]), 'utf8'),
        '{"not json',
        'the backup holds the exact original malformed bytes',
      );
      // The operation result names the backup so the caller can report it.
      assert.equal(result.details.registryBackup, path.join(commonDirOf(root), siblings[0]));
    } finally {
      restoreEnv();
    }
  });

  test('a create over a valid registry creates no .corrupt-* file', async () => {
    const root = makeRepo('valid');
    const gh = makeGhStub([35]);
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-xyz'),
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: 'thread-1',
    });
    try {
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.upsertWorktree(root, {
        branch: 'feat/other', path: path.join(path.dirname(root), 'other-wt'), thread: 'thread-9', issues: [7], odd: [],
      }).ok, true);
      // The valid upsert above must not back anything up either.
      assert.deepEqual(corruptSiblings(root), []);
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'call-1', { branch: 'feat/fresh', issues: [35] }, undefined, undefined, ctxFor(root),
      );
      assert.equal(result.isError, undefined, `expected success: ${(result.content || []).map((p) => p.text).join('\n')}`);
      track(result.details.path);
      assert.deepEqual(corruptSiblings(root), [], 'a valid registry is never backed up');
      assert.equal(result.details.registryBackup, undefined);
    } finally {
      restoreEnv();
    }
  });
});
