// @ts-nocheck
// gentle-worktree-tools.ts — agent worktree tools (Pi extension, P2-S4,
// plus the session opener T34/S25 and the agent warp T40/S49).
//
// Registers five tools: `worktree_create` (validate + herdr-first
// creation with hooks), `worktree_list` (read-only, no approval prompt),
// `worktree_close` (remove the checkout, keep the branch),
// `worktree_warp` (move the session to another checkout and continue there) and
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
// Under the test harness (GENTLE_WORKTREE_LIB_DIR set by the test loaders)
// with no explicit binary injected, fail closed instead of spawning live
// herdr: lib/worktree-git.js resolveHerdrBinary is the single authority.
function herdrBinary() {
  try {
    const git = libRequire("worktree-git.js");
    if (git && typeof git.resolveHerdrBinary === "function") {
      return git.resolveHerdrBinary(process.env);
    }
  } catch {
    // Fall through to the inline check below; a missing helper never
    // silently reaches a live binary from a test process.
  }
  const bin = process.env.HERDR_BIN_PATH;
  if (typeof bin === "string" && bin.length > 0) return bin;
  const harness = process.env.GENTLE_WORKTREE_LIB_DIR;
  if (typeof harness === "string" && harness.length > 0) {
    throw new Error('herdr binary is not injected: set HERDR_BIN_PATH in tests (refusing to run live herdr)');
  }
  return "herdr";
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
// Older test doubles stub only the constructors the tools needed;
// Type.Union is the production shape for string-or-array options, so
// the one option that needs it degrades to a bare string schema when
// the host Type has no Union (tests) instead of failing the load.
function unionSchema(schemas, opts) {
  try {
    if (Type && typeof Type.Union === 'function') return Type.Union(schemas, opts);
  } catch {
    // Fall through to the stub-compatible shape below.
  }
  return Type.String();
}
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

// S19 bounded agent text: short ordered lines in the warp moved/to
// spirit. Branch names, paths and session ids reach the transcript
// through these builders only, cleaned by the shared warpClean helper
// (defined below; hoisted) so the text and the card never drift into
// two notions of cleaning. Failure texts are untouched and stay
// byte-identical. `slugOf` mirrors lib/worktree-git.js slugifyBranch —
// the flattened slug the listing prints and warp accepts — so the agent
// text and the card agree without a new import. (Named slugPart: slugOf
// already names the git-backed resolver further below.)
function slugPart(branch) {
  try {
    const slug = String(branch ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug === '' ? 'worktree' : slug;
  } catch {
    return 'worktree';
  }
}

function issueListOf(issues) {
  return Array.isArray(issues) ? issues.filter((n) => typeof n === 'number') : [];
}

function createSuccessText(branch, target, issues, alreadyExists, odd) {
  const name = warpClean(branch, 'worktree');
  const head = alreadyExists === true
    ? `created: ${slugPart(branch)} · ${name} · already exists`
    : alreadyExists === 'updated'
      ? `updated: ${slugPart(branch)} · ${name}`
      : `created: ${slugPart(branch)} · ${name}`;
  const lines = [head, `path: ${warpClean(target, '(unknown path)')}`];
  const nums = issueListOf(issues);
  if (nums.length > 0) lines.push(`issues: ${nums.join(',')}`);
  const docs = Array.isArray(odd) ? odd.filter((o) => typeof o === 'string' && o.length > 0) : [];
  if (docs.length > 0) lines.push(`odd: ${docs.join(',')}`);
  return lines.join('\n');
}

function closeSuccessText(branch, branchKept) {
  const name = warpClean(branch, 'worktree');
  return `removed: ${slugPart(branch)} · ${name}\n${branchKept === false ? 'branch deleted' : 'branch kept'}`;
}

// Worktree tool card wiring (customize-command T6/S13): each registered
// tool draws the compact/expandable native card from lib/worktree-card.js
// through its own renderShell/renderCall/renderResult, so execute,
// schemas, content and details stay exactly as they are. Width helpers
// resolve lazily here — never a top-level package import (S6/S10: every
// test loader stubs only the two package import lines) — preferring the
// real pi-tui measurement (emoji/wide-char aware) and degrading to the
// lib's local fallback when the host has no such module. keyHint rides
// along only when the coding-agent module resolves; otherwise the lib's
// static ctrl+o hint stands in. Renderers are cached per helpers
// identity because Pi re-renders every visible card each frame.
let worktreeCardHelpersOverride;
let worktreeCardCache = null;
// The runtime resolution below runs once per process: rebuilding the
// helpers object on every render would defeat the per-identity card
// cache above (a fresh identity busts it each time). The injectable seam
// still wins whenever set, and resetting it returns to this stable
// resolution — never to a fresh rebuild.
let worktreeCardAutoHelpers;
let worktreeCardAutoResolved = false;

function setWorktreeCardHelpers(helpers) {
  worktreeCardHelpersOverride = helpers;
  worktreeCardCache = null;
}

function loadRuntimeCardHelpers() {
  try {
    const tui = require("@earendil-works/pi-tui");
    const helpers = {};
    if (tui && typeof tui.visibleWidth === "function") helpers.visibleWidth = tui.visibleWidth;
    if (tui && typeof tui.truncateToWidth === "function") {
      helpers.truncateToWidth = (text, width, ellipsis) => tui.truncateToWidth(text, width, ellipsis);
    }
    try {
      const agent = require("@earendil-works/pi-coding-agent");
      if (agent && typeof agent.keyHint === "function") helpers.keyHint = agent.keyHint;
    } catch {
      // keyHint stays on the lib's static fallback; never fatal.
    }
    return helpers;
  } catch {
    return null;
  }
}

function resolveWorktreeCardHelpers() {
  if (worktreeCardHelpersOverride !== undefined) return worktreeCardHelpersOverride || null;
  if (!worktreeCardAutoResolved) {
    worktreeCardAutoResolved = true;
    worktreeCardAutoHelpers = loadRuntimeCardHelpers();
  }
  return worktreeCardAutoHelpers;
}

function worktreeCardFor(toolName) {
  const helpers = resolveWorktreeCardHelpers() || undefined;
  if (!worktreeCardCache || worktreeCardCache.helpers !== helpers) {
    worktreeCardCache = { helpers, cards: new Map() };
  }
  let card = worktreeCardCache.cards.get(toolName);
  if (!card) {
    card = libRequire("worktree-card.js").createWorktreeCardRenderer(toolName, helpers);
    worktreeCardCache.cards.set(toolName, card);
  }
  return card;
}

// Spreads nothing and keeps the defineTool identity: the card hooks are
// assigned onto the definition, so a failure anywhere above returns the
// tool untouched and execution never depends on rendering. The hooks
// resolve the cached card per invocation (one Map hit) so an injected
// helpers seam set after load still reaches every render.
function withWorktreeCardRenderer(tool) {
  try {
    const card = worktreeCardFor(tool.name);
    tool.renderShell = card.renderShell;
    tool.renderCall = (...args) => worktreeCardFor(tool.name).renderCall(...args);
    tool.renderResult = (...args) => worktreeCardFor(tool.name).renderResult(...args);
  } catch {
    // Rendering stays generic; the tool itself is unaffected.
  }
  return tool;
}

// Core of `worktree_create`: validation (S2, S3) then herdr-first creation
// with a git fallback. Exported for unit tests; the registered tool calls
// it with the live Pi context.
async function executeWorktreeCreate(params, ctx, opts) {
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const mode = libRequire("worktree-mode.js");
  const issuesLib = libRequire("worktree-issues.js");

  // S53 git-only route (create-from-warp): the wizard creates a plain
  // git checkout plus the registry row and nothing else — never a Herdr
  // workspace (`herdr worktree create/open` is what materialized the
  // stray Herdr worktree the user never asked for). The route reuses
  // every validation and the registry machinery below; only the
  // backends change. Subprocesses run through the async runner here so
  // a hanging child aborts on its bound instead of freezing the
  // interactive session on the main thread.
  const gitOnly = !!(opts && opts.gitOnly === true);
  const runGit = gitOnly && typeof git.runArgvAsync === "function"
    ? (bin, argv, runOpts) => git.runArgvAsync(bin, argv, runOpts)
    : (bin, argv, runOpts) => git.runArgv(bin, argv, runOpts);

  const branch = params ? params.branch : undefined;
  const issues = params ? params.issues : undefined;
  const oddParam = params ? params.odd : undefined;
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
      "worktree tools are disabled; open /herdr-gentle:customize and apply the Worktree tools Enabled row to enable them",
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

  // (c) Issues are optional (customize-command S14): an omitted or empty
  // issues field means issues:[] with no verification; supplied issues
  // keep the exact existing verification (D5, S3) — awaited
  // asynchronously on the gitOnly/wizard path so a slow `gh` never
  // blocks the interactive session, synchronously everywhere else
  // (unchanged contract for the tool and its callers).
  const issuesOmitted = issues === undefined || (Array.isArray(issues) && issues.length === 0);
  const issuesSupplied = issues !== undefined;
  let issueNumbers = [];
  if (!issuesOmitted) {
    const verified = (gitOnly && issuesLib && typeof issuesLib.verifyIssuesAsync === "function")
      ? await issuesLib.verifyIssuesAsync(issues, { cwd })
      : issuesLib.verifyIssues(issues, { cwd });
    if (!verified.ok) {
      return errorResult(verified.reason, { branch, issues, code: verified.code });
    }
    issueNumbers = verified.issues.map((issue) => issue.number);
  }

  // (c2) S26: `odd` is optional exactly like `issues`: omitted means
  // "leave untouched", a supplied value (path string, array of paths,
  // or an empty value for removal) must name existing `.md` files and
  // replaces the stored value. A missing file fails closed here, before
  // any checkout or registry write.
  const oddSupplied = oddParam !== undefined;
  let oddNames = null;
  if (oddSupplied) {
    let oddLib;
    try {
      oddLib = libRequire("worktree-odd.js");
    } catch (err) {
      return errorResult(
        `cannot validate odd document: ${(err && err.message) || err}`,
        { branch, issues: issueNumbers },
      );
    }
    const checked = oddLib.validateOddParam(oddParam, cwd);
    if (!checked.ok) {
      return errorResult(checked.reason, { branch, issues: issueNumbers, odd: oddParam });
    }
    oddNames = checked.odd;
  }

  // (d) Repository identity and target path.
  let repo;
  try {
    repo = git.repoIdentity(cwd);
  } catch (err) {
    return errorResult(`not a git repository: ${cwd}`, { branch, issues: issueNumbers });
  }
  const target = opts && opts.principalLayout && typeof git.canonicalWorktreePath === "function"
    ? git.canonicalWorktreePath(repo.root, branch)
    : git.worktreePath(repo.root, branch);
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

  // Principal identity for the S31 edit path: the live listing entry
  // whose resolved identity equals the main root recovered from the
  // shared common dir (the same recovery the list uses). Null when git
  // names no principal.
  let principalInfo = null;
  try {
    if (typeof repo.commonDir === "string" && path.basename(repo.commonDir) === ".git") {
      const rawPrincipal = path.resolve(path.dirname(repo.commonDir));
      const pst = checkoutState(rawPrincipal, repo.root);
      const pid = pst.real !== null ? pst.real : pst.absolute;
      if (pid !== null) {
        for (const entry of listed) {
          if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
          const st = checkoutState(entry.path, repo.root);
          const id = st.real !== null ? st.real : st.absolute;
          if (id === pid && st.exists && st.isDirectory) {
            principalInfo = { path: pid, branch: entry.branch || "(detached)" };
            break;
          }
        }
      }
    }
  } catch {
    principalInfo = null;
  }
  // Display names for supplied odd files: `odd/<rel>` when they live
  // under a known `odd/` root, else the resolved absolute path.
  if (oddSupplied && oddNames !== null) {
    try {
      const oddLib = libRequire("worktree-odd.js");
      const principalRoot = (typeof repo.commonDir === "string" && path.basename(repo.commonDir) === ".git")
        ? path.dirname(repo.commonDir)
        : repo.root;
      oddNames = oddNames.map((abs) => oddLib.normalizeOddName(abs, { worktreePath: target, principalRoot }));
    } catch {
      // Keep the validated names as they are.
    }
  }

  // (d0) S31: the principal checkout is editable but never created by
  // this tool. When the requested branch is the principal's own live
  // branch, no checkout is created: the principal's registration record
  // is created on demand and the supplied fields overwrite it (empty
  // removes, omitted stays untouched). Any other branch falls through
  // to the normal create flow below.
  if (principalInfo !== null && branch === principalInfo.branch && (issuesSupplied || oddSupplied)) {
    const patch = {};
    if (issuesSupplied) patch.issues = issuesOmitted ? [] : issueNumbers.slice();
    if (oddSupplied) patch.odd = oddNames.slice();
    let existing = null;
    try {
      existing = registry.findByPath(repo.root, principalInfo.path) || registry.findByBranch(repo.root, branch);
      if (existing && typeof existing.path === "string" && path.isAbsolute(existing.path)) {
        const est = checkoutState(existing.path, repo.root);
        const eid = est.real !== null ? est.real : est.absolute;
        if (eid !== principalInfo.path) existing = null;
      } else if (existing) {
        existing = null;
      }
    } catch {
      existing = null;
    }
    let stored;
    try {
      if (existing) {
        const updated = registry.updateWorktree(repo.root, existing.path, patch);
        if (!updated.ok) {
          return errorResult(
            `cannot update the principal checkout at ${principalInfo.path}: ${updated.error}`,
            { branch, issues: issueNumbers, odd: oddNames, path: principalInfo.path },
          );
        }
        stored = updated.entry;
      } else {
        const created = registry.upsertWorktree(repo.root, {
          branch,
          path: principalInfo.path,
          thread,
          issues: patch.issues || [],
          odd: patch.odd || [],
        });
        if (!created.ok) {
          return errorResult(
            `cannot update the principal checkout at ${principalInfo.path}: ${created.error}`,
            { branch, issues: issueNumbers, odd: oddNames, path: principalInfo.path },
          );
        }
        stored = created.entry;
      }
    } catch (err) {
      return errorResult(
        `cannot update the principal checkout at ${principalInfo.path}: ${(err && err.message) || err}`,
        { branch, issues: issueNumbers, odd: oddNames, path: principalInfo.path },
      );
    }
    return textResult(
      createSuccessText(branch, stored.path, stored.issues, "updated", stored.odd),
      { path: stored.path, branch, issues: stored.issues, odd: stored.odd, created: false, updated: true },
      false,
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
        createSuccessText(owned.branch, owned.path, owned.issues, true, owned.odd),
        { path: owned.path, branch: owned.branch, issues: owned.issues, odd: Array.isArray(owned.odd) ? owned.odd.slice() : [], created: false },
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
  // (d2) S27 create-or-update: when the requested branch already owns a
  // LIVE checkout exactly at its agreed sibling target path and the
  // caller supplied `issues` and/or `odd`, this is an update, not a
  // create: the supplied fields (including empty values, which remove)
  // overwrite the stored ones while omitted fields stay untouched. The
  // branch, the path and every unsupplied value survive. A same-branch
  // row pointing at a DIFFERENT live checkout keeps the historical
  // append-and-warn flow below; without supplied fields — or when no
  // registry row owns the checkout at the target — the historical
  // refusals below stay byte-identical.
  if ((issuesSupplied || oddSupplied)) {
    const sameTarget = liveBranchRecords.find((entry) => {
      const st = checkoutState(entry.path, repo.root);
      return st.absolute !== null && st.absolute === resolvedTarget;
    });
    if (sameTarget) {
      const liveIdsForUpdate = liveIdentities(listed, repo.root);
      let row = null;
      try {
        const reread = registry.readRegistry(repo.root);
        const rows = reread && reread.ok === true && Array.isArray(reread.worktrees) ? reread.worktrees : [];
        for (const candidate of rows) {
          if (!candidate || candidate.branch !== branch) continue;
          if (typeof candidate.path !== "string" || !path.isAbsolute(candidate.path)) continue;
          const cst = checkoutState(candidate.path, repo.root);
          if (!cst.exists || !cst.isDirectory || cst.absolute === null || cst.absolute !== resolvedTarget) continue;
          const cid = cst.real !== null ? cst.real : cst.absolute;
          if (cid !== null && liveIdsForUpdate.has(cid)) {
            row = candidate;
            break;
          }
        }
      } catch {
        row = null;
      }
      if (row) {
        const patch = {};
        if (issuesSupplied) patch.issues = issuesOmitted ? [] : issueNumbers.slice();
        if (oddSupplied) patch.odd = oddNames.slice();
        try {
          const updated = registry.updateWorktree(repo.root, row.path, patch);
          if (updated.ok) {
            const stored = updated.entry;
            return textResult(
              createSuccessText(branch, stored.path, stored.issues, "updated", stored.odd),
              { path: stored.path, branch, issues: stored.issues, odd: stored.odd, created: false, updated: true },
              false,
            );
          }
        } catch {
          // Fall through to the historical refusals below.
        }
      }
    }
  }
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
    const pruned = await runGit("git", ["worktree", "prune"], { cwd: repo.root });
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
    const head = await runGit("git", ["rev-parse", "HEAD"], { cwd: repo.root });
    if (head.status === 0 && head.stdout.trim().length > 0) base = head.stdout.trim();
  } catch {
    base = null;
  }
  let branchExists = false;
  try {
    const ref = await runGit("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo.root });
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
    const adopted = await runGit("git", ["worktree", "add", target, branch], { cwd: repo.root, timeoutMs: 120000 });
    if (adopted.status === 0) {
      createdBy = "git";
      branchCreated = false;
      adoptWarnings.push(
        `adopted existing branch '${branch}' at ${target}: the worktree checks out that branch as-is, the branch ref was left untouched`,
      );
      // Best-effort Herdr workspace association: reported, never fatal.
      // Skipped on the git-only route: that checkout is git plus the
      // registry row by design, so no association is expected.
      if (!gitOnly) {
      try {
        const opened = await runGit(herdrBinary(), git.herdrArgv("open", { cwd: repo.root, path: target }), {
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
      }
    } else {
      createError = ((adopted.stderr || adopted.error || "unknown error") + "").trim();
    }
  } else {
  // The git-only route skips the herdr-first attempt outright: no
  // `herdr worktree create` runs, so no Herdr workspace is ever
  // materialized from the wizard. The tool path keeps herdr-first
  // with the git fallback below, byte-identical.
  let herdrRes = null;
  if (!gitOnly) {
  const createParams = { cwd: repo.root, branch, path: target };
  if (base) createParams.base = base;
  herdrRes = await runGit(herdrBinary(), git.herdrArgv("create", createParams), {
    cwd: repo.root,
    timeoutMs: 120000,
  });
  }
  if (herdrRes !== null && herdrRes.status === 0) {
    createdBy = "herdr";
    branchCreated = true;
  } else {
    const fallbackArgv = ["worktree", "add", "-b", branch, target];
    if (base) fallbackArgv.push(base);
    const fallback = await runGit("git", fallbackArgv, { cwd: repo.root, timeoutMs: 120000 });
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
      const ref = await runGit("git", ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repo.root });
      if (ref.status === 0) {
        const retry = await runGit("git", ["worktree", "add", target, branch], { cwd: repo.root, timeoutMs: 120000 });
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
      odd: oddSupplied ? oddNames.slice() : [],
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
  // The hooks themselves create no symlinks of any kind (the
  // `.agents`/`.claude`/`.odd` principal links are the separate silent
  // step (k) below). Hooks never turn a
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
    if (gitOnly) {
      // S63: the wizard path never runs the blocking sync hooks. The async
      // twin owns every child until settle (timeout/abort SIGTERMs, waits a
      // bounded grace for close, then SIGKILLs and reaps — POSIX group-wide)
      // while the event loop stays responsive, and awaiting it here preserves
      // ready-before-warp ordering (hooks settle before the warp) without
      // blocking Pi input/render. No fallback to the sync runner: a missing
      // async helper fails safe before the slow work with a useful error.
      if (typeof hooksLib.runCreationHooksAsync !== 'function') {
        throw new Error('creation hooks async runner is unavailable (runCreationHooksAsync missing)');
      }
      const runAsync = (bin, argv, runOpts) => git.runArgvAsync(bin, argv, {
        ...runOpts,
        // Abort reaches the effective runner only when the caller supplies
        // a signal (the wizard currently passes none, so none is claimed).
        ...(opts && opts.signal ? { signal: opts.signal } : {}),
      });
      hooks = await hooksLib.runCreationHooksAsync({
        principalRoot,
        worktreePath: target,
        root: repo.root,
        env: process.env,
        runAsync,
        ...(opts && opts.signal ? { signal: opts.signal } : {}),
        ...(opts && Number.isFinite(opts.killGraceMs) && opts.killGraceMs > 0 ? { killGraceMs: opts.killGraceMs } : {}),
      });
    } else {
      hooks = hooksLib.runCreationHooks({
        principalRoot,
        worktreePath: target,
        root: repo.root,
        env: process.env,
      });
    }
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
  // (k) T42/S51 principal dot-dir symlinks (silent hook): `.agents`,
  // `.claude` and `.odd` from the PRINCIPAL checkout — recovered from
  // the shared common dir exactly like the hooks above, never the
  // current checkout — with the all-or-nothing tracked gate. Adds
  // NOTHING to the output text in any branch; outcomes travel in
  // details only. Never fails the create.
  let symlinkDetails = { created: [], skippedTracked: [] };
  try {
    const symlinksLib = libRequire("worktree-symlinks.js");
    const principalForLinks = path.basename(repo.commonDir) === ".git"
      ? path.dirname(repo.commonDir)
      : repo.root;
    const applied = symlinksLib.applyWorktreeSymlinks({ principalRoot: principalForLinks, worktreePath: target });
    if (applied && Array.isArray(applied.created) && Array.isArray(applied.skippedTracked)) {
      symlinkDetails = { created: applied.created.slice(), skippedTracked: applied.skippedTracked.slice() };
    }
  } catch {
    // Best effort only; the create stands regardless.
  }
  // (l) T41/S50 changes registration: register the checkout just
  // created on the CURRENT session through gentle-shell's
  // `session_worktree_register` host tool, but ONLY when that tool is
  // actually available (listed in ctx.tools and callable through
  // ctx.executeTool — the injectable seam). On success the output ends
  // with ONE short line so the agent does not repeat the call; when
  // the tool is unavailable, the call fails, or anything throws, do
  // nothing and append nothing — the create never fails because of this.
  let changesRegistered = false;
  try {
    const registerLib = libRequire("session-worktree-register.js");
    if (registerLib && typeof registerLib.registerSessionWorktree === "function") {
      changesRegistered = await registerLib.registerSessionWorktree(ctx, target) === true;
    }
  } catch {
    changesRegistered = false;
  }
  const successText = createSuccessText(branch, target, issueNumbers, false, oddSupplied ? oddNames : []);
  return textResult(
    changesRegistered ? `${successText}\nchanges: already registered for this session` : successText,
    { path: target, branch, issues: issueNumbers, odd: oddSupplied ? oddNames.slice() : [], created: true, hooks, warnings, pruned: prunedStale, replacedRows: replacedRows.map((r) => ({ branch: r.branch, path: r.path })), symlinks: symlinkDetails, changesRegistered, ...adoptionDetails, ...backupDetails },
    false,
  );
}

const worktreeCreateTool = withWorktreeCardRenderer(defineTool({
  name: "worktree_create",
  label: "Worktree Create",
  description: "Create an agent worktree for a branch at the flattened worktree path, optionally associated with verified GitHub issues. The calling thread owns the checkout.",
  parameters: Type.Object({
    branch: Type.String({ description: "Branch name to create the worktree for" }),
    issues: opt(Type.Array(Type.Number(), { description: "Associated GitHub issue numbers (optional; when given, each must verify to exist)" })),
    odd: opt(Type.String({ description: "Path of the odd .md document to associate (optional; must exist). When the worktree already exists, supplied issues/odd overwrite the stored values." })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeCreate(params, ctx);
  },
}));

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
      "worktree tools are disabled; open /herdr-gentle:customize and apply the Worktree tools Enabled row to enable them",
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
  // S39 current branch from git (shared helper); the registry field is
  // the fallback. Sole claimants print the live branch; shared checkouts
  // keep their stored names so the ambiguity keeps resolving.
  const liveBranchById = liveBranchMap(live, repo.root);
  const claimCounts = registryClaimCounts(read.worktrees, repo.root);
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
    // S25: every entry carries the checkout's odd document,
    // auto-detected from inside that worktree (never hand-bookkept):
    // the stored names plus whatever `odd/*.md` the checkout holds now.
    let oddDocs = [];
    try {
      const oddLib = libRequire("worktree-odd.js");
      const stored = Array.isArray(entry.odd) ? entry.odd.slice() : [];
      oddDocs = typeof oddLib.oddDocsForCheckout === "function"
        ? oddLib.oddDocsForCheckout(stored, entry.path)
        : stored.slice();
    } catch {
      oddDocs = Array.isArray(entry.odd) ? entry.odd.slice() : [];
    }
    // S24: the first column is the NAME (flattened branch slug); the
    // absolute path stays in details, never in the printed line.
    // S39: a sole claimant shows the CURRENT git branch, not the stale row.
    const rowId = st && st.absolute !== null ? (st.real !== null ? st.real : st.absolute) : null;
    const liveShown = rowId !== null && (claimCounts.get(rowId) || 0) === 1 ? liveBranchById.get(rowId) : undefined;
    const shownBranch = liveShown || entry.branch;
    let rowName = "worktree";
    try {
      rowName = git.slugifyBranch(typeof shownBranch === "string" ? shownBranch : "worktree");
    } catch {
      rowName = "worktree";
    }
    agentRows.push({
      line: `worktree list: ${rowName} ${shownBranch} thread=${thread} issues=${issues.join(",")}`
        + (liveHit ? "" : " missing")
        + (oddDocs.length > 0 ? ` odd=${oddDocs.join(",")}` : ""),
      item: { name: rowName, path: entry.path, branch: shownBranch, thread, issues, odd: oddDocs, status, kind: "agent" },
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

// S29 name-or-path resolution shared by close (and, through its own
// call below, session open): the SAME field accepts a name OR a path —
// the name first (the caller tries `resolveCheckoutByName`), then the
// path. A path resolves only when it exists, is a directory, and belongs
// to this project's worktrees: it must match a registered row by
// resolved identity AND be a live checkout in git's listing. Anything
// else yields null so the caller fails closed with the name error.
function resolveClosePathEntry(raw, git, read, live, repoRoot) {
  try {
    if (typeof raw !== "string" || raw.length === 0) return null;
    const st = checkoutState(raw, repoRoot);
    if (st.absolute === null || !st.exists || !st.isDirectory) return null;
    const id = st.real !== null ? st.real : st.absolute;
    if (id === null) return null;
    if (!liveIdentities(live, repoRoot).has(id)) return null;
    const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
    for (const row of rows) {
      if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
      const rst = checkoutState(row.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      if (rid !== null && rid === id) return row;
    }
    return null;
  } catch {
    return null;
  }
}

// S39 current branch, shared by the resolver, the listing, the selector
// and the warp: map each live checkout identity to its CURRENT branch from
// git. The registry row keeps the branch recorded at creation time, so this
// map is the refresh source and the registry field is the fallback only.
function liveBranchMap(live, repoRoot) {
  const map = new Map();
  try {
    for (const record of live || []) {
      if (!record || typeof record.path !== "string" || record.path.length === 0) continue;
      const rst = checkoutState(record.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      if (rid === null) continue;
      if (typeof record.branch === "string" && record.branch.length > 0 && !map.has(rid)) {
        map.set(rid, record.branch);
      }
    }
  } catch {
    // No live map: every caller falls back to its registry field.
  }
  return map;
}

// How many registry rows claim each checkout identity. The CURRENT branch
// replaces a row's stored branch only when that row is the checkout's sole
// claimant: several rows may deliberately reach one checkout (a symlink
// spelling kept under its own name), and there the stored names stay so the
// ambiguity keeps resolving.
function registryClaimCounts(rows, repoRoot) {
  const counts = new Map();
  try {
    for (const row of rows || []) {
      if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
      const rst = checkoutState(row.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      if (rid === null) continue;
      counts.set(rid, (counts.get(rid) || 0) + 1);
    }
  } catch {
    // No counts: callers keep their registry fields.
  }
  return counts;
}

function resolveCheckoutByName(name, git, read, principal, live, repoRoot, opts) {
  // S14: the warp allows a single unregistered match (`{allowUnregistered:
  // true}`); close-by-name and session-open keep the default refusal so
  // their semantics do not change.
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
  // S39: a row matches by its stored slug OR by its CURRENT live-branch
  // slug, so the refreshed name the listing and the selector show stays
  // warpable. One row matching twice still counts once.
  const liveById = liveBranchMap(live, repoRoot);
  const matches = [];
  for (const row of rows) {
    if (slugOf(git, row && row.branch) === name) {
      matches.push(row);
      continue;
    }
    if (row && typeof row.path === "string" && path.isAbsolute(row.path)) {
      const rst = checkoutState(row.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      const current = rid !== null ? liveById.get(rid) : undefined;
      if (typeof current === "string" && slugOf(git, current) === name) matches.push(row);
    }
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
    // S14: the warp moves to a lone unregistered checkout; every other
    // caller keeps the refusal (close never acts on one).
    if (opts && opts.allowUnregistered === true) {
      return {
        ok: true, kind: "unregistered", name,
        path: only.path, branch: only.branch, entry: null,
      };
    }
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

// Best-effort session-manager string accessor for the close sequence:
// the current session id or session file, or null when the context
// carries no such accessor. Never throws.
function closeSessionString(ctx, method) {
  try {
    const sm = ctx && ctx.sessionManager;
    if (!sm || typeof sm[method] !== "function") return null;
    const value = sm[method]();
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

// S33/S34 pre-removal sequence for `worktree_close`, running after
// approval and before the checkout removal:
//  1. A foreign live session (a Pi session that is not ours, evidenced
//     by `herdr agent list` agents cwd'd in the target checkout) refuses
//     the close with an actionable message and changes nothing. A
//     failing or unparseable agent list is NO evidence: Herdr being
//     unavailable never blocks the removal.
//  2. Our own session (the tool context's cwd inside the target) warps
//     to the principal FIRST through the existing warp machinery, and
//     the close continues only when that warp actually succeeded.
//  3. Only after such a warp, the Herdr workspace that pointed at the
//     removed checkout is closed and a normal workspace is opened at the
//     principal, resuming the warped session (lib/worktree-close-herdr.js;
//     Herdr offers no workspace path move). Without a warped session the
//     removal below already retires the workspace with the checkout, so
//     there is nothing to re-home and the step stays silent.
// Returns {ok: true, warp, herdrWorkspace, notices} or {ok: false, text,
// details}. Never throws: every failure mode is a value.
async function closePreRemovalSequence({ git, repo, target, branch, force, ctx, opts, resolvedTarget }) {
  const closeHerdr = libRequire("worktree-close-herdr.js");
  // Subprocess cwd, re-anchored onto the principal after a warp (below)
  // so no Herdr call ever runs inside the checkout being removed.
  let runRoot = repo.root;
  const runHerdr = (argv, timeoutMs) => git.runArgv(herdrBinary(), argv, { cwd: runRoot, timeoutMs });
  const ourSessionId = closeSessionString(ctx, "getSessionId");
  let agents = [];
  try {
    const listed = runHerdr(["agent", "list"], 60000);
    if (listed && listed.status === 0) {
      agents = closeHerdr.agentsInCheckout(listed.stdout, resolvedTarget, repo.root, ourSessionId);
    }
  } catch {
    agents = [];
  }
  if (agents.length > 0) {
    const named = agents.map((agent) => agent.cwd).join(", ");
    return {
      ok: false,
      text: `cannot close the worktree at ${target}: another live Pi session is active in that checkout (${named}); warp it to the principal with /herdr-gentle:warp principal from that session and retry; the checkout and the registry were left untouched`,
      details: { branch, path: target, force, agents },
    };
  }
  let warp = null;
  try {
    const sessionState = checkoutState(toolCwd(ctx), repo.root);
    const sessionId = sessionState.real !== null ? sessionState.real : sessionState.absolute;
    if (sessionId !== null && (sessionId === resolvedTarget || sessionId.startsWith(resolvedTarget + path.sep))) {
      const warpOpts = opts && typeof opts === "object" ? opts : undefined;
      const moved = await executeWorktreeWarp("principal", ctx, warpOpts);
      if (!moved || moved.isError) {
        return {
          ok: false,
          text: `cannot close the worktree at ${target}: the session warp to the principal failed (${moved && moved.text ? moved.text : "the warp reported no result"}); the checkout and the registry were left untouched`,
          details: { branch, path: target, force, warp: moved && moved.details ? moved.details : null },
        };
      }
      warp = {
        name: moved.details.name,
        path: moved.details.path,
        branch: moved.details.branch,
        sessionFile: closeSessionString(ctx, "getSessionFile"),
      };
    }
  } catch (err) {
    return {
      ok: false,
      text: `cannot close the worktree at ${target}: the session warp to the principal failed (${(err && err.message) || err}); the checkout and the registry were left untouched`,
      details: { branch, path: target, force, warp: null },
    };
  }
  let herdrWorkspace = null;
  const notices = [];
  // Subprocess anchor: the pre-warp repo.root names the caller's
  // checkout, which after a warp is the doomed target itself. Re-anchor
  // on the principal the warp just moved to (best-effort; the common
  // dir — and therefore the registry — is shared either way), so the
  // workspace reconcile and the removal below never run with a cwd
  // inside the checkout being removed.
  let anchorRoot = repo.root;
  if (warp !== null) {
    try {
      anchorRoot = git.repoIdentity(warp.path).root;
    } catch {
      anchorRoot = repo.root;
    }
    runRoot = anchorRoot;
    const reconciled = closeHerdr.reconcileHerdrWorkspace({
      run: (argv, timeoutMs) => runHerdr(argv, timeoutMs),
      repoRoot: anchorRoot,
      resolvedTarget,
      principalPath: warp.path,
      session: { file: warp.sessionFile, id: ourSessionId },
      force,
    });
    if (reconciled.status === "reconciled") {
      herdrWorkspace = {
        status: "reconciled",
        closedWorkspace: reconciled.closedWorkspace,
        openedWorkspace: reconciled.openedWorkspace,
        session: reconciled.session,
      };
      // S35: the group reconcile closes every member of the checkout's
      // group (linked first, root last); carry the full list when present.
      if (Array.isArray(reconciled.closedWorkspaces)) {
        herdrWorkspace.closedWorkspaces = reconciled.closedWorkspaces;
      }
    } else if (reconciled.status !== "absent") {
      // 'skipped' and 'reconciled-partial': a short visible notice
      // travels with the success, and the removal below still proceeds.
      herdrWorkspace = {
        status: reconciled.status,
        notice: reconciled.notice,
      };
      if (reconciled.closedWorkspace !== undefined && reconciled.closedWorkspace !== null) {
        herdrWorkspace.closedWorkspace = reconciled.closedWorkspace;
      }
      if (Array.isArray(reconciled.closedWorkspaces)) {
        herdrWorkspace.closedWorkspaces = reconciled.closedWorkspaces;
      }
      // S35: a failed member leaves the group half-closed: name it so no
      // partial success is mistaken for a clean reconcile.
      if (typeof reconciled.failedWorkspace === "string" && reconciled.failedWorkspace.length > 0) {
        herdrWorkspace.failedWorkspace = reconciled.failedWorkspace;
      }
      if (reconciled.openedWorkspace !== undefined) {
        herdrWorkspace.openedWorkspace = reconciled.openedWorkspace;
      }
      if (reconciled.session !== undefined) herdrWorkspace.session = reconciled.session;
      notices.push(reconciled.notice);
    }
  }
  return { ok: true, warp, herdrWorkspace, notices, repoRoot: anchorRoot };
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
async function executeWorktreeClose(params, ctx, opts) {
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
      "worktree tools are disabled; open /herdr-gentle:customize and apply the Worktree tools Enabled row to enable them",
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
      // S29: the same field accepts a name OR a path — the name first,
      // then the path. A path resolves only when it exists and belongs
      // to this project's worktrees (checked against the registry and
      // the live listing); anything else fails closed with the name
      // resolution error and no side effect.
      const pathEntry = resolveClosePathEntry(rawName, git, read, liveForName, repo.root);
      if (pathEntry) {
        entry = pathEntry;
      } else {
        return errorResult(resolved.error, { query: rawName, candidates: resolved.candidates, force });
      }
    } else if (resolved.kind === "principal") {
      return errorResult(
        `cannot close the principal checkout at ${resolved.path}: worktree_close only closes registered agent worktrees; the checkout and the registry were left untouched`,
        { name: rawName, path: resolved.path, branch: resolved.branch, force },
      );
    } else {
      entry = resolved.entry;
    }
    // S32: a path that resolves to the principal checkout (or to
    // anything that is not a registered agent worktree) is refused here,
    // before any approval, removal or registry write.
    if (entry) {
      const entryState = checkoutState(entry.path, repo.root);
      const entryId = entryState.real !== null ? entryState.real : entryState.absolute;
      const principalRef = principalForName(git, repo.root, repo, liveForName);
      if (principalRef && typeof principalRef.path === "string") {
        const pst = checkoutState(principalRef.path, repo.root);
        const pid = pst.real !== null ? pst.real : pst.absolute;
        if (entryId !== null && pid !== null && entryId === pid) {
          return errorResult(
            `cannot close the principal checkout at ${principalRef.path}: worktree_close only closes registered agent worktrees; the checkout and the registry were left untouched`,
            { name: rawName, path: principalRef.path, branch: principalRef.branch, force },
          );
        }
      }
    }
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
  // S61: the confirmation names the checkout's pending changes when it
  // has any (N files +N/-N read through lib/worktree-changes.js); a
  // clean checkout omits the dirty warning. A summary failure degrades
  // to the plain confirmation (never a silent force: force still comes
  // only from the caller's params).
  if (ctx && ctx.hasUI) {
    const canAsk = ctx.ui && typeof ctx.ui.confirm === "function";
    let approved = false;
    if (canAsk) {
      let dirtyLine = '';
      try {
        const changesLib = libRequire('worktree-changes.js');
        const summary = await changesLib.summarizeChanges(target, { git });
        if (summary && summary.ok === true && summary.files > 0) {
          dirtyLine = ` Pending changes: ${summary.files} file${summary.files === 1 ? '' : 's'}, +${summary.added}/-${summary.deleted}.`;
        }
      } catch {
        dirtyLine = '';
      }
      try {
        approved = await ctx.ui.confirm(
          `Close worktree '${branch}'?`,
          `Remove the worktree checkout at ${target} for branch '${branch}'? The branch '${branch}' will be kept.`
            + (owner
              ? ` This checkout is owned by thread '${owner}'.`
              : " This checkout has no recorded owning thread.")
            + dirtyLine,
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

  // S33/S34: warp a live session out and reconcile the Herdr workspace
  // BEFORE the checkout removal below. A refusal here changes nothing:
  // the checkout, the branch and the registry entry are left untouched.
  const preRemoval = await closePreRemovalSequence({
    git, repo, target, branch, force, ctx, opts, resolvedTarget,
  });
  if (!preRemoval.ok) {
    return errorResult(preRemoval.text, preRemoval.details);
  }
  // S33/S34: after a warp the caller's checkout is the doomed target
  // itself, so the removal and its verification run anchored on the
  // principal the warp moved to. Without a warp this is repo.root and
  // the removal below is exactly as before.
  const effectiveRoot = preRemoval.repoRoot || repo.root;

  // Remove herdr-first: resolve the workspace id from `herdr worktree
  // list`, then `herdr worktree remove`. Fixed argv only, values as
  // separate elements (herdr rejects --flag=value). Never
  // --trust-repository: trusting a repository is a human decision these
  // tools never take. `--force` only when the caller asked for it.
  let removedBy = null;
  let removeError = null;
  let workspace = null;
  const listed = git.runArgv(herdrBinary(), git.herdrArgv("list", { cwd: effectiveRoot }), {
    cwd: effectiveRoot,
    timeoutMs: 60000,
  });
  if (listed.status === 0) {
    workspace = herdrWorkspaceId(listed.stdout, resolvedTarget, effectiveRoot);
  }
  if (workspace) {
    const removeParams = { workspace };
    if (force) removeParams.force = true;
    const removed = git.runArgv(herdrBinary(), git.herdrArgv("remove", removeParams), {
      cwd: effectiveRoot,
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
    const fallen = git.runArgv("git", argv, { cwd: effectiveRoot, timeoutMs: 120000 });
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
    const vanishedOnFailure = vanishedCheckouts(git, effectiveRoot, live, resolvedTarget);
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
    after = git.listWorktrees(effectiveRoot);
  } catch (err) {
    const vanishedWithoutList = vanishedCheckouts(git, effectiveRoot, live, resolvedTarget, null);
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
  const vanished = vanishedCheckouts(git, effectiveRoot, live, resolvedTarget, after);
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
    dropped = registry.removeWorktreeByPath(effectiveRoot, resolvedTarget);
  } catch (err) {
    dropped = { ok: false, error: (err && err.message) || String(err) };
  }
  if (!dropped.ok) {
    return errorResult(
      `worktree removed at ${target} but the registry entry could not be dropped: ${dropped.error}`,
      { branch, path: target, force, removed: true, branchKept: true },
    );
  }
  // S33/S34: the pre-removal sequence appends its own visible lines —
  // the warp that moved this session out, and any skipped Herdr
  // workspace step — while the removed/branch-kept contract stays
  // byte-identical on every path that never warped.
  const successLines = [closeSuccessText(branch, true)];
  if (preRemoval.warp !== null) successLines.push("session warped to principal");
  for (const notice of preRemoval.notices) successLines.push(notice);
  const successDetails = { path: target, branch, removed: true, branchKept: true, thread: owner };
  if (preRemoval.warp !== null) successDetails.warp = preRemoval.warp;
  if (preRemoval.herdrWorkspace !== null) successDetails.herdrWorkspace = preRemoval.herdrWorkspace;
  return textResult(
    successLines.join("\n"),
    successDetails,
    false,
  );
}

const worktreeListTool = withWorktreeCardRenderer(defineTool({
  name: "worktree_list",
  label: "Worktree List",
  description: "List the principal checkout plus the agent worktrees registered for this repository, cross-checked against live checkouts with their owning thread. The session's own checkout is listed first. Pass all:true to also show live checkouts the registry does not know about. Rows whose paths no longer exist are excluded and pruned from the registry.",
  parameters: Type.Object({
    all: opt(Type.Boolean({ description: "Include live checkouts the registry does not know about" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeList(params, ctx);
  },
}));

const worktreeCloseTool = withWorktreeCardRenderer(defineTool({
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
}));

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
// this plugin reports, named `<timestamp>_<session-id>.jsonl`, so the id
// is compared against the SEGMENT the file names — never against the
// whole name as a substring or a suffix. Both would call another session
// ours: `session: "def"` matches `..._abc_def.jsonl`, `session: "."`
// matches any path, and a stem-shaped id matches the whole basename. The
// timestamp prefix is stripped only when it has the shape Pi writes, so an
// id that itself contains `_` still matches its own file.
const SESSION_FILE_STEM = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z_/;
function bindingNamesSession(value, sessionId) {
  if (typeof value !== "string" || value.length === 0) return false;
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  if (value === sessionId) return true;
  const base = path.basename(value);
  if (!base.endsWith(".jsonl")) return false;
  const stem = base.slice(0, -6);
  return stem.replace(SESSION_FILE_STEM, "") === sessionId;
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
      // A host whose send never settles must not keep the watcher alive past
      // its maximum wait: the outcome is dropped, and the timer with it.
      if (delivering && Date.now() - pendingAt >= maxWaitMs) {
        stop();
        return;
      }
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

function sessionSuccessText(worktree, sessionId, targetPath, resumed) {
  const head = `opened: ${warpClean(worktree, 'worktree')} · ${warpClean(sessionId, '(unknown session)')}`;
  if (resumed === true) return `${head}\nresumed`;
  return `${head}\npath: ${warpClean(targetPath, '(unknown path)')}`;
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
    return { workspaceId: null, paneId: null, paneCwd: null, paneWorkspace: null };
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
  const paneWorkspace = rootPane && typeof rootPane.workspace_id === "string" && rootPane.workspace_id.length > 0
    ? rootPane.workspace_id
    : null;
  return { workspaceId, paneId, paneCwd, paneWorkspace };
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
      "worktree tools are disabled; open /herdr-gentle:customize and apply the Worktree tools Enabled row to enable them",
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
  // S29: the same field accepts a name OR a path — the name first,
  // then the path. An explicit path is NOT refused up front: it falls
  // through to the path leg below, which resolves only when the path
  // exists and belongs to this project's worktrees. Anything else keeps
  // the historical refusals byte-identical.
  if (typeof rawWorktree !== "string" || rawWorktree.length === 0) {
    return errorResult(
      "worktree_session_open requires a worktree name: pass the NAME 'worktree list' prints (or a branch name), not a path",
      { worktree: rawWorktree },
    );
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
    // S29 path leg: a path that exists and belongs to this project's
    // worktrees resolves to its registered row; any other path keeps
    // the historical refusal, byte-identical, before any backend runs.
    const pathEntry = resolveClosePathEntry(rawWorktree, git, read, live, repo.root);
    if (pathEntry) {
      let entryName = null;
      try {
        entryName = git.slugifyBranch(pathEntry.branch);
      } catch {
        entryName = null;
      }
      resolved = {
        ok: true, kind: "agent",
        name: entryName || pathEntry.branch,
        path: pathEntry.path, branch: pathEntry.branch, entry: pathEntry,
      };
    }
  }
  if (!resolved.ok && isExplicitPath(rawWorktree)) {
    return errorResult(pathRefusal(rawWorktree), { worktree: rawWorktree });
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
      // The pane's own workspace, when the reply reports one, must agree
      // with the workspace the reply names: the reuse path refuses that
      // disagreement, so this path does too.
      if (pair.paneWorkspace !== null && pair.paneWorkspace !== pair.workspaceId) {
        return errorResult(
          `worktree session open failed: 'herdr worktree open' named workspace '${pair.workspaceId}' but its root pane reports workspace '${pair.paneWorkspace}'; no session was started`,
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
    sessionSuccessText(resolved.name, sessionId, targetCwd, resumed),
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

const worktreeSessionOpenTool = withWorktreeCardRenderer(defineTool({
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
}));

// ---------------------------------------------------------------------------
// `worktree_warp` (customize-command T40/S49): the warp, designed FOR AGENT USE.
//
// The `/herdr-gentle:warp` command is human-only (selectors, idle-slot
// waits); the agent has no exposed warp tool, so this one exists for the
// agent. It NEVER opens a selector (selectors are human-only; `name` is
// required) and NEVER awaits `waitForIdle` — awaiting it from inside a
// tool is a self-deadlock (`isIdle` stays false for the whole turn the
// tool runs in). It switches through `switchSession(targetFile,
// { withSession })`: from the FRESH context it emits the S42 warp card
// (the single visible confirmation per real move, through the
// `worktree-warp` customType the warp message renderer paints) and starts
// a continuation turn with `r.sendMessage(..., { triggerTurn: true,
// deliverAs: "followUp" })` carrying one short, filler-free instruction
// naming the checkout now in and telling the agent to continue, so the
// agent does not stop.
//
// Resolution, fork-vs-resume, records and naming follow the current S43
// rule exactly: name first, then path (one candidate; unknown, foreign or
// ambiguous fails closed, listing the available checkouts); resume when the
// destination record's filtered point equals the current point, otherwise
// fork from the highest identical ancestor (`parentSession` climb); the
// base-name rename; the dual-side records. The tool result text is short
// and agent-facing (the S42 rows). Gated by the same worktree switch as
// the other four tools; the command path (`executeWorktreeWarp`, with its
// `waitForIdle`) is untouched.
// ---------------------------------------------------------------------------

// Core of the `worktree_warp` tool. Exported for unit tests, which drive a
// fake tool context (a `switchSession` spy with `withSession` support plus
// a `waitForIdle` spy the tool must never call); the registered tool calls
// it with the live Pi context.
// A nonempty session-file path is NOT proof the fork source exists:
// the host may report an allocated-but-never-written file, and
// forkFrom throws on those. Validate the actual source first — a
// regular file whose first line is a session header — so an allocated
// ghost never reaches forkFrom; the in-memory carry path takes those
// sessions instead, and a session with nothing anywhere is refused
// before any mutation. Never throws and never writes.
function warpForkSourceUsable(file) {
  try {
    if (typeof file !== "string" || file.length === 0) return false;
    const st = fs.statSync(file);
    if (!st.isFile() || st.size === 0) return false;
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(4096, st.size));
      const read = fs.readSync(fd, buf, 0, buf.length, 0);
      let first = null;
      for (const line of buf.toString("utf8", 0, read).split("\n")) {
        if (line.length > 0) {
          first = line;
          break;
        }
      }
      if (first === null) return false;
      if (first.charCodeAt(0) === 0xFEFF) first = first.slice(1);
      const header = JSON.parse(first);
      return !!header && typeof header === "object" && header.type === "session";
    } finally {
      try {
        fs.closeSync(fd);
      } catch {
        // A close failure never fails the validation.
      }
    }
  } catch {
    return false;
  }
}

// The test seam models the live runtime's view of a session file (a
// fake path the real filesystem never sees), so usability consults it
// too: disk proof first, then the seam's entries. Production passes no
// seam, so only the disk decides there. Never throws.
function warpSourceUsable(file, open) {
  if (warpForkSourceUsable(file)) return true;
  if (typeof open === "function") {
    try {
      const seen = open(file);
      if (Array.isArray(seen)) return true;
      if (seen && typeof seen === "object" && !Array.isArray(seen) && Array.isArray(seen.entries)) return true;
    } catch {
      // An unreadable seam entry is not usable.
    }
  }
  return false;
}

// Preflight BEFORE any branch/worktree/registry mutation: the session
// being warped must either name a usable fork source (validated above,
// never a bare nonempty string) or carry in-memory entries the existing
// carry path can clone. Otherwise refuse with the same message the warp
// itself uses — before creating anything, so no orphan checkout is left
// behind and no user data is ever rolled back or deleted.
function warpCreatePreflight(ctx) {
  const sm = ctx && ctx.sessionManager;
  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const file = sm && typeof sm.getSessionFile === "function" ? safe(() => sm.getSessionFile()) : undefined;
  if (typeof file === "string" && file.length > 0 && warpForkSourceUsable(file)) return { ok: true };
  const entries = sm && typeof sm.getEntries === "function" ? safe(() => sm.getEntries()) : undefined;
  const carried = Array.isArray(entries) ? entries : [];
  if (carried.length === 0) {
    return { ok: false, reason: "warp: no persisted session for this session and nothing in memory to carry over; open or write the session first and retry" };
  }
  return { ok: true };
}

// S61 tool-side copy for the `changes` option. Resolves to
// {isError:false, copied} to continue or {isError:true, result} to
// refuse with no copy and no switch. Never throws.
async function warpToolMaybeCopyChanges({ ctx, git, params, fromCheckout, targetCwd }) {
  let raw;
  try {
    raw = params ? params.changes : undefined;
  } catch {
    raw = undefined;
  }
  let changesLib = null;
  try {
    changesLib = libRequire('worktree-changes.js');
  } catch (err) {
    return { isError: false, copied: null };
  }
  let normalized;
  try {
    normalized = changesLib.normalizeChangesSelection(raw);
  } catch (err) {
    return {
      isError: true,
      result: errorResult(`worktree warp: ${(err && err.message) || err}`, { tool: 'worktree_warp' }),
    };
  }
  if (!normalized.ok) {
    return { isError: true, result: errorResult(`worktree warp: ${normalized.error}`, { tool: 'worktree_warp' }) };
  }
  if (normalized.mode === 'none') return { isError: false, copied: null };
  let copied;
  try {
    copied = await changesLib.copyChanges(
      { from: fromCheckout, to: targetCwd, selectMode: normalized.mode, selection: normalized.paths },
      { git },
    );
  } catch (err) {
    return {
      isError: true,
      result: errorResult(`worktree warp: cannot copy changes: ${(err && err.message) || err} (nothing was copied)`, { tool: 'worktree_warp' }),
    };
  }
  if (!copied || copied.ok !== true) {
    return {
      isError: true,
      result: errorResult(`worktree warp: ${(copied && copied.error) || 'cannot copy changes'}`, { tool: 'worktree_warp' }),
    };
  }
  return { isError: false, copied };
}
async function executeWorktreeWarpTool(params, ctx, opts) {
  const options = opts || {};
  const mode = libRequire("worktree-mode.js");
  let modeState;
  try {
    modeState = mode.readMode();
  } catch {
    modeState = { state: "malformed", enabled: false };
  }
  if (!modeState || modeState.enabled !== true) {
    return errorResult(
      "worktree tools are disabled; open /herdr-gentle:customize and apply the Worktree tools Enabled row to enable them",
      { state: modeState ? modeState.state : "unknown", tool: "worktree_warp" },
    );
  }
  if (!ctx || typeof ctx.switchSession !== "function") {
    return errorResult(
      "worktree warp is unavailable here: the host session cannot switch sessions",
      { tool: "worktree_warp" },
    );
  }
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const warpSessions = libRequire("worktree-warp-sessions.js");
  const raw = params && typeof params.name === "string" ? params.name.trim() : "";
  const fromCwd = toolCwd(ctx);
  let repo;
  try {
    repo = git.repoIdentity(fromCwd);
  } catch (err) {
    return errorResult(`worktree warp: not a git repository: ${fromCwd}`, { tool: "worktree_warp" });
  }
  const read = registry.readRegistry(repo.root);
  if (!read.ok) {
    return errorResult(`worktree warp: cannot read worktree registry: ${read.error}`, { tool: "worktree_warp" });
  }
  let live;
  try {
    live = git.listWorktrees(repo.root);
  } catch (err) {
    return errorResult(`worktree warp: cannot list worktrees: ${(err && err.message) || err}`, { tool: "worktree_warp" });
  }
  noteWarpDiscovery(repo.root, live);
  const principal = principalForName(git, repo.root, repo, live);
  // The refusal listing: every live selectable checkout as `<name> — <path>`,
  // so the agent can pick without a human.
  const availableCheckouts = () => {
    try {
      const offered = warpOfferedCheckouts(git, read, principal, live, repo.root);
      const listed = offered.map((entry) => `${entry.name} — ${entry.path}`);
      return listed.length > 0 ? listed.join(", ") : "(none)";
    } catch {
      return "(none)";
    }
  };
  if (raw === "") {
    return errorResult(
      `worktree_warp needs a name: pass the worktree name or path; available checkouts: ${availableCheckouts()}`,
      { tool: "worktree_warp" },
    );
  }
  // Name first, then path — one candidate; unknown, foreign or ambiguous
  // fails closed with the listing, exactly like the command's resolver plus
  // the shared path leg.
  let resolved = resolveCheckoutByName(raw, git, read, principal, live, repo.root, { allowUnregistered: true });
  if (!resolved.ok) {
    const pathEntry = resolveClosePathEntry(raw, git, read, live, repo.root);
    if (pathEntry) {
      const entrySlug = slugOf(git, pathEntry.branch);
      resolved = {
        ok: true, kind: "agent", name: entrySlug !== null ? entrySlug : raw,
        path: pathEntry.path, branch: pathEntry.branch, entry: pathEntry,
      };
    } else {
      // A live checkout of this repository reached by path — including one
      // the registry does not own (the warp's lone-unregistered rule) — is
      // not foreign; anything else keeps the name refusal with the listing.
      let byPath = null;
      try {
        const st = checkoutState(raw, repo.root);
        const id = st.real !== null ? st.real : st.absolute;
        if (st.absolute !== null && st.exists && st.isDirectory && id !== null && liveIdentities(live, repo.root).has(id)) {
          let isPrincipal = false;
          try {
            if (principal && typeof principal.path === "string" && principal.path.length > 0) {
              const pst = checkoutState(principal.path, repo.root);
              const pid = pst.real !== null ? pst.real : pst.absolute;
              isPrincipal = pid !== null && pid === id;
            }
          } catch {
            isPrincipal = false;
          }
          if (isPrincipal) {
            byPath = { ok: true, kind: "principal", name: "principal", path: principal.path, branch: principal.branch, entry: null };
          } else {
            let liveBranch = null;
            for (const entry of live) {
              if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
              const est = checkoutState(entry.path, repo.root);
              const eid = est.real !== null ? est.real : est.absolute;
              if (eid !== null && eid === id && typeof entry.branch === "string" && entry.branch.length > 0) { liveBranch = entry.branch; break; }
            }
            const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
            const claimants = rows.filter((row) => {
              try {
                if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) return false;
                const rst = checkoutState(row.path, repo.root);
                const rid = rst.real !== null ? rst.real : rst.absolute;
                return rid !== null && rid === id;
              } catch {
                return false;
              }
            });
            if (claimants.length <= 1) {
              const branch = liveBranch || (claimants.length === 1 ? claimants[0].branch : null);
              if (typeof branch === "string" && branch.length > 0) {
                const slug = slugOf(git, branch);
                byPath = {
                  ok: true, kind: claimants.length === 1 ? "agent" : "unregistered",
                  name: slug !== null ? slug : raw, path: id, branch,
                  entry: claimants.length === 1 ? claimants[0] : null,
                };
              }
            }
          }
        }
      } catch {
        byPath = null;
      }
      if (byPath) {
        resolved = byPath;
      } else {
        return errorResult(
          `worktree warp: ${resolved.error}; available checkouts: ${availableCheckouts()}`,
          { tool: "worktree_warp", name: raw, candidates: resolved.candidates },
        );
      }
    }
  }
  // S39 fail-closed: the target must exist as a directory AND still be a
  // checkout of this repository in git's listing — no fork, no notice, no
  // record write when it is missing or foreign.
  const targetState = checkoutState(resolved.path, repo.root);
  const targetCwd = targetState.real !== null ? targetState.real
    : targetState.absolute !== null ? targetState.absolute
    : path.resolve(resolved.path);
  if (!targetState.exists || !targetState.isDirectory || !liveIdentities(live, repo.root).has(targetCwd)) {
    return errorResult(
      `worktree warp: no live checkout for "${raw}" at ${targetCwd}: the path is missing or is not a checkout of this repository; available checkouts: ${availableCheckouts()}`,
      { tool: "worktree_warp", name: raw },
    );
  }
  // S39 current branch: the registry row keeps the branch recorded at
  // creation time, so the warp shows the checkout's CURRENT branch from git.
  const liveBranch = (registryClaimCounts(read.worktrees, repo.root).get(targetCwd) || 0) <= 1
    ? warpLiveBranchFor(targetCwd, live, repo.root)
    : null;
  let displayName = resolved.name;
  let displayBranch = resolved.branch;
  if (typeof liveBranch === "string" && liveBranch.length > 0) {
    displayBranch = liveBranch;
    if (resolved.kind !== "principal") {
      const liveSlug = slugOf(git, liveBranch);
      if (liveSlug !== null) displayName = liveSlug;
    }
  }
  // Already there: the deepest live checkout containing the session, the
  // rule the listing already uses. No fork, no switch, no message.
  const sessionId = warpSessionIdentity(fromCwd, repo.root);
  const sessionCheckout = warpDeepestContaining(sessionId, [targetCwd, ...warpLiveIdentities(live, repo.root)]);
  if (sessionCheckout !== null && sessionCheckout === targetCwd) {
    return textResult(
      `worktree warp: ${raw} (already there)`,
      { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: true, cancelled: false },
      false,
    );
  }
  // S61: the tool's `changes` option (named changes, never copy):
  // omitted/empty [] or "" copies nothing, "all" copies every pending
  // change, a list of files copies only those. No human selector in the
  // tool: the selection copies working-tree changes only (the source is
  // retained, the destination index preserved) through the same
  // lib/worktree-changes.js transfer the command uses, BEFORE the
  // switch. A destination overlap rejects with no copy and no switch.
  const toolChangesGate = await warpToolMaybeCopyChanges({
    ctx, git, params, fromCheckout: sessionCheckout || fromCwd, targetCwd,
  });
  if (toolChangesGate && toolChangesGate.isError) return toolChangesGate.result;
  const toolCopiedChanges = toolChangesGate && toolChangesGate.copied ? toolChangesGate.copied : null;
  // The S42 rows for the card and the result text: compact names only,
  // expanded adding the current path and branch in that order.
  const sourceCheckout = warpDeepestContaining(sessionId, warpLiveIdentities(live, repo.root));
  const principalCheckout = principalForName(git, repo.root, repo, live);
  const fromDesc = warpDescribeCheckout(sourceCheckout, git, live, repo.root, principalCheckout) || fromCwd;
  const fromName = warpDescribeName(sourceCheckout, git, live, repo.root, principalCheckout)
    || warpClean(fromDesc, "(unknown checkout)");
  const toolMoveText =
    `moved: ${warpClean(fromName, "(unknown checkout)")}\n` +
    `to: ${warpClean(displayName, "worktree")}\n` +
    `path: now in "${warpClean(targetCwd, "(unknown checkout)")}"\n` +
    `branch: now in "${warpClean(displayBranch, "(detached)")}"`;
  // The ONE continuation the switched-to session delivers (S49): the S42
  // card fields travel as details (the warp message renderer paints them),
  // while the content is one short, filler-free instruction naming the
  // checkout now in and telling the agent to continue — sent with
  // triggerTurn:true so the agent does not stop.
  const warpToolNotice = `Worktree warp: now in ${warpClean(targetCwd, "(unknown checkout)")} (branch '${warpClean(displayBranch, "(detached)")}'). Continue the task from here.`;
  const warpToolWithSession = async (r) => {
    try {
      r.ui.setStatus("worktree", `${displayName} (${targetCwd})`);
    } catch {
      // Status is cosmetic; the continuation below is not.
    }
    await r.sendMessage({
      customType: "worktree-warp",
      content: warpToolNotice,
      display: true,
      details: { from: fromCwd, to: targetCwd, fromDesc, fromName, name: displayName, branch: displayBranch },
    }, { triggerTurn: true, deliverAs: "followUp" });
  };
  // S43 records: the filtered point of the current session; both sides of
  // every transition are recorded at their post-transition points.
  const smEarly = ctx.sessionManager || {};
  const safeEarly = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const currentFile = typeof smEarly.getSessionFile === "function" ? safeEarly(() => smEarly.getSessionFile()) : undefined;
  let currentEntriesList = [];
  try {
    const seen = typeof smEarly.getEntries === "function" ? safeEarly(() => smEarly.getEntries()) : undefined;
    if (Array.isArray(seen)) currentEntriesList = seen;
  } catch {
    currentEntriesList = [];
  }
  // S43 identity reads. The POINT of a session is its ACTIVE branch
  // filtered to non-bookkeeping entries (lib/worktree-warp-sessions.js):
  // getEntries() returns every branch while getLeafId() selects the live
  // one, so the leaf travels with the entries. File points are recovered
  // from the file itself (installed _buildIndex rule: the last entry is
  // the leaf), seam first, then the file's own lines — the live runtime
  // reopens the manager and keeps appending there, so the file is the
  // actual destination state, never a stale manager or cached fingerprint.
  const currentLeaf = typeof smEarly.getLeafId === "function" ? safeEarly(() => smEarly.getLeafId()) : undefined;
  const currentPoint = warpSessions.sessionPoint(
    currentEntriesList, typeof currentLeaf === "string" ? currentLeaf : undefined,
  );
  const warpFileOpen = options && typeof options.warpSessionFileOpen === "function"
    ? options.warpSessionFileOpen
    : undefined;
  const warpFreshPoint = (sessionFile) => {
    try {
      return warpSessions.pointOfSessionFile(sessionFile, warpFileOpen ? { open: warpFileOpen } : {});
    } catch {
      return null;
    }
  };
  const sourceIdentity = warpDeepestContaining(sessionId, warpLiveIdentities(live, repo.root));
  const lastSessionInfoName = (entries) => {
    try {
      const list = Array.isArray(entries) ? entries : [];
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const entry = list[index];
        if (entry && entry.type === 'session_info' && typeof entry.name === 'string') {
          const clean = warpClean(entry.name, '');
          if (clean.length > 0) return clean;
        }
      }
    } catch {
    }
    return '';
  };
  const firstSessionInfoName = (entries) => {
    try {
      const list = Array.isArray(entries) ? entries : [];
      for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];
        if (entry && entry.type === 'session_info' && typeof entry.name === 'string') {
          const clean = warpClean(entry.name, '');
          if (clean.length > 0) return clean;
        }
      }
    } catch {
    }
    return '';
  };
  const currentSessionName = () => {
    try {
      const sm = ctx.sessionManager || {};
      if (typeof sm.getSessionName === 'function') {
        return warpClean(sm.getSessionName(), '');
      }
    } catch {
    }
    return '';
  };
  const warpForkName = (entries) => {
    const label = warpClean(displayName, '');
    if (label.length === 0) return '';
    let base = firstSessionInfoName(entries);
    if (base.length === 0) base = currentSessionName();
    if (base.length === 0) return label;
    if (base === label || base.endsWith(` · ${label}`)) return base;
    return `${base} · ${label}`;
  };
  const nameForkAfterCheckout = (renameView, sourceEntries, forkEntries) => {
    try {
      if (!renameView || typeof renameView.appendSessionInfo !== 'function') return;
      const wanted = warpForkName(sourceEntries);
      if (wanted.length === 0) return;
      if (lastSessionInfoName(forkEntries) === wanted) return;
      if (lastSessionInfoName(sourceEntries) === wanted) return;
      renameView.appendSessionInfo(wanted);
    } catch {
    }
  };
  const recordBothSides = (destCwd, destFile, destPoint, srcCwd, srcFile, srcPoint) => {
    try {
      // A null destination point skips its side instead of recording a
      // borrowed one: each side reflects its OWN file, never copied.
      if (typeof destFile === 'string' && destFile.length > 0 && destPoint) {
        warpSessions.recordWarpSession(repo.root, destCwd, {
          sessionFile: destFile, tipId: destPoint.tipId, count: destPoint.count,
        });
      }
    } catch {
    }
    try {
      if (typeof srcCwd === 'string' && srcCwd.length > 0
        && typeof srcFile === 'string' && srcFile.length > 0) {
        warpSessions.recordWarpSession(repo.root, srcCwd, {
          sessionFile: srcFile, tipId: srcPoint.tipId, count: srcPoint.count,
        });
      }
    } catch {
    }
  };
  // S43 resume at the gate: the destination owns a warp session whose file
  // still exists AND whose recorded filtered point equals the CURRENT
  // session's filtered point — then switch to it with no new fork. A
  // missing, corrupt, or stale record, or a record at a DIFFERENT point
  // (real work happened), falls through to the single fork below. Unlike
  // the command's silent resume, the tool emits the card and the
  // continuation in both cases, so the agent keeps working.
  let recordedSession = null;
  let recordedFreshPoint = null;
  try {
    const recorded = warpSessions.getWarpSession(repo.root, targetCwd);
    if (recorded && typeof recorded.sessionFile === "string" && recorded.sessionFile.length > 0
      && path.isAbsolute(recorded.sessionFile)) {
      let usable = false;
      try {
        usable = fs.statSync(recorded.sessionFile).isFile();
      } catch {
        usable = false;
      }
      if (usable) {
        try {
          // Equal points mean the same content, so resume; different points
          // mean real work happened, so fork below. The comparison reads
          // the destination FILE's actual point — never the blindly stale
          // cached fingerprint. An unreadable destination never resumes.
          // Never throws: any comparison failure reads as "fork".
          const freshDestPoint = warpFreshPoint(recorded.sessionFile);
          if (freshDestPoint !== null && warpSessions.samePoint(currentPoint, freshDestPoint)) {
            recordedSession = recorded;
            recordedFreshPoint = freshDestPoint;
          }
        } catch {
          recordedSession = null;
        }
      }
    }
  } catch {
    recordedSession = null;
  }
  const recordedSessionFile = recordedSession !== null ? recordedSession.sessionFile : null;
  if (recordedSessionFile !== null) {
    let resumed;
    try {
      resumed = await ctx.switchSession(recordedSessionFile, { withSession: warpToolWithSession });
    } catch (err) {
      return errorResult(
        `worktree warp: the session switch to ${targetCwd} failed: ${(err && err.message) || err}; the recorded warp session was kept`,
        { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    if (resumed && resumed.cancelled === true) {
      return errorResult(
        `worktree warp: ${raw} cancelled (the session stays in ${fromCwd})`,
        { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: true },
      );
    }
    recordBothSides(
      targetCwd, recordedSessionFile, recordedFreshPoint,
      sourceIdentity, currentFile, currentPoint,
    );
    emitOsc7(options.oscStream || process.stdout, targetCwd);
    return textResult(
      toolMoveText,
      { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, fromName, fromDesc, from: fromCwd, to: targetCwd, alreadyThere: false, cancelled: false, resumed: true },
      false,
    );
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
  if (!warpSourceUsable(file, warpFileOpen)) {
    const entries = typeof sm.getEntries === "function" ? safe(() => sm.getEntries()) : undefined;
    carried = Array.isArray(entries) ? entries : [];
    if (carried.length === 0) {
      return errorResult(
        "worktree warp: no persisted session for this session and nothing in memory to carry over; open or write the session first and retry",
        { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  const SM = options.sessionManagerClass || await sessionManagerClassFor(ctx);
  if (!SM || typeof SM.forkFrom !== "function") {
    return errorResult(
      "worktree warp is unavailable here: the host SessionManager has no forkFrom",
      { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  let target = null;
  let targetFile = null;
  // Only a validated source forks; an allocated-but-unwritten file
  // falls through to the in-memory carry path below.
  if (warpSourceUsable(file, warpFileOpen)) {
    // S43 parent priority: fork from the HIGHEST ancestor whose filtered
    // point still equals this session's, so an untouched fork yields a
    // SIBLING while an advanced session yields its own child.
    let forkSource = file;
    try {
      const climbed = warpSessions.topmostIdenticalAncestor(
        file, currentPoint, warpFileOpen ? { open: warpFileOpen } : {},
      );
      if (typeof climbed === "string" && climbed.length > 0) forkSource = climbed;
    } catch {
      forkSource = file;
    }
    try {
      target = SM.forkFrom(forkSource, targetCwd, sessionDir);
    } catch (err) {
      return errorResult(
        `worktree warp: could not fork the session into ${targetCwd}: ${(err && err.message) || err}`,
        { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    targetFile = target && typeof target.getSessionFile === "function" ? safe(() => target.getSessionFile()) : undefined;
  } else {
    try {
      const allocated = SM.create(targetCwd, sessionDir);
      const allocatedFile = allocated && typeof allocated.getSessionFile === "function" ? allocated.getSessionFile() : undefined;
      if (typeof allocatedFile !== "string" || allocatedFile.length === 0) {
        throw new Error("the host allocated no session file for the target");
      }
      const header = typeof allocated.getHeader === "function" ? allocated.getHeader() : null;
      if (!header) throw new Error("the allocated session has no header");
      const lines = [header, ...carried].map((entry) => `${JSON.stringify(entry)}\n`).join("");
      fs.writeFileSync(allocatedFile, lines, { flag: "wx" });
      target = SM.open(allocatedFile, sessionDir, targetCwd);
    } catch (err) {
      return errorResult(
        `worktree warp: could not carry this session into ${targetCwd}: ${(err && err.message) || err}`,
        { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    targetFile = target && typeof target.getSessionFile === "function" ? safe(() => target.getSessionFile()) : undefined;
  }
  if (typeof targetFile !== "string" || targetFile.length === 0) {
    return errorResult(
      `worktree warp: the forked session for ${targetCwd} has no session file`,
      { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  try {
    if (leaf !== null && leaf !== undefined) target.branch(leaf);
    else target.resetLeaf();
  } catch (err) {
    // S43 sibling case: the fork branched from the highest identical
    // ancestor, which does not carry the current leaf (bookkeeping the
    // fork appended after branching — the real branch() refuses unknown
    // ids). Fall back to the deepest non-bookkeeping entry of the current
    // active branch: the climb guarantees the fork holds it. Reset when
    // the session holds no real entry at all.
    try {
      const liveBranch = warpSessions.activeBranch(
        currentEntriesList, typeof leaf === "string" ? leaf : undefined,
      );
      let anchor = null;
      for (const entry of liveBranch) {
        if (entry && typeof entry.id === "string" && !warpSessions.isWarpBookkeepingEntry(entry)) {
          anchor = entry.id;
        }
      }
      if (anchor !== null) target.branch(anchor);
      else target.resetLeaf();
    } catch (err2) {
      return errorResult(
        `worktree warp: could not position the forked session at ${targetFile}: ${(err2 && err2.message) || err2}; the forked session file was kept for inspection`,
      { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  if (!warpTransitionRecorded(target, fromCwd, targetCwd)) {
    try {
      target.appendCustomEntry("worktree-warp", { from: fromCwd, to: targetCwd, name: displayName, branch: displayBranch });
    } catch (err) {
      return errorResult(
        `worktree warp: could not record the transition into ${targetCwd}: ${(err && err.message) || err}; the forked session file was kept for inspection`,
        { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  try {
    let renameView = null;
    if (SM && typeof SM.open === "function") {
      renameView = SM.open(targetFile, sessionDir);
    }
    if (!renameView || typeof renameView.appendSessionInfo !== "function") {
      renameView = target && typeof target.appendSessionInfo === "function" ? target : null;
    }
    if (renameView) {
      const seen = typeof renameView.getEntries === "function" ? safe(() => renameView.getEntries()) : undefined;
      nameForkAfterCheckout(renameView, currentEntriesList, Array.isArray(seen) ? seen : []);
    }
  } catch {
  }
  let switched;
  try {
    switched = await ctx.switchSession(targetFile, { withSession: warpToolWithSession });
  } catch (err) {
    return errorResult(
      `worktree warp: the session switch to ${targetCwd} failed: ${(err && err.message) || err}; the forked session file was kept at ${targetFile}`,
      { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  if (switched && switched.cancelled === true) {
    try {
      fs.unlinkSync(targetFile);
    } catch {
    }
    return errorResult(
      `worktree warp: ${raw} cancelled (the session stays in ${fromCwd}; the forked session file was removed)`,
      { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: true },
    );
  }
  try {
    // The destination record comes from FRESH destination state read after
    // the switch (the file the live runtime appended to), never from the
    // stale pre-switch manager and never copied from the source.
    const freshForkPoint = warpFreshPoint(targetFile);
    recordBothSides(targetCwd, targetFile, freshForkPoint, sourceIdentity, currentFile, currentPoint);
  } catch {
  }
  emitOsc7(options.oscStream || process.stdout, targetCwd);
  return textResult(
    toolMoveText,
    { tool: "worktree_warp", name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, fromName, fromDesc, from: fromCwd, to: targetCwd, alreadyThere: false, cancelled: false, resumed: false },
    false,
  );
}

const worktreeWarpTool = withWorktreeCardRenderer(defineTool({
  name: "worktree_warp",
  label: "Worktree Warp",
  description: "Move this session to another checkout of the project and continue the task there: pass the worktree name or path (no selector). Resumes the checkout's session when it holds the same content, otherwise forks one, then continues working in the new checkout.",
  parameters: Type.Object({
    name: Type.String({ description: "Name of the checkout to move to (the flattened branch slug, or principal), or its path" }),
    changes: opt(unionSchema([Type.String(), Type.Array(Type.String())], { description: "Pending changes to copy into the destination checkout: omit or pass \"\" or [] for no copy, \"all\" for everything, or a list of files for selected changes only" })),
  }),
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return executeWorktreeWarpTool(params, ctx);
  },
}));

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
// `/herdr-gentle:warp <name>` (S23): move the SESSION to another
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

// S18/S19 warp text hygiene. Branch names and checkout paths reach the
// transcript through the two-line moved/to compact and the one-line
// transition notice, so control characters and ANSI escapes are stripped
// at this layer — the card renderer never sees a command notification.
function warpClean(value, fallback) {
  try {
    const line = String(value ?? '')
      .replace(/\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g, '')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .split('\n')[0].trim().replace(/\s+/g, ' ');
    return line.length > 0 ? line : fallback;
  } catch {
    return fallback;
  }
}

// The S19 compact: exactly two ordered lines — the checkout left, then
// the checkout entered as `name · branch`. Never a paragraph dump; the
// longer explanation lives in the transition notice and the docs.
function warpCompactText(fromDesc, name, branch) {
  const from = warpClean(fromDesc, '(unknown checkout)');
  const toName = warpClean(name, 'worktree');
  const toBranch = warpClean(branch, '(detached)');
  return `moved: ${from}\nto: ${toName} · ${toBranch}`;
}

// The ONE agent-facing transition notice per real move (S18): a single
// line naming the new checkout. Both the fork
// and the resume path send exactly this through withSession; already-there
// warps, cancelled switches (the host never runs withSession for those)
// and refusals never reach it.
function warpNoticeText(targetCwd, branch) {
  const to = warpClean(targetCwd, '(unknown checkout)');
  const cleanBranch = warpClean(branch, '(detached)');
  return `Worktree warp: now in ${to} (branch '${cleanBranch}').`;
}

// Deepest live checkout containing a cwd, by resolved identity — the one
// rule the listing, the selector title and the already-there check share.
// `extraIds` lets the already-there check keep its target-cwd candidate
// without a second notion of containment.
function warpDeepestContaining(sessionId, ids) {
  if (sessionId === null) return null;
  let active = null;
  for (const id of ids || []) {
    if (typeof id !== 'string' || id.length === 0) continue;
    if (sessionId === id || sessionId.startsWith(id + path.sep)) {
      if (active === null || id.length > active.length) active = id;
    }
  }
  return active;
}

function warpLiveIdentities(live, repoRoot) {
  const ids = [];
  for (const entry of live || []) {
    if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    const id = st.real !== null ? st.real : st.absolute;
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function warpSessionIdentity(fromCwd, repoRoot) {
  const sessionState = checkoutState(fromCwd, repoRoot);
  return sessionState.real !== null ? sessionState.real : sessionState.absolute;
}

// Current branch/head for a checkout identity from git's live listing
// (S39): the registry row keeps name/branch as recorded at creation time,
// so the warp and the listing print the CURRENT branch from git instead.
// Returns the live branch string, or null when git names no such checkout
// (the caller then falls back to the registry field).
function warpLiveBranchFor(targetCwd, live, repoRoot) {
  try {
    if (typeof targetCwd !== "string" || targetCwd.length === 0) return null;
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id !== null && id === targetCwd) {
        if (typeof entry.branch === "string" && entry.branch.length > 0) return entry.branch;
        return null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// `name · branch` for a checkout identity, or null when the session sits
// outside every known checkout (the caller then prints the raw path).
function warpDescribeCheckout(identity, git, live, repoRoot, principal) {
  try {
    if (identity === null) return null;
    if (principal && typeof principal.path === 'string' && principal.path.length > 0) {
      const st = checkoutState(principal.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id !== null && id === identity) {
        return `principal · ${warpClean(principal.branch, '(detached)')}`;
      }
    }
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id === identity) {
        const slug = slugOf(git, entry.branch);
        return `${warpClean(slug || 'worktree', 'worktree')} · ${warpClean(entry.branch || '(detached)', '(detached)')}`;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// The S42 source name: the checkout's name only — `principal` for the
// principal checkout, the flattened slug for a worktree — or null when the
// session sits outside every known checkout (the caller then falls back to
// the fromDesc text). Parallel to warpDescribeCheckout, which keeps the
// `name · branch` form the agent text prints; the card reads this field
// for its names-only `moved:` row.
function warpDescribeName(identity, git, live, repoRoot, principal) {
  try {
    if (identity === null) return null;
    if (principal && typeof principal.path === 'string' && principal.path.length > 0) {
      const st = checkoutState(principal.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id !== null && id === identity) return 'principal';
    }
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== 'string' || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id === identity) {
        const slug = slugOf(git, entry.branch);
        return warpClean(slug || 'worktree', 'worktree');
      }
    }
  } catch {
    return null;
  }
  return null;
}

// True when the target session already carries this exact transition
// record (S18): the fork path then skips a duplicate appendCustomEntry,
// so the custom-entry sequence never accumulates one paragraph per warp.
// Unreadable entries read as absent — the record is history and is never
// silently dropped when it cannot be inspected.
function warpTransitionRecorded(target, fromCwd, targetCwd) {
  try {
    const carried = target && typeof target.getEntries === 'function' ? target.getEntries() : undefined;
    if (!Array.isArray(carried)) return false;
    return carried.some((entry) => entry && entry.type === 'custom'
      && entry.customType === 'worktree-warp' && entry.data
      && entry.data.from === fromCwd && entry.data.to === targetCwd);
  } catch {
    return false;
  }
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
// + r.sendMessage(..., {triggerTurn: false}) })`, whose message names the
// new checkout. `cancelled` is a real outcome: it removes the target session file,
// reports it, and changes nothing else. S17 (customize-command T11): at
// most ONE fork per checkout — a checkout with a usable recorded session
// resumes that same file with a plain `switchSession` (no fork, no
// branch/append bookkeeping); only a missing, corrupt, or stale record
// forks once and overwrites the record, principal included.
// S61 pending-changes guard: when the source checkout holds uncommitted
// changes, the warp asks whether to copy them into the destination
// checkout (YES COPY / NO COPY), while Esc/Ctrl+C cancels the warp with
// no switch and no mutation. The built-in boolean confirm collapses No
// and Esc, so the choice rides the existing custom inline single-select
// (lib/warp-create-picker.js), never an invented API. A clean checkout
// never prompts; a summary failure degrades to an ordinary warp (no
// copy) instead of blocking the scripted path. Copying uses the shared
// lib/worktree-changes.js transfer (snapshot preflight, destination
// overlap rejects with zero mutation, dry-run patch validation).
let warpDirtyAsker = null;
function setWarpDirtyAsker(asker) {
  warpDirtyAsker = asker;
}
// Returns 'yes' | 'no' | null (null = cancel). Never throws: any UI
// failure reads as cancel (no switch, no mutation).
async function askWarpDirtyChoice(ctx, summaryLine, opts) {
  if (typeof warpDirtyAsker === 'function') {
    try {
      const value = await warpDirtyAsker(ctx, summaryLine);
      if (value === 'yes' || value === 'no' || value === null) return value;
      return null;
    } catch {
      return null;
    }
  }
  if (ctx && ctx.ui && typeof ctx.ui.custom === 'function') {
    let helpers = null;
    try {
      helpers = await customizeTuiLoader();
    } catch {
      helpers = null;
    }
    let pickerLib = null;
    try {
      pickerLib = libRequire('warp-create-picker.js');
    } catch {
      pickerLib = null;
    }
    if (pickerLib && typeof pickerLib.createSingleSelect === 'function') {
      let out;
      try {
        out = await ctx.ui.custom(
          (hostTui, theme, _keybindings, done) => pickerLib.createSingleSelect({
            title: `Uncommitted changes: ${summaryLine}. Copy to the destination checkout?`,
            items: ['YES COPY', 'NO COPY'],
            helpers,
            hostTui,
            theme,
            showTab: false,
            confirmLabel: 'choose',
            rowsAvailable: () => {
              try {
                const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
                if (Number.isFinite(rows) && rows > 0) return rows;
              } catch {
                // A hostile host object never breaks the prompt.
              }
              return 24;
            },
            done,
          }),
        );
      } catch {
        return null;
      }
      if (out === null || out === undefined) return null;
      if (typeof out === 'string') {
        if (out === 'YES COPY') return 'yes';
        if (out === 'NO COPY') return 'no';
      }
      return null;
    }
  }
  // No custom UI (scripted/headless path): ordinary warp, no copy.
  return 'no';
}
// S61 source-dirty gate shared by the warp command. Returns
// {ok:true, copied} to continue, {cancelled:true} to stop with no
// switch, or {error} to refuse with no switch. Never throws.
async function warpMaybeCopyDirty({ ctx, git, fromCheckout, targetCwd, options }) {
  let changesLib = null;
  try {
    changesLib = libRequire('worktree-changes.js');
  } catch (err) {
    return { ok: true, copied: null };
  }
  let summary;
  try {
    summary = await changesLib.summarizeChanges(fromCheckout, { git });
  } catch {
    return { ok: true, copied: null };
  }
  if (!summary || summary.ok !== true || summary.files === 0) return { ok: true, copied: null };
  const summaryLine = `${summary.files} file${summary.files === 1 ? '' : 's'}, +${summary.added}/-${summary.deleted}`;
  const choice = await askWarpDirtyChoice(ctx, summaryLine, options);
  if (choice === null) return { cancelled: true };
  if (choice === 'no') return { ok: true, copied: null };
  let copied;
  try {
    copied = await changesLib.copyChanges({ from: fromCheckout, to: targetCwd, selectMode: 'all' }, { git });
  } catch (err) {
    return { error: `cannot copy changes: ${(err && err.message) || err} (nothing was warped)` };
  }
  if (!copied || copied.ok !== true) {
    return { error: `${(copied && copied.error) || 'cannot copy changes'} (nothing was warped)` };
  }
  return { ok: true, copied };
}
async function executeWorktreeWarp(rawName, ctx, opts) {
  const options = opts || {};
  const git = libRequire("worktree-git.js");
  const registry = libRequire("worktree-registry.js");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  if (name === "") {
    return warpFail(
      "worktree warp needs a name: use /herdr-gentle:warp <name> (the flattened branch slug, or principal)",
      { name, alreadyThere: false, cancelled: false },
    );
  }
  if (!ctx || typeof ctx.waitForIdle !== "function" || typeof ctx.switchSession !== "function") {
    return warpFail(
      "worktree warp is only available as a session command: run /herdr-gentle:warp <name> from a Pi session",
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
  // S14: this fresh scan is the warp-time discovery refresh.
  noteWarpDiscovery(repo.root, live);
  // The SAME resolver as close-by-name (S14: the warp allows a lone
  // unregistered match): unknown or ambiguous fails closed.
  const resolved = resolveCheckoutByName(name, git, read, principalForName(git, repo.root, repo, live), live, repo.root, { allowUnregistered: true });
  if (!resolved.ok) {
    return warpFail(`worktree warp: ${resolved.error}`, { name, alreadyThere: false, cancelled: false, candidates: resolved.candidates });
  }
  // Normalize the target cwd through the one liveness predicate (a row
  // reaching the checkout through a symlink warps to the real checkout).
  // S39 fail-closed: the target must exist as a directory AND still be a
  // checkout of this repository in git's listing — no fork, no notice,
  // no record write when it is missing or foreign.
  const targetState = checkoutState(resolved.path, repo.root);
  const targetCwd = targetState.real !== null ? targetState.real
    : targetState.absolute !== null ? targetState.absolute
    : path.resolve(resolved.path);
  if (!targetState.exists || !targetState.isDirectory || !liveIdentities(live, repo.root).has(targetCwd)) {
    return warpFail(
      `worktree warp: no live checkout for "${name}" at ${targetCwd}: the path is missing or is not a checkout of this repository; run 'git worktree list' to see the live checkouts`,
      { name, alreadyThere: false, cancelled: false },
    );
  }
  // S39 current branch: the registry row keeps the branch recorded at
  // creation time, so the warp shows the checkout's CURRENT branch from
  // git (the registry field is the fallback only). Sole claimants refresh;
  // shared checkouts keep the resolved row so the ambiguity keeps resolving.
  // The principal keeps its reserved name whatever the default branch is.
  const liveBranch = (registryClaimCounts(read.worktrees, repo.root).get(targetCwd) || 0) <= 1
    ? warpLiveBranchFor(targetCwd, live, repo.root)
    : null;
  let displayName = resolved.name;
  let displayBranch = resolved.branch;
  if (typeof liveBranch === "string" && liveBranch.length > 0) {
    displayBranch = liveBranch;
    if (resolved.kind !== "principal") {
      const liveSlug = slugOf(git, liveBranch);
      if (liveSlug !== null) displayName = liveSlug;
    }
  }
  // Warping to the checkout the session already runs in reports that and
  // changes nothing: no fork, no switch, no OSC-7. "Already there" is the
  // DEEPEST live checkout containing the session, the rule the listing
  // already uses: a session inside a nested worktree under the principal
  // is not in the principal, while a session in a subdirectory of the
  // target is in the target.
  const sessionId = warpSessionIdentity(fromCwd, repo.root);
  const sessionCheckout = warpDeepestContaining(sessionId, [targetCwd, ...warpLiveIdentities(live, repo.root)]);
  if (sessionCheckout !== null && sessionCheckout === targetCwd) {
    return {
      text: `worktree warp: ${name} (already there)`,
      details: { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: true, cancelled: false },
    };
  }
  // S61: the source checkout's pending changes gate. The destination is
  // resolved and verified above; a dirty source asks YES COPY / NO COPY
  // (Esc/Ctrl+C cancels with no switch), a clean source warps silently.
  // The source is the deepest live checkout containing the session (the
  // same rule the already-there check uses); outside every checkout the
  // session cwd itself is summarized.
  const dirtyFrom = warpDeepestContaining(sessionId, warpLiveIdentities(live, repo.root)) || fromCwd;
  const dirtyGate = await warpMaybeCopyDirty({
    ctx, git, fromCheckout: dirtyFrom, targetCwd, options: opts,
  });
  if (dirtyGate && dirtyGate.cancelled === true) {
    return warpFail(
      `worktree warp: ${name} cancelled (the session stays in ${fromCwd})`,
      { name, alreadyThere: false, cancelled: true },
    );
  }
  if (dirtyGate && typeof dirtyGate.error === 'string') {
    return warpFail(dirtyGate.error, { name, alreadyThere: false, cancelled: false });
  }
  // The S19 compact both success paths report: the checkout left, then
  // the checkout entered. One builder, so fork and resume never diverge.
  // fromDesc keeps the `name · branch` form the agent text prints; fromName
  // carries the source worktree's name alone for the card's S42 `moved:` row.
  const sourceCheckout = warpDeepestContaining(sessionId, warpLiveIdentities(live, repo.root));
  const principalCheckout = principalForName(git, repo.root, repo, live);
  const fromDesc = warpDescribeCheckout(
    sourceCheckout,
    git, live, repo.root, principalCheckout,
  ) || fromCwd;
  const fromName = warpDescribeName(sourceCheckout, git, live, repo.root, principalCheckout)
    || warpClean(fromDesc, '(unknown checkout)');
  const moveText = warpCompactText(fromDesc, displayName, displayBranch);
  // The notice the switched-to session delivers on a FORK: the new fork
  // carries the session's work into a new checkout. One closure, one short
  // notice — never a repeated paragraph (S18). Resumes send nothing (R2):
  // the recorded session already carries its notice, so re-entering must
  // not append another copy; the resume path below only updates status.
  const warpNotice = warpNoticeText(targetCwd, displayBranch);
  const warpWithSession = async (r) => {
    try {
      r.ui.setStatus("worktree", `${displayName} (${targetCwd})`);
    } catch {
      // Status is cosmetic; the notice below is not.
    }
    await r.sendMessage({
      customType: "worktree-warp",
      content: warpNotice,
      display: true,
      // S20: the card renderer reads the compact rows from here — never
      // by parsing text — so the styled confirmation, the agent text and
      // the listing identifier cannot drift apart. S42: fromName is the
      // source worktree's name alone for the card's `moved:` row.
      details: { from: fromCwd, to: targetCwd, fromDesc, fromName, name: displayName, branch: displayBranch },
    }, { triggerTurn: false });
  };
  const warpResumeWithSession = async (r) => {
    try {
      r.ui.setStatus("worktree", `${displayName} (${targetCwd})`);
    } catch {
      // Status is cosmetic; the recorded session already carries its
      // confirmation, so no message is sent here (R2).
    }
  };
  // S43 records. The POINT of a session is its ACTIVE branch (the live
  // leaf's parentId path, never all append-only entries) filtered to
  // entries that are NOT our own bookkeeping — the custom marker, the
  // custom_message notice, the session-worktree registration entry and
  // the renames never count as advancement — so a fresh fork's filtered
  // point equals its source's. BOTH sides of every transition are
  // recorded at their post-transition points from FRESH state: the
  // destination file as re-read after the switch, and the source session
  // file just left, each its OWN point. The resume gate below compares
  // the current point against the destination file's actual point (see
  // below); a first visit forks the current work into the target, appends
  // exactly one marker, names the fork after the checkout, and shows
  // exactly one card (R2).
  const warpSessions = libRequire("worktree-warp-sessions.js");
  const smEarly = ctx.sessionManager || {};
  const safeEarly = (fn) => {
    try {
      return fn();
    } catch {
      return undefined;
    }
  };
  const currentFile = typeof smEarly.getSessionFile === "function" ? safeEarly(() => smEarly.getSessionFile()) : undefined;
  let currentEntriesList = [];
  try {
    const seen = typeof smEarly.getEntries === "function" ? safeEarly(() => smEarly.getEntries()) : undefined;
    if (Array.isArray(seen)) currentEntriesList = seen;
  } catch {
    currentEntriesList = [];
  }
  // S43 identity reads. The POINT of a session is its ACTIVE branch
  // filtered to non-bookkeeping entries (lib/worktree-warp-sessions.js):
  // getEntries() returns every branch while getLeafId() selects the live
  // one, so the leaf travels with the entries. File points are recovered
  // from the file itself (installed _buildIndex rule: the last entry is
  // the leaf), seam first, then the file's own lines — the live runtime
  // reopens the manager and keeps appending there, so the file is the
  // actual destination state, never a stale manager or cached fingerprint.
  const currentLeaf = typeof smEarly.getLeafId === "function" ? safeEarly(() => smEarly.getLeafId()) : undefined;
  const currentPoint = warpSessions.sessionPoint(
    currentEntriesList, typeof currentLeaf === "string" ? currentLeaf : undefined,
  );
  const warpFileOpen = options && typeof options.warpSessionFileOpen === "function"
    ? options.warpSessionFileOpen
    : undefined;
  const warpFreshPoint = (sessionFile) => {
    try {
      return warpSessions.pointOfSessionFile(sessionFile, warpFileOpen ? { open: warpFileOpen } : {});
    } catch {
      return null;
    }
  };
  // The checkout being left: the deepest live checkout containing the
  // session, the same rule the already-there check uses. Null when the
  // session sits outside every checkout: then only the destination side
  // is recorded. It never gates the resume decision — S37 compares the
  // destination record against the current session, not this checkout.
  const sourceIdentity = warpDeepestContaining(sessionId, warpLiveIdentities(live, repo.root));
  // Latest session_info name: the human-visible name the session carries
  // right now (what getSessionName() returns). Used only for the
  // already-there equality checks below, never as the rename base — the
  // latest is the already-appended one, so suffixing onto it stacks a
  // pair of segments per hop.
  const lastSessionInfoName = (entries) => {
    try {
      const list = Array.isArray(entries) ? entries : [];
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const entry = list[index];
        if (entry && entry.type === 'session_info' && typeof entry.name === 'string') {
          const clean = warpClean(entry.name, '');
          if (clean.length > 0) return clean;
        }
      }
    } catch {
      // No name: the checkout label stands alone below.
    }
    return '';
  };
  // Base session name for the fork rename: the FIRST session_info
  // entry's name — the session's original name before any warp appended
  // a checkout — because entries arrive in append order while
  // getSessionName() sees only the latest. Falls back to the manager's
  // current name when the entries carry none (getEntries() copies the
  // session while getSessionName() reads the live list, so one can
  // answer when the other cannot). Empty when there is no name at all.
  const firstSessionInfoName = (entries) => {
    try {
      const list = Array.isArray(entries) ? entries : [];
      for (let index = 0; index < list.length; index += 1) {
        const entry = list[index];
        if (entry && entry.type === 'session_info' && typeof entry.name === 'string') {
          const clean = warpClean(entry.name, '');
          if (clean.length > 0) return clean;
        }
      }
    } catch {
      // No base: the caller falls back below.
    }
    return '';
  };
  const currentSessionName = () => {
    try {
      const sm = ctx.sessionManager || {};
      if (typeof sm.getSessionName === 'function') {
        return warpClean(sm.getSessionName(), '');
      }
    } catch {
      // No current name: the checkout label stands alone below.
    }
    return '';
  };
  // Short form: "<base> · <checkout>", the checkout written ONCE as the
  // warp identifier (displayName — the slug the selector shows and
  // `warp <name>` accepts, so "principal" stays "principal" whatever
  // the default branch is). The base is the session's ORIGINAL name, so
  // a second hop re-derives "base · b" instead of stacking
  // "base · a · b"; with no name at all the checkout label alone is
  // the stable default (still a usable name). Sanitized and
  // structurally bounded — one segment per fork, never accumulated.
  // Empty only when there is nothing to say.
  const warpForkName = (entries) => {
    const label = warpClean(displayName, '');
    if (label.length === 0) return '';
    let base = firstSessionInfoName(entries);
    if (base.length === 0) base = currentSessionName();
    if (base.length === 0) return label;
    if (base === label || base.endsWith(` · ${label}`)) return base;
    return `${base} · ${label}`;
  };
  // Name the fork after the checkout through the real
  // SessionManager.open(path).appendSessionInfo(name): a rename is a
  // session_info entry, so it never moves the filtered point. The base
  // name comes from the source entries (the fork inherits them verbatim)
  // while the already-there check reads the fork itself. Best-effort and
  // never on resume: a name that is already there is left alone, and a
  // rename failure never fails the warp that already switched.
  const nameForkAfterCheckout = (renameView, sourceEntries, forkEntries) => {
    try {
      if (!renameView || typeof renameView.appendSessionInfo !== 'function') return;
      const wanted = warpForkName(sourceEntries);
      if (wanted.length === 0) return;
      // The fork inherits the source entries verbatim, so a name that is
      // already there — on either leg — is left alone, never rewritten.
      if (lastSessionInfoName(forkEntries) === wanted) return;
      if (lastSessionInfoName(sourceEntries) === wanted) return;
      renameView.appendSessionInfo(wanted);
    } catch {
      // Best effort: the warp already succeeded.
    }
  };
  const recordBothSides = (destCwd, destFile, destPoint, srcCwd, srcFile, srcPoint) => {
    try {
      // A null destination point skips its side instead of recording a
      // borrowed one: each side reflects its OWN file, never copied.
      if (typeof destFile === 'string' && destFile.length > 0 && destPoint) {
        warpSessions.recordWarpSession(repo.root, destCwd, {
          sessionFile: destFile, tipId: destPoint.tipId, count: destPoint.count,
        });
      }
    } catch {
      // Best effort: the warp already succeeded.
    }
    try {
      if (typeof srcCwd === 'string' && srcCwd.length > 0
        && typeof srcFile === 'string' && srcFile.length > 0) {
        warpSessions.recordWarpSession(repo.root, srcCwd, {
          sessionFile: srcFile, tipId: srcPoint.tipId, count: srcPoint.count,
        });
      }
    } catch {
      // Best effort: the warp already succeeded.
    }
  };
  // S43 resume (point comparison at the gate): the destination owns a
  // warp session whose file is an absolute path that still exists AND
  // whose recorded filtered point equals the CURRENT session's filtered
  // point (our warp markers and renames excluded from both) — then switch
  // to it with NO new fork, no fresh confirmation (R2: it already
  // carries its notice), no rename and no new bookkeeping: the two
  // threads hold the same content. A missing, corrupt, or stale (file
  // gone) destination record — the checkout's first visit — or a record
  // at a DIFFERENT point (real work happened) falls through to the
  // single fork below, which records both sides. The lookup never throws
  // and never writes.
  let recordedSession = null;
  let recordedFreshPoint = null;
  try {
    const recorded = warpSessions.getWarpSession(repo.root, targetCwd);
    // Absolute only: a relative entry can never name a session file
    // without resolving against the process cwd, so it reads as no
    // record and the warp forks again.
    if (recorded && typeof recorded.sessionFile === "string" && recorded.sessionFile.length > 0
      && path.isAbsolute(recorded.sessionFile)) {
      let usable = false;
      try {
        usable = fs.statSync(recorded.sessionFile).isFile();
      } catch {
        usable = false;
      }
      // Equal points mean the same content, so resume; different points
      // mean real work happened, so fork below. Never throws: any
      // comparison failure reads as "fork".
      if (usable) {
        try {
          // Equal points mean the same content, so resume; different points
          // mean real work happened, so fork below. The comparison reads
          // the destination FILE's actual point — never the blindly stale
          // cached fingerprint. An unreadable destination never resumes.
          // Never throws: any comparison failure reads as "fork".
          const freshDestPoint = warpFreshPoint(recorded.sessionFile);
          if (freshDestPoint !== null && warpSessions.samePoint(currentPoint, freshDestPoint)) {
            recordedSession = recorded;
            recordedFreshPoint = freshDestPoint;
          }
        } catch {
          recordedSession = null;
        }
      }
    }
  } catch {
    recordedSession = null;
  }
  const recordedSessionFile = recordedSession !== null ? recordedSession.sessionFile : null;
  if (recordedSessionFile !== null) {
    let resumed;
    try {
      resumed = await ctx.switchSession(recordedSessionFile, { withSession: warpResumeWithSession });
    } catch (err) {
      return warpFail(
        `worktree warp: the session switch to ${targetCwd} failed: ${(err && err.message) || err}; the recorded warp session was kept`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    if (resumed && resumed.cancelled === true) {
      // Like the fork path, `cancelled` is a real outcome, not a
      // success — except the recorded file is kept: it still belongs to
      // this checkout, so a later warp resumes it.
      return warpFail(
        `worktree warp: ${name} cancelled (the session stays in ${fromCwd})`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: true },
      );
    }
    // After a successful switch only: refresh both records at their
    // post-transition points. The resume appends nothing, so the
    // destination keeps its recorded point (only the timestamp moves)
    // while the source records the session file just left at its point.
    // Then tell the terminal the new cwd (nothing unless a TTY).
    recordBothSides(
      targetCwd, recordedSessionFile, recordedFreshPoint,
      sourceIdentity, currentFile, currentPoint,
    );
    emitOsc7(options.oscStream || process.stdout, targetCwd);
    return {
      text: moveText,
      details: { name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
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
  if (!warpSourceUsable(file, warpFileOpen)) {
    const entries = typeof sm.getEntries === "function" ? safe(() => sm.getEntries()) : undefined;
    carried = Array.isArray(entries) ? entries : [];
    if (carried.length === 0) {
      return warpFail(
        "worktree warp: no persisted session for this session and nothing in memory to carry over; open or write the session first and retry",
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  const SM = options.sessionManagerClass || await sessionManagerClassFor(ctx);
  if (!SM || typeof SM.forkFrom !== "function") {
    return warpFail(
      "worktree warp is unavailable here: the host SessionManager has no forkFrom",
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  let target = null;
  let targetFile = null;
  // Only a validated source forks; an allocated-but-unwritten file
  // falls through to the in-memory carry path below.
  if (warpSourceUsable(file, warpFileOpen)) {
    // S43 parent priority: fork from the HIGHEST ancestor whose filtered
    // point still equals this session's, so an untouched fork yields a
    // SIBLING (both children of the original) while an advanced session
    // yields its own child. The climb reads the `parentSession` chain and
    // never throws: any unreadable link, mismatch, cycle or depth-cap stop
    // keeps the last good file. `warpSessionFileOpen` is the test seam
    // (open(file) -> {entries, parentSession}); production omits it and
    // the climb reads the real session files.
    let forkSource = file;
    try {
      const climbed = warpSessions.topmostIdenticalAncestor(
        file, currentPoint, warpFileOpen ? { open: warpFileOpen } : {},
      );
      if (typeof climbed === "string" && climbed.length > 0) forkSource = climbed;
    } catch {
      forkSource = file;
    }
    try {
      target = SM.forkFrom(forkSource, targetCwd, sessionDir);
    } catch (err) {
      return warpFail(
        `worktree warp: could not fork the session into ${targetCwd}: ${(err && err.message) || err}`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
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
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
    targetFile = target && typeof target.getSessionFile === "function" ? safe(() => target.getSessionFile()) : undefined;
  }
  if (typeof targetFile !== "string" || targetFile.length === 0) {
    return warpFail(
      `worktree warp: the forked session for ${targetCwd} has no session file`,
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
    );
  }
  try {
    if (leaf !== null && leaf !== undefined) target.branch(leaf);
    else target.resetLeaf();
  } catch (err) {
    // S43 sibling case: the fork branched from the highest identical
    // ancestor, which does not carry the current leaf (bookkeeping the
    // fork appended after branching — the real branch() refuses unknown
    // ids). Fall back to the deepest non-bookkeeping entry of the current
    // active branch: the climb guarantees the fork holds it. Reset when
    // the session holds no real entry at all.
    try {
      const liveBranch = warpSessions.activeBranch(
        currentEntriesList, typeof leaf === "string" ? leaf : undefined,
      );
      let anchor = null;
      for (const entry of liveBranch) {
        if (entry && typeof entry.id === "string" && !warpSessions.isWarpBookkeepingEntry(entry)) {
          anchor = entry.id;
        }
      }
      if (anchor !== null) target.branch(anchor);
      else target.resetLeaf();
    } catch (err2) {
      return warpFail(
        `worktree warp: could not position the forked session at ${targetFile}: ${(err2 && err2.message) || err2}; the forked session file was kept for inspection`,
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  // S18 dedupe: the target may already carry this exact transition (a
  // fork of a session that recorded it), in which case no second record
  // is appended — the custom-entry sequence stays at one per transition.
  // The marker is our own bookkeeping: it advances the raw leaf but never
  // the filtered point, so it can never force a second fork by itself.
  if (!warpTransitionRecorded(target, fromCwd, targetCwd)) {
    try {
      target.appendCustomEntry("worktree-warp", { from: fromCwd, to: targetCwd, name: displayName, branch: displayBranch });
    } catch (err) {
      return warpFail(
        `worktree warp: could not record the transition into ${targetCwd}: ${(err && err.message) || err}; the forked session file was kept for inspection`,
        { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
      );
    }
  }
  // S23 naming: each fork carries its checkout. Never on resume (that
  // path returns before any fork exists), never when the fork already
  // carries the name, never a warp failure.
  try {
    let renameView = null;
    if (SM && typeof SM.open === "function") {
      renameView = SM.open(targetFile, sessionDir);
    }
    if (!renameView || typeof renameView.appendSessionInfo !== "function") {
      renameView = target && typeof target.appendSessionInfo === "function" ? target : null;
    }
    if (renameView) {
      const seen = typeof renameView.getEntries === "function" ? safe(() => renameView.getEntries()) : undefined;
      nameForkAfterCheckout(renameView, currentEntriesList, Array.isArray(seen) ? seen : []);
    }
  } catch {
    // Best effort: the warp already succeeded.
  }
  let switched;
  try {
    switched = await ctx.switchSession(targetFile, { withSession: warpWithSession });
  } catch (err) {
    return warpFail(
      `worktree warp: the session switch to ${targetCwd} failed: ${(err && err.message) || err}; the forked session file was kept at ${targetFile}`,
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
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
      { name, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: true },
    );
  }
  // S23: the fork (or the carried memory session) is the destination's
  // warp session at its post-transition point — read AFTER the marker and
  // the rename landed, so what is stored is the filtered point, identical
  // to the source's by the verbatim-copy property (our own appends are
  // excluded from the filter). The target read wins when it carries
  // entries; an empty or unreadable target read falls back to the source
  // point, which names the same filtered position. The source checkout
  // records the session file just left at its own point. Best-effort and
  // only on success: a cancelled switch removed the file above (nothing
  // to record), and a failed record write never fails the warp that
  // already switched.
  try {
    // The destination record comes from FRESH destination state read after
    // the switch (the file the live runtime appended to), never from the
    // stale pre-switch manager and never copied from the source.
    const freshForkPoint = warpFreshPoint(targetFile);
    recordBothSides(targetCwd, targetFile, freshForkPoint, sourceIdentity, currentFile, currentPoint);
  } catch {
    // Best effort: the warp already succeeded.
  }
  // After a successful switch only: tell the terminal the new cwd. The
  // helper writes nothing unless the stream is a TTY.
  emitOsc7(options.oscStream || process.stdout, targetCwd);
  return {
    text: moveText,
    details: { name: displayName, path: targetCwd, branch: displayBranch, kind: resolved.kind, alreadyThere: false, cancelled: false },
  };
}

// ---------------------------------------------------------------------------
// `/herdr-gentle:warp` (customize-command S11): move the SESSION to another
// checkout of the project through a popup selector, or by explicit `<name>`.
//
// WHY its own command instead of a `warp` verb only: S11 wants the
// project's checkouts offered as a selector with the active checkout shown
// as text, and an explicit `<name>` keeps the scripted path. Both paths end
// in the SAME `executeWorktreeWarp` above — one resolver, one mover — so a
// name carried by more than one live checkout keeps failing closed here
// exactly as it does for the `worktree` verb, and the notification, the
// cancelled outcome and the OSC-7 behaviour stay byte for byte. Session
// control (`waitForIdle`, `switchSession`) exists only on a command
// context, which is why this is a command and never a tool.
// ---------------------------------------------------------------------------

// Live, selectable checkouts for the warp selector (S11, S14): the
// principal checkout first, then the registry rows in registry order, then
// the live checkouts the registry does not own (S14 discovery, in git
// listing order) — every entry live through the ONE liveness predicate
// (`checkoutState`: something exists there AND it is a directory AND git
// still lists it), so a hand-deleted checkout or a path replaced by a file
// is never offered. Nothing here is written to the registry: unregistered
// checkouts are offered without being adopted.
function warpOfferedCheckouts(git, read, principal, live, repoRoot) {
  const liveIds = liveIdentities(live, repoRoot);
  const offered = [];
  if (principal) {
    offered.push({ name: "principal", path: principal.path, branch: principal.branch });
  }
  const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
  // S39: sole claimants offer the CURRENT git branch; shared checkouts keep
  // their stored names so the ambiguity keeps resolving (and every offered
  // name stays warpable through the resolver's live-slug match).
  const liveBranchById = liveBranchMap(live, repoRoot);
  const claimCounts = registryClaimCounts(rows, repoRoot);
  for (const row of rows) {
    if (!row || typeof row.path !== "string" || !path.isAbsolute(row.path)) continue;
    const st = checkoutState(row.path, repoRoot);
    if (!st.exists || !st.isDirectory) continue;
    const id = st.real !== null ? st.real : st.absolute;
    if (id === null || !liveIds.has(id)) continue;
    const liveShown = (claimCounts.get(id) || 0) === 1 ? liveBranchById.get(id) : undefined;
    const shownBranch = liveShown || row.branch;
    const name = slugOf(git, shownBranch);
    if (name === null) continue;
    offered.push({ name, path: id, branch: typeof shownBranch === "string" ? shownBranch : "(detached)" });
  }
  // S14 discovery: live checkouts the registry does not own are offered
  // too (never written or adopted here). A name already offered keeps its
  // registered row: the duplicate fails closed at resolution time instead
  // of hiding a checkout.
  for (const extra of liveUnregisteredEntries(rows, live, repoRoot, principal)) {
    const name = slugOf(git, extra.branch);
    if (name === null) continue;
    offered.push({ name, path: extra.path, branch: extra.branch || "(detached)" });
  }
  return offered;
}

// The active checkout for the warp selector (S11): the checkout containing
// or equal to the command context's cwd, deepest match winning, the
// principal as a candidate — the SAME rule the listing (S19) and the warp
// already-there check use, never a second notion. Identity is the resolved
// realpath with an absolute fallback on both legs (never the process cwd
// and never a lexical resolve alone), so a symlink spelling of a checkout
// still matches it. Returns the identity string, or null when the session
// sits outside every checkout.
function warpActiveIdentity(live, repoRoot, principal, fromCwd) {
  const sessionState = checkoutState(fromCwd, repoRoot);
  const sessionId = sessionState.real !== null ? sessionState.real : sessionState.absolute;
  if (sessionId === null) return null;
  const ids = [];
  if (principal && typeof principal.path === "string" && principal.path.length > 0) ids.push(principal.path);
  for (const entry of live || []) {
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
    const st = checkoutState(entry.path, repoRoot);
    const id = st.real !== null ? st.real : st.absolute;
    if (id !== null && !ids.includes(id)) ids.push(id);
  }
  let active = null;
  for (const id of ids) {
    if (sessionId === id || sessionId.startsWith(id + path.sep)) {
      if (active === null || id.length > active.length) active = id;
    }
  }
  return active;
}

// The title entry for the warp selector (S11): the active checkout as
// `{name, path}`, resolved against the offered rows first (so the title
// spells the checkout exactly as the options would), then against the live
// listing for a checkout the registry does not own. A session outside
// every checkout titles itself honestly instead of inventing one.
function warpTitleEntry(git, offered, live, repoRoot, active, fromCwd) {
  const current = offered.find((entry) => entry.path === active);
  if (current) return current;
  if (active !== null) {
    for (const entry of live || []) {
      if (!entry || typeof entry.path !== "string" || entry.path.length === 0) continue;
      const st = checkoutState(entry.path, repoRoot);
      const id = st.real !== null ? st.real : st.absolute;
      if (id === active) {
        return { name: slugOf(git, entry.branch) || "worktree", path: active };
      }
    }
  }
  return { name: "unknown", path: fromCwd };
}

// Startup + warp-time discovery (customize-command S14): the project's
// live checkouts, refreshed on `session_start` and freshly on every warp
// invocation, so the selector sees checkouts created or closed since the
// session started — including live checkouts the registry does not own.
// Read-only by construction: the scan never writes the registry, never
// adopts anything, never throws. The last successful scan is kept in
// `warpDiscoveryCache` for inspection; every warp still lists fresh before
// acting, so a stale cache can never move the session somewhere stale.
let warpDiscoveryCache = null;

function noteWarpDiscovery(repoRoot, live) {
  warpDiscoveryCache = { repoRoot, live, at: Date.now() };
  return warpDiscoveryCache;
}

// Best-effort live scan for `session_start`: `{repo, live}` or null when
// the session is outside a repository or git cannot list. Never throws,
// never touches the registry.
function scanLiveCheckouts(cwd) {
  try {
    const git = libRequire("worktree-git.js");
    const from = typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
    const repo = git.repoIdentity(from);
    const live = git.listWorktrees(repo.root);
    return { repo, live };
  } catch {
    return null;
  }
}

// S20 warp confirmation card: the visible transition notice renders like
// the reference cards (glyph, capitalised label, ordered short lines)
// instead of Pi's default `[worktree-warp]` block. Commands have no render
// hook, so the styling lives here as a message renderer over the pure card
// factory in lib/worktree-card.js, with helpers through the same
// injectable seam as the tool cards. Guarded so older hosts and unit-test
// doubles without registerMessageRenderer still load: then the notice
// shows through the default block, while the warp itself is unaffected.
function registerWarpMessageRenderer(pi) {
  if (typeof pi?.registerMessageRenderer !== "function") return;
  try {
    const factory = libRequire("worktree-card.js");
    if (typeof factory.createWarpMessageRenderer !== "function") return;
    pi.registerMessageRenderer(
      "worktree-warp",
      factory.createWarpMessageRenderer(resolveWorktreeCardHelpers() || undefined),
    );
  } catch {
    // The default block still shows the notice; the warp itself is unaffected.
  }
}

// S45: the warp selector's FINAL entry — create a worktree from the
// selector, in TWO steps: the change TYPE first, then the change NAME.
// S47: plain action text with an ellipsis (never the em-dash path shape
// of a checkout row, so it can never collide with one) and always last.
// There is deliberately NO separator row above it: the host selector
// takes a plain string array where EVERY row is selectable
// (ExtensionSelectorComponent moves and confirms over all indices — no
// disabled flag, no divider, no header concept), so a fake blank row
// would itself be pickable. The old `+ ` prefix is gone for the same
// alignment reason the user flagged.
const WARP_CREATE_ENTRY = "Create new worktree…";

// S45: the Conventional Commit change types (skills/branch-pr/SKILL.md),
// in the skill's order with its human labels. `feat` rides first on
// purpose: the host selector highlights the first row, so the default
// highlight lands on it with no extra API.
const WARP_CHANGE_TYPES = [
  { id: "feat", label: "Feature" },
  { id: "fix", label: "Bug fix" },
  { id: "chore", label: "Chore" },
  { id: "docs", label: "Docs" },
  { id: "style", label: "Style" },
  { id: "refactor", label: "Refactor" },
  { id: "perf", label: "Performance" },
  { id: "test", label: "Test" },
  { id: "build", label: "Build" },
  { id: "ci", label: "CI" },
  { id: "revert", label: "Revert" },
];
const WARP_CHANGE_TYPE_OPTIONS = WARP_CHANGE_TYPES.map((t) => `${t.label} (${t.id})`);
// No selectable Back or Confirm row on the type panel: eleven data rows
// only. Tab alone goes back (quiet return to the checkout selector —
// the first field has nowhere earlier to go), Enter confirms, Esc
// cancels. The built-in `ctx.ui.select` cannot return a Tab Back (it
// only resolves picked strings), so the inline custom single-select
// below carries the Tab handling; the host select stays as the fallback
// where no custom UI exists (there Esc cancels, documented, never a
// phantom row).
const WARP_CREATE_TYPE_TITLE = "New worktree change type";
// Branch names MUST match the skill's shape: `<type>/<slug>`.
const WARP_CREATE_BRANCH_RE = /^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$/;

// Resolve a type answer to its id: the seam returns the id, the real
// selector returns the picked option string — both land here, anything
// else fails closed.
function resolveWarpChangeType(value) {
  if (typeof value !== "string") return null;
  const byId = WARP_CHANGE_TYPES.find((t) => t.id === value);
  if (byId) return byId.id;
  const byOption = WARP_CHANGE_TYPES.find((t) => `${t.label} (${t.id})` === value);
  return byOption ? byOption.id : null;
}

// Injectable seam for the type prompt: tests inject a stub so no test
// ever opens a real selector. Production leaves it null and the helper
// below calls the real `ctx.ui.select` exactly.
let warpCreateTypeAsker = null;

function setWarpCreateTypeAsker(asker) {
  warpCreateTypeAsker = asker;
}

// Ask for the change type as a STANDALONE panel: only its own title,
// its eleven data rows and its own key footer — never cross-field
// chips/tabs/counters. Returns `{ ok: true, value }` (value undefined
// on cancel), `{ back: true }` on Tab Back (the caller exits quietly to
// the checkout selector: the first field has nowhere earlier to go),
// or `{ ok: false }` when the host truly has no selector — then the
// caller fails with a clear actionable message instead of inventing
// one. `previous` (a type id) restores the cursor on the return trip.
async function askWarpCreateType(ctx, previous) {
  if (typeof warpCreateTypeAsker === "function") {
    try {
      const value = await warpCreateTypeAsker(ctx, previous);
      if (value !== null && typeof value === "object" && value.back === true) return { back: true };
      return { ok: true, value };
    } catch {
      return { ok: true, value: undefined };
    }
  }
  if (ctx && ctx.ui && typeof ctx.ui.custom === "function") {
    let helpers = null;
    try {
      helpers = await customizeTuiLoader();
    } catch {
      helpers = null;
    }
    let pickerLib = null;
    try {
      pickerLib = libRequire("warp-create-picker.js");
    } catch {
      pickerLib = null;
    }
    if (pickerLib && typeof pickerLib.createSingleSelect === "function") {
      let out;
      try {
        // Inline, no overlay options — the same bottom-anchored dock
        // region as the other panels. One mount at a time: this await
        // resolves before the next panel opens.
        out = await ctx.ui.custom(
          (hostTui, theme, _keybindings, done) => pickerLib.createSingleSelect({
            title: WARP_CREATE_TYPE_TITLE,
            items: WARP_CHANGE_TYPE_OPTIONS,
            helpers,
            hostTui,
            theme,
            // The panel rows are option strings while the wizard keeps
            // the type id: map the kept id back to its row so the
            // cursor restores on the return trip.
            initialSelected: typeof previous === "string"
              ? (WARP_CHANGE_TYPES.find((t) => t.id === previous) ? `${WARP_CHANGE_TYPES.find((t) => t.id === previous).label} (${previous})` : undefined)
              : undefined,
            rowsAvailable: () => {
              try {
                const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
                if (Number.isFinite(rows) && rows > 0) return rows;
              } catch {
                // A hostile host object never breaks the selector.
              }
              return 24;
            },
            done,
          }),
        );
      } catch {
        return { ok: true, value: undefined };
      }
      if (out === null || out === undefined) return { ok: true, value: undefined };
      if (typeof out === "object" && out.back === true) return { back: true };
      if (typeof out === "string") return { ok: true, value: out };
      return { ok: true, value: undefined };
    }
  }
  if (ctx && ctx.ui && typeof ctx.ui.select === "function") {
    let picked;
    try {
      picked = await ctx.ui.select(WARP_CREATE_TYPE_TITLE, WARP_CHANGE_TYPE_OPTIONS);
    } catch {
      return { ok: true, value: undefined };
    }
    return { ok: true, value: picked };
  }
  return { ok: false, value: undefined };
}

// The type was picked first, so the title asks for the CHANGE name
// (a bare name like `name-change`, never a branch) and the placeholder
// shows one. The real Pi text prompt (verified against this Pi version's
// own API: `ctx.ui.input(title, placeholder)` — the `input` dialog method
// beside `select`/`confirm`/`editor`, see docs/tui.md +
// docs/rpc-extension-ui.md and
// examples/extensions/{project-trust,rpc-demo}.ts).
const WARP_CREATE_NAME_TITLE = "New worktree change name";
const WARP_CREATE_NAME_PLACEHOLDER = "name-change";

// Injectable seam for the name prompt: tests inject a stub so no test
// ever opens a real prompt. Production leaves it null and the helper
// below calls the real `ctx.ui.input` exactly.
let warpCreateNameAsker = null;

function setWarpCreateNameAsker(asker) {
  warpCreateNameAsker = asker;
}

// Ask for the new worktree's name, exactly once per create-entry choice.
// Returns `{ ok: true, value }` (value undefined on cancel), or
// `{ ok: false }` when the host truly has no text prompt — then the
// caller fails with a clear actionable message instead of inventing one.
// Ask for the new worktree's name as a STANDALONE panel: only its own
// title, its own value line and its own key footer — never cross-field
// chips/tabs/counters. Returns `{ ok: true, value }` (value undefined
// on cancel), `{ back: true }` on Tab Back (the caller returns to the
// type field with every kept value), or `{ ok: false }` when the host
// truly has no text prompt — then the caller fails with a clear
// actionable message instead of inventing one. The inline custom text
// input (same dock region as the pickers, questionnaire style) carries
// the Back affordance the host `input` primitive lacks; the host input
// stays as the fallback where no custom UI exists. `previous` pre-fills
// the field when returning from a later step.
async function askWarpCreateName(ctx, previous) {
  if (typeof warpCreateNameAsker === "function") {
    try {
      const value = await warpCreateNameAsker(ctx, previous);
      if (value !== null && typeof value === "object" && value.back === true) return { back: true };
      return { ok: true, value };
    } catch {
      return { ok: true, value: undefined };
    }
  }
  if (ctx && ctx.ui && typeof ctx.ui.custom === "function") {
    let helpers = null;
    try {
      helpers = await customizeTuiLoader();
    } catch {
      helpers = null;
    }
    let pickerLib = null;
    try {
      pickerLib = libRequire("warp-create-picker.js");
    } catch {
      pickerLib = null;
    }
    if (pickerLib && typeof pickerLib.createTextInput === "function") {
      let out;
      try {
        // Inline, no overlay options — the same bottom-anchored dock
        // region as the type/name prompts and the pickers (S48).
        out = await ctx.ui.custom(
          (hostTui, theme, _keybindings, done) => pickerLib.createTextInput({
            title: WARP_CREATE_NAME_TITLE,
            placeholder: WARP_CREATE_NAME_PLACEHOLDER,
            initial: typeof previous === "string" ? previous : "",
            helpers,
            hostTui,
            theme,
            rowsAvailable: () => {
              try {
                const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
                if (Number.isFinite(rows) && rows > 0) return rows;
              } catch {
                // A hostile host object never breaks the input.
              }
              return 24;
            },
            done,
          }),
        );
      } catch {
        return { ok: true, value: undefined };
      }
      if (out === null || out === undefined) return { ok: true, value: undefined };
      // Tab Back carries the actually typed value: the wizard keeps
      // exactly what the user typed, not just the last confirmation.
      if (typeof out === "object" && out.back === true) {
        return { back: true, value: typeof out.value === "string" ? out.value : undefined };
      }
      if (typeof out === "string") return { ok: true, value: out };
      return { ok: true, value: undefined };
    }
  }
  if (ctx && ctx.ui && typeof ctx.ui.input === "function") {
    // Returning from a later step shows the kept name as the
    // placeholder; submitting empty keeps it. The host input has no
    // prefill, so this placeholder is the preservation.
    const placeholder = typeof previous === "string" && previous.length > 0 ? previous : WARP_CREATE_NAME_PLACEHOLDER;
    try {
      return { ok: true, value: await ctx.ui.input(WARP_CREATE_NAME_TITLE, placeholder) };
    } catch {
      return { ok: true, value: undefined };
    }
  }
  return { ok: false, value: undefined };
}


// S45 create-then-warp: the selector's final entry. The change TYPE comes
// first, then the change NAME, and the pair derives branch `<type>/<slug>`
// and checkout `<type>-<slug>` (the skill's regex). The checkout is created
// through the SAME creation path the `worktree_create` tool uses
// (`executeWorktreeCreate` is called, never reimplemented). The picked
// type plus the typed name is the human approval, so the create runs
// with the approval dialog suppressed (`hasUI: false` on a shallow copy
// — the same function, one call); forwarding the command context
// unchanged would double-prompt. A fresh checkout has no recorded session,
// so the warp that follows forks, and that fork's card is the only
// confirmation.
//
// S46: between the NAME step and the creation run two OPTIONAL
// multi-select steps — ISSUES, then ODD — through the ONE reusable
// component in lib/warp-create-picker.js (search box, pagination,
// multi-select, confirm; rendered through `ctx.ui.custom` with NO overlay
// options, so the host shows it inline in the editor container — the same
// bottom-anchored region as the `select`/`input` dialogs — instead of
// floating above the transcript (S48; an `anchor: "bottom-*"` overlay
// option would only reposition the floating box, never unfloat it).
// Confirming with nothing selected proceeds with empty values, and empty
// means OMITTED on the create call — not empty arrays — on purpose: a
// supplied `issues: []` would take the S27/S31 update paths and rewrite a
// live checkout's record, while omitted keeps the invalid, duplicate,
// occupied and principal refusals byte-identical with no state change.
// Either step is SKIPPED silently (never blocking the creation) when its
// source is empty or unavailable — no open issues, `gh` missing or
// erroring, no odd documents, or a host with no custom UI — and Esc in
// either step keeps its existing meaning: it cancels the whole
// creation and changes nothing.
const WARP_CREATE_ISSUES_TITLE = "Select issues (optional)";
const WARP_CREATE_ODD_TITLE = "Select odd documents (optional)";

// Injectable seam for the open-issues fetch: tests inject a stub so no
// test ever spawns `gh`. Production leaves it null and the default
// below calls lib/warp-create-picker.js `fetchOpenIssues` exactly.
let warpCreateIssuesFetcher = null;

function setWarpCreateIssuesFetcher(fetcher) {
  warpCreateIssuesFetcher = fetcher;
}

// Injectable seam for the odd/tasks listing: tests inject a stub so no
// test ever touches the filesystem for this. Production leaves it null
// and the default below lists the CURRENT checkout's `odd/tasks/*.md`
// exactly (the branch the worktree will be born from).
let warpCreateOddLister = null;

function setWarpCreateOddLister(lister) {
  warpCreateOddLister = lister;
}

// Injectable seam for the multi-select interaction itself: tests inject
// a stub so no test ever opens a real prompt. Production leaves it null
// and the default below renders the shared component through the real
// `ctx.ui.custom` inline (no overlay options — S48). A seam answer of
// null/undefined (or `{ cancelled: true }`) is Esc: cancel the whole
// creation.
let warpCreatePicker = null;

function setWarpCreatePicker(picker) {
  warpCreatePicker = picker;
}

// Injectable seam for the warp-selector delete path (tests): production
// leaves it null and the delete flow calls the shared executeWorktreeClose
// directly — never a duplicated removal. Tests inject a stub to record
// the call without touching git or Herdr.
let warpCloseRunner = null;

function setWarpCloseRunner(runner) {
  warpCloseRunner = runner;
}

// Warp-selector delete eligibility: a checkout row is deletable only when
// it is a REGISTERED agent worktree of this project. The principal
// checkout (by resolved identity, never by name alone — a branch whose
// slug is also `principal` stays deletable) and the create row (never a
// checkout) are never deletable, and neither is a live checkout the
// registry does not own (close would refuse it). Identity is the
// consolidated checkoutState realpath with an absolute fallback, so a
// symlink spelling still matches its row. Never throws.
function warpDeletableAt(others, index, principal, read, repoRoot) {
  try {
    if (!Array.isArray(others) || typeof index !== "number" || index < 0 || index >= others.length) return false;
    const entry = others[index];
    if (!entry || typeof entry.path !== "string" || entry.path.length === 0) return false;
    if (principal && typeof principal.path === "string" && principal.path.length > 0) {
      const pst = checkoutState(principal.path, repoRoot);
      const pid = pst.real !== null ? pst.real : pst.absolute;
      const est = checkoutState(entry.path, repoRoot);
      const eid = est.real !== null ? est.real : est.absolute;
      if (pid !== null && eid !== null && pid === eid) return false;
    }
    const rows = read && Array.isArray(read.worktrees) ? read.worktrees : [];
    const want = checkoutState(entry.path, repoRoot);
    const wid = want.real !== null ? want.real : want.absolute;
    if (wid === null) return false;
    for (const row of rows) {
      if (!row || typeof row.path !== "string" || row.path.length === 0) continue;
      const rst = checkoutState(row.path, repoRoot);
      const rid = rst.real !== null ? rst.real : rst.absolute;
      if (rid !== null && rid === wid) return true;
    }
    return false;
  } catch {
    return false;
  }
}

// Run one multi-select panel. Each panel is STANDALONE (its own title,
// its own rows, its own footer — never cross-field chips/tabs/counters).
// Returns `{ cancelled: true }` on Esc, `{ back: true }` on Tab Back
// (the caller returns to the previous field with the kept values),
// `{ cancelled: false, selected }` on the explicit Confirm action
// (empty is valid), `{ cancelled: false, skipped: true, selected: [] }`
// when the host cannot render the step or its source is legitimately
// empty — then the caller proceeds with empty values instead of
// blocking the creation — or `{ failed: true, error }` when the picker
// itself cannot render (a broken import or a throwing host). A broken
// picker STOPS the creation with an actionable message: silently
// skipping it would create a checkout the user never confirmed the
// contents of. `initialSelected` restores the ids of an earlier pass so
// Back preserves them; `initialUiState` ({ query, page, cursor })
// restores the kept filter and position, and every resolution echoes
// the live `uiState` back for the next revisit.
async function runWarpCreatePick(ctx, { kind, title, searchPlaceholder, items, filterFn, initialSelected, initialUiState }) {
  if (typeof warpCreatePicker === "function") {
    try {
      const out = await warpCreatePicker(ctx, { kind, title, items, initialSelected, initialUiState });
      if (out === null || out === undefined) return { cancelled: true };
      if (out && out.cancelled === true) return { cancelled: true };
      if (out && out.back === true) return { back: true, selected: out.selected, uiState: out.uiState };
      if (out && Array.isArray(out.selected)) return { cancelled: false, selected: out.selected, uiState: out.uiState };
      return { failed: true, error: `warp: the ${kind} picker returned nothing usable; nothing was created.` };
    } catch (err) {
      return { failed: true, error: `warp: the ${kind} picker failed (${(err && err.message) || err}); nothing was created.` };
    }
  }
  if (!ctx || !ctx.ui || typeof ctx.ui.custom !== "function") {
    return { cancelled: false, skipped: true, selected: [] };
  }
  let helpers = null;
  try {
    helpers = await customizeTuiLoader();
  } catch {
    helpers = null;
  }
  let pickerLib = null;
  try {
    pickerLib = libRequire("warp-create-picker.js");
  } catch (err) {
    return { failed: true, error: `warp: the ${kind} picker cannot load (${(err && err.message) || err}); nothing was created.` };
  }
  if (!pickerLib || typeof pickerLib.createMultiSelect !== "function") {
    return { failed: true, error: `warp: the ${kind} picker cannot load; nothing was created.` };
  }
  let out;
  try {
    // S48: a single argument — NO `overlay: true`. Without it the host
    // takes the non-overlay path (editorContainer.clear + addChild +
    // focus, the exact container the `select`/`input` dialogs use), so
    // the picker sits inline above the editor instead of floating over
    // the transcript. Overlay anchors cannot do this: they only
    // reposition the floating box.
    out = await ctx.ui.custom(
      (hostTui, theme, _keybindings, done) => pickerLib.createMultiSelect({
        title,
        items,
        filterFn,
        searchPlaceholder,
        helpers,
        hostTui,
        theme,
        initialSelected,
        initialQuery: initialUiState && typeof initialUiState.query === "string" ? initialUiState.query : undefined,
        initialPage: initialUiState && Number.isInteger(initialUiState.page) ? initialUiState.page : undefined,
        initialCursor: initialUiState && Number.isInteger(initialUiState.cursor) ? initialUiState.cursor : undefined,
        rowsAvailable: () => {
          try {
            const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
            if (Number.isFinite(rows) && rows > 0) return rows;
          } catch {
            // A hostile host object never breaks the picker.
          }
          return 24;
        },
        done,
      }),
    );
  } catch (err) {
    // The host offered custom UI but rendering failed: STOP with an
    // actionable message, never silently skip a confirmation.
    return { failed: true, error: `warp: the ${kind} picker failed (${(err && err.message) || err}); nothing was created.` };
  }
  if (out === null || out === undefined) return { cancelled: true };
  if (out && out.back === true) return { back: true, selected: out.selected, uiState: out.uiState };
  if (out && Array.isArray(out.selected)) return { cancelled: false, selected: out.selected, uiState: out.uiState };
  return { failed: true, error: `warp: the ${kind} picker returned nothing usable; nothing was created.` };
}

// The S46 association panels fetched ONCE per wizard invocation (see the
// prefetch in warpCreateAndEnter): every revisit awaits the same cached
// promise, so going Back never refetches `gh` or relists the checkout.

// The S46 association panels, one function per panel so the wizard can
// walk Back iteratively: the issues panel (open issues through `gh`,
// fetched asynchronously with a bounded timeout so the wizard never
// blocks on the network) then the odd step (`odd/tasks/*.md` of the
// CURRENT checkout — the branch the worktree will be born from). Each
// returns `{ cancelled }` (Esc: the whole creation ends),
// `{ back: true }` (Tab Back: the caller re-opens the previous field
// with the kept values), `{ failed, error }` (the picker broke:
// STOP, never silently skip), `{ skipped: true, selected: [] }` (a
// legitimate silent skip: no open issues, `gh` missing or erroring, no
// odd documents, or a host with no custom UI), or
// `{ cancelled: false, selected }` on Confirm. `initialSelected`
// restores the ids of an earlier pass.
async function pickWarpCreateIssues(ctx, { initialSelected, initialUiState, issuesResult } = {}) {
  let pickerLib = null;
  try {
    pickerLib = libRequire("warp-create-picker.js");
  } catch (err) {
    return { failed: true, error: `warp: the issues picker cannot load (${(err && err.message) || err}); nothing was created.` };
  }
  // The prefetched result (one fetch per wizard invocation): skipped
  // silently when `gh` is missing, unauthenticated, errors, times out,
  // or reports no open issues.
  const fetched = issuesResult;
  if (!fetched || fetched.ok !== true || !Array.isArray(fetched.issues) || fetched.issues.length === 0) {
    return { cancelled: false, skipped: true, selected: [] };
  }
  const picked = await runWarpCreatePick(ctx, {
    kind: "issues",
    title: WARP_CREATE_ISSUES_TITLE,
    searchPlaceholder: "number or title",
    items: pickerLib.issuePickItems(fetched.issues),
    filterFn: pickerLib.filterIssueItems,
    initialSelected,
    initialUiState,
  });
  if (picked.cancelled) return { cancelled: true };
  if (picked.back) return { back: true, selected: picked.selected, uiState: picked.uiState };
  if (picked.failed) return { failed: true, error: picked.error };
  if (picked.skipped) return { cancelled: false, skipped: true, selected: [] };
  return { cancelled: false, selected: picked.selected.filter((n) => Number.isInteger(n)), uiState: picked.uiState };
}

async function pickWarpCreateOdd(ctx, { initialSelected, initialUiState, oddDocs } = {}) {
  let pickerLib = null;
  try {
    pickerLib = libRequire("warp-create-picker.js");
  } catch (err) {
    return { failed: true, error: `warp: the odd picker cannot load (${(err && err.message) || err}); nothing was created.` };
  }
  // The prefetched listing (one list per wizard invocation) of the
  // CURRENT checkout's documents; skipped silently when none.
  const docs = oddDocs;
  if (!Array.isArray(docs) || docs.length === 0) {
    return { cancelled: false, skipped: true, selected: [] };
  }
  const picked = await runWarpCreatePick(ctx, {
    kind: "odd",
    title: WARP_CREATE_ODD_TITLE,
    searchPlaceholder: "name",
    items: pickerLib.oddPickItems(docs),
    filterFn: pickerLib.filterOddItems,
    initialSelected,
    initialUiState,
  });
  if (picked.cancelled) return { cancelled: true };
  if (picked.back) return { back: true, selected: picked.selected, uiState: picked.uiState };
  if (picked.failed) return { failed: true, error: picked.error };
  if (picked.skipped) return { cancelled: false, skipped: true, selected: [] };
  return { cancelled: false, selected: picked.selected.filter((s) => typeof s === "string" && s.length > 0), uiState: picked.uiState };
}

async function warpCreateAndEnter(ctx, git, notify) {
  // The sequential wizard: type -> name -> issues -> odd -> creation.
  // Each field is a STANDALONE panel (its own title, its own rows, its
  // own footer — never shared chips/tabs/counters): one panel mounted
  // at a time, each ui call resolving before the next opens, the
  // previous panel disposed first. Tab Back returns to the previous
  // field with every kept value, while Esc at any field ends the whole
  // creation quietly. The loop is bounded by construction: Back always
  // moves to an earlier field and Confirm always moves forward. Nothing
  // mutates until the odd panel confirms: the creation (git checkout,
  // registry row) and the warp run exactly once, after all
  // confirmations — and after the session preflight below, so an
  // unavailable session refuses before any branch, checkout or registry
  // write.
  let type = null;
  let rawName = null;
  let issues = [];
  let odd = [];
  // Last-known per-panel state across revisits: confirmed AND
  // back-echoed selections plus the echoed filter/page/cursor, so a
  // return trip restores the exact pass the user left.
  let issuesSelected = null;
  let oddSelected = null;
  let issuesUi = null;
  let oddUi = null;
  // Prefetch ONCE per wizard invocation, while the type/name panels
  // hold the user: both promises start now, every revisit awaits the
  // same cached ones — going Back never refetches `gh` or relists the
  // checkout. Failures resolve to null and skip silently, exactly like
  // the per-open fetch did.
  const wizardCwd = toolCwd(ctx);
  let wizardRoot = wizardCwd;
  try {
    wizardRoot = git.repoIdentity(wizardCwd).root;
  } catch {
    wizardRoot = wizardCwd;
  }
  const issuesPromise = (async () => {
    try {
      if (typeof warpCreateIssuesFetcher === "function") {
        return await warpCreateIssuesFetcher(ctx, { cwd: wizardCwd });
      }
      let pickerLib = null;
      try {
        pickerLib = libRequire("warp-create-picker.js");
      } catch {
        return null;
      }
      return await pickerLib.fetchOpenIssuesAsync({ cwd: wizardCwd });
    } catch {
      return null;
    }
  })();
  const oddPromise = (async () => {
    try {
      if (typeof warpCreateOddLister === "function") {
        return await warpCreateOddLister(wizardRoot, ctx);
      }
      let pickerLib = null;
      try {
        pickerLib = libRequire("warp-create-picker.js");
      } catch {
        return null;
      }
      return pickerLib.listOddTaskDocs(wizardRoot);
    } catch {
      return null;
    }
  })();
  let step = "type";
  for (;;) {
    if (step === "type") {
      const typed = await askWarpCreateType(ctx, type);
      if (typed.back === true) return;
      if (!typed.ok) {
        notify?.("warp: the host UI cannot ask for a change type here; create one with the worktree_create tool first, then /herdr-gentle:warp <name>.", "error");
        return;
      }
      // Cancelling the type field changes nothing — no name panel, no
      // creation, no registry write, no notice, no warp. Tab Back is
      // the same quiet exit: the first field has nowhere earlier to go,
      // so Back there returns to the checkout selector.
      if (typed.value === undefined) return;
      const resolved = resolveWarpChangeType(typed.value);
      if (resolved === null) {
        notify?.(`warp: unknown change type ${JSON.stringify(typed.value)}; nothing was created.`, "error");
        return;
      }
      type = resolved;
      step = "name";
      continue;
    }
    if (step === "name") {
      const asked = await askWarpCreateName(ctx, rawName);
      if (asked.back === true) {
        // Tab Back from the name re-opens the type field; the kept name
        // stays for the next pass — including what the user had typed
        // but not yet confirmed — and the kept type restores the
        // cursor on the inline panel (the host-select fallback cannot
        // preserve a highlight — stated, not hidden).
        if (typeof asked.value === "string") rawName = asked.value;
        step = "type";
        continue;
      }
      if (!asked.ok) {
        notify?.("warp: the host UI cannot ask for a change name here (no text input); create one with the worktree_create tool first, then /herdr-gentle:warp <name>.", "error");
        return;
      }
      // Cancelling the name step changes nothing. Submitting empty
      // keeps the kept name when returning from a later step; on the
      // first pass an empty name refuses instead: the derived `<type>/`
      // branch could never satisfy the branch regex, and the create path
      // would never see the raw name, so the refusal names the name.
      if (asked.value === undefined) return;
      const trimmed = typeof asked.value === "string" ? asked.value.trim() : "";
      if (trimmed === "") {
        if (rawName !== null) {
          step = "issues";
          continue;
        }
        notify?.(`warp: invalid change name ${JSON.stringify(asked.value)}: use at least one letter or digit (for example "name-change"); nothing was created.`, "error");
        return;
      }
      // A name with no letter or digit slugs to nothing (the lib's
      // slugifier would silently fall back to `worktree`): refuse with
      // the same actionable message before the create path ever runs.
      if (!/[a-z0-9]/i.test(trimmed)) {
        notify?.(`warp: invalid change name ${JSON.stringify(trimmed)}: use at least one letter or digit (for example "name-change"); nothing was created.`, "error");
        return;
      }
      rawName = trimmed;
      step = "issues";
      continue;
    }
    if (step === "issues") {
      const branch = `${type}/${git.slugifyBranch(rawName)}`;
      if (!WARP_CREATE_BRANCH_RE.test(branch)) {
        notify?.(`warp: invalid change name ${JSON.stringify(rawName)}: use at least one letter or digit (for example "name-change"); nothing was created.`, "error");
        return;
      }
      const picked = await pickWarpCreateIssues(ctx, {
        initialSelected: issuesSelected !== null ? issuesSelected : issues,
        initialUiState: issuesUi,
        issuesResult: await issuesPromise,
      });
      if (picked.cancelled) return;
      if (picked.failed) {
        notify?.(picked.error, "error");
        return;
      }
      // Echoes (confirmed or backed-out selections, filter, page,
      // cursor) become the next revisit restore; only a confirmation
      // moves the creation payload forward.
      if (Array.isArray(picked.selected)) issuesSelected = picked.selected.slice();
      if (picked.uiState) issuesUi = picked.uiState;
      if (picked.back) {
        step = "name";
        continue;
      }
      if (!picked.skipped) issues = picked.selected;
      step = "odd";
      continue;
    }
    // field === "odd": Confirm leaves the loop into the deferred
    // creation below; Tab Back re-opens the issues panel with the kept
    // selections; empty confirmations stay omitted, so the create
    // path's refusals keep their exact shape.
    const picked = await pickWarpCreateOdd(ctx, {
      initialSelected: oddSelected !== null ? oddSelected : odd,
      initialUiState: oddUi,
      oddDocs: await oddPromise,
    });
    if (picked.cancelled) return;
    if (picked.failed) {
      notify?.(picked.error, "error");
      return;
    }
    if (Array.isArray(picked.selected)) oddSelected = picked.selected.slice();
    if (picked.uiState) oddUi = picked.uiState;
    if (picked.back) {
      step = "issues";
      continue;
    }
    if (!picked.skipped) odd = picked.selected;
    break;
  }
  // Session preflight BEFORE any mutation: an allocated-but-missing
  // session file with nothing in memory refuses here — before any
  // branch, checkout or registry write — instead of failing after the
  // worktree was created. A usable file, or valid in-memory entries
  // the carry path can clone, proceeds.
  const flight = warpCreatePreflight(ctx);
  if (!flight.ok) {
    notify?.(flight.reason, "error");
    return;
  }
  const branch = `${type}/${git.slugifyBranch(rawName)}`;
  const createParams = { branch };
  if (issues.length > 0) createParams.issues = issues.slice();
  if (odd.length > 0) createParams.odd = odd.slice();
  const createCtx = ctx && typeof ctx === "object" ? { ...ctx, hasUI: false } : ctx;
  // S53: the wizard creates through the git-only route — a plain git
  // checkout plus the registry row, never a Herdr workspace — reusing
  // the same creation path (validations, refusals, registration) with
  // the approval dialog suppressed (the type plus the typed name is
  // the human approval; forwarding the command context unchanged would
  // double-prompt). The layout is principal-anchored (S56): the new
  // checkout lands beside the PRINCIPAL checkout even when the wizard
  // runs inside a linked worktree, while the branch HEAD still comes
  // from the current checkout.
  const created = await executeWorktreeCreate(createParams, createCtx, { gitOnly: true, principalLayout: true });
  if (created && created.isError) {
    notify?.(created.text, "error");
    return;
  }
  const storedBranch = created && created.details && typeof created.details.branch === "string"
    ? created.details.branch
    : branch;
  // Warp by the slug the selector shows and `warp <name>` accepts (the
  // stored branch when the create returned an owned checkout instead).
  const warpName = slugOf(git, storedBranch) || branch;
  const out = await executeWorktreeWarp(warpName, ctx);
  // Same single-confirmation rule as every other warp path: success stays
  // silent (the card is the confirmation), only failures notify.
  if (out && out.isError) {
    notify?.(out.text, "error");
  }
}

// Warp selector loop with Ctrl+D delete (human selector). Returns
// undefined when the interaction resolved (warp, create, delete flow, or
// cancel) and "fallback" when the host custom UI is unusable so the
// caller falls through to the plain select path (no delete). Each
// iteration re-reads the registry and the live git listing fresh, so a
// delete never leaves a stale row on screen. The selector closes FIRST
// (ctx.ui.custom resolves) and only then does one explicit
// ctx.ui.confirm name the target and its absolute path; a refused
// confirmation reopens the selector with stable focus and zero
// git/fs/registry/workspace mutations, while acceptance reuses the
// shared executeWorktreeClose exactly once with hasUI:false (the Ctrl+D
// confirmation IS the approval, so no second prompt — tool semantics for
// dirty/unmerged/protected/foreign checkouts stay intact). Never touches
// the principal checkout or the create row.
async function runWarpSelectorLoop(ctx, git, registry, repo, fromCwd, notify) {
  let pickerLib = null;
  try {
    pickerLib = libRequire("warp-create-picker.js");
  } catch {
    return "fallback";
  }
  if (!pickerLib || typeof pickerLib.createSingleSelect !== "function") return "fallback";
  let helpers = null;
  try {
    helpers = await customizeTuiLoader();
  } catch {
    helpers = null;
  }
  // Stable focus across reopen: the option string to restore, or a
  // pending index clamped into the next listing (deleted rows shift up).
  let focusValue;
  let pendingFocusIndex = null;
  for (;;) {
    let freshRead;
    try {
      freshRead = registry.readRegistry(repo.root);
    } catch (err) {
      notify?.(`warp: cannot read worktree registry: ${(err && err.message) || err}`, "error");
      return undefined;
    }
    if (!freshRead.ok) {
      notify?.(`warp: cannot read worktree registry: ${freshRead.error}`, "error");
      return undefined;
    }
    let freshLive;
    try {
      freshLive = git.listWorktrees(repo.root);
    } catch (err) {
      notify?.(`warp: cannot list worktrees: ${(err && err.message) || err}`, "error");
      return undefined;
    }
    noteWarpDiscovery(repo.root, freshLive);
    const freshPrincipal = principalForName(git, repo.root, repo, freshLive);
    const freshOffered = warpOfferedCheckouts(git, freshRead, freshPrincipal, freshLive, repo.root);
    const freshActive = warpActiveIdentity(freshLive, repo.root, freshPrincipal, fromCwd);
    const freshOthers = freshOffered.filter((entry) => entry.path !== freshActive);
    if (freshOthers.length === 0) {
      // After a delete the last row may be gone: no further choices, no
      // extra notice — the delete success already notified.
      if (pendingFocusIndex !== null || focusValue !== undefined) return undefined;
      notify?.("warp: no other checkout to move the session to", "info");
      return undefined;
    }
    const freshCurrent = warpTitleEntry(git, freshOffered, freshLive, repo.root, freshActive, fromCwd);
    const freshTitle = `Warp session \u00B7 current: ${freshCurrent.name} ${freshCurrent.path}`;
    const freshOptions = [...freshOthers.map((entry) => `${entry.name} — ${entry.path}`), WARP_CREATE_ENTRY];
    if (pendingFocusIndex !== null) {
      const at = Math.min(Math.max(0, pendingFocusIndex), freshOthers.length - 1);
      focusValue = `${freshOthers[at].name} — ${freshOthers[at].path}`;
      pendingFocusIndex = null;
    }
    if (typeof focusValue === "string" && !freshOptions.includes(focusValue)) focusValue = undefined;
    const canDelete = (index) => warpDeletableAt(freshOthers, index, freshPrincipal, freshRead, repo.root);
    let out;
    try {
      out = await ctx.ui.custom(
        (hostTui, theme, _keybindings, done) => pickerLib.createSingleSelect({
          title: freshTitle,
          items: freshOptions,
          helpers,
          hostTui,
          theme,
          initialSelected: focusValue,
          confirmLabel: "warp",
          showTab: false,
          canDelete,
          rowsAvailable: () => {
            try {
              const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
              if (Number.isFinite(rows) && rows > 0) return rows;
            } catch {
              // A hostile host object never breaks the selector.
            }
            return 24;
          },
          done,
        }),
      );
    } catch {
      return "fallback";
    }
    if (out === null || out === undefined) return undefined;
    if (out && typeof out === "object" && out.back === true) return undefined;
    if (out && typeof out === "object" && out.delete === true) {
      const index = out.index;
      if (typeof index !== "number" || index < 0 || index >= freshOthers.length) {
        // Protected row (principal/create) or invalid: safe no-op, keep
        // focus where it is.
        focusValue = typeof out.value === "string" && freshOptions.includes(out.value) ? out.value : focusValue;
        continue;
      }
      if (!warpDeletableAt(freshOthers, index, freshPrincipal, freshRead, repo.root)) {
        focusValue = `${freshOthers[index].name} — ${freshOthers[index].path}`;
        continue;
      }
      const target = freshOthers[index];
      if (typeof ctx?.ui?.confirm !== "function") {
        notify?.("warp: the host UI cannot confirm worktree deletion here; nothing was deleted.", "error");
        focusValue = `${target.name} — ${target.path}`;
        continue;
      }
      // S61: the deletion confirmation always names the checkout's
      // pending changes when it has any (N files +N/-N through
      // lib/worktree-changes.js); a clean checkout omits the dirty
      // warning. This confirmation IS the targeted human approval: an
      // explicit Yes for a dirty row passes force:true deliberately to
      // the shared close for exactly that row (never the principal —
      // not deletable here — never protected/foreign, whose refusals
      // inside the close stay intact because they run before any
      // removal). A summary failure degrades to the plain confirmation.
      let deleteDirtyLine = '';
      let deleteIsDirty = false;
      try {
        const deleteChangesLib = libRequire('worktree-changes.js');
        const deleteSummary = await deleteChangesLib.summarizeChanges(target.path, { git });
        if (deleteSummary && deleteSummary.ok === true && deleteSummary.files > 0) {
          deleteIsDirty = true;
          deleteDirtyLine = ` Pending changes: ${deleteSummary.files} file${deleteSummary.files === 1 ? '' : 's'}, +${deleteSummary.added}/-${deleteSummary.deleted}.`;
        }
      } catch {
        deleteDirtyLine = '';
        deleteIsDirty = false;
      }
      let approved = false;
      try {
        approved = await ctx.ui.confirm(
          `Delete worktree '${target.name}'?`,
          `Delete worktree checkout at ${target.path} for branch '${target.branch}'? This removes the checkout but keeps the branch.` + deleteDirtyLine,
        );
      } catch {
        approved = false;
      }
      if (!approved) {
        focusValue = `${target.name} — ${target.path}`;
        continue;
      }
      const closeCtx = ctx && typeof ctx === "object" ? { ...ctx, hasUI: false } : ctx;
      const runner = typeof warpCloseRunner === "function" ? warpCloseRunner : executeWorktreeClose;
      // The explicit Yes above authorizes this row's pending changes:
      // force travels ONLY here, for exactly this approved target.
      const closeParams = deleteIsDirty ? { path: target.path, force: true } : { path: target.path };
      let closed;
      try {
        closed = await runner(closeParams, closeCtx);
      } catch (err) {
        notify?.(`warp: cannot delete worktree ${target.name}: ${(err && err.message) || err}`, "error");
        focusValue = `${target.name} — ${target.path}`;
        continue;
      }
      if (closed && closed.isError) {
        notify?.(closed.text, "error");
        focusValue = `${target.name} — ${target.path}`;
        continue;
      }
      if (closed && typeof closed.text === "string" && closed.text.length > 0) notify?.(closed.text, "info");
      pendingFocusIndex = Math.min(index, freshOthers.length - 2 >= 0 ? index : 0);
      focusValue = undefined;
      continue;
    }
    if (typeof out === "string") {
      if (out === WARP_CREATE_ENTRY) {
        await warpCreateAndEnter(ctx, git, notify);
        return undefined;
      }
      const chosen = freshOthers.find((entry) => `${entry.name} — ${entry.path}` === out);
      if (!chosen) {
        notify?.(`warp: unknown checkout selection ${JSON.stringify(out)}; nothing was moved.`, "error");
        return undefined;
      }
      const warpOut = await executeWorktreeWarp(chosen.name, ctx);
      if (warpOut.isError) notify?.(warpOut.text, "error");
      return undefined;
    }
    notify?.(`warp: unknown checkout selection ${JSON.stringify(out)}; nothing was moved.`, "error");
    return undefined;
  }
}

// Registered before any gate on purpose, exactly like the `worktree`
// toggle: the switch belongs to the Pi session, so it must exist even
// while the worktree tools themselves are unregistered. Hosts without
// commands simply skip it.
function registerWarpCommand(pi) {
  if (typeof pi?.registerCommand !== "function") return;
  pi.registerCommand("herdr-gentle:warp", {
    description: "Move this session to another checkout of the project: pick from a selector, or warp <name>",
    handler: async (args, ctx) => {
      const notify = ctx?.ui?.notify;
      const raw = String(args ?? "").trim();
      // An explicit name skips the selector: the scripted path, reusing
      // `executeWorktreeWarp` unchanged (its notifications, its cancelled
      // outcome, its OSC-7 behaviour).
      if (raw !== "") {
        const parts = raw.split(/\s+/).filter((part) => part.length > 0);
        if (parts.length !== 1) {
          notify?.("worktree warp needs exactly one name: use /herdr-gentle:warp <name> (the flattened branch slug, or principal).", "error");
          return;
        }
        const out = await executeWorktreeWarp(parts[0], ctx);
        // S20 + R1: a real move shows exactly ONE visible confirmation — the
        // styled warp card delivered to the switched-to session — so the
        // command stays silent on success. Already-there warps emit NOTHING
        // (R1: the session is already where it was asked to go); refusals
        // and cancellations send no card, so only failures still notify here.
        if (out.isError) {
          notify?.(out.text, "error");
        }
        return;
      }
      // No argument: offer the project's checkouts as a selector. The
      // listing is read fresh here (never cached): a checkout created or
      // closed since the session started still shows up correctly. Any
      // listing failure fails closed with an actionable message and
      // changes nothing — no selector, no switch.
      const git = libRequire("worktree-git.js");
      const registry = libRequire("worktree-registry.js");
      const fromCwd = typeof ctx?.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
      let repo;
      try {
        repo = git.repoIdentity(fromCwd);
      } catch (err) {
        notify?.(`warp: not a git repository: ${fromCwd}`, "error");
        return;
      }
      const read = registry.readRegistry(repo.root);
      if (!read.ok) {
        notify?.(`warp: cannot read worktree registry: ${read.error}`, "error");
        return;
      }
      let live;
      try {
        live = git.listWorktrees(repo.root);
      } catch (err) {
        notify?.(`warp: cannot list worktrees: ${(err && err.message) || err}`, "error");
        return;
      }
      // S14: this fresh scan is the warp-time discovery refresh.
      noteWarpDiscovery(repo.root, live);
      // Ctrl+D delete: the inline custom selector (the same standalone
      // single-select pattern as the create wizard, smallest extension)
      // supports Ctrl+D on a focused ELIGIBLE worktree row when the host
      // offers ctx.ui.custom. The selector closes FIRST, then one explicit
      // ctx.ui.confirm names the target and its absolute path; cancel/Esc
      // reopens the selector with stable focus and zero mutations, while
      // acceptance reuses the shared executeWorktreeClose exactly once
      // (second approval suppressed deliberately — the Ctrl+D confirmation
      // IS the human approval — never globally disabled). Principal and
      // create rows are never deletable (safe no-op). Enter still warps,
      // Esc still cancels, create stays last, and the listing refreshes
      // before further choices so no stale row survives.
      const useCustomWarp = ctx && ctx.ui && typeof ctx.ui.custom === "function";
      if (useCustomWarp) {
        const handled = await runWarpSelectorLoop(ctx, git, registry, repo, fromCwd, notify);
        if (handled !== "fallback") return;
        // "fallback": the host custom UI is unusable here — fall through
        // to the plain select path below (no delete affordance), unchanged.
      }
      const principal = principalForName(git, repo.root, repo, live);
      const offered = warpOfferedCheckouts(git, read, principal, live, repo.root);
      const active = warpActiveIdentity(live, repo.root, principal, fromCwd);
      // The active checkout is never an option: it stays out of the list
      // and travels in the title as text instead.
      const others = offered.filter((entry) => entry.path !== active);
      if (others.length === 0) {
        notify?.("warp: no other checkout to move the session to", "info");
        return;
      }
      // The host `select` primitive has no non-selectable rows, so the
      // active checkout travels in the title and `Esc`/undefined is the
      // cancel path. S44/S45 appends the create entry last: it is visually
      // distinct from the checkout rows and never collides with one;
      // S45 asks the change type first, then the change name.
      const current = warpTitleEntry(git, offered, live, repo.root, active, fromCwd);
      const title = `Warp session · current: ${current.name} ${current.path}`;
      const options = [...others.map((entry) => `${entry.name} — ${entry.path}`), WARP_CREATE_ENTRY];
      if (typeof ctx?.ui?.select !== "function") {
        notify?.("warp: the host UI cannot open a checkout selector here; pass a name instead: /herdr-gentle:warp <name>.", "error");
        return;
      }
      let picked;
      try {
        picked = await ctx.ui.select(title, options);
      } catch {
        picked = undefined;
      }
      // `Esc` cancels silently: no notification, no write, no switch.
      if (picked === undefined) return;
      // S45: the final entry runs the two-step create (type, then name)
      // through the existing create path, then warps the session into
      // the new checkout.
      if (picked === WARP_CREATE_ENTRY) {
        await warpCreateAndEnter(ctx, git, notify);
        return;
      }
      const chosen = others.find((entry) => `${entry.name} — ${entry.path}` === picked);
      if (!chosen) {
        notify?.(`warp: unknown checkout selection ${JSON.stringify(picked)}; nothing was moved.`, "error");
        return;
      }
      const out = await executeWorktreeWarp(chosen.name, ctx);
      // S20 + R1: same single-confirmation rule as the explicit path above:
      // success stays silent (the card is the confirmation), already-there
      // stays silent, only failures notify.
      if (out.isError) {
        notify?.(out.text, "error");
      }
    },
  });
}

// `/herdr-gentle:customize` panel (customize-command T1: S1, S2, S3, S5,
// S6, S10, S12).
//
// One panel for the three toggles (sidebar, moshi, worktree): no argument
// opens the two-pane view through ctx.ui.custom with the exact overlay
// options S2 pins; `customize status` keeps the read-only reporting as one
// terse line per switch and writes nothing. The sidebar and moshi actions
// stay inline in extensions/gentle-herdr-state.ts and are reached through
// the single in-process provider slot below — nothing is reimplemented or
// extracted here. The worktree switch writes the mode file through
// libRequire("worktree-mode.js") (the same shared mode file the removed
// `/herdr-gentle:worktree` mode command wrote).
//
// S10: @earendil-works/pi-tui is resolved LAZILY inside the handler
// through the injectable customizeTuiLoader seam (tests inject a stub;
// production defaults to a lazy import), never a top-level import — a
// top-level import would force a stub line into twelve test loaders. When
// the helpers cannot be loaded, or ctx.ui.custom is missing, the command
// falls back to the plain ctx.ui.select menu (category, then value) and
// says nothing about /reload. No string anywhere asks the user to run
// /reload (S5): the notification says what changed and the command
// reloads itself when the change reported needsReload.
// ---------------------------------------------------------------------------

// Injectable seam for the TUI helpers: defaults to the lazy import so no
// test loader needs a new stub line. Tests replace it per load.
let customizeTuiLoader = () => import("@earendil-works/pi-tui");

function setCustomizeTuiLoader(loader) {
  customizeTuiLoader = loader;
}

const CUSTOMIZE_CATEGORIES = [
  {
    id: "sidebar",
    title: "Agentes sidebar",
    rows: [
      { id: "gentle", label: "Gentle (this extension)", detail: "publishes agent state and SessionChanges from Gentle" },
      { id: "native", label: "Native Herdr", detail: "hands the pane back to Herdr's own agent state" },
    ],
  },
  {
    id: "moshi",
    title: "Moshi notifications",
    rows: [
      { id: "on", label: "On", detail: "notifies ask and finish episodes through Moshi" },
      { id: "off", label: "Off", detail: "leaves notifications to the host" },
    ],
  },
  {
    id: "worktree",
    title: "Worktree tools",
    rows: [
      { id: "enabled", label: "Enabled", detail: "agents can create, list, close, warp between and open sessions in agent worktrees" },
      { id: "disabled", label: "Disabled", detail: "the worktree tools are not registered" },
    ],
  },
];

function customizeReadSlot() {
  try {
    const slot = globalThis[Symbol.for("herdr-gentle.customize.v1")];
    if (slot && typeof slot === "object") return slot;
  } catch {
    // A hostile globalThis never breaks the command: fail closed below.
  }
  return null;
}

function customizeProviderValue(slot, name, ids) {
  try {
    const provider = slot ? slot[name] : null;
    if (!provider || typeof provider !== "object") return { available: false, active: null };
    if (typeof provider.read !== "function" || typeof provider.apply !== "function") {
      return { available: false, active: null };
    }
    const value = provider.read();
    if (!ids.includes(value)) return { available: false, active: null };
    return { available: true, active: value };
  } catch {
    return { available: false, active: null };
  }
}

function customizeWorktreeValue() {
  try {
    return libRequire("worktree-mode.js").readMode().enabled === true ? "enabled" : "disabled";
  } catch {
    return "disabled";
  }
}

function customizePanelModel() {
  const slot = customizeReadSlot();
  const sidebar = customizeProviderValue(slot, "sidebar", ["gentle", "native"]);
  const moshi = customizeProviderValue(slot, "moshi", ["on", "off"]);
  const worktreeActive = customizeWorktreeValue();
  const byId = (id) => CUSTOMIZE_CATEGORIES.find((entry) => entry.id === id);
  return [
    { ...byId("sidebar"), available: sidebar.available, active: sidebar.active },
    { ...byId("moshi"), available: moshi.available, active: moshi.active },
    { ...byId("worktree"), available: true, active: worktreeActive },
  ];
}

function customizeKeyMatches(helpers, key, names) {
  for (const name of names) {
    try {
      if (helpers && typeof helpers.matchesKey === "function" && helpers.matchesKey(key, name)) return true;
    } catch {
      // A throwing matcher never matches; the string fallback below decides.
    }
  }
  const text = typeof key === "string" ? key : (key && (key.name || key.key)) || "";
  const lower = String(text).toLowerCase();
  return names.some((name) => lower === String(name).toLowerCase());
}

// Kitty key-release guard (gentle-shell guards the same way): an event the
// helper module classifies as a key release must change nothing. Without
// the helper there is nothing to guard on.
function customizeIsKeyRelease(helpers, data) {
  try {
    if (helpers && typeof helpers.isKeyRelease === "function") return helpers.isKeyRelease(data) === true;
  } catch {
    // A throwing classifier never releases; fall through to normal handling.
  }
  return false;
}

function customizeTruncate(helpers, text, width) {
  try {
    if (helpers && typeof helpers.truncateToWidth === "function") return helpers.truncateToWidth(text, width);
  } catch {
    // Fall through to the plain slice.
  }
  const chars = [...String(text)];
  return chars.length > width ? chars.slice(0, width).join("") : String(text);
}

// The host component contract (pi-coding-agent
// examples/extensions/overlay-qa-tests.ts plus
// dist/core/extensions/types.d.ts `custom`): the factory receives
// (hostTui, theme, keybindings, done) and returns
// { render(width), handleInput(data), invalidate() }. Selection keys only
// move local state and ask the host to repaint through
// hostTui.requestRender(); Esc finishes with done(null) and Enter with
// done({categoryId, valueId}) — done() resolves ctx.ui.custom() and
// disposes the overlay. handleInput therefore never writes state,
// notifies, or reloads: the single apply path runs after custom()
// resolves (S6 ordering: the panel is gone before any notification or
// runtime rebuild).
//
// Two-pane card geometry (T5/S2), following the gentle-shell
// visual-customize-view + command-palette pair without importing it:
// one bordered card (CARD_PADDING 4), title row with esc right-aligned,
// CATEGORIES left of a vertical divider with the focused category's
// label-only values right of it, a preview section naming the focused
// choice plus its description, and the footer. Terminals under 60 columns fall back to a single
// navigable pane; short terminals clip by rowsAvailable. Copy stays the
// S2-fixed strings; only layout is new.
const CUSTOMIZE_CARD_PADDING = 4;
const CUSTOMIZE_NARROW_WIDTH = 60;
const CUSTOMIZE_MAX_HEIGHT = 24;

function customizeStripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b\]8;;.*?\x07/g, "");
}

function customizeMeasure(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === "function") return helpers.visibleWidth(text);
  } catch {
    // Fall through to the codepoint count.
  }
  return [...customizeStripAnsi(text)].length;
}

function customizeFit(helpers, text, width, ellipsis = "…") {
  const clean = String(text).split("\n")[0] ?? "";
  if (customizeMeasure(helpers, clean) <= width) return clean;
  try {
    if (helpers && typeof helpers.truncateToWidth === "function") {
      return helpers.truncateToWidth(clean, width, ellipsis);
    }
  } catch {
    // Fall through to the plain slice.
  }
  const chars = [...clean];
  return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join("") + ellipsis : clean;
}

function customizePaint(helpers, theme, role, text, size) {
  const clipped = customizeFit(helpers, text, Math.max(0, size));
  const padded = clipped + " ".repeat(Math.max(0, size - customizeMeasure(helpers, clipped)));
  try {
    if (theme && typeof theme.fg === "function") return theme.fg(role, padded);
  } catch {
    // A hostile theme never breaks the panel.
  }
  return padded;
}

// Focused-row selection (the palette's renderPaletteSelection pattern):
// a full-width bar when the injected theme paints backgrounds, else an
// accent ▸ marker — never a hardcoded escape.
function customizeSelect(helpers, theme, label, size, focused) {
  const safe = String(label).split("\n")[0] ?? "";
  if (focused && theme && typeof theme.bg === "function") {
    try {
      const row = customizeFit(helpers, `  ${safe}`, Math.max(0, size));
      return theme.bg("selectedBg", row + " ".repeat(Math.max(0, size - customizeMeasure(helpers, row))));
    } catch {
      // Fall through to the marker form below.
    }
  }
  let prefix = "  ";
  if (focused) {
    try {
      prefix = theme && typeof theme.fg === "function" ? theme.fg("accent", "▸ ") : "▸ ";
    } catch {
      prefix = "▸ ";
    }
  }
  return prefix + customizeFit(helpers, safe, Math.max(0, size - 2));
}

function customizeCard(helpers, theme, lines, width) {
  const innerWidth = Math.max(1, width - CUSTOMIZE_CARD_PADDING);
  let border = (text) => text;
  try {
    if (theme && typeof theme.fg === "function") border = (text) => theme.fg("border", text);
  } catch {
    border = (text) => text;
  }
  const horizontal = "─".repeat(innerWidth + 2);
  return [
    border(`╭${horizontal}╮`),
    ...lines.map((content) => {
      const wide = customizeMeasure(helpers, content);
      const fitted = wide > innerWidth
        ? customizeFit(helpers, content, innerWidth)
        : content + " ".repeat(innerWidth - wide);
      return `${border("│")} ${fitted} ${border("│")}`;
    }),
    border(`╰${horizontal}╯`),
  ];
}

function createCustomizePanel({ helpers, hostTui, theme, rowsAvailable, model, done }) {
  const state = {
    pane: "categories",
    cat: 0,
    row: model.map((category) => {
      const at = category.rows.findIndex((row) => row.id === category.active);
      return at >= 0 ? at : 0;
    }),
  };
  function availableRows() {
    try {
      if (typeof rowsAvailable === "function") {
        const rows = Math.floor(rowsAvailable());
        if (Number.isFinite(rows) && rows > 0) return Math.min(CUSTOMIZE_MAX_HEIGHT, rows);
      }
    } catch {
      // A hostile rows source never breaks the panel.
    }
    return CUSTOMIZE_MAX_HEIGHT;
  }
  function focused() {
    const category = model[state.cat];
    return { category, row: category.rows[state.row[state.cat]] || null };
  }
  function render(width) {
    const w = typeof width === "number" && Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    if (!height) return [];
    const title = "Customize · Herdr Gentle Shell";
    // A card needs two border rows. At extreme dimensions keep a
    // read-only heading rather than activatable invisible controls.
    if (w < CUSTOMIZE_CARD_PADDING + 1 || height < 4) {
      return [title, "Enlarge terminal"].slice(0, Math.min(height, 2))
        .map((line) => customizeFit(helpers, line, w, ""));
    }
    const inner = w - CUSTOMIZE_CARD_PADDING;
    const narrow = w < CUSTOMIZE_NARROW_WIDTH;
    const navOnly = narrow && state.pane === "categories" && model.length > 1;
    // The left column fits the S2-fixed category titles plus the focus
    // prefix: truncating a category name is never acceptable, detail
    // lines on the right may clip instead. Unavailability reads in the
    // right pane's note, not as a squeezed left suffix.
    const leftNeed = model.reduce(
      (need, entry) => Math.max(need, 2 + customizeMeasure(helpers, entry.title)),
      0,
    );
    const leftWidth = narrow ? 0 : Math.min(24, Math.max(leftNeed, Math.floor(inner * 0.28)));
    const rightWidth = inner - leftWidth - (leftWidth ? 3 : 0);
    const category = model[state.cat];
    const rows = category.rows;
    const previewLines = height >= 11 ? 3 : height >= 8 ? 1 : 0;
    const showHeading = height >= 6;
    // Right pane: LABELS ONLY (gentle-shell visual-customize-view
    // style) — each choice's S2 detail lives exactly once in the
    // preview block below, never under the rows. Then the unavailable
    // note when the provider slot is missing or malformed.
    const rightLines = [];
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      // S2 pins → on the active value; focus adds its own ▸ beside it
      // (▸ → Label) so the two states never mask each other.
      const focusedValue = !navOnly && state.pane === "values" && index === state.row[state.cat];
      rightLines.push({
        label: `${row.id === category.active ? "→ " : "  "}${row.label}`,
        focused: focusedValue,
      });
    }
    if (!category.available) {
      rightLines.push({ label: "(unavailable in this session)", mark: "    ", focused: false, muted: true });
    }
    const contentHeight = Math.max(1, height - 2 - 1 - (showHeading ? 1 : 0) - previewLines - (showHeading ? 1 : 0));
    const position = navOnly ? state.cat : state.row[state.cat];
    const listLength = navOnly ? model.length : rightLines.length;
    const start = Math.min(Math.max(0, position - contentHeight + 1), Math.max(0, listLength - contentHeight));
    const navStart = Math.min(Math.max(0, state.cat - contentHeight + 1), Math.max(0, model.length - contentHeight));
    const paint = (text, size, role = "text") => customizePaint(helpers, theme, role, text, size);
    let divider = "│";
    try {
      divider = theme && typeof theme.fg === "function" ? theme.fg("border", "│") : "│";
    } catch {
      divider = "│";
    }
    const join = (left, right) => leftWidth
      ? `${left}${" ".repeat(Math.max(0, leftWidth - customizeMeasure(helpers, left)))} ${divider} ${right}`
      : right;
    const lines = [];
    // Title row doubles as the esc hint: same row, right-aligned.
    const escGap = Math.max(1, inner - customizeMeasure(helpers, title) - 3);
    lines.push(paint(`${title}${" ".repeat(escGap)}esc`, inner, "accent"));
    if (showHeading) {
      const heading = navOnly
        ? "Categories · choose a category →"
        : `${category.title} · ${rows.length ? `${state.row[state.cat] + 1}/${rows.length}` : "empty"}`;
      lines.push(join(
        leftWidth ? paint("CATEGORIES", leftWidth, "accent") : "",
        paint(heading, rightWidth, "accent"),
      ));
    }
    for (let i = 0; i < contentHeight; i += 1) {
      const nav = model[navStart + i];
      const left = nav
        ? customizeSelect(helpers, theme, nav.title, leftWidth, navOnly || (navStart + i === state.cat && state.pane === "categories"))
        : "";
      const item = navOnly ? (model[start + i] || null) : (rightLines[start + i] || null);
      let right = "";
      if (item) {
        // Labels sit under a 4-column mark gutter (▸/→): the stored
        // label already carries its → mark, focus adds ▸ in front and
        // the rest pad two spaces. Detail lines indent into the same
        // gutter so each choice reads as one block.
        let cell = "";
        if (navOnly) {
          cell = customizeSelect(helpers, theme, item.title, rightWidth, start + i === position);
        } else if (item.muted) {
          cell = paint(`    ${item.label}`, rightWidth, "muted");
        } else if (item.focused) {
          cell = customizeSelect(helpers, theme, item.label, rightWidth, true);
        } else {
          cell = paint(`  ${item.label}`, rightWidth, "text");
        }
        right = cell;
      } else if (!navOnly && rightLines.length === 0) {
        right = paint("No settings available", rightWidth, "muted");
      }
      lines.push(join(left, right));
    }
    // Bottom block (gentle-shell style): the FOCUSED choice's label in
    // the title plus its S2 description on the next line — exactly
    // once. The redundant Active: repeat is gone on purpose.
    const current = focused();
    const previewTitle = `Preview · ${current.row ? current.row.label : current.category.title}`;
    const previewSample = current.row ? current.row.detail : "unavailable";
    if (previewLines === 3) {
      lines.push("");
      lines.push(paint(previewTitle, inner, "accent"));
      lines.push(paint(previewSample, inner, "muted"));
    } else if (previewLines === 1) {
      lines.push(paint(previewTitle, inner, "muted"));
    }
    if (showHeading) {
      lines.push(paint("←/→ or Tab panes · ↑/↓ move · Enter apply · Esc close", inner, "muted"));
    }
    return customizeCard(helpers, theme, lines.slice(0, Math.max(0, height - 2)), w);
  }
  function requestPaint() {
    try {
      if (hostTui && typeof hostTui.requestRender === "function") hostTui.requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }
  function handleInput(data) {
    if (customizeIsKeyRelease(helpers, data)) return;
    if (customizeKeyMatches(helpers, data, ["escape", "ctrl+c"])) {
      done(null);
      return;
    }
    if (customizeKeyMatches(helpers, data, ["left", "right", "tab"])) {
      state.pane = state.pane === "categories" ? "values" : "categories";
      requestPaint();
      return;
    }
    if (customizeKeyMatches(helpers, data, ["up"])) {
      if (state.pane === "categories") state.cat = (state.cat + model.length - 1) % model.length;
      else {
        const count = model[state.cat].rows.length;
        state.row[state.cat] = (state.row[state.cat] + count - 1) % count;
      }
      requestPaint();
      return;
    }
    if (customizeKeyMatches(helpers, data, ["down"])) {
      if (state.pane === "categories") state.cat = (state.cat + 1) % model.length;
      else {
        const count = model[state.cat].rows.length;
        state.row[state.cat] = (state.row[state.cat] + 1) % count;
      }
      requestPaint();
      return;
    }
    if (customizeKeyMatches(helpers, data, ["enter", "return"])) {
      const current = focused();
      done({ categoryId: current.category.id, valueId: current.row ? current.row.id : null });
      return;
    }
  }
  function invalidate() {}
  return { render, handleInput, invalidate, state };
}

// One shared apply path for the panel and the fallback menu. Returns the
// verdict; notifies exactly once (providers run against a capturing ctx
// so an inline notify never double-posts) and reloads only when the
// change reported needsReload.
async function applyCustomizeChoice(categoryId, valueId, ctx, toolsRegistered) {
  const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
  const category = CUSTOMIZE_CATEGORIES.find((entry) => entry.id === categoryId);
  const title = category ? category.title : String(categoryId);
  if (categoryId === "worktree") {
    const enabled = valueId === "enabled";
    const mode = libRequire("worktree-mode.js");
    try {
      mode.writeMode(enabled, process.env);
    } catch (err) {
      if (typeof notify === "function") notify(`Could not write ${mode.modePath(process.env)}: ${(err && err.message) || err}; nothing was changed.`, "error");
      return { changed: false, needsReload: false };
    }
    // S6: reload only when the runtime's registration must change, i.e.
    // enabling while the runtime loaded disabled or vice versa.
    const needsReload = enabled !== toolsRegistered;
    if (typeof notify === "function") {
      notify(`Worktree tools ${enabled ? "enabled" : "disabled"}.${needsReload ? " Reloading now to apply the change." : ""}`, "info");
    }
    if (needsReload && ctx && typeof ctx.reload === "function") await ctx.reload();
    return { changed: true, needsReload };
  }
  const slot = customizeReadSlot();
  const provider = slot ? slot[categoryId] : null;
  if (!provider || typeof provider !== "object" || typeof provider.apply !== "function") {
    if (typeof notify === "function") notify(`${title} is unavailable in this session; nothing was changed.`, "info");
    return { changed: false, needsReload: false };
  }
  const seen = [];
  const capture = ctx && typeof ctx === "object"
    ? { ...ctx, ui: { ...((ctx.ui) ?? {}), notify: (message, level) => { seen.push([message, level]); } } }
    : ctx;
  let result = null;
  try {
    result = await provider.apply(valueId, capture);
  } catch (err) {
    result = { changed: false, needsReload: false, text: `Could not update ${title}: ${(err && err.message) || err}; nothing was changed.` };
  }
  if (!result || typeof result !== "object") {
    result = { changed: false, needsReload: false, text: `${title}: the provider returned no verdict; nothing was changed.` };
  }
  const text = typeof result.text === "string" && result.text.length > 0
    ? result.text
    : (seen.length > 0 ? String(seen[seen.length - 1][0]) : `${title} updated.`);
  const needsReload = result.needsReload === true;
  if (typeof notify === "function") {
    notify(`${text}${needsReload ? " Reloading now to apply the change." : ""}`, "info");
  }
  if (needsReload && ctx && typeof ctx.reload === "function") await ctx.reload();
  return { changed: result.changed === true, needsReload };
}

async function runCustomizeFallback(ctx, toolsRegistered) {
  const select = ctx && ctx.ui ? ctx.ui.select : undefined;
  if (typeof select !== "function") return;
  const model = customizePanelModel();
  let picked = null;
  try {
    picked = await select("Customize · Herdr Gentle Shell", model.map((category) => category.title));
  } catch {
    picked = undefined;
  }
  if (picked === undefined || picked === null) return;
  const category = model.find((entry) => entry.title === picked);
  if (!category) return;
  if (!category.available) {
    if (ctx && ctx.ui && typeof ctx.ui.notify === "function") {
      ctx.ui.notify(`${category.title} is unavailable in this session; nothing was changed.`, "info");
    }
    return;
  }
  let choice = null;
  try {
    choice = await select(category.title, category.rows.map((row) => row.label));
  } catch {
    choice = undefined;
  }
  if (choice === undefined || choice === null) return;
  const row = category.rows.find((entry) => entry.label === choice);
  if (!row) return;
  await applyCustomizeChoice(category.id, row.id, ctx, toolsRegistered);
}

async function executeCustomize(rawArgs, ctx, toolsRegistered) {
  const notify = ctx && ctx.ui ? ctx.ui.notify : undefined;
  const raw = String(rawArgs ?? "").trim();
  const parts = raw.split(/\s+/).filter((part) => part.length > 0);
  const head = (parts[0] || "").toLowerCase();
  if (head === "status") {
    // S12: one terse line per switch, pinned for headless use. Writes nothing.
    const slot = customizeReadSlot();
    const sidebar = customizeProviderValue(slot, "sidebar", ["gentle", "native"]);
    const moshi = customizeProviderValue(slot, "moshi", ["on", "off"]);
    const worktree = customizeWorktreeValue();
    if (typeof notify === "function") {
      notify(`customize status: sidebar=${sidebar.available ? sidebar.active : "unknown"} moshi=${moshi.available ? moshi.active : "unknown"} worktree=${worktree}`, "info");
    }
    return;
  }
  if (head !== "") {
    if (typeof notify === "function") notify(`Unknown option "${raw}". Use /herdr-gentle:customize or /herdr-gentle:customize status.`, "error");
    return;
  }
  // `helpers` is the lazily loaded pi-tui module (measurement and key
  // matching through the injectable seam); `hostTui` is the live host
  // object from the factory arguments, used only for requestRender().
  let helpers = null;
  try {
    helpers = await customizeTuiLoader();
  } catch {
    helpers = null;
  }
  if (helpers && ctx && ctx.ui && typeof ctx.ui.custom === "function") {
    const model = customizePanelModel();
    let choice = null;
    try {
      choice = await ctx.ui.custom(
        // Theme and terminal rows travel through the real factory
        // arguments: the card paints with the host theme and clips to
        // the live terminal height, exactly like the reference view.
        (hostTui, theme, _keybindings, done) => createCustomizePanel({
          helpers,
          hostTui,
          theme,
          rowsAvailable: () => {
            try {
              const rows = hostTui && hostTui.terminal ? hostTui.terminal.rows : undefined;
              if (Number.isFinite(rows) && rows > 0) return rows;
            } catch {
              // A hostile host object never breaks the panel.
            }
            return CUSTOMIZE_MAX_HEIGHT;
          },
          model,
          done,
        }),
        {
          overlay: true,
          overlayOptions: { anchor: "center", width: "70%", minWidth: 60, maxHeight: "85%" },
        },
      );
    } catch {
      // A host that rejects the overlay degrades to the menu below.
      await runCustomizeFallback(ctx, toolsRegistered);
      return;
    }
    // Esc (null) does nothing at all: no notification, no write, no
    // reload. Anything else runs the single apply path once the overlay
    // is disposed and the interaction is over (S6 ordering).
    if (!choice || typeof choice !== "object") return;
    await applyCustomizeChoice(choice.categoryId, choice.valueId, ctx, toolsRegistered);
    return;
  }
  await runCustomizeFallback(ctx, toolsRegistered);
}

function registerCustomizeCommand(pi, toolsRegistered) {
  if (typeof pi?.registerCommand !== "function") return;
  pi.registerCommand("herdr-gentle:customize", {
    description: "Customize Herdr Gentle Shell in one panel: agent sidebar, Moshi notifications and worktree tools",
    handler: async (args, ctx) => {
      await executeCustomize(args, ctx, toolsRegistered);
    },
  });
}

export default function (pi) {
  // The S26 delivery route: watchers started by `worktree_session_open`
  // notify through this host object.
  sessionNotifyPi = pi;
  // Load-time gate (D9): missing means enabled, malformed never enables.
  // The customize panel always stays registered so the mode can be
  // flipped back; the current registration state feeds its worktree rows
  // and `customize status` (mode state, what is active, whether a reload
  // is needed).
  let toolsRegistered = false;
  try {
    toolsRegistered = libRequire("worktree-mode.js").readMode().enabled === true;
  } catch {
    toolsRegistered = false;
  }
  registerWarpCommand(pi);
  registerWarpMessageRenderer(pi);
  registerCustomizeCommand(pi, toolsRegistered);
  if (toolsRegistered) {
    pi.registerTool(worktreeCreateTool);
    pi.registerTool(worktreeListTool);
    pi.registerTool(worktreeCloseTool);
    pi.registerTool(worktreeSessionOpenTool);
    pi.registerTool(worktreeWarpTool);
  }
  // Automatic odd/ capture (S5, D7): observe the tool pipeline for the
  // read/edit/write tools. Guarded so hosts (and the older unit-test
  // doubles) without `pi.on` still load the tools above.
  if (typeof pi?.on === "function") {
    pi.on("tool_call", handleWorktreeOddEvent);
    pi.on("tool_result", handleWorktreeOddEvent);
    // S28: enumerate EVERY repository worktree through git at startup
    // and register the missing ones — all registered worktrees, not
    // only those under the creation path (that path is only where new
    // ones are born). Best-effort: never writes user config, never
    // throws, never blocks the session; the principal checkout is never
    // registered here (S31: its record is created on demand by an
    // explicit edit).
    pi.on("session_start", (event, ctx) => {
      try {
        const cwd = ctx && typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd
          : event && typeof event.cwd === "string" && event.cwd.length > 0 ? event.cwd
          : process.cwd();
        const scanned = scanLiveCheckouts(cwd);
        if (scanned !== null) {
          noteWarpDiscovery(scanned.repo.root, scanned.live);
          try {
            const registry = libRequire("worktree-registry.js");
            let principalId = null;
            try {
              if (typeof scanned.repo.commonDir === "string" && path.basename(scanned.repo.commonDir) === ".git") {
                const rawPrincipal = path.resolve(path.dirname(scanned.repo.commonDir));
                const pst = checkoutState(rawPrincipal, scanned.repo.root);
                principalId = pst.real !== null ? pst.real : pst.absolute;
              }
            } catch {
              principalId = null;
            }
            if (typeof registry.registerMissingWorktrees === "function") {
              registry.registerMissingWorktrees(scanned.repo.root, scanned.live, principalId);
            }
          } catch {
            // Discovery registration is best-effort: the warp cache above
            // already recorded the scan.
          }
        }
      } catch {
        // Discovery must never break startup.
      }
    });
    // S22: compare the installed `herdr-gentle-shell` Herdr plugin
    // against the version this package ships, once per session.
    // Best-effort and read-only: an absent Herdr CLI or unreadable
    // metadata fails silent inside the check itself — never throws,
    // never blocks the session, never writes config, never repeats
    // the alert, and never mentions /reload.
    pi.on("session_start", (event, ctx) => {
      try {
        const check = libRequire("herdr-plugin-check.js");
        const notify = ctx && ctx.ui && typeof ctx.ui.notify === "function"
          ? (text) => ctx.ui.notify(text, "info")
          : null;
        check.checkAndNotifyHerdrPlugin({ env: process.env, notify });
      } catch {
        // The plugin check must never break startup.
      }
    });
  }
}

export { executeWorktreeCreate, executeWorktreeList, executeWorktreeClose, resolveThread, executeWorktreeWarp, executeWorktreeWarpTool, emitOsc7, executeWorktreeSessionOpen, startAgentSessionWatcher, clearSessionWatchers, setCustomizeTuiLoader, setWorktreeCardHelpers, setWarpCreateNameAsker, setWarpCreateTypeAsker, setWarpCreateIssuesFetcher, setWarpCreateOddLister, setWarpCreatePicker, setWarpCloseRunner, setWarpDirtyAsker, warpCreatePreflight, warpForkSourceUsable };
