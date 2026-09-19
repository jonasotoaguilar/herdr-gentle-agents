'use strict';

// Gentle-sidecar token contract: validation + reducer (DESIGN.md §4.3, §5).
//
// Pure module: no I/O, no Herdr calls. The daemon (bin/gentle-status.js)
// supplies snapshot entries; every function takes `now` explicitly so the
// rules stay testable without clocks.
//
// Security posture (security-and-hardening, implementation mode): every token
// shape is validated with an anchored grammar before use; the session binding
// (sha256 of the pane's agent_session path, base64url, 43 chars) must match
// exactly or the signal is dropped; malformed or foreign-session tokens fail
// closed to "no signal", never to a guessed state. Names are advisory only:
// a bad names token degrades the label to `working (n)`, never the count.

const { createHash } = require('node:crypto');

// DESIGN §4.3 grammars. COUNT allows "0"; WORK/CHANGES expiry fields require
// >= 1 (an expiry of 0 is never fresh, so it is rejected at parse time).
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const WORK_RE = /^([A-Za-z0-9_-]{43}):(0|[1-9]\d{0,15}):([1-9]\d{0,15})$/;
const CHANGES_RE = /^([A-Za-z0-9_-]{43}):(0|[1-9]\d{0,15}):(0|[1-9]\d{0,15}):([1-9]\d{0,15})$/;
// herdr:blocked labels, DESIGN §4.2. Id charset mirrors the producer's ID_RE.
const BLOCKED_RE = /^(ask|review|error):([A-Za-z0-9_-]{1,64})$/;
// Advisory names: printable, no CSV separators or quotes (producer strips
// \x00-\x1f\x7f-\x9f and , " \n \r, then truncates to 64 chars).
const NAME_BAD_RE = /[\x00-\x1f\x7f-\x9f",]/;

// DESIGN §3 O5 / §8: absolute expiry, 60 s horizon at write. Readers use
// `now` at read; clock skew is documented, not compensated.
const TTL_MS = 60000;

// Reduced displays, DESIGN §5.2. `subs` = working with 1+ delegated subagents.
const DISPLAYS = ['working', 'working_subs', 'ask', 'review', 'error', 'done', 'idle'];

const STATE_TOKENS = {
  working: 'gentle_state_working',
  working_subs: 'gentle_state_working_subs',
  ask: 'gentle_state_ask',
  review: 'gentle_state_review',
  error: 'gentle_state_error',
  done: 'gentle_state_done',
  idle: 'gentle_state_idle',
};

const TITLE_TOKENS = {
  working: 'gentle_title_working',
  working_subs: 'gentle_title_working_subs',
  ask: 'gentle_title_ask',
  review: 'gentle_title_review',
  error: 'gentle_title_error',
  done: 'gentle_title_done',
  idle: 'gentle_title_idle',
};

const BADGE_TOKEN = 'gentle_badge';

// Every token name this daemon may write: 7 state + 7 title + 1 badge = 15,
// so one report never crosses the 16-token ceiling (DESIGN §8). The sweeper
// clears exactly these names and nothing else (DESIGN §3 O5).
const OWNED_TOKENS = [...Object.values(STATE_TOKENS), ...Object.values(TITLE_TOKENS), BADGE_TOKEN];

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Expected sessionHash for a pane: base64url(sha256(agent_session path)).
// Mirrors pi-tree lib/state.js delegatedCount. Null when the session ref is
// missing or malformed — every gentle signal for that pane then fails
// closed (foreign-session protection).
function expectedSessionHash(entry) {
  const session = entry?.agent_session;
  if (!isRecord(session)) return null;
  if (session.agent !== 'pi' || session.kind !== 'path') return null;
  if (typeof session.value !== 'string' || session.value.length === 0) return null;
  const hash = createHash('sha256').update(session.value, 'utf8').digest('base64url');
  return HASH_RE.test(hash) ? hash : null;
}

function expiryFresh(expiry, now) {
  return Number.isSafeInteger(expiry) && expiry > now && expiry <= now + TTL_MS;
}

// gentle_work_v1 = <hash>:<count>:<expiry>. Null on any grammar, binding,
// or freshness failure — one bad token never poisons the other signals.
function parseWork(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = WORK_RE.exec(value);
  if (!match) return null;
  const [, hash, rawCount, rawExpiry] = match;
  if (hash !== sessionHash) return null;
  const count = Number(rawCount);
  const expiry = Number(rawExpiry);
  if (!Number.isSafeInteger(count) || count < 0) return null;
  if (!expiryFresh(expiry, now)) return null;
  return { count, expiry };
}

// gentle_changes_v1 = <hash>:<files>:<added+deleted>:<expiry>.
function parseChanges(value, sessionHash, now) {
  if (typeof value !== 'string') return null;
  const match = CHANGES_RE.exec(value);
  if (!match) return null;
  const [, hash, rawFiles, rawDelta, rawExpiry] = match;
  if (hash !== sessionHash) return null;
  const files = Number(rawFiles);
  const delta = Number(rawDelta);
  const expiry = Number(rawExpiry);
  if (!Number.isSafeInteger(files) || files < 0) return null;
  if (!Number.isSafeInteger(delta) || delta < 0) return null;
  if (!expiryFresh(expiry, now)) return null;
  return { files, delta, expiry };
}

// gentle_names_v1 = CSV of sanitized labels. Advisory: invalid entries are
// dropped individually; a wholly unusable value yields [] (caller falls back
// to `working (n)`).
function parseNames(value) {
  if (typeof value !== 'string' || value.length === 0) return [];
  const names = [];
  for (const part of value.split(',')) {
    if (part.length === 0 || part.length > 64) continue;
    if (NAME_BAD_RE.test(part)) continue;
    if (names.includes(part)) continue;
    names.push(part);
  }
  return names;
}

// Strongest fresh blocked label wins: error > ask > review (DESIGN §5.2).
// Reads the snapshot's state_labels map (populated from pane.report_agent
// `message`, which the managed herdr-agent-state.ts sets to the
// `herdr:blocked` label). Foreign values that miss the grammar are ignored.
function parseBlockedLabel(stateLabels) {
  if (!isRecord(stateLabels)) return null;
  let found = null;
  const rank = { error: 0, ask: 1, review: 2 };
  for (const value of Object.values(stateLabels)) {
    if (typeof value !== 'string') continue;
    const match = BLOCKED_RE.exec(value);
    if (!match) continue;
    const [, kind, id] = match;
    if (found === null || rank[kind] < rank[found.kind]) found = { kind, id };
  }
  return found;
}

// DESIGN §3 O1 single-writer handoff: a pane pi-tree owns is never written.
// pi-tree claims a pane with a FRESH pi_subagents_work_v1 (same grammar and
// session binding we enforce on our own tokens) or with presence-encoded
// pi-tree-DISTINCTIVE state/title display tokens. Bare `state_idle` /
// `title_idle` are EXCLUDED: Herdr's native sidebar publishes those names on
// every ordinary pane (observed live 2026-09-19: pi-tree disabled, tokens
// cleared at unconfigure, yet state_idle/title_idle present), so treating
// them as foreign ownership bricks the plugin on all normal panes. Stale
// foreign work tokens do NOT claim the pane (TTL wins, O5). Any other
// lingering distinctive foreign presence still claims it — that residue is a
// handover-verification item, and yielding stays the fail-safe direction.
const PITREE_DISTINCTIVE = new Set([
  'state_working',
  'state_done',
  'state_blocked',
  'state_idle_fresh',
  'state_idle_stale',
  'state_unknown',
  'title_working',
  'title_done',
  'title_blocked',
  'title_idle_fresh',
  'title_idle_stale',
  'title_unknown',
]);
function piTreeOwnsPane(tokens, sessionHash, now) {
  const foreign = tokens.pi_subagents_work_v1;
  if (typeof foreign === 'string' && parseWork(foreign, sessionHash, now) !== null) return true;
  // Ungrammatical-but-present foreign work tokens are ignored (read-only,
  // never deleted, never parsed for state).
  for (const name of Object.keys(tokens)) {
    if (PITREE_DISTINCTIVE.has(name)) return true;
  }
  return false;
}

// Reducer, DESIGN §5.2. First match wins:
//   error > ask > review > working(subs) > working(main) > done > idle.
// `notify` is set only for ask (DESIGN §7; review/error stay silent).
// A native `blocked` with no fresh gentle label clears our family (fail
// closed): the block belongs to another writer or the producer died, so we
// must not paint `working` over it — native attention still fires.
function reducePane(entry, now = Date.now()) {
  const tokens = isRecord(entry?.tokens) ? entry.tokens : {};
  const native = typeof entry?.agent_status === 'string' ? entry.agent_status : 'unknown';
  const sessionHash = expectedSessionHash(entry);
  const idle = { display: 'idle', label: 'idle', badge: '', notify: null };

  if (piTreeOwnsPane(tokens, sessionHash, now)) return { ...idle, owned: false };

  const work = sessionHash === null ? null : parseWork(tokens.gentle_work_v1, sessionHash, now);
  const changes = sessionHash === null ? null : parseChanges(tokens.gentle_changes_v1, sessionHash, now);
  const badge = changes !== null && changes.files > 0 ? `~${changes.delta}` : '';
  // Blocked labels are fresh iff the producer beat is alive (full-state
  // snapshots every beat carry a fresh work token while the session lives).
  const blocked = work === null ? null : parseBlockedLabel(entry?.state_labels);

  const out = (display, label, notify = null) => ({ display, label, badge, notify, owned: true });

  if (blocked !== null) {
    if (blocked.kind === 'error') return out('error', 'error');
    if (blocked.kind === 'ask') {
      return out('ask', 'ask', { sessionHash, intentId: blocked.id, expiry: work.expiry });
    }
    return out('review', 'review');
  }
  if (native === 'blocked') return out('idle', 'idle');
  if (work !== null && work.count > 0) {
    const names = parseNames(tokens.gentle_names_v1);
    if (work.count === 1 && names.length === 1) return out('working_subs', `working (${names[0]})`);
    return out('working_subs', `working (${work.count})`);
  }
  if (native === 'working' || (work !== null && work.count === 0 && native !== 'done' && native !== 'idle')) {
    return out('working', 'working');
  }
  // `done` never outlives its evidence: without a fresh work token the
  // settle is either ancient (TTL expired) or was never observed here —
  // both fall through to idle (native fallback, O5).
  if (native === 'done' && work !== null) return out('done', 'done');
  return out('idle', 'idle');
}

// Full publish family for a reduced pane: the current state/title names carry
// values, every other owned name is null (presence-encoding: a stale name
// left behind would render beside the current one). State values carry the
// machine key, title values the human label; the badge rides separately so
// state and changes stay independently observable (DESIGN §3 O4 — never ↳,
// never merged).
function displayTokens(result) {
  const patch = {};
  for (const display of DISPLAYS) {
    patch[STATE_TOKENS[display]] = display === result.display ? display : null;
    patch[TITLE_TOKENS[display]] = display === result.display ? result.label : null;
  }
  patch[BADGE_TOKEN] = result.badge || null;
  return patch;
}

module.exports = {
  TTL_MS,
  DISPLAYS,
  STATE_TOKENS,
  TITLE_TOKENS,
  BADGE_TOKEN,
  OWNED_TOKENS,
  expectedSessionHash,
  parseWork,
  parseChanges,
  parseNames,
  parseBlockedLabel,
  piTreeOwnsPane,
  reducePane,
  displayTokens,
};
