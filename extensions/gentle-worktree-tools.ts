// @ts-nocheck
// gentle-worktree-tools.ts — agent worktree tools (Pi extension, P2-S4,
// plus the session opener T34/S25).
//
// Registers four tools: `worktree_create` (validate + herdr-first
// creation with hooks), `worktree_list` (read-only, no approval prompt),
// `worktree_close` (remove the checkout, keep the branch) and
// `worktree_session_open` (open a Pi session inside a registered agent
// worktree via Herdr). Create and close prompt for approval when the host
// offers dialog UI; list never mutates anything.
//
// The file is plain JavaScript with a .ts extension (// @ts-nocheck, no
// type annotations), exactly like extensions/gentle-herdr-state.ts, so the
// test copy-to-.mjs loading pattern keeps working under plain node.

import { Type } from "@earendil-works/pi-ai";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

// Consolidated liveness predicate: the ONE definition of "is this path a
// real, live checkout?" Every call site below (list liveness + prune +
// extras, create idempotency + conflict guard + refusals + verification,
// close pre/post checks + vanished comparison) resolves through this, so
// the question is never re-answered with slightly different logic.
//
// Returns {absolute, real, exists, isDirectory} and never throws:
// - absolute: the path resolved WITHOUT the process cwd (absolute inputs
//   via path.resolve, which never consults the cwd for them; relative
//   inputs against the repository root). A non-absolute input with no
//   repository root yields no state at all (absolute null).
// - real: the symlink-resolved realpath, or null when the filesystem
//   cannot resolve it (missing checkout, dangling link).
// - exists: something is present (statSync, which FOLLOWS symlinks, so a
//   dangling link reads as absent).
// - isDirectory: that something is a directory — a FILE at the path is
//   not a checkout, so liveness always requires exists && isDirectory.
function checkoutState(entryPath, repoRoot) {
  const none = { absolute: null, real: null, exists: false, isDirectory: false };
  try {
    if (typeof entryPath !== "string" || entryPath.length === 0) return { ...none };
    let absolute = null;
    try {
      if (path.isAbsolute(entryPath)) absolute = path.resolve(entryPath);
      else {
        if (typeof repoRoot !== "string" || repoRoot.length === 0) return { ...none };
        absolute = path.resolve(repoRoot, entryPath);
      }
    } catch {
      return { ...none };
    }
    if (absolute === null) return { ...none };
    let exists = false;
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(absolute).isDirectory();
      exists = true;
    } catch {
      exists = false;
      isDirectory = false;
    }
    let real = null;
    try {
      real = fs.realpathSync(absolute);
    } catch {
      real = null;
    }
    return { absolute, real, exists, isDirectory };
  } catch {
    return { absolute: null, real: null, exists: false, isDirectory: false };
  }
}

// Realpath identities of live checkouts, for symlink-transparent
// liveness: a registry row that reaches a live checkout through a
// symlink shares its realpath even though the spellings differ. Built
// through checkoutState: a git entry contributes only when something
// exists there AND it is a directory, so a hand-deleted checkout git
// still records never makes a row live. Relative list paths (never
// expected from git) resolve against the repository root, never the
// process cwd.
function liveIdentities(listed, repoRoot) {
  const ids = new Set();
  for (const entry of listed || []) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    if (!st.exists || !st.isDirectory) continue;
    if (st.real !== null) ids.add(st.real);
    else if (st.absolute !== null) ids.add(st.absolute);
  }
  return ids;
}

