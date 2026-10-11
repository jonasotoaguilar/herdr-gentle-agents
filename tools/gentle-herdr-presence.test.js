'use strict';
// T1 regression tests for the presence reconciliation helpers now inlined in
// extensions/gentle-herdr-state.ts (single-file deployment boundary: the
// installed copy/symlink ships without the helper module). The tests
// extract the exported helpers from an isolated single-file copy of
// state.ts — the package import is stubbed exactly like
// tools/gentle-herdr-state.test.js; production is untouched. Bounded,
// session-bound full activity reconciliation independent of delayed chat
// results: explicit terminal task statuses are preferred over absence; no
// timer, parent-settlement, rendered-text, or capped-discovery signal may
// complete a task.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');

const src = path.resolve(__dirname, '../extensions/gentle-herdr-state.ts');
const srcText = fs.readFileSync(src, 'utf8');
const stubbed = srcText.replace(
  /import \{ generateUnifiedPatch \} from "@earendil-works\/pi-coding-agent";/,
  'const generateUnifiedPatch = () => { throw new Error("stubbed in tests"); };',
);
assert.ok(stubbed !== srcText, 'expected the package import line to be stubbed');
// Single-file deployment boundary: no sibling helper may be needed. Fail
// the load if state.ts still carries a relative import.
assert.ok(
  !/^import .* from "\.\//m.test(stubbed),
  'state.ts must stay self-contained (no relative imports)',
);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-herdr-presence-'));
const copy = path.join(root, 'gentle-herdr-state-helpers.mjs');
fs.writeFileSync(copy, stubbed);
const presencePromise = import(pathToFileURL(copy).href);

const INCARNATION = '123e4567-e89b-42d3-a456-426614174000';
const OTHER_INCARNATION = '223e4567-e89b-42d3-a456-426614174001';

function hexHash(sessionId) {
  return createHash('sha256').update(sessionId, 'utf8').digest('hex');
}

function makeProfile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-presence-'));
  fs.chmodSync(dir, 0o755);
  const shared = path.join(dir, 'gentle-agents');
  const presenceRoot = path.join(shared, 'presence');
  fs.mkdirSync(presenceRoot, { recursive: true });
  fs.chmodSync(shared, 0o700);
  fs.chmodSync(presenceRoot, 0o700);
  return { dir, presenceRoot };
}

function summaryFor(id, status, agent = 'gentle-ai-worker') {
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

// Real session ref fixture: exact upstream envelope bytes so the header
// digest authenticates, like PresencePublisher.flush() writes them.
function writeSnapshot(presenceRoot, options) {
  const {
    sessionId,
    incarnation = INCARNATION,
    generation = 1,
    heartbeat = Date.now(),
    tasks = [],
    label = 'Test Session',
    dropActivity = false,
    rawActivityBytes,
    digestOverride,
    unavailableOverride,
  } = options;
  const sessionHash = hexHash(sessionId);
  const counts = { running: 0, queued: 0, waiting: 0, finished: 0 };
  for (const task of tasks) {
    if (task.status === 'running') counts.running += 1;
    else if (task.status === 'queued') counts.queued += 1;
    else if (task.status === 'waiting') counts.waiting += 1;
    else counts.finished += 1;
  }
  const activityBytes =
    rawActivityBytes ??
    JSON.stringify({
      schema: 1,
      sessionHash,
      incarnation,
      generation,
      activity: {
        tasks: tasks.map((task) => ({
          summary: task.summary ?? summaryFor(task.id, task.status, task.agent),
          thread: { version: 0, dropped: 0, items: [] },
        })),
      },
    });
  const header = {
    schema: 1,
    sessionHash,
    incarnation,
    label,
    heartbeat,
    generation,
    counts,
    digest: digestOverride !== undefined ? digestOverride : createHash('sha256').update(activityBytes, 'utf8').digest('hex'),
    unavailable: unavailableOverride !== undefined ? unavailableOverride : null,
  };
  if (unavailableOverride !== undefined && unavailableOverride !== null) header.digest = null;
  fs.writeFileSync(
    path.join(presenceRoot, `${sessionHash}.${incarnation}.header.json`),
    JSON.stringify(header),
  );
  if (!dropActivity) {
    fs.writeFileSync(
      path.join(presenceRoot, `${sessionHash}.${incarnation}.activity.json`),
      activityBytes,
    );
  }
  return { sessionHash, header };
}

function localTasks(entries) {
  const map = new Map();
  for (const [id, status, at, epoch = 0] of entries) {
    map.set(id, { agent: 'gentle-ai-worker', label: `label ${id}`, status, at, epoch });
  }
  return map;
}

function envFor(dir) {
  return { GENTLE_PI_AGENT_HOME: dir };
}

test('state.ts exports live reconciliation helpers (not no-op stubs)', async () => {
  const mod = await presencePromise;
  for (const name of [
    'resolvePresenceProfile',
    'readPresenceSnapshot',
    'createPresenceReconciler',
    'reconcilePresenceTasks',
  ]) {
    assert.equal(typeof mod[name], 'function', `${name} must be an exported helper`);
  }
  // The temporary deployment stubs returned null/empty unconditionally;
  // a real helper set must witness and resolve a trivial snapshot.
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-export-shape';
  const now = Date.now();
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 1,
    heartbeat: now,
    tasks: [{ id: 'only', status: 'failed' }],
  });
  const snapshot = mod.readPresenceSnapshot(sessionId, now, { env: envFor(dir) });
  assert.ok(snapshot, 'inlined readPresenceSnapshot must return a real snapshot');
});

