'use strict';
// Per-checkout warp sessions (customize-command S17/T11).
//
// At most ONE forked session per checkout: the first warp to a checkout
// forks and records the session file here, keyed by the checkout's
// realpath; later warps to the same checkout resume that same file with
// a plain `switchSession` instead of forking again. The principal
// checkout is keyed exactly like every other checkout.
//
// The file lives at <git-common-dir>/pi-warp-sessions.json: beside the
// pi-worktrees.json registry, never inside it (the registry shape is a
// consumed contract) and never in the plugin state dir. Values carry
// {sessionFile, leafId, entryCount, updatedAt}; nothing secret is ever stored and no
// path or file content is echoed in errors.
//
// Reads tolerate damage: a missing file reads as empty, and a malformed
// file is treated as empty (never thrown), so a corrupt record fails
// safe by forking again and overwriting. Writes are atomic (a sibling
// temp file created exclusively with an unpredictable suffix plus
// rename, retrying a new name a bounded number of times) and refuse a
// symlinked or non-regular destination instead of following it. A failed
// record write never fails the warp: recording is best-effort, the warp
// itself already switched. Concurrent warps may each fork with the last
// writer winning; that orphans at most one extra session file and never
// corrupts the record.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { repoIdentity } = require('./worktree-git.js');

const WARP_SESSIONS_VERSION = 1;
const WARP_SESSIONS_NAME = 'pi-warp-sessions.json';

function warpSessionsPath(repoRoot) {
  return path.join(repoIdentity(repoRoot).commonDir, WARP_SESSIONS_NAME);
}

function emptySessions() {
  return { ok: true, version: WARP_SESSIONS_VERSION, sessions: {}, error: null };
}

function isRecordShape(entry) {
  return typeof entry === 'object' && entry !== null && !Array.isArray(entry)
    && typeof entry.sessionFile === 'string' && entry.sessionFile.length > 0;
}

// S23/S43 filtered session identity: the POINT of a session is its ACTIVE
// branch (the getBranch(leaf) path, never all append-only entries)
// filtered to entries that are NOT our own bookkeeping. Our shapes are
// exactly these four, proven against the installed SessionManager
// (dist/core/session-manager.js) and the live warp flow:
//   - `custom` + `worktree-warp`: the transition record the fork appends
//     through appendCustomEntry;
//   - `custom_message` + `worktree-warp`: the visible confirmation the
//     switched-to session sends through sendMessage({customType}), which
//     the runtime persists through appendCustomMessageEntry — the shape
//     the old filter missed, so every warp back forked again;
//   - `custom` + `gentle-pi.session-worktree/v1`: the registration entry
//     the session_worktree_register host tool appends at startup;
//   - every `session_info`: the checkout rename (appendSessionInfo).
// Anything else — user/assistant/tool entries, model/thinking changes,
// unknown custom shapes — is session content and COUNTS: no broad
// exclusion, nothing silently ignored. Because SessionManager.forkFrom
// copies source entries VERBATIM with their ids, a fresh fork's filtered
// point equals its source's: the fork is identical. {tipId, count} where
// tipId is the last remaining entry's id (null when no real entry exists)
// and count is the number of remaining entries.
const WARP_BOOKKEEPING_CUSTOM_TYPE = 'worktree-warp';
const SESSION_WORKTREE_CUSTOM_TYPE = 'gentle-pi.session-worktree/v1';

function isWarpBookkeepingEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (entry.type === 'session_info') return true;
  if (entry.type === 'custom' && (entry.customType === WARP_BOOKKEEPING_CUSTOM_TYPE
    || entry.customType === SESSION_WORKTREE_CUSTOM_TYPE)) return true;
  return entry.type === 'custom_message' && entry.customType === WARP_BOOKKEEPING_CUSTOM_TYPE;
}

