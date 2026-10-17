'use strict';
// S61/T47 tests: lib/worktree-changes.js — the shared pending-changes
// helper (dirty summary + safe copy). Real isolated git repos; no live
// Herdr/gh/Pi/UI. Every assertion goes through the public functions,
// never internals.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const changes = require('../lib/worktree-changes.js');

const roots = [];
after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return result.stdout;
}

function makeRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `wt-changes-${name}-`));
  roots.push(dir);
  git(dir, ['init', '-b', 'main']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'alpha\nbeta\n');
  git(dir, ['add', '.']);
  git(dir, ['commit', '-m', 'init']);
  return dir;
}

function addWorktree(root, branch) {
  git(root, ['worktree', 'add', '-b', branch, path.join(root, '..', `wt-${branch.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}`)]);
  const list = git(root, ['worktree', 'list', '--porcelain']).split('\n');
  let current = null;
  for (const line of list) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    if (line === `branch refs/heads/${branch}`) return current;
  }
  throw new Error(`worktree for ${branch} not found`);
}

describe('summarizeChanges', { concurrency: false }, () => {
  test('a clean checkout reports zero files', async () => {
    const root = makeRepo('clean');
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    assert.equal(summary.files, 0);
    assert.equal(summary.added, 0);
    assert.equal(summary.deleted, 0);
  });

  test('a tracked modification counts staged and unstaged once, not twice', async () => {
    const root = makeRepo('staged-unstaged');
    // Staged change plus a further unstaged change to the SAME file:
    // the HEAD diff holds both, counted once.
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO-staged\n');
    git(root, ['add', 'a.txt']);
    fs.appendFileSync(path.join(root, 'a.txt'), 'three-unstaged\n');
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    assert.equal(summary.files, 1, JSON.stringify(summary.entries));
    const entry = summary.entries[0];
    assert.equal(entry.rel, 'a.txt');
    assert.equal(entry.added, 2);
    assert.equal(entry.deleted, 1);
    assert.equal(summary.added, 2);
    assert.equal(summary.deleted, 1);
  });

  test('untracked files count added lines and deletions remove lines', async () => {
    const root = makeRepo('untracked-deletion');
    fs.writeFileSync(path.join(root, 'new.txt'), 'l1\nl2\nl3\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'alpha\n');
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    assert.equal(summary.files, 2);
    const byRel = Object.fromEntries(summary.entries.map((e) => [e.rel, e]));
    assert.equal(byRel['new.txt'].added, 3);
    assert.equal(byRel['new.txt'].untracked, true);
    assert.equal(byRel['b.txt'].added, 0);
    assert.equal(byRel['b.txt'].deleted, 1);
  });

  test('a rename is one entry and binary files never fake line counts', async () => {
    const root = makeRepo('rename-binary');
    git(root, ['mv', 'a.txt', 'renamed.txt']);
    const binary = Buffer.from([0x00, 0x01, 0x02, 0x89, 0x50, 0x4e, 0x47, 0x0a]);
    fs.writeFileSync(path.join(root, 'blob.bin'), binary);
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    const byRel = Object.fromEntries(summary.entries.map((e) => [e.rel, e]));
    assert.ok(byRel['renamed.txt'], `rename entry present: ${JSON.stringify(summary.entries)}`);
    assert.equal(byRel['renamed.txt'].status, 'renamed');
    assert.equal(byRel['blob.bin'].binary, true);
    assert.equal(byRel['blob.bin'].added, 0, 'binary added lines are never faked');
    assert.equal(summary.binaryCount, 1);
    assert.match(changes.formatChangeSummary(summary), /\(1 binary\)/);
  });

  test('a tracked binary modification labels binary with zero counts', async () => {
    const root = makeRepo('tracked-binary');
    const start = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0a, 0x0b]);
    fs.writeFileSync(path.join(root, 'img.bin'), start);
    git(root, ['add', 'img.bin']);
    git(root, ['commit', '-m', 'add binary']);
    fs.appendFileSync(path.join(root, 'img.bin'), Buffer.from([0x00, 0xff, 0x01]));
    const summary = await changes.summarizeChanges(root);
    assert.equal(summary.ok, true);
    const entry = summary.entries.find((e) => e.rel === 'img.bin');
    assert.ok(entry, 'binary modification is reported');
    assert.equal(entry.binary, true);
    assert.equal(entry.added, 0);
    assert.equal(entry.deleted, 0);
  });

  test('formatChangeSummary is exact on clean and dirty checkouts', async () => {
    assert.equal(changes.formatChangeSummary({ files: 0, added: 0, deleted: 0, binaryCount: 0 }), '0 files, +0/-0');
    assert.equal(changes.formatChangeSummary({ files: 1, added: 2, deleted: 1, binaryCount: 0 }), '1 file, +2/-1');
    assert.equal(changes.formatChangeSummary({ files: 2, added: 3, deleted: 1, binaryCount: 0 }), '2 files, +3/-1');
  });

  test('timeout/failure reports precisely and mutates nothing', async () => {
    const root = makeRepo('timeout');
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    const before = fs.readFileSync(path.join(root, 'a.txt'), 'utf8');
    const summary = await changes.summarizeChanges(root, {
      runAsync: async () => ({ status: null, stdout: '', stderr: '', error: 'timed out after 5ms' }),
    });
    assert.equal(summary.ok, false);
    assert.match(summary.error, /timed out/);
    assert.equal(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), before, 'a failed read mutates nothing');
  });
});

