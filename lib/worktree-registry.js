'use strict';
// Registry of agent-owned worktrees (P2-S1 foundation).
//
// The file lives at <git-common-dir>/pi-worktrees.json: inside `.git`,
// never in a working tree, never committed, shared by every worktree of
// the repository. Entries carry
// {branch, path, thread, issues[], odd[], createdAt, updatedAt}.
//
// Reads tolerate malformed content and report it instead of throwing, and
// never delete the file. Writes are atomic (temporary file plus rename)
// and serialized by withRegistryLock, an exclusive lock file beside the
// registry with a bounded wait and stale-lock recovery. Pure Node: the
// only subprocess used is the git plumbing that locates the common dir.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { repoIdentity } = require('./worktree-git.js');

const REGISTRY_VERSION = 1;
const REGISTRY_NAME = 'pi-worktrees.json';
const LOCK_NAME = 'pi-worktrees.lock';

const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_POLL_MS = 50;
const DEFAULT_STALE_MS = 30000;

function registryPath(repoRoot) {
  return path.join(repoIdentity(repoRoot).commonDir, REGISTRY_NAME);
}

function lockPath(repoRoot) {
  return path.join(repoIdentity(repoRoot).commonDir, LOCK_NAME);
}

function emptyRegistry() {
  return { ok: true, version: REGISTRY_VERSION, worktrees: [], error: null };
}

// Tolerant odd-documents read (customize-command S46): the registry has
// always stored `odd[]`, but older rows may predate the field (missing)
// or carry the single-path string the public `worktree_create` tool
// accepts. Every read and every store funnels through here, so a stored
// older shape normalizes instead of crashing or spreading.
function normalizeOddList(value) {
  if (Array.isArray(value)) return value.slice();
  if (typeof value === 'string' && value.length > 0) return [value];
  return [];
}

function isEntryShape(entry) {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    && typeof entry.branch === 'string' && typeof entry.path === 'string';
}

// Read the registry. Missing means empty; malformed content is reported
// ({ok:false, error}) instead of thrown, and the file is left untouched.
function readRegistry(repoRoot) {
  let raw;
  try {
    raw = fs.readFileSync(registryPath(repoRoot), 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return emptyRegistry();
    return { ok: false, version: null, worktrees: [], error: `cannot read registry: ${err.message}` };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
  } catch (err) {
    return { ok: false, version: null, worktrees: [], error: `malformed registry (invalid JSON): ${err.message}` };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc) || !Array.isArray(doc.worktrees)) {
    return { ok: false, version: null, worktrees: [], error: 'malformed registry (expected {worktrees: []})' };
  }
  const version = doc.version === undefined ? REGISTRY_VERSION : doc.version;
  const worktrees = doc.worktrees.filter(isEntryShape).map((entry) => ({
    ...entry,
    issues: Array.isArray(entry.issues) ? entry.issues : [],
    odd: normalizeOddList(entry.odd),
  }));
  return { ok: true, version, worktrees, error: null };
}

function findEntry(worktrees, predicate) {
  return worktrees.find(predicate) || null;
}

function findByBranch(repoRoot, branch) {
  const read = readRegistry(repoRoot);
  if (!read.ok) return null;
  return findEntry(read.worktrees, (entry) => entry.branch === branch);
}

function findByPath(repoRoot, target) {
  const read = readRegistry(repoRoot);
  if (!read.ok) return null;
  // A relative key matches nothing: registry paths are absolute, and
  // resolving either side against the process cwd would name a checkout
  // relative to wherever the caller happens to run, not the repository.
  if (typeof target !== 'string' || !path.isAbsolute(target)) return null;
  const resolved = path.resolve(target);
  return findEntry(read.worktrees, (entry) => typeof entry.path === 'string'
    && path.isAbsolute(entry.path)
    && path.resolve(entry.path) === resolved);
}

function findByThread(repoRoot, thread) {
  const read = readRegistry(repoRoot);
  if (!read.ok) return null;
  return findEntry(read.worktrees, (entry) => entry.thread === thread);
}

