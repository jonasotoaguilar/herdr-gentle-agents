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
// beats + TTL expiry; no end-to-end exactly-once claim. Desktop toast dedup
// is Herdr's native edge-triggered semantics; the producer's contribution is
// a stable per-episode intentId (ask label correlation, and the Moshi
// approval action id when the phone channel is enabled).
// @ts-nocheck

import net from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { homedir } from "node:os";
import { delimiter as pathDelimiter, dirname, join, resolve as resolvePath, relative as pathRelative, basename as pathBasename, isAbsolute as pathIsAbsolute } from "node:path";
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
// Gentle Shell's live background jobs (`bash_background` / `monitor`) are
// published on the Pi event bus, session-scoped and display-only:
// `{ sessionId, snapshot: { jobs: [{ id, label, startedAt }] } }`. A live job
// is pending work exactly like a running delegate, so it must keep the
// session non-terminal.
const JOBS_SIDEBAR_EVENT = "gentle-ai:jobs-sidebar";
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
// method — the host owns finished text plus toast/sound, and desktop ask
// attention (including toast dedup) is host-owned (DESIGN §7).
export function computeNativeState({
  agentActive,
  settled,
  activeCount,
  pendingCount,
  jobCount = 0,
  askActive,
  reviewActive,
  hasError,
}) {
  if (hasError) return "blocked";
  if (askActive) return "blocked";
  if (agentActive || activeCount > 0 || pendingCount > 0 || jobCount > 0 || reviewActive) {
    return "working";
  }
  if (
    settled &&
    !agentActive &&
    activeCount === 0 &&
    pendingCount === 0 &&
    jobCount === 0 &&
    !askActive &&
    !reviewActive
  ) {
    return "idle";
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Live session-changes metric (S62: authoritative publisher, never transcript)
//
// Gentle-shell shows the CURRENT working tree against HEAD for the session's
// subscribed roots. The transcript aggregate below (aggregateChanges over
// SESSION_CHANGE_ENTRY before/after patches) is retained as legacy evidence
// for other needs but is NOT the publisher authority: beats publish the
// live Git scan instead, so external/untracked edits and scope registration
// reflect immediately with numerical equality to the reference.
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
// Live Git scope + scan (S62, mirrored from gentle-shell shell-changes.ts +
// session-changes.ts + bounded-writer-admission.ts). Self-contained like the
// rest of this file: no relative imports. lib/live-session-changes.js is the
// extracted canonical copy; this inline mirror keeps the installed single-file
// copy working with zero sibling files. A parity test pins them equal.
// Reference argv, never -z/-M on numstat: `diff --numstat HEAD` +
// `status --porcelain=v1 --untracked-files=all -z`.
// ---------------------------------------------------------------------------

const LIVE_GIT_TIMEOUT_MS = 5000;
const LIVE_DIFF_MAX_BYTES = 1024 * 1024;
const LIVE_NUMSTAT_ARGS = ["diff", "--numstat", "HEAD"];
const LIVE_PORCELAIN_ARGS = ["status", "--porcelain=v1", "--untracked-files=all", "-z"];
const LIVE_SESSION_WORKTREE_ENTRY = "gentle-pi.session-worktree/v1";
const LIVE_STATUS_BY_CODE = { A: "added", D: "deleted", R: "renamed", C: "added", "?": "untracked" };
const LIVE_RENAME_BRACES = /\{([^{}]*) => ([^{}]*)\}/g;
const LIVE_HAS_RENAME_BRACES = /\{[^{}]* => [^{}]*\}/;
const LIVE_RENAME_ARROW = " => ";
const LIVE_BROAD_HOME_FOLDER = /^(?:documents|desktop|downloads|onedrive(?: - .+)?)$/i;
const LIVE_BROAD_ONEDRIVE_FOLDER = /^(?:documents|desktop)$/i;

export function liveRenamedPath(p) {
  if (LIVE_HAS_RENAME_BRACES.test(p)) return p.replace(LIVE_RENAME_BRACES, "$2").replace(/\/\//g, "/");
  const arrow = p.indexOf(LIVE_RENAME_ARROW);
  return arrow === -1 ? p : p.slice(arrow + LIVE_RENAME_ARROW.length);
}

export function liveCount(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function liveParseNumstat(text) {
  const entries = [];
  for (const line of String(text ?? "").split("\n")) {
    const [added, deleted, ...rest] = line.split("\t");
    if (added === undefined || deleted === undefined || rest.length === 0) continue;
    entries.push({ path: liveRenamedPath(rest.join("\t")), added: liveCount(added), deleted: liveCount(deleted) });
  }
  return entries;
}

export function liveParsePorcelain(text) {
  const statuses = new Map();
  const records = String(text ?? "").split("\0").filter((record) => record.length > 0);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const p = record.slice(3);
    if (!p.endsWith("/")) statuses.set(p, LIVE_STATUS_BY_CODE[code[0]] ?? LIVE_STATUS_BY_CODE[code[1]] ?? "modified");
    if (code[0] === "R" || code[0] === "C") index += 1;
  }
  return statuses;
}

export function liveSnapshotChanges(snapshot) {
  const counts = new Map(liveParseNumstat(snapshot.numstat).map((entry) => [entry.path, entry]));
  const files = [];
  for (const [p, status] of liveParsePorcelain(snapshot.porcelain)) {
    if (status === "untracked" && /(?:^|\/)node_modules\.backup-[^/]+\//.test(p)) continue;
    const entry = counts.get(p);
    files.push({ path: p, added: entry?.added ?? 0, deleted: entry?.deleted ?? 0, status });
  }
  return files;
}

export function liveIsHomeOrBroad(targetPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const fold = (value) => (platform === "win32" ? String(value).toLowerCase() : String(value));
  let home;
  try {
    home = options.home ?? fs.realpathSync.native(homedir());
  } catch {
    return true;
  }
  const target = fold(targetPath);
  const canonicalHome = fold(home);
  const towardHome = pathRelative(target, canonicalHome);
  if (towardHome === "" || (!pathIsAbsolute(towardHome) && towardHome !== ".." && !towardHome.startsWith("..\\") && !towardHome.startsWith("../"))) return true;
  const parent = dirname(target);
  if (parent === canonicalHome) return LIVE_BROAD_HOME_FOLDER.test(pathBasename(targetPath));
  return dirname(parent) === canonicalHome
    && /^onedrive(?: - .+)?$/i.test(pathBasename(parent))
    && LIVE_BROAD_ONEDRIVE_FOLDER.test(pathBasename(targetPath));
}

function liveValidEvidence(evidence) {
  if (!isRecord(evidence)) return false;
  if (typeof evidence.id !== "string" || evidence.id.length === 0) return false;
  if (typeof evidence.root !== "string" || !pathIsAbsolute(evidence.root)) return false;
  if (typeof evidence.path !== "string" || evidence.path.length === 0) return false;
  if (pathIsAbsolute(evidence.path) || /[\0\r\n]/.test(evidence.root + evidence.path)) return false;
  if (evidence.path.split(/[\\/]/).some((part) => part === ".." || part === ".git")) return false;
  return true;
}

export function liveSessionChangeRoots(sessionId, entries) {
  const roots = new Set();
  for (const entry of entries ?? []) {
    if (!isRecord(entry) || entry.type !== "custom" || !isRecord(entry.data)) continue;
    const data = entry.data;
    if (data.sessionId !== sessionId) continue;
    if (entry.customType === LIVE_SESSION_WORKTREE_ENTRY && typeof data.root === "string" && pathIsAbsolute(data.root)) roots.add(data.root);
    if (entry.customType === CHANGE_ENTRY && liveValidEvidence(data.evidence)) roots.add(data.evidence.root);
  }
  return [...roots];
}

function liveRootExists(root) {
  try {
    return fs.existsSync(join(root, ".git"));
  } catch {
    return false;
  }
}

export function liveResolveScopeRoots(entries, sessionId, cwdRoot) {
  const candidates = [];
  if (typeof cwdRoot === "string" && cwdRoot.length > 0) candidates.push(cwdRoot);
  for (const root of liveSessionChangeRoots(sessionId, entries)) candidates.push(root);
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      continue;
    }
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    let exists = false;
    try {
      exists = liveRootExists(real);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    try {
      if (liveIsHomeOrBroad(real)) continue;
    } catch {
      continue;
    }
    out.push(real);
  }
  return out;
}

function liveSanitizedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
}

function liveRunGit(root, args) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn("git", ["-C", root, ...args], { env: liveSanitizedEnv(), shell: false, windowsHide: true, timeout: LIVE_GIT_TIMEOUT_MS });
    } catch (err) {
      finish({ stdout: "", code: 1, error: (err && err.message) || String(err) });
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ stdout, code: 1, error: `timed out after ${LIVE_GIT_TIMEOUT_MS}ms` });
    }, LIVE_GIT_TIMEOUT_MS + 500);
    if (timer.unref) timer.unref();
    child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
    child.on("error", (err) => {
      clearTimeout(timer);
      finish({ stdout, code: 1, error: (err && err.message) || String(err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ stdout, code: typeof code === "number" ? code : 1 });
    });
  });
}

