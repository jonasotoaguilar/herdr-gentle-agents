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
      assert.match(resultText(result), /^removed: /);
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
      assert.match(resultText(result), /^removed: /);
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

// R4-1: a herdr list that reports the same path twice with different ids
// is ambiguity — the close must skip herdr entirely and use the git path.
const HERDR_DUP_R4_SRC = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const EOL = String.fromCharCode(10);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_SHIM_LOG, argv.join(' ') + EOL);
function fail(m){ console.error(m); process.exit(1); }
const op = argv[1]; const rest = argv.slice(2);
function flag(n){ const i=rest.indexOf(n); if(i<0||i+1>=rest.length) return null; return rest[i+1]; }
if (argv[0]!=='worktree') fail('stub scope');
if (op==='list'){
  const mode = process.env.HERDR_DUP_MODE || 'ambiguous';
  const target = process.env.HERDR_DUP_TARGET;
  const victim = process.env.HERDR_DUP_VICTIM;
  let worktrees;
  if (mode === 'same') {
    worktrees = [{ path: target, branch: 'feat-target', open_workspace_id: 'ws-0' }, { path: target, branch: 'feat-target', open_workspace_id: 'ws-0' }];
    fs.writeFileSync(process.env.HERDR_SHIM_STATE, JSON.stringify({ 'ws-0': target }));
  } else {
    worktrees = [{ path: target, branch: 'feat-target', open_workspace_id: 'ws-v' }, { path: target, branch: 'feat-target', open_workspace_id: 'ws-t' }];
    const map = {}; map['ws-v'] = victim; map['ws-t'] = target;
    fs.writeFileSync(process.env.HERDR_SHIM_STATE, JSON.stringify(map));
  }
  console.log(JSON.stringify({ result: { worktrees } }));
  process.exit(0);
}
if (op==='remove'){
  const ws = flag('--workspace'); if(!ws) fail('remove missing --workspace');
  let map=null; try{ map=JSON.parse(fs.readFileSync(process.env.HERDR_SHIM_STATE,'utf8')); }catch(e){ map=null; }
  if(!map) fail('no state');
  const t=map[ws]; if(!t) fail('unknown ws '+ws);
  const l=spawnSync('git',['worktree','list','--porcelain'],{cwd:t,encoding:'utf8'});
  let main=null;
  if(l.status===0){ for(const line of l.stdout.split(EOL)){ if(line.indexOf('worktree ')===0){ main=line.slice(9); break; } } }
  if(!main) fail('cannot locate main');
  const args=['worktree','remove'];
  if(rest.indexOf('--force')>=0) args.push('--force');
  args.push(t);
  const r=spawnSync('git',args,{cwd:main,encoding:'utf8'});
  if(r.stdout) process.stdout.write(r.stdout);
  if(r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status==null?1:r.status);
}
fail('unexpected '+argv.join(' '));
`;
function makeHerdrDupStubR4() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-r4-dup-')));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, HERDR_DUP_R4_SRC, { mode: 0o755 });
  return { bin, log: path.join(dir, 'argv.log'), state: path.join(dir, 'state.json') };
}

describe('R4-1: duplicate herdr list paths with different ids fall back to git', { concurrency: false }, () => {
  test('ambiguous duplicate ids use the git path; victim survives, target removed', async () => {
    const root = makeRepo('r41');
    const dirV = path.join(path.dirname(root), `${path.basename(root)}-victim`);
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-victim', dirV, 'HEAD']);
    git(root, ['worktree', 'add', '-b', 'feat-target', dirT, 'HEAD']);
    const realV = fs.realpathSync(dirV); track(realV);
    const realT = fs.realpathSync(dirT); track(realT);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-victim', path: realV, thread: 't-v', issues: [1], odd: [] }).ok, true);
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    const beforeBytes = fs.readFileSync(reg.registryPath(root));
    const herdr = makeHerdrDupStubR4();
    fs.writeFileSync(herdr.log, '');
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: herdr.bin, HERDR_SHIM_LOG: herdr.log, HERDR_SHIM_STATE: herdr.state, HERDR_DUP_MODE: 'ambiguous', HERDR_DUP_TARGET: realT, HERDR_DUP_VICTIM: realV, GENTLE_WORKTREE_THREAD: undefined });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realT, force: true }, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success via git fallback, got: ${text}`);
      assert.deepEqual(text.split('\n'), [
        'removed: feat-target · feat-target',
        'branch kept',
      ]);
      assert.ok(fs.existsSync(realV), 'victim directory survives on disk');
      assert.ok(livePaths(root).includes(realV), 'victim still listed by git');
      assert.equal(fs.existsSync(realT), false, 'target removed from disk');
      assert.ok(!livePaths(root).includes(realT), 'target gone from git list');
      const lines = fs.readFileSync(herdr.log, 'utf8').split('\n').filter((l) => l.length > 0);
      const removes = lines.filter((l) => l.startsWith('worktree remove '));
      assert.deepEqual(removes, [], `no removal argv may name a workspace: ${JSON.stringify(lines)}`);
      const after = reg.readRegistry(root);
      assert.equal(after.ok, true);
      assert.ok(after.worktrees.some((e) => path.resolve(e.path) === realV), 'victim entry kept');
      assert.ok(!after.worktrees.some((e) => path.resolve(e.path) === realT), 'target entry dropped');
      assert.notDeepEqual(fs.readFileSync(reg.registryPath(root)), beforeBytes, 'registry bytes changed');
    } finally { restoreEnvCwd(); }
  });
  test('duplicate entries carrying the SAME id still resolve through herdr', async () => {
    const root = makeRepo('r41-same');
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-target', dirT, 'HEAD']);
    const realT = fs.realpathSync(dirT); track(realT);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    const herdr = makeHerdrDupStubR4();
    fs.writeFileSync(herdr.log, '');
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: herdr.bin, HERDR_SHIM_LOG: herdr.log, HERDR_SHIM_STATE: herdr.state, HERDR_DUP_MODE: 'same', HERDR_DUP_TARGET: realT, HERDR_DUP_VICTIM: realT, GENTLE_WORKTREE_THREAD: undefined });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realT, force: true }, undefined, undefined, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.equal(fs.existsSync(realT), false, 'target removed');
      const lines = fs.readFileSync(herdr.log, 'utf8').split('\n').filter((l) => l.length > 0);
      const removes = lines.filter((l) => l.startsWith('worktree remove '));
      assert.equal(removes.length, 1, `same-id duplicates still use herdr: ${JSON.stringify(lines)}`);
      assert.ok(removes[0].includes('--workspace ws-0'), `names the shared id: ${removes[0]}`);
    } finally { restoreEnvCwd(); }
  });
});

