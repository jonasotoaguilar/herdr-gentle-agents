'use strict';
// P2-S3 tests (test-first): creation hooks — lib/worktree-hooks.js plus the
// `worktree_create` wiring in extensions/gentle-worktree-tools.ts.
//
// Every test builds isolated fixtures under os.tmpdir(): a real principal
// repository (`git init` + one commit) plus a real linked worktree (`git
// worktree add -b`). Package managers and `codegraph` are stub shell
// scripts on a private PATH (or the injectable command table) that append
// their argv + cwd to a log file, so no network and no real managers are
// ever touched. Only observable effects are asserted.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');

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

function makePrincipal(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-hooks-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function addLinkedWorktree(principal, branch) {
  const wt = path.join(path.dirname(principal), `${path.basename(principal)}-wt-${branch.replace(/[^a-z0-9]+/gi, '-')}`);
  track(wt);
  git(principal, ['worktree', 'add', '-b', branch, wt, 'HEAD']);
  return fs.realpathSync(wt);
}

// Stub bin dir: every named binary becomes a shell script that logs
// `<bin> <argv...>` + `CWD=<cwd>` to $HOOK_SHIM_LOG and exits 0.
// `failBins` is a set of binary names that exit 1 instead (still logging).
// `special` maps bin -> custom script body for bespoke behaviour (npm ci
// fallback). Missing names are simply not created (simulates absent PATH).
function makeStubBin({ bins = [], failBins = new Set(), special = {} } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hookbin-')));
  const log = path.join(dir, 'calls.log');
  fs.writeFileSync(log, '');
  for (const bin of bins) {
    if (special[bin]) {
      fs.writeFileSync(path.join(dir, bin), special[bin], { mode: 0o755 });
      continue;
    }
    const exitLine = failBins.has(bin) ? 'exit 1' : 'exit 0';
    fs.writeFileSync(
      path.join(dir, bin),
      [
        '#!/bin/sh',
        `printf '%s CWD=%s\\n' "${bin} $*" "$PWD" >> "$HOOK_SHIM_LOG"`,
        exitLine,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
  }
  return { dir, log };
}

function stubLog(log) {
  try {
    return fs.readFileSync(log, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch {
    return [];
  }
}

function hooksLib() {
  return require('../lib/worktree-hooks.js');
}

function runHooks(principal, worktree, opts = {}) {
  const lib = hooksLib();
  return lib.runCreationHooks({
    principalRoot: principal,
    worktreePath: worktree,
    root: principal,
    env: opts.env || process.env,
    timeoutMs: opts.timeoutMs,
    unversionedCandidates: opts.unversionedCandidates,
    installTable: opts.installTable,
    run: opts.run,
    hasBinary: opts.hasBinary,
  });
}

function envWithBin(stub) {
  return { ...process.env, PATH: `${stub.dir}${path.delimiter}${process.env.PATH || ''}`, HOOK_SHIM_LOG: stub.log };
}

function envWithBinIsolated(stub) {
  // PATH contains ONLY the stub dir: anything without a stub reads as missing.
  return { ...process.env, PATH: stub.dir, HOOK_SHIM_LOG: stub.log };
}

function stepByName(result, name) {
  return (result.steps || []).find((s) => s.name === name) || null;
}

// ---------------------------------------------------------------------------
// Defaults are exactly as specified (S8 + slice contract).
// ---------------------------------------------------------------------------

describe('worktree-hooks defaults', () => {
  test('default candidate list and command table match the spec exactly', () => {
    const lib = hooksLib();
    assert.deepEqual(lib.DEFAULT_UNVERSIONED_FILES, [
      '.env',
      '.env.local',
      '.env.development',
      '.env.production',
      '.env.test',
    ]);
    const table = lib.DEFAULT_INSTALL_TABLE;
    const simplified = table.map((e) => ({
      key: e.key,
      markers: e.markers,
      argv: e.argv,
      fallbackArgv: e.fallbackArgv || null,
    }));
    assert.deepEqual(simplified, [
      { key: 'bun', markers: ['bun.lockb', 'bun.lock'], argv: ['bun', 'install'], fallbackArgv: null },
      { key: 'pnpm', markers: ['pnpm-lock.yaml'], argv: ['pnpm', 'install', '--frozen-lockfile'], fallbackArgv: null },
      { key: 'yarn', markers: ['yarn.lock'], argv: ['yarn', 'install', '--frozen-lockfile'], fallbackArgv: null },
      { key: 'npm', markers: ['package-lock.json'], argv: ['npm', 'ci'], fallbackArgv: ['npm', 'install'] },
      { key: 'uv', markers: ['uv.lock', 'pyproject.toml'], argv: ['uv', 'sync'], fallbackArgv: null },
      { key: 'cargo', markers: ['Cargo.toml'], argv: ['cargo', 'fetch'], fallbackArgv: null },
      { key: 'go', markers: ['go.mod'], argv: ['go', 'mod', 'download'], fallbackArgv: null },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Copy unversioned files.
// ---------------------------------------------------------------------------

describe('worktree-hooks: copy unversioned files', () => {
  test('copies present+untracked candidates, refuses tracked / missing-source / existing-target', () => {
    const principal = makePrincipal('copy');
    const worktree = addLinkedWorktree(principal, 'hooks/copy');
    // Untracked source: copied.
    fs.writeFileSync(path.join(principal, '.env'), 'SECRET=1\n');
    // Tracked source: committed, must never be copied.
    fs.writeFileSync(path.join(principal, '.env.local'), 'TRACKED=1\n');
    git(principal, ['add', '.env.local']);
    git(principal, ['commit', '-m', 'track env.local']);
    // Existing target: never overwritten.
    fs.writeFileSync(path.join(principal, '.env.development'), 'SRC=1\n');
    fs.writeFileSync(path.join(worktree, '.env.development'), 'EXISTING=1\n');
    // .env.production / .env.test: missing sources, never fail.
    const stub = makeStubBin({ bins: [] });
    // Keep the system PATH so real `git` resolves for the tracking check;
    // no lockfiles exist so no real managers can run.
    const result = runHooks(principal, worktree, { env: envWithBin(stub) });
    assert.equal(result.ok, true);
    const copy = stepByName(result, 'copy-unversioned');
    assert.ok(copy, 'expected a copy-unversioned step');
    assert.equal(copy.status, 'done');
    // Copied.
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'SECRET=1\n');
    // Tracked file refused.
    assert.equal(fs.existsSync(path.join(worktree, '.env.local')), false);
    // Existing target kept.
    assert.equal(fs.readFileSync(path.join(worktree, '.env.development'), 'utf8'), 'EXISTING=1\n');
    // Missing sources create nothing and fail nothing.
    assert.equal(fs.existsSync(path.join(worktree, '.env.production')), false);
    assert.equal(fs.existsSync(path.join(worktree, '.env.test')), false);
    assert.deepEqual(result.warnings, []);
  });

  test('candidate list is injectable so tests never touch real dotfiles', () => {
    const principal = makePrincipal('copyinject');
    const worktree = addLinkedWorktree(principal, 'hooks/copyinject');
    fs.writeFileSync(path.join(principal, 'custom.secret'), 'X=1\n');
    const stub = makeStubBin({ bins: [] });
    const result = runHooks(principal, worktree, {
      env: envWithBin(stub),
      unversionedCandidates: ['custom.secret'],
    });
    assert.equal(fs.readFileSync(path.join(worktree, 'custom.secret'), 'utf8'), 'X=1\n');
    assert.equal(stepByName(result, 'copy-unversioned').status, 'done');
  });
});

// ---------------------------------------------------------------------------
// Dependency install by detected stack.
// ---------------------------------------------------------------------------

describe('worktree-hooks: dependency install', () => {
  const cases = [
    { marker: 'bun.lockb', bin: 'bun', argv: 'bun install' },
    { marker: 'bun.lock', bin: 'bun', argv: 'bun install' },
    { marker: 'pnpm-lock.yaml', bin: 'pnpm', argv: 'pnpm install --frozen-lockfile' },
    { marker: 'yarn.lock', bin: 'yarn', argv: 'yarn install --frozen-lockfile' },
    { marker: 'package-lock.json', bin: 'npm', argv: 'npm ci' },
    { marker: 'uv.lock', bin: 'uv', argv: 'uv sync' },
    { marker: 'pyproject.toml', bin: 'pyproject-stub', argv: null },
    { marker: 'Cargo.toml', bin: 'cargo', argv: 'cargo fetch' },
    { marker: 'go.mod', bin: 'go', argv: 'go mod download' },
  ];

  for (const { marker, bin, argv } of cases) {
    test(`detects ${marker} and runs the exact argv in the worktree`, () => {
      if (marker === 'pyproject.toml') return; // covered separately below.
      const principal = makePrincipal(`inst-${bin}`);
      const worktree = addLinkedWorktree(principal, `hooks/inst-${bin}`);
      fs.writeFileSync(path.join(worktree, marker), 'marker\n');
      const stub = makeStubBin({ bins: [bin] });
      const result = runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
      const lines = stubLog(stub.log);
      assert.ok(lines.some((l) => l.startsWith(`${argv} CWD=${worktree}`)), `expected "${argv}" in ${JSON.stringify(lines)}`);
      const step = (result.steps || []).find((s) => s.name.includes(bin) || s.name === 'install:npm');
      assert.ok(step, `expected an install step for ${bin}: ${JSON.stringify(result.steps)}`);
      assert.equal(step.status, 'done');
    });
  }

  test('pyproject.toml without uv.lock still runs uv sync', () => {
    const principal = makePrincipal('inst-py');
    const worktree = addLinkedWorktree(principal, 'hooks/inst-py');
    fs.writeFileSync(path.join(worktree, 'pyproject.toml'), '[project]\n');
    const stub = makeStubBin({ bins: ['uv'] });
    const result = runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
    const lines = stubLog(stub.log);
    assert.ok(lines.some((l) => l.startsWith(`uv sync CWD=${worktree}`)), JSON.stringify(lines));
    assert.equal(stepByName(result, 'install:uv').status, 'done');
  });

  test('npm falls back to npm install only when npm ci fails', () => {
    const principal = makePrincipal('npmfb');
    const worktree = addLinkedWorktree(principal, 'hooks/npmfb');
    fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{}\n');
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-npmfb-')));
    const log = path.join(dir, 'calls.log');
    fs.writeFileSync(log, '');
    fs.writeFileSync(
      path.join(dir, 'npm'),
      [
        '#!/bin/sh',
        `printf '%s CWD=%s\\n' "npm $*" "$PWD" >> "${log}"`,
        'if [ "$1" = "ci" ]; then exit 1; fi',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    const result = runHooks(principal, worktree, {
      env: { ...process.env, PATH: dir, HOOK_SHIM_LOG: log },
    });
    const lines = stubLog(log);
    assert.ok(lines.some((l) => l.startsWith('npm ci ')), `ci attempted: ${JSON.stringify(lines)}`);
    assert.ok(lines.some((l) => l.startsWith('npm install ')), `fallback ran: ${JSON.stringify(lines)}`);
    assert.equal(stepByName(result, 'install:npm').status, 'done');
  });

  test('npm success never runs npm install', () => {
    const principal = makePrincipal('npmok');
    const worktree = addLinkedWorktree(principal, 'hooks/npmok');
    fs.writeFileSync(path.join(worktree, 'package-lock.json'), '{}\n');
    const stub = makeStubBin({ bins: ['npm'] });
    runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
    const lines = stubLog(stub.log);
    assert.ok(lines.some((l) => l.startsWith('npm ci ')), JSON.stringify(lines));
    assert.ok(!lines.some((l) => l.startsWith('npm install ')), `no fallback: ${JSON.stringify(lines)}`);
  });

  test('a missing binary is skipped with a reason, never failed', () => {
    const principal = makePrincipal('missingbin');
    const worktree = addLinkedWorktree(principal, 'hooks/missingbin');
    fs.writeFileSync(path.join(worktree, 'Cargo.toml'), '[package]\n');
    const stub = makeStubBin({ bins: [] }); // no cargo stub anywhere on PATH.
    const result = runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
    const step = stepByName(result, 'install:cargo');
    assert.ok(step, JSON.stringify(result.steps));
    assert.equal(step.status, 'skipped');
    assert.ok(String(step.detail || '').length > 0, 'a reason is recorded');
    assert.equal(result.ok, true);
  });

  test('a failing install records failed + warning but remaining steps still run', () => {
    const principal = makePrincipal('failinst');
    const worktree = addLinkedWorktree(principal, 'hooks/failinst');
    fs.writeFileSync(path.join(worktree, 'Cargo.toml'), '[package]\n');
    const stub = makeStubBin({ bins: ['cargo', 'codegraph'], failBins: new Set(['cargo']) });
    const result = runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
    const cargo = stepByName(result, 'install:cargo');
    assert.equal(cargo.status, 'failed');
    assert.ok((result.warnings || []).some((w) => /cargo/i.test(w)), `warning names cargo: ${JSON.stringify(result.warnings)}`);
    // Remaining steps still ran (codegraph init below); S21: there are
    // no symlink steps anymore, so nothing is linked either.
    assert.ok(!(result.steps || []).some((s) => s.name.startsWith('link:')), `no symlink steps: ${JSON.stringify((result.steps || []).map((s) => s.name))}`);
    assert.equal(fs.existsSync(path.join(worktree, 'odd')), false, 'no odd/ is linked into the worktree');
    const lines = stubLog(stub.log);
    assert.ok(lines.some((l) => l.startsWith('codegraph init ')), `codegraph still ran: ${JSON.stringify(lines)}`);
    assert.equal(result.ok, false, 'overall ok reflects the failure');
  });

  test('command table is injectable (no real managers, no network)', () => {
    const principal = makePrincipal('injectcmd');
    const worktree = addLinkedWorktree(principal, 'hooks/injectcmd');
    fs.writeFileSync(path.join(worktree, 'custom.lock'), 'x\n');
    const seen = [];
    const result = runHooks(principal, worktree, {
      env: process.env,
      installTable: [{ key: 'custom', markers: ['custom.lock'], argv: ['custom-bin', 'sync', '--offline'] }],
      run: (bin, args) => {
        seen.push(`${bin} ${args.join(' ')}`);
        return { status: 0, stdout: '', stderr: '', error: null };
      },
      // Only the injected binary resolves; codegraph stays skipped so the
      // recorded argv proves exactly one install ran.
      hasBinary: (bin) => bin === 'custom-bin',
    });
    assert.deepEqual(seen, ['custom-bin sync --offline']);
    assert.equal(stepByName(result, 'install:custom').status, 'done');
  });
});

// ---------------------------------------------------------------------------
// No symlinks (S21: the S8 symlink hook is removed entirely).
// ---------------------------------------------------------------------------

describe('worktree-hooks: no symlinks', () => {
  test('creation creates no symlinks even when the sources exist in the principal', () => {
    const principal = makePrincipal('nosymlink');
    const worktree = addLinkedWorktree(principal, 'hooks/nosymlink');
    fs.mkdirSync(path.join(principal, 'odd'));
    fs.writeFileSync(path.join(principal, 'odd', 'notes.md'), 'hi\n');
    fs.mkdirSync(path.join(principal, '.agents'));
    fs.writeFileSync(path.join(principal, '.agents', 'note.md'), 'hi\n');
    fs.mkdirSync(path.join(principal, '.claude'));
    fs.writeFileSync(path.join(principal, '.claude', 'note.md'), 'hi\n');
    const stub = makeStubBin({ bins: [] });
    const result = runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
    // No symlink step of any kind is reported.
    assert.ok(!(result.steps || []).some((s) => s.name.startsWith('link:')), `no symlink steps: ${JSON.stringify((result.steps || []).map((s) => s.name))}`);
    assert.ok(!(result.steps || []).some((s) => /symlink/i.test(s.name)), 'no step name mentions symlinks');
    // Nothing is linked into the worktree, whatever exists upstream.
    for (const subdir of ['odd', '.agents', '.claude']) {
      assert.equal(fs.existsSync(path.join(worktree, subdir)), false, `${subdir} is not created in the worktree`);
    }
    // The principal sources are left exactly as they were (real dirs).
    assert.equal(fs.lstatSync(path.join(principal, 'odd')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(principal, 'odd', 'notes.md'), 'utf8'), 'hi\n');
    // What remains is unchanged: env copies, stack installs, codegraph.
    assert.ok(stepByName(result, 'copy-unversioned'), 'env-copy step still reported');
    assert.ok(stepByName(result, 'install'), 'install step still reported');
    assert.ok(stepByName(result, 'codegraph-init'), 'codegraph step still reported');
    assert.equal(result.ok, true);
  });

  test('odd/ is NOT created in the principal: the link-only directory is gone', () => {
    const principal = makePrincipal('noodd');
    const worktree = addLinkedWorktree(principal, 'hooks/noodd');
    assert.equal(fs.existsSync(path.join(principal, 'odd')), false);
    const stub = makeStubBin({ bins: [] });
    const result = runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
    assert.equal(fs.existsSync(path.join(principal, 'odd')), false, 'the hooks no longer create odd/ upstream');
    assert.equal(fs.existsSync(path.join(worktree, 'odd')), false, 'and link nothing downstream');
    assert.equal(stepByName(result, 'link:odd'), null, 'no link:odd step is reported');
  });

  test('a worktree-owned .agents/ directory is left untouched', () => {
    const principal = makePrincipal('ownagents');
    const worktree = addLinkedWorktree(principal, 'hooks/ownagents');
    fs.mkdirSync(path.join(principal, '.agents'));
    fs.mkdirSync(path.join(worktree, '.agents'));
    fs.writeFileSync(path.join(worktree, '.agents', 'mine.md'), 'mine\n');
    const stub = makeStubBin({ bins: [] });
    runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
    assert.equal(fs.lstatSync(path.join(worktree, '.agents')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(path.join(worktree, '.agents', 'mine.md'), 'utf8'), 'mine\n');
  });
});

// ---------------------------------------------------------------------------
// codegraph init.
// ---------------------------------------------------------------------------

describe('worktree-hooks: codegraph init', () => {
  test('runs codegraph init in the worktree only when the CLI exists', () => {
    const principal = makePrincipal('cghere');
    const worktree = addLinkedWorktree(principal, 'hooks/cghere');
    const stub = makeStubBin({ bins: ['codegraph'] });
    const result = runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
    const lines = stubLog(stub.log);
    assert.ok(lines.some((l) => l.startsWith(`codegraph init CWD=${worktree}`)), JSON.stringify(lines));
    assert.equal(stepByName(result, 'codegraph-init').status, 'done');
  });

  test('skips with a reason when codegraph is absent, never fatal', () => {
    const principal = makePrincipal('cgmissing');
    const worktree = addLinkedWorktree(principal, 'hooks/cgmissing');
    const stub = makeStubBin({ bins: [] });
    const result = runHooks(principal, worktree, { env: envWithBinIsolated(stub) });
    const step = stepByName(result, 'codegraph-init');
    assert.equal(step.status, 'skipped');
    assert.ok(String(step.detail || '').length > 0);
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Idempotency.
// ---------------------------------------------------------------------------

describe('worktree-hooks: idempotency', () => {
  test('a second run copies nothing new and reports skipped', () => {
    const principal = makePrincipal('idem');
    const worktree = addLinkedWorktree(principal, 'hooks/idem');
    fs.writeFileSync(path.join(principal, '.env'), 'A=1\n');
    const stub = makeStubBin({ bins: [] });
    // Real git must resolve for the tracking check; no lockfiles exist.
    const env = envWithBin(stub);
    const first = runHooks(principal, worktree, { env });
    assert.equal(stepByName(first, 'copy-unversioned').status, 'done');
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'A=1\n');
    // Taint the copy: a second run must not overwrite it.
    fs.writeFileSync(path.join(worktree, '.env'), 'TAINTED=1\n');
    const second = runHooks(principal, worktree, { env });
    assert.equal(fs.readFileSync(path.join(worktree, '.env'), 'utf8'), 'TAINTED=1\n');
    assert.equal(stepByName(second, 'copy-unversioned').status, 'skipped');
    assert.ok(!(second.steps || []).some((s) => s.name.startsWith('link:')), 'no symlink steps on a second run either');
  });
});

// ---------------------------------------------------------------------------
// Extension wiring: worktree_create reports hook steps in details.
// ---------------------------------------------------------------------------

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
  .replace('import { Type } from "@earendil-works/pi-ai";', TYPE_STUB)
  .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', 'const defineTool = (def) => def;');
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

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

function makeHerdrStub() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-herdr-')));
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
      'echo "herdr stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  return { bin, log: path.join(dir, 'herdr-argv.log') };
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
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const pi = { registerTool: (tool) => { tools.set(tool.name, tool); } };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return tools;
}

describe('worktree_create hook wiring', { concurrency: false }, () => {
  test('a created worktree keeps the exact success text and reports hook steps in details', async () => {
    const root = makePrincipal('extok');
    // Unversioned file in the principal is copied into the new worktree.
    fs.writeFileSync(path.join(root, '.env'), 'HOOKED=1\n');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    const hookBin = makeStubBin({ bins: ['codegraph'] });
    const modeDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mode-')));
    const shimLog = path.join(path.dirname(herdr.bin), 'herdr-argv.log');
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeDir,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: shimLog,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
      PATH: `${hookBin.dir}${path.delimiter}${process.env.PATH || ''}`,
      HOOK_SHIM_LOG: hookBin.log,
    });
    try {
      const tools = await loadExtension();
      const tool = tools.get('worktree_create');
      assert.ok(tool, 'expected worktree_create to be registered');
      const ctx = {
        cwd: root,
        hasUI: false,
        sessionManager: { getSessionId: () => 'thread-hooks-1' },
        ui: { confirm: async () => true, notify: () => {} },
      };
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-hooked');
      const result = await tool.execute('call-1', { branch: 'feat/hooked', issues: [35] }, undefined, undefined, ctx);
      assert.equal(result.isError, undefined, `hooks must never fail creation: ${JSON.stringify(result)}`);
      const text = (result.content || []).map((p) => p.text || '').join('\n');
      assert.deepEqual(text.split('\n'), [
        'created: feat-hooked · feat/hooked',
        `path: ${target}`,
        'issues: 35',
      ]);
      // Hook side effects happened: the env copy lands, and S21 means no
      // odd/ symlink is created in the worktree.
      assert.equal(fs.readFileSync(path.join(target, '.env'), 'utf8'), 'HOOKED=1\n');
      assert.equal(fs.existsSync(path.join(target, 'odd')), false, 'creation creates no symlinks');
      // Hook steps + warnings are reported inside details and failures visible.
      assert.ok(result.details && result.details.hooks, 'expected details.hooks');
      assert.ok(Array.isArray(result.details.hooks.steps), 'expected steps array');
      assert.ok(result.details.hooks.steps.length > 0, 'at least one hook step');
      for (const s of result.details.hooks.steps) {
        assert.ok(['done', 'skipped', 'failed'].includes(s.status), `status: ${s.name}`);
      }
      assert.ok(Array.isArray(result.details.hooks.warnings), 'expected warnings array');
    } finally {
      restoreEnv();
    }
  });

  test('a failing install is visible in details but the creation still succeeds', async () => {
    const root = makePrincipal('extfail');
    const herdr = makeHerdrStub();
    const gh = makeGhStub([35]);
    // Cargo always fails; codegraph present so later steps still run.
    const hookBin = makeStubBin({ bins: ['cargo', 'codegraph'], failBins: new Set(['cargo']) });
    // Pre-seed the marker into the principal so the new worktree inherits it
    // through git (worktree add checks out committed files).
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\n');
    git(root, ['add', 'Cargo.toml']);
    git(root, ['commit', '-m', 'add cargo marker']);
    const modeDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-mode-')));
    const shimLog = path.join(path.dirname(herdr.bin), 'herdr-argv.log');
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: modeDir,
      HERDR_BIN_PATH: herdr.bin,
      HERDR_SHIM_LOG: shimLog,
      GH_BIN_PATH: gh,
      GENTLE_WORKTREE_THREAD: undefined,
      PATH: `${hookBin.dir}${path.delimiter}${process.env.PATH || ''}`,
      HOOK_SHIM_LOG: hookBin.log,
    });
    try {
      const tools = await loadExtension();
      const tool = tools.get('worktree_create');
      const ctx = {
        cwd: root,
        hasUI: false,
        sessionManager: { getSessionId: () => 'thread-hooks-2' },
        ui: { confirm: async () => true, notify: () => {} },
      };
      const target = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-hookfail');
      const result = await tool.execute('call-1', { branch: 'feat/hookfail', issues: [35] }, undefined, undefined, ctx);
      assert.equal(result.isError, undefined, 'hooks never turn success into error');
      const text = (result.content || []).map((p) => p.text || '').join('\n');
      assert.deepEqual(text.split('\n'), [
        'created: feat-hookfail · feat/hookfail',
        `path: ${target}`,
        'issues: 35',
      ]);
      const failed = (result.details.hooks.steps || []).filter((s) => s.status === 'failed');
      assert.ok(failed.length >= 1, `a failed step is visible: ${JSON.stringify(result.details.hooks.steps)}`);
      assert.ok((result.details.hooks.warnings || []).length >= 1, 'a warning is recorded');
    } finally {
      restoreEnv();
    }
  });
});

// ---------------------------------------------------------------------------
// S63 freeze proof + async counterpart (T49, test-first RED).
//
// The public creation hook route must never run a long spawnSync on the
// main thread: a slow child has to let Pi input/render/event-loop work
// run WHILE it is still active. The sync contract stays exported
// untouched; the async twin reuses the same detection/format pipeline.
// ---------------------------------------------------------------------------

describe('worktree-hooks: S63 event-loop stall proof (sync blocks)', { concurrency: false }, () => {
  test('a slow sync hook runner blocks timers (the reported freeze)', () => {
    const principal = makePrincipal('syncblock');
    const worktree = addLinkedWorktree(principal, 'hooks/syncblock');
    fs.writeFileSync(path.join(worktree, 'custom.lock'), 'x\n');
    let heartbeats = 0;
    const timer = setInterval(() => { heartbeats += 1; }, 10);
    try {
      const result = hooksLib().runCreationHooks({
        principalRoot: principal,
        worktreePath: worktree,
        root: principal,
        env: process.env,
        unversionedCandidates: [],
        installTable: [{ key: 'slow', markers: ['custom.lock'], argv: ['fake-slow', 'install'] }],
        run: () => {
          const start = Date.now();
          while (Date.now() - start < 200) { /* busy-block the event loop like spawnSync does */ }
          return { status: 0, stdout: '', stderr: '', error: null };
        },
        hasBinary: () => true,
      });
      assert.equal(result.ok, true);
      assert.equal(heartbeats, 0, 'no timer fired while the sync hook blocked the loop');
    } finally {
      clearInterval(timer);
    }
  });
});

describe('worktree-hooks: S63 async counterpart (nonblocking)', { concurrency: false }, () => {
  test('runCreationHooksAsync is exported alongside the sync contract', () => {
    const lib = hooksLib();
    assert.equal(typeof lib.runCreationHooks, 'function', 'sync contract stays');
    assert.equal(typeof lib.runCreationHooksAsync, 'function', 'async twin exists');
  });

  test('timers advance WHILE the slow async hook is still running', async () => {
    const principal = makePrincipal('asyncbeat');
    const worktree = addLinkedWorktree(principal, 'hooks/asyncbeat');
    fs.writeFileSync(path.join(worktree, 'custom.lock'), 'x\n');
    const lib = hooksLib();
    let heartbeats = 0;
    const timer = setInterval(() => { heartbeats += 1; }, 10);
    try {
      const pending = lib.runCreationHooksAsync({
        principalRoot: principal,
        worktreePath: worktree,
        root: principal,
        env: process.env,
        unversionedCandidates: [],
        timeoutMs: 5000,
        installTable: [{ key: 'slow', markers: ['custom.lock'], argv: ['fake-slow', 'install'] }],
        runAsync: async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return { status: 0, stdout: '', stderr: '', error: null };
        },
        hasBinary: () => true,
      });
      // Let the event loop turn while the child is still pending.
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(heartbeats > 0, `heartbeat ran while async hook pending (got ${heartbeats})`);
      const result = await pending;
      assert.equal(result.ok, true);
      assert.ok((result.steps || []).some((s) => s.name === 'install:slow' && s.status === 'done'));
    } finally {
      clearInterval(timer);
    }
  });

  test('async keeps exact step order, warnings and no skipped hooks vs sync', async () => {
    const principal = makePrincipal('asyncparity');
    const worktree = addLinkedWorktree(principal, 'hooks/asyncparity');
    fs.writeFileSync(path.join(worktree, 'custom.lock'), 'x\n');
    const lib = hooksLib();
    const table = [
      { key: 'custom', markers: ['custom.lock'], argv: ['custom-bin', 'sync'] },
    ];
    const syncRes = lib.runCreationHooks({
      principalRoot: principal,
      worktreePath: worktree,
      root: principal,
      env: process.env,
      unversionedCandidates: [],
      installTable: table,
      run: (bin, args) => ({ status: 0, stdout: `${bin}`, stderr: '', error: null }),
      hasBinary: (bin) => bin === 'custom-bin',
    });
    const asyncRes = await lib.runCreationHooksAsync({
      principalRoot: principal,
      worktreePath: worktree,
      root: principal,
      env: process.env,
      unversionedCandidates: [],
      installTable: table,
      runAsync: async (bin) => ({ status: 0, stdout: `${bin}`, stderr: '', error: null }),
      hasBinary: (bin) => bin === 'custom-bin',
    });
    assert.deepEqual(
      (asyncRes.steps || []).map((s) => [s.name, s.status]),
      (syncRes.steps || []).map((s) => [s.name, s.status]),
    );
    assert.deepEqual(asyncRes.warnings, syncRes.warnings);
    assert.equal(asyncRes.ok, syncRes.ok);
    const names = (asyncRes.steps || []).map((s) => s.name);
    assert.ok(names.includes('copy-unversioned'), 'copy step kept');
    assert.ok(names.some((n) => n.startsWith('install:')), 'install step kept');
    assert.ok(names.includes('codegraph-init'), 'codegraph step kept, never silently skipped');
  });

  test('async timeout kills the owned child (no zombie, no hang)', async () => {
    const principal = makePrincipal('asynckill');
    const worktree = addLinkedWorktree(principal, 'hooks/asynckill');
    fs.writeFileSync(path.join(worktree, 'custom.lock'), 'x\n');
    let killed = false;
    const fakeSpawn = () => {
      const handlers = {};
      const child = {
        stdout: { on: () => {} },
        stderr: { on: () => {} },
        on: (ev, fn) => { handlers[ev] = fn; },
        kill: () => { killed = true; if (handlers.close) handlers.close(null); return true; },
      };
      return child;
    };
    const lib = hooksLib();
    const result = await lib.runCreationHooksAsync({
      principalRoot: principal,
      worktreePath: worktree,
      root: principal,
      env: process.env,
      unversionedCandidates: [],
      timeoutMs: 50,
      installTable: [{ key: 'slow', markers: ['custom.lock'], argv: ['fake-slow', 'install'] }],
      hasBinary: () => true,
      spawnFn: fakeSpawn,
    });
    assert.equal(killed, true, 'the timed-out child was killed, not left running');
    const step = (result.steps || []).find((s) => s.name === 'install:slow');
    assert.ok(step && step.status === 'failed', 'timeout surfaces as failed, never silent success');
  });

  test('heartbeat advances during a slow async copy (meaningful, not only a sleep runner)', async () => {
    const principal = makePrincipal('asynccopy');
    const worktree = addLinkedWorktree(principal, 'hooks/asynccopy');
    fs.writeFileSync(path.join(principal, 'custom.secret'), 'X=1\n');
    const lib = hooksLib();
    let heartbeats = 0;
    const timer = setInterval(() => { heartbeats += 1; }, 10);
    try {
      const pending = lib.runCreationHooksAsync({
        principalRoot: principal,
        worktreePath: worktree,
        root: principal,
        env: process.env,
        unversionedCandidates: ['custom.secret'],
        installTable: [],
        runAsync: async (bin, args) => ({ status: 1, stdout: '', stderr: '', error: null }),
        hasBinary: () => false,
        copyAsync: async (src, dest) => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          await fs.promises.copyFile(src, dest);
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.ok(heartbeats > 0, `heartbeat ran while the async copy was pending (got ${heartbeats})`);
      const result = await pending;
      assert.equal(result.ok, true);
      assert.equal(fs.readFileSync(path.join(worktree, 'custom.secret'), 'utf8'), 'X=1\n', 'exact contents preserved');
      assert.equal((result.steps || []).find((s) => s.name === 'copy-unversioned').status, 'done');
    } finally {
      clearInterval(timer);
    }
  });
});

// ---------------------------------------------------------------------------
// S63 follow-up: owned-child cleanup proof (test-first RED).
//
// The effective production runner is `lib/worktree-git.js` runArgvAsync
// (the wizard passes it as runAsync); the hooks default must share it.
// A child that ignores SIGTERM — plus a background grandchild — must be
// gone after the bounded settle, never left writing while the next step
// proceeds. Real POSIX executables only (no Node-fake-only proof); on
// win32 the group-containment branch is documented-unsupported and skipped.
// ---------------------------------------------------------------------------

function writeTermIgnorer(dir, tag) {
  const pidFile = path.join(dir, `${tag}.pid`);
  const gcPidFile = path.join(dir, `${tag}.grandchild.pid`);
  const script = path.join(dir, `${tag}.sh`);
  fs.writeFileSync(script, [
    '#!/bin/sh',
    `echo $$ > "${pidFile}"`,
    `sleep 30 > /dev/null 2>&1 & echo $! > "${gcPidFile}"`,
    `trap '' TERM`,
    'wait',
    '',
  ].join('\n'), { mode: 0o755 });
  return { script, pidFile, gcPidFile };
}

function readPid(p) {
  const n = Number(String(fs.readFileSync(p, 'utf8')).trim());
  assert.ok(Number.isInteger(n) && n > 0, `expected a pid in ${p}`);
  return n;
}

// ESRCH-polled: a freshly KILLed grandchild may need one scheduler turn
// before init reaps it; never an unbounded wait.
async function pidGone(pid, label) {
  for (let i = 0; i < 40; i += 1) {
    let alive = true;
    try {
      process.kill(pid, 0);
      alive = true;
    } catch (err) {
      alive = false;
    }
    if (!alive) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`process still alive after escalation: ${label} pid ${pid}`);
}

describe('worktree-hooks: S63 owned-child cleanup (effective runner)', { concurrency: false }, () => {
  test('git runArgvAsync reaps a SIGTERM-ignoring child AND its grandchild', async () => {
    if (process.platform === 'win32') {
      assert.ok(true, 'documented limitation: process-group containment is POSIX-only; grandchildren may survive on win32');
      return;
    }
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-own-')));
    const { script, pidFile, gcPidFile } = writeTermIgnorer(dir, 'ignorer');
    const gitLib = require('../lib/worktree-git.js');
    const started = Date.now();
    const result = await gitLib.runArgvAsync(script, [], { timeoutMs: 300, killGraceMs: 200 });
    assert.equal(result.status, null, 'settles as a timeout, never a fake success');
    assert.match(String(result.error || ''), /timed out/, 'timeout cause preserved');
    assert.ok(Date.now() - started < 15000, 'bounded well under the 30s child lifetime');
    await pidGone(readPid(pidFile), 'ignoring child');
    await pidGone(readPid(gcPidFile), 'grandchild');
  });

  test('abort settles as aborted and leaves no child behind', async () => {
    if (process.platform === 'win32') {
      assert.ok(true, 'documented limitation: abort group containment is POSIX-only');
      return;
    }
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-abort-')));
    const { script, pidFile } = writeTermIgnorer(dir, 'aborter');
    const gitLib = require('../lib/worktree-git.js');
    const ctl = new AbortController();
    const pending = gitLib.runArgvAsync(script, [], { timeoutMs: 10000, killGraceMs: 200, signal: ctl.signal });
    await new Promise((resolve) => setTimeout(resolve, 200));
    ctl.abort();
    const started = Date.now();
    const result = await pending;
    assert.match(String(result.error || ''), /aborted/i, 'abort cause preserved, never a hang to the 10s bound');
    assert.ok(Date.now() - started < 8000, 'settles on abort, never waits out the timeout');
    await pidGone(readPid(pidFile), 'aborted child');
  });

  test('hooks default runner shares the effective cleanup (real ignorer, no injected spawn)', async () => {
    if (process.platform === 'win32') {
      assert.ok(true, 'documented limitation: process-group containment is POSIX-only');
      return;
    }
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-hookown-')));
    const { script, pidFile } = writeTermIgnorer(dir, 'hookignorer');
    const principal = makePrincipal('hookown');
    const worktree = addLinkedWorktree(principal, 'hooks/hookown');
    fs.writeFileSync(path.join(worktree, 'custom.lock'), 'x\n');
    const lib = hooksLib();
    const result = await lib.runCreationHooksAsync({
      principalRoot: principal,
      worktreePath: worktree,
      root: principal,
      env: process.env,
      unversionedCandidates: [],
      timeoutMs: 300,
      killGraceMs: 200,
      installTable: [{ key: 'slow', markers: ['custom.lock'], argv: [script] }],
      hasBinary: () => true,
    });
    const step = (result.steps || []).find((s) => s.name === 'install:slow');
    assert.ok(step && step.status === 'failed', 'timeout surfaces as failed, never silent success');
    await pidGone(readPid(pidFile), 'hooks ignoring child');
  });
});
