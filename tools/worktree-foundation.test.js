'use strict';
// P2-S1 foundation tests (test-first): lib/worktree-git.js,
// lib/worktree-registry.js, lib/worktree-mode.js.
//
// Every test builds its own isolated fixture repository under os.tmpdir()
// with real `git init` / `git worktree` commands issued through fixed argv
// (never a shell string). The user's real checkouts and the repository
// under test are never touched; only the fixture dirs tracked in `roots`
// are removed afterwards.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const gitLib = require('../lib/worktree-git.js');
const registryLib = require('../lib/worktree-registry.js');
const modeLib = require('../lib/worktree-mode.js');

const LIB_DIR = path.resolve(__dirname, '../lib');

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

// Fresh fixture repository with one empty commit on its default branch.
function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-foundation-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function defaultBranch(root) {
  return git(root, ['branch', '--show-current']);
}

// --git-common-dir may print a path relative to the fixture root.
function commonDirOf(root) {
  return path.resolve(root, git(root, ['rev-parse', '--git-common-dir']));
}

function scratchEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mode-'))) };
}

// ---------------------------------------------------------------------------
// lib/worktree-git.js
// ---------------------------------------------------------------------------

describe('worktree-git: runArgv', () => {
  test('returns the exact shape for a successful command', () => {
    const result = gitLib.runArgv('git', ['--version'], {});
    assert.deepEqual(Object.keys(result).sort(), ['error', 'status', 'stderr', 'stdout']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^git version \d/);
    assert.equal(typeof result.stderr, 'string');
    assert.equal(result.error, null);
  });

  test('reports a missing binary instead of throwing', () => {
    const result = gitLib.runArgv('definitely-not-a-real-binary-xyz', ['--version'], {});
    assert.equal(result.status, null);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
  });

  test('never builds a shell string: metacharacters are literal argv', () => {
    const root = makeRepo('shell');
    const marker = path.join(root, 'pwned-by-shell');
    const result = gitLib.runArgv('git', ['check-ref-format', '--branch', 'a b; touch pwned-by-shell'], { cwd: root });
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(marker), false);
  });
});

describe('worktree-git: repoIdentity', () => {
  test('returns the exact identity shape', () => {
    const root = makeRepo('identity');
    const identity = gitLib.repoIdentity(root);
    assert.deepEqual(identity, {
      root,
      commonDir: path.join(root, '.git'),
      repoName: path.basename(root),
      parentDir: path.dirname(root),
    });
  });
});

describe('worktree-git: slugifyBranch', () => {
  test('maps the documented examples exactly', () => {
    assert.equal(gitLib.slugifyBranch('feat/foo-bar'), 'feat-foo-bar');
    assert.equal(gitLib.slugifyBranch('Feat/Foo_Bar!'), 'feat-foo-bar');
    assert.equal(gitLib.slugifyBranch('ABC'), 'abc');
    assert.equal(gitLib.slugifyBranch('a//b'), 'a-b');
    assert.equal(gitLib.slugifyBranch('-x-'), 'x');
    assert.equal(gitLib.slugifyBranch('  -- '), 'worktree');
    assert.equal(gitLib.slugifyBranch(''), 'worktree');
    assert.equal(gitLib.slugifyBranch('///'), 'worktree');
  });
});

describe('worktree-git: validateBranch', () => {
  test('accepts ordinary branch names', () => {
    assert.deepEqual(gitLib.validateBranch('feat/ok-name'), { ok: true, reason: null });
    assert.deepEqual(gitLib.validateBranch('main'), { ok: true, reason: null });
  });

  test('rejects every named hostile input with a reason', () => {
    const hostile = [
      '',
      '-leading-dash',
      'has space',
      'tab\there',
      'new\nline',
      'ctrl\x01char',
      'del\x7fchar',
      'bidi\u200Emark',
      'bidi\u200Fmark',
      'bidi\u202Emark',
      'double..dots',
      '..',
    ];
    for (const name of hostile) {
      const result = gitLib.validateBranch(name);
      assert.equal(result.ok, false, `expected rejection: ${JSON.stringify(name)}`);
      assert.equal(typeof result.reason, 'string');
      assert.ok(result.reason.length > 0, `expected a reason: ${JSON.stringify(name)}`);
    }
  });
});

