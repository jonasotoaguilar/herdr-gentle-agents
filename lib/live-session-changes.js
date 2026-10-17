'use strict';
// Live session changes (customize-command S62/T48): authoritative local live
// Git metric mirroring gentle-shell's lib/shell-changes.ts +
// lib/session-changes.ts + lib/session-worktree-registry.ts scope semantics.
//
// Why this module exists: the Herdr producer previously published transcript
// evidence sums (SESSION_CHANGE_ENTRY before/after patches). Gentle-shell
// shows the CURRENT working tree against HEAD for the session's subscribed
// roots. The user explicitly approved a local equivalent implementation
// (no private module imports, no edits to gentle-shell): this is that
// equivalent, read-only scanner. Numerical equality is the goal, not
// provenance labels.
//
// Reference parity notes (deliberate, documented):
// - Commands are EXACTLY the reference argv: `diff --numstat HEAD` (no -z,
//   no -M) and `status --porcelain=v1 --untracked-files=all -z`. The sibling
//   lib/worktree-changes.js uses `diff --numstat -z -M HEAD`; for ordinary
//   text edits both count identically, but renames and exotic filenames can
//   differ in encoding. Publishing uses THIS module, never worktree-changes,
//   so warp/copy/delete mutations stay decoupled from the published metric.
// - Untracked lines are counted from disk exactly like the reference
//   (utf8 read, empty -> 0, else newline count). Binary untracked files are
//   therefore counted as decoded lines, matching the reference; the sibling
//   helper instead probes NUL bytes and reports 0 + a binary label. That
//   difference is intentional here: equality with gentle-shell wins.
// - Scope is sessionChangeRoots(sessionId, entries) = registered worktree
//   roots (custom/gentle-pi.session-worktree/v1, includes the session's own
//   cwd registration) plus captured evidence roots
//   (custom/gentle-pi.session-change/v1), same-session bound, realpath
//   deduped, filtered by existence (a `.git` entry under the root) and by
//   the home/broad-user-directory guard. Discovery (`worktree list`) never
//   grants visibility to unsubscribed checkouts. A failed root never reads
//   as clean: any per-root git failure fails the whole scan stale
//   ({ok:false}), never 0/0 and never partial totals as complete.
// - Nothing here mutates: fixed argv, no shell, bounded timeouts, async
//   only (never spawnSync on the agent event loop).

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');

const GIT_TIMEOUT_MS = 5000;
const DIFF_MAX_BYTES = 1024 * 1024;
const CHANGE_STATUS = {
  MODIFIED: 'modified',
  ADDED: 'added',
  DELETED: 'deleted',
  RENAMED: 'renamed',
  UNTRACKED: 'untracked',
};
const STATUS_BY_CODE = {
  A: CHANGE_STATUS.ADDED,
  D: CHANGE_STATUS.DELETED,
  R: CHANGE_STATUS.RENAMED,
  C: CHANGE_STATUS.ADDED,
  '?': CHANGE_STATUS.UNTRACKED,
};
const RENAME_BRACES = /\{([^{}]*) => ([^{}]*)\}/g;
const HAS_RENAME_BRACES = /\{[^{}]* => [^{}]*\}/;
const RENAME_ARROW = ' => ';

const NUMSTAT_ARGS = ['diff', '--numstat', 'HEAD'];
const PORCELAIN_ARGS = ['status', '--porcelain=v1', '--untracked-files=all', '-z'];

const SESSION_WORKTREE_ENTRY = 'gentle-pi.session-worktree/v1';
const SESSION_CHANGE_ENTRY = 'gentle-pi.session-change/v1';

function emptyChanges() {
  return { files: [], added: 0, deleted: 0 };
}

