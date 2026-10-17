'use strict';
// T1 (customize-command S1,S2,S3,S5,S6,S10,S12) tests: the
// `/herdr-gentle:customize` command in extensions/gentle-worktree-tools.ts.
//
// Contract under test (observable behavior only — the select/custom calls,
// the exact notified text, the mode file bytes, and whether ctx.reload was
// called; never internal function names):
// - registered unconditionally next to /herdr-gentle:warp (the three old
//   commands are gone — S7);
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

  test('the three old commands are gone and the two new ones are registered (S7)', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { commands } = await loadExtension();
      assert.ok(!commands.has('herdr-gentle:worktree'), 'the worktree toggle is removed outright (S7)');
      assert.ok(commands.has('herdr-gentle:warp'), 'warp stays registered');
      assert.ok(commands.has('herdr-gentle:customize'), 'customize stays registered');
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
        'Customize · Herdr Gentle Shell',
        'CATEGORIES',
        'Agentes sidebar',
        'Moshi notifications',
        'Worktree tools',
        'Gentle (this extension)',
        'publishes agent state and SessionChanges from Gentle',
        'Native Herdr',
        'Preview · Gentle (this extension)',
        '←/→ or Tab panes · ↑/↓ move · Enter apply · Esc close',
      ]) {
        assert.ok(seen().includes(copy), `panel copy missing: ${copy}`);
      }
      assert.ok(seen().includes('→'), 'the active row carries the → marker');
      component.handleInput('down');
      for (const copy of [
        'Moshi notifications',
        'On',
        'Off',
        'leaves notifications to the host',
        'Preview · Off',
      ]) {
        assert.ok(seen().includes(copy), `panel copy missing: ${copy}`);
      }
      component.handleInput('down');
      for (const copy of [
        'Worktree tools',
        'Enabled',
        'agents can create, list, close, warp between and open sessions in agent worktrees',
        'Disabled',
        'Preview · Enabled',
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
          assert.ok(first.includes('▸ Agentes sidebar'), 'cursor starts on the first category');
          component.handleInput('down');
          assert.equal(host.paints.length, 1, 'a selection change requests a repaint');
          const second = component.render(100).join('\n');
          assert.ok(second.includes('▸ Moshi notifications'), 'the cursor moved');
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

  test('loaded while disabled, worktree Enabled reloads to register and Disabled does not', async () => {
    // Carried over from the removed mode-command suite: the
    // `enabled !== toolsRegistered` predicate in the other direction.
    for (const pick of ['enabled', 'disabled']) {
      const modeEnv = scratchStateEnv();
      setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
      const { slot } = stubSlot();
      const hadSlot = setSlot(slot);
      try {
        modeLib().writeMode(false, process.env);
        const { commands, mod } = await loadExtension();
        installTuiLoader(mod, async () => stubTui);
        const host = makeHostTui();
        // worktree rows: Enabled first, Disabled second; loaded disabled
        // means the cursor starts on Disabled.
        const keys = pick === 'enabled'
          ? ['down', 'down', 'right', 'up', 'enter']
          : ['down', 'down', 'right', 'enter'];
        const { ctx, notes, seq } = makeCtx({
          customImpl: async (factory) => (await driveContract(factory, host, keys)).result,
        });
        await customizeDef(commands).handler('', ctx);
        assert.equal(
          modeBytes(),
          pick === 'enabled' ? '{"version":1,"enabled":true}\n' : '{"version":1,"enabled":false}\n',
          'the mode file is written either way',
        );
        assert.equal(notes.length, 1);
        if (pick === 'enabled') {
          assert.deepEqual(seq, [`notify:${notes[0][0]}`, 'reload'], 'enabling an unregistered runtime reloads after notify');
        } else {
          assert.ok(!seq.includes('reload'), 'repeating the unregistered state needs no reload');
        }
      } finally {
        setSlot(hadSlot);
        restoreEnv();
      }
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

describe('customize two-column card geometry', { concurrency: false }, () => {
  // RED (T5/S2): the panel must render as one bordered card with two
  // side-by-side panes — categories left, values right of a vertical
  // divider — like the gentle-shell reference, not as stacked flat text.
  // Every assertion below is geometric: row counts, exact line widths,
  // divider column coordinates, and focus movement — never bare copy.
  function stripAnsi(line) {
    return String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
  }

  function visible(line) {
    return [...stripAnsi(line)].length;
  }

  async function openPanel({ terminalRows } = {}) {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, customs } = makeCtx({ customImpl: async () => {} });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'expected exactly one custom() call');
      const host = makeHostTui();
      if (terminalRows !== undefined) host.tui.terminal = { rows: terminalRows };
      const opened = openComponent(customs[0][0], host);
      return { ...opened, host, cleanup: () => { setSlot(hadSlot); restoreEnv(); } };
    } catch (err) {
      setSlot(hadSlot);
      restoreEnv();
      throw err;
    }
  }

  // Divider column of the two-pane body: every content row that carries
  // a divider carries exactly one │ strictly inside the borders, at the
  // same visible column. Title, preview and footer rows carry none.
  function dividerColumn(lines) {
    const columns = new Set();
    let divided = 0;
    for (const line of lines.slice(1, -1)) {
      const plain = stripAnsi(line);
      if (!plain.startsWith('│') || !plain.endsWith('│')) return null;
      const inner = plain.slice(1, -1);
      const at = [];
      for (let i = 0; i < inner.length; i += 1) {
        if (inner[i] === '│') at.push(i);
      }
      if (at.length > 1) return null;
      if (at.length === 1) {
        divided += 1;
        columns.add(at[0]);
      }
    }
    return divided > 0 && columns.size === 1 ? [...columns][0] : null;
  }

  for (const width of [60, 80, 100]) {
    test(`width ${width}: one bordered card, every row exactly ${width} columns`, async () => {
      const { component, cleanup } = await openPanel();
      try {
        const lines = component.render(width);
        assert.ok(lines.length >= 12, `a card needs room for two panes, got ${lines.length} rows`);
        for (const line of lines) {
          assert.equal(visible(line), width, `row is not ${width} columns: ${JSON.stringify(stripAnsi(line))}`);
        }
        assert.ok(stripAnsi(lines[0]).startsWith('╭') && stripAnsi(lines[0]).endsWith('╮'), 'card opens with a top border');
        const last = stripAnsi(lines[lines.length - 1]);
        assert.ok(last.startsWith('╰') && last.endsWith('╯'), 'card closes with a bottom border');
      } finally {
        cleanup();
      }
    });

    test(`width ${width}: categories left and values right of one stable divider`, async () => {
      const { component, cleanup } = await openPanel();
      try {
        const lines = component.render(width);
        const column = dividerColumn(lines);
        assert.ok(column !== null && column > 10, `expected one stable inner divider column, got ${column}`);
        const body = lines.slice(1, -1).map(stripAnsi);
        const leftOf = (line) => line.slice(1, 1 + column);
        const rightOf = (line) => line.slice(1 + column + 1, -1);
        assert.ok(leftOf(body[1]).includes('CATEGORIES'), 'left heading sits left of the divider');
        assert.ok(rightOf(body[1]).includes('· 1/2'), 'right heading names the category with i/N right of the divider');
        assert.ok(leftOf(body[2]).includes('Agentes sidebar'), 'first category sits left of the divider');
        assert.ok(rightOf(body[2]).includes('Gentle (this extension)'), 'first value sits right of the divider');
      } finally {
        cleanup();
      }
    });

    test(`width ${width}: title and esc share the top row`, async () => {
      const { component, cleanup } = await openPanel();
      try {
        const top = stripAnsi(component.render(width)[1]);
        assert.ok(top.includes('Customize · Herdr Gentle Shell'), 'title on the top row');
        const inside = top.slice(0, -1).trimEnd();
        assert.ok(inside.endsWith('esc'), 'esc aligned to the top-right of the same row');
        assert.ok(top.indexOf('Customize · Herdr Gentle Shell') < top.indexOf('esc'), 'title stays left of esc');
      } finally {
        cleanup();
      }
    });
  }

  test('input navigation moves the visible focus highlight, not just the model', async () => {
    const { component, cleanup } = await openPanel();
    try {
      const rightFocusRow = (width) => {
        const lines = component.render(width).slice(1, -1).map(stripAnsi);
        const column = dividerColumn(component.render(width));
        assert.ok(column !== null, 'precondition: two panes with a divider');
        for (let i = 0; i < lines.length; i += 1) {
          const right = lines[i].slice(1 + column + 1, -1);
          if (right.includes('▸')) return i;
        }
        return -1;
      };
      component.handleInput('right');
      const before = rightFocusRow(80);
      assert.ok(before >= 0, 'values pane shows a ▸ focus row once focused');
      component.handleInput('down');
      const after = rightFocusRow(80);
      assert.ok(after >= 0 && after !== before, `focus visibly moved from row ${before} to ${after}`);
    } finally {
      cleanup();
    }
  });

  test('narrow width clips to a single navigable pane instead of squeezing two', async () => {
    const { component, cleanup } = await openPanel();
    try {
      const lines = component.render(50);
      for (const line of lines) assert.equal(visible(line), 50, 'every narrow row still fits');
      assert.equal(dividerColumn(lines), null, 'no inner divider in single-pane mode');
      const text = lines.map(stripAnsi).join('\n');
      assert.ok(text.includes('Agentes sidebar') && text.includes('Worktree tools'), 'categories stay navigable');
    } finally {
      cleanup();
    }
  });

  test('constrained height clips the card to the available rows', async () => {
    const { component, cleanup } = await openPanel({ terminalRows: 12 });
    try {
      const lines = component.render(80);
      assert.equal(lines.length, 12, `card clips to 12 rows, got ${lines.length}`);
      for (const line of lines) assert.equal(visible(line), 80, 'every clipped row still fits');
      assert.ok(stripAnsi(lines[0]).startsWith('╭'), 'clipped card keeps its top border');
      assert.ok(stripAnsi(lines[lines.length - 1]).startsWith('╰'), 'clipped card keeps its bottom border');
    } finally {
      cleanup();
    }
  });

  test('full height keeps the preview section and the footer inside the card', async () => {
    const { component, cleanup } = await openPanel();
    try {
      const text = component.render(80).map(stripAnsi).join('\n');
      assert.ok(text.includes('Preview · Gentle (this extension)'), 'preview names the focused choice');
      assert.ok(text.includes('←/→ or Tab panes · ↑/↓ move · Enter apply · Esc close'), 'footer survives inside the card');
    } finally {
      cleanup();
    }
  });

  test('the card paints through the injected theme instead of hardcoding escapes', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot();
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, customs } = makeCtx({ customImpl: async () => {} });
      await customizeDef(commands).handler('', ctx);
      const roles = [];
      const theme = { fg: (role, text) => { roles.push(role); return text; } };
      let settled = 'pending';
      const component = customs[0][0](makeHostTui().tui, theme, {}, (result) => { settled = result; });
      assert.equal(settled, 'pending');
      const lines = component.render(80);
      assert.ok(lines.length > 0, 'themed render produces rows');
      for (const role of ['border', 'accent', 'muted']) {
        assert.ok(roles.includes(role), `theme.fg paints the ${role} role`);
      }
      for (const line of lines) assert.ok(!line.includes('\x1b'), 'injected theme adds no escapes of its own here');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

describe('customize label-only rows with focused preview', { concurrency: false }, () => {
  // Panel fix: right-pane rows are LABELS ONLY (gentle-shell
  // visual-customize-view style) — the focused choice's S2 detail
  // appears ONCE in the bottom block as `Preview · <focused label>`
  // plus the description line, never under each row.
  function stripRowAnsi(line) {
    return String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
  }

  async function openSidebarPanel() {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      modeLib().writeMode(true, process.env);
      const { commands, mod } = await loadExtension();
      installTuiLoader(mod, async () => stubTui);
      const { ctx, customs } = makeCtx({ customImpl: async () => {} });
      await customizeDef(commands).handler('', ctx);
      assert.equal(customs.length, 1, 'expected exactly one custom() call');
      const host = makeHostTui();
      const opened = openComponent(customs[0][0], host);
      return { ...opened, host, cleanup: () => { setSlot(hadSlot); restoreEnv(); } };
    } catch (err) {
      setSlot(hadSlot);
      restoreEnv();
      throw err;
    }
  }

  const countIn = (text, needle) => text.split(needle).length - 1;

  for (const width of [60, 80, 100]) {
    test(`width ${width}: right pane rows are label-only, the focused detail appears exactly once`, async () => {
      const { component, cleanup } = await openSidebarPanel();
      try {
        const text = component.render(width).map(stripRowAnsi).join('\n');
        // Both rows render as labels; the active value keeps its → mark.
        assert.ok(text.includes('Gentle (this extension)'), 'focused row label renders');
        assert.ok(text.includes('Native Herdr'), 'unfocused row label renders');
        assert.ok(text.includes('→'), 'the active row keeps the → marker');
        // The heading still names the category with i/N.
        assert.ok(text.includes('Agentes sidebar · 1/2'), 'heading still renders');
        // No per-row detail line: the unfocused row's detail is absent.
        assert.equal(countIn(text, "hands the pane back to Herdr's own agent state"), 0, 'unfocused detail renders nowhere');
        // The focused row's detail appears exactly once, in the bottom block.
        assert.equal(countIn(text, 'publishes agent state and SessionChanges from Gentle'), 1, 'focused detail appears exactly once');
        assert.ok(text.includes('Preview · Gentle (this extension)'), 'bottom block names the focused label');
        assert.ok(!text.includes('Active:'), 'the redundant Active: repeat is gone');
      } finally {
        cleanup();
      }
    });
  }

  test('moving the value focus swaps only the preview description', async () => {
    const { component, cleanup } = await openSidebarPanel();
    try {
      component.handleInput('right');
      component.handleInput('down');
      const text = component.render(80).map(stripRowAnsi).join('\n');
      assert.ok(text.includes('Preview · Native Herdr'), 'bottom block follows the focused label');
      assert.equal(countIn(text, "hands the pane back to Herdr's own agent state"), 1, 'new focused detail appears exactly once');
      assert.equal(countIn(text, 'publishes agent state and SessionChanges from Gentle'), 0, 'old focused detail is gone');
      assert.ok(text.includes('→'), 'the active marker stays on the active value');
      assert.ok(text.includes('Agentes sidebar · 2/2'), 'the heading tracks the focused row');
    } finally {
      cleanup();
    }
  });

  test('moving across categories swaps only the preview description', async () => {
    const { component, cleanup } = await openSidebarPanel();
    try {
      component.handleInput('down');
      const text = component.render(80).map(stripRowAnsi).join('\n');
      assert.ok(text.includes('Preview · Off'), 'bottom block follows the new category focus');
      assert.equal(countIn(text, 'leaves notifications to the host'), 1, 'new focused detail appears exactly once');
      assert.equal(countIn(text, 'notifies ask and finish episodes through Moshi'), 0, 'unfocused moshi detail renders nowhere');
      assert.equal(countIn(text, 'publishes agent state and SessionChanges from Gentle'), 0, 'previous category detail is gone');
    } finally {
      cleanup();
    }
  });
});

describe('worktree registration under an injected state dir (S15)', { concurrency: false }, () => {
  const WORKTREE_TOOLS = ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open', 'worktree_warp'];

  // A sandbox XDG state home plus an injected (new-id) dir. A stored flag
  // means <sandbox>/herdr/plugins/herdr-gentle-agents holds the mode file.
  function injectedSandbox(storedDoc) {
    const sandbox = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-panel-xdg-')));
    const injected = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-panel-injected-')));
    if (storedDoc !== undefined) {
      const stored = path.join(sandbox, 'herdr', 'plugins', 'herdr-gentle-agents');
      fs.mkdirSync(stored, { recursive: true });
      fs.writeFileSync(path.join(stored, 'gentle-worktree-mode.json'), `${JSON.stringify(storedDoc)}\n`);
    }
    return { injected, sandbox };
  }

  test('a stored disabled flag leaves the tools unregistered', async () => {
    const { injected, sandbox } = injectedSandbox({ version: 1, enabled: false });
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: undefined,
      HERDR_PLUGIN_STATE_DIR: injected,
      XDG_STATE_HOME: sandbox,
    });
    const hadSlot = setSlot(undefined);
    try {
      const { tools, commands } = await loadExtension();
      for (const name of WORKTREE_TOOLS) {
        assert.ok(!tools.has(name), `${name} must stay unregistered while the stored flag is disabled`);
      }
      assert.ok(commands.has('herdr-gentle:warp'), 'warp stays registered');
      assert.ok(commands.has('herdr-gentle:customize'), 'customize stays registered');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('a stored enabled flag registers the tools', async () => {
    const { injected, sandbox } = injectedSandbox({ version: 1, enabled: true });
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: undefined,
      HERDR_PLUGIN_STATE_DIR: injected,
      XDG_STATE_HOME: sandbox,
    });
    const hadSlot = setSlot(undefined);
    try {
      const { tools } = await loadExtension();
      for (const name of WORKTREE_TOOLS) {
        assert.ok(tools.has(name), `${name} must register while the stored flag is enabled`);
      }
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('an explicit disabled dir wins over injected and stored dirs', async () => {
    const { injected, sandbox } = injectedSandbox({ version: 1, enabled: true });
    const explicit = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-panel-explicit-')));
    fs.writeFileSync(path.join(explicit, 'gentle-worktree-mode.json'), '{"version":1,"enabled":false}\n');
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: explicit,
      HERDR_PLUGIN_STATE_DIR: injected,
      XDG_STATE_HOME: sandbox,
    });
    const hadSlot = setSlot(undefined);
    try {
      const { tools } = await loadExtension();
      for (const name of WORKTREE_TOOLS) {
        assert.ok(!tools.has(name), `${name} must stay unregistered under an explicit disabled dir`);
      }
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('customize status reports the stored worktree state under an injected dir', async () => {
    const { injected, sandbox } = injectedSandbox({ version: 1, enabled: false });
    setEnv({
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: undefined,
      HERDR_PLUGIN_STATE_DIR: injected,
      XDG_STATE_HOME: sandbox,
    });
    const { slot } = stubSlot({ sidebarRead: 'gentle', moshiRead: 'off' });
    const hadSlot = setSlot(slot);
    try {
      const { commands } = await loadExtension();
      const { ctx, notes } = makeCtx();
      await customizeDef(commands).handler('status', ctx);
      assert.equal(notes.length, 1);
      assert.equal(notes[0][0], 'customize status: sidebar=gentle moshi=off worktree=disabled');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});

describe('single Worktree tools switch covers the session and warp tools (S21, T40)', { concurrency: false }, () => {
  // The extension registers exactly five tools and two of them move or open
  // sessions; the single mode gate governs all five (S21 verified
  // inventory, T40 adds the agent warp). These tests pin that the one switch
  // stays the whole story: the copy names the session and warp coverage,
  // enabled registers exactly the five tools, disabled registers none, and
  // every disabled-path refusal keeps its exact bytes.
  const FOUR = ['worktree_close', 'worktree_create', 'worktree_list', 'worktree_session_open', 'worktree_warp'];
  const REFUSAL =
    'worktree tools are disabled; open /herdr-gentle:customize and apply the Worktree tools Enabled row to enable them';
  const ENABLED_DETAIL = 'agents can create, list, close, warp between and open sessions in agent worktrees';

  function textOf(result) {
    return (result.content || []).map((part) => part.text || '').join('\n');
  }

  test('the Enabled row names the session coverage in its exact bytes', async () => {
    // Byte pin on the switch's own copy: one short line, same shape as
    // the other detail strings. (The panel render path asserting this
    // copy is visible lives in the customize panel test above.)
    const line =
      '{ id: "enabled", label: "Enabled", detail: "agents can create, list, close, warp between and open sessions in agent worktrees" }';
    assert.equal(srcText.split(line).length - 1, 1, 'the Enabled worktree row keeps its exact copy');
    assert.ok(ENABLED_DETAIL.includes('open sessions'), 'the coverage names opening sessions');
    assert.ok(ENABLED_DETAIL.includes('warp'), 'the coverage names the warp capability');
  });

  test('enabled registers exactly the five tools including the session opener and the warp', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { tools } = await loadExtension();
      assert.deepEqual(
        [...tools.keys()].sort(),
        [...FOUR].sort(),
        'enabled registers exactly the five tools, no more and no fewer',
      );
      assert.ok(tools.has('worktree_session_open'), 'the single session tool is among them');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('disabled registers no tool at all', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(false, process.env);
      const { tools } = await loadExtension();
      assert.deepEqual([...tools.keys()], [], 'disabled registers none of the five tools');
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });

  test('every tool refuses with the byte-identical disabled message', async () => {
    const modeEnv = scratchStateEnv();
    setEnv({ GENTLE_WORKTREE_LIB_DIR: LIB_DIR, ...modeEnv });
    const hadSlot = setSlot(undefined);
    try {
      modeLib().writeMode(true, process.env);
      const { tools } = await loadExtension();
      assert.deepEqual(
        [...tools.keys()].sort(),
        [...FOUR].sort(),
        'precondition: all five tools are registered while enabled',
      );
      // The mode gate runs before any repo or backend access, so these
      // calls need no fixture repository and no Herdr/gh shim: a plain
      // refusal is the whole observable effect.
      modeLib().writeMode(false, process.env);
      const calls = [
        ['worktree_create', { branch: 'feat/off' }],
        ['worktree_list', {}],
        ['worktree_close', { branch: 'feat/off' }],
        ['worktree_session_open', { worktree: 'feat-off' }],
        ['worktree_warp', { name: 'feat-off' }],
      ];
      for (const [name, params] of calls) {
        const tool = tools.get(name);
        assert.ok(tool, `${name} is registered`);
        const result = await tool.execute('call-1', params, undefined, undefined, {});
        assert.equal(result.isError, true, `${name} refuses while disabled`);
        assert.equal(textOf(result), REFUSAL, `${name} refusal keeps its exact bytes`);
      }
    } finally {
      setSlot(hadSlot);
      restoreEnv();
    }
  });
});