test('profile resolution fails closed on ambiguous overrides', async () => {
  const { resolvePresenceProfile } = await presencePromise;
  const { dir } = makeProfile();
  assert.equal(
    resolvePresenceProfile({ GENTLE_PI_AGENT_HOME: '/a', PI_CODING_AGENT_DIR: '/b' }, dir),
    undefined,
    'two different overrides must not pick one',
  );
  assert.equal(
    resolvePresenceProfile({ GENTLE_PI_AGENT_HOME: '/a', PI_CODING_AGENT_DIR: '/a' }, dir),
    undefined,
    'identical non-profile values still fail closed without a real root',
  );
  assert.equal(
    resolvePresenceProfile({ GENTLE_PI_AGENT_HOME: '' }, dir),
    undefined,
    'empty override falls through to a missing home root'
  );
});

test('profile resolution honors the real env convention', async () => {
  const { resolvePresenceProfile } = await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  assert.equal(resolvePresenceProfile(envFor(dir), dir), presenceRoot);
  const { dir: dir2 } = makeProfile();
  const presenceRoot2 = path.join(dir2, 'gentle-agents', 'presence');
  fs.mkdirSync(presenceRoot2, { recursive: true });
  fs.chmodSync(path.join(dir2, 'gentle-agents'), 0o700);
  fs.chmodSync(presenceRoot2, 0o700);
  assert.equal(
    resolvePresenceProfile({ PI_CODING_AGENT_DIR: dir2 }, dir2),
    presenceRoot2,
    'PI_CODING_AGENT_DIR fallback matches agent-home.ts order',
  );
  assert.equal(
    resolvePresenceProfile(envFor(dir), '/ignored-home'),
    presenceRoot,
    'explicit env wins over home fallback',
  );
});

test('profile resolution expands tilde like the upstream selector', async () => {
  const { resolvePresenceProfile } = await presencePromise;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-home-'));
  const agentHome = path.join(home, '.pi', 'agent');
  const presenceRoot = path.join(agentHome, 'gentle-agents', 'presence');
  fs.mkdirSync(presenceRoot, { recursive: true });
  fs.chmodSync(path.join(agentHome, 'gentle-agents'), 0o700);
  fs.chmodSync(presenceRoot, 0o700);
  assert.equal(resolvePresenceProfile({}, home), presenceRoot, 'empty env falls through to ~/.pi/agent');
  assert.equal(
    resolvePresenceProfile({ GENTLE_PI_AGENT_HOME: '~/.pi/agent' }, home),
    presenceRoot,
    '~ expands against home for env-derived values',
  );
});

