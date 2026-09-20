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
  h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: {} });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.equal(labels[0].active, true);
  assert.match(labels[0].label, /^review:r-/);
  const review = labels[0].label;
  // A non-consent review operation (status check) stays in the review leg.
  h.fire('tool_call', { toolName: 'gentle_review', toolCallId: 's1', input: { operation: 'status' } });
  assert.equal(blockedLabels(h).length, 1, 'second review call must not re-emit the same label');
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 's1' });
  assert.equal(blockedLabels(h).length, 1, 'first resolve must hold while one call is in flight');
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
  h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: {} });
  h.fire('tool_call', { toolName: 'gentle_review_capture_group', toolCallId: 'c2', input: {} });
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

test('reserved review hook holds review without tool calls and clears on inactive', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fireEvent('gentle-pi:review:blocked', { active: true, reviewId: 'hook1' });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.deepEqual(labels[0], { active: true, label: 'review:hook1' });
  h.fireEvent('gentle-pi:review:blocked', { active: true, reviewId: 'hook1' });
  assert.equal(blockedLabels(h).length, 1, 'duplicate hook active must not re-emit');
  h.fireEvent('gentle-pi:review:blocked', { active: false });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2);
  assert.deepEqual(labels[1], { active: false });
});

test('consent-eligible start stays ask while pending, falls back to review on resolve', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  // Ordinary-mode start may present host review-consent UI: ask leg.
  h.fire('tool_call', {
    toolName: 'gentle_review',
    toolCallId: 's1',
    input: { operation: 'start', input: { mode: 'ordinary' } },
  });
  let labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.match(labels[0].label, /^ask:/);
  // An in-flight capture call must not outrank the pending consent ask.
  h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: {} });
  assert.equal(blockedLabels(h).length, 1, 'review must not outrank pending consent ask');
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 's1' });
  labels = blockedLabels(h);
  assert.equal(labels.length, 2, 'consent resolve falls back to the live review call');
  assert.match(labels[1].label, /^review:/);
  h.fire('tool_result', { toolName: 'gentle_review_capture', toolCallId: 'c1' });
  labels = blockedLabels(h);
  assert.equal(labels.length, 3);
  assert.deepEqual(labels[2], { active: false });
});

test('select-intended-untracked start is consent-eligible (ask while pending)', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_call', {
    toolName: 'gentle_review',
    toolCallId: 's1',
    input: { operation: 'select-intended-untracked' },
  });
  const labels = blockedLabels(h);
  assert.equal(labels.length, 1);
  assert.match(labels[0].label, /^ask:/);
  h.fire('tool_result', { toolName: 'gentle_review', toolCallId: 's1' });
  assert.deepEqual(blockedLabels(h)[1], { active: false });
});

test('error outranks ask outranks review across legs', async () => {
  const { default: factory } = await factoryPromise;
  const h = harness();
  factory(h.pi);
  startRootSession(h);
  h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: {} });
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
  h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: {} });
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
    // 1. The review call publishes a fresh review token on the wire.
    h.fire('tool_call', { toolName: 'gentle_review_capture', toolCallId: 'c1', input: {} });
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
