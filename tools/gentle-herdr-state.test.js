'use strict';
// Focused behavior tests for the generic tool-blocking UI prompt leg in
// extensions/gentle-herdr-state.ts (mirrors the installed herdr-pi-tree
// herdr-prompt-state pattern: a Pi `ui_prompt_start` contributes to ask only
// when it opens while at least one `tool_execution_start`ed tool call is in
// flight; nested/duplicate lifecycle coalesces into one boolean leg).
//
// The extension is TypeScript with one package import that is unresolvable
// under plain node (@earendil-works/pi-coding-agent, used only for
// transcript patch accounting). The tests load a renamed copy with exactly
// that import line stubbed — production is untouched — the same approach as
// the installed herdr-pi-tree tools/prompt-state.test.js.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-herdr-state-'));
// Single-file deployment boundary: state.ts ships alone (installed copy or
// symlink) with no sibling helper, so the copy is exactly one file and the
// load proves no relative import is needed.
assert.ok(
  !/^import .* from "\.\//m.test(stubbed),
  'state.ts must stay self-contained (no relative imports)',
);
const copy = path.join(root, 'gentle-herdr-state.mjs');
fs.writeFileSync(copy, stubbed);
const copyUrl = pathToFileURL(copy).href;

// Module-level env/pane binding is captured at import, so it is pinned
// before the first import resolves.
process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = '/tmp/nonexistent-gentle-herdr-state.sock';
process.env.HERDR_PANE_ID = 'test-pane';
const factoryPromise = import(copyUrl);

function harness() {
  const handlers = new Map(); // pi.on kinds
  const eventHandlers = new Map(); // pi.events.on kinds
  const emitted = [];
  const on = (registry) => (kind, fn) => {
    if (!registry.has(kind)) registry.set(kind, []);
    registry.get(kind).push(fn);
  };
  const pi = {
    on: on(handlers),
    events: {
      on: on(eventHandlers),
      emit: (kind, payload) => emitted.push([kind, payload]),
    },
  };
  return {
    pi,
    emitted,
    fire: (kind, event, ctx) => {
      for (const fn of handlers.get(kind) ?? []) fn(event, ctx);
    },
    fireEvent: (kind, event) => {
      for (const fn of eventHandlers.get(kind) ?? []) fn(event);
    },
  };
}

// sessionHash stays undefined (no session file), so beats build zero tokens
// and never touch the socket/CLI transport; the `herdr:blocked` label leg
// (which shares askActiveNow with the durable gentle_ask_v1 token) is fully
// observable without network side effects.
function startRootSession(h, sessionId = 'sess-1') {
  const ctx = {
    mode: 'tui',
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => {
        throw new Error('no session file in tests');
      },
      getEntries: () => [],
    },
    isIdle: () => false,
  };
  h.fire('session_start', {}, ctx);
  return ctx;
}

function blockedLabels(h) {
  return h.emitted
    .filter(([kind]) => kind === 'herdr:blocked')
    .map(([, payload]) => payload);
}

test('prompt during a tool call enters ask and coalesces nested lifecycle', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'select' });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].active, true);
  assert.match(labels[0].label, /^ask:q1-/);
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'confirm' });
  assert.equal(blockedLabels(h).length, 1, 'nested start must not re-emit');
  h.fire('tool_execution_end', { toolCallId: 't1' });
  assert.equal(blockedLabels(h).length, 1, 'tool end mid-prompt must not clear the span');
  h.fire('ui_prompt_end', {});
  labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
  h.fire('ui_prompt_end', {});
  assert.equal(blockedLabels(h).length, 2, 'duplicate end must not re-emit');
});

test('prompt with no tool in flight never becomes ask', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'custom' });
  h.fire('ui_prompt_end', {});
  assert.equal(blockedLabels(h).length, 0);
});

test('tool end before the prompt leaves the session working', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  h.fire('tool_execution_end', { toolCallId: 't1' });
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'input' });
  h.fire('ui_prompt_end', {});
  assert.equal(blockedLabels(h).length, 0);
});

test('overlapping executions keep the gate for a later prompt', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  h.fire('tool_execution_start', { toolCallId: 't2' });
  h.fire('tool_execution_end', { toolCallId: 't1' });
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'editor' });
  const labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].active, true);
  assert.match(labels[0].label, /^ask:/);
});

test('prompt leg shares one intent episode with the questionnaire leg', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fireEvent('rpiv:ask-user:blocked', { active: true });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  const intent = labels[0].label;
  assert.match(intent, /^ask:/);
  // A tool-gated prompt opening mid-episode must not mint a second intent.
  h.fire('tool_execution_start', { toolCallId: 't1' });
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'select' });
  assert.equal(blockedLabels(h).length, 1);
  h.fire('ui_prompt_end', {});
  assert.equal(blockedLabels(h).length, 1, 'questionnaire still holds ask after prompt end');
  h.fireEvent('rpiv:ask-user:blocked', { active: false });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
  assert.equal(labels[0].label, intent);
});

test('session shutdown clears the prompt leg', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_execution_start', { toolCallId: 't1' });
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'select' });
  assert.equal(blockedLabels(h).length, 1);
  h.fire('session_shutdown', {});
  let labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
  // After shutdown the handlers are inert until a new root session starts,
  // and the fresh session carries no prompt state.
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'select' });
  assert.equal(blockedLabels(h).length, 2);
  startRootSession(h, 'sess-2');
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'select' });
  h.fire('ui_prompt_end', {});
  assert.equal(blockedLabels(h).length, 2);
});

test('review call emits review and clears immediately on resolve (no grace)', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  const acked = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
  // Proposal alone never opens review — only acknowledged execution does.
  h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: acked });
  assert.equal(blockedLabels(h).length, 0, 'proposal must not open review');
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: acked });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].active, true);
  assert.match(labels[0].label, /^review:r-/);
  const review = labels[0].label;
  // A controller status check never enters the review leg.
  h.fire('tool_call', { toolName: 'gentle_review', toolCallId: 's1', input: { operation: 'status' } });
  h.fire('tool_execution_start', { toolCallId: 's1', toolName: 'gentle_review', args: { operation: 'status' } });
  assert.equal(blockedLabels(h).length, 1, 'controller calls must not disturb the episode');
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 's1' });
  h.fire('tool_execution_end', { toolCallId: 's1', toolName: 'gentle_review' });
  assert.equal(blockedLabels(h).length, 1);
  h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2, 'last resolve clears on the same beat — no grace');
  assert.deepEqual(labels[1], { active: false });
  assert.equal(labels[0].label, review);
});

test('overlapping review calls share one review episode until the last resolves', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  const ackedCapture = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
  const ackedGroup = { lineageId: 'lin-1', collectBindings: ['{}'], reviewerRunAcknowledged: true };
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: ackedCapture });
  h.fire('tool_execution_start', { toolCallId: 'c2', toolName: 'gentle_review_capture_group', args: ackedGroup });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  const review = labels[0].label;
  assert.match(review, /^review:/);
  h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
  assert.equal(blockedLabels(h).length, 1, 'one surviving call holds the episode');
  assert.equal(blockedLabels(h)[0].label, review, 'episode id stays stable across overlap');
  h.fire('tool_result', { toolName: 'gentle_review_capture_group', toolCallId: 'c2' });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
});

test('reserved review hook events are fully ignored', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  // No producer exists and no handler is registered: well-formed,
  // duplicate, malformed, and inactive payloads are all inert.
  h.fireEvent('gentle-pi:review:blocked', { active: true, reviewId: 'hook1' });
  h.fireEvent('gentle-pi:review:blocked', { active: true, reviewId: 'hook1' });
  h.fireEvent('gentle-pi:review:blocked', { active: false });
  h.fireEvent('gentle-pi:review:blocked', { active: 'yes' });
  h.fireEvent('gentle-pi:review:blocked', {});
  assert.equal(blockedLabels(h).length, 0, 'hook signals must never hold review');
});

test('eligible start never asks; acked capture still reviews while it is pending', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  // Ordinary-mode start never speculates ask — before, during, or after.
  h.fire('tool_call', {
    toolName: 'gentle_review',
    toolCallId: 's1',
    input: { operation: 'start', input: { mode: 'ordinary' } },
  });
  h.fire('tool_execution_start', {
    toolCallId: 's1',
    toolName: 'gentle_review',
    args: { operation: 'start', input: { mode: 'ordinary' } },
  });
  assert.equal(blockedLabels(h).length, 0, 'eligible start must never speculate ask');
  // An acknowledged capture execution holds review independently of it.
  const acked = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: acked });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.match(labels[0].label, /^review:/);
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 's1' });
  h.fire('tool_execution_end', { toolCallId: 's1', toolName: 'gentle_review' });
  assert.equal(blockedLabels(h).length, 1, 'start resolve must not disturb the live execution');
  h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
});

test('select-intended-untracked start never enters ask or review', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_call', {
    toolName: 'gentle_review',
    toolCallId: 's1',
    input: { operation: 'select-intended-untracked' },
  });
  h.fire('tool_execution_start', {
    toolCallId: 's1',
    toolName: 'gentle_review',
    args: { operation: 'select-intended-untracked' },
  });
  assert.equal(blockedLabels(h).length, 0);
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 's1' });
  h.fire('tool_execution_end', { toolCallId: 's1', toolName: 'gentle_review' });
  assert.equal(blockedLabels(h).length, 0);
});

test('error outranks ask outranks review across legs', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  const acked = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: acked });
  assert.match(blockedLabels(h)[0].label, /^review:/);
  h.fireEvent('rpiv:ask-user:blocked', { active: true });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.match(labels[1].label, /^ask:/);
  h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'run1', isError: true });
  labels = blockedLabels(h);
  assert.equal(labels.length, 3);
  assert.match(labels[2].label, /^error:/);
  // The error latch clears on the next agent_start; ask still holds.
  h.fire('agent_start', {}, { sessionManager: { getSessionFile: () => { throw new Error('no session file'); } } });
  labels = blockedLabels(h);
  assert.equal(labels.length, 4);
  assert.match(labels[3].label, /^ask:/);
  h.fireEvent('rpiv:ask-user:blocked', { active: false });
  labels = blockedLabels(h);
  assert.equal(labels.length, 5);
  assert.match(labels[4].label, /^review:/, 'ask release falls back to the live review call');
  h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
  assert.deepEqual(blockedLabels(h)[5], { active: false });
});

test('settled session keeps review until the last call resolves (beats stay alive)', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  const ackedSettle = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: ackedSettle });
  assert.equal(blockedLabels(h).length, 1);
  const idleCtx = { isIdle: () => true };
  h.fire('agent_settled', {}, idleCtx);
  assert.equal(blockedLabels(h).length, 1, 'settle must not clear a live review leg');
  h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
  h.fire('agent_settled', {}, idleCtx);
  const labels = blockedLabels(h);
  assert.deepEqual(labels[labels.length - 1], { active: false });
});

// NO GRACE regression: the last review call resolving while ask owns the
// visible label used to emit no label transition and schedule no publish,
// so `gentle_review_v1` stayed live until the next 15s beat/TTL. This test
// observes actual token bytes on a fake Herdr socket with a valid session
// hash — labels alone cannot catch the bug.
test('review token bytes clear immediately when the last call resolves under ask', async () => {
  const net = require('node:net');
  const { createHash } = require('node:crypto');
  const sockPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-review-bytes-')),
    'herdr.sock',
  );
  const received = [];
  const conns = new Set();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    let buf = '';
    conn.on('data', (chunk) => {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          req &&
          req.method === 'pane.report_metadata' &&
          req.params &&
          typeof req.params.tokens === 'object'
        ) {
          received.push(req.params.tokens);
        }
        try {
          conn.write(`${JSON.stringify({ id: req && req.id, result: true })}\n`);
        } catch {}
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  const prevEnv = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
  process.env.HERDR_ENV = '1';
  process.env.HERDR_SOCKET_PATH = sockPath;
  process.env.HERDR_PANE_ID = 'test-pane-bytes';
  try {
    // Fresh module instance so the socket endpoint binds to the fake server.
    // Single file only — no sibling helper alongside the copy.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-herdr-state-bytes-'));
    const copy2 = path.join(dir, 'gentle-herdr-state-bytes.mjs');
    fs.writeFileSync(copy2, stubbed);
    const { default: factory2 } = await import(pathToFileURL(copy2).href);
    const h = harness();
    factory2(h.pi);
    const sessionFile = '/tmp/gentle-review-bytes-session';
    const expectedHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    assert.match(expectedHash, /^[A-Za-z0-9_-]{43}$/);
    h.fire(
      'session_start',
      {},
      {
        mode: 'tui',
        sessionManager: {
          getSessionId: () => 'sess-bytes',
          getSessionFile: () => sessionFile,
          getEntries: () => [],
        },
        isIdle: () => false,
      },
    );
    const waitForFrom = async (from, pred, timeoutMs, what) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const found = received.slice(from).find(pred);
        if (found) return found;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.fail(`timed out waiting for ${what}; ${received.length - from} new patches seen`);
    };
    // 1. The acknowledged capture execution publishes a fresh review token on the wire.
    h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true } });
    const fresh = await waitForFrom(
      0,
      (p) => typeof p.gentle_review_v1 === 'string',
      5000,
      'fresh gentle_review_v1 bytes',
    );
    const [tokHash, tokId, tokExp] = fresh.gentle_review_v1.split(':');
    assert.equal(tokHash, expectedHash, 'token carries the valid session hash');
    const reviewLabel = blockedLabels(h).find((p) => p.active)?.label;
    assert.match(reviewLabel ?? '', /^review:/);
    assert.equal(tokId, reviewLabel.split(':')[1], 'token reuses the sanitized reviewId episode');
    const expiry = Number(tokExp);
    assert.ok(expiry > Date.now() && expiry <= Date.now() + 60000, 'token expiry is TTL-fresh');
    // 2. Ask takes the visible label while the review token stays fresh.
    // Drain every scheduled beat first: the ask publish must flush (fresh
    // ask token on the wire) and the loop must go quiescent, otherwise a
    // still-pending ask beat would flush after the resolve below and mask
    // a missing immediate clear.
    h.fireEvent('rpiv:ask-user:blocked', { active: true });
    assert.match(blockedLabels(h)[blockedLabels(h).length - 1].label, /^ask:/);
    await waitForFrom(
      0,
      (p) => typeof p.gentle_ask_v1 === 'string' && typeof p.gentle_review_v1 === 'string',
      5000,
      'ask beat flushed with review token still fresh',
    );
    await new Promise((r) => setTimeout(r, 350));
    const countAfterSettle = received.length;
    await new Promise((r) => setTimeout(r, 350));
    assert.equal(
      received.length,
      countAfterSettle,
      'no beat pending before the resolve — the clear below must be newly scheduled',
    );
    const labelsBefore = blockedLabels(h).length;
    const patchesBefore = received.length;
    // 3. The last review call resolves while ask owns the label: no label
    // transition fires, but the null clear must still ship immediately.
    h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
    assert.equal(blockedLabels(h).length, labelsBefore, 'label stays ask — the stale-token bug hid here');
    const cleared = await waitForFrom(
      patchesBefore,
      (p) => 'gentle_review_v1' in p && p.gentle_review_v1 === null,
      5000,
      'immediate gentle_review_v1=null clear (must not wait for the 15s beat)',
    );
    assert.ok(cleared, 'clear patch observed');
    assert.match(
      blockedLabels(h)[blockedLabels(h).length - 1].label,
      /^ask:/,
      'ask still owns the visible label',
    );
  } finally {
    process.env.HERDR_ENV = prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = prevEnv.HERDR_PANE_ID;
    for (const conn of conns) {
      try {
        conn.destroy();
      } catch {}
    }
    await new Promise((r) => server.close(r));
  }
});

