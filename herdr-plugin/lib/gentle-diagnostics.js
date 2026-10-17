'use strict';

// Shared read-only helpers for the standalone diagnostics CLIs
// (bin/gentle-doctor.js, bin/gentle-trace.js, bin/gentle-whois.js).
//
// Read-only contract: nothing here creates directories, writes files,
// publishes tokens, starts/stops the daemon, or reads transcripts. State
// and config paths resolve with the existing env precedence but are only
// ever read (bounded, fail-closed). Herdr is reached exclusively through
// fixed-argv `HERDR_BIN_PATH` CLI calls — no socket, no shell.
//
// Privacy contract: only whitelisted reduced state crosses this module —
// safe pane/workspace ids, validated agent names, agent_status enum,
// role slugs, running counts, freshness booleans, the identity session
// hash, and the strictly validated L6 interruption record. Raw producer
// tokens, task labels/summaries, review verdicts, transcripts, and
// arbitrary ledger fields are never returned.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Active plugin lookup identity (S15 rename). The stored state dir below
// intentionally keeps the pre-rename segment: no migration, no orphaned
// flags. Used by install.sh and the sidebar provider for lookups.
const ACTIVE_PLUGIN_ID = 'herdr-gentle-shell';
const STATE_PLUGIN_ID = 'herdr-gentle-agents';
const PLUGIN_ID = STATE_PLUGIN_ID;
// Family of files proving a state dir is ours: when the Herdr-injected
// dir (which changes with the plugin id) holds none of these while the
// stored dir does, the stored dir wins so pre-rename flags stay readable.
// Fresh installs with no stored files converge on the injected dir.
const STATE_KNOWN_FILES = [
  'gentle-sidebar-mode.json',
  'gentle-moshi.json',
  'pi-extension-exclusion-owned',
  'gentle-status.pid',
  'gentle-interruptions.json',
  'installer-state',
  'gentle-worktree-mode.json',
];
const CLI_TIMEOUT_MS = 5000;
const MAX_FILE_BYTES = 256 * 1024;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const PANE_ID_RE = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$/;
const WORKSPACE_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const AGENT_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
const AGENT_STATUS_RE = /^(idle|working|blocked|done|unknown)$/;
// L6 unfinished displays only: terminal done/idle (and anything unknown)
// never qualify as an interruption signal.
const UNFINISHED_DISPLAYS = new Set([
  'working', 'orchestrating', 'explorer', 'worker', 'verify', 'judge', 'ask', 'review', 'error',
]);
const INTERRUPTION_REASON = 'agent_disappeared';

function herdrBinary() {
  const bin = process.env.HERDR_BIN_PATH;
  return typeof bin === 'string' && bin.length > 0 ? bin : 'herdr';
}

// Existing state-directory precedence (mirrors bin/gentle-status.js) but
// WITHOUT mkdir: readers fail closed to "absent" instead of creating.
// S15 rename compat: GENTLE_STATUS_STATE_DIR (explicit user override) is
// used as-is; HERDR_PLUGIN_STATE_DIR is Herdr-injected and changes with
// the plugin id, so an empty injected dir never orphans the stored
// pre-rename flags (see STATE_KNOWN_FILES above).
function storedStateDir(env = process.env) {
  if (env?.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, 'herdr', 'plugins', STATE_PLUGIN_ID);
  const base =
    process.platform === 'win32'
      ? (env?.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
      : path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'herdr', 'plugins', STATE_PLUGIN_ID);
}

function dirHasKnownFiles(dir) {
  for (const name of STATE_KNOWN_FILES) {
    try {
      if (fs.existsSync(path.join(dir, name))) return true;
    } catch {
      // A single unreadable entry never decides; keep scanning.
    }
  }
  return false;
}

