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
  DEFAULT_UNVERSIONED_FILES,
  DEFAULT_INSTALL_TABLE,
  DEFAULT_TIMEOUT_MS,
};
