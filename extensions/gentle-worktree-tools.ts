// @ts-nocheck
// gentle-worktree-tools.ts — agent worktree tools (Pi extension, P2-S2).
//
// Registers exactly one tool in this slice: `worktree_create`. Creation
// hooks (env copy, dependency install, symlinks, codegraph init) are the
// next slice, so this file creates the checkout and nothing else.
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

export default function (pi) {
  pi.registerTool(worktreeCreateTool);
}

export { executeWorktreeCreate, resolveThread };