test('explicit terminal statuses apply to known tasks only', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-terminal-1';
  const now = Date.now();
  const tasks = localTasks([
    ['t-complete', 'running', now - 5000],
    ['t-fail', 'queued', now - 5000],
    ['t-cancel', 'running', now - 5000],
    ['t-timeout', 'waiting', now - 5000],
    ['t-done', 'completed', now - 9000],
  ]);
  const reconciler = createPresenceReconciler();
  // Explicit terminals require a current-epoch active witness: gen 6 lists
  // every task active first, so the gen-7 terminals resolve safely.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 6,
    heartbeat: now - 1000,
    tasks: [
      { id: 't-complete', status: 'running' },
      { id: 't-fail', status: 'queued' },
      { id: 't-cancel', status: 'running' },
      { id: 't-timeout', status: 'waiting' },
    ],
  });
  const witnessed = readPresenceSnapshot(sessionId, now - 1000, { env: envFor(dir) });
  assert.ok(witnessed, 'gen6 witness must read');
  assert.deepEqual(
    reconcilePresenceTasks(tasks, reconciler, witnessed, now - 1000).applied,
    [],
  );
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 7,
    heartbeat: now,
    tasks: [
      { id: 't-complete', status: 'completed' },
      { id: 't-fail', status: 'failed' },
      { id: 't-cancel', status: 'cancelled' },
      { id: 't-timeout', status: 'timed_out' },
      { id: 't-stranger', status: 'failed' },
    ],
  });
  const snapshot = readPresenceSnapshot(sessionId, now, { env: envFor(dir) });
  assert.ok(snapshot, 'valid fresh snapshot must read');
  assert.equal(snapshot.generation, 7);
  const { applied } = reconcilePresenceTasks(tasks, reconciler, snapshot, now);
  assert.equal(tasks.get('t-complete').status, 'completed');
  assert.equal(tasks.get('t-fail').status, 'failed');
  assert.equal(tasks.get('t-cancel').status, 'cancelled');
  assert.equal(tasks.get('t-timeout').status, 'timed_out');
  assert.ok(!tasks.has('t-stranger'), 'snapshot ids never create local tasks');
  assert.equal(tasks.get('t-done').status, 'completed', 'locally final records keep their status');
  assert.equal(applied.length, 4);
  assert.deepEqual(
    applied.map((entry) => entry.status).sort(),
    ['cancelled', 'completed', 'failed', 'timed_out'],
  );
});

test('witnessed absence in a newer complete snapshot completes the task', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-absence-1';
  const t0 = Date.now();
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 3,
    heartbeat: t0,
    tasks: [{ id: 't1', status: 'running' }],
  });
  const reconciler = createPresenceReconciler();
  const tasks = localTasks([['t1', 'running', t0 - 5000]]);
  const first = readPresenceSnapshot(sessionId, t0, { env: envFor(dir) });
  assert.ok(first, 'gen3 must read');
  assert.deepEqual(reconcilePresenceTasks(tasks, reconciler, first, t0).applied, []);
  assert.equal(tasks.get('t1').status, 'running', 'witnessing never completes');
  // Upstream drops the finished task and advances generation + heartbeat.
  writeSnapshot(presenceRoot, { sessionId, generation: 4, heartbeat: t0 + 1000, tasks: [] });
  const second = readPresenceSnapshot(sessionId, t0 + 1000, { env: envFor(dir) });
  assert.ok(second, 'gen4 must read');
  const { applied } = reconcilePresenceTasks(tasks, reconciler, second, t0 + 1000);
  assert.equal(tasks.get('t1').status, 'completed');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].via, 'absence');
});

test('unwitnessed absence never completes (restored tasks stay safe)', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-absence-2';
  const now = Date.now();
  // The local map knows t-restored (live tool events), but no snapshot ever
  // listed it — e.g. upstream treats it as restored history and filters it.
  writeSnapshot(presenceRoot, { sessionId, generation: 9, heartbeat: now, tasks: [] });
  const snapshot = readPresenceSnapshot(sessionId, now, { env: envFor(dir) });
  assert.ok(snapshot, 'empty complete snapshot must read');
  const tasks = localTasks([['t-restored', 'running', now - 30000]]);
  const { applied } = reconcilePresenceTasks(tasks, createPresenceReconciler(), snapshot, now);
  assert.equal(tasks.get('t-restored').status, 'running');
  assert.deepEqual(applied, []);
});

