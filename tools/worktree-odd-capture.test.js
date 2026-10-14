'use strict';
// P2-S6 tests (test-first): automatic `odd/` document capture (S5, D7) in
// extensions/gentle-worktree-tools.ts.
//
// Loading pattern mirrors tools/worktree-create.test.js: the TypeScript
// extension is plain JS under the hood (// @ts-nocheck, no type
// annotations), so the test copies it to a temporary .mjs path with the
// package import lines stubbed and import()s it with a fake `pi` object
// that records tool/command/event registrations and lets the test dispatch
// tool pipeline events.
//
// Every test builds its own isolated fixture repository under os.tmpdir()
// (real `git init` + one commit), a real linked worktree (`git worktree
// add -b`), a registry entry for that worktree, and a principal `odd/`
// directory symlinked into the worktree exactly like the creation hooks do.
// Only observable behavior is asserted: the registry `odd` array inside the
// git common dir, and the handler's return value (nothing). The user's real
// checkouts are never touched; only the fixture dirs tracked in `roots` are
// removed.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');

const TYPE_STUB = [
  'const Type = {',
  '  Object: (props) => ({ type: "object", properties: props }),',
  '  String: (opts) => ({ type: "string", ...(opts || {}) }),',
  '  Number: (opts) => ({ type: "number", ...(opts || {}) }),',
  '  Array: (items, opts) => ({ type: "array", items, ...(opts || {}) }),',
  '  Boolean: (opts) => ({ type: "boolean", ...(opts || {}) }),',
  '  Optional: (schema) => ({ ...schema, optional: true }),',
  '};',
].join('\n');

const srcText = fs.readFileSync(SRC, 'utf8');
const stubbed = srcText
  .replace(
    'import { Type } from "@earendil-works/pi-ai";',
    TYPE_STUB,
  )
  .replace(
    'import { defineTool } from "@earendil-works/pi-coding-agent";',
    'const defineTool = (def) => def;',
  );
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

const roots = [];
after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
  return (result.stdout || '').trim();
}

// Fresh fixture repository with one commit, a principal `odd/` directory
// holding `docs`, a real linked worktree whose `odd/` is a symlink into the
// principal checkout (exactly what the creation hooks build), and a
// registry entry owning that worktree.
function makeRepoWithWorktree(tag, { branch = 'feat/odd', docs = ['notes.md'] } = {}) {
  const root = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-odd-${tag}-`)));
  git(root, ['init']);
  git(root, ['config', 'user.email', 'test@example.com']);
  git(root, ['config', 'user.name', 'Test']);
  git(root, ['commit', '--allow-empty', '-m', 'init']);
  const realRoot = fs.realpathSync(root);

  const principalOdd = path.join(realRoot, 'odd');
  fs.mkdirSync(principalOdd, { recursive: true });
  for (const doc of docs) {
    const full = path.join(principalOdd, doc);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `# ${doc}\n`);
  }

  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(path.dirname(realRoot), `${path.basename(realRoot)}-wt-${slug}`);
  track(target);
  git(realRoot, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  const realTarget = fs.realpathSync(target);
  fs.symlinkSync(principalOdd, path.join(realTarget, 'odd'));

  const registryLib = require('../lib/worktree-registry.js');
  const stored = registryLib.upsertWorktree(realRoot, {
    branch, path: realTarget, thread: 'thread-1', issues: [35], odd: [],
  });
  assert.equal(stored.ok, true);
  return { root: realRoot, target: realTarget, branch, principalOdd };
}

function oddOf(root, branch) {
  return require('../lib/worktree-registry.js').findByBranch(root, branch).odd;
}

const savedEnv = { ...process.env };
function setEnv(vars) {
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}
function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(savedEnv)) process.env[key] = value;
}

// Import the stubbed extension copy with the lib override in place. The
// fake `pi` records tool/command registrations and every `pi.on`
// subscription so tests can dispatch tool pipeline events.
async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-odd-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map(); // event name -> [handler]
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  return { tools, commands, handlers };
}

function toolEvent(toolName, filePath) {
  return { toolName, args: { path: filePath } };
}

function ctxFor(cwd) {
  return { cwd, sessionManager: { getSessionId: () => 'thread-1' }, ui: { notify: () => {} } };
}

async function dispatch(handlers, eventName, event, ctx) {
  const list = handlers.get(eventName) || [];
  assert.ok(list.length > 0, `expected a ${eventName} subscription`);
  const returns = [];
  for (const handler of list) {
    returns.push(await handler(event, ctx));
  }
  return returns;
}