// R4-2: a removal that removes something else must fail naming the vanished path.
const HERDR_HOSTILE_R4_SRC = `#!/usr/bin/env node
'use strict';
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const EOL = String.fromCharCode(10);
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.HERDR_SHIM_LOG, argv.join(' ') + EOL);
function fail(m){ console.error(m); process.exit(1); }
const op = argv[1]; const rest = argv.slice(2);
if (argv[0]!=='worktree') fail('stub scope');
if (op==='list'){
  const target = process.env.HERDR_R42_TARGET;
  const map = { 'ws-0': target };
  fs.writeFileSync(process.env.HERDR_SHIM_STATE, JSON.stringify(map));
  console.log(JSON.stringify({ result: { worktrees: [{ path: target, branch: 'feat-target', open_workspace_id: 'ws-0' }] } }));
  process.exit(0);
}
if (op==='remove'){
  const victim = process.env.HERDR_R42_VICTIM;
  const l=spawnSync('git',['worktree','list','--porcelain'],{cwd:victim,encoding:'utf8'});
  let main=null;
  if(l.status===0){ for(const line of l.stdout.split(EOL)){ if(line.indexOf('worktree ')===0){ main=line.slice(9); break; } } }
  if(!main) fail('cannot locate main');
  const r=spawnSync('git',['worktree','remove','--force', victim],{cwd:main,encoding:'utf8'});
  if(r.stdout) process.stdout.write(r.stdout);
  if(r.stderr) process.stderr.write(r.stderr);
  process.exit(0);
}
fail('unexpected '+argv.join(' '));
`;
function makeHerdrHostileR4() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-r4-hostile-')));
  const bin = path.join(dir, 'herdr');
  fs.writeFileSync(bin, HERDR_HOSTILE_R4_SRC, { mode: 0o755 });
  return { bin, log: path.join(dir, 'argv.log'), state: path.join(dir, 'state.json') };
}

