'use strict';
// T3 diagnostics/global-view slice (S1-S5): read-only standalone CLIs.
// Isolation contract: every test builds a temp sandbox (state dir, config
// fixture, fake `herdr` binary) and drives the real CLIs via fixed-argv
// HERDR_BIN_PATH. Rejected input must cause zero Herdr calls and zero
// filesystem writes. No live config/state mutation, no daemon lifecycle,
// no transcripts, no private token/task/verdict exposure.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DOCTOR = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'gentle-doctor.js');
const TRACE = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'gentle-trace.js');
const WHOIS = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'gentle-whois.js');

const FAKE_HERDR = `#!/bin/sh
# Fake herdr: replays canned agent/pane JSON, logs every argv with framing.
printf -- '---CALL---\\n' >>"$CALL_LOG"
i=0
for a in "$@"; do printf 'arg%s=<%s>\\n' "$i" "$a" >>"$CALL_LOG"; i=$((i+1)); done
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  if [ -n "$AGENTS_EXIT" ] && [ "$AGENTS_EXIT" != "0" ]; then exit "$AGENTS_EXIT"; fi
  cat "$AGENTS_FILE"
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  if [ -n "$PANES_EXIT" ] && [ "$PANES_EXIT" != "0" ]; then exit "$PANES_EXIT"; fi
  if [ -f "$PANES_FILE" ]; then cat "$PANES_FILE"; else printf '{"result":{"panes":[]}}\\n'; fi
  exit 0
fi
echo "fake-herdr: unknown command $*" >&2
exit 1
`;

const HASH_A = '8DmJRuXgoClQcF4N7ASyZid8BmMy814HvGqtB0bZpAo';
const HASH_B = '3vEd-s5_ptFOwss1ASj2wA1k0mSwVNLw26NZT4rZckM';

function freshWork(hash, count, ttlMs = 55000) {
  return `${hash}:${count}:${Date.now() + ttlMs}`;
}

function agentsDoc(agents) {
  return JSON.stringify({ result: { agents } });
}

function ownedEntry(paneId, hash, opts = {}) {
  return {
    pane_id: paneId,
    workspace_id: opts.workspaceId ?? 'wBG',
    agent: 'pi',
    agent_session: { agent: 'pi', kind: 'path', source: 'herdr:pi', value: opts.sessionValue ?? `/sessions/${paneId.replace(/:/g, '_')}.jsonl` },
    agent_status: opts.agentStatus ?? 'working',
    group: opts.group ?? 'myproj',
    cwd: '/repo/myproj',
    foreground_cwd: '/repo/myproj',
    tokens: {
      gentle_work_v1: opts.stale ? `${hash}:2:${Date.now() - 1000}` : freshWork(hash, opts.count ?? 2),
      gentle_roles_v1: opts.roles ?? 'explorer,worker',
    },
  };
}

let dir;
let stateDir;
let configFile;
let fakeBin;
let agentsFile;
let panesFile;
let callLog;

function writePanes(panes) {
  fs.writeFileSync(panesFile, JSON.stringify({ result: { panes } }) + '\n', 'utf8');
}

function barePane(paneId, opts = {}) {
  return {
    pane_id: paneId,
    workspace_id: opts.workspaceId ?? 'wBG',
    cwd: '/repo/myproj',
    foreground_cwd: '/repo/myproj',
  };
}

function validLedgerRecord(opts = {}) {
  return {
    session_hash: opts.sessionHash ?? HASH_A,
    observed_display: opts.display ?? 'worker',
    last_fresh_ts: 1000,
    interrupted_at: 2000,
    reason: 'agent_disappeared',
  };
}

function writeLedger(panes) {
  fs.writeFileSync(
    path.join(stateDir, 'gentle-interruptions.json'),
    JSON.stringify({ version: 1, panes }) + '\n',
    'utf8',
  );
}

function writeAgents(agents) {
  fs.writeFileSync(agentsFile, agentsDoc(agents) + '\n', 'utf8');
}

function run(bin, args, extraEnv = {}) {
  return spawnSync('node', [bin, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    env: {
      ...process.env,
      HOME: dir,
      XDG_STATE_HOME: path.join(dir, 'xdg-state'),
      XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
      HERDR_BIN_PATH: fakeBin,
      GENTLE_STATUS_STATE_DIR: stateDir,
      HERDR_CONFIG_PATH: configFile,
      HERDR_SOCKET_PATH: path.join(dir, 'no-socket.sock'),
      COLUMNS: '80',
      ...extraEnv,
    },
  });
}