describe('worktree odd capture', { concurrency: false }, () => {
  test('a read/edit/write of an odd/*.md inside a registered worktree records it idempotently', async () => {
    const { root, target, branch } = makeRepoWithWorktree('capture');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers } = await loadExtension();
      const ctx = ctxFor(target);
      for (const [toolName, doc] of [['read', 'notes.md'], ['edit', 'notes.md'], ['write', 'tasks/plan.md']]) {
        const full = path.join(target, 'odd', doc);
        fs.mkdirSync(path.dirname(full), { recursive: true });
        if (!fs.existsSync(full)) fs.writeFileSync(full, `# ${doc}\n`);
        const returns = await dispatch(handlers, 'tool_call', toolEvent(toolName, full), ctx);
        for (const value of returns) {
          assert.equal(value, undefined, 'the handler returns nothing and never blocks the pipeline');
        }
      }
      assert.deepEqual(oddOf(root, branch).slice().sort(), ['odd/notes.md', 'odd/tasks/plan.md']);
      // A second identical wave adds nothing.
      const before = oddOf(root, branch).slice().sort();
      await dispatch(handlers, 'tool_call', toolEvent('read', path.join(target, 'odd', 'notes.md')), ctx);
      await dispatch(handlers, 'tool_call', toolEvent('edit', path.join(target, 'odd', 'notes.md')), ctx);
      await dispatch(handlers, 'tool_call', toolEvent('write', path.join(target, 'odd', 'tasks/plan.md')), ctx);
      assert.deepEqual(oddOf(root, branch).slice().sort(), before, 'already-recorded docs are not added again');
    } finally {
      restoreEnv();
    }
  });

  test('a call whose context is the principal checkout records nothing', async () => {
    const { root, target, branch } = makeRepoWithWorktree('principal');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers } = await loadExtension();
      // Same shared file, but the agent context is the principal checkout.
      const returns = await dispatch(
        handlers, 'tool_call',
        toolEvent('read', path.join(root, 'odd', 'notes.md')),
        ctxFor(root),
      );
      for (const value of returns) assert.equal(value, undefined);
      assert.deepEqual(oddOf(root, branch), [], 'the principal checkout associates nothing');
      assert.ok(!fs.existsSync(path.join(target, 'odd', 'notes.md')) || true);
    } finally {
      restoreEnv();
    }
  });

  test('a non-.md path and a path outside odd/ record nothing', async () => {
    // No pre-existing docs: the re-scan complement must find nothing, so
    // only the per-call capture is exercised here.
    const { root, target, branch } = makeRepoWithWorktree('nonmd', { docs: [] });
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers } = await loadExtension();
      const ctx = ctxFor(target);
      const image = path.join(target, 'odd', 'diagram.png');
      fs.writeFileSync(image, 'fake-png\n');
      await dispatch(handlers, 'tool_call', toolEvent('read', image), ctx);
      const outside = path.join(target, 'src', 'app.js');
      fs.mkdirSync(path.dirname(outside), { recursive: true });
      fs.writeFileSync(outside, 'console.log(1)\n');
      await dispatch(handlers, 'tool_call', toolEvent('edit', outside), ctx);
      await dispatch(handlers, 'tool_call', toolEvent('write', outside), ctx);
      assert.deepEqual(oddOf(root, branch), [], 'only .md documents inside odd/ are captured');
    } finally {
      restoreEnv();
    }
  });

  test('a bash command touching odd/ is not parsed (re-scan still finds nothing new)', async () => {
    const { root, target, branch } = makeRepoWithWorktree('bash');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers } = await loadExtension();
      const returns = await dispatch(
        handlers, 'tool_call',
        { toolName: 'bash', args: { command: `cat ${path.join(target, 'odd', 'notes.md')}` } },
        ctxFor(target),
      );
      for (const value of returns) assert.equal(value, undefined);
      // The re-scan complements the hook: the pre-existing notes.md the
      // registry never saw is recorded even though the bash argv is opaque.
      assert.deepEqual(oddOf(root, branch), ['odd/notes.md']);
    } finally {
      restoreEnv();
    }
  });

  test('a worktree whose registry cannot be written neither throws nor breaks the pipeline', async () => {
    const { root, target, branch } = makeRepoWithWorktree('readonly');
    const registryLib = require('../lib/worktree-registry.js');
    const commonDir = path.resolve(root, spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).stdout.trim());
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    fs.chmodSync(commonDir, 0o555);
    try {
      const { handlers } = await loadExtension();
      let returns;
      let threw = null;
      try {
        returns = await dispatch(
          handlers, 'tool_call',
          toolEvent('read', path.join(target, 'odd', 'notes.md')),
          ctxFor(target),
        );
      } catch (err) {
        threw = err;
      }
      assert.equal(threw, null, 'the handler never throws');
      assert.ok(returns, 'expected dispatch returns');
      for (const value of returns) assert.equal(value, undefined, 'the pipeline is never blocked');
      assert.deepEqual(oddOf(root, branch), [], 'a failed write leaves stored data unchanged');
    } finally {
      fs.chmodSync(commonDir, 0o755);
      restoreEnv();
    }
  });

  test('the re-scan records an odd/*.md that was never observed', async () => {
    const { root, target, branch } = makeRepoWithWorktree('rescan', { docs: ['observed.md', 'unseen.md'] });
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers } = await loadExtension();
      await dispatch(
        handlers, 'tool_call',
        toolEvent('read', path.join(target, 'odd', 'observed.md')),
        ctxFor(target),
      );
      assert.deepEqual(
        oddOf(root, branch).slice().sort(),
        ['odd/observed.md', 'odd/unseen.md'],
        'the bounded re-scan complements the per-call capture',
      );
    } finally {
      restoreEnv();
    }
  });

  test('tool_result events capture the same way without duplicating', async () => {
    const { root, target, branch } = makeRepoWithWorktree('result');
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR });
    try {
      const { handlers } = await loadExtension();
      const ctx = ctxFor(target);
      const full = path.join(target, 'odd', 'notes.md');
      await dispatch(handlers, 'tool_result', { toolName: 'read', input: { path: full } }, ctx);
      assert.deepEqual(oddOf(root, branch), ['odd/notes.md']);
      await dispatch(handlers, 'tool_result', { toolName: 'read', input: { path: full } }, ctx);
      assert.deepEqual(oddOf(root, branch), ['odd/notes.md'], 'repeat results add nothing');
    } finally {
      restoreEnv();
    }
  });
});
