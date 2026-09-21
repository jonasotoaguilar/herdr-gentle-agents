// gentle-herdr-state.ts — Gentle Herdr producer sidecar (Pi extension).
//
// Publishes Gentle session facts as Herdr pane-metadata tokens plus
// namespaced `herdr:blocked` labels, for the herdr-gentle-agents consumer
// daemon (task 7) to reduce into sidebar state. Ships ALONGSIDE the
// managed-by-herdr sidecar `herdr-agent-state.ts` (HERDR_INTEGRATION_ID=pi,
// v9); never modifies, reinstalls, or imports it.
//
// DESIGN.md §4 producer contract (abridged, normative details there):
//   source id `gentle:v1`; sessionHash = base64url(sha256(agent_session path))
//   (43 chars, same derivation as herdr-pi-tree so pane correlation matches
//   without reusing its tokens); every token carries absolute expiry with
//   `expiry <= now + 60000`; writes are idempotent full-state snapshots per
//   beat (at-least-once, no ack; a lost beat is repaired by the next one);
//   ≤ 16 tokens per report; counts are normative, names advisory.
//
// Tokens (§4.3):
//   gentle_work_v1    = <hash>:<count>:<expiry>
//                       (normative running/queued total, internal only — the
//                       count never renders; the visible activity state comes
//                       from gentle_roles_v1)
//   gentle_roles_v1   = CSV of canonical role slugs from TaskRecord.agent
//                       (most-recent first, e.g. `worker,explorer`; null /
//                       clear when no active recognized roles). Authoritative
//                       for the visible activity state: explorer / worker /
//                       verify / rdd (review agents) collapse to the sidebar
//                       role; unrecognized agents fall back to `working`.
//   gentle_orchestrating_v1 = <hash>:<expiry>
//                       (root-session marker, session-bound + TTL-fresh like
//                       gentle_work_v1 but carrying no count: emitted only by
//                       the root Pi session (rootSession) while the main
//                       session is actively working (agentActive, even with
//                       zero subagents) or an authoritative running|queued
//                       TaskStore subagent exists or a
//                       subagent_run/subagent_continue launch is pending;
//                       null / clear once the main session settles (or any
//                       non-root session). Never alters the authoritative
//                       work count or the roles CSV.)
//   gentle_changes_v2 = <hash>:<files>:<added>:<deleted>:<expiry>
//                       (normative; exact added/deleted totals kept separate)
//   gentle_changes_v1 = <hash>:<files>:<added+deleted>:<expiry>
//                       (dual-emitted for rollback consumers only)
//   gentle_names_v1   = CSV of TaskRecord.label/agent (sanitized, ≤64 chars
//                       each, most-recent first, total ≤ ~512 chars; excess
//                       advisory names are dropped, never chunked — the §4.5
//                       #p= overflow form never triggers by construction)
//                       Compatibility transport only: the consumer renders
//                       roles, never names. Null (clear) when the active
//                       TaskStore list has no labels; null change tokens when the session model has
//                       zero changed files — refreshed/cleared from the live
//                       session model, never carried across sessions.
//   gentle_ask_v1         = <hash>:<intentId>:<expiry>
//                       (durable ask signal, session-bound + TTL-fresh like
//                       gentle_orchestrating_v1: emitted on every beat while
//                       ask is active (rpiv questionnaire, Gentle Shell
//                       choice, permission, or in-flight ask tool calls),
//                       null / clear when inactive. Repairs a missed
//                       edge-triggered `herdr:blocked` ask label; the
//                       consumer reduces a fresh token to `ask` with the
//                       existing error > ask > review priority.)
//   gentle_review_v1      = <hash>:<reviewId>:<expiry>
//                       (durable review signal, session-bound + TTL-fresh
//                       like gentle_ask_v1: emitted on every beat while
//                       effective review is active (an exact review tool
//                       call in flight or the reserved review hook active),
//                       null / clear the beat the last call resolves — NO
//                       GRACE, no timers, no agent_settled holds. Reuses
//                       the sanitized reviewId episode; never a verdict,
//                       authority, lineage, lens, or provider result.
//                       Repairs a missed edge-triggered `herdr:blocked`
//                       review label; the consumer reduces a fresh token to
//                       `review` (visible `rdd`) with the existing error >
//                       ask > review priority, independently of work token
//                       presence.)
//   herdr:blocked     = "ask:" intentId / "review:" reviewId / "error:" code
//                       (single effective label, priority error > ask >
//                       review, edge-triggered so the native counter in
//                       herdr-agent-state.ts stays balanced)
//
// Event seams (all in-process; this extension imports nothing from
// gentle-shell — DESIGN §10 U6 source pin is unresolved, so the producer is
// self-contained and observes only the Pi extension API):
//   subagent activity : structured details.gentleAgents
//                       {taskId,agent,status,mode} from subagent_*
//                       tool_results (authoritative TaskStore projection;
//                       active = running|queued per §4.2) plus background
//                       Gentle Agents completions as custom messages
//                       (customType `gentle-agents.result`,
//                       details.gentleAgents {taskId,agent,status}) observed
//                       via `message_end`. Final statuses
//                       (completed|failed|cancelled|timed_out) replace the
//                       task record so the next beat counts only
//                       running|queued as active; the rendered card is never
//                       parsed. Pending subagent
//                       tool calls are label correlation only for a later
//                       gentleAgents.taskId result and never count.
//   ask               : ASK_USER_CHOICE_BLOCKED_EVENT +
//                       rpiv:ask-user:blocked (questionnaire) +
//                       pi-permission-system:permission-request waiting state
//                       (tool-gated confirmation leg) + direct in-process
//                       `tool_call`/`tool_result` for the exact Pi tools
//                       `ask_user_question` and `ask_user_choice`, tracked by
//                       toolCallId in a call-id set, + consent-eligible
//                       `gentle_review` starts (ordinary-mode `start` /
//                       `select-intended-untracked`, tracked by toolCallId
//                       while pending: renders `ask` until the call
//                       resolves, then falls back to `review:` or the next
//                       state). One intentId minted per
//                       ¬ask→ask episode; stable across beats in the episode.
//                       Generic Pi `ui_prompt_start` / `ui_prompt_end` spans
//                       gated on in-flight `tool_execution_start` /
//                       `tool_execution_end` (installed herdr-pi-tree
//                       herdr-prompt-state pattern): a prompt contributes to
//                       ask only when it opens while at least one tool
//                       execution is active, so commands/widgets that prompt
//                       while idle never become ask; nested/duplicate
//                       lifecycle coalesces into one boolean leg.
//                       Boundary: this leg observes only what Pi emits as a
//                       `tool_call` event in this root extension. A host-side
//                       ask UI that never emits `tool_call` for those names
//                       is not observable here and stays covered only by the
//                       event-based legs above; no host-tool observation is
//                       claimed beyond the emitted events.
//   review            : in-flight Pi review tool calls
//                       (gentle_review, gentle_review_capture,
//                       gentle_review_capture_group, gentle_review_scope)
//                       tracked by toolCallId via the same in-process
//                       tool_call/tool_result seams as subagent activity, plus
//                       the reserved hook `gentle-pi:review:blocked`
//                       {active, reviewId?}. `review:` fires only while a
//                       review tool call is in flight (or the reserved hook
//                       reports active). Consent-eligible `gentle_review`
//                       starts (ordinary-mode `start` /
//                       `select-intended-untracked`) are classified into the
//                       ask leg while pending, never here — see the ask leg
//                       and isConsentEligibleReviewInput. During capture-group's fan-out to
//                       multiple reviewers the single parent capture-group
//                       call stays in flight for the whole span, so that one
//                       call alone holds `review:` — no per-reviewer tracking
//                       is needed or attempted. The consumer renders this leg
//                       as user-facing `rdd` (machine key stays `review`).
//                       Fail-safe: no provider verdicts are
//                       invented; the id is a sanitized correlation id only.
//   error             : subagent task failed status / subagent tool error /
//                       repeated own-transport failure. Latched until the next
//                       agent_start (fresh snapshot), TTL-bounded display.
//   changes           : SESSION_CHANGE_ENTRY facts mirroring the Gentle Shell
//                       SessionChanges model semantics from the session
//                       transcript (write|edit tool outcomes only, never git
//                       status) on `gentle-pi:session-change`. Files keyed by
//                       (root, path) with evidence-ID dedup, first-before /
//                       latest-after preservation, unavailable on broken
//                       snapshot continuity or kind:unavailable snapshots
//                       (unavailable files stay in the file count with 0/0),
//                       and the same unified-patch accounting as
//                       SessionChanges.changed() (generateUnifiedPatch +
//                       first-@@ +N/-N counts; absent maps to empty text) —
//                       published as separate v2 totals so the sidebar
//                       renders exact +N/-N segments.
//
// Security (implementation mode): principal = local Pi agent process;
// asset = pane tokens + session hash; untrusted sources = tool inputs, task
// details, event payloads, transcript entries (all shape/charset/bound
// validated before token inclusion; fail closed — no session binding means
// no tokens); sinks = Herdr socket IPC + fixed-argv `herdr` CLI fallback +
// in-process event bus. Logs carry no session IDs, paths, labels, hashes,
// or payloads (debug gate only, kinds/counts).
//
// Async semantics (async-and-realtime guidance): at-least-once snapshot
// beats + TTL expiry; no end-to-end exactly-once claim. The only
// exactly-once scope is ask *notification* dedup, which is consumer-side
// (DESIGN §7); the producer's contribution is a stable per-episode intentId.
// @ts-nocheck

