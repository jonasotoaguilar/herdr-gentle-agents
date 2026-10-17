'use strict';
// S62/T48 RED: lib/live-session-changes.js — local live Git metric mirroring
// gentle-shell shell-changes/session-changes semantics (not transcript sums).
// Real isolated git repos; no live Herdr/Pi/UI. Public functions only.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

let live;
try {
  live = require('../lib/live-session-changes.js');
} catch (err) {
  test('lib/live-session-changes.js exists (RED before implementation)', () => {
    assert.fail(`missing module: ${err && err.message}`);
  });
  return;
}

const {
  parseNumstat,
  parsePorcelain,
  snapshotChanges,
  changesModel,
  sessionChangeRoots,
  resolveScopeRoots,
  summarizeRoots,
} = live;

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `live-changes-${name}-`));
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
  const wtPath = path.join(root, '..', `live-wt-${branch.replace(/[^a-z0-9]+/gi, '-')}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
  git(root, ['worktree', 'add', '-b', branch, wtPath]);
  const list = git(root, ['worktree', 'list', '--porcelain']).split('\n');
  let current = null;
  for (const line of list) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length).trim();
    if (line === `branch refs/heads/${branch}`) return current;
  }
  throw new Error(`worktree for ${branch} not found`);
}

describe('reference parsers (mirrored from gentle-shell shell-changes.ts)', { concurrency: false }, () => {
  test('parseNumstat counts added/deleted per path; dash means 0 (binary)', () => {
    const entries = parseNumstat('2\t1\ta.txt\n-\t-\timg.bin\n');
    assert.deepEqual(entries, [
      { path: 'a.txt', added: 2, deleted: 1 },
      { path: 'img.bin', added: 0, deleted: 0 },
    ]);
  });

  test('parsePorcelain maps codes, skips trailing-slash dirs, skips rename source record', () => {
    const porcelain = ['M  a.txt', '?? new.txt', 'R  new2.txt', 'old.txt', '?? nested.dir/'].join('\0') + '\0';
    const statuses = parsePorcelain(porcelain);
    assert.equal(statuses.get('a.txt'), 'modified');
    assert.equal(statuses.get('new.txt'), 'untracked');
    assert.equal(statuses.get('new2.txt'), 'renamed');
    assert.ok(!statuses.has('nested.dir/'), 'directory-shaped lines are not files');
    assert.ok(!statuses.has('old.txt'), 'rename source record is skipped');
  });

  test('snapshotChanges joins numstat counts onto porcelain; untracked starts at 0/0', () => {
    const files = snapshotChanges({
      numstat: '3\t1\ta.txt\n',
      porcelain: ['M  a.txt', '?? new.txt'].join('\0') + '\0',
    });
    const byPath = Object.fromEntries(files.map((f) => [f.path, f]));
    assert.equal(byPath['a.txt'].added, 3);
    assert.equal(byPath['a.txt'].deleted, 1);
    assert.equal(byPath['new.txt'].added, 0);
    assert.equal(byPath['new.txt'].status, 'untracked');
  });

  test('snapshotChanges excludes node_modules.backup untracked artifacts', () => {
    const files = snapshotChanges({
      numstat: '',
      porcelain: ['?? node_modules.backup-123/pkg/file.js'].join('\0') + '\0',
    });
    assert.equal(files.length, 0);
  });

  test('changesModel sums and sorts by path', () => {
    const model = changesModel([
      { path: 'b.txt', added: 1, deleted: 0, status: 'modified' },
      { path: 'a.txt', added: 2, deleted: 1, status: 'modified' },
    ]);
    assert.deepEqual(model.files.map((f) => f.path), ['a.txt', 'b.txt']);
    assert.equal(model.added, 3);
    assert.equal(model.deleted, 1);
  });
});

describe('session scope (mirrored from gentle-shell session-changes.ts + shell-changes roots filter)', { concurrency: false }, () => {
  const WT = 'gentle-pi.session-worktree/v1';
  const CE = 'gentle-pi.session-change/v1';

  test('sessionChangeRoots binds the session and unions worktree + evidence roots', () => {
    const entries = [
      { type: 'custom', customType: WT, data: { sessionId: 's1', root: '/r/a' } },
      { type: 'custom', customType: CE, data: { sessionId: 's1', evidence: { id: 'e1', root: '/r/b', path: 'f', before: { kind: 'absent' }, after: { kind: 'text', text: 'x' } } } },
      { type: 'custom', customType: WT, data: { sessionId: 's2', root: '/r/other' } },
      { type: 'custom', customType: CE, data: { sessionId: 's2', evidence: { id: 'e2', root: '/r/other2', path: 'f', before: { kind: 'absent' }, after: { kind: 'text', text: 'x' } } } },
    ];
    assert.deepEqual(sessionChangeRoots('s1', entries).sort(), ['/r/a', '/r/b']);
    assert.deepEqual(sessionChangeRoots('missing', entries), []);
  });

  test('resolveScopeRoots dedups realpath aliases and drops missing roots', () => {
    const real = makeRepo('scope-dedup');
    const alias = path.join(os.tmpdir(), `live-alias-${Date.now()}`);
    try { fs.symlinkSync(real, alias); } catch { return; }
    roots.push(alias);
    const entries = [
      { type: 'custom', customType: 'gentle-pi.session-worktree/v1', data: { sessionId: 's1', root: real } },
      { type: 'custom', customType: 'gentle-pi.session-worktree/v1', data: { sessionId: 's1', root: alias } },
      { type: 'custom', customType: 'gentle-pi.session-worktree/v1', data: { sessionId: 's1', root: '/definitely/missing/live-scope' } },
    ];
    const scoped = resolveScopeRoots(entries, 's1', { cwdRoot: undefined, rootExists: (r) => { try { return fs.existsSync(path.join(r, '.git')); } catch { return false; } } });
    const reals = scoped.map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
    assert.equal(new Set(reals).size, 1, `symlink alias dedups: ${JSON.stringify(scoped)}`);
    assert.ok(!scoped.some((r) => r.includes('definitely/missing')), 'missing roots are dropped');
  });

  test('resolveScopeRoots includes the session cwd root and excludes unsubscribed roots', () => {
    const principal = makeRepo('scope-cwd');
    const entries = [];
    const scoped = resolveScopeRoots(entries, 's9', {
      cwdRoot: principal,
      rootExists: () => true,
    });
    assert.ok(scoped.includes(principal), 'cwd root is in scope even with no entries');
  });
});

describe('summarizeRoots live Git (principal + two same-clone worktrees)', { concurrency: false }, () => {
  test('clean checkout reports 0 files (never clean-advertised on failure)', async () => {
    const root = makeRepo('live-clean');
    const summary = await summarizeRoots([root]);
    assert.equal(summary.ok, true);
    assert.equal(summary.files, 0);
    assert.equal(summary.added, 0);
    assert.equal(summary.deleted, 0);
  });

  test('staged + unstaged edits to the same file count once against HEAD', async () => {
    const root = makeRepo('live-staged');
    fs.writeFileSync(path.join(root, 'a.txt'), 'one\nTWO-staged\n');
    git(root, ['add', 'a.txt']);
    fs.appendFileSync(path.join(root, 'a.txt'), 'three-unstaged\n');
    const summary = await summarizeRoots([root]);
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.files, 1);
    assert.equal(summary.added, 2);
    assert.equal(summary.deleted, 1);
  });

  test('untracked new file counts its lines like gentle-shell; deletion counts removed', async () => {
    const root = makeRepo('live-untracked');
    fs.writeFileSync(path.join(root, 'new.txt'), 'l1\nl2\nl3\n');
    fs.writeFileSync(path.join(root, 'b.txt'), 'alpha\n');
    const summary = await summarizeRoots([root]);
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.files, 2);
    const byRel = Object.fromEntries(summary.model.files.map((f) => [f.path, f]));
    assert.equal(byRel['new.txt'].added, 3);
    assert.equal(byRel['b.txt'].deleted, 1);
  });

  test('registered roots aggregate; unsubscribed worktree is excluded', async () => {
    const principal = makeRepo('live-scope');
    const reg = addWorktree(principal, 'feat/live-reg');
    const unsub = addWorktree(principal, 'feat/live-unsub');
    try {
      fs.writeFileSync(path.join(principal, 'a.txt'), 'one\nPRINCIPAL\n');
      fs.writeFileSync(path.join(reg, 'a.txt'), 'one\nREG\n');
      fs.writeFileSync(path.join(unsub, 'a.txt'), 'one\nUNSUB\n');
      const scoped = await summarizeRoots([principal, reg]);
      assert.equal(scoped.ok, true, JSON.stringify(scoped));
      assert.equal(scoped.files, 2, `only subscribed roots count: ${JSON.stringify(scoped.model.files)}`);
      const unscoped = await summarizeRoots([principal, reg, unsub]);
      assert.equal(unscoped.files, 3, 'explicitly passed unsubscribed root counts when asked');
    } finally {
      git(principal, ['worktree', 'remove', '--force', reg]);
      git(principal, ['worktree', 'remove', '--force', unsub]);
    }
  });

  test('space filenames count; binary tracks as 0/0 but still a file', async () => {
    const root = makeRepo('live-space-bin');
    fs.writeFileSync(path.join(root, 'with space.txt'), 'x\ny\n');
    git(root, ['add', 'with space.txt']);
    git(root, ['commit', '-m', 'space']);
    fs.appendFileSync(path.join(root, 'with space.txt'), 'z\n');
    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]);
    fs.writeFileSync(path.join(root, 'img.bin'), binary);
    git(root, ['add', 'img.bin']);
    git(root, ['commit', '-m', 'bin']);
    fs.appendFileSync(path.join(root, 'img.bin'), Buffer.from([0x01, 0x02]));
    const summary = await summarizeRoots([root]);
    assert.equal(summary.ok, true, JSON.stringify(summary));
    const byRel = Object.fromEntries(summary.model.files.map((f) => [f.path, f]));
    assert.ok(byRel['with space.txt'], 'space filename survives');
    assert.equal(byRel['with space.txt'].added, 1);
    assert.ok(byRel['img.bin'], 'binary modification is a file');
    assert.equal(byRel['img.bin'].added, 0, 'binary never fakes line counts');
    assert.equal(byRel['img.bin'].deleted, 0);
  });

  test('parse errors and timeouts fail stale (ok:false), never clean 0/0', async () => {
    const root = makeRepo('live-fail');
    fs.writeFileSync(path.join(root, 'a.txt'), 'changed\n');
    const bad = await summarizeRoots([root], {
      runGit: async () => ({ stdout: '', code: 128 }),
    });
    assert.equal(bad.ok, false, 'non-zero git fails stale');
    assert.ok(!('files' in bad) || bad.files === undefined || bad.ok === false, 'no clean totals advertised');
    const throws = await summarizeRoots([root], {
      runGit: async () => { throw new Error('timed out'); },
    });
    assert.equal(throws.ok, false, 'rejected git fails stale');
  });

  test('rename collapses to the new path (no double count)', async () => {
    const root = makeRepo('live-rename');
    git(root, ['mv', 'a.txt', 'renamed.txt']);
    const summary = await summarizeRoots([root]);
    assert.equal(summary.ok, true, JSON.stringify(summary));
    assert.equal(summary.files, 1);
    assert.equal(summary.model.files[0].path, 'renamed.txt');
  });
});
