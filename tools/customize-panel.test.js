'use strict';
// T1 (customize-command S1,S2,S3,S5,S6,S10,S12) tests: the
// `/herdr-gentle:customize` command in extensions/gentle-worktree-tools.ts.
//
// Contract under test (observable behavior only — the select/custom calls,
// the exact notified text, the mode file bytes, and whether ctx.reload was
// called; never internal function names):
// - registered unconditionally next to the old commands (which stay);
// - no argument opens the two-pane panel through ctx.ui.custom with the
//   exact overlay options, and writes nothing until Enter;
// - Esc closes with zero writes;
// - worktree Disabled writes the mode file and reloads per the
//   registration predicate (enabled !== toolsRegistered), while Enabled
//   while already registered does not reload;
// - sidebar/moshi choices reach the provider slot with the right value and
//   reload exactly when the provider said so;
// - a missing or malformed provider renders the category unavailable and
//   Enter on it writes nothing;
// - `customize status` prints the fixed one-line-per-switch summary and
//   writes nothing;
// - when the TUI helpers cannot be loaded (or ctx.ui.custom is missing)
//   the panel falls back to the plain ctx.ui.select menu and says nothing
//   about /reload.
//
// Loading pattern mirrors tools/worktree-mode-command.test.js: the
// TypeScript extension is plain JS under the hood (// @ts-nocheck, no type
// annotations), so the test copies it to a temporary .mjs path with the
// package import lines stubbed and import()s it with a fake `pi` object.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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