// The leaf of an entry list under installed SessionManager semantics:
// _buildIndex walks the file in order and keeps the LAST non-session
// entry's id (upstream packages/coding-agent/src/core/session-manager.ts
// _buildIndex; installed dist/core/session-manager.js _buildIndex). No
// separate leaf pointer is persisted, so the last line IS the leaf.
// Returns the id string, or null when there is no such entry.
function leafIdOfEntries(entries) {
  try {
    const list = Array.isArray(entries) ? entries : [];
    for (let index = list.length - 1; index >= 0; index -= 1) {
      const entry = list[index];
      if (entry && typeof entry === 'object' && !Array.isArray(entry)
        && entry.type !== 'session' && typeof entry.id === 'string') {
        return entry.id;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// The ACTIVE branch of an entry list: walk parentId from the leaf back to
// the root, like SessionManager.getBranch does. `leafId` selects the
// start; an unknown or missing leaf falls back to the last entry, like
// the manager's own `leaf ??= entries[entries.length - 1]` rule in
// buildSessionPath. Off-branch entries (an abandoned leg after branch())
// are NOT on this path. Cycles and missing parents stop the walk
// conservatively instead of throwing. Returns the path in root-to-leaf
// order (possibly empty).
function activeBranch(entries, leafId) {
  try {
    const list = Array.isArray(entries) ? entries : [];
    const byId = new Map();
    for (const entry of list) {
      if (entry && typeof entry === 'object' && !Array.isArray(entry)
        && typeof entry.id === 'string') {
        byId.set(entry.id, entry);
      }
    }
    let start = null;
    if (typeof leafId === 'string' && byId.has(leafId)) start = byId.get(leafId);
    else {
      const fallback = leafIdOfEntries(list);
      if (fallback !== null) start = byId.get(fallback) || null;
    }
    if (!start) return [];
    const path = [];
    const visited = new Set();
    let current = start;
    while (current && typeof current.id === 'string' && !visited.has(current.id)) {
      visited.add(current.id);
      path.push(current);
      const parentId = current.parentId;
      if (typeof parentId !== 'string' || parentId.length === 0) break;
      const parent = byId.get(parentId);
      if (!parent) break;
      current = parent;
    }
    path.reverse();
    return path;
  } catch {
    return [];
  }
}

function sessionPoint(entries, leafId) {
  const branch = activeBranch(entries, leafId);
  let tipId = null;
  let count = 0;
  for (const entry of branch) {
    if (isWarpBookkeepingEntry(entry)) continue;
    count += 1;
    if (entry && typeof entry.id === 'string') tipId = entry.id;
    else tipId = null;
  }
  return { tipId, count };
}

// Point evidence for the R3 fork-vs-resume rule: the source session's
// FILTERED position (S23 sessionPoint) when the record was written. Older
// records carry {leafId, entryCount} from the raw-leaf comparison; they
// read through the same shape, so a record written before the fix still
// resolves. Both names are stored on write for the same reason.
function asPoint(value) {
  const tipId = value && typeof value.tipId === 'string' ? value.tipId
    : value && typeof value.leafId === 'string' ? value.leafId : null;
  const rawCount = value && typeof value.count === 'number' ? value.count
    : value && typeof value.entryCount === 'number' ? value.entryCount : null;
  const count = rawCount !== null && Number.isFinite(rawCount) && rawCount >= 0
    ? Math.floor(rawCount) : null;
  return { tipId, count, leafId: tipId, entryCount: count };
}

// True when two points name the same filtered position. An unreadable
// count on either side leaves the tip to decide, so legacy records
// without a count keep their resume behaviour.
function samePoint(a, b) {
  try {
    const first = asPoint(a);
    const second = asPoint(b);
    if (first.tipId !== second.tipId) return false;
    if (first.count === null || second.count === null) return true;
    return first.count === second.count;
  } catch {
    return false;
  }
}

// S43 parent priority: every session header carries `parentSession` (a
// session-file path), so a fork can climb to the HIGHEST ancestor whose
// filtered point still equals its own and fork from there — an untouched
// fork then yields a SIBLING (both children of the original) while an
// advanced session yields its own child. The climb is bounded by a small
// documented constant and fails safe to the LAST GOOD file: a missing or
// empty parent link, an unreadable ancestor, a point mismatch, a cycle
// (visited set) or the depth cap all stop the climb without throwing.
const WARP_ANCESTOR_MAX_DEPTH = 25;

// Read a session file from disk into {entries, parentSession}. The first
// line is the header (carrying `parentSession`, like the live reader in
// extensions/gentle-herdr-state.ts parses it); the remaining lines are
// the entries. Any unreadable file or unparseable line reads as null:
// the climb then keeps the last good file. Never throws.
function readSessionFileNode(sessionFile) {
  try {
    if (typeof sessionFile !== 'string' || sessionFile.length === 0) return null;
    let raw;
    try {
      raw = fs.readFileSync(sessionFile, 'utf8');
    } catch {
      return null;
    }
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const lines = raw.split('\n').filter((line) => line.length > 0);
    if (lines.length === 0) return { entries: [], parentSession: null };
    let header = null;
    try {
      header = JSON.parse(lines[0]);
    } catch {
      return null;
    }
    const rawParent = header && typeof header === 'object'
      ? (header.parentSession !== undefined ? header.parentSession : header.parentSessionId)
      : null;
    const parentSession = typeof rawParent === 'string' && rawParent.length > 0 ? rawParent : null;
    const firstEntry = header && typeof header === 'object' && header.type === 'session' ? 1 : 0;
    const entries = [];
    for (let index = firstEntry; index < lines.length; index += 1) {
      try {
        entries.push(JSON.parse(lines[index]));
      } catch {
        return null;
      }
    }
    return { entries, parentSession };
  } catch {
    return null;
  }
}

// Normalize what an injected `open` returns: either the entries array
// itself or {entries, parentSession} shaped like the real format. Anything
// else reads as unreadable. Never throws.
function normalizeOpenResult(value) {
  try {
    if (Array.isArray(value)) return { entries: value, parentSession: null };
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const entries = Array.isArray(value.entries) ? value.entries : null;
      const rawParent = value.parentSession !== undefined ? value.parentSession : value.parent;
      const parentSession = typeof rawParent === 'string' && rawParent.length > 0 ? rawParent : null;
      return { entries, parentSession };
    }
    return { entries: null, parentSession: null };
  } catch {
    return { entries: null, parentSession: null };
  }
}

// Read one session node through the injectable `open` seam when it knows
// the file, else through the file itself. The seam models the live
// runtime's view of a session (used by tests and by the warp's ancestor
// climb); when it yields nothing for a file, the file's own lines are the
// actual destination state (the live runtime reopens the manager and
// keeps appending there), so they are read instead of inventing an empty
// session. A file that is unknown to both reads as unreadable (entries
// null): callers fail safe to the last good value. Never throws.
function readSessionNode(sessionFile, open) {
  if (typeof open === 'function') {
    let value = null;
    try {
      value = open(sessionFile);
    } catch {
      value = null;
    }
    const shaped = normalizeOpenResult(value);
    if (shaped && Array.isArray(shaped.entries)) return shaped;
  }
  return readSessionFileNode(sessionFile);
}

// The filtered {tipId, count} point of a session FILE, or null when the
// file cannot be read. `open` is the injectable seam (a function of the
// file path, for tests); without it the file is read from disk. Never
// throws.
function pointOfSessionFile(sessionFile, { open } = {}) {
  try {
    const node = readSessionNode(sessionFile, open);
    if (!node || !Array.isArray(node.entries)) return null;
    return sessionPoint(node.entries);
  } catch {
    return null;
  }
}

// The highest ancestor of a session file whose filtered point still
// equals `point` — the fork source under S43. Starts at the file itself
// (returned as-is when it has no readable identical parent) and climbs
// the `parentSession` chain, keeping the last good file at every stop:
// missing/empty/unreadable parent, point mismatch, cycle or depth cap.
// `open` is the same injectable seam as pointOfSessionFile; `maxDepth`
// overrides the bound (the default is WARP_ANCESTOR_MAX_DEPTH). Never
// throws: any failure returns the last good file.
function topmostIdenticalAncestor(sessionFile, point, { open, maxDepth } = {}) {
  try {
    if (typeof sessionFile !== 'string' || sessionFile.length === 0) return sessionFile;
    const cap = Number.isFinite(maxDepth) && maxDepth >= 0 ? Math.floor(maxDepth) : WARP_ANCESTOR_MAX_DEPTH;
    const me = asPoint(point);
    let best = sessionFile;
    let current = sessionFile;
    const visited = new Set([sessionFile]);
    for (let depth = 0; depth < cap; depth += 1) {
      let parent = null;
      try {
        const node = readSessionNode(current, open);
        parent = node ? node.parentSession : null;
      } catch {
        parent = null;
      }
      if (typeof parent !== 'string' || parent.length === 0) break;
      if (visited.has(parent)) break;
      visited.add(parent);
      const parentPoint = pointOfSessionFile(parent, open === undefined ? {} : { open });
      if (parentPoint === null) break;
      if (!samePoint(me, parentPoint)) break;
      best = parent;
      current = parent;
    }
    return best;
  } catch {
    return sessionFile;
  }
}

// The canonical key for a checkout: its realpath, falling back to the
// resolved absolute path when the filesystem cannot resolve it. A
// non-absolute input (or anything unresolvable to absolute) keys nothing.
function normalizeKey(checkoutPath) {
  try {
    if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) return null;
    try {
      return fs.realpathSync(checkoutPath);
    } catch {
      // Unresolvable (a checkout removed between listing and lookup):
      // the absolute spelling still keys the record lookup below.
    }
    if (path.isAbsolute(checkoutPath)) return path.resolve(checkoutPath);
    return null;
  } catch {
    return null;
  }
}

// Read the record file. Missing reads as empty; malformed content is
// treated as empty too (never thrown, never reported as an error):
// the warp then forks again and overwrites. Never throws.
function readWarpSessions(repoRoot) {
  try {
    let file;
    try {
      file = warpSessionsPath(repoRoot);
    } catch {
      return emptySessions();
    }
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err && err.code === 'ENOENT') return emptySessions();
      return emptySessions();
    }
    let doc;
    try {
      doc = JSON.parse(raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw);
    } catch {
      return emptySessions();
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)
      || typeof doc.sessions !== 'object' || doc.sessions === null || Array.isArray(doc.sessions)) {
      return emptySessions();
    }
    const sessions = {};
    for (const [key, entry] of Object.entries(doc.sessions)) {
      if (isRecordShape(entry)) {
        const point = asPoint(entry);
        sessions[key] = {
          sessionFile: entry.sessionFile,
          tipId: point.tipId,
          count: point.count,
          leafId: point.leafId,
          entryCount: point.entryCount,
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
        };
      }
    }
    const version = doc.version === undefined ? WARP_SESSIONS_VERSION : doc.version;
    return { ok: true, version, sessions, error: null };
  } catch {
    return emptySessions();
  }
}