test('old snapshots cannot override newer locally observed launches', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-race-1';
  const t0 = Date.now();
  // Witness t1 running at gen 5 first.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 5,
    heartbeat: t0,
    tasks: [{ id: 't1', status: 'running' }],
  });
  const reconciler = createPresenceReconciler();
  const first = readPresenceSnapshot(sessionId, t0, { env: envFor(dir) });
  const tasks = localTasks([['t1', 'running', t0 - 5000]]);
  reconcilePresenceTasks(tasks, reconciler, first, t0);
  // A relaunch is observed locally AFTER the next snapshot's heartbeat: the
  // snapshot predates the launch, so neither its explicit status nor its
  // absence may clobber the fresh record.
  const launchAt = t0 + 2000;
  tasks.set('t1', { agent: 'gentle-ai-worker', label: 'label t1', status: 'running', at: launchAt, epoch: 1 });
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 6,
    heartbeat: t0 + 1000,
    tasks: [{ id: 't1', status: 'completed' }],
  });
  const stale = readPresenceSnapshot(sessionId, t0 + 1000, { env: envFor(dir) });
  const { applied } = reconcilePresenceTasks(tasks, reconciler, stale, t0 + 1000);
  assert.equal(tasks.get('t1').status, 'running', 'predated explicit status must not apply');
  assert.deepEqual(applied, []);
  // A same-generation terminal status after the relaunch is indistinguishable
  // from stale activity (the header ticked but the generation did not), so
  // it must still be skipped: only a fresh-epoch witness plus a strictly
  // newer generation may resolve the relaunched task.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 7,
    heartbeat: launchAt + 1000,
    tasks: [{ id: 't1', status: 'completed' }],
  });
  const ticked = readPresenceSnapshot(sessionId, launchAt + 1000, { env: envFor(dir) });
  const skipped = reconcilePresenceTasks(tasks, reconciler, ticked, launchAt + 1000);
  assert.deepEqual(skipped.applied, [], 'post-relaunch terminal without fresh witness stays skipped');
  assert.equal(tasks.get('t1').status, 'running');
  // Upstream observes the resumed task running, then drops it: the new epoch
  // completes on a strictly newer absent generation.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 8,
    heartbeat: launchAt + 2000,
    tasks: [{ id: 't1', status: 'running' }],
  });
  const witnessed = readPresenceSnapshot(sessionId, launchAt + 2000, { env: envFor(dir) });
  assert.deepEqual(
    reconcilePresenceTasks(tasks, reconciler, witnessed, launchAt + 2000).applied,
    [],
  );
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 9,
    heartbeat: launchAt + 3000,
    tasks: [],
  });
  const done = readPresenceSnapshot(sessionId, launchAt + 3000, { env: envFor(dir) });
  const { applied: completed } = reconcilePresenceTasks(tasks, reconciler, done, launchAt + 3000);
  assert.equal(completed.length, 1);
  assert.equal(tasks.get('t1').status, 'completed');
});

test('duplicate or regressed generations are ignored', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-gen-1';
  const now = Date.now();
  const tasks = localTasks([['t1', 'running', now - 5000]]);
  const reconciler = createPresenceReconciler();
  // Witness the task active first: explicit terminals resolve only from
  // activity strictly newer than a current-epoch witness.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 10,
    heartbeat: now - 1000,
    tasks: [{ id: 't1', status: 'running' }],
  });
  const witnessed = readPresenceSnapshot(sessionId, now - 1000, { env: envFor(dir) });
  assert.ok(witnessed, 'gen10 witness must read');
  assert.deepEqual(
    reconcilePresenceTasks(tasks, reconciler, witnessed, now - 1000).applied,
    [],
  );
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 11,
    heartbeat: now,
    tasks: [{ id: 't1', status: 'failed' }],
  });
  const snapshot = readPresenceSnapshot(sessionId, now, { env: envFor(dir) });
  reconcilePresenceTasks(tasks, reconciler, snapshot, now);
  assert.equal(tasks.get('t1').status, 'failed');
  tasks.set('t1', { agent: 'gentle-ai-worker', label: 'label t1', status: 'running', at: now - 1000, epoch: 1 });
  const { applied } = reconcilePresenceTasks(tasks, reconciler, snapshot, now);
  assert.deepEqual(applied, [], 'replaying the same generation must not re-apply');
  assert.equal(tasks.get('t1').status, 'running');
});

test('stale, future, or missing heartbeats never clear tasks', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-stale-1';
  const now = Date.now();
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 2,
    heartbeat: now - 16000,
    tasks: [{ id: 't1', status: 'failed' }],
  });
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'heartbeat past the 15s window is stale',
  );
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 3,
    heartbeat: now + 60000,
    tasks: [{ id: 't1', status: 'failed' }],
  });
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'future heartbeat fails closed',
  );
  const tasks = localTasks([['t1', 'running', now - 5000]]);
  const { applied } = reconcilePresenceTasks(tasks, createPresenceReconciler(), undefined, now);
  assert.deepEqual(applied, []);
  assert.equal(tasks.get('t1').status, 'running');
});

