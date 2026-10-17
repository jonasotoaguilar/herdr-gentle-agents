'use strict';
// Warp identity against the REAL installed Pi SessionManager
// (customize-command T33/S43 correction).
//
// The fake SessionManager doubles in tools/customize-warp.test.js model
// sessions as flat entry arrays, so they cannot prove the two production
// defects behind the repeated erroneous forks:
//
//  1. The warp's own notice persists as `custom_message/worktree-warp`
//     (SessionManager.appendCustomMessageEntry, reached through
//     `sendMessage({ customType })`), while the filter excluded only
//     `custom/worktree-warp`; and session startup appends
//     `custom/gentle-pi.session-worktree/v1`. Both were counted as real
//     work, so an untouched fork never equalled its parent.
//  2. `getEntries()` returns ALL branches while the live point is the
//     ACTIVE branch (`getBranch(leaf)`); and the record was recomputed
//     from the stale pre-switch manager instead of the destination file
//     the live runtime kept appending to.
//
// Every session below is built by the REAL installed SessionManager in an
// isolated temp dir (no live sessions, no daemons): files are genuinely
// unique per scenario (timestamp_uuid names from the manager itself), and
// the public warp flow runs through `executeWorktreeWarp` with the real
// class injected. When no installed runtime exists this suite SKIPS with
// a notice instead of substituting fake-only claims.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const LIB_DIR = path.resolve(__dirname, '../lib');
const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');

function warpLib() {
  return require('../lib/worktree-warp-sessions.js');
}

function registryLib() {
  return require('../lib/worktree-registry.js');
}

