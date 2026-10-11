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
//                       (normative running total — only `running` counts as
//                       executing; queued/waiting/pending never count. The
//                       consumer renders the oldest running role plus this
//                       total in parentheses only when above one.)
//   gentle_roles_v1   = CSV of canonical role slugs from TaskRecord.agent
//                       (oldest-first by immutable firstSeen, e.g.
//                       `worker,explorer` with worker oldest; null /
//                       clear when no active recognized roles). Authoritative
//                       for the visible activity state: explorer / worker /
//                       verify / judge / rdd (review agents) collapse to the
//                       sidebar role; unrecognized agents fall back to
//                       `working`.
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
//                       each, oldest-first, total ≤ ~512 chars; excess
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
//                       Gentle Agents lifecycle as custom messages
//                       (customType `gentle-agents.result`,
//                       details.gentleAgents {taskId,agent,status}) observed
//                       via `message_end`: ACTIVE statuses
//                       (running|queued) promote a background start into the
//                       task record, and Final statuses
//                       (completed|failed|cancelled|timed_out) replace the
//                       task record so the next beat counts only
//                       running|queued as active; the rendered card is never
//                       parsed. Pending subagent
//                       tool calls are label correlation only for a later
//                       gentleAgents.taskId result and never count.
//   ask               : ASK_USER_CHOICE_BLOCKED_EVENT (choice) +
//                       gentle-pi:ask-user-question:blocked (native
//                       questionnaire) + rpiv:ask-user:blocked (legacy
//                       questionnaire) — three independent legs sharing one
//                       intent episode, so closing one never erases another —
//                       +
//                       pi-permission-system:permission-request waiting state
//                       (tool-gated confirmation leg) + direct in-process
//                       `tool_execution_start` opens / `tool_execution_end`
//                       / `tool_result` closes for the exact Pi tools
//                       `ask_user_question` and `ask_user_choice`, tracked by
//                       toolCallId in a call-id set (a `tool_call` proposal
//                       alone never opens; an abort/error end with no result
//                       still closes). One intentId minted per
//                       ¬ask→ask episode; stable across beats in the episode.
//                       `gentle_review` starts (any operation, incl.
//                       ordinary-mode `start` / `select-intended-untracked`)
//                       never enter ask: the old consent-eligible pending
//                       signal fired before any outcome/UI, so a pre-granted
//                       session read blocked with no actual prompt. Only a
//                       real prompt leg (event, permission, structured tool,
//                       or in-flight UI span) holds ask.
//                       Generic Pi `ui_prompt_start` / `ui_prompt_end` spans
//                       gated on in-flight `tool_execution_start` /
//                       `tool_execution_end` (installed herdr-pi-tree
//                       herdr-prompt-state pattern): a prompt contributes to
//                       ask only when it opens while at least one tool
//                       execution is active, so commands/widgets that prompt
//                       while idle never become ask; nested/duplicate
//                       lifecycle coalesces into one boolean leg.
//                       Boundary: this leg observes only what Pi emits as a
//                       `tool_execution_start` event in this root extension.
//                       A host-side ask UI that emits no execution for those names
//                       is not observable here and stays covered only by the
//                       event-based legs above; no host-tool observation is
//                       claimed beyond the emitted events.
//   review            : ACKNOWLEDGED `gentle_review_capture` /
//                       `gentle_review_capture_group` EXECUTION, tracked by
//                       toolCallId from `tool_execution_start` (actual
//                       execution — a `tool_call` proposal alone never
//                       opens) to `tool_execution_end` / `tool_result`
//                       (thrown / cancelled / error closes clear on this
//                       beat — zero grace, per-id overlap). Acknowledged
//                       means the runtime args carry
//                       `reviewerRunAcknowledged: true`, authorizing exactly
//                       one host-relay reviewer run. Nothing else qualifies:
//                       forecast-only calls (no ack), correction-plan calls
//                       (`correctionLines` is native planning, never a
//                       reviewer), invalid combinations, `gentle_review` in
//                       any operation (inspect / status / start / ack /
//                       assess / select-intended-untracked / ...), and
//                       `gentle_review_scope` never enter. Legacy
//                       provider-rendered captures carry no ack key and the
//                       upstream sidebar publishes `reviewing` at any bound
//                       capture entry BEFORE the forecast branch runs, so no
//                       sidebar/event signal can prove a legacy reviewer
//                       route — unknown legacy shapes stay dark
//                       (documented conservative limitation; bindings stay
//                       opaque, never parsed). The reserved
//                       `gentle-pi:review:blocked` hook has no producer and
//                       is not observed. During capture-group's fan-out the
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
import * as fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { stripVTControlCharacters } from "node:util";
// Inlined presence reconciliation (T1). Single-file deployment boundary:
// the installed copy/symlink of this file ships WITHOUT the sibling
// helper module, so the bounded passive reader lives here and this file
// carries no relative imports. Logic mirrors the Gentle Shell orchestrator
// presence protocol (profile order, hex session-hash binding, header /
// activity validation, 15 s freshness); all `presence`-prefixed internals
// are collision-scoped to this block and the four exported helpers below
// are the only surface the harness extracts.

export const PRESENCE_HEADER_LIMIT = 16 * 1024;
export const PRESENCE_ACTIVITY_LIMIT = 16 * 1024 * 1024;
export const PRESENCE_FRESH_MS = 15_000;
export const PRESENCE_MAX_DIR_ENTRIES = 128;
export const PRESENCE_MAX_WITNESSED = 256;

const PRESENCE_HEX64 = /^[a-f0-9]{64}$/;
const PRESENCE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PRESENCE_KNOWN_STATUSES = new Set([
  "running",
  "queued",
  "waiting",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const FINAL_PRESENCE_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "timed_out",
]);
const PRESENCE_LOCAL_FINAL = new Set(["completed", "failed", "cancelled", "timed_out"]);
const PRESENCE_SUMMARY_KEYS = [
  "id",
  "agent",
  "label",
  "status",
  "model",
  "createdAt",
  "startedAt",
  "endedAt",
  "lastActivityAt",
];

function presenceIsObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function presenceIsNonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function presenceDigestHex(data) {
  return createHash("sha256").update(data).digest("hex");
}

function presenceSanitizedLabel(text) {
  const clean = stripVTControlCharacters(text)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return Array.from(clean).slice(0, 120).join("").trimEnd();
}

function presenceSessionHash(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined;
  return presenceDigestHex(sessionId);
}