// --- T1 presence reconciliation wiring -------------------------------------
// The producer must reconcile delegate completion from the bounded passive
// presence snapshot independently of deferred chat results. These tests use
// real session ref fixtures (profile dir + header/activity files with valid
// digests) and observe actual token bytes on a fake Herdr socket, because
// label legs alone cannot catch a stuck work count or a retained role.

const WIRE_INCARNATION = '323e4567-e89b-42d3-a456-426614174002';

function wirePresenceRoot(agentHome) {
  const shared = path.join(agentHome, 'gentle-agents');
  const presenceRoot = path.join(shared, 'presence');
  fs.mkdirSync(presenceRoot, { recursive: true });
  fs.chmodSync(agentHome, 0o755);
  fs.chmodSync(shared, 0o700);
  fs.chmodSync(presenceRoot, 0o700);
  return presenceRoot;
}

function wireSummary(id, status, agent = 'gentle-ai-worker') {
  return {
    id,
    agent,
    label: `label ${id}`,
    status,
    model: 'test-model',
    createdAt: 1700000000000,
    startedAt: 1700000000001,
    endedAt: null,
    lastActivityAt: 1700000000002,
  };
}

function writeWireSnapshot(presenceRoot, { sessionId, generation, heartbeat, tasks }) {
  const { createHash } = require('node:crypto');
  const sessionHash = createHash('sha256').update(sessionId, 'utf8').digest('hex');
  const counts = { running: 0, queued: 0, waiting: 0, finished: 0 };
  for (const task of tasks) {
    if (task.status === 'running') counts.running += 1;
    else if (task.status === 'queued') counts.queued += 1;
    else if (task.status === 'waiting') counts.waiting += 1;
    else counts.finished += 1;
  }
  const activityBytes = JSON.stringify({
    schema: 1,
    sessionHash,
    incarnation: WIRE_INCARNATION,
    generation,
    activity: {
      tasks: tasks.map((task) => ({
        summary: wireSummary(task.id, task.status, task.agent),
        thread: { version: 0, dropped: 0, items: [] },
      })),
    },
  });
  fs.writeFileSync(
    path.join(presenceRoot, `${sessionHash}.${WIRE_INCARNATION}.header.json`),
    JSON.stringify({
      schema: 1,
      sessionHash,
      incarnation: WIRE_INCARNATION,
      label: 'Wire Session',
      heartbeat,
      generation,
      counts,
      digest: createHash('sha256').update(activityBytes, 'utf8').digest('hex'),
      unavailable: null,
    }),
  );
  fs.writeFileSync(
    path.join(presenceRoot, `${sessionHash}.${WIRE_INCARNATION}.activity.json`),
    activityBytes,
  );
}

async function loadWireFactory(sockPath, paneId) {
  const prevEnv = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
  process.env.HERDR_ENV = '1';
  process.env.HERDR_SOCKET_PATH = sockPath;
  process.env.HERDR_PANE_ID = paneId;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-herdr-wire-'));
    const wireCopy = path.join(dir, 'gentle-herdr-state-wire.mjs');
    fs.writeFileSync(wireCopy, stubbed);
    const { default: factory } = await import(pathToFileURL(wireCopy).href);
    return { factory, prevEnv };
  } catch (error) {
    process.env.HERDR_ENV = prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = prevEnv.HERDR_PANE_ID;
    throw error;
  }
}

async function startWireServer() {
  const net = require('node:net');
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-wire-')), 'herdr.sock');
  const received = [];
  const conns = new Set();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    let buf = '';
    conn.on('data', (chunk) => {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        if (req && req.method === 'pane.report_metadata' && req.params && typeof req.params.tokens === 'object') {
          received.push(req.params.tokens);
        }
        try {
          conn.write(`${JSON.stringify({ id: req && req.id, result: true })}\n`);
        } catch {}
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  const waitForFrom = async (from, pred, timeoutMs, what) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = received.slice(from).find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`timed out waiting for ${what}; ${received.length - from} new patches seen`);
  };
  const close = async () => {
    for (const conn of conns) {
      try {
        conn.destroy();
      } catch {}
    }
    await new Promise((r) => server.close(r));
  };
  return { sockPath, received, waitForFrom, close };
}

test('deferred chat: witnessed presence absence completes the last delegate', async () => {
  const { sockPath, received, waitForFrom, close } = await startWireServer();
  const { factory, prevEnv } = await loadWireFactory(sockPath, 'test-pane-wire');
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-wire-home-'));
  const presenceRoot = wirePresenceRoot(agentHome);
  const prevProfile = process.env.GENTLE_PI_AGENT_HOME;
  process.env.GENTLE_PI_AGENT_HOME = agentHome;
  try {
    const h = harness();
    factory(h.pi);
    const sessionId = 'sess-wire-absence';
    const sessionFile = '/tmp/gentle-wire-session';
    h.fire(
      'session_start',
      {},
      {
        mode: 'tui',
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => sessionFile,
          getEntries: () => [],
        },
        isIdle: () => false,
      },
    );
    // Launch observed locally as running; chat completion will be deferred
    // (no message_end), so only passive presence reconciliation may resolve it.
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'run-w1',
      input: { agent: 'gentle-ai-worker', label: 'wire work' },
    });
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'run-w1',
      details: { gentleAgents: { taskId: 'w1', agent: 'gentle-ai-worker', status: 'running' } },
    });
    const { createHash } = require('node:crypto');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    // Upstream still lists the delegate running: witness, no completion.
    writeWireSnapshot(presenceRoot, {
      sessionId,
      generation: 1,
      heartbeat: Date.now(),
      tasks: [{ id: 'w1', status: 'running' }],
    });
    h.fire('agent_start', {});
    const running = await waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'work count 1 while the delegate runs',
    );
    assert.equal(running.gentle_roles_v1, 'worker');
    // Upstream settles the delegate: the next generation drops it. The chat
    // result stays deferred — reconciliation must still clear the role.
    writeWireSnapshot(presenceRoot, {
      sessionId,
      generation: 2,
      heartbeat: Date.now(),
      tasks: [],
    });
    const before = received.length;
    h.fire('agent_start', {});
    const cleared = await waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:0:`),
      5000,
      'work count 0 after witnessed presence absence',
    );
    assert.equal(cleared.gentle_roles_v1, null, 'last delegate completion clears the role');
    assert.equal(
      typeof cleared.gentle_orchestrating_v1,
      'string',
      'principal active retains the orchestrating marker',
    );
  } finally {
    if (prevProfile === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
    else process.env.GENTLE_PI_AGENT_HOME = prevProfile;
    process.env.HERDR_ENV = prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = prevEnv.HERDR_PANE_ID;
    await close();
  }
});

test('deferred chat result still completes the delegate under a settled principal', async () => {
  const { sockPath, received, waitForFrom, close } = await startWireServer();
  const { factory, prevEnv } = await loadWireFactory(sockPath, 'test-pane-deferred');
  try {
    const h = harness();
    factory(h.pi);
    const sessionId = 'sess-wire-deferred';
    const sessionFile = '/tmp/gentle-wire-deferred-session';
    h.fire(
      'session_start',
      {},
      {
        mode: 'tui',
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => sessionFile,
          getEntries: () => [],
        },
        isIdle: () => false,
      },
    );
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'run-d1',
      input: { agent: 'gentle-ai-worker', label: 'deferred work' },
    });
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'run-d1',
      details: { gentleAgents: { taskId: 'd1', agent: 'gentle-ai-worker', status: 'running' } },
    });
    // Principal settles while the delegate runs; the completion chat is
    // deferred past settlement and arrives late.
    h.fire('agent_settled', {}, { isIdle: () => true });
    const { createHash } = require('node:crypto');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    await waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'running delegate still counted while the principal is settled',
    );
    h.fire('message_end', {
      message: {
        role: 'custom',
        customType: 'gentle-agents.result',
        details: { gentleAgents: { taskId: 'd1', agent: 'gentle-ai-worker', status: 'completed' } },
      },
    });
    // Principal resumes working with no delegates left.
    const before = received.length;
    h.fire('agent_start', {});
    const cleared = await waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:0:`),
      5000,
      'work count 0 after the deferred completion lands',
    );
    assert.equal(cleared.gentle_roles_v1, null);
    assert.equal(typeof cleared.gentle_orchestrating_v1, 'string');
  } finally {
    process.env.HERDR_ENV = prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = prevEnv.HERDR_PANE_ID;
    await close();
  }
});

// --- Installed single-file boundary ----------------------------------------
// Deployment incident: the installed ~/.pi/agent/extensions/ directory holds
// only one file (a copy per the public installer, or a symlink of the repo
// file). A relative helper import resolves against the installed directory
// and breaks child startup there. These tests simulate the installed
// directory exactly — one state.ts plus a stubbed Pi package — and prove the
// deployed file loads and reconciles with no sibling helper present.

function makeInstalledDir() {
  const installedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-installed-'));
  const stubPkg = path.join(installedDir, 'node_modules', '@earendil-works', 'pi-coding-agent');
  fs.mkdirSync(stubPkg, { recursive: true });
  fs.writeFileSync(
    path.join(stubPkg, 'package.json'),
    JSON.stringify({
      name: '@earendil-works/pi-coding-agent',
      version: '0.0.0-test',
      type: 'module',
      exports: { '.': './index.js' },
    }),
  );
  fs.writeFileSync(
    path.join(stubPkg, 'index.js'),
    'export const generateUnifiedPatch = () => { throw new Error("stubbed in installed-dir test"); };\n',
  );
  return installedDir;
}

async function loadInstalled(statePath) {
  const prevEnv = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
  process.env.HERDR_ENV = '1';
  process.env.HERDR_SOCKET_PATH = '/tmp/nonexistent-gentle-installed.sock';
  process.env.HERDR_PANE_ID = 'test-pane-installed';
  try {
    return await import(pathToFileURL(statePath).href);
  } finally {
    process.env.HERDR_ENV = prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = prevEnv.HERDR_PANE_ID;
  }
}

function assertLiveHelpers(mod, what) {
  assert.equal(typeof mod.default, 'function', `${what}: default factory must load`);
  for (const name of [
    'resolvePresenceProfile',
    'readPresenceSnapshot',
    'createPresenceReconciler',
    'reconcilePresenceTasks',
  ]) {
    assert.equal(typeof mod[name], 'function', `${what}: ${name} must be live (not a stub)`);
  }
  // Live end-to-end through the installed file: witness then absence.
  const now = Date.now();
  const tasks = new Map([
    ['only', { agent: 'gentle-ai-worker', label: 'only', status: 'running', at: now - 5000 }],
  ]);
  const reconciler = mod.createPresenceReconciler();
  const witnessed = {
    sessionHash: 's',
    incarnation: 'i',
    generation: 1,
    heartbeat: now,
    tasks: [{ id: 'only', agent: 'gentle-ai-worker', label: 'only', status: 'running' }],
  };
  assert.deepEqual(mod.reconcilePresenceTasks(tasks, reconciler, witnessed, now).applied, []);
  const gone = { ...witnessed, generation: 2, tasks: [] };
  const { applied } = mod.reconcilePresenceTasks(tasks, reconciler, gone, now);
  assert.equal(applied.length, 1, `${what}: witnessed absence must complete`);
  assert.equal(tasks.get('only').status, 'completed');
  // And the factory itself must start a session without throwing.
  const h = harness();
  mod.default(h.pi);
  h.fire(
    'session_start',
    {},
    {
      mode: 'tui',
      sessionManager: {
        getSessionId: () => 'sess-installed',
        getSessionFile: () => {
          throw new Error('no session file in tests');
        },
        getEntries: () => [],
      },
      isIdle: () => false,
    },
  );
}

