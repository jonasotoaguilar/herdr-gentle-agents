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
const DAEMON = path.join(REPO_ROOT, 'bin', 'gentle-status.js');
const contract = require('../lib/gentle-tokens.js');

const EXPECTED_TITLE = 'Gentle needs response';
const PROJECT_NAME = 'myproj';
const EXPECTED_BODY = `${PROJECT_NAME} needs your input. Return to Pi to respond.`;

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
  it('ask emits the exact private-safe title/body with request sound', () => {
    writeAgents(sandbox, [askEntry(sandbox, sessionPath(sandbox, 'a'))]);
    runOnce(sandbox);
    const calls = notificationCalls(sandbox);
    assert.equal(calls.length, 1);
    const c = calls[0];
    assert.equal(c[0], 'notification');
    assert.equal(c[1], 'show');
    assert.equal(c[2], EXPECTED_TITLE);
    assert.equal(c[3], '--body');
    assert.equal(c[4], EXPECTED_BODY);
    assert.equal(c[5], '--sound');
    assert.equal(c[6], 'request');
    assert.equal(Object.keys(c).length, 7);
  });

  it('ask body names the project from the workspace group', () => {
    writeAgents(sandbox, [askEntry(sandbox, sessionPath(sandbox, 'd'), { group: 'raguard' })]);
    runOnce(sandbox);
    const calls = notificationCalls(sandbox);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], EXPECTED_TITLE);
    assert.equal(calls[0][4], 'raguard needs your input. Return to Pi to respond.');
  });

  it('ask falls back to Gentle when no project name is available', () => {
    writeAgents(sandbox, [askEntry(sandbox, sessionPath(sandbox, 'e'), { group: null, cwd: null })]);
    runOnce(sandbox);
    const calls = notificationCalls(sandbox);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][2], EXPECTED_TITLE);
    assert.equal(calls[0][4], 'Gentle needs your input. Return to Pi to respond.');
  });

  it('a hostile project name cannot inject argv or control characters', () => {
    writeAgents(sandbox, [askEntry(sandbox, sessionPath(sandbox, 'f'), { group: 'bad\nname\tx$(id)' })]);
    runOnce(sandbox);
    const calls = notificationCalls(sandbox);
    assert.equal(calls.length, 1);
    assert.equal(Object.keys(calls[0]).length, 7);
    const body = calls[0][4];
    assert.ok(!/[\x00-\x1f\x7f]/.test(body), `body carries control characters: ${body}`);
    assert.ok(body.startsWith('badnamex$(id) needs your input.'), body);
  });

  it('visible copy carries no ids, paths, or question data', () => {
    const session = sessionPath(sandbox, 'secret-workspace');
    const paneId = 'pane-42-secret';
    const intentId = 'question-99-secret';
    writeAgents(sandbox, [askEntry(sandbox, session, { paneId, intentId })]);
    runOnce(sandbox);
    const calls = notificationCalls(sandbox);
    assert.equal(calls.length, 1);
    const visible = `${calls[0][2]}\n${calls[0][4]}`;
    assert.equal(visible, `${EXPECTED_TITLE}\n${EXPECTED_BODY}`);
    for (const secret of [paneId, intentId, session, 'secret', 'question-99']) {
      assert.ok(!visible.includes(secret), `visible copy leaks ${secret}`);
    }
    const hash = contract.expectedSessionHash({ agent_session: { agent: 'pi', kind: 'path', value: session } });
    assert.ok(!visible.includes(hash));
  });

  it('one notification per intent across frames; new intent re-arms', () => {
    const session = sessionPath(sandbox, 'b');
    writeAgents(sandbox, [askEntry(sandbox, session, { intentId: 'q1' })]);
    runOnce(sandbox);
    runOnce(sandbox);
    assert.equal(notificationCalls(sandbox).length, 1);
    writeAgents(sandbox, [askEntry(sandbox, session, { intentId: 'q2' })]);
    runOnce(sandbox);
    const calls = notificationCalls(sandbox);
    assert.equal(calls.length, 2);
    assert.equal(calls[1][2], EXPECTED_TITLE);
    assert.equal(calls[1][4], EXPECTED_BODY);
  });

  it('failed send retries on the next frame', () => {
    const session = sessionPath(sandbox, 'c');
    writeAgents(sandbox, [askEntry(sandbox, session, { intentId: 'q1' })]);
    fs.writeFileSync(sandbox.failFile, '1\n');
    runOnce(sandbox, { FAIL_ONCE: '1' });
    assert.equal(notificationCalls(sandbox).length, 1);
    runOnce(sandbox, { FAIL_ONCE: '1' });
    assert.equal(notificationCalls(sandbox).length, 2);
    runOnce(sandbox, { FAIL_ONCE: '1' });
    assert.equal(notificationCalls(sandbox).length, 2);
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
  const daemon = require('../bin/gentle-status.js');

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

describe('non-blocking notify (P2)', () => {
  // Slow-fake: notification send sleeps SLOW_S seconds while metadata
  // publishes return immediately. Timestamped events prove publishes land
  // while a send is still in flight (no head-of-line blocking).
  const FAKE_SLOW = `#!/bin/sh
if [ "$1" = "notification" ] && [ "$2" = "show" ]; then
  printf 'NOTIFY_START %s\\n' "$(date +%s%N)" >>"$NOTIFY_LOG"
  sleep "\${SLOW_S:-2}"
  printf -- '---CALL---\\n' >>"$NOTIFY_LOG"
  i=0
  for a in "$@"; do printf 'arg%s=<%s>\\n' "$i" "$a" >>"$NOTIFY_LOG"; i=$((i+1)); done
  if [ -n "$FAIL_FILE" ] && [ -f "$FAIL_FILE" ]; then
    remaining=$(cat "$FAIL_FILE")
    if [ "$remaining" -gt 0 ]; then
      printf '%s\\n' "$((remaining - 1))" >"$FAIL_FILE"
      printf 'NOTIFY_END %s\\n' "$(date +%s%N)" >>"$NOTIFY_LOG"
      exit 1
    fi
  fi
  printf 'NOTIFY_END %s\\n' "$(date +%s%N)" >>"$NOTIFY_LOG"
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
  printf 'META %s %s\\n' "$(date +%s%N)" "$3" >>"$NOTIFY_LOG"
  printf '{"ok":true}\\n'
  exit 0
fi
echo "fake-herdr: unknown command $*" >&2
exit 1
`;
  function useSlowFake(sb) {
    fs.writeFileSync(sb.fake, FAKE_SLOW, { mode: 0o755 });
  }
  function readTimeline(sb) {
    const raw = fs.readFileSync(sb.notifyLog, 'utf8');
    const starts = [];
    const ends = [];
    const metas = [];
    for (const line of raw.split('\n')) {
      let m = /^NOTIFY_START (\d+)$/.exec(line);
      if (m) { starts.push(BigInt(m[1])); continue; }
      m = /^NOTIFY_END (\d+)$/.exec(line);
      if (m) { ends.push(BigInt(m[1])); continue; }
      m = /^META (\d+) (\S+)$/.exec(line);
      if (m) metas.push({ at: BigInt(m[1]), pane: m[2] });
    }
    return { starts, ends, metas };
  }
  function readLedger(sb) {
    return JSON.parse(fs.readFileSync(path.join(sb.stateDir, 'gentle-status-notified.json'), 'utf8'));
  }
  function idleEntry(sb, session, paneId) {
    const entry = {
      pane_id: paneId,
      agent_session: { agent: 'pi', kind: 'path', value: session },
      agent_status: 'idle',
      group: 'myproj',
      cwd: sb.workDir,
      foreground_cwd: sb.workDir,
      tokens: {},
    };
    const hash = contract.expectedSessionHash(entry);
    entry.tokens.gentle_work_v1 = `${hash}:0:${Date.now() + 30000}`;
    return entry;
  }
  it('slow send never head-of-line blocks sibling pane metadata', () => {
    useSlowFake(sandbox);
    const s1 = sessionPath(sandbox, 'p2-a');
    const s2 = sessionPath(sandbox, 'p2-b');
    writeAgents(sandbox, [
      askEntry(sandbox, s1, { paneId: 'pane-1', intentId: 'q1' }),
      askEntry(sandbox, s2, { paneId: 'pane-2', intentId: 'q1' }),
    ]);
    runOnce(sandbox, { SLOW_S: '2' });
    assert.equal(notificationCalls(sandbox).length, 2);
    const tl = readTimeline(sandbox);
    assert.equal(tl.ends.length, 2);
    assert.ok(tl.metas.length >= 2, `expected sibling METAs, got ${tl.metas.length}`);
    const firstEnd = tl.ends[0] < tl.ends[1] ? tl.ends[0] : tl.ends[1];
    for (const meta of tl.metas) {
      assert.ok(meta.at < firstEnd, `pane ${meta.pane} metadata published only after slow send finished`);
    }
    assert.equal(Object.keys(readLedger(sandbox)).length, 2);
  });
  it('two intents in one slow frame each notify once; next frame silent', () => {
    useSlowFake(sandbox);
    const s1 = sessionPath(sandbox, 'p2-c');
    const s2 = sessionPath(sandbox, 'p2-d');
    writeAgents(sandbox, [
      askEntry(sandbox, s1, { paneId: 'pane-1', intentId: 'q1' }),
      askEntry(sandbox, s2, { paneId: 'pane-2', intentId: 'q9' }),
    ]);
    runOnce(sandbox, { SLOW_S: '1' });
    assert.equal(notificationCalls(sandbox).length, 2);
    assert.equal(Object.keys(readLedger(sandbox)).length, 2);
    runOnce(sandbox, { SLOW_S: '1' });
    assert.equal(notificationCalls(sandbox).length, 2);
  });
  it('slow failed send still publishes siblings and retries next frame', () => {
    useSlowFake(sandbox);
    const sAsk = sessionPath(sandbox, 'p2-e');
    const sIdle = sessionPath(sandbox, 'p2-f');
    writeAgents(sandbox, [
      askEntry(sandbox, sAsk, { paneId: 'pane-ask', intentId: 'q1' }),
      idleEntry(sandbox, sIdle, 'pane-idle'),
    ]);
    fs.writeFileSync(sandbox.failFile, '1\n');
    runOnce(sandbox, { SLOW_S: '2', FAIL_ONCE: '1' });
    assert.equal(notificationCalls(sandbox).length, 1);
    const first = readTimeline(sandbox);
    assert.equal(first.ends.length, 1);
    assert.ok(first.metas.length >= 1, 'sibling metadata missing on failed-send frame');
    for (const meta of first.metas) {
      assert.ok(meta.at < first.ends[0], 'sibling metadata blocked behind failed slow send');
    }
    assert.ok(!fs.existsSync(path.join(sandbox.stateDir, 'gentle-status-notified.json')));
    runOnce(sandbox, { SLOW_S: '1', FAIL_ONCE: '1' });
    assert.equal(notificationCalls(sandbox).length, 2);
    assert.equal(Object.keys(readLedger(sandbox)).length, 1);
    runOnce(sandbox, { SLOW_S: '1', FAIL_ONCE: '1' });
    assert.equal(notificationCalls(sandbox).length, 2);
  });
});
