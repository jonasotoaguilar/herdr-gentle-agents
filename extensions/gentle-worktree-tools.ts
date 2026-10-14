// @ts-nocheck
// gentle-worktree-tools.ts — agent worktree tools (Pi extension, P2-S4).
//
// Registers three tools: `worktree_create` (validate + herdr-first
// creation with hooks), `worktree_list` (read-only, no approval prompt),
// and `worktree_close` (remove the checkout, keep the branch). Create and
// close prompt for approval when the host offers dialog UI; list never
// mutates anything.
//
// The file is plain JavaScript with a .ts extension (// @ts-nocheck, no
// type annotations), exactly like extensions/gentle-herdr-state.ts, so the
// test copy-to-.mjs loading pattern keeps working under plain node.

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

// Package-side helpers live in lib/. Tests point GENTLE_WORKTREE_LIB_DIR
// at the real lib dir before importing the copied module; production
// resolves relative to this file.
function libRequire(name) {
  const override = process.env.GENTLE_WORKTREE_LIB_DIR;
  const dir = typeof override === "string" && override.length > 0
    ? override
    : path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib");
  return require(path.join(dir, name));
}

// The herdr binary honors the documented HERDR_BIN_PATH override (tests),
// else `herdr` on PATH — the same convention lib/gentle-diagnostics.js uses.
function herdrBinary() {
  const bin = process.env.HERDR_BIN_PATH;
  return typeof bin === "string" && bin.length > 0 ? bin : "herdr";
}

function toolCwd(ctx) {
  if (ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0) return ctx.cwd;
  return process.cwd();
}

// Marks a TypeBox property optional. Production `Type` is the full TypeBox
// export, but older test doubles stub only the constructors `worktree_create`
// needed; falling back to the bare schema keeps the module loadable there
// while production still gets true optionals.
function opt(schema) {
  if (Type && typeof Type.Optional === "function") return Type.Optional(schema);
  return schema;
}

// Thread identity source precedence (which source won is returned in
// `source` so callers and tests can tell):
//  1. GENTLE_WORKTREE_THREAD environment override (tests).
//  2. The Pi host session id via ctx.sessionManager.getSessionId() — the
//     documented accessor on the session manager, the same one
//     extensions/gentle-herdr-state.ts uses. Never invented, never guessed.
function resolveThread(ctx) {
  const override = process.env.GENTLE_WORKTREE_THREAD;
  if (typeof override === "string" && override.length > 0) {
    return { thread: override, source: "env:GENTLE_WORKTREE_THREAD" };
  }
  let id;
  try {
    id = ctx && ctx.sessionManager && typeof ctx.sessionManager.getSessionId === "function"
      ? ctx.sessionManager.getSessionId()
      : undefined;
  } catch {
    id = undefined;
  }
  if (typeof id === "string" && id.length > 0) {
    return { thread: id, source: "session:getSessionId" };
  }
  return { thread: undefined, source: "none" };
}

function textResult(text, details, isError) {
  const result = { content: [{ type: "text", text }], details };
  if (isError) result.isError = true;
  return result;
}

function errorResult(text, details) {
  return textResult(text, details || {}, true);
}

function successText(target) {
  return `worktree create: ${target}`;
}