// Acquire the exclusive lock file beside the registry, run fn, release.
// Bounded wait (timeoutMs) with stale-lock recovery (staleMs): a lock
// file older than staleMs is treated as orphaned and removed. Throws on
// timeout so a stuck holder fails loudly instead of hanging forever.
function withRegistryLock(repoRoot, fn, opts = {}) {
  const file = lockPath(repoRoot);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const deadline = Date.now() + timeoutMs;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(file, 'wx', 0o644);
      try {
        fs.writeSync(fd, String(process.pid));
      } catch {
        // Best effort owner hint; the lock itself is what matters.
      }
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      if (isStaleLock(file, staleMs)) {
        try {
          fs.unlinkSync(file);
        } catch {
          // Lost a race with another recoverer; retry acquisition.
        }
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out after ${timeoutMs}ms waiting for registry lock ${file}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(pollMs, deadline - Date.now()));
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Releasing must not mask the callback result.
    }
    try {
      fs.unlinkSync(file);
    } catch {
      // Another stale recovery may have removed it first.
    }
  }
}

function isStaleLock(file, staleMs) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  return Date.now() - stat.mtimeMs > staleMs;
}

function backupCorruptRegistry(file) {
  // Preserve the previous bytes beside the registry before a malformed
  // file is replaced. Best-effort and never fatal: a missing or
  // unreadable file, or a failed copy, simply yields no backup.
  // The backup name carries an unpredictable suffix and is created
  // exclusively (`wx`) so a planted symlink or file at a predictable
  // name is never followed or overwritten; on collision a new name is
  // retried a bounded number of times, then the operation continues
  // WITHOUT a backup (the caller reports that clearly).
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix;
    try {
      suffix = crypto.randomBytes(8).toString('hex');
    } catch {
      return null;
    }
    const backup = `${file}.corrupt-${Date.now()}-${suffix}`;
    try {
      fs.writeFileSync(backup, raw, { flag: 'wx' });
      return backup;
    } catch (err) {
      if (err && err.code === 'EEXIST') continue;
      // Best-effort: a failed backup write never leaves litter behind.
      try {
        fs.unlinkSync(backup);
      } catch {
        // Either never created or already gone; nothing to clean.
      }
      return null;
    }
  }
  return null;
}

function validateEntry(entry) {
  if (typeof entry !== 'object' || entry === null) return 'entry must be an object';
  if (typeof entry.branch !== 'string' || entry.branch === '') return 'entry.branch is required';
  if (typeof entry.path !== 'string' || entry.path === '') return 'entry.path is required';
  if (typeof entry.thread !== 'string' || entry.thread === '') return 'entry.thread is required';
  if (!Array.isArray(entry.issues)) return 'entry.issues must be an array (possibly empty)';
  if (entry.odd !== undefined && !Array.isArray(entry.odd)) return 'entry.odd must be an array';
  return null;
}

// Atomically replace the registry file: write a sibling temp file
// exclusively (`wx`) with an unpredictable suffix, then rename over the
// target. A pre-existing name is never followed or reused: on collision
// a new name is retried a bounded number of times, then the write is
// refused with a clear error. The temp file never survives the call.
function writeRegistryAtomic(file, doc) {
  const payload = `${JSON.stringify(doc, null, 2)}\n`;
  let tmp = null;
  let wrote = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix;
    try {
      suffix = crypto.randomBytes(8).toString('hex');
    } catch (err) {
      throw new Error(`cannot write registry ${file}: cannot generate a temporary file name: ${(err && err.message) || err}`);
    }
    tmp = `${file}.tmp.${process.pid}.${Date.now()}.${suffix}`;
    try {
      fs.writeFileSync(tmp, payload, { flag: 'wx' });
      wrote = true;
      break;
    } catch (err) {
      // A non-EEXIST failure may still have created the temp file
      // (e.g. ENOSPC mid-write): unlink it best-effort so a failed
      // write never leaves litter behind, then rethrow (never success).
      const failedTmp = tmp;
      tmp = null;
      if (err && err.code === 'EEXIST') continue;
      if (failedTmp) {
        try {
          fs.unlinkSync(failedTmp);
        } catch {
          // Best effort: the rethrow below is what matters.
        }
      }
      throw err;
    }
  }
  if (!wrote || !tmp) {
    throw new Error(`cannot write registry ${file}: could not create a unique temporary file after 10 attempts; refusing to follow or reuse an existing path`);
  }
  try {
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // Either renamed (gone) or never created; nothing to clean.
    }
  }
}

function upsertWorktree(repoRoot, entry, opts = {}) {
  const invalid = validateEntry(entry);
  if (invalid) return { ok: false, error: invalid };
  return withRegistryLock(repoRoot, () => storeLocked(repoRoot, entry, 'upsert'), opts);
}

