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
  return { ok: true, version, worktrees: doc.worktrees.filter(isEntryShape), error: null };
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
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  const backup = `${file}.corrupt-${Date.now()}`;
  try {
    fs.writeFileSync(backup, raw);
    return backup;
  } catch {
    return null;
  }
}

function validateEntry(entry) {
  if (typeof entry !== 'object' || entry === null) return 'entry must be an object';
  if (typeof entry.branch !== 'string' || entry.branch === '') return 'entry.branch is required';
  if (typeof entry.path !== 'string' || entry.path === '') return 'entry.path is required';
  if (typeof entry.thread !== 'string' || entry.thread === '') return 'entry.thread is required';
  if (!Array.isArray(entry.issues) || entry.issues.length === 0) return 'entry.issues must list at least one issue';
  if (entry.odd !== undefined && !Array.isArray(entry.odd)) return 'entry.odd must be an array';
  return null;
}

// Atomically replace the registry file: write a sibling temp file, then
// rename over the target. The temp file never survives the call.
function writeRegistryAtomic(file, doc) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
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
  return withRegistryLock(repoRoot, () => {
    const file = registryPath(repoRoot);
    const read = readRegistry(repoRoot);
    // A malformed file is replaced, never merged: the incoming entry is
    // the only trustworthy data. Reads already reported the damage. The
    // previous bytes are preserved beside the registry first so the
    // damage stays inspectable.
    const backup = read.ok ? null : backupCorruptRegistry(file);
    const worktrees = read.ok ? read.worktrees.slice() : [];
    const now = new Date().toISOString();
    const index = worktrees.findIndex((item) => item.branch === entry.branch);
    const previous = index >= 0 ? worktrees[index] : null;
    const stored = {
      branch: entry.branch,
      path: entry.path,
      thread: entry.thread,
      issues: entry.issues.slice(),
      odd: entry.odd ? entry.odd.slice() : (previous ? previous.odd.slice() : []),
      createdAt: previous ? previous.createdAt : now,
      updatedAt: now,
    };
    if (index >= 0) worktrees[index] = stored;
    else worktrees.push(stored);
    writeRegistryAtomic(file, { version: REGISTRY_VERSION, worktrees });
    const result = { ok: true, entry: stored };
    // Name the backup so the caller can report it; absent when the
    // previous registry was valid (or there was nothing to preserve).
    if (backup) result.backup = backup;
    return result;
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

function addOddDoc(repoRoot, key, relPath, opts = {}) {
  if (typeof relPath !== 'string' || relPath === '') return { ok: false, error: 'relPath is required' };
  return withRegistryLock(repoRoot, () => {
    const read = readRegistry(repoRoot);
    if (!read.ok) return { ok: false, error: read.error };
    const index = read.worktrees.findIndex((entry) => matchesKey(entry, key));
    if (index < 0) return { ok: false, error: `no registered worktree for ${key}` };
    const worktrees = read.worktrees.slice();
    const entry = { ...worktrees[index], odd: (worktrees[index].odd || []).slice() };
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
  registryPath,
  readRegistry,
  findByBranch,
  findByPath,
  findByThread,
  upsertWorktree,
  removeWorktree,
  addOddDoc,
  withRegistryLock,
};
