'use strict';
// Herdr workspace reconciliation for `worktree_close` (S33/S34, group-aware S35).
//
// Required order: after the close has warped a live session in the target
// checkout to the principal (S33 step 1), EVERY Herdr workspace belonging
// to that checkout's group is reconciled in order — the linked worktree
// workspaces that point at the checkout path FIRST, then the group's root —
// and only then a NORMAL workspace is opened at the principal path,
// resuming the session that was warped. Herdr exposes NO workspace path
// move (parent-verified: `herdr workspace` offers list, create --cwd,
// get, focus, rename, close; `herdr worktree` offers list/create/open/remove),
// so close-plus-reopen is the recorded fallback.
//
// Parent-verified live behaviour (S35): Herdr groups a root workspace with
// its linked worktree workspaces; closing a LINKED member succeeds while
// closing the ROOT with a linked member still open fails with
// `workspace_group_close_required`; once the linked members are closed the
// root closes normally. `herdr worktree remove --workspace <id> --force`
// answers `workspace_not_found` when the workspace is already gone, and
// `herdr workspace list` prints JSON by default — passing `--json` yields
// EMPTY output, so this module never passes it.
//
// Boundaries, all pinned in tools/worktree-close.test.js:
// - Only workspaces belonging to the removed checkout's group are ever
//   touched: the linked worktree workspaces whose list entry resolves
//   EXACTLY to the removed checkout, plus the group's root resolved
//   through `herdr workspace list`. A foreign workspace (another group, or
//   another checkout) is left alone. Relative list entries resolve against
//   the repository root, never the process cwd, for the comparison only.
// - Members close linked-first, root-last. A member that is already gone
//   (`workspace_not_found`) is tolerated without failing. Any other close
//   failure — including `workspace_group_close_required`, which is handled
//   into a friendly order message rather than surfaced raw — stops the
//   sequence with a partial-group report naming the failed member, and no
//   reopen is claimed. A failed reopen is likewise partial, never success.
// - Herdr being unavailable or erroring never blocks the removal: every
//   failure here reports {status: 'skipped' | 'reconciled-partial',
//   notice} with a short human-readable notice, and the caller still
//   removes the checkout. This module never throws.
// - Live-session detection (`agentsInCheckout`) reports positive evidence
//   only: an agent whose cwd is the checkout or inside it. A failing or
//   unparseable `herdr agent list` is no evidence, never a refusal.
//
// No static package imports (only node builtins), so the extension's
// copy-to-.mjs test loaders keep working. All Herdr I/O flows through an
// injected `run(argv, timeoutMs)` returning {status, stdout, stderr,
// error} (the shape lib/worktree-git.js runArgv returns); the extension
// supplies the runner bound to the Herdr binary and the repository root.
// Fixed argv only, values as separate elements — Herdr rejects
// --flag=value — and never --trust-repository.

const fs = require('node:fs');
const path = require('node:path');

const LIST_TIMEOUT_MS = 60000;
const MUTATE_TIMEOUT_MS = 120000;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Tolerant `herdr worktree list` parse: the real CLI prints
// {result: {worktrees: [...]}}; accept {worktrees: [...]}, {result: [...]}
// and a bare array too. Never throws: garbage reads as no list.
function parseWorktreeList(stdout) {
  try {
    if (typeof stdout !== 'string' || stdout.length === 0) return null;
    const doc = JSON.parse(stdout);
    if (doc && doc.result && Array.isArray(doc.result.worktrees)) return doc.result.worktrees;
    if (doc && Array.isArray(doc.worktrees)) return doc.worktrees;
    if (doc && Array.isArray(doc.result)) return doc.result;
    if (Array.isArray(doc)) return doc;
    return null;
  } catch {
    return null;
  }
}

function workspaceIdOf(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  for (const key of ['open_workspace_id', 'workspace_id', 'workspace', 'id']) {
    if (typeof item[key] === 'string' && item[key].length > 0) return item[key];
  }
  return null;
}

