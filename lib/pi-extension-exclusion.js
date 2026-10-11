#!/usr/bin/env node
'use strict';

// Safe, idempotent mutation of the Pi global settings.json `extensions` list
// for a single force-exclusion entry (e.g. `-extensions/herdr-agent-state.ts`).
//
// Only ever appends or removes the exact entry string. All other keys, values,
// and entries are preserved (formatting is normalized to 2-space JSON).
// Any validation failure exits nonzero BEFORE writing, so the settings file
// is never destructively replaced: malformed JSON, a non-object document, a
// non-array `extensions` value, or a non-string entry all fail closed.
// A leading BOM is accepted exactly like Pi (which strips it before parse).
//
// Ownership: `ensure` records a bound ownership record (schema version, exact
// entry, canonical settings target through symlinks) only after the settings
// write succeeds. If the record write fails, the settings change is rolled
// back (byte-identical restore, or removal of a file this run created) and
// the command fails with an accurate error -- a failed `ensure` never leaves
// a changed settings file behind while claiming otherwise, and never leaves
// a misleading record that could later remove a user entry.
// `remove` edits the file only when the record parses, has a known schema,
// names this exact entry, and binds this exact canonical target; any foreign,
// invalid, or misbound record fails closed without removing the user entry.
// A foreign record is never silently upgraded or adopted.
//
// Writes: regular files and symlink targets are replaced atomically via an
// exclusively-created random temp file plus rename in the target directory;
// the symlink itself is preserved and the previous mode is kept (fresh files
// are created 0600). Dangling symlinks, directories, and special files fail
// closed. No temp files are left behind on success or validated failure.
//
// Usage:
//   node pi-extension-exclusion.js ensure --settings P --entry E --marker M
//   node pi-extension-exclusion.js remove --settings P --entry E --marker M
//
// Exit codes: 0 success/no-op; 1 operational failure; 2 usage failure.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const MARKER_VERSION = 1;
const CREATE_MODE = 0o600;
const TEMP_ATTEMPTS = 10;

function fail(msg, code = 1) {
  console.error(`pi-extension-exclusion: error: ${msg}`);
  process.exit(code);
}

function warn(msg) {
  console.error(`pi-extension-exclusion: warning: ${msg}`);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== 'ensure' && command !== 'remove') {
    fail('usage: pi-extension-exclusion.js (ensure|remove) --settings PATH --entry ENTRY --marker PATH', 2);
  }
  const opts = {};
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    if (flag !== '--settings' && flag !== '--entry' && flag !== '--marker') {
      fail(`unknown flag ${flag} (expected --settings/--entry/--marker)`, 2);
    }
    const value = rest[i + 1];
    if (value === undefined || value === '') {
      fail(`missing value for ${flag}`, 2);
    }
    opts[flag.slice(2)] = value;
    i += 1;
  }
  if (!opts.settings || !opts.entry || !opts.marker) {
    fail('usage: pi-extension-exclusion.js (ensure|remove) --settings PATH --entry ENTRY --marker PATH', 2);
  }
  return { command, ...opts };
}

// Mirror Pi's own loader: a single leading BOM is stripped before parse.
function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// Load and validate the settings document. Missing file yields an empty
// document with raw === null. Anything invalid fails closed.
function loadSettings(settingsPath) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return { doc: {}, raw: null };
    fail(`cannot read ${settingsPath}: ${err.message}`);
  }
  let doc;
  try {
    doc = JSON.parse(stripBom(raw));
  } catch (err) {
    fail(`refusing to edit ${settingsPath}: invalid JSON (${err.message}); fix or remove the file first`);
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    fail(`refusing to edit ${settingsPath}: top-level JSON must be an object`);
  }
  return { doc, raw };
}

function validatedEntries(settingsPath, doc) {
  if (doc.extensions === undefined) return [];
  if (!Array.isArray(doc.extensions)) {
    fail(`refusing to edit ${settingsPath}: "extensions" must be an array`);
  }
  for (const item of doc.extensions) {
    if (typeof item !== 'string') {
      fail(`refusing to edit ${settingsPath}: every "extensions" entry must be a string`);
    }
  }
  return doc.extensions;
}

// Classify the settings path. Returns 'missing', 'file', or 'symlink'.
// Dangling symlinks, directories, and special files fail closed.
function classifySettingsPath(settingsPath) {
  let st;
  try {
    st = fs.lstatSync(settingsPath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return 'missing';
    fail(`cannot stat ${settingsPath}: ${err.message}`);
  }
  if (st.isSymbolicLink()) {
    try {
      fs.statSync(settingsPath);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        fail(`refusing to edit ${settingsPath}: dangling symlink`);
      }
      fail(`cannot stat ${settingsPath}: ${err.message}`);
    }
    return 'symlink';
  }
  if (st.isFile()) return 'file';
  fail(`refusing to edit ${settingsPath}: not a regular file`);
}