async function liveReadUntrackedLines(root, rel) {
  const target = join(root, rel);
  let info;
  try {
    info = await fs.promises.lstat(target);
  } catch {
    return 0;
  }
  if (!info.isFile() || info.size > LIVE_DIFF_MAX_BYTES) return 0;
  let text;
  try {
    text = await fs.promises.readFile(target, "utf8");
  } catch {
    return 0;
  }
  return text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export async function liveSummarizeRoots(roots) {
  const list = Array.isArray(roots) ? roots.slice() : [];
  if (list.length === 0) return { ok: true, files: 0, added: 0, deleted: 0, failedRoots: [] };
  const perRoot = [];
  const failedRoots = [];
  await Promise.all(list.map(async (root) => {
    let numstat;
    let porcelain;
    try {
      [numstat, porcelain] = await Promise.all([liveRunGit(root, LIVE_NUMSTAT_ARGS), liveRunGit(root, LIVE_PORCELAIN_ARGS)]);
    } catch {
      failedRoots.push(root);
      return;
    }
    if (!porcelain || porcelain.code !== 0) {
      failedRoots.push(root);
      return;
    }
    const files = liveSnapshotChanges({ numstat: (numstat && numstat.code === 0 ? numstat.stdout : ""), porcelain: porcelain.stdout });
    await Promise.all(files.map(async (file) => {
      if (file.status !== "untracked") return;
      try {
        file.added = await liveReadUntrackedLines(root, file.path);
      } catch {
        file.added = 0;
      }
    }));
    perRoot.push({ files });
  }));
  if (failedRoots.length > 0) return { ok: false, error: `cannot read git changes in ${failedRoots.length} checkout(s)`, failedRoots };
  let files = 0;
  let added = 0;
  let deleted = 0;
  for (const tree of perRoot) {
    for (const file of tree.files) {
      files += 1;
      added += file.added;
      deleted += file.deleted;
    }
  }
  return { ok: true, files, added, deleted, failedRoots: [] };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// Optional Moshi notification mirror toggle (DESIGN §7). The producer
// extension owns this flag file; the consumer daemon never publishes to
// Moshi (single emitter). This command is the Pi-side switch. Enabling also
// excludes the Moshi-managed Pi hook (`extensions/moshi-hooks.ts`) so Moshi
// stops notifying per prompt and per turn, and disabling removes that
// exclusion again. Both settings edits happen only while that hook file
// exists. The flag path mirrors the daemon's stateRoot() resolution
// (GENTLE_STATUS_STATE_DIR / HERDR_PLUGIN_STATE_DIR / XDG_STATE_HOME /
// ~/.local/state/herdr), so both sides agree without a shared helper — this
// file must stay self-contained.
const MOSHI_HOOKS_REL = "extensions/moshi-hooks.ts";
const MOSHI_EXCLUSION_ENTRY = "-extensions/moshi-hooks.ts";

// S15 identity rename: the active plugin lookup id is herdr-gentle-shell,
// but every stored state path keeps the herdr-gentle-agents segment (no
// migration step, no orphaned flags). GENTLE_STATUS_STATE_DIR (explicit
// user override) is used as-is; HERDR_PLUGIN_STATE_DIR is Herdr-injected
// and changes with the plugin id, so when it holds none of our files
// while the stored dir does, the stored dir wins. Fresh installs with no
// stored files converge on the injected dir.
const SIDEBAR_STATE_SEGMENT = "herdr-gentle-agents";
const SIDEBAR_STATE_KNOWN_FILES = [
  "gentle-sidebar-mode.json",
  "gentle-moshi.json",
  "pi-extension-exclusion-owned",
  "gentle-status.pid",
  "gentle-interruptions.json",
  "installer-state",
  "gentle-worktree-mode.json",
];

function sidebarStoredDir() {
  const env = process.env;
  const base = env.XDG_STATE_HOME
    ? join(env.XDG_STATE_HOME, "herdr")
    : join(homedir(), ".local", "state", "herdr");
  return join(base, "plugins", SIDEBAR_STATE_SEGMENT);
}

function sidebarEffectiveDir() {
  const env = process.env;
  const explicit = env.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === "string" && explicit.length > 0) return explicit;
  const stored = sidebarStoredDir();
  // HEAD parity: an explicit-but-empty (or otherwise invalid non-nullish)
  // value ignores every override and uses the stored default. Only an
  // omitted (null/undefined) explicit falls through to the injected dir.
  if (explicit !== undefined && explicit !== null) return stored;
  const injected = env.HERDR_PLUGIN_STATE_DIR;
  if (typeof injected !== "string" || injected.length === 0) return stored;
  if (injected === stored) return injected;
  try {
    let injectedHas = false;
    for (const name of SIDEBAR_STATE_KNOWN_FILES) {
      try {
        if (fs.existsSync(join(injected, name))) {
          injectedHas = true;
          break;
        }
      } catch {
        // A single unreadable entry never decides; keep scanning.
      }
    }
    if (injectedHas) return injected;
    for (const name of SIDEBAR_STATE_KNOWN_FILES) {
      try {
        if (fs.existsSync(join(stored, name))) return stored;
      } catch {
        // A single unreadable entry never decides; keep scanning.
      }
    }
  } catch {
    // Fall through to the injected dir on unexpected failure.
  }
  return injected;
}

function moshiFlagPath() {
  return join(sidebarEffectiveDir(), "gentle-moshi.json");
}

function moshiFlagEnabled(path) {
  try {
    const raw = JSON.parse(fs.readFileSync(path, "utf8"));
    return isRecord(raw) && raw.enabled === true;
  } catch {
    return false;
  }
}

function writeMoshiFlag(path, enabled) {
  fs.mkdirSync(dirname(path), { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify({ enabled, updatedAt: new Date().toISOString() })}\n`);
}

// Pi agent dir, resolved like resolvePresenceProfile: an explicit agent home
// wins, then Pi's own override, then the default.
function piAgentDir() {
  const env = process.env;
  const selected = env.GENTLE_PI_AGENT_HOME ?? env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  if (selected === "~") return homedir();
  if (selected.startsWith("~/")) return join(homedir(), selected.slice(2));
  return selected;
}

function moshiHooksPath() {
  return join(piAgentDir(), "extensions", "moshi-hooks.ts");
}

function piSettingsPath() {
  return join(piAgentDir(), "settings.json");
}

// Fail closed: null means "do not touch it" (unreadable, invalid JSON, a
// non-object document, or an `extensions` value that is not a list of
// strings). A missing file yields an empty document, exactly like Pi.
function readSettingsDoc(path) {
  let raw;
  try {
    raw = fs.readFileSync(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { doc: {}, exists: false };
    return null;
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return null;
  }
  if (!isRecord(doc)) return null;
  if (doc.extensions !== undefined && !Array.isArray(doc.extensions)) return null;
  if (Array.isArray(doc.extensions) && doc.extensions.some((entry) => typeof entry !== "string")) return null;
  return { doc, exists: true };
}

function moshiExclusionPresent() {
  const loaded = readSettingsDoc(piSettingsPath());
  if (loaded === null) return null;
  const list = Array.isArray(loaded.doc.extensions) ? loaded.doc.extensions : [];
  return list.includes(MOSHI_EXCLUSION_ENTRY);
}

// Atomic and mode-preserving. A symlinked settings.json keeps pointing at its
// target because the temp file is created next to the resolved target.
function writeSettingsDoc(path, doc) {
  let target = path;
  try {
    target = fs.realpathSync(path);
  } catch {
    // Missing or dangling: write where the path points.
  }
  let mode = 0o600;
  try {
    mode = fs.statSync(target).mode & 0o777;
  } catch {
    // Fresh file.
  }
  const temp = join(dirname(target), `.settings.json.gentle-${randomUUID().slice(0, 8)}.tmp`);
  try {
    fs.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { mode });
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {}
    throw error;
  }
}

// Only ever appends or removes the exact entry, preserving every other key,
// value, and entry. Both directions are gated on the Moshi-managed hook
// existing: with no hook file there is nothing to exclude, so settings.json
// is never touched.
function setMoshiExclusion(want) {
  if (!fs.existsSync(moshiHooksPath())) {
    return { ok: true, note: `${MOSHI_HOOKS_REL} is not installed; settings.json untouched.` };
  }
  const settings = piSettingsPath();
  const loaded = readSettingsDoc(settings);
  if (loaded === null) {
    return { ok: false, note: `could not update ${settings}: unreadable or invalid JSON.` };
  }
  const list = Array.isArray(loaded.doc.extensions) ? loaded.doc.extensions : [];
  const present = list.includes(MOSHI_EXCLUSION_ENTRY);
  if (want === present) {
    return { ok: true, note: want ? "exclusion already present." : "no exclusion to remove." };
  }
  const next = want
    ? [...list, MOSHI_EXCLUSION_ENTRY]
    : list.filter((entry) => entry !== MOSHI_EXCLUSION_ENTRY);
  try {
    writeSettingsDoc(settings, { ...loaded.doc, extensions: next });
  } catch (error) {
    return { ok: false, note: `could not write ${settings}: ${error?.message ?? error}.` };
  }
  return { ok: true, note: want ? `added ${MOSHI_EXCLUSION_ENTRY}.` : `removed ${MOSHI_EXCLUSION_ENTRY}.` };
}

// ---------------------------------------------------------------------------
// Sidebar integration switch (S7): OUR sidebar versus the native Herdr
// sidebar. Reached through the `/herdr-gentle:customize` panel's sidebar
// rows (the old `toggle|enable|disable|status` command is removed); the
// provider slot below drives `sidebarEnable`/`sidebarDisable`.
// Enable means OURS (owned native exclusion + managed `configure` rows);
// disable means NATIVE (only the owned exclusion removed + managed rows
// unconfigured, so the native sidebar renders again). This block is
// self-contained like the rest of this file: the installed copy ships
// without sibling modules, so the marker-bound exclusion below mirrors
// lib/pi-extension-exclusion.js semantics inline (exact entry, canonical
// target binding, foreign/misbound refusal, byte-identical rollback)
// without importing it. Row convergence runs the installed plugin's own
// bin/configure.js synchronously after resolving its root through the
// read-only plugin list; only a zero exit plus a re-read managed-row
// effect commits the mode or exclusion, and Pi sessions always need
// /reload.
const SIDEBAR_NATIVE_REL = "extensions/herdr-agent-state.ts";
const SIDEBAR_NATIVE_ENTRY = "-extensions/herdr-agent-state.ts";
const SIDEBAR_MODE_VERSION = 1;
const SIDEBAR_MARKER_VERSION = 1;
const SIDEBAR_PLUGIN_ID = "herdr-gentle-shell";
const SIDEBAR_LEGACY_PLUGIN_ID = "herdr-gentle-agents";
const SIDEBAR_MARKER_NAME = "pi-extension-exclusion-owned";
const SIDEBAR_MANAGED_BEGIN = "# BEGIN herdr-gentle-agents (managed; do not edit)";
const SIDEBAR_MANAGED_END = "# END herdr-gentle-agents";

// Shared mode file under the existing resolved state directory (same
// resolution as the Moshi flag above): {version:1,enabled:boolean}.
// Missing defaults to enabled for current-install compatibility.
function sidebarModePath() {
  return join(sidebarEffectiveDir(), "gentle-sidebar-mode.json");
}

function sidebarMarkerPath() {
  return join(dirname(sidebarModePath()), SIDEBAR_MARKER_NAME);
}

function sidebarNativePath() {
  return join(piAgentDir(), "extensions", "herdr-agent-state.ts");
}

function sidebarHerdrBin() {
  const override = process.env.HERDR_BIN_PATH;
  return typeof override === "string" && override.length > 0 ? override : "herdr";
}

// Read-only Herdr config location (same resolution as bin/configure.js).
// Used only for the status rows probe; this file never writes it.
function sidebarConfigPath() {
  if (process.env.HERDR_CONFIG_PATH) return process.env.HERDR_CONFIG_PATH;
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return join(xdg, "herdr", "config.toml");
  return join(homedir(), ".config", "herdr", "config.toml");
}

// Missing means enabled (compatibility); malformed never enables
// (fail closed, reported by the command paths below).
function readSidebarMode() {
  let raw;
  try {
    raw = fs.readFileSync(sidebarModePath(), "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { state: "missing", publish: true };
    return { state: "malformed", publish: false };
  }
  let doc;
  try {
    doc = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch {
    return { state: "malformed", publish: false };
  }
  if (!isRecord(doc) || doc.version !== SIDEBAR_MODE_VERSION || typeof doc.enabled !== "boolean") {
    return { state: "malformed", publish: false };
  }
  return doc.enabled ? { state: "enabled", publish: true } : { state: "disabled", publish: false };
}

function sidebarPublishingEnabled() {
  try {
    return readSidebarMode().publish;
  } catch {
    return false;
  }
}

function writeSidebarMode(enabled) {
  const file = sidebarModePath();
  fs.mkdirSync(dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ version: SIDEBAR_MODE_VERSION, enabled })}\n`);
}

function sidebarBasename(p) {
  const parts = String(p).split(/[\\/]/);
  return parts.length > 0 ? parts[parts.length - 1] : String(p);
}

// Canonical ownership target through symlinks (parent-resolved when the
// file is absent), mirroring lib/pi-extension-exclusion.js. Null when
// unresolvable: the caller fails closed.
function sidebarCurrentTarget(settings) {
  try {
    return fs.realpathSync(settings);
  } catch (error) {
    if (error?.code !== "ENOENT") return null;
    try {
      return join(fs.realpathSync(dirname(settings)), sidebarBasename(settings));
    } catch {
      return null;
    }
  }
}

// Validate the ownership record against this exact entry and settings
// target. Absent means never owned (caller decides); foreign, invalid,
// or misbound fails closed without touching settings.
function checkSidebarMarker(settings) {
  const marker = sidebarMarkerPath();
  let markerRaw;
  try {
    markerRaw = fs.readFileSync(marker, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, owned: false };
    return { ok: false, note: `cannot read ownership record ${marker}: ${error?.message ?? error}.` };
  }
  let record = null;
  try {
    record = JSON.parse(markerRaw);
  } catch {
    record = null;
  }
  if (
    !isRecord(record) ||
    record.version !== SIDEBAR_MARKER_VERSION ||
    typeof record.entry !== "string" ||
    record.entry === "" ||
    typeof record.settings !== "string" ||
    record.settings === ""
  ) {
    return { ok: false, note: `ownership record ${marker} is foreign or invalid; delete the record or the entry manually.` };
  }
  if (record.entry !== SIDEBAR_NATIVE_ENTRY) {
    return { ok: false, note: `ownership record ${marker} authorizes a different entry (${record.entry}); delete the record or the entry manually.` };
  }
  const current = sidebarCurrentTarget(settings);
  if (current === null || current !== record.settings) {
    return { ok: false, note: `ownership record ${marker} is bound to ${record.settings}, not ${settings}; delete the record or the entry manually.` };
  }
  return { ok: true, owned: true };
}

function writeSidebarMarker(settings) {
  const canon = sidebarCurrentTarget(settings);
  if (canon === null) return false;
  try {
    const marker = sidebarMarkerPath();
    fs.mkdirSync(dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({ version: SIDEBAR_MARKER_VERSION, entry: SIDEBAR_NATIVE_ENTRY, settings: canon })}\n`);
    return true;
  } catch {
    return false;
  }
}

function removeSidebarMarker() {
  try {
    fs.rmSync(sidebarMarkerPath(), { force: true });
  } catch {
    // Best-effort marker cleanup.
  }
}

// Byte-identical settings restore after a failed marker write: a failed
// ensure never leaves a changed settings file behind while claiming
// otherwise. Null `before` means this run created the file.
function restoreSidebarSettings(settings, before) {
  try {
    const target = sidebarCurrentTarget(settings) ?? settings;
    if (before === null) fs.rmSync(target, { force: true });
    else fs.writeFileSync(target, before);
    return true;
  } catch {
    return false;
  }
}

// Only ever appends the exact native entry, preserving every other key,
// value, and entry. Gated on the native hook file existing (with no hook
// there is nothing to exclude); a pre-existing user entry without our
// marker is left as-is and never adopted.
function ensureSidebarExclusion() {
  if (!fs.existsSync(sidebarNativePath())) {
    return { ok: true, changed: false, note: `${SIDEBAR_NATIVE_REL} is not installed; settings.json untouched.` };
  }
  const settings = piSettingsPath();
  const binding = checkSidebarMarker(settings);
  if (!binding.ok) return { ok: false, changed: false, note: `refusing to record ${SIDEBAR_NATIVE_ENTRY}: ${binding.note}` };
  const loaded = readSettingsDoc(settings);
  if (loaded === null) {
    return { ok: false, changed: false, note: `could not update ${settings}: unreadable or invalid JSON.` };
  }
  const list = Array.isArray(loaded.doc.extensions) ? loaded.doc.extensions : [];
  if (list.includes(SIDEBAR_NATIVE_ENTRY)) {
    return {
      ok: true,
      changed: false,
      note: binding.owned
        ? "exclusion already present."
        : "exclusion already present (pre-existing user entry, not owned; left as-is).",
    };
  }
  let before = null;
  try {
    before = fs.readFileSync(settings, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return { ok: false, changed: false, note: `could not read ${settings}: ${error?.message ?? error}.` };
    }
  }
  try {
    fs.mkdirSync(dirname(settings), { recursive: true });
    writeSettingsDoc(settings, { ...loaded.doc, extensions: [...list, SIDEBAR_NATIVE_ENTRY] });
  } catch (error) {
    return { ok: false, changed: false, note: `could not write ${settings}: ${error?.message ?? error}.` };
  }
  if (!writeSidebarMarker(settings)) {
    const restored = restoreSidebarSettings(settings, before);
    return {
      ok: false,
      changed: false,
      note: restored
        ? `could not record ownership (${sidebarMarkerPath()}); settings restored unchanged.`
        : `could not record ownership (${sidebarMarkerPath()}); settings could NOT be restored, remove ${SIDEBAR_NATIVE_ENTRY} manually or re-run enable.`,
    };
  }
  return { ok: true, changed: true, note: `added ${SIDEBAR_NATIVE_ENTRY}.` };
}

// Removes only the plugin-owned entry. A pre-existing user entry (no
// marker) and any foreign/misbound record are preserved, failing closed.
function removeSidebarExclusion() {
  if (!fs.existsSync(sidebarNativePath())) {
    return { ok: true, changed: false, note: `${SIDEBAR_NATIVE_REL} is not installed; settings.json untouched.` };
  }
  const settings = piSettingsPath();
  const binding = checkSidebarMarker(settings);
  if (!binding.ok) return { ok: false, changed: false, note: `refusing to remove ${SIDEBAR_NATIVE_ENTRY}: ${binding.note}` };
  if (!binding.owned) {
    return { ok: true, changed: false, note: "no owned exclusion; settings.json untouched." };
  }
  try {
    fs.lstatSync(settings);
  } catch (error) {
    if (error?.code === "ENOENT") {
      removeSidebarMarker();
      return { ok: true, changed: false, note: "settings.json already absent; stale ownership dropped." };
    }
    return { ok: false, changed: false, note: `cannot stat ${settings}: ${error?.message ?? error}.` };
  }
  const loaded = readSettingsDoc(settings);
  if (loaded === null) {
    return { ok: false, changed: false, note: `could not update ${settings}: unreadable or invalid JSON.` };
  }
  const list = Array.isArray(loaded.doc.extensions) ? loaded.doc.extensions : [];
  if (!list.includes(SIDEBAR_NATIVE_ENTRY)) {
    removeSidebarMarker();
    return { ok: true, changed: false, note: "no exclusion to remove." };
  }
  const kept = list.filter((entry) => entry !== SIDEBAR_NATIVE_ENTRY);
  const next = { ...loaded.doc };
  if (kept.length === 0) delete next.extensions;
  else next.extensions = kept;
  try {
    writeSettingsDoc(settings, next);
  } catch (error) {
    return { ok: false, changed: false, note: `could not write ${settings}: ${error?.message ?? error}.` };
  }
  removeSidebarMarker();
  return { ok: true, changed: true, note: `removed ${SIDEBAR_NATIVE_ENTRY}.` };
}

// Row convergence through the installed plugin's own configure script,
// run synchronously: the plugin root is resolved via the read-only
// `herdr plugin list --json` shape (the same lookup install.sh uses),
// then `<root>/bin/configure.js --apply|--uninstall --reload` runs under
// this process's node with a bounded timeout. Exit 0 alone is still not
// the commit gate — the managed-row effect is re-read from the Herdr
// config and must match (present for enable, absent for disable) before
// the mode or exclusion changes. An accepted-but-incomplete run therefore
// never commits state and never claims success.
// Resolve the installed plugin root via read-only `herdr plugin list
// --json` (verified shape: result.plugins[] with plugin_id/plugin_root).
// The active (renamed) id is queried first; a zero match falls through to
// one explicit lookup by the retired id so pre-rename installs keep
// working. Ambiguous roots fail closed on either id — the legacy lookup
// is never a silent weak fallback. Other failures (spawn, exit, parse)
// fail closed on the id that produced them.
function querySidebarPluginRoots(id) {
  let result;
  try {
    result = spawnSync(
      sidebarHerdrBin(),
      ["plugin", "list", "--plugin", id, "--json"],
      { encoding: "utf8", timeout: 15000, windowsHide: true },
    );
  } catch (error) {
    return { ok: false, note: `could not resolve the installed plugin root: ${error?.message ?? error}.` };
  }
  if (result.error) {
    return { ok: false, note: `could not resolve the installed plugin root: ${result.error.message}.` };
  }
  if (result.status !== 0) {
    return { ok: false, note: `could not resolve the installed plugin root (plugin list exited ${result.status}).` };
  }
  try {
    const doc = JSON.parse(result.stdout || "");
    const arr = (doc && doc.result && doc.result.plugins) || doc.plugins || [];
    if (!Array.isArray(arr)) throw new Error("no plugins array");
    const hits = arr.filter((p) => p && (p.plugin_id === id || p.id === id));
    const roots = [...new Set(hits.map((h) => h.plugin_root).filter((r) => typeof r === "string" && r.length > 0))];
    return { ok: true, roots };
  } catch (error) {
    return { ok: false, note: `could not resolve the installed plugin root: malformed plugin list (${error?.message ?? error}).` };
  }
}

function checkSidebarPluginRoot(root) {
  if (!root.startsWith("/")) {
    return { ok: false, note: `could not resolve the installed plugin root (ambiguous or non-absolute).` };
  }
  if (!fs.existsSync(join(root, "bin", "configure.js"))) {
    return { ok: false, note: `could not resolve the installed plugin root (${root} has no bin/configure.js).` };
  }
  return { ok: true, root };
}

function resolveSidebarPluginRoot() {
  const active = querySidebarPluginRoots(SIDEBAR_PLUGIN_ID);
  if (!active.ok) return active;
  if (active.roots.length === 1) return checkSidebarPluginRoot(active.roots[0]);
  if (active.roots.length > 1) {
    return { ok: false, note: `could not resolve the installed plugin root (ambiguous for ${SIDEBAR_PLUGIN_ID}).` };
  }
  const legacy = querySidebarPluginRoots(SIDEBAR_LEGACY_PLUGIN_ID);
  if (!legacy.ok) return legacy;
  if (legacy.roots.length === 1) return checkSidebarPluginRoot(legacy.roots[0]);
  if (legacy.roots.length > 1) {
    return { ok: false, note: `could not resolve the installed plugin root (ambiguous for retired id ${SIDEBAR_LEGACY_PLUGIN_ID}).` };
  }
  return { ok: false, note: `could not resolve the installed plugin root (no match for ${SIDEBAR_PLUGIN_ID} or ${SIDEBAR_LEGACY_PLUGIN_ID}).` };
}

// Run the installed configure script synchronously (fixed argv, no
// shell; config path and reload binary resolve inside that script from
// the inherited environment). Returns the exit and bounded output.
function runSidebarConfigure(root, op, reload) {
  const args = [join(root, "bin", "configure.js"), op];
  if (reload) args.push("--reload");
  let result;
  try {
    result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 60000, windowsHide: true });
  } catch (error) {
    return { exit: -1, output: `configure ${op} could not start: ${error?.message ?? error}.` };
  }
  if (result.error) {
    return { exit: -1, output: `configure ${op} could not start: ${result.error.message}.` };
  }
  const output = `${result.stdout || ""}${result.stderr || ""}`.trim().slice(0, 300);
  return { exit: result.status, output };
}

function readSidebarConfig() {
  try {
    return { ok: true, text: fs.readFileSync(sidebarConfigPath(), "utf8") };
  } catch (error) {
    if (error?.code === "ENOENT") return { ok: true, text: null };
    return { ok: false, text: null, note: `config ${sidebarConfigPath()} unreadable: ${error?.message ?? error}.` };
  }
}

function sidebarRowsManaged(text) {
  return typeof text === "string" && text.includes(SIDEBAR_MANAGED_BEGIN) && text.includes(SIDEBAR_MANAGED_END);
}

async function sidebarEnable(ctx) {
  const notify = ctx?.ui?.notify;
  const reRun = "Retry via /herdr-gentle:customize to converge.";
  // Preflight before any mutation: unreadable settings or a
  // foreign/misbound record fails closed with nothing touched.
  if (fs.existsSync(sidebarNativePath())) {
    if (readSettingsDoc(piSettingsPath()) === null) {
      notify?.(`Could not enable: ${piSettingsPath()} is unreadable or invalid JSON; fix or remove it, then retry via /herdr-gentle:customize.`, "error");
      return;
    }
    const binding = checkSidebarMarker(piSettingsPath());
    if (!binding.ok) {
      notify?.(`Could not enable: ${binding.note} Re-run after resolving it.`, "error");
      return;
    }
  }
  // Completion proof before any local state changes: resolve the
  // installed root, run its configure synchronously, and re-read the
  // managed-row effect. Exclusion and mode only change after this.
  const resolved = resolveSidebarPluginRoot();
  if (!resolved.ok) {
    notify?.(`Could not enable: ${resolved.note} ${reRun}`, "error");
    return;
  }
  const before = readSidebarConfig();
  if (!before.ok) {
    notify?.(`Could not enable: ${before.note} ${reRun}`, "error");
    return;
  }
  const hadManaged = sidebarRowsManaged(before.text);
  const ran = runSidebarConfigure(resolved.root, "--apply", true);
  const after = readSidebarConfig();
  const nowManaged = after.ok && sidebarRowsManaged(after.text);
  if (ran.exit !== 0 || !nowManaged) {
    // Bounded rows restore: only our own markers are ever removed, so
    // user tables and concurrent edits outside them are preserved.
    let restored = "rows left as found";
    if (!hadManaged && nowManaged) {
      const undone = runSidebarConfigure(resolved.root, "--uninstall", false);
      const check = readSidebarConfig();
      restored = undone.exit === 0 && check.ok && !sidebarRowsManaged(check.text)
        ? "stranded rows removed again"
        : "rows could NOT be restored; remove the managed block manually or re-run enable";
    }
    const detail = ran.exit !== 0
      ? `configure exited ${ran.exit}${ran.output ? `: ${ran.output}` : "."}`
      : "managed rows missing after configure.";
    notify?.(`Could not enable: ${detail} ${restored}; mode and exclusion unchanged. ${reRun}`, "error");
    return;
  }
  const exclusion = ensureSidebarExclusion();
  if (!exclusion.ok) {
    if (!hadManaged) runSidebarConfigure(resolved.root, "--uninstall", false);
    notify?.(`Could not enable: ${exclusion.note} Rows rolled back; mode unchanged. ${reRun}`, "error");
    return;
  }
  try {
    writeSidebarMode(true);
  } catch (error) {
    if (exclusion.changed) removeSidebarExclusion();
    if (!hadManaged) runSidebarConfigure(resolved.root, "--uninstall", false);
    notify?.(`Could not enable: cannot write ${sidebarModePath()}: ${error?.message ?? error}. State rolled back. ${reRun}`, "error");
    return;
  }
  notify?.(
    `Gentle sidebar enabled (ours). ${exclusion.note} Managed rows applied and verified (configure exit 0). Sessions already running need /reload to pick up the extension-list change.`,
    "info",
  );
}

async function sidebarDisable(ctx) {
  const notify = ctx?.ui?.notify;
  const reRun = "Retry via /herdr-gentle:customize to converge.";
  if (fs.existsSync(sidebarNativePath())) {
    if (readSettingsDoc(piSettingsPath()) === null) {
      notify?.(`Could not disable: ${piSettingsPath()} is unreadable or invalid JSON; fix or remove it, then retry via /herdr-gentle:customize.`, "error");
      return;
    }
    const binding = checkSidebarMarker(piSettingsPath());
    if (!binding.ok) {
      notify?.(`Could not disable: ${binding.note} Re-run after resolving it.`, "error");
      return;
    }
  }
  const resolved = resolveSidebarPluginRoot();
  if (!resolved.ok) {
    notify?.(`Could not disable: ${resolved.note} ${reRun}`, "error");
    return;
  }
  const before = readSidebarConfig();
  if (!before.ok) {
    notify?.(`Could not disable: ${before.note} ${reRun}`, "error");
    return;
  }
  const hadManaged = sidebarRowsManaged(before.text);
  const ran = runSidebarConfigure(resolved.root, "--uninstall", true);
  const after = readSidebarConfig();
  const nowAbsent = after.ok && !sidebarRowsManaged(after.text);
  if (ran.exit !== 0 || !nowAbsent) {
    // Bounded rows restore (marker-scoped re-apply only): user tables
    // and concurrent edits outside our markers are preserved.
    let restored = "rows left as found";
    if (hadManaged && after.ok && !sidebarRowsManaged(after.text)) {
      const redone = runSidebarConfigure(resolved.root, "--apply", false);
      const check = readSidebarConfig();
      restored = redone.exit === 0 && check.ok && sidebarRowsManaged(check.text)
        ? "prior owned rows restored"
        : "rows could NOT be restored; re-run disable or apply the managed block manually";
    }
    const detail = ran.exit !== 0
      ? `configure exited ${ran.exit}${ran.output ? `: ${ran.output}` : "."}`
      : "managed rows still present after configure.";
    notify?.(`Could not disable: ${detail} ${restored}; exclusion and mode unchanged. ${reRun}`, "error");
    return;
  }
  const exclusion = removeSidebarExclusion();
  if (!exclusion.ok) {
    notify?.(`Could not disable: ${exclusion.note} Rows are native; mode unchanged. ${reRun}`, "error");
    return;
  }
  try {
    writeSidebarMode(false);
  } catch (error) {
    if (exclusion.changed) ensureSidebarExclusion();
    notify?.(`Could not disable: cannot write ${sidebarModePath()}: ${error?.message ?? error}. Exclusion restored; rows are native. ${reRun}`, "error");
    return;
  }
  notify?.(
    `Gentle sidebar disabled (native renders again). ${exclusion.note} Managed rows removed and verified (configure exit 0). Sessions already running need /reload to pick up the extension-list change.`,
    "info",
  );
}

/* ------------------------------------------------------------ moshi */

// Optional Moshi replacement (DESIGN §7). With the toggle on, this extension
// takes over the whole integration the Moshi-managed Pi hook used to provide
// — the same `session.update` envelopes over the Moshi daemon socket — so
// Chat View, Live Activity, the session row and the terminal context keep
// working, while notifications follow OUR policy: one per real ask episode
// and one per real finish, never per prompt or per turn. Moshi still owns
// pairing and credentials (this code never reads a token), and every send is
// best effort: an absent daemon is a silent no-op that never interrupts Pi.
//
// This file ships as plain JavaScript inside a .ts file (Pi loads it through
// jiti; the tests load a copy as .mjs), so it carries no type annotations.
const MOSHI_AGENT = "pi";
const MOSHI_MAX_CHILD_HEADER = 16 * 1024;

function moshiSocketPath() {
  const override = process.env.MOSHI_SOCKET_PATH;
  if (typeof override === "string" && override.length > 0) return override;
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "Moshi", "moshi-hook.sock");
  }
  if (process.platform === "win32") return "\\\\.\\pipe\\moshi-hook";
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (typeof runtime === "string" && runtime.length > 0) return join(runtime, "moshi-hook.sock");
  return "/tmp/moshi-hook.sock";
}