function resolveAgainstRepo(entryPath, repoRoot) {
  try {
    if (typeof entryPath !== 'string' || entryPath.length === 0) return null;
    if (path.isAbsolute(entryPath)) return path.resolve(entryPath);
    if (typeof repoRoot !== 'string' || repoRoot.length === 0) return null;
    return path.resolve(repoRoot, entryPath);
  } catch {
    return null;
  }
}

// The Herdr workspace entry pointing at the removed checkout, or null.
// Mirrors the extension's herdrWorkspaceId ambiguity rule: more than one
// entry resolving to the target with DIFFERENT ids — or a match without
// an id — resolves nothing, so a first-match win can never name a
// workspace that maps to another checkout. Never throws.
function workspaceEntryForPath(stdout, resolvedTarget, repoRoot) {
  try {
    // A non-absolute target can never name a checkout without resolving
    // against the process cwd, so it matches nothing.
    if (typeof resolvedTarget !== 'string' || !path.isAbsolute(resolvedTarget)) return null;
    const list = parseWorktreeList(stdout);
    if (!list) return null;
    let matched = 0;
    let missing = false;
    const ids = new Set();
    let entryPath = null;
    for (const item of list) {
      if (!item || typeof item.path !== 'string' || item.path.length === 0) continue;
      const resolved = resolveAgainstRepo(item.path, repoRoot);
      if (resolved === null || resolved !== resolvedTarget) continue;
      matched += 1;
      entryPath = item.path;
      const id = workspaceIdOf(item);
      if (id === null) missing = true;
      else ids.add(id);
    }
    if (matched === 0 || missing || ids.size !== 1) return null;
    return { id: [...ids][0], path: entryPath };
  } catch {
    return null;
  }
}

// Every identity an absolute checkout path can present: the resolved form
// plus the realpath when the filesystem still resolves it. Inputs are
// absolute, so path.resolve here never consults the process cwd.
function checkoutIdentities(absolutePath) {
  const ids = new Set();
  try {
    if (typeof absolutePath !== 'string' || !path.isAbsolute(absolutePath)) return ids;
    ids.add(path.resolve(absolutePath));
    try {
      ids.add(fs.realpathSync(absolutePath));
    } catch {
      // A removed checkout contributes only its spelling.
    }
  } catch {
    // No identity: matches nothing.
  }
  return ids;
}

function agentCwdOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  for (const key of ['cwd', 'foreground_cwd', 'path', 'working_directory', 'workingDirectory', 'directory']) {
    if (typeof entry[key] === 'string' && entry[key].length > 0) return entry[key];
  }
  return null;
}

function agentSessionOf(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  for (const key of ['session_id', 'sessionId', 'session', 'sessionFile']) {
    if (typeof entry[key] === 'string' && entry[key].length > 0) return entry[key];
  }
  return null;
}

// Tolerant `herdr agent list` parse: {result: {agents: [...)}},
// {agents: [...]}, {result: [...]}, or a bare array. Returns the agents
// whose cwd is the checkout or inside it — [{cwd, session}] with the raw
// cwd spelling — excluding our own session when both ids are known.
// A non-absolute cwd names nothing (it cannot be placed without guessing
// a base). Never throws: garbage reads as no evidence.
function agentsInCheckout(stdout, resolvedTarget, repoRoot, ourSession) {
  try {
    if (typeof resolvedTarget !== 'string' || !path.isAbsolute(resolvedTarget)) return [];
    let agents = null;
    try {
      if (typeof stdout !== 'string' || stdout.length === 0) return [];
      const doc = JSON.parse(stdout);
      if (doc && doc.result && Array.isArray(doc.result.agents)) agents = doc.result.agents;
      else if (doc && Array.isArray(doc.agents)) agents = doc.agents;
      else if (doc && Array.isArray(doc.result)) agents = doc.result;
      else if (Array.isArray(doc)) agents = doc;
      else return [];
    } catch {
      return [];
    }
    void repoRoot;
    const targetIds = checkoutIdentities(resolvedTarget);
    const ours = typeof ourSession === 'string' && ourSession.length > 0 ? ourSession : null;
    const found = [];
    for (const entry of asArray(agents)) {
      const cwd = agentCwdOf(entry);
      if (cwd === null || !path.isAbsolute(cwd)) continue;
      const session = agentSessionOf(entry);
      // Our own session is never foreign evidence.
      if (ours !== null && session !== null && session === ours) continue;
      const cwdIds = checkoutIdentities(cwd);
      let inside = false;
      for (const id of cwdIds) {
        // Exact identity (symlink-transparent through realpath), or
        // containment under the checkout by spelling.
        if (targetIds.has(id)) {
          inside = true;
          break;
        }
        for (const base of targetIds) {
          if (id.startsWith(`${base}${path.sep}`)) {
            inside = true;
            break;
          }
        }
        if (inside) break;
      }
      if (inside) found.push({ cwd, session });
    }
    return found;
  } catch {
    return [];
  }
}

