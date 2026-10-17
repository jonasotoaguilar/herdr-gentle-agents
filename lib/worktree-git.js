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

// Async twin of `runArgv` for interactive paths: the same fixed argv
// (never a shell string) over `spawn`, with a bounded timeout that
// reaps the owned child instead of blocking the host event loop. Resolves to
// the same `{status, stdout, stderr, error}` shape, so callers can
// `await` either runner interchangeably. `timeoutMs` defaults to
// 120000 like the longest creation pole; pass a smaller bound for
// network CLIs.
//
// Ownership (S63 follow-up): on timeout — or on `opts.signal` abort — the
// runner SIGTERMs the owned process, waits a bounded `killGraceMs` for
// the `close` event, then SIGKILLs and waits the same bound again before
// settling, so settlement never precedes cleanup and the await never hangs
// on a child that ignores signals. On POSIX the child spawns `detached`
// (its own process group, pgid === pid) and the signals go to the whole
// group, so background grandchildren die with it; only the owned pgid is
// ever signaled, never an unrelated process. On win32 group containment is
// unsupported (negative-pid signals do not exist there): only the owned
// child handle is signaled with the same TERM-then-KILL escalation, and a
// grandchild that outlives its parent may survive — that platform limit is
// stated here, not hidden. `opts.env` rides through to spawn; `opts.signal`
// (AbortSignal) produces `{error: 'aborted'}`; without a signal there is no
// cancellation source and none is claimed.
const KILL_GRACE_MS_DEFAULT = 2000;

// Signal ONLY the owned process (or its owned group on POSIX). The group
// path requires the pgid this runner created (child.pid); anything
// unexpected falls back to the direct child handle. Never throws, never
// touches an unrelated pid.
function ownKill(child, sig) {
  try {
    if (child && typeof child.pid === 'number' && child.pid > 0 && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, sig);
        return;
      } catch {
        // ESRCH (already gone) or no group support: fall through to direct.
      }
    }
  } catch {
    // A hostile child object never breaks the cleanup.
  }
  try {
    if (child && typeof child.kill === 'function') child.kill(sig);
  } catch {
    // Killing a dead child never fails the run.
  }
}

