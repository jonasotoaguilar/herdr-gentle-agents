'use strict';
// N1 isolated tests for the clear intervention notification copy
// (odd/tasks/clear-intervention-notifications.md).
//
// Isolation contract: every test builds a temp sandbox (state dir, agents
// file, notify log, fake `herdr` binary) and drives the real daemon frame
// via `node bin/gentle-status.js --once`. The socket path points at a
// nonexistent file so the socket transport always degrades to the CLI
// fallback; every Herdr call is served by the fake binary. No live
// notification, token publish, or daemon state is ever touched.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'gentle-status.js');
const contract = require('../herdr-plugin/lib/gentle-tokens.js');

// No daemon toast copy remains: the daemon emits no desktop notification
// for any display (native Herdr attention owns ask + finish); the tests
// below pin that silence. Moshi copy lives in the extension and is pinned
// by tools/gentle-moshi-integration.test.js.
const PROJECT_NAME = 'myproj';

const FAKE_HERDR = `#!/bin/sh
# Fake herdr for notify-copy tests: replays canned agent/pane JSON, logs
# every notification argv with framing, optionally fails sends.
if [ "$1" = "notification" ] && [ "$2" = "show" ]; then
  printf -- '---CALL---\\n' >>"$NOTIFY_LOG"
  i=0
  for a in "$@"; do printf 'arg%s=<%s>\\n' "$i" "$a" >>"$NOTIFY_LOG"; i=$((i+1)); done
  if [ -n "$FAIL_FILE" ] && [ -f "$FAIL_FILE" ]; then
    remaining=$(cat "$FAIL_FILE")
    if [ "$remaining" -gt 0 ]; then
      printf '%s\\n' "$((remaining - 1))" >"$FAIL_FILE"
      exit 1
    fi
  fi
  exit 0
fi
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  cat "$AGENTS_FILE"
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  printf '{"result":{"panes":[]}}\\n'
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "report-metadata" ]; then
  printf -- '---META---\\n' >>"$NOTIFY_LOG"
  printf '{"ok":true}\\n'
  exit 0
fi
echo "fake-herdr: unknown command $*" >&2
exit 1
`;

let sandbox = null;

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-notify-'));
  const stateDir = path.join(root, 'state');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const fake = path.join(root, 'herdr-fake.sh');
  fs.writeFileSync(fake, FAKE_HERDR, { mode: 0o755 });
  const sb = {
    root,
    stateDir,
    workDir,
    fake,
    agentsFile: path.join(root, 'agents.json'),
    notifyLog: path.join(root, 'notify.log'),
    failFile: path.join(root, 'fail-count'),
    socketPath: path.join(root, 'no-such-herdr.sock'),
  };
  fs.writeFileSync(sb.agentsFile, '{"result":{"agents":[]}}\n');
  fs.writeFileSync(sb.notifyLog, '');
  return sb;
}

function sessionPath(sb, name) {
  return path.join(sb.root, `session-${name}`);
}

function askEntry(sb, session, { paneId = 'pane-1', intentId = 'q1', roles = 'worker', count = 1, group = 'myproj', cwd = sb.workDir } = {}) {
  const entry = {
    pane_id: paneId,
    agent_session: { agent: 'pi', kind: 'path', value: session },
    agent_status: 'unknown',
    state_labels: { 0: `ask:${intentId}` },
    tokens: { gentle_roles_v1: roles },
  };
  if (group !== null) entry.group = group;
  if (cwd !== null) {
    entry.cwd = cwd;
    entry.foreground_cwd = cwd;
  }
  const hash = contract.expectedSessionHash(entry);
  assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
  const expiry = Date.now() + 30000;
  entry.tokens.gentle_work_v1 = `${hash}:${count}:${expiry}`;
  return entry;
}

function writeAgents(sb, agents) {
  fs.writeFileSync(sb.agentsFile, `${JSON.stringify({ result: { agents } })}\n`);
}

function runOnce(sb, extraEnv = {}) {
  const result = spawnSync(process.execPath, [DAEMON, '--once'], {
    encoding: 'utf8',
    timeout: 30000,
    env: {
      ...process.env,
      HERDR_BIN_PATH: sb.fake,
      HERDR_SOCKET_PATH: sb.socketPath,
      GENTLE_STATUS_STATE_DIR: sb.stateDir,
      AGENTS_FILE: sb.agentsFile,
      NOTIFY_LOG: sb.notifyLog,
      FAIL_FILE: extraEnv.FAIL_ONCE ? sb.failFile : '',
      ...extraEnv,
    },
  });
  assert.equal(result.status, 0, `daemon --once failed: ${result.stderr}`);
  return result;
}