// Always-append variant of the upsert: the incoming entry is recorded
// WITHOUT replacing any row that already carries its branch. The create
// path uses this when a hand-written row with the same branch points at
// a DIFFERENT live checkout, so that checkout keeps its registration and
// the new checkout is recorded alongside it. Malformed-file handling
// (replace, never merge, with the same best-effort backup) matches the
// upsert exactly.
function appendWorktree(repoRoot, entry, opts = {}) {
  const invalid = validateEntry(entry);
  if (invalid) return { ok: false, error: invalid };
  return withRegistryLock(repoRoot, () => storeLocked(repoRoot, entry, 'append'), opts);
}

function storeLocked(repoRoot, entry, mode) {
    const file = registryPath(repoRoot);
    const read = readRegistry(repoRoot);
    // A malformed file is replaced, never merged: the incoming entry is
    // the only trustworthy data. Reads already reported the damage. The
    // previous bytes are preserved beside the registry first so the
    // damage stays inspectable.
    const backup = read.ok ? null : backupCorruptRegistry(file);
    const worktrees = read.ok ? read.worktrees.slice() : [];
    const now = new Date().toISOString();
    const index = mode === 'upsert'
      ? worktrees.findIndex((item) => item.branch === entry.branch)
      : -1;
    const previous = index >= 0 ? worktrees[index] : null;
    const stored = {
      branch: entry.branch,
      path: entry.path,
      thread: entry.thread,
      issues: entry.issues.slice(),
      odd: entry.odd !== undefined ? normalizeOddList(entry.odd) : (previous ? normalizeOddList(previous.odd) : []),
      createdAt: previous ? previous.createdAt : now,
      updatedAt: now,
    };
    if (index >= 0) worktrees[index] = stored;
    else worktrees.push(stored);
    writeRegistryAtomic(file, { version: REGISTRY_VERSION, worktrees });
    const result = { ok: true, entry: stored };
    // Name the backup so the caller can report it; absent when the
    // previous registry was valid (or there was nothing to preserve).
    // When the previous file was malformed but no backup could be
    // written, the operation still succeeds (best-effort, never fatal)
    // but the failure is reported clearly via backupError and never
    // clobbers anything.
    if (backup) result.backup = backup;
    else if (!read.ok) result.backupError = `could not preserve malformed registry ${file}: backup unavailable; the registry was replaced without a backup`;
    return result;
}

// Update-in-place for the create-or-update tool (S27/S31): overwrite
// ONLY the supplied fields of the row identified by `key` (branch or
// absolute path, the same matching `removeWorktree` uses) and leave
// every omitted field untouched — so a supplied `issues` (including
// `[]`) and a supplied `odd` (including `[]`) REPLACE the stored value
// while an omitted field stays as it was. The branch and the path are
// never rewritten here. Returns {ok, entry} or {ok:false, error}; never
// throws on a readable registry, and writes atomically under the lock.
function updateWorktree(repoRoot, key, patch = {}, opts = {}) {
  const hasIssues = patch && Object.prototype.hasOwnProperty.call(patch, 'issues');
  const hasOdd = patch && Object.prototype.hasOwnProperty.call(patch, 'odd');
  if (hasIssues && !Array.isArray(patch.issues)) {
    return { ok: false, error: 'patch.issues must be an array (possibly empty)' };
  }
  if (hasOdd && !Array.isArray(patch.odd)) {
    return { ok: false, error: 'patch.odd must be an array (possibly empty)' };
  }
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const index = read.worktrees.findIndex((entry) => matchesKey(entry, key));
    if (index < 0) return { ok: false, error: `no registered worktree for ${key}` };
    const worktrees = read.worktrees.slice();
    const current = worktrees[index];
    const stored = {
      branch: current.branch,
      path: current.path,
      thread: current.thread,
      issues: hasIssues ? patch.issues.slice() : (Array.isArray(current.issues) ? current.issues.slice() : []),
      odd: hasOdd ? patch.odd.slice() : normalizeOddList(current.odd),
      createdAt: current.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    worktrees[index] = stored;
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return { ok: true, entry: stored };
  }, opts);
}