// Canonical ownership target: the real path of the file content, through
// any symlink chain. Throws with a message on failure (caller decides).
function canonicalTargetOrThrow(settingsPath) {
  return fs.realpathSync(settingsPath);
}

// Atomic exclusive write of exact text to a concrete target path: a random
// temp file created O_CREAT|O_EXCL (never truncating a foreign file), exact
// mode applied regardless of umask, then rename. Throws on failure having
// removed its own temp file.
function writeFileAtomicOrThrow(targetPath, text, mode) {
  const dir = path.dirname(targetPath);
  const base = path.basename(targetPath);
  let lastError = null;
  for (let attempt = 0; attempt < TEMP_ATTEMPTS; attempt += 1) {
    const tmp = path.join(dir, `.${base}.tmp.${process.pid}.${crypto.randomBytes(8).toString('hex')}`);
    let fd = null;
    try {
      fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        lastError = err;
        continue;
      }
      throw err;
    }
    try {
      const buf = Buffer.from(text, 'utf8');
      let offset = 0;
      while (offset < buf.length) {
        offset += fs.writeSync(fd, buf, offset);
      }
      fs.chmodSync(tmp, mode);
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmp, targetPath);
    } catch (err) {
      try {
        if (fd !== null) fs.closeSync(fd);
      } catch {
        // Best-effort descriptor cleanup.
      }
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Best-effort temp cleanup.
      }
      throw err;
    }
    return;
  }
  throw lastError || new Error('could not create a unique temporary file');
}

// Resolve the concrete write target for a classified settings path and write
// exact text atomically. Symlinks resolve to their target (link preserved);
// missing paths resolve under their real parent dir. Throws on failure.
function writeTextAtomicOrThrow(settingsPath, kind, text) {
  let target;
  if (kind === 'missing') {
    target = path.join(fs.realpathSync(path.dirname(settingsPath)), path.basename(settingsPath));
  } else {
    target = canonicalTargetOrThrow(settingsPath);
  }
  let mode = CREATE_MODE;
  if (kind !== 'missing') {
    mode = fs.statSync(settingsPath).mode & 0o777;
  }
  writeFileAtomicOrThrow(target, text, mode);
}

function writeTextAtomic(settingsPath, kind, text) {
  try {
    writeTextAtomicOrThrow(settingsPath, kind, text);
  } catch (err) {
    fail(`cannot write ${settingsPath}: ${err.message}`);
  }
  if (kind === 'symlink') {
    warn(`following symlink ${settingsPath} (link preserved)`);
  }
}

function writeSettingsDoc(settingsPath, kind, doc) {
  writeTextAtomic(settingsPath, kind, `${JSON.stringify(doc, null, 2)}\n`);
}

// Restore the pre-ensure state after a record-write failure: rewrite the
// original bytes (byte-identical), or remove the file this run created.
// Throws on failure so the caller reports accurately.
function restoreOriginalOrThrow(settingsPath, kind, raw) {
  if (raw === null) {
    fs.rmSync(canonicalTargetOrThrow(settingsPath), { force: true });
    if (fs.existsSync(settingsPath)) {
      throw new Error('created file could not be removed');
    }
    return;
  }
  writeTextAtomicOrThrow(settingsPath, kind, raw);
}

function removeMarker(markerPath) {
  try {
    fs.rmSync(markerPath, { force: true });
  } catch {
    // Best-effort marker cleanup.
  }
}