const moshiInFlight = new Set();

// One envelope per connection: JSON line, half-close, drain the ack — the
// wire protocol of the Moshi daemon socket. Every failure resolves silently.
function moshiSendEnvelope(envelope) {
  try {
    const sock = net.connect({ path: moshiSocketPath() });
    const done = new Promise((resolve) => sock.once("close", () => resolve()));
    moshiInFlight.add(done);
    void done.then(() => moshiInFlight.delete(done));
    sock.setNoDelay(true);
    sock.on("error", () => {
      try {
        sock.destroy();
      } catch {}
    });
    sock.once("connect", () => {
      sock.write(`${JSON.stringify(envelope)}\n`);
      sock.end();
    });
    sock.on("data", () => {});
  } catch {
    // Moshi absent is never an error for Pi.
  }
}

// session_shutdown is awaited by the host: without draining, the process can
// exit before the socket connects and the session never closes in Moshi.
function moshiFlushSends(timeoutMs) {
  if (moshiInFlight.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void Promise.all([...moshiInFlight]).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function moshiCommandOutput(command, args, timeout) {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", timeout, windowsHide: true });
    return typeof result.stdout === "string" ? result.stdout : "";
  } catch {
    return "";
  }
}

// Terminal identity for the envelopes (Chat View, jump-to, approval routing).
// Resolved once, lazily: enabling Moshi is what pays for the tmux probe.
// Herdr identity comes straight from the environment Herdr stamps into every
// pane; labels are resolved daemon-side from these ids.
let moshiTerminalCache;

function moshiTerminal() {
  if (moshiTerminalCache) return moshiTerminalCache;
  const tmuxPane = process.env.TMUX_PANE ?? "";
  const tmuxEnv = process.env.TMUX ?? "";
  const comma = tmuxEnv.indexOf(",");
  const tmuxSocket = comma > 0 ? tmuxEnv.slice(0, comma) : "";
  let tmuxSession = "";
  let tmuxWindow = "";
  if (tmuxEnv) {
    const args = ["display-message", "-p"];
    if (tmuxPane) args.push("-t", tmuxPane);
    args.push("#S\t#I");
    const text = moshiCommandOutput("tmux", args, 200).trim();
    if (text) {
      const parts = text.split("\t", 2);
      tmuxSession = parts[0] ?? "";
      tmuxWindow = parts[1] ?? "";
    }
  }
  const zellijSession = process.env.ZELLIJ_SESSION_NAME ?? "";
  const zellijPane = process.env.ZELLIJ_PANE_ID ?? "";
  const inHerdr = process.env.HERDR_ENV === "1";
  const terminalKind = tmuxSession
    ? "tmux"
    : inHerdr
      ? "herdr"
      : process.env.ZELLIJ || zellijSession || zellijPane
        ? "zellij"
        : "";
  moshiTerminalCache = {
    terminalKind,
    tmuxSession,
    tmuxWindow,
    tmuxPane,
    tmuxSocket,
    zellijSession,
    zellijPane,
    herdrSession: inHerdr ? (process.env.HERDR_SESSION ?? "") : "",
    herdrPane: inHerdr ? (paneId ?? "") : "",
    herdrWorkspaceId: inHerdr ? (process.env.HERDR_WORKSPACE_ID ?? "") : "",
    herdrTabId: inHerdr ? (process.env.HERDR_TAB_ID ?? "") : "",
  };
  return moshiTerminalCache;
}

const moshiChildCache = new Map();

// A Pi session created by fork/clone/newSession carries a parent in its
// transcript header; those stay out of the Moshi inbox (the managed hook
// applied the same rule). An unreadable or half-written header is retried on
// the next call.
function moshiSessionIsChild(file) {
  if (!file) return false;
  const cached = moshiChildCache.get(file);
  if (cached !== undefined) return cached;
  let fd;
  try {
    fd = fs.openSync(file, "r");
  } catch {
    return false;
  }
  let child = false;
  try {
    const buffer = Buffer.alloc(MOSHI_MAX_CHILD_HEADER);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, read).toString("utf8");
    const newline = text.indexOf("\n");
    const header = JSON.parse(newline >= 0 ? text.slice(0, newline) : text);
    const parent = header?.parentSession ?? header?.parentSessionId;
    child = typeof parent === "string" && parent.length > 0;
  } catch {
    return false;
  } finally {
    try {
      fs.closeSync(fd);
    } catch {}
  }
  moshiChildCache.set(file, child);
  return child;
}