test('generation or digest mismatch is malformed and never clears', async () => {
  const { readPresenceSnapshot } = await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-tamper-1';
  const now = Date.now();
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 4,
    heartbeat: now,
    tasks: [{ id: 't1', status: 'failed' }],
  });
  const { sessionHash } = { sessionHash: hexHash(sessionId) };
  // Tamper the activity bytes after the header digest was computed.
  const activityPath = path.join(presenceRoot, `${sessionHash}.${INCARNATION}.activity.json`);
  const parsed = JSON.parse(fs.readFileSync(activityPath, 'utf8'));
  parsed.activity.tasks[0].summary.status = 'completed';
  fs.writeFileSync(activityPath, JSON.stringify(parsed));
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'digest mismatch must fail closed',
  );
  // Generation skew between header and envelope is malformed too.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 5,
    heartbeat: now,
    tasks: [{ id: 't1', status: 'failed' }],
  });
  const skewed = JSON.parse(fs.readFileSync(activityPath, 'utf8'));
  skewed.generation = 6;
  const skewedBytes = JSON.stringify(skewed);
  fs.writeFileSync(activityPath, skewedBytes);
  const headerPath = path.join(presenceRoot, `${sessionHash}.${INCARNATION}.header.json`);
  const header = JSON.parse(fs.readFileSync(headerPath, 'utf8'));
  header.digest = createHash('sha256').update(skewedBytes, 'utf8').digest('hex');
  fs.writeFileSync(headerPath, JSON.stringify(header));
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'generation mismatch must fail closed even with a valid digest',
  );
});

test('oversize, malformed, or unavailable snapshots never clear tasks', async () => {
  const { readPresenceSnapshot } = await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-limits-1';
  const now = Date.now();
  const { sessionHash } = { sessionHash: hexHash(sessionId) };
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 1,
    heartbeat: now,
    tasks: [{ id: 't1', status: 'failed' }],
  });
  const headerPath = path.join(presenceRoot, `${sessionHash}.${INCARNATION}.header.json`);
  const goodHeader = fs.readFileSync(headerPath, 'utf8');
  fs.writeFileSync(headerPath, `${goodHeader}${' '.repeat(17 * 1024)}`);
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'oversize header must fail closed',
  );
  fs.writeFileSync(headerPath, '{not json');
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'malformed header must fail closed',
  );
  fs.writeFileSync(headerPath, goodHeader);
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 2,
    heartbeat: now,
    tasks: [],
    unavailableOverride: 'activity-too-large',
  });
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'activity-too-large carries no task evidence',
  );
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 3,
    heartbeat: now,
    tasks: [],
    dropActivity: true,
  });
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'interrupted publication (missing activity) must fail closed',
  );
});

test('ambiguous incarnations fail closed; foreign sessions never match', async () => {
  const { readPresenceSnapshot } = await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-ambig-1';
  const now = Date.now();
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 1,
    heartbeat: now,
    tasks: [{ id: 't1', status: 'failed' }],
  });
  writeSnapshot(presenceRoot, {
    sessionId,
    incarnation: OTHER_INCARNATION,
    generation: 1,
    heartbeat: now,
    tasks: [{ id: 't1', status: 'failed' }],
  });
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'two incarnations for one session hash must not pick one',
  );
  assert.equal(
    readPresenceSnapshot('sess-foreign-9', now, { env: envFor(dir) }),
    undefined,
    'exact live session id hash is required — never a foreign session',
  );
});

test('capped discovery sidecars are never task evidence', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-discovery-1';
  const now = Date.now();
  const { sessionHash } = { sessionHash: hexHash(sessionId) };
  // A discovery sidecar omits the task (8-task cap); without a complete
  // activity file it must establish nothing.
  fs.writeFileSync(
    path.join(presenceRoot, `${sessionHash}.${INCARNATION}.discovery.json`),
    JSON.stringify({
      schema: 1,
      sessionHash,
      incarnation: INCARNATION,
      generation: 1,
      metadata: { activation: 'a'.repeat(64), workspace: '/tmp', tasks: [], omitted: 3 },
    }),
  );
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'discovery alone is not a snapshot',
  );
  const tasks = localTasks([['t1', 'running', now - 5000]]);
  const { applied } = reconcilePresenceTasks(tasks, createPresenceReconciler(), undefined, now);
  assert.deepEqual(applied, []);
  assert.equal(tasks.get('t1').status, 'running');
});

test('truncated lists fail the header counts consistency check', async () => {
  const { readPresenceSnapshot } = await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-trunc-1';
  const now = Date.now();
  const { sessionHash } = writeSnapshot(presenceRoot, {
    sessionId,
    generation: 1,
    heartbeat: now,
    tasks: [{ id: 't1', status: 'running' }],
  });
  // Inflate the header count past the listed tasks: the projection cannot
  // account for every active task, so absence proves nothing.
  const headerPath = path.join(presenceRoot, `${sessionHash}.${INCARNATION}.header.json`);
  const header = JSON.parse(fs.readFileSync(headerPath, 'utf8'));
  header.counts.running = 2;
  fs.writeFileSync(headerPath, JSON.stringify(header));
  assert.equal(
    readPresenceSnapshot(sessionId, now, { env: envFor(dir) }),
    undefined,
    'list/count skew must fail closed'
  );
});