function renamedPath(p) {
  if (HAS_RENAME_BRACES.test(p)) return p.replace(RENAME_BRACES, '$2').replace(/\/\//g, '/');
  const arrow = p.indexOf(RENAME_ARROW);
  return arrow === -1 ? p : p.slice(arrow + RENAME_ARROW.length);
}

function count(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseNumstat(text) {
  const entries = [];
  for (const line of String(text ?? '').split('\n')) {
    const [added, deleted, ...rest] = line.split('\t');
    if (added === undefined || deleted === undefined || rest.length === 0) continue;
    entries.push({ path: renamedPath(rest.join('\t')), added: count(added), deleted: count(deleted) });
  }
  return entries;
}

function parsePorcelain(text) {
  const statuses = new Map();
  const records = String(text ?? '').split('\0').filter((record) => record.length > 0);
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    const p = record.slice(3);
    if (!p.endsWith('/')) statuses.set(p, STATUS_BY_CODE[code[0]] ?? STATUS_BY_CODE[code[1]] ?? CHANGE_STATUS.MODIFIED);
    if (code[0] === 'R' || code[0] === 'C') index += 1;
  }
  return statuses;
}

function snapshotChanges(snapshot) {
  const counts = new Map(parseNumstat(snapshot.numstat).map((entry) => [entry.path, entry]));
  const files = [];
  for (const [p, status] of parsePorcelain(snapshot.porcelain)) {
    if (status === CHANGE_STATUS.UNTRACKED && /(?:^|\/)node_modules\.backup-[^/]+\//.test(p)) continue;
    const entry = counts.get(p);
    files.push({ path: p, added: entry?.added ?? 0, deleted: entry?.deleted ?? 0, status });
  }
  return files;
}

function changesModel(changed) {
  const files = [...changed].sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    added: files.reduce((total, file) => total + file.added, 0),
    deleted: files.reduce((total, file) => total + file.deleted, 0),
  };
}

// Home / broad-user-directory guard (mirrors bounded-writer-admission.ts).
const BROAD_HOME_FOLDER = /^(?:documents|desktop|downloads|onedrive(?: - .+)?)$/i;
const BROAD_ONEDRIVE_FOLDER = /^(?:documents|desktop)$/i;

function isHomeOrBroadUserDirectory(targetPath, options = {}) {
  const platform = options.platform ?? process.platform;
  const fold = (value) => (platform === 'win32' ? String(value).toLowerCase() : String(value));
  let home;
  try {
    home = options.home ?? fs.realpathSync.native(os.homedir());
  } catch {
    return true;
  }
  const target = fold(targetPath);
  const canonicalHome = fold(home);
  const towardHome = path.relative(target, canonicalHome);
  if (towardHome === '' || (!path.isAbsolute(towardHome) && towardHome !== '..' && !towardHome.startsWith('..\\') && !towardHome.startsWith('../'))) return true;
  const parent = path.dirname(target);
  if (parent === canonicalHome) return BROAD_HOME_FOLDER.test(path.basename(targetPath));
  return path.dirname(parent) === canonicalHome
    && /^onedrive(?: - .+)?$/i.test(path.basename(parent))
    && BROAD_ONEDRIVE_FOLDER.test(path.basename(targetPath));
}

function defaultRootExists(root) {
  try {
    return fs.existsSync(path.join(root, '.git'));
  } catch {
    return false;
  }
}

function isValidEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') return false;
  if (typeof evidence.id !== 'string' || evidence.id.length === 0) return false;
  if (typeof evidence.root !== 'string' || !path.isAbsolute(evidence.root)) return false;
  if (typeof evidence.path !== 'string' || evidence.path.length === 0) return false;
  if (path.isAbsolute(evidence.path) || /[\0\r\n]/.test(evidence.root + evidence.path)) return false;
  if (evidence.path.split(/[\\/]/).some((part) => part === '..' || part === '.git')) return false;
  return true;
}

// Mirrors session-changes.ts sessionChangeRoots: union of registered
// worktree roots and evidence roots, bound to one session id.
function sessionChangeRoots(sessionId, entries) {
  const roots = new Set();
  for (const entry of entries ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    if (entry.type !== 'custom' || !entry.data || typeof entry.data !== 'object') continue;
    const data = entry.data;
    if (data.sessionId !== sessionId) continue;
    if (entry.customType === SESSION_WORKTREE_ENTRY && typeof data.root === 'string' && path.isAbsolute(data.root)) {
      roots.add(data.root);
    }
    if (entry.customType === SESSION_CHANGE_ENTRY && isValidEvidence(data.evidence)) {
      roots.add(data.evidence.root);
    }
  }
  return [...roots];
}