// The recorded session for a checkout, or null when there is none, the
// record is corrupt, or the entry names no session file. Never throws:
// any failure reads as "no record", so the warp forks again.
function getWarpSession(repoRoot, checkoutPath) {
  try {
    const read = readWarpSessions(repoRoot);
    if (!read.ok) return null;
    const candidates = [];
    try {
      candidates.push(fs.realpathSync(checkoutPath));
    } catch {
      // Fall through to the absolute spelling below.
    }
    if (typeof checkoutPath === 'string' && path.isAbsolute(checkoutPath)) {
      try {
        candidates.push(path.resolve(checkoutPath));
      } catch {
        // No candidate: returns null below.
      }
    }
    for (const key of candidates) {
      const entry = read.sessions[key];
      if (isRecordShape(entry)) {
        const point = asPoint(entry);
        return {
          sessionFile: entry.sessionFile,
          tipId: point.tipId,
          count: point.count,
          leafId: point.leafId,
          entryCount: point.entryCount,
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
        };
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Atomically replace the record file: write a sibling temp file
// exclusively (`wx`) with an unpredictable suffix, then rename over the
// target. A pre-existing name is never followed or reused: on collision
// a new name is retried a bounded number of times, then the write is
// refused with a clear error. The temp file never survives the call.
function writeWarpSessionsAtomic(file, doc) {
  const payload = `${JSON.stringify(doc, null, 2)}\n`;
  let tmp = null;
  let wrote = false;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    let suffix;
    try {
      suffix = crypto.randomBytes(8).toString('hex');
    } catch (err) {
      throw new Error(`cannot write warp sessions: cannot generate a temporary file name: ${(err && err.message) || err}`);
    }
    tmp = `${file}.tmp.${process.pid}.${Date.now()}.${suffix}`;
    try {
      fs.writeFileSync(tmp, payload, { flag: 'wx' });
      wrote = true;
      break;
    } catch (err) {
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
    throw new Error('cannot write warp sessions: could not create a unique temporary file after 10 attempts; refusing to follow or reuse an existing path');
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

// Record (or overwrite) the session for a checkout. Never throws: every
// failure returns {ok: false} with a generic error naming no path, and
// the warp that already switched stays successful.
function recordWarpSession(repoRoot, checkoutPath, record) {
  try {
    const key = normalizeKey(checkoutPath);
    const sessionFile = record && typeof record.sessionFile === 'string' ? record.sessionFile : null;
    if (key === null || sessionFile === null || sessionFile.length === 0) {
      return { ok: false, error: 'cannot record warp session: checkout or session file is missing' };
    }
    const point = asPoint(record);
    const leafId = point.tipId;
    const entryCount = point.count;
    let file;
    try {
      file = warpSessionsPath(repoRoot);
    } catch {
      return { ok: false, error: 'cannot record warp session: repository identity unavailable' };
    }
    // Inspect the destination BEFORE writing: writeFileSync follows a
    // symlink, so a symlinked record file would overwrite its target. A
    // symlinked or non-regular destination is refused and nothing is
    // touched; the warp itself already succeeded.
    let stat = null;
    try {
      stat = fs.lstatSync(file);
    } catch (err) {
      if (!err || err.code !== 'ENOENT') {
        return { ok: false, error: 'cannot record warp session: destination unreadable' };
      }
    }
    if (stat) {
      if (stat.isSymbolicLink()) {
        return { ok: false, error: 'cannot record warp session: destination is a symlink; remove it first' };
      }
      if (!stat.isFile()) {
        return { ok: false, error: 'cannot record warp session: destination is not a regular file' };
      }
    }
    // Read-modify-write against the tolerant read: a malformed file is
    // replaced, never merged — the incoming record is the only
    // trustworthy data.
    const read = readWarpSessions(repoRoot);
    const sessions = read.ok ? { ...read.sessions } : {};
    sessions[key] = {
      sessionFile, tipId: leafId, count: entryCount,
      leafId, entryCount, updatedAt: new Date().toISOString(),
    };
    writeWarpSessionsAtomic(file, { version: WARP_SESSIONS_VERSION, sessions });
    return { ok: true, entry: sessions[key] };
  } catch (err) {
    return { ok: false, error: `cannot record warp session: ${(err && err.message) || err}` };
  }
}

module.exports = {
  WARP_SESSIONS_VERSION,
  WARP_SESSIONS_NAME,
  WARP_BOOKKEEPING_CUSTOM_TYPE,
  SESSION_WORKTREE_CUSTOM_TYPE,
  WARP_ANCESTOR_MAX_DEPTH,
  leafIdOfEntries,
  activeBranch,
  warpSessionsPath,
  readWarpSessions,
  getWarpSession,
  recordWarpSession,
  isWarpBookkeepingEntry,
  sessionPoint,
  samePoint,
  asPoint,
  pointOfSessionFile,
  topmostIdenticalAncestor,
};