function resolveStateDir(env = process.env) {
  const explicit = env?.GENTLE_STATUS_STATE_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return path.resolve(explicit);
  const stored = storedStateDir(env);
  // HEAD parity: an explicit-but-empty (or otherwise invalid non-nullish)
  // value ignores every override and uses the stored default. Only an
  // omitted (null/undefined) explicit falls through to the injected dir.
  if (explicit !== undefined && explicit !== null) return stored;
  const injected = env?.HERDR_PLUGIN_STATE_DIR;
  if (typeof injected !== 'string' || injected.length === 0) return stored;
  const resolvedInjected = path.resolve(injected);
  if (resolvedInjected === stored) return resolvedInjected;
  try {
    if (dirHasKnownFiles(resolvedInjected)) return resolvedInjected;
    if (dirHasKnownFiles(stored)) return stored;
  } catch {
    // Fall through to the injected dir on unexpected failure.
  }
  return resolvedInjected;
}

function resolveConfigPath(env = process.env) {
  if (env?.HERDR_CONFIG_PATH) return path.resolve(env.HERDR_CONFIG_PATH);
  const xdg = env?.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'herdr', 'config.toml');
  const base =
    process.platform === 'win32'
      ? (env?.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : path.join(os.homedir(), '.config');
  return path.join(base, 'herdr', 'config.toml');
}

// Bounded read; null when missing/unreadable/oversize — never throws.
function readFileBounded(file, maxBytes = MAX_FILE_BYTES) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > maxBytes) return null;
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

// Strip control characters (incl. ANSI framing residue), collapse
// whitespace, trim, and bound to maxChars code points. Never returns raw
// snapshot text beyond the budget.
function sanitizeCell(value, maxChars = 64) {
  if (typeof value !== 'string') return '';
  const clean = value
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const chars = Array.from(clean);
  return chars.length > maxChars ? chars.slice(0, maxChars).join('') : chars.join('');
}

// Fit a sanitized cell into width columns, reserving one ellipsis char on
// truncation. Widths are code-point counts (robust without deps).
function fitCell(text, width) {
  const chars = Array.from(typeof text === 'string' ? text : '');
  if (width <= 0) return '';
  if (chars.length <= width) return chars.join('');
  if (width === 1) return '…';
  return `${chars.slice(0, width - 1).join('')}…`;
}

function terminalWidth(fallback = 80) {
  const fromEnv = Number(process.env.COLUMNS);
  if (Number.isSafeInteger(fromEnv) && fromEnv >= 20 && fromEnv <= 512) return fromEnv;
  const tty = Number(process.stdout?.columns);
  if (Number.isSafeInteger(tty) && tty >= 20 && tty <= 512) return tty;
  return fallback;
}

function safePaneId(value) {
  return typeof value === 'string' && PANE_ID_RE.test(value) ? value : null;
}

function safeWorkspaceId(value) {
  return typeof value === 'string' && WORKSPACE_ID_RE.test(value) ? value : null;
}

// Fixed-argv Herdr call. Only the two read-only list commands are allowed;
// anything else is an internal programming error, never caller input.
const ALLOWED_COMMANDS = new Set(['agent list', 'pane list']);

