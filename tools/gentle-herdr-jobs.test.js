'use strict';
// A live background job keeps the session non-terminal (DESIGN §7, S9 in
// odd/tasks/moshi-full-replacement.md).
//
// Gentle Shell runs `bash_background` / `monitor` jobs per session and
// publishes the running set on the Pi event bus:
//   pi.events.emit("gentle-ai:jobs-sidebar",
//     { sessionId, snapshot: { jobs: [{ id, label, startedAt }] } })
// While that set is non-empty the principal may settle — but it has NOT
// finished: the native state must stay `working`, the orchestrating marker
// must keep publishing (sidebar keeps showing `gentle`), the terminal
// `done`/`idle` must not be reached, and the Moshi finish notification must
// not fire. Only when the last job is gone does the working→idle edge happen.

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

const JOBS_EVENT = 'gentle-ai:jobs-sidebar';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-herdr-jobs-'));
const herdrSock = path.join(root, 'herdr.sock');
const moshiSock = path.join(root, 'moshi.sock');
const stateDir = path.join(root, 'state');
const sessionFile = path.join(root, 'sess.jsonl');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(sessionFile, '{"type":"session"}\n');
fs.writeFileSync(path.join(stateDir, 'gentle-moshi.json'), '{"enabled":true}\n');
const fakeHerdr = path.join(root, 'herdr-fake.sh');
fs.writeFileSync(fakeHerdr, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = herdrSock;
process.env.HERDR_PANE_ID = 'pane-1';
process.env.HERDR_BIN_PATH = fakeHerdr;
process.env.MOSHI_SOCKET_PATH = moshiSock;
process.env.GENTLE_STATUS_STATE_DIR = stateDir;

const herdrFrames = [];
const moshiFrames = [];

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

const herdrServer = net.createServer(socketListener(herdrFrames, { reply: true }));
const moshiServer = net.createServer(socketListener(moshiFrames));
herdrServer.unref();
moshiServer.unref();
const listening = Promise.all([
  new Promise((resolve) => herdrServer.listen(herdrSock, resolve)),
  new Promise((resolve) => moshiServer.listen(moshiSock, resolve)),
]);

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = herdrFrames.find(predicate);
    if (hit) return hit;
    if (Date.now() > deadline) return undefined;
    await settle(25);
  }
}

const nativeStates = () => herdrFrames.filter((f) => f?.method === 'pane.report_agent').map((f) => f.params.state);
const moshiOf = (kind) => moshiFrames.filter((f) => f && f.category === kind);

function harness() {
  const handlers = new Map();
  const busHandlers = new Map();
  const on = (registry) => (kind, fn) => {
    if (!registry.has(kind)) registry.set(kind, []);
    registry.get(kind).push(fn);
  };
  const pi = {
    on: on(handlers),
    events: { on: on(busHandlers), emit: () => {} },
  };
  return {
    pi,
    fire: (kind, event, ctx) => {
      for (const fn of handlers.get(kind) ?? []) fn(event, ctx);
    },
    fireBus: (kind, payload) => {
      for (const fn of busHandlers.get(kind) ?? []) fn(payload);
    },
  };
}

const CWD = '/tmp/gentle-proj/myproj';

function ctx({ idle = true } = {}) {
  return {
    mode: 'tui',
    cwd: CWD,
    model: { displayName: 'gpt-test' },
    getContextUsage: () => ({ percent: 40 }),
    sessionManager: {
      getSessionId: () => 'sess-1',
      getSessionFile: () => sessionFile,
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
  return module;
}

const jobsSnapshot = (sessionId, jobs) => ({ sessionId, snapshot: { jobs } });
const job = (id, label = 'ci') => ({ id, label, startedAt: Date.now() });

// Principal settles while the given job set is live; returns the runtime
// handles so a test can then clear the set.
async function settleWithJobs(h) {
  h.fire('session_start', { reason: 'startup' }, ctx());
  await settle(250);
  h.fire('agent_start', {}, ctx({ idle: false }));
  await settle(300);
  h.fire('agent_settled', {}, ctx({ idle: true }));
  await settle(500);
}

test('computeNativeState treats a live job as working, never idle', async () => {
  const mod = await loadRuntime();
  const base = {
    agentActive: false,
    settled: true,
    activeCount: 0,
    pendingCount: 0,
    askActive: false,
    reviewActive: false,
    hasError: false,
  };
  assert.equal(mod.computeNativeState(base), 'idle', 'true empty settle is idle');
  assert.equal(mod.computeNativeState({ ...base, jobCount: 1 }), 'working', 'a live job keeps it working');
  assert.equal(mod.computeNativeState({ ...base, jobCount: 2, activeCount: 1 }), 'working');
});

test('a running job keeps the native state working and the marker alive', async () => {
  await listening;
  const before = herdrFrames.length;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1')]));
  await settleWithJobs(h);

  const frames = herdrFrames.slice(before);
  assert.ok(frames.length > 0, 'the extension must keep publishing');
  assert.ok(
    !nativeStates().slice(-1).includes('idle'),
    `no terminal idle while a job runs (saw ${JSON.stringify(nativeStates())})`,
  );
  assert.equal(nativeStates().at(-1), 'working', 'the last native state stays working');

  const marker = frames
    .filter((f) => f.method === 'pane.report_metadata')
    .flatMap((f) => Object.entries(f.params.tokens ?? {}))
    .filter(([name]) => name === 'gentle_orchestrating_v1')
    .map(([, value]) => value);
  assert.ok(
    marker.some((value) => typeof value === 'string' && value.length > 0),
    'the orchestrating marker keeps publishing (sidebar keeps showing gentle)',
  );
  assert.equal(moshiOf('task_complete').length, 0, 'no finish notification while a job runs');
});

test('the finish waits for the last job to end', async () => {
  await listening;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-1'), job('job-2', 'monitor')]));
  await settleWithJobs(h);
  assert.equal(moshiOf('task_complete').length, 0, 'still nothing while jobs run');

  // One job left: still not finished.
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', [job('job-2', 'monitor')]));
  await settle(400);
  assert.equal(moshiOf('task_complete').length, 0, 'one job left is still working');

  // All clear: the working→idle edge fires once.
  h.fireBus(JOBS_EVENT, jobsSnapshot('sess-1', []));
  const idle = await waitFor((f) => f.method === 'pane.report_agent' && f.params.state === 'idle');
  assert.ok(idle, 'the terminal idle arrives once the last job ends');
  await waitFor(() => moshiOf('task_complete').length === 1);
  assert.equal(moshiOf('task_complete').length, 1, 'exactly one finish notification');
});

test('jobs owned by another session never block this one', async () => {
  await listening;
  const before = herdrFrames.length;
  const { default: factory } = await loadRuntime();
  const h = harness();
  factory(h.pi);
  h.fireBus(JOBS_EVENT, jobsSnapshot('other-session', [job('job-x')]));
  await settleWithJobs(h);
  const states = herdrFrames.slice(before).filter((f) => f.method === 'pane.report_agent').map((f) => f.params.state);
  assert.ok(states.includes('idle'), `another session's job must not block this one (saw ${JSON.stringify(states)})`);
});
