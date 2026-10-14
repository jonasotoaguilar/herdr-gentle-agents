#!/usr/bin/env node
'use strict';

// gentle-whois: concise read-only global pane view (terminal table).
//
// Default view lists only panes owned by this plugin; --all additionally
// lists native/foreign panes without exposing private task names. The
// human word `Interrumpido` is diagnostic-only (from the validated L6
// ledger while the pane shows no fresh activity); sidebar vocabulary is
// untouched. A failed snapshot exits 1 and is never an empty table.
//
// Output is restrained plain text: a header, one row per pane in stable
// pane_id order, fitted to narrow widths with control characters stripped.
// Meaning is never encoded by color alone (no color is emitted at all).
//
// Exit codes: 0 rendered (empty snapshot renders a header + note);
// 1 snapshot unavailable; 2 invalid CLI args (rejected before any read).

var MIN_MAJOR = 18;
var major = Number(String(process.versions.node).split('.')[0]);
if (major < MIN_MAJOR) {
  process.stderr.write(
    'herdr-gentle-agents: Node ' + MIN_MAJOR + ' or newer is required (running ' + process.versions.node + ').\n',
  );
  process.exit(1);
}

const diag = require('../lib/gentle-diagnostics');
const contract = require('../lib/gentle-tokens');

const HELP = `Usage: gentle-whois [--all] [--help]

Concise read-only table of panes: PANE AGENT STATE ROLES WORKSPACE.
Default lists only panes owned by this plugin; --all also lists
native/foreign panes (no task names exposed). Interruption shows the
diagnostic-only word Interrumpido; the sidebar is unchanged.

Exit codes: 0 rendered; 1 snapshot unavailable; 2 bad args.
`;

function isFreshSummary(summary) {
  return (
    summary.freshness.work ||
    summary.freshness.orchestrating ||
    summary.freshness.ask ||
    summary.freshness.review
  );
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  let includeAll = false;
  if (args.length === 1 && args[0] === '--all') includeAll = true;
  else if (args.length > 0) {
    process.stderr.write('usage: gentle-whois [--all]\n');
    return 2;
  }

  const agents = diag.loadAgents();
  if (agents === null) {
    process.stderr.write('gentle-whois: snapshot failed (herdr agent list unavailable)\n');
    return 1;
  }
  const now = Date.now();
  const ledger = diag.loadInterruptions(diag.resolveStateDir());
  const interruptions = ledger.malformed || ledger.missing ? {} : ledger.panes;

  const rows = [];
  const agentIds = new Set();
  for (const entry of agents) {
    const id = diag.safePaneId(entry?.pane_id);
    if (id !== null) agentIds.add(id);
  }
  for (const entry of agents) {
    let summary;
    try {
      summary = diag.summarizePane(entry, contract, now);
    } catch {
      continue; // Malformed records are skipped, never fatal.
    }
    if (summary === null) continue;
    if (!includeAll && summary.owned === false) continue;
    const record = interruptions[summary.pane_id] ?? null;
    // Diagnostic-only interruption: a valid L6 record while the pane
    // shows no fresh activity. Fresh activity always wins (the daemon
    // removes the record on new activity); terminal/fresh panes never
    // read Interrumpido.
    const interrupted = record !== null && !isFreshSummary(summary);
    rows.push({
      pane: summary.pane_id,
      agent: summary.owned ? summary.agent || '-' : sanitizeAgent(summary.agent),
      state: interrupted ? 'Interrumpido' : summary.owned ? summary.label || summary.display : summary.agent_status,
      roles: summary.owned ? summary.roles.join(',') : '-',
      workspace: summary.workspace || summary.workspace_id || '-',
      interrupted,
    });
  }
  // S3 merge: validated ledger rows whose pane is absent from the agent
  // list are confirmed via one fixed-argv pane list (only when genuinely
  // needed — present-agent paths make no extra call). Confirmed presence
  // renders Interrumpido; confirmed absence shows no ghost; a failed pane
  // list is an explicit failure, never invented presence or empty success.
  const unmatched = Object.keys(interruptions).filter((id) => !agentIds.has(id));
  if (unmatched.length > 0) {
    const panes = diag.loadPanes();
    if (panes === null) {
      process.stderr.write('gentle-whois: snapshot failed (herdr pane list unavailable)\n');
      return 1;
    }
    const byId = diag.indexPanesById(panes);
    for (const id of unmatched) {
      const presence = byId.get(id) ?? null;
      if (presence === null) continue;
      rows.push({
        pane: id,
        agent: '-',
        state: 'Interrumpido',
        roles: '-',
        workspace:
          diag.sanitizeCell(contract.parseWorkspaceName(presence), 48) ||
          diag.safeWorkspaceId(presence?.workspace_id) ||
          '-',
        interrupted: true,
      });
    }
  }
  rows.sort((a, b) => (a.pane < b.pane ? -1 : a.pane > b.pane ? 1 : 0));

  const width = diag.terminalWidth(80);
  // Column budget: pane 12, agent 8, state 14, roles flexible, workspace
  // takes the remainder; everything fitted, never wrapped.
  const paneW = 12;
  const agentW = 8;
  const stateW = 14;
  const fixed = paneW + agentW + stateW + 6; // two-space separators
  const rolesW = Math.max(8, Math.min(24, Math.floor((width - fixed) * 0.4)));
  const wsW = Math.max(8, width - fixed - rolesW);
  const out = [];
  out.push(
    `${diag.fitCell('PANE', paneW)}  ${diag.fitCell('AGENT', agentW)}  ${diag.fitCell('STATE', stateW)}  ${diag.fitCell('ROLES', rolesW)}  ${diag.fitCell('WORKSPACE', wsW)}`,
  );
  if (rows.length === 0) {
    out.push('(no panes observed)');
  } else {
    for (const row of rows) {
      out.push(
        `${diag.fitCell(row.pane, paneW)}  ${diag.fitCell(row.agent, agentW)}  ${diag.fitCell(row.state, stateW)}  ${diag.fitCell(row.roles || '-', rolesW)}  ${diag.fitCell(row.workspace, wsW)}`,
      );
    }
    if (rows.some((row) => row.interrupted)) {
      out.push('(Interrumpido is diagnostic-only; the sidebar is unchanged)');
    }
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return 0;
}

function sanitizeAgent(agent) {
  const clean = diag.sanitizeCell(agent, 8);
  return clean === '' ? '-' : clean;
}

if (require.main === module) process.exit(main());
else module.exports = { main };