function herdrJson(...args) {
  if (!ALLOWED_COMMANDS.has(args.join(' '))) return { ok: false, error: 'command_not_allowed' };
  try {
    const result = spawnSync(herdrBinary(), args, {
      encoding: 'utf8',
      timeout: CLI_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    if (result.status !== 0 || typeof result.stdout !== 'string' || !result.stdout.trim()) {
      return { ok: false, error: 'snapshot_unavailable' };
    }
    return { ok: true, json: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: 'snapshot_unavailable' };
  }
}

// Null on failure (never empty-as-success): callers must treat failure as
// a failed view, not as "no panes".
function loadAgents() {
  const reply = herdrJson('agent', 'list');
  if (!reply.ok) return null;
  const agents = reply.json?.result?.agents;
  return Array.isArray(agents) ? agents : null;
}

// Strict L6 ledger validation. Returns { ok, missing, malformed, panes }.
// Missing file tolerates to empty; malformed file tolerates to empty with
// malformed:true — arbitrary fields are dropped, never exposed.
function loadInterruptions(stateDir) {
  const file = path.join(stateDir, 'gentle-interruptions.json');
  let body;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) {
      return { ok: false, missing: false, malformed: true, panes: {} };
    }
    body = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { ok: true, missing: true, malformed: false, panes: {} };
    }
    return { ok: false, missing: false, malformed: true, panes: {} };
  }
  let doc;
  try {
    doc = JSON.parse(body);
  } catch {
    return { ok: false, missing: false, malformed: true, panes: {} };
  }
  if (typeof doc !== 'object' || doc === null || doc.version !== 1) {
    return { ok: false, missing: false, malformed: true, panes: {} };
  }
  const raw = doc.panes;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, missing: false, malformed: true, panes: {} };
  }
  const panes = {};
  for (const [paneId, record] of Object.entries(raw)) {
    if (safePaneId(paneId) === null) continue;
    if (typeof record !== 'object' || record === null || Array.isArray(record)) continue;
    const { session_hash, observed_display, last_fresh_ts, interrupted_at, reason } = record;
    if (session_hash !== null && !(typeof session_hash === 'string' && HASH_RE.test(session_hash))) continue;
    if (typeof observed_display !== 'string' || !UNFINISHED_DISPLAYS.has(observed_display)) continue;
    if (!Number.isFinite(last_fresh_ts) || !Number.isFinite(interrupted_at)) continue;
    if (reason !== INTERRUPTION_REASON) continue;
    // The identity hash is L6-whitelisted exposure (validated 43-char or
    // null); every other arbitrary field was already dropped above.
    panes[paneId] = { session_hash, observed_display, last_fresh_ts, interrupted_at, reason };
  }
  return { ok: true, missing: false, malformed: false, panes };
}

// Null on failure (never empty-as-success): callers must treat failure as
// a failed view, not as confirmed pane absence.
function loadPanes() {
  const reply = herdrJson('pane', 'list');
  if (!reply.ok) return null;
  const panes = reply.json?.result?.panes;
  return Array.isArray(panes) ? panes : null;
}

// Safe presence index over a pane-list snapshot: pane_id -> raw entry.
// Only well-formed ids are indexed; callers whitelist every field they
// expose (never raw tokens, labels, or paths).
function indexPanesById(panes) {
  const byId = new Map();
  if (!Array.isArray(panes)) return byId;
  for (const entry of panes) {
    const id = safePaneId(entry?.pane_id);
    if (id !== null && !byId.has(id)) byId.set(id, entry);
  }
  return byId;
}

function sidebarModeStatus(stateDir) {
  const file = path.join(stateDir, 'gentle-sidebar-mode.json');
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return { enabled: false, malformed: true };
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (doc === null || typeof doc !== 'object' || Array.isArray(doc) || doc.version !== 1 || typeof doc.enabled !== 'boolean') {
      return { enabled: false, malformed: true };
    }
    return { enabled: doc.enabled, malformed: false };
  } catch (error) {
    if (error?.code === 'ENOENT') return { enabled: true, malformed: false };
    return { enabled: false, malformed: true };
  }
}

// Pidfile presence is NOT liveness: parse the pid and signal 0 it.
// Returns { present, pid, alive } — all best-effort, never throws.
function daemonStatus(stateDir) {
  const body = readFileBounded(path.join(stateDir, 'gentle-status.pid'), 64);
  if (body === null) return { present: false, pid: null, alive: false };
  const pid = Number(body.trim());
  if (!Number.isSafeInteger(pid) || pid <= 0) return { present: true, pid: null, alive: false };
  try {
    process.kill(pid, 0);
    return { present: true, pid, alive: true };
  } catch {
    return { present: true, pid, alive: false };
  }
}

const MANAGED_BEGIN = '# BEGIN herdr-gentle-agents (managed; do not edit)';
const MANAGED_END = '# END herdr-gentle-agents';