test('installed copy loads self-contained with live reconciliation', async () => {
  const installedDir = makeInstalledDir();
  const statePath = path.join(installedDir, 'gentle-herdr-state.ts');
  fs.copyFileSync(src, statePath);
  assertLiveHelpers(await loadInstalled(statePath), 'installed copy');
});

test('installed symlink loads self-contained with live reconciliation', async () => {
  // ESM realpaths symlinks for bare-package lookup, so an in-process
  // symlink import would resolve the Pi package from the repo tree instead
  // of the simulated installed dir. A child with --preserve-symlinks keeps
  // lookup rooted at the installed dir, exactly like Pi opening the
  // deployed symlink.
  const { execFile } = require('node:child_process');
  const installedDir = makeInstalledDir();
  fs.symlinkSync(src, path.join(installedDir, 'gentle-herdr-state.ts'));
  const script = path.join(installedDir, 'check.mjs');
  fs.writeFileSync(
    script,
    [
      "import * as mod from './gentle-herdr-state.ts';",
      "if (typeof mod.default !== 'function') throw new Error('no default factory');",
      "for (const name of ['resolvePresenceProfile', 'readPresenceSnapshot', 'createPresenceReconciler', 'reconcilePresenceTasks']) {",
      "  if (typeof mod[name] !== 'function') throw new Error('stub: ' + name);",
      '}',
      'const now = Date.now();',
      "const tasks = new Map([['only', { agent: 'a', label: 'only', status: 'running', at: now - 5000 }]]);",
      'const r = mod.createPresenceReconciler();',
      "mod.reconcilePresenceTasks(tasks, r, { sessionHash: 's', incarnation: 'i', generation: 1, heartbeat: now, tasks: [{ id: 'only', agent: 'a', label: 'only', status: 'running' }] }, now);",
      "const { applied } = mod.reconcilePresenceTasks(tasks, r, { sessionHash: 's', incarnation: 'i', generation: 2, heartbeat: now, tasks: [] }, now);",
      "if (applied.length !== 1 || tasks.get('only').status !== 'completed') throw new Error('reconcile dead');",
      "console.log('installed-symlink-ok');",
      '',
    ].join('\n'),
  );
  await new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      ['--preserve-symlinks', script],
      { cwd: installedDir, timeout: 30000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`installed symlink load failed: ${stderr || err.message}`));
        else if (!String(stdout).includes('installed-symlink-ok')) {
          reject(new Error('installed symlink check printed no ok marker'));
        } else resolvePromise();
      },
    );
  });
});

test('progress observation does not strand the delegate: absence still resolves', async () => {
  const { sockPath, received, waitForFrom, close } = await startWireServer();
  const { factory, prevEnv } = await loadWireFactory(sockPath, 'test-pane-progress');
  const agentHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-wire-home-'));
  const presenceRoot = wirePresenceRoot(agentHome);
  const prevProfile = process.env.GENTLE_PI_AGENT_HOME;
  process.env.GENTLE_PI_AGENT_HOME = agentHome;
  try {
    const h = harness();
    factory(h.pi);
    const sessionId = 'sess-wire-progress';
    const sessionFile = '/tmp/gentle-wire-progress-session';
    h.fire(
      'session_start',
      {},
      {
        mode: 'tui',
        sessionManager: {
          getSessionId: () => sessionId,
          getSessionFile: () => sessionFile,
          getEntries: () => [],
        },
        isIdle: () => false,
      },
    );
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'run-p1',
      input: { agent: 'gentle-ai-worker', label: 'progress work' },
    });
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'run-p1',
      details: { gentleAgents: { taskId: 'p1', agent: 'gentle-ai-worker', status: 'running' } },
    });
    const { createHash } = require('node:crypto');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    writeWireSnapshot(presenceRoot, {
      sessionId,
      generation: 1,
      heartbeat: Date.now(),
      tasks: [{ id: 'p1', status: 'running' }],
    });
    h.fire('agent_start', {});
    await waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'work count 1 while the delegate runs',
    );
    // A same-status progress read (status poll, still running) bumps recency
    // but starts no new execution: the presence witness must survive it.
    h.fire('tool_result', {
      toolName: 'subagent_status',
      toolCallId: 'status-p1',
      details: { gentleAgents: { taskId: 'p1', agent: 'gentle-ai-worker', status: 'running' } },
    });
    // Upstream settles the delegate while the chat result stays deferred.
    writeWireSnapshot(presenceRoot, {
      sessionId,
      generation: 2,
      heartbeat: Date.now(),
      tasks: [],
    });
    const before = received.length;
    h.fire('agent_start', {});
    const cleared = await waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:0:`),
      5000,
      'work count 0 after witnessed absence past a progress read',
    );
    assert.equal(cleared.gentle_roles_v1, null, 'progress must not strand the role');
    assert.equal(
      typeof cleared.gentle_orchestrating_v1,
      'string',
      'principal active retains the orchestrating marker',
    );
  } finally {
    if (prevProfile === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
    else process.env.GENTLE_PI_AGENT_HOME = prevProfile;
    process.env.HERDR_ENV = prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = prevEnv.HERDR_PANE_ID;
    await close();
  }
});

// --- T2 ask/review observation -------------------------------------------
// The native questionnaire emits `gentle-pi:ask-user-question:blocked`
// independently of the choice leg and the rpiv legacy leg (upstream
// gentle-ai.ts keeps three independent flags): closing one leg must never
// erase another still-open leg, and all three share one intent episode.
// The review sidebar publishes session-bound observational snapshots on
// `gentle-ai:review-sidebar`, but entry publishes fire before the forecast
// branch, so no snapshot proves execution: the producer observes none of
// them. Real execution tracks call ids via tool_execution_start/end plus
// tool_result; `assess` never lights review.

test('native questionnaire leg holds ask independently of choice and legacy', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fireEvent('gentle-pi:ask-user-question:blocked', { active: true });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  const intent = labels[0].label;
  assert.match(intent, /^ask:/);
  h.fireEvent('gentle-pi:ask-user-choice:blocked', { active: true });
  assert.equal(blockedLabels(h).length, 1);
  h.fireEvent('gentle-pi:ask-user-choice:blocked', { active: false });
  assert.equal(blockedLabels(h).length, 1, 'choice close must not erase the questionnaire leg');
  h.fireEvent('rpiv:ask-user:blocked', { active: true });
  assert.equal(blockedLabels(h).length, 1);
  h.fireEvent('rpiv:ask-user:blocked', { active: false });
  assert.equal(blockedLabels(h).length, 1, 'legacy close must not erase the native leg');
  assert.equal(blockedLabels(h)[0].label, intent, 'one intent episode across all three legs');
  h.fireEvent('gentle-pi:ask-user-question:blocked', { active: false });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
});

test('choice leg survives a native questionnaire close', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fireEvent('gentle-pi:ask-user-choice:blocked', { active: true });
  const intent = blockedLabels(h)[0].label;
  h.fireEvent('gentle-pi:ask-user-question:blocked', { active: true });
  assert.equal(blockedLabels(h).length, 1);
  h.fireEvent('gentle-pi:ask-user-question:blocked', { active: false });
  assert.equal(blockedLabels(h).length, 1, 'questionnaire close must not erase the choice leg');
  assert.equal(blockedLabels(h)[0].label, intent);
  h.fireEvent('gentle-pi:ask-user-choice:blocked', { active: false });
  assert.deepEqual(blockedLabels(h)[1], { active: false });
});

test('stray sidebar snapshots never hold review; terminal clears the hint', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  // A stray call-start hint with no executing capture holds nothing.
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'reviewing', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 0, 'stray reviewing must not stick review');
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'closed', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 0, 'terminal clears the hint with no label churn');
});

test('lifecycle snapshots never imply execution', async () => {
  const { default: factory } = await factoryPromise;
  for (const state of ['in_review', 'approved', 'correction', 'consent', 'forecast']) {
    const h = harness();
    factory(h.pi);
    startRootSession(h, 'sess-1');
    h.fireEvent('gentle-ai:review-sidebar', {
      sessionId: 'sess-1',
      snapshot: { state, scope: 'plan.md' },
    });
    assert.equal(blockedLabels(h).length, 0, `${state} must not light review alone`);
  }
});

test('sidebar snapshots validate session ownership and shape', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'other',
    snapshot: { state: 'reviewing', scope: 'plan.md' },
  });
  h.fireEvent('gentle-ai:review-sidebar', { sessionId: 'sess-1' });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'nope', scope: 'plan.md' },
  });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'reviewing', scope: '' },
  });
  assert.equal(blockedLabels(h).length, 0);
  startRootSession(h, 'sess-2');
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'reviewing', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 0, 'stale previous session must stay ignored');
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-2',
    snapshot: { state: 'checking', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 0, 'checking never holds review, even for the own session');
});

test('terminal sidebar snapshot never clears an unrelated in-flight call', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  const ackedUnrelated = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: ackedUnrelated });
  assert.match(blockedLabels(h)[0].label, /^review:/);
  for (const state of ['closed', 'declined', 'unknown', 'consent', 'forecast', 'in_review']) {
    h.fireEvent('gentle-ai:review-sidebar', {
      sessionId: 'sess-1',
      snapshot: { state, scope: 'plan.md' },
    });
  }
  assert.equal(blockedLabels(h).length, 1, 'no terminal snapshot clears a tracked call');
  h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
  assert.deepEqual(blockedLabels(h)[1], { active: false });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'consent', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 2, 'result after close leaves no review behind');
});

test('assess never lights review on any execution seam', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_call', {
    toolName: 'gentle_review',
    toolCallId: 'a1',
    input: { operation: 'assess' },
  });
  h.fire('tool_execution_start', { toolCallId: 'a1', toolName: 'gentle_review', args: { operation: 'assess' } });
  h.fire('tool_execution_end', { toolCallId: 'a1', toolName: 'gentle_review' });
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 'a1' });
  assert.equal(blockedLabels(h).length, 0, 'assess must stay out of the review leg');
});

test('tool_execution_end clears a review call missing its tool_result', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_execution_start', {
    toolCallId: 'c9',
    toolName: 'gentle_review_capture',
    args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true },
  });
  assert.match(blockedLabels(h)[0].label, /^review:/);
  h.fire('tool_execution_end', {
    toolCallId: 'c9',
    toolName: 'gentle_review_capture',
    isError: true,
  });
  const labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
});

test('shutdown clears executing review', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  h.fire('tool_execution_start', {
    toolCallId: 'c1',
    toolName: 'gentle_review_capture',
    args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true },
  });
  assert.equal(blockedLabels(h).length, 1);
  h.fire('session_shutdown', {});
  assert.deepEqual(blockedLabels(h)[1], { active: false });
});

test('dual-seam normal flow stays one episode; start never routes to ask', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  const ackedDual = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
  // Production order tool_call → execution_start for the same id: proposal
  // stays silent, execution opens exactly one label.
  h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c2', input: ackedDual });
  assert.equal(blockedLabels(h).length, 0, 'proposal must not open review');
  h.fire('tool_execution_start', { toolCallId: 'c2', toolName: 'gentle_review_capture', args: ackedDual });
  assert.equal(blockedLabels(h).length, 1);
  h.fire('tool_execution_end', { toolCallId: 'c2', toolName: 'gentle_review_capture' });
  assert.deepEqual(blockedLabels(h)[1], { active: false });
  // A start seen via execution start alone still never holds ask.
  h.fire('tool_execution_start', {
    toolCallId: 's9',
    toolName: 'gentle_review',
    args: { operation: 'start', input: { mode: 'ordinary' } },
  });
  assert.equal(blockedLabels(h).length, 2, 'start must never route to ask');
  h.fire('tool_execution_end', { toolCallId: 's9', toolName: 'gentle_review' });
  assert.equal(blockedLabels(h).length, 2);
});

// --- T2 context-reset regressions ----------------------------------------
// Actual upstream order: execution_start -> tool_call -> sidebar
// checking/reviewing inside execute, completion BEFORE tool_result/end. The
// producer observes none of the sidebar signals: only the acknowledged
// execution's own end seams release review — never left indefinite, never
// clearing an unrelated tracked call's true execution. session_tree and
// same-session re-announcements carry no review state and are no-ops.

test('sidebar noise and tree reset never disturb acked execution release', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  // Acknowledged execution holds review; sidebar noise is fully inert.
  h.fire('tool_execution_start', {
    toolCallId: 'c1',
    toolName: 'gentle_review_capture',
    args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true },
  });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'reviewing', scope: 'plan.md' },
  });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'forecast', scope: 'plan.md' },
  });
  assert.match(blockedLabels(h)[0].label, /^review:/);
  assert.equal(blockedLabels(h).length, 1, 'sidebar noise must not churn the episode');
  // Same-session tree rebuild carries no review state: still holding.
  h.fire('session_tree', {});
  assert.equal(blockedLabels(h).length, 1, 'reset alone must not clear true execution');
  // The span ends with no tool_result: review must drop on the end seam.
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
  const labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
});

test('same-id session_start never disturbs execution state', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  // No observer hint exists anymore: stray sidebar signals stay dark.
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: {} });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'reviewing', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 0);
  startRootSession(h, 'sess-1');
  assert.equal(blockedLabels(h).length, 0, 'same-session re-announcement is a no-op for review');
  // Acknowledged execution survives the same reset untouched.
  h.fire('tool_execution_start', {
    toolCallId: 'c2',
    toolName: 'gentle_review_capture',
    args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true },
  });
  assert.match(blockedLabels(h)[0].label, /^review:/);
  startRootSession(h, 'sess-1');
  assert.equal(blockedLabels(h).length, 1, 'true execution survives the re-announcement');
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
  h.fire('tool_execution_end', { toolCallId: 'c2', toolName: 'gentle_review_capture' });
  assert.deepEqual(blockedLabels(h)[1], { active: false });
});

test('one ending call keeps the remaining overlap review', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  const ackedOverlapA = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
  const ackedOverlapB = { lineageId: 'lin-1', collectBindings: ['{}'], reviewerRunAcknowledged: true };
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: ackedOverlapA });
  h.fire('tool_execution_start', { toolCallId: 'c2', toolName: 'gentle_review_capture_group', args: ackedOverlapB });
  const review = blockedLabels(h)[0].label;
  assert.match(review, /^review:/);
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'checking', scope: 'plan.md' },
  });
  h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
  assert.equal(blockedLabels(h).length, 1, 'ending one span must not clear the other');
  assert.equal(blockedLabels(h)[0].label, review);
  h.fire('tool_result', { toolName: 'gentle_review_capture_group', toolCallId: 'c2' });
  assert.deepEqual(blockedLabels(h)[1], { active: false });
});

test('abort after reset leaves no review behind', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  h.fire('tool_execution_start', {
    toolCallId: 'c1',
    toolName: 'gentle_review_capture',
    args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true },
  });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'reviewing', scope: 'plan.md' },
  });
  assert.match(blockedLabels(h)[0].label, /^review:/);
  h.fire('session_tree', {});
  // Abort: end seam with no tool_result and suppressed completion.
  h.fire('tool_execution_end', {
    toolCallId: 'c1',
    toolName: 'gentle_review_capture',
    isError: true,
  });
  const labels = blockedLabels(h);
  assert.equal(labels.length, 2, 'aborted span after reset must fully clear');
  assert.deepEqual(labels[1], { active: false });
});

test('start resolution after reset leaves neither ask nor review', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  // Starts never speculate ask, even across a publisher reset.
  h.fire('tool_call', {
    toolName: 'gentle_review',
    toolCallId: 's1',
    input: { operation: 'start', input: { mode: 'ordinary' } },
  });
  h.fire('tool_execution_start', {
    toolCallId: 's1',
    toolName: 'gentle_review',
    args: { operation: 'start', input: { mode: 'ordinary' } },
  });
  assert.equal(blockedLabels(h).length, 0);
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'checking', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 0, 'checking never lights review');
  h.fire('session_tree', {});
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 's1' });
  h.fire('tool_execution_end', { toolCallId: 's1', toolName: 'gentle_review' });
  assert.equal(blockedLabels(h).length, 0, 'start end after reset leaves nothing behind');
});

// --- T2b judge mapping, oldest-first order, running-only count ----------
// Producer wire: jd-judge-a/jd-judge-b/jd-fix-agent map to a distinct
// `judge` slug (never rdd); roles CSV is oldest-first by immutable
// first-seen (progress reads never reorder); gentle_work_v1 counts actual
// running agents only (queued/waiting/pending never count); pending
// launches stay role-only hints with no double count.

async function startT2bWire(t2bPaneId) {
  const { sockPath, received, waitForFrom, close } = await startWireServer();
  const { factory, prevEnv } = await loadWireFactory(sockPath, t2bPaneId);
  return { sockPath, received, waitForFrom, close, factory, prevEnv };
}

function t2bSessionFile(paneId) {
  return `/tmp/gentle-t2b-${paneId}-session`;
}

function startT2bSession(h, sessionId, sessionFile) {
  h.fire(
    'session_start',
    {},
    {
      mode: 'tui',
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
        getEntries: () => [],
      },
      isIdle: () => false,
    },
  );
}

function launchRunning(h, callId, taskId, agent) {
  h.fire('tool_call', { toolName: 'subagent_run', toolCallId: callId, input: { agent, label: `${taskId} work` } });
  h.fire('tool_result', {
    toolName: 'subagent_run',
    toolCallId: callId,
    details: { gentleAgents: { taskId, agent, status: 'running' } },
  });
}

test('T2b RED: judge agents map distinctly; oldest-first; progress never reorders', async () => {
  const wire = await startT2bWire('test-pane-t2b-judge');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('judge');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-t2b-judge', sessionFile);
    launchRunning(h, 'run-j1', 'j1', 'jd-judge-a');
    launchRunning(h, 'run-j2', 'j2', 'jd-fix-agent');
    launchRunning(h, 'run-w1', 'w1', 'gentle-ai-worker');
    const twoPlus = await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:3:`),
      5000,
      'three running delegates counted',
    );
    assert.equal(twoPlus.gentle_roles_v1, 'judge,worker', 'oldest-first: judge oldest, worker last');
    // Same-status progress on the oldest must not reorder.
    h.fire('tool_result', {
      toolName: 'subagent_status',
      toolCallId: 'status-j1',
      details: { gentleAgents: { taskId: 'j1', agent: 'jd-judge-a', status: 'running' } },
    });
    await new Promise((r) => setTimeout(r, 350));
    const before = wire.received.length;
    h.fire('agent_start', {});
    const stable = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:3:`),
      5000,
      'count stable past a progress read',
    );
    assert.equal(stable.gentle_roles_v1, 'judge,worker', 'progress must not reorder oldest-first');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('T2b RED: queued/waiting/pending never count; mixed completion drops suffix', async () => {
  const wire = await startT2bWire('test-pane-t2b-count');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('count');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-t2b-count', sessionFile);
    launchRunning(h, 'run-e1', 'e1', 'gentle-ai-explore');
    launchRunning(h, 'run-e2', 'e2', 'gentle-ai-explore');
    launchRunning(h, 'run-e3', 'e3', 'gentle-ai-explore');
    const three = await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:3:`),
      5000,
      'three explorers counted',
    );
    assert.equal(three.gentle_roles_v1, 'explorer');
    // Queued + waiting + pending hint must not inflate the running total.
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'run-q1',
      details: { gentleAgents: { taskId: 'q1', agent: 'gentle-ai-worker', status: 'queued' } },
    });
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'run-wait1',
      details: { gentleAgents: { taskId: 'wait1', agent: 'gentle-ai-worker', status: 'waiting' } },
    });
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'pending-1',
      input: { agent: 'gentle-ai-worker', label: 'pending work' },
    });
    await new Promise((r) => setTimeout(r, 350));
    const before = wire.received.length;
    h.fire('agent_start', {});
    const uninflated = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:3:`),
      5000,
      'queued/waiting/pending never inflate the running count',
    );
    assert.equal(uninflated.gentle_roles_v1, 'explorer,worker', 'pending hint merges role-only without double count');
    // Complete two explorers via background results; one explorer left: count 1, role only.
    h.fire('message_end', {
      message: {
        role: 'custom',
        customType: 'gentle-agents.result',
        details: { gentleAgents: { taskId: 'e1', agent: 'gentle-ai-explore', status: 'completed' } },
      },
    });
    h.fire('message_end', {
      message: {
        role: 'custom',
        customType: 'gentle-agents.result',
        details: { gentleAgents: { taskId: 'e2', agent: 'gentle-ai-explore', status: 'completed' } },
      },
    });
    // Cancel the queued worker and finish the pending hint via a failed launch result.
    h.fire('tool_call', { toolName: 'subagent_cancel', toolCallId: 'cancel-1', input: { task_id: 'q1' } });
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'pending-1', isError: true });
    const beforeSingle = wire.received.length;
    h.fire('agent_start', {});
    const single = await wire.waitForFrom(
      beforeSingle,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'single survivor counted once',
    );
    assert.equal(single.gentle_roles_v1, 'explorer', 'one explorer left, no suffix at the producer (consumer renders bare)');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('T2b RED: session reset clears prior running roles (no stale counts)', async () => {
  const wire = await startT2bWire('test-pane-t2b-reset');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('reset');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-t2b-a', sessionFile);
    launchRunning(h, 'run-a1', 'a1', 'gentle-ai-worker');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'first session counted',
    );
    startT2bSession(h, 'sess-t2b-b', sessionFile);
    const before = wire.received.length;
    h.fire('agent_start', {});
    const cleared = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:0:`),
      5000,
      'new session starts at zero with no stale roles',
    );
    assert.equal(cleared.gentle_roles_v1, null);
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