// A git listing record names a LIVE checkout only through the one
// predicate: its path resolves (absolute inputs directly, relative inputs
// against the repository root, never the process cwd) AND something
// exists there AND it is a directory. A record git still holds for a
// hand-deleted checkout, or for a path replaced by a FILE, is stale and
// never blocks a create, never reads live in the list, and never passes
// the close pre-check.
function isLiveGitRecord(entry, repoRoot) {
  if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return false;
  const st = checkoutState(entry.path, repoRoot);
  return st.absolute !== null && st.exists && st.isDirectory;
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
  // A stale owned row is dropped only after its replacement checkout is
  // verified (see (h)): dropping it here would leave an empty registry
  // behind a refusal with no way back.
  let staleOwned = null;
  if (owned) {
    // Liveness is the consolidated checkoutState: the owned row is still
    // live only when something exists there AND it is a directory AND its
    // resolved realpath matches a live checkout's realpath, so an owned
    // SYMLINK to a live checkout is live and never dropped as stale while
    // a hand-deleted checkout git still records is stale (its state has
    // nothing existing, so it can never match). A relative owned path can
    // never match, exactly as before.
    const ownedState = (typeof owned.path === "string" && path.isAbsolute(owned.path))
      ? checkoutState(owned.path, repo.root)
      : { absolute: null, real: null, exists: false, isDirectory: false };
    const stillLive = ownedState.real !== null
      && ownedState.exists && ownedState.isDirectory
      && liveIdentities(listed, repo.root).has(ownedState.real);
    if (stillLive) {
      return textResult(
        successText(owned.path),
        { path: owned.path, branch: owned.branch, issues: owned.issues, created: false },
        false,
      );
    }
    // Stale entry (checkout gone): remembered, not dropped. The drop
    // happens after the replacement checkout verifies, so a refusal or a
    // failed creation below still leaves this row intact with a way back.
    staleOwned = owned;
  }

  // (d) Refusals: the branch already checked out at a LIVE path, the
  // target already a LIVE worktree, or the target inside any checkout /
  // the git common dir. Every record is judged through the one predicate
  // (exists AND is-a-directory): a git record whose path is not a live
  // checkout never blocks a create on its own. When such stale records are
  // the ONLY thing holding the branch or the target path, the tool
  // recovers with a scoped `git worktree prune` (which drops only records
  // whose directories are missing) and proceeds to create; a branch
  // genuinely checked out at a LIVE path is refused exactly as before,
  // with the registry row left intact either way.
  const branchRecords = listed.filter((entry) => entry.branch === branch);
  const liveBranchRecords = branchRecords.filter((entry) => isLiveGitRecord(entry, repo.root));
  const targetRecords = listed.filter((entry) => {
    const st = checkoutState(entry.path, repo.root);
    return st.absolute !== null && st.absolute === resolvedTarget;
  });
  const liveTargetRecords = targetRecords.filter((entry) => isLiveGitRecord(entry, repo.root));
  // Stale records recovered below; reported in details.pruned and in the
  // create warnings so the caller can name what `git worktree prune` took.
  let prunedStale = [];
  if (liveBranchRecords.length === 0 && liveTargetRecords.length === 0
    && (branchRecords.length > 0 || targetRecords.length > 0)) {
    const stalePaths = [];
    for (const entry of [...branchRecords, ...targetRecords]) {
      const st = checkoutState(entry.path, repo.root);
      if (st.absolute !== null && !stalePaths.includes(st.absolute)) stalePaths.push(st.absolute);
    }
    const pruned = git.runArgv("git", ["worktree", "prune"], { cwd: repo.root });
    if (pruned.status !== 0) {
      const reason = ((pruned.stderr || pruned.error || "unknown error") + "").trim();
      return errorResult(
        `cannot create worktree for branch '${branch}': the branch or target path is recorded at ${stalePaths.join(", ")} but no live checkout exists there, and 'git worktree prune' failed (${reason}); run 'git worktree prune' by hand and retry; the registry was left untouched`,
        { branch, issues: issueNumbers, path: target, pruned: [], pruneError: reason },
      );
    }
    let relisted;
    try {
      relisted = git.listWorktrees(repo.root);
    } catch (err) {
      return errorResult(
        `cannot create worktree for branch '${branch}': the branch or target path is recorded at ${stalePaths.join(", ")} but no live checkout exists there, and the worktree list could not be re-read after pruning (${(err && err.message) || err}); the registry was left untouched`,
        { branch, issues: issueNumbers, path: target, pruned: [], pruneError: (err && err.message) || String(err) },
      );
    }
    const stillLiveBranch = relisted.filter((entry) => entry.branch === branch && isLiveGitRecord(entry, repo.root));
    const stillLiveTarget = relisted.filter((entry) => {
      const st = checkoutState(entry.path, repo.root);
      return st.absolute !== null && st.absolute === resolvedTarget && isLiveGitRecord(entry, repo.root);
    });
    if (stillLiveBranch.length > 0) {
      return errorResult(
        `branch '${branch}' is already checked out at ${stillLiveBranch[0].path}: pick another branch or close that worktree first`,
        { branch, issues: issueNumbers, path: stillLiveBranch[0].path, pruned: [] },
      );
    }
    if (stillLiveTarget.length > 0) {
      return errorResult(
        `target path ${target} is already a live worktree (branch '${stillLiveTarget[0].branch}'): pick another branch`,
        { branch, issues: issueNumbers, path: target, pruned: [] },
      );
    }
    const relistedAbs = new Set();
    for (const entry of relisted) {
      const st = checkoutState(entry.path, repo.root);
      if (st.absolute !== null) relistedAbs.add(st.absolute);
    }
    prunedStale = stalePaths.filter((absolute) => !relistedAbs.has(absolute));
    listed = relisted;
  } else {
    if (liveBranchRecords.length > 0) {
      return errorResult(
        `branch '${branch}' is already checked out at ${liveBranchRecords[0].path}: pick another branch or close that worktree first`,
        { branch, issues: issueNumbers, path: liveBranchRecords[0].path },
      );
    }
    const liveAtTarget = liveTargetRecords[0];
    if (liveAtTarget) {
      return errorResult(
        `target path ${target} is already a live worktree (branch '${liveAtTarget.branch}'): pick another branch`,
        { branch, issues: issueNumbers, path: target },
      );
    }
  }
  if (git.isPathInAnyCheckout(repo.root, target)) {
    return errorResult(
      `target path ${target} is inside an existing checkout: pick another branch`,
      { branch, issues: issueNumbers, path: target, pruned: prunedStale },
    );
  }
  // (e2) Occupant (S22, widening I3): ANY pre-existing entry at the target
  // path — an empty or non-empty directory, a file, a FIFO, a symlink, a
  // dangling symlink — is refused before any backend runs, with an
  // actionable message naming what is there and what to do (remove it by
  // hand or pick another branch), never git's raw
  // `fatal: '<path>' already exists`. The empty directory is included
  // precisely because git would silently adopt it. No registry row is
  // written, so removing the occupant lets the next create at the same
  // path succeed. The single exception is the thread's own registered
  // checkout, already returned as `created: false` by the idempotency
  // contract above — everything reaching this point is someone else's
  // entry or no checkout at all.
  try {
    let occupantKind = null;
    try {
      const lst = fs.lstatSync(resolvedTarget);
      if (lst.isSymbolicLink()) {
        let stat = null;
        try {
          stat = fs.statSync(resolvedTarget);
        } catch {
          stat = null;
        }
        // Name the referent when it resolves: a symlink to a file or to
        // a directory says so; a dangling link (nothing resolves) stays
        // a plain symlink with no referent to name.
        if (!stat) occupantKind = "symlink";
        else if (stat.isDirectory()) occupantKind = "symlink to a directory";
        else if (stat.isFile()) occupantKind = "symlink to a file";
        else occupantKind = "symlink";
      } else if (lst.isFile()) {
        occupantKind = "file";
      } else if (lst.isFIFO()) {
        occupantKind = "FIFO";
      } else if (lst.isDirectory()) {
        let empty = false;
        try {
          empty = fs.readdirSync(resolvedTarget).length === 0;
        } catch {
          empty = false;
        }
        occupantKind = empty ? "empty directory" : "non-empty directory";
      } else if (lst.isSocket()) {
        occupantKind = "socket";
      } else {
        occupantKind = "non-directory";
      }
    } catch {
      occupantKind = null;
    }
    if (occupantKind !== null) {
      // "a empty directory" reads wrong; the article follows the kind.
      const article = /^[aeiou]/i.test(occupantKind) ? "an" : "a";
      return errorResult(
        `target path ${target} is occupied by ${article} ${occupantKind}: remove it by hand or pick another branch; the registry was left untouched`,
        { branch, issues: issueNumbers, path: target, pruned: prunedStale },
      );
    }
  } catch {
    // A failed probe never blocks: the backends report their own error.
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

  // (g) Create. S20 branch adoption is resolved BEFORE creating: when
  // `refs/heads/<branch>` already exists (and is not checked out at a
  // live checkout — already refused above), the worktree checks out that
  // EXISTING branch with `git worktree add <target> <branch>` — no `-b`,
  // no base, the ref never created, rewritten or deleted — and the result
  // reports `branchCreated: false` plus a warning naming the adopted
  // branch. Herdr's `worktree create` cannot adopt an existing branch, so
  // the adopt case goes through git and then associates the Herdr
  // workspace BEST-EFFORT via `herdr worktree open --path <path>
  // --cwd <root>`; the checkout succeeding never depends on herdr.
  // When the ref does not exist, creation keeps the herdr-first path
  // with a `git worktree add -b` fallback and reports `branchCreated:
  // true`. Fixed argv only, values as separate elements (herdr rejects
  // --flag=value). Never --focus, never --trust-repository: trusting a
  // repository is a human decision these tools never take. The base ref
  // is the repository's current HEAD.
  let base = null;
  try {
    const head = git.runArgv("git", ["rev-parse", "HEAD"], { cwd: repo.root });
    if (head.status === 0 && head.stdout.trim().length > 0) base = head.stdout.trim();
  } catch {
    base = null;
  }
  let branchExists = false;
  try {
    const ref = git.runArgv("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo.root });
    branchExists = ref.status === 0;
  } catch {
    branchExists = false;
  }
  let createdBy = null;
  let createError = null;
  let branchCreated = null;
  let herdrAssociated = null;
  const adoptWarnings = [];
  if (branchExists) {
    // Adopt: check out the existing branch at the fresh path. No `-b`
    // (the ref already exists), no base (checking out the branch IS the
    // base) — the ref is never created, rewritten or deleted.
    const adopted = git.runArgv("git", ["worktree", "add", target, branch], { cwd: repo.root, timeoutMs: 120000 });
    if (adopted.status === 0) {
      createdBy = "git";
      branchCreated = false;
      adoptWarnings.push(
        `adopted existing branch '${branch}' at ${target}: the worktree checks out that branch as-is, the branch ref was left untouched`,
      );
      // Best-effort Herdr workspace association: reported, never fatal.
      try {
        const opened = git.runArgv(herdrBinary(), git.herdrArgv("open", { cwd: repo.root, path: target }), {
          cwd: repo.root,
          timeoutMs: 60000,
        });
        herdrAssociated = opened.status === 0;
      } catch (err) {
        herdrAssociated = false;
      }
      if (herdrAssociated !== true) {
        adoptWarnings.push(
          `herdr workspace association failed for ${target} ('herdr worktree open' did not succeed): the checkout itself is fine, associate it by hand when needed`,
        );
      }
    } else {
      createError = ((adopted.stderr || adopted.error || "unknown error") + "").trim();
    }
  } else {
  const createParams = { cwd: repo.root, branch, path: target };
  if (base) createParams.base = base;
  const herdrRes = git.runArgv(herdrBinary(), git.herdrArgv("create", createParams), {
    cwd: repo.root,
    timeoutMs: 120000,
  });
  if (herdrRes.status === 0) {
    createdBy = "herdr";
    branchCreated = true;
  } else {
    const fallbackArgv = ["worktree", "add", "-b", branch, target];
    if (base) fallbackArgv.push(base);
    const fallback = git.runArgv("git", fallbackArgv, { cwd: repo.root, timeoutMs: 120000 });
    if (fallback.status === 0) {
      createdBy = "git";
      branchCreated = true;
    } else {
      // Same-branch recovery (H1): the branch ref appeared between the
      // pre-creation resolution above and the fallback (or survives a
      // hand-deleted checkout), so `-b` fails with "already exists".
      // Checking out the existing branch at the fresh path is the
      // recovery — the same adoption semantics, reported the same way;
      // anything else keeps the backend's own error.
      const ref = git.runArgv("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo.root });
      if (ref.status === 0) {
        const retry = git.runArgv("git", ["worktree", "add", target, branch], { cwd: repo.root, timeoutMs: 120000 });
        if (retry.status === 0) {
          createdBy = "git";
          branchCreated = false;
          adoptWarnings.push(
            `adopted existing branch '${branch}' at ${target}: the worktree checks out that branch as-is, the branch ref was left untouched`,
          );
        } else {
          createError = ((retry.stderr || retry.error || "unknown error") + "").trim();
        }
      } else {
        createError = ((fallback.stderr || fallback.error || "unknown error") + "").trim();
      }
    }
  }
  }
  if (!createdBy) {
    return errorResult(
      `failed to create worktree for branch '${branch}': ${createError || "herdr and git both failed"}`,
      { branch, issues: issueNumbers, path: target, pruned: prunedStale },
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
      { branch, issues: issueNumbers, path: target, createdBy, pruned: prunedStale },
    );
  }
  if (!after.some((entry) => {
    const st = checkoutState(entry.path, repo.root);
    return st.absolute !== null && st.absolute === resolvedTarget;
  })) {
    return errorResult(
      `worktree creation could not be verified at ${target}`,
      { branch, issues: issueNumbers, path: target, createdBy, pruned: prunedStale },
    );
  }

  // The stale owned row (if any) is dropped only now that the replacement
  // checkout is verified: every failure above returns with the row intact.
  // Drop by row identity — the (branch, path) pair of the entry this
  // thread owned — never by branch alone and never by a path-key lookup
  // that can match a different row, so a live entry sharing the branch
  // survives whether the stale path is absolute or relative.
  if (staleOwned) {
    try {
      if (typeof registry.removeWorktreeExact === "function") registry.removeWorktreeExact(repo.root, staleOwned.branch, staleOwned.path);
      else if (typeof staleOwned.path === "string" && path.isAbsolute(staleOwned.path)) registry.removeWorktreeByPath(repo.root, path.resolve(staleOwned.path));
      else registry.removeWorktree(repo.root, staleOwned.branch);
    } catch {
      // The upsert below still records the new checkout.
    }
  }

  // I1 one-owner-per-path: when a create lands on its target path, that
  // path ends with exactly ONE registry row — the one just created. Any
  // other row whose path resolves to the same path (whatever its branch or
  // thread, absolute spelling, trailing-slash spelling, or a symlink to the
  // target) is stale by definition and is dropped as part of the create.
  // Never drops a row for a different path; relative rows never match.
  let replacedRows = [];
  try {
    const reread = registry.readRegistry(repo.root);
    const rows = reread && reread.ok === true && Array.isArray(reread.worktrees) ? reread.worktrees : [];
    const targetState = checkoutState(target, repo.root);
    for (const row of rows) {
      if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
      // Skip the stale-owned row already dropped above (same identity).
      if (staleOwned && row.branch === staleOwned.branch && row.path === staleOwned.path) continue;
      let same = false;
      try {
        const rowState = checkoutState(row.path, repo.root);
        if (rowState.absolute !== null && targetState.absolute !== null && rowState.absolute === targetState.absolute) same = true;
        else if (rowState.real !== null && targetState.real !== null && rowState.real === targetState.real) same = true;
      } catch {
        same = false;
      }
      if (same) replacedRows.push(row);
    }
    for (const row of replacedRows) {
      try {
        if (typeof registry.removeWorktreeExact === "function") registry.removeWorktreeExact(repo.root, row.branch, row.path);
        else registry.removeWorktree(repo.root, row.branch);
      } catch {
        // Best effort: the upsert below still records the new checkout.
      }
    }
  } catch {
    replacedRows = [];
  }

  // (i) Registry: upsert the entry owned by this thread. A hand-written
  // row that carries this branch but points at a DIFFERENT live checkout
  // is never replaced: that checkout keeps its registration, the new
  // checkout is recorded alongside it, and the conflict is reported as a
  // warning naming the kept checkout. Liveness is the consolidated
  // checkoutState (exists AND is a directory AND realpath equality, never
  // the process cwd), so a row that reaches a live checkout through a
  // symlink is live while a row whose path git still lists but which no
  // longer exists is never a live conflict. EVERY
  // same-branch row is examined, so a live row is warned about regardless
  // of whether a dead row comes first. Only an absolute row path can name
  // a live checkout (never resolved against the process cwd).
  let stored;
  const conflictWarnings = [];
  try {
    const afterIds = liveIdentities(after, repo.root);
    const targetReal = checkoutState(target, repo.root).real;
    let conflictLive = null;
    try {
      const reread = registry.readRegistry(repo.root);
      const rows = reread && reread.ok === true && Array.isArray(reread.worktrees)
        ? reread.worktrees
        : [];
      for (const row of rows) {
        if (!row || row.branch !== branch) continue;
        if (typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
        const rowState = checkoutState(row.path, repo.root);
        if (!rowState.exists || !rowState.isDirectory) continue;
        if (rowState.real === null || !afterIds.has(rowState.real)) continue;
        if (targetReal !== null && rowState.real === targetReal) continue;
        conflictLive = row;
        break;
      }
    } catch {
      conflictLive = null;
    }
    const recorded = {
      branch,
      path: target,
      thread,
      issues: issueNumbers,
      odd: [],
    };
    if (conflictLive) {
      stored = registry.appendWorktree(repo.root, recorded);
      if (stored.ok) {
        conflictWarnings.push(
          `kept the existing registration for branch '${branch}' at ${conflictLive.path}: a live checkout is recorded there, so the new checkout at ${target} was registered alongside it`,
        );
      }
    } else {
      stored = registry.upsertWorktree(repo.root, recorded);
    }
  } catch (err) {
    stored = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!stored.ok) {
    return errorResult(
      `worktree created at ${target} but the registry write failed: ${stored.error}`,
      { branch, issues: issueNumbers, path: target, createdBy },
    );
  }

  // (i2) Creation hooks (S8 as narrowed by S21, P2-S3): copy unversioned
  // files, install by detected stack, codegraph init when available.
  // S21 creates no symlinks of any kind. Hooks never turn a
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
  const pruneWarnings = prunedStale.length > 0
    ? [`pruned ${prunedStale.length} stale worktree record(s) via 'git worktree prune': ${prunedStale.join(", ")}; git no longer records the missing checkout`]
    : [];
  const replacedWarnings = replacedRows.length > 0
    ? [`replaced ${replacedRows.length} stale registry row(s) at the same path ${target}: ${replacedRows.map((r) => `branch '${r.branch}' at ${r.path}`).join(", ")}; one path has one owner, so the row just created is the only registration`]
    : [];
  const warnings = [...((hooks && hooks.warnings) || []), ...conflictWarnings, ...pruneWarnings, ...replacedWarnings, ...adoptWarnings];
  // S20 adoption reporting: whether the branch was created or adopted,
  // and (adopt case only) whether the best-effort Herdr workspace
  // association happened. The checkout succeeding never depends on herdr.
  const adoptionDetails = { branchCreated };
  if (herdrAssociated !== null) adoptionDetails.herdrAssociated = herdrAssociated;
  return textResult(
    successText(target),
    { path: target, branch, issues: issueNumbers, created: true, hooks, warnings, pruned: prunedStale, replacedRows: replacedRows.map((r) => ({ branch: r.branch, path: r.path })), ...adoptionDetails, ...backupDetails },
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

// `worktree_list` output contract (S6, S9, S19, S24) — terse, one line per
// checkout, pinned in tools/worktree-list.test.js. The FIRST column is the
// NAME (S24): the flattened branch slug, or `principal` for the principal
// checkout, so the printed identifier is exactly what `warp` accepts and
// what `close` can take. The absolute path is not dropped: it stays in
// `details.worktrees[].path` (plus `details.worktrees[].name`).
//   worktree list: <name> <branch> principal
//   worktree list: <name> <branch> thread=<thread> issues=<n,n[,n...]>
// A registered entry whose path is not a live checkout gains ` missing`:
//   worktree list: <name> <branch> thread=<thread> issues=<n,n> missing
// With `all: true`, live checkouts the registry does not know about are
// listed (the principal checkout is never listed as unregistered); the
// session's own one leads the listing and the rest stay path-sorted:
//   worktree list: <name> <branch> unregistered
// The principal checkout (S19) is always listed when git's listing names
// it, and the session's own checkout is the FIRST line; `worktree list:
// none` is retired and only survives as the degenerate fallback when the
// principal cannot be determined and nothing else is listed.
// S16 self-heal: an ABSOLUTE registry path that no longer exists on disk
// (the user deleted the checkout by hand) is removed from the listing AND
// pruned from the registry in one atomic write, so the tool always
// exposes only real checkouts. The pruned paths travel in
// `details.pruned` and in a `details.warnings` line that also says git may
// still record the checkout until `git worktree prune`; when the prune
// write itself fails, the listing still excludes them and says so (plus
// `details.pruneError`). A path that EXISTS but git no longer lists stays
// `missing` and is never pruned. A non-absolute entry can never be
// existence-checked without resolving against the process cwd, so it
// stays listed as `missing` (never live), exactly as before.
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

  // Cross-check the registry against git, then self-heal (S16), all
  // through the consolidated checkoutState. A row is live only when its
  // state exists AND is a directory AND its resolved identity (realpath,
  // absolute fallback) matches a live checkout's — so a row reaching a
  // live checkout through a symlink is live, while a FILE is never live
  // even when git names its path. A row is pruned only when nothing exists
  // at its path (a FILE exists, so it stays missing and is never pruned).
  // A registry path that is not absolute is never resolved against the
  // process cwd, so it can never match a live checkout and is reported
  // missing (and never pruned). Git's own listing paths resolve through
  // the same predicate, so a relative listing path resolves against the
  // repository root, never the process cwd.
  const liveIds = liveIdentities(live, repo.root);
  // S19: the principal checkout is the main worktree of git's listing.
  // repo.root is the toplevel of the CALLER's checkout (a linked worktree
  // when the session runs inside one), so the main root is recovered from
  // the shared common dir instead — for a normal repository
  // <principal>/.git is the common dir, the same recovery runCreationHooks
  // uses for its sources. The principal is the listing entry whose
  // resolved identity equals that main root: realpath with an absolute
  // fallback (the same rule checkoutState uses, never the process cwd),
  // so a symlink spelling of the principal still finds it. It is printed
  // distinguished (`principal`, never thread=/issues=), is never pruned
  // (the registry holds agent rows only) and is never reported as
  // unregistered. When no listing entry matches, no principal line is
  // invented.
  let principalEntry = null;
  let principalPath = null;
  if (typeof repo.commonDir === "string" && path.basename(repo.commonDir) === ".git") {
    try {
      const rawPrincipal = path.resolve(path.dirname(repo.commonDir));
      const principalState = checkoutState(rawPrincipal, repo.root);
      principalPath = principalState.real !== null ? principalState.real : principalState.absolute;
    } catch {
      principalPath = null;
    }
  }
  if (principalPath !== null) {
    for (const entry of live) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repo.root);
      if (st.absolute === null) continue;
      const entryId = st.real !== null ? st.real : st.absolute;
      if (entryId === principalPath) {
        principalEntry = entry;
        break;
      }
    }
    if (!principalEntry) principalPath = null;
  }
  let principalLine = null;
  let principalItem = null;
  if (principalEntry && principalPath !== null) {
    const principalBranch = principalEntry.branch || "(detached)";
    // S24: the first column is the NAME (`principal`), never the path.
    principalLine = `worktree list: principal ${principalBranch} principal`;
    principalItem = { name: "principal", path: principalPath, branch: principalBranch, thread: null, issues: [], status: "live", kind: "principal" };
  }
  const agentRows = [];
  const deadPaths = [];
  for (const entry of read.worktrees) {
    const isAbsoluteRow = typeof entry.path === "string" && path.isAbsolute(entry.path);
    const st = isAbsoluteRow ? checkoutState(entry.path, repo.root) : null;
    const absolute = st ? st.absolute : null;
    // Consolidated existence probe: nothing present (missing checkout,
    // dangling symlink) is pruned; a FILE is present, so it stays listed
    // as missing and is never pruned. Liveness additionally requires a
    // directory (checked below).
    if (absolute !== null && !st.exists) {
      deadPaths.push(entry.path);
      continue;
    }
    // A FILE is never live even when git names its path, and a symlink
    // spelling of a live checkout IS live: liveness is exists AND
    // is-a-directory AND resolved-identity membership, the one predicate.
    const liveHit = st && st.absolute !== null && st.exists && st.isDirectory
      && (st.real !== null ? liveIds.has(st.real) : liveIds.has(st.absolute))
      ? true
      : undefined;
    const issues = Array.isArray(entry.issues) ? entry.issues.slice() : [];
    const thread = typeof entry.thread === "string" && entry.thread.length > 0
      ? entry.thread
      : "unknown";
    const status = liveHit ? "live" : "missing";
    // S24: the first column is the NAME (flattened branch slug); the
    // absolute path stays in details, never in the printed line.
    let rowName = "worktree";
    try {
      rowName = git.slugifyBranch(typeof entry.branch === "string" ? entry.branch : "worktree");
    } catch {
      rowName = "worktree";
    }
    agentRows.push({
      line: `worktree list: ${rowName} ${entry.branch} thread=${thread} issues=${issues.join(",")}`
        + (liveHit ? "" : " missing"),
      item: { name: rowName, path: entry.path, branch: entry.branch, thread, issues, status, kind: "agent" },
    });
  }
  // Prune exactly the dead rows in one atomic registry write, best
  // effort: when the write fails the listing below still excludes them
  // and the warning says so.
  let pruned = [];
  let pruneError = null;
  if (deadPaths.length > 0) {
    try {
      const outcome = registry.pruneWorktrees(repo.root, deadPaths);
      if (outcome && outcome.ok) {
        pruned = Array.isArray(outcome.pruned) ? outcome.pruned : [];
      } else {
        pruneError = (outcome && outcome.error) || "unknown prune error";
      }
    } catch (err) {
      pruneError = (err && err.message) || String(err);
    }
  }
  // S19: the session's own checkout is the FIRST line, whether that is
  // the principal or a registered worktree — the checkout containing or
  // equal to the tool context's cwd, deepest match winning, the
  // principal as a candidate. Identity is realpath with an absolute
  // fallback on both legs (never the process cwd and never a lexical
  // resolve alone), so a symlink spelling of a checkout — or of a
  // subdirectory inside one — still matches that checkout. A session
  // outside every checkout (or inside an unregistered one, without
  // all:true) gets the principal first. Then the principal (when the
  // first line was a worktree), then the remaining agent rows in registry
  // order. The agent-row text contract is unchanged.
  const sessionState = checkoutState(cwd, repo.root);
  const sessionTarget = sessionState.real !== null ? sessionState.real : sessionState.absolute;
  const containsOrEquals = (base, target) => target === base || target.startsWith(base + path.sep);
  let sessionAgent = -1;
  let bestLen = -1;
  if (principalItem !== null && sessionTarget !== null) {
    const principalState = checkoutState(principalItem.path, repo.root);
    const principalBase = principalState.real !== null ? principalState.real : principalState.absolute;
    if (principalBase !== null && containsOrEquals(principalBase, sessionTarget)) {
      bestLen = principalBase.length;
    }
  }
  agentRows.forEach((row, index) => {
    if (typeof row.item.path !== "string" || !path.isAbsolute(row.item.path)) return;
    if (sessionTarget === null) return;
    const rowState = checkoutState(row.item.path, repo.root);
    const base = rowState.real !== null ? rowState.real : rowState.absolute;
    if (base === null) return;
    if (containsOrEquals(base, sessionTarget) && base.length > bestLen) {
      sessionAgent = index;
      bestLen = base.length;
    }
  });
  const lines = [];
  const items = [];
  if (sessionAgent >= 0) {
    lines.push(agentRows[sessionAgent].line);
    items.push(agentRows[sessionAgent].item);
    if (principalLine !== null) {
      lines.push(principalLine);
      items.push(principalItem);
    }
    agentRows.forEach((row, index) => {
      if (index !== sessionAgent) {
        lines.push(row.line);
        items.push(row.item);
      }
    });
  } else {
    if (principalLine !== null) {
      lines.push(principalLine);
      items.push(principalItem);
    }
    for (const row of agentRows) {
      lines.push(row.line);
      items.push(row.item);
    }
  }
  const warnings = [];
  if (deadPaths.length > 0) {
    if (pruneError) {
      warnings.push(
        `could not prune ${deadPaths.length} stale worktree path(s) from the registry (${deadPaths.join(", ")}): ${pruneError}; the listing still excludes them, and git may still record the checkout until 'git worktree prune'`,
      );
    } else {
      warnings.push(
        `pruned ${pruned.length} stale worktree path(s) from the registry: ${pruned.join(", ")}; git may still record the checkout until 'git worktree prune'`,
      );
    }
  }
  if (all) {
    // Only absolute registry paths participate: anything else cannot name
    // a live checkout without resolving against the process cwd. The set
    // comes from the POST-prune registry (re-read; when the re-read fails
    // the pre-prune set minus the pruned paths stands in), so a row pruned
    // above never reappears as "unregistered" just because git still
    // records it. Every git entry is existence-checked on its absolute
    // form (relative entries resolve against the repository root, never
    // the process cwd): a path that does not exist is never reported, in
    // any status, and stays out of details.worktrees as well.
    let postPrune = null;
    try {
      const reread = registry.readRegistry(repo.root);
      if (reread && reread.ok === true && Array.isArray(reread.worktrees)) postPrune = reread.worktrees;
    } catch {
      postPrune = null;
    }
    const registered = new Set();
    for (const entry of postPrune || read.worktrees) {
      if (typeof entry.path !== "string" || !path.isAbsolute(entry.path)) continue;
      const st = checkoutState(entry.path, repo.root);
      // Both spellings count: a symlink row and the git spelling of the
      // same checkout share the realpath, so the checkout is never
      // double-reported as unregistered.
      if (st.absolute !== null) registered.add(st.absolute);
      if (st.real !== null) registered.add(st.real);
    }
    if (!postPrune) {
      for (const dropped of pruned) {
        try {
          registered.delete(path.resolve(dropped));
        } catch {
          // Nothing to delete.
        }
      }
    }
    // The principal checkout is never an extra: it already has its
    // distinguished line. Any other live checkout the registry does not
    // know about — including the session's own checkout when it is
    // unregistered — is reported. The principal exclusion is by resolved
    // identity (realpath with absolute fallback), so a symlink spelling
    // of the principal never surfaces as unregistered. When no principal
    // could be determined, the caller's checkout keeps the old exclusion
    // so the degenerate listing stays exactly `worktree list: none`.
    const self = principalPath !== null ? principalPath : path.resolve(repo.root);
    const extra = live
      .filter((entry) => {
        if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return false;
        // Consolidated predicate: only an existing DIRECTORY surfaces,
        // relative entries resolving against the repository root.
        const st = checkoutState(entry.path, repo.root);
        if (st.absolute === null || !st.exists || !st.isDirectory) return false;
        if (registered.has(st.absolute)) return false;
        if (st.real !== null && registered.has(st.real)) return false;
        const entryId = st.real !== null ? st.real : st.absolute;
        if (entryId === self) return false;
        return true;
      })
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // F2/S19: the session's OWN unregistered checkout is the FIRST line.
    // When the session runs inside a live checkout the registry does not
    // know about, that checkout leads — the principal follows immediately
    // (when the session is not in it), then the agent rows in registry
    // order, then the remaining unregistered extras in path order. The
    // match is deepest-containing on resolved identity, the same rule as
    // the registered session match above. Every other ordering and the
    // agent-row text contract are unchanged.
    let sessionExtra = -1;
    let sessionBest = -1;
    if (sessionTarget !== null) {
      extra.forEach((entry, index) => {
        const st = checkoutState(entry.path, repo.root);
        const base = st.real !== null ? st.real : st.absolute;
        if (base === null) return;
        if (containsOrEquals(base, sessionTarget) && base.length > sessionBest) {
          sessionExtra = index;
          sessionBest = base.length;
        }
      });
    }
    const orderedExtra = sessionExtra >= 0
      ? [extra[sessionExtra], ...extra.filter((_, index) => index !== sessionExtra)]
      : extra;
    const extraLines = [];
    for (const entry of orderedExtra) {
      const branch = entry.branch || "(detached)";
      // Report the resolved absolute form so details.worktrees never
      // carries a relative spelling or a path that does not exist.
      const shown = checkoutState(entry.path, repo.root).absolute || entry.path;
      // S24: the first column is the NAME, exactly what `warp` accepts.
      let extraName = "worktree";
      try {
        extraName = git.slugifyBranch(branch);
      } catch {
        extraName = "worktree";
      }
      extraLines.push({
        line: `worktree list: ${extraName} ${branch} unregistered`,
        item: { name: extraName, path: shown, branch, thread: null, issues: [], status: "unregistered", kind: "unregistered" },
      });
    }
    if (sessionExtra >= 0) {
      // The session's own checkout leads; everything already in
      // lines/items (principal, then agents in registry order) follows.
      lines.unshift(extraLines[0].line);
      items.unshift(extraLines[0].item);
      for (const rest of extraLines.slice(1)) {
        lines.push(rest.line);
        items.push(rest.item);
      }
    } else {
      for (const rest of extraLines) {
        lines.push(rest.line);
        items.push(rest.item);
      }
    }
  }
  // S19 retires `worktree list: none`: with the principal line always
  // present there is always something to list. This fallback survives
  // only for the degenerate case where the principal cannot be determined
  // from git's listing and nothing else is listed either.
  if (lines.length === 0) {
    return textResult("worktree list: none", { worktrees: [], count: 0, all, pruned, warnings, pruneError }, false);
  }
  return textResult(lines.join("\n"), { worktrees: items, count: items.length, all, pruned, warnings, pruneError }, false);
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
  // R4-1: more than one entry resolving to the target with DIFFERENT
  // workspace ids is ambiguity — a first-match win could name a workspace
  // that maps to another checkout, removing the wrong one. Collect every
  // match: one entry, or several carrying the SAME id, still resolves;
  // anything else (conflicting ids, or a match without an id) is null so
  // the caller skips herdr entirely and uses the git path.
  const matchedIds = new Set();
  let matched = 0;
  let missing = false;
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
    matched += 1;
    let id = null;
    for (const key of ["open_workspace_id", "workspace_id", "workspace", "id"]) {
      if (typeof item[key] === "string" && item[key].length > 0) { id = item[key]; break; }
    }
    if (id === null) missing = true;
    else matchedIds.add(id);
  }
  if (matched === 0 || missing || matchedIds.size !== 1) return null;
  return [...matchedIds][0];
}

// Checkouts from the pre-removal snapshot that are gone now, excluding
// the target itself. A hostile or confused remover that deleted another
// checkout fails loudly through this: the caller names the vanished path
// instead of treating the close as successful (or as a bare failure).
// Never throws and never masks the caller's own error. Pass the
// already-fetched post listing when there is one; otherwise one is fetched
// best-effort. When no post-removal listing is available (it failed), the
// comparison falls back to an existence check on the pre-removal live
// paths: a pre-removal live checkout whose directory no longer exists has
// vanished. Every probe is absolute and never consults the process cwd.
function vanishedCheckouts(git, repoRoot, live, resolvedTarget, after) {
  // Identity through the consolidated predicate: compare resolved
  // realpaths (absolute fallback), never bare spellings, so a symlink
  // spelling of a surviving checkout is not misreported as vanished. The
  // target itself is excluded by the same resolved identity (absolute OR
  // realpath), never by lexical spelling alone. Both legs name only paths
  // where NOTHING exists — a path replaced by a FILE reads `missing` in
  // the list and is not reported vanished here either, so list, create and
  // close agree that exists AND is-a-directory is the rule.
  let targetReal = null;
  try {
    targetReal = checkoutState(resolvedTarget, repoRoot).real;
  } catch {
    targetReal = null;
  }
  const isTarget = (st) => {
    if (st.absolute === null) return true;
    if (st.absolute === resolvedTarget) return true;
    if (st.real !== null && targetReal !== null && st.real === targetReal) return true;
    return false;
  };
  const identityOf = (item) => {
    if (!item || typeof item.path !== "string" || item.path.length === 0) return null;
    const st = checkoutState(item.path, repoRoot);
    if (st.absolute === null) return null;
    if (isTarget(st)) return null;
    return { id: st.real !== null ? st.real : st.absolute, absolute: st.absolute, exists: st.exists, isDirectory: st.isDirectory };
  };
  let current = after;
  if (!current) {
    try {
      current = git.listWorktrees(repoRoot);
    } catch {
      current = null;
    }
  }
  if (current) {
    try {
      const afterSet = new Set();
      for (const item of current) {
        const seen = identityOf(item);
        // The target itself is excluded by identityOf; every other listed
        // record counts as present by resolved identity.
        if (seen !== null) afterSet.add(seen.id);
      }
      const vanished = [];
      for (const item of live || []) {
        const before = identityOf(item);
        if (before === null) continue;
        if (!afterSet.has(before.id)) {
          // Same rule as the fallback: only a path where NOTHING exists
          // has vanished; a FILE reads missing, never vanished.
          if (!before.exists) vanished.push(before.absolute);
        }
      }
      return vanished;
    } catch {
      // Fall through to the existence check below.
    }
  }
  const vanished = [];
  try {
    for (const item of live || []) {
      const before = identityOf(item);
      if (before === null) continue;
      // Only a path where nothing exists has vanished: something present
      // (even a FILE) is reported `missing` elsewhere, never vanished.
      if (!before.exists) vanished.push(before.absolute);
    }
  } catch {
    return [];
  }
  return vanished;
}

// S24 name resolution — the ONE place checkout names resolve to
// checkouts. `worktree_close` (by `name`) and the `warp` command verb
// both call this, never separate logic. A name is the flattened branch
// slug (`slugifyBranch`, already exported by lib/worktree-git.js), or
// `principal` for the principal checkout.
//
// `principal` is `{path, branch} | null` (null when git's listing names
// no principal). Returns either:
// - `{ok: true, kind: "principal", name, path, branch, entry: null}`, or
// - `{ok: true, kind: "agent", name, path, branch, entry}`, or
// - `{ok: false, error, candidates}` where candidates are the known names
//   for the fail-closed message.
// An unknown name fails closed; two registry rows flattening to one name
// are AMBIGUOUS and fail closed naming every matching row, never picking
// one.
// Names are the flattened branch slug, and `principal` is reserved for the
// principal checkout. A branch whose slug is also `principal`, or a live
// checkout the registry does not own that shares a name with a registered
// row, makes that name genuinely ambiguous to whoever read it in the
// listing — so those cases fail closed instead of silently selecting one
// checkout. The caller can always pass the path or the branch.
function slugOf(git, branch) {
  try {
    const slug = typeof branch === "string" ? git.slugifyBranch(branch) : null;
    return typeof slug === "string" && slug.length > 0 ? slug : null;
  } catch {
    return null;
  }
}

function prefixScore(query, slug) {
  const q = String(query);
  const s = String(slug);
  const shared = Math.min(q.length, s.length);
  let score = 0;
  while (score < shared && q[score] === s[score]) score += 1;
  return score;
}

// Live checkouts git lists that no registry row owns, by resolved identity.
// `all: true` prints them, so a name they share with a registered row is
// ambiguous to the reader even though only the registered row is selectable.
// The principal checkout is NOT one of them: it prints as `principal`, never
// by its branch, so a branch whose slug happens to equal the principal's own
// branch slug leaves the name unique instead of colliding with it.
function liveUnregisteredEntries(rows, live, repoRoot, principal) {
  const owned = new Set();
  for (const row of rows) {
    if (!row || typeof row.path !== "string" || row.path.length === 0) continue;
    const st = checkoutState(row.path, repoRoot);
    if (st.absolute !== null) owned.add(st.absolute);
    if (st.real !== null) owned.add(st.real);
  }
  let principalId = null;
  if (principal && typeof principal.path === "string" && principal.path.length > 0) {
    const st = checkoutState(principal.path, repoRoot);
    principalId = st.real !== null ? st.real : st.absolute;
  }
  const out = [];
  for (const entry of live || []) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    // The same liveness the listing applies: a git record whose directory is
    // gone (prunable) is not printed as an unregistered checkout, so it must
    // not make a name ambiguous either.
    if (!st.exists || !st.isDirectory) continue;
    const id = st.real !== null ? st.real : st.absolute;
    if (id === null || owned.has(id)) continue;
    if (principalId !== null && id === principalId) continue;
    out.push({ path: id, branch: entry.branch || "(detached)" });
  }
  return out;
}

function resolveCheckoutByName(name, git, read, principal, live, repoRoot) {
  const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
  const extras = liveUnregisteredEntries(rows, live, repoRoot, principal);
  const knownNames = [];
  if (principal) knownNames.push("principal");
  const seen = new Set();
  for (const item of [...rows, ...extras]) {
    const slug = slugOf(git, item && item.branch);
    if (slug === null || seen.has(slug)) continue;
    seen.add(slug);
    knownNames.push(slug);
  }
  if (name === "principal") {
    const clashes = [];
    for (const row of rows) {
      if (slugOf(git, row && row.branch) === "principal") clashes.push(`'${row.branch}' at ${row.path}`);
    }
    for (const extra of extras) {
      if (slugOf(git, extra.branch) === "principal") clashes.push(`'${extra.branch}' at ${extra.path} (unregistered)`);
    }
    if (clashes.length > 0) {
      return {
        ok: false,
        error: `worktree name "principal" is ambiguous: it names the principal checkout and ${clashes.join(", ")}; pass the path or branch instead`,
        candidates: knownNames,
      };
    }
    if (principal) {
      return {
        ok: true, kind: "principal", name: "principal",
        path: principal.path, branch: principal.branch, entry: null,
      };
    }
    return {
      ok: false,
      error: `no registered worktree for "principal": the principal checkout could not be determined; known worktrees: ${knownNames.join(", ") || "(none)"}`,
      candidates: knownNames,
    };
  }
  const matches = [];
  for (const row of rows) {
    if (slugOf(git, row && row.branch) === name) matches.push(row);
  }
  const extraMatches = extras.filter((extra) => slugOf(git, extra.branch) === name);
  if (matches.length + extraMatches.length > 1) {
    const named = [
      ...matches.map((row) => `'${row.branch}' at ${row.path}`),
      ...extraMatches.map((extra) => `'${extra.branch}' at ${extra.path} (unregistered)`),
    ].join(", ");
    return {
      ok: false,
      error: `worktree name "${name}" is ambiguous: ${named}; pass the path or branch instead`,
      candidates: knownNames,
    };
  }
  if (matches.length === 1) {
    const row = matches[0];
    return {
      ok: true, kind: "agent", name,
      path: row.path, branch: row.branch, entry: row,
    };
  }
  if (extraMatches.length === 1) {
    const only = extraMatches[0];
    return {
      ok: false,
      error: `no registered worktree for ${JSON.stringify(name)}: '${only.branch}' at ${only.path} is unregistered, and neither close nor warp acts on an unregistered checkout`,
      candidates: knownNames,
    };
  }
  // Unknown: fail closed in the style of the unknown-path error, naming
  // the closest known candidates by name.
  const ranked = [
    ...rows.map((row) => ({ branch: row && row.branch, path: row && row.path })),
    ...extras,
  ]
    .map((item) => ({ item, slug: slugOf(git, item.branch) || "" }))
    .sort((a, b) => prefixScore(name, b.slug) - prefixScore(name, a.slug))
    .slice(0, 3);
  const named = ranked.map((item) => `'${item.slug}' (branch '${item.item.branch}') at ${item.item.path}`).join(", ");
  const suffix = ranked.length > 0 ? `: closest worktrees: ${named}` : ": no worktrees are registered";
  return {
    ok: false,
    error: `no registered worktree for ${JSON.stringify(name)}${suffix}`,
    candidates: knownNames,
  };
}

// The principal checkout for name resolution: the live listing entry
// whose resolved identity equals the main root recovered from the shared
// common dir (the same recovery the list uses). Null when git's listing
// names no such entry, so no principal line — and no `principal` name —
// is invented.
function principalForName(git, repoRoot, repo, live) {
  try {
    if (typeof repo.commonDir !== "string" || path.basename(repo.commonDir) !== ".git") return null;
    const rawPrincipal = path.resolve(path.dirname(repo.commonDir));
    const principalState = checkoutState(rawPrincipal, repoRoot);
    const principalPath = principalState.real !== null ? principalState.real : principalState.absolute;
    if (principalPath === null) return null;
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      if (st.absolute === null) continue;
      const entryId = st.real !== null ? st.real : st.absolute;
      if (entryId === principalPath) {
        return { path: principalPath, branch: entry.branch || "(detached)" };
      }
    }
    return null;
  } catch {
    return null;
  }
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
  const rawName = params ? params.name : undefined;
  const force = !!params && params.force === true;
  const hasPath = typeof rawPath === "string" && rawPath.length > 0;
  const hasBranch = typeof rawBranch === "string" && rawBranch.length > 0;
  const hasName = typeof rawName === "string" && rawName.length > 0;
  if (!hasPath && !hasBranch && !hasName) {
    return errorResult(
      "worktree_close requires a path or a branch or a name: pass the worktree path, branch, or name to close",
      { force },
    );
  }
  // S24: `name` is a third selector beside `path` and `branch` — at most
  // one of the three. (The pre-existing path+branch pair keeps its
  // agree-or-disagree behaviour below.)
  if (hasName && (hasPath || hasBranch)) {
    return errorResult(
      "worktree_close accepts only one of path, branch, or name: pass only one",
      { path: rawPath, branch: rawBranch, name: rawName, force },
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
  const byPath = hasPath && !hasName ? registry.findByPath(repo.root, rawPath) : null;
  const byBranch = hasBranch && !hasName ? registry.findByBranch(repo.root, rawBranch) : null;
  if (hasPath && hasBranch && byPath && byBranch && byPath.branch !== byBranch.branch) {
    return errorResult(
      `worktree_close path and branch disagree: path resolves to branch '${byPath.branch}' but branch '${rawBranch}' is registered elsewhere; pass only one`,
      { path: rawPath, branch: rawBranch, force },
    );
  }
  // S24: resolve `name` through the shared resolver (the same one `warp`
  // uses). An unknown or ambiguous name fails closed here, before
  // anything is verified or removed.
  let entry = byPath || byBranch || null;
  if (hasName) {
    let liveForName;
    try {
      liveForName = git.listWorktrees(repo.root);
    } catch (err) {
      return errorResult(
        `cannot list worktrees: ${(err && err.message) || err}`,
        { name: rawName, force },
      );
    }
    const resolved = resolveCheckoutByName(rawName, git, read, principalForName(git, repo.root, repo, liveForName), liveForName, repo.root);
    if (!resolved.ok) {
      return errorResult(resolved.error, { query: rawName, candidates: resolved.candidates, force });
    }
    if (resolved.kind === "principal") {
      return errorResult(
        `cannot close the principal checkout at ${resolved.path}: worktree_close only closes registered agent worktrees; the checkout and the registry were left untouched`,
        { name: rawName, path: resolved.path, branch: resolved.branch, force },
      );
    }
    entry = resolved.entry;
  }
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
  // Pre-removal liveness through the same predicate: the target must exist
  // as a directory AND be recorded by git. A hand-deleted checkout git
  // still records, or a path replaced by a FILE, is stale — the entry is
  // kept, exactly like the list's `missing`.
  const closeLiveIds = liveIdentities(live, repo.root);
  const targetState = checkoutState(target, repo.root);
  const targetLive = targetState.absolute !== null && targetState.exists && targetState.isDirectory
    && (targetState.real !== null ? closeLiveIds.has(targetState.real) : closeLiveIds.has(targetState.absolute));
  if (!targetLive) {
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
    // The remover exited non-zero — but a lying backend may still have
    // deleted a checkout other than the target on its way out, so the
    // vanished comparison runs BEFORE this early return, never after it.
    // Either way the registry entry is kept; only the message differs.
    const vanishedOnFailure = vanishedCheckouts(git, repo.root, live, resolvedTarget);
    if (vanishedOnFailure.length > 0) {
      return errorResult(
        `worktree removal failed (${removeError || "failed to remove worktree"}) and removed an unexpected checkout at ${vanishedOnFailure[0]}: expected only ${target} to be removed; the checkout and the registry entry were left for inspection`,
        { branch, path: target, force, removed: false, vanished: vanishedOnFailure },
      );
    }
    // The backend's own reason (e.g. git's dirty-checkout refusal) is the
    // whole message; checkout and registry entry are left untouched.
    return errorResult(removeError || "failed to remove worktree", {
      branch, path: target, force, removed: false,
    });
  }

  // Verify against git before dropping the entry: the path must be gone.
  // The check never depends on the post-removal listing alone: when the
  // listing itself fails, the existence fallback above still names a
  // vanished checkout (registry kept) instead of hiding it behind an
  // unverifiable-removal message. Covers both the herdr and git paths.
  let after;
  try {
    after = git.listWorktrees(repo.root);
  } catch (err) {
    const vanishedWithoutList = vanishedCheckouts(git, repo.root, live, resolvedTarget, null);
    if (vanishedWithoutList.length > 0) {
      return errorResult(
        `worktree removal removed an unexpected checkout at ${vanishedWithoutList[0]}: expected only ${target} to be removed; the checkout and the registry entry were left for inspection`,
        { branch, path: target, force, removedBy, vanished: vanishedWithoutList },
      );
    }
    return errorResult(
      `worktree removal could not be verified at ${target}: ${(err && err.message) || err}`,
      { branch, path: target, force, removedBy },
    );
  }
  // R4-2: the backend must not have removed anything but the target. A
  // hostile or confused remover that deleted another checkout fails
  // loudly here: the vanished path is named, the close is not treated as
  // successful, and the registry entry is left in place. Covers both the
  // herdr and the git removal paths; a legitimate single-checkout removal
  // (only the target gone) never trips it.
  const vanished = vanishedCheckouts(git, repo.root, live, resolvedTarget, after);
  if (vanished.length > 0) {
    return errorResult(
      `worktree removal removed an unexpected checkout at ${vanished[0]}: expected only ${target} to be removed; the checkout and the registry entry were left for inspection`,
      { branch, path: target, force, removedBy, vanished },
    );
  }
  if (after.some((item) => {
    const st = checkoutState(item.path, repo.root);
    return st.absolute !== null && st.absolute === resolvedTarget;
  })) {
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
  description: "List the principal checkout plus the agent worktrees registered for this repository, cross-checked against live checkouts with their owning thread. The session's own checkout is listed first. Pass all:true to also show live checkouts the registry does not know about. Rows whose paths no longer exist are excluded and pruned from the registry.",
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
  description: "Remove a registered agent worktree checkout and its Herdr workspace while keeping the branch. Pass the worktree name, path, or branch (only one), plus force:true to close a dirty checkout.",
  parameters: Type.Object({
    name: opt(Type.String({ description: "Name of the registered worktree to close (the flattened branch slug, or principal)" })),
    path: opt(Type.String({ description: "Path of the registered worktree to close" })),
    branch: opt(Type.String({ description: "Branch of the registered worktree to close" })),
    force: opt(Type.Boolean({ description: "Close even when the checkout is dirty" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeClose(params, ctx);
  },
});

// ---------------------------------------------------------------------------
// `worktree_session_open` (S25, T34): open a Pi session in a Herdr
// worktree, and only in a worktree.
//
// Scope is enforced, not documented: the worktree resolves through the
// S24 name resolver (`resolveCheckoutByName` — one resolver, never a
// second one) against THIS repository's registered live worktrees only. A
// branch spelling resolves through its flattened slug; an absolute or
// relative PATH is refused with an actionable message naming the listing;
// the principal checkout is refused because a session there delegates
// nothing; a registered row whose checkout is gone is refused as stale.
//
// Launching is composed, because no single Herdr command starts a
// worktree AND a command in it: the worktree's Herdr workspace comes
// from `herdr worktree list --cwd <root>` (`open_workspace_id` for that
// branch/path); when there is none, `herdr worktree open
// --branch <b> --cwd <root> --no-focus` opens one and its
// `root_pane.pane_id` / `workspace.workspace_id` are used; when there IS
// one, `herdr pane list --workspace <id>` names the panes and the ROOT
// pane (the lowest `<workspace>:pN` index, the convention every observed
// workspace uses) is used. Then
// `herdr agent start <name> --kind pi --pane <pane> --timeout <ms> --
// <pi argv>` starts Pi in that pane, whose cwd is the worktree — so Pi's
// own session directory is the worktree's and no `--session-dir` is
// passed. The Pi argv is `--name <agent>` plus `--session <id>` when
// resuming, or `--session-id <minted>` (a fresh UUID, valid in Pi's
// `[A-Za-z0-9._-]` session-id charset) for a new session so the id is
// known immediately and returned.
//
// `notify` (default true) starts the S26 finish watcher for the opened
// pane; `notify: false` starts none.
// ---------------------------------------------------------------------------

// How long `herdr agent start` waits for interactive readiness (its own
// `--timeout`; max 300000). Fixed so the argv is exact and testable.
const AGENT_START_TIMEOUT_MS = 120000;

// ---------------------------------------------------------------------------
// Finish subscription (S26, T35): whoever opens a session subscribes to
// its real finish.
//
// `worktree_session_open` with `notify !== false` starts ONE watcher for
// the pane it just opened; `notify: false` starts none. Watchers coexist
// in `SESSION_WATCHERS`, keyed by pane id (one entry per pane; opening a
// pane that already has a watcher replaces it), and
// `clearSessionWatchers` stops them all so tests can reset the registry.
//
// WHAT it watches: the pane id the tool returns in `details.paneId`,
// read with `herdr agent get <paneId>` — whose real shape is
// `{result: {agent: {agent: "pi", agent_status, pane_id, tokens: {...}}}}`.
// A missing agent answers
// `{error: {code: "agent_not_found", message: "agent target <t> not found"}}`
// — the VANISHED signal. The target is the pane id, never the kind name.
//
// WHAT a finish is: `agent_status` reading `idle` AFTER that same pane
// was observed `working` at least once. `blocked` is the delegate waiting
// for input and never counts as the `working` observation. A delegate that
// never reports `working` is reported as never-started, honestly; a pane
// that vanishes is reported as vanished; reaching the maximum wait without
// either is reported as a timeout. None of those three claims a finish.
//
// HOW it polls: a bounded `setInterval`, never a busy loop, with a launch
// grace window before anything is concluded (the delegate is idle right
// after `agent start`, so a finish inside it is impossible), a maximum
// wait, and the timer cleared and unref'd when it ends. The interval, the
// grace and the maximum are injectable through the options object (with
// production defaults below) so tests run in milliseconds.
//
// HOW it delivers: `pi.sendMessage({customType:
// "herdr-agent-sessions.finished", content, display: true, details},
// {deliverAs: "followUp", triggerTurn: true})` — the route incoming
// session messages already use, because the orchestrator has to act on it.
// The content states which outcome was observed and names the worktree,
// the pane and the session id; the details carry the same facts as data.
// ---------------------------------------------------------------------------

// Production timing: poll like a state beat, grace past the launch idle,
// and a maximum wait after which the delegate is reported as timed out.
const SESSION_WATCH_DEFAULTS = { intervalMs: 15000, graceMs: 60000, maxWaitMs: 4 * 60 * 60 * 1000 };

// Live watchers by pane id. The host `pi` captured at load, whose
// `sendMessage` is the delivery route (null until the extension loads).
const SESSION_WATCHERS = new Map();
let sessionNotifyPi = null;

// Resolve the watcher timing: explicit options win, then the
// `GENTLE_WORKTREE_WATCH_*_MS` overrides (tests), then production
// defaults. Non-positive or unparseable values never apply.
function sessionWatchOptions(overrides) {
  const pick = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
  const envPick = (name) => {
    const raw = process.env[name];
    if (typeof raw !== "string" || raw.length === 0) return undefined;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  const src = overrides && typeof overrides === "object" ? overrides : {};
  return {
    intervalMs: pick(src.intervalMs) ?? envPick("GENTLE_WORKTREE_WATCH_INTERVAL_MS") ?? SESSION_WATCH_DEFAULTS.intervalMs,
    graceMs: pick(src.graceMs) ?? envPick("GENTLE_WORKTREE_WATCH_GRACE_MS") ?? SESSION_WATCH_DEFAULTS.graceMs,
    maxWaitMs: pick(src.maxWaitMs) ?? envPick("GENTLE_WORKTREE_WATCH_MAX_MS") ?? SESSION_WATCH_DEFAULTS.maxWaitMs,
  };
}

// One outcome, one text: which of finished / never-started / vanished /
// timed-out was observed, naming the worktree, the pane and the session
// id. Only the finished text claims a finish.
function sessionWatchContent(outcome, { worktree, paneId, sessionId, maxWaitMs }) {
  switch (outcome) {
    case "finished":
      return `worktree session finished: ${worktree} ${sessionId} in pane ${paneId} is idle after working`;
    case "never-started":
      return `worktree session never started: ${worktree} ${sessionId} in pane ${paneId} went idle without ever reporting working (the published state is another process's view, so "never started" and "never reported anything" are indistinguishable)`;
    case "vanished":
      return `worktree session vanished: ${worktree} ${sessionId} in pane ${paneId} disappeared (agent not found)`;
    default:
      return `worktree session timed out: ${worktree} ${sessionId} in pane ${paneId} did not finish within ${maxWaitMs}ms`;
  }
}

// Is this published binding OUR session? The value is the session file
// this plugin reports (`<timestamp>_<session-id>.jsonl`), so the id is
// matched at the END of the file name, never as a substring: a substring
// match calls another session ours — `session: "abc"` would accept
// `..._xabc.jsonl`, and `session: "."` would accept any path at all.
function bindingNamesSession(value, sessionId) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  if (value === sessionId) return true;
  const base = path.basename(value);
  return base.endsWith(`_${sessionId}.jsonl`) || base === `${sessionId}.jsonl`;
}

// Read one `herdr agent get` reply: `{status, vanished, bound, foreign}`.
// The `agent_not_found` error is the vanished signal; `agent_session.value`
// is the session BINDING this plugin publishes (the session file, whose
// name carries the id), so an observation is attributed to the session
// this tool opened instead of to whoever holds that pane now. `bound`
// means the pane reports OUR session and `foreign` that it reports a
// different one; both stay false when no binding is available, where the
// published status is all there is. Anything unparseable is neither, so
// the watcher keeps polling to its maximum.
function sessionWatchReading(stdout, sessionId) {
  const unreadable = { status: null, vanished: false, bound: false, foreign: false };
  let doc = null;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return unreadable;
  }
  if (!doc || typeof doc !== "object") return unreadable;
  const err = doc.error;
  if (err && typeof err === "object" && err.code === "agent_not_found") {
    return { status: null, vanished: true, bound: false, foreign: false };
  }
  const agent = doc.result && typeof doc.result === "object" ? doc.result.agent : null;
  const boundValue = agent && agent.agent_session && typeof agent.agent_session.value === "string"
    ? agent.agent_session.value
    : null;
  const bound = bindingNamesSession(boundValue, sessionId);
  const foreign = boundValue !== null && !bound;
  const status = agent && typeof agent.agent_status === "string"
    ? agent.agent_status
    : doc.result && typeof doc.result === "object" && typeof doc.result.agent_status === "string"
      ? doc.result.agent_status
      : typeof doc.agent_status === "string" ? doc.agent_status : null;
  return { status, vanished: false, bound, foreign };
}

const AGENT_GET_TIMEOUT_MS = 10000;

// One non-blocking `herdr agent get <pane>`: a hung daemon must never freeze
// the session that opened the delegate, so the poll is an async child with
// its own kill timer instead of a synchronous spawn on the event loop.
// `null` means "no reading", never a state.
function pollAgentGet(paneId, repoRoot, onDone) {
  let child = null;
  let settled = false;
  let killer = null;
  const done = (value) => {
    if (settled) return;
    settled = true;
    if (killer !== null) {
      try {
        clearTimeout(killer);
      } catch {}
    }
    onDone(value);
  };
  try {
    const git = libRequire("worktree-git.js");
    child = spawn(herdrBinary(), git.herdrArgv("agent-get", { target: paneId }), {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    done(null);
    return;
  }
  killer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
    done(null);
  }, AGENT_GET_TIMEOUT_MS);
  if (killer && typeof killer.unref === "function") {
    try {
      killer.unref();
    } catch {}
  }
  let out = "";
  try {
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.on("error", () => done(null));
    child.on("close", () => done(out));
  } catch {
    done(null);
  }
}

// Start the watcher for one opened pane. Replaces any watcher already
// keyed at that pane id; the registry keeps every other pane's watcher.
// The timer is unref'd so it never holds the process open, and cleared
// with the registry entry the moment an outcome is delivered.
function startAgentSessionWatcher({ paneId, worktree, branch, sessionId, agentName, workspaceId, path: targetPath, repoRoot }, options) {
  const { intervalMs, graceMs, maxWaitMs } = sessionWatchOptions(options);
  const startedAt = Date.now();
  let seenWorking = false;
  let sawBound = false;
  let pendingOutcome = null;
  let pendingAt = 0;
  let polling = false;
  let delivering = false;
  const previous = SESSION_WATCHERS.get(paneId);
  if (previous) {
    try {
      clearInterval(previous.timer);
    } catch {}
  }
  // Deliver the one outcome. A host whose `sendMessage` throws or rejects
  // does not turn the notification into silence: the outcome stays pending
  // and is retried on the next tick, bounded by the same maximum wait
  // measured from the outcome itself.
  const stop = () => {
    const record = SESSION_WATCHERS.get(paneId);
    if (record && record.timer === timer) SESSION_WATCHERS.delete(paneId);
    try {
      clearInterval(timer);
    } catch {}
  };
  const attemptDelivery = () => {
    // One send in flight at a time: a promise that settles after the next
    // tick must not deliver the same outcome a second time.
    if (delivering) return;
    const sender = sessionNotifyPi && typeof sessionNotifyPi.sendMessage === "function" ? sessionNotifyPi : null;
    if (!sender) {
      stop();
      return;
    }
    const content = sessionWatchContent(pendingOutcome, { worktree, paneId, sessionId, maxWaitMs });
    const details = { worktree, branch, path: targetPath, paneId, workspaceId, sessionId, agentName, outcome: pendingOutcome, seenWorking };
    const retry = () => {
      delivering = false;
      if (Date.now() - pendingAt >= maxWaitMs) stop();
    };
    let sent;
    delivering = true;
    try {
      sent = sender.sendMessage(
        { customType: "herdr-agent-sessions.finished", content, display: true, details },
        { deliverAs: "followUp", triggerTurn: true },
      );
    } catch {
      retry();
      return;
    }
    if (sent && typeof sent.then === "function") {
      Promise.resolve(sent).then(() => {
        delivering = false;
        stop();
      }, retry);
      return;
    }
    delivering = false;
    stop();
  };
  const finish = (outcome) => {
    pendingOutcome = outcome;
    pendingAt = Date.now();
    attemptDelivery();
  };
  const timer = setInterval(() => {
    if (pendingOutcome !== null) {
      attemptDelivery();
      return;
    }
    if (polling) return;
    polling = true;
    pollAgentGet(paneId, repoRoot, (stdout) => {
      polling = false;
      if (pendingOutcome !== null) return;
      const reading = stdout === null
        ? { status: null, vanished: false, bound: false, foreign: false }
        : sessionWatchReading(stdout, sessionId);
      const elapsed = Date.now() - startedAt;
      const ours = reading.bound || !reading.foreign;
      if (reading.status === "working" && ours) seenWorking = true;
      if (reading.bound) sawBound = true;
      // Launch grace: the delegate is idle right after `agent start`, so no
      // outcome — finish, never-started, vanished or timeout — is concluded
      // inside it. Observations still count: a `working` here arms the finish.
      if (elapsed < graceMs) return;
      if (reading.vanished) {
        finish("vanished");
        return;
      }
      // A pane holding a DIFFERENT session is never ours: a finish is only
      // ever concluded for the session this tool opened.
      if (reading.foreign) {
        finish(sawBound ? "vanished" : "never-started");
        return;
      }
      if (reading.status === "idle") {
        finish(seenWorking ? "finished" : "never-started");
        return;
      }
      // `blocked` is the delegate waiting for input — never a finish — and
      // anything unparseable is ignored: both keep polling to the maximum.
      if (elapsed >= maxWaitMs) {
        finish("timed-out");
      }
    });
  }, intervalMs);
  if (timer && typeof timer.unref === "function") {
    try {
      timer.unref();
    } catch {}
  }
  SESSION_WATCHERS.set(paneId, { timer, startedAt, paneId, worktree, sessionId });
  return timer;
}

// Stop every watcher and empty the registry. Tests clear the pane-keyed
// registry through this between cases.
function clearSessionWatchers() {
  for (const record of SESSION_WATCHERS.values()) {
    try {
      clearInterval(record.timer);
    } catch {}
  }
  SESSION_WATCHERS.clear();
}

function sessionSuccessText(worktree, sessionId) {
  return `worktree session open: ${worktree} ${sessionId}`;
}

// A value that is unambiguously a filesystem path rather than a worktree
// name: absolute, or explicitly relative (`.`, `..`, `./`, `../`). A bare
// `foo/bar` is NOT refused here — it may be a branch spelling, which
// resolves through its slug below — but when no name resolves and the
// value carries a separator, it is refused as a path rather than reported
// as an unknown name.
function isExplicitPath(value) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (path.isAbsolute(value)) return true;
  if (value === "." || value === "..") return true;
  if (value.startsWith("./") || value.startsWith("../")) return true;
  return false;
}

function looksLikePath(value) {
  if (isExplicitPath(value)) return true;
  if (typeof value !== "string") return false;
  return value.includes("/") || value.includes("\\");
}

function pathRefusal(value) {
  return `worktree session open refuses ${JSON.stringify(value)}: pass the worktree NAME 'worktree list' prints, not a path`; 
}

// The Herdr workspace id for a worktree from `herdr worktree list` JSON
// (`{result: {worktrees: [{path, branch, open_workspace_id, ...}]}}`,
// with the same tolerant fallbacks `herdrWorkspaceId` uses). An entry
// matches by resolved path identity (absolute entries directly, relative
// entries against the repository root, never the process cwd) or by exact
// branch equality. Returns `{id, matched}`: `matched` counts the entries
// that named this worktree, so callers can tell "no workspace" (open
// one) from "several disagreeing workspaces" (fail closed) apart.
function sessionWorkspaceId(stdout, repoRoot, branch, targetCwd) {
  const none = { id: null, matched: 0, claimed: 0, conflict: false };
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
    return { id: null, matched: 0, parseError: true };
  }
  if (!list) return none;
  const ids = new Set();
  let matched = 0;
  let claimed = 0;
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    let hit = false;
    if (typeof item.path === "string" && item.path.length > 0) {
      try {
        const resolved = path.isAbsolute(item.path)
          ? path.resolve(item.path)
          : path.resolve(repoRoot, item.path);
        if (resolved === targetCwd) hit = true;
      } catch {
        // Unresolvable entries never match.
      }
    }
    if (!hit && typeof item.branch === "string" && item.branch === branch) hit = true;
    if (!hit) continue;
    matched += 1;
    let id = null;
    for (const key of ["open_workspace_id", "workspace_id", "workspace", "id"]) {
      if (typeof item[key] === "string" && item[key].length > 0) { id = item[key]; break; }
    }
    // A matching entry WITHOUT a workspace id is the normal shape of a
    // worktree Herdr has not opened (`open_workspace_id` is simply absent),
    // not a conflict: the caller opens one. Only two DIFFERENT workspace
    // ids claiming the same worktree are a genuine disagreement.
    if (id !== null) { claimed += 1; ids.add(id); }
  }
  if (matched === 0) return { id: null, matched: 0, claimed: 0, conflict: false };
  if (ids.size > 1) return { id: null, matched, claimed, conflict: true };
  if (claimed === 0) return { id: null, matched, claimed, conflict: false };
  return { id: [...ids][0], matched, claimed, conflict: false };
}

// The workspace's ROOT pane from `herdr pane list` JSON
// (`{result: {panes: [{pane_id, ...}]}}`, tolerant fallbacks): the lowest
// `<workspace>:pN` index, the convention every observed workspace uses.
// Entries without a parseable index sort last; null when no pane id is
// present at all.
function rootPaneId(stdout, workspaceId) {
  let panes = null;
  try {
    const doc = JSON.parse(stdout);
    if (doc && doc.result && Array.isArray(doc.result.panes)) {
      panes = doc.result.panes;
    } else if (doc && Array.isArray(doc.panes)) {
      panes = doc.panes;
    } else if (doc && Array.isArray(doc.result)) {
      panes = doc.result;
    }
  } catch {
    return null;
  }
  if (!panes) return null;
  let best = null;
  let bestN = Infinity;
  for (const pane of panes) {
    if (!pane || typeof pane !== "object") continue;
    const id = typeof pane.pane_id === "string" && pane.pane_id.length > 0
      ? pane.pane_id
      : typeof pane.id === "string" && pane.id.length > 0 ? pane.id : null;
    if (id === null) continue;
    // The workspace filter travels to herdr, but membership is verified
    // here too: `herdr pane list` without it is global (it lists panes of
    // every workspace, measured), so a pane of another workspace would
    // start Pi outside the worktree. A pane id carries its workspace as
    // its prefix.
    if (typeof workspaceId === "string" && workspaceId.length > 0) {
      const owner = typeof pane.workspace_id === "string" && pane.workspace_id.length > 0 ? pane.workspace_id : null;
      // Both facts must agree: the owner the pane reports AND the workspace
      // its id carries. Trusting either one alone lets through a pane that
      // claims our workspace but belongs to another one.
      if (owner !== null && owner !== workspaceId) continue;
      if (!id.startsWith(`${workspaceId}:`)) continue;
    }
    const match = /:p(\d+)$/.exec(id);
    const n = match ? Number(match[1]) : Infinity;
    if (n < bestN) {
      bestN = n;
      best = id;
    }
  }
  return best;
}

// The `cwd` a pane reports, or null when it reports none. The root pane of
// a worktree's workspace is where Pi would start, so it is checked before
// starting one: a pane whose shell moved elsewhere would run the session
// outside the worktree.
function paneCwdFor(stdout, paneId) {
  let panes = null;
  try {
    const doc = JSON.parse(stdout);
    if (doc && doc.result && Array.isArray(doc.result.panes)) panes = doc.result.panes;
    else if (doc && Array.isArray(doc.panes)) panes = doc.panes;
    else if (doc && Array.isArray(doc.result)) panes = doc.result;
  } catch {
    return null;
  }
  if (!panes) return null;
  for (const pane of panes) {
    if (!pane || typeof pane !== "object") continue;
    const id = typeof pane.pane_id === "string" && pane.pane_id.length > 0
      ? pane.pane_id
      : typeof pane.id === "string" && pane.id.length > 0 ? pane.id : null;
    if (id !== paneId) continue;
    return typeof pane.cwd === "string" && pane.cwd.length > 0 ? pane.cwd : null;
  }
  return null;
}

// Choose the pane to start Pi in from one `herdr pane list` reply: the
// lowest-numbered pane of THAT WORKSPACE (the unfiltered list is global —
// measured — so a pane of another workspace would start Pi outside the
// worktree), whose cwd is the worktree or inside it when the pane reports
// one. One decision, one owner: the reuse path and the create-then-list
// path both come through here, so neither can drift from the other.
// `reason` says why nothing was chosen.
function selectSessionPane(stdout, workspaceId, targetCwd, repoRoot) {
  const paneId = rootPaneId(stdout, workspaceId);
  if (paneId === null) return { paneId: null, paneCwd: null, reason: "no-panes" };
  const paneCwd = paneCwdFor(stdout, paneId);
  if (paneCwd === null) return { paneId, paneCwd: null, reason: null };
  const paneState = checkoutState(paneCwd, repoRoot);
  const paneReal = paneState.real !== null ? paneState.real : paneState.absolute;
  const inside = paneReal !== null && (paneReal === targetCwd || paneReal.startsWith(targetCwd + path.sep));
  if (!inside) return { paneId, paneCwd, reason: "cwd" };
  return { paneId, paneCwd, reason: null };
}

// `root_pane.pane_id` and `workspace.workspace_id` from a `herdr worktree
// open` reply — the same shape `worktree create` returns — with tolerant
// fallbacks. Nulls when the reply names no usable pair.
function openedWorkspace(stdout) {
  let doc = null;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return { workspaceId: null, paneId: null, paneCwd: null };
  }
  const result = doc && typeof doc === "object" ? (doc.result || doc) : null;
  const workspace = result && typeof result.workspace === "object" ? result.workspace : null;
  const rootPane = result && typeof result.root_pane === "object" ? result.root_pane : null;
  const workspaceId = workspace && typeof workspace.workspace_id === "string" && workspace.workspace_id.length > 0
    ? workspace.workspace_id
    : typeof result.workspace_id === "string" && result.workspace_id.length > 0 ? result.workspace_id : null;
  const paneId = rootPane && typeof rootPane.pane_id === "string" && rootPane.pane_id.length > 0
    ? rootPane.pane_id
    : typeof result.pane_id === "string" && result.pane_id.length > 0
      ? result.pane_id
      : typeof result.root_pane_id === "string" && result.root_pane_id.length > 0 ? result.root_pane_id : null;
  // The cwd the reply reports for that pane, when it reports one: the same
  // check the reuse path makes, so a pane that is not in the worktree is
  // refused here too.
  const paneCwd = rootPane && typeof rootPane.cwd === "string" && rootPane.cwd.length > 0
    ? rootPane.cwd
    : typeof result.cwd === "string" && result.cwd.length > 0 ? result.cwd : null;
  return { workspaceId, paneId, paneCwd };
}

function herdrFailureText(call, status, reason) {
  const detail = ((reason || "unknown error") + "").trim() || "unknown error";
  return `'${call}' exited ${status} (${detail})`;
}

// Core of `worktree_session_open`. Exported for unit tests; the
// registered tool calls it with the live Pi context.
async function executeWorktreeSessionOpen(params, ctx, watcherOptions) {
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const mode = libRequire("worktree-mode.js");
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
      { state: modeState ? modeState.state : "unknown", tool: "worktree_session_open" },
    );
  }

  const rawWorktree = params ? params.worktree : undefined;
  const rawSession = params && typeof params.session === "string" && params.session.length > 0
    ? params.session
    : undefined;
  // A name that was PROVIDED is used as given, empty included, so an
  // explicit "" is refused by the guard below instead of silently
  // falling back to the worktree name.
  const nameProvided = params !== undefined && params !== null && params.name !== undefined && params.name !== null;
  const rawName = nameProvided
    ? typeof params.name === "string" ? params.name : String(params.name)
    : undefined;
  // T35 wires the behaviour; this tool only accepts and reports it.
  const notify = !(params && params.notify === false);
  if (typeof rawWorktree !== "string" || rawWorktree.length === 0) {
    return errorResult(
      "worktree_session_open requires a worktree name: pass the NAME 'worktree list' prints (or a branch name), not a path",
      { worktree: rawWorktree },
    );
  }
  // An explicit path is refused before any backend runs, so no command
  // can ever run outside a worktree of this repository.
  if (isExplicitPath(rawWorktree)) {
    return errorResult(pathRefusal(rawWorktree), { worktree: rawWorktree });
  }

  let repo;
  try {
    repo = git.repoIdentity(cwd);
  } catch (err) {
    return errorResult(`not a git repository: ${cwd}`, { worktree: rawWorktree });
  }
  const read = registry.readRegistry(repo.root);
  if (!read.ok) {
    return errorResult(`cannot read worktree registry: ${read.error}`, { worktree: rawWorktree });
  }
  let live;
  try {
    live = git.listWorktrees(repo.root);
  } catch (err) {
    return errorResult(
      `cannot list worktrees: ${(err && err.message) || err}`,
      { worktree: rawWorktree },
    );
  }
  // (b) Scope: the ONE name resolver (S24). A branch spelling resolves
  // through its flattened slug; a value that resolves neither way but
  // carries a separator is a path, refused with the actionable message.
  const principal = principalForName(git, repo.root, repo, live);
  let resolved = resolveCheckoutByName(rawWorktree, git, read, principal, live, repo.root);
  if (!resolved.ok) {
    let slug = null;
    try {
      slug = git.slugifyBranch(rawWorktree);
    } catch {
      slug = null;
    }
    if (typeof slug === "string" && slug.length > 0 && slug !== rawWorktree) {
      const viaSlug = resolveCheckoutByName(slug, git, read, principal, live, repo.root);
      if (viaSlug.ok) resolved = viaSlug;
    }
  }
  if (!resolved.ok && looksLikePath(rawWorktree)) {
    return errorResult(pathRefusal(rawWorktree), { worktree: rawWorktree });
  }
  if (!resolved.ok) {
    return errorResult(resolved.error, { worktree: rawWorktree, candidates: resolved.candidates });
  }
  if (resolved.kind === "principal") {
    return errorResult(
      `cannot open a session in the principal checkout at ${resolved.path}: worktree_session_open only opens sessions in a registered agent worktree (a session in the principal delegates nothing); pass the NAME 'worktree list' prints`,
      { worktree: rawWorktree, path: resolved.path, branch: resolved.branch },
    );
  }
  // Only a registered, LIVE worktree of THIS repository is acceptable:
  // the consolidated liveness predicate (exists AND is-a-directory AND
  // resolved-identity membership), so a hand-deleted checkout git still
  // records is stale and refused here.
  const entryState = checkoutState(resolved.path, repo.root);
  const targetCwd = entryState.real !== null ? entryState.real
    : entryState.absolute !== null ? entryState.absolute
    : path.resolve(resolved.path);
  const liveIds = liveIdentities(live, repo.root);
  const entryId = entryState.real !== null ? entryState.real : entryState.absolute;
  const isLive = entryState.exists && entryState.isDirectory && entryId !== null && liveIds.has(entryId);
  if (!isLive) {
    return errorResult(
      `no live worktree for "${resolved.name}" at ${resolved.path}: the registry entry is stale (the checkout is missing or git no longer records it); close or recreate the worktree and retry`,
      { worktree: resolved.name, branch: resolved.branch, path: resolved.path },
    );
  }
  const branch = resolved.entry ? resolved.entry.branch : resolved.branch;
  const agentName = nameProvided ? rawName : resolved.name;
  // Herdr reads the positional name as an option when it starts with a
  // dash: `herdr agent start --help` exits 0 and prints help without
  // starting anything, which would be reported as a successful open and
  // then subscribed to. The name also becomes the pane's agent identity,
  // so it stays a plain word.
  if (agentName.startsWith("-") || !/^[A-Za-z0-9._-]+$/.test(agentName)) {
    return errorResult(
      `worktree session open failed: invalid agent name "${agentName}": use letters, digits, dot, underscore or dash, and do not start with a dash`,
      { worktree: resolved.name, branch, path: targetCwd },
    );
  }
  const resumed = rawSession !== undefined;
  const sessionId = resumed ? rawSession : randomUUID();
  const piArgs = resumed
    ? ["--name", agentName, "--session", sessionId]
    : ["--name", agentName, "--session-id", sessionId];

  // (c) The worktree's Herdr workspace: `herdr worktree list
  // --cwd <root>`, reading `open_workspace_id` for that branch/path.
  const listed = git.runArgv(herdrBinary(), git.herdrArgv("list", { cwd: repo.root }), {
    cwd: repo.root,
    timeoutMs: 60000,
  });
  if (listed.status !== 0) {
    return errorResult(
      `worktree session open failed: ${herdrFailureText("herdr worktree list", listed.status, listed.stderr || listed.error)}; no session was opened`,
      { worktree: resolved.name, branch, path: targetCwd },
    );
  }
  let found = sessionWorkspaceId(listed.stdout, repo.root, branch, targetCwd);
  if (found.parseError) {
    return errorResult(
      `worktree session open failed: 'herdr worktree list' returned unparseable JSON; no session was opened`,
      { worktree: resolved.name, branch, path: targetCwd },
    );
  }
  let workspaceId = found.id;
  let paneId = null;
  let openedHere = false;
  if (workspaceId !== null) {
    // Reuse: the workspace's ROOT pane from `herdr pane list`.
    const panes = git.runArgv(herdrBinary(), git.herdrArgv("pane-list", { workspace: workspaceId }), {
      cwd: repo.root,
      timeoutMs: 60000,
    });
    if (panes.status !== 0) {
      return errorResult(
        `worktree session open failed: ${herdrFailureText("herdr pane list", panes.status, panes.stderr || panes.error)} for workspace '${workspaceId}'; no session was opened`,
        { worktree: resolved.name, branch, path: targetCwd, workspaceId },
      );
    }
    const chosen = selectSessionPane(panes.stdout, workspaceId, targetCwd, repo.root);
    if (chosen.reason === "no-panes") {
      return errorResult(
        `worktree session open failed: 'herdr pane list' for workspace '${workspaceId}' reported no pane of that workspace; no session was opened`,
        { worktree: resolved.name, branch, path: targetCwd, workspaceId },
      );
    }
    if (chosen.reason === "cwd") {
      return errorResult(
        `worktree session open failed: the root pane '${chosen.paneId}' of workspace '${workspaceId}' has cwd ${chosen.paneCwd}, outside the worktree ${targetCwd}; a session started there would not be in the worktree. Close that pane or open the worktree in a fresh workspace`,
        { worktree: resolved.name, branch, path: targetCwd, paneId: chosen.paneId, workspaceId },
      );
    }
    paneId = chosen.paneId;
  } else if (found.conflict) {
    // Two different workspace ids claim this worktree: fail closed rather
    // than opening a second workspace blindly.
    return errorResult(
      `worktree session open failed: 'herdr worktree list' names ${found.claimed} different workspaces for '${branch}'; resolve it by hand and retry; no session was opened`,
      { worktree: resolved.name, branch, path: targetCwd },
    );
  } else {
    // Creation: open the workspace, then use its root pane. The open of
    // an ALREADY-OPEN worktree is deliberately not assumed idempotent:
    // when it fails, one fresh list decides whether a workspace appeared
    // anyway (proceed through reuse) or the failure stands.
    const opened = git.runArgv(herdrBinary(), git.herdrArgv("open", { branch, cwd: repo.root, noFocus: true }), {
      cwd: repo.root,
      timeoutMs: 60000,
    });
    if (opened.status !== 0) {
      const relisted = git.runArgv(herdrBinary(), git.herdrArgv("list", { cwd: repo.root }), {
        cwd: repo.root,
        timeoutMs: 60000,
      });
      const retry = relisted.status === 0
        ? sessionWorkspaceId(relisted.stdout, repo.root, branch, targetCwd)
        : { id: null, matched: 0, claimed: 0, conflict: false };
      if (retry.id !== null) {
        workspaceId = retry.id;
      } else {
        return errorResult(
          `worktree session open failed: ${herdrFailureText("herdr worktree open", opened.status, opened.stderr || opened.error)} for branch '${branch}'; no session was opened`,
          { worktree: resolved.name, branch, path: targetCwd },
        );
      }
    } else {
      const pair = openedWorkspace(opened.stdout);
      if (pair.workspaceId === null || pair.paneId === null) {
        return errorResult(
          `worktree session open failed: 'herdr worktree open' for branch '${branch}' succeeded but its output named no workspace/pane; no session was started`,
          { worktree: resolved.name, branch, path: targetCwd },
        );
      }
      // The pane Herdr just opened must belong to the workspace it named
      // (a pane id carries its workspace), and its cwd — when the reply
      // reports one — must be the worktree or inside it, exactly as on the
      // reuse path. Trusting the reply is what would start Pi somewhere
      // else on a reply that names another pane.
      if (!pair.paneId.startsWith(`${pair.workspaceId}:`)) {
        return errorResult(
          `worktree session open failed: 'herdr worktree open' named workspace '${pair.workspaceId}' but pane '${pair.paneId}', which does not belong to it; no session was started`,
          { worktree: resolved.name, branch, path: targetCwd, workspaceId: pair.workspaceId, paneId: pair.paneId },
        );
      }
      if (pair.paneCwd !== null) {
        const openedState = checkoutState(pair.paneCwd, repo.root);
        const openedReal = openedState.real !== null ? openedState.real : openedState.absolute;
        const openedInside = openedReal !== null && (openedReal === targetCwd || openedReal.startsWith(targetCwd + path.sep));
        if (!openedInside) {
          return errorResult(
            `worktree session open failed: the pane '${pair.paneId}' Herdr opened for branch '${branch}' has cwd ${pair.paneCwd}, outside the worktree ${targetCwd}; no session was started`,
            { worktree: resolved.name, branch, path: targetCwd, workspaceId: pair.workspaceId, paneId: pair.paneId },
          );
        }
      }
      workspaceId = pair.workspaceId;
      paneId = pair.paneId;
      openedHere = true;
    }
    if (paneId === null && workspaceId !== null) {
      const panes = git.runArgv(herdrBinary(), git.herdrArgv("pane-list", { workspace: workspaceId }), {
        cwd: repo.root,
        timeoutMs: 60000,
      });
      if (panes.status !== 0) {
        return errorResult(
          `worktree session open failed: ${herdrFailureText("herdr pane list", panes.status, panes.stderr || panes.error)} for workspace '${workspaceId}'; the workspace '${workspaceId}' was opened by this call and no session was started in it`,
          { worktree: resolved.name, branch, path: targetCwd, workspaceId },
        );
      }
      const chosen = selectSessionPane(panes.stdout, workspaceId, targetCwd, repo.root);
      if (chosen.reason === "no-panes") {
        return errorResult(
          `worktree session open failed: 'herdr pane list' for workspace '${workspaceId}' reported no pane of that workspace; the workspace '${workspaceId}' was opened by this call and no session was started in it`,
          { worktree: resolved.name, branch, path: targetCwd, workspaceId },
        );
      }
      if (chosen.reason === "cwd") {
        return errorResult(
          `worktree session open failed: the root pane '${chosen.paneId}' of workspace '${workspaceId}' has cwd ${chosen.paneCwd}, outside the worktree ${targetCwd}; a session started there would not be in the worktree. Close that pane or open the worktree in a fresh workspace`,
          { worktree: resolved.name, branch, path: targetCwd, paneId: chosen.paneId, workspaceId },
        );
      }
      paneId = chosen.paneId;
    }
  }

  // (d) Start Pi in the pane. The pane belongs to the worktree's own
  // workspace and its cwd is inside the worktree, so Pi's session
  // directory is the worktree's: no `--session-dir`.
  const started = git.runArgv(herdrBinary(), git.herdrArgv("agent-start", {
    name: agentName, kind: "pi", pane: paneId,
    timeout: String(AGENT_START_TIMEOUT_MS), agentArgs: piArgs,
  }), {
    cwd: repo.root,
    timeoutMs: AGENT_START_TIMEOUT_MS + 60000,
  });
  if (started.status !== 0) {
    const createdNote = openedHere
      ? `; the workspace '${workspaceId}' was opened by this call and no session was started in it`
      : `; the workspace '${workspaceId}' already existed and no session was started in it`;
    return errorResult(
      `worktree session open failed: ${herdrFailureText("herdr agent start", started.status, started.stderr || started.error)} for agent '${agentName}' in pane '${paneId}'${createdNote}`,
      {
        worktree: resolved.name, branch, path: targetCwd,
        paneId, workspaceId, sessionId, resumed, agentName, notify,
      },
    );
  }
  const opened = textResult(
    sessionSuccessText(resolved.name, sessionId),
    {
      worktree: resolved.name, branch, path: targetCwd,
      paneId, workspaceId, sessionId, resumed, agentName, notify,
    },
    false,
  );
  // S26: subscribing is opening with `notify !== false` — one watcher for
  // the pane just opened, `notify: false` starts none. The watcher needs
  // the host message route; without it nothing is watched.
  if (notify && sessionNotifyPi && typeof sessionNotifyPi.sendMessage === "function") {
    try {
      startAgentSessionWatcher(
        {
          paneId, worktree: resolved.name, branch, sessionId,
          agentName, workspaceId, path: targetCwd, repoRoot: repo.root,
        },
        watcherOptions,
      );
    } catch {}
  }
  return opened;
}