function readCalls(sb) {
  const raw = fs.readFileSync(sb.notifyLog, 'utf8');
  const blocks = raw.split('---CALL---\n').slice(1);
  return blocks.map((block) => {
    const args = {};
    for (const line of block.split('\n')) {
      const m = /^arg(\d+)=<(.*)>$/.exec(line);
      if (m) args[Number(m[1])] = m[2];
    }
    return args;
  });
}

function notificationCalls(sb) {
  return readCalls(sb).filter((c) => c[0] === 'notification' && c[1] === 'show');
}

beforeEach(() => {
  sandbox = makeSandbox();
});

afterEach(() => {
  try {
    if (sandbox?.root) fs.rmSync(sandbox.root, { recursive: true, force: true });
  } catch {
    // Best-effort test hygiene; never fail the test on cleanup.
  }
  sandbox = null;
});

describe('clear intervention copy', () => {
  it('ask never emits a daemon toast (native owns desktop attention)', () => {
    writeAgents(sandbox, [askEntry(sandbox, sessionPath(sandbox, 'a'))]);
    runOnce(sandbox);
    runOnce(sandbox);
    assert.equal(notificationCalls(sandbox).length, 0);
  });

  it('ask stays silent for any project name, including hostile input', () => {
    writeAgents(sandbox, [
      askEntry(sandbox, sessionPath(sandbox, 'd'), { group: 'raguard' }),
      askEntry(sandbox, sessionPath(sandbox, 'e'), { group: null, cwd: null }),
      askEntry(sandbox, sessionPath(sandbox, 'f'), { group: 'bad\nname\tx$(id)' }),
    ]);
    runOnce(sandbox);
    runOnce(sandbox);
    assert.equal(notificationCalls(sandbox).length, 0);
  });

  it('ask stays silent across frames and intents (no re-arm toast)', () => {
    const session = sessionPath(sandbox, 'b');
    writeAgents(sandbox, [askEntry(sandbox, session, { intentId: 'q1' })]);
    runOnce(sandbox);
    runOnce(sandbox);
    writeAgents(sandbox, [askEntry(sandbox, session, { intentId: 'q2' })]);
    runOnce(sandbox);
    assert.equal(notificationCalls(sandbox).length, 0);
  });

  it('review and error never emit a daemon toast', () => {
    const session = sessionPath(sandbox, 'd');
    for (const labels of [[{ 0: 'review:r1' }], [{ 0: 'error:e1' }], [{ 0: 'review:r1', 1: 'error:e9' }]]) {
      const entry = askEntry(sandbox, session, { roles: 'worker', count: 1 });
      entry.state_labels = labels[0];
      writeAgents(sandbox, [entry]);
      const reduced = contract.reducePane(entry, Date.now());
      assert.equal(reduced.notify, null);
    }
    const reviewEntry = askEntry(sandbox, session);
    reviewEntry.state_labels = { 0: 'review:r7' };
    writeAgents(sandbox, [reviewEntry]);
    runOnce(sandbox);
    const errorEntry = askEntry(sandbox, session);
    errorEntry.state_labels = { 0: 'error:e7' };
    writeAgents(sandbox, [errorEntry]);
    runOnce(sandbox);
    assert.equal(notificationCalls(sandbox).length, 0);
  });

  it('done and idle never emit a daemon toast', () => {
    const session = sessionPath(sandbox, 'e');
    const doneEntry = {
      pane_id: 'pane-1',
      agent_session: { agent: 'pi', kind: 'path', value: session },
      agent_status: 'done',
      group: 'myproj',
      cwd: sandbox.workDir,
      foreground_cwd: sandbox.workDir,
      tokens: {},
    };
    const hash = contract.expectedSessionHash(doneEntry);
    doneEntry.tokens.gentle_work_v1 = `${hash}:0:${Date.now() + 30000}`;
    doneEntry.tokens.gentle_roles_v1 = '';
    assert.equal(contract.reducePane(doneEntry, Date.now()).display, 'done');
    writeAgents(sandbox, [doneEntry]);
    runOnce(sandbox);
    const idleEntry = { ...doneEntry, agent_status: 'idle' };
    writeAgents(sandbox, [idleEntry]);
    runOnce(sandbox);
    assert.equal(notificationCalls(sandbox).length, 0);
  });

  it('stale ask evidence stays silent (TTL semantics kept)', () => {
    const session = sessionPath(sandbox, 'f');
    const entry = askEntry(sandbox, session, { intentId: 'q1' });
    const hash = contract.expectedSessionHash(entry);
    entry.tokens.gentle_work_v1 = `${hash}:1:${Date.now() - 1000}`;
    entry.state_labels = {};
    entry.tokens.gentle_ask_v1 = `${hash}:q1:${Date.now() - 1000}`;
    assert.equal(contract.reducePane(entry, Date.now()).notify, null);
    writeAgents(sandbox, [entry]);
    runOnce(sandbox);
    assert.equal(notificationCalls(sandbox).length, 0);
  });
});