describe('R4-2: removal of another checkout fails naming the vanished path', { concurrency: false }, () => {
  test('herdr path: vanished checkout is named, registry entry kept', async () => {
    const root = makeRepo('r42-herdr');
    const dirV = path.join(path.dirname(root), `${path.basename(root)}-victim`);
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-victim', dirV, 'HEAD']);
    git(root, ['worktree', 'add', '-b', 'feat-target', dirT, 'HEAD']);
    const realV = fs.realpathSync(dirV); track(realV);
    const realT = fs.realpathSync(dirT); track(realT);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-victim', path: realV, thread: 't-v', issues: [1], odd: [] }).ok, true);
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    const beforeBytes = fs.readFileSync(reg.registryPath(root));
    const herdr = makeHerdrHostileR4();
    fs.writeFileSync(herdr.log, '');
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: herdr.bin, HERDR_SHIM_LOG: herdr.log, HERDR_SHIM_STATE: herdr.state, HERDR_R42_TARGET: realT, HERDR_R42_VICTIM: realV, GENTLE_WORKTREE_THREAD: undefined });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realT, force: true }, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, true, `expected loud failure, got: ${text}`);
      assert.ok(text.includes(realV), `error names the vanished path ${realV}: ${text}`);
      assert.ok(fs.existsSync(realT), 'target checkout survives on disk');
      assert.ok(livePaths(root).includes(realT), 'target still listed');
      assert.equal(fs.existsSync(realV), false, 'victim was removed by the hostile backend');
      assert.ok(!livePaths(root).includes(realV), 'victim gone from git list');
      assert.deepEqual(fs.readFileSync(reg.registryPath(root)), beforeBytes, 'registry bytes unchanged (entry kept)');
    } finally { restoreEnvCwd(); }
  });
  test('git path: vanished checkout is named, registry entry kept', async () => {
    const root = makeRepo('r42-git');
    const dirV = path.join(path.dirname(root), `${path.basename(root)}-victim`);
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-victim', dirV, 'HEAD']);
    git(root, ['worktree', 'add', '-b', 'feat-target', dirT, 'HEAD']);
    const realV = fs.realpathSync(dirV); track(realV);
    const realT = fs.realpathSync(dirT); track(realT);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    const beforeBytes = fs.readFileSync(reg.registryPath(root));
    const which = spawnSync('which', ['git'], { encoding: 'utf8' });
    assert.equal(which.status, 0);
    const realGit = which.stdout.trim();
    const shimDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-r42-gitshim-')));
    const gitLog = path.join(shimDir, 'git.log');
    fs.writeFileSync(gitLog, '');
    fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "git $*" >> "${gitLog}"\ncase "$*" in\n  *"worktree remove"*) exec "${realGit}" -C "${root}" worktree remove --force "${realV}";;\n  *) exec "${realGit}" "$@";;\nesac\n`, { mode: 0o755 });
    const modeEnv = scratchModeEnv();
    const savedPath = process.env.PATH;
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-r42'), GENTLE_WORKTREE_THREAD: undefined, PATH: `${shimDir}${path.delimiter}${savedPath}` });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realT, force: true }, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, true, `expected loud failure, got: ${text}`);
      assert.ok(text.includes(realV), `error names the vanished path ${realV}: ${text}`);
      assert.ok(fs.existsSync(realT), 'target survives on disk');
      assert.ok(livePaths(root).includes(realT), 'target still listed');
      assert.deepEqual(fs.readFileSync(reg.registryPath(root)), beforeBytes, 'registry bytes unchanged (entry kept)');
    } finally { restoreEnvCwd(); }
  });
  test('legitimate single-checkout removal still succeeds', async () => {
    const root = makeRepo('r42-legit');
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-target', dirT, 'HEAD']);
    const realT = fs.realpathSync(dirT); track(realT);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-r42legit'), GENTLE_WORKTREE_THREAD: undefined });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realT, force: true }, undefined, undefined, makeCtx(root));
      assert.equal(result.isError, undefined, `expected success, got: ${resultText(result)}`);
      assert.deepEqual(resultText(result).split('\n'), [
        'removed: feat-target · feat-target',
        'branch kept',
      ]);
      assert.equal(fs.existsSync(realT), false, 'target removed');
    } finally { restoreEnvCwd(); }
  });
});

describe('R4-3: removeWorktreeByPath drops every duplicate row', { concurrency: false }, () => {
  test('two rows sharing one path leave no stale duplicate', async () => {
    const root = makeRepo('r43');
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-a', dirT, 'HEAD']);
    const realT = fs.realpathSync(dirT); track(realT);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-a', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-b', path: path.join(path.dirname(root), 'other'), thread: 't-2', issues: [1], odd: [] }).ok, true);
    const file = reg.registryPath(root);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    doc.worktrees.find((e) => e.branch === 'feat-b').path = realT;
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).worktrees.filter((e) => path.resolve(e.path) === realT).length, 2, 'fixture holds two duplicate rows');
    const modeEnv = scratchModeEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-r43'), GENTLE_WORKTREE_THREAD: undefined });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realT, force: true }, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      assert.deepEqual(text.split('\n'), [
        'removed: feat-a · feat-a',
        'branch kept',
      ]);
      assert.equal(fs.existsSync(realT), false, 'checkout removed from disk');
      assert.ok(!livePaths(root).includes(realT), 'checkout gone from git list');
      const after = reg.readRegistry(root);
      assert.equal(after.ok, true);
      assert.equal(after.worktrees.filter((e) => { try { return path.isAbsolute(e.path) && path.resolve(e.path) === realT; } catch { return false; } }).length, 0, `no stale duplicate survives (R4-3): ${JSON.stringify(after.worktrees)}`);
    } finally { restoreEnvCwd(); }
  });
});

function makeGhStubR4(knownIssues) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-r4-gh-')));
  const bin = path.join(dir, 'gh');
  const cases = knownIssues.map((n) => `    ${n}) printf '{"number":${n},"title":"T${n}","state":"OPEN"}\\n'; exit 0;;`).join('\n');
  fs.writeFileSync(bin, ['#!/bin/sh', 'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then', '  case "$3" in', cases, '    *) echo "could not resolve to an Issue" >&2; exit 1;;', '  esac', 'fi', 'echo "gh stub" >&2; exit 1', ''].join('\n'), { mode: 0o755 });
  return bin;
}
function makeHerdrCreateStubR4() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-r4-hc-')));
  const bin = path.join(dir, 'herdr');
  const log = path.join(dir, 'argv.log');
  fs.writeFileSync(bin, ['#!/bin/sh', 'printf \'%s\\n\' "$*" >> "$HERDR_SHIM_LOG"', 'if [ "$1" = "worktree" ] && [ "$2" = "create" ]; then', '  shift 2', '  branch=""; base=""; wtpath=""; cwd=""', '  while [ $# -gt 0 ]; do', '    case "$1" in', '      --branch) branch="$2"; shift 2;;', '      --base) base="$2"; shift 2;;', '      --path) wtpath="$2"; shift 2;;', '      --cwd) cwd="$2"; shift 2;;', '      *) shift;;', '    esac', '  done', '  [ -n "$branch" ] && [ -n "$wtpath" ] && [ -n "$cwd" ] || { echo "missing args" >&2; exit 1; }', '  exec git -C "$cwd" worktree add -b "$branch" "$wtpath" "$base"', 'fi', 'echo "herdr stub" >&2; exit 1', ''].join('\n'), { mode: 0o755 });
  return { bin, log };
}

describe('R4-4: stale cleanup drops exactly the thread-owned row', { concurrency: false }, () => {
  test('live feat-shared survives in both absolute and relative stale arms', async () => {
    for (const arm of ['absolute', 'relative']) {
      const root = makeRepo(`r44-${arm}`);
      const liveDir = path.join(path.dirname(root), `${path.basename(root)}-live`);
      git(root, ['worktree', 'add', '-b', 'feat-shared', liveDir, 'HEAD']);
      const liveAbs = fs.realpathSync(liveDir); track(liveAbs);
      const reg = require('../lib/worktree-registry.js');
      assert.equal(reg.upsertWorktree(root, { branch: 'feat-shared', path: liveAbs, thread: 'other-thread', issues: [1], odd: [] }).ok, true);
      const stalePath = arm === 'absolute' ? path.join(path.dirname(root), `${path.basename(root)}-stale-gone`) : 'relative/stale';
      assert.equal(reg.upsertWorktree(root, { branch: 'feat-temp', path: stalePath, thread: 'creator', issues: [1], odd: [] }).ok, true);
      const file = reg.registryPath(root);
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      doc.worktrees.find((e) => e.branch === 'feat-temp').branch = 'feat-shared';
      fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
      const herdr = makeHerdrCreateStubR4();
      const gh = makeGhStubR4([7]);
      fs.writeFileSync(herdr.log, '');
      const modeEnv = scratchModeEnv();
      setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: herdr.bin, HERDR_SHIM_LOG: herdr.log, GH_BIN_PATH: gh, GENTLE_WORKTREE_THREAD: 'creator' });
      try {
        const tools = await loadExtension();
        const ctx = { cwd: root, hasUI: false, sessionManager: { getSessionId: () => 'creator' }, ui: { confirm: async () => true, notify: () => {} } };
        const result = await tools.get('worktree_create').execute('c1', { branch: 'feat-new-' + arm, issues: [7] }, undefined, undefined, ctx);
        const text = resultText(result);
        assert.equal(result.isError, undefined, `[${arm}] expected creation success, got: ${text}`);
        const after = reg.readRegistry(root);
        assert.equal(after.ok, true);
        assert.ok(after.worktrees.some((e) => e.branch === 'feat-shared' && e.path === liveAbs), `[${arm}] live entry survives registered: ${JSON.stringify(after.worktrees)}`);
        assert.ok(!after.worktrees.some((e) => e.thread === 'creator' && e.branch === 'feat-shared'), `[${arm}] stale row is gone: ${JSON.stringify(after.worktrees)}`);
        assert.ok(fs.existsSync(liveAbs), `[${arm}] live checkout survives on disk`);
        assert.ok(livePaths(root).includes(liveAbs), `[${arm}] live checkout still listed`);
      } finally { restoreEnvCwd(); }
    }
  });
});

describe('R4-5: failed writes never leave a temp file behind', { concurrency: false }, () => {
  test('mode and registry writers unlink the temp before rethrowing ENOSPC', async () => {
    const modeLib = require('../lib/worktree-mode.js');
    const modeDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-r45-mode-')));
    const modeEnv = { GENTLE_STATUS_STATE_DIR: modeDir };
    const origWrite = fs.writeFileSync;
    let modeSawTemp = null;
    fs.writeFileSync = function (file, data, opts) {
      if (typeof file === 'string' && file.includes('.tmp.') && opts && opts.flag === 'wx') {
        modeSawTemp = file;
        origWrite.call(fs, file, 'partial');
        const err = new Error('ENOSPC: no space left on device, write');
        err.code = 'ENOSPC';
        throw err;
      }
      return origWrite.call(fs, file, data, opts);
    };
    let modeThrew = null;
    try { modeLib.writeMode(true, modeEnv); } catch (err) { modeThrew = err; } finally { fs.writeFileSync = origWrite; }
    assert.ok(modeThrew, 'mode write rethrows (never a success)');
    assert.match(String(modeThrew && modeThrew.message), /ENOSPC|no space/i);
    assert.ok(modeSawTemp, 'the temp file was attempted');
    assert.equal(fs.existsSync(modeSawTemp), false, `mode temp left behind at ${modeSawTemp}`);
    assert.deepEqual(fs.readdirSync(modeDir).filter((n) => n.includes('.tmp.')), [], 'no mode temp files remain');
    assert.equal(fs.existsSync(modeLib.modePath(modeEnv)), false, 'mode file not created on failure');
    const root = makeRepo('r45-reg');
    const reg = require('../lib/worktree-registry.js');
    const file = reg.registryPath(root);
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-base', path: path.join(path.dirname(root), 'base-wt'), thread: 't-1', issues: [1], odd: [] }).ok, true);
    const beforeBytes = fs.readFileSync(file);
    let regSawTemp = null;
    fs.writeFileSync = function (f, data, opts) {
      if (typeof f === 'string' && f.includes('.tmp.') && opts && opts.flag === 'wx') {
        regSawTemp = f;
        origWrite.call(fs, f, 'partial');
        const err = new Error('ENOSPC: no space left on device, write');
        err.code = 'ENOSPC';
        throw err;
      }
      return origWrite.call(fs, f, data, opts);
    };
    let regThrew = null;
    try { reg.upsertWorktree(root, { branch: 'feat-next', path: path.join(path.dirname(root), 'next-wt'), thread: 't-1', issues: [1], odd: [] }); } catch (err) { regThrew = err; } finally { fs.writeFileSync = origWrite; }
    assert.ok(regThrew, 'registry write rethrows (never a success)');
    assert.match(String(regThrew && regThrew.message), /ENOSPC|no space/i);
    assert.ok(regSawTemp, 'the registry temp file was attempted');
    assert.equal(fs.existsSync(regSawTemp), false, `registry temp left behind at ${regSawTemp}`);
    assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((n) => n.includes('.tmp.')), [], 'no registry temp files remain');
    assert.deepEqual(fs.readFileSync(file), beforeBytes, 'registry bytes unchanged after failed write');
  });
});

describe('S13: close drops a row whose path reaches the checkout through a symlink', { concurrency: false }, () => {
  test('a hand-written symlink row is dropped with the removed checkout', async () => {
    const root = makeRepo('s13-sym');
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-target', dirT, 'HEAD']);
    const realT = fs.realpathSync(dirT); track(realT);
    // A hand-written row whose path is a SYMLINK to the removed checkout.
    const linkT = path.join(path.dirname(root), `${path.basename(root)}-link`);
    fs.symlinkSync(realT, linkT); track(linkT);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    // Hand-write the second row (a symlink path no upsert would produce).
    const file = reg.registryPath(root);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    const now = new Date().toISOString();
    doc.worktrees.push({ branch: 'feat-alias', path: linkT, thread: 't-9', issues: [1], odd: [], createdAt: now, updatedAt: now });
    fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).worktrees.length, 2, 'fixture holds both rows');

    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: scratchModeEnv().GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-s13'), GENTLE_WORKTREE_THREAD: undefined });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realT, force: true }, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, undefined, `expected success, got: ${text}`);
      assert.deepEqual(text.split('\n'), [
        'removed: feat-target · feat-target',
        'branch kept',
      ]);
      assert.equal(fs.existsSync(realT), false, 'removed checkout gone from disk');
      assert.ok(!livePaths(root).includes(realT), 'removed checkout not listed');
      // Both rows reach the removed checkout: none may survive as stale bookkeeping.
      const after = reg.readRegistry(root);
      assert.equal(after.ok, true);
      assert.deepEqual(after.worktrees, [], `no stale row survives the close: ${JSON.stringify(after.worktrees)}`);
    } finally { restoreEnvCwd(); }
  });
});

describe('S15: a removal that vanishes another checkout names it even on a non-zero exit', { concurrency: false }, () => {
  test('git path: lying remover deletes another checkout and exits non-zero', async () => {
    const root = makeRepo('s15-git');
    const dirV = path.join(path.dirname(root), `${path.basename(root)}-victim`);
    const dirT = path.join(path.dirname(root), `${path.basename(root)}-target`);
    git(root, ['worktree', 'add', '-b', 'feat-victim', dirV, 'HEAD']);
    git(root, ['worktree', 'add', '-b', 'feat-target', dirT, 'HEAD']);
    const realV = fs.realpathSync(dirV); track(realV);
    const realT = fs.realpathSync(dirT); track(realT);
    const reg = require('../lib/worktree-registry.js');
    assert.equal(reg.upsertWorktree(root, { branch: 'feat-target', path: realT, thread: 't-1', issues: [1], odd: [] }).ok, true);
    const beforeBytes = fs.readFileSync(reg.registryPath(root));
    const which = spawnSync('which', ['git'], { encoding: 'utf8' });
    assert.equal(which.status, 0);
    const realGit = which.stdout.trim();
    // A lying remover: deletes the VICTIM instead of the target, then
    // exits non-zero. The close must still name the vanished path.
    const shimDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-s15-gitshim-')));
    fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\ncase \"$*\" in\n  *\"worktree remove\"*) \"${realGit}\" -C \"${root}\" worktree remove --force \"${realV}\" >/dev/null 2>&1; echo \"lying remover failed\" >&2; exit 1;;\n  *) exec \"${realGit}\" \"$@\";;\nesac\n`, { mode: 0o755 });
    const modeEnv = scratchModeEnv();
    const savedPath = process.env.PATH;
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, GENTLE_STATUS_STATE_DIR: modeEnv.GENTLE_STATUS_STATE_DIR, HERDR_BIN_PATH: path.join(os.tmpdir(), 'definitely-not-a-herdr-binary-s15'), GENTLE_WORKTREE_THREAD: undefined, PATH: `${shimDir}${path.delimiter}${savedPath}` });
    try {
      const tools = await loadExtension();
      const result = await tools.get('worktree_close').execute('c1', { path: realT, force: true }, undefined, undefined, makeCtx(root));
      const text = resultText(result);
      assert.equal(result.isError, true, `expected loud failure, got: ${text}`);
      assert.ok(text.includes(realV), `error names the vanished path ${realV}, not just the failure: ${text}`);
      assert.ok(fs.existsSync(realT), 'target checkout survives on disk');
      assert.ok(livePaths(root).includes(realT), 'target still listed');
      assert.deepEqual(fs.readFileSync(reg.registryPath(root)), beforeBytes, 'registry bytes unchanged (entry kept)');
    } finally { restoreEnvCwd(); }
  });
});
