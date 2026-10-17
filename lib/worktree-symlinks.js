'use strict';
// Principal dot-dir symlinks for the worktree tools (customize-command
// T42/S51, amended twice: all-or-nothing tracked gate, completely silent).
//
// On every worktree creation, for each of `.agents`, `.claude` and
// `.odd`: when that entry exists in the PRINCIPAL checkout — the source
// is always the principal, never the current checkout — create a
// symlink to it inside the new worktree; when the new worktree already
// has an entry at that path, replace it with the symlink.
//
// ALL-OR-NOTHING GATE (amendment #1): the repository's tracked state
// (the principal's git state, read with `git ls-files`, never guessed)
// is checked first. When ANY of the three is tracked, NO symlink is
// created for any of them. Only when NONE of the three is tracked do
// the symlinks apply, one per name that exists in the principal.
//
// SILENCE (amendment #2): this step is an automatic side effect of
// creation — a hook, not a report. It adds NOTHING to the create
// tool's output in any branch. Outcomes travel in the returned object
// (and the caller's `details`) only.
//
// Safety: a symlink is never created whose target is missing (absent
// source, or a dangling source link, is skipped), and a failed git
// check fails closed (no symlinks, like the tracked case). Symlink
// creation itself is best-effort per name and never throws: a failed
// name is skipped and the others still apply.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const LINK_NAMES = ['.agents', '.claude', '.odd'];

// Names of LINK_NAMES tracked in the principal checkout, read from
// `git ls-files` (the index: staged-but-uncommitted counts as
// tracked). Returns null when git cannot answer, so the caller fails
// closed. Fixed argv, bounded timeout, never a shell string.
function trackedLinkNames(principalRoot) {
  let result;
  try {
    result = spawnSync('git', ['-C', principalRoot, 'ls-files', '--', ...LINK_NAMES], {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    });
  } catch {
    return null;
  }
  if (!result || result.error || typeof result.status !== 'number' || result.status !== 0) return null;
  const tracked = new Set();
  for (const line of String(result.stdout || '').split('\n')) {
    if (line.length === 0) continue;
    for (const name of LINK_NAMES) {
      if (line === name || line.startsWith(`${name}/`)) tracked.add(name);
    }
  }
  return [...tracked];
}

// True when the path resolves to something real (stat, not lstat: a
// dangling symlink reads as missing, so it can never become a target).
function resolvesToSomething(p) {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

// Apply the symlink step. Returns `{ created, skippedTracked }` where
// `created` names the symlinks now in place and `skippedTracked` names
// the gate-blocked entries (all three when the git check itself fails).
// Never throws.
function applyWorktreeSymlinks(opts = {}) {
  const principalRoot = opts.principalRoot;
  const worktreePath = opts.worktreePath;
  if (typeof principalRoot !== 'string' || principalRoot.length === 0) return { created: [], skippedTracked: [] };
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return { created: [], skippedTracked: [] };

  let tracked;
  try {
    tracked = trackedLinkNames(principalRoot);
  } catch {
    tracked = null;
  }
  if (tracked === null) return { created: [], skippedTracked: LINK_NAMES.slice() };
  if (tracked.length > 0) return { created: [], skippedTracked: tracked.slice() };

  const created = [];
  for (const name of LINK_NAMES) {
    const src = path.join(principalRoot, name);
    if (!resolvesToSomething(src)) continue;
    let isDir = false;
    try {
      isDir = fs.statSync(src).isDirectory();
    } catch {
      continue;
    }
    const dst = path.join(worktreePath, name);
    try {
      // rmSync on a symlink removes the link itself, never its target;
      // force means an absent destination is not an error.
      fs.rmSync(dst, { recursive: true, force: true });
      // Absolute target, so the link never depends on cwd spelling.
      // The type only matters on Windows ('junction' needs no privilege
      // for directories); POSIX ignores it.
      fs.symlinkSync(src, dst, isDir ? 'junction' : 'file');
      created.push(name);
    } catch {
      // Best effort per name: a failed entry never blocks the others
      // and never fails the creation.
    }
  }
  return { created, skippedTracked: [] };
}

module.exports = {
  LINK_NAMES,
  trackedLinkNames,
  applyWorktreeSymlinks,
};