test('session-file hash never substitutes for the live session id hash', async () => {
  const { readPresenceSnapshot } = await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const now = Date.now();
  writeSnapshot(presenceRoot, {
    sessionId: 'live-session-abc',
    generation: 1,
    heartbeat: now,
    tasks: [],
  });
  assert.equal(
    readPresenceSnapshot('/tmp/some/session-file.json', now, { env: envFor(dir) }),
    undefined,
    'a session-file path hashes differently from the live session id',
  );
});

function rewriteHeartbeat(presenceRoot, sessionId, incarnation, heartbeat) {
  const headerPath = path.join(
    presenceRoot,
    `${hexHash(sessionId)}.${incarnation}.header.json`,
  );
  const header = JSON.parse(fs.readFileSync(headerPath, 'utf8'));
  header.heartbeat = heartbeat;
  fs.writeFileSync(headerPath, JSON.stringify(header));
}

test('refreshed heartbeat on an unchanged generation cannot finalize a relaunched epoch', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-heartbeat-race';
  const t0 = Date.now();
  // Generation 5 witnesses the delegate running under the first local epoch.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 5,
    heartbeat: t0,
    tasks: [{ id: 'x', status: 'running' }],
  });
  const reconciler = createPresenceReconciler();
  const tasks = localTasks([['x', 'running', t0 - 5000]]);
  const gen5 = readPresenceSnapshot(sessionId, t0, { env: envFor(dir) });
  assert.ok(gen5, 'gen5 must read');
  assert.deepEqual(reconcilePresenceTasks(tasks, reconciler, gen5, t0).applied, []);
  // Upstream finishes the delegate (gen 6 drops it), then the SAME task id
  // resumes locally: a strictly newer local epoch with a newer observation.
  const relaunchAt = t0 + 2000;
  tasks.set('x', { agent: 'gentle-ai-worker', label: 'label x', status: 'running', at: relaunchAt, epoch: 1 });
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 6,
    heartbeat: t0 + 1000,
    tasks: [],
  });
  // The 5 s header ticker rewrites the heartbeat past the relaunch WITHOUT
  // touching the gen-6 activity bytes. A heartbeat-vs-at guard now passes —
  // but the activity still predates the new epoch, so it must not finalize.
  const tickedHeartbeat = relaunchAt + 1000;
  rewriteHeartbeat(presenceRoot, sessionId, INCARNATION, tickedHeartbeat);
  const stale = readPresenceSnapshot(sessionId, tickedHeartbeat, { env: envFor(dir) });
  assert.ok(stale, 'ticked gen6 header must still read as fresh');
  assert.equal(stale.generation, 6);
  const { applied } = reconcilePresenceTasks(tasks, reconciler, stale, tickedHeartbeat);
  assert.deepEqual(applied, [], 'ticked heartbeat must not authorize absence for a new epoch');
  assert.equal(tasks.get('x').status, 'running', 'relaunched delegate stays running');
});

test('same task resume completes again after a fresh-epoch witness', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-resume-1';
  const t0 = Date.now();
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 5,
    heartbeat: t0,
    tasks: [{ id: 'x', status: 'running' }],
  });
  const reconciler = createPresenceReconciler();
  const tasks = localTasks([['x', 'running', t0 - 5000]]);
  reconcilePresenceTasks(tasks, reconciler, readPresenceSnapshot(sessionId, t0, { env: envFor(dir) }), t0);
  writeSnapshot(presenceRoot, { sessionId, generation: 6, heartbeat: t0 + 1000, tasks: [] });
  const first = reconcilePresenceTasks(
    tasks,
    reconciler,
    readPresenceSnapshot(sessionId, t0 + 1000, { env: envFor(dir) }),
    t0 + 1000,
  );
  assert.equal(tasks.get('x').status, 'completed', 'first epoch completes by witnessed absence');
  assert.equal(first.applied.length, 1);
  // Resume: same id, new local epoch, still running.
  const relaunchAt = t0 + 2000;
  tasks.set('x', { agent: 'gentle-ai-worker', label: 'label x', status: 'running', at: relaunchAt, epoch: 1 });
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 7,
    heartbeat: relaunchAt + 500,
    tasks: [{ id: 'x', status: 'running' }],
  });
  const resumed = reconcilePresenceTasks(
    tasks,
    reconciler,
    readPresenceSnapshot(sessionId, relaunchAt + 500, { env: envFor(dir) }),
    relaunchAt + 500,
  );
  assert.deepEqual(resumed.applied, []);
  assert.equal(tasks.get('x').status, 'running', 'resumed epoch is witnessed, not completed');
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 8,
    heartbeat: relaunchAt + 1500,
    tasks: [],
  });
  const second = reconcilePresenceTasks(
    tasks,
    reconciler,
    readPresenceSnapshot(sessionId, relaunchAt + 1500, { env: envFor(dir) }),
    relaunchAt + 1500,
  );
  assert.equal(tasks.get('x').status, 'completed', 'resumed epoch completes on newer absence');
  assert.equal(second.applied.length, 1);
  assert.equal(second.applied[0].via, 'absence');
});

