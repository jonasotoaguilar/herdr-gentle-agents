#!/usr/bin/env node
'use strict';

// Sidebar installer for herdr-gentle-agents: manages ONE marked pi-only
// [ui.sidebar.agents.rows_by_agent] override and nothing else.
//
// The daemon (bin/gentle-status.js) publishes presence-encoded
// gentle_title_* labels plus $gentle_badge (lib/gentle-tokens.js); only one
// title token carries a value at a time, so the pi row lists every title
// token and the badge together — absent tokens render empty. DESIGN §5.3
// leaves the exact sidebar wiring as install configuration, and §9 keeps
// the change additive: no native/pi-tree token names are touched.
//
// Safety contract:
// - The parent [ui.sidebar.agents] table is user-owned and never edited.
// - Refuses (exit 2, no write) when a rows_by_agent override exists outside
//   the managed markers — adopting foreign config silently would destroy
//   user intent.
// - Atomic write (temp file in the same directory + rename) with a backup
//   of the pre-mutation bytes; any failure leaves the original in place.
// - Never reads or writes any other file. Test against a fixture by setting
//   HERDR_CONFIG_PATH to a temp file; the live config is never touched by
//   checks in this repo.
//
// Usage:
//   node bin/configure.js --check [--reload]
//   node bin/configure.js --apply [--reload]
//   node bin/configure.js --uninstall [--reload]
//   HERDR_CONFIG_PATH=/tmp/fixture.toml node bin/configure.js --apply

var MIN_MAJOR = 18;
var major = Number(String(process.versions.node).split('.')[0]);
if (major < MIN_MAJOR) {
  process.stderr.write(
    'herdr-gentle-agents: Node ' + MIN_MAJOR + ' or newer is required (running ' + process.versions.node + ').\n',
  );
  process.exit(1);
}

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MANAGED_BEGIN = '# BEGIN herdr-gentle-agents (managed; do not edit)';
const MANAGED_END = '# END herdr-gentle-agents';

// Canonical agent id observed live (snapshot agent_session agent = "pi").
const AGENT_ID = 'pi';

// One pi-only row: default context segments preserved, gentle state labels
// appended. Presence-encoding means exactly one $gentle_title_* token has a
// value per frame; the rest render empty. $gentle_badge renders "~N" or
// empty and stays independent of the state label (DESIGN §3 O4).
const PI_ROW =
  'pi = [["state_icon", "machine", "workspace", "tab"], ' +
  '["agent", "$gentle_title_working", "$gentle_title_working_subs", ' +
  '"$gentle_title_ask", "$gentle_title_review", "$gentle_title_error", ' +
  '"$gentle_title_done", "$gentle_title_idle", "$gentle_badge"]]';

const MANAGED_BLOCK = [
  MANAGED_BEGIN,
  '# Sidebar override owned by herdr-gentle-agents: pi-only row rendering the',
  '# daemon-owned gentle_title_* labels plus $gentle_badge. The parent',
  '# [ui.sidebar.agents] table is user-owned and never touched here.',
  '[ui.sidebar.agents.rows_by_agent]',
  PI_ROW,
  MANAGED_END,
  '',
].join('\n');

/* ------------------------------------------------------------ paths */

// Identical resolution to bin/gentle-status.js herdrConfigPath().
function herdrConfigPath() {
  if (process.env.HERDR_CONFIG_PATH) return path.resolve(process.env.HERDR_CONFIG_PATH);
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, 'herdr', 'config.toml');
  const base =
    process.platform === 'win32'
      ? (process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'))
      : path.join(os.homedir(), '.config');
  return path.join(base, 'herdr', 'config.toml');
}

function herdrBinary() {
  return process.env.HERDR_BIN_PATH ?? 'herdr';
}

/* ------------------------------------------------------------ parsing */

