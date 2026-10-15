'use strict';
// Shared git plumbing for the worktree tools (P2-S1 foundation).
//
// Every external process is spawned with a fixed argv array — no shell
// string is ever built, so branch names and paths cannot inject commands.
// `listWorktrees` parses `git worktree list --porcelain -z` itself instead
// of trusting Herdr JSON output.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Run a binary with a fixed argument vector. Never a shell string.
function runArgv(bin, args, opts = {}) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    throw new TypeError('runArgv requires an array of string arguments');
  }
  const result = spawnSync(bin, args, {
    cwd: opts.cwd,
    input: opts.input,
    timeout: opts.timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.error) {
    return { status: null, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error.message };
  }
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: null };
}

// Identify the repository containing repoRoot.
// Returns {root, commonDir, repoName, parentDir}; throws when repoRoot is
// not inside a git repository (a programmer error, never user input).
function repoIdentity(repoRoot) {
  const top = runArgv('git', ['rev-parse', '--show-toplevel'], { cwd: repoRoot });
  if (top.status !== 0) throw new Error(`not a git repository: ${repoRoot}`);
  const root = path.resolve(top.stdout.trim());
  const common = runArgv('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot });
  if (common.status !== 0) throw new Error(`cannot resolve git common dir: ${repoRoot}`);
  const rawCommon = common.stdout.trim();
  // --git-common-dir prints a path relative to the git invocation's own cwd
  // (`.git` at the repository root, `../.git` from one level below), and
  // that cwd may be a symlinked spelling of the real directory. Resolve
  // against its realpath: a lexical base turns `../.git` seen through a
  // symlink into the symlink's parent, and the toplevel is the wrong base
  // outright for a subdirectory (`../.git` there names the repo's parent).
  let base = repoRoot;
  try {
    base = fs.realpathSync(repoRoot);
  } catch {
    // git already ran, so an unreadable cwd keeps the lexical base.
  }
  const commonDir = path.isAbsolute(rawCommon) ? path.normalize(rawCommon) : path.resolve(base, rawCommon);
  return { root, commonDir, repoName: path.basename(root), parentDir: path.dirname(root) };
}

// Flatten a branch name into a single path component, exactly like the
// AGENTS.md rule: lowercase, runs of non-alphanumerics collapse to one
// `-`, leading/trailing dashes trimmed, `worktree` when nothing survives.
function slugifyBranch(branch) {
  const slug = String(branch).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug === '' ? 'worktree' : slug;
}

// Absolute target path for a branch: <repo-parent>/<repo-name>-worktrees/<slug>.
function worktreePath(repoRoot, branch) {
  const identity = repoIdentity(repoRoot);
  return path.join(identity.parentDir, `${identity.repoName}-worktrees`, slugifyBranch(branch));
}

// Unicode bidi control marks that can visually reorder a branch name.
const BIDI_RE = /[\u200E\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u2028\u2029]/;

// Validate a branch name. Uses `git check-ref-format --branch` as the
// authority, after rejecting empty names, a leading `-`, whitespace,
// control characters and Unicode bidi marks up front (fail closed).
function validateBranch(name) {
  if (typeof name !== 'string' || name === '') return { ok: false, reason: 'branch name is empty' };
  if (name.startsWith('-')) return { ok: false, reason: 'branch name must not start with `-`' };
  if (/\s/.test(name)) return { ok: false, reason: 'branch name must not contain whitespace' };
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(name)) return { ok: false, reason: 'branch name must not contain control characters' };
  if (BIDI_RE.test(name)) return { ok: false, reason: 'branch name must not contain Unicode bidi marks' };
  const checked = runArgv('git', ['check-ref-format', '--branch', name], {});
  if (checked.status !== 0) return { ok: false, reason: `invalid branch name: ${name}` };
  return { ok: true, reason: null };
}

// List every checkout from `git worktree list --porcelain -z`.
// Returns [{path, branch, head, detached, bare}]; branch is null when detached.
function listWorktrees(repoRoot) {
  const listed = runArgv('git', ['worktree', 'list', '--porcelain', '-z'], { cwd: repoRoot });
  if (listed.status !== 0) throw new Error(`git worktree list failed: ${(listed.stderr || '').trim()}`);
  // With -z every line is NUL-terminated; a blank token ends a record.
  const tokens = listed.stdout.split('\0');
  const entries = [];
  let current = null;
  const flush = () => {
    if (current && current.path) entries.push(current);
    current = null;
  };
  for (const token of tokens) {
    if (token === '') {
      flush();
      continue;
    }
    if (token.startsWith('worktree ')) {
      flush();
      current = { path: token.slice('worktree '.length), branch: null, head: null, detached: false, bare: false };
    } else if (current && token.startsWith('HEAD ')) {
      current.head = token.slice('HEAD '.length);
    } else if (current && token.startsWith('branch ')) {
      const ref = token.slice('branch '.length);
      current.branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
    } else if (current && token === 'detached') {
      current.detached = true;
    } else if (current && token === 'bare') {
      current.bare = true;
    }
    // `locked` / `prunable` tokens carry no identity and are ignored.
  }
  flush();
  return entries;
}