test('stale explicit final is skipped and the witness record is preserved', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-explicit-stale';
  const t0 = Date.now();
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 5,
    heartbeat: t0,
    tasks: [{ id: 'x', status: 'running' }],
  });
  const reconciler = createPresenceReconciler();
  const tasks = localTasks([['x', 'running', t0 - 5000]]);
  reconcilePresenceTasks(tasks, reconciler, readPresenceSnapshot(sessionId, t0, { env: envFor(dir) }), t0);
  assert.ok(reconciler.seen.has('x'), 'gen5 witnesses the first epoch');
  // Same id resumes locally (new epoch); the next activity still carries the
  // previous epoch's terminal status with a freshly ticked heartbeat.
  const relaunchAt = t0 + 2000;
  tasks.set('x', { agent: 'gentle-ai-worker', label: 'label x', status: 'running', at: relaunchAt, epoch: 1 });
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 6,
    heartbeat: t0 + 1000,
    tasks: [{ id: 'x', status: 'failed' }],
  });
  rewriteHeartbeat(presenceRoot, sessionId, INCARNATION, relaunchAt + 1000);
  const stale = readPresenceSnapshot(sessionId, relaunchAt + 1000, { env: envFor(dir) });
  assert.ok(stale, 'ticked gen6 header must still read as fresh');
  const { applied } = reconcilePresenceTasks(tasks, reconciler, stale, relaunchAt + 1000);
  assert.deepEqual(applied, [], 'previous-epoch explicit final must not apply to the new epoch');
  assert.equal(tasks.get('x').status, 'running');
  assert.ok(
    reconciler.seen.has('x'),
    'rejecting the stale explicit final must preserve the witness record',
  );
  // The preserved witness chain still converges: a fresh-epoch witness plus
  // a newer absence completes normally.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 7,
    heartbeat: relaunchAt + 1500,
    tasks: [{ id: 'x', status: 'running' }],
  });
  reconcilePresenceTasks(
    tasks,
    reconciler,
    readPresenceSnapshot(sessionId, relaunchAt + 1500, { env: envFor(dir) }),
    relaunchAt + 1500,
  );
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 8,
    heartbeat: relaunchAt + 2500,
    tasks: [],
  });
  const later = reconcilePresenceTasks(
    tasks,
    reconciler,
    readPresenceSnapshot(sessionId, relaunchAt + 2500, { env: envFor(dir) }),
    relaunchAt + 2500,
  );
  assert.equal(later.applied.length, 1);
  assert.equal(tasks.get('x').status, 'completed');
});

test('first-ever stale terminal fails closed without a witness', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-first-terminal';
  const t0 = Date.now();
  const tasks = localTasks([
    ['x', 'running', t0 - 5000],
    ['y', 'running', t0 - 5000],
  ]);
  const reconciler = createPresenceReconciler();
  // The reader missed every generation before gen 9: its first sighting of x
  // already carries a terminal status. The live publisher omits finals, so a
  // first-seen terminal cannot be a fresh finish — it is an older epoch's
  // leftover surfaced after a resume — and must fail closed with no witness.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 9,
    heartbeat: t0,
    tasks: [
      { id: 'x', status: 'failed' },
      { id: 'y', status: 'running' },
    ],
  });
  const first = readPresenceSnapshot(sessionId, t0, { env: envFor(dir) });
  assert.ok(first, 'gen9 must read');
  const { applied: noneApplied } = reconcilePresenceTasks(tasks, reconciler, first, t0);
  assert.deepEqual(noneApplied, [], 'unwitnessed first-ever terminal must not apply');
  assert.equal(tasks.get('x').status, 'running', 'stale terminal never clobbers the resume');
  assert.equal(tasks.get('y').status, 'running', 'witnessing never completes');
  // Witnessed active (gen 10) followed by a strictly newer terminal resolves.
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 10,
    heartbeat: t0 + 1000,
    tasks: [{ id: 'x', status: 'running' }],
  });
  const witnessed = readPresenceSnapshot(sessionId, t0 + 1000, { env: envFor(dir) });
  const { applied: witnessedApplied } = reconcilePresenceTasks(
    tasks,
    reconciler,
    witnessed,
    t0 + 1000,
  );
  // y was witnessed active in gen 9 and is gone from gen 10: absence applies.
  assert.equal(witnessedApplied.length, 1);
  assert.equal(witnessedApplied[0].id, 'y');
  assert.equal(tasks.get('y').status, 'completed', 'witnessed absence still works');
  assert.equal(tasks.get('x').status, 'running', 'fresh witness never completes');
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 11,
    heartbeat: t0 + 2000,
    tasks: [{ id: 'x', status: 'failed' }],
  });
  const terminal = readPresenceSnapshot(sessionId, t0 + 2000, { env: envFor(dir) });
  const { applied } = reconcilePresenceTasks(tasks, reconciler, terminal, t0 + 2000);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].via, 'explicit');
  assert.equal(tasks.get('x').status, 'failed', 'witnessed newer terminal still works');
});