function presenceSafeDirectory(path, owned, ownerMask) {
  let stat;
  try {
    stat = fs.lstatSync(path);
  } catch {
    return false;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  if (owned && process.platform !== "win32") {
    if (typeof stat.uid !== "number" || stat.uid !== process.getuid?.()) return false;
    if ((stat.mode & ownerMask) !== 0) return false;
  }
  return true;
}

export function resolvePresenceProfile(env = process.env, home = homedir()) {
  const gentle = env?.GENTLE_PI_AGENT_HOME;
  const piDir = env?.PI_CODING_AGENT_DIR;
  const hasGentle = typeof gentle === "string" && gentle.length > 0;
  const hasPiDir = typeof piDir === "string" && piDir.length > 0;
  if (hasGentle && hasPiDir && gentle !== piDir) return undefined;
  const selected = hasGentle ? gentle : hasPiDir ? piDir : join(home, ".pi", "agent");
  if (typeof selected !== "string" || selected.length === 0) return undefined;
  let expanded = selected;
  if (selected === "~") expanded = home;
  else if (selected.startsWith("~/") || (process.platform === "win32" && selected.startsWith("~\\"))) {
    expanded = join(home, selected.slice(2));
  }
  let real;
  try {
    real = fs.realpathSync(resolvePath(expanded));
  } catch {
    return undefined;
  }
  const shared = join(real, "gentle-agents");
  const presenceRoot = join(shared, "presence");
  if (!presenceSafeDirectory(real, false, 0)) return undefined;
  if (!presenceSafeDirectory(shared, true, 0o022)) return undefined;
  if (!presenceSafeDirectory(presenceRoot, true, 0o077)) return undefined;
  for (let path = dirname(real); ; path = dirname(path)) {
    if (!presenceSafeDirectory(path, false, 0)) return undefined;
    if (dirname(path) === path) break;
  }
  return presenceRoot;
}

function presenceBoundedRead(path, limit) {
  const before = fs.lstatSync(path);
  if (!before.isFile() || before.nlink !== 1) throw new Error("unsafe-file");
  if (process.platform !== "win32" && before.uid !== process.getuid?.()) {
    throw new Error("unsafe-file");
  }
  if (before.size > limit) throw new Error("oversized");
  const fd = fs.openSync(
    path,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsafe-file");
    if (process.platform !== "win32" && stat.uid !== process.getuid?.()) {
      throw new Error("unsafe-file");
    }
    if (stat.ino !== before.ino || stat.dev !== before.dev) throw new Error("unsafe-file");
    if (stat.size > limit) throw new Error("oversized");
    const bytes = Buffer.alloc(stat.size + 1);
    let used = 0;
    while (used < bytes.length) {
      const count = fs.readSync(fd, bytes, used, bytes.length - used, null);
      if (!count) break;
      used += count;
    }
    if (used !== stat.size) throw new Error("changed-file");
    return bytes.subarray(0, used);
  } finally {
    fs.closeSync(fd);
  }
}

function presenceHeaderFilename(header) {
  return `${header.sessionHash}.${header.incarnation}.header.json`;
}

function presenceValidHeader(value, sessionHash, entryName) {
  if (!presenceIsObject(value)) return false;
  const keys = Object.keys(value);
  const want = [
    "schema",
    "sessionHash",
    "incarnation",
    "label",
    "heartbeat",
    "generation",
    "counts",
    "digest",
    "unavailable",
  ];
  if (keys.length !== want.length || !want.every((key) => Object.hasOwn(value, key))) return false;
  if (value.schema !== 1) return false;
  if (value.sessionHash !== sessionHash || !PRESENCE_HEX64.test(value.sessionHash)) return false;
  if (typeof value.incarnation !== "string" || !PRESENCE_UUID.test(value.incarnation)) return false;
  if (typeof value.label !== "string" || value.label !== presenceSanitizedLabel(value.label)) return false;
  if (!presenceIsNonNegativeInt(value.heartbeat)) return false;
  if (!presenceIsNonNegativeInt(value.generation) || value.generation <= 0) return false;
  const counts = value.counts;
  if (!presenceIsObject(counts)) return false;
  const countKeys = Object.keys(counts);
  if (
    countKeys.length !== 4 ||
    !["running", "queued", "waiting", "finished"].every((key) => presenceIsNonNegativeInt(counts[key]))
  ) {
    return false;
  }
  const digestOk =
    value.unavailable === null && typeof value.digest === "string" && PRESENCE_HEX64.test(value.digest);
  const unavailableOk =
    value.unavailable === "activity-too-large" && value.digest === null;
  if (!digestOk && !unavailableOk) return false;
  if (presenceHeaderFilename(value) !== entryName) return false;
  return true;
}

function presenceValidTask(row) {
  if (!presenceIsObject(row)) return false;
  const keys = Object.keys(row);
  if (keys.length !== 2 || !Object.hasOwn(row, "summary") || !Object.hasOwn(row, "thread")) {
    return false;
  }
  const summary = row.summary;
  if (!presenceIsObject(summary)) return false;
  const summaryKeys = Object.keys(summary);
  if (summaryKeys.length !== PRESENCE_SUMMARY_KEYS.length || !PRESENCE_SUMMARY_KEYS.every((key) => Object.hasOwn(summary, key))) {
    return false;
  }
  for (const key of ["id", "agent", "label", "status", "model"]) {
    if (typeof summary[key] !== "string") return false;
  }
  if (!PRESENCE_KNOWN_STATUSES.has(summary.status)) return false;
  if (!presenceIsNonNegativeInt(summary.createdAt) || !presenceIsNonNegativeInt(summary.lastActivityAt)) return false;
  for (const key of ["startedAt", "endedAt"]) {
    if (summary[key] !== null && !presenceIsNonNegativeInt(summary[key])) return false;
  }
  const thread = row.thread;
  if (!presenceIsObject(thread)) return false;
  if (!presenceIsNonNegativeInt(thread.version) || !presenceIsNonNegativeInt(thread.dropped)) return false;
  if (!Array.isArray(thread.items)) return false;
  return true;
}

export function readPresenceSnapshot(sessionId, now = Date.now(), opts = {}) {
  const sessionHash = presenceSessionHash(sessionId);
  if (!sessionHash) return undefined;
  if (typeof now !== "number" || !Number.isSafeInteger(now) || now < 0) return undefined;
  let presenceRoot;
  try {
    presenceRoot = resolvePresenceProfile(opts.env ?? process.env, opts.home ?? homedir());
  } catch {
    return undefined;
  }
  if (!presenceRoot) return undefined;
  let names;
  try {
    const dir = fs.opendirSync(presenceRoot);
    try {
      names = [];
      for (;;) {
        const entry = dir.readSync();
        if (!entry) break;
        names.push(entry.name);
        if (names.length > PRESENCE_MAX_DIR_ENTRIES) return undefined;
      }
    } finally {
      dir.closeSync();
    }
  } catch {
    return undefined;
  }
  let match;
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".header.json")) continue;
    if (!name.startsWith(`${sessionHash}.`)) continue;
    let header;
    try {
      header = JSON.parse(presenceBoundedRead(join(presenceRoot, name), PRESENCE_HEADER_LIMIT).toString("utf8"));
    } catch {
      continue;
    }
    if (!presenceValidHeader(header, sessionHash, name)) continue;
    // Selection eligibility before ambiguity count: a stale or unavailable
    // leftover prior incarnation carries no live evidence and must neither
    // suppress nor outrank the fresh current owner. Only fresh, available
    // headers elect; two elected owners stay ambiguous (fail closed).
    if (!(now >= header.heartbeat && now - header.heartbeat <= PRESENCE_FRESH_MS)) continue;
    if (header.unavailable !== null) continue;
    if (match) return undefined;
    match = { name, header };
  }
  if (!match) return undefined;
  const { header } = match;
  let raw;
  try {
    raw = presenceBoundedRead(
      join(presenceRoot, `${header.sessionHash}.${header.incarnation}.activity.json`),
      PRESENCE_ACTIVITY_LIMIT,
    );
  } catch {
    return undefined;
  }
  if (presenceDigestHex(raw) !== header.digest) return undefined;
  let envelope;
  try {
    envelope = JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
  if (!presenceIsObject(envelope)) return undefined;
  const envelopeKeys = Object.keys(envelope);
  const want = ["schema", "sessionHash", "incarnation", "generation", "activity"];
  if (envelopeKeys.length !== want.length || !want.every((key) => Object.hasOwn(envelope, key))) {
    return undefined;
  }
  if (envelope.schema !== 1) return undefined;
  if (envelope.sessionHash !== header.sessionHash) return undefined;
  if (envelope.incarnation !== header.incarnation) return undefined;
  if (envelope.generation !== header.generation) return undefined;
  const activity = envelope.activity;
  if (!presenceIsObject(activity) || !Array.isArray(activity.tasks)) return undefined;
  if (Object.keys(activity).length !== 1) return undefined;
  const tasks = [];
  let activeCount = 0;
  for (const row of activity.tasks) {
    if (!presenceValidTask(row)) return undefined;
    const { summary } = row;
    // createdAt/startedAt ride along so the producer can order by immutable
    // first-seen (T2b): sound same-session timestamps improve ordering,
    // otherwise the local firstSeen stands (fallback, never recency).
    tasks.push({
      id: summary.id,
      agent: summary.agent,
      label: summary.label,
      status: summary.status,
      createdAt: summary.createdAt,
      startedAt: summary.startedAt,
    });
    if (!FINAL_PRESENCE_STATUSES.has(summary.status)) activeCount += 1;
  }
  if (activeCount !== header.counts.running + header.counts.queued + header.counts.waiting) {
    return undefined;
  }
  return {
    sessionHash: header.sessionHash,
    incarnation: header.incarnation,
    generation: header.generation,
    heartbeat: header.heartbeat,
    tasks,
  };
}

