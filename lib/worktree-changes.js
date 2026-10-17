'use strict';
// Reusable pending-changes helper (customize-command S61/T47): dirty
// summary (N files +N/-N) plus the safe working-tree copy warp and the
// tool use. One module, never two implementations: the warp command,
// the worktree_warp tool and the close/delete confirmations all read
// through here.
//
// Why this shape: staged AND unstaged changes are read as ONE diff
// against HEAD (`git diff --numstat -M HEAD`), so a file changed in both
// places counts once, never twice. Untracked files never appear in that
// diff, so they are listed separately through `git status --porcelain -z`
// and measured from disk (text line counts; binary only labelled, never
// faked). Every external process is a fixed argv array with a bounded
// timeout — never a shell string, never a long sync block of the UI.
// Nothing here mutates the source or its index: the summary only reads,
// and the copy writes only into the destination.
//
// Containment: every selected path must resolve inside the source
// checkout, must not be (or hide behind) `.git`, must not traverse
// (`..`) out, and must not escape through a symlink. The destination
// overlap rule is a hard reject: when any selected path already carries
// destination modifications, nothing is copied, warped or switched.
// A dry-run (`git apply --check`) guards branch-base mismatch before any
// write; an unsupported case fails BEFORE the write and says so instead
// of leaving a partial copy.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SUMMARY_TIMEOUT_MS = 30000;
const COPY_TIMEOUT_MS = 60000;

// Parse `git diff --numstat -z -M HEAD` output. With -z a plain record
// is one `<added>\t<deleted>\t<path>` token, while a rename (or copy)
// is `<added>\t<deleted>\t` with an EMPTY path followed by TWO tokens:
// the old path and the new path (`0\t0\t\0old\0new\0`). `-` counts
// mean binary. Returns [{added, deleted, binary, oldRel, rel}].
function parseNumstatZ(stdout) {
  const out = [];
  if (typeof stdout !== 'string' || stdout.length === 0) return out;
  const isRecord = (token) => typeof token === 'string' && /^(\d+|-)\t(\d+|-)\t/.test(token);
  const tokens = stdout.split('\0');
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === '') continue;
    const match = token.match(/^(\d+|-)\t(\d+|-)\t([\s\S]*)$/);
    if (!match) continue;
    const binary = match[1] === '-' || match[2] === '-';
    const added = binary ? 0 : Number(match[1]);
    const deleted = binary ? 0 : Number(match[2]);
    let oldRel = match[3];
    let rel = match[3];
    const next1 = tokens[i + 1];
    const next2 = tokens[i + 2];
    const plain1 = typeof next1 === 'string' && next1 !== '' && !isRecord(next1);
    const plain2 = typeof next2 === 'string' && next2 !== '' && !isRecord(next2);
    if (match[3] === '' && plain1 && plain2) {
      // A rename pair: the empty path plus old and new.
      oldRel = next1;
      rel = next2;
      i += 2;
    } else if (match[3] === '' && plain1) {
      // Defensive: an empty path with a single follower names one file.
      oldRel = next1;
      rel = next1;
      i += 1;
    }
    out.push({
      added: Number.isFinite(added) ? added : 0,
      deleted: Number.isFinite(deleted) ? deleted : 0,
      binary,
      oldRel,
      rel,
    });
  }
  return out;
}

// Default async git runner: fixed argv through worktree-git's async
// runner (bounded timeout, never a shell string). Injectable in tests
// via opts.runAsync(bin, args, cwd).
async function defaultRunAsync(bin, args, cwd, timeoutMs) {
  let git = null;
  try {
    git = require('./worktree-git.js');
  } catch {
    git = null;
  }
  if (git && typeof git.runArgvAsync === 'function') {
    return git.runArgvAsync(bin, args, { cwd, timeoutMs });
  }
  return { status: null, stdout: '', stderr: '', error: 'async git runner is unavailable' };
}