test('same-status progress observation keeps the witness epoch', async () => {
  const { readPresenceSnapshot, createPresenceReconciler, reconcilePresenceTasks } =
    await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-progress-epoch';
  const t0 = Date.now();
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 5,
    heartbeat: t0,
    tasks: [{ id: 'x', status: 'running' }],
  });
  const reconciler = createPresenceReconciler();
  const tasks = localTasks([['x', 'running', t0 - 5000]]);
  const gen5 = readPresenceSnapshot(sessionId, t0, { env: envFor(dir) });
  assert.ok(gen5, 'gen5 must read');
  assert.deepEqual(reconcilePresenceTasks(tasks, reconciler, gen5, t0).applied, []);
  // A same-status progress read bumps recency (at) but starts no new
  // execution, so the epoch stays 0 and the witness stays valid.
  const progressAt = t0 + 2000;
  tasks.set('x', { agent: 'gentle-ai-worker', label: 'label x', status: 'running', at: progressAt, epoch: 0 });
  writeSnapshot(presenceRoot, { sessionId, generation: 6, heartbeat: progressAt + 500, tasks: [] });
  const gen6 = readPresenceSnapshot(sessionId, progressAt + 500, { env: envFor(dir) });
  assert.ok(gen6, 'gen6 must read');
  const { applied } = reconcilePresenceTasks(tasks, reconciler, gen6, progressAt + 500);
  assert.equal(applied.length, 1, 'progress must not strand the delegate');
  assert.equal(applied[0].via, 'absence');
  assert.equal(tasks.get('x').status, 'completed');
});

test('stale prior incarnation never suppresses the fresh current owner', async () => {
  const { readPresenceSnapshot } = await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-stale-owner';
  const now = Date.now();
  // Leftover prior incarnation: structurally valid but stale (heartbeat far
  // past the 15 s window). Written first so directory order cannot save us.
  writeSnapshot(presenceRoot, {
    sessionId,
    incarnation: OTHER_INCARNATION,
    generation: 3,
    heartbeat: now - 60000,
    tasks: [{ id: 'old', status: 'running' }],
  });
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 9,
    heartbeat: now,
    tasks: [{ id: 'cur', status: 'running' }],
  });
  const snapshot = readPresenceSnapshot(sessionId, now, { env: envFor(dir) });
  assert.ok(snapshot, 'fresh current owner must resolve despite the stale leftover');
  assert.equal(snapshot.generation, 9);
  assert.deepEqual(
    snapshot.tasks.map((task) => task.id),
    ['cur'],
  );
});

test('unavailable prior incarnation never suppresses the fresh current owner', async () => {
  const { readPresenceSnapshot } = await presencePromise;
  const { dir, presenceRoot } = makeProfile();
  const sessionId = 'sess-unavailable-owner';
  const now = Date.now();
  // Fresh but carrying no activity evidence: must not count as an owner and
  // must not create ambiguity with the live incarnation.
  writeSnapshot(presenceRoot, {
    sessionId,
    incarnation: OTHER_INCARNATION,
    generation: 4,
    heartbeat: now,
    tasks: [],
    unavailableOverride: 'activity-too-large',
  });
  writeSnapshot(presenceRoot, {
    sessionId,
    generation: 9,
    heartbeat: now,
    tasks: [{ id: 'cur', status: 'running' }],
  });
  const snapshot = readPresenceSnapshot(sessionId, now, { env: envFor(dir) });
  assert.ok(snapshot, 'fresh available owner must resolve despite the unavailable leftover');
  assert.equal(snapshot.generation, 9);
});