describe('worktree-git: listWorktrees', () => {
  test('parses porcelain -z output instead of trusting anything else', () => {
    const root = makeRepo('list');
    const main = defaultBranch(root);
    const linked = path.join(path.dirname(root), `${path.basename(root)}-linked`);
    track(linked);
    git(root, ['worktree', 'add', linked, '-b', 'feature/one']);
    const found = gitLib.listWorktrees(root);
    assert.equal(found.length, 2);
    for (const entry of found) {
      assert.deepEqual(Object.keys(entry).sort(), ['bare', 'branch', 'detached', 'head', 'path']);
      assert.match(entry.head, /^[0-9a-f]{40}$/);
      assert.equal(entry.detached, false);
      assert.equal(entry.bare, false);
    }
    const byPath = new Map(found.map((entry) => [entry.path, entry]));
    assert.equal(byPath.get(root).branch, main);
    assert.equal(byPath.get(linked).branch, 'feature/one');
  });
});

describe('worktree-git: isPathInAnyCheckout', () => {
  test('refuses targets inside any checkout or the git common dir', () => {
    const root = makeRepo('checkout');
    const linked = path.join(path.dirname(root), `${path.basename(root)}-linked`);
    track(linked);
    git(root, ['worktree', 'add', linked, '-b', 'feature/two']);
    const commonDir = commonDirOf(root);

    assert.equal(gitLib.isPathInAnyCheckout(root, root), true);
    assert.equal(gitLib.isPathInAnyCheckout(root, path.join(root, 'sub', 'file.js')), true);
    assert.equal(gitLib.isPathInAnyCheckout(root, linked), true);
    assert.equal(gitLib.isPathInAnyCheckout(root, path.join(linked, 'odd', 'tasks.md')), true);
    assert.equal(gitLib.isPathInAnyCheckout(root, path.join(commonDir, 'pi-worktrees.json')), true);

    const outside = path.join(path.dirname(root), `${path.basename(root)}-elsewhere`);
    assert.equal(gitLib.isPathInAnyCheckout(root, outside), false);
  });
});

describe('worktree-git: worktreePath', () => {
  test('returns <repo-parent>/<repo-name>-worktrees/<slug>', () => {
    const root = makeRepo('target');
    assert.equal(
      gitLib.worktreePath(root, 'feat/foo-bar'),
      path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-foo-bar'),
    );
    // A fresh branch target is not inside any checkout.
    assert.equal(gitLib.isPathInAnyCheckout(root, gitLib.worktreePath(root, 'feat/fresh')), false);
  });
});

