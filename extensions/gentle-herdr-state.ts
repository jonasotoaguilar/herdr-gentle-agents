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
//   gentle_changes_v1 = <hash>:<files>:<added+deleted>:<expiry>
//   gentle_names_v1   = CSV of TaskRecord.label/agent (sanitized, ≤64 chars
//                       each, most-recent first, total ≤ ~512 chars; excess
//                       advisory names are dropped, never chunked — the §4.5
//                       #p= overflow form never triggers by construction)
//   herdr:blocked     = "ask:" intentId / "review:" reviewId / "error:" code
//                       (single effective label, priority error > ask >
//                       review, edge-triggered so the native counter in
//                       herdr-agent-state.ts stays balanced)
//
// Event seams (all in-process; this extension imports nothing from
// gentle-shell — DESIGN §10 U6 source pin is unresolved, so the producer is
// self-contained and observes only the Pi extension API):
//   subagent activity : tool_call/tool_result for subagent_run|continue
//                       (optimistic active) + structured
//                       details.gentleAgents {taskId,agent,status,mode} from
//                       subagent_run|status|result tool_results (authoritative
//                       refresh; active = running|queued per §4.2).
//   ask               : ASK_USER_CHOICE_BLOCKED_EVENT +
//                       rpiv:ask-user:blocked (questionnaire) +
//                       pi-permission-system:permission-request waiting state
//                       (tool-gated confirmation leg). One intentId minted per
//                       ¬ask→ask episode; stable across beats in the episode.
//   review            : RESERVED hook `gentle-pi:review:blocked`
//                       {active, reviewId?}. DESIGN §10 U4 (review-in-progress
//                       matcher) is UNRESOLVED: gentle-ai exposes no review
//                       lifecycle event, so this listener has no sender yet
//                       and `review:` never fires. Do not invent a matcher.
//   error             : subagent task failed status / subagent tool error /
//                       repeated own-transport failure. Latched until the next
//                       agent_start (fresh snapshot), TTL-bounded display.
//   changes           : SESSION_CHANGE_ENTRY facts re-aggregated from the
//                       session transcript (write|edit tool outcomes only,
//                       never git status) on `gentle-pi:session-change`.
//                       Per-file delta is a prefix/suffix-trimmed line diff —
//                       exact for single-hunk edits, approximate otherwise —
//                       so counts follow the U5 `~N` approximate reading until
//                       U5 fixes the aggregation rule.
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
const MAX_TRACKED_TASKS = 128;
const MAX_CHANGE_PATHS = 256;
const TASK_STALE_MS = 30 * 60 * 1000;
const TRANSPORT_FAIL_LATCH = 3;
const CLI_FALLBACK_TIMEOUT_MS = 2500;

const ASK_EVENT = "gentle-pi:ask-user-choice:blocked";
const QUESTIONNAIRE_EVENT = "rpiv:ask-user:blocked";
const PERMISSION_EVENT = "pi-permission-system:permission-request";
const REVIEW_EVENT = "gentle-pi:review:blocked"; // reserved hook, see U4 note above
const CHANGE_EVENT = "gentle-pi:session-change";
const CHANGE_ENTRY = "gentle-pi.session-change/v1";
const BLOCKED_EVENT = "herdr:blocked";

const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const COUNT_RE = /^(0|[1-9]\d{0,15})$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ACTIVE_TASK = new Set(["running", "queued"]);

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
    socket.on("data", () => finish(true));
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
      for (const [name, value] of Object.entries(patch)) args.push("--token", `${name}=${value}`);
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
// ---------------------------------------------------------------------------

function snapshotText(snapshot) {
  return snapshot && snapshot.kind === "text" && typeof snapshot.text === "string" ? snapshot.text : undefined;
}

function countLines(text) {
  if (text.length === 0) return 0;
  return text.split("\n").length;
}

// Prefix/suffix-trimmed line diff: exact for single-hunk edits, approximate
// otherwise (DESIGN §10 U5 pending the exact ±N/~N rule).
function diffLines(before, after) {
  const a = before.split("\n");
  const b = after.split("\n");
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail += 1;
  return { added: b.length - head - tail, deleted: a.length - head - tail };
}

function fileDelta(before, after) {
  const beforeText = snapshotText(before);
  const afterText = snapshotText(after);
  if (beforeText !== undefined && afterText !== undefined) {
    if (beforeText === afterText) return { added: 0, deleted: 0, noop: true };
    return { ...diffLines(beforeText, afterText), noop: false };
  }
  if (before === undefined || before?.kind === "absent") {
    return { added: afterText !== undefined ? countLines(afterText) : 0, deleted: 0, noop: false };
  }
  if (after === undefined || after?.kind === "absent") {
    return { added: 0, deleted: beforeText !== undefined ? countLines(beforeText) : 0, noop: false };
  }
  return { added: 0, deleted: 0, noop: false };
}

function isPlausibleEvidence(evidence) {
  return (
    isRecord(evidence) &&
    typeof evidence.id === "string" &&
    evidence.id.length > 0 &&
    typeof evidence.path === "string" &&
    evidence.path.length > 0 &&
    isRecord(evidence.before) &&
    isRecord(evidence.after)
  );
}