function stateSnapshot() {
  const out = {};
  if (!fs.existsSync(stateDir)) return null;
  for (const name of fs.readdirSync(stateDir).sort()) {
    out[name] = fs.readFileSync(path.join(stateDir, name), 'utf8');
  }
  return out;
}

function callCount() {
  if (!fs.existsSync(callLog)) return 0;
  const body = fs.readFileSync(callLog, 'utf8');
  return body.split('---CALL---\n').length - 1;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-diag-'));
  stateDir = path.join(dir, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  configFile = path.join(dir, 'config.toml');
  fs.writeFileSync(configFile, '# empty fixture config\n', 'utf8');
  fakeBin = path.join(dir, 'herdr');
  fs.writeFileSync(fakeBin, FAKE_HERDR, { mode: 0o755 });
  agentsFile = path.join(dir, 'agents.json');
  panesFile = path.join(dir, 'panes.json');
  callLog = path.join(dir, 'calls.log');
  fs.writeFileSync(panesFile, JSON.stringify({ result: { panes: [] } }) + '\n', 'utf8');
  const env = { AGENTS_FILE: agentsFile, PANES_FILE: panesFile, CALL_LOG: callLog };
  for (const [k, v] of Object.entries(env)) process.env[`_T3_${k}`] = v;
  // Fake binary reads these from its own env at spawn time.
  process.env.AGENTS_FILE = agentsFile;
  process.env.PANES_FILE = panesFile;
  process.env.CALL_LOG = callLog;
  delete process.env.AGENTS_EXIT;
  delete process.env.PANES_EXIT;
  writeAgents([]);
});

afterEach(() => {
  delete process.env.AGENTS_FILE;
  delete process.env.PANES_FILE;
  delete process.env.CALL_LOG;
  delete process.env.AGENTS_EXIT;
  delete process.env.PANES_EXIT;
  fs.rmSync(dir, { recursive: true, force: true });
});

function runWithFiles(bin, args, files = {}) {
  // Inject per-run AGENTS_EXIT / file overrides through the child env.
  return run(bin, args, files);
}

describe('doctor sidebar-mode handoff', () => {
  it('native mode skips inactive Gentle checks without writes or private output', () => {
    fs.writeFileSync(path.join(stateDir, 'gentle-sidebar-mode.json'), JSON.stringify({ version: 1, enabled: false }));
    fs.writeFileSync(path.join(stateDir, 'gentle-status.pid'), '4000000');
    writeAgents([ownedEntry('wBG:p1', HASH_A, { stale: true })]);
    const before = stateSnapshot();
    const configBefore = fs.readFileSync(configFile, 'utf8');
    const r = run(DOCTOR, []);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'pass: native sidebar selected (Gentle supervision inactive)\npass: agent snapshot available (1 pane(s))\n');
    assert.equal(r.stderr, '');
    assert.equal(callCount(), 1);
    assert.deepEqual(stateSnapshot(), before);
    assert.equal(fs.readFileSync(configFile, 'utf8'), configBefore);
  });

  it('native mode still reports transport failure, never empty success', () => {
    fs.writeFileSync(path.join(stateDir, 'gentle-sidebar-mode.json'), JSON.stringify({ version: 1, enabled: false }));
    const before = stateSnapshot();
    const r = run(DOCTOR, [], { AGENTS_EXIT: '1' });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, `pass: native sidebar selected (Gentle supervision inactive)\nfail: agent snapshot unavailable\nremedy: verify \`${fakeBin} agent list\` runs (HERDR_BIN_PATH) and retry\n`);
    assert.equal(r.stderr, 'gentle-doctor: one or more checks failed\n');
    assert.equal(callCount(), 1);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('malformed mode fails closed without publishing its contents or running Herdr', () => {
    fs.writeFileSync(path.join(stateDir, 'gentle-sidebar-mode.json'), '{SECRET-MODE-BAIT');
    const before = stateSnapshot();
    const r = run(DOCTOR, []);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, 'fail: sidebar mode invalid (Gentle publishing disabled)\nremedy: inspect gentle-sidebar-mode.json and /herdr-gentle:sidebar status before changing modes\n');
    assert.equal(r.stderr, 'gentle-doctor: one or more checks failed\n');
    assert.equal(callCount(), 0);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('explicit Gentle mode retains the previous live checks and leaves its flag unchanged', () => {
    fs.writeFileSync(path.join(stateDir, 'gentle-sidebar-mode.json'), JSON.stringify({ version: 1, enabled: true }));
    fs.writeFileSync(path.join(stateDir, 'gentle-status.pid'), String(process.pid));
    writeAgents([ownedEntry('wBG:p1', HASH_A)]);
    fs.writeFileSync(configFile, '# BEGIN herdr-gentle-agents (managed; do not edit)\n[ui.sidebar.agents.rows_by_agent]\n# END herdr-gentle-agents\n');
    const before = stateSnapshot();
    const r = run(DOCTOR, []);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `pass: daemon running (pid ${process.pid})\npass: 1/1 owned pane(s) with fresh activity\npass: managed sidebar override present\n`);
    assert.equal(r.stderr, '');
    assert.equal(callCount(), 1);
    assert.deepEqual(stateSnapshot(), before);
  });
});