let moshiFlagCache = { mtimeMs: -1, enabled: false };

function moshiEnabled() {
  const path = moshiFlagPath();
  try {
    const stat = fs.statSync(path);
    if (stat.mtimeMs === moshiFlagCache.mtimeMs) return moshiFlagCache.enabled;
    moshiFlagCache = { mtimeMs: stat.mtimeMs, enabled: moshiFlagEnabled(path) };
  } catch {
    moshiFlagCache = { mtimeMs: -1, enabled: false };
  }
  return moshiFlagCache.enabled;
}

function moshiFirstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return "";
}

function moshiModelLabel(model) {
  if (!isRecord(model)) return "";
  return moshiFirstString(model.displayName, model.display_name, model.name, model.id, model.modelId);
}

function moshiContextRemaining(ctx) {
  let usage;
  try {
    const call = ctx?.getContextUsage;
    if (typeof call !== "function") return undefined;
    usage = call.call(ctx);
  } catch {
    return undefined;
  }
  if (typeof usage?.percent !== "number" || !Number.isFinite(usage.percent)) return undefined;
  return Math.max(1, Math.min(100, Math.round(100 - usage.percent)));
}

// Visible project name for the notification copy: the multiplexer session
// name when there is one, else the cwd basename, else `Gentle`. Never a full
// path.
function moshiProjectName(cwd, terminal) {
  const trimmed = typeof cwd === "string" ? cwd.replace(/[\\/]+$/, "") : "";
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  const base = at >= 0 ? trimmed.slice(at + 1) : trimmed;
  return terminal.tmuxSession || terminal.herdrSession || terminal.zellijSession || base || "Gentle";
}