describe('worktree-git: herdrArgv', () => {
  test('builds exact argv arrays with values as separate elements', () => {
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
  });

  test('rejects operations and flags outside the allowlist, never --flag=value', () => {
    assert.throws(() => gitLib.herdrArgv('destroy-everything', {}));
    assert.throws(() => gitLib.herdrArgv('create', { branch: 'x', shellEscape: '; rm -rf ~' }));
    for (const argv of [
      gitLib.herdrArgv('create', { branch: 'a b', path: '/wt' }),
      gitLib.herdrArgv('remove', { workspace: 'a=b', force: true }),
    ]) {
      for (const element of argv) {
        assert.ok(!element.startsWith('--') || !element.includes('='),
          `must not use --flag=value: ${element}`);
      }
    }
  });

  test('mirrors the installed CLI flag surface: focus is opt-in, no --no-focus, no trust decision', () => {
    // Verified against `herdr worktree create --help` and `herdr worktree
    // remove --help` (herdr 0.9.3): create takes --workspace --cwd --branch
    // --base --path --label --focus, remove takes --workspace --force
    // --trust-repository. Focus is opt-in, so a false value stays omitted,
    // and --trust-repository is a human trust decision these tools never
    // take on the user's behalf.
    assert.deepEqual(
      gitLib.herdrArgv('create', { branch: 'feat/x', base: 'main', path: '/wt', label: 'thread', focus: false }),
      ['worktree', 'create', '--branch', 'feat/x', '--base', 'main', '--path', '/wt', '--label', 'thread'],
    );
    assert.deepEqual(
      gitLib.herdrArgv('create', { branch: 'feat/x', focus: true }),
      ['worktree', 'create', '--branch', 'feat/x', '--focus'],
    );
    assert.throws(() => gitLib.herdrArgv('create', { branch: 'x', noFocus: true }));
    assert.throws(() => gitLib.herdrArgv('remove', { workspace: 'abc', trustRepository: true }));
  });
});

// ---------------------------------------------------------------------------
// lib/worktree-registry.js
// ---------------------------------------------------------------------------