function doEnsure(settings, entry, marker) {
  // Pre-validate any preexisting ownership record BEFORE any settings or
  // marker mutation (including the idempotent no-op below): a record bound
  // to another entry or settings target fails closed here, so a second
  // agent dir sharing this state dir can never silently orphan or adopt
  // foreign ownership. Absent settings still bind via the parent-resolved
  // path; an unresolvable target fails closed.
  requireBoundRecord(marker, entry, settings, 'record');
  const kind = classifySettingsPath(settings);
  if (kind === 'missing') {
    try {
      fs.mkdirSync(path.dirname(settings), { recursive: true });
    } catch (err) {
      fail(`cannot create ${path.dirname(settings)}: ${err.message}`);
    }
  }
  const { doc, raw } = loadSettings(settings);
  const entries = validatedEntries(settings, doc);
  if (entries.includes(entry)) {
    return; // Idempotent no-op: byte-stable, no ownership taken or changed.
  }
  const next = { ...doc, extensions: [...entries, entry] };
  // Settings write first; on its failure no record exists, so a later
  // removal can never mistake this run for an owner.
  writeSettingsDoc(settings, kind, next);
  let canon;
  try {
    canon = canonicalTargetOrThrow(settings);
  } catch (err) {
    fail(`recorded ${entry} in ${settings} but cannot resolve canonical target (${err.message}); entry present without ownership and uninstall will preserve it`);
  }
  try {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, `${JSON.stringify({ version: MARKER_VERSION, entry, settings: canon })}\n`, 'utf8');
  } catch (err) {
    // The settings change must not survive a failed ownership record:
    // restore byte-identical originals (or remove the created file).
    try {
      restoreOriginalOrThrow(settings, kind, raw);
    } catch (restoreErr) {
      fail(`cannot record ownership (${marker}: ${err.message}); settings could NOT be restored (${restoreErr.message}); the entry may be present without ownership and uninstall will preserve it`);
    }
    fail(`cannot record ownership (${marker}: ${err.message}); settings restored unchanged`);
  }
  console.log(`pi-extension-exclusion: recorded ${entry} in ${settings}`);
}

// Resolve the canonical target of THIS settings path (through links, or
// parent-resolved when the file is absent). Fails closed when unresolvable.
function resolveCurrentTarget(settings, verb, entry, marker) {
  try {
    return canonicalTargetOrThrow(settings);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      try {
        return path.join(fs.realpathSync(path.dirname(settings)), path.basename(settings));
      } catch {
        fail(`refusing to ${verb} ${entry}: settings target unresolvable and ownership is bound elsewhere`);
      }
    } else {
      fail(`cannot resolve ${settings}: ${err.message}`);
    }
  }
}

// Read and strictly validate the ownership record against this exact entry
// and settings target. Returns null when no record exists. Anything foreign,
// invalid, or misbound fails closed WITHOUT touching the settings file.
// verb ('remove'|'record') shapes the error for the calling command.
function requireBoundRecord(marker, entry, settings, verb) {
  let markerRaw;
  try {
    markerRaw = fs.readFileSync(marker, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return null; // Never owned: caller decides.
    fail(`cannot read ownership record ${marker}: ${err.message}`);
  }
  let record = null;
  try {
    record = JSON.parse(markerRaw);
  } catch {
    record = null;
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.version !== MARKER_VERSION
      || typeof record.entry !== 'string' || record.entry === ''
      || typeof record.settings !== 'string' || record.settings === '') {
    fail(`refusing to ${verb} ${entry}: ownership record ${marker} is foreign or invalid; delete the record or the entry manually`);
  }
  if (record.entry !== entry) {
    fail(`refusing to ${verb} ${entry}: ownership record ${marker} authorizes a different entry (${record.entry}); delete the record or the entry manually`);
  }
  // Bind to the canonical target of THIS settings path (through links, or
  // parent-resolved when the file is absent). A record minted for another
  // settings file authorizes nothing here.
  const current = resolveCurrentTarget(settings, verb, entry, marker);
  if (current !== record.settings) {
    const hint = verb === 'record' ? '; delete the record or the entry manually' : '';
    fail(`refusing to ${verb} ${entry}: ownership record ${marker} is bound to ${record.settings}, not ${settings}${hint}`);
  }
  return record;
}

function doRemove(settings, entry, marker) {
  const record = requireBoundRecord(marker, entry, settings, 'remove');
  if (record === null) {
    return; // No record: preexisting or foreign entry, preserved.
  }
  let rawMissing = false;
  try {
    fs.lstatSync(settings);
  } catch (err) {
    if (err && err.code === 'ENOENT') rawMissing = true;
    else fail(`cannot stat ${settings}: ${err.message}`);
  }
  if (rawMissing) {
    removeMarker(marker); // Bound target already gone: drop the stale record.
    return;
  }
  const kind = classifySettingsPath(settings);
  const { doc } = loadSettings(settings);
  const entries = validatedEntries(settings, doc);
  if (!entries.includes(entry)) {
    removeMarker(marker);
    return;
  }
  const kept = entries.filter((item) => item !== entry);
  const next = { ...doc };
  if (kept.length === 0) {
    delete next.extensions; // Semantically neutral: absent == no overrides.
  } else {
    next.extensions = kept;
  }
  writeSettingsDoc(settings, kind, next);
  removeMarker(marker);
  console.log(`pi-extension-exclusion: removed ${entry} from ${settings}`);
}

function main() {
  const { command, settings, entry, marker } = parseArgs(process.argv.slice(2));
  if (command === 'ensure') {
    doEnsure(settings, entry, marker);
  } else {
    doRemove(settings, entry, marker);
  }
}

main();