// --- T2b sound presence firstSeen refinement --------------------------------
// Uses the already-imported stubbed module's named exports directly: a
// sound earlier same-binding createdAt corrects a late local firstSeen
// (backfills tasks that lack one); future or later timestamps never move
// it, and epochs/witness state are untouched (T1 preserved).
test('sound presence createdAt refines firstSeen; unsound timestamps never move it', async () => {
  const mod = await factoryPromise;
  const now = Date.now();
  const tasks = new Map([
    ['a', { agent: 'gentle-ai-worker', label: 'a', status: 'running', at: now - 1000, firstSeen: now - 1000, epoch: 0 }],
    ['b', { agent: 'gentle-ai-explore', label: 'b', status: 'running', at: now - 900, firstSeen: now - 900, epoch: 0 }],
    ['c', { agent: 'gentle-ai-verify', label: 'c', status: 'running', at: now - 800, epoch: 0 }],
  ]);
  const reconciler = mod.createPresenceReconciler();
  const snap1 = {
    sessionHash: 's',
    incarnation: 'i',
    generation: 1,
    heartbeat: now,
    tasks: [
      { id: 'a', agent: 'gentle-ai-worker', label: 'a', status: 'running', createdAt: now - 5000, startedAt: now - 5000 },
      { id: 'b', agent: 'gentle-ai-explore', label: 'b', status: 'running', createdAt: now - 4000, startedAt: now - 4000 },
      { id: 'c', agent: 'gentle-ai-verify', label: 'c', status: 'running', createdAt: now - 6000, startedAt: now - 6000 },
    ],
  };
  mod.reconcilePresenceTasks(tasks, reconciler, snap1, now);
  assert.equal(tasks.get('a').firstSeen, now - 5000, 'earlier sound timestamp corrects late sighting');
  assert.equal(tasks.get('b').firstSeen, now - 4000);
  assert.equal(tasks.get('c').firstSeen, now - 6000, 'missing firstSeen backfilled');
  const snap2 = {
    sessionHash: 's',
    incarnation: 'i',
    generation: 2,
    heartbeat: now,
    tasks: [
      { id: 'a', agent: 'gentle-ai-worker', label: 'a', status: 'running', createdAt: now + 999999, startedAt: now + 999999 },
      { id: 'b', agent: 'gentle-ai-explore', label: 'b', status: 'running', createdAt: now - 100, startedAt: now - 100 },
      { id: 'c', agent: 'gentle-ai-verify', label: 'c', status: 'running', createdAt: now - 6000, startedAt: now - 6000 },
    ],
  };
  const { applied } = mod.reconcilePresenceTasks(tasks, reconciler, snap2, now);
  assert.deepEqual(applied, [], 'active listings apply nothing');
  assert.equal(tasks.get('a').firstSeen, now - 5000, 'future timestamp unsound, ignored');
  assert.equal(tasks.get('b').firstSeen, now - 4000, 'later timestamp never moves firstSeen');
  assert.equal(tasks.get('c').firstSeen, now - 6000);
  for (const id of ['a', 'b', 'c']) assert.equal(tasks.get(id).epoch, 0, 'epochs untouched');
});

// --- T1 native-owner: permission waiting vs independent close ----------------
// A permission `waiting` request holds ask on its own leg; approving or
// denying that request clears only its leg (the questionnaire leg still
// holds ask); all legs closed clears to idle. Matches upstream
// emitPermissionRequest(requestId, waiting|approved|denied) exactly.
test('permission waiting holds ask; resolve clears only its leg', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fireEvent('pi-permission-system:permission-request', { requestId: 'p1', state: 'waiting' });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.match(labels[0].label, /^ask:/);
  const intent = labels[0].label;
  h.fireEvent('pi-permission-system:permission-request', { requestId: 'p1', state: 'waiting' });
  assert.equal(blockedLabels(h).length, 1, 'duplicate waiting must not re-emit');
  h.fireEvent('rpiv:ask-user:blocked', { active: true });
  assert.equal(blockedLabels(h).length, 1, 'second leg joins the same intent episode');
  h.fireEvent('pi-permission-system:permission-request', { requestId: 'p1', state: 'approved' });
  assert.equal(blockedLabels(h).length, 1, 'resolving one leg must not clear the other');
  h.fireEvent('pi-permission-system:permission-request', { requestId: 'p1', state: 'denied' });
  assert.equal(blockedLabels(h).length, 1, 'unknown request id resolves nothing');
  h.fireEvent('rpiv:ask-user:blocked', { active: false });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
  assert.equal(labels[0].label, intent, 'one intent across the whole episode');
});