describe('adaptive poll (P1)', () => {
  const daemon = require('../herdr-plugin/bin/gentle-status.js');

  it('baseline defaults to 10s with 2s fast cycle; env overrides honored', () => {
    const defaults = daemon.resolvePollConfig({});
    assert.equal(defaults.baselineMs, 10000);
    assert.equal(defaults.fastMs, 2000);
    const custom = daemon.resolvePollConfig({
      GENTLE_STATUS_POLL_MS: '30000',
      GENTLE_STATUS_FAST_POLL_MS: '1000',
      GENTLE_STATUS_FAST_QUIET_FRAMES: '5',
      GENTLE_STATUS_FAST_WINDOW_MS: '120000',
    });
    assert.equal(custom.baselineMs, 30000);
    assert.equal(custom.fastMs, 1000);
    assert.equal(custom.quietFrames, 5);
    assert.equal(custom.windowMs, 120000);
  });

  it('fast cycle triggers on ask activity and on failure', () => {
    const config = daemon.resolvePollConfig({});
    const t0 = 1000000;
    let poll = daemon.createPollState();
    assert.equal(daemon.nextPollDelay(poll, t0, { askActivity: false, failure: false }, config), 10000);
    poll = daemon.createPollState();
    assert.equal(daemon.nextPollDelay(poll, t0, { askActivity: true, failure: false }, config), 2000);
    poll = daemon.createPollState();
    assert.equal(daemon.nextPollDelay(poll, t0, { askActivity: false, failure: true }, config), 2000);
  });

  it('recovers to baseline after N quiet frames within the window', () => {
    const config = daemon.resolvePollConfig({ GENTLE_STATUS_FAST_QUIET_FRAMES: '3' });
    const t0 = 2000000;
    const poll = daemon.createPollState();
    assert.equal(daemon.nextPollDelay(poll, t0, { askActivity: true, failure: false }, config), 2000);
    assert.equal(daemon.nextPollDelay(poll, t0 + 2000, { askActivity: false, failure: false }, config), 2000);
    assert.equal(daemon.nextPollDelay(poll, t0 + 4000, { askActivity: false, failure: false }, config), 2000);
    assert.equal(daemon.nextPollDelay(poll, t0 + 6000, { askActivity: false, failure: false }, config), 10000);
  });

  it('fast window is TTL-bounded: expiry returns to baseline', () => {
    const config = daemon.resolvePollConfig({ GENTLE_STATUS_FAST_WINDOW_MS: '5000' });
    const t0 = 3000000;
    const poll = daemon.createPollState();
    assert.equal(daemon.nextPollDelay(poll, t0, { askActivity: true, failure: false }, config), 2000);
    assert.equal(daemon.nextPollDelay(poll, t0 + 6000, { askActivity: false, failure: false }, config), 10000);
  });

  it('no busy loop: sub-second overrides are floored; single timer loop only', () => {
    const config = daemon.resolvePollConfig({
      GENTLE_STATUS_POLL_MS: '0',
      GENTLE_STATUS_FAST_POLL_MS: '1',
    });
    assert.ok(config.baselineMs >= 250, `baseline floor missing: ${config.baselineMs}`);
    assert.ok(config.fastMs >= 250, `fast floor missing: ${config.fastMs}`);
    assert.ok(config.fastMs <= config.baselineMs);
    const source = fs.readFileSync(DAEMON, 'utf8');
    assert.ok(!/setInterval\s*\(/.test(source), 'daemon must not use setInterval');
  });
});