function runArgvAsync(bin, args, opts = {}) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== 'string')) {
    return Promise.reject(new TypeError('runArgvAsync requires an array of string arguments'));
  }
  const timeoutMs = Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0 ? Math.floor(opts.timeoutMs) : 120000;
  const killGraceMs = Number.isFinite(opts.killGraceMs) && opts.killGraceMs > 0
    ? Math.floor(opts.killGraceMs)
    : KILL_GRACE_MS_DEFAULT;
  let spawnFn = opts.spawnFn;
  if (typeof spawnFn !== 'function') {
    try {
      spawnFn = require('node:child_process').spawn;
    } catch (err) {
      return Promise.resolve({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
    }
  }
  const spawnOpts = { cwd: opts.cwd, windowsHide: true };
  if (opts.input !== undefined) spawnOpts.input = opts.input;
  if (opts.env !== undefined) spawnOpts.env = opts.env;
  // POSIX-only new group: group signals stay inside the owned pgid, so a
  // negative-pid kill can never reach our own process group.
  if (process.platform !== 'win32') spawnOpts.detached = true;
  let child;
  try {
    child = spawnFn(bin, args, spawnOpts);
  } catch (err) {
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: (err && err.message) || String(err) });
  }
  if (!child || typeof child.on !== 'function') {
    return Promise.resolve({ status: null, stdout: '', stderr: '', error: 'spawn returned nothing usable' });
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let done = false;
    let cleaningUp = false;
    let terminalError = null;
    let timer = null;
    let grace = null;
    let reap = null;
    const clearTimers = () => {
      try { if (timer !== null) clearTimeout(timer); } catch { /* a dead timer never fails the run */ }
      try { if (grace !== null) clearTimeout(grace); } catch { /* a dead timer never fails the run */ }
      try { if (reap !== null) clearTimeout(reap); } catch { /* a dead timer never fails the run */ }
    };
    const detachSignal = () => {
      try {
        if (opts.signal && typeof opts.signal.removeEventListener === 'function') {
          opts.signal.removeEventListener('abort', onAbort);
        }
      } catch { /* a hostile signal never fails the run */ }
    };
    const settle = (value) => {
      if (done) return;
      done = true;
      clearTimers();
      detachSignal();
      resolve(value);
    };
    // Second bound: after SIGKILL the run settles even if `close` never
    // fires (an uninterruptible or fake child), so the await cannot hang.
    const startReap = () => {
      reap = setTimeout(() => {
        settle({ status: null, stdout, stderr, error: terminalError });
      }, killGraceMs);
    };
    const beginCleanup = (error) => {
      if (done || cleaningUp) return;
      cleaningUp = true;
      terminalError = error;
      ownKill(child, 'SIGTERM');
      grace = setTimeout(() => {
        if (done) return;
        ownKill(child, 'SIGKILL');
        startReap();
      }, killGraceMs);
    };
    const onAbort = () => {
      beginCleanup('aborted');
    };
    timer = setTimeout(() => {
      beginCleanup(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    try {
      if (opts.signal) {
        if (opts.signal.aborted) {
          onAbort();
        } else if (typeof opts.signal.addEventListener === 'function') {
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      }
      child.on('error', (err) => {
        if (cleaningUp) {
          settle({ status: null, stdout, stderr, error: terminalError });
          return;
        }
        settle({ status: null, stdout, stderr, error: (err && err.message) || String(err) });
      });
      child.on('close', (code) => {
        // A close during cleanup is the reap: settle the terminal error
        // now instead of waiting out the grace/reap bounds.
        if (cleaningUp) {
          settle({ status: null, stdout, stderr, error: terminalError });
          return;
        }
        settle({ status: code, stdout, stderr, error: null });
      });
    } catch (err) {
      settle({ status: null, stdout, stderr, error: (err && err.message) || String(err) });
    }
  });
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

// The PRINCIPAL checkout of the repository containing repoRoot: the
// checkout that owns the shared git common dir. For a linked worktree
// `git rev-parse --git-common-dir` resolves (through the realpath-aware
// base in repoIdentity) to `<principal>/.git`, so the principal is its
// dirname — no branch-name assumption (`main`, `master`, anything) is
// ever consulted. For the principal itself this is its own root, and
// for anything unresolvable it falls back to the toplevel: callers
// always get a usable directory, never a throw.
function principalRoot(repoRoot) {
  let identity;
  try {
    identity = repoIdentity(repoRoot);
  } catch {
    return repoRoot;
  }
  try {
    if (typeof identity.commonDir === 'string' && path.basename(identity.commonDir) === '.git') {
      const candidate = path.resolve(path.dirname(identity.commonDir));
      return candidate;
    }
  } catch {
    // Fall through to the toplevel below.
  }
  return identity.root;
}

// Canonical target path for a branch: the SAME sibling layout as
// worktreePath, but ALWAYS derived from the principal checkout's
// parent/name — even when the caller runs inside a linked worktree
// (where worktreePath would nest `<worktree>-worktrees/` inside the
// calling checkout). The branch HEAD still comes from the CURRENT
// checkout (creation never changes its base); only the directory
// layout is principal-anchored.
function canonicalWorktreePath(repoRoot, branch) {
  const principal = principalRoot(repoRoot);
  return path.join(path.dirname(principal), `${path.basename(principal)}-worktrees`, slugifyBranch(branch));
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

// Closed union of herdr operations with a per-operation flag allowlist,
// mirroring the installed CLI surface (herdr 0.9.4, verified read-only
// against `herdr worktree list|create|open --help`, `herdr pane list
// --help` and `herdr agent start|get|list --help`: every flag below
// exists there with the shape used here). Every value travels as its own
// argv element because herdr rejects `--flag=value`. Unknown operations
// or flags throw. `--trust-repository` is deliberately absent everywhere:
// trusting a repository is a human decision these tools never take.
// `--focus` stays opt-in for the worktree create/open calls that predate
// the session tool; the session tool itself only ever passes `--no-focus`.
const HERDR_ALLOWLIST = {
  list: ['cwd'],
  create: ['cwd', 'branch', 'base', 'path', 'label', 'focus'],
  open: ['cwd', 'path', 'branch', 'noFocus', 'focus'],
  remove: ['workspace', 'force'],
  'pane-list': ['workspace'],
  'agent-start': ['name', 'kind', 'pane', 'timeout', 'agentArgs'],
  'agent-get': ['target'],
  'agent-list': [],
};

const HERDR_FLAG = {
  cwd: '--cwd',
  workspace: '--workspace',
  branch: '--branch',
  base: '--base',
  path: '--path',
  label: '--label',
  focus: '--focus',
  noFocus: '--no-focus',
  force: '--force',
  kind: '--kind',
  pane: '--pane',
  timeout: '--timeout',
};

// Build the fixed argv for a herdr operation. Worktree operations produce
// `herdr worktree <op> ...`; the session composition additionally needs
// `herdr pane list`, `herdr agent start <NAME> ... -- [AGENT_ARG]...`,
// `herdr agent get <target>` and `herdr agent list`, each with its own
// fixed shape below so no caller hand-builds herdr argv.
function herdrArgv(operation, params = {}) {
  const allowed = HERDR_ALLOWLIST[operation];
  if (!allowed) throw new Error(`unknown herdr operation: ${operation}`);
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw new Error(`flag not allowed for herdr ${operation}: ${key}`);
  }
  // `herdr agent start <NAME> --kind <KIND> --pane <ID> --timeout <MS>
  // -- [AGENT_ARG]...`: the agent name is positional and always first,
  // the Pi argv travels after a `--` separator. Fixed order, values as
  // separate elements, never `--flag=value`.
  if (operation === 'agent-start') {
    const { name, kind, pane, timeout, agentArgs } = params;
    if (typeof name !== 'string' || name === '') throw new Error('invalid value for herdr agent-start name');
    for (const [key, value] of [['kind', kind], ['pane', pane], ['timeout', timeout]]) {
      if (typeof value !== 'string' || value === '') throw new Error(`invalid value for herdr agent-start ${key}`);
    }
    if (!Array.isArray(agentArgs) || agentArgs.some((entry) => typeof entry !== 'string')) {
      throw new Error('invalid value for herdr agent-start agentArgs');
    }
    return ['agent', 'start', name,
      '--kind', kind, '--pane', pane, '--timeout', timeout,
      '--', ...agentArgs];
  }
  // `herdr agent get <target>`: the target is positional.
  if (operation === 'agent-get') {
    const { target } = params;
    if (typeof target !== 'string' || target === '') throw new Error('invalid value for herdr agent-get target');
    return ['agent', 'get', target];
  }
  // `herdr agent list` takes no flags.
  if (operation === 'agent-list') return ['agent', 'list'];
  // `herdr pane list [--workspace <ID>]`.
  if (operation === 'pane-list') {
    const argv = ['pane', 'list'];
    if (params.workspace !== undefined) {
      if (typeof params.workspace !== 'string' || params.workspace === '') {
        throw new Error('invalid value for herdr pane-list workspace');
      }
      argv.push('--workspace', params.workspace);
    }
    return argv;
  }
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

// Where the herdr binary comes from. Production honors the documented
// HERDR_BIN_PATH override (tests), else `herdr` on PATH — the same
// convention lib/gentle-diagnostics.js uses. When the test harness is in
// force (GENTLE_WORKTREE_LIB_DIR is set only by the test loaders that
// import the extension copy) and no explicit binary was injected, fail
// closed instead of silently spawning the live `herdr` on PATH: tests must
// never touch a live Herdr session. Production (no harness marker) keeps
// the historical `herdr` default untouched.
function resolveHerdrBinary(env = {}) {
  const source = env || {};
  const bin = source.HERDR_BIN_PATH;
  if (typeof bin === 'string' && bin.length > 0) return bin;
  const harness = source.GENTLE_WORKTREE_LIB_DIR;
  if (typeof harness === 'string' && harness.length > 0) {
    throw new Error('herdr binary is not injected: set HERDR_BIN_PATH in tests (refusing to run live herdr)');
  }
  return 'herdr';
}

module.exports = {
  runArgv,
  runArgvAsync,
  repoIdentity,
  slugifyBranch,
  worktreePath,
  principalRoot,
  canonicalWorktreePath,
  validateBranch,
  listWorktrees,
  isPathInAnyCheckout,
  herdrArgv,
  resolveHerdrBinary,
};