// --- T1 native-owner: principal settle never clears running delegates ------
// The principal Pi session may go idle while background delegates run;
// that is NOT terminal: role, count, and marker survive the settle beat,
// and only settle+zero-count (no delegates, no pending) may read done.
test('T1: principal settle preserves running delegate role, count, and marker', async () => {
  const wire = await startT2bWire('test-pane-t1-settle');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('settle');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-t1-settle', sessionFile);
    launchRunning(h, 'run-s1', 's1', 'gentle-ai-worker');
    launchRunning(h, 'run-s2', 's2', 'jd-judge-a');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:2:`),
      5000,
      'two running delegates counted',
    );
    // Principal goes idle with both delegates running: not terminal.
    // No agent_start follows: the next beat must still carry the delegates
    // on the settled principal alone.
    h.fire('agent_settled', {}, { isIdle: () => true });
    const before = wire.received.length;
    const survived = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:2:`),
      5000,
      'settle preserves the running count',
    );
    assert.equal(survived.gentle_roles_v1, 'worker,judge', 'oldest-first roles survive settle');
    assert.equal(
      typeof survived.gentle_orchestrating_v1,
      'string',
      'delegate marker survives principal settle',
    );
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('T1: queued delegate after settle emits count0 with a fresh marker (never false done)', async () => {
  const wire = await startT2bWire('test-pane-t1-queued');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('queued');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-t1-queued', sessionFile);
    launchRunning(h, 'run-q1', 'q1', 'gentle-ai-worker');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'running delegate counted',
    );
    // Delegate drains to queued (still active cover, running-only count 0).
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'run-q1b',
      details: { gentleAgents: { taskId: 'q1', agent: 'gentle-ai-worker', status: 'queued' } },
    });
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:0:`),
      5000,
      'queued delegate drops the running count',
    );
    h.fire('agent_settled', {}, { isIdle: () => true });
    const before = wire.received.length;
    const settled = await wire.waitForFrom(
      before,
      (p) =>
        typeof p.gentle_work_v1 === 'string' &&
        p.gentle_work_v1.startsWith(`${paneHash}:0:`) &&
        typeof p.gentle_orchestrating_v1 === 'string',
      5000,
      'count0 with a fresh marker after settle (queued cover, vetoes done)',
    );
    assert.equal(settled.gentle_roles_v1, null, 'queued supplies no running role');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

// --- T2 native owner: always-on single publisher (no opt-in flag) --------
// The extension ALWAYS owns pane.report_agent (working|blocked|idle); the
// native managed file is deleted and the user controls installs, so no
// flag gates publishing. Single-writer native transport reuses the session
// path-or-id binding with monotonic seq and a serial latest-wins coalesced
// queue. Never done/finished, never notify.

async function startNativeWire() {
  const net = require('node:net');
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-native-')), 'herdr.sock');
  const received = [];
  const conns = new Set();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    let buf = '';
    conn.on('data', (chunk) => {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        if (req && typeof req.method === 'string') received.push(req);
        try {
          conn.write(`${JSON.stringify({ id: req && req.id, result: true })}\n`);
        } catch {}
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  const waitFor = async (pred, timeoutMs, what) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = received.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`timed out waiting for ${what}; saw ${received.length} requests`);
  };
  const close = async () => {
    for (const conn of conns) {
      try {
        conn.destroy();
      } catch {}
    }
    await new Promise((r) => server.close(r));
  };
  return { sockPath, received, waitFor, close };
}

async function loadNativeFactory(sockPath, paneId, _ownerValueIgnored) {
  // Always-on single publisher: the GENTLE_HERDR_NATIVE_OWNER opt-in flag is
  // removed, so the env gate is never set here regardless of the legacy
  // third argument (kept only to avoid touching every call site).
  const prevEnv = {
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    GENTLE_HERDR_NATIVE_OWNER: process.env.GENTLE_HERDR_NATIVE_OWNER,
  };
  process.env.HERDR_ENV = '1';
  process.env.HERDR_SOCKET_PATH = sockPath;
  process.env.HERDR_PANE_ID = paneId;
  delete process.env.GENTLE_HERDR_NATIVE_OWNER;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-native-mod-'));
  const modCopy = path.join(dir, 'gentle-herdr-state-native.mjs');
  fs.writeFileSync(modCopy, stubbed);
  try {
    const { default: factory, ...named } = await import(pathToFileURL(modCopy).href);
    return { factory, named, prevEnv };
  } catch (error) {
    Object.assign(process.env, prevEnv);
    throw error;
  }
}

function restoreNativeEnv(prevEnv) {
  for (const key of ['HERDR_ENV', 'HERDR_SOCKET_PATH', 'HERDR_PANE_ID', 'GENTLE_HERDR_NATIVE_OWNER']) {
    if (prevEnv[key] === undefined) delete process.env[key];
    else process.env[key] = prevEnv[key];
  }
}

function nativeStates(received) {
  return received.filter((r) => r.method === 'pane.report_agent').map((r) => r.params);
}

test('T2: default path always publishes native states (no opt-in flag)', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-default-off', undefined);
  try {
    const h = harness();
    factory(h.pi);
    const sessionFile = '/tmp/gentle-native-default-session';
    h.fire('session_start', {}, {
      mode: 'tui',
      sessionManager: { getSessionId: () => 'sess-native-off', getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => false,
    });
    launchRunning(h, 'run-off1', 'off1', 'gentle-ai-worker');
    const first = await wire.waitFor((r) => r.method === 'pane.report_agent' && r.params.state === 'working', 5000, 'native working without any flag');
    assert.equal(first.params.pane_id, 'pane-default-off');
    assert.equal(first.params.agent_session_path, sessionFile, 'native reuses the session-path binding');
    assert.equal(first.params.seq, 1, 'first native seq is 1');
    const metas = await wire.waitFor((r) => r.method === 'pane.report_metadata', 5000, 'metadata beats alongside native states');
    assert.ok(metas, 'metadata beats still flow alongside native states');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('T2: native owner has no opt-in flag; principal-gated states hold', async () => {
  const mod = await factoryPromise;
  assert.equal(typeof mod.computeNativeState, 'function', 'computeNativeState must be exported');
  assert.equal(mod.isNativeOwnerEnabled, undefined, 'isNativeOwnerEnabled gate must be removed');
  const base = { agentActive: false, settled: true, activeCount: 0, pendingCount: 0, askActive: false, reviewActive: false, hasError: false };
  assert.equal(mod.computeNativeState({ ...base, hasError: true }), 'blocked');
  assert.equal(mod.computeNativeState({ ...base, hasError: true, reviewActive: true }), 'blocked');
  assert.equal(mod.computeNativeState({ ...base, agentActive: true, settled: false }), 'working');
  assert.equal(mod.computeNativeState({ ...base, activeCount: 2 }), 'working', 'running/queued delegates keep working');
  assert.equal(mod.computeNativeState({ ...base, pendingCount: 1 }), 'working', 'pending launches keep working');
  assert.equal(mod.computeNativeState({ ...base, askActive: true }), 'blocked', 'human-wait intervention emits blocked, never idle');
  assert.equal(mod.computeNativeState({ ...base, reviewActive: true }), 'working', 'review execution keeps working, never blocked/idle');
  assert.equal(mod.computeNativeState(base), 'idle', 'true empty settle is the only idle');
  assert.equal(mod.computeNativeState({ ...base, settled: false }), undefined, 'count0 alone without settle never idles');
});

test('T2: opt-in settle with delegates stays working with seq + path binding', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-native-working', '1');
  try {
    const h = harness();
    factory(h.pi);
    const sessionFile = '/tmp/gentle-native-working-session';
    h.fire('session_start', {}, {
      mode: 'tui',
      sessionManager: { getSessionId: () => 'sess-native-w', getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => false,
    });
    launchRunning(h, 'run-nw1', 'nw1', 'gentle-ai-worker');
    const first = await wire.waitFor((r) => r.method === 'pane.report_agent' && r.params.state === 'working', 5000, 'native working');
    assert.equal(first.params.pane_id, 'pane-native-working');
    assert.equal(first.params.agent_session_path, sessionFile, 'native reuses the session-path binding');
    assert.equal(first.params.seq, 1, 'first native seq is 1');
    h.fire('agent_settled', {}, { isIdle: () => true });
    await new Promise((r) => setTimeout(r, 600));
    const states = nativeStates(wire.received);
    assert.ok(states.length >= 1, 'working observed');
    assert.ok(states.every((p) => p.state === 'working'), 'settle with a running delegate must never emit idle');
    const seqs = states.map((p) => p.seq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'seq stays monotonic');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('T2: true empty settle emits idle once with monotonic seq', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-native-idle', '1');
  try {
    const h = harness();
    factory(h.pi);
    const sessionFile = '/tmp/gentle-native-idle-session';
    h.fire('session_start', {}, {
      mode: 'tui',
      sessionManager: { getSessionId: () => 'sess-native-i', getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => false,
    });
    await wire.waitFor((r) => r.method === 'pane.report_agent' && r.params.state === 'working', 5000, 'initial working');
    const before = nativeStates(wire.received).length;
    h.fire('agent_settled', {}, { isIdle: () => true });
    const idle = await wire.waitFor((r) => r.method === 'pane.report_agent' && r.params.state === 'idle', 5000, 'native idle on true empty settle');
    assert.ok(idle.params.seq > before, 'idle seq advances monotonically');
    const idles = nativeStates(wire.received).filter((p) => p.state === 'idle');
    assert.equal(idles.length, 1, 'idle emits exactly once');
    h.fire('agent_settled', {}, { isIdle: () => true });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(nativeStates(wire.received).filter((p) => p.state === 'idle').length, 1, 'repeated settle must not re-emit idle');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('T2: error emits blocked once; review execution never blocks; no finished toast', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-native-blocked', '1');
  try {
    const h = harness();
    factory(h.pi);
    const sessionFile = '/tmp/gentle-native-blocked-session';
    h.fire('session_start', {}, {
      mode: 'tui',
      sessionManager: { getSessionId: () => 'sess-native-b', getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => false,
    });
    h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true } });
    h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true } });
    await wire.waitFor((r) => r.method === 'pane.report_agent' && r.params.state === 'working', 5000, 'review execution stays working');
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(nativeStates(wire.received).every((p) => p.state === 'working'), 'review must never emit blocked');
    h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
    h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'run-b1', isError: true });
    const blocked = await wire.waitFor((r) => r.method === 'pane.report_agent' && r.params.state === 'blocked', 5000, 'real error emits blocked');
    assert.ok(blocked.params.seq >= 1);
    await new Promise((r) => setTimeout(r, 400));
    const blockedCount = nativeStates(wire.received).filter((p) => p.state === 'blocked').length;
    assert.equal(blockedCount, 1, 'blocked emits once until the next agent_start');
    for (const r of wire.received) {
      assert.ok(!String(r.method).toLowerCase().includes('notif'), 'never emit a notification toast');
      if (r.method === 'pane.report_agent') assert.ok(['working', 'blocked', 'idle'].includes(r.params.state), `native state ${r.params.state} must stay in working|blocked|idle (never done/finished)`);
    }
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('T2: settle with only pending launches stays working (no idle)', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-native-pending', '1');
  try {
    const h = harness();
    factory(h.pi);
    const sessionFile = '/tmp/gentle-native-pending-session';
    h.fire('session_start', {}, {
      mode: 'tui',
      sessionManager: { getSessionId: () => 'sess-native-p', getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => false,
    });
    await wire.waitFor((r) => r.method === 'pane.report_agent' && r.params.state === 'working', 5000, 'initial working');
    // Launch stays in flight: tool_call observed, tool_result not yet back.
    h.fire('tool_call', { toolName: 'subagent_run', toolCallId: 'pend-1', input: { agent: 'gentle-ai-worker', label: 'pending work' } });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(nativeStates(wire.received).every((p) => p.state === 'working'), 'in-flight launch keeps working');
    // Principal settles with ONLY the pending launch outstanding: not terminal.
    h.fire('agent_settled', {}, { isIdle: () => true });
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(nativeStates(wire.received).length >= 1, 'native states observed');
    assert.ok(nativeStates(wire.received).every((p) => p.state === 'working'), 'settle with a pending launch must never emit idle');
    // Launch resolves to a running delegate: still working via the task record.
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'pend-1',
      details: { gentleAgents: { taskId: 'p1', agent: 'gentle-ai-worker', status: 'running' } },
    });
    await new Promise((r) => setTimeout(r, 400));
    assert.ok(nativeStates(wire.received).every((p) => p.state === 'working'), 'resolved launch keeps working while its delegate runs');
    // Delegate completes, principal resumes, then settles truly empty: idle once.
    h.fire('message_end', {
      message: { role: 'custom', customType: 'gentle-agents.result', details: { gentleAgents: { taskId: 'p1', agent: 'gentle-ai-worker', status: 'completed' } } },
    });
    h.fire('agent_start', {});
    await new Promise((r) => setTimeout(r, 400));
    h.fire('agent_settled', {}, { isIdle: () => true });
    await wire.waitFor((r) => r.method === 'pane.report_agent' && r.params.state === 'idle', 5000, 'idle after the pending launch fully resolved');
    assert.equal(nativeStates(wire.received).filter((p) => p.state === 'idle').length, 1, 'idle emits exactly once');
    h.fire('agent_settled', {}, { isIdle: () => true });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(nativeStates(wire.received).filter((p) => p.state === 'idle').length, 1, 'repeated settle must not re-emit idle');
    const seqs = nativeStates(wire.received).map((p) => p.seq);
    assert.deepEqual([...seqs].sort((a, b) => a - b), seqs, 'seq stays monotonic');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

// --- N1 notification parity: specific working message + gated idle + wait-only blocked ---
// RED regressions: working carries the oldest running role in message (never
// bare generic working while a role is known); idle only on true-empty
// settle; blocked only for real error/wait with the label; review stays
// working-silent; working/role transitions never emit notification methods.

function n1NativeSession(h, sessionId, sessionFile) {
  h.fire(
    'session_start',
    {},
    {
      mode: 'tui',
      sessionManager: {
        getSessionId: () => sessionId,
        getSessionFile: () => sessionFile,
        getEntries: () => [],
      },
      isIdle: () => false,
    },
  );
}

function n1Complete(h, taskId, agent) {
  h.fire('message_end', {
    message: {
      role: 'custom',
      customType: 'gentle-agents.result',
      details: { gentleAgents: { taskId, agent, status: 'completed' } },
    },
  });
}

function n1NoNotify(received, what) {
  for (const r of received) {
    assert.ok(!String(r.method).toLowerCase().includes('notif'), `${what}: no notification method (saw ${r.method})`);
    if (r.method === 'pane.report_agent') {
      assert.ok(
        ['working', 'blocked', 'idle'].includes(r.params.state),
        `${what}: native state stays working|blocked|idle (never done/finished)`,
      );
    }
  }
}

test('N1 RED: working rotates the oldest running role through the message', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-n1-roles', '1');
  try {
    const h = harness();
    factory(h.pi);
    n1NativeSession(h, 'sess-n1-roles', '/tmp/gentle-n1-roles-session');
    launchRunning(h, 'run-n1w', 'n1w', 'gentle-ai-worker');
    let seen = await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working' && r.params.message === 'worker',
      5000,
      'working carries worker while it runs oldest',
    );
    assert.equal(seen.params.message, 'worker');
    launchRunning(h, 'run-n1e', 'n1e', 'gentle-ai-explore');
    launchRunning(h, 'run-n1v', 'n1v', 'gentle-ai-verify');
    launchRunning(h, 'run-n1j', 'n1j', 'jd-judge-a');
    launchRunning(h, 'run-n1r', 'n1r', 'gentle-ai-review-helper');
    await new Promise((r) => setTimeout(r, 800));
    let last = nativeStates(wire.received).filter((p) => p.state === 'working').pop();
    assert.equal(last.message, 'worker', 'newer roles never outrank the oldest running role');
    n1Complete(h, 'n1w', 'gentle-ai-worker');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working' && r.params.message === 'explorer',
      5000,
      'worker completion rotates the message to explorer',
    );
    n1Complete(h, 'n1e', 'gentle-ai-explore');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working' && r.params.message === 'verify',
      5000,
      'explorer completion rotates the message to verify',
    );
    n1Complete(h, 'n1v', 'gentle-ai-verify');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working' && r.params.message === 'judge',
      5000,
      'verify completion rotates the message to judge',
    );
    n1Complete(h, 'n1j', 'jd-judge-a');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working' && r.params.message === 'rdd',
      5000,
      'judge completion rotates the message to rdd',
    );
    n1NoNotify(wire.received, 'role rotation');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('N1 RED: principal working alone reports gentle, never bare working with a role known', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-n1-gentle', '1');
  try {
    const h = harness();
    factory(h.pi);
    n1NativeSession(h, 'sess-n1-gentle', '/tmp/gentle-n1-gentle-session');
    const first = await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working',
      5000,
      'principal working alone',
    );
    assert.equal(first.params.message, 'gentle', 'zero-role working carries the gentle marker message');
    n1NoNotify(wire.received, 'gentle working');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('N1 RED: real human-wait emits blocked once with the ask label', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-n1-wait', '1');
  try {
    const h = harness();
    factory(h.pi);
    n1NativeSession(h, 'sess-n1-wait', '/tmp/gentle-n1-wait-session');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working',
      5000,
      'initial working',
    );
    h.fireEvent('rpiv:ask-user:blocked', { active: true });
    const blocked = await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'blocked',
      5000,
      'human-wait emits blocked',
    );
    assert.match(blocked.params.message ?? '', /^ask:/, 'blocked carries the ask intent label');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(nativeStates(wire.received).filter((p) => p.state === 'blocked').length, 1, 'wait blocked emits once');
    h.fireEvent('rpiv:ask-user:blocked', { active: false });
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working',
      5000,
      'wait resolve returns to working',
    );
    n1NoNotify(wire.received, 'wait blocked');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('N1 RED: real error emits blocked once with the error label', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-n1-error', '1');
  try {
    const h = harness();
    factory(h.pi);
    n1NativeSession(h, 'sess-n1-error', '/tmp/gentle-n1-error-session');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working',
      5000,
      'initial working',
    );
    h.fire('tool_result', { toolName: 'subagent_run', toolCallId: 'run-n1e1', isError: true });
    const blocked = await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'blocked',
      5000,
      'real error emits blocked',
    );
    assert.match(blocked.params.message ?? '', /^error:/, 'blocked carries the error label');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(nativeStates(wire.received).filter((p) => p.state === 'blocked').length, 1, 'error blocked emits once');
    n1NoNotify(wire.received, 'error blocked');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('N1 RED: review execution stays working-silent, never blocked', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-n1-review', '1');
  try {
    const h = harness();
    factory(h.pi);
    n1NativeSession(h, 'sess-n1-review', '/tmp/gentle-n1-review-session');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working',
      5000,
      'initial working',
    );
    h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'n1c1', input: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true } });
    h.fire('tool_execution_start', { toolCallId: 'n1c1', toolName: 'gentle_review_capture', args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true } });
    await new Promise((r) => setTimeout(r, 700));
    const states = nativeStates(wire.received);
    assert.ok(states.length >= 1, 'native states observed during review');
    assert.ok(states.every((p) => p.state === 'working'), 'review execution never emits blocked');
    assert.ok(
      states.every((p) => typeof p.message !== 'string' || !p.message.startsWith('review:')),
      'review execution never carries a review label',
    );
    h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'n1c1' });
    h.fire('tool_execution_end', { toolCallId: 'n1c1', toolName: 'gentle_review_capture' });
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(nativeStates(wire.received).every((p) => p.state === 'working'), 'review resolve stays working');
    n1NoNotify(wire.received, 'review execution');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('N1 RED: working transitions emit zero notification calls', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-n1-nonotify', '1');
  try {
    const h = harness();
    factory(h.pi);
    n1NativeSession(h, 'sess-n1-nonotify', '/tmp/gentle-n1-nonotify-session');
    launchRunning(h, 'run-nn1', 'nn1', 'gentle-ai-worker');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working' && r.params.message === 'worker',
      5000,
      'working with a role',
    );
    launchRunning(h, 'run-nn2', 'nn2', 'gentle-ai-explore');
    await new Promise((r) => setTimeout(r, 600));
    n1Complete(h, 'nn1', 'gentle-ai-worker');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working' && r.params.message === 'explorer',
      5000,
      'role switch to explorer',
    );
    n1Complete(h, 'nn2', 'gentle-ai-explore');
    h.fire('agent_start', {});
    await new Promise((r) => setTimeout(r, 600));
    const notifs = wire.received.filter((r) => String(r.method).toLowerCase().includes('notif'));
    assert.equal(notifs.length, 0, 'working/count/role transitions must never call a notification method');
    for (const r of wire.received) {
      if (r.method === 'pane.report_agent') {
        assert.ok(['working', 'blocked', 'idle'].includes(r.params.state), 'state-only, never done/finished');
      }
    }
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('N1 pending-only launch reports gentle, never bare working or a hint', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-n1-pendingmsg', '1');
  try {
    const h = harness();
    factory(h.pi);
    n1NativeSession(h, 'sess-n1-pendingmsg', '/tmp/gentle-n1-pendingmsg-session');
    launchRunning(h, 'run-np1', 'np1', 'gentle-ai-worker');
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working' && r.params.message === 'worker',
      5000,
      'working with a running role',
    );
    const before = Math.max(0, ...nativeStates(wire.received).map((p) => p.seq));
    // A second launch stays in flight (no TaskStore record yet) while the
    // running delegate completes: pending-only activity must read gentle.
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'pend-np2',
      input: { agent: 'gentle-ai-explore', label: 'pending explore' },
    });
    n1Complete(h, 'np1', 'gentle-ai-worker');
    const pend = await wire.waitFor(
      (r) =>
        r.method === 'pane.report_agent' &&
        r.params.state === 'working' &&
        r.params.message === 'gentle' &&
        r.params.seq > before,
      5000,
      'pending-only working carries gentle',
    );
    assert.equal(pend.params.message, 'gentle');
    for (const p of nativeStates(wire.received)) {
      if (p.state === 'working') {
        assert.notEqual(p.message, 'working', 'visible generic activity is never bare working');
      }
    }
    n1NoNotify(wire.received, 'pending-only gentle');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('sanitizeAgentSlug passes unknown names through slug rules with a 32-char bound', async () => {
  const mod = await factoryPromise;
  assert.equal(typeof mod.sanitizeAgentSlug, 'function', 'sanitizeAgentSlug must be exported');
  assert.equal(mod.sanitizeAgentSlug('my-custom-scout'), 'my-custom-scout');
  assert.equal(mod.sanitizeAgentSlug('My_Custom.Scout 2'), 'my_custom-scout-2');
  assert.equal(mod.sanitizeAgentSlug('a'.repeat(40)), 'a'.repeat(32), 'overlong names truncate to 32');
  assert.equal(mod.sanitizeAgentSlug('!!!'), undefined, 'unsalvageable names yield undefined');
  assert.equal(mod.sanitizeAgentSlug(''), undefined);
  assert.equal(mod.sanitizeAgentSlug(undefined), undefined);
});

test('N1 unknown delegation reports its sanitized name, never a generic word', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-n1-unknown', '1');
  try {
    const h = harness();
    factory(h.pi);
    n1NativeSession(h, 'sess-n1-unknown', '/tmp/gentle-n1-unknown-session');
    launchRunning(h, 'run-nu1', 'nu1', 'my-custom-scout');
    const seen = await wire.waitFor(
      (r) =>
        r.method === 'pane.report_agent' &&
        r.params.state === 'working' &&
        r.params.message === 'my-custom-scout',
      5000,
      'unknown delegation carries its sanitized name',
    );
    assert.equal(seen.params.message, 'my-custom-scout');
    // An overlong unknown name truncates to the 32-char slug bound.
    launchRunning(h, 'run-nu2', 'nu2', `${'b'.repeat(40)}-tail`);
    n1Complete(h, 'nu1', 'my-custom-scout');
    const trunc = await wire.waitFor(
      (r) =>
        r.method === 'pane.report_agent' &&
        r.params.state === 'working' &&
        r.params.message === 'b'.repeat(32),
      5000,
      'overlong unknown name truncates to 32 chars',
    );
    assert.equal(trunc.params.message, 'b'.repeat(32));
    n1NoNotify(wire.received, 'unknown passthrough');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

// --- Interleaving: principal activity never erases live delegate evidence ---
// Live report: the user messages the principal while a delegation is
// active; the display flips to gentle and stays stuck on gentle after the
// principal finishes, even though the worker delegation still runs.
// Expected: while the principal works with live delegates the display
// follows oldest-running precedence (delegation role+count survives); when
// the principal finishes and delegates remain active the display reverts to
// the delegation role+count.

test('INTERLEAVE RED: principal start with a running worker keeps worker role+count', async () => {
  const wire = await startT2bWire('test-pane-interleave-1');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('interleave-1');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-interleave-1', sessionFile);
    launchRunning(h, 'run-i1', 'i1', 'gentle-ai-worker');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'worker counted before the principal starts',
    );
    // The user messages the principal: the principal starts working and a
    // racy status poll reads the still-running worker as queued. That read
    // must never erase the live running evidence.
    h.fire('agent_start', {});
    h.fire('tool_result', {
      toolName: 'subagent_status',
      toolCallId: 'status-i1',
      details: { gentleAgents: { taskId: 'i1', agent: 'gentle-ai-worker', status: 'queued' } },
    });
    const before = wire.received.length;
    h.fire('agent_start', {});
    const survived = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'worker count survives a racy queued poll during principal work',
    );
    assert.equal(survived.gentle_roles_v1, 'worker', 'delegation role survives principal activity');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('INTERLEAVE RED: principal settle with a running worker reverts to worker+count', async () => {
  const wire = await startT2bWire('test-pane-interleave-2');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('interleave-2');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-interleave-2', sessionFile);
    launchRunning(h, 'run-i2', 'i2', 'gentle-ai-worker');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'worker counted before the principal starts',
    );
    h.fire('agent_start', {});
    // A racy queued poll lands mid-turn: live running evidence survives it.
    h.fire('tool_result', {
      toolName: 'subagent_status',
      toolCallId: 'status-i2',
      details: { gentleAgents: { taskId: 'i2', agent: 'gentle-ai-worker', status: 'queued' } },
    });
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'worker counted while the principal works',
    );
    // The principal finishes while the worker delegation still runs: the
    // display must revert to the delegation role+count, never stick gentle.
    const before = wire.received.length;
    h.fire('agent_settled', {}, { isIdle: () => true });
    const reverted = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'worker count returns after the principal settles',
    );
    assert.equal(reverted.gentle_roles_v1, 'worker', 'principal settle reverts to the live delegation role');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('INTERLEAVE RED: multi-delegate count preserved across principal interleave+settle', async () => {
  const wire = await startT2bWire('test-pane-interleave-3');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('interleave-3');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-interleave-3', sessionFile);
    launchRunning(h, 'run-i3a', 'i3a', 'gentle-ai-worker');
    launchRunning(h, 'run-i3b', 'i3b', 'gentle-ai-explore');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:2:`),
      5000,
      'both delegates counted',
    );
    // A racy queued poll for the oldest must not drop it from the count.
    h.fire('agent_start', {});
    h.fire('tool_result', {
      toolName: 'subagent_status',
      toolCallId: 'status-i3a',
      details: { gentleAgents: { taskId: 'i3a', agent: 'gentle-ai-worker', status: 'queued' } },
    });
    const before = wire.received.length;
    h.fire('agent_settled', {}, { isIdle: () => true });
    const kept = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:2:`),
      5000,
      'multi-delegate count preserved across principal settle',
    );
    assert.equal(kept.gentle_roles_v1, 'worker,explorer', 'oldest-first roles preserved across principal settle');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('INTERLEAVE: poll-reported completion still applies and re-resolves oldest-first', async () => {
  const wire = await startT2bWire('test-pane-interleave-4');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('interleave-4');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-interleave-4', sessionFile);
    launchRunning(h, 'run-i4a', 'i4a', 'gentle-ai-worker');
    launchRunning(h, 'run-i4b', 'i4b', 'gentle-ai-explore');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:2:`),
      5000,
      'both delegates counted',
    );
    // A poll-reported FINAL is completion truth (not a racy read): it
    // applies, and the survivor re-resolves oldest-first.
    h.fire('agent_start', {});
    h.fire('tool_result', {
      toolName: 'subagent_status',
      toolCallId: 'status-i4a',
      details: { gentleAgents: { taskId: 'i4a', agent: 'gentle-ai-worker', status: 'completed' } },
    });
    const before = wire.received.length;
    h.fire('agent_settled', {}, { isIdle: () => true });
    const reverted = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'survivor count after poll-reported completion',
    );
    assert.equal(reverted.gentle_roles_v1, 'explorer', 'completion re-resolves to the oldest survivor');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