function readConfig(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function hasManagedBlock(text) {
  return text.includes(MANAGED_BEGIN) && text.includes(MANAGED_END);
}

function managedBlockCurrent(text) {
  return text.includes(MANAGED_BLOCK);
}

// Strip managed block(s) so the unmanaged-override scan never sees our own
// rows_by_agent header. Malformed markers (begin without end) are treated
// as managed presence: never mistake them for foreign config.
function withoutManaged(text) {
  let out = '';
  let rest = text;
  for (;;) {
    const begin = rest.indexOf(MANAGED_BEGIN);
    if (begin < 0) {
      out += rest;
      break;
    }
    out += rest.slice(0, begin);
    const end = rest.indexOf(MANAGED_END, begin);
    if (end < 0) break; // unterminated marker: remainder is ours; stop.
    rest = rest.slice(end + MANAGED_END.length);
  }
  return out;
}

// True when a rows_by_agent override exists outside the managed markers.
// Matches TOML headers ([ui.sidebar.agents.rows_by_agent], quoted or
// spaced variants) and dotted-key assignments, on non-comment lines only.
function hasUnmanagedOverride(text) {
  const bare = withoutManaged(text);
  const headerRe = /^\s*\[.*\brows_by_agent\b.*\]\s*(#.*)?$/m;
  if (headerRe.test(bare)) return true;
  for (const line of bare.split('\n')) {
    const stripped = line.replace(/#.*$/, '');
    if (/^\s*#/.test(line) || stripped.trim() === '') continue;
    if (/\brows_by_agent\b/.test(stripped)) return true;
  }
  return false;
}

/* ------------------------------------------------------------ write */

function backupPathFor(file) {
  return `${file}.herdr-gentle-agents.bak`;
}

// Atomic write with backup: temp file in the target directory, then rename.
// On any failure the original is untouched and the temp is removed.
function writeAtomic(file, next, backup) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  let original = null;
  try {
    original = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const tmp = path.join(dir, `.config.toml.herdr-gentle-agents.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, next, 'utf8');
    if (backup && original !== null) {
      try {
        fs.writeFileSync(backup, original, 'utf8');
      } catch {
        // Backup is best-effort; the atomic rename below still protects
        // the original. Report but do not abort.
        console.error('configure: warning: could not write backup; continuing with atomic replace');
      }
    }
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Temp already renamed or never created.
    }
  }
}

function appendManaged(text) {
  if (text === null) return MANAGED_BLOCK;
  if (text.length === 0) return MANAGED_BLOCK;
  const sep = text.endsWith('\n') ? (text.endsWith('\n\n') ? '' : '\n') : '\n\n';
  return text + sep + MANAGED_BLOCK;
}

function removeManaged(text) {
  let next = text;
  for (;;) {
    const begin = next.indexOf(MANAGED_BEGIN);
    if (begin < 0) break;
    const end = next.indexOf(MANAGED_END, begin);
    if (end < 0) break; // unterminated: refuse to guess; leave as-is.
    // Extend the cut to whole lines (drop a single preceding blank line and
    // the trailing newline) so uninstall does not accumulate gaps.
    let cutStart = begin;
    const lineStart = next.lastIndexOf('\n', begin - 1);
    const gap = next.slice(lineStart + 1, begin);
    if (/^[ \t]*$/.test(gap)) cutStart = lineStart + 1;
    let cutEnd = end + MANAGED_END.length;
    if (next[cutEnd] === '\n') cutEnd += 1;
    next = next.slice(0, cutStart) + next.slice(cutEnd);
  }
  return next;
}

/* ------------------------------------------------------------ reload */

function reloadConfig() {
  const result = spawnSync(herdrBinary(), ['server', 'reload-config'], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
  if (result.error) {
    console.error(`configure: reload failed: ${result.error.message}`);
    return false;
  }
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    console.error(`configure: reload failed (exit ${result.status})${detail ? `: ${detail}` : ''}`);
    return false;
  }
  console.log('configure: reloaded Herdr config');
  return true;
}

/* ------------------------------------------------------------ ops */

function usage() {
  console.error(
    [
      'usage: node bin/configure.js (--check | --apply | --uninstall) [--reload]',
      '',
      '  --check      exit 0 when the managed pi-only override is present and current,',
      '               1 when it is absent (needs --apply)',
      '  --apply      append (or repair) the managed block; refuse on unmanaged override',
      '  --uninstall  remove the managed block only; user tables are left intact',
      '  --reload     run `herdr server reload-config` after a successful operation',
      '',
      `config: ${herdrConfigPath()} (HERDR_CONFIG_PATH/XDG_CONFIG_HOME override)`,
    ].join('\n'),
  );
}

function main() {
  const args = new Set(process.argv.slice(2));
  const wantsCheck = args.has('--check');
  const wantsApply = args.has('--apply');
  const wantsUninstall = args.has('--uninstall');
  const wantsReload = args.has('--reload');
  const known = new Set(['--check', '--apply', '--uninstall', '--reload']);
  for (const arg of args) {
    if (!known.has(arg)) {
      console.error(`configure: unknown flag ${arg}`);
      usage();
      process.exit(2);
    }
  }
  const ops = [wantsCheck, wantsApply, wantsUninstall].filter(Boolean).length;
  if (ops !== 1) {
    usage();
    process.exit(2);
  }

  const file = herdrConfigPath();
  let text;
  try {
    text = readConfig(file);
  } catch (error) {
    console.error(`configure: cannot read ${file}: ${error.message}`);
    process.exit(2);
  }

  if (wantsCheck) {
    if (text !== null && managedBlockCurrent(text)) {
      console.log('configure: managed pi-only override present and current');
      if (wantsReload && !reloadConfig()) process.exit(1);
      return;
    }
    if (text !== null && hasUnmanagedOverride(text)) {
      console.error(
        'configure: unmanaged [ui.sidebar.agents.rows_by_agent] override exists; refusing to adopt it. ' +
          'Remove or rename it, then re-run --apply.',
      );
      process.exit(2);
    }
    console.error('configure: managed pi-only override missing (run --apply)');
    process.exit(1);
  }

  if (wantsApply) {
    if (text !== null && managedBlockCurrent(text)) {
      console.log('configure: managed pi-only override already current; nothing to do');
      if (wantsReload && !reloadConfig()) process.exit(1);
      return;
    }
    if (text !== null && hasUnmanagedOverride(text)) {
      console.error(
        'configure: refusing --apply: an unmanaged [ui.sidebar.agents.rows_by_agent] override already exists. ' +
          'This tool only manages its marked block and will not adopt or overwrite foreign config. ' +
          'Remove or rename the existing override, then re-run --apply.',
      );
      process.exit(2);
    }
    let next;
    if (text !== null && hasManagedBlock(text)) {
      // Stale managed block (markers present, content drifted): replace it.
      next = removeManaged(text);
      if (next.includes(MANAGED_BEGIN)) {
        console.error('configure: refusing --apply: managed markers are malformed (unterminated); fix manually.');
        process.exit(2);
      }
      next = appendManaged(next);
    } else {
      next = appendManaged(text);
    }
    try {
      writeAtomic(file, next, backupPathFor(file));
    } catch (error) {
      console.error(`configure: write failed, original untouched: ${error.message}`);
      process.exit(2);
    }
    console.log(`configure: applied managed pi-only override to ${file}`);
    if (wantsReload && !reloadConfig()) process.exit(1);
    return;
  }

  // --uninstall
  if (text === null || !hasManagedBlock(text)) {
    if (text !== null && hasUnmanagedOverride(text)) {
      console.log('configure: no managed block; unmanaged rows_by_agent override left intact');
      return;
    }
    console.log('configure: no managed block; nothing to do');
    return;
  }
  const next = removeManaged(text);
  if (next.includes(MANAGED_BEGIN)) {
    console.error('configure: refusing --uninstall: managed markers are malformed (unterminated); fix manually.');
    process.exit(2);
  }
  try {
    writeAtomic(file, next, backupPathFor(file));
  } catch (error) {
    console.error(`configure: write failed, original untouched: ${error.message}`);
    process.exit(2);
  }
  console.log(`configure: removed managed pi-only override from ${file}`);
  if (wantsReload && !reloadConfig()) process.exit(1);
}

main();