import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Contract constants (DESIGN §4.3 / §8)
// ---------------------------------------------------------------------------

const SOURCE = "gentle:v1";
const HERDR_ENV = process.env.HERDR_ENV;
const socketPath = process.env.HERDR_SOCKET_PATH;
const socketEndpoint =
  process.platform === "win32" && socketPath ? `\\\\.\\pipe\\${socketPath}` : socketPath;
const paneId = process.env.HERDR_PANE_ID;

const TTL_MS = 60000;
const BEAT_MS = 15000;
const MAX_TOKENS_PER_REPORT = 16;
const MAX_LABEL_CHARS = 64;
const MAX_NAMES_CHARS = 512;
const MAX_ROLES_CHARS = 512;
const MAX_TRACKED_TASKS = 128;
const MAX_CHANGE_PATHS = 256;
const TRANSPORT_FAIL_LATCH = 3;
const CLI_FALLBACK_TIMEOUT_MS = 2500;

const ASK_EVENT = "gentle-pi:ask-user-choice:blocked";
const QUESTIONNAIRE_EVENT = "rpiv:ask-user:blocked";
const PERMISSION_EVENT = "pi-permission-system:permission-request";
const REVIEW_EVENT = "gentle-pi:review:blocked"; // reserved hook, OR-combined with the in-flight review tool-call signal below
// Exact Pi tool registrations verified in the installed Gentle Shell source
// (extensions/gentle-ai.ts): these four names are the only review leg.
const REVIEW_TOOLS = new Set([
  "gentle_review",
  "gentle_review_capture",
  "gentle_review_capture_group",
  "gentle_review_scope",
]);
// Direct Pi ask tools observed via the in-process tool_call/tool_result
// seam only (exact registrations `ask_user_question`, `ask_user_choice`).
// While any tracked call is pending the ask leg holds `ask:`; overlapping
// calls are counted by call id, never by a single boolean.
const ASK_TOOLS = new Set(["ask_user_question", "ask_user_choice"]);
// Consent-eligible native review starts (mirrors gentle-shell's
// isHostReviewConsentEligibleOperation self-contained — DESIGN §10 U6, this
// producer imports nothing from gentle-shell): a `gentle_review` start whose
// input requests ordinary mode, or a `select-intended-untracked` operation,
// may present the host review-consent UI while the tool call is pending.
// While such a call is in flight the ask leg holds `ask:` (the user must
// answer before the review can proceed); when the call resolves the label
// falls back to whatever leg is live then (an in-flight capture/review call
// → `review:`, else the next state). Eligibility is fail-closed:
// anything unparseable is an ordinary review call.
const REVIEW_START_OPERATION = "start";
const REVIEW_SELECT_OPERATION = "select-intended-untracked";
const REVIEW_ORDINARY_MODE = "ordinary";

