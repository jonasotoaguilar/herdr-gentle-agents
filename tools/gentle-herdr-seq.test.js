'use strict';
// The report `seq` must be monotonic ACROSS processes (DESIGN §7 / E1).
//
// Herdr's own embedded plugin SDK seeds its counter with `Date.now() * 1000`
// and increments from there, so a report from a freshly started process is
// never lower than the previous process's last one. A zero-based counter
// makes every report after a Pi restart or `/new` (which recreates the
// extension runtime) lose to the stored value: Herdr ignores it, the pane
// keeps the OLD `agent_session` binding, and the consumer daemon rejects the
// fresh tokens (session-hash mismatch) — the sidebar freezes at `idle`.
//
// This test loads two independent copies of the extension (two simulated
// processes) against one live unix socket and asserts the second runtime's
// first binding seq is strictly greater than the first runtime's last one.

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-herdr-seq-'));
const sockPath = path.join(root, 'herdr.sock');

// Live socket: records every request frame and answers with a matching id so
// the extension takes the socket path and never falls back to the CLI.
const frames = [];
const server = net.createServer((conn) => {
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
      frames.push(request);
      try {
        conn.write(`${JSON.stringify({ id: request.id, result: {} })}\n`);
      } catch {}
    }
  });
  conn.on('error', () => {});
});
server.unref();

const sessionFile = path.join(root, 'sess.jsonl');
fs.writeFileSync(sessionFile, '{}\n');

// Module-level env/pane binding is captured at import, so it is pinned before
// the first import resolves.
process.env.HERDR_ENV = '1';
process.env.HERDR_SOCKET_PATH = sockPath;
process.env.HERDR_PANE_ID = 'test-pane';

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

function rootContext() {
  return {
    mode: 'tui',
    sessionManager: {
      getSessionId: () => 'sess-1',
      getSessionFile: () => sessionFile,
      getEntries: () => [],
    },
    isIdle: () => false,
  };
}

async function loadRuntime(name) {
  const copy = path.join(root, `${name}.mjs`);
  fs.writeFileSync(copy, stubbed);
  const module = await import(pathToFileURL(copy).href);
  return module.default;
}

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

const bindings = () => frames.filter((f) => f?.method === 'pane.report_agent_session');
const states = () => frames.filter((f) => f?.method === 'pane.report_agent');

test('the report seq is time-seeded, not a zero-based counter', async () => {
  await new Promise((resolve) => server.listen(sockPath, resolve));
  const factory = await loadRuntime('runtime-a');
  const h = harness();
  factory(h.pi);
  h.fire('session_start', { reason: 'startup' }, rootContext());
  await settle();

  const sent = bindings();
  assert.ok(sent.length > 0, 'expected a pane.report_agent_session frame');
  const seq = sent[0].params.seq;
  assert.ok(Number.isSafeInteger(seq), `seq must be an integer, got ${seq}`);
  assert.ok(
    seq > 1_000_000_000_000,
    `seq must be seeded from time (herdr SDK uses Date.now()*1000); got ${seq}`,
  );
  for (const frame of states()) {
    assert.ok(
      frame.params.seq > 1_000_000_000_000,
      `pane.report_agent seq must be time-seeded too; got ${frame.params.seq}`,
    );
  }
  server.close();
});

test('a fresh runtime reports a seq above the previous runtime', async () => {
  await new Promise((resolve) => server.listen(sockPath, resolve));
  const first = await loadRuntime('runtime-b1');
  const h1 = harness();
  first(h1.pi);
  h1.fire('session_start', { reason: 'startup' }, rootContext());
  await settle();
  const firstSeq = bindings().at(-1)?.params.seq;
  assert.ok(Number.isSafeInteger(firstSeq), 'first runtime must bind');

  const second = await loadRuntime('runtime-b2');
  const h2 = harness();
  second(h2.pi);
  h2.fire('session_start', { reason: 'startup' }, rootContext());
  await settle();
  const secondSeq = bindings().at(-1)?.params.seq;

  assert.ok(
    secondSeq > firstSeq,
    `a restarted runtime must win the binding (got ${secondSeq} vs ${firstSeq})`,
  );
  server.close();
});
