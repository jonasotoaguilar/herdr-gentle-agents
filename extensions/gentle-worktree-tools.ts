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
    const stillLive = listed.some((entry) => path.resolve(entry.path) === path.resolve(owned.path));
    if (stillLive) {
      return textResult(
        successText(owned.path),
        { path: owned.path, branch: owned.branch, issues: owned.issues, created: false },
        false,
      );
    }
    // Stale entry (checkout gone): drop it best-effort and create fresh.
    try {
      registry.removeWorktree(repo.root, owned.branch);
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
  // visible there and never becomes an error result.
  return textResult(
    successText(target),
    { path: target, branch, issues: issueNumbers, created: true, hooks, warnings: (hooks && hooks.warnings) || [] },
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
  // is reported as `missing`, never as live. Nothing is written back.
  const liveByPath = new Map(live.map((entry) => [path.resolve(entry.path), entry]));
  const lines = [];
  const items = [];
  for (const entry of read.worktrees) {
    const liveHit = liveByPath.get(path.resolve(entry.path));
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
    const registered = new Set(read.worktrees.map((entry) => path.resolve(entry.path)));
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
// with tolerant fallbacks). Returns null when herdr is unusable or the
// checkout has no workspace id — the caller then falls back to git.
function herdrWorkspaceId(stdout, resolvedTarget) {
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
  for (const item of list) {
    if (!item || typeof item.path !== "string") continue;
    let resolved;
    try {
      resolved = path.resolve(item.path);
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
    workspace = herdrWorkspaceId(listed.stdout, resolvedTarget);
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
    // with fixed argv. It never deletes the branch either.
    const argv = ["worktree", "remove"];
    if (force) argv.push("--force");
    argv.push(target);
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
    dropped = registry.removeWorktree(repo.root, branch);
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

export default function (pi) {
  pi.registerTool(worktreeCreateTool);
  pi.registerTool(worktreeListTool);
  pi.registerTool(worktreeCloseTool);
}

export { executeWorktreeCreate, executeWorktreeList, executeWorktreeClose, resolveThread };