// Core of `worktree_create`: validation (S2, S3) then herdr-first creation
// with a git fallback. Exported for unit tests; the registered tool calls
// it with the live Pi context.
async function executeWorktreeCreate(params, ctx) {
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const mode = libRequire("worktree-mode.js");
  const issuesLib = libRequire("worktree-issues.js");

  const branch = params ? params.branch : undefined;
  const issues = params ? params.issues : undefined;
  const cwd = toolCwd(ctx);

  // (a) Mode gate: missing means enabled, malformed never enables
  // (lib/worktree-mode.js). A disabled tool names the toggle to re-enable.
  let modeState;
  try {
    modeState = mode.readMode();
  } catch {
    modeState = { state: "malformed", enabled: false };
  }
  if (!modeState || modeState.enabled !== true) {
    return errorResult(
      "worktree tools are disabled; run /herdr-gentle:worktree enabled to enable them",
      { state: modeState ? modeState.state : "unknown", branch, issues },
    );
  }

  // (b) Branch validation, refusing with the returned reason.
  const validated = git.validateBranch(branch);
  if (!validated.ok) {
    return errorResult(
      `invalid branch name ${JSON.stringify(branch)}: ${validated.reason}`,
      { branch, issues },
    );
  }

  // Thread identity resolves before any mutation so a second checkout for
  // the same thread is never created. Without an identity the call fails
  // closed: it must never adopt another thread's checkout.
  const identity = resolveThread(ctx);
  if (!identity.thread) {
    return errorResult(
      "cannot resolve thread identity: set GENTLE_WORKTREE_THREAD or run inside a Pi session",
      { branch, issues },
    );
  }
  const thread = identity.thread;

  // (c) Issues are mandatory and verified to exist (D5, S3).
  const verified = issuesLib.verifyIssues(issues, { cwd });
  if (!verified.ok) {
    return errorResult(verified.reason, { branch, issues, code: verified.code });
  }
  const issueNumbers = verified.issues.map((issue) => issue.number);

  // (d) Repository identity and target path.
  let repo;
  try {
    repo = git.repoIdentity(cwd);
  } catch (err) {
    return errorResult(`not a git repository: ${cwd}`, { branch, issues: issueNumbers });
  }
  const target = git.worktreePath(repo.root, branch);
  const resolvedTarget = path.resolve(target);
  let listed;
  try {
    listed = git.listWorktrees(repo.root);
  } catch (err) {
    return errorResult(
      `cannot list worktrees: ${(err && err.message) || err}`,
      { branch, issues: issueNumbers },
    );
  }

  // (e) Per-thread idempotency (D2, L10): a thread that already owns a
  // registered worktree gets that one back, never a second checkout.
  // This runs BEFORE the (d) refusals on purpose: the owned checkout is
  // by definition checked out at its target, so checking (d) first would
  // make this return unreachable.
  const owned = registry.findByThread(repo.root, thread);
  if (owned) {
    // Only an absolute owned path can be matched against the live list:
    // a relative one is never resolved against the process cwd.
    const ownedAbsolute = typeof owned.path === "string" && path.isAbsolute(owned.path)
      ? path.resolve(owned.path)
      : null;
    const stillLive = ownedAbsolute !== null
      && listed.some((entry) => path.resolve(entry.path) === ownedAbsolute);
    if (stillLive) {
      return textResult(
        successText(owned.path),
        { path: owned.path, branch: owned.branch, issues: owned.issues, created: false },
        false,
      );
    }
    // Stale entry (checkout gone): drop it best-effort and create fresh.
    // Drop by this entry's own path when it is absolute: with a hand-edited
    // registry holding two entries that share a branch, dropping by branch
    // could delete the live entry instead of the stale one.
    try {
      if (ownedAbsolute !== null) registry.removeWorktreeByPath(repo.root, ownedAbsolute);
      else registry.removeWorktree(repo.root, owned.branch);
    } catch {
      // Creation below still produces a correct checkout + entry.
    }
  }

  // (d) Refusals: branch checked out anywhere, target already live, or
  // target inside any checkout / the git common dir.
  const checkedOutAt = listed.find((entry) => entry.branch === branch);
  if (checkedOutAt) {
    return errorResult(
      `branch '${branch}' is already checked out at ${checkedOutAt.path}: pick another branch or close that worktree first`,
      { branch, issues: issueNumbers, path: checkedOutAt.path },
    );
  }
  const liveAtTarget = listed.find((entry) => path.resolve(entry.path) === resolvedTarget);
  if (liveAtTarget) {
    return errorResult(
      `target path ${target} is already a live worktree (branch '${liveAtTarget.branch}'): pick another branch`,
      { branch, issues: issueNumbers, path: target },
    );
  }
  if (git.isPathInAnyCheckout(repo.root, target)) {
    return errorResult(
      `target path ${target} is inside an existing checkout: pick another branch`,
      { branch, issues: issueNumbers, path: target },
    );
  }

  // (f) Approval when the host offers dialog UI; non-interactive modes
  // proceed without it. A refusal mutates nothing and writes no entry.
  if (ctx && ctx.hasUI) {
    const canAsk = ctx.ui && typeof ctx.ui.confirm === "function";
    let approved = false;
    if (canAsk) {
      try {
        approved = await ctx.ui.confirm(
          `Create worktree '${branch}'?`,
          `Create worktree at ${target} for branch '${branch}' (issues: ${issueNumbers.join(", ")})?`,
        );
      } catch {
        approved = false;
      }
    }
    if (!approved) {
      return errorResult(
        `worktree create cancelled: approval declined for branch '${branch}'`,
        { cancelled: true, branch, path: target, issues: issueNumbers },
      );
    }
  }

  // (g) Create: herdr first, git fallback. Fixed argv only, values as
  // separate elements (herdr rejects --flag=value). Never --focus, never
  // --trust-repository: trusting a repository is a human decision these
  // tools never take. The base ref is the repository's current HEAD.
  let base = null;
  try {
    const head = git.runArgv("git", ["rev-parse", "HEAD"], { cwd: repo.root });
    if (head.status === 0 && head.stdout.trim().length > 0) base = head.stdout.trim();
  } catch {
    base = null;
  }
  const createParams = { cwd: repo.root, branch, path: target };
  if (base) createParams.base = base;
  let createdBy = null;
  let createError = null;
  const herdrRes = git.runArgv(herdrBinary(), git.herdrArgv("create", createParams), {
    cwd: repo.root,
    timeoutMs: 120000,
  });
  if (herdrRes.status === 0) {
    createdBy = "herdr";
  } else {
    const fallbackArgv = ["worktree", "add", "-b", branch, target];
    if (base) fallbackArgv.push(base);
    const fallback = git.runArgv("git", fallbackArgv, { cwd: repo.root, timeoutMs: 120000 });
    if (fallback.status === 0) {
      createdBy = "git";
    } else {
      createError = ((fallback.stderr || fallback.error || "unknown error") + "").trim();
    }
  }
  if (!createdBy) {
    return errorResult(
      `failed to create worktree for branch '${branch}': ${createError || "herdr and git both failed"}`,
      { branch, issues: issueNumbers, path: target },
    );
  }

  // (h) Verify against git before claiming success: the new checkout must
  // be present at the target path.
  let after;
  try {
    after = git.listWorktrees(repo.root);
  } catch (err) {
    return errorResult(
      `worktree creation could not be verified at ${target}: ${(err && err.message) || err}`,
      { branch, issues: issueNumbers, path: target, createdBy },
    );
  }
  if (!after.some((entry) => path.resolve(entry.path) === resolvedTarget)) {
    return errorResult(
      `worktree creation could not be verified at ${target}`,
      { branch, issues: issueNumbers, path: target, createdBy },
    );
  }

  // (i) Registry: upsert the entry owned by this thread.
  let stored;
  try {
    stored = registry.upsertWorktree(repo.root, {
      branch,
      path: target,
      thread,
      issues: issueNumbers,
      odd: [],
    });
  } catch (err) {
    return errorResult(
      `worktree created at ${target} but the registry write failed: ${(err && err.message) || err}`,
      { branch, issues: issueNumbers, path: target, createdBy },
    );
  }
  if (!stored.ok) {
    return errorResult(
      `worktree created at ${target} but the registry write failed: ${stored.error}`,
      { branch, issues: issueNumbers, path: target, createdBy },
    );
  }

  // (i2) Creation hooks (S8, P2-S3): copy unversioned files, install by
  // detected stack, symlinks (odd/ always, .agents/.claude when present,
  // never .codegraph/), codegraph init when available. Hooks never turn a
  // successful creation into an error: every outcome, including a thrown
  // hook, is reported inside `details.hooks`, and the exact success text
  // stays unchanged. A failed step stays visible via steps + warnings.
  let hooks = { ok: true, steps: [], warnings: [] };
  try {
    const hooksLib = libRequire("worktree-hooks.js");
    // The principal checkout owns the shared sources. repo.root is the
    // toplevel of the caller (which may itself be a linked worktree), so
    // the principal is recovered from the shared common dir: for a normal
    // repository <principal>/.git is the common dir.
    const principalRoot = path.basename(repo.commonDir) === ".git"
      ? path.dirname(repo.commonDir)
      : repo.root;
    hooks = hooksLib.runCreationHooks({
      principalRoot,
      worktreePath: target,
      root: repo.root,
      env: process.env,
    });
  } catch (err) {
    const message = `creation hooks failed: ${(err && err.message) || err}`;
    hooks = {
      ok: false,
      steps: [{ name: "hooks", status: "failed", detail: message }],
      warnings: [message],
    };
  }

  // (j) Terse success text (S9), whichever backend performed the creation.
  // Hook steps and warnings travel inside details; a failed step is
  // visible there and never becomes an error result. When the write
  // replaced a malformed registry, the sibling backup path travels along
  // so the caller can name it. When no backup could be written the
  // failure travels as registryBackupError (best-effort, never fatal).
  const backupDetails = {};
  if (stored.backup) backupDetails.registryBackup = stored.backup;
  if (stored.backupError) backupDetails.registryBackupError = stored.backupError;
  return textResult(
    successText(target),
    { path: target, branch, issues: issueNumbers, created: true, hooks, warnings: (hooks && hooks.warnings) || [], ...backupDetails },
    false,
  );
}

