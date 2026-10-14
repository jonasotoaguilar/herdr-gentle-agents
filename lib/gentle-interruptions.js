'use strict';

// Daemon-owned interruption ledger (odd/tasks/supervision-diagnostics.md
// L6): diagnostic-only `Interrumpido` backing state. The daemon is the sole
// persistent writer of gentle-interruptions.json; diagnostic readers never
// write. `--once` never touches this file (it must not become a second
// writer); only the `--run` daemon loop persists.
//
// State shape (exact L6 schema):
//   {version:1,panes:{[pane_id]:{session_hash:string|null,
//     observed_display:string,last_fresh_ts:number,interrupted_at:number,
//     reason:"agent_disappeared"}}}
// Only the identity hash, finite timestamps, whitelisted unfinished
// displays, and the fixed reason may be stored or exposed. Records are
// created only on explicit disappearance of a previously live, fresh
// unfinished owned agent while the pane still exists, and removed on fresh
// new activity or explicit pane close/confirmed pane absence. Done/graceful
// close, stale tokens alone, malformed snapshots, producer session
// mismatch, and transport failure never establish interruption. No sidebar
// state, notification, spool, telemetry, or token carries this signal.

const fs = require('node:fs');
const path = require('node:path');

const contract = require('./gentle-tokens');

const INTERRUPTIONS_FILE = 'gentle-interruptions.json';
const INTERRUPTION_REASON = 'agent_disappeared';

// Reducer displays that count as unfinished owned activity. Terminal
// `done`/`idle` are excluded: a settled done with fresh count 0 is proof
// of completion, never disappearance, and idle covers stale/foreign/empty
// evidence that must fail closed.
const UNFINISHED_DISPLAYS = new Set([
  'working',
  'orchestrating',
  'explorer',
  'worker',
  'verify',
  'judge',
  'ask',
  'review',
  'error',
]);

const HASH_RE = /^[A-Za-z0-9_-]{43}$/;

function interruptionsPath(stateDir) {
  return path.join(stateDir, INTERRUPTIONS_FILE);
}

function blankInterruptions() {
  return { version: 1, panes: {} };
}

function isPaneId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256;
}

function isValidRecord(record) {
  if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
  const keys = Object.keys(record).sort();
  if (keys.join(',') !== 'interrupted_at,last_fresh_ts,observed_display,reason,session_hash') return false;
  if (record.session_hash !== null && (typeof record.session_hash !== 'string' || !HASH_RE.test(record.session_hash))) return false;
  if (!UNFINISHED_DISPLAYS.has(record.observed_display)) return false;
  if (!Number.isFinite(record.last_fresh_ts) || !Number.isFinite(record.interrupted_at)) return false;
  if (record.reason !== INTERRUPTION_REASON) return false;
  return true;
}

// Tolerant load: missing, malformed, or partially invalid state degrades
// to a blank ledger (valid records are kept, invalid ones dropped), never
// a crash. Readers tolerate a missing file the same way.
function loadInterruptions(stateDir) {
  const blank = blankInterruptions();
  let raw;
  try {
    raw = fs.readFileSync(interruptionsPath(stateDir), 'utf8');
  } catch {
    return blank;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return blank;
  }
  if (typeof parsed !== 'object' || parsed === null || parsed.version !== 1) return blank;
  const panes = parsed.panes;
  if (typeof panes !== 'object' || panes === null || Array.isArray(panes)) return blank;
  for (const [paneId, record] of Object.entries(panes)) {
    if (isPaneId(paneId) && isValidRecord(record)) blank.panes[paneId] = record;
  }
  return blank;
}

// Atomic persist (tmp + rename) so a crashed daemon never leaves a torn
// ledger behind. Only valid records are written; invalid entries fail
// closed (dropped) rather than persisted.
function saveInterruptions(stateDir, state) {
  const clean = blankInterruptions();
  const panes = state?.panes;
  if (typeof panes === 'object' && panes !== null && !Array.isArray(panes)) {
    for (const [paneId, record] of Object.entries(panes)) {
      if (isPaneId(paneId) && isValidRecord(record)) clean.panes[paneId] = record;
    }
  }
  const tmp = `${interruptionsPath(stateDir)}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(clean)}\n`, 'utf8');
  fs.renameSync(tmp, interruptionsPath(stateDir));
}

// Fresh owned evidence for one snapshot entry: any session-bound,
// TTL-fresh producer signal (work, orchestrating marker, durable ask or
// review token). Stale, foreign-session, malformed, or missing signals are
// not fresh — TTL expiration alone is never failure evidence. Unowned
// (pi-tree) panes are never fresh for this ledger regardless of signals.
function hasFreshSignal(entry, reduced, now = Date.now()) {
  if (!reduced || reduced.owned !== true) return false;
  const sessionHash = contract.expectedSessionHash(entry);
  if (sessionHash === null) return false;
  const tokens = entry?.tokens;
  if (typeof tokens !== 'object' || tokens === null || Array.isArray(tokens)) return false;
  return (
    contract.parseWork(tokens.gentle_work_v1, sessionHash, now) !== null ||
    contract.parseOrchestrating(tokens.gentle_orchestrating_v1, sessionHash, now) !== null ||
    contract.parseAsk(tokens.gentle_ask_v1, sessionHash, now) !== null ||
    contract.parseReview(tokens.gentle_review_v1, sessionHash, now) !== null
  );
}

