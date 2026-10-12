'use strict';
// Moshi full replacement (DESIGN §7, odd/tasks/moshi-full-replacement.md).
//
// The extension owns the Moshi integration the way the Moshi-managed Pi hook
// did — the same `session.update` envelopes over the Moshi daemon socket — but
// with our notification policy: a silent session carrier (Chat View, session
// row, terminal context), `approval_required` only on a real ask episode, and
// `task_complete` only on a real finish. Everything is gated by the toggle's
// flag file and skipped for lineage child sessions.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const src = path.resolve(__dirname, '../extensions/gentle-herdr-state.ts');
const srcText = fs.readFileSync(src, 'utf8');
const stubbed = srcText.replace(
  /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
  'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
);
assert.ok(stubbed !== srcText, 'expected the package import line to be stubbed');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-moshi-int-'));
const moshiSock = path.join(root, 'moshi.sock');
const herdrSock = path.join(root, 'herdr.sock');
const stateDir = path.join(root, 'state');
const sessionFile = path.join(root, 'sess.jsonl');
const childSessionFile = path.join(root, 'child.jsonl');
const flagFile = path.join(stateDir, 'gentle-moshi.json');

fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(sessionFile, '{"type":"session","id":"sess-1"}\n');
fs.writeFileSync(childSessionFile, '{"type":"session","parentSession":"parent-1"}\n');
const fakeHerdr = path.join(root, 'herdr-fake.sh');
fs.writeFileSync(fakeHerdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

// Module-level env is captured at import, so it is pinned before the first
// import resolves.
process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = herdrSock;
process.env.HERDR_PANE_ID = 'pane-1';
process.env.HERDR_BIN_PATH = fakeHerdr;
process.env.MOSHI_SOCKET_PATH = moshiSock;
process.env.GENTLE_STATUS_STATE_DIR = stateDir;

const moshiFrames = [];
const herdrFrames = [];

function socketListener(record, { reply = false } = {}) {
  return (conn) => {
    let buffer = '';
    conn.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let request;
        try {
          request = JSON.parse(line);
        } catch {
          continue;
        }
        record.push(request);
        if (reply) {
          try {
            conn.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
          } catch {}
        }
      }
    });
    conn.on('end', () => {
      try {
        conn.end();
      } catch {}
    });
    conn.on('error', () => {});
  };
}

const moshiServer = net.createServer(socketListener(moshiFrames));
const herdrServer = net.createServer(socketListener(herdrFrames, { reply: true }));
moshiServer.unref();
herdrServer.unref();

const listening = Promise.all([
  new Promise((resolve) => moshiServer.listen(moshiSock, resolve)),
  new Promise((resolve) => herdrServer.listen(herdrSock, resolve)),
]);

function enableMoshi() {
  fs.writeFileSync(flagFile, `${JSON.stringify({ enabled: true })}\n`);
}

function disableMoshi() {
  fs.writeFileSync(flagFile, `${JSON.stringify({ enabled: false })}\n`);
}

const settle = (ms = 350) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = moshiFrames.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await settle(25);
  }
}

const moshiOf = (kind) => moshiFrames.filter((f) => f && f.category === kind);
const carriers = () => moshiFrames.filter((f) => f && f.type === 'session.update' && !f.category);

function harness() {
  const handlers = new Map();
  const on = (kind, fn) => {
    if (!handlers.has(kind)) handlers.set(kind, []);
    handlers.get(kind).push(fn);
  };
  const pi = { on, events: { on: () => {}, emit: () => {} } };
  return {
    pi,
    fire: (kind, event, ctx) => {
      for (const fn of handlers.get(kind) ?? []) fn(event, ctx);
    },
  };
}

const CWD = '/tmp/gentle-proj/myproj';

function ctx({ file = sessionFile, idle = true, model = { displayName: 'gpt-test' } } = {}) {
  return {
    mode: 'tui',
    cwd: CWD,
    model,
    getContextUsage: () => ({ percent: 40 }),
    sessionManager: {
      getSessionId: () => 'sess-1',
      getSessionFile: () => file,
      getEntries: () => [],
    },
    isIdle: () => idle,
  };
}

let runtimeSeq = 0;
async function loadRuntime() {
  runtimeSeq += 1;
  const copy = path.join(root, `runtime-${runtimeSeq}.mjs`);
  fs.writeFileSync(copy, stubbed);
  const module = await import(pathToFileURL(copy).href);
  return module.default;
}