function isConsentEligibleReviewInput(input) {
  if (!isRecord(input)) return false;
  const operation = input.operation;
  if (operation === REVIEW_SELECT_OPERATION) return true;
  if (operation !== REVIEW_START_OPERATION) return false;
  const raw = input.input;
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return isRecord(parsed) && parsed.mode === REVIEW_ORDINARY_MODE;
  } catch {
    return false;
  }
}
const CHANGE_EVENT = "gentle-pi:session-change";
const CHANGE_ENTRY = "gentle-pi.session-change/v1";
const BLOCKED_EVENT = "herdr:blocked";
// Durable ask token name (DESIGN §4.3): session-bound + TTL-fresh
// `<hash>:<intentId>:<expiry>`, emitted on every beat while ask is active.
const ASK_TOKEN = "gentle_ask_v1";
// Durable review token name: session-bound + TTL-fresh
// `<hash>:<reviewId>:<expiry>`, emitted on every beat while effective
// review is active (in-flight exact review tool call or reserved hook).
// Null / clear the beat the last call resolves — NO GRACE, no timers.
const REVIEW_TOKEN = "gentle_review_v1";

const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const COUNT_RE = /^(0|[1-9]\d{0,15})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE_TASK = new Set(["running", "queued"]);
const FINAL_TASK = new Set(["completed", "failed", "cancelled", "timed_out"]);
const AGENTS_RESULT_TYPE = "gentle-agents.result";

const DEBUG = process.env.GENTLE_HERDR_DEBUG === "1";

function debug(kind, extra) {
  if (DEBUG) console.error(`[gentle-herdr-state] ${kind}${extra === undefined ? "" : ` ${extra}`}`);
}