// --- Background-mode delegates (message_end lifecycle) --------------------
// Live evidence: Pi shows `Agents 1 active: gentle-ai-worker` while the
// sidebar for that same session reads gentle (expected worker). Background
// launches run through `subagent_run` with `mode: background`, but their
// TaskStore lifecycle announces over the `message_end` custom channel
// (`gentle-agents.result`) rather than `tool_result` details: a background
// START arrives with an ACTIVE status (running|queued) and must enter the
// running tasks map exactly like a task-mode record (counted,
// oldest-first, settle-safe, cleared by its FINAL). Pre-fix only FINAL
// statuses were accepted there, so background delegates never entered the
// map and the display stuck on gentle while Pi showed them active.

function bgStart(h, taskId, agent, status = 'running') {
  h.fire('message_end', {
    message: {
      role: 'custom',
      customType: 'gentle-agents.result',
      details: { gentleAgents: { taskId, agent, status } },
    },
  });
}

function bgComplete(h, taskId, agent) {
  bgStart(h, taskId, agent, 'completed');
}

test('BG RED: background start via message_end running enters count+roles', async () => {
  const wire = await startT2bWire('test-pane-bg-1');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('bg-1');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-bg-1', sessionFile);
    // No tool_call/tool_result: the background delegate announces itself
    // over message_end (e.g. launched before extension load).
    bgStart(h, 'bg1', 'gentle-ai-worker');
    const before = wire.received.length;
    h.fire('agent_start', {});
    const entered = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'background delegate counted with its role',
    );
    assert.equal(entered.gentle_roles_v1, 'worker');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('BG RED: background delegate survives principal settle, reverts to worker', async () => {
  const wire = await startT2bWire('test-pane-bg-2');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('bg-2');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-bg-2', sessionFile);
    bgStart(h, 'bg2', 'gentle-ai-worker');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'background delegate counted before the principal starts',
    );
    // The user messages the principal while the background delegate runs,
    // then the principal finishes: the display must revert to worker,
    // never stick on gentle.
    h.fire('agent_start', {});
    const before = wire.received.length;
    h.fire('agent_settled', {}, { isIdle: () => true });
    const reverted = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'background worker count returns after the principal settles',
    );
    assert.equal(reverted.gentle_roles_v1, 'worker');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('BG RED: mixed task-mode + background oldest-first preserved across settle', async () => {
  const wire = await startT2bWire('test-pane-bg-3');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('bg-3');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-bg-3', sessionFile);
    launchRunning(h, 'run-bg3', 'bg3task', 'gentle-ai-worker');
    bgStart(h, 'bg3', 'gentle-ai-explore');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:2:`),
      5000,
      'task-mode plus background delegates counted together',
    );
    h.fire('agent_start', {});
    const before = wire.received.length;
    h.fire('agent_settled', {}, { isIdle: () => true });
    const kept = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:2:`),
      5000,
      'mixed count preserved across principal settle',
    );
    assert.equal(kept.gentle_roles_v1, 'worker,explorer', 'oldest-first across both delegate paths');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('BG: background completion clears via message_end final', async () => {
  const wire = await startT2bWire('test-pane-bg-4');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('bg-4');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-bg-4', sessionFile);
    bgStart(h, 'bg4', 'gentle-ai-worker');
    await wire.waitForFrom(
      0,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      5000,
      'background delegate counted',
    );
    bgComplete(h, 'bg4', 'gentle-ai-worker');
    const before = wire.received.length;
    h.fire('agent_start', {});
    const cleared = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:0:`),
      5000,
      'background completion clears the count',
    );
    assert.equal(cleared.gentle_roles_v1, null);
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

// --- LIVE incident: post-restart static sidebar + invisible background delegate ---
// Live facts: (1) a fresh post-restart session publishes fresh gentle_*
// metadata beats yet the Herdr agent list shows NO agent_session binding
// for it; (2) a RUNNING background gentle-ai-verify delegate is invisible
// (count 0, no roles). Both reproduce on the wire below.

test('LIVE-1 RED: session binding publishes pane.report_agent_session on session_start', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-live-session', '1');
  try {
    const h = harness();
    factory(h.pi);
    const sessionFile = '/tmp/gentle-live-session-binding';
    h.fire('session_start', { reason: 'tui-restart' }, {
      mode: 'tui',
      sessionManager: { getSessionId: () => 'sess-live-1', getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => false,
    });
    const bound = await wire.waitFor(
      (r) => r.method === 'pane.report_agent_session' && r.params.agent_session_path === sessionFile,
      4000,
      'session_start must publish the agent_session binding (live: binding absent)',
    );
    assert.equal(bound.params.pane_id, 'pane-live-session');
    assert.equal(bound.params.agent, 'pi');
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('LIVE-1 RED: agent_start re-publishes the session binding', async () => {
  const wire = await startNativeWire();
  const { factory, prevEnv } = await loadNativeFactory(wire.sockPath, 'pane-live-session-2', '1');
  try {
    const h = harness();
    factory(h.pi);
    const sessionFile = '/tmp/gentle-live-session-binding-2';
    h.fire('session_start', {}, {
      mode: 'tui',
      sessionManager: { getSessionId: () => 'sess-live-2', getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => false,
    });
    await wire.waitFor(
      (r) => r.method === 'pane.report_agent_session' && r.params.agent_session_path === sessionFile,
      4000,
      'session_start binding',
    );
    const before = wire.received.filter((r) => r.method === 'pane.report_agent_session').length;
    h.fire('agent_start', {});
    const start = Date.now();
    while (Date.now() - start < 4000) {
      if (wire.received.filter((r) => r.method === 'pane.report_agent_session').length > before) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(
      wire.received.filter((r) => r.method === 'pane.report_agent_session').length > before,
      'agent_start must re-publish the agent_session binding',
    );
  } finally {
    restoreNativeEnv(prevEnv);
    await wire.close();
  }
});

test('LIVE-2 RED: background launch ack (queued, mode background) counts as running verify', async () => {
  const wire = await startT2bWire('test-pane-live-bg');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('live-bg');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-live-bg', sessionFile);
    // Live background shape: subagent_run returns immediately with the
    // runner-admitted QUEUED status plus mode background (runner.run admits
    // QUEUED synchronously; the pump to RUNNING emits no tool_result and
    // no message_end ACTIVE — completion is the next signal). The delegate
    // runs upstream while the producer only ever sees this ack.
    h.fire('tool_call', {
      toolName: 'subagent_run',
      toolCallId: 'run-live-bg1',
      input: { agent: 'gentle-ai-verify', label: 'live verify work', mode: 'background' },
    });
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'run-live-bg1',
      details: { gentleAgents: { taskId: 'live-bg1', agent: 'gentle-ai-verify', status: 'queued', mode: 'background' } },
    });
    const before = wire.received.length;
    h.fire('agent_start', {});
    const counted = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:1:`),
      4000,
      'background verify delegate counted (live: count 0, no roles)',
    );
    assert.equal(counted.gentle_roles_v1, 'verify');
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('LIVE-2 guard: task-mode queued stays uncounted (T2b preserved)', async () => {
  const wire = await startT2bWire('test-pane-live-bg-guard');
  try {
    const { createHash } = require('node:crypto');
    const h = harness();
    wire.factory(h.pi);
    const sessionFile = t2bSessionFile('live-bg-guard');
    const paneHash = createHash('sha256').update(sessionFile, 'utf8').digest('base64url');
    startT2bSession(h, 'sess-live-bg-guard', sessionFile);
    // No mode (task-mode shape): queued must never count and never supply
    // a role — the T2b running-only contract is unchanged.
    h.fire('tool_result', {
      toolName: 'subagent_run',
      toolCallId: 'run-guard-q1',
      details: { gentleAgents: { taskId: 'guard-q1', agent: 'gentle-ai-worker', status: 'queued' } },
    });
    const before = wire.received.length;
    h.fire('agent_start', {});
    const zero = await wire.waitForFrom(
      before,
      (p) => typeof p.gentle_work_v1 === 'string' && p.gentle_work_v1.startsWith(`${paneHash}:0:`),
      4000,
      'task-mode queued stays at count 0',
    );
    assert.equal(zero.gentle_roles_v1, null);
  } finally {
    process.env.HERDR_ENV = wire.prevEnv.HERDR_ENV;
    process.env.HERDR_SOCKET_PATH = wire.prevEnv.HERDR_SOCKET_PATH;
    process.env.HERDR_PANE_ID = wire.prevEnv.HERDR_PANE_ID;
    await wire.close();
  }
});

test('LIVE-3: settled idle is never dropped by an in-flight metadata beat', async () => {
  // Deterministic race pin: the metadata reply is held so the first beat
  // is provably in flight when the true-empty settle lands. Pre-fix the
  // settle publish hits `publishInFlight` and is dropped with no recovery
  // (publishQueued is only set via schedulePublish), so the pane sticks
  // at working forever. The session binding (LIVE-1) is in play: binding
  // first, then working, then settle-while-held, then idle must arrive.
  const net = require('node:net');
  const sockPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-live-settle-')), 'herdr.sock');
  const received = [];
  const heldReplies = [];
  let holdMetadata = true;
  const conns = new Set();
  const server = net.createServer((conn) => {
    conns.add(conn);
    conn.on('close', () => conns.delete(conn));
    let buf = '';
    conn.on('data', (chunk) => {
      buf += String(chunk);
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let req;
        try {
          req = JSON.parse(line);
        } catch {
          continue;
        }
        if (req && typeof req.method === 'string') received.push(req);
        const reply = () => {
          try {
            conn.write(`${JSON.stringify({ id: req && req.id, result: true })}\n`);
          } catch {}
        };
        if (holdMetadata && req && req.method === 'pane.report_metadata') heldReplies.push(reply);
        else reply();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, resolve);
  });
  const waitFor = async (pred, timeoutMs, what) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const found = received.find(pred);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.fail(`timed out waiting for ${what}; saw ${received.length} requests`);
  };
  const { factory, prevEnv } = await loadNativeFactory(sockPath, 'pane-live-settle', '1');
  try {
    const h = harness();
    factory(h.pi);
    const sessionFile = '/tmp/gentle-live-settle-session';
    h.fire('session_start', {}, {
      mode: 'tui',
      sessionManager: { getSessionId: () => 'sess-live-settle', getSessionFile: () => sessionFile, getEntries: () => [] },
      isIdle: () => false,
    });
    await waitFor((r) => r.method === 'pane.report_agent_session', 4000, 'session binding before settle');
    await waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'working',
      4000,
      'initial working (beat now held in flight)',
    );
    // The metadata beat is held in flight: settle now.
    h.fire('agent_settled', {}, { isIdle: () => true });
    await new Promise((r) => setTimeout(r, 150));
    holdMetadata = false;
    for (const reply of heldReplies.splice(0)) reply();
    const idle = await waitFor(
      (r) => r.method === 'pane.report_agent' && r.params.state === 'idle',
      4000,
      'idle after working settle (must not be dropped by the in-flight beat)',
    );
    assert.ok(idle.params.seq >= 1);
    h.fire('agent_settled', {}, { isIdle: () => true });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(
      received.filter((r) => r.method === 'pane.report_agent' && r.params.state === 'idle').length,
      1,
      'idle emits exactly once',
    );
  } finally {
    restoreNativeEnv(prevEnv);
    for (const conn of conns) {
      try {
        conn.destroy();
      } catch {}
    }
    await new Promise((r) => server.close(r));
  }
});

