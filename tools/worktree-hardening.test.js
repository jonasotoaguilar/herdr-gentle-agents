'use strict';
// Adversarial hardening tests for CE1–CE5 (test-first).
// Each counterexample gets its own test asserting every observable effect:
// registry bytes, removal argv, which checkout survived, and error text.

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
  .replace('import { Type } from "@earendil-works/pi-ai";', TYPE_STUB)
  .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', 'const defineTool = (def) => def;');
assert.ok(stubbed !== srcText);

const roots = [];
const savedCwd = process.cwd();
const savedEnv = { ...process.env };
after(() => {
  try { process.chdir(savedCwd); } catch {}
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});
function track(p) { roots.push(p); return p; }
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return (r.stdout || '').trim();
}
function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-hard-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}
function setEnv(vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
function restoreEnvCwd() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [k, v] of Object.entries(savedEnv)) process.env[k] = v;
  try { process.chdir(savedCwd); } catch {}
}
function scratchModeEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hard-mode-'))) };
}
async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hard-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = { registerTool: (t) => { tools.set(t.name, t); } };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
}
function makeCtx(repoRoot) {
  return { cwd: repoRoot, hasUI: false, sessionManager: { getSessionId: () => 'thread-1' }, ui: { confirm: async () => true, notify: () => {} } };
}
function resultText(r) { return (r.content || []).map((p) => p.text || '').join('\n'); }
function livePaths(root) {
  return git(root, ['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).map((l) => l.slice(9));
}
// Herdr stub for CE3: list emits RELATIVE paths (relative to repo root,
// i.e. honest) with workspace ids; remove maps workspace -> absolute path
// and runs a real `git worktree remove`. Every argv line is logged.
const HERDR_REL_SRC = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const EOL = String.fromCharCode(10);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_SHIM_LOG, argv.join(' ') + EOL);
function fail(m){ console.error(m); process.exit(1); }
const op = argv[1]; const rest = argv.slice(2);
function flag(n){ const i=rest.indexOf(n); if(i<0||i+1>=rest.length) return null; return rest[i+1]; }
if (argv[0]!=='worktree') fail('stub scope');
if (op==='list'){
  const cwd = flag('--cwd'); if(!cwd) fail('list missing --cwd');
  const repoRoot = process.env.HERDR_SHIM_REPO;
  const entries = JSON.parse(fs.readFileSync(process.env.HERDR_SHIM_ENTRIES,'utf8'));
  const map = {};
  const worktrees = entries.map(function(e,i){
    const id='ws-'+i; map[id]=e.abs;
    let rel = e.abs;
    try { rel = path.relative(repoRoot, e.abs); } catch {}
    // Emit relative when it does not escape upward beyond one level honesty:
    // keep it relative whenever the relative form is not absolute.
    if (path.isAbsolute(rel)) rel = e.abs;
    return { path: rel, branch: e.branch, open_workspace_id: id };
  });
  fs.writeFileSync(process.env.HERDR_SHIM_STATE, JSON.stringify(map));
  console.log(JSON.stringify({ result: { worktrees } }));
  process.exit(0);
}
if (op==='remove'){
  const ws = flag('--workspace'); if(!ws) fail('remove missing --workspace');
  let map=null; try{ map=JSON.parse(fs.readFileSync(process.env.HERDR_SHIM_STATE,'utf8')); }catch(e){ map=null; }
  if(!map) fail('no state');
  const target=map[ws]; if(!target) fail('unknown ws '+ws);
  const l=spawnSync('git',['worktree','list','--porcelain'],{cwd:target,encoding:'utf8'});
  let main=null;
  if(l.status===0){ for(const line of l.stdout.split(EOL)){ if(line.indexOf('worktree ')===0){ main=line.slice(9); break; } } }
  if(!main) fail('cannot locate main');
  const args=['worktree','remove'];
  if(rest.indexOf('--force')>=0) args.push('--force');
  args.push(target);
  const r=spawnSync('git',args,{cwd:main,encoding:'utf8'});
  if(r.stdout) process.stdout.write(r.stdout);
  if(r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status==null?1:r.status);
}
fail('unexpected '+argv.join(' '));
`;
function makeHerdrRelStub() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hard-herdr-')));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, HERDR_REL_SRC, { mode: 0o755 });
  return { bin, log: path.join(dir, 'argv.log'), state: path.join(dir, 'state.json'), entries: path.join(dir, 'entries.json') };
}

describe('CE1: duplicate branch entries — close drops by path identity', { concurrency: false }, () => {
  test('closing one of two same-branch checkouts keeps the live survivor registered', async () => {
    const root = makeRepo('ce1');
    const dirA = path.join(path.dirname(root), `${path.basename(root)}-a`);
    const dirB = path.join(path.dirname(root), `${path.basename(root)}-b`);
    git(root, ['worktree', 'add', '-b', 'feat-a', dirA, 'HEAD']);
    git(root, ['worktree', 'add', '-b', 'feat-b', dirB, 'HEAD']);
    const realA = fs.realpathSync(dirA); track(realA);
    const realB = fs.realpathSync(dirB); track(realB);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-a', path: realA, thread: 't-1', issues: [1], odd: [] }).ok, true);
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-b', path: realB, thread: 't-2', issues: [1], odd: [] }).ok, true);
    // Hand-edit: duplicate the branch so both entries share 'feat-a'.
    const file = reg.registryPath(root);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.worktrees.find((e) => e.path === realB).branch = 'feat-a';
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    const beforeBytes = fs.readFileSync(file);

    const herdr = makeHerdrRelStub();
    // Honest absolute entries for the stub (it will relativize); order irrelevant here.
    fs.writeFileSync(herdr.entries, JSON.stringify([{ abs: realA, branch: 'feat-a' }, { abs: realB, branch: 'feat-a' }]));
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-ce1'), GENTLE_WORKTREE_THREAD: undefined });
    try {
      const tools = await loadExtension();
      // Close the SECOND checkout by path (forces path-identity resolution).
      const result = await tools.get('worktree_close').execute('c1', { path: realB, force: true }, undefined, undefined, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.match(resultText(result), /worktree close:/);
      // The removed checkout is gone from disk and registry ...
      assert.equal(fs.existsSync(realB), false, 'removed checkout gone from disk');
      assert.ok(!livePaths(root).includes(realB), 'removed checkout not listed');
      // ... and the registry contains EXACTLY the surviving live checkout.
      const after = reg.readRegistry(root);
      assert.equal(after.ok, true);
      assert.equal(after.worktrees.length, 1, `registry must hold exactly one entry, got ${JSON.stringify(after.worktrees)}`);
      assert.equal(path.resolve(after.worktrees[0].path), realA, 'survivor is the live checkout');
      assert.ok(livePaths(root).includes(realA), 'survivor still live');
      assert.ok(fs.existsSync(realA), 'survivor on disk');
      assert.notDeepEqual(fs.readFileSync(file), beforeBytes, 'registry bytes changed (dead entry dropped)');
    } finally { restoreEnvCwd(); }
  });
});

describe('CE2: branch equals another entry absolute path', { concurrency: false }, () => {
  test('close drops the resolved path, not the branch-first match', async () => {
    const root = makeRepo('ce2');
    const dirA = path.join(path.dirname(root), `${path.basename(root)}-a`);
    const dirB = path.join(path.dirname(root), `${path.basename(root)}-b`);
    git(root, ['worktree', 'add', '-b', 'feat-a', dirA, 'HEAD']);
    git(root, ['worktree', 'add', '-b', 'feat-b', dirB, 'HEAD']);
    const realA = fs.realpathSync(dirA); track(realA);
    const realB = fs.realpathSync(dirB); track(realB);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-a', path: realA, thread: 't-1', issues: [1], odd: [] }).ok, true);
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-b', path: realB, thread: 't-2', issues: [1], odd: [] }).ok, true);
    // Hand-edit: entry B branch becomes entry A absolute path (branch-first trap).
    const file = reg.registryPath(root);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    // Order: A first so a branch-first scan hits A path-match before B branch-match.
    doc.worktrees.find((e) => e.path === realB).branch = realA;
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);

    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: scratchModeEnv().GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-ce2'), GENTLE_WORKTREE_THREAD: undefined });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realB, force: true }, undefined, undefined, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.equal(fs.existsSync(realB), false, 'removed checkout gone from disk');
      assert.ok(!livePaths(root).includes(realB), 'removed gone from git list');
      const after = reg.readRegistry(root);
      assert.equal(after.ok, true);
      assert.equal(after.worktrees.length, 1, `exactly one survivor, got ${JSON.stringify(after.worktrees)}`);
      assert.equal(path.resolve(after.worktrees[0].path), realA, 'survivor is the live checkout');
      assert.ok(livePaths(root).includes(realA) && fs.existsSync(realA), 'survivor live on disk');
    } finally { restoreEnvCwd(); }
  });
});

describe('CE3: herdr relative paths with foreign cwd', { concurrency: false }, () => {
  test('relative list entries resolve against repo root; victim survives, target removed', async () => {
    const root = makeRepo('ce3');
    const elsewhere = fs.realpathSync(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hard-ce3-ew-'))));
    // Victim V inside repo (relative "victim"), intended T inside elsewhere with same leaf.
    const victimAbs = path.join(root, 'victim');
    git(root, ['worktree', 'add', '-b', 'feat-victim', victimAbs, 'HEAD']);
    const realV = fs.realpathSync(victimAbs);
    const targetAbs = path.join(elsewhere, 'victim');
    git(root, ['worktree', 'add', '-b', 'feat-target', targetAbs, 'HEAD']);
    const realT = fs.realpathSync(targetAbs); track(realT);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);

    const herdr = makeHerdrRelStub();
    // Victim FIRST so a cwd-resolved scan hits it before the target.
    fs.writeFileSync(herdr.entries, JSON.stringify([{ abs: realV, branch: 'feat-victim' }, { abs: realT, branch: 'feat-target' }]));
    fs.writeFileSync(herdr.log, '');
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: herdr.bin, HERDR_SHIM_LOG: herdr.log, HERDR_SHIM_STATE: herdr.state, HERDR_SHIM_ENTRIES: herdr.entries, HERDR_SHIM_REPO: root, GENTLE_WORKTREE_THREAD: undefined });
    process.chdir(elsewhere);
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realT, force: true }, undefined, undefined, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.match(resultText(result), /worktree close:/);
      // Victim survives on disk and in git list; intended is the one removed.
      assert.ok(fs.existsSync(realV), 'victim directory survives');
      assert.ok(livePaths(root).includes(realV), 'victim still listed');
      assert.equal(fs.existsSync(realT), false, 'intended checkout removed from disk');
      assert.ok(!livePaths(root).includes(realT), 'intended gone from git list');
      // No --workspace argv named another path: the only remove (if any) is the verified target.
      const lines = fs.readFileSync(herdr.log, 'utf8').split('\n').filter((l) => l.length > 0);
      const removes = lines.filter((l) => l.startsWith('worktree remove '));
      assert.ok(removes.length <= 1, `at most one herdr remove, got ${JSON.stringify(lines)}`);
      if (removes.length === 1) {
        assert.ok(removes[0].includes('--workspace ws-1'), `herdr remove must name the verified target workspace (ws-1), got ${removes[0]}`);
        assert.ok(!removes[0].includes('ws-0'), `must never name the victim workspace, got ${removes[0]}`);
      }
      // Registry: removed entry gone, no dead entry left.
      const after = reg.readRegistry(root);
      assert.equal(after.ok, true);
      assert.equal(after.worktrees.length, 0, `registry empty after closing sole entry, got ${JSON.stringify(after.worktrees)}`);
    } finally { restoreEnvCwd(); }
  });
});

describe('CE4: mode temp file must not follow a predictable symlink', { concurrency: false }, () => {
  test('a symlink at the legacy predictable temp name is never followed', () => {
    const modeLib = require('../lib/worktree-mode.js');
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hard-ce4-')));
    const env = { GENTLE_STATUS_STATE_DIR: dir };
    const file = modeLib.modePath(env);
    const canary = path.join(dir, 'precious.txt');
    fs.writeFileSync(canary, 'do not destroy me\n');
    // Legacy predictable name (first-round code): <file>.tmp.<pid>.<Date.now()>.<rand>
    const fixedNow = 1700000000000;
    const origNow = Date.now;
    const origRandom = Math.random;
    Date.now = () => fixedNow;
    Math.random = () => 0.123456;
    let legacyTmp;
    try {
      legacyTmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
      fs.symlinkSync(canary, legacyTmp);
    } finally {
      Date.now = origNow;
      Math.random = origRandom;
    }
    // Act under the same clock so legacy code would collide exactly.
    Date.now = () => fixedNow;
    Math.random = () => 0.123456;
    try {
      modeLib.writeMode(true, env);
    } finally {
      Date.now = origNow;
      Math.random = origRandom;
    }
    assert.equal(fs.readFileSync(canary, 'utf8'), 'do not destroy me\n', 'symlink target bytes unchanged');
    assert.equal(fs.readFileSync(file, 'utf8'), '{"version":1,"enabled":true}\n', 'mode file holds exactly the enabled bytes');
    assert.equal(fs.lstatSync(file).isSymbolicLink(), false, 'mode path is a regular file');
  });
});

describe('CE5: corrupt-registry backup must not follow a predictable symlink', { concurrency: false }, () => {
  test('a symlink at the legacy corrupt name never receives the malformed bytes', () => {
    const root = makeRepo('ce5');
    const reg = require('../lib/worktree-registry.js');
    const file = reg.registryPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const evil = '{"not json';
    fs.writeFileSync(file, evil);
    const precious = path.join(path.dirname(file), 'precious-backup-target.txt');
    fs.writeFileSync(precious, 'precious\n');
    const fixedNow = 1700000000000;
    const origNow = Date.now;
    Date.now = () => fixedNow;
    let legacyBackup;
    try {
      legacyBackup = `${file}.corrupt-${Date.now()}`;
      try { fs.unlinkSync(legacyBackup); } catch {}
      fs.symlinkSync(precious, legacyBackup);
    } finally {
      Date.now = origNow;
    }
    Date.now = () => fixedNow;
    let stored;
    try {
      stored = reg.upsertWorktree(root, { branch: 'feat-x', path: path.join(path.dirname(root), 'x-wt'), thread: 't-1', issues: [1], odd: [] });
    } finally {
      Date.now = origNow;
    }
    assert.equal(stored.ok, true, 'upsert continues (backup is best-effort, never fatal)');
    assert.equal(fs.readFileSync(precious, 'utf8'), 'precious\n', 'precious symlink target never clobbered');
    // Registry itself is replaced with the valid entry.
    const after = reg.readRegistry(root);
    assert.equal(after.ok, true);
    assert.equal(after.worktrees.length, 1);
    assert.equal(after.worktrees[0].branch, 'feat-x');
    // If a backup was made it must not be the planted symlink and must hold exact bytes.
    if (stored.backup) {
      assert.notEqual(path.resolve(stored.backup), path.resolve(legacyBackup), 'backup never reuses the planted name');
      assert.equal(fs.lstatSync(stored.backup).isSymbolicLink(), false, 'backup is a regular file');
      assert.equal(fs.readFileSync(stored.backup, 'utf8'), evil, 'backup holds the exact malformed bytes');
    } else {
      assert.ok(stored.backupError, 'when no backup could be written the failure is reported clearly');
    }
  });
});
