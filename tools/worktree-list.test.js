'use strict';
// T11/S16 tests (test-first): `worktree_list` verifies every registered
// path exists — a path that no longer exists is removed from the listing
// AND pruned from the registry, so the tool always exposes only real
// checkouts.
//
// Loading pattern mirrors tools/worktree-close.test.js: the TypeScript
// extension is plain JS under the hood, so the test copies it to a
// temporary .mjs path with the package import lines stubbed and import()s
// it with a fake `pi` object. Every test builds its own isolated fixture
// repository under os.tmpdir(). Only observable behavior is asserted:
// result text, details.pruned/details.warnings, registry bytes, and which
// paths exist on disk.

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
const savedEnv = { ...process.env };
after(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-list-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-list-mode-'))) };
}

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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-list-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = { registerTool: (tool) => { tools.set(tool.name, tool); } };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
}

function makeCtx(repoRoot) {
  return {
    cwd: repoRoot,
    hasUI: false,
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: { confirm: async () => true, notify: () => {} },
  };
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

function livePaths(root) {
  return git(root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
}

function addRegistered(root, branch, { thread = 'thread-1', issues = [35] } = {}) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-wt-${slug}`);
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const registryLib = require('../lib/worktree-registry.js');
  const stored = registryLib.upsertWorktree(root, {
    branch, path: target, thread, issues, odd: [],
  });
  assert.equal(stored.ok, true);
  return fs.realpathSync(target);
}

function stdEnv() {
  return { GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: scratchModeEnv().GENTLE_STATUS_STATE_DIR, GENTLE_WORKTREE_THREAD: undefined };
}

describe('worktree_list prunes checkouts deleted out of band (S16)', { concurrency: false }, () => {
  test('one dead row among live ones is excluded and pruned, naming the path', async () => {
    const root = makeRepo('prune-one');
    setEnv(stdEnv());
    try {
      const live = addRegistered(root, 'feat/live', { thread: 'thread-1', issues: [35] });
      const dead = addRegistered(root, 'feat/dead', { thread: 'thread-2', issues: [7] });
      git(root, ['worktree', 'remove', '--force', dead]);
      assert.ok(!livePaths(root).includes(dead), 'the checkout is really gone');
      assert.equal(fs.existsSync(dead), false, 'the path no longer exists');

      const tools = await loadExtension();
      const result = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      // The listing exposes only the real checkout.
      assert.equal(text, `worktree list: ${live} feat/live thread=thread-1 issues=35`);
      assert.deepEqual(result.details.worktrees.map((item) => item.path), [live]);
      // The pruned path travels in details and in the warning text.
      assert.deepEqual(result.details.pruned, [dead]);
      assert.ok(
        result.details.warnings.join('\n').includes(dead),
        `the warning names the pruned path: ${JSON.stringify(result.details.warnings)}`,
      );
      assert.ok(
        result.details.warnings.join('\n').includes('git worktree prune'),
        `the warning says git may still record the checkout: ${JSON.stringify(result.details.warnings)}`,
      );
      // The registry keeps the live row and drops exactly the dead one.
      const registryLib = require('../lib/worktree-registry.js');
      const after = registryLib.readRegistry(root);
      assert.equal(after.ok, true);
      assert.deepEqual(after.worktrees.map((entry) => entry.path), [live]);
    } finally {
      restoreEnv();
    }
  });

  test('all rows dead lists none and empties the registry', async () => {
    const root = makeRepo('prune-all');
    setEnv(stdEnv());
    try {
      const first = addRegistered(root, 'feat/gone-one', { thread: 'thread-1', issues: [35] });
      const second = addRegistered(root, 'feat/gone-two', { thread: 'thread-2', issues: [7] });
      git(root, ['worktree', 'remove', '--force', first]);
      git(root, ['worktree', 'remove', '--force', second]);

      const tools = await loadExtension();
      const result = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, makeCtx(root));
      assert.equal(result.isError, undefined);
      assert.equal(resultText(result), 'worktree list: none');
      assert.deepEqual(result.details.worktrees, []);
      assert.equal(result.details.count, 0);
      assert.deepEqual([...result.details.pruned].sort(), [first, second].sort());
      const registryLib = require('../lib/worktree-registry.js');
      assert.deepEqual(registryLib.readRegistry(root).worktrees, []);
    } finally {
      restoreEnv();
    }
  });

  test('a malformed registry never throws and reports the damage', async () => {
    const root = makeRepo('prune-malformed');
    setEnv(stdEnv());
    try {
      const registryLib = require('../lib/worktree-registry.js');
      const file = registryLib.registryPath(root);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tools = await loadExtension();
      for (const [tag, bytes] of [['invalid-json', '{oops{{{'], ['wrong-shape', '{"version":1}']]) {
        fs.writeFileSync(file, bytes);
        const result = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, makeCtx(root));
        assert.equal(result.isError, true, `[${tag}] a damaged registry is an error, never a throw`);
        assert.match(resultText(result), /registry/i, `[${tag}] the error names the registry`);
      }
    } finally {
      restoreEnv();
    }
  });

  test('a prune write failure still excludes the dead rows and says so', async () => {
    const root = makeRepo('prune-fail');
    setEnv(stdEnv());
    try {
      const live = addRegistered(root, 'feat/live', { thread: 'thread-1', issues: [35] });
      const dead = addRegistered(root, 'feat/dead', { thread: 'thread-2', issues: [7] });
      git(root, ['worktree', 'remove', '--force', dead]);
      const registryLib = require('../lib/worktree-registry.js');
      const beforeBytes = fs.readFileSync(registryLib.registryPath(root));

      // Fail the atomic registry write (ENOSPC mid-write, like R4-5).
      const origWrite = fs.writeFileSync;
      fs.writeFileSync = function (file, data, opts) {
        if (typeof file === 'string' && file.includes('.tmp.') && opts && opts.flag === 'wx') {
          const err = new Error('ENOSPC: no space left on device, write');
          err.code = 'ENOSPC';
          throw err;
        }
        return origWrite.call(fs, file, data, opts);
      };
      let result;
      try {
        const tools = await loadExtension();
        result = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, makeCtx(root));
      } finally {
        fs.writeFileSync = origWrite;
      }
      const text = resultText(result);
      assert.equal(result.isError, undefined, `the listing still succeeds, got: ${text}`);
      assert.equal(text, `worktree list: ${live} feat/live thread=thread-1 issues=35`);
      assert.deepEqual(result.details.pruned, [], 'nothing was pruned');
      assert.ok(result.details.pruneError, 'the write failure travels in details');
      assert.ok(
        result.details.warnings.join('\n').includes(dead),
        `the warning still names the dead path: ${JSON.stringify(result.details.warnings)}`,
      );
      assert.deepEqual(fs.readFileSync(registryLib.registryPath(root)), beforeBytes, 'registry bytes unchanged');
    } finally {
      restoreEnv();
    }
  });

  test('a path that exists but git no longer lists stays missing and is never pruned', async () => {
    const root = makeRepo('prune-exists');
    setEnv(stdEnv());
    try {
      // A plain directory that was never a checkout, hand-registered.
      const plain = path.join(path.dirname(root), `${path.basename(root)}-plain`);
      track(plain);
      fs.mkdirSync(plain, { recursive: true });
      const realPlain = fs.realpathSync(plain);
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.upsertWorktree(root, {
        branch: 'feat/plain', path: realPlain, thread: 'thread-1', issues: [35], odd: [],
      }).ok, true);
      assert.ok(!livePaths(root).includes(realPlain), 'git does not list the plain directory');
      const beforeBytes = fs.readFileSync(registryLib.registryPath(root));

      const tools = await loadExtension();
      const result = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      assert.equal(text, `worktree list: ${realPlain} feat/plain thread=thread-1 issues=35 missing`);
      assert.deepEqual(result.details.pruned, [], 'an existing path is never pruned');
      assert.deepEqual(fs.readFileSync(registryLib.registryPath(root)), beforeBytes, 'registry untouched');
    } finally {
      restoreEnv();
    }
  });

  test('live checkouts still list exactly, with no prune noise', async () => {
    const root = makeRepo('prune-live');
    setEnv(stdEnv());
    try {
      const first = addRegistered(root, 'feat/one', { thread: 'thread-1', issues: [35] });
      const second = addRegistered(root, 'feat/two', { thread: 'thread-2', issues: [35, 7] });
      const beforeBytes = fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root));

      const tools = await loadExtension();
      const result = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, makeCtx(root));
      assert.equal(result.isError, undefined);
      assert.equal(
        resultText(result),
        `worktree list: ${first} feat/one thread=thread-1 issues=35\n`
        + `worktree list: ${second} feat/two thread=thread-2 issues=35,7`,
      );
      assert.deepEqual(result.details.pruned, []);
      assert.deepEqual(result.details.warnings, []);
      assert.deepEqual(fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root)), beforeBytes);
    } finally {
      restoreEnv();
    }
  });

  test('F1: a hand-deleted checkout git still lists never reappears as unregistered', async () => {
    const root = makeRepo('prune-hand-deleted');
    setEnv(stdEnv());
    try {
      const live = addRegistered(root, 'feat/live', { thread: 'thread-1', issues: [35] });
      const dead = addRegistered(root, 'feat/dead', { thread: 'thread-2', issues: [7] });
      // Hand-delete the checkout directory: git still records it, the
      // path no longer exists. Never `git worktree remove` here.
      fs.rmSync(dead, { recursive: true, force: true });
      assert.equal(fs.existsSync(dead), false, 'the path no longer exists');
      assert.ok(livePaths(root).includes(dead), 'git still records the deleted checkout');

      const tools = await loadExtension();
      const first = await tools.get('worktree_list').execute('call-1', {}, undefined, undefined, makeCtx(root));
      assert.equal(first.isError, undefined);
      assert.deepEqual(first.details.pruned, [dead], 'first call prunes the dead row');

      const second = await tools.get('worktree_list').execute('c', { all: true }, undefined, undefined, makeCtx(root));
      const text = resultText(second);
      assert.equal(second.isError, undefined, `expected success, got: ${text}`);
      assert.ok(!text.includes(dead), `second all:true call must not contain the dead path: ${text}`);
      for (const item of second.details.worktrees) {
        assert.equal(fs.existsSync(item.path), true, `details.worktrees carries no non-existent path: ${item.path}`);
      }
      assert.ok(!second.details.worktrees.some((item) => item.path === dead), 'dead path absent from details');
      assert.ok(livePaths(root).includes(live), 'live checkout still listed');
    } finally {
      restoreEnv();
    }
  });
});

describe('consolidated checkout liveness: files + relative git listing', { concurrency: false }, () => {
  test('FILE: a path that exists but is a FILE is never live, in either mode, and is not pruned', async () => {
    const root = makeRepo('file-row');
    setEnv(stdEnv());
    try {
      const filePath = path.join(path.dirname(root), `${path.basename(root)}-afile.txt`);
      track(filePath);
      fs.writeFileSync(filePath, 'not a checkout\n');
      const realFile = fs.realpathSync(filePath);
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.upsertWorktree(root, {
        branch: 'feat/filerow', path: realFile, thread: 'thread-1', issues: [35], odd: [],
      }).ok, true);
      const beforeBytes = fs.readFileSync(registryLib.registryPath(root));

      const gitLib = require('../lib/worktree-git.js');
      const origList = gitLib.listWorktrees;
      const baseLive = origList(root);
      // Unregistered FILE the lying git claims is a checkout: must never surface.
      const extraFile = path.join(path.dirname(root), `${path.basename(root)}-extra-file.txt`);
      track(extraFile);
      fs.writeFileSync(extraFile, 'not a checkout\n');
      gitLib.listWorktrees = () => [...baseLive, { path: extraFile, branch: 'feat/extra', head: null, detached: false, bare: false }];

      const tools = await loadExtension();
      try {
      for (const params of [{}, { all: true }]) {
        const result = await tools.get('worktree_list').execute('call-1', params, undefined, undefined, makeCtx(root));
        const text = resultText(result);
        assert.equal(result.isError, undefined, `expected success, got: ${text}`);
        assert.ok(text.includes('feat/filerow') && text.includes('missing'), `file row is missing, never live: ${text}`);
        assert.ok(!text.split('\n').some((line) => line.includes('feat/filerow') && !line.endsWith(' missing')), 'never reported live');
        assert.deepEqual(result.details.pruned, [], 'a file row is never pruned');
        const row = result.details.worktrees.find((item) => item.path === realFile);
        assert.ok(row, 'file row stays in details');
        assert.equal(row.status, 'missing');
        assert.ok(!text.includes('feat/extra'), `a file is never an unregistered checkout: ${text}`);
        assert.ok(!result.details.worktrees.some((item) => item.path === extraFile), 'file extra absent from details');
      }
      } finally {
        gitLib.listWorktrees = origList;
      }
      assert.deepEqual(fs.readFileSync(registryLib.registryPath(root)), beforeBytes, 'registry untouched');
    } finally {
      restoreEnv();
    }
  });

  test('RELATIVE-GIT: a lying relative listing resolves against the repo root, never the process cwd', async () => {
    const root = makeRepo('relative-git');
    setEnv(stdEnv());
    const savedCwd = process.cwd();
    try {
      const live = addRegistered(root, 'feat/live', { thread: 'thread-1', issues: [35] });
      const relLive = path.relative(root, live);
      assert.ok(!path.isAbsolute(relLive), 'relative form for the lying git');
      // Decoy cwd: resolving the relative ghost against the DECOY would
      // find a live directory there; resolving against the repo root finds
      // nothing. The tool must use the repo root.
      const decoyBase = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-decoy-')));
      const decoy = path.join(decoyBase, 'sub', 'deep');
      fs.mkdirSync(decoy, { recursive: true });
      const decoyGhost = path.join(decoy, 'ghost-relative');
      fs.mkdirSync(decoyGhost, { recursive: true });
      const gitLib = require('../lib/worktree-git.js');
      const origList = gitLib.listWorktrees;
      gitLib.listWorktrees = (repoRoot) => [
        { path: relLive, branch: 'feat/live', head: null, detached: false, bare: false },
        { path: 'ghost-relative', branch: 'feat/ghost', head: null, detached: false, bare: false },
      ];
      process.chdir(decoy);
      let result;
      try {
        const tools = await loadExtension();
        result = await tools.get('worktree_list').execute('call-1', { all: true }, undefined, undefined, makeCtx(root));
      } finally {
        gitLib.listWorktrees = origList;
        try { process.chdir(savedCwd); } catch {}
      }
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      assert.ok(text.includes(`${live} feat/live thread=thread-1 issues=35`), `live checkout stays live, not missing: ${text}`);
      assert.ok(!text.split('\n').some((line) => line.includes('feat/live') && line.endsWith(' missing')), 'must not mislabel live as missing');
      assert.ok(!text.includes('ghost-relative'), `non-existent extra never reported: ${text}`);
      assert.ok(!result.details.worktrees.some((item) => item.path.includes('ghost-relative')), 'ghost absent from details');
      for (const item of result.details.worktrees) {
        assert.equal(fs.existsSync(item.path), true, `details carries no non-existent path: ${item.path}`);
      }
    } finally {
      try { process.chdir(savedCwd); } catch {}
      restoreEnv();
    }
  });
});