function enabled() {
  return HERDR_ENV === "1" && !!socketPath && !!paneId;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizeId(value, fallbackPrefix) {
  if (typeof value === "string" && ID_RE.test(value)) return value;
  const rand = randomUUID().replace(/-/g, "").slice(0, 8);
  return `${fallbackPrefix}${rand}`;
}

function sanitizeLabel(value, fallback) {
  const raw = typeof value === "string" && value.length > 0 ? value : fallback;
  const clean = String(raw)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "")
    .replace(/[,\"\n\r]/g, " ")
    .trim()
    .slice(0, MAX_LABEL_CHARS);
  return clean.length > 0 ? clean : String(fallback).slice(0, MAX_LABEL_CHARS);
}

function sessionHashOf(sessionFile) {
  if (typeof sessionFile !== "string" || sessionFile.length === 0) return undefined;
  const hash = createHash("sha256").update(sessionFile, "utf8").digest("base64url");
  return HASH_RE.test(hash) ? hash : undefined;
}

// ---------------------------------------------------------------------------
// Transport: socket IPC with one CLI fallback per beat (DESIGN §4.5 / §6)
// ---------------------------------------------------------------------------

function sendRequestAttempt(request, timeoutMs) {
  if (!enabled()) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    let timeout;
    const finish = (delivered) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      try {
        socket.destroy();
      } catch {}
      resolve(delivered);
    };
    let socket;
    try {
      socket = net.createConnection(socketEndpoint);
    } catch {
      finish(false);
      return;
    }
    socket.on("error", () => finish(false));
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(request)}\n`);
      } catch {
        finish(false);
      }
    });
    socket.on("data", (chunk) => {
      let body;
      try {
        body = JSON.parse(String(chunk));
      } catch {
        // Fail closed on unparseable bodies: retry + CLI fallback engage.
        finish(false);
        return;
      }
      if (isRecord(body) && body.error !== undefined && body.error !== null) {
        finish(false);
        return;
      }
      finish(true);
    });
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    if (timeout.unref) timeout.unref();
  });
}

async function sendTokens(tokens) {
  const names = Object.keys(tokens);
  for (let at = 0; at < names.length; at += MAX_TOKENS_PER_REPORT) {
    const patch = {};
    for (const name of names.slice(at, at + MAX_TOKENS_PER_REPORT)) patch[name] = tokens[name];
    const delivered =
      (await sendRequestAttempt(
        {
          id: `${SOURCE}:${Date.now()}:${randomUUID()}`,
          method: "pane.report_metadata",
          params: { pane_id: paneId, source: SOURCE, tokens: patch },
        },
        500,
      )) ||
      (await sendRequestAttempt(
        {
          id: `${SOURCE}:${Date.now()}:${randomUUID()}`,
          method: "pane.report_metadata",
          params: { pane_id: paneId, source: SOURCE, tokens: patch },
        },
        1500,
      ));
    if (delivered) continue;
    if (!(await cliFallback(patch))) return false;
  }
  return true;
}

// Never spawnSync on the agent event loop (R4-stall): async spawn with a
// short timeout keeps beats off the critical path; on failure the beat is
// skipped and the next beat repairs (at-least-once already holds). Fixed
// argv, no shell; 60 s TTL discipline untouched.
function cliFallback(patch) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    let child;
    try {
      const args = ["pane", "report-metadata", paneId, "--source", SOURCE];
      for (const [name, value] of Object.entries(patch)) {
        // Null clears must never serialize as the literal string "name=null":
        // socket metadata carries null for clear, CLI uses --clear-token <name>.
        if (value === null || value === undefined) args.push("--clear-token", name);
        else args.push("--token", `${name}=${value}`);
      }
      child = spawn("herdr", args, { windowsHide: true });
    } catch {
      finish(false);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(false);
    }, CLI_FALLBACK_TIMEOUT_MS);
    if (timer.unref) timer.unref();
    child.on("error", () => {
      clearTimeout(timer);
      finish(false);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish(code === 0);
    });
  });
}

// ---------------------------------------------------------------------------
// Session-changes aggregation (G1/G2: transcript facts only, never git)
//
// Mirrors the Gentle Shell SessionChanges model semantics over the same
// SESSION_CHANGE_ENTRY evidence: files keyed by (root, path), evidence-ID
// dedup, identical before/after records skipped, first before preserved with
// latest after, unavailable on broken snapshot continuity or any
// kind:unavailable snapshot (unavailable files stay in the file count with
// 0 added/0 deleted), and unified-patch line accounting for available
// text/absent snapshots (absent maps to empty text for patch counts).
// ---------------------------------------------------------------------------

function sameSnapshot(before, after) {
  return (
    before?.kind === after?.kind &&
    (before?.kind === "absent" ||
      (before?.kind === "text" &&
        after?.kind === "text" &&
        before?.text === after?.text))
  );
}

function snapshotPatchText(snapshot) {
  return snapshot && snapshot.kind === "text" && typeof snapshot.text === "string" ? snapshot.text : "";
}

function unavailableReason(snapshot) {
  if (snapshot?.kind === "unavailable" && typeof snapshot?.reason === "string" && snapshot.reason.length > 0) {
    return snapshot.reason;
  }
  return "Snapshot unavailable.";
}

// Unified-patch accounting identical to Gentle Shell
// SessionChanges.changed(): generateUnifiedPatch(path, before, after),
// enter after the first @@ hunk, count lines beginning + and -. Fail-closed
// to 0/0 so token bounds hold when the patch cannot be built.
function safePatchPath(path) {
  if (typeof path !== "string") return "change";
  const clean = path.replace(/[\0\r\n]/g, "").slice(0, 256);
  return clean.length > 0 ? clean : "change";
}

function patchLineCounts(pathLabel, before, after) {
  try {
    const patch = generateUnifiedPatch(pathLabel, before, after);
    const patchLines = patch.split("\n");
    const firstHunk = patchLines.findIndex((line) => line.startsWith("@@"));
    const lines = firstHunk < 0 ? [] : patchLines.slice(firstHunk + 1);
    return {
      added: lines.filter((line) => line.startsWith("+")).length,
      deleted: lines.filter((line) => line.startsWith("-")).length,
    };
  } catch {
    return { added: 0, deleted: 0 };
  }
}

function isPlausibleEvidence(evidence) {
  return (
    isRecord(evidence) &&
    typeof evidence.id === "string" &&
    evidence.id.length > 0 &&
    typeof evidence.root === "string" &&
    evidence.root.length > 0 &&
    typeof evidence.path === "string" &&
    evidence.path.length > 0 &&
    isRecord(evidence.before) &&
    isRecord(evidence.after)
  );
}

function aggregateChanges(entries, sessionId) {
  const seen = new Set();
  const perRoot = new Map();
  let paths = 0;
  for (const entry of entries ?? []) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CHANGE_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data) || data.sessionId !== sessionId || !isPlausibleEvidence(data.evidence)) continue;
    const evidence = data.evidence;
    if (seen.has(evidence.id)) continue;
    seen.add(evidence.id);
    if (sameSnapshot(evidence.before, evidence.after)) continue;
    let perPath = perRoot.get(evidence.root);
    if (!perPath) {
      perPath = new Map();
      perRoot.set(evidence.root, perPath);
    }
    let slot = perPath.get(evidence.path);
    if (!slot) {
      if (paths >= MAX_CHANGE_PATHS) continue;
      paths += 1;
      slot = { before: evidence.before, after: evidence.after };
      if (evidence.before?.kind === "unavailable") slot.unavailable = unavailableReason(evidence.before);
      if (evidence.after?.kind === "unavailable" && !slot.unavailable) {
        slot.unavailable = unavailableReason(evidence.after);
      }
      perPath.set(evidence.path, slot);
    } else {
      if (!slot.unavailable && !sameSnapshot(slot.after, evidence.before)) {
        slot.unavailable =
          "Snapshot continuity lost (external or unobserved edit); session diff unavailable.";
      }
      if (evidence.before?.kind === "unavailable" && !slot.unavailable) {
        slot.unavailable = unavailableReason(evidence.before);
      }
      if (evidence.after?.kind === "unavailable" && !slot.unavailable) {
        slot.unavailable = unavailableReason(evidence.after);
      }
      slot.after = evidence.after;
    }
  }
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const perPath of perRoot.values()) {
    for (const [changePath, { before, after, unavailable }] of perPath) {
      if (!unavailable && sameSnapshot(before, after)) continue;
      files += 1;
      if (unavailable) continue;
      const { added: fileAdded, deleted: fileDeleted } = patchLineCounts(
        safePatchPath(changePath),
        snapshotPatchText(before),
        snapshotPatchText(after),
      );
      added += fileAdded;
      deleted += fileDeleted;
    }
  }
  return { files, added, deleted };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi) {
  if (!enabled()) return;

  let rootSession = false;
  let sessionId;
  let sessionManager;
  let sessionFile;
  let sessionHash;
  let agentActive = false;
  let settled = false;

  // Subagent tracking: authoritative TaskStore projection only. The tasks
  // map mirrors Gentle Shell status records carried in
  // details.gentleAgents on subagent_* tool results; activeSubs() counts
  // exactly the entries whose status is running|queued. Gentle Shell owns
  // lifecycle/status truth: no local age/staleness timeout is applied.
  // pendingCalls holds label correlation state for a later
  // gentleAgents.taskId result plus a role-only display hint (exact pending
  // subagent agent -> gentle_roles_v1 slug) while the tool call is in
  // flight; it never increments the count. Task-mode `subagent_run` stays
  // in flight with no TaskStore record until tool_result, so without the
  // hint the active role would be invisible and the sidebar would show
  // generic `working` during execution.
  // Finished/failed/cancelled/waiting entries may linger in the map but
  // never count; the map is cleared only on session reset (plus the
  // bounded-map guard) — never by a local staleness timeout.
  const pendingCalls = new Map(); // toolCallId -> { agent, label, at }
  const tasks = new Map(); // taskId -> { agent, label, status, at }

  // Blocker legs. ask combines choice + questionnaire + tool-gated
  // confirmation + direct ask_user_* tool calls in flight; exactly one
  // intentId per ¬ask→ask episode. askToolCalls tracks live
  // `ask_user_question`/`ask_user_choice` calls by toolCallId so
  // overlapping calls stay correct; cleared on tool_result (by call id),
  // session reset, and shutdown. Event legs and permission/review
  // precedence (error > ask > review) are unchanged.
  let choiceActive = false;
  let questionnaireActive = false;
  const permissionPending = new Set();
  const askToolCalls = new Map(); // toolCallId -> at (ms)
  // Consent-eligible `gentle_review` starts pending answer (toolCallId ->
  // at (ms)): feeds the ask leg while in flight, cleared on tool_result
  // (by call id), session reset, and shutdown. Overlapping starts stay
  // correct by call id, like askToolCalls above.
  const consentPending = new Map(); // toolCallId -> at (ms)
  // Generic Pi UI prompt leg (mirrors the installed herdr-pi-tree
  // herdr-prompt-state pattern): `tool_execution_start` /
  // `tool_execution_end` track tool calls in flight by id; a
  // `ui_prompt_start` contributes to ask only when it opens while at least
  // one tool execution is active, so commands/widgets that prompt while
  // idle never become ask. Nested or duplicate prompt lifecycle coalesces
  // into one boolean leg, cleared on the matching `ui_prompt_end`,
  // session reset, and shutdown.
  const runningTools = new Set(); // toolCallId -> in-flight tool execution
  let uiPromptActive = false;
  let askIntentId;
  let askCounter = 0;
  // Review leg: bounded in-flight signal. reviewCalls tracks live review
  // tool calls by toolCallId; reviewEventActive is the reserved
  // `gentle-pi:review:blocked` hook. reviewActive is the effective OR of
  // both, so `review:` emits only while a review tool call is in flight
  // (or the hook reports active). During a capture-group run the single
  // parent capture-group call covers the whole multi-reviewer span.
  // reviewId stays a sanitized correlation
  // id; never a provider verdict.
  let reviewActive = false;
  let reviewEventActive = false;
  let reviewId;
  const reviewCalls = new Map(); // toolCallId -> at (ms)

  function syncReviewActive() {
    reviewActive = reviewEventActive || reviewCalls.size > 0;
  }
  // Error latch: cleared on the next agent_start (fresh snapshot).
  let errorCode;
  let emittedLabel;

  let changes = { files: 0, added: 0, deleted: 0 };
  let transportFails = 0;
  let beatTimer;
  let publishQueued = false;
  let publishInFlight = false;

  function refreshSessionRef(ctx) {
    try {
      const file = ctx?.sessionManager?.getSessionFile?.();
      if (typeof file === "string" && file.length > 0) {
        sessionFile = file;
        sessionHash = sessionHashOf(file);
      }
    } catch {
      // Fail closed: keep the last bound hash; publish nothing without one.
    }
    try {
      const id = ctx?.sessionManager?.getSessionId?.();
      if (typeof id === "string" && id.length > 0) sessionId = id;
    } catch {}
  }

  function askActiveNow() {
    return (
      choiceActive ||
      questionnaireActive ||
      permissionPending.size > 0 ||
      askToolCalls.size > 0 ||
      consentPending.size > 0 ||
      uiPromptActive
    );
  }

  function desiredLabel() {
    if (errorCode) return `error:${errorCode}`;
    if (askActiveNow()) return `ask:${askIntentId}`;
    if (reviewActive) return `review:${reviewId}`;
    return undefined;
  }

  function ensureAskIntent() {
    if (askActiveNow() && !askIntentId) {
      askCounter += 1;
      askIntentId = sanitizeId(undefined, `q${askCounter.toString(36)}-`);
    }
  }

  function updateBlocker() {
    if (!rootSession) return;
    ensureAskIntent();
    if (!askActiveNow()) askIntentId = undefined;
    if (reviewActive && !reviewId) reviewId = sanitizeId(undefined, "r-");
    if (!reviewActive) reviewId = undefined;
    const next = desiredLabel();
    if (next === emittedLabel) return;
    emittedLabel = next;
    try {
      if (next === undefined) pi.events.emit(BLOCKED_EVENT, { active: false });
      else pi.events.emit(BLOCKED_EVENT, { active: true, label: next });
    } catch {
      // Event-bus emission must never break the beat.
    }
    schedulePublish();
  }

  // Direct projection of the Gentle Shell TaskStore: every entry whose
  // authoritative status is running|queued counts once. Pending tool calls
  // never count; finished/failed/cancelled/waiting entries never count.
  // WHY pending calls stay out of the count: task-mode `subagent_run` stays
  // in flight without a TaskStore record until it returns tool_result, so
  // counting pending calls would inflate `gentle_work_v1` with estimates.
  // The count is normative and internal-only; role display below is the
  // only consumer of the pending hint.
  function activeSubs() {
    const out = [];
    for (const task of tasks.values()) {
      if (ACTIVE_TASK.has(task.status)) {
        out.push({ agent: task.agent, label: task.label, at: task.at });
      }
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  // Role-only hint from in-flight `subagent_run`/`subagent_continue` tool
  // calls: task-mode launches stay in flight (no tool_result yet, hence no
  // TaskStore record) even though `tool_call` input already carries the
  // exact agent name. Publishing that agent's role slug keeps the sidebar
  // from showing generic `working` during execution. This is display-only:
  // it never enters `gentle_work_v1` or any displayed count, and each hint
  // is cleared when its tool_result arrives, the call is cancelled, or the
  // agent settles. Unrecognized agents yield no hint (consumer falls back
  // to main `working`).
  function pendingRoleSubs() {
    const out = [];
    for (const pending of pendingCalls.values()) {
      if (agentToRole(pending.agent) !== undefined) {
        out.push({ agent: pending.agent, label: pending.label, at: pending.at });
      }
    }
    out.sort((a, b) => b.at - a.at);
    return out;
  }

  // Merged role sources, newest-first by `at`: authoritative active
  // TaskStore subs first by recency, interleaved with pending role hints.
  // Authoritative entries win on duplicates via rolesCsv dedup (first wins).
  function mergedRoleSubs() {
    const merged = [...activeSubs(), ...pendingRoleSubs()];
    merged.sort((a, b) => b.at - a.at);
    return merged;
  }

  function namesCsv(subs) {
    const parts = [];
    let length = 0;
    for (const sub of subs) {
      const name = sanitizeLabel(sub.label, sub.agent);
      if (parts.includes(name)) continue;
      const add = (parts.length === 0 ? 0 : 1) + name.length;
      if (length + add > MAX_NAMES_CHARS) break;
      parts.push(name);
      length += add;
    }
    return parts.join(",");
  }

  // Authoritative role signal from TaskRecord.agent (never task labels):
  // the actual package agent `gentle-ai-explore` (verified in the project
  // registry `~/.pi/agent`, alongside `gentle-ai-worker`/`gentle-ai-verify`/
  // review agents) maps to `explorer`; the legacy `gentle-ai-explorer` alias
  // is preserved for compatibility. Exact worker/verify agents map 1:1;
  // the gentle-ai-review* family, a bare `review` agent, or any role
  // containing `review` collapses to the single `rdd` slug. Anything else is
  // unrecognized (undefined) and the consumer falls back to
  // orchestrator/main `working`. No counts, no names, no labels enter the
  // signal.
  function agentToRole(agent) {
    if (typeof agent !== "string" || agent.length === 0) return undefined;
    if (agent === "gentle-ai-explore" || agent === "gentle-ai-explorer") return "explorer";
    if (agent === "gentle-ai-worker") return "worker";
    if (agent === "gentle-ai-verify") return "verify";
    if (
      agent === "gentle-ai-review" ||
      agent.startsWith("gentle-ai-review-") ||
      agent.startsWith("gentle-ai-review_") ||
      /review/i.test(agent)
    ) {
      return "rdd";
    }
    return undefined;
  }

  // Bounded CSV of recognized roles, most-recent first (subs already arrive
  // newest-first), deduped. Empty when no active recognized roles — the
  // caller null-clears the token so a new/reloaded session never retains a
  // prior roles value.
  function rolesCsv(subs) {
    const parts = [];
    let length = 0;
    for (const sub of subs) {
      const role = agentToRole(sub.agent);
      if (!role || parts.includes(role)) continue;
      const add = (parts.length === 0 ? 0 : 1) + role.length;
      if (length + add > MAX_ROLES_CHARS) break;
      parts.push(role);
      length += add;
    }
    return parts.join(",");
  }

  function buildTokens() {
    if (!sessionHash) return {};
    const expiry = Date.now() + TTL_MS;
    const subs = activeSubs();
    const tokens = {};
    const count = String(subs.length);
    if (COUNT_RE.test(count)) tokens.gentle_work_v1 = `${sessionHash}:${count}:${expiry}`;
    const csv = namesCsv(subs);
    // Clear (null) when the authoritative active TaskStore list has no
    // labels, so a new/reloaded session never retains a prior names token.
    // Socket metadata carries null for clear; the CLI fallback maps null to
    // `--clear-token <name>`.
    if (csv.length > 0) tokens.gentle_names_v1 = csv;
    else tokens.gentle_names_v1 = null;
    // Authoritative role signal for the visible activity state (DESIGN
    // §4.3), merged with the in-flight pending role hint: TaskStore
    // running|queued roles plus the exact pending subagent agent while its
    // tool call is in flight (task-mode launches have no TaskStore record
    // yet). The hint is role-only — the count above stays authoritative —
    // and is cleared with the pending call. Null (clear) when no active
    // recognized roles in either source — unrecognized agents degrade to
    // the consumer's `working` display.
    const roles = rolesCsv(mergedRoleSubs());
    if (roles.length > 0) tokens.gentle_roles_v1 = roles;
    else tokens.gentle_roles_v1 = null;
    // Durable ask signal (DESIGN §4.3): session-bound + TTL-fresh
    // `<hash>:<intentId>:<expiry>`, emitted on every beat while ask is
    // active, null (clear) when inactive. Repairs a missed edge-triggered
    // `herdr:blocked` ask label — the consumer reduces a fresh token to
    // `ask` with the existing error > ask > review priority. Intent and
    // clearing discipline match the label leg (updateBlocker); the mint
    // here covers beats where the leg went active without an updateBlocker
    // pass (e.g. session handoff), so the token never lags the label.
    ensureAskIntent();
    if (askActiveNow() && askIntentId) tokens[ASK_TOKEN] = `${sessionHash}:${askIntentId}:${expiry}`;
    else tokens[ASK_TOKEN] = null;
    // Durable review signal: session-bound + TTL-fresh
    // `<hash>:<reviewId>:<expiry>`, emitted on every beat while effective
    // review is active, null (clear) the beat the last call resolves — NO
    // GRACE, no timers, no agent_settled holds. Reuses the sanitized
    // reviewId episode minted by updateBlocker (minted here too so the
    // token never lags the label); never a verdict, authority, lineage,
    // lens, or provider result. Consent-eligible `gentle_review` starts
    // stay in the ask leg above, never here.
    if (reviewActive && !reviewId) reviewId = sanitizeId(undefined, "r-");
    if (!reviewActive) reviewId = undefined;
    if (reviewActive && reviewId) tokens[REVIEW_TOKEN] = `${sessionHash}:${reviewId}:${expiry}`;
    else tokens[REVIEW_TOKEN] = null;
    // Root-only orchestrating marker (DESIGN §4.3): session-bound freshness
    // (<hash>:<expiry>, same binding/TTL style as gentle_work_v1, no count)
    // emitted by the root Pi session while the main session is actively
    // working (agentActive, even with zero subagents), retaining coverage
    // while an authoritative running|queued subagent exists or a
    // subagent_run/subagent_continue launch is pending; null (clear) once
    // the main session settles (or any non-root session) so a settled
    // session never retains it. Carries no count and never alters the work
    // total or the roles CSV — the consumer reduces a fresh marker to the
    // `orchestrating` display only when no recognized role is active (below
    // attention, terminal `done`, and recognized roles; ahead of main
    // `working`).
    if (rootSession && (agentActive || subs.length > 0 || pendingCalls.size > 0)) {
      tokens.gentle_orchestrating_v1 = `${sessionHash}:${expiry}`;
    } else {
      tokens.gentle_orchestrating_v1 = null;
    }
    if (changes.files > 0) {
      const files = String(changes.files);
      const added = String(changes.added);
      const deleted = String(changes.deleted);
      if (COUNT_RE.test(files) && COUNT_RE.test(added) && COUNT_RE.test(deleted)) {
        // v2 is normative (exact added/deleted for the +N/-N row);
        // v1 dual-emit keeps rollback consumers on the combined delta.
        tokens.gentle_changes_v2 = `${sessionHash}:${files}:${added}:${deleted}:${expiry}`;
        const delta = String(changes.added + changes.deleted);
        if (COUNT_RE.test(delta)) {
          tokens.gentle_changes_v1 = `${sessionHash}:${files}:${delta}:${expiry}`;
        }
      }
    } else {
      // Zero changed files in the current Gentle Shell session model clears
      // both change tokens (null = clear), so a new/reloaded session under a
      // different session hash cannot retain the prior session's v2 token.
      tokens.gentle_changes_v2 = null;
      tokens.gentle_changes_v1 = null;
    }
    return tokens;
  }

  function interesting() {
    // A pending role hint alone keeps the beat alive so the in-flight
    // task-mode role publishes even while the authoritative count is 0.
    // A pending ask tool call likewise keeps the beat alive so `ask:`
    // publishes while the call is in flight; the generic UI prompt leg
    // holds the beat the same way while its span is open. Effective
    // review (in-flight exact review tool calls or the reserved hook)
    // keeps the beat alive so `review:` and the durable review token
    // publish — NO GRACE: the leg drops the beat the last call resolves.
    return (
      agentActive ||
      activeSubs().length > 0 ||
      pendingCalls.size > 0 ||
      askToolCalls.size > 0 ||
      consentPending.size > 0 ||
      uiPromptActive ||
      reviewActive ||
      emittedLabel !== undefined
    );
  }

  function ensureBeat() {
    if (beatTimer || !rootSession) return;
    if (!interesting() && settled) return;
    beatTimer = setInterval(() => {
      void publishNow();
    }, BEAT_MS);
    if (beatTimer.unref) beatTimer.unref();
  }

  function maybeStopBeat() {
    if (beatTimer && !interesting()) {
      clearInterval(beatTimer);
      beatTimer = undefined;
    }
  }

  async function publishNow() {
    if (publishInFlight || !rootSession) return;
    const tokens = buildTokens();
    if (Object.keys(tokens).length === 0) {
      maybeStopBeat();
      return;
    }
    publishInFlight = true;
    try {
      const ok = await sendTokens(tokens);
      if (ok) {
        if (transportFails >= TRANSPORT_FAIL_LATCH && errorCode === "transport") {
          errorCode = undefined;
          updateBlocker();
        }
        transportFails = 0;
      } else {
        transportFails += 1;
        if (transportFails >= TRANSPORT_FAIL_LATCH && !errorCode) {
          errorCode = "transport";
          updateBlocker();
        }
      }
    } finally {
      publishInFlight = false;
      if (publishQueued) {
        publishQueued = false;
        schedulePublish();
      } else {
        maybeStopBeat();
      }
    }
    debug("beat", `tokens=${Object.keys(tokens).length} subs=${activeSubs().length}`);
  }

  function schedulePublish() {
    ensureBeat();
    if (publishInFlight) {
      publishQueued = true;
      return;
    }
    setTimeout(() => {
      void publishNow();
    }, 100);
  }

  function refreshChanges() {
    if (!sessionManager || !sessionId) return;
    try {
      const entries = sessionManager.getEntries?.();
      changes = aggregateChanges(entries, sessionId);
    } catch {
      // Observation must never break tool outcomes; keep last aggregate.
    }
  }

  function resetSessionState() {
    pendingCalls.clear();
    tasks.clear();
    choiceActive = false;
    questionnaireActive = false;
    permissionPending.clear();
    askToolCalls.clear();
    consentPending.clear();
    runningTools.clear();
    uiPromptActive = false;
    askIntentId = undefined;
    reviewEventActive = false;
    reviewCalls.clear();
    reviewActive = false;
    reviewId = undefined;
    errorCode = undefined;
    changes = { files: 0, added: 0, deleted: 0 };
    agentActive = false;
    settled = false;
  }

  function clearEmittedLabel() {
    if (emittedLabel === undefined) return;
    emittedLabel = undefined;
    try {
      pi.events.emit(BLOCKED_EVENT, { active: false });
    } catch {}
  }

  // -- ask legs -------------------------------------------------------------

  pi.events.on(ASK_EVENT, (event) => {
    if (!rootSession || !isRecord(event) || typeof event.active !== "boolean") return;
    if (event.active === choiceActive) return;
    choiceActive = event.active;
    updateBlocker();
  });

  pi.events.on(QUESTIONNAIRE_EVENT, (event) => {
    if (!rootSession || !isRecord(event) || typeof event.active !== "boolean") return;
    if (event.active === questionnaireActive) return;
    questionnaireActive = event.active;
    updateBlocker();
  });

  pi.events.on(PERMISSION_EVENT, (event) => {
    if (!rootSession || !isRecord(event)) return;
    const { requestId, state } = event;
    if (typeof requestId !== "string" || requestId.length === 0) return;
    if (state === "waiting") {
      if (permissionPending.has(requestId)) return;
      permissionPending.add(requestId);
      updateBlocker();
    } else if (state === "approved" || state === "denied") {
      if (!permissionPending.delete(requestId)) return;
      updateBlocker();
    }
  });

  // -- generic tool-blocking UI prompt leg (state above) --

  pi.on("tool_execution_start", (event) => {
    if (!rootSession || !isRecord(event) || typeof event.toolCallId !== "string") return;
    runningTools.add(event.toolCallId);
  });

  pi.on("tool_execution_end", (event) => {
    if (!rootSession || !isRecord(event) || typeof event.toolCallId !== "string") return;
    runningTools.delete(event.toolCallId);
  });

  pi.on("ui_prompt_start", () => {
    if (!rootSession || uiPromptActive || runningTools.size === 0) return;
    uiPromptActive = true;
    updateBlocker();
  });

  pi.on("ui_prompt_end", () => {
    if (!rootSession || !uiPromptActive) return;
    uiPromptActive = false;
    updateBlocker();
  });

  // -- review leg (in-flight review tool calls + reserved hook) --

  pi.events.on(REVIEW_EVENT, (event) => {
    if (!rootSession || !isRecord(event) || typeof event.active !== "boolean") return;
    if (event.active === reviewEventActive) return;
    reviewEventActive = event.active;
    if (reviewEventActive && typeof event.reviewId === "string" && ID_RE.test(event.reviewId)) {
      reviewId = event.reviewId;
    }
    syncReviewActive();
    updateBlocker();
    // NO GRACE (same coupling as the tool_result path above): the hook
    // flips effective review even when ask/error owns the visible label and
    // updateBlocker() emits nothing — always republish so the token bytes
    // track the leg on this beat.
    schedulePublish();
  });

  // -- session changes -------------------------------------------------------

  pi.events.on(CHANGE_EVENT, (event) => {
    if (!rootSession || !isRecord(event)) return;
    if (event.sessionId !== undefined && event.sessionId !== sessionId) return;
    refreshChanges();
    schedulePublish();
  });

  // -- subagent activity -----------------------------------------------------

  function launchInput(input) {
    if (!isRecord(input)) return undefined;
    const agent = typeof input.agent === "string" ? input.agent : "subagent";
    const label = sanitizeLabel(typeof input.label === "string" ? input.label : agent, agent);
    return { agent: agent.slice(0, MAX_LABEL_CHARS), label };
  }

  pi.on("tool_call", (event) => {
    if (!rootSession || !isRecord(event) || typeof event.toolName !== "string") return;
    if (ASK_TOOLS.has(event.toolName)) {
      if (typeof event.toolCallId === "string" && event.toolCallId.length > 0) {
        askToolCalls.set(event.toolCallId, Date.now());
        if (askToolCalls.size > MAX_TRACKED_TASKS) {
          const oldest = askToolCalls.keys().next().value;
          askToolCalls.delete(oldest);
        }
        updateBlocker();
        schedulePublish();
      }
    }
    if (REVIEW_TOOLS.has(event.toolName)) {
      if (typeof event.toolCallId === "string" && event.toolCallId.length > 0) {
        if (event.toolName === "gentle_review" && isConsentEligibleReviewInput(event.input)) {
          consentPending.set(event.toolCallId, Date.now());
          if (consentPending.size > MAX_TRACKED_TASKS) {
            const oldest = consentPending.keys().next().value;
            consentPending.delete(oldest);
          }
          updateBlocker();
          schedulePublish();
        } else {
          reviewCalls.set(event.toolCallId, Date.now());
          syncReviewActive();
          updateBlocker();
          schedulePublish();
        }
      }
    }
    if (event.toolName === "subagent_run" || event.toolName === "subagent_continue") {
      const parsed = launchInput(event.input);
      if (!parsed || typeof event.toolCallId !== "string") return;
      pendingCalls.set(event.toolCallId, { ...parsed, at: Date.now() });
      if (pendingCalls.size > MAX_TRACKED_TASKS) {
        const oldest = pendingCalls.keys().next().value;
        pendingCalls.delete(oldest);
      }
      schedulePublish();
    } else if (event.toolName === "subagent_cancel") {
      const taskId = isRecord(event.input) ? event.input.task_id : undefined;
      if (typeof taskId !== "string") return;
      const known = tasks.get(taskId);
      if (known) {
        tasks.set(taskId, { ...known, status: "cancelled", at: Date.now() });
        schedulePublish();
      }
    }
  });

  pi.on("tool_result", (event) => {
    if (!rootSession || !isRecord(event) || typeof event.toolName !== "string") return;
    if (typeof event.toolCallId === "string" && askToolCalls.delete(event.toolCallId)) {
      updateBlocker();
    }
    if (typeof event.toolCallId === "string" && consentPending.delete(event.toolCallId)) {
      updateBlocker();
    }
    const pending =
      typeof event.toolCallId === "string" ? pendingCalls.get(event.toolCallId) : undefined;
    if (typeof event.toolCallId === "string") pendingCalls.delete(event.toolCallId);
    if (typeof event.toolCallId === "string" ? reviewCalls.delete(event.toolCallId) : false) {
      const wasActive = reviewActive;
      syncReviewActive();
      if (reviewActive !== wasActive) updateBlocker();
      // NO GRACE: a resolving review call changes the durable review token
      // even when a higher-priority leg (ask/error) owns the visible label
      // and updateBlocker() emits nothing — always republish so the clear
      // ships on this beat instead of lingering to the next beat/TTL.
      schedulePublish();
    } else if (REVIEW_TOOLS.has(event.toolName)) {
      const wasActive = reviewActive;
      syncReviewActive();
      if (reviewActive !== wasActive) updateBlocker();
    }
    const details = isRecord(event.details) ? event.details.gentleAgents : undefined;
    if (!isRecord(details) || typeof details.taskId !== "string") {
      if (event.toolName === "subagent_run" && event.isError === true && !errorCode) {
        errorCode = "task-failed";
        updateBlocker();
      }
      return;
    }
    const previous = tasks.get(details.taskId);
    // Never infer an active status: a missing status keeps the previous
    // record's status, else lands as unknown (never counted). The pending
    // record contributes only its label before it is deleted above.
    const status =
      typeof details.status === "string" ? details.status : (previous?.status ?? "unknown");
    const agent =
      typeof details.agent === "string" && details.agent.length > 0
        ? details.agent.slice(0, MAX_LABEL_CHARS)
        : "subagent";
    tasks.set(details.taskId, {
      agent,
      label: previous?.label ?? pending?.label ?? agent,
      status,
      at: Date.now(),
    });
    if (tasks.size > MAX_TRACKED_TASKS) {
      const oldest = tasks.keys().next().value;
      tasks.delete(oldest);
    }
    if (status === "failed" && !errorCode) {
      errorCode = "task-failed";
      updateBlocker();
    }
    schedulePublish();
  });

  // Background Gentle Agents completions arrive as a custom message
  // (customType `gentle-agents.result`, details.gentleAgents
  // {taskId,agent,status}) rather than a subagent_* tool_result. A final
  // status replaces the authoritative task record so the next beat counts
  // only running|queued as active; the rendered card is never parsed.
  pi.on("message_end", (event) => {
    if (!rootSession || !isRecord(event)) return;
    const message = event.message;
    if (!isRecord(message) || message.role !== "custom") return;
    if (message.customType !== AGENTS_RESULT_TYPE) return;
    const details = isRecord(message.details) ? message.details.gentleAgents : undefined;
    if (!isRecord(details) || typeof details.taskId !== "string") return;
    if (typeof details.status !== "string" || !FINAL_TASK.has(details.status)) return;
    const previous = tasks.get(details.taskId);
    const agent =
      typeof details.agent === "string" && details.agent.length > 0
        ? details.agent.slice(0, MAX_LABEL_CHARS)
        : (previous?.agent ?? "subagent");
    tasks.set(details.taskId, {
      agent,
      label: previous?.label ?? agent,
      status: details.status,
      at: Date.now(),
    });
    if (tasks.size > MAX_TRACKED_TASKS) {
      const oldest = tasks.keys().next().value;
      tasks.delete(oldest);
    }
    if (details.status === "failed" && !errorCode) {
      errorCode = "task-failed";
      updateBlocker();
    }
    schedulePublish();
  });

  // -- agent lifecycle ---------------------------------------------------------

  pi.on("session_start", (event, ctx) => {
    if (ctx?.mode !== "tui") return;
    const nextId = (() => {
      try {
        return ctx?.sessionManager?.getSessionId?.();
      } catch {
        return undefined;
      }
    })();
    if (rootSession && typeof nextId === "string" && nextId !== sessionId) resetSessionState();
    rootSession = true;
    sessionManager = ctx.sessionManager;
    refreshSessionRef(ctx);
    refreshChanges();
    agentActive = ctx?.isIdle?.() === false;
    settled = false;
    schedulePublish();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    refreshSessionRef(ctx);
    agentActive = true;
    settled = false;
    if (errorCode) {
      errorCode = undefined;
      updateBlocker();
    }
    schedulePublish();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) return;
    agentActive = false;
    settled = true;
    pendingCalls.clear();
    if (activeSubs().length === 0 && !askActiveNow() && !reviewActive) {
      clearEmittedLabel();
      void publishNow();
    } else {
      schedulePublish();
    }
  });

  pi.on("session_shutdown", () => {
    rootSession = false;
    if (beatTimer) {
      clearInterval(beatTimer);
      beatTimer = undefined;
    }
    if (emittedLabel !== undefined) {
      emittedLabel = undefined;
      try {
        pi.events.emit(BLOCKED_EVENT, { active: false });
      } catch {}
    }
    resetSessionState();
  });
}