// Read-only sidebar override probe: managed present? unmanaged
// rows_by_agent header outside our markers? Never writes.
function sidebarOverrideStatus(configPath) {
  const body = readFileBounded(configPath);
  if (body === null) return { found: false, managed: false, unmanaged: false };
  const managed = body.includes(MANAGED_BEGIN) && body.includes(MANAGED_END);
  const stripped = stripManagedBlocks(body);
  const unmanaged = /^\s*\[.*\brows_by_agent\b.*\]\s*(#.*)?$/m.test(stripped);
  return { found: true, managed, unmanaged };
}

function stripManagedBlocks(text) {
  let rest = text;
  let out = '';
  for (;;) {
    const begin = rest.indexOf(MANAGED_BEGIN);
    if (begin < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, begin);
    const end = rest.indexOf(MANAGED_END, begin);
    if (end < 0) break;
    rest = rest.slice(end + MANAGED_END.length);
  }
  return out;
}

// Whitelisted per-pane summary. Requires the gentle-tokens contract for
// role/freshness parsing; exposes only safe scalar fields — never raw
// tokens, summaries, labels, titles, or paths.
function summarizePane(entry, contract, now = Date.now()) {
  const paneId = safePaneId(entry?.pane_id);
  if (paneId === null) return null;
  const tokens = typeof entry?.tokens === 'object' && entry.tokens !== null ? entry.tokens : {};
  const sessionHash = contract.expectedSessionHash(entry);
  const agent =
    typeof entry?.agent === 'string' && AGENT_NAME_RE.test(entry.agent) ? entry.agent : '';
  const agentStatus =
    typeof entry?.agent_status === 'string' && AGENT_STATUS_RE.test(entry.agent_status)
      ? entry.agent_status
      : 'unknown';
  const roles = contract.parseRoles(tokens.gentle_roles_v1);
  const work = sessionHash === null ? null : contract.parseWork(tokens.gentle_work_v1, sessionHash, now);
  let reduced;
  try {
    reduced = contract.reducePane(entry, now);
  } catch {
    reduced = null;
  }
  const display =
    reduced && typeof reduced.display === 'string' ? sanitizeCell(reduced.display, 16) : 'unknown';
  const workspaceId = safeWorkspaceId(entry?.workspace_id) ?? '';
  const workspace = sanitizeCell(contract.parseWorkspaceName(entry), 48);
  return {
    pane_id: paneId,
    workspace_id: workspaceId,
    workspace,
    agent,
    agent_status: agentStatus,
    display,
    label: reduced && typeof reduced.label === 'string' ? sanitizeCell(reduced.label, 32) : display,
    roles: roles.map((role) => sanitizeCell(role, 32)).slice(0, 16),
    count: work === null ? null : work.count,
    owned: reduced ? reduced.owned !== false : true,
    freshness: {
      work: work !== null,
      orchestrating:
        sessionHash === null
          ? false
          : contract.parseOrchestrating(tokens.gentle_orchestrating_v1, sessionHash, now) !== null,
      ask:
        sessionHash === null
          ? false
          : contract.parseAsk(tokens.gentle_ask_v1, sessionHash, now) !== null,
      review:
        sessionHash === null
          ? false
          : contract.parseReview(tokens.gentle_review_v1, sessionHash, now) !== null,
    },
    session_hash: sessionHash,
  };
}

module.exports = {
  PLUGIN_ID,
  ACTIVE_PLUGIN_ID,
  STATE_PLUGIN_ID,
  HASH_RE,
  UNFINISHED_DISPLAYS,
  INTERRUPTION_REASON,
  herdrBinary,
  resolveStateDir,
  resolveConfigPath,
  readFileBounded,
  sanitizeCell,
  fitCell,
  terminalWidth,
  safePaneId,
  safeWorkspaceId,
  herdrJson,
  loadAgents,
  loadPanes,
  indexPanesById,
  loadInterruptions,
  sidebarModeStatus,
  daemonStatus,
  sidebarOverrideStatus,
  summarizePane,
};