// Startup discovery registration (S28): record every live checkout the
// registry does not already own, without touching any existing row. `live`
// is git's listing; `principalPath` (resolved identity, or null) excludes
// the principal checkout, which is only ever created on demand by an
// explicit edit (S31) and never by discovery. Matching is by resolved
// path identity, so a registered row reached through a symlink still
// counts as owned. Returns {ok, registered:[{branch,path}]}; never throws
// on a readable registry — failures report {ok:false, error}.
function registerMissingWorktrees(repoRoot, live, principalPath, opts = {}) {
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error, registered: [] };
    const owned = new Set();
    for (const row of read.worktrees) {
      if (!row || typeof row.path !== 'string' || !path.isAbsolute(row.path)) continue;
      try {
        owned.add(path.resolve(row.path));
      } catch {
        // An unresolvable row owns nothing.
      }
      try {
        owned.add(fs.realpathSync(row.path));
      } catch {
        // A missing checkout contributes only its spelling.
      }
    }
    const now = new Date().toISOString();
    const worktrees = read.worktrees.slice();
    const registered = [];
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
      if (!entry.branch || typeof entry.branch !== 'string' || entry.branch.length === 0) continue;
      let absolute;
      try {
        absolute = path.isAbsolute(entry.path) ? path.resolve(entry.path) : null;
      } catch {
        continue;
      }
      if (absolute === null) continue;
      let exists = false;
      let isDirectory = false;
      try {
        isDirectory = fs.statSync(absolute).isDirectory();
        exists = true;
      } catch {
        exists = false;
        isDirectory = false;
      }
      if (!exists || !isDirectory) continue;
      let real = null;
      try {
        real = fs.realpathSync(absolute);
      } catch {
        real = null;
      }
      const id = real !== null ? real : absolute;
      if (principalPath !== null && principalPath !== undefined && id === principalPath) continue;
      if (owned.has(absolute) || (real !== null && owned.has(real))) continue;
      if (worktrees.some((row) => row.branch === entry.branch)) continue;
      const stored = {
        branch: entry.branch,
        path: absolute,
        thread: 'discovery',
        issues: [],
        odd: [],
        createdAt: now,
        updatedAt: now,
      };
      worktrees.push(stored);
      owned.add(absolute);
      if (real !== null) owned.add(real);
      registered.push({ branch: stored.branch, path: stored.path });
    }
    if (registered.length === 0) return { ok: true, registered: [] };
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return { ok: true, registered };
  }, opts);
}

function matchesKey(entry, key) {
  if (entry.branch === key) return true;
  // Path keys match by exact absolute path equality only. A branch name
  // (or any other relative string) must never be resolved against the
  // process cwd as a path key: from a different cwd that would match a
  // checkout the caller never named.
  if (typeof key !== 'string' || !path.isAbsolute(key)) return false;
  if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return false;
  try {
    return path.resolve(entry.path) === path.resolve(key);
  } catch {
    return false;
  }
}

function removeWorktree(repoRoot, key, opts = {}) {
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const index = read.worktrees.findIndex((entry) => matchesKey(entry, key));
    if (index < 0) return { ok: false, error: `no registered worktree for ${key}` };
    const worktrees = read.worktrees.slice();
    worktrees.splice(index, 1);
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return { ok: true };
  }, opts);
}

// Every identity an absolute path can present: its resolved form, its
// realpath when the filesystem still resolves it, and — via an explicit
// readlink walk that never touches the process cwd — every referent of a
// symlink chain, so a DANGLING link left behind by a removed checkout
// still names the checkout it used to reach. All inputs are absolute, so
// path.resolve here never consults the process cwd.
function pathIdentities(absolutePath) {
  const ids = new Set();
  let resolved;
  try {
    resolved = path.resolve(absolutePath);
  } catch {
    return ids;
  }
  ids.add(resolved);
  try {
    ids.add(fs.realpathSync(absolutePath));
  } catch {
    // Unresolvable (removed checkout, dangling link): the readlink walk
    // below still recovers the referent.
  }
  let current = resolved;
  for (let depth = 0; depth < 10; depth += 1) {
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      break;
    }
    if (!stat.isSymbolicLink()) break;
    let link;
    try {
      link = fs.readlinkSync(current);
    } catch {
      break;
    }
    current = path.resolve(path.dirname(current), link);
    ids.add(current);
    try {
      ids.add(fs.realpathSync(current));
    } catch {
      // Keep walking: a deeper link may still resolve.
    }
  }
  return ids;
}