export function createPresenceReconciler() {
  return { binding: undefined, lastGeneration: 0, seen: new Map() };
}

function presenceBindingKey(snapshot) {
  return `${snapshot.sessionHash}.${snapshot.incarnation}`;
}

export function reconcilePresenceTasks(tasks, reconciler, snapshot, now = Date.now()) {
  const none = { applied: [] };
  if (!presenceIsObject(reconciler) || !(reconciler.seen instanceof Map)) return none;
  if (!(tasks instanceof Map)) return none;
  if (!presenceIsObject(snapshot) || !Array.isArray(snapshot.tasks)) return none;
  if (typeof snapshot.generation !== "number" || !presenceIsNonNegativeInt(snapshot.generation)) return none;
  if (typeof snapshot.heartbeat !== "number" || !presenceIsNonNegativeInt(snapshot.heartbeat)) return none;
  const key = presenceBindingKey(snapshot);
  if (typeof snapshot.sessionHash !== "string" || typeof snapshot.incarnation !== "string") return none;
  if (reconciler.binding !== key) {
    reconciler.binding = key;
    reconciler.lastGeneration = 0;
    reconciler.seen = new Map();
  }
  if (snapshot.generation <= reconciler.lastGeneration) return none;
  // Generation — never the header heartbeat — ages activity. The header is
  // rewritten on every 5 s heartbeat tick without touching the activity
  // file (its mtime tracks liveness too), so heartbeat freshness says
  // nothing about when a task entry was written; wall-clock is only used to
  // reject stale headers on read, never to authorize completion here. Each
  // witness binds the immutable execution epoch of the task (an integer
  // counter that advances only on a new launch, resume, or inactive→active
  // transition — never on same-status progress reads or Date.now recency),
  // captured alongside the generation that listed it active: any new local
  // execution starts a new epoch the old witness cannot authorize. Stale
  // witness records are retained but never consulted for another epoch, and
  // skip paths never delete witness state — only a successful apply
  // resolves an entry.
  const witnessFor = (id) => {
    const record = reconciler.seen.get(id);
    const local = tasks.get(id);
    if (!record || !presenceIsObject(local)) return undefined;
    const epoch = typeof local.epoch === "number" ? local.epoch : 0;
    return record.epoch === epoch ? record : undefined;
  };
  const applied = [];
  const listedNow = new Set();
  // T2b sound timestamp for first-seen ordering: a same-binding presence
  // createdAt (fallback startedAt) that is a positive int not newer than
  // the snapshot heartbeat. Earlier sound timestamps correct a late local
  // first-sighting; later ones never move firstSeen (fallback stands).
  const soundFirstSeen = (entry) => {
    for (const key of ["createdAt", "startedAt"]) {
      const value = entry?.[key];
      if (
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0 &&
        value <= snapshot.heartbeat
      ) {
        return value;
      }
    }
    return undefined;
  };
  for (const entry of snapshot.tasks) {
    if (!presenceIsObject(entry) || typeof entry.id !== "string") continue;
    listedNow.add(entry.id);
    let local = tasks.get(entry.id);
    // First-seen refinement (T2b, epoch-preserving): adopt a sound earlier
    // presence timestamp for ordering only — never a recency bump, never
    // an epoch change, never witness state.
    if (local && presenceIsObject(local)) {
      const sound = soundFirstSeen(entry);
      const current =
        typeof local.firstSeen === "number" ? local.firstSeen : undefined;
      if (sound !== undefined && (current === undefined || sound < current)) {
        local = { ...local, firstSeen: sound };
        tasks.set(entry.id, local);
      }
    }
    if (FINAL_PRESENCE_STATUSES.has(entry.status)) {
      if (!local || PRESENCE_LOCAL_FINAL.has(local.status)) continue;
      const witness = witnessFor(entry.id);
      // Race-safe epoch binding: the terminal status must come from
      // activity strictly newer than the witness for THIS local epoch. The
      // live publisher omits finals, so a first-ever terminal with no
      // witness is an older epoch's leftover and fails closed. A previous
      // epoch's terminal status resurfacing after a resume is likewise
      // skipped with the witness record preserved untouched.
      if (witness === undefined || snapshot.generation <= witness.gen) continue;
      tasks.set(entry.id, { ...local, status: entry.status });
      reconciler.seen.delete(entry.id);
      applied.push({ id: entry.id, status: entry.status, via: "explicit" });
    } else if (PRESENCE_KNOWN_STATUSES.has(entry.status)) {
      if (local) {
        reconciler.seen.set(entry.id, {
          gen: snapshot.generation,
          epoch: typeof local.epoch === "number" ? local.epoch : 0,
        });
      }
    }
  }
  for (const [id, local] of tasks) {
    if (!presenceIsObject(local) || PRESENCE_LOCAL_FINAL.has(local.status)) continue;
    if (listedNow.has(id)) continue;
    // Absence completes only with a present witness for the CURRENT epoch
    // plus a strictly newer absent generation: the task was active in older
    // activity of this binding and is gone from newer activity without any
    // newer local execution in between (progress reads never void it).
    const witness = witnessFor(id);
    if (witness === undefined || snapshot.generation <= witness.gen) continue;
    tasks.set(id, { ...local, status: "completed" });
    reconciler.seen.delete(id);
    applied.push({ id, status: "completed", via: "absence" });
  }
  while (reconciler.seen.size > PRESENCE_MAX_WITNESSED) {
    reconciler.seen.delete(reconciler.seen.keys().next().value);
  }
  reconciler.lastGeneration = snapshot.generation;
  return { applied };
}

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
const ASK_QUESTION_EVENT = "gentle-pi:ask-user-question:blocked";
const QUESTIONNAIRE_EVENT = "rpiv:ask-user:blocked";
const PERMISSION_EVENT = "pi-permission-system:permission-request";
// Neither `gentle-pi:review:blocked` (reserved hook: no producer exists) nor
// `gentle-ai:review-sidebar` snapshots (entry publishes fire before the
// forecast branch, so they prove no reviewer route) are observed: no handler
// is registered for either, and no constants are retained for them.
// Exact Pi tool registrations verified in the installed Gentle Shell source
// (extensions/gentle-ai.ts): only the two capture tools can execute a
// reviewer run. `gentle_review` (controller: inspect / status / start /
// ack / assess / select-intended-untracked / ...) and `gentle_review_scope`
// (read-only page read) never execute reviewers and never enter this leg.
const REVIEW_TOOLS = new Set([
  "gentle_review_capture",
  "gentle_review_capture_group",
]);
// Acknowledged capture args (runtime `tool_execution_start` args): the call
// carries `reviewerRunAcknowledged: true`, authorizing exactly one host-relay
// reviewer run (capture or group). Nothing else qualifies: `correctionLines`
// is native correction planning (captureCorrectionPlan), never a reviewer;
// both keys together is rejected upstream without executing; a call with no
// ack key is forecast-only or a legacy provider-rendered vector whose route
// is unprovable (sidebar `reviewing` fires at any bound capture entry BEFORE
// the forecast branch, so it proves nothing) — never acknowledged here (fail
// closed). Anything unparseable is unacknowledged.
// Direct Pi ask tools observed via the execution seam only (exact
// registrations `ask_user_question`, `ask_user_choice`): a
// `tool_execution_start` opens, `tool_execution_end` / `tool_result`
// closes (a `tool_call` proposal alone never opens; an abort/error end
// with no result still closes). While any tracked execution is pending
// the ask leg holds `ask:`; overlapping calls are counted by call id,
// never by a single boolean.
const ASK_TOOLS = new Set(["ask_user_question", "ask_user_choice"]);
function isAcknowledgedCaptureArgs(args) {
  if (!isRecord(args)) return false;
  // `correctionLines` anywhere disqualifies: it is native correction
  // planning (or an invalid combination upstream), never a reviewer run.
  if (args.correctionLines !== undefined) return false;
  return args.reviewerRunAcknowledged === true;
}
const CHANGE_EVENT = "gentle-pi:session-change";
const CHANGE_ENTRY = "gentle-pi.session-change/v1";
const BLOCKED_EVENT = "herdr:blocked";
// Durable ask token name (DESIGN §4.3): session-bound + TTL-fresh
// `<hash>:<intentId>:<expiry>`, emitted on every beat while ask is active.
const ASK_TOKEN = "gentle_ask_v1";
// Durable review token name: session-bound + TTL-fresh
// `<hash>:<reviewId>:<expiry>`, emitted on every beat while effective
// review is active (acknowledged capture/group execution only). Null /
// clear the beat the last execution resolves — NO GRACE, no timers.
const REVIEW_TOKEN = "gentle_review_v1";