// Last-finished task label for the finish notification body: the most
// recently completed/cancelled record, sanitized like advisory labels and
// bounded so a notification (history, lock screen) never carries ids,
// paths, or prompt content. Undefined when no terminal record exists (the
// fallback body covers a session with no tracked tasks).
function lastFinishedLabel(taskMap) {
  let bestLabel;
  let bestAt = -1;
  if (taskMap instanceof Map) {
    for (const task of taskMap.values()) {
      if (task?.status !== "completed" && task?.status !== "cancelled") continue;
      if (typeof task?.label !== "string" || task.label.length === 0) continue;
      if (typeof task.at !== "number" || task.at < bestAt) continue;
      bestAt = task.at;
      bestLabel = task.label;
    }
  }
  if (bestLabel === undefined) return undefined;
  const clean = bestLabel.replace(/[\x00-\x1f\x7f-\x9f]/g, "").trim().slice(0, 80);
  return clean || undefined;
}

// ---------------------------------------------------------------------------
// Customize panel providers (customize-command S6, T1).
//
// The sidebar and moshi actions stay inline above — nothing is extracted
// or rewritten here. This block only registers the two actions once at
// load into the single cross-extension provider slot the worktree
// extension reads when the panel opens. `Symbol.for` yields the same
// symbol in both modules without a shared import, so the key literal is
// the contract: it must stay byte-identical in both files (a test asserts
// it). Provider contract: read() returns the active value id;
// apply(value, ctx) returns {changed, needsReload, text} through the
// existing sidebarEnable/sidebarDisable and writeMoshiFlag/
// setMoshiExclusion/moshiFlagEnabled paths unchanged. No text here ever
// asks the user to run /reload (S5): the command notifies once itself
// and reloads on its own when the verdict says so.
// ---------------------------------------------------------------------------