/* ---------------------------------------------------------- doctor */

describe('gentle-doctor', () => {
  it('help exits 0 with usage and makes zero herdr calls', () => {
    const before = stateSnapshot();
    const r = run(DOCTOR, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: gentle-doctor/);
    assert.equal(r.stderr, '');
    assert.equal(callCount(), 0);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('rejects unknown args with exit 2 before any read (no calls, no writes)', () => {
    const before = stateSnapshot();
    const r = run(DOCTOR, ['--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/i);
    assert.equal(callCount(), 0);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('happy path: live pid + fresh owned pane + managed override yields pass lines, exit 0', () => {
    fs.writeFileSync(path.join(stateDir, 'gentle-status.pid'), String(process.pid), 'utf8');
    writeAgents([ownedEntry('wBG:p1', HASH_A)]);
    fs.writeFileSync(
      configFile,
      '# BEGIN herdr-gentle-agents (managed; do not edit)\n[ui.sidebar.agents.rows_by_agent]\n# END herdr-gentle-agents\n',
      'utf8',
    );
    const r = run(DOCTOR, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^pass: daemon running \(pid \d+\)$/m);
    assert.match(r.stdout, /^pass: .*fresh/m);
    assert.match(r.stdout, /^pass: managed sidebar override present$/m);
    assert.doesNotMatch(r.stdout, /^fail:/m);
  });

  it('failed snapshot is failure (exit 1), not an empty successful view', () => {
    fs.writeFileSync(path.join(stateDir, 'gentle-status.pid'), String(process.pid), 'utf8');
    const r = runWithFiles(DOCTOR, [], { AGENTS_EXIT: '1' });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^fail: agent snapshot unavailable$/m);
    assert.match(r.stdout, /^remedy: /m);
    assert.doesNotMatch(r.stdout, /no agents observed/);
  });

  it('empty snapshot is a warn, not a fail (exit 0)', () => {
    writeAgents([]);
    const r = run(DOCTOR, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^warn: no agents observed$/m);
    assert.doesNotMatch(r.stdout, /^fail:/m);
  });

  it('dead pid is a fail (presence is not liveness) with remedy, exit 1', () => {
    fs.writeFileSync(path.join(stateDir, 'gentle-status.pid'), '4000000', 'utf8');
    writeAgents([]);
    const r = run(DOCTOR, []);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^fail: daemon pidfile stale \(pid 4000000 not running\)$/m);
    assert.match(r.stdout, /^remedy: /m);
  });

  it('malformed agent records are tolerated and private bait is never echoed', () => {
    fs.writeFileSync(path.join(stateDir, 'gentle-status.pid'), String(process.pid), 'utf8');
    const bait = 'SECRET-PROMPT-BAIT-9f8e7d6c5b4a verdict:APPROVE-ME';
    writeAgents([
      { nope: true, tokens: { gentle_work_v1: bait }, summary: bait, state_labels: { x: bait } },
      ownedEntry('wBG:p1', HASH_A),
    ]);
    const r = run(DOCTOR, []);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes(bait) && !r.stderr.includes(bait), 'private bait leaked');
  });

  it('never creates the state dir (read-only) and never claims socket tests', () => {
    const missing = path.join(dir, 'no-state-dir');
    const r = run(DOCTOR, [], { GENTLE_STATUS_STATE_DIR: missing });
    assert.ok(!fs.existsSync(missing), 'reader created state dir');
    assert.doesNotMatch(r.stdout, /socket/i);
    assert.doesNotMatch(r.stderr, /socket/i);
  });
});

/* ---------------------------------------------------------- trace */

describe('gentle-trace', () => {
  it('help exits 0 with usage and makes zero herdr calls', () => {
    const before = stateSnapshot();
    const r = run(TRACE, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: gentle-trace/);
    assert.equal(callCount(), 0);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('rejects missing/extra/unknown args with exit 2 before any read', () => {
    for (const args of [[], ['wBG:p1', 'extra'], ['--bogus']]) {
      const before = stateSnapshot();
      const callsBefore = callCount();
      const r = run(TRACE, args);
      assert.equal(r.status, 2, `args ${JSON.stringify(args)}`);
      assert.match(r.stderr, /usage|invalid pane id/i);
      assert.equal(callCount(), callsBefore);
      assert.deepEqual(stateSnapshot(), before);
    }
  });

  it('rejects a malformed pane id before any read', () => {
    const before = stateSnapshot();
    const r = run(TRACE, ['../../etc/passwd']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /invalid pane id/i);
    assert.equal(callCount(), 0);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('happy path emits whitelisted JSON only (no raw tokens/labels/verdicts)', () => {
    const bait = 'TRACE-BAIT-PROMPT verdict:REJECT-ME';
    const entry = ownedEntry('wBG:p1', HASH_A);
    entry.tokens.gentle_names_v1 = bait;
    entry.summary = bait;
    entry.summary2 = bait;
    entry.state_labels = { q: `ask:${bait}` };
    entry.terminal_title = bait;
    writeAgents([entry]);
    const r = run(TRACE, ['wBG:p1']);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, true);
    assert.equal(doc.pane_id, 'wBG:p1');
    assert.deepEqual(Object.keys(doc).sort(), [
      'agent', 'agent_status', 'count', 'display', 'freshness',
      'interruption', 'label', 'ok', 'owned', 'pane_id',
      'roles', 'session_hash', 'snapshot_at', 'workspace', 'workspace_id',
    ]);
    assert.ok(!r.stdout.includes(bait), 'private bait leaked into trace');
  });

  it('unknown pane is a JSON failure with exit 1', () => {
    writeAgents([ownedEntry('wBG:p1', HASH_A)]);
    const r = run(TRACE, ['wBG:p9']);
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, error: 'pane_not_found', pane_id: 'wBG:p9' });
  });

  it('failed snapshot is a JSON failure with exit 1', () => {
    const r = runWithFiles(TRACE, ['wBG:p1'], { AGENTS_EXIT: '1' });
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, error: 'snapshot_unavailable', pane_id: 'wBG:p1' });
  });

  it('surfaces a valid interruption record and rejects malformed arbitrary fields', () => {
    const entry = ownedEntry('wBG:p1', HASH_A, { stale: true, roles: '' });
    writeAgents([entry]);
    const evil = 'EVIL-ARBITRARY-FIELD-zzz';
    fs.writeFileSync(
      path.join(stateDir, 'gentle-interruptions.json'),
      JSON.stringify({
        version: 1,
        panes: {
          'wBG:p1': {
            session_hash: null,
            observed_display: 'worker',
            last_fresh_ts: 1000,
            interrupted_at: 2000,
            reason: 'agent_disappeared',
            prompt: evil,
            verdict: evil,
          },
        },
      }),
      'utf8',
    );
    const r = run(TRACE, ['wBG:p1']);
    assert.equal(r.status, 0);
    const doc = JSON.parse(r.stdout);
    assert.deepEqual(doc.interruption, {
      session_hash: null,
      observed_display: 'worker',
      last_fresh_ts: 1000,
      interrupted_at: 2000,
      reason: 'agent_disappeared',
    });
    assert.ok(!r.stdout.includes(evil), 'arbitrary ledger field leaked');
  });
});

/* ---------------------------------------------------------- whois */

describe('gentle-whois', () => {
  it('help exits 0 with usage and makes zero herdr calls', () => {
    const before = stateSnapshot();
    const r = run(WHOIS, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: gentle-whois/);
    assert.equal(callCount(), 0);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('rejects unknown args with exit 2 before any read', () => {
    const before = stateSnapshot();
    const r = run(WHOIS, ['--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage/i);
    assert.equal(callCount(), 0);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('happy path renders a stable sorted table of owned panes', () => {
    writeAgents([ownedEntry('wBG:p2', HASH_A), ownedEntry('wBG:p1', HASH_A, { roles: 'worker' })]);
    const r = run(WHOIS, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^PANE\s+AGENT\s+STATE\s+ROLES\s+WORKSPACE$/m);
    const p1 = r.stdout.indexOf('wBG:p1');
    const p2 = r.stdout.indexOf('wBG:p2');
    assert.ok(p1 >= 0 && p2 >= 0 && p1 < p2, 'rows not stably sorted');
    assert.ok(!r.stdout.includes('SECRET'), 'unexpected private text');
  });

  it('hides non-owned panes by default but shows them with --all sans task names', () => {
    const native = {
      pane_id: 'wZZ:p9',
      workspace_id: 'wZZ',
      agent_status: 'working',
      group: 'native-proj',
      summary: 'TOP-SECRET-TASK-NAME',
      // pi-tree distinctive presence token marks foreign ownership.
      tokens: { state_working: '1' },
    };
    writeAgents([ownedEntry('wBG:p1', HASH_A), native]);
    const def = run(WHOIS, []);
    assert.equal(def.status, 0);
    assert.ok(!def.stdout.includes('wZZ:p9'), 'native pane leaked into default view');
    const all = run(WHOIS, ['--all']);
    assert.equal(all.status, 0);
    assert.ok(all.stdout.includes('wZZ:p9'), '--all omitted native pane');
    assert.ok(!all.stdout.includes('TOP-SECRET-TASK-NAME'), 'private task name leaked');
  });

  it('failed snapshot (exit 1, stderr) is distinct from empty success (exit 0)', () => {
    const bad = runWithFiles(WHOIS, [], { AGENTS_EXIT: '1' });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /snapshot failed/i);
    writeAgents([]);
    const empty = run(WHOIS, []);
    assert.equal(empty.status, 0);
    assert.match(empty.stdout, /no panes observed/);
  });

  it('shows diagnostic-only Interrumpido from the L6 ledger, sidebar vocabulary untouched', () => {
    writeAgents([ownedEntry('wBG:p1', HASH_A, { stale: true, roles: '' })]);
    fs.writeFileSync(
      path.join(stateDir, 'gentle-interruptions.json'),
      JSON.stringify({
        version: 1,
        panes: {
          'wBG:p1': {
            session_hash: null,
            observed_display: 'worker',
            last_fresh_ts: 1000,
            interrupted_at: 2000,
            reason: 'agent_disappeared',
          },
        },
      }),
      'utf8',
    );
    const r = run(WHOIS, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Interrumpido/);
    assert.match(r.stdout, /diagnostic-only/);
  });

  it('tolerates a missing ledger and fits narrow widths with sanitized cells', () => {
    const entry = ownedEntry('wBG:p1', HASH_A);
    entry.group = 'proj\x01\x1fCTL';
    writeAgents([entry]);
    const r = run(WHOIS, [], { COLUMNS: '40' });
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('\x01'), 'control character leaked');
    for (const line of r.stdout.split('\n')) {
      if (line.trim() === '') continue;
      assert.ok(Array.from(line).length <= 40, `line exceeds 40 cols: ${JSON.stringify(line)}`);
    }
  });
});

/* --------------------------------- C1 S3 merge: disappeared agent with pane
   still present must surface Interrumpido; positive pane absence must not;
   failed pane list is an explicit failure, never invented presence. */

describe('C1 whois disappeared-agent merge', () => {
  it('agent gone + pane present + valid ledger shows Interrumpido (exit 0, exact view)', () => {
    writeAgents([]);
    writePanes([barePane('wBG:p1')]);
    writeLedger({ 'wBG:p1': validLedgerRecord() });
    const before = stateSnapshot();
    const r = run(WHOIS, []);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    assert.equal(
      r.stdout,
      'PANE  AGENT  STATE  ROLES  WORKSPACE\n' +
        'wBG:p1  -  Interrumpido  -  myproj\n' +
        '(Interrumpido is diagnostic-only; the sidebar is unchanged)\n',
    );
    assert.equal(callCount(), 2);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('agent gone + pane positively absent + valid ledger shows no ghost (exit 0)', () => {
    writeAgents([]);
    writePanes([]);
    writeLedger({ 'wBG:p1': validLedgerRecord() });
    const before = stateSnapshot();
    const r = run(WHOIS, []);
    assert.equal(r.status, 0);
    assert.ok(!r.stdout.includes('wBG:p1'), 'ghost closed pane shown from ledger alone');
    assert.ok(!r.stdout.includes('Interrumpido'), 'interruption shown without pane presence');
    assert.match(r.stdout, /no panes observed/);
    assert.equal(callCount(), 2);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('agent gone + pane list failed + valid ledger is failure, not empty success (exit 1)', () => {
    writeAgents([]);
    writeLedger({ 'wBG:p1': validLedgerRecord() });
    const before = stateSnapshot();
    const r = run(WHOIS, [], { PANES_EXIT: '1' });
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'gentle-whois: snapshot failed (herdr pane list unavailable)\n');
    assert.ok(!r.stdout.includes('Interrumpido'), 'presence invented from failed snapshot');
    assert.deepEqual(stateSnapshot(), before);
  });

  it('present-agent path with matched ledger makes no extra pane call', () => {
    writeAgents([ownedEntry('wBG:p1', HASH_A, { stale: true, roles: '' })]);
    writeLedger({ 'wBG:p1': validLedgerRecord() });
    const r = run(WHOIS, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Interrumpido/);
    assert.equal(callCount(), 1);
  });
});

describe('C1 trace disappeared-agent merge', () => {
  it('agent gone + pane present + valid ledger traces interrupted with safe record', () => {
    writeAgents([]);
    writePanes([barePane('wBG:p1')]);
    writeLedger({ 'wBG:p1': validLedgerRecord() });
    const before = stateSnapshot();
    const r = run(TRACE, ['wBG:p1']);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    const doc = JSON.parse(r.stdout);
    assert.equal(doc.ok, true);
    assert.equal(doc.pane_id, 'wBG:p1');
    assert.equal(doc.display, 'interrupted');
    assert.equal(doc.label, 'Interrumpido');
    assert.equal(doc.session_hash, HASH_A);
    assert.deepEqual(doc.interruption, {
      session_hash: HASH_A,
      observed_display: 'worker',
      last_fresh_ts: 1000,
      interrupted_at: 2000,
      reason: 'agent_disappeared',
    });
    assert.deepEqual(Object.keys(doc).sort(), [
      'agent', 'agent_status', 'count', 'display', 'freshness',
      'interruption', 'label', 'ok', 'owned', 'pane_id',
      'roles', 'session_hash', 'snapshot_at', 'workspace', 'workspace_id',
    ]);
    assert.equal(callCount(), 2);
    assert.deepEqual(stateSnapshot(), before);
  });

  it('agent gone + pane positively absent + valid ledger stays pane_not_found (exit 1)', () => {
    writeAgents([]);
    writePanes([]);
    writeLedger({ 'wBG:p1': validLedgerRecord() });
    const r = run(TRACE, ['wBG:p1']);
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, error: 'pane_not_found', pane_id: 'wBG:p1' });
  });

  it('agent gone + pane list failed + valid ledger is snapshot_unavailable (exit 1)', () => {
    writeAgents([]);
    writeLedger({ 'wBG:p1': validLedgerRecord() });
    const r = run(TRACE, ['wBG:p1'], { PANES_EXIT: '1' });
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, error: 'snapshot_unavailable', pane_id: 'wBG:p1' });
    assert.equal(r.stderr, 'gentle-trace: snapshot failed (herdr pane list unavailable)\n');
  });

  it('malformed ledger with gone agent exposes no bait and adds no pane call', () => {
    writeAgents([]);
    writePanes([barePane('wBG:p1')]);
    const evil = 'C1-EVIL-BAIT-qq1122 verdict:GRANT';
    fs.writeFileSync(
      path.join(stateDir, 'gentle-interruptions.json'),
      JSON.stringify({ version: 1, panes: { 'wBG:p1': { ...validLedgerRecord(), prompt: evil, verdict: evil, reason: 'bogus' } } }),
      'utf8',
    );
    const r = run(TRACE, ['wBG:p1']);
    assert.equal(r.status, 1);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, error: 'pane_not_found', pane_id: 'wBG:p1' });
    assert.ok(!r.stdout.includes(evil) && !r.stderr.includes(evil), 'malformed ledger bait leaked');
    assert.equal(callCount(), 1);
  });
});