function aggregateChanges(entries, sessionId) {
  const seen = new Set();
  const perPath = new Map();
  let paths = 0;
  for (const entry of entries ?? []) {
    if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== CHANGE_ENTRY) continue;
    const data = entry.data;
    if (!isRecord(data) || data.sessionId !== sessionId || !isPlausibleEvidence(data.evidence)) continue;
    const evidence = data.evidence;
    if (seen.has(evidence.id)) continue;
    seen.add(evidence.id);
    let slot = perPath.get(evidence.path);
    if (!slot) {
      if (paths >= MAX_CHANGE_PATHS) continue;
      paths += 1;
      slot = { before: evidence.before, after: evidence.after };
      perPath.set(evidence.path, slot);
    } else {
      slot.after = evidence.after;
    }
  }
  let files = 0;
  let delta = 0;
  for (const { before, after } of perPath.values()) {
    const { added, deleted, noop } = fileDelta(before, after);
    if (noop) continue;
    files += 1;
    delta += added + deleted;
  }
  return { files, delta };
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

  // Subagent tracking: optimistic pending tool calls + authoritative refresh
  // from structured details.gentleAgents on subagent_* tool results.
  const pendingCalls = new Map(); // toolCallId -> { agent, label, at }
  const tasks = new Map(); // taskId -> { agent, label, status, at }

  // Blocker legs. ask combines choice + questionnaire + tool-gated
  // confirmation; exactly one intentId per ¬ask→ask episode.
  let choiceActive = false;
  let questionnaireActive = false;
  const permissionPending = new Set();
  let askIntentId;
  let askCounter = 0;
  // Review leg: reserved for the U4 matcher; no sender exists yet.
  let reviewActive = false;
  let reviewId;
  // Error latch: cleared on the next agent_start (fresh snapshot).
  let errorCode;
  let emittedLabel;

  let changes = { files: 0, delta: 0 };
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
    return choiceActive || questionnaireActive || permissionPending.size > 0;
  }

  function desiredLabel() {
    if (errorCode) return `error:${errorCode}`;
    if (askActiveNow()) return `ask:${askIntentId}`;
    if (reviewActive) return `review:${reviewId}`;
    return undefined;
  }

  function updateBlocker() {
    if (!rootSession) return;
    const askNow = askActiveNow();
    if (askNow && !askIntentId) {
      askCounter += 1;
      askIntentId = sanitizeId(undefined, `q${askCounter.toString(36)}-`);
    }
    if (!askNow) askIntentId = undefined;
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

  function activeSubs() {
    const now = Date.now();
    const out = [];
    for (const pending of pendingCalls.values()) out.push({ agent: pending.agent, label: pending.label, at: pending.at });
    for (const task of tasks.values()) {
      if (ACTIVE_TASK.has(task.status) && now - task.at < TASK_STALE_MS) {
        out.push({ agent: task.agent, label: task.label, at: task.at });
      }
    }
    out.sort((a, b) => b.at - a.at);
    return out;
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

  function buildTokens() {
    if (!sessionHash) return {};
    const expiry = Date.now() + TTL_MS;
    const subs = activeSubs();
    const tokens = {};
    const count = String(subs.length);
    if (COUNT_RE.test(count)) tokens.gentle_work_v1 = `${sessionHash}:${count}:${expiry}`;
    const csv = namesCsv(subs);
    if (csv.length > 0) tokens.gentle_names_v1 = csv;
    if (changes.files > 0) {
      const files = String(changes.files);
      const delta = String(changes.delta);
      if (COUNT_RE.test(files) && COUNT_RE.test(delta)) {
        tokens.gentle_changes_v1 = `${sessionHash}:${files}:${delta}:${expiry}`;
      }
    }
    return tokens;
  }

  function interesting() {
    return agentActive || activeSubs().length > 0 || emittedLabel !== undefined;
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
    askIntentId = undefined;
    reviewActive = false;
    reviewId = undefined;
    errorCode = undefined;
    changes = { files: 0, delta: 0 };
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

  // -- review leg (reserved hook; DESIGN §10 U4 unresolved — no sender yet) --

  pi.events.on(REVIEW_EVENT, (event) => {
    if (!rootSession || !isRecord(event) || typeof event.active !== "boolean") return;
    if (event.active === reviewActive) return;
    reviewActive = event.active;
    if (reviewActive && typeof event.reviewId === "string" && ID_RE.test(event.reviewId)) {
      reviewId = event.reviewId;
    }
    updateBlocker();
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
    if (typeof event.toolCallId === "string") pendingCalls.delete(event.toolCallId);
    const details = isRecord(event.details) ? event.details.gentleAgents : undefined;
    if (!isRecord(details) || typeof details.taskId !== "string") {
      if (event.toolName === "subagent_run" && event.isError === true && !errorCode) {
        errorCode = "task-failed";
        updateBlocker();
      }
      return;
    }
    const status = typeof details.status === "string" ? details.status : "running";
    const agent =
      typeof details.agent === "string" && details.agent.length > 0
        ? details.agent.slice(0, MAX_LABEL_CHARS)
        : "subagent";
    const previous = tasks.get(details.taskId);
    tasks.set(details.taskId, {
      agent,
      label: previous?.label ?? agent,
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