// Pure ledger transition for one daemon frame. Inputs: prior (paneId ->
// {session_hash, observed_display, last_fresh_ts} tracking the last fresh
// unfinished owned sighting), stored (loaded ledger object), live (paneId
// -> {entry, reduced} for panes present in the agent snapshot), paneIds
// (Set of pane ids from a successful pane list, or null when the pane
// read failed and presence is unknown), now. Returns {prior, stored,
// changed}. Never throws on malformed input: bad entries fail closed.
function updateInterruptions({ prior, stored, live, paneIds, now }) {
  const nextPrior = {};
  if (prior && typeof prior === 'object' && !Array.isArray(prior)) {
    for (const [paneId, seen] of Object.entries(prior)) {
      if (!isPaneId(paneId) || typeof seen !== 'object' || seen === null) continue;
      if (!UNFINISHED_DISPLAYS.has(seen.observed_display)) continue;
      if (!Number.isFinite(seen.last_fresh_ts)) continue;
      if (seen.session_hash !== null && (typeof seen.session_hash !== 'string' || !HASH_RE.test(seen.session_hash))) continue;
      nextPrior[paneId] = {
        session_hash: seen.session_hash ?? null,
        observed_display: seen.observed_display,
        last_fresh_ts: seen.last_fresh_ts,
      };
    }
  }
  const nextStored = blankInterruptions();
  if (stored && typeof stored === 'object' && stored.version === 1 && stored.panes && typeof stored.panes === 'object') {
    for (const [paneId, record] of Object.entries(stored.panes)) {
      if (isPaneId(paneId) && isValidRecord(record)) nextStored.panes[paneId] = { ...record };
    }
  }
  let changed = false;
  const dropRecord = (paneId) => {
    if (paneId in nextStored.panes) {
      delete nextStored.panes[paneId];
      changed = true;
    }
  };

  const liveMap = live && typeof live === 'object' && !Array.isArray(live) ? live : {};
  // Panes present in the snapshot: refresh prior on fresh unfinished
  // owned evidence, clear any record on fresh evidence (new activity —
  // including a fresh terminal done, which is settled proof, not
  // disappearance). Stale/foreign/malformed entries leave prior and
  // records untouched.
  for (const [paneId, sighting] of Object.entries(liveMap)) {
    if (!isPaneId(paneId)) continue;
    const entry = sighting?.entry;
    const reduced = sighting?.reduced;
    if (!reduced || reduced.owned !== true) {
      if (paneId in nextPrior) {
        delete nextPrior[paneId];
        changed = true;
      }
      continue;
    }
    if (!hasFreshSignal(entry, reduced, now)) continue;
    const sessionHash = contract.expectedSessionHash(entry);
    if (UNFINISHED_DISPLAYS.has(reduced.display)) {
      const prev = nextPrior[paneId];
      if (!prev || prev.session_hash !== sessionHash || prev.observed_display !== reduced.display || prev.last_fresh_ts !== now) {
        nextPrior[paneId] = { session_hash: sessionHash, observed_display: reduced.display, last_fresh_ts: now };
        changed = true;
      }
    } else {
      // Fresh terminal evidence (done): no longer unfinished, resolved.
      if (paneId in nextPrior) {
        delete nextPrior[paneId];
        changed = true;
      }
    }
    dropRecord(paneId);
  }

  // Panes absent from the snapshot: only a previously fresh unfinished
  // sighting plus a successful pane list showing the pane still exists may
  // record. Unknown presence (failed pane read) records nothing; confirmed
  // absence removes prior and record (explicit close, not interruption).
  for (const paneId of Object.keys(nextPrior)) {
    if (paneId in liveMap) continue;
    if (paneIds === null || paneIds === undefined) continue;
    if (!paneIds.has(paneId)) {
      delete nextPrior[paneId];
      dropRecord(paneId);
      changed = true;
      continue;
    }
    const seen = nextPrior[paneId];
    const existing = nextStored.panes[paneId];
    if (existing && existing.session_hash === seen.session_hash && existing.observed_display === seen.observed_display) continue;
    nextStored.panes[paneId] = {
      session_hash: seen.session_hash,
      observed_display: seen.observed_display,
      last_fresh_ts: seen.last_fresh_ts,
      interrupted_at: existing && Number.isFinite(existing.interrupted_at) ? existing.interrupted_at : now,
      reason: INTERRUPTION_REASON,
    };
    changed = true;
  }

  return { prior: nextPrior, stored: nextStored, changed };
}

module.exports = {
  INTERRUPTIONS_FILE,
  INTERRUPTION_REASON,
  UNFINISHED_DISPLAYS,
  interruptionsPath,
  blankInterruptions,
  isValidRecord,
  loadInterruptions,
  saveInterruptions,
  hasFreshSignal,
  updateInterruptions,
};