const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const COUNT_RE = /^(0|[1-9]\d{0,15})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE_TASK = new Set(["running", "queued"]);
// T2b display set: only `running` counts as executing for the visible
// role + total count. Queued/waiting never count and never supply a role;
// pending tool calls stay role-only hints with no double count. ACTIVE_TASK
// above is unchanged for epochs/witness/marker coverage (T1 preserved).
const FINAL_TASK = new Set(["completed", "failed", "cancelled", "timed_out"]);
const AGENTS_RESULT_TYPE = "gentle-agents.result";

// Immutable task execution epoch, separate from recency (`at`, which bumps on
// every observation) and from display order (`firstSeen`, which never moves).
// A new epoch starts only on an actual new execution: first sighting of the id (new launch — upstream
// launch and subagent_continue both allocate new task ids, so a fresh id is
// a fresh execution), an explicit resume result (subagent_continue), or a
// transition from inactive (waiting or final) into active (running|queued).
// Same-status progress reads (running→running status polls/results) keep the
// epoch so they never void a presence witness. Unknown→active is status
// discovery within one execution, not a new epoch. Integer counter, never a
// timestamp, so no Date.now collision can authorize an older execution.
function taskEpochFor(previous, status, isResume) {
  const prevEpoch = typeof previous?.epoch === "number" ? previous.epoch : 0;
  if (!previous) return 0;
  if (isResume) return prevEpoch + 1;
  const wasInactive = previous.status === "waiting" || FINAL_TASK.has(previous.status);
  if (wasInactive && ACTIVE_TASK.has(status)) return prevEpoch + 1;
  return prevEpoch;
}

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