function customizeSidebarRead() {
  try {
    return readSidebarMode().publish ? "gentle" : "native";
  } catch {
    return "native";
  }
}

async function customizeSidebarApply(value, ctx) {
  if (value !== "gentle" && value !== "native") {
    return { changed: false, needsReload: false, text: `Unknown sidebar value ${JSON.stringify(value)}; nothing was changed.` };
  }
  let current = null;
  try {
    current = customizeSidebarRead();
  } catch {
    current = null;
  }
  if (current === value) {
    return {
      changed: false,
      needsReload: false,
      text: value === "gentle"
        ? "Gentle sidebar already enabled (ours); nothing was changed."
        : "Native sidebar already active; nothing was changed.",
    };
  }
  // The existing enable/disable paths notify through ctx while the panel
  // notifies once itself, so they run against a capturing ctx here and
  // only their outcome — the re-read mode — decides the verdict.
  const seen = [];
  const capture = ctx && typeof ctx === "object"
    ? { ...ctx, ui: { ...((ctx.ui) ?? {}), notify: (message, level) => { seen.push([message, level]); } } }
    : ctx;
  try {
    if (value === "gentle") await sidebarEnable(capture);
    else await sidebarDisable(capture);
  } catch (err) {
    return { changed: false, needsReload: false, text: `Could not update the sidebar: ${(err && err.message) || err}; nothing was changed.` };
  }
  let after = null;
  try {
    after = customizeSidebarRead();
  } catch {
    after = null;
  }
  if (after !== value) {
    return {
      changed: false,
      needsReload: false,
      text: seen.length > 0 ? String(seen[seen.length - 1][0]) : "Could not update the sidebar; nothing was changed.",
    };
  }
  // S6 reload matrix: the Pi settings exclusion and the native sidebar
  // only take effect on the next Pi extension load, so a successful
  // switch ALWAYS reloads.
  return {
    changed: true,
    needsReload: true,
    text: value === "gentle"
      ? "Gentle sidebar enabled (ours)."
      : "Gentle sidebar disabled (native renders again).",
  };
}

// Moshi enable prerequisites (customize-command S38). Before the switch
// flips to On, the enable path verifies (a) the `moshi-hook` CLI resolves
// on PATH by exact name, and (b) `moshi-hook status --json` (fixed argv,
// short timeout) reports a top-level `paired: true`. Pairing is what lets
// a notification reach the phone; the token itself is only consumed by
// `moshi-hook pair --token` and is never read, logged, stored, or
// returned here — only the `paired` flag the CLI reports. Either check
// missing refuses with one message naming the fix, and changes NOTHING:
// no flag write, no settings write, no exclusion entry, no reload, and
// the switch stays Off. The `pi` hooks entry is deliberately NOT
// required: enabling excludes `extensions/moshi-hooks.ts` on purpose, so
// this plugin is the single notifier. The disable path never calls here;
// disabling stays unconditional.
//
// Self-contained like the rest of this file: the installed copy ships
// without sibling modules, so this mirrors lib/moshi-prereq.js inline
// (keep the three refusal literals byte-identical in both files) instead
// of importing it. The two seams below are the injectable test surface
// (mirroring the customizeTuiLoader pattern): production uses the real
// PATH scan + spawnSync, tests replace either seam so no real
// `moshi-hook` — which may talk to a daemon — is ever spawned.
const MOSHI_BIN_NAME = "moshi-hook";
const MOSHI_STATUS_ARGS = ["status", "--json"];
const MOSHI_STATUS_TIMEOUT_MS = 5000;