// --- L2: real prompts vs review preparation -------------------------------
// Causal finding: consentPending marked every eligible gentle_review
// start/select-intended-untracked as ask before any outcome/UI, so a
// pre-granted (auto-approved) session read blocked with no actual prompt.
// Review over-fired the same way: proposal tool_call, inspect/status/ack/
// scope tools, forecast-only captures, and stray sidebar/event hints all
// held review. Revised contract: review holds only for acknowledged
// gentle_review_capture/group EXECUTION (execution start with
// `reviewerRunAcknowledged: true`, never proposal, never correctionLines,
// never forecast-only); no sidebar/hook signal is observed and unknown
// legacy shapes stay dark; gentle_review
// (any operation) and gentle_review_scope never enter ask or review.

const L2_ACKED_CAPTURE = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
const L2_ACKED_GROUP = { lineageId: 'lin-1', collectBindings: ['{}'], reviewerRunAcknowledged: true };

test('L2: eligible no-prompt start never enters ask (incl. auto-granted resolve)', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_call', {
    toolName: 'gentle_review',
    toolCallId: 's1',
    input: { operation: 'start', input: { mode: 'ordinary' } },
  });
  h.fire('tool_call', {
    toolName: 'gentle_review',
    toolCallId: 's2',
    input: { operation: 'select-intended-untracked' },
  });
  h.fire('tool_execution_start', {
    toolCallId: 's1',
    toolName: 'gentle_review',
    args: { operation: 'start', input: { mode: 'ordinary' } },
  });
  h.fire('tool_execution_start', {
    toolCallId: 's2',
    toolName: 'gentle_review',
    args: { operation: 'select-intended-untracked' },
  });
  assert.equal(blockedLabels(h).length, 0, 'eligible starts must never speculate ask before a real prompt');
  // Auto-granted: the calls resolve with no UI ever opening — still no ask.
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 's1' });
  h.fire('tool_execution_end', { toolCallId: 's1', toolName: 'gentle_review' });
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 's2' });
  h.fire('tool_execution_end', { toolCallId: 's2', toolName: 'gentle_review' });
  assert.equal(blockedLabels(h).length, 0, 'auto-granted resolve must not leave ask behind');
});