const SLOT_KEY = 'herdr-gentle.customize.v1';
function slotLiteral() {
  return `Symbol.for("${SLOT_KEY}")`;
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

function scratchStateEnv() {
  return { GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-state-'))) };
}

function modeLib() {
  return require('../lib/worktree-mode.js');
}

async function loadExtension() {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-customize-ext-')));
  const copy = path.join(dir, 'gentle-worktree-tools.mjs');
  fs.writeFileSync(copy, stubbed);
  const tools = new Map();
  const commands = new Map();
  const handlers = new Map();
  const pi = {
    registerTool: (tool) => { tools.set(tool.name, tool); },
    registerCommand: (name, def) => { commands.set(name, def); },
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
      return () => {};
    },
  };
  const mod = await import(pathToFileURL(copy).href);
  mod.default(pi);
  return { tools, commands, handlers, mod };
}

function customizeDef(commands) {
  const def = commands.get('herdr-gentle:customize');
  assert.ok(def, 'expected the herdr-gentle:customize command to be registered');
  assert.equal(typeof def.handler, 'function');
  return def;
}

// Stub TUI helpers: the shape S10 names (measure/truncate/match/release).
// Raw input arrives as plain strings in tests ("escape", "enter",
// "up", "down", ...); "release" models a Kitty key-release event.
const stubTui = {
  visibleWidth: (s) => [...String(s)].length,
  truncateToWidth: (s, w) => {
    const chars = [...String(s)];
    return chars.length > w ? chars.slice(0, w).join('') : String(s);
  },
  matchesKey: (key, name) => key === name,
  isKeyRelease: (key) => key === 'release',
};

function installTuiLoader(mod, loader) {
  assert.equal(typeof mod.setCustomizeTuiLoader, 'function', 'expected the injectable TUI loader seam');
  mod.setCustomizeTuiLoader(loader);
}

// Command context. reload/notify order is recorded in seq so tests pin the
// mandatory ordering (panel closed, then notify, then reload).
function makeCtx({ customImpl, selectImpl } = {}) {
  const notes = [];
  const selects = [];
  const customs = [];
  const seq = [];
  const ctx = {
    ui: {
      notify: (message, level) => { notes.push([message, level]); seq.push(`notify:${message}`); },
      select: async (title, options) => {
        selects.push([title, options]);
        if (typeof selectImpl === 'function') return selectImpl(title, options);
        return selectImpl;
      },
    },
    reload: async () => { seq.push('reload'); },
  };
  if (customImpl !== undefined) {
    ctx.ui.custom = async (factory, options) => {
      customs.push([factory, options]);
      return customImpl(factory, options);
    };
  }
  return { ctx, notes, selects, customs, seq };
}

// Fake host TUI: only requestRender() is observable from the panel.
function makeHostTui() {
  const paints = [];
  return {
    paints,
    tui: { requestRender: () => { paints.push(true); } },
  };
}

function failAfter(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

// Open the component through the REAL host factory signature
// (hostTui, theme, keybindings, done) and assert its shape: the host
// delivers keystrokes through handleInput and finishes through done.
function openComponent(factory, host) {
  let settled = 'pending';
  const component = factory(host.tui, {}, {}, (result) => { settled = result; });
  assert.equal(typeof component.render, 'function', 'component must implement render(width)');
  assert.equal(typeof component.handleInput, 'function', 'component must implement handleInput(data)');
  assert.equal(typeof component.invalidate, 'function', 'component must implement invalidate()');
  return { component, done: () => settled };
}

// Feed raw input bytes; the done() value is what ctx.ui.custom() resolves
// with. A component that never calls done() fails fast instead of hanging
// the suite the way the real host would hang the command.
async function driveContract(factory, host, inputs) {
  const { component, done } = openComponent(factory, host);
  for (const input of inputs) component.handleInput(input);
  if (done() === 'pending') {
    await Promise.race([
      (async () => { while (done() === 'pending') await new Promise((r) => setTimeout(r, 10)); })(),
      failAfter(1000, 'done() was never called: ctx.ui.custom() would hang with the overlay owning input'),
    ]);
  }
  return { component, result: done() };
}

function setSlot(slot) {
  const key = Symbol.for(SLOT_KEY);
  const had = Object.hasOwn(globalThis, key) ? globalThis[key] : undefined;
  if (slot === undefined) delete globalThis[key];
  else globalThis[key] = slot;
  return had;
}

function stubSlot({ sidebarRead = 'gentle', moshiRead = 'off', applyImpl } = {}) {
  const applied = [];
  const slot = {
    sidebar: {
      read: () => sidebarRead,
      apply: async (value, ctx) => {
        applied.push(['sidebar', value]);
        if (typeof applyImpl === 'function') return applyImpl('sidebar', value, ctx);
        return { changed: true, needsReload: false, text: `sidebar ${value}` };
      },
    },
    moshi: {
      read: () => moshiRead,
      apply: async (value, ctx) => {
        applied.push(['moshi', value]);
        if (typeof applyImpl === 'function') return applyImpl('moshi', value, ctx);
        return { changed: true, needsReload: false, text: `moshi ${value}` };
      },
    },
  };
  return { slot, applied };
}

function modeBytes() {
  try {
    return fs.readFileSync(modeLib().modePath(process.env), 'utf8');
  } catch {
    return null;
  }
}

describe('customize command registration', { concurrency: false }, () => {
  test('the command is registered under the exact name while enabled', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { commands } = await loadExtension();
      assert.ok(commands.has('herdr-gentle:customize'), `exact name, got ${JSON.stringify([...commands.keys()])}`);
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('the command is registered unconditionally while disabled', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(false, process.env);
      const { commands } = await loadExtension();
      assert.ok(commands.has('herdr-gentle:customize'), 'the panel must exist even while the tools are unregistered');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('the three old commands are still registered (T2 owns their removal)', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { commands } = await loadExtension();
      assert.ok(commands.has('herdr-gentle:worktree'), 'worktree toggle must not disappear in this commit');
      assert.ok(commands.has('herdr-gentle:warp'), 'warp must not disappear in this commit');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('both extensions carry the identical provider slot literal (drift guard)', async () => {
    const worktreeSrc = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts'), 'utf8');
    const stateSrc = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-herdr-state.ts'), 'utf8');
    assert.ok(worktreeSrc.includes(slotLiteral()), 'worktree extension must read the exact slot key');
    assert.ok(stateSrc.includes(slotLiteral()), 'state extension must write the exact slot key');
  });
});

describe('customize panel', { concurrency: false }, () => {
  test('no argument opens the two-pane panel with the exact overlay options and writes nothing until Enter', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, notes, customs, seq } = makeCtx({
        customImpl: async () => {},
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'expected exactly one custom() call');
      assert.deepEqual(customs[0][1], {
        overlay: true,
        overlayOptions: { anchor: 'center', width: '70%', minWidth: 60, maxHeight: '85%' },
      });
      // The factory was captured but never driven: nothing applied.
      assert.equal(applied.length, 0, 'opening the panel must not reach any provider');
      assert.equal(modeBytes(), before, 'opening the panel must not touch the mode file');
      assert.equal(notes.length, 0, 'opening the panel notifies nothing');
      assert.ok(!seq.includes('reload'), 'opening the panel never reloads');
      // The captured factory renders the fixed copy: the left pane lists
      // all three switches, the right pane the focused category's rows.
      // The factory receives the host arguments (tui, theme, keybindings,
      // done) per the host contract.
      const host = makeHostTui();
      const { component, done } = openComponent(customs[0][0], host);
      const seen = () => component.render(100).join('\n');
      for (const copy of [
        'Customize · Gentle Herdr',
        'CATEGORIES',
        'Agentes sidebar',
        'Moshi notifications',
        'Worktree tools',
        'Gentle (this extension)',
        'publishes agent state and SessionChanges from Gentle',
        'Native Herdr',
        'hands the pane back to Herdr\'s own agent state',
        'Preview ·',
        '←/→ or Tab panes · ↑/↓ move · Enter apply · Esc close',
      ]) {
        assert.ok(seen().includes(copy), `panel copy missing: ${copy}`);
      }
      assert.ok(seen().includes('→'), 'the active row carries the → marker');
      component.handleInput('down');
      for (const copy of [
        'Moshi notifications',
        'On',
        'notifies ask and finish episodes through Moshi',
        'Off',
        'leaves notifications to the host',
      ]) {
        assert.ok(seen().includes(copy), `panel copy missing: ${copy}`);
      }
      component.handleInput('down');
      for (const copy of [
        'Worktree tools',
        'Enabled',
        'agents can create, list, close and open sessions in agent worktrees',
        'Disabled',
        'the worktree tools are not registered',
      ]) {
        assert.ok(seen().includes(copy), `panel copy missing: ${copy}`);
      }
      assert.equal(done(), 'pending', 'movement keys never finish the overlay');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('Esc closes with zero writes', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, notes, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => (await driveContract(factory, host, ['escape'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(applied.length, 0, 'Esc must not reach any provider');
      assert.equal(modeBytes(), before, 'Esc must not touch the mode file');
      assert.equal(notes.length, 0, 'Esc notifies nothing');
      assert.ok(!seq.includes('reload'), 'Esc never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('Esc resolves done() with null: no notification, no write, no reload', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, notes, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { result } = await driveContract(factory, host, ['escape']);
          assert.equal(result, null, 'Esc finishes the overlay with null');
          return result;
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(modeBytes(), before, 'Esc writes nothing');
      assert.equal(notes.length, 0, 'Esc notifies nothing');
      assert.ok(!seq.includes('reload'), 'Esc never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a movement key repaints and moves the cursor without finishing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, notes, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { component, done } = openComponent(factory, host);
          const first = component.render(100).join('\n');
          assert.ok(first.includes('> Agentes sidebar'), 'cursor starts on the first category');
          component.handleInput('down');
          assert.equal(host.paints.length, 1, 'a selection change requests a repaint');
          const second = component.render(100).join('\n');
          assert.ok(second.includes('> Moshi notifications'), 'the cursor moved');
          assert.equal(done(), 'pending', 'movement never finishes the overlay');
          component.handleInput('escape');
          assert.equal(done(), null);
          return done();
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(modeBytes(), before, 'navigation writes nothing');
      assert.equal(notes.length, 0, 'navigation notifies nothing');
      assert.ok(!seq.includes('reload'), 'navigation never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a key-release event changes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, notes, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { component, done } = openComponent(factory, host);
          const first = component.render(100).join('\n');
          component.handleInput('release');
          assert.equal(host.paints.length, 0, 'a release requests no repaint');
          assert.equal(component.render(100).join('\n'), first, 'a release moves nothing');
          assert.equal(done(), 'pending', 'a release never finishes the overlay');
          component.handleInput('escape');
          return done();
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(modeBytes(), before, 'a release writes nothing');
      assert.equal(notes.length, 0, 'a release notifies nothing');
      assert.ok(!seq.includes('reload'), 'a release never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('worktree Disabled writes the mode file and reloads after notify when the tools are registered', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes, seq } = makeCtx({
        // sidebar -> moshi -> worktree, values pane, down to Disabled, Enter.
        customImpl: async (factory, options) => {
          assert.deepEqual(options.overlayOptions, { anchor: 'center', width: '70%', minWidth: 60, maxHeight: '85%' });
          const { result } = await driveContract(factory, host, ['down', 'down', 'right', 'down', 'enter']);
          assert.deepEqual(result, { categoryId: 'worktree', valueId: 'disabled' }, 'Enter resolves done() with the choice');
          assert.equal(modeBytes(), '{"version":1,"enabled":true}\n', 'nothing is written while the overlay is still up');
          assert.equal(notes.length, 0, 'nothing is notified while the overlay is still up');
          return result;
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(modeBytes(), '{"version":1,"enabled":false}\n', 'choosing Disabled writes the mode file');
      assert.equal(notes.length, 1, 'exactly one notification');
      assert.ok(!notes[0][0].includes('/reload'), 'the panel never asks the user to run /reload');
      assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload'], 'notify runs before the reload');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('worktree Enabled while already registered writes the file but does not reload', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes, seq } = makeCtx({
        // worktree is already the active row (Enabled); Enter applies it.
        customImpl: async (factory) => (await driveContract(factory, host, ['down', 'down', 'right', 'enter'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(modeBytes(), '{"version":1,"enabled":true}\n', 'the mode file is still written');
      assert.equal(notes.length, 1);
      assert.ok(!notes[0][0].includes('/reload'), 'no /reload instruction');
      assert.ok(!seq.includes('reload'), 'already-registered state needs no reload');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a sidebar choice reaches the provider with the right value and reloads exactly when the provider said so', async () => {
    for (const needsReload of [true, false]) {
      const modeEnv = scratchStateEnv();
      setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
      const { slot, applied } = stubSlot({
        sidebarRead: 'gentle',
        applyImpl: () => ({ changed: true, needsReload, text: 'Gentle sidebar disabled (native renders again).' }),
      });
      const hadSlot = setSlot(slot);
      try {
        modeLib().writeMode(true, process.env);
        const before = modeBytes();
        const { commands, mod } = await loadExtension();
        installTuiLoader(mod, async () => stubTui);
        const host = makeHostTui();
        const { ctx, notes, seq } = makeCtx({
          // sidebar values pane, down to Native Herdr, Enter.
          customImpl: async (factory) => (await driveContract(factory, host, ['right', 'down', 'enter'])).result,
        });
        await customizeDef(commands).handler('', ctx);
        assert.deepEqual(applied, [['sidebar', 'native']], 'the provider gets the chosen value id');
        assert.equal(modeBytes(), before, 'a sidebar choice never touches the worktree mode file');
        assert.equal(notes.length, 1);
        assert.ok(!notes[0][0].includes('/reload'), 'no /reload instruction');
        if (needsReload) {
          assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload'], 'provider needsReload reloads after notify');
        } else {
          assert.ok(!seq.includes('reload'), 'provider needsReload:false never reloads');
        }
      } finally {
        setSlot(hadSlot);
        restoreEnv();
      }
    }
  });

  test('a moshi choice reaches the provider with the right value', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot({
      moshiRead: 'off',
      applyImpl: () => ({ changed: true, needsReload: false, text: 'Moshi notifications enabled.' }),
    });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      const { ctx, notes, seq } = makeCtx({
        // moshi values pane, up to On, Enter.
        customImpl: async (factory) => (await driveContract(factory, host, ['down', 'right', 'up', 'enter'])).result,
      });
      await customizeDef(commands).handler('', ctx);
      assert.deepEqual(applied, [['moshi', 'on']], 'the provider gets the chosen value id');
      assert.equal(modeBytes(), before, 'a moshi choice never touches the worktree mode file');
      assert.equal(notes.length, 1);
      assert.ok(!seq.includes('reload'), 'needsReload:false never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a missing provider renders the category unavailable and Enter on it writes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { component } = openComponent(factory, host);
          const lines = component.render(100).join('\n');
          assert.ok(lines.toLowerCase().includes('unavailable'), 'missing provider renders unavailable');
          const { result } = await driveContract(factory, host, ['right', 'down', 'enter']);
          assert.deepEqual(result, { categoryId: 'sidebar', valueId: 'native' });
          return result;
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.equal(modeBytes(), before, 'Enter on an unavailable category writes nothing');
      assert.ok(!seq.includes('reload'), 'Enter on an unavailable category never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a malformed provider renders the category unavailable and cannot write', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const applied = [];
    const hadSlot = setSlot({ sidebar: null, moshi: { read: () => { throw new Error('broken'); } } });
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const host = makeHostTui();
      let fellBack = false;
      const { ctx, seq } = makeCtx({
        selectImpl: () => { fellBack = true; return undefined; },
        customImpl: async (factory) => {
          const { component } = openComponent(factory, host);
          const lines = component.render(100).join('\n');
          assert.ok(lines.toLowerCase().includes('unavailable'), 'malformed provider renders unavailable');
          const { result } = await driveContract(factory, host, ['down', 'right', 'enter']);
          assert.deepEqual(result, { categoryId: 'moshi', valueId: 'on' });
          return result;
        },
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(fellBack, false, 'the overlay path must not degrade to the menu here');
      assert.deepEqual(applied, [], 'a malformed provider is never called');
      assert.equal(modeBytes(), before, 'Enter on an unavailable category writes nothing');
      assert.ok(!seq.includes('reload'), 'Enter on an unavailable category never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('customize status prints the fixed line and writes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands } = await loadExtension();
      const { ctx, notes, seq } = makeCtx();
      await customizeDef(commands).handler('status', ctx);
      assert.equal(notes.length, 1);
      assert.equal(notes[0][0], 'customize status: sidebar=gentle moshi=off worktree=enabled');
      assert.equal(modeBytes(), before, 'status writes nothing');
      assert.ok(!seq.includes('reload'), 'status never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('an unknown argument prints usage and writes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands } = await loadExtension();
      const { ctx, notes, seq } = makeCtx();
      await customizeDef(commands).handler('frobnicate', ctx);
      assert.equal(notes.length, 1);
      assert.match(notes[0][0], /status/, 'usage names the status verb');
      assert.equal(modeBytes(), before, 'usage writes nothing');
      assert.ok(!seq.includes('reload'), 'usage never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

describe('customize fallback menu', { concurrency: false }, () => {
  test('falls back to ctx.ui.select when the TUI helpers cannot be loaded', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => { throw new Error('no such module'); });
      const answers = ['Worktree tools', 'Disabled'];
      const { ctx, notes, selects, customs, seq } = makeCtx({
        customImpl: async () => { throw new Error('custom must not be called without helpers'); },
        selectImpl: () => answers.shift(),
      });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 0, 'no custom panel without helpers');
      assert.equal(selects.length, 2, 'category then value');
      assert.equal(modeBytes(), '{"version":1,"enabled":false}\n', 'the fallback writes through the same path');
      assert.equal(notes.length, 1);
      assert.ok(!notes[0][0].includes('/reload'), 'the fallback says nothing about /reload');
      assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload']);
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('falls back to ctx.ui.select when ctx.ui.custom is missing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot({
      moshiRead: 'off',
      applyImpl: () => ({ changed: true, needsReload: false, text: 'Moshi notifications enabled.' }),
    });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const answers = ['Moshi notifications', 'On'];
      const { ctx, notes, selects, seq } = makeCtx({
        selectImpl: () => answers.shift(),
      });
      assert.equal(typeof ctx.ui.custom, 'undefined', 'precondition: no custom surface');
      await customizeDef(commands).handler('', ctx);
      assert.equal(selects.length, 2, 'category then value');
      assert.deepEqual(applied, [['moshi', 'on']], 'the fallback reaches the provider with the value id');
      assert.equal(modeBytes(), before, 'a moshi choice never touches the mode file');
      assert.equal(notes.length, 1);
      assert.ok(!notes[0][0].includes('/reload'), 'the fallback says nothing about /reload');
      assert.ok(!seq.includes('reload'), 'needsReload:false never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('cancelling the fallback selector writes nothing', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot, applied } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const before = modeBytes();
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => { throw new Error('no such module'); });
      const { ctx, notes, seq } = makeCtx({ selectImpl: () => undefined });
      await customizeDef(commands).handler('', ctx);
      assert.deepEqual(applied, [], 'cancel reaches no provider');
      assert.equal(modeBytes(), before, 'cancel writes nothing');
      assert.equal(notes.length, 0, 'cancel notifies nothing');
      assert.ok(!seq.includes('reload'), 'cancel never reloads');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});