// Opens an ask episode through the direct ask-tool leg and closes it again.
function openAsk(h, callId = 'c1', toolName = 'ask_user_question') {
  h.fire('tool_execution_start', { toolCallId: callId, toolName });
}

function closeAsk(h, callId = 'c1') {
  h.fire('tool_execution_end', { toolCallId: callId });
}

test('off by default: nothing is sent to Moshi', async () => {
  await listening;
  disableMoshi();
  const before = moshiFrames.length;
  const factory = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());
  openAsk(h);
  h.fire('agent_start', {}, ctx({ idle: false }));
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(600);
  assert.equal(moshiFrames.length, before, 'no envelope while the toggle is off');
});

test('enabled: a silent session carrier carries Chat View context', async () => {
  await listening;
  enableMoshi();
  const factory = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());

  const carrier = await waitFor((f) => f.type === 'session.update' && !f.category);
  assert.ok(carrier, 'expected a category-less session carrier');
  assert.equal(carrier.source, 'pi');
  assert.equal(carrier.eventName, 'SessionStart');
  assert.equal(carrier.sessionId, 'sess-1');
  assert.equal(carrier.transcriptPath, sessionFile);
  assert.equal(carrier.cwd, CWD);
  assert.equal(carrier.projectName, 'myproj');
  assert.equal(carrier.modelName, 'gpt-test');
  assert.equal(carrier.terminalKind, 'herdr');
  assert.equal(carrier.herdrPane, 'pane-1');
  assert.equal(typeof carrier.requestedAt, 'string');
  assert.equal(carrier.contextRemaining, 60, '100 - percent');
});

test('enabled: approval_required fires once per ask episode', async () => {
  await listening;
  enableMoshi();
  const factory = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());

  openAsk(h, 'c1');
  const first = await waitFor((f) => f.category === 'approval_required');
  assert.ok(first, 'expected an approval_required envelope');
  assert.equal(first.phase, 'waitingForApproval');
  assert.equal(first.title, 'Gentle needs response');
  assert.match(first.message, /myproj/);
  assert.equal(first.toolName, 'ask_user_question');
  assert.equal(typeof first.actionId, 'string');

  // A second leg inside the same episode must not re-notify.
  openAsk(h, 'c2', 'ask_user_choice');
  await settle(400);
  assert.equal(moshiOf('approval_required').length, 1, 'one per episode');

  // Closing and reopening the episode re-arms.
  closeAsk(h, 'c1');
  closeAsk(h, 'c2');
  await settle(200);
  openAsk(h, 'c3');
  await waitFor(() => moshiOf('approval_required').length === 2);
  assert.equal(moshiOf('approval_required').length, 2, 'a new episode re-arms');
});

test('enabled: task_complete fires only on the real finish', async () => {
  await listening;
  enableMoshi();
  const factory = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());
  // Realistic ordering: the session starts, and only then a prompt opens a
  // turn. Firing both in the same tick would race the async continuation of
  // session_start (which re-derives agentActive from its own ctx) against
  // agent_start — a pre-existing latent race that never happens in Pi.
  await settle(250);

  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(300);
  assert.equal(moshiOf('task_complete').length, 0, 'working never notifies');

  h.fire('agent_settled', {}, ctx({ idle: true }));
  const finish = await waitFor((f) => f.category === 'task_complete');
  assert.ok(finish, 'expected a task_complete envelope on the real finish');
  assert.equal(finish.title, 'Gentle finished');
  assert.match(finish.message, /myproj/);

  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(400);
  assert.equal(moshiOf('task_complete').length, 1, 'a settled session never re-notifies');
});

test('enabled: a lineage child session stays out of Moshi', async () => {
  await listening;
  enableMoshi();
  const before = moshiFrames.length;
  const factory = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx({ file: childSessionFile }));
  openAsk(h);
  h.fire('agent_start', {}, ctx({ idle: false }));
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(600);
  assert.equal(moshiFrames.length, before, 'child sessions are never published');
});

test('enabled: shutdown closes the session for Moshi', async () => {
  await listening;
  enableMoshi();
  const factory = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(300);
  h.fire('session_shutdown', {}, ctx());
  const closed = await waitFor((f) => f.type === 'session.closed');
  assert.ok(closed, 'expected a session.closed envelope');
  assert.equal(closed.category, 'session_ended');
  assert.equal(closed.sessionId, 'sess-1');
});