// Scope: session cwd root plus sessionChangeRoots, realpath deduped,
// existence + broad-directory guarded. Never enumerates unsubscribed
// checkouts of the clone.
function resolveScopeRoots(entries, sessionId, opts = {}) {
  const rootExists = typeof opts.rootExists === 'function' ? opts.rootExists : defaultRootExists;
  const home = opts.home;
  const platform = opts.platform;
  const candidates = [];
  if (typeof opts.cwdRoot === 'string' && opts.cwdRoot.length > 0) candidates.push(opts.cwdRoot);
  for (const root of sessionChangeRoots(sessionId, entries)) candidates.push(root);
  const seen = new Set();
  const out = [];
  for (const candidate of candidates) {
    let real = candidate;
    try {
      real = fs.realpathSync(candidate);
    } catch {
      // A missing(javax) path cannot be scanned; skip without failing scope.
      continue;
    }
    const key = platform === 'win32' ? real.toLowerCase() : real;
    if (seen.has(key)) continue;
    seen.add(key);
    let exists = false;
    try {
      exists = rootExists(real);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    try {
      if (isHomeOrBroadUserDirectory(real, home === undefined ? {} : { home, platform })) continue;
    } catch {
      continue;
    }
    out.push(real);
  }
  return out;
}

function sanitizedEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
}

function defaultRunGit(root, args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? GIT_TIMEOUT_MS;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn('git', ['-C', root, ...args], {
        env: sanitizedEnv(),
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
      });
    } catch (err) {
      finish({ stdout: '', code: 1, error: (err && err.message) || String(err) });
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish({ stdout, code: 1, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs + 500);
    if (timer.unref) timer.unref();
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ stdout, code: 1, error: (err && err.message) || String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ stdout, code: typeof code === 'number' ? code : 1, stderr });
    });
  });
}

async function defaultReadUntrackedLines(root, rel) {
  const target = path.join(root, rel);
  let info;
  try {
    info = await fs.promises.lstat(target);
  } catch {
    return 0;
  }
  if (!info.isFile() || info.size > DIFF_MAX_BYTES) return 0;
  let text;
  try {
    text = await fs.promises.readFile(target, 'utf8');
  } catch {
    return 0;
  }
  return text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

// Read-only aggregate over explicitly scoped roots. Returns
// {ok:true, files, added, deleted, model, roots} or
// {ok:false, error, failedRoots} — never partial totals as complete.
async function summarizeRoots(roots, opts = {}) {
  const list = Array.isArray(roots) ? roots.slice() : [];
  if (list.length === 0) {
    return { ok: true, files: 0, added: 0, deleted: 0, model: emptyChanges(), roots: [] };
  }
  const runGit = typeof opts.runGit === 'function' ? opts.runGit : (root, args) => defaultRunGit(root, args, { timeoutMs: opts.timeoutMs });
  const readLines = typeof opts.readUntrackedLines === 'function' ? opts.readUntrackedLines : defaultReadUntrackedLines;
  const perRoot = [];
  const failedRoots = [];
  await Promise.all(list.map(async (root) => {
    let numstat;
    let porcelain;
    try {
      [numstat, porcelain] = await Promise.all([runGit(root, NUMSTAT_ARGS), runGit(root, PORCELAIN_ARGS)]);
    } catch (err) {
      failedRoots.push(root);
      return;
    }
    if (!porcelain || porcelain.code !== 0) {
      failedRoots.push(root);
      return;
    }
    const files = snapshotChanges({ numstat: (numstat && numstat.code === 0 ? numstat.stdout : ''), porcelain: porcelain.stdout });
    await Promise.all(files.map(async (file) => {
      if (file.status !== CHANGE_STATUS.UNTRACKED) return;
      try {
        file.added = await readLines(root, file.path);
      } catch {
        file.added = 0;
      }
    }));
    perRoot.push({ root, model: changesModel(files) });
  }));
  if (failedRoots.length > 0) {
    return { ok: false, error: `cannot read git changes in ${failedRoots.length} checkout(s)`, failedRoots };
  }
  const multi = perRoot.length > 1;
  const combined = changesModel(perRoot.flatMap((tree) => tree.model.files.map((file) => ({
    ...file,
    path: multi ? `${tree.root}/${file.path}` : file.path,
  }))));
  return {
    ok: true,
    files: combined.files.length,
    added: combined.added,
    deleted: combined.deleted,
    model: combined,
    roots: perRoot.map((t) => t.root),
  };
}

module.exports = {
  GIT_TIMEOUT_MS,
  DIFF_MAX_BYTES,
  NUMSTAT_ARGS,
  PORCELAIN_ARGS,
  SESSION_WORKTREE_ENTRY,
  SESSION_CHANGE_ENTRY,
  emptyChanges,
  parseNumstat,
  parsePorcelain,
  snapshotChanges,
  changesModel,
  isHomeOrBroadUserDirectory,
  sessionChangeRoots,
  resolveScopeRoots,
  summarizeRoots,
  defaultRunGit,
};