describe('worktree-registry', () => {
  test('registryPath lives inside the git common dir', () => {
    const root = makeRepo('regpath');
    assert.equal(registryLib.registryPath(root), path.join(commonDirOf(root), 'pi-worktrees.json'));
  });

  test('readRegistry reports a missing file as an empty registry', () => {
    const root = makeRepo('regmissing');
    assert.deepEqual(registryLib.readRegistry(root), {
      ok: true, version: 1, worktrees: [], error: null,
    });
  });

  test('upsert/read round-trips the exact entry shape', () => {
    const root = makeRepo('regrundtrip');
    const target = path.join(path.dirname(root), 'rt-wt');
    const written = registryLib.upsertWorktree(root, {
      branch: 'feat/rt', path: target, thread: 'thread-1', issues: [35], odd: ['odd/tasks/x.md'],
    });
    assert.equal(written.ok, true);
    assert.equal(typeof written.entry.createdAt, 'string');
    assert.equal(typeof written.entry.updatedAt, 'string');
    assert.deepEqual({ ...written.entry, createdAt: 'T', updatedAt: 'T' }, {
      branch: 'feat/rt', path: target, thread: 'thread-1',
      issues: [35], odd: ['odd/tasks/x.md'], createdAt: 'T', updatedAt: 'T',
    });

    const read = registryLib.readRegistry(root);
    assert.equal(read.ok, true);
    assert.equal(read.version, 1);
    assert.equal(read.worktrees.length, 1);
    assert.deepEqual(registryLib.findByBranch(root, 'feat/rt'), written.entry);
    assert.deepEqual(registryLib.findByPath(root, target), written.entry);
    assert.deepEqual(registryLib.findByThread(root, 'thread-1'), written.entry);
    assert.equal(registryLib.findByBranch(root, 'feat/nope'), null);
  });

  test('a malformed registry is reported and the file is never deleted', () => {
    const root = makeRepo('regmalformed');
    const file = registryLib.registryPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ this is not json {{{');
    const read = registryLib.readRegistry(root);
    assert.equal(read.ok, false);
    assert.equal(typeof read.error, 'string');
    assert.ok(read.error.length > 0);
    assert.deepEqual(read.worktrees, []);
    assert.equal(fs.existsSync(file), true);
    assert.equal(fs.readFileSync(file, 'utf8'), '{ this is not json {{{');
    assert.equal(registryLib.findByBranch(root, 'feat/x'), null);

    // The toolchain recovers: a later write replaces the garbage.
    const upserted = registryLib.upsertWorktree(root, {
      branch: 'feat/x', path: path.join(path.dirname(root), 'x-wt'), thread: 't', issues: [1],
    });
    assert.equal(upserted.ok, true);
    assert.equal(registryLib.readRegistry(root).ok, true);
  });

  test('removeWorktree drops the entry and reports unknown keys', () => {
    const root = makeRepo('regremove');
    registryLib.upsertWorktree(root, {
      branch: 'feat/gone', path: path.join(path.dirname(root), 'gone-wt'), thread: 't', issues: [2],
    });
    assert.deepEqual(registryLib.removeWorktree(root, 'feat/gone'), { ok: true });
    assert.equal(registryLib.findByBranch(root, 'feat/gone'), null);
    const missing = registryLib.removeWorktree(root, 'feat/gone');
    assert.equal(missing.ok, false);
    assert.equal(typeof missing.error, 'string');
  });

  test('addOddDoc associates docs idempotently', () => {
    const root = makeRepo('regodd');
    registryLib.upsertWorktree(root, {
      branch: 'feat/odd', path: path.join(path.dirname(root), 'odd-wt'), thread: 't', issues: [3],
    });
    const first = registryLib.addOddDoc(root, 'feat/odd', 'odd/tasks/a.md');
    assert.equal(first.ok, true);
    assert.equal(first.added, true);
    const second = registryLib.addOddDoc(root, 'feat/odd', 'odd/tasks/a.md');
    assert.equal(second.ok, true);
    assert.equal(second.added, false);
    assert.deepEqual(registryLib.findByBranch(root, 'feat/odd').odd, ['odd/tasks/a.md']);
    const missing = registryLib.addOddDoc(root, 'feat/nope', 'odd/tasks/a.md');
    assert.equal(missing.ok, false);
  });

  test('registry writes leave no temporary file or lock behind', () => {
    const root = makeRepo('regclean');
    registryLib.upsertWorktree(root, {
      branch: 'feat/clean', path: path.join(path.dirname(root), 'clean-wt'), thread: 't', issues: [4],
    });
    registryLib.addOddDoc(root, 'feat/clean', 'odd/tasks/c.md');
    const commonDir = commonDirOf(root);
    const leftovers = fs.readdirSync(commonDir).filter((name) => name !== 'pi-worktrees.json'
      && (name.startsWith('pi-worktrees.json.tmp') || name === 'pi-worktrees.lock'));
    assert.deepEqual(leftovers, []);
  });
});

// Cross-process lock behaviour uses a tiny driver script so the two
// writers are genuinely separate processes.
const DRIVER = `
'use strict';
const path = require('node:path');
const libDir = process.argv[2];
const repoRoot = process.argv[3];
const mode = process.argv[4];
const reg = require(path.join(libDir, 'worktree-registry.js'));
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
try {
  if (mode === 'hold') {
    const ms = Number(process.argv[5]);
    reg.withRegistryLock(repoRoot, () => { sleepMs(ms); return 'held'; }, { timeoutMs: 20000 });
    console.log(JSON.stringify({ held: true }));
  } else if (mode === 'upsert') {
    const branch = process.argv[5];
    const timeoutMs = Number(process.argv[6] || '15000');
    const started = Date.now();
    const res = reg.upsertWorktree(repoRoot, {
      branch, path: '/tmp/wt-driver-' + branch.replace(/[^a-z0-9]+/gi, '-'),
      thread: 'thread-' + branch, issues: [7],
    }, { timeoutMs });
    if (!res.ok) throw new Error(res.error);
    console.log(JSON.stringify({ branch, elapsed: Date.now() - started }));
  } else {
    throw new Error('unknown driver mode');
  }
} catch (err) {
  console.error(String((err && err.message) || err));
  process.exit(2);
}
`;

function runDriver(scriptPath, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('worktree-registry: withRegistryLock across processes', () => {
  test('two concurrent writers in separate processes are serialized', async () => {
    const root = makeRepo('reglock');
    const driver = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-driver-')));
    const scriptPath = path.join(driver, 'lock-driver.js');
    fs.writeFileSync(scriptPath, DRIVER);
    const [held, written] = await Promise.all([
      runDriver(scriptPath, [LIB_DIR, root, 'hold', '1500']),
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        return runDriver(scriptPath, [LIB_DIR, root, 'upsert', 'feat/racer', '15000']);
      })(),
    ]);
    assert.equal(held.code, 0);
    assert.equal(written.code, 0, `writer failed: ${written.stderr}`);
    // The second writer waited for the 1.5s hold instead of racing it.
    assert.ok(JSON.parse(written.stdout).elapsed >= 1000,
      `expected the writer to wait, elapsed: ${written.stdout}`);
    assert.notEqual(registryLib.findByBranch(root, 'feat/racer'), null);
  });

  test('a writer refuses with a bounded error after the timeout', async () => {
    const root = makeRepo('regtimeout');
    const driver = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-driver-')));
    const scriptPath = path.join(driver, 'lock-driver.js');
    fs.writeFileSync(scriptPath, DRIVER);
    const holder = runDriver(scriptPath, [LIB_DIR, root, 'hold', '5000']);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    const refused = await runDriver(scriptPath, [LIB_DIR, root, 'upsert', 'feat/late', '500']);
    const elapsed = Date.now() - started;
    assert.equal(refused.code, 2);
    assert.match(refused.stderr, /lock/i);
    assert.ok(elapsed < 4000, `must fail bounded, took ${elapsed}ms`);
    assert.equal((await holder).code, 0);
  });

  test('a stale lock file is recovered instead of blocking forever', () => {
    const root = makeRepo('regstale');
    const lockPath = path.join(commonDirOf(root), 'pi-worktrees.lock');
    fs.writeFileSync(lockPath, '999999');
    const ancient = new Date(Date.now() - 60000);
    fs.utimesSync(lockPath, ancient, ancient);
    const result = registryLib.withRegistryLock(root, () => 'recovered', { timeoutMs: 5000, staleMs: 1000 });
    assert.equal(result, 'recovered');
    assert.equal(fs.existsSync(lockPath), false);
  });
});

// ---------------------------------------------------------------------------
// lib/worktree-mode.js
// ---------------------------------------------------------------------------

describe('worktree-mode', () => {
  test('stateDir resolves exactly like the sidebar: override else XDG state', () => {
    const override = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-state-')));
    assert.equal(modeLib.stateDir({ GENTLE_STATUS_STATE_DIR: override }), override);
    const xdg = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-xdg-')));
    assert.equal(
      modeLib.stateDir({ XDG_STATE_HOME: xdg }),
      path.join(xdg, 'herdr', 'plugins', 'herdr-gentle-agents'),
    );
  });

  test('modePath is the shared worktree mode file inside the state dir', () => {
    const env = scratchEnv();
    assert.equal(
      modeLib.modePath(env),
      path.join(env.GENTLE_STATUS_STATE_DIR, 'gentle-worktree-mode.json'),
    );
  });

  test('missing means enabled', () => {
    assert.deepEqual(modeLib.readMode(scratchEnv()), { state: 'missing', enabled: true });
  });

  test('writeMode round-trips both states exactly', () => {
    const env = scratchEnv();
    modeLib.writeMode(false, env);
    assert.deepEqual(modeLib.readMode(env), { state: 'disabled', enabled: false });
    modeLib.writeMode(true, env);
    assert.deepEqual(modeLib.readMode(env), { state: 'enabled', enabled: true });
    const stored = JSON.parse(fs.readFileSync(modeLib.modePath(env), 'utf8'));
    assert.deepEqual(stored, { version: 1, enabled: true });
  });

  test('malformed content never enables', () => {
    const env = scratchEnv();
    fs.writeFileSync(modeLib.modePath(env), '{ nope {{{');
    assert.deepEqual(modeLib.readMode(env), { state: 'malformed', enabled: false });
  });
});
