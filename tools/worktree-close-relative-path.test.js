'use strict';
// Regression tests (test-first) for C1: `worktree_close` must never act on
// a different checkout than the one it verified.
//
// Defect: with a hand-edited registry entry whose `path` is RELATIVE (e.g.
// `nested`), the pre-removal verification resolved it with `path.resolve`
// against the PROCESS cwd while `git worktree remove` ran with cwd = the
// repository root, so the check and the removal named different checkouts.
// Related defect: `matchesKey`/`removeWorktree` treated
// `path.resolve(<branch name>)` as a path key, so closing `feat-a` from a
// cwd different from the repository dropped a DIFFERENT entry whose path
// happened to be `<cwd>/feat-a`.
//
// Loading pattern mirrors tools/worktree-close.test.js: the TypeScript
// extension is plain JS under the hood (// @ts-nocheck), so the test copies
// it to a temporary .mjs path with the package import lines stubbed and
// import()s it with a fake `pi`. Only observable behavior is asserted.

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
  restoreCwd();
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-rel-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

// Stub `herdr` as a node script (list + remove only), mirroring
// tools/worktree-close.test.js: logs every argv line to $HERDR_SHIM_LOG,
// resolves the workspace id through a state file, and performs a real
// `git worktree remove` for `worktree remove`.
const HERDR_STUB_SRC = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const EOL = String.fromCharCode(10);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_SHIM_LOG, argv.join(' ') + EOL);
function fail(msg) { console.error(msg); process.exit(1); }
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rel-herdr-')));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, HERDR_STUB_SRC, { mode: 0o755 });
  return { bin, log: path.join(dir, 'herdr-argv.log'), state: path.join(dir, 'herdr-state.json') };
}

// A `git` wrapper on PATH that logs every invocation, so the test can prove
// no `git worktree remove` ran. Installed only around the close call; the
// fixture setup above always uses the real binary.
function makeGitShim() {
  const which = spawnSync('which', ['git'], { encoding: 'utf8' });
  assert.equal(which.status, 0, 'expected git on PATH');
  const real = which.stdout.trim();
  assert.ok(real.length > 0 && real !== path.join('__no_such_dir__', 'git'));
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rel-gitshim-')));
  const log = path.join(dir, 'git-argv.log');
  fs.writeFileSync(
    log,
    '',
  );
  fs.writeFileSync(
    path.join(dir, 'git'),
    `#!/bin/sh\nprintf '%s\\n' "git $*" >> "${log}"\nexec "${real}" "$@"\n`,
    { mode: 0o755 },
  );
  return { dir, log };
}

function gitLogLines(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function shimArgv(log) {
  return gitLogLines(log);
}

function livePaths(root) {
  return git(root, ['worktree', 'list', '--porcelain'])
    .split('\n')
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length));
}

function resultText(result) {
  return (result.content || []).map((part) => part.text || '').join('\n');
}

function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rel-mode-'))) };
}

const savedEnv = { ...process.env };
const savedCwd = process.cwd();
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
function restoreCwd() {
  try {
    process.chdir(savedCwd);
  } catch {
    // Best effort: the next test re-pins its own cwd.
  }
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rel-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = { registerTool: (tool) => { tools.set(tool.name, tool); } };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
}

function makeCtx({ repoRoot, hasUI = false, confirm = true }) {
  return {
    cwd: repoRoot,
    hasUI,
    mode: 'tui',
    sessionManager: { getSessionId: () => 'thread-1' },
    ui: {
      confirm: async () => confirm,
      notify: () => {},
    },
  };
}