const worktreeCreateTool = defineTool({
  name: "worktree_create",
  label: "Worktree Create",
  description: "Create an agent worktree for a branch at the flattened worktree path, associated with at least one verified GitHub issue. The calling thread owns the checkout.",
  parameters: Type.Object({
    branch: Type.String({ description: "Branch name to create the worktree for" }),
    issues: Type.Array(Type.Number(), { description: "Associated GitHub issue numbers (at least one, each verified to exist)" }),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeCreate(params, ctx);
  },
});

// `worktree_list` output contract (S6, S9) — terse, one line per
// worktree, pinned in tools/worktree-close.test.js:
//   worktree list: <path> <branch> thread=<thread> issues=<n,n[,n...]>
// A registered entry whose path is not a live checkout gains ` missing`:
//   worktree list: <path> <branch> thread=<thread> issues=<n,n> missing
// With `all: true`, a live checkout the registry does not know about
// appends (the caller's own checkout is never listed as unregistered):
//   worktree list: <path> <branch> unregistered
// Nothing registered (and nothing unregistered with all) is a single:
//   worktree list: none
// The registry is only read, never written, by this tool.
async function executeWorktreeList(params, ctx) {
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const mode = libRequire("worktree-mode.js");
  const cwd = toolCwd(ctx);

  // Mode gate, exactly like `worktree_create`: missing means enabled,
  // malformed never enables, disabled names the toggle.
  let modeState;
  try {
    modeState = mode.readMode();
  } catch {
    modeState = { state: "malformed", enabled: false };
  }
  if (!modeState || modeState.enabled !== true) {
    return errorResult(
      "worktree tools are disabled; run /herdr-gentle:worktree enabled to enable them",
      { state: modeState ? modeState.state : "unknown", tool: "worktree_list" },
    );
  }

  let repo;
  try {
    repo = git.repoIdentity(cwd);
  } catch (err) {
    return errorResult(`not a git repository: ${cwd}`, { tool: "worktree_list" });
  }
  const all = !!params && params.all === true;
  const read = registry.readRegistry(repo.root);
  if (!read.ok) {
    return errorResult(
      `cannot read worktree registry: ${read.error}`,
      { tool: "worktree_list" },
    );
  }
  let live;
  try {
    live = git.listWorktrees(repo.root);
  } catch (err) {
    return errorResult(
      `cannot list worktrees: ${(err && err.message) || err}`,
      { tool: "worktree_list" },
    );
  }

  // Cross-check the registry against git: a checkout deleted out of band
  // is reported as `missing`, never as live. Nothing is written back. A
  // registry path that is not absolute is never resolved against the
  // process cwd, so it can never match a live checkout and is reported
  // missing.
  const liveByPath = new Map(live.map((entry) => [path.resolve(entry.path), entry]));
  const lines = [];
  const items = [];
  for (const entry of read.worktrees) {
    const absolute = typeof entry.path === "string" && path.isAbsolute(entry.path)
      ? path.resolve(entry.path)
      : null;
    const liveHit = absolute === null ? undefined : liveByPath.get(absolute);
    const issues = Array.isArray(entry.issues) ? entry.issues.slice() : [];
    const thread = typeof entry.thread === "string" && entry.thread.length > 0
      ? entry.thread
      : "unknown";
    const status = liveHit ? "live" : "missing";
    lines.push(
      `worktree list: ${entry.path} ${entry.branch} thread=${thread} issues=${issues.join(",")}`
      + (liveHit ? "" : " missing"),
    );
    items.push({ path: entry.path, branch: entry.branch, thread, issues, status });
  }
  if (all) {
    // Only absolute registry paths participate: anything else cannot name
    // a live checkout without resolving against the process cwd.
    const registered = new Set(read.worktrees
      .filter((entry) => typeof entry.path === "string" && path.isAbsolute(entry.path))
      .map((entry) => path.resolve(entry.path)));
    const self = path.resolve(repo.root);
    const extra = live
      .filter((entry) => {
        const resolved = path.resolve(entry.path);
        return !registered.has(resolved) && resolved !== self;
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const entry of extra) {
      const branch = entry.branch || "(detached)";
      lines.push(`worktree list: ${entry.path} ${branch} unregistered`);
      items.push({ path: entry.path, branch, thread: null, issues: [], status: "unregistered" });
    }
  }
  if (lines.length === 0) {
    return textResult("worktree list: none", { worktrees: [], count: 0, all }, false);
  }
  return textResult(lines.join("\n"), { worktrees: items, count: items.length, all }, false);
}

// Rank registry entries by common-prefix score against the query so an
// unregistered close target can name the closest registered candidates.
function rankCandidates(query, entries) {
  const q = String(query);
  return entries
    .map((entry) => {
      const name = String(entry.branch || "");
      const shared = Math.min(q.length, name.length);
      let score = 0;
      while (score < shared && q[score] === name[score]) score += 1;
      let pathBonus = 0;
      try {
        if (typeof entry.path === "string" && entry.path.includes(q)) {
          pathBonus = Math.min(3, Math.floor(q.length / 4));
        }
      } catch {
        pathBonus = 0;
      }
      return { entry, score: score + pathBonus };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((ranked) => ranked.entry);
}

// Resolve the Herdr workspace id for a checkout path from `herdr worktree
// list` JSON (`{result: {worktrees: [{path, open_workspace_id, ...}]}}`,
// with tolerant fallbacks). A workspace id is returned only when the list
// entry's path resolves to exactly the close target: absolute entries
// compare directly, relative entries resolve against the repository root
// (never the process cwd) for the comparison only. Returns null when
// herdr is unusable, no entry matches, or the checkout has no workspace
// id — the caller then skips herdr entirely and falls back to git.
function herdrWorkspaceId(stdout, resolvedTarget, repoRoot) {
  let list = null;
  try {
    const doc = JSON.parse(stdout);
    if (doc && doc.result && Array.isArray(doc.result.worktrees)) {
      list = doc.result.worktrees;
    } else if (doc && Array.isArray(doc.worktrees)) {
      list = doc.worktrees;
    } else if (doc && Array.isArray(doc.result)) {
      list = doc.result;
    }
  } catch {
    return null;
  }
  if (!list) return null;
  const base = typeof repoRoot === "string" && repoRoot.length > 0 ? repoRoot : null;
  for (const item of list) {
    if (!item || typeof item.path !== "string" || item.path.length === 0) continue;
    let resolved;
    try {
      if (path.isAbsolute(item.path)) resolved = path.resolve(item.path);
      else if (base === null) continue;
      else resolved = path.resolve(base, item.path);
    } catch {
      continue;
    }
    if (resolved !== resolvedTarget) continue;
    for (const key of ["open_workspace_id", "workspace_id", "workspace", "id"]) {
      if (typeof item[key] === "string" && item[key].length > 0) return item[key];
    }
    return null;
  }
  return null;
}

// Core of `worktree_close` (S7, D6): remove the checkout and its Herdr
// workspace, keep the branch, drop the registry entry. Exported for unit
// tests; the registered tool calls it with the live Pi context.
//
// The S7 rule is that the BRANCH IS KEPT: this function never deletes a
// branch, never passes `--trust-repository`, and passes `--force` only
// when the caller asked for it. Removal is herdr-first (workspace id
// resolved from `herdr worktree list`) with a `git worktree remove` fixed
// argv fallback when herdr is unavailable; a dirty checkout without
// `force` fails with the backend's own reason and nothing is mutated. The
// registry entry is dropped only after `listWorktrees` confirms the path
// is gone.
async function executeWorktreeClose(params, ctx) {
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const mode = libRequire("worktree-mode.js");
  const cwd = toolCwd(ctx);

  // Mode gate, exactly like `worktree_create`.
  let modeState;
  try {
    modeState = mode.readMode();
  } catch {
    modeState = { state: "malformed", enabled: false };
  }
  if (!modeState || modeState.enabled !== true) {
    return errorResult(
      "worktree tools are disabled; run /herdr-gentle:worktree enabled to enable them",
      { state: modeState ? modeState.state : "unknown", tool: "worktree_close" },
    );
  }

  const rawPath = params ? params.path : undefined;
  const rawBranch = params ? params.branch : undefined;
  const force = !!params && params.force === true;
  const hasPath = typeof rawPath === "string" && rawPath.length > 0;
  const hasBranch = typeof rawBranch === "string" && rawBranch.length > 0;
  if (!hasPath && !hasBranch) {
    return errorResult(
      "worktree_close requires a path or a branch: pass the worktree path or branch name to close",
      { force },
    );
  }

  let repo;
  try {
    repo = git.repoIdentity(cwd);
  } catch (err) {
    return errorResult(`not a git repository: ${cwd}`, { force });
  }
  const read = registry.readRegistry(repo.root);
  if (!read.ok) {
    return errorResult(`cannot read worktree registry: ${read.error}`, { force });
  }
  const byPath = hasPath ? registry.findByPath(repo.root, rawPath) : null;
  const byBranch = hasBranch ? registry.findByBranch(repo.root, rawBranch) : null;
  if (hasPath && hasBranch && byPath && byBranch && byPath.branch !== byBranch.branch) {
    return errorResult(
      `worktree_close path and branch disagree: path resolves to branch '${byPath.branch}' but branch '${rawBranch}' is registered elsewhere; pass only one`,
      { path: rawPath, branch: rawBranch, force },
    );
  }
  const entry = byPath || byBranch || null;
  if (!entry) {
    // Never remove an unknown checkout: refuse and name the closest
    // registered candidates instead.
    const query = hasPath ? rawPath : rawBranch;
    if (read.worktrees.length === 0) {
      return errorResult(
        `no registered worktree for ${JSON.stringify(query)}: no worktrees are registered`,
        { query, force },
      );
    }
    const candidates = rankCandidates(query, read.worktrees);
    const named = candidates.map((item) => `'${item.branch}' at ${item.path}`).join(", ");
    return errorResult(
      `no registered worktree for ${JSON.stringify(query)}: closest registered worktrees: ${named}`,
      { query, candidates: candidates.map((item) => ({ branch: item.branch, path: item.path })), force },
    );
  }
  const target = entry.path;
  const branch = entry.branch;
  // C1: a registry entry whose path is not absolute is refused here,
  // before anything is verified or removed. Resolving it against the
  // process cwd would name a checkout relative to wherever the caller
  // happens to run, while `git worktree remove` runs with cwd = the
  // repository root — the check and the removal would name different
  // checkouts. No mutation, no registry change.
  if (typeof target !== 'string' || !path.isAbsolute(target)) {
    return errorResult(
      `refusing to close worktree for branch '${branch}': registry entry path ${JSON.stringify(target)} is not absolute (registry entry paths must be absolute); the checkout and the registry were left untouched`,
      { branch, path: target, force },
    );
  }
  // The single absolute value derived from the entry: the pre-removal
  // check, any removal argv, and the post-removal verification all use
  // this, never the process cwd.
  // L7: the checkout belongs to a thread. Closing another thread's
  // checkout is legitimate (a delivered thread is often closed from a later
  // session), so this reports the owner instead of refusing: the human sees
  // whose checkout the approval would remove.
  const owner = typeof entry.thread === "string" && entry.thread.length > 0 ? entry.thread : null;
  const resolvedTarget = path.resolve(target);

  let live;
  try {
    live = git.listWorktrees(repo.root);
  } catch (err) {
    return errorResult(
      `cannot list worktrees: ${(err && err.message) || err}`,
      { branch, path: target, force },
    );
  }
  if (!live.some((item) => path.resolve(item.path) === resolvedTarget)) {
    return errorResult(
      `worktree at ${target} is not a live checkout (stale registry entry for branch '${branch}'): the entry was kept`,
      { branch, path: target, force },
    );
  }

  // Approval when the host offers dialog UI; non-interactive modes
  // proceed without it. A refusal mutates nothing and keeps the entry.
  if (ctx && ctx.hasUI) {
    const canAsk = ctx.ui && typeof ctx.ui.confirm === "function";
    let approved = false;
    if (canAsk) {
      try {
        approved = await ctx.ui.confirm(
          `Close worktree '${branch}'?`,
          `Remove the worktree checkout at ${target} for branch '${branch}'? The branch '${branch}' will be kept.`
            + (owner
              ? ` This checkout is owned by thread '${owner}'.`
              : " This checkout has no recorded owning thread."),
        );
      } catch {
        approved = false;
      }
    }
    if (!approved) {
      return errorResult(
        `worktree close cancelled: approval declined for branch '${branch}'`,
        { cancelled: true, branch, path: target, force },
      );
    }
  }

  // Remove herdr-first: resolve the workspace id from `herdr worktree
  // list`, then `herdr worktree remove`. Fixed argv only, values as
  // separate elements (herdr rejects --flag=value). Never
  // --trust-repository: trusting a repository is a human decision these
  // tools never take. `--force` only when the caller asked for it.
  let removedBy = null;
  let removeError = null;
  let workspace = null;
  const listed = git.runArgv(herdrBinary(), git.herdrArgv("list", { cwd: repo.root }), {
    cwd: repo.root,
    timeoutMs: 60000,
  });
  if (listed.status === 0) {
    workspace = herdrWorkspaceId(listed.stdout, resolvedTarget, repo.root);
  }
  if (workspace) {
    const removeParams = { workspace };
    if (force) removeParams.force = true;
    const removed = git.runArgv(herdrBinary(), git.herdrArgv("remove", removeParams), {
      cwd: repo.root,
      timeoutMs: 120000,
    });
    if (removed.status === 0) {
      removedBy = "herdr";
    } else {
      removeError = ((removed.stderr || removed.error || "") + "").trim()
        || "herdr worktree remove failed";
    }
  } else {
    // Herdr is unavailable (missing binary, failed list, unparseable
    // output) or the checkout has no workspace id: `git worktree remove`
    // with fixed argv. It never deletes the branch either. The absolute
    // entry path travels explicitly so the removal names the verified
    // checkout however the process cwd is set.
    const argv = ["worktree", "remove"];
    if (force) argv.push("--force");
    argv.push(resolvedTarget);
    const fallen = git.runArgv("git", argv, { cwd: repo.root, timeoutMs: 120000 });
    if (fallen.status === 0) {
      removedBy = "git";
    } else {
      removeError = ((fallen.stderr || fallen.error || "") + "").trim()
        || "git worktree remove failed";
    }
  }
  if (!removedBy) {
    // The backend's own reason (e.g. git's dirty-checkout refusal) is the
    // whole message; checkout and registry entry are left untouched.
    return errorResult(removeError || "failed to remove worktree", {
      branch, path: target, force, removed: false,
    });
  }

  // Verify against git before dropping the entry: the path must be gone.
  let after;
  try {
    after = git.listWorktrees(repo.root);
  } catch (err) {
    return errorResult(
      `worktree removal could not be verified at ${target}: ${(err && err.message) || err}`,
      { branch, path: target, force, removedBy },
    );
  }
  if (after.some((item) => path.resolve(item.path) === resolvedTarget)) {
    return errorResult(
      `worktree removal could not be verified at ${target}: the checkout is still listed`,
      { branch, path: target, force, removedBy },
    );
  }
  let dropped;
  try {
    dropped = registry.removeWorktreeByPath(repo.root, resolvedTarget);
  } catch (err) {
    dropped = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!dropped.ok) {
    return errorResult(
      `worktree removed at ${target} but the registry entry could not be dropped: ${dropped.error}`,
      { branch, path: target, force, removed: true, branchKept: true },
    );
  }
  return textResult(
    `worktree close: ${target}`,
    { path: target, branch, removed: true, branchKept: true, thread: owner },
    false,
  );
}

const worktreeListTool = defineTool({
  name: "worktree_list",
  label: "Worktree List",
  description: "List agent worktrees registered for this repository, cross-checked against live checkouts with their owning thread. Pass all:true to also show live checkouts the registry does not know about. Read-only: never mutates the registry.",
  parameters: Type.Object({
    all: opt(Type.Boolean({ description: "Include live checkouts the registry does not know about" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeList(params, ctx);
  },
});

const worktreeCloseTool = defineTool({
  name: "worktree_close",
  label: "Worktree Close",
  description: "Remove a registered agent worktree checkout and its Herdr workspace while keeping the branch. Pass the worktree path or branch, plus force:true to close a dirty checkout.",
  parameters: Type.Object({
    path: opt(Type.String({ description: "Path of the registered worktree to close" })),
    branch: opt(Type.String({ description: "Branch of the registered worktree to close" })),
    force: opt(Type.Boolean({ description: "Close even when the checkout is dirty" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeClose(params, ctx);
  },
});

// ---------------------------------------------------------------------------
// Automatic odd/ capture (S5, D7).
//
// The extension observes the Pi tool pipeline for the `read`, `edit` and
// `write` tools. For each call it decides whether the touched path is a
// `.md` document inside the principal checkout's `odd/` directory and, when
// it is, associates that document with the worktree of the AGENT'S CONTEXT
// (resolved from the invoking context's working directory and matched
// against the registry entries) — never from the file path identity,
// because `odd/` is a symlink into the principal checkout so one real path
// is shared by every worktree. A call running in the principal checkout
// itself associates nothing.
//
// `bash` commands touching `odd/` are NOT reliably parseable (arbitrary
// shell text, redirections, and quoting cannot be reduced to a file list),
// so the per-call capture is complemented by a bounded re-scan of the
// worktree's own `odd/` directory (`.md` only) on EVERY pipeline event on
// this hook — including `bash` calls, which carry no parseable path at
// all. Anything the registry does not know about yet is recorded there.
//
// The hook never throws and never blocks the pipeline: any failure
// (unreadable registry, lock timeout, unknown context) is swallowed after
// a best-effort attempt, and the handler returns nothing.
// ---------------------------------------------------------------------------

// Only these three tools carry a single document path worth capturing.
const ODD_CAPTURE_TOOLS = new Set(["read", "edit", "write"]);

// Bounds for the complementary re-scan: at most this many `.md` documents
// are recorded per hook invocation, the walk descends at most this deep,
// and gives up after this many directory entries so a huge `odd/` tree can
// never stall the tool pipeline.
const ODD_SCAN_MAX_FILES = 500;
const ODD_SCAN_MAX_DEPTH = 10;
const ODD_SCAN_MAX_ENTRIES = 5000;

function oddToolNameOf(event) {
  if (!event || typeof event !== "object") return undefined;
  const name = event.toolName ?? event.tool ?? event.name;
  return typeof name === "string" ? name : undefined;
}

function oddArgsOf(event) {
  if (!event || typeof event !== "object") return undefined;
  return event.args ?? event.input ?? event.params ?? event.arguments;
}

// Path arguments across the tool_call / tool_result shapes: the file tools
// carry the document under `path` (accepted aliases cover older shapes).
function oddTouchedPaths(args) {
  const out = [];
  const push = (value) => {
    if (typeof value === "string" && value.length > 0) out.push(value);
  };
  if (typeof args === "string") {
    push(args);
    return out;
  }
  if (!args || typeof args !== "object") return out;
  const direct = args.path ?? args.file ?? args.filePath ?? args.filename ?? args.target;
  if (Array.isArray(direct)) direct.forEach(push);
  else push(direct);
  const plural = args.paths ?? args.files;
  if (Array.isArray(plural)) plural.forEach(push);
  return out;
}

function oddEventCwd(event, ctx) {
  if (ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0) return ctx.cwd;
  if (event && typeof event.cwd === "string" && event.cwd.length > 0) return event.cwd;
  return process.cwd();
}

// The registry entry owning `cwd`: the entry whose worktree root is `cwd`
// itself or its longest enclosing prefix. Anything else — the principal
// checkout, an unregistered directory — yields null and captures nothing.
function oddEntryForCwd(worktrees, cwd) {
  const resolved = path.resolve(cwd);
  let best = null;
  let bestLen = -1;
  for (const entry of worktrees) {
    // Relative registry paths never participate: resolving one against
    // the process cwd would attribute the call to the wrong worktree.
    if (!entry || typeof entry.path !== "string" || !path.isAbsolute(entry.path)) continue;
    let candidate;
    try {
      candidate = path.resolve(entry.path);
    } catch {
      continue;
    }
    if (resolved !== candidate && !resolved.startsWith(candidate + path.sep)) continue;
    if (candidate.length > bestLen) {
      best = entry;
      bestLen = candidate.length;
    }
  }
  return best;
}

// Best-effort real path: the file itself when it exists (resolving the
// worktree `odd/` symlink into the principal checkout), else its parent
// directory plus the basename (covers `write` of a not-yet-created doc),
// else the lexical path.
function oddRealPath(absPath) {
  try {
    return fs.realpathSync(absPath);
  } catch {
    // The file may not exist yet; resolve through its parent instead.
  }
  try {
    return path.join(fs.realpathSync(path.dirname(absPath)), path.basename(absPath));
  } catch {
    return absPath;
  }
}

// `odd/<rel>` for a touched absolute path, or null when the path is not a
// `.md` document inside either the worktree's own `odd/` (lexical, through
// the symlink) or the principal checkout's `odd/` (real path). The returned
// rel is always relative to the shared `odd/` root so every worktree
// records the same document under the same name.
function oddRelFor(absPath, worktreePath, principalRoot) {
  if (typeof absPath !== "string" || absPath.length === 0) return null;
  const lexical = path.resolve(absPath);
  if (!lexical.endsWith(".md")) return null;
  const candidates = [lexical, path.resolve(oddRealPath(lexical))];
  const oddRoots = [path.join(worktreePath, "odd"), path.join(principalRoot, "odd")];
  const bases = [];
  for (const base of oddRoots) {
    bases.push(path.resolve(base));
    try {
      bases.push(path.resolve(fs.realpathSync(base)));
    } catch {
      // An absent `odd/` simply contributes no real base.
    }
  }
  for (const candidate of candidates) {
    for (const base of bases) {
      if (candidate === base) continue;
      if (!candidate.startsWith(base + path.sep)) continue;
      const rel = path.relative(base, candidate).split(path.sep).join("/");
      if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      return `odd/${rel}`;
    }
  }
  return null;
}

// Bounded (`.md` only) listing of the worktree's own `odd/` directory,
// relative to it (`tasks/plan.md`). Never throws: any unreadable directory
// contributes nothing.
function scanOddMarkdowns(oddDir) {
  const rels = [];
  const visited = new Set();
  let entriesSeen = 0;
  const stack = [{ dir: oddDir, depth: 0, prefix: "" }];
  while (stack.length > 0
    && rels.length < ODD_SCAN_MAX_FILES
    && entriesSeen < ODD_SCAN_MAX_ENTRIES) {
    const { dir, depth, prefix } = stack.pop();
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      continue;
    }
    if (visited.has(real)) continue;
    visited.add(real);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (rels.length >= ODD_SCAN_MAX_FILES || entriesSeen >= ODD_SCAN_MAX_ENTRIES) break;
      entriesSeen += 1;
      const name = entry.name;
      if (!name || name === "." || name === "..") continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      let isDir = false;
      let isFile = false;
      try {
        isDir = entry.isDirectory();
        isFile = entry.isFile();
      } catch {
        continue;
      }
      if (isDir) {
        if (depth + 1 <= ODD_SCAN_MAX_DEPTH) {
          stack.push({ dir: path.join(dir, name), depth: depth + 1, prefix: rel });
        }
      } else if (isFile && name.endsWith(".md")) {
        rels.push(rel);
      }
    }
  }
  return rels;
}

function captureOddFromToolEvent(event, ctx) {
  // M1: the capture is gated by the worktree mode, read fresh on every
  // event. A disabled or malformed mode records nothing.
  let modeState;
  try {
    modeState = libRequire("worktree-mode.js").readMode();
  } catch {
    return;
  }
  if (!modeState || modeState.enabled !== true) return;
  const cwd = oddEventCwd(event, ctx);
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  let repo;
  try {
    repo = git.repoIdentity(cwd);
  } catch {
    return; // Unknown context: not a repository, nothing to associate.
  }
  const principalRoot = path.basename(repo.commonDir) === ".git"
    ? path.dirname(repo.commonDir)
    : repo.root;
  const read = registry.readRegistry(repo.root);
  if (!read || read.ok !== true || !Array.isArray(read.worktrees)) return;
  const entry = oddEntryForCwd(read.worktrees, cwd);
  if (!entry) return; // Principal checkout itself associates nothing.
  const key = entry.branch;
  const known = new Set(Array.isArray(entry.odd) ? entry.odd : []);
  const candidates = [];
  // Per-call capture applies to the read/edit/write tools, which carry a
  // single document path. Every other tool (notably `bash`) carries no
  // reliably parseable path and skips this leg entirely.
  if (ODD_CAPTURE_TOOLS.has(oddToolNameOf(event))) {
    for (const raw of oddTouchedPaths(oddArgsOf(event))) {
      const abs = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
      const rel = oddRelFor(abs, entry.path, principalRoot);
      if (rel && !known.has(rel)) {
        known.add(rel);
        candidates.push(rel);
      }
    }
  }
  // Complement: record anything the per-call capture never observed.
  // Runs on every pipeline event so opaque calls (e.g. `bash`) still
  // converge the registry towards the worktree's `odd/` contents.
  try {
    for (const rel of scanOddMarkdowns(path.join(entry.path, "odd"))) {
      const full = `odd/${rel}`;
      if (!known.has(full)) {
        known.add(full);
        candidates.push(full);
      }
    }
  } catch {
    // Best effort: the observed paths above are still recorded.
  }
  for (const rel of candidates) {
    try {
      registry.addOddDoc(repo.root, key, rel);
    } catch {
      // Unreadable registry or lock timeout: swallow, keep the pipeline.
    }
  }
}

// The subscribed pipeline handler: never throws, never blocks, returns
// nothing (a `tool_call` return value would mutate or block the call).
function handleWorktreeOddEvent(event, ctx) {
  try {
    captureOddFromToolEvent(event, ctx);
  } catch {
    // Any failure is swallowed after the best-effort attempt above.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// `/herdr-gentle:worktree` mode command (S10, D9).
//
// Follows the `/herdr-gentle:sidebar` pattern with the shared mode file in
// lib/worktree-mode.js (default enabled): `enabled`/`disabled` write the
// file (with `enable`/`disable` accepted as aliases), `status` never
// writes. An unknown or missing verb prints a usage line naming the three
// verbs and mutates nothing.
// ---------------------------------------------------------------------------

function worktreeStatusMessage(modeState, toolsRegistered) {
  const state = !modeState || typeof modeState.state !== "string"
    ? "unknown (mode file unreadable)"
    : modeState.state === "missing"
      ? "enabled (default; no mode file)"
      : modeState.state === "malformed"
        ? "unknown (mode file malformed)"
        : modeState.state;
  const registered = toolsRegistered ? "yes" : "no";
  let reload = "unknown";
  try {
    reload = (modeState && modeState.enabled === true) !== toolsRegistered ? "yes" : "no";
  } catch {
    reload = "unknown";
  }
  return `Worktree tools are ${state} (tools registered: ${registered}; /reload needed: ${reload}). Use /herdr-gentle:worktree enabled|disabled|status.`;
}

// Registered before any gate on purpose (like the sidebar toggle): the
// switch belongs to the Pi session, so it must exist even while the tools
// themselves are unregistered. Hosts without commands simply skip it.
function registerWorktreeCommand(pi, toolsRegistered) {
  if (typeof pi?.registerCommand !== "function") return;
  pi.registerCommand("herdr-gentle:worktree", {
    description: "Turn the agent worktree tools (worktree_create/list/close) on or off",
    handler: async (args, ctx) => {
      const notify = ctx?.ui?.notify;
      const raw = String(args ?? "").trim().toLowerCase();
      let verb = raw;
      if (verb === "enable") verb = "enabled";
      if (verb === "disable") verb = "disabled";
      if (verb !== "enabled" && verb !== "disabled" && verb !== "status") {
        notify?.(`Unknown option "${raw}". Use /herdr-gentle:worktree enabled|disabled|status.`, "error");
        return;
      }
      const mode = libRequire("worktree-mode.js");
      if (verb === "status") {
        let state;
        try {
          state = mode.readMode();
        } catch {
          state = { state: "malformed", enabled: false };
        }
        notify?.(worktreeStatusMessage(state, toolsRegistered), "info");
        return;
      }
      const enabled = verb === "enabled";
      try {
        mode.writeMode(enabled, process.env);
      } catch (err) {
        notify?.(`Could not write ${mode.modePath(process.env)}: ${(err && err.message) || err}`, "error");
        return;
      }
      // Registration changes apply on `/reload`: enabling a session that
      // loaded while disabled (or vice versa) only takes full effect after
      // one, while repeating the already-loaded state needs none.
      const needsReload = enabled !== toolsRegistered;
      notify?.(
        enabled
          ? (needsReload
            ? "Worktree tools enabled. Sessions already running need /reload to register the tools."
            : "Worktree tools enabled (already registered in this session; no /reload needed).")
          : (needsReload
            ? "Worktree tools disabled. Sessions already running need /reload to unload the tools (calls stay blocked until then)."
            : "Worktree tools disabled (already unregistered in this session; no /reload needed)."),
        "info",
      );
    },
  });
}

export default function (pi) {
  // Load-time gate (D9): missing means enabled, malformed never enables.
  // The toggle command below always stays registered so the mode can be
  // flipped back; the current registration state is reported through its
  // `status` verb in the same style the `/herdr-gentle:sidebar` command
  // uses (mode state, what is active, whether `/reload` is needed).
  let toolsRegistered = false;
  try {
    toolsRegistered = libRequire("worktree-mode.js").readMode().enabled === true;
  } catch {
    toolsRegistered = false;
  }
  registerWorktreeCommand(pi, toolsRegistered);
  if (toolsRegistered) {
    pi.registerTool(worktreeCreateTool);
    pi.registerTool(worktreeListTool);
    pi.registerTool(worktreeCloseTool);
  }
  // Automatic odd/ capture (S5, D7): observe the tool pipeline for the
  // read/edit/write tools. Guarded so hosts (and the older unit-test
  // doubles) without `pi.on` still load the tools above.
  if (typeof pi?.on === "function") {
    pi.on("tool_call", handleWorktreeOddEvent);
    pi.on("tool_result", handleWorktreeOddEvent);
  }
}

export { executeWorktreeCreate, executeWorktreeList, executeWorktreeClose, resolveThread };