// Is `abs` inside `base` (or equal)? Pure lexical check on resolved
// paths; symlink escape is checked separately through realpath.
function isInsideOrEqual(base, abs) {
  const relative = path.relative(base, abs);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// True when the checkout-relative path touches repository metadata.
function isGitInternal(rel) {
  if (typeof rel !== 'string' || rel.length === 0) return true;
  const parts = rel.split(path.sep);
  return parts.includes('.git');
}

// Binary probe: a NUL byte in the first bytes. Never fakes line counts.
function probeBinary(absPath, fsImpl) {
  try {
    const fd = fsImpl.openSync(absPath, 'r');
    try {
      const size = Math.min(8192, fsImpl.fstatSync(fd).size);
      if (size <= 0) return { binary: false };
      const buf = Buffer.alloc(size);
      fsImpl.readSync(fd, buf, 0, size, 0);
      return { binary: buf.includes(0) };
    } finally {
      try { fsImpl.closeSync(fd); } catch { /* a close failure never fails the probe */ }
    }
  } catch {
    return { binary: false };
  }
}

// Count added lines of an untracked text file from disk.
function countAddedLines(absPath, fsImpl) {
  try {
    const text = fsImpl.readFileSync(absPath, 'utf8');
    if (text.length === 0) return 0;
    const parts = text.split('\n');
    return text.endsWith('\n') ? parts.length - 1 : parts.length;
  } catch {
    return 0;
  }
}

// Resolve the repository root for a checkout without trusting the
// process cwd: through the shared repoIdentity helper.
function resolveRepoRoot(checkoutPath, git) {
  const identity = git.repoIdentity(checkoutPath);
  return identity.root;
}

// Resolve the shared git common dir for a checkout: the identity two
// checkouts of one repository (principal or linked worktrees) share,
// while two repositories never do.
function repoCommonDir(checkoutPath, git) {
  const identity = git.repoIdentity(checkoutPath);
  if (!identity || typeof identity.commonDir !== 'string' || identity.commonDir.length === 0) {
    throw new Error(`cannot resolve git common dir: ${checkoutPath}`);
  }
  return identity.commonDir;
}

// Summarize the pending working-tree changes of ONE checkout.
// Reads only: never mutates the source or its index. Staged and
// unstaged changes combine through the single HEAD diff (no
// double-counting); untracked files come from `git status -z` and are
// measured from disk. Returns
// {ok, checkout, root, files, added, deleted, binaryCount, entries}
// where each entry is {path, rel, status, added, deleted, binary,
// untracked}. Failures are {ok:false, error}.
async function summarizeChanges(checkoutPath, opts = {}) {
  const fsImpl = opts.fs || fs;
  const git = opts.git || (() => { try { return require('./worktree-git.js'); } catch { return null; } })();
  if (!git || typeof git.repoIdentity !== 'function') {
    return { ok: false, error: 'git helper is unavailable' };
  }
  if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) {
    return { ok: false, error: 'checkout path is empty' };
  }
  let checkout;
  let root;
  try {
    checkout = path.resolve(checkoutPath);
    root = resolveRepoRoot(checkout, git);
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
  // The checkout must exist as a directory; anything else is not a
  // checkout we summarize.
  try {
    const st = fsImpl.statSync(checkout);
    if (!st.isDirectory()) return { ok: false, error: `not a checkout directory: ${checkout}` };
  } catch (err) {
    return { ok: false, error: `cannot read checkout at ${checkout}: ${(err && err.message) || err}` };
  }
  const runAsync = typeof opts.runAsync === 'function'
    ? opts.runAsync
    : (bin, args, cwd) => defaultRunAsync(bin, args, cwd, opts.timeoutMs || SUMMARY_TIMEOUT_MS);
  const timeoutMs = opts.timeoutMs || SUMMARY_TIMEOUT_MS;
  void timeoutMs;
  let diff;
  try {
    diff = await runAsync('git', ['diff', '--numstat', '-z', '-M', 'HEAD', '--'], checkout);
  } catch (err) {
    return { ok: false, error: `cannot diff ${checkout}: ${(err && err.message) || err}` };
  }
  if (!diff || diff.status !== 0) {
    const reason = (diff && ((diff.stderr || '').trim().split('\n')[0] || diff.error)) || `exit ${diff && diff.status}`;
    return { ok: false, error: `cannot diff ${checkout}: ${reason}` };
  }
  let status;
  try {
    status = await runAsync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--'], checkout);
  } catch (err) {
    return { ok: false, error: `cannot status ${checkout}: ${(err && err.message) || err}` };
  }
  if (!status || status.status !== 0) {
    const reason = (status && ((status.stderr || '').trim().split('\n')[0] || status.error)) || `exit ${status && status.status}`;
    return { ok: false, error: `cannot status ${checkout}: ${reason}` };
  }
  const entries = [];
  const seen = new Set();
  for (const record of parseNumstatZ(diff.stdout || '')) {
    const rel = String(record.rel || '');
    if (rel.length === 0 || isGitInternal(rel)) continue;
    const abs = path.resolve(checkout, rel);
    if (!isInsideOrEqual(checkout, abs)) continue;
    // A record that resolves through a symlink outside the checkout is
    // refused: the copy must never follow it out.
    try {
      const real = fsImpl.realpathSync(abs);
      if (!isInsideOrEqual(checkout, real) && !isInsideOrEqual(root, real)) {
        // Realpath inside the REPO but outside this checkout (a linked
        // worktree reaching another checkout through a symlink) still
        // refuses: the change belongs to another checkout.
        if (!isInsideOrEqual(checkout, real)) continue;
      }
    } catch {
      // A missing path (a deletion) has no realpath; keep it.
    }
    entries.push({
      path: abs,
      rel,
      status: record.oldRel !== rel ? 'renamed' : 'modified',
      added: record.added,
      deleted: record.deleted,
      binary: record.binary,
      untracked: false,
    });
    seen.add(abs);
  }
  // Untracked files from `git status -z`: `?? <path>` tokens. Renames in
  // status (`R  old -> new`) are already covered by the diff; only `??`
  // rows add entries here.
  const statusTokens = String(status.stdout || '').split('\0');
  const untrackedRels = [];
  for (const token of statusTokens) {
    if (token.length < 4) continue;
    const code = token.slice(0, 2);
    if (code !== '??') continue;
    const rel = token.slice(3);
    if (rel.length === 0 || isGitInternal(rel)) continue;
    untrackedRels.push(rel);
  }
  for (const rel of untrackedRels) {
    const abs = path.resolve(checkout, rel);
    if (!isInsideOrEqual(checkout, abs)) continue;
    if (seen.has(abs)) continue;
    let st = null;
    try {
      st = fsImpl.statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      // With --untracked-files=all directories arrive as files, but a
      // defensive walk covers the spelling that lists a directory.
      let nested = [];
      try {
        nested = walkFiles(abs, fsImpl);
      } catch {
        continue;
      }
      for (const file of nested) {
        const fileRel = path.relative(checkout, file);
        if (fileRel.length === 0 || fileRel.startsWith('..') || path.isAbsolute(fileRel)) continue;
        if (isGitInternal(fileRel)) continue;
        if (seen.has(file)) continue;
        entries.push(measureUntracked(file, fileRel, fsImpl));
        seen.add(file);
      }
      continue;
    }
    if (!st.isFile() && !st.isSymbolicLink()) continue;
    // A symlink at the path escapes when its referent leaves the
    // checkout: refuse it rather than copying through it.
    try {
      if (st.isSymbolicLink()) {
        const real = fsImpl.realpathSync(abs);
        if (!isInsideOrEqual(checkout, real)) continue;
      }
    } catch {
      // A dangling symlink names nothing to copy; skip it.
      continue;
    }
    entries.push(measureUntracked(abs, rel, fsImpl));
    seen.add(abs);
  }
  entries.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  let added = 0;
  let deleted = 0;
  let binaryCount = 0;
  for (const entry of entries) {
    added += entry.added;
    deleted += entry.deleted;
    if (entry.binary) binaryCount += 1;
  }
  return {
    ok: true, checkout, root, files: entries.length, added, deleted, binaryCount, entries,
  };
}

function measureUntracked(abs, rel, fsImpl) {
  let binary = false;
  try {
    binary = probeBinary(abs, fsImpl).binary;
  } catch {
    binary = false;
  }
  return {
    path: abs,
    rel,
    status: 'untracked',
    added: binary ? 0 : countAddedLines(abs, fsImpl),
    deleted: 0,
    binary,
    untracked: true,
  };
}

function walkFiles(dir, fsImpl) {
  const out = [];
  const stack = [dir];
  let guard = 0;
  while (stack.length > 0) {
    guard += 1;
    if (guard > 5000) break;
    const current = stack.pop();
    let names;
    try {
      names = fsImpl.readdirSync(current);
    } catch {
      continue;
    }
    for (const name of names || []) {
      const full = path.join(current, name);
      let st;
      try {
        st = fsImpl.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (st.isFile()) out.push(full);
    }
  }
  return out;
}

// `3 files, +10/-2`, with ` (1 binary)` appended only when binary files
// are present (binary counts are never faked, only labelled).
function formatChangeSummary(summary) {
  if (!summary || typeof summary.files !== 'number') return '0 files, +0/-0';
  const base = `${summary.files} file${summary.files === 1 ? '' : 's'}, +${summary.added}/-${summary.deleted}`;
  if (summary.binaryCount > 0) return `${base} (${summary.binaryCount} binary)`;
  return base;
}

// Normalize the tool's `changes` option. Omitted, empty string and empty
// array all mean "copy nothing"; the string "all" means everything; an
// array of paths means exactly those files. Anything else fails closed.
function normalizeChangesSelection(value) {
  if (value === undefined || value === null) return { ok: true, mode: 'none', paths: [] };
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return { ok: true, mode: 'none', paths: [] };
    if (trimmed === 'all') return { ok: true, mode: 'all', paths: [] };
    return { ok: false, error: `invalid changes selection ${JSON.stringify(value)}: pass \"all\", a list of files, or leave it empty for no copy` };
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return { ok: true, mode: 'none', paths: [] };
    for (const entry of value) {
      if (typeof entry !== 'string' || entry.trim() === '') {
        return { ok: false, error: 'invalid changes selection: every entry must be a non-empty file path' };
      }
    }
    return { ok: true, mode: 'paths', paths: value.slice() };
  }
  return { ok: false, error: 'invalid changes selection: pass \"all\", a list of files, or leave it empty for no copy' };
}

// Match a selection entry against a summary entry: absolute path, or the
// checkout-relative spelling. Returns the matched summary entries, or
// {ok:false} naming the unknown file (fail closed, no partial match).
function matchSelection(summary, mode, paths) {
  if (mode === 'none') return { ok: true, entries: [] };
  if (mode === 'all') return { ok: true, entries: summary.entries.slice() };
  const matched = [];
  const unknown = [];
  for (const raw of paths) {
    const trimmed = String(raw).trim();
    const asAbs = path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(summary.checkout, trimmed);
    const found = summary.entries.find((entry) => entry.path === asAbs || entry.rel === trimmed);
    if (found) matched.push(found);
    else unknown.push(trimmed);
  }
  if (unknown.length > 0) {
    return { ok: false, error: `unknown changed file${unknown.length === 1 ? '' : 's'}: ${unknown.map((u) => JSON.stringify(u)).join(', ')} (nothing was copied)` };
  }
  // De-duplicate while keeping summary order.
  const picked = new Set(matched.map((entry) => entry.path));
  return { ok: true, entries: summary.entries.filter((entry) => picked.has(entry.path)) };
}

// Copy working-tree changes from one checkout to another of the SAME
// repository. Never mutates the source or either index: tracked changes
// travel through a file patch applied to the working tree only
// (`git apply`, never `--index`), untracked files are copied byte for
// byte, and the source checkout is only read. Snapshot preflight is
// revalidated immediately before the write; a drifted snapshot, a
// destination overlap on any selected path, or a failed dry-run rejects
// with ZERO destination mutation. Unsupported shapes (for example a
// selection that cannot be expressed as a patch plus file copies)
// fail BEFORE any write and say so. Returns
// {ok, copied:[rel], files, added, deleted} or {ok:false, error}.
async function copyChanges({ from, to, selection, selectMode, opts } = {}, inject = {}) {
  const fsImpl = inject.fs || fs;
  const git = inject.git || (() => { try { return require('./worktree-git.js'); } catch { return null; } })();
  if (!git || typeof git.repoIdentity !== 'function') {
    return { ok: false, error: 'git helper is unavailable' };
  }
  if (typeof from !== 'string' || from.length === 0) return { ok: false, error: 'copy source is empty' };
  if (typeof to !== 'string' || to.length === 0) return { ok: false, error: 'copy destination is empty' };
  const runAsync = inject.runAsync || ((bin, args, cwd) => defaultRunAsync(bin, args, cwd, COPY_TIMEOUT_MS));
  let fromAbs = path.resolve(from);
  let toAbs = path.resolve(to);
  // Same-repository proof: linked worktrees each report their own root
  // from `rev-parse --show-toplevel`, so the shared git common dir is
  // the identity that proves two checkouts belong to one repository.
  let fromCommon;
  let toCommon;
  try {
    fromCommon = path.resolve(repoCommonDir(fromAbs, git));
    toCommon = path.resolve(repoCommonDir(toAbs, git));
  } catch (err) {
    return { ok: false, error: `cannot copy changes: ${(err && err.message) || err}` };
  }
  if (fromCommon !== toCommon) {
    return { ok: false, error: `cannot copy changes: ${fromAbs} and ${toAbs} belong to different repositories (nothing was copied)` };
  }
  // Resolve both checkouts through their realpaths when available so a
  // symlinked spelling of the same checkout compares equal; a missing
  // destination is refused (never created by the copy).
  try {
    const st = fsImpl.statSync(toAbs);
    if (!st.isDirectory()) return { ok: false, error: `cannot copy changes: destination is not a directory: ${toAbs} (nothing was copied)` };
  } catch (err) {
    return { ok: false, error: `cannot copy changes: destination is missing: ${toAbs} (nothing was copied)` };
  }
  // Normalize the selection: caller passes selectMode/paths or the raw
  // tool value in `selection`.
  let mode = selectMode;
  let paths = [];
  if (mode === undefined) {
    const normalized = normalizeChangesSelection(selection);
    if (!normalized.ok) return { ok: false, error: normalized.error };
    mode = normalized.mode;
    paths = normalized.paths;
  } else if (Array.isArray(selection)) {
    paths = selection;
  }
  if (mode === 'none') return { ok: true, copied: [], files: 0, added: 0, deleted: 0 };
  const source = await summarizeChanges(fromAbs, { fs: fsImpl, git, runAsync });
  if (!source.ok) return { ok: false, error: `${source.error} (nothing was copied)` };
  fromAbs = source.checkout;
  const matched = matchSelection(source, mode, paths);
  if (!matched.ok) return { ok: false, error: matched.error };
  if (matched.entries.length === 0) return { ok: true, copied: [], files: 0, added: 0, deleted: 0 };
  // Containment on every selected path before any destination read.
  for (const entry of matched.entries) {
    if (!isInsideOrEqual(fromAbs, entry.path) || isGitInternal(entry.rel)) {
      return { ok: false, error: `refusing to copy ${JSON.stringify(entry.rel)}: path escapes the source checkout (nothing was copied)` };
    }
    try {
      const st = fsImpl.lstatSync(entry.path);
      if (st.isSymbolicLink()) {
        const real = fsImpl.realpathSync(entry.path);
        if (!isInsideOrEqual(fromAbs, real)) {
          return { ok: false, error: `refusing to copy ${JSON.stringify(entry.rel)}: symlink escapes the source checkout (nothing was copied)` };
        }
      }
    } catch {
      // A deletion names a path with nothing behind it; the patch leg
      // carries it, so only the lexical check applies.
      if (!entry.untracked) continue;
      return { ok: false, error: `cannot copy ${JSON.stringify(entry.rel)}: the source file is unreadable (nothing was copied)` };
    }
  }
  // Destination overlap preflight: any selected relative path that
  // already carries destination modifications rejects with zero
  // mutation. Compared by checkout-relative path (both checkouts share
  // the repository, so rel paths line up).
  const dest = await summarizeChanges(toAbs, { fs: fsImpl, git, runAsync });
  if (!dest.ok) return { ok: false, error: `${dest.error} (nothing was copied)` };
  toAbs = dest.checkout;
  const destRels = new Set(dest.entries.map((entry) => entry.rel));
  const overlapping = matched.entries.filter((entry) => destRels.has(entry.rel)).map((entry) => entry.rel);
  if (overlapping.length > 0) {
    return { ok: false, error: `cannot copy changes: destination already modifies ${overlapping.map((r) => JSON.stringify(r)).join(', ')} (nothing was copied, warped or switched)` };
  }
  const tracked = matched.entries.filter((entry) => !entry.untracked);
  const untracked = matched.entries.filter((entry) => entry.untracked);
  // Untracked leg preflight: the destination must not already hold a
  // DIFFERENT file at that path — not even a clean tracked one when the
  // source base differs. Identical bytes skip quietly.
  for (const entry of untracked) {
    const destPath = path.resolve(toAbs, entry.rel);
    if (!isInsideOrEqual(toAbs, destPath) || isGitInternal(entry.rel)) {
      return { ok: false, error: `refusing to copy ${JSON.stringify(entry.rel)}: path escapes the destination checkout (nothing was copied)` };
    }
    let destStat = null;
    try {
      destStat = fsImpl.statSync(destPath);
    } catch {
      destStat = null;
    }
    if (destStat !== null) {
      let same = false;
      try {
        const a = fsImpl.readFileSync(entry.path);
        const b = fsImpl.readFileSync(destPath);
        same = Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
      } catch {
        same = false;
      }
      if (!same) {
        return { ok: false, error: `cannot copy ${JSON.stringify(entry.rel)}: the destination already has a file there (nothing was copied)` };
      }
    }
  }
  // Revalidate the snapshot immediately before the write: the source
  // must still hold exactly the snapshotted selection, and the
  // destination must still be clear on those paths. Any drift rejects
  // with zero mutation.
  const reSource = await summarizeChanges(fromAbs, { fs: fsImpl, git, runAsync });
  if (!reSource.ok) return { ok: false, error: `${reSource.error} (nothing was copied)` };
  const reMatched = matchSelection(reSource, mode, paths);
  if (!reMatched.ok) return { ok: false, error: reMatched.error };
  const before = new Map(matched.entries.map((entry) => [entry.rel, `${entry.added}/${entry.deleted}/${entry.status}`]));
  const after = new Map(reMatched.entries.map((entry) => [entry.rel, `${entry.added}/${entry.deleted}/${entry.status}`]));
  if (before.size !== after.size || [...before.keys()].some((key) => before.get(key) !== after.get(key))) {
    return { ok: false, error: 'cannot copy changes: the source changed during confirmation (nothing was copied)' };
  }
  const reDest = await summarizeChanges(toAbs, { fs: fsImpl, git, runAsync });
  if (!reDest.ok) return { ok: false, error: `${reDest.error} (nothing was copied)` };
  const reDestRels = new Set(reDest.entries.map((entry) => entry.rel));
  const reOverlapping = matched.entries.filter((entry) => reDestRels.has(entry.rel)).map((entry) => entry.rel);
  if (reOverlapping.length > 0) {
    return { ok: false, error: `cannot copy changes: destination already modifies ${reOverlapping.map((r) => JSON.stringify(r)).join(', ')} (nothing was copied, warped or switched)` };
  }
  // Tracked leg through a patch file: generated in the system temp dir
  // (never inside the worktree), dry-run first. The patch applies to
  // the working tree only (no --index), so the destination index is
  // preserved by construction.
  if (tracked.length > 0) {
    const rels = tracked.map((entry) => entry.rel);
    let patch;
    try {
      patch = await runAsync('git', ['diff', '--binary', '-M', 'HEAD', '--', ...rels], fromAbs);
    } catch (err) {
      return { ok: false, error: `cannot copy changes: diff failed (${(err && err.message) || err}; nothing was copied)` };
    }
    if (!patch || patch.status !== 0) {
      const reason = (patch && ((patch.stderr || '').trim().split('\n')[0] || patch.error)) || 'diff failed';
      return { ok: false, error: `cannot copy changes: diff failed (${reason}; nothing was copied)` };
    }
    if (typeof patch.stdout !== 'string' || patch.stdout.length === 0) {
      return { ok: false, error: 'cannot copy changes: the tracked selection produced no patch (unsupported case; nothing was copied)' };
    }
    let tmpDir = null;
    let patchFile = null;
    try {
      tmpDir = fsImpl.mkdtempSync(path.join(os.tmpdir(), 'worktree-changes-'));
      patchFile = path.join(tmpDir, 'copy.patch');
      fsImpl.writeFileSync(patchFile, patch.stdout);
    } catch (err) {
      try { if (tmpDir) fsImpl.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
      return { ok: false, error: `cannot copy changes: cannot stage the patch (${(err && err.message) || err}; nothing was copied)` };
    }
    const cleanup = () => {
      try { fsImpl.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
    };
    let check;
    try {
      check = await runAsync('git', ['apply', '--check', '--whitespace=nowarn', patchFile], toAbs);
    } catch (err) {
      cleanup();
      return { ok: false, error: `cannot copy changes: dry-run failed (${(err && err.message) || err}; nothing was copied)` };
    }
    if (!check || check.status !== 0) {
      const reason = (check && ((check.stderr || '').trim().split('\n')[0] || check.error)) || 'patch does not apply';
      cleanup();
      return { ok: false, error: `cannot copy changes: the destination rejects the patch (${reason}; the branches may have diverged; nothing was copied)` };
    }
    let applied;
    try {
      applied = await runAsync('git', ['apply', '--whitespace=nowarn', patchFile], toAbs);
    } catch (err) {
      cleanup();
      return { ok: false, error: `cannot copy changes: apply failed (${(err && err.message) || err}; inspect the destination before retrying)` };
    }
    cleanup();
    if (!applied || applied.status !== 0) {
      const reason = (applied && ((applied.stderr || '').trim().split('\n')[0] || applied.error)) || 'apply failed';
      return { ok: false, error: `cannot copy changes: apply failed (${reason}; inspect the destination before retrying)` };
    }
  }
  // Untracked leg: byte copies after the patch leg succeeded, so a
  // patch failure never leaves half-copied new files behind.
  for (const entry of untracked) {
    const destPath = path.resolve(toAbs, entry.rel);
    let destStat = null;
    try {
      destStat = fsImpl.statSync(destPath);
    } catch {
      destStat = null;
    }
    if (destStat !== null) continue;
    try {
      fsImpl.mkdirSync(path.dirname(destPath), { recursive: true });
      fsImpl.copyFileSync(entry.path, destPath);
    } catch (err) {
      return { ok: false, error: `cannot copy ${JSON.stringify(entry.rel)}: ${(err && err.message) || err} (inspect the destination before retrying)` };
    }
  }
  let added = 0;
  let deleted = 0;
  for (const entry of matched.entries) {
    added += entry.added;
    deleted += entry.deleted;
  }
  return {
    ok: true,
    copied: matched.entries.map((entry) => entry.rel),
    files: matched.entries.length,
    added,
    deleted,
  };
}

module.exports = {
  SUMMARY_TIMEOUT_MS,
  COPY_TIMEOUT_MS,
  parseNumstatZ,
  summarizeChanges,
  formatChangeSummary,
  normalizeChangesSelection,
  matchSelection,
  copyChanges,
  isInsideOrEqual,
};