// Candidate installed runtimes, newest first. PI_SESSION_MANAGER_PATH
// overrides the discovery (a direct file path to session-manager.js).
function realSessionManagerCandidates() {
  if (process.env.PI_SESSION_MANAGER_PATH) return [process.env.PI_SESSION_MANAGER_PATH];
  const base = path.join(os.homedir(), '.pi', 'agent', 'install', 'releases');
  let versions = [];
  try {
    versions = fs.readdirSync(base)
      .filter((name) => /^\d+\.\d+\.\d+$/.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  return versions.map((v) => path.join(
    base, v, 'node_modules', '@earendil-works', 'pi-coding-agent',
    'dist', 'core', 'session-manager.js',
  ));
}

function realSessionManagerPath() {
  return realSessionManagerCandidates().find((p) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  }) || null;
}

const SM_PATH = realSessionManagerPath();
if (!SM_PATH) {
  console.error(
    'worktree-warp-real-session: SKIPPING (no installed Pi SessionManager found; '
    + 'set PI_SESSION_MANAGER_PATH to a session-manager.js to run real-session proof)',
  );
}

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

function makeRepo(tag) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-real-${tag}-`)));
  git(dir, ['init']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['commit', '--allow-empty', '-m', 'init']);
  return fs.realpathSync(dir);
}

function addWorktree(root, branch) {
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'worktree';
  const target = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-wt-'))), slug);
  git(root, ['worktree', 'add', '-b', branch, target, 'HEAD']);
  assert.equal(registryLib().upsertWorktree(root, {
    branch, path: target, thread: 'real-test', issues: [], odd: [],
  }).ok, true);
  return fs.realpathSync(target);
}

function readSessionLines(file) {
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function entryTypes(file) {
  return readSessionLines(file)
    .filter((entry) => entry.type !== 'session')
    .map((entry) => entry.type + (entry.customType ? `/${entry.customType}` : ''));
}

// The extension loader mirrors tools/customize-warp.test.js: the
// TypeScript extension is plain JS under the hood, so the test copies it
// to a temp .mjs path with the package import lines stubbed.
const srcText = fs.readFileSync(SRC, 'utf8');
const stubbed = srcText
  .replace(
    'import { Type } from "@earendil-works/pi-ai";',
    'const Type = { Object: (p) => ({ properties: p }), String: (o) => ({ ...(o || {}) }), '
    + 'Number: (o) => ({ ...(o || {}) }), Array: (i, o) => ({ items: i }), '
    + 'Boolean: (o) => ({ ...(o || {}) }), Optional: (s) => ({ ...s }) };',
  )
  .replace(
    'import { defineTool } from "@earendil-works/pi-coding-agent";',
    'const defineTool = (def) => def;',
  );
assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    registerMessageRenderer: () => {},
    on: () => () => {},
  };
  const factory = (await import(pathToFileURL(copy).href)).default;
  factory(pi);
  const mod = await import(pathToFileURL(copy).href);
  return { mod };
}

describe('warp identity on real sessions (T33 correction RED)', { skip: !SM_PATH, concurrency: false }, () => {
  let RealSM = null;

  before(async () => {
    assert.ok(SM_PATH, 'no installed Pi SessionManager (set PI_SESSION_MANAGER_PATH)');
    RealSM = (await import(pathToFileURL(SM_PATH).href)).SessionManager;
    assert.equal(typeof RealSM?.forkFrom, 'function', `installed runtime has forkFrom (${SM_PATH})`);
    assert.equal(typeof RealSM?.open, 'function', `installed runtime has open (${SM_PATH})`);
  });

  // A session holding real work plus every proven bookkeeping shape the
  // warp flow itself appends: the custom marker, the custom_message
  // notice, the session-worktree registration entry and the rename.
  function trackedSession(dir, { modelChange = null } = {}) {
    const sessionDir = path.join(dir, 'sessions');
    const sm = RealSM.create(dir, sessionDir);
    sm.appendMessage({ role: 'user', content: 'do the thing' });
    sm.appendMessage({ role: 'assistant', content: 'doing it' });
    const workTip = sm.getLeafId();
    sm.appendCustomEntry('worktree-warp', { from: '/a', to: '/b' });
    sm.appendCustomMessageEntry('worktree-warp', 'Worktree warp: now in /b.', true, {});
    sm.appendCustomEntry('gentle-pi.session-worktree/v1', { path: '/b' });
    sm.appendSessionInfo('notes · feat-x');
    if (modelChange) sm.appendModelChange(modelChange.provider, modelChange.modelId);
    return { sm, file: sm.getSessionFile(), workTip };
  }

  test('the real notice and registration shapes never move the filtered point', () => {
    const lib = warpLib();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-filter-')));
    const { sm, workTip } = trackedSession(dir);
    const entries = sm.getEntries();
    assert.ok(entries.some((e) => e.type === 'custom_message' && e.customType === 'worktree-warp'),
      'the notice really persists as custom_message/worktree-warp');
    assert.ok(entries.some((e) => e.type === 'custom' && e.customType === 'gentle-pi.session-worktree/v1'),
      'the registration really persists as custom/gentle-pi.session-worktree/v1');
    const point = lib.sessionPoint(entries, sm.getLeafId());
    assert.equal(point.tipId, workTip, 'the filtered tip is the last real entry, not the notice or rename');
    assert.equal(point.count, 2, 'only the user/assistant entries count');
    assert.deepStrictEqual(lib.pointOfSessionFile(sm.getSessionFile()), point,
      'the file point matches the live point before further work');
    // Every real role invalidates equality: a tool result is work too.
    sm.appendMessage({ role: 'toolResult', content: 'tool output' });
    const toolTip = sm.getLeafId();
    const moved = lib.sessionPoint(sm.getEntries(), toolTip);
    assert.equal(moved.tipId, toolTip, 'a tool result moves the tip');
    assert.equal(moved.count, 3, 'a tool result counts');
    // The same file read back from disk (leaf recovered, not guessed).
    assert.deepStrictEqual(lib.pointOfSessionFile(sm.getSessionFile()), moved,
      'the file point matches the live point');
  });

  test('unproven shapes still count: no broad exclusion', () => {
    const lib = warpLib();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-narrow-')));
    const { sm } = trackedSession(dir);
    const before = lib.sessionPoint(sm.getEntries(), sm.getLeafId());
    sm.appendCustomEntry('some-other-tool/v9', { x: 1 });
    sm.appendCustomMessageEntry('some-other-tool/v9', 'other', true, {});
    const afterPoint = lib.sessionPoint(sm.getEntries(), sm.getLeafId());
    assert.notDeepStrictEqual(afterPoint, before, 'unknown custom shapes move the point');
    assert.equal(afterPoint.count, before.count + 2, 'both unknown entries count');
  });

  test('model/thinking changes are session content and move the point', () => {
    const lib = warpLib();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-model-')));
    const { sm } = trackedSession(dir);
    // Installed API proof: appendModelChange/appendThinkingLevelChange
    // exist on the real manager (dist/core/session-manager.js). They
    // change the effective session (they travel in the projection), the
    // warp never appends them, and unknown entries must never be silently
    // ignored — so they count, and a hop across one forks.
    assert.equal(typeof sm.appendModelChange, 'function', 'installed appendModelChange exists');
    assert.equal(typeof sm.appendThinkingLevelChange, 'function', 'installed appendThinkingLevelChange exists');
    const before = lib.sessionPoint(sm.getEntries(), sm.getLeafId());
    sm.appendModelChange('prov', 'model-2');
    sm.appendThinkingLevelChange('high');
    const afterPoint = lib.sessionPoint(sm.getEntries(), sm.getLeafId());
    assert.equal(afterPoint.count, before.count + 2, 'model/thinking changes count as session content');
  });

  test('identity is the ACTIVE branch, not all append-only entries', () => {
    const lib = warpLib();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-branch-')));
    const sessionDir = path.join(dir, 'sessions');
    const sm = RealSM.create(dir, sessionDir);
    sm.appendMessage({ role: 'user', content: 'one' });
    const first = sm.getLeafId();
    sm.appendMessage({ role: 'assistant', content: 'two' });
    const abandoned = sm.getLeafId();
    // A side leg off the first entry: getEntries() keeps the abandoned
    // reply, getBranch() does not (installed _buildIndex + getBranch).
    sm.branch(first);
    sm.appendSessionInfo('side rename');
    assert.equal(sm.getEntries().length, 3, 'all entries keep the abandoned leg');
    assert.equal(sm.getBranch().length, 2, 'the active branch drops it');
    const point = lib.sessionPoint(sm.getEntries(), sm.getLeafId());
    assert.equal(point.count, 1, 'only the active user entry counts (rename excluded)');
    assert.equal(point.tipId, first, 'the tip is the active leg, not the abandoned reply');
    const filePoint = lib.pointOfSessionFile(sm.getSessionFile());
    assert.deepStrictEqual(filePoint, point, 'the file helper recovers the same active leaf');
    // The abandoned leg is still addressable and says what it says.
    const offPoint = lib.sessionPoint(sm.getEntries(), abandoned);
    assert.equal(offPoint.count, 2, 'the off-branch point names its own content');
    assert.notDeepStrictEqual(offPoint, point, 'active vs off-branch points differ');
  });

  test('topmost identical ancestor over real files: untouched fork climbs, advanced stays', () => {
    const lib = warpLib();
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-anc-')));
    const mainDir = path.join(dir, 'main-sessions');
    const main = RealSM.create(dir, mainDir);
    main.appendMessage({ role: 'user', content: 'one' });
    main.appendMessage({ role: 'assistant', content: 'two' });
    const mainFile = main.getSessionFile();
    const mainPoint = lib.pointOfSessionFile(mainFile);
    // Untouched fork plus the warp's own appends (marker, rename, the
    // real custom_message notice): identical content, so the climb must
    // reach the original — the next fork becomes a SIBLING.
    const forkDir = path.join(dir, 'fork-sessions');
    const fork = RealSM.forkFrom(mainFile, dir, forkDir);
    fork.appendCustomEntry('worktree-warp', { from: '/a', to: '/b' });
    fork.appendSessionInfo('notes · feat-x');
    fork.appendCustomMessageEntry('worktree-warp', 'Worktree warp: now in /b.', true, {});
    const forkFile = fork.getSessionFile();
    assert.equal(fork.getHeader().parentSession, mainFile, 'forkFrom records the parentSession header');
    assert.deepStrictEqual(lib.pointOfSessionFile(forkFile), mainPoint,
      'an untouched fork holds the same filtered point as its parent');
    assert.equal(lib.topmostIdenticalAncestor(forkFile, mainPoint), mainFile,
      'the climb reaches the original through real parentSession links');
    // Real work in the fork: the climb stays — the next fork is its CHILD.
    fork.appendMessage({ role: 'user', content: 'follow-up' });
    const advancedPoint = lib.pointOfSessionFile(forkFile);
    assert.notDeepStrictEqual(advancedPoint, mainPoint, 'real work moves the point');
    assert.equal(lib.topmostIdenticalAncestor(forkFile, advancedPoint), forkFile,
      'an advanced session forks from itself');
  });

  // Public-flow harness: the warp runs through executeWorktreeWarp with
  // the REAL class injected; the switch fake persists the withSession
  // notice into the destination file exactly like the live runtime does
  // (reopened manager appends newer entries), so the record must come
  // from FRESH destination state, never the stale pre-switch manager.
  function countingSM(calls) {
    class Counting extends RealSM {}
    const statics = ['forkFrom', 'create', 'open'];
    for (const name of statics) {
      const original = Counting[name];
      Counting[name] = function (...args) {
        calls.push([name, ...args.slice(0, 2)]);
        return original.apply(this, args);
      };
    }
    return Counting;
  }

  async function warpWithReal({ mod, name, cwd, manager, calls, sent, switches, sessionDir }) {
    const ctx = {
      cwd,
      ui: { notify: () => {}, setStatus: () => {} },
      sessionManager: manager,
      waitForIdle: async () => {},
      switchSession: async (file, options) => {
        switches.push(file);
        if (options && typeof options.withSession === 'function') {
          const replaced = {
            ui: { setStatus: () => {} },
            sendMessage: async (message) => {
              sent.push(message);
              const live = RealSM.open(file);
              live.appendCustomMessageEntry(
                message.customType, message.content, message.display, message.details,
              );
            },
          };
          await options.withSession(replaced);
        }
        return undefined;
      },
    };
    const out = await mod.executeWorktreeWarp(name, ctx, {
      sessionManagerClass: countingSM(calls),
      oscStream: { isTTY: false, write: () => true },
    });
    void sessionDir;
    return out;
  }

  function seedMainWork(root) {
    const sessionDir = path.join(root, '.tmp-real-sessions');
    const main = RealSM.create(root, sessionDir);
    main.appendMessage({ role: 'user', content: 'do the thing' });
    main.appendMessage({ role: 'assistant', content: 'doing it' });
    return { mainFile: main.getSessionFile(), sessionDir };
  }

  test('untouched warp back resumes the original (no fork, no notice, no new file)', async () => {
    const lib = warpLib();
    const { mod } = await loadExtension();
    const root = makeRepo('back');
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    try {
      const target = addWorktree(root, 'feat/real-back');
      const { mainFile, sessionDir } = seedMainWork(root);
      const calls = [];
      const sent = [];
      const switches = [];
      const first = await warpWithReal({
        mod, name: 'feat-real-back', cwd: root,
        manager: RealSM.open(mainFile), calls, sent, switches, sessionDir,
      });
      assert.equal(first.isError, undefined, `first warp succeeds: ${first.text}`);
      assert.equal(calls.filter((c) => c[0] === 'forkFrom').length, 1, 'first visit forks once');
      assert.equal(switches.length, 1, 'the session switched');
      assert.equal(sent.length, 1, 'the real move carries its single confirmation');
      const forkFile = switches[0];
      assert.notEqual(forkFile, mainFile, 'the fork is a new file');
      assert.ok(entryTypes(forkFile).includes('custom_message/worktree-warp'),
        'the live runtime persisted the real notice into the fork');
      const before = fs.readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl')).sort();
      // Straight back with no new work: the fork holds the same content
      // (notice and rename excluded), so the warp RESUMES the original.
      const backCalls = [];
      const backSent = [];
      const backSwitches = [];
      const back = await warpWithReal({
        mod, name: 'principal', cwd: target,
        manager: RealSM.open(forkFile), calls: backCalls, sent: backSent,
        switches: backSwitches, sessionDir,
      });
      assert.equal(back.isError, undefined, `warp back succeeds: ${back.text}`);
      assert.deepStrictEqual(backCalls.filter((c) => c[0] === 'forkFrom'), [],
        'identical points resume: NO new fork for the real notice');
      assert.equal(backSwitches[0], mainFile, 'the way back lands on the exact original file');
      assert.deepStrictEqual(backSent, [], 'resuming sends no second notice');
      assert.deepStrictEqual(
        fs.readdirSync(sessionDir).filter((f) => f.endsWith('.jsonl')).sort(), before,
        'no new session file in the checkout',
      );
      assert.equal(lib.getWarpSession(root, target).sessionFile, forkFile,
        'the destination still names the fork');
    } finally {
      delete process.env.GENTLE_WORKTREE_LIB_DIR;
    }
  });

  test('untouched fork to a second worktree lands as a sibling of the first', async () => {
    const { mod } = await loadExtension();
    const root = makeRepo('sibling');
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    try {
      const first = addWorktree(root, 'feat/real-first');
      addWorktree(root, 'feat/real-second');
      const { mainFile, sessionDir } = seedMainWork(root);
      const calls = [];
      const hop = (name, cwd, file, box) => warpWithReal({
        mod, name, cwd, manager: RealSM.open(file),
        calls: box.calls, sent: box.sent, switches: box.switches, sessionDir,
      });
      const box1 = { calls: [], sent: [], switches: [] };
      await hop('feat-real-first', root, mainFile, box1);
      const forkFile = box1.switches[0];
      // From the untouched fork, warp to the unvisited second checkout:
      // the fork must branch from the ORIGINAL (sibling), never chain.
      const box2 = { calls: [], sent: [], switches: [] };
      const second = await hop('feat-real-second', first, forkFile, box2);
      assert.equal(second.isError, undefined, `second hop succeeds: ${second.text}`);
      const forks = box2.calls.filter((c) => c[0] === 'forkFrom');
      assert.equal(forks.length, 1, 'one fork for the unvisited checkout');
      assert.equal(forks[0][1], mainFile, 'the sibling forks from the ORIGINAL, not the untouched fork');
      assert.notEqual(box2.switches[0], forkFile, 'the sibling is its own file');
      assert.equal(box2.sent.length, 1, 'the real move carries its single confirmation');
    } finally {
      delete process.env.GENTLE_WORKTREE_LIB_DIR;
    }
  });

  test('an advanced session forks its own child, to main or another worktree', async () => {
    const { mod } = await loadExtension();
    const root = makeRepo('child');
    process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
    try {
      const wt = addWorktree(root, 'feat/real-adv');
      addWorktree(root, 'feat/real-other');
      const { mainFile, sessionDir } = seedMainWork(root);
      const box1 = { calls: [], sent: [], switches: [] };
      await warpWithReal({
        mod, name: 'feat-real-adv', cwd: root, manager: RealSM.open(mainFile),
        calls: box1.calls, sent: box1.sent, switches: box1.switches, sessionDir,
      });
      const forkFile = box1.switches[0];
      // Real work in the fork, persisted through the live manager: an
      // assistant reply, its tool result and the follow-up user message.
      const live = RealSM.open(forkFile);
      live.appendMessage({ role: 'assistant', content: 'checking the worktree' });
      live.appendMessage({ role: 'toolResult', content: 'tool output' });
      live.appendMessage({ role: 'user', content: 'follow-up in the worktree' });
      const hop = (name, cwd, box) => warpWithReal({
        mod, name, cwd, manager: RealSM.open(forkFile),
        calls: box.calls, sent: box.sent, switches: box.switches, sessionDir,
      });
      const toMain = { calls: [], sent: [], switches: [] };
      const backOut = await hop('principal', wt, toMain);
      assert.equal(backOut.isError, undefined, `warp to main succeeds: ${backOut.text}`);
      const mainForks = toMain.calls.filter((c) => c[0] === 'forkFrom');
      assert.equal(mainForks.length, 1, 'different points fork instead of resuming');
      assert.equal(mainForks[0][1], forkFile, 'the fork branches from the advanced session itself');
      assert.notEqual(toMain.switches[0], mainFile, 'the switch lands on a new file, not the original');
      assert.equal(toMain.sent.length, 1, 'the real move carries its single confirmation');
      const toOther = { calls: [], sent: [], switches: [] };
      const otherOut = await hop('feat-real-other', wt, toOther);
      assert.equal(otherOut.isError, undefined, `warp to another worktree succeeds: ${otherOut.text}`);
      const otherForks = toOther.calls.filter((c) => c[0] === 'forkFrom');
      assert.equal(otherForks.length, 1, 'different points fork instead of resuming');
      assert.equal(otherForks[0][1], forkFile, 'the fork branches from the advanced session itself');
    } finally {
      delete process.env.GENTLE_WORKTREE_LIB_DIR;
    }
  });
});

describe('warp create preflight on real sessions (allocated-but-missing guard)', { skip: !SM_PATH, concurrency: false }, () => {
  let RealSM = null;
  let mod = null;

  before(async () => {
    assert.ok(SM_PATH, 'no installed Pi SessionManager (set PI_SESSION_MANAGER_PATH)');
    RealSM = (await import(pathToFileURL(SM_PATH).href)).SessionManager;
    ({ mod } = await loadExtension());
    assert.equal(typeof mod.warpCreatePreflight, 'function', 'the preflight is exported for tests');
    assert.equal(typeof mod.warpForkSourceUsable, 'function', 'the fork-source validator is exported for tests');
  });

  test('a persisted session passes: the file names a real session header', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-pre-ok-')));
    const sm = RealSM.create(dir, path.join(dir, 'sessions'));
    sm.appendMessage({ role: 'user', content: 'do the thing' });
    assert.equal(fs.existsSync(sm.getSessionFile()), true, 'the message persisted the file');
    assert.equal(mod.warpForkSourceUsable(sm.getSessionFile()), true, 'the allocated file validates');
    assert.deepEqual(mod.warpCreatePreflight({ sessionManager: sm }), { ok: true });
  });

  test('a fresh allocated session without messages refuses: path set, file missing, nothing in memory', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-pre-fresh-')));
    const sm = RealSM.create(dir, path.join(dir, 'sessions'));
    assert.equal(typeof sm.getSessionFile(), 'string', 'the host allocates the path eagerly');
    assert.equal(fs.existsSync(sm.getSessionFile()), false, 'but nothing is on disk before the first message');
    assert.deepEqual(sm.getEntries(), [], 'and nothing is in memory either');
    assert.equal(mod.warpForkSourceUsable(sm.getSessionFile()), false, 'a bare path is not proof');
    const pre = mod.warpCreatePreflight({ sessionManager: sm });
    assert.equal(pre.ok, false, 'refused before any mutation');
    assert.match(pre.reason, /no persisted session/, 'the refusal names the missing session');
  });

  test('an unpersisted session with entries passes through the carry path', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-pre-carry-')));
    const sm = RealSM.inMemory(dir, undefined, [{ id: 'e1', type: 'message' }]);
    assert.equal(sm.isPersisted(), false, 'really unpersisted');
    assert.deepEqual(mod.warpCreatePreflight({ sessionManager: sm }), { ok: true });
  });

  test('an empty unpersisted session refuses', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-pre-empty-')));
    const sm = RealSM.inMemory(dir);
    assert.deepEqual(mod.warpCreatePreflight({ sessionManager: sm }).ok, false);
  });

  test('a garbage file is not a fork source', () => {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-real-pre-garbage-')));
    const garbage = path.join(dir, 'garbage.jsonl');
    fs.writeFileSync(garbage, 'not json\n');
    assert.equal(mod.warpForkSourceUsable(garbage), false, 'unparseable content never forks');
    const headerless = path.join(dir, 'headerless.jsonl');
    fs.writeFileSync(headerless, '{"id":"e1","type":"message"}\n');
    assert.equal(mod.warpForkSourceUsable(headerless), false, 'entries without a session header never fork');
  });
});