test('L2: forecast-only capture/group never enters review', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  // Proposal first (never opens), then execution without acknowledgement
  // (forecast-only: no reviewer run authorized, no proven legacy route).
  h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: {} });
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: {} });
  h.fire('tool_call', { toolName: 'gentle_review_capture_group', toolCallId: 'g1', input: {} });
  h.fire('tool_execution_start', { toolCallId: 'g1', toolName: 'gentle_review_capture_group', args: {} });
  assert.equal(blockedLabels(h).length, 0, 'forecast-only calls must not hold review');
  h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
  h.fire('tool_result', { toolName: 'gentle_review_capture_group', toolCallId: 'g1' });
  h.fire('tool_execution_end', { toolCallId: 'g1', toolName: 'gentle_review_capture_group' });
  assert.equal(blockedLabels(h).length, 0);
});

test('L2: inspect/status/ack/assess/scope never enter review', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  const cases = [
    ['gentle_review', 'r-inspect', { operation: 'inspect' }],
    ['gentle_review', 'r-status', { operation: 'status' }],
    ['gentle_review', 'r-ack', { operation: 'acknowledge-approved' }],
    ['gentle_review', 'r-assess', { operation: 'assess' }],
    ['gentle_review', 'r-start', { operation: 'start', input: { mode: 'ordinary' } }],
    ['gentle_review_scope', 'r-scope', {}],
  ];
  for (const [toolName, toolCallId, input] of cases) {
    h.fire('tool_call', { toolName, toolCallId, input });
    h.fire('tool_execution_start', { toolCallId, toolName, args: input });
  }
  assert.equal(blockedLabels(h).length, 0, 'non-capture review tools must never hold review');
  for (const [toolName, toolCallId] of cases) {
    h.fire('tool_result', { toolName, toolCallId });
    h.fire('tool_execution_end', { toolCallId, toolName });
  }
  assert.equal(blockedLabels(h).length, 0);
});

test('L2: acknowledged capture holds review from execution start, not proposal, until end', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: L2_ACKED_CAPTURE });
  assert.equal(blockedLabels(h).length, 0, 'proposal alone must not open review');
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: L2_ACKED_CAPTURE });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.match(labels[0].label, /^review:/);
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2, 'execution end releases immediately — zero grace');
  assert.deepEqual(labels[1], { active: false });
});

test('L2: overlapping acked captures clear per id; error end releases immediately', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: L2_ACKED_CAPTURE });
  h.fire('tool_execution_start', { toolCallId: 'g1', toolName: 'gentle_review_capture_group', args: L2_ACKED_GROUP });
  const labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  const review = labels[0].label;
  assert.match(review, /^review:/);
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture', isError: true });
  assert.equal(blockedLabels(h).length, 1, 'error end of one span keeps the surviving overlap');
  assert.equal(blockedLabels(h)[0].label, review, 'episode id stays stable across overlap');
  h.fire('tool_result', { toolName: 'gentle_review_capture_group', toolCallId: 'g1' });
  const cleared = blockedLabels(h);
  assert.equal(cleared.length, 2);
  assert.deepEqual(cleared[1], { active: false });
});

test('L2: stray sidebar reviewing/checking never sticks review alone', async () => {
  const { default: factory } = await factoryPromise;
  for (const state of ['reviewing', 'checking', 'consent', 'forecast', 'in_review', 'approved', 'correction']) {
    const h = harness();
    factory(h.pi);
    startRootSession(h, 'sess-1');
    h.fireEvent('gentle-ai:review-sidebar', {
      sessionId: 'sess-1',
      snapshot: { state, scope: 'plan.md' },
    });
    assert.equal(blockedLabels(h).length, 0, `${state} without executing evidence must not hold review`);
  }
});

test('L2: legacy unacked execution never reviews; later acked execution still lights', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  // Unknown legacy shapes stay dark with any sidebar hint (documented
  // conservative limitation) — and the dark path must not wedge the leg.
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: {} });
  assert.equal(blockedLabels(h).length, 0);
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'reviewing', scope: 'plan.md' },
  });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'checking', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 0, 'no hint proves a legacy reviewer route');
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
  assert.equal(blockedLabels(h).length, 0);
  // A genuine acknowledged execution afterwards still lights and releases.
  h.fire('tool_execution_start', {
    toolCallId: 'c2',
    toolName: 'gentle_review_capture',
    args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true },
  });
  assert.match(blockedLabels(h)[0].label, /^review:/);
  h.fire('tool_execution_end', { toolCallId: 'c2', toolName: 'gentle_review_capture' });
  assert.deepEqual(blockedLabels(h)[1], { active: false });
});

test('L2: real UI prompt outranks live review and releases back to it', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: L2_ACKED_CAPTURE });
  assert.match(blockedLabels(h)[0].label, /^review:/);
  h.fire('tool_execution_start', { toolCallId: 't1', toolName: 'bash', args: {} });
  h.fire('ui_prompt_start', { reason: 'ui_prompt', kind: 'select' });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.match(labels[1].label, /^ask:/, 'real prompt takes priority during review execution');
  h.fire('ui_prompt_end', {});
  labels = blockedLabels(h);
  assert.equal(labels.length, 3);
  assert.match(labels[2].label, /^review:/, 'prompt close releases back to the live execution');
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
  h.fire('tool_execution_end', { toolCallId: 't1', toolName: 'bash' });
  labels = blockedLabels(h);
  assert.deepEqual(labels[labels.length - 1], { active: false }, 'overlap cleanup must not stick blocked');
});

// --- L2 correction: acked-only review, execution-gated structured ask ----
// Independent findings: correctionLines is native planning
// (captureCorrectionPlan), not a reviewer run; sidebar `reviewing` fires at
// any bound capture entry BEFORE the forecast branch, so it cannot prove
// legacy execution; the reserved hook has no producer; structured ask
// opened on tool_call proposal and never closed on execution end. Revised
// contract: review = executing capture/group with reviewerRunAcknowledged
// === true only; structured ask opens on tool execution and closes on end
// or result.

test('L2c: correctionLines capture execution never reviews', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  // Native correction-plan shape: planning, not a reviewer run.
  h.fire('tool_execution_start', {
    toolCallId: 'c1',
    toolName: 'gentle_review_capture',
    args: { lineageId: 'lin-1', collectBinding: '{}', correctionLines: 12 },
  });
  assert.equal(blockedLabels(h).length, 0, 'correctionLines is planning, never reviewer execution');
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
  assert.equal(blockedLabels(h).length, 0);
  // Both keys together is rejected upstream without executing: never review.
  h.fire('tool_execution_start', {
    toolCallId: 'c2',
    toolName: 'gentle_review_capture',
    args: { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true, correctionLines: 12 },
  });
  assert.equal(blockedLabels(h).length, 0, 'invalid upstream combination never executes');
  h.fire('tool_execution_end', { toolCallId: 'c2', toolName: 'gentle_review_capture' });
  assert.equal(blockedLabels(h).length, 0);
});

test('L2c: unacked execution with reviewing then forecast never reviews', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  // Actual upstream order: execute entry publishes `reviewing` for any bound
  // capture BEFORE the forecast branch runs — so the hint cannot prove a
  // legacy reviewer run. Unknown legacy shapes stay dark (documented).
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: {} });
  assert.equal(blockedLabels(h).length, 0);
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'reviewing', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 0, 'entry reviewing must not light forecast review');
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'forecast', scope: 'plan.md' },
  });
  assert.equal(blockedLabels(h).length, 0);
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
  assert.equal(blockedLabels(h).length, 0);
});

test('L2c: standalone reserved hook never reviews', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  // No producer emits this hook; an independent OR would activate review
  // from nothing. It must be fully inert on its own.
  h.fireEvent('gentle-pi:review:blocked', { active: true, reviewId: 'hook1' });
  assert.equal(blockedLabels(h).length, 0, 'producer-less hook must never hold review');
  h.fireEvent('gentle-pi:review:blocked', { active: true, reviewId: 'hook1' });
  h.fireEvent('gentle-pi:review:blocked', { active: false });
  assert.equal(blockedLabels(h).length, 0);
});

test('L2c: hook/sidebar noise never disturbs acked execution release', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h, 'sess-1');
  const acked = { lineageId: 'lin-1', collectBinding: '{}', reviewerRunAcknowledged: true };
  h.fire('tool_execution_start', { toolCallId: 'c1', toolName: 'gentle_review_capture', args: acked });
  assert.match(blockedLabels(h)[0].label, /^review:/);
  h.fireEvent('gentle-pi:review:blocked', { active: true, reviewId: 'hook1' });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'reviewing', scope: 'plan.md' },
  });
  h.fireEvent('gentle-ai:review-sidebar', {
    sessionId: 'sess-1',
    snapshot: { state: 'forecast', scope: 'plan.md' },
  });
  h.fireEvent('gentle-pi:review:blocked', { active: false });
  assert.equal(blockedLabels(h).length, 1, 'noise must not churn or steal the episode');
  h.fire('tool_execution_end', { toolCallId: 'c1', toolName: 'gentle_review_capture' });
  const labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
});

test('L2c: proposed structured ask without execution stays nonblocked', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  // Proposal (beforeToolCall) alone is not execution: no prompt is open.
  h.fire('tool_call', { toolName: 'ask_user_question', toolCallId: 'q1', input: {} });
  h.fire('tool_call', { toolName: 'ask_user_choice', toolCallId: 'q2', input: {} });
  assert.equal(blockedLabels(h).length, 0, 'proposal without execution must not block');
  h.fire('tool_result', { toolName: 'ask_user_question', toolCallId: 'q1' });
  h.fire('tool_result', { toolName: 'ask_user_choice', toolCallId: 'q2' });
  assert.equal(blockedLabels(h).length, 0);
});

test('L2c: aborted executed ask clears on execution end without tool_result', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  // Genuine execution opens ask; an abort/error end with no tool_result
  // must release it immediately (no latch, no timers).
  h.fire('tool_execution_start', { toolCallId: 'q1', toolName: 'ask_user_choice', args: {} });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.match(labels[0].label, /^ask:/);
  h.fire('tool_execution_end', { toolCallId: 'q1', toolName: 'ask_user_choice', isError: true });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
  // Symmetric close: result without a prior end also releases.
  h.fire('tool_execution_start', { toolCallId: 'q2', toolName: 'ask_user_question', args: {} });
  assert.match(blockedLabels(h)[2].label, /^ask:/);
  h.fire('tool_result', { toolName: 'ask_user_question', toolCallId: 'q2' });
  labels = blockedLabels(h);
  assert.equal(labels.length, 4);
  assert.deepEqual(labels[3], { active: false });
});
