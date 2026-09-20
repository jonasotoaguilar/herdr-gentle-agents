#!/usr/bin/env node
'use strict';

// Sidebar installer for herdr-gentle-agents: manages ONE marked pi-only
// [ui.sidebar.agents.rows_by_agent] override and nothing else.
//
// Row 1 is exactly the native Herdr tokens `state_icon`, `workspace`,
// `agent` in that order as plain native token strings (no custom cells,
// no colors wired here): native no-duplication/name-coloring behavior for
// `state_icon` + `workspace`, and the grey native agent identity with the
// native separator. Row 2 wires the ten presence-encoded gentle_title_*
// state cells (state word only, one current title only, each in its
// state's semantic color with no rules) followed by the three
// change-segment tokens (added green, deleted red, pull blue, each its
// own color cell with no rules). Absent tokens render empty. Native
// separators on row 2 are acceptable. Custom heading/project/agent cells
// (`$gentle_heading_*`, `$gentle_project`, `$gentle_agent`) and
// `gentle_changes_summary` stay published and owned for compatibility
// but are wired into no visible row.
// DESIGN §5.3 leaves the exact sidebar wiring as install configuration,
// and §9 keeps the change additive: no native/pi-tree token names are
// touched.
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

// Two pi-only rows in the herdr-pi-tree shape (DESIGN §5.3). Row 1 is
// exactly the native Herdr tokens `state_icon`, `workspace`, `agent` in
// that order as plain native token strings — no custom `$gentle_*` cell,
// no fg/rules wired here. This is intentional: native `state_icon` +
// `workspace` gives the native no-duplication/name coloring behavior, and
// native `agent` is the grey agent identity with the native separator.
// Row 2 is the state word plus changes: the ten presence-encoded
// `gentle_title_*` state cells (state word only, one current title per
// frame, each in its state's semantic color as base fg with no rules)
// followed by the three change-segment tokens (added green `+N`, deleted
// red `-N`, pull blue `↑N`, each its own color cell with no rules, never
// swapped). The review leg renders the user-facing word `review` (machine key
// stays `review`); the error value renders `blocked`; the orchestrating
// leg renders the user-facing word `gentle` (machine key stays
// `orchestrating`, pink). The compact `gentle_changes_summary` token and
// the custom `$gentle_heading_*` / `$gentle_project` / `$gentle_agent`
// cells stay published and owned for compatibility but are wired into no
// visible row. Only one title token carries a value per frame (presence
// encoding), so absent tokens render empty. Row 1 holds 3 native cells
// and row 2 holds 13 cells (10 state + 3 changes), each within
// Herdr's 16-token per-row ceiling. The agent name in each value is the snapshot-provided
// validated identity (pi, op, codex, ...) — never a subagent name, never a
// count — with no vendor colors invented here. The heading
// workspace name is the snapshot's validated group name, else a safe cwd
// basename (never the Herdr workspace_id, never Git, never inferred).
//
// Palette values mirror herdr-pi-tree lib/palette.js: project white
// #ffffff (state.branch, Spaces project names), explorer/pull blue
// #89b4fa, added/done green #a6e3a1, removed/blocked red #f38ba8, working
// amber #f9e2af; ask #fab387 is the warning hue; explorer icon uses Herdr
// blue #89b4fa, verify teal #94e2d5, the root-session `orchestrating`
// marker pink fuchsia #f5c2e7 (SIDEBAR_FUCHSIA for its heading icon and
// title), and the RDD/review running state
// uses blue #89b4fa (same as explorer/pull). Idle renders grey #7c7f93. Row 1 wires no colors:
// plain native `state_icon`, `workspace`, `agent` strings. Row 2 is structural color cells with no rules:
// each state word in its state color, added green, deleted red, pull blue. Added
// stays green and deleted stays red; the mapping is never swapped.
const SIDEBAR_PROJECT = '#ffffff';
const SIDEBAR_BLUE = '#89b4fa';
const SIDEBAR_GREEN = '#a6e3a1';
const SIDEBAR_RED = '#f38ba8';
const SIDEBAR_AMBER = '#f9e2af';
const SIDEBAR_ORANGE = '#fab387';
const SIDEBAR_GREY = '#7c7f93';
const SIDEBAR_FUCHSIA = '#f5c2e7';
const SIDEBAR_TEAL = '#94e2d5';

// One sidebar cell: `{ token, fg }` plus optional Herdr value `rules`
// (`{ contains, fg }`, first match wins, unmatched text inherits the cell
// fg). Row 2 uses no rules: state and change cells each carry one value,
// so base fg colors them structurally. Row 1 uses plain native token
// strings with no styled cells.
function sidebarCell(token, fg, rules) {
  const ruleText = (rules ?? [])
    .map((rule) => `{ contains = "${rule.contains}", fg = "${rule.fg}" }`)
    .join(', ');
  return `{ token = "${token}", fg = "${fg}"${ruleText ? `, rules = [${ruleText}]` : ''} }`;
}

// Row 1: exactly the native Herdr tokens `state_icon`, `workspace`,
// `agent` in that order as plain native token strings. No custom
// `$gentle_heading_*`, `$gentle_project`, or `$gentle_agent` cell is
// visibly wired; those tokens stay published/owned for compatibility.
const PI_ROW_1 = ['"state_icon"', '"workspace"', '"agent"'];

// Row 2: ten state-word cells in state colors with no rules (one current
// title per frame), followed by the three change segments as their own
// color cells (added green `+N`, deleted red `-N`, pull blue `↑N`, never
// swapped; empty segments collapse). Native separators on row 2 are
// acceptable. No `$gentle_heading_*`, `$gentle_project`, `$gentle_agent`,
// or `$gentle_changes_summary` token is visibly wired; those stay
// published and owned for compatibility but unwired. The error title renders
// `blocked`, the review title renders `review`.
const PI_ROW_2 = [
  sidebarCell('$gentle_title_working', SIDEBAR_AMBER),
  sidebarCell('$gentle_title_orchestrating', SIDEBAR_FUCHSIA),
  sidebarCell('$gentle_title_explorer', SIDEBAR_BLUE),
  sidebarCell('$gentle_title_worker', SIDEBAR_AMBER),
  sidebarCell('$gentle_title_verify', SIDEBAR_TEAL),
  sidebarCell('$gentle_title_ask', SIDEBAR_ORANGE),
  sidebarCell('$gentle_title_review', SIDEBAR_BLUE),
  sidebarCell('$gentle_title_error', SIDEBAR_RED),
  sidebarCell('$gentle_title_done', SIDEBAR_GREEN),
  sidebarCell('$gentle_title_idle', SIDEBAR_GREY),
  sidebarCell('$gentle_changes_added', SIDEBAR_GREEN),
  sidebarCell('$gentle_changes_deleted', SIDEBAR_RED),
  sidebarCell('$gentle_changes_pull', SIDEBAR_BLUE),
];

const PI_ROW = `pi = [[${PI_ROW_1.join(', ')}], [${PI_ROW_2.join(', ')}]]`;

const MANAGED_BLOCK = [
  MANAGED_BEGIN,
  '# Sidebar override owned by herdr-gentle-agents: two pi-only rows —',
  '# row 1 native state_icon + workspace + agent, row 2 state word + changes.',
  '# The parent [ui.sidebar.agents] table is user-owned and never touched here.',
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

if (require.main === module) main();

module.exports = {
  PI_ROW,
  PI_ROW_1,
  PI_ROW_2,
  MANAGED_BLOCK,
  MANAGED_BEGIN,
  MANAGED_END,
  sidebarCell,
};