let moshiHookResolver = null;
let moshiStatusRunner = null;

export function setMoshiHookResolver(fn) {
  moshiHookResolver = typeof fn === "function" ? fn : null;
}

export function setMoshiStatusRunner(fn) {
  moshiStatusRunner = typeof fn === "function" ? fn : null;
}

function defaultResolveMoshiHook() {
  // Exact-name PATH scan; never through a shell (join + stat only).
  const names = process.platform === "win32"
    ? ["moshi-hook.exe", "moshi-hook.cmd", "moshi-hook.bat", MOSHI_BIN_NAME]
    : [MOSHI_BIN_NAME];
  const pathEnv = process.env.PATH ?? "";
  for (const dir of String(pathEnv).split(pathDelimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        // Unreadable entries never decide; keep scanning.
      }
    }
  }
  return null;
}

function defaultRunMoshiStatus(cliPath) {
  // Fixed argv, no shell, short timeout. Only the top-level `paired`
  // flag is read; every other field (secretStore, hooks, ...) is ignored.
  let result;
  try {
    result = spawnSync(cliPath, [...MOSHI_STATUS_ARGS], {
      encoding: "utf8",
      timeout: MOSHI_STATUS_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch {
    return { ok: false, reason: "spawn-failed" };
  }
  if (!result || result.status !== 0) {
    return { ok: false, reason: "non-zero-exit", status: result ? result.status : null };
  }
  const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!out) return { ok: false, reason: "unparseable" };
  let doc;
  try {
    doc = JSON.parse(out);
  } catch {
    return { ok: false, reason: "unparseable" };
  }
  if (!isRecord(doc)) return { ok: false, reason: "missing-field" };
  if (doc.paired !== true) return { ok: false, reason: doc.paired === false ? "not-paired" : "missing-field" };
  return { ok: true };
}

function moshiMissingCliText() {
  return "Moshi notifications cannot be enabled: the `moshi-hook` CLI was not found on PATH; install the Moshi CLI, then re-apply On from /herdr-gentle:customize.";
}

function moshiNotPairedText() {
  return "Moshi notifications cannot be enabled: `moshi-hook status --json` reports paired:false (this device is not paired); run `moshi-hook pair --token <pairing-token>`, then re-apply On from /herdr-gentle:customize.";
}

function moshiStatusFailedText(reason, status) {
  let detail = "could not be run";
  if (reason === "non-zero-exit") detail = `exited with status ${status ?? "unknown"}`;
  else if (reason === "unparseable") detail = "produced no parseable JSON";
  else if (reason === "missing-field") detail = "reported no paired flag";
  return `Moshi notifications cannot be enabled: \`moshi-hook status --json\` did not confirm pairing (${detail}); make sure the Moshi CLI is installed and paired (\`moshi-hook pair --token <pairing-token>\`), then re-apply On from /herdr-gentle:customize.`;
}

async function checkMoshiEnablePrereqs() {
  const resolve = moshiHookResolver ?? defaultResolveMoshiHook;
  const run = moshiStatusRunner ?? defaultRunMoshiStatus;
  let cliPath = null;
  try {
    cliPath = await resolve();
  } catch {
    cliPath = null;
  }
  if (typeof cliPath !== "string" || cliPath.length === 0) {
    return { ok: false, text: moshiMissingCliText() };
  }
  let status;
  try {
    status = await run(cliPath);
  } catch {
    status = { ok: false, reason: "spawn-failed" };
  }
  if (status && status.ok === true) return { ok: true, cliPath };
  if (status && status.reason === "not-paired") return { ok: false, text: moshiNotPairedText() };
  const reason = status && typeof status.reason === "string" ? status.reason : "spawn-failed";
  return { ok: false, text: moshiStatusFailedText(reason, status ? status.status : null) };
}

function customizeMoshiRead() {
  try {
    return moshiFlagEnabled(moshiFlagPath()) ? "on" : "off";
  } catch {
    return "off";
  }
}

async function customizeMoshiApply(value, ctx) {
  if (value !== "on" && value !== "off") {
    return { changed: false, needsReload: false, text: `Unknown Moshi value ${JSON.stringify(value)}; nothing was changed.` };
  }
  let current = null;
  try {
    current = customizeMoshiRead();
  } catch {
    current = null;
  }
  if (current === value) {
    return {
      changed: false,
      needsReload: false,
      text: `Moshi notifications already ${value === "on" ? "on" : "off"}; nothing was changed.`,
    };
  }
  const want = value === "on";
  // S38: enabling requires the real prerequisites first. The gate runs
  // before any write, so a refusal changes NOTHING (no flag file, no
  // settings write, no exclusion entry, no reload) and the switch stays
  // Off. Disabling skips the gate entirely and stays unconditional.
  if (want) {
    let gate;
    try {
      gate = await checkMoshiEnablePrereqs();
    } catch (err) {
      gate = { ok: false, text: moshiStatusFailedText("spawn-failed", null) };
    }
    if (!gate || gate.ok !== true) {
      return {
        changed: false,
        needsReload: false,
        text: (gate && typeof gate.text === "string" && gate.text) || moshiStatusFailedText("spawn-failed", null),
      };
    }
  }
  const file = moshiFlagPath();
  let exclusionBefore = null;
  try {
    exclusionBefore = moshiExclusionPresent();
  } catch {
    exclusionBefore = null;
  }
  try {
    writeMoshiFlag(file, want);
  } catch (err) {
    return { changed: false, needsReload: false, text: `Could not write ${file}: ${(err && err.message) || err}; nothing was changed.` };
  }
  let exclusion = { ok: true, note: "settings.json untouched." };
  try {
    exclusion = setMoshiExclusion(want);
  } catch (err) {
    exclusion = { ok: false, note: `could not update the Moshi hook exclusion: ${(err && err.message) || err}.` };
  }
  let exclusionAfter = null;
  try {
    exclusionAfter = moshiExclusionPresent();
  } catch {
    exclusionAfter = null;
  }
  // S6 reload matrix: the flag is re-read per event (hot, immediate), so
  // a reload is only needed when the exclusion entry actually changed —
  // it applies at the next Pi load.
  return {
    changed: true,
    needsReload: exclusionBefore !== exclusionAfter,
    text: `Moshi notifications ${want ? "enabled" : "disabled"}. ${exclusion.note}`,
  };
}

function registerCustomizeProviders() {
  try {
    globalThis[Symbol.for("herdr-gentle.customize.v1")] = {
      sidebar: { read: customizeSidebarRead, apply: customizeSidebarApply },
      moshi: { read: customizeMoshiRead, apply: customizeMoshiApply },
    };
  } catch {
    // Fail closed: without the slot the panel renders both categories
    // unavailable instead of throwing at load.
  }
}

export default function (pi) {
  registerCustomizeProviders();
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

  // Moshi replacement state (DESIGN §7): the session context the envelopes
  // carry (undefined while the toggle is off or for a lineage child), the last
  // ctx seen (so enabling mid-session still opens the row), and the tool that
  // opened the current ask episode.
  let moshiContext;
  let moshiCtxRef;
  let lastAskToolName;

  // Live background jobs (Gentle Shell `bash_background` / `monitor`), from
  // the bus snapshot. Session-scoped: a snapshot owned by another session
  // never counts here.
  let jobsSnapshot;

  function runningJobCount() {
    if (!jobsSnapshot) return 0;
    const owner = jobsSnapshot.sessionId;
    const mine = sessionId;
    if (
      typeof owner === "string" &&
      owner.length > 0 &&
      typeof mine === "string" &&
      mine.length > 0 &&
      owner !== mine
    ) {
      return 0;
    }
    return jobsSnapshot.jobs.length;
  }

  // A job starting or ending is a state change: publish immediately so the
  // sidebar and the native report follow it, and keep the beat alive while
  // jobs run (the marker has its own TTL).
  function onJobsSnapshot(value) {
    if (!isRecord(value) || !isRecord(value.snapshot) || !Array.isArray(value.snapshot.jobs)) return;
    const jobs = value.snapshot.jobs.filter(
      (entry) => isRecord(entry) && typeof entry.id === "string" && entry.id.length > 0,
    );
    jobsSnapshot = {
      sessionId: typeof value.sessionId === "string" ? value.sessionId : undefined,
      jobs,
    };
    schedulePublish();
  }

  // Subscribed before the `enabled()` guard would matter: the bus event is
  // session-scoped display data, so it is safe to observe anywhere. Hosts
  // whose runtime has no event bus simply never see it (jobs stay at zero,
  // which is today's behavior).
  if (typeof pi?.events?.on === "function") pi.events.on(JOBS_SIDEBAR_EVENT, onJobsSnapshot);

  function moshiCapture(ctx) {
    const record = isRecord(ctx) ? ctx : undefined;
    const file = typeof sessionFile === "string" ? sessionFile : "";
    if (!file || moshiSessionIsChild(file)) {
      moshiContext = undefined;
      return;
    }
    const cwd = moshiFirstString(record?.cwd, process.cwd());
    moshiContext = {
      sessionId: moshiFirstString(sessionId, "pi"),
      transcriptPath: file,
      cwd,
      modelName: moshiModelLabel(record?.model),
      contextRemaining: moshiContextRemaining(record),
      project: moshiProjectName(cwd, moshiTerminal()),
    };
  }

  function moshiEmit(eventName, extra = {}) {
    if (!rootSession) return;
    if (!moshiContext && !moshiEnsureContext()) return;
    const context = moshiContext;
    if (!context) return;
    const envelope = {
      type: "session.update",
      source: MOSHI_AGENT,
      sessionId: context.sessionId,
      eventName,
      cwd: context.cwd,
      projectName: context.project,
      ...moshiTerminal(),
      modelName: context.modelName,
      transcriptPath: context.transcriptPath,
      requestedAt: new Date().toISOString(),
      ...extra,
    };
    if (typeof context.contextRemaining === "number" && context.contextRemaining > 0) {
      envelope.contextRemaining = Math.round(context.contextRemaining);
    }
    moshiSendEnvelope(envelope);
  }

  // Captures on demand and sends the silent carrier once per session, so
  // enabling Moshi mid-session still opens the Chat View row instead of
  // waiting for the next Pi session.
  function moshiEnsureContext() {
    if (moshiContext) return true;
    if (!rootSession || !moshiEnabled()) return false;
    moshiCapture(moshiCtxRef);
    if (!moshiContext) return false;
    moshiEmit("SessionStart");
    return true;
  }
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
  // S62 live-scan state: session cwd for scope, generation guard so a stale
  // async scan never overwrites a newer session, coalesced in-flight flag.
  let liveGen = 0;
  let liveInFlight = false;
  let liveQueued = false;
  let sessionCwd;
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
  // Seeded from the clock exactly like herdr's own plugin SDK
  // (`let reportSeq = Date.now() * 1000`): the counter must stay monotonic
  // ACROSS processes, because Herdr ignores a report whose seq loses to the
  // stored one. A zero-based counter makes every report after a Pi restart or
  // `/new` (both recreate this runtime) lose, which freezes the pane's
  // `agent_session` binding at the old session; the consumer then rejects the
  // fresh tokens (session-hash mismatch) and the sidebar stays on `idle`.
  let nativeSeq = Date.now() * 1000;
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
      const cwd = ctx?.cwd;
      if (typeof cwd === "string" && cwd.length > 0) sessionCwd = cwd;
    } catch {}
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
      // Moshi replacement (DESIGN §7): a real ask episode is the only
      // intervention that reaches the phone — one approval_required per
      // intentId, exactly like the Herdr toast, and never a speculative ask.
      if (moshiContext || moshiEnabled()) {
        moshiEmit("PermissionRequest", {
          category: "approval_required",
          phase: "waitingForApproval",
          actionId: askIntentId,
          title: `Gentle ask: ${moshiContext?.project ?? "Gentle"}`,
          subtitle: "Answer in terminal",
          message: `${moshiContext?.project ?? "Gentle"} has a question and is waiting for your answer. Return to Pi to respond.`,
          ...(lastAskToolName ? { toolName: lastAskToolName } : {}),
        });
      }
    }
  }

  function updateBlocker() {
    if (!rootSession) return;
    // Disabled sidebar hands the lifecycle back to native: no gentle
    // labels are claimed. A stale active label is released once so the
    // consumer can settle, then this leg stays silent.
    if (!sidebarPublishingEnabled()) {
      if (emittedLabel !== undefined) {
        emittedLabel = undefined;
        try {
          pi.events.emit(BLOCKED_EVENT, { active: false });
        } catch {}
      }
      return;
    }
    ensureAskIntent();
    if (!askActiveNow()) {
      askIntentId = undefined;
      lastAskToolName = undefined;
    }
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
    if (rootSession && (agentActive || subs.length > 0 || pendingCalls.size > 0 || runningJobCount() > 0)) {
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
      runningJobCount() > 0 ||
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
      jobCount: runningJobCount(),
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
  // Same clock-seeded rule as nativeSeq above: the session binding is the
  // report that must win after a restart, so it can never be zero-based.
  let nativeSessionSeq = Date.now() * 1000;

  async function reportSession(sessionStartSource) {
    if (!enabled() || !sidebarPublishingEnabled()) return;
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
        if (ok) {
          const wasWorking = nativeLastOk?.state === "working";
          nativeLastOk = next;
          // Moshi replacement (DESIGN §7): the real finish is the native
          // transition into `idle` — settled plus zero running/queued plus
          // zero pending plus no human wait — never a settle with work left.
          if (wasWorking && next.state === "idle") {
            const project = moshiContext?.project ?? "Gentle";
            const lastLabel = lastFinishedLabel(tasks);
            moshiEmit("AgentEnd", {
              category: "task_complete",
              title: `Gentle finished: ${project}`,
              message:
                lastLabel !== undefined
                  ? `${project} finished \u2014 ${lastLabel}. Return to Pi for what\u2019s next.`
                  : `${project} finished and is waiting for your next instruction.`,
            });
          }
        }
      }
    } finally {
      nativeInFlight = false;
      if (nativePending !== null) void drainNative();
    }
  }

  function queueNative() {
    if (!enabled() || !sidebarPublishingEnabled()) return;
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
    if (!rootSession || !sidebarPublishingEnabled()) return;
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
    void liveRefreshChanges();
  }

  // S62 authoritative publisher: live Git over the subscribed scope.
  // Async, fixed-argv, coalesced; fail-stale keeps the last good totals
  // (never 0/0, never partial) so a git failure cannot advertise clean.
  async function liveRefreshChanges() {
    if (!rootSession || !sessionManager || !sessionId) return;
    if (liveInFlight) {
      liveQueued = true;
      return;
    }
    liveInFlight = true;
    const gen = liveGen;
    try {
      let entries;
      try {
        entries = sessionManager.getEntries?.() ?? [];
      } catch {
        return;
      }
      let cwdRoot;
      if (typeof sessionCwd === "string" && sessionCwd.length > 0) {
        try {
          const probe = await liveRunGit(sessionCwd, ["rev-parse", "--show-toplevel"]);
          if (probe && probe.code === 0 && typeof probe.stdout === "string") {
            const top = probe.stdout.trim();
            if (top.length > 0) cwdRoot = top;
          }
        } catch {}
      }
      const roots = liveResolveScopeRoots(entries, sessionId, cwdRoot);
      const summary = await liveSummarizeRoots(roots);
      if (gen !== liveGen || !rootSession) return;
      if (!summary.ok) return;
      changes = { files: summary.files, added: summary.added, deleted: summary.deleted };
      schedulePublish();
    } finally {
      liveInFlight = false;
      if (liveQueued) {
        liveQueued = false;
        if (gen === liveGen) void liveRefreshChanges();
      }
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
    liveGen += 1;
    liveInFlight = false;
    liveQueued = false;
    sessionCwd = undefined;
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
      lastAskToolName = event.toolName;
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

  // S62 scope registration: a newly registered worktree affects the live
  // aggregate immediately (same trigger shape as the transcript event).
  pi.events.on("gentle-pi:session-worktree-changed", (event) => {
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
    moshiCtxRef = ctx;
    if (moshiEnabled()) moshiEnsureContext();
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
    moshiCtxRef = ctx;
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
    refreshChanges();
    schedulePublish();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || ctx?.isIdle?.() !== true) return;
    moshiCtxRef = ctx;
    agentActive = false;
    settled = true;
    // Retain settle-time pending evidence for native gating before the
    // metadata hint clears (see nativeSettledPending above).
    if (pendingCalls.size > 0) nativeSettledPending = true;
    pendingCalls.clear();
    // S62 turn-end: the working tree may have changed without transcript
    // evidence (external/untracked edits), so re-scan before publishing.
    refreshChanges();
    if (activeSubs().length === 0 && !askActiveNow() && !reviewActive) {
      clearEmittedLabel();
      void publishNow();
    } else {
      schedulePublish();
    }
  });

  pi.on("session_shutdown", () => {
    // Close the Moshi row before the session state is dropped. The host
    // awaits this handler, so the flush keeps the process alive until the
    // envelope lands (or the bound expires).
    if (moshiEnsureContext()) {
      moshiEmit("SessionEnd", {
        type: "session.closed",
        category: "session_ended",
        title: "Pi session ended",
      });
    }
    moshiContext = undefined;
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
    return moshiFlushSends(1000);
  });
}
