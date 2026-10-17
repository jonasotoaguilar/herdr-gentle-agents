'use strict';
// Creation hooks for the worktree tools (P2-S3).
//
// `runCreationHooks({principalRoot, worktreePath, ...})` runs, in order:
//   (a) copy unversioned files from the principal checkout,
//   (b) dependency install by lockfile-detected stack,
//   (c) `codegraph init` when the CLI is available.
//
// S21: creation creates NO symlinks — the S8 `odd/`/`.agents/`/`.claude/`
// link stage (and the `odd/`-in-principal creation that existed only to
// be linked) is removed. A worktree reaches `odd/` only when the
// repository tracks it: a tracked `odd/` is a real directory there too, and
// the odd capture records both spellings. An untracked `odd/` is reachable
// in the principal alone. Closing a tool-created checkout still needs
// `force` wherever env copies leave untracked files.
//
// Every external process is spawned with a fixed argv array (never a shell
// string) and a bounded timeout. A missing binary is a `skipped` step with
// a recorded reason, never a failure. A non-zero exit is a `failed` step
// plus a warning, and never aborts the remaining steps. Missing sources
// never fail the hook.
//
// The candidate list (`unversionedCandidates`) and the command table
// (`installTable`) are injectable so tests never touch the network and
// never need real package managers. Defaults match S8 exactly. The `run`
// and `hasBinary` hooks are injectable for the same reason.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Shared pure plan helpers (S63): the sync and async hook runners use the
// SAME detection/format/classification pipeline so the two implementations
// cannot drift. Detection stays sync lstat (constant-time, millisecond
// scale, never a 120s subprocess); only subprocesses and file copies go
// async in the async twin.

const DEFAULT_UNVERSIONED_FILES = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.test',
];

// Order is the execution order when several markers are present (monorepo:
// every detected stack runs). `markers` is OR: any present file triggers
// the entry. `fallbackArgv` runs only when `argv` exits non-zero.
const DEFAULT_INSTALL_TABLE = [
  { key: 'bun', markers: ['bun.lockb', 'bun.lock'], argv: ['bun', 'install'] },
  { key: 'pnpm', markers: ['pnpm-lock.yaml'], argv: ['pnpm', 'install', '--frozen-lockfile'] },
  { key: 'yarn', markers: ['yarn.lock'], argv: ['yarn', 'install', '--frozen-lockfile'] },
  { key: 'npm', markers: ['package-lock.json'], argv: ['npm', 'ci'], fallbackArgv: ['npm', 'install'] },
  { key: 'uv', markers: ['uv.lock', 'pyproject.toml'], argv: ['uv', 'sync'] },
  { key: 'cargo', markers: ['Cargo.toml'], argv: ['cargo', 'fetch'] },
  { key: 'go', markers: ['go.mod'], argv: ['go', 'mod', 'download'] },
];

const DEFAULT_TIMEOUT_MS = 120000;

function resolvePrincipal(opts) {
  return opts.principalRoot || opts.root || opts.principal || null;
}

function resolveWorktree(opts) {
  return opts.worktreePath || opts.worktreeRoot || opts.path || null;
}