function isInsideOrEqual(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// True when the resolved target is the path of, or inside, any existing
// checkout — or inside the shared git common dir. Used to refuse targets
// that would nest checkouts or clobber repository metadata. Only a LIVE
// checkout blocks: a git record whose path no longer exists as a
// directory never refuses a create (the create path prunes such stale
// records first). Relative listing paths resolve against the repository
// root, never the process cwd.
function isPathInAnyCheckout(repoRoot, target) {
  const identity = repoIdentity(repoRoot);
  const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(identity.root, target);
  if (isInsideOrEqual(identity.commonDir, resolved)) return true;
  // Through the export so tests can simulate listings git would never
  // emit (notably relative paths); production behavior is unchanged.
  // One liveness predicate (exists AND is-a-directory, never the process
  // cwd) plus realpath identity: a symlink spelling of a checkout is the
  // same checkout, so inside-verdicts compare both spellings and realpaths
  // (resolving non-existent tails through their parents, so a not-yet-
  // created subpath through a symlink still matches).
  const entries = module.exports.listWorktrees(repoRoot);
  const realish = (p) => {
    try {
      return fs.realpathSync(p);
    } catch {
      // Walk up to the nearest existing ancestor, resolve it, re-append.
      let cur = p;
      const tail = [];
      for (let i = 0; i < 32; i += 1) {
        const parent = path.dirname(cur);
        if (parent === cur) break;
        tail.unshift(path.basename(cur));
        cur = parent;
        try {
          return path.join(fs.realpathSync(cur), ...tail);
        } catch {
          continue;
        }
      }
      return null;
    }
  };
  const resolvedReal = realish(resolved);
  for (const entry of entries) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const base = path.isAbsolute(entry.path) ? path.resolve(entry.path) : path.resolve(identity.root, entry.path);
    let live = false;
    try {
      live = fs.statSync(base).isDirectory();
    } catch {
      live = false;
    }
    if (!live) continue;
    if (isInsideOrEqual(base, resolved)) return true;
    // Realpath identity: the same checkout reached through a symlink must
    // give the same verdict as its real spelling.
    const baseReal = realish(base);
    if (baseReal !== null && resolvedReal !== null && isInsideOrEqual(baseReal, resolvedReal)) return true;
    if (baseReal !== null && baseReal === resolved) return true;
    if (resolvedReal !== null && resolvedReal === base) return true;
  }
  return false;
}

// Closed union of herdr worktree operations with a per-operation flag
// allowlist, mirroring the installed CLI surface (`herdr worktree create
// --help`, `herdr worktree remove --help`, herdr 0.9.3). Every value
// travels as its own argv element because herdr rejects `--flag=value`.
// Unknown operations or flags throw. `--trust-repository` is deliberately
// absent: trusting a repository is a human decision these tools never take.
const HERDR_ALLOWLIST = {
  list: ['cwd'],
  create: ['cwd', 'branch', 'base', 'path', 'label', 'focus'],
  open: ['cwd', 'path', 'branch', 'focus'],
  remove: ['workspace', 'force'],
};

const HERDR_FLAG = {
  cwd: '--cwd',
  workspace: '--workspace',
  branch: '--branch',
  base: '--base',
  path: '--path',
  label: '--label',
  focus: '--focus',
  force: '--force',
};

function herdrArgv(operation, params = {}) {
  const allowed = HERDR_ALLOWLIST[operation];
  if (!allowed) throw new Error(`unknown herdr operation: ${operation}`);
  const argv = ['worktree', operation];
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new Error(`flag not allowed for herdr ${operation}: ${key}`);
    const value = params[key];
    if (typeof value === 'boolean') {
      if (value) argv.push(HERDR_FLAG[key]);
      continue;
    }
    if (typeof value !== 'string' || value === '') throw new Error(`invalid value for herdr ${operation} ${key}`);
    argv.push(HERDR_FLAG[key], value);
  }
  return argv;
}

module.exports = {
  runArgv,
  repoIdentity,
  slugifyBranch,
  worktreePath,
  validateBranch,
  listWorktrees,
  isPathInAnyCheckout,
  herdrArgv,
};
