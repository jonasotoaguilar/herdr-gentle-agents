#!/usr/bin/env node
'use strict';

// gentle-doctor: read-only diagnostics for the Gentle supervision stack.
//
// Reads (bounded, never writes): the daemon pidfile + L6 interruption
// ledger under the resolved state dir, one fixed-argv `herdr agent list`
// snapshot, and the Herdr config file (managed-sidebar probe). Performs
// no socket tests and claims none: every finding below names the check
// actually performed (pidfile liveness via signal 0, CLI snapshot parse,
// config marker scan).
//
// Exit codes: 0 no fail findings (warns allowed); 1 any fail finding or
// failed snapshot; 2 invalid CLI args (rejected before any read).

var MIN_MAJOR = 18;
var major = Number(String(process.versions.node).split('.')[0]);
if (major < MIN_MAJOR) {
  process.stderr.write(
    'herdr-gentle-agents: Node ' + MIN_MAJOR + ' or newer is required (running ' + process.versions.node + ').\n',
  );
  process.exit(1);
}

const path = require('node:path');
const diag = require('../lib/gentle-diagnostics');
const contract = require('../lib/gentle-tokens');

const HELP = `Usage: gentle-doctor [--help]

Read-only Gentle supervision diagnostics. Checks daemon pidfile liveness,
producer/token freshness from one 'herdr agent list' snapshot, and the
managed sidebar override. Native mode skips inactive Gentle checks but still
checks snapshot availability. Invalid mode fails closed. Never writes state
or starts the daemon.

Checks (each names the probe actually performed):
  daemon    pidfile signal-0 liveness (presence alone is not liveness)
  freshness parsed producer tokens from the CLI snapshot
  sidebar   managed-marker scan of the Herdr config file

Exit codes: 0 pass/warn only; 1 any fail or failed snapshot; 2 bad args.
`;

function fail(lines, text) {
  lines.push(`fail: ${text}`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.length > 0) {
    process.stderr.write('usage: gentle-doctor [--help]\n');
    return 2;
  }

  const lines = [];
  let failed = false;
  const stateDir = diag.resolveStateDir();
  const mode = diag.sidebarModeStatus(stateDir);
  if (mode.malformed) {
    process.stdout.write('fail: sidebar mode invalid (Gentle publishing disabled)\nremedy: inspect gentle-sidebar-mode.json and /herdr-gentle:sidebar status before changing modes\n');
    process.stderr.write('gentle-doctor: one or more checks failed\n');
    return 1;
  }
  // Native mode is an intentional handoff, not a broken Gentle daemon.
  if (!mode.enabled) {
    lines.push('pass: native sidebar selected (Gentle supervision inactive)');
    const agents = diag.loadAgents();
    if (agents === null) {
      lines.push('fail: agent snapshot unavailable');
      lines.push(`remedy: verify \`${diag.herdrBinary()} agent list\` runs (HERDR_BIN_PATH) and retry`);
      process.stdout.write(`${lines.join('\n')}\n`);
      process.stderr.write('gentle-doctor: one or more checks failed\n');
      return 1;
    }
    lines.push(`pass: agent snapshot available (${agents.length} pane(s))`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  }

  // 1. Daemon pidfile liveness (signal 0; never equate presence with life).
  const daemon = diag.daemonStatus(stateDir);
  if (daemon.alive) {
    lines.push(`pass: daemon running (pid ${daemon.pid})`);
  } else if (!daemon.present) {
    lines.push('warn: daemon pidfile absent (daemon not running)');
    lines.push('remedy: start the daemon with `node bin/gentle-status.js` (lifecycle owner); this reader never starts it');
  } else if (daemon.pid === null) {
    lines.push('warn: daemon pidfile unreadable (not a positive integer pid)');
    lines.push('remedy: stop the daemon with `node bin/gentle-status.js --stop`, then start it again');
  } else {
    fail(lines, `daemon pidfile stale (pid ${daemon.pid} not running)`);
    lines.push('remedy: remove the stale pidfile via `node bin/gentle-status.js --stop`, then start the daemon with `node bin/gentle-status.js`');
    failed = true;
  }

  // 2. Producer/token freshness from one CLI snapshot. A failed snapshot
  // is a failure, never an empty view.
  const agents = diag.loadAgents();
  if (agents === null) {
    fail(lines, 'agent snapshot unavailable');
    lines.push(`remedy: verify \`${diag.herdrBinary()} agent list\` runs (HERDR_BIN_PATH) and retry`);
    failed = true;
  } else if (agents.length === 0) {
    lines.push('warn: no agents observed');
    lines.push('remedy: open a pane with the Pi producer active, then re-run');
  } else {
    const now = Date.now();
    let owned = 0;
    let active = 0;
    for (const entry of agents) {
      let summary;
      try {
        summary = diag.summarizePane(entry, contract, now);
      } catch {
        continue; // Malformed records are tolerated, never fatal.
      }
      if (summary === null || summary.owned === false) continue;
      owned += 1;
      if (summary.display !== 'idle' && summary.display !== 'unknown') active += 1;
    }
    if (owned === 0) {
      lines.push(`warn: ${agents.length} pane(s) observed, none owned by this plugin`);
      lines.push('remedy: check the producer extension is attached to these panes (another writer may own them)');
    } else if (active === 0) {
      lines.push(`warn: ${owned} owned pane(s) observed, none with fresh activity (tokens stale or idle)`);
      lines.push('remedy: check the Pi producer beat is publishing fresh tokens (60 s TTL); see docs/diagnostics.md');
    } else {
      lines.push(`pass: ${active}/${owned} owned pane(s) with fresh activity`);
    }
  }

  // 3. Managed sidebar override (marker scan of the config file only).
  const sidebar = diag.sidebarOverrideStatus(diag.resolveConfigPath());
  if (!sidebar.found) {
    lines.push('warn: Herdr config file not found (sidebar override unchecked)');
    lines.push('remedy: run `node bin/configure.js --check` against HERDR_CONFIG_PATH to verify wiring');
  } else if (sidebar.unmanaged) {
    fail(lines, 'unmanaged sidebar rows_by_agent override present');
    lines.push('remedy: run `node bin/configure.js --check` to inspect; --apply refuses while foreign config exists');
    failed = true;
  } else if (sidebar.managed) {
    lines.push('pass: managed sidebar override present');
  } else {
    lines.push('warn: managed sidebar override absent');
    lines.push('remedy: run `node bin/configure.js --apply` to install the pi-only override');
  }

  // 4. Interruption ledger tolerance probe (read-only; malformed is warn).
  const ledger = diag.loadInterruptions(stateDir);
  if (ledger.malformed) {
    lines.push('warn: interruption ledger malformed (ignored)');
    lines.push('remedy: stop the daemon, delete gentle-interruptions.json, and let the daemon rebuild it');
  } else if (!ledger.missing && Object.keys(ledger.panes).length > 0) {
    lines.push(`info: ${Object.keys(ledger.panes).length} interruption record(s) tracked`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  if (failed) process.stderr.write('gentle-doctor: one or more checks failed\n');
  return failed ? 1 : 0;
}

if (require.main === module) process.exit(main());
else module.exports = { main };