// Path-identity removal for the close flow: drops every entry that reaches
// the removed checkout — the same absolute value the close resolved,
// verified, and removed, a realpath-equal row, or a row whose path is a
// symlink (live or dangling) to it. A non-absolute key is refused, no
// branch comparison happens here, and a relative row can never match, so
// duplicate branches or a branch that equals another entry's path can
// never divert the drop. Other callers keep using `removeWorktree` with
// its branch behaviour.
function removeWorktreeByPath(repoRoot, absolutePath, opts = {}) {
  if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) {
    return { ok: false, error: `refusing to drop registry entry: path ${JSON.stringify(absolutePath)} is not absolute` };
  }
  const targetIds = pathIdentities(absolutePath);
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    // Drop EVERY row reaching the target: a hand-edited registry may hold
    // duplicate rows sharing one path, or a row whose path is a symlink
    // to the removed checkout, and leaving one behind would keep a stale
    // entry after the close.
    const worktrees = read.worktrees.filter((entry) => {
      if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return true;
      for (const id of pathIdentities(entry.path)) {
        if (targetIds.has(id)) return false;
      }
      return true;
    });
    if (worktrees.length === read.worktrees.length) return { ok: false, error: `no registered worktree for ${absolutePath}` };
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return { ok: true };
  }, opts);
}

// Row-identity removal for the create-path stale cleanup: drops the rows
// whose (branch, path) pair exactly equals the selected entry — the ONE
// row the caller identified as its own. Never matches by branch alone
// and never resolves paths, so a live entry sharing the branch (or a
// path that resolves the same) is never diverted onto.
function removeWorktreeExact(repoRoot, branch, entryPath, opts = {}) {
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const worktrees = read.worktrees.filter((entry) => !(entry.branch === branch && entry.path === entryPath));
    if (worktrees.length === read.worktrees.length) return { ok: false, error: `no registered worktree for ${branch}` };
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return { ok: true };
  }, opts);
}

// Batch prune for the list self-heal (S16): drops every row whose
// absolute path is one of `absolutePaths` in ONE locked atomic write.
// Only absolute paths participate on either side — a relative row can
// never name a checkout without resolving against the process cwd, so it
// is never matched here and callers must not pass one. Returns
// {ok, pruned} where pruned lists the dropped entry paths; a write
// failure throws so the caller can still exclude the rows from its
// listing while reporting the failure.
function pruneWorktrees(repoRoot, absolutePaths, opts = {}) {
  const targets = new Set();
  for (const candidate of absolutePaths || []) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate)) continue;
    try {
      targets.add(path.resolve(candidate));
    } catch {
      // An unresolvable candidate matches nothing.
    }
  }
  if (targets.size === 0) return { ok: true, pruned: [] };
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error, pruned: [] };
    const pruned = [];
    const worktrees = read.worktrees.filter((entry) => {
      if (typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return true;
      let resolved;
      try {
        resolved = path.resolve(entry.path);
      } catch {
        return true;
      }
      if (targets.has(resolved)) {
        pruned.push(entry.path);
        return false;
      }
      return true;
    });
    if (pruned.length === 0) return { ok: true, pruned: [] };
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return { ok: true, pruned };
  }, opts);
}

function addOddDoc(repoRoot, key, relPath, opts = {}) {
  if (typeof relPath !== 'string' || relPath === '') return { ok: false, error: 'relPath is required' };
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const index = read.worktrees.findIndex((entry) => matchesKey(entry, key));
    if (index < 0) return { ok: false, error: `no registered worktree for ${key}` };
    const worktrees = read.worktrees.slice();
    const entry = { ...worktrees[index], odd: normalizeOddList(worktrees[index].odd) };
    let added = false;
    if (!entry.odd.includes(relPath)) {
      entry.odd.push(relPath);
      added = true;
    }
    entry.updatedAt = new Date().toISOString();
    worktrees[index] = entry;
    writeRegistryAtomic(registryPath(repoRoot), { version: read.version, worktrees });
    return { ok: true, entry, added };
  }, opts);
}

module.exports = {
  REGISTRY_VERSION,
  normalizeOddList,
  registryPath,
  readRegistry,
  findByBranch,
  findByPath,
  findByThread,
  upsertWorktree,
  appendWorktree,
  removeWorktree,
  removeWorktreeByPath,
  removeWorktreeExact,
  pruneWorktrees,
  addOddDoc,
  updateWorktree,
  registerMissingWorktrees,
  withRegistryLock,
};