// Fixture for the verifier's probe: repository R with two checkouts —
// feat-a nested at R/nested, feat-b at E/nested (E = elsewhere) — and the
// feat-a registry entry hand-edited to the RELATIVE path `nested`.
function makeRelativePathFixture(tag) {
  const root = makeRepo(tag);
  const elsewhere = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-rel-ew-${tag}-`))));
  const nested = path.join(root, 'nested');
  git(root, ['worktree', 'add', '-b', 'feat-a', nested, 'HEAD']);
  const far = path.join(elsewhere, 'nested');
  git(root, ['worktree', 'add', '-b', 'feat-b', far, 'HEAD']);
  const realNested = fs.realpathSync(nested);
  const realFar = fs.realpathSync(far);
  const registryLib = require('../lib/worktree-registry.js');
  assert.equal(registryLib.upsertWorktree(root, {
    branch: 'feat-a', path: realNested, thread: 'thread-1', issues: [35], odd: [],
  }).ok, true);
  assert.equal(registryLib.upsertWorktree(root, {
    branch: 'feat-b', path: realFar, thread: 'thread-2', issues: [35], odd: [],
  }).ok, true);
  // Hand-edit the feat-a entry to a relative path (valid JSON, bad value).
  const file = registryLib.registryPath(root);
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  doc.worktrees.find((entry) => entry.branch === 'feat-a').path = 'nested';
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { root, elsewhere, nested: realNested, far: realFar, registryFile: file };
}

function registryBytes(file) {
  return fs.readFileSync(file);
}

describe('worktree_close with a relative registry path', { concurrency: false }, () => {
  test('herdr path: a relative entry is refused with no mutation and no removal', async () => {
    const { root, elsewhere, nested, far, registryFile } = makeRelativePathFixture('herdr');
    const herdr = makeHerdrStub();
    const shim = makeGitShim();
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_STATE: herdr.state,
      HERDR_SHIM_EXIT: undefined,
      GENTLE_WORKTREE_THREAD: undefined,
      GIT_SHIM_LOG: shim.log,
      PATH: `${shim.dir}${path.delimiter}${savedEnv.PATH}`,
    });
    process.chdir(elsewhere);
    try {
      const tools = await loadExtension();
      const before = registryBytes(registryFile);
      const result = await tools.get('worktree_close').execute(
        'call-1', { branch: 'feat-a' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, true, `expected an error, got: ${resultText(result)}`);
      assert.match(resultText(result), /not absolute|relative/i, 'the error names the reason');
      assert.ok(resultText(result).includes('feat-a'), 'the error names the entry');
      // BOTH checkouts are still present.
      assert.deepEqual(livePaths(root).sort(), [root, nested, far].sort());
      assert.ok(fs.existsSync(nested), 'R/nested still on disk');
      assert.ok(fs.existsSync(far), 'elsewhere/nested still on disk');
      // The registry bytes are unchanged.
      assert.deepEqual(registryBytes(registryFile), before);
      // No `git worktree remove` ran through either backend.
      const removals = gitLogLines(shim.log).filter((line) => /worktree.*remove/.test(line));
      assert.deepEqual(removals, [], `no git worktree remove may run: ${JSON.stringify(gitLogLines(shim.log))}`);
      assert.deepEqual(
        shimArgv(herdr.log).filter((line) => line.startsWith('worktree remove ')),
        [],
        'herdr remove never invoked',
      );
    } finally {
      restoreCwd();
      restoreEnv();
    }
  });

  test('git-fallback path: a relative entry is refused with no mutation and no removal', async () => {
    const { root, elsewhere, nested, far, registryFile } = makeRelativePathFixture('fallback');
    const herdr = makeHerdrStub();
    const shim = makeGitShim();
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-xyz'),
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_STATE: herdr.state,
      GENTLE_WORKTREE_THREAD: undefined,
      GIT_SHIM_LOG: shim.log,
      PATH: `${shim.dir}${path.delimiter}${savedEnv.PATH}`,
    });
    process.chdir(elsewhere);
    try {
      const tools = await loadExtension();
      const before = registryBytes(registryFile);
      const result = await tools.get('worktree_close').execute(
        'call-1', { branch: 'feat-a' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, true, `expected an error, got: ${resultText(result)}`);
      assert.match(resultText(result), /not absolute|relative/i, 'the error names the reason');
      assert.deepEqual(livePaths(root).sort(), [root, nested, far].sort(), 'both checkouts still listed');
      assert.deepEqual(registryBytes(registryFile), before, 'registry bytes unchanged');
      const removals = gitLogLines(shim.log).filter((line) => /worktree.*remove/.test(line));
      assert.deepEqual(removals, [], `no git worktree remove may run: ${JSON.stringify(gitLogLines(shim.log))}`);
    } finally {
      restoreCwd();
      restoreEnv();
    }
  });

  test('worktree_list never resolves a registry path against the process cwd', async () => {
    const { root, elsewhere, nested, far } = makeRelativePathFixture('list');
    const herdr = makeHerdrStub();
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_STATE: herdr.state,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    // From elsewhere, <cwd>/nested IS a live checkout (feat-b's) — the
    // relative feat-a entry must still be reported missing, never live.
    process.chdir(elsewhere);
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_list').execute(
        'call-1', {}, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined);
      const text = resultText(result);
      assert.ok(
        text.includes('feat-a') && text.split('\n').find((line) => line.includes('feat-a')).endsWith(' missing'),
        `the relative entry is missing, never live: ${text}`,
      );
      assert.ok(
        text.includes(`${far} feat-b thread=thread-2 issues=35`) && !text.split('\n').find((line) => line.includes('feat-b')).endsWith(' missing'),
        `the absolute entry stays live: ${text}`,
      );
      void nested;
    } finally {
      restoreCwd();
      restoreEnv();
    }
  });

  test('exact keys only: closing feat-a from another cwd keeps the <cwd>/feat-a entry', async () => {
    const root = makeRepo('exactkey');
    const elsewhere = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rel-ew-exact-'))));
    // Registration order matters: the <cwd>/feat-a entry comes FIRST so a
    // path-key match would drop it before the branch match is reached.
    const decoy = path.join(elsewhere, 'feat-a');
    git(root, ['worktree', 'add', '-b', 'feat-x', decoy, 'HEAD']);
    const target = path.join(path.dirname(root), `${path.basename(root)}-wt-feat-a`);
    git(root, ['worktree', 'add', '-b', 'feat-a', target, 'HEAD']);
    const realDecoy = fs.realpathSync(decoy);
    const realTarget = fs.realpathSync(target);
    track(realTarget);
    const registryLib = require('../lib/worktree-registry.js');
    assert.equal(registryLib.upsertWorktree(root, {
      branch: 'feat-x', path: realDecoy, thread: 'thread-9', issues: [35], odd: [],
    }).ok, true);
    assert.equal(registryLib.upsertWorktree(root, {
      branch: 'feat-a', path: realTarget, thread: 'thread-1', issues: [35], odd: [],
    }).ok, true);

    // `path.resolve(<branch name>)` must never be a path key: a relative
    // lookup matches nothing even though <cwd>/feat-a is registered.
    process.chdir(elsewhere);
    try {
      assert.equal(
        registryLib.findByPath(root, 'feat-a'),
        null,
        'findByPath with a relative key matches nothing',
      );
      const dropped = registryLib.removeWorktree(root, 'feat-a');
      assert.equal(dropped.ok, true);
      assert.equal(
        registryLib.findByBranch(root, 'feat-x').path,
        realDecoy,
        'the <cwd>/feat-a entry survives a close of feat-a',
      );
      assert.equal(registryLib.findByBranch(root, 'feat-a'), null, 'the intended entry is dropped');
    } finally {
      restoreCwd();
    }
  });

  test('close flow drops exactly the intended entry when a <cwd>/feat-a checkout exists', async () => {
    const root = makeRepo('exactflow');
    const elsewhere = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-rel-ew-flow-'))));
    const decoy = path.join(elsewhere, 'feat-a');
    git(root, ['worktree', 'add', '-b', 'feat-x', decoy, 'HEAD']);
    const target = path.join(path.dirname(root), `${path.basename(root)}-wt-feat-a`);
    git(root, ['worktree', 'add', '-b', 'feat-a', target, 'HEAD']);
    const realDecoy = fs.realpathSync(decoy);
    const realTarget = fs.realpathSync(target);
    track(realTarget);
    const registryLib = require('../lib/worktree-registry.js');
    registryLib.upsertWorktree(root, {
      branch: 'feat-x', path: realDecoy, thread: 'thread-9', issues: [35], odd: [],
    });
    registryLib.upsertWorktree(root, {
      branch: 'feat-a', path: realTarget, thread: 'thread-1', issues: [35], odd: [],
    });
    const herdr = makeHerdrStub();
    const modeEnv = scratchModeEnv();
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: herdr.log,
      HERDR_SHIM_STATE: herdr.state,
      GENTLE_WORKTREE_THREAD: undefined,
    });
    process.chdir(elsewhere);
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute(
        'call-1', { branch: 'feat-a' }, undefined, undefined, makeCtx({ repoRoot: root }),
      );
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.equal(registryLib.findByBranch(root, 'feat-a'), null, 'the intended entry is dropped');
      assert.equal(
        registryLib.findByBranch(root, 'feat-x').path,
        realDecoy,
        'the <cwd>/feat-a entry is kept',
      );
      assert.ok(livePaths(root).includes(realDecoy), 'the decoy checkout is still live');
      assert.ok(!livePaths(root).includes(realTarget), 'the intended checkout is removed');
    } finally {
      restoreCwd();
      restoreEnv();
    }
  });
});
