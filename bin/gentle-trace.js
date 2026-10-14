#!/usr/bin/env node
'use strict';

// gentle-trace: read-only structured JSON for one pane.
//
// Emits exactly one JSON document to stdout: whitelisted reduced producer
// state plus the safe L6 interruption record for the pane — never raw
// tokens, task labels, review verdicts, transcripts, or arbitrary ledger
// fields. A failed snapshot is a JSON failure, never an empty success.
//
// Exit codes: 0 pane traced; 1 snapshot unavailable or pane not found;
// 2 invalid CLI args or malformed pane id (rejected before any read).

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

const HELP = `Usage: gentle-trace <pane-id> [--help]

Print read-only structured JSON for one pane (e.g. wBG:p1): sanitized
producer/consumer state plus the safe interruption record. Never dumps
raw tokens, task labels, verdicts, or transcripts.

Exit codes: 0 traced; 1 snapshot unavailable or pane not found; 2 bad args.
`;

function emit(doc) {
  process.stdout.write(`${JSON.stringify(doc, null, 2)}\n`);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  // Strict public args: exactly one pane id, validated before any read.
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('usage: gentle-trace <pane-id>\n');
    return 2;
  }
  const paneId = diag.safePaneId(args[0]);
  if (paneId === null) {
    process.stderr.write(`gentle-trace: invalid pane id ${JSON.stringify(args[0])} (expected like wBG:p1)\n`);
    return 2;
  }

  const agents = diag.loadAgents();
  if (agents === null) {
    emit({ ok: false, error: 'snapshot_unavailable', pane_id: paneId });
    process.stderr.write('gentle-trace: snapshot failed (herdr agent list unavailable)\n');
    return 1;
  }
  const now = Date.now();
  let found = null;
  for (const entry of agents) {
    if (entry?.pane_id !== paneId) continue;
    try {
      found = diag.summarizePane(entry, contract, now);
    } catch {
      found = null;
    }
    break;
  }
  if (found === null) {
    // S3 merge: a valid ledger record plus positively confirmed pane
    // presence (fixed-argv pane list) traces as interrupted. Failed pane
    // list is an explicit failure; confirmed absence stays pane_not_found
    // — a lingering ledger row alone never invents presence.
    const ledger = diag.loadInterruptions(diag.resolveStateDir());
    const record = !ledger.malformed && !ledger.missing ? (ledger.panes[paneId] ?? null) : null;
    if (record === null) {
      emit({ ok: false, error: 'pane_not_found', pane_id: paneId });
      return 1;
    }
    const panes = diag.loadPanes();
    if (panes === null) {
      emit({ ok: false, error: 'snapshot_unavailable', pane_id: paneId });
      process.stderr.write('gentle-trace: snapshot failed (herdr pane list unavailable)\n');
      return 1;
    }
    const presence = diag.indexPanesById(panes).get(paneId) ?? null;
    if (presence === null) {
      emit({ ok: false, error: 'pane_not_found', pane_id: paneId });
      return 1;
    }
    emit({
      ok: true,
      pane_id: paneId,
      workspace_id: diag.safeWorkspaceId(presence?.workspace_id) ?? '',
      workspace: diag.sanitizeCell(contract.parseWorkspaceName(presence), 48),
      agent: '',
      agent_status: 'unknown',
      display: 'interrupted',
      label: 'Interrumpido',
      roles: [],
      count: null,
      owned: true,
      freshness: { work: false, orchestrating: false, ask: false, review: false },
      session_hash: record.session_hash ?? null,
      interruption: record,
      snapshot_at: now,
    });
    return 0;
  }

  const ledger = diag.loadInterruptions(diag.resolveStateDir());
  const interruption = !ledger.malformed && !ledger.missing ? (ledger.panes[paneId] ?? null) : null;

  emit({
    ok: true,
    pane_id: found.pane_id,
    workspace_id: found.workspace_id,
    workspace: found.workspace,
    agent: found.agent,
    agent_status: found.agent_status,
    display: found.display,
    label: found.label,
    roles: found.roles,
    count: found.count,
    owned: found.owned,
    freshness: found.freshness,
    session_hash: found.session_hash,
    interruption,
    snapshot_at: now,
  });
  return 0;
}

if (require.main === module) process.exit(main());
else module.exports = { main };
