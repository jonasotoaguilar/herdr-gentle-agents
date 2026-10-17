'use strict';
// T18-T23 / S25-S32 tests (test-first RED): odd docs on list, create
// odd + create-or-update, startup discovery, name-or-path resolution,
// principal rules, detector boundary.
//
// Loading pattern mirrors tools/worktree-list.test.js: stub the two
// package imports, copy the extension to a temp .mjs, import with a fake
// pi. Fixtures are isolated repos under os.tmpdir(); only roots tracked
// here are removed.

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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-ou-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
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

function stdEnv() {
  return {
    GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
    GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ou-mode-'))),
    GENTLE_WORKTREE_THREAD: undefined,
    // Fail-closed herdr injection: with no binary injected the extension
    // refuses to spawn live herdr (resolveHerdrBinary throws under the
    // test harness), so every test here names a binary that cannot exist.
    // The herdr-first create path then falls back to `git worktree add`
    // without ever touching a live Herdr session.
    HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-ou'),
  };
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ou-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: () => {},
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return { tools, handlers };
}

function makeCtx(cwd, thread = 'thread-1') {
  return {
    cwd,
    hasUI: false,
    sessionManager: { getSessionId: () => thread },
    ui: { confirm: async () => true, notify: () => {} },
  };
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

function addRegistered(root, branch, { thread = 'thread-1', issues = [], odd = [] } = {}) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-ou-${slug}`);
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const realTarget = fs.realpathSync(target);
  const registryLib = require('../lib/worktree-registry.js');
  const stored = registryLib.upsertWorktree(root, {
    branch, path: realTarget, thread, issues, odd,
  });
  assert.equal(stored.ok, true);
  return realTarget;
}

function addUnregistered(root, branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(root), `${path.basename(root)}-ou-${slug}`);
  try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  track(target);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  return fs.realpathSync(target);
}

describe('T18/S25: list carries the auto-detected odd document', { concurrency: false }, () => {
  test('a worktree with odd/*.md lists it in text and details with the path', async () => {
    const root = makeRepo('list-odd');
    setEnv(stdEnv());
    try {
      const target = addRegistered(root, 'feat/odd-list');
      fs.mkdirSync(path.join(target, 'odd'), { recursive: true });
      fs.writeFileSync(path.join(target, 'odd', 'notes.md'), '# notes\n');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_list').execute('c1', {}, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      const row = result.details.worktrees.find((item) => item.branch === 'feat/odd-list');
      assert.ok(row, 'row present in details');
      assert.ok(path.isAbsolute(row.path), 'details keeps the absolute checkout path');
      assert.ok(Array.isArray(row.odd) && row.odd.length > 0, `row carries odd docs: ${JSON.stringify(row)}`);
      assert.ok(row.odd.some((o) => String(o).includes('notes.md')), `odd names notes.md: ${JSON.stringify(row.odd)}`);
      const line = text.split('\n').find((l) => l.includes('feat/odd-list'));
      assert.ok(line && line.includes('notes.md'), `agent text carries the odd doc: ${text}`);
    } finally {
      restoreEnv();
    }
  });
});

describe('T19/S26: create accepts an optional validated odd path', { concurrency: false }, () => {
  test('a supplied odd file is stored with the registration', async () => {
    const root = makeRepo('create-odd');
    setEnv(stdEnv());
    try {
      const doc = path.join(root, 'odd-doc.md');
      fs.writeFileSync(doc, '# doc\n');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/with-odd', odd: doc }, undefined, undefined, makeCtx(root, 'thread-odd-1'),
      );
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/with-odd');
      assert.ok(entry, 'registered');
      assert.ok(Array.isArray(entry.odd) && entry.odd.length > 0, `odd stored: ${JSON.stringify(entry)}`);
      assert.ok(path.isAbsolute(result.details.path), 'create output keeps the checkout path');
    } finally {
      restoreEnv();
    }
  });

  test('a missing odd file fails closed with no checkout and no row', async () => {
    const root = makeRepo('create-odd-bad');
    setEnv(stdEnv());
    try {
      const missing = path.join(root, 'no-such-odd.md');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1', { branch: 'feat/bad-odd', odd: missing }, undefined, undefined, makeCtx(root, 'thread-odd-2'),
      );
      assert.equal(result.isError, true, 'missing odd is refused');
      assert.match(resultText(result), /odd/i, 'the refusal names odd');
      assert.equal(require('../lib/worktree-registry.js').findByBranch(root, 'feat/bad-odd'), null, 'no row written');
    } finally {
      restoreEnv();
    }
  });
});

describe('T19/S27+S31: create updates an existing worktree instead of duplicating', { concurrency: false }, () => {
  test('supplied issues/odd overwrite; omitted fields stay untouched', async () => {
    const root = makeRepo('create-update');
    setEnv(stdEnv());
    try {
      // The existing checkout lives at the agreed sibling layout, exactly
      // as a real create would have placed it.
      const branch = 'feat/upd';
      const slug = 'feat-upd';
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, slug);
      track(path.dirname(target));
      git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
      const realTarget = fs.realpathSync(target);
      const registryLib = require('../lib/worktree-registry.js');
      assert.equal(registryLib.upsertWorktree(root, {
        branch, path: realTarget, thread: 'thread-upd', issues: [1], odd: [],
      }).ok, true);
      const doc = path.join(root, 'upd-odd.md');
      fs.writeFileSync(doc, '# u\n');
      const { tools } = await loadExtension();
      // Omit issues, supply odd: issues stay, odd is set.
      const first = await tools.get('worktree_create').execute(
        'c1', { branch, odd: doc }, undefined, undefined, makeCtx(root, 'thread-other'),
      );
      assert.equal(first.isError, undefined, `update succeeds, got: ${resultText(first)}`);
      assert.equal(first.details.created, false, 'an update never reports created:true');
      assert.equal(first.details.updated, true, 'an update reports updated:true');
      assert.equal(first.details.path, realTarget, 'the checkout path is reported');
      let entry = registryLib.findByBranch(root, branch);
      assert.deepEqual(entry.issues, [1], 'omitted issues untouched');
      assert.ok(entry.odd.length > 0, 'supplied odd stored');
      assert.equal(entry.path, realTarget, 'the path is never rewritten');
      // Supply empty issues: removal is the same operation as replacement.
      const second = await tools.get('worktree_create').execute(
        'c2', { branch, issues: [] }, undefined, undefined, makeCtx(root, 'thread-other'),
      );
      assert.equal(second.isError, undefined, `empty update succeeds, got: ${resultText(second)}`);
      entry = registryLib.findByBranch(root, branch);
      assert.deepEqual(entry.issues, [], 'empty issues removes');
      assert.ok(entry.odd.length > 0, 'omitted odd untouched');
    } finally {
      restoreEnv();
    }
  });
});

describe('T20/S28: startup discovery registers missing repository worktrees', { concurrency: false }, () => {
  test('session_start registers a live checkout the registry never saw', async () => {
    const root = makeRepo('discover');
    setEnv(stdEnv());
    try {
      const ghost = addUnregistered(root, 'feat/ghost-disc');
      const { handlers } = await loadExtension();
      const starters = handlers.get('session_start') || [];
      assert.ok(starters.length > 0, 'a session_start subscription exists');
      for (const handler of starters) {
        await handler({ cwd: root }, makeCtx(root));
      }
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/ghost-disc');
      assert.ok(entry, 'discovery registered the missing worktree');
      assert.equal(entry.path, ghost, 'the checkout path is registered');
    } finally {
      restoreEnv();
    }
  });
});

describe('T21/S29+S32: close and session_open resolve name first then path', { concurrency: false }, () => {
  test('close accepts the checkout path in the name field', async () => {
    const root = makeRepo('close-path');
    setEnv(stdEnv());
    try {
      const target = addRegistered(root, 'feat/by-path');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_close').execute(
        'c1', { name: target, force: true }, undefined, undefined, makeCtx(root),
      );
      assert.equal(result.isError, undefined, `close by path succeeds, got: ${resultText(result)}`);
      assert.equal(fs.existsSync(target), false, 'checkout removed');
    } finally {
      restoreEnv();
    }
  });

  test('close refuses a foreign path with no side effect', async () => {
    const root = makeRepo('close-foreign');
    setEnv(stdEnv());
    try {
      const target = addRegistered(root, 'feat/kept');
      const foreign = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ou-foreign-')));
      const { tools } = await loadExtension();
      const before = fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root));
      const result = await tools.get('worktree_close').execute(
        'c1', { name: foreign, force: true }, undefined, undefined, makeCtx(root),
      );
      assert.equal(result.isError, true, 'foreign path fails closed');
      assert.equal(fs.existsSync(target), true, 'registered checkout untouched');
      assert.deepEqual(fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root)), before, 'registry untouched');
    } finally {
      restoreEnv();
    }
  });

  test('close refuses the principal checkout before acting', async () => {
    const root = makeRepo('close-principal');
    setEnv(stdEnv());
    try {
      addRegistered(root, 'feat/other');
      const { tools } = await loadExtension();
      const before = fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root));
      const result = await tools.get('worktree_close').execute(
        'c1', { name: 'principal', force: true }, undefined, undefined, makeCtx(root),
      );
      assert.equal(result.isError, true, 'principal refused');
      assert.match(resultText(result), /principal/i, 'the refusal names the principal');
      assert.equal(fs.existsSync(root), true, 'principal checkout untouched');
      assert.deepEqual(fs.readFileSync(require('../lib/worktree-registry.js').registryPath(root)), before, 'registry untouched');
    } finally {
      restoreEnv();
    }
  });
});

describe('T22/S30: the odd detector is inactive in the principal checkout', { concurrency: false }, () => {
  test('events from the principal assign nothing even as worktree odd/ grows', async () => {
    const root = makeRepo('detector-bound');
    setEnv(stdEnv());
    try {
      const target = addRegistered(root, 'feat/det');
      const { handlers } = await loadExtension();
      const calls = handlers.get('tool_call') || [];
      assert.ok(calls.length > 0, 'a tool_call subscription exists');
      // A new doc appears in the worktree while the session runs in principal.
      fs.mkdirSync(path.join(target, 'odd'), { recursive: true });
      fs.writeFileSync(path.join(target, 'odd', 'later.md'), '# later\n');
      for (const handler of calls) {
        const value = await handler(
          { toolName: 'read', args: { path: path.join(root, 'odd', 'later.md') } },
          makeCtx(root),
        );
        assert.equal(value, undefined, 'the handler never blocks the pipeline');
      }
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/det');
      assert.deepEqual(entry.odd, [], 'no detection and no assignment from the principal session');
      // The same event inside the worktree still captures.
      for (const handler of calls) {
        await handler(
          { toolName: 'read', args: { path: path.join(target, 'odd', 'later.md') } },
          makeCtx(target),
        );
      }
      const after = require('../lib/worktree-registry.js').findByBranch(root, 'feat/det');
      assert.ok(after.odd.length > 0, 'detection stays active inside agent worktrees');
    } finally {
      restoreEnv();
    }
  });
});

describe('T23/S31: the principal is editable but never created or removed', { concurrency: false }, () => {
  test('updating the principal branch writes its record without creating a checkout', async () => {
    const root = makeRepo('principal-edit');
    setEnv(stdEnv());
    try {
      const branch = git(root, ['branch', '--show-current']);
      const doc = path.join(root, 'p-odd.md');
      fs.writeFileSync(doc, '# p\n');
      const { tools } = await loadExtension();
      const result = await tools.get('worktree_create').execute(
        'c1', { branch, odd: doc }, undefined, undefined, makeCtx(root, 'thread-p'),
      );
      assert.equal(result.isError, undefined, `principal update succeeds, got: ${resultText(result)}`);
      assert.equal(result.details.created, false, 'the principal is never created by this tool');
      const entry = require('../lib/worktree-registry.js').findByBranch(root, branch);
      assert.ok(entry, 'its registration record is created on demand');
      assert.equal(fs.realpathSync(entry.path), root, 'the record points at the principal checkout');
    } finally {
      restoreEnv();
    }
  });
});