describe('normalizeChangesSelection', { concurrency: false }, () => {
  test('omitted, empty string and empty list all mean no copy', () => {
    assert.deepEqual(changes.normalizeChangesSelection(undefined), { ok: true, mode: 'none', paths: [] });
    assert.deepEqual(changes.normalizeChangesSelection(''), { ok: true, mode: 'none', paths: [] });
    assert.deepEqual(changes.normalizeChangesSelection([]), { ok: true, mode: 'none', paths: [] });
  });
  test('"all" copies everything and a list copies those files', () => {
    assert.deepEqual(changes.normalizeChangesSelection('all'), { ok: true, mode: 'all', paths: [] });
    const listed = changes.normalizeChangesSelection(['a.txt']);
    assert.equal(listed.ok, true);
    assert.equal(listed.mode, 'paths');
  });
  test('anything else fails closed', () => {
    assert.equal(changes.normalizeChangesSelection('some').ok, false);
    assert.equal(changes.normalizeChangesSelection(42).ok, false);
    assert.equal(changes.normalizeChangesSelection(['']).ok, false);
  });
});

describe('copyChanges', { concurrency: false }, () => {
  test('copy all moves tracked and untracked changes; source retained, destination index preserved', async () => {
    const root = makeRepo('copy-all');
    const src = addWorktree(root, 'feat/copy-src');
    const dest = addWorktree(root, 'feat/copy-dest');
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(src, 'new.txt'), 'fresh\nfile\n');
      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(copied.copied.sort(), ['a.txt', 'new.txt']);
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.equal(fs.readFileSync(path.join(dest, 'new.txt'), 'utf8'), 'fresh\nfile\n');
      // Source retained: nothing was stashed, moved or reset.
      assert.equal(fs.readFileSync(path.join(src, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.ok(fs.existsSync(path.join(src, 'new.txt')));
      // Destination index preserved: working-tree changes only, nothing staged.
      const cached = git(dest, ['diff', '--cached', '--name-only']).trim();
      assert.equal(cached, '', 'the destination index stays untouched');
      const sourceCached = git(src, ['diff', '--cached', '--name-only']).trim();
      assert.equal(sourceCached, '', 'the source index stays untouched');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });

  test('selected files copy only those files', async () => {
    const root = makeRepo('copy-selected');
    const src = addWorktree(root, 'feat/sel-src');
    const dest = addWorktree(root, 'feat/sel-dest');
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nTWO\n');
      fs.writeFileSync(path.join(src, 'b.txt'), 'ALPHA\nbeta\n');
      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['a.txt'] });
      assert.equal(copied.ok, true, copied.error);
      assert.deepEqual(copied.copied, ['a.txt']);
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\nTWO\n');
      assert.equal(fs.readFileSync(path.join(dest, 'b.txt'), 'utf8'), 'alpha\nbeta\n', 'unselected files stay clean');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });

  test('a destination that already modifies a selected path rejects with zero mutation', async () => {
    const root = makeRepo('copy-overlap');
    const src = addWorktree(root, 'feat/over-src');
    const dest = addWorktree(root, 'feat/over-dest');
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nSRC\n');
      fs.writeFileSync(path.join(dest, 'a.txt'), 'one\nDEST\n');
      const beforeDest = fs.readFileSync(path.join(dest, 'a.txt'), 'utf8');
      const beforeSrc = fs.readFileSync(path.join(src, 'a.txt'), 'utf8');
      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, false);
      assert.match(copied.error, /destination already modifies/);
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), beforeDest, 'destination untouched');
      assert.equal(fs.readFileSync(path.join(src, 'a.txt'), 'utf8'), beforeSrc, 'source untouched');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });

  test('a deletion and a binary copy travel safely', async () => {
    const root = makeRepo('copy-del-bin');
    const src = addWorktree(root, 'feat/db-src');
    const dest = addWorktree(root, 'feat/db-dest');
    try {
      fs.rmSync(path.join(src, 'b.txt'));
      const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x01]);
      fs.writeFileSync(path.join(src, 'blob.bin'), binary);
      const copied = await changes.copyChanges({ from: src, to: dest, selectMode: 'all' });
      assert.equal(copied.ok, true, copied.error);
      assert.equal(fs.existsSync(path.join(dest, 'b.txt')), false, 'the deletion applies');
      assert.ok(fs.readFileSync(path.join(dest, 'blob.bin')).equals(binary), 'binary bytes survive');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });

  test('foreign checkouts, traversal, symlink escape and .git all refuse without mutation', async () => {
    const first = makeRepo('foreign-a');
    const second = makeRepo('foreign-b');
    fs.writeFileSync(path.join(first, 'a.txt'), 'changed\n');
    const beforeFirst = fs.readFileSync(path.join(first, 'a.txt'), 'utf8');
    const beforeSecond = fs.readFileSync(path.join(second, 'a.txt'), 'utf8');
    const foreign = await changes.copyChanges({ from: first, to: second, selectMode: 'all' });
    assert.equal(foreign.ok, false);
    assert.match(foreign.error, /different repositories/);
    assert.equal(fs.readFileSync(path.join(first, 'a.txt'), 'utf8'), beforeFirst);
    assert.equal(fs.readFileSync(path.join(second, 'a.txt'), 'utf8'), beforeSecond);

    const root = makeRepo('escape');
    const src = addWorktree(root, 'feat/esc-src');
    const dest = addWorktree(root, 'feat/esc-dest');
    try {
      fs.writeFileSync(path.join(src, 'a.txt'), 'one\nTWO\n');
      const traversal = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['../a.txt'] });
      assert.equal(traversal.ok, false, 'traversal refuses');
      const gitInternal = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['.git/HEAD'] });
      assert.equal(gitInternal.ok, false, '.git refuses');
      // A symlink escaping the checkout never enters the summary, so
      // selecting it fails closed as unknown.
      fs.symlinkSync(path.join(os.tmpdir()), path.join(src, 'link-out'));
      const summary = await changes.summarizeChanges(src);
      assert.equal(summary.ok, true);
      assert.ok(!summary.entries.some((e) => e.rel === 'link-out'), 'escape symlinks are not summarized');
      const escaped = await changes.copyChanges({ from: src, to: dest, selectMode: 'paths', selection: ['link-out'] });
      assert.equal(escaped.ok, false, 'symlink escape refuses');
      assert.equal(fs.readFileSync(path.join(dest, 'a.txt'), 'utf8'), 'one\ntwo\n', 'rejected copies change nothing');
    } finally {
      git(root, ['worktree', 'remove', '--force', src]);
      git(root, ['worktree', 'remove', '--force', dest]);
    }
  });
});