// True when the path exists, including a dangling symlink (lstat, not stat).
function pathExists(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

// Default PATH lookup: search each PATH entry for an executable file.
// Never spawns anything, never a shell string.
function defaultHasBinary(bin, env) {
  if (typeof bin !== 'string' || bin === '') return false;
  if (bin.includes(path.sep) || bin.includes('/')) {
    try {
      fs.accessSync(bin, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
  const rawPath = (env || {}).PATH || (env || {}).Path || '';
  const dirs = String(rawPath).split(path.delimiter).filter((d) => d.length > 0);
  for (const dir of dirs) {
    try {
      fs.accessSync(path.join(dir, bin), fs.constants.X_OK);
      return true;
    } catch {
      // Not here; keep searching.
    }
  }
  return false;
}

// Default runner: fixed argv via spawnSync, bounded timeout, no shell.
function defaultRun(bin, args, opts = {}) {
  const result = spawnSync(bin, args, {
    cwd: opts.cwd,
    env: opts.env,
    timeout: opts.timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    return {
      status: result.status ?? null,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
      error: String((result.error && result.error.message) || result.error),
    };
  }
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: null,
  };
}

// True when <candidate> (relative, e.g. `.env`) is tracked by git in the
// principal checkout: `git ls-files --error-unmatch` exits 0. Fixed argv,
// bounded timeout, never a shell string.
function isTrackedByGit(run, principalRoot, candidate, timeoutMs, env) {
  let res;
  try {
    res = run('git', ['ls-files', '--error-unmatch', candidate], {
      cwd: principalRoot,
      timeoutMs,
      env,
    });
  } catch {
    // A runner failure must never mark a file untracked (fail closed
    // would copy a tracked file); treat as tracked so the copy is refused.
    return true;
  }
  if (!res) return true;
  if (res.status === 0) return true;
  // A spawn-level failure (missing git, timeout) fails closed: refuse
  // the copy rather than risk copying a tracked file.
  if (res.status === null || res.status === undefined || res.error) return true;
  return false;
}

// --- Shared pure pipeline (S63): sync + async runners use these ---
// Detection: which install entries fire for the worktree (markers OR).
// Sync lstat only (constant-time); never a subprocess, never the loop blocker.
function selectInstallEntries(worktreePath, table) {
  const list = Array.isArray(table) ? table : DEFAULT_INSTALL_TABLE;
  return list.filter((entry) => Array.isArray(entry.markers)
    && entry.markers.some((marker) => pathExists(path.join(worktreePath, marker))));
}

// Split an install entry argv into fixed bin + args (never a shell string).
// Returns null when the entry carries no command.
function installEntryArgv(entry) {
  const argv = (entry && entry.argv) || [];
  const bin = argv[0];
  if (typeof bin !== 'string' || bin === '') return null;
  return { bin, args: argv.slice(1) };
}

// Classify a finished run: { ok } when status 0, else a short cause.
function runCause(res) {
  if (res && res.status === 0) return null;
  if (res && (res.stderr || res.error)) return String(res.stderr || res.error).trim();
  const code = res && res.status !== null && res.status !== undefined ? res.status : 'non-zero';
  return `exit ${code}`;
}

// Copy outcome formatting shared by both runners.
function formatCopyOutcome(copied, skipped, copyError) {
  if (copyError && copied.length === 0) {
    const message = `copy unversioned files failed: ${(copyError && copyError.message) || copyError}`;
    return { status: 'failed', detail: `copied none; ${skipped.join('; ')}`, warning: message };
  }
  const warning = copyError
    ? `copy unversioned files partially failed: ${(copyError && copyError.message) || copyError}`
    : null;
  const detail = copied.length > 0
    ? `copied ${copied.join(', ')}${skipped.length > 0 ? `; skipped ${skipped.join('; ')}` : ''}`
    : `copied none; ${skipped.join('; ') || 'nothing to copy'}`;
  return { status: copied.length > 0 ? 'done' : 'skipped', detail, warning };
}

// Default async runner: SHARED with `lib/worktree-git.js` runArgvAsync
// (the wizard's effective production runner) — one ownership
// implementation, never two divergent kill paths. Fixed argv, never a
// shell string, never the main-thread blocker; bounded timeout with
// SIGTERM-then-SIGKILL escalation and owned-group reaping (POSIX), plus
// AbortSignal support. Forwards cwd/env/spawnFn/signal/timeoutMs/killGraceMs
// and resolves the same `{status, stdout, stderr, error}` shape.
function defaultRunAsync(bin, args, opts = {}) {
  let gitAsync = null;
  try {
    gitAsync = require('./worktree-git.js').runArgvAsync;
  } catch {
    gitAsync = null;
  }
  if (typeof gitAsync === 'function') {
    return gitAsync(bin, args, opts);
  }
  return Promise.resolve({
    status: null,
    stdout: '',
    stderr: '',
    error: 'async runner unavailable: lib/worktree-git.js could not be loaded',
  });
}

// Async existence via lstat (dangling symlink counts as exists, like sync).
async function pathExistsAsync(p, existsAsync) {
  if (typeof existsAsync === 'function') return !!(await existsAsync(p));
  try {
    await fs.promises.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function copyFileAsyncDefault(src, dest, copyAsync) {
  if (typeof copyAsync === 'function') return copyAsync(src, dest);
  return fs.promises.copyFile(src, dest);
}

// Async tracked check: same fail-closed classification as the sync twin.
async function isTrackedByGitAsync(runAsync, principalRoot, candidate, timeoutMs, env) {
  let res;
  try {
    res = await runAsync('git', ['ls-files', '--error-unmatch', candidate], { cwd: principalRoot, timeoutMs, env });
  } catch {
    return true;
  }
  if (!res) return true;
  if (res.status === 0) return true;
  if (res.status === null || res.status === undefined || res.error) return true;
  return false;
}

// Async counterpart of runCreationHooks (S63): same order, same steps,
// same warnings, same fail-closed gates — but subprocesses run on a
// spawned child with a killing timeout and copies run on async fs, so
// Pi input/render/event-loop work advances WHILE hooks are pending.
// Never detaches orphan jobs: every child is owned until settle (close /
// error / timeout / abort kills it). Never skips installs/codegraph as
// a speed fix; no extra retries beyond the npm fallback. Fixed argv only.
async function runCreationHooksAsync(opts = {}) {
  const principalRoot = resolvePrincipal(opts);
  const worktreePath = resolveWorktree(opts);
  if (typeof principalRoot !== 'string' || principalRoot === '') {
    throw new TypeError('runCreationHooksAsync requires principalRoot (or root)');
  }
  if (typeof worktreePath !== 'string' || worktreePath === '') {
    throw new TypeError('runCreationHooksAsync requires worktreePath');
  }
  const env = opts.env || process.env;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const signal = opts.signal || null;
  const candidates = Array.isArray(opts.unversionedCandidates)
    ? opts.unversionedCandidates
    : DEFAULT_UNVERSIONED_FILES;
  const table = Array.isArray(opts.installTable) ? opts.installTable : DEFAULT_INSTALL_TABLE;
  const spawnFn = opts.spawnFn;
  const killGraceMs = opts.killGraceMs;
  // Preferred async runner; else await a promise-returning `run`; else the
  // owned default that kills on timeout/abort. A purely sync blocking `run`
  // must not be passed here (it would re-block the loop).
  let runAsync;
  if (typeof opts.runAsync === 'function') {
    runAsync = (bin, args, o) => opts.runAsync(bin, args, o);
  } else if (typeof opts.run === 'function') {
    runAsync = (bin, args, o) => {
      const out = opts.run(bin, args, o);
      if (out && typeof out.then === 'function') return out;
      return Promise.resolve(out);
    };
  } else {
    runAsync = (bin, args, o) => defaultRunAsync(bin, args, { ...o, env, spawnFn, signal });
  }
  const defaultedRunAsync = runAsync;
  const runWithDefaults = (bin, args, o) => defaultedRunAsync(bin, args, { ...o, env, spawnFn, signal, killGraceMs });
  const hasBinary = typeof opts.hasBinary === 'function'
    ? (bin) => opts.hasBinary(bin, env)
    : (bin) => defaultHasBinary(bin, env);
  const existsAsync = opts.existsAsync;
  const copyAsync = opts.copyAsync;

  const steps = [];
  const warnings = [];
  let failed = false;
  const addStep = (name, status, detail) => {
    steps.push({ name, status, detail: String(detail || '') });
    if (status === 'failed') failed = true;
  };

  // (a) Copy unversioned files on async fs (heartbeat advances mid-copy).
  {
    const copied = [];
    const skipped = [];
    let copyError = null;
    for (const candidate of candidates) {
      const src = path.join(principalRoot, candidate);
      const dest = path.join(worktreePath, candidate);
      if (!(await pathExistsAsync(src, existsAsync))) {
        skipped.push(`${candidate}: missing source`);
        continue;
      }
      if (await pathExistsAsync(dest, existsAsync)) {
        skipped.push(`${candidate}: target exists`);
        continue;
      }
      if (await isTrackedByGitAsync(runWithDefaults, principalRoot, candidate, timeoutMs, env)) {
        skipped.push(`${candidate}: tracked`);
        continue;
      }
      try {
        await copyFileAsyncDefault(src, dest, copyAsync);
        copied.push(candidate);
      } catch (err) {
        copyError = err;
        skipped.push(`${candidate}: copy failed`);
      }
    }
    const outcome = formatCopyOutcome(copied, skipped, copyError);
    if (outcome.warning) warnings.push(outcome.warning);
    addStep('copy-unversioned', outcome.status, outcome.detail);
  }

  // (b) Dependency install by detected stack (shared detection pipeline).
  {
    const detected = selectInstallEntries(worktreePath, table);
    if (detected.length === 0) {
      addStep('install', 'skipped', 'no lockfile detected');
    }
    for (const entry of detected) {
      const name = `install:${entry.key}`;
      const parsed = installEntryArgv(entry);
      if (!parsed) {
        addStep(name, 'skipped', 'no command configured');
        continue;
      }
      const { bin, args } = parsed;
      if (!hasBinary(bin)) {
        addStep(name, 'skipped', `${bin} not on PATH`);
        continue;
      }
      let res;
      try {
        res = await runWithDefaults(bin, args, { cwd: worktreePath, timeoutMs, env });
      } catch (err) {
        res = { status: null, stdout: '', stderr: '', error: String((err && err.message) || err) };
      }
      if (res && res.status === 0) {
        addStep(name, 'done', `${bin} ${args.join(' ')} exited 0`);
        continue;
      }
      if (Array.isArray(entry.fallbackArgv) && entry.fallbackArgv.length > 0) {
        const fbBin = entry.fallbackArgv[0];
        const fbArgs = entry.fallbackArgv.slice(1);
        if (!hasBinary(fbBin)) {
          const message = `${name}: ${bin} ${args.join(' ')} failed and fallback ${fbBin} not on PATH`;
          warnings.push(message);
          addStep(name, 'failed', message);
          continue;
        }
        let fb;
        try {
          fb = await runWithDefaults(fbBin, fbArgs, { cwd: worktreePath, timeoutMs, env });
        } catch (err) {
          fb = { status: null, stdout: '', stderr: '', error: String((err && err.message) || err) };
        }
        if (fb && fb.status === 0) {
          addStep(name, 'done', `${bin} ${args.join(' ')} failed, ${fbBin} ${fbArgs.join(' ')} exited 0`);
          continue;
        }
        const message = `${name}: ${bin} ${args.join(' ')} failed (${((res && (res.stderr || res.error)) || 'exit non-zero').trim()}), `
          + `fallback ${fbBin} ${fbArgs.join(' ')} failed (${((fb && (fb.stderr || fb.error)) || 'exit non-zero').trim()})`;
        warnings.push(message);
        addStep(name, 'failed', message);
        continue;
      }
      const cause = runCause(res);
      const message = `${name}: ${bin} ${args.join(' ')} failed (${cause})`;
      warnings.push(message);
      addStep(name, 'failed', message);
    }
  }

  // (c) codegraph init when the CLI is available.
  {
    if (!hasBinary('codegraph')) {
      addStep('codegraph-init', 'skipped', 'codegraph not on PATH');
    } else {
      let res;
      try {
        res = await runWithDefaults('codegraph', ['init'], { cwd: worktreePath, timeoutMs, env });
      } catch (err) {
        res = { status: null, stdout: '', stderr: '', error: String((err && err.message) || err) };
      }
      if (res && res.status === 0) {
        addStep('codegraph-init', 'done', 'codegraph init exited 0');
      } else {
        const cause = runCause(res);
        const message = `codegraph-init: codegraph init failed (${cause})`;
        warnings.push(message);
        addStep('codegraph-init', 'failed', message);
      }
    }
  }

  return { ok: !failed, steps, warnings };
}

function runCreationHooks(opts = {}) {
  const principalRoot = resolvePrincipal(opts);
  const worktreePath = resolveWorktree(opts);
  if (typeof principalRoot !== 'string' || principalRoot === '') {
    throw new TypeError('runCreationHooks requires principalRoot (or root)');
  }
  if (typeof worktreePath !== 'string' || worktreePath === '') {
    throw new TypeError('runCreationHooks requires worktreePath');
  }
  const env = opts.env || process.env;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const candidates = Array.isArray(opts.unversionedCandidates)
    ? opts.unversionedCandidates
    : DEFAULT_UNVERSIONED_FILES;
  const table = Array.isArray(opts.installTable) ? opts.installTable : DEFAULT_INSTALL_TABLE;
  const run = typeof opts.run === 'function'
    ? (bin, args, o) => opts.run(bin, args, o)
    : (bin, args, o) => defaultRun(bin, args, { ...o, env });
  const hasBinary = typeof opts.hasBinary === 'function'
    ? (bin) => opts.hasBinary(bin, env)
    : (bin) => defaultHasBinary(bin, env);

  const steps = [];
  const warnings = [];
  let failed = false;
  const addStep = (name, status, detail) => {
    steps.push({ name, status, detail: String(detail || '') });
    if (status === 'failed') failed = true;
  };

  // (a) Copy unversioned files. Each candidate is copied from the
  // principal checkout ONLY when it exists there, is NOT tracked by git,
  // and does NOT already exist in the worktree. Never overwrite, never
  // copy a tracked file, never fail for a missing source.
  {
    const copied = [];
    const skipped = [];
    let copyError = null;
    for (const candidate of candidates) {
      const src = path.join(principalRoot, candidate);
      const dest = path.join(worktreePath, candidate);
      if (!pathExists(src)) {
        skipped.push(`${candidate}: missing source`);
        continue;
      }
      if (pathExists(dest)) {
        skipped.push(`${candidate}: target exists`);
        continue;
      }
      if (isTrackedByGit(run, principalRoot, candidate, timeoutMs, env)) {
        skipped.push(`${candidate}: tracked`);
        continue;
      }
      try {
        fs.copyFileSync(src, dest);
        copied.push(candidate);
      } catch (err) {
        copyError = err;
        skipped.push(`${candidate}: copy failed`);
      }
    }
    if (copyError && copied.length === 0 && skipped.length > 0 && copied.length === 0) {
      // A copy error with nothing copied is a failed step plus a warning,
      // but never aborts the remaining hooks.
      const message = `copy unversioned files failed: ${(copyError && copyError.message) || copyError}`;
      warnings.push(message);
      addStep('copy-unversioned', 'failed', `copied none; ${skipped.join('; ')}`);
    } else {
      if (copyError) warnings.push(`copy unversioned files partially failed: ${(copyError && copyError.message) || copyError}`);
      addStep(
        'copy-unversioned',
        copied.length > 0 ? 'done' : 'skipped',
        copied.length > 0
          ? `copied ${copied.join(', ')}${skipped.length > 0 ? `; skipped ${skipped.join('; ')}` : ''}`
          : `copied none; ${skipped.join('; ') || 'nothing to copy'}`,
      );
    }
  }

  // (b) Dependency install by detected stack. Every detected stack runs in
  // table order. A missing binary is skipped; a non-zero exit is failed
  // plus a warning and never aborts the remaining steps. `npm ci` falls
  // back to `npm install` only when `ci` fails.
  {
    const detected = table.filter((entry) => Array.isArray(entry.markers)
      && entry.markers.some((marker) => pathExists(path.join(worktreePath, marker))));
    if (detected.length === 0) {
      addStep('install', 'skipped', 'no lockfile detected');
    }
    for (const entry of detected) {
      const name = `install:${entry.key}`;
      const argv = entry.argv || [];
      const bin = argv[0];
      const args = argv.slice(1);
      if (typeof bin !== 'string' || bin === '') {
        addStep(name, 'skipped', 'no command configured');
        continue;
      }
      if (!hasBinary(bin)) {
        addStep(name, 'skipped', `${bin} not on PATH`);
        continue;
      }
      let res;
      try {
        res = run(bin, args, { cwd: worktreePath, timeoutMs, env });
      } catch (err) {
        res = { status: null, stdout: '', stderr: '', error: String((err && err.message) || err) };
      }
      if (res && res.status === 0) {
        addStep(name, 'done', `${bin} ${args.join(' ')} exited 0`);
        continue;
      }
      // Non-zero: npm alone gets exactly one fallback to `npm install`.
      if (Array.isArray(entry.fallbackArgv) && entry.fallbackArgv.length > 0) {
        const fbBin = entry.fallbackArgv[0];
        const fbArgs = entry.fallbackArgv.slice(1);
        if (!hasBinary(fbBin)) {
          const message = `${name}: ${bin} ${args.join(' ')} failed and fallback ${fbBin} not on PATH`;
          warnings.push(message);
          addStep(name, 'failed', message);
          continue;
        }
        let fb;
        try {
          fb = run(fbBin, fbArgs, { cwd: worktreePath, timeoutMs, env });
        } catch (err) {
          fb = { status: null, stdout: '', stderr: '', error: String((err && err.message) || err) };
        }
        if (fb && fb.status === 0) {
          addStep(name, 'done', `${bin} ${args.join(' ')} failed, ${fbBin} ${fbArgs.join(' ')} exited 0`);
          continue;
        }
        const message = `${name}: ${bin} ${args.join(' ')} failed (${((res && (res.stderr || res.error)) || 'exit non-zero').trim()}), `
          + `fallback ${fbBin} ${fbArgs.join(' ')} failed (${((fb && (fb.stderr || fb.error)) || 'exit non-zero').trim()})`;
        warnings.push(message);
        addStep(name, 'failed', message);
        continue;
      }
      const cause = res && (res.stderr || res.error)
        ? String(res.stderr || res.error).trim()
        : `exit ${res && res.status !== null && res.status !== undefined ? res.status : 'non-zero'}`;
      const message = `${name}: ${bin} ${args.join(' ')} failed (${cause})`;
      warnings.push(message);
      addStep(name, 'failed', message);
    }
  }

  // (c) codegraph init when the CLI is available. Skipped with a reason
  // when absent; a non-zero exit is failed plus a warning. Never fatal.
  {
    if (!hasBinary('codegraph')) {
      addStep('codegraph-init', 'skipped', 'codegraph not on PATH');
    } else {
      let res;
      try {
        res = run('codegraph', ['init'], { cwd: worktreePath, timeoutMs, env });
      } catch (err) {
        res = { status: null, stdout: '', stderr: '', error: String((err && err.message) || err) };
      }
      if (res && res.status === 0) {
        addStep('codegraph-init', 'done', 'codegraph init exited 0');
      } else {
        const cause = res && (res.stderr || res.error)
          ? String(res.stderr || res.error).trim()
          : `exit ${res && res.status !== null && res.status !== undefined ? res.status : 'non-zero'}`;
        const message = `codegraph-init: codegraph init failed (${cause})`;
        warnings.push(message);
        addStep('codegraph-init', 'failed', message);
      }
    }
  }

  return { ok: !failed, steps, warnings };
}

module.exports = {
  runCreationHooks,
  runCreationHooksAsync,
  DEFAULT_UNVERSIONED_FILES,
  DEFAULT_INSTALL_TABLE,
  DEFAULT_TIMEOUT_MS,
};
