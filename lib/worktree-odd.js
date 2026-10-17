'use strict';
// Odd-document helpers for the worktree tools (customize-command S25-S28,
// S30-S31).
//
// The registry stores odd documents per worktree entry as `odd[]`
// (`odd/<rel>` names, as the tool-pipeline capture records them). This
// module adds the two read paths the tools share:
// - detection: the `.md` documents inside a checkout's own `odd/`
//   directory, scanned boundedly, returned as `odd/<rel>` names;
// - validation: the OPTIONAL `odd` parameter of `worktree_create`,
//   checked for existence exactly like supplied `issues` are (an omitted
//   field means "leave untouched", a supplied value — including an empty
//   one — replaces the stored value).
//
// Pure Node, no subprocesses, never throws on unreadable directories:
// an absent `odd/` simply contributes no documents.

const fs = require('node:fs');
const path = require('node:path');

const ODD_DIR_NAME = 'odd';
const ODD_SCAN_MAX_FILES = 500;
const ODD_SCAN_MAX_DEPTH = 10;
const ODD_SCAN_MAX_ENTRIES = 5000;

// Bounded (`.md` only) listing of a checkout's own `odd/` directory,
// returned as `odd/<rel>` names sorted in scan order. Never throws:
// any unreadable directory contributes nothing.
function detectOddDocs(worktreePath) {
  const rels = [];
  if (typeof worktreePath !== 'string' || worktreePath.length === 0) return rels;
  const oddDir = path.join(worktreePath, ODD_DIR_NAME);
  const visited = new Set();
  let entriesSeen = 0;
  const stack = [{ dir: oddDir, depth: 0, prefix: '' }];
  while (stack.length > 0
    && rels.length < ODD_SCAN_MAX_FILES
    && entriesSeen < ODD_SCAN_MAX_ENTRIES) {
    const frame = stack.pop();
    const dir = frame.dir;
    const depth = frame.depth;
    const prefix = frame.prefix;
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
      if (!name || name === '.' || name === '..') continue;
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
      } else if (isFile && name.endsWith('.md')) {
        rels.push(`odd/${rel}`);
      }
    }
  }
  return rels;
}

// Union of stored odd names and auto-detected documents for one checkout,
// deduplicated with stored entries first. Never throws.
function oddDocsForCheckout(storedOdd, worktreePath) {
  const seen = new Set();
  const out = [];
  const stored = Array.isArray(storedOdd) ? storedOdd : [];
  for (const name of stored) {
    if (typeof name !== 'string' || name.length === 0 || seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  let detected = [];
  try {
    detected = detectOddDocs(worktreePath);
  } catch {
    detected = [];
  }
  for (const name of detected) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
  }
  return out;
}

// Validate the OPTIONAL `odd` parameter of `worktree_create`, mirroring
// the supplied-`issues` contract: an omitted field (undefined) leaves the
// stored value untouched; a supplied value — a path string, an array of
// path strings, or an empty value (`''`, `[]`, `null` counts as empty,
// never as omitted) — replaces it. Every non-empty entry must name an
// existing file, resolved against `cwd` when relative (absolute inputs
// resolve directly, never against the process cwd beyond that). Returns
// `{ok:true, omitted:true}` when the caller said nothing,
// `{ok:true, omitted:false, odd:[...]}` with the entries normalized to
// `odd/<rel>` when they live under an `odd/` root and to resolved
// absolute paths otherwise, or `{ok:false, reason}` — and validation
// never writes anything.
function validateOddParam(odd, cwd, opts = {}) {
  if (odd === undefined) return { ok: true, omitted: true, odd: null };
  const rawList = Array.isArray(odd) ? odd.slice() : [odd];
  const supplied = rawList.filter((entry) => !(entry === null || entry === undefined || entry === ''));
  if (supplied.length === 0) return { ok: true, omitted: false, odd: [] };
  const base = typeof cwd === 'string' && cwd.length > 0 ? cwd : process.cwd();
  const normalized = [];
  for (const entry of supplied) {
    if (typeof entry !== 'string' || entry.length === 0) {
      return { ok: false, reason: `invalid odd document path ${JSON.stringify(entry)}: pass the path of an existing odd .md file` };
    }
    if (entry.endsWith('.md') === false) {
      return { ok: false, reason: `invalid odd document path ${JSON.stringify(entry)}: pass the path of an existing odd .md file` };
    }
    let absolute;
    try {
      absolute = path.isAbsolute(entry) ? path.resolve(entry) : path.resolve(base, entry);
    } catch {
      return { ok: false, reason: `invalid odd document path ${JSON.stringify(entry)}: pass the path of an existing odd .md file` };
    }
    let isFile = false;
    try {
      isFile = fs.statSync(absolute).isFile();
    } catch {
      isFile = false;
    }
    if (!isFile) {
      return { ok: false, reason: `odd document not found at ${entry}: pass the path of an existing odd .md file` };
    }
    normalized.push(normalizeOddName(absolute, opts));
  }
  return { ok: true, omitted: false, odd: normalized };
}

// Display name for one validated odd file: `odd/<rel>` when it lives
// under a known `odd/` root (the worktree's or the principal's, when the
// caller names them), else the resolved absolute path.
function normalizeOddName(absolutePath, opts = {}) {
  const roots = [];
  if (opts && typeof opts.worktreePath === 'string' && opts.worktreePath.length > 0) {
    roots.push(path.resolve(path.join(opts.worktreePath, ODD_DIR_NAME)));
  }
  if (opts && typeof opts.principalRoot === 'string' && opts.principalRoot.length > 0) {
    roots.push(path.resolve(path.join(opts.principalRoot, ODD_DIR_NAME)));
  }
  for (const base of roots) {
    if (absolutePath === base) continue;
    if (absolutePath.startsWith(base + path.sep)) {
      const rel = path.relative(base, absolutePath).split(path.sep).join('/');
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return `odd/${rel}`;
    }
  }
  return absolutePath;
}

module.exports = {
  ODD_DIR_NAME,
  detectOddDocs,
  oddDocsForCheckout,
  validateOddParam,
  normalizeOddName,
};