// Best-effort synchronous run: a throwing runner reads as a failed call,
// never as an exception to the caller.
function tryRun(run, argv, timeoutMs) {
  try {
    const out = run(argv, timeoutMs);
    if (!out || typeof out !== 'object') return { status: 1, stdout: '', stderr: 'herdr call failed', error: null };
    return {
      status: typeof out.status === 'number' ? out.status : 1,
      stdout: typeof out.stdout === 'string' ? out.stdout : '',
      stderr: typeof out.stderr === 'string' ? out.stderr : '',
      error: out.error === undefined || out.error === null ? null : String(out.error),
    };
  } catch (err) {
    return { status: 1, stdout: '', stderr: '', error: (err && err.message) || String(err) };
  }
}

function failureReason(out) {
  const text = [out.error, out.stderr].filter((part) => typeof part === 'string' && part.trim().length > 0)[0];
  if (text) {
    const line = text.split('\n')[0].trim().replace(/\s+/g, ' ');
    return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  return `exit ${out.status}`;
}

// Tolerant `herdr workspace list` parse: the real CLI prints JSON by
// default (never pass `--json`: it yields empty output). Accept
// {result: {workspaces: [...]}}, {workspaces: [...]}, {result: [...]}
// and a bare array too. Never throws: garbage reads as no list.
function parseWorkspaceList(stdout) {
  try {
    if (typeof stdout !== 'string' || stdout.length === 0) return null;
    const doc = JSON.parse(stdout);
    if (doc && doc.result && Array.isArray(doc.result.workspaces)) return doc.result.workspaces;
    if (doc && Array.isArray(doc.workspaces)) return doc.workspaces;
    if (doc && Array.isArray(doc.result)) return doc.result;
    if (Array.isArray(doc)) return doc;
    return null;
  } catch {
    return null;
  }
}

// Every workspace id pointing at the removed checkout: ALL entries whose
// path resolves EXACTLY to the target and that carry an id. Unlike
// `workspaceEntryForPath` (which fails closed on conflicting ids for the
// single-remove path), the group reconcile closes every such member.
// Never throws: garbage reads as no member.
function workspaceEntriesForPath(stdout, resolvedTarget, repoRoot) {
  try {
    if (typeof resolvedTarget !== 'string' || !path.isAbsolute(resolvedTarget)) return [];
    const list = parseWorktreeList(stdout);
    if (!list) return [];
    const found = [];
    for (const item of list) {
      if (!item || typeof item.path !== 'string' || item.path.length === 0) continue;
      const resolved = resolveAgainstRepo(item.path, repoRoot);
      if (resolved === null || resolved !== resolvedTarget) continue;
      const id = workspaceIdOf(item);
      if (id === null) continue;
      found.push({ id, path: item.path });
    }
    return found;
  } catch {
    return [];
  }
}

// The group a workspace belongs to (LEGACY secondary signal only): the
// first non-empty string under any known group key. Live `herdr workspace
// list` entries carry NO such key (S36), so this resolves null there and
// must never be the only path — see `orderedGroupMembers`, which derives
// the group from `worktree.repo_key` first and consults this only when no
// entry names a repo_key. Null when the entry names no group.
function groupIdOf(item) {
  try {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    for (const key of ['group_id', 'groupId', 'workspace_group_id', 'workspaceGroupId']) {
      if (typeof item[key] === 'string' && item[key].length > 0) return item[key];
    }
    for (const key of ['group', 'workspace_group', 'workspaceGroup']) {
      const value = item[key];
      if (typeof value === 'string' && value.length > 0) return value;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        for (const inner of ['id', 'group_id', 'groupId']) {
          if (typeof value[inner] === 'string' && value[inner].length > 0) return value[inner];
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// The nested `worktree` object of a `workspace list` entry, or null.
// Live entries carry EXACTLY checkout_path, is_linked_worktree, repo_key,
// repo_name, repo_root here — and no group id anywhere (S36).
function worktreeInfoOf(item) {
  try {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const info = item.worktree;
    if (!info || typeof info !== 'object' || Array.isArray(info)) return null;
    return info;
  } catch {
    return null;
  }
}

// The repo group a `workspace list` entry belongs to: its
// `worktree.repo_key`. Null when it names none.
function repoKeyOf(item) {
  try {
    const info = worktreeInfoOf(item);
    if (!info) return null;
    return typeof info.repo_key === 'string' && info.repo_key.length > 0 ? info.repo_key : null;
  } catch {
    return null;
  }
}

// True when the entry is its group's ROOT: its `worktree.checkout_path`
// equals its own `worktree.repo_root` (equivalently
// `is_linked_worktree === false`). Entries that name neither order with
// the roots (closed last), so a root is never closed before a linked
// member. Never throws.
function isGroupRoot(item) {
  try {
    const info = worktreeInfoOf(item);
    if (!info) return true;
    const at = typeof info.checkout_path === 'string' && info.checkout_path.length > 0 ? info.checkout_path : null;
    const root = typeof info.repo_root === 'string' && info.repo_root.length > 0 ? info.repo_root : null;
    if (at !== null && root !== null) return at === root;
    if (info.is_linked_worktree === false) return true;
    if (info.is_linked_worktree === true) return false;
    return true;
  } catch {
    return true;
  }
}

// The checkout path a `workspace list` entry points at: its nested
// `worktree.checkout_path` first, then the first non-empty string under
// any known top-level cwd key. Null when it names none —
// such an entry can never prove membership by path, so it is ordered
// with the roots (closed last) when it shares the group.
function workspacePathOf(item) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const info = worktreeInfoOf(item);
  if (info && typeof info.checkout_path === 'string' && info.checkout_path.length > 0) return info.checkout_path;
  for (const key of ['cwd', 'path', 'directory', 'working_directory', 'workingDirectory', 'foreground_cwd', 'root']) {
    if (typeof item[key] === 'string' && item[key].length > 0) return item[key];
  }
  return null;
}

// Order the group's members for closing: linked members FIRST (sorted),
// then the group's root LAST (sorted). Membership derives from the fields
// that exist live (S36): EVERY workspace whose `worktree.repo_key` matches
// the target's belongs to the group; the ROOT is the member whose
// `worktree.checkout_path` equals its own `worktree.repo_root`
// (equivalently `is_linked_worktree === false`), and the linked members
// are the rest. A workspace whose repo_key does not match the target's is
// never returned — not even when a legacy group-id key says otherwise. The
// legacy group keys (`groupIdOf`) are only a fallback for entries that
// name no repo_key at all, and never the deciding signal when repo_key
// membership exists. When no group identity is available at all, the
// linked members alone (sorted) are returned. Never throws.
function orderedGroupMembers({ linkedIds, workspaceList, resolvedTarget, repoRoot }) {
  try {
    const linked = [...new Set((linkedIds || []).filter((id) => typeof id === 'string' && id.length > 0))].sort();
    if (linked.length === 0) return [];
    const list = Array.isArray(workspaceList) ? workspaceList : null;
    if (!list) return linked;
    const byId = new Map();
    for (const item of list) {
      const id = workspaceIdOf(item);
      if (id !== null && !byId.has(id)) byId.set(id, item);
    }
    const groups = new Set();
    const targetKeys = new Set();
    for (const id of linked) {
      if (!byId.has(id)) continue;
      const entry = byId.get(id);
      const key = repoKeyOf(entry);
      if (key !== null) targetKeys.add(key);
      const group = groupIdOf(entry);
      if (group !== null) groups.add(group);
    }
    // Primary signal: repo_key membership. Linked members first, then
    // same-key siblings that are not roots, then the root(s) last.
    if (targetKeys.size > 0) {
      const linkedSet = new Set(linked);
      const siblings = [];
      const roots = [];
      for (const [id, item] of byId) {
        if (linkedSet.has(id)) continue;
        const key = repoKeyOf(item);
        if (key === null || !targetKeys.has(key)) continue;
        if (isGroupRoot(item)) roots.push(id);
        else siblings.push(id);
      }
      siblings.sort();
      roots.sort();
      return [...linked, ...siblings, ...roots];
    }
    // Legacy fallback: no entry names a repo_key, so the legacy group
    // keys decide (pinned as secondary-only by the fallback test).
    if (groups.size === 0) return linked;
    const members = new Set(linked);
    for (const [id, item] of byId) {
      const group = groupIdOf(item);
      if (group !== null && groups.has(group)) members.add(id);
    }
    const linkedSet = new Set(linked);
    const isLinkedPath = (id) => {
      if (linkedSet.has(id)) return true;
      const entry = byId.get(id);
      const raw = entry ? workspacePathOf(entry) : null;
      if (raw === null) return false;
      const resolved = resolveAgainstRepo(raw, repoRoot);
      return resolved !== null && resolved === resolvedTarget;
    };
    const first = [...members].filter((id) => isLinkedPath(id)).sort();
    const rest = [...members].filter((id) => !isLinkedPath(id)).sort();
    return [...first, ...rest];
  } catch {
    return [...new Set(linkedIds || [])].sort();
  }
}

function combinedOutput(out) {
  try {
    return [out && out.stdout, out && out.stderr, out && out.error]
      .filter((part) => typeof part === 'string' && part.length > 0)
      .join('\n');
  } catch {
    return '';
  }
}

function hasCode(out, code) {
  try {
    return combinedOutput(out).includes(code);
  } catch {
    return false;
  }
}

// Friendly reason for a failed member close: the group-order violation is
// translated instead of dumping the raw error JSON. Every other failure
// keeps the short first-line reason. Never throws.
function memberCloseReason(out, id) {
  try {
    if (hasCode(out, 'workspace_group_close_required')) {
      return `workspace ${id} requires its linked workspaces to be closed first`;
    }
    return failureReason(out);
  } catch {
    return 'the close failed';
  }
}

// Tolerant `herdr workspace create` id parse: {result: {workspace:
// {workspace_id}}}, {workspace_id}, {id}, {result: {workspace_id}}. Null
// when the id cannot be read — the workspace was still created.
function parseWorkspaceCreateId(stdout) {
  try {
    if (typeof stdout !== 'string' || stdout.length === 0) return null;
    const doc = JSON.parse(stdout);
    const candidates = [
      doc && doc.result && doc.result.workspace,
      doc && doc.workspace,
      doc && doc.result,
      doc,
    ];
    for (const candidate of candidates) {
      const id = workspaceIdOf(candidate);
      if (id !== null) return id;
    }
    return null;
  } catch {
    return null;
  }
}

// Reconcile EVERY Herdr workspace of the removed checkout's group and
// open a single normal workspace at the principal path. `session`
// ({file, id}, either nullable) is the warped session now living in the
// principal; it is carried through to the result for the caller's details,
// never invented into Herdr flags. `force` forwards --force to each
// workspace close only when the caller asked for it. Never throws: every
// Herdr failure reports a skip (or a partial reconcile) with a short
// notice, and the caller still removes the checkout.
function reconcileHerdrWorkspace({ run, repoRoot, resolvedTarget, principalPath, session, force }) {
  const carried = {
    file: session && typeof session.file === 'string' ? session.file : null,
    id: session && typeof session.id === 'string' ? session.id : null,
  };
  try {
    if (typeof run !== 'function') {
      return { status: 'skipped', notice: 'herdr workspace step skipped (herdr is unavailable)' };
    }
    const listed = tryRun(run, ['worktree', 'list', '--cwd', repoRoot], LIST_TIMEOUT_MS);
    if (listed.status !== 0) {
      return { status: 'skipped', notice: `herdr workspace step skipped (the workspace lookup failed: ${failureReason(listed)})` };
    }
    const linked = workspaceEntriesForPath(listed.stdout, resolvedTarget, repoRoot);
    if (linked.length === 0) {
      // No workspace points at this checkout: preserve the historical
      // single-entry ambiguity rule (a match without an id resolves
      // nothing) by treating it as absent too.
      return { status: 'absent' };
    }
    // Resolve the whole group through `herdr workspace list`, which prints
    // JSON by default — never pass `--json` (it yields empty output).
    // A failed or unparseable workspace list degrades to the linked
    // members alone rather than skipping: Herdr being unavailable never
    // blocks the removal, and the linked members are still reconciled.
    let members = linked.map((entry) => entry.id).sort();
    const grouped = tryRun(run, ['workspace', 'list'], LIST_TIMEOUT_MS);
    if (grouped.status === 0) {
      const workspaces = parseWorkspaceList(grouped.stdout);
      if (workspaces !== null) {
        members = orderedGroupMembers({
          linkedIds: members, workspaceList: workspaces,
          resolvedTarget, repoRoot,
        });
      }
    }
    if (members.length === 0) return { status: 'absent' };
    const closedWorkspaces = [];
    for (const id of members) {
      const closeArgv = ['workspace', 'close', '--workspace', id];
      if (force === true) closeArgv.push('--force');
      const closed = tryRun(run, closeArgv, MUTATE_TIMEOUT_MS);
      if (closed.status !== 0) {
        // An already-closed member reconciles as gone: keep going.
        if (hasCode(closed, 'workspace_not_found')) {
          closedWorkspaces.push(id);
          continue;
        }
        // Any other member failure leaves the group half-closed: name the
        // member, say the group is partially reconciled, claim no reopen.
        return {
          status: 'reconciled-partial', closedWorkspaces: [...closedWorkspaces],
          closedWorkspace: closedWorkspaces.length > 0 ? closedWorkspaces[0] : null,
          failedWorkspace: id, openedWorkspace: null, session: carried,
          notice: `herdr workspace step partially reconciled (could not close workspace ${id}: ${memberCloseReason(closed, id)})`,
        };
      }
      closedWorkspaces.push(id);
    }
    const created = tryRun(run, ['workspace', 'create', '--cwd', principalPath, '--no-focus'], MUTATE_TIMEOUT_MS);
    if (created.status !== 0) {
      return {
        status: 'reconciled-partial', closedWorkspaces: [...closedWorkspaces],
        closedWorkspace: closedWorkspaces.length > 0 ? closedWorkspaces[0] : null,
        openedWorkspace: null,
        session: carried,
        notice: `herdr workspace step partially reconciled (opening a workspace at the principal failed: ${failureReason(created)})`,
      };
    }
    return {
      status: 'reconciled', closedWorkspaces: [...closedWorkspaces],
      closedWorkspace: closedWorkspaces.length > 0 ? closedWorkspaces[0] : null,
      openedWorkspace: parseWorkspaceCreateId(created.stdout), session: carried,
    };
  } catch (err) {
    return { status: 'skipped', notice: `herdr workspace step skipped (${(err && err.message) || err})` };
  }
}

module.exports = {
  workspaceEntryForPath,
  workspaceEntriesForPath,
  orderedGroupMembers,
  parseWorkspaceList,
  agentsInCheckout,
  reconcileHerdrWorkspace,
  parseWorkspaceCreateId,
};