const worktreeSessionOpenTool = defineTool({
  name: "worktree_session_open",
  label: "Worktree Session Open",
  description: "Open a Pi session inside a registered agent worktree via Herdr (workspace only, never a path): pass the worktree NAME 'worktree list' prints (or a branch name) and optionally a session id to resume. A new session id is minted when resuming is not asked. Unless notify:false is passed, the creator is notified when that session really finishes.",
  parameters: Type.Object({
    worktree: Type.String({ description: "Name of the registered worktree to open the session in (the flattened branch slug, or a branch name)" }),
    session: opt(Type.String({ description: "Pi session id or path to resume; absent means a new session" })),
    name: opt(Type.String({ description: "Agent/pane name; defaults to the worktree name" })),
    notify: opt(Type.Boolean({ description: "Subscribe the creator to the delegate finish notification (default true)" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeSessionOpen(params, ctx);
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
// `/herdr-gentle:worktree warp <name>` (S23): move the SESSION to another
// checkout by NAME.
//
// The platform keeps session control (`waitForIdle`/`switchSession`) on
// the extension COMMAND context, so the warp is a command verb — never a
// `worktree_warp` tool, which the platform makes impossible. The name is
// the flattened branch slug S24 prints (or `principal`), resolved through
// the SAME `resolveCheckoutByName` the close-by-name path uses — one
// place, never two.
//
// Measured scope of the move (nothing over-promised): the SESSION cwd
// changes and the tools operate in the target, while the PROCESS cwd does
// not (Pi never calls `process.chdir`); emitting OSC-7 tells the TERMINAL
// the new cwd, and Herdr honours it natively (ghostty-vt parses OSC 7
// into its pane pwd, so new panes/tabs/workspaces with
// `new_cwd = "follow"` inherit it); the interactive bash shell in that
// pane does NOT change directory, because a child process cannot change
// its parent shell's cwd.
// ---------------------------------------------------------------------------

// Emit OSC-7 announcing the session's new cwd to the terminal — written
// ONLY when the stream is a TTY, so a stream the TUI owns when it is not a
// TTY is never written to. The payload is a file URL, so a path holding a
// space or a non-ASCII character is percent-encoded instead of splitting
// the OSC-7 argument. The stream is injectable so tests can assert the
// exact bytes.
function emitOsc7(stream, cwd) {
  try {
    if (!stream || stream.isTTY !== true || typeof stream.write !== "function") return false;
    if (typeof cwd !== "string" || cwd.length === 0) return false;
    stream.write(`\x1b]7;${pathToFileURL(cwd).href}\x1b\\`);
    return true;
  } catch {
    return false;
  }
}

// Resolve the SessionManager class for the warp without a static package
// import (which would force every extension test double to stub a third
// line): prefer the canonical package export when the loader resolves it
// (the production Pi loader, which already resolves the sibling static
// imports from the same package), else the session instance's own
// constructor — the class that produced it, whose statics (`forkFrom`,
// `create`, `open`) are the mechanism. Null when neither is available.
async function sessionManagerClassFor(ctx) {
  try {
    const mod = await import("@earendil-works/pi-coding-agent");
    if (mod && mod.SessionManager && typeof mod.SessionManager.forkFrom === "function") {
      return mod.SessionManager;
    }
  } catch {
    // Plain-node test copies cannot resolve the package: fall through to
    // the instance constructor (the injected fake) below.
  }
  try {
    const ctor = ctx && ctx.sessionManager ? ctx.sessionManager.constructor : null;
    if (ctor && typeof ctor.forkFrom === "function") return ctor;
  } catch {
    // Unreachable: fall through to null.
  }
  return null;
}

function warpFail(text, details) {
  return { text, details: details || {}, isError: true };
}

// Core of the `warp` verb. Exported for unit tests, which inject a fake
// SessionManager class plus a fake OSC stream through `opts` and drive a
// fake command context (`waitForIdle`, `sessionManager` with
// `getSessionFile`/`getLeafId`/`getEntries`/`getSessionDir`,
// `switchSession`, `ui.setStatus`, `cwd`); the registered command calls
// it with the live Pi context and notifies the returned text.
//
// Mechanism (S23): `await ctx.waitForIdle()`; capture
// `{file: getSessionFile(), leaf: getLeafId(), cwd: ctx.cwd, sessionDir}`
// and refuse when there is no persisted session; `SessionManager.forkFrom`
// (or, for a session Pi has not written to disk yet — brand-new, living
// only in memory — clone the in-memory entries into a session allocated
// for the target cwd via `SessionManager.create` + `open`); `branch(leaf)`
// (or `resetLeaf()` when there is no leaf) plus one `appendCustomEntry`
// transition record naming both cwds; then
// `ctx.switchSession(targetFile, { withSession: r => r.ui.setStatus(...)
// + r.sendMessage(..., {triggerTurn: false}) })`, whose message tells the
// session to revalidate every path and cwd-dependent assumption.
// `cancelled` is a real outcome: it removes the target session file,
// reports it, and changes nothing else.
async function executeWorktreeWarp(rawName, ctx, opts) {
  const options = opts || {};
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name === "") {
    return warpFail(
      "worktree warp needs a name: use /herdr-gentle:worktree warp <name> (the flattened branch slug, or principal)",
      { name, alreadyThere: false, cancelled: false },
    );
  }
  if (!ctx || typeof ctx.waitForIdle !== "function" || typeof ctx.switchSession !== "function") {
    return warpFail(
      "worktree warp is only available as a session command: run /herdr-gentle:worktree warp <name> from a Pi session",
      { name, alreadyThere: false, cancelled: false },
    );
  }
  await ctx.waitForIdle();
  const fromCwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
  let repo;
  try {
    repo = git.repoIdentity(fromCwd);
  } catch (err) {
    return warpFail(`worktree warp: not a git repository: ${fromCwd}`, { name, alreadyThere: false, cancelled: false });
  }
  const read = registry.readRegistry(repo.root);
  if (!read.ok) {
    return warpFail(`worktree warp: cannot read worktree registry: ${read.error}`, { name, alreadyThere: false, cancelled: false });
  }
  let live;
  try {
    live = git.listWorktrees(repo.root);
  } catch (err) {
    return warpFail(`worktree warp: cannot list worktrees: ${(err && err.message) || err}`, { name, alreadyThere: false, cancelled: false });
  }
  // The SAME resolver as close-by-name: unknown or ambiguous fails closed.
  const resolved = resolveCheckoutByName(name, git, read, principalForName(git, repo.root, repo, live), live, repo.root);
  if (!resolved.ok) {
    return warpFail(`worktree warp: ${resolved.error}`, { name, alreadyThere: false, cancelled: false, candidates: resolved.candidates });
  }
  // Normalize the target cwd through the one liveness predicate (a row
  // reaching the checkout through a symlink warps to the real checkout).
  const targetState = checkoutState(resolved.path, repo.root);
  const targetCwd = targetState.real !== null ? targetState.real
    : targetState.absolute !== null ? targetState.absolute
    : path.resolve(resolved.path);
  // Warping to the checkout the session already runs in reports that and
  // changes nothing: no fork, no switch, no OSC-7. "Already there" is the
  // DEEPEST live checkout containing the session, the rule the listing
  // already uses: a session inside a nested worktree under the principal
  // is not in the principal, while a session in a subdirectory of the
  // target is in the target.
  const sessionState = checkoutState(fromCwd, repo.root);
  const sessionId = sessionState.real !== null ? sessionState.real : sessionState.absolute;
  let sessionCheckout = null;
  if (sessionId !== null) {
    const candidates = [targetCwd];
    for (const entry of live) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repo.root);
      const id = st.real !== null ? st.real : st.absolute;
      if (id !== null) candidates.push(id);
    }
    for (const id of candidates) {
      if (sessionId === id || sessionId.startsWith(id + path.sep)) {
        if (sessionCheckout === null || id.length > sessionCheckout.length) sessionCheckout = id;
      }
    }
  }
  if (sessionCheckout !== null && sessionCheckout === targetCwd) {
    return {
      text: `worktree warp: ${name} (already there)`,
      details: { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: true, cancelled: false },
    };
  }
  const sm = ctx.sessionManager || {};
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const file = typeof sm.getSessionFile === "function" ? safe(() => sm.getSessionFile()) : undefined;
  const leaf = typeof sm.getLeafId === "function" ? safe(() => sm.getLeafId()) : null;
  const sessionDir = typeof sm.getSessionDir === "function" ? safe(() => sm.getSessionDir()) : undefined;
  let carried = [];
  if (typeof file !== "string" || file.length === 0) {
    const entries = typeof sm.getEntries === "function" ? safe(() => sm.getEntries()) : undefined;
    carried = Array.isArray(entries) ? entries : [];
    if (carried.length === 0) {
      return warpFail(
        "worktree warp: no persisted session for this session and nothing in memory to carry over; open or write the session first and retry",
        { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  const SM = options.sessionManagerClass || await sessionManagerClassFor(ctx);
  if (!SM || typeof SM.forkFrom !== "function") {
    return warpFail(
      "worktree warp is unavailable here: the host SessionManager has no forkFrom",
      { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  let target = null;
  let targetFile = null;
  if (typeof file === "string" && file.length > 0) {
    try {
      target = SM.forkFrom(file, targetCwd, sessionDir);
    } catch (err) {
      return warpFail(
        `worktree warp: could not fork the session into ${targetCwd}: ${(err && err.message) || err}`,
        { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    targetFile = target && typeof target.getSessionFile === "function" ? safe(() => target.getSessionFile()) : undefined;
  } else {
    // Pi has not written this session to disk yet: allocate a session for
    // the target cwd and put the carried entries in its file ourselves,
    // preserving order and ids so the history (and the leaf below)
    // survives.
    try {
      const allocated = SM.create(targetCwd, sessionDir);
      const allocatedFile = allocated && typeof allocated.getSessionFile === "function" ? allocated.getSessionFile() : undefined;
      if (typeof allocatedFile !== "string" || allocatedFile.length === 0) {
        throw new Error("the host allocated no session file for the target");
      }
      const header = typeof allocated.getHeader === "function" ? allocated.getHeader() : null;
      if (!header) throw new Error("the allocated session has no header");
      // Written rather than replayed through the manager's private append:
      // a private append is not guaranteed to reach disk before the switch,
      // and a target holding only its header would silently lose the whole
      // conversation. `wx` never clobbers an existing file.
      const lines = [header, ...carried].map((entry) => `${JSON.stringify(entry)}\n`).join("");
      fs.writeFileSync(allocatedFile, lines, { flag: "wx" });
      target = SM.open(allocatedFile, sessionDir, targetCwd);
    } catch (err) {
      return warpFail(
        `worktree warp: could not carry this session into ${targetCwd}: ${(err && err.message) || err}`,
        { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    targetFile = target && typeof target.getSessionFile === "function" ? safe(() => target.getSessionFile()) : undefined;
  }
  if (typeof targetFile !== "string" || targetFile.length === 0) {
    return warpFail(
      `worktree warp: the forked session for ${targetCwd} has no session file`,
      { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  try {
    if (leaf !== null && leaf !== undefined) target.branch(leaf);
    else target.resetLeaf();
  } catch (err) {
    return warpFail(
      `worktree warp: could not position the forked session at ${targetFile}: ${(err && err.message) || err}; the forked session file was kept for inspection`,
      { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  try {
    target.appendCustomEntry("worktree-warp", { from: fromCwd, to: targetCwd, name, branch: resolved.branch });
  } catch (err) {
    return warpFail(
      `worktree warp: could not record the transition into ${targetCwd}: ${(err && err.message) || err}; the forked session file was kept for inspection`,
      { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  let switched;
  try {
    switched = await ctx.switchSession(targetFile, {
      withSession: async (r) => {
        try {
          r.ui.setStatus("worktree", `${name} (${targetCwd})`);
        } catch {
          // Status is cosmetic; the revalidation message below is not.
        }
        await r.sendMessage({
          customType: "worktree-warp",
          content: `Worktree warp: this session moved from ${fromCwd} to ${targetCwd} (branch '${resolved.branch}'). Revalidate every path and cwd-dependent assumption: the working directory, the git root, the worktree registry, and any cached absolute paths now refer to ${targetCwd}.`,
          display: true,
        }, { triggerTurn: false });
      },
    });
  } catch (err) {
    return warpFail(
      `worktree warp: the session switch to ${targetCwd} failed: ${(err && err.message) || err}; the forked session file was kept at ${targetFile}`,
      { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  if (switched && switched.cancelled === true) {
    // `cancelled` is a real outcome, not a success: remove the target
    // session file, report it, change nothing else.
    try {
      fs.unlinkSync(targetFile);
    } catch {
      // Best effort: the report below is what matters.
    }
    return warpFail(
      `worktree warp: ${name} cancelled (the session stays in ${fromCwd}; the forked session file was removed)`,
      { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: true },
    );
  }
  // After a successful switch only: tell the terminal the new cwd. The
  // helper writes nothing unless the stream is a TTY.
  emitOsc7(options.oscStream || process.stdout, targetCwd);
  return {
    text: `worktree warp: ${name} -> ${targetCwd}`,
    details: { name, path: targetCwd, branch: resolved.branch, kind: resolved.kind, alreadyThere: false, cancelled: false },
  };
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
  return `Worktree tools are ${state} (tools registered: ${registered}; /reload needed: ${reload}). Use /herdr-gentle:worktree enabled|disabled|status|warp <name>.`;
}

// Registered before any gate on purpose (like the sidebar toggle): the
// switch belongs to the Pi session, so it must exist even while the tools
// themselves are unregistered. Hosts without commands simply skip it.
function registerWorktreeCommand(pi, toolsRegistered) {
  if (typeof pi?.registerCommand !== "function") return;
  pi.registerCommand("herdr-gentle:worktree", {
    description: "Manage agent worktrees: turn the worktree tools on or off, check their status, or warp this session to a named checkout",
    handler: async (args, ctx) => {
      const notify = ctx?.ui?.notify;
      const raw = String(args ?? "").trim();
      const parts = raw.split(/\s+/).filter((part) => part.length > 0);
      const head = (parts[0] || "").toLowerCase();
      // S23: the warp verb moves the SESSION to the named checkout. It
      // resolves through the same name resolver as the listing and the
      // close-by-name path, and reports the outcome as a notification.
      if (head === "warp") {
        const target = parts[1] || "";
        if (!target || parts.length > 2) {
          notify?.("worktree warp needs exactly one name: use /herdr-gentle:worktree warp <name> (the flattened branch slug, or principal).", "error");
          return;
        }
        const out = await executeWorktreeWarp(target, ctx);
        notify?.(out.text, out.isError ? "error" : "info");
        return;
      }
      let verb = head;
      if (verb === "enable") verb = "enabled";
      if (verb === "disable") verb = "disabled";
      if (verb !== "enabled" && verb !== "disabled" && verb !== "status") {
        notify?.(`Unknown option "${raw}". Use /herdr-gentle:worktree enabled|disabled|status|warp <name>.`, "error");
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
  // The S26 delivery route: watchers started by `worktree_session_open`
  // notify through this host object.
  sessionNotifyPi = pi;
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
    pi.registerTool(worktreeSessionOpenTool);
  }
  // Automatic odd/ capture (S5, D7): observe the tool pipeline for the
  // read/edit/write tools. Guarded so hosts (and the older unit-test
  // doubles) without `pi.on` still load the tools above.
  if (typeof pi?.on === "function") {
    pi.on("tool_call", handleWorktreeOddEvent);
    pi.on("tool_result", handleWorktreeOddEvent);
  }
}

export { executeWorktreeCreate, executeWorktreeList, executeWorktreeClose, resolveThread, executeWorktreeWarp, emitOsc7, executeWorktreeSessionOpen, startAgentSessionWatcher, clearSessionWatchers };