// Unknown-agent fallback (slug rules, 32-char bound): a delegation agent
// outside the known vocabulary is NOT collapsed to a generic word — its
// original name is sanitized to a lowercase `[a-z0-9_-]` slug (runs of
// other characters become one `-`, leading/trailing `-` stripped,
// truncated to 32 chars) and travels as the visible role word. Returns
// undefined when nothing salvageable remains. Pure and exported for tests.
export function sanitizeAgentSlug(agent) {
  if (typeof agent !== "string" || agent.length === 0) return undefined;
  const slug = stripVTControlCharacters(agent)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug.length > 0 ? slug : undefined;
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
// Native state owner (always on): this extension is the single publisher of
// pane.report_agent (working|blocked|idle) alongside its
// pane.report_metadata beats. The managed native extension file is deleted
// and the user controls installs (no auto-restore), so no opt-in flag
// gates publishing. Transport mirrors the metadata socket IPC
// (pane.report_agent with pane_id + session path-or-id binding + monotonic
// seq), serial latest-wins coalesced queue with bounded retries, no CLI
// fallback (native CLI shape unverified), no notification methods, never
// done/finished (only working|blocked|idle; host idle->finished mapping
// unverified) and no new imports (self-contained single file). Do NOT
// reinstall the native publisher from Herdr: two publishers for the same
// pane collide (dual-publish).
// ---------------------------------------------------------------------------

export const NATIVE_STATES = ["working", "blocked", "idle"];
const NATIVE_MAX_ATTEMPTS = 2;

// Principal-gated native state (pure, testable): blocked on a real
// principal-stopped error OR an actual human-wait intervention leg
// (ask/choice/question/questionnaire/permission — never
// review/RDD execution, which stays working and silent); working while the
// principal is active OR running/queued delegates exist OR pending launches
// exist OR review execution holds; idle ONLY on authoritative principal
// settled plus zero running+queued plus zero pending plus no human-wait
// prompt and no review execution. Never infer terminal from child
// completion, timeout, or count0 alone (settled required). Never
// done/finished (only working|blocked|idle) and never a notification
// method — the host owns finished text plus toast/sound, and ask
// notification dedup stays consumer-side (DESIGN §7).
export function computeNativeState({
  agentActive,
  settled,
  activeCount,
  pendingCount,
  askActive,
  reviewActive,
  hasError,
}) {
  if (hasError) return "blocked";
  if (askActive) return "blocked";
  if (agentActive || activeCount > 0 || pendingCount > 0 || reviewActive) {
    return "working";
  }
  if (
    settled &&
    !agentActive &&
    activeCount === 0 &&
    pendingCount === 0 &&
    !askActive &&
    !reviewActive
  ) {
    return "idle";
  }
  return undefined;
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

  // Blocker legs. ask combines choice + native questionnaire + legacy
  // questionnaire + tool-gated confirmation + direct ask_user_* tool calls
  // in flight; exactly one intentId per ¬ask→ask episode. The three event
  // legs keep independent booleans so closing one never erases another.
  // askToolCalls tracks live `ask_user_question`/`ask_user_choice` calls by toolCallId so
  // overlapping calls stay correct; cleared on tool_result (by call id),
  // session reset, and shutdown. Event legs and permission/review
  // precedence (error > ask > review) are unchanged.
  let choiceActive = false;
  let questionActive = false;
  let questionnaireActive = false;
  const permissionPending = new Set();
  const askToolCalls = new Map(); // toolCallId -> at (ms)
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
  // Review leg: bounded acknowledged-execution signal. reviewCalls tracks
  // live ACKNOWLEDGED capture/group executions by toolCallId, opened only
  // on `tool_execution_start` with `reviewerRunAcknowledged: true` (a
  // `tool_call` proposal alone never opens) and closed by
  // `tool_execution_end` / `tool_result` by call id (thrown / cancelled /
  // error closes clear on this beat — zero grace, per-id overlap).
  // reviewActive holds exactly while the map is non-empty, so `review:`
  // emits only for genuine reviewer execution. `gentle_review` (any
  // operation) and `gentle_review_scope` never enter. During a
  // capture-group run the single parent capture-group call covers the
  // whole multi-reviewer span. reviewId stays a sanitized correlation
  // id; never a provider verdict.
  let reviewActive = false;
  let reviewId;
  const reviewCalls = new Map(); // toolCallId -> at (ms)

  function syncReviewActive() {
    reviewActive = reviewCalls.size > 0;
  }
  // Error latch: cleared on the next agent_start (fresh snapshot).
  let errorCode;
  let emittedLabel;

  let changes = { files: 0, added: 0, deleted: 0 };
  // T1 passive presence reconciliation state, per root-session binding
  // (session hash + incarnation) with monotonic generation. Reset with the
  // session so a new session never inherits another binding's witness set.
  let presenceReconciler = createPresenceReconciler();
  let transportFails = 0;
  let beatTimer;
  let publishQueued = false;
  let publishInFlight = false;
  // Native owner queue (always on): monotonic seq per logical report,
  // serial latest-wins coalescing, deduped emit-once per state+message.
  // Seq is never reset (host ordering); pending/last reset with the
  // session.
  let nativeSeq = 0;
  let nativeInFlight = false;
  let nativePending = null;
  let nativeLastOk = undefined;
  let nativeSettledPending = false;
  // T2 native-only terminal guard: agent_settled clears the metadata
  // pending-launch hint below, but a settle that observes in-flight
  // launches retains pending evidence here so native idle gating stays
  // working until those launches resolve. Metadata/tasks untouched; the
  // guard clears when a launch resolves, on agent_start, and with the
  // session (seq itself never resets).

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
      questionActive ||
      questionnaireActive ||
      permissionPending.size > 0 ||
      askToolCalls.size > 0 ||
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

  // Authoritative TaskStore projection for liveness/marker coverage:
  // every entry whose status is running|queued is active here (T1
  // epochs/witness unchanged). Display count/roles use runningSubs()
  // below (running only). Pending tool calls never count;
  // finished/failed/cancelled/waiting entries never count.
  // WHY pending calls stay out of the count: task-mode `subagent_run` stays
  // in flight without a TaskStore record until it returns tool_result, so
  // counting pending calls would inflate `gentle_work_v1` with estimates.
  // The count is normative; role display below is the
  // only consumer of the pending hint.
  // Order is oldest-first by immutable firstSeen (fallback at): progress
  // reads bump `at` but never move `firstSeen`, so they never reorder.
  function activeSubs() {
    const out = [];
    for (const [id, task] of tasks) {
      if (ACTIVE_TASK.has(task.status)) {
        out.push({
          id,
          agent: task.agent,
          label: task.label,
          at: task.at,
          firstSeen: typeof task.firstSeen === "number" ? task.firstSeen : task.at,
        });
      }
    }
    out.sort((a, b) => a.firstSeen - b.firstSeen);
    return out;
  }

  // T2b display projection: only `running` counts as executing.
  // Queued/waiting never count and never supply a role; the total here is
  // the consumer's `(n)` suffix source (suffix only when > 1).
  function runningSubs() {
    const out = [];
    for (const [id, task] of tasks) {
      if (task.status === "running") {
        out.push({
          id,
          agent: task.agent,
          label: task.label,
          at: task.at,
          firstSeen: typeof task.firstSeen === "number" ? task.firstSeen : task.at,
        });
      }
    }
    out.sort((a, b) => a.firstSeen - b.firstSeen);
    return out;
  }

  // Role-only hint from in-flight `subagent_run`/`subagent_continue` tool
  // calls: task-mode launches stay in flight (no tool_result yet, hence no
  // TaskStore record) even though `tool_call` input already carries the
  // exact agent name. Publishing that agent's role slug keeps the sidebar
  // from showing generic `working` during execution. This is display-only:
  // it never enters `gentle_work_v1` or any displayed count, and each hint
  // is cleared when its tool_result arrives, the call is cancelled, or the
  // agent settles. The hint carries the mapped word or the sanitized
  // passthrough slug (unsalvageable names yield no hint and read gentle).
  function pendingRoleSubs() {
    const out = [];
    for (const pending of pendingCalls.values()) {
      if (agentToRole(pending.agent) !== undefined) {
        out.push({ agent: pending.agent, label: pending.label, at: pending.at });
      }
    }
    out.sort((a, b) => a.at - b.at);
    return out;
  }

  // Merged role sources, oldest-first by first-seen: authoritative running
  // TaskStore subs plus pending role hints. Authoritative entries win on
  // duplicates via rolesCsv dedup (first wins = oldest wins).
  function mergedRoleSubs() {
    const merged = [...runningSubs(), ...pendingRoleSubs()];
    merged.sort((a, b) => (a.firstSeen ?? a.at) - (b.firstSeen ?? b.at));
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

  // Unknown-agent fallback (slug rules, 32-char bound) lives at module
  // scope as sanitizeAgentSlug; agentToRole calls it below.
  // Authoritative role signal from TaskRecord.agent (never task labels):
  // the actual package agent `gentle-ai-explore` (verified in the project
  // registry `~/.pi/agent`, alongside `gentle-ai-worker`/`gentle-ai-verify`/
  // review agents) maps to `explorer`; the legacy `gentle-ai-explorer` alias
  // is preserved for compatibility. Exact worker/verify agents map 1:1;
  // `jd-judge-a`, `jd-judge-b`, and `jd-fix-agent` (plus the `jd-judge-` /
  // `jd-fix-` families) map to the distinct `judge` slug — never `rdd`;
  // the gentle-ai-review* family, a bare `review` agent, or any role
  // containing `review` collapses to the single `rdd` slug. Anything else
  // keeps its original sanitized name via sanitizeAgentSlug (never a
  // generic collapse). No counts, no labels enter the
  // signal.
  function agentToRole(agent) {
    if (typeof agent !== "string" || agent.length === 0) return undefined;
    if (agent === "gentle-ai-explore" || agent === "gentle-ai-explorer") return "explorer";
    if (agent === "gentle-ai-worker") return "worker";
    if (agent === "gentle-ai-verify") return "verify";
    if (
      agent === "jd-judge-a" ||
      agent === "jd-judge-b" ||
      agent === "jd-fix-agent" ||
      agent.startsWith("jd-judge-") ||
      agent.startsWith("jd-judge_") ||
      agent.startsWith("jd-fix-") ||
      agent.startsWith("jd-fix_")
    ) {
      return "judge";
    }
    if (
      agent === "gentle-ai-review" ||
      agent.startsWith("gentle-ai-review-") ||
      agent.startsWith("gentle-ai-review_") ||
      /review/i.test(agent)
    ) {
      return "rdd";
    }
    // The bare visible word `working` is banned: a sanitized unknown slug
    // exactly equal to `working` degrades to no role (generic `gentle`)
    // in metadata roles and the native message alike.
    const slug = sanitizeAgentSlug(agent);
    return slug === "working" ? undefined : slug;
  }

  // Bounded CSV of role words, oldest-first (subs already arrive
  // oldest-first by immutable firstSeen), deduped: known agents map to
  // their short words, unknown agents to their sanitized slugs. Empty when
  // no active roles at all — the caller null-clears the token so a
  // new/reloaded session never retains a prior roles value.
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
    // Liveness/marker coverage stays running|queued (T1); the visible
    // count + roles are running-only (T2b executing set).
    const subs = activeSubs();
    const running = runningSubs();
    const tokens = {};
    const count = String(running.length);
    if (COUNT_RE.test(count)) tokens.gentle_work_v1 = `${sessionHash}:${count}:${expiry}`;
    const csv = namesCsv(running);
    // Clear (null) when the authoritative active TaskStore list has no
    // labels, so a new/reloaded session never retains a prior names token.
    // Socket metadata carries null for clear; the CLI fallback maps null to
    // `--clear-token <name>`.
    if (csv.length > 0) tokens.gentle_names_v1 = csv;
    else tokens.gentle_names_v1 = null;
    // Authoritative role signal for the visible activity state (DESIGN
    // §4.3), merged with the in-flight pending role hint: running TaskStore
    // roles (oldest-first) plus the exact pending subagent agent while its
    // tool call is in flight (task-mode launches have no TaskStore record
    // yet). The hint is role-only — the count above stays running-only —
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
    // review is active, null (clear) the beat the last execution resolves — NO
    // GRACE, no timers, no agent_settled holds. Reuses the sanitized
    // reviewId episode minted by updateBlocker (minted here too so the
    // token never lags the label); never a verdict, authority, lineage,
    // lens, or provider result.
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
    // review (executing acknowledged capture/group calls) keeps the beat
    // alive so `review:` and the durable review token publish — NO GRACE:
    // the leg drops when the last execution ends or resolves.
    return (
      agentActive ||
      activeSubs().length > 0 ||
      pendingCalls.size > 0 ||
      askToolCalls.size > 0 ||
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

  // N1 parity report: state + message. Working carries the SPECIFIC
  // working role in the message from the same oldest-running role
  // resolution as the metadata roles token (authoritative running roles
  // only — never a pending hint, never bare generic working; with no
  // running role the message is `gentle`; machine keys unchanged). Blocked carries the
  // corresponding herdr:blocked label (ask:<intentId> / error:<code> —
  // never review:, never done/finished). Idle carries no message. No
  // notification method is ever emitted from this code (state-only
  // pane.report_agent; host owns finished text + toast/sound, ask dedup
  // stays consumer-side per DESIGN §7).
  function desiredNativeReport() {
    if (!rootSession) return undefined;
    const state = computeNativeState({
      agentActive,
      settled,
      activeCount: activeSubs().length,
      pendingCount: pendingCalls.size + (nativeSettledPending ? 1 : 0),
      askActive: askActiveNow(),
      reviewActive,
      hasError: !!errorCode,
    });
    if (!state) return undefined;
    if (state === "blocked") {
      ensureAskIntent();
      return { state, message: desiredLabel() };
    }
    if (state === "working") {
      // N1 parity: the message is always per-agent activity — the oldest
      // RUNNING role only (authoritative TaskStore records; a pending
      // launch hint is not a role and never leaks into the message). With
      // no running role the message is `gentle`: visible generic activity
      // is never bare `working`. Machine keys unchanged.
      const roles = rolesCsv(runningSubs());
      const first = roles.split(",")[0];
      if (first) return { state, message: first };
      return { state, message: "gentle" };
    }
    return { state, message: undefined };
  }

  function nativeBinding() {
    if (typeof sessionFile === "string" && sessionFile.length > 0) {
      return { agent_session_path: sessionFile };
    }
    if (typeof sessionId === "string" && sessionId.length > 0) {
      return { agent_session_id: sessionId };
    }
    return null;
  }

  // LIVE-1: the agent_session binding lives in pane.report_agent_session,
  // not in metadata token values (which only carry the derived hash the
  // consumer cannot validate without the binding). The deleted managed
  // publisher sent it on session_start (with session_start_source) and on
  // every agent_start; without it Herdr shows no agent_session for the
  // fresh pane and the sidebar stays static while metadata beats flow.
  // Identity mirrors the managed publisher (source herdr:pi, agent pi)
  // so the host sees the same single publisher, never a dual identity.
  // Session reports carry their own monotonic seq so the pinned
  // pane.report_agent state seq still starts at 1.
  const NATIVE_SOURCE = "herdr:pi";
  const NATIVE_AGENT = "pi";
  let nativeSessionSeq = 0;

  async function reportSession(sessionStartSource) {
    if (!enabled()) return;
    const binding = nativeBinding();
    if (!binding) return;
    nativeSessionSeq += 1;
    const seq = nativeSessionSeq;
    const params = {
      pane_id: paneId,
      source: NATIVE_SOURCE,
      agent: NATIVE_AGENT,
      seq,
      ...binding,
    };
    if (typeof sessionStartSource === "string" && sessionStartSource.length > 0) {
      params.session_start_source = sessionStartSource;
    }
    const base = `${SOURCE}:session:${seq}`;
    await sendRequestAttempt(
      {
        id: `${base}:0:${randomUUID()}`,
        method: "pane.report_agent_session",
        params,
      },
      500,
    ).catch(() => false) ||
      (await sendRequestAttempt(
        {
          id: `${base}:1:${randomUUID()}`,
          method: "pane.report_agent_session",
          params,
        },
        1500,
      ).catch(() => false));
  }

  async function drainNative() {
    if (!enabled()) return;
    if (nativeInFlight) return;
    nativeInFlight = true;
    try {
      while (nativePending !== null) {
        const next = nativePending;
        nativePending = null;
        const binding = nativeBinding();
        if (!binding) continue;
        if (!NATIVE_STATES.includes(next.state)) continue;
        nativeSeq += 1;
        const seq = nativeSeq;
        let ok = false;
        for (let attempt = 0; attempt < NATIVE_MAX_ATTEMPTS && !ok; attempt += 1) {
          ok = await sendRequestAttempt(
            {
              id: `${SOURCE}:native:${seq}:${attempt}:${randomUUID()}`,
              method: "pane.report_agent",
              params: {
                pane_id: paneId,
                source: NATIVE_SOURCE,
                agent: NATIVE_AGENT,
                state: next.state,
                message: next.message,
                ...binding,
                seq,
              },
            },
            attempt === 0 ? 500 : 1500,
          );
        }
        if (ok) nativeLastOk = next;
      }
    } finally {
      nativeInFlight = false;
      if (nativePending !== null) void drainNative();
    }
  }

  function queueNative() {
    if (!enabled()) return;
    const want = desiredNativeReport();
    if (!want) return;
    if (
      nativeLastOk !== undefined &&
      want.state === nativeLastOk.state &&
      want.message === nativeLastOk.message &&
      nativePending === null &&
      !nativeInFlight
    ) {
      return;
    }
    if (
      nativePending !== null &&
      nativePending.state === want.state &&
      nativePending.message === want.message
    ) {
      return;
    }
    nativePending = want;
    void drainNative();
  }

  async function publishNow() {
    if (!rootSession) return;
    if (publishInFlight) {
      // LIVE-3: an in-flight beat must never swallow a newer snapshot —
      // notably the true-empty settle idle, which has no later trigger
      // to repair it. Coalesce into one follow-up beat instead of
      // dropping (snapshots are idempotent full-state; idle-once dedup
      // is unchanged in queueNative).
      publishQueued = true;
      return;
    }
    reconcilePresence();
    queueNative();
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

  // T1 passive presence reconciliation: resolve explicit terminal task
  // statuses (and witnessed absence in a newer complete snapshot) from the
  // Gentle Shell presence files before building tokens, so delegate
  // completion never waits on deferred chat delivery. Passive and bounded:
  // no timers, no writes, no imported upstream dependencies; any unreadable
  // or inapplicable snapshot leaves tasks untouched. Count, TTL, and
  // transport semantics below are unchanged.
  function reconcilePresence() {
    if (!sessionId) return;
    let snapshot;
    try {
      snapshot = readPresenceSnapshot(sessionId, Date.now());
    } catch {
      return;
    }
    if (!snapshot) return;
    let applied = [];
    try {
      applied = reconcilePresenceTasks(tasks, presenceReconciler, snapshot, Date.now()).applied;
    } catch {
      return;
    }
    if (!Array.isArray(applied) || applied.length === 0) return;
    // An explicitly failed delegate latches the error leg exactly like a
    // failed tool_result/message_end; absence-driven completion carries no
    // known terminal state and never latches.
    if (!errorCode && applied.some((entry) => entry && entry.status === "failed")) {
      errorCode = "task-failed";
      updateBlocker();
    }
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
    questionActive = false;
    questionnaireActive = false;
    permissionPending.clear();
    askToolCalls.clear();
    runningTools.clear();
    uiPromptActive = false;
    askIntentId = undefined;
    reviewCalls.clear();
    reviewActive = false;
    reviewId = undefined;
    presenceReconciler = createPresenceReconciler();
    nativePending = null;
    nativeLastOk = undefined;
    nativeSettledPending = false;
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

  // Native questionnaire leg (first-party ask_user_question): its own
  // boolean, OR-combined like the other two, so closing any one leg never
  // erases another still-open leg. All three share one intent episode.
  pi.events.on(ASK_QUESTION_EVENT, (event) => {
    if (!rootSession || !isRecord(event) || typeof event.active !== "boolean") return;
    if (event.active === questionActive) return;
    questionActive = event.active;
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
    // Structured ask tools open ONLY on genuine execution (never on
    // `tool_call` proposal), keyed by call id so the matching end or
    // result closes them.
    if (typeof event.toolName === "string" && ASK_TOOLS.has(event.toolName)) {
      askToolCalls.set(event.toolCallId, Date.now());
      if (askToolCalls.size > MAX_TRACKED_TASKS) {
        const oldest = askToolCalls.keys().next().value;
        askToolCalls.delete(oldest);
      }
      updateBlocker();
      schedulePublish();
    }
    // Review opens ONLY on actual acknowledged execution of a capture/group
    // tool. A `tool_call` proposal alone never opens — forecast-only calls,
    // correction-plan calls, `gentle_review` in any operation, and
    // `gentle_review_scope` never enter. Keyed by call id so the matching
    // end closes it.
    if (
      typeof event.toolName !== "string" ||
      !REVIEW_TOOLS.has(event.toolName) ||
      !isAcknowledgedCaptureArgs(event.args) ||
      reviewCalls.has(event.toolCallId)
    ) {
      return;
    }
    reviewCalls.set(event.toolCallId, Date.now());
    if (reviewCalls.size > MAX_TRACKED_TASKS) {
      const oldest = reviewCalls.keys().next().value;
      reviewCalls.delete(oldest);
    }
    syncReviewActive();
    updateBlocker();
    schedulePublish();
  });

  pi.on("tool_execution_end", (event) => {
    if (!rootSession || !isRecord(event) || typeof event.toolCallId !== "string") return;
    runningTools.delete(event.toolCallId);
    // Abort/error ends with no tool_result still release: an executed ask
    // that never resolves must not latch ask.
    if (askToolCalls.delete(event.toolCallId)) {
      updateBlocker();
    }
    // Thrown/cancelled/error closes: the end seam clears a tracked
    // execution id even when its tool_result never arrives, so review
    // drops (and the principal row returns) on this beat, not the TTL —
    // zero grace, per-id overlap.
    if (reviewCalls.delete(event.toolCallId)) {
      const wasActive = reviewActive;
      syncReviewActive();
      if (reviewActive !== wasActive) updateBlocker();
      // NO GRACE coupling (same as the tool_result path): the token bytes
      // track the leg even when ask/error owns the visible label.
      schedulePublish();
    }
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

  // Neither the reserved hook (no producer) nor sidebar snapshots (entry
  // publishes fire before the forecast branch, so they prove no reviewer
  // route) are observed: no handlers are registered for either signal.

  // -- session changes -------------------------------------------------------
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
    // Structured ask proposals never open ask (execution does); subagent
    // launch correlation below is unchanged.
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
        // Progress/cancel bumps recency only; firstSeen never moves (T2b).
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
    const pending =
      typeof event.toolCallId === "string" ? pendingCalls.get(event.toolCallId) : undefined;
    if (typeof event.toolCallId === "string") pendingCalls.delete(event.toolCallId);
    // A launch resolution retires the settle-time pending guard: the
    // outcome is now covered by the task record (working via activeSubs),
    // the error latch (blocked), or genuine emptiness (idle on next beat).
    if (event.toolName === "subagent_run" || event.toolName === "subagent_continue") {
      nativeSettledPending = false;
    }
    if (typeof event.toolCallId === "string" ? reviewCalls.delete(event.toolCallId) : false) {
      // The ended id was a known acknowledged execution; remaining tracked
      // executions keep their true state untouched.
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
    // firstSeen is immutable (T2b): set once at first sighting, preserved
    // across progress reads so they never reorder oldest-first display.
    // Epochs are untouched (T1): taskEpochFor still owns execution identity.
    // Interleave liveness guard: a racy non-final read (a status poll via
    // any tool other than the authoritative subagent_run/subagent_continue
    // launch outcomes) must never regress a live `running` record — a stale
    // `queued` observed while the principal works would otherwise erase the
    // running-only count/roles, flip the display to generic `gentle`, and
    // stick there after settle (queued-cover keeps the marker fresh while
    // the delegate still runs upstream). Only a FINAL status (completion
    // truth, still re-resolving oldest-first) may replace `running` from a
    // read; the authoritative drain path (T1 queued cover) is untouched.
    const incomingStatus =
      typeof details.status === "string" ? details.status : undefined;
    const isLaunchOutcome =
      event.toolName === "subagent_run" || event.toolName === "subagent_continue";
    let status = incomingStatus ?? (previous?.status ?? "unknown");
    let staleRead = false;
    if (
      !isLaunchOutcome &&
      previous?.status === "running" &&
      status !== "running" &&
      !FINAL_TASK.has(status)
    ) {
      status = "running";
      staleRead = true;
    }
    // LIVE-2: a background launch ack arrives QUEUED (the runner admits
    // QUEUED synchronously; the pump to RUNNING emits no tool_result and
    // live senders never emit a message_end ACTIVE start — completion is
    // the next signal). Recording the ack verbatim leaves the delegate
    // queued forever: count 0, no roles, marker-only. Promoting a
    // background-mode launch outcome to running is the only live start
    // evidence; task-mode queued stays uncounted (T2b, LIVE-2 guard).
    if (isLaunchOutcome && status === "queued" && details.mode === "background") {
      status = "running";
    }
    const incomingAgent =
      typeof details.agent === "string" && details.agent.length > 0
        ? details.agent.slice(0, MAX_LABEL_CHARS)
        : undefined;
    // A stale read's agent is distrusted with its status, and a missing
    // agent keeps the previous record's agent (never reset to a guess).
    const agent =
      staleRead && previous?.agent
        ? previous.agent
        : (incomingAgent ?? previous?.agent ?? "subagent");
    const now = Date.now();
    tasks.set(details.taskId, {
      agent,
      label: previous?.label ?? pending?.label ?? agent,
      status,
      at: now,
      firstSeen: typeof previous?.firstSeen === "number" ? previous.firstSeen : now,
      epoch: taskEpochFor(previous, status, event.toolName === "subagent_continue"),
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

  // Background Gentle Agents lifecycle arrives as custom messages
  // (customType `gentle-agents.result`, details.gentleAgents
  // {taskId,agent,status}) rather than subagent_* tool_results: a
  // background START announces with an ACTIVE status (running|queued) and
  // enters the authoritative tasks map exactly like a task-mode record
  // (counted, oldest-first, settle-safe, cleared by its FINAL), while a
  // FINAL status replaces the record so the next beat counts only
  // running|queued as active; the rendered card is never parsed.
  // Waiting/unknown/other strings stay ignored (fail closed). This is the
  // background-mode tracking path: background launches run through
  // `subagent_run` with `mode: background`, so their TaskStore lifecycle
  // never passes through `tool_result` details.
  pi.on("message_end", (event) => {
    if (!rootSession || !isRecord(event)) return;
    const message = event.message;
    if (!isRecord(message) || message.role !== "custom") return;
    if (message.customType !== AGENTS_RESULT_TYPE) return;
    const details = isRecord(message.details) ? message.details.gentleAgents : undefined;
    if (!isRecord(details) || typeof details.taskId !== "string") return;
    if (typeof details.status !== "string") return;
    if (!FINAL_TASK.has(details.status) && !ACTIVE_TASK.has(details.status)) return;
    const previous = tasks.get(details.taskId);
    const agent =
      typeof details.agent === "string" && details.agent.length > 0
        ? details.agent.slice(0, MAX_LABEL_CHARS)
        : (previous?.agent ?? "subagent");
    // Record identity is immutable per taskId: firstSeen never moves (T2b
    // ordering only) whether this observation promotes a background start
    // or replaces the record with its terminal status; completion still
    // clears the count and re-resolves oldest-first.
    tasks.set(details.taskId, {
      agent,
      label: previous?.label ?? agent,
      status: details.status,
      at: Date.now(),
      firstSeen:
        typeof previous?.firstSeen === "number" ? previous.firstSeen : Date.now(),
      epoch: taskEpochFor(previous, details.status, false),
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

  pi.on("session_start", async (event, ctx) => {
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
    // LIVE-1: bind the session before any state beat so Herdr attributes
    // the pane from the first frame (mirrors the managed publisher: await
    // on session_start, fire-and-forget on agent_start).
    await reportSession(event?.reason);
    refreshChanges();
    agentActive = ctx?.isIdle?.() === false;
    settled = false;
    schedulePublish();
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    refreshSessionRef(ctx);
    // LIVE-1: re-bind the session like the managed publisher did, so a
    // restart or re-announcement never leaves the pane binding-less while
    // metadata beats flow.
    void reportSession();
    agentActive = true;
    settled = false;
    nativeSettledPending = false;
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
    // Retain settle-time pending evidence for native gating before the
    // metadata hint clears (see nativeSettledPending above).
    if (pendingCalls.size > 0) nativeSettledPending = true;
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
