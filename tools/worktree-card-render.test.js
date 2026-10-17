'use strict';
// T6/S13 tests (test-first): reusable native Pi worktree tool card renderer.
//
// The renderer lives in lib/worktree-card.js and is pure rendering: given
// the tool name plus the public render hooks (args/result/options/theme/
// context) it returns Pi component objects ({render(width), invalidate}).
// Tests invoke those public hooks and assert geometry — every line fits the
// supplied width at 30/60/100 columns, collapsed cards stay compact, the
// frame keeps its left-accent structure — plus collapsed/expanded, error/
// partial/empty/malformed details, and one semantic summary per tool.
// Text presence alone is never the assertion: width bounds, line budgets
// and frame structure travel with every case.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  createWorktreeCardRenderer,
  createWarpMessageRenderer,
  summarizeWorktreeResult,
  safeText,
} = require('../lib/worktree-card.js');

const TOOLS = ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open', 'worktree_warp'];
const WIDTHS = [30, 60, 100];

// Identity theme: adds no ANSI of its own, so any escape left in a line is
// leaked untrusted input rather than theme paint.
const THEME = {
  bold: (s) => s,
  fg: (_color, s) => s,
};

function stripAnsi(line) {
  // eslint-disable-next-line no-control-regex
  return String(line).replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b\]8;;.*?\x07/g, '');
}

function visible(line) {
  return [...stripAnsi(line)].length;
}

function renderLines(component, width) {
  const lines = component.render(width);
  assert.ok(Array.isArray(lines), 'component.render(width) returns string[]');
  for (const line of lines) assert.strictEqual(typeof line, 'string');
  return lines;
}

function assertFits(lines, width) {
  for (const line of lines) {
    assert.ok(
      visible(line) <= width,
      `line exceeds width ${width}: ${JSON.stringify(stripAnsi(line))}`,
    );
  }
}

function assertFrame(lines) {
  assert.ok(lines.length > 0, 'card renders at least one row');
  for (const line of lines) {
    assert.ok(
      stripAnsi(line).startsWith('▎'),
      `every row carries the accent bar: ${JSON.stringify(stripAnsi(line))}`,
    );
  }
}

function callFor(tool) {
  switch (tool) {
    case 'worktree_create': return { branch: 'feat/cards', issues: [12] };
    case 'worktree_list': return { all: true };
    case 'worktree_close': return { name: 'feat-cards' };
    case 'worktree_session_open': return { worktree: 'feat-cards' };
    case 'worktree_warp': return { name: 'feat-cards' };
    default: throw new Error(`unknown tool ${tool}`);
  }
}

function resultFor(tool) {
  switch (tool) {
    case 'worktree_create':
      return {
        content: [{ type: 'text', text: 'worktree create: /repo/../feat-cards' }],
        details: { path: '/repo/../feat-cards', branch: 'feat/cards', issues: [12], created: true, warnings: [] },
      };
    case 'worktree_list':
      return {
        content: [{ type: 'text', text: 'worktree list: feat-cards feat/cards thread=t issues=12' }],
        details: {
          worktrees: [{ name: 'feat-cards', path: '/repo/../feat-cards', branch: 'feat/cards' }],
          count: 1, all: true, pruned: [], warnings: [],
        },
      };
    case 'worktree_close':
      return {
        content: [{ type: 'text', text: 'worktree close: /repo/../feat-cards' }],
        details: { path: '/repo/../feat-cards', branch: 'feat/cards', removed: true, branchKept: true },
      };
    case 'worktree_session_open':
      return {
        content: [{ type: 'text', text: 'opened: feat-cards · abc123\npath: /repo/../feat-cards' }],
        details: { worktree: 'feat-cards', sessionId: 'abc123', resumed: false, paneId: 'p1', path: '/repo/../feat-cards' },
      };
    case 'worktree_warp':
      return {
        content: [{ type: 'text', text: 'moved: principal\nto: feat-cards\npath: now in "/repo/../feat-cards"\nbranch: now in "feat/cards"' }],
        details: { fromName: 'principal', fromDesc: 'principal · main', name: 'feat-cards', branch: 'feat/cards', path: '/repo/../feat-cards', to: '/repo/../feat-cards' },
      };
    default: throw new Error(`unknown tool ${tool}`);
  }
}

describe('factory contract', () => {
  test('exposes renderShell self plus renderCall/renderResult for every tool', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      assert.strictEqual(card.renderShell, 'self');
      assert.strictEqual(typeof card.renderCall, 'function');
      assert.strictEqual(typeof card.renderResult, 'function');
    }
  });

  test('rejects unknown tool names instead of rendering a blank card', () => {
    assert.throws(() => createWorktreeCardRenderer('bash'), /unknown worktree tool/);
  });

  test('renders deterministically: no leaking timer between passes', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const result = resultFor('worktree_list');
    const first = renderLines(card.renderResult(result, {}, THEME, {}), 60).join('\n');
    const second = renderLines(card.renderResult(result, {}, THEME, {}), 60).join('\n');
    assert.strictEqual(first, second);
  });
});

describe('renderCall geometry', () => {
  for (const tool of TOOLS) {
    test(`${tool}: header fits 30/60/100 and keeps the accent frame`, () => {
      const card = createWorktreeCardRenderer(tool);
      for (const width of WIDTHS) {
        const lines = renderLines(card.renderCall(callFor(tool), THEME, {}), width);
        assertFits(lines, width);
        assertFrame(lines);
        assert.ok(lines.length <= 4, `call card stays compact at ${width}: got ${lines.length} rows`);
      }
    });

    test(`${tool}: malformed args never throw and still fit`, () => {
      const card = createWorktreeCardRenderer(tool);
      for (const bad of [undefined, null, 'feat/x', 42, { branch: { nested: true } }]) {
        const lines = renderLines(card.renderCall(bad, THEME, {}), 60);
        assertFits(lines, 60);
        assertFrame(lines);
      }
    });
  }

  test('narrow widths truncate, zero width renders nothing', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const narrow = renderLines(
      card.renderCall({ branch: 'feat/a-very-long-branch-name-that-keeps-going', issues: [1] }, THEME, {}),
      10,
    );
    assertFits(narrow, 10);
    assertFrame(narrow);
    assert.deepStrictEqual(card.renderCall({ branch: 'feat/x' }, THEME, {}).render(0), []);
  });

  test('ANSI in args is stripped: no raw escape leaks with an identity theme', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const lines = renderLines(
      card.renderCall({ branch: '\x1b[31mfeat/evil\x1b[0m', issues: [1] }, THEME, {}),
      60,
    );
    for (const line of lines) assert.ok(!line.includes('\x1b'), `escape leaked: ${JSON.stringify(line)}`);
  });
});

describe('renderResult geometry and states', () => {
  for (const tool of TOOLS) {
    test(`${tool}: collapsed result fits 30/60/100 inside a compact frame`, () => {
      const card = createWorktreeCardRenderer(tool);
      for (const width of WIDTHS) {
        const lines = renderLines(card.renderResult(resultFor(tool), { expanded: false }, THEME, {}), width);
        assertFits(lines, width);
        assertFrame(lines);
        assert.ok(lines.length <= 6, `collapsed card stays compact at ${width}: got ${lines.length} rows`);
      }
    });

    test(`${tool}: expanded preserves the full result text`, () => {
      const card = createWorktreeCardRenderer(tool);
      const longText = ['line one', 'line two', 'line three', 'line four', 'line five'].join('\n');
      const result = { content: [{ type: 'text', text: longText }], details: resultFor(tool).details };
      const collapsed = renderLines(card.renderResult(result, { expanded: false }, THEME, {}), 100);
      const expanded = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), 100);
      assertFits(expanded, 100);
      assertFrame(expanded);
      assert.ok(expanded.length >= collapsed.length, 'expanded shows at least as much as collapsed');
      for (const line of ['line four', 'line five']) {
        assert.ok(expanded.join('\n').includes(line), `expanded keeps ${JSON.stringify(line)}`);
      }
      assert.ok(
        collapsed.join('\n').split('\n').length <= 6,
        'collapsed stays bounded while expanded grows',
      );
    });

    test(`${tool}: error results keep the frame and surface the failure`, () => {
      const card = createWorktreeCardRenderer(tool);
      const failed = {
        content: [{ type: 'text', text: 'worktree exploded: bad things happened' }],
        details: resultFor(tool).details,
        isError: true,
      };
      const lines = renderLines(card.renderResult(failed, { expanded: false }, THEME, {}), 60);
      assertFits(lines, 60);
      assertFrame(lines);
      assert.ok(lines.join('\n').includes('bad things happened'), 'error text reaches the card');
    });

    test(`${tool}: partial results stay bounded and marked as running`, () => {
      const card = createWorktreeCardRenderer(tool);
      const lines = renderLines(card.renderResult(resultFor(tool), { expanded: false, isPartial: true }, THEME, {}), 60);
      assertFits(lines, 60);
      assertFrame(lines);
      assert.ok(lines.join('\n').includes('…'), 'partial card carries the running marker');
    });

    test(`${tool}: malformed details never throw and still fit`, () => {
      const card = createWorktreeCardRenderer(tool);
      for (const details of [undefined, null, 'nope', 42, []]) {
        const lines = renderLines(
          card.renderResult({ content: [{ type: 'text', text: 'some text' }], details }, {}, THEME, {}),
          60,
        );
        assertFits(lines, 60);
        assertFrame(lines);
      }
    });
  }

  test('empty result text renders a placeholder inside the frame', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const lines = renderLines(
      card.renderResult({ content: [{ type: 'text', text: '' }], details: { worktrees: [], count: 0 } }, {}, THEME, {}),
      60,
    );
    assertFits(lines, 60);
    assertFrame(lines);
    assert.ok(lines.join('\n').includes('(no output)'), 'empty result says so');
  });

  test('warnings travel in the expanded body', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const result = resultFor('worktree_create');
    result.details.warnings = ['pruned 1 stale worktree record(s)'];
    const expanded = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), 100);
    assert.ok(expanded.join('\n').includes('pruned 1 stale'), 'warning survives expansion');
  });

  test('duration only renders from lifecycle evidence, never fabricated', () => {
    const card = createWorktreeCardRenderer('worktree_close');
    const plain = renderLines(card.renderResult(resultFor('worktree_close'), {}, THEME, {}), 60).join('\n');
    assert.ok(!plain.includes('1.2s'), 'no duration without evidence');
    const timed = renderLines(
      card.renderResult(resultFor('worktree_close'), {}, THEME, { durationMs: 1200 }),
      60,
    );
    assertFits(timed, 60);
    assert.ok(timed.join('\n').includes('1.2s'), 'evidence-backed duration renders');
  });
});

describe('semantic summaries', () => {
  test('create names the branch', () => {
    assert.ok(summarizeWorktreeResult('worktree_create', resultFor('worktree_create')).includes('feat/cards'));
  });

  test('list reports the checkout count', () => {
    const summary = summarizeWorktreeResult('worktree_list', resultFor('worktree_list'));
    assert.ok(summary.includes('1'), `count visible in ${JSON.stringify(summary)}`);
  });

  test('list with zero checkouts says so', () => {
    const summary = summarizeWorktreeResult('worktree_list', {
      content: [{ type: 'text', text: 'worktree list: none' }],
      details: { worktrees: [], count: 0 },
    });
    assert.ok(/no worktrees/i.test(summary), `empty listing reads clearly: ${JSON.stringify(summary)}`);
  });

  test('close names the removed checkout', () => {
    const summary = summarizeWorktreeResult('worktree_close', resultFor('worktree_close'));
    assert.ok(summary.includes('feat-cards'), `removed path visible in ${JSON.stringify(summary)}`);
  });

  test('session_open names the worktree and session', () => {
    const summary = summarizeWorktreeResult('worktree_session_open', resultFor('worktree_session_open'));
    assert.ok(summary.includes('feat-cards'), 'worktree visible');
    assert.ok(summary.includes('abc123'), 'session visible');
  });

  test('error results summarize as errors without hiding the message', () => {
    const summary = summarizeWorktreeResult('worktree_create', {
      content: [{ type: 'text', text: 'invalid branch name "a..b": bad pattern' }],
      details: { branch: 'a..b' },
      isError: true,
    });
    assert.ok(summary.includes('a..b'), `failing input stays visible: ${JSON.stringify(summary)}`);
  });

  test('safeText strips escapes and control characters', () => {
    assert.ok(!safeText('\x1b[31mhi\x1b[0m\x07').includes('\x1b'));
    assert.strictEqual(typeof safeText(undefined), 'string');
  });
});

describe('call/result pair coherence', () => {
  // renderShell:self draws ONE coherent card: while no result exists the
  // call closes its own frame; once the result marks the shared row state,
  // the call drops to the top rule and the result body closes the frame.
  // Two independent full cards stacked is the defect this pins.
  test('call drops its closing rule once the shared row state carries a result', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const state = {};
    const callArgs = { branch: 'feat/cards', issues: [12] };
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const lone = card.renderCall(callArgs, theme, { state }).render(60);
    assert.ok(lone.some((line) => line.includes('─')), 'awaiting call closes its own frame');
    const loneRows = lone.length;
    card.renderResult(resultFor('worktree_create'), { expanded: false }, theme, { state });
    const paired = card.renderCall(callArgs, theme, { state }).render(60);
    assert.ok(paired.length < loneRows, 'paired call drops to the top rule');
    assert.ok(!paired.some((line) => line.includes('─')), 'paired call leaves the closing rule to the result');
    const body = card.renderResult(resultFor('worktree_create'), { expanded: false }, theme, { state }).render(60);
    assert.ok(body.some((line) => line.includes('─')), 'the result closes the shared frame');
  });

  test('options.durationMs is ignored: only host context timing renders', () => {
    const card = createWorktreeCardRenderer('worktree_close');
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const lines = card.renderResult(resultFor('worktree_close'), { durationMs: 1200 }, theme, {}).render(60);
    assert.ok(!lines.join('\n').includes('1.2s'), 'uncontracted options timing never renders');
  });
});

describe('extension wiring', () => {
  // The five registered tools carry the card hooks from the REAL
  // extension module (loaded through the repo harness), without touching
  // execute/schemas/content/details. Helpers resolve through the
  // injectable seam, so tests prove runtime injection — including real
  // pi-tui width measurement over emoji — instead of the local fallback.
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');
  const { pathToFileURL } = require('node:url');

  const LIB_DIR = path.resolve(__dirname, '../lib');
  const SRC = path.resolve(__dirname, '../extensions/gentle-worktree-tools.ts');

  async function loadWiredExtension() {
    const srcText = fs.readFileSync(SRC, 'utf8');
    const stubbed = srcText
      .replace(
        'import { Type } from "@earendil-works/pi-ai";',
        'const Type = { Object: (p) => p, String: (o) => o, Number: (o) => o, Array: (i, o) => o, Boolean: (o) => o, Optional: (s) => s };',
      )
      .replace(
        'import { defineTool } from "@earendil-works/pi-coding-agent";',
        'const defineTool = (def) => def;',
      );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wt-card-wire-'));
    try {
      const copy = path.join(dir, 'gentle-worktree-tools.mjs');
      fs.writeFileSync(copy, stubbed);
      const tools = new Map();
      const pi = { registerTool: (tool) => { tools.set(tool.name, tool); }, registerCommand: () => {}, on: () => () => {} };
      // The card hooks resolve lib/ at module evaluation time, so the lib
      // dir must be set before the import — like every other suite's
      // setEnv-before-loadExtension pattern.
      process.env.GENTLE_WORKTREE_LIB_DIR = LIB_DIR;
      const mod = await import(pathToFileURL(copy).href);
      mod.default(pi);
      return { mod, tools };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  const WIRED = ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open', 'worktree_warp'];

  test('all five tools expose renderShell self with renderCall/renderResult hooks', async () => {
    const { tools } = await loadWiredExtension();
    for (const name of WIRED) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} is registered while enabled`);
      assert.strictEqual(tool.renderShell, 'self', `${name} draws its own shell`);
      assert.strictEqual(typeof tool.renderCall, 'function', `${name} wires renderCall`);
      assert.strictEqual(typeof tool.renderResult, 'function', `${name} wires renderResult`);
      assert.strictEqual(typeof tool.execute, 'function', `${name} keeps its execute`);
      assert.ok(tool.parameters, `${name} keeps its schema`);
    }
  });

  test('wired hooks render fitting framed components for every tool', async () => {
    const { tools } = await loadWiredExtension();
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const argsFor = {
      worktree_create: { branch: 'feat/cards', issues: [12] },
      worktree_list: { all: true },
      worktree_close: { name: 'feat-cards' },
      worktree_session_open: { worktree: 'feat-cards' },
      worktree_warp: { name: 'feat-cards' },
    };
    for (const name of WIRED) {
      const tool = tools.get(name);
      for (const width of [30, 60, 100]) {
        for (const lines of [
          tool.renderCall(argsFor[name], theme, {}).render(width),
          tool.renderResult(
            { content: [{ type: 'text', text: `${name} ok` }], details: {} },
            { expanded: false },
            theme,
            {},
          ).render(width),
        ]) {
          assert.ok(lines.length > 0 && lines.length <= 6, `${name} stays compact at ${width}`);
          for (const line of lines) {
            assert.ok([...line].length <= width, `${name} fits ${width}: ${JSON.stringify(line)}`);
          }
        }
      }
    }
  });

  test('injected helpers reach the hooks: real pi-tui measures emoji width', async () => {
    const { mod, tools } = await loadWiredExtension();
    assert.strictEqual(typeof mod.setWorktreeCardHelpers, 'function', 'expected the injectable card helpers seam');
    let realTui = null;
    try {
      realTui = require('@earendil-works/pi-tui');
    } catch {
      realTui = null;
    }
    if (!realTui || typeof realTui.visibleWidth !== 'function') {
      return;
    }
    let measured = 0;
    mod.setWorktreeCardHelpers({
      visibleWidth: (s) => { measured += 1; return realTui.visibleWidth(s); },
      truncateToWidth: (s, w, e) => realTui.truncateToWidth(s, w, e),
    });
    try {
      const theme = { bold: (s) => s, fg: (_c, s) => s };
      const tool = tools.get('worktree_create');
      const lines = tool.renderCall({ branch: 'feat/👍👍', issues: [1] }, theme, {}).render(30);
      assert.ok(measured > 0, 'the hook measures through the injected helpers');
      for (const line of lines) {
        assert.ok(realTui.visibleWidth(line) <= 30, `emoji-aware fit at 30: ${JSON.stringify(line)}`);
      }
    } finally {
      mod.setWorktreeCardHelpers(undefined);
    }
  });

  test('resetting the seam returns renders to the stable auto resolution', async () => {
    const { mod, tools } = await loadWiredExtension();
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const tool = tools.get('worktree_list');
    const before = tool.renderCall({ all: true }, theme, {}).render(60).join('\n');
    let calls = 0;
    mod.setWorktreeCardHelpers({
      visibleWidth: (s) => { calls += 1; return [...String(s)].length; },
      truncateToWidth: (s, w) => [...String(s)].slice(0, w).join(''),
    });
    const injected = tool.renderCall({ all: true }, theme, {}).render(60).join('\n');
    assert.ok(calls > 0, 'injected helpers measure while set');
    assert.strictEqual(typeof injected, 'string');
    mod.setWorktreeCardHelpers(undefined);
    const after = tool.renderCall({ all: true }, theme, {}).render(60).join('\n');
    assert.strictEqual(after, before, 'reset renders exactly the pre-injection output');
    const again = tool.renderCall({ all: true }, theme, {}).render(60).join('\n');
    assert.strictEqual(again, before, 'auto resolution stays stable across renders');
  });
});

describe('outputPad contract', () => {
  // Installed Pi 1.3.0 ToolRenderContext (dist/core/extensions/types.d.ts)
  // carries outputPad (0|1, default 1) with the explicit rule that
  // renderShell:self renderers apply it themselves: the host wraps self
  // cards in a plain Container with no padding (tool-execution.js), while
  // default-shell content goes through setPaddingX(outputPad) on both
  // sides (pi-tui Text: content width − 2×pad, one margin each side).
  const theme = { bold: (s) => s, fg: (_c, s) => s };

  test('nonzero outputPad pads both sides and keeps content inside width-2', () => {
    for (const tool of ['worktree_create', 'worktree_list', 'worktree_close', 'worktree_session_open']) {
      const card = createWorktreeCardRenderer(tool);
      const ctx = { outputPad: 1, state: {} };
      for (const width of [30, 60]) {
        const call = card.renderCall({ branch: 'feat/cards' }, theme, ctx).render(width);
        const result = card.renderResult(
          { content: [{ type: 'text', text: `${tool} ok` }], details: {} },
          { expanded: false },
          theme,
          { outputPad: 1, state: {} },
        ).render(width);
        for (const lines of [call, result]) {
          assert.ok(lines.length > 0, `${tool} renders rows at ${width}`);
          for (const line of lines) {
            const plain = stripAnsi(line);
            assert.ok(visible(line) <= width, `${tool} exceeds ${width}: ${JSON.stringify(plain)}`);
            assert.ok(plain.startsWith(' ') && plain.endsWith(' '), `${tool} applies pad on both sides: ${JSON.stringify(plain)}`);
            assert.ok([...plain.slice(1, -1)].length <= width - 2, `${tool} content fits ${width}-2`);
          }
        }
      }
    }
  });

  test('absent outputPad keeps the unpadded shape', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const lines = card.renderCall({ all: true }, theme, {}).render(60);
    assert.ok(lines.length > 0);
    assert.ok(stripAnsi(lines[0]).startsWith('▎'), 'no pad configured, frame leads the row');
  });

  for (const width of [0, 1, 2, 3]) {
    test(`width ${width} never exceeds the viewport`, () => {
      const card = createWorktreeCardRenderer('worktree_create');
      const theme = { bold: (s) => s, fg: (_c, s) => s };
      const sets = [
        card.renderCall({ branch: 'feat/cards' }, theme, {}).render(width),
        card.renderResult(
          { content: [{ type: 'text', text: 'worktree create: /r/feat-cards' }], details: {} },
          { expanded: false },
          theme,
          {},
        ).render(width),
      ];
      for (const lines of sets) {
        for (const line of lines) {
          assert.ok(visible(line) <= width, `width ${width} exceeded: ${JSON.stringify(stripAnsi(line))}`);
        }
      }
      if (width === 0) {
        for (const lines of sets) assert.deepStrictEqual(lines, []);
      } else {
        for (const lines of sets) assert.ok(lines.length > 0, `width ${width} still draws`);
      }
    });
  }

  test('unicode branch names fit narrow widths through real measurement', () => {
    let real = null;
    try {
      real = require('@earendil-works/pi-tui');
    } catch {
      real = null;
    }
    if (!real || typeof real.visibleWidth !== 'function' || typeof real.truncateToWidth !== 'function') {
      return;
    }
    const card = createWorktreeCardRenderer('worktree_create', {
      visibleWidth: real.visibleWidth,
      truncateToWidth: (text, width, ellipsis) => real.truncateToWidth(text, width, ellipsis),
    });
    const theme = { bold: (s) => s, fg: (_c, s) => s };
    const lines = card.renderCall({ branch: 'feat/日本語👍' }, theme, {}).render(8);
    assert.ok(lines.length > 0, 'narrow unicode call still draws');
    for (const line of lines) {
      assert.ok(real.visibleWidth(line) <= 8, `unicode row exceeds 8: ${JSON.stringify(stripAnsi(line))}`);
    }
  });
});

describe('lifecycle coherence', () => {
  // The host (tool-execution.js getRenderContext/updateDisplay) shares ONE
  // rendererState object across call/result renders and re-invokes both
  // renderers on every update; durationMs is undefined while partial and
  // options carry only expanded/isPartial. The sequence below replays that
  // order through the public hooks: running call, settled result, then a
  // re-rendered call that must join the same frame instead of doubling it.
  const theme = { bold: (s) => s, fg: (_c, s) => s };

  function hostCtx(state, over = {}) {
    return {
      args: { branch: 'feat/cards' },
      toolCallId: 'call_1',
      invalidate: () => {},
      lastComponent: undefined,
      state,
      cwd: '/repo',
      executionStarted: true,
      argsComplete: true,
      isPartial: true,
      expanded: false,
      showImages: false,
      isError: false,
      durationMs: undefined,
      outputPad: 0,
      ...over,
    };
  }

  function closers(lines) {
    return lines.filter((line) => stripAnsi(line).includes('─')).length;
  }

  function running(lines) {
    const text = lines.map(stripAnsi).join('\n');
    return text.includes('running') || text.includes('receiving');
  }

  test('call → result → call re-render forms one frame with no stale running line', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const state = {};
    const args = { branch: 'feat/cards', issues: [12] };
    const ok = {
      content: [{ type: 'text', text: 'worktree create: /r/feat-cards' }],
      details: { path: '/r/feat-cards', branch: 'feat/cards', issues: [12], created: true },
    };
    const runningCall = card.renderCall(args, theme, hostCtx(state)).render(60);
    assert.ok(runningCall.length > 0, 'running call draws');
    assert.ok(running(runningCall), 'running call says so');
    assert.strictEqual(closers(runningCall), 1, 'awaiting call closes its own frame');
    const body = card.renderResult(ok, { expanded: false, isPartial: false }, theme, hostCtx(state, {
      isPartial: false,
      durationMs: 1200,
    })).render(60);
    assert.ok(!running(body), 'settled body carries no running marker');
    assert.strictEqual(closers(body), 1, 'result closes the shared frame');
    assert.ok(body.join('\n').includes('1.2s'), 'settled host duration renders');
    const pairedCall = card.renderCall(args, theme, hostCtx(state, { isPartial: false, durationMs: 1200 })).render(60);
    assert.ok(!running(pairedCall), 're-rendered call drops the stale running line');
    assert.strictEqual(closers(pairedCall), 0, 'paired call leaves the closing rule to the result');
    const combined = [...pairedCall, ...body].map(stripAnsi).join('\n');
    assert.strictEqual(closers([...pairedCall, ...body]), 1, 'one frame, one closing rule across the pair');
    assert.ok(combined.includes('worktree create'), 'header survives on the call side');
    assert.ok(combined.includes('feat/cards'), 'summary survives on the result side');
  });
});

describe('worktree git-identity compact cards (S19 RED)', () => {
  const DOCUMENTED_ROLES = ['warning', 'error', 'muted'];

  function recorder() {
    const roles = [];
    const theme = {
      bold: (s) => s,
      fg: (role, s) => { roles.push(role); return s; },
    };
    return { theme, roles };
  }

  function bodyRows(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500'));
  }

  function closer(lines) {
    const found = lines.map((line) => stripAnsi(line)).filter((line) => line.includes('\u2500'));
    assert.equal(found.length, 1, 'one closing rule, got ' + JSON.stringify(lines));
    return found[0];
  }

  test('every header carries the branch glyph in the warning role', () => {
    for (const tool of TOOLS) {
      const rec = recorder();
      const card = createWorktreeCardRenderer(tool);
      const lines = renderLines(card.renderCall(callFor(tool), rec.theme, {}), 60);
      const header = stripAnsi(lines[0]);
      assert.ok(header.includes('\u2387'), tool + ' header carries the git-branch glyph: ' + JSON.stringify(header));
      assert.ok(rec.roles.includes('warning'), tool + ' paints in the git-orange role, saw ' + JSON.stringify(rec.roles));
    }
  });

  test('only documented theme roles reach the transcript (no invented orange)', () => {
    const seen = new Set();
    for (const tool of TOOLS) {
      const rec = recorder();
      const card = createWorktreeCardRenderer(tool);
      card.renderCall(callFor(tool), rec.theme, {}).render(60);
      card.renderCall(callFor(tool), rec.theme, { isPartial: false }).render(60);
      card.renderResult(resultFor(tool), { expanded: false }, rec.theme, {}).render(60);
      card.renderResult(resultFor(tool), { expanded: true }, rec.theme, { durationMs: 1500 }).render(60);
      card.renderResult(
        { content: [{ type: 'text', text: 'boom' }], details: resultFor(tool).details, isError: true },
        { expanded: false }, rec.theme, {},
      ).render(60);
      card.renderResult(resultFor(tool), { expanded: false, isPartial: true }, rec.theme, {}).render(60);
      for (const role of rec.roles) seen.add(role);
    }
    for (const role of seen) {
      assert.ok(DOCUMENTED_ROLES.includes(role), 'undocumented theme role ' + JSON.stringify(role));
    }
    assert.ok(seen.has('warning'), 'the git-orange role is actually used');
    assert.ok(seen.has('error'), 'failures still read as errors');
  });

  test('collapsed bodies are ordered short lines per tool', () => {
    const cases = [
      ['worktree_create', ['created: feat-cards · feat/cards', 'path: /repo/../feat-cards', 'issues: 12']],
      ['worktree_list', ['current: feat-cards', '1 checkout']],
      ['worktree_close', ['removed: feat-cards · feat/cards', 'branch kept']],
      ['worktree_session_open', ['opened: feat-cards · abc123', 'path: /repo/../feat-cards']],
    ];
    for (const entry of cases) {
      const tool = entry[0];
      const expected = entry[1];
      const card = createWorktreeCardRenderer(tool);
      // The new two-identifier heads (`created: <slug> · <branch>`) are
      // longer than the old one-word rows, so width 30 truncates them:
      // exact rows at readable widths, row-count plus fit at 30.
      for (const width of [60, 100]) {
        const lines = renderLines(card.renderResult(resultFor(tool), { expanded: false }, THEME, {}), width);
        assertFits(lines, width);
        assert.deepStrictEqual(bodyRows(lines), expected, tool + ' compact rows at ' + width);
      }
      const narrow = renderLines(card.renderResult(resultFor(tool), { expanded: false }, THEME, {}), 30);
      assertFits(narrow, 30);
      assert.equal(bodyRows(narrow).length, expected.length, tool + ' keeps every compact row at 30');
    }
  });

  test('close names a removed branch and session_open marks a resume', () => {
    const closeCard = createWorktreeCardRenderer('worktree_close');
    const dropped = {
      content: [{ type: 'text', text: 'worktree close: /repo/../feat-gone' }],
      details: { path: '/repo/../feat-gone', branch: 'feat/gone', removed: true, branchKept: false },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(closeCard.renderResult(dropped, { expanded: false }, THEME, {}), 60)),
      ['removed: feat-gone · feat/gone', 'branch deleted'],
    );
    const openCard = createWorktreeCardRenderer('worktree_session_open');
    const resumed = {
      content: [{ type: 'text', text: 'opened: feat-cards · abc123\nresumed' }],
      details: { worktree: 'feat-cards', sessionId: 'abc123', resumed: true, path: '/repo/../feat-cards' },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(openCard.renderResult(resumed, { expanded: false }, THEME, {}), 60)),
      ['opened: feat-cards · abc123', 'resumed'],
    );
  });

  test('an empty listing compacts to one line', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const lines = renderLines(card.renderResult(
      { content: [{ type: 'text', text: 'worktree list: none' }], details: { worktrees: [], count: 0 } },
      { expanded: false }, THEME, {},
    ), 60);
    assert.deepStrictEqual(bodyRows(lines), ['no worktrees']);
  });

  test('closing rule right-aligns the hint, then the evidence-backed duration', () => {
    const card = createWorktreeCardRenderer('worktree_close');
    const plain = closer(renderLines(card.renderResult(resultFor('worktree_close'), {}, THEME, {}), 60));
    assert.ok(plain.endsWith('ctrl+o to expand'), 'hint rides the rule end: ' + JSON.stringify(plain));
    assert.equal(visible(plain), 60, 'the hint is right-aligned to the full width: ' + JSON.stringify(plain));
    const timed = closer(renderLines(
      card.renderResult(resultFor('worktree_close'), {}, THEME, { durationMs: 1200 }), 60,
    ));
    assert.ok(timed.includes('ctrl+o to expand'), 'hint survives timing: ' + JSON.stringify(timed));
    assert.ok(timed.endsWith('1.2s'), 'duration closes the rule: ' + JSON.stringify(timed));
    assert.ok(!plain.includes('1.2s'), 'no duration without host evidence');
  });

  test('expanded list shows every row while compact shows current plus count', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const words = ['worktree list: a-x feat/x thread=t1 issues=1', 'worktree list: b-y feat/y thread=t2 issues=2'];
    const result = {
      content: [{ type: 'text', text: words.join('\n') }],
      details: {
        worktrees: [
          { name: 'a-x', path: '/repo/a-x', branch: 'feat/x' },
          { name: 'b-y', path: '/repo/b-y', branch: 'feat/y' },
        ],
        count: 2,
      },
    };
    const compact = renderLines(card.renderResult(result, { expanded: false }, THEME, {}), 100).map(stripAnsi).join('\n');
    assert.ok(compact.includes('current: a-x'), 'compact names the current checkout');
    assert.ok(compact.includes('2 checkouts'), 'compact names the count');
    assert.ok(!compact.includes('b-y'), 'compact stays short instead of listing rows');
    const expanded = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), 100).map(stripAnsi).join('\n');
    assert.ok(expanded.includes('a-x') && expanded.includes('b-y'), 'expanded keeps the full listing');
  });

  test('result rows strip ANSI smuggled through branch names and paths', () => {
    const card = createWorktreeCardRenderer('worktree_create');
    const evil = {
      content: [{ type: 'text', text: 'worktree create: /repo/x' }],
      details: { path: '/repo/\x1b[31mx', branch: 'feat/\x1b[31mevil', issues: [] },
    };
    const lines = renderLines(card.renderResult(evil, { expanded: false }, THEME, {}), 60);
    for (const line of lines) assert.ok(!line.includes('\x1b'), 'escape leaked: ' + JSON.stringify(line));
    assertFits(lines, 60);
  });
});

describe('S19: bounded compact per tool plus card parity', () => {
  function bodyRows(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500'));
  }

  function freshResult(tool) {
    switch (tool) {
      case 'worktree_create':
        return {
          content: [{ type: 'text', text: 'created: feat-cards · feat/cards\npath: /repo/../feat-cards\nissues: 12' }],
          details: { path: '/repo/../feat-cards', branch: 'feat/cards', issues: [12], created: true },
        };
      case 'worktree_close':
        return {
          content: [{ type: 'text', text: 'removed: feat-cards · feat/cards\nbranch kept' }],
          details: { path: '/repo/../feat-cards', branch: 'feat/cards', removed: true, branchKept: true },
        };
      case 'worktree_session_open':
        return {
          content: [{ type: 'text', text: 'opened: feat-cards · abc123\npath: /repo/../feat-cards' }],
          details: { worktree: 'feat-cards', sessionId: 'abc123', resumed: false, path: '/repo/../feat-cards' },
        };
      default:
        throw new Error(`no fresh fixture for ${tool}`);
    }
  }

  test('collapsed bodies are the ordered short lines of the new contract', () => {
    const cases = [
      ['worktree_create', ['created: feat-cards · feat/cards', 'path: /repo/../feat-cards', 'issues: 12']],
      ['worktree_close', ['removed: feat-cards · feat/cards', 'branch kept']],
      ['worktree_session_open', ['opened: feat-cards · abc123', 'path: /repo/../feat-cards']],
    ];
    for (const entry of cases) {
      const tool = entry[0];
      const expected = entry[1];
      const card = createWorktreeCardRenderer(tool);
      // Width 30 truncates the two-identifier heads: exact rows at
      // readable widths, row-count plus fit at 30.
      for (const width of [60, 100]) {
        const lines = renderLines(card.renderResult(freshResult(tool), { expanded: false }, THEME, {}), width);
        assertFits(lines, width);
        assert.deepStrictEqual(bodyRows(lines), expected, tool + ' compact rows at ' + width);
      }
      const narrow = renderLines(card.renderResult(freshResult(tool), { expanded: false }, THEME, {}), 30);
      assertFits(narrow, 30);
      assert.equal(bodyRows(narrow).length, expected.length, tool + ' keeps every compact row at 30');
    }
  });

  test('already-exists create, deleted branch, and resume keep the same ordered shape', () => {
    const createCard = createWorktreeCardRenderer('worktree_create');
    const owned = {
      content: [{ type: 'text', text: 'created: feat-cards · feat/cards · already exists\npath: /repo/../feat-cards' }],
      details: { path: '/repo/../feat-cards', branch: 'feat/cards', issues: [], created: false },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(createCard.renderResult(owned, { expanded: false }, THEME, {}), 60)),
      ['created: feat-cards · feat/cards · already exists', 'path: /repo/../feat-cards'],
    );
    const closeCard = createWorktreeCardRenderer('worktree_close');
    const dropped = {
      content: [{ type: 'text', text: 'removed: feat-gone · feat/gone\nbranch deleted' }],
      details: { path: '/repo/../feat-gone', branch: 'feat/gone', removed: true, branchKept: false },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(closeCard.renderResult(dropped, { expanded: false }, THEME, {}), 60)),
      ['removed: feat-gone · feat/gone', 'branch deleted'],
    );
    const openCard = createWorktreeCardRenderer('worktree_session_open');
    const resumed = {
      content: [{ type: 'text', text: 'opened: feat-cards · abc123\nresumed' }],
      details: { worktree: 'feat-cards', sessionId: 'abc123', resumed: true, path: '/repo/../feat-cards' },
    };
    assert.deepStrictEqual(
      bodyRows(renderLines(openCard.renderResult(resumed, { expanded: false }, THEME, {}), 60)),
      ['opened: feat-cards · abc123', 'resumed'],
    );
  });

  test('all five tools share one glyph, one tone role, and one right-aligned hint', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const header = stripAnsi(card.renderCall(callFor(tool), THEME, {}).render(60)[0]);
      assert.ok(header.startsWith('▎ ⎇ '), `${tool} carries the shared glyph: ${JSON.stringify(header)}`);
    }
    const roles = new Set();
    const rec = { theme: { bold: (s) => s, fg: (role, s) => { roles.add(role); return s; } }, roles };
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      card.renderCall(callFor(tool), rec.theme, {}).render(60);
      card.renderResult(resultFor(tool), { expanded: false }, rec.theme, {}).render(60);
      card.renderResult(
        { content: [{ type: 'text', text: 'boom' }], details: resultFor(tool).details, isError: true },
        { expanded: false }, rec.theme, {},
      ).render(60);
    }
    for (const role of roles) assert.ok(['warning', 'error', 'muted'].includes(role), `documented role only: ${role}`);
    assert.ok(roles.has('warning'), 'the git-orange tone role is used');
    assert.ok(roles.has('error'), 'failures read as errors');
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const plain = stripAnsi(card.renderResult(resultFor(tool), {}, THEME, {}).render(60).pop());
      assert.ok(plain.endsWith('ctrl+o to expand'), `${tool} hint rides the rule end: ${JSON.stringify(plain)}`);
      assert.equal(visible(plain), 60, `${tool} hint right-aligned: ${JSON.stringify(plain)}`);
      const untimed = stripAnsi(card.renderResult(resultFor(tool), {}, THEME, {}).render(60).join('\n'));
      assert.ok(!/\d+(ms|s)/.test(untimed.replace(/ctrl\+o to expand/, '')), `${tool} shows no duration without host evidence`);
    }
  });
});

describe('warp message renderer (S20)', () => {
  // The warp confirmation is a custom MESSAGE (commands have no render
  // hook), so its card lives here as a pure message renderer: no brackets
  // from the customType, a capitalised label, the compact moved:/to: name rows
  // and the expanded path/detail on ctrl+o. Same geometry helpers as the
  // tool cards (accent bar, right-aligned hint, outputPad), same fake-theme
  // discipline: the identity theme below adds no paint of its own.
  const WIDTHS_WARP = [30, 60, 100];

  function warpMessage(overrides) {
    return {
      customType: 'worktree-warp',
      content: "Worktree warp: now in /repo/to (branch 'feat/cards').",
      display: true,
      details: {
        from: '/repo/from',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 main',
        fromName: 'principal',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
      ...(overrides || {}),
    };
  }

  function recordingTheme() {
    const roles = [];
    return {
      roles,
      fg: (role, text) => { roles.push(role); return text; },
      bg: (role, text) => text,
    };
  }

  function warpBodyRows(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500'));
  }

  // buildCard honours outputPad with a margin on both sides, so the bar
  // check tolerates leading space; width fit is asserted separately.
  function assertWarpFrame(lines) {
    assert.ok(lines.length > 0, 'card renders at least one row');
    for (const line of lines) {
      assert.ok(/^\s*\u258E/.test(stripAnsi(line)),
        `every row carries the accent bar: ${JSON.stringify(stripAnsi(line))}`);
    }
  }

  test('compact renders the capitalised label, glyph and ordered moved:/to: name rows (S42)', () => {
    const render = createWarpMessageRenderer();
    for (const width of [60, 100]) {
      const lines = renderLines(render(warpMessage(), { expanded: false, outputPad: 1 }, THEME), width);
      assertFits(lines, width);
      assertWarpFrame(lines);
      const rows = warpBodyRows(lines);
      assert.equal(rows[0], '\u2387 Warp \u00B7 moved', 'own label with glyph, never the bracketed customType');
      // S42: compact is EXACTLY the two name-only rows — no branch, no path.
      assert.deepStrictEqual(rows.slice(1), ['moved: principal', 'to: feat-cards']);
      assert.ok(!rows.join('\n').includes('feat/cards'), 'no branch row in the compact card: ' + JSON.stringify(rows));
      assert.ok(!rows.join('\n').includes('/repo/to'), 'no path row in the compact card: ' + JSON.stringify(rows));
      assert.ok(!lines.join('\n').includes('[worktree-warp]'), 'no default-renderer bracket label');
    }
    const narrow = renderLines(render(warpMessage(), { expanded: false, outputPad: 1 }, THEME), 30);
    assertFits(narrow, 30);
    assertWarpFrame(narrow);
    assert.equal(warpBodyRows(narrow).length, 3, 'header plus both compact rows survive at 30');
  });

  test('compact without fromName still names the worktrees only (legacy details fallback)', () => {
    const render = createWarpMessageRenderer();
    const legacy = warpMessage({ details: {
      from: '/repo/from',
      to: '/repo/to',
      fromDesc: 'feat-old \u00B7 feat/old',
      name: 'feat-cards',
      branch: 'feat/cards',
    } });
    const rows = warpBodyRows(renderLines(render(legacy, { expanded: false, outputPad: 1 }, THEME), 100));
    // The source name is read off the fromDesc's name segment, never the branch.
    assert.deepStrictEqual(rows.slice(1), ['moved: feat-old', 'to: feat-cards']);
    assert.ok(!rows.join('\n').includes('feat/old'), 'no branch row in the compact card: ' + JSON.stringify(rows));
  });

  test('expanded adds path: and branch: rows after the compact pair, in that order (S42)', () => {
    const render = createWarpMessageRenderer();
    const lines = renderLines(render(warpMessage(), { expanded: true, outputPad: 1 }, THEME), 100);
    assertFits(lines, 100);
    const rows = warpBodyRows(lines);
    assert.equal(rows[0], '\u2387 Warp \u00B7 moved');
    assert.deepStrictEqual(rows.slice(1, 3), ['moved: principal', 'to: feat-cards']);
    assert.deepStrictEqual(rows.slice(3), ['path: now in "/repo/to"', 'branch: now in "feat/cards"'],
      'S42: expanded appends exactly path then branch: ' + JSON.stringify(rows));
    assert.ok(!rows.some((row) => /Worktree warp: now in/.test(row)), 'S42: the long prose notice stays out of the card body');
    assert.ok(!rows.some((row) => /evalidate/i.test(row)), 'S41: the filler sentence is gone from the card');
    for (const width of WIDTHS_WARP) {
      assertFits(renderLines(render(warpMessage(), { expanded: true, outputPad: 1 }, THEME), width), width);
    }
  });

  test('expanded wraps a long line with no ellipsis instead of cutting it', () => {
    const render = createWarpMessageRenderer();
    const longTo = `/repo/very-long-checkout-path-that-keeps-going-and-going-${'x'.repeat(80)}`;
    const message = warpMessage({ details: {
      from: '/repo/from',
      to: longTo,
      fromDesc: 'principal \u00B7 main',
      name: 'feat-cards',
      branch: 'feat/cards',
    } });
    const lines = renderLines(render(message, { expanded: true, outputPad: 1 }, THEME), 60);
    assertFits(lines, 60);
    const rows = warpBodyRows(lines);
    assert.ok(!rows.join('\n').includes('\u2026') && !rows.join('\n').includes('...'), 'S39: no ellipsis in the expanded form');
    assert.ok(rows.join('').includes(longTo), 'S39: the long line survives whole across the wrapped rows');
    assert.ok(rows.length > 4, 'the long path wrapped onto extra rows: ' + JSON.stringify(rows));
  });

  test('tool expanded wraps a long body line with no ellipsis', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const longLine = `worktree list: feat-cards feat/cards thread=t issues=12 odd=${'odd-doc-'.repeat(20)}.md`;
    const result = {
      content: [{ type: 'text', text: longLine }],
      details: { worktrees: [{ name: 'feat-cards', path: '/repo/x', branch: 'feat/cards' }], count: 1, all: true, pruned: [], warnings: [] },
    };
    const lines = renderLines(card.renderResult(result, { expanded: true }, THEME, {}), 60);
    assertFits(lines, 60);
    const text = lines.map((line) => stripAnsi(line)).join('\n');
    assert.ok(!text.includes('\u2026'), 'S39: no ellipsis in the expanded form');
    // Wrapped chunks carry the accent bar per row: strip it (and the
    // closing rule) before rejoining, so the check sees only content.
    const content = lines
      .map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500') && !row.includes('ctrl+o'))
      .join('');
    assert.ok(content.includes(longLine), 'S39: the long line survives whole across the wrapped rows');
  });

  test('outputPad is honoured and widths 30/60/100 all fit', () => {
    const render = createWarpMessageRenderer();
    for (const width of WIDTHS_WARP) {
      for (const outputPad of [0, 1, 2]) {
        const lines = renderLines(
          render(warpMessage(), { expanded: false, outputPad }, THEME), width);
        assertFits(lines, width);
        assertWarpFrame(lines);
      }
    }
    const padded = renderLines(render(warpMessage(), { expanded: false, outputPad: 2 }, THEME), 60);
    const plain = renderLines(render(warpMessage(), { expanded: false, outputPad: 0 }, THEME), 60);
    assert.ok(padded[0].startsWith('  '), 'outputPad pads both sides: ' + JSON.stringify(padded[0]));
    assert.ok(!plain[0].startsWith(' '), 'zero pad leaves no margin: ' + JSON.stringify(plain[0]));
  });

  test('branch names and paths cannot leak ANSI, controls or newlines into the card', () => {
    const render = createWarpMessageRenderer();
    const evil = warpMessage({
      content: "Worktree warp: now in /x (branch 'b').\x1b[31mred\x1b[0m",
      details: {
        from: '/repo/\x1b[31mfrom\x1b[0m',
        to: '/repo/to\nsecond-line\x07bell',
        fromDesc: 'principal \u00B7 \x1b[1mmain\x1b[22m',
        name: 'feat-\x1b]8;;http://evil\x07cards',
        branch: 'feat/cards\nnext',
      },
    });
    for (const expanded of [false, true]) {
      for (const width of WIDTHS_WARP) {
        const lines = renderLines(render(evil, { expanded, outputPad: 1 }, THEME), width);
        assertFits(lines, width);
        for (const line of lines) {
          // eslint-disable-next-line no-control-regex
          assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(line), 'no control characters: ' + JSON.stringify(line));
          assert.ok(!/\x1b\[[0-9;]*m/.test(line), 'no ANSI escapes: ' + JSON.stringify(line));
        }
        assert.ok(!lines.join('\n').includes('second-line'), 'embedded newlines never add rows');
      }
    }
  });

  test('a foreign customType falls back to the default renderer via undefined', () => {
    const render = createWarpMessageRenderer();
    assert.equal(render(warpMessage({ customType: 'something-else' }), { expanded: false, outputPad: 1 }, THEME), undefined);
    assert.equal(render(null, { expanded: false, outputPad: 1 }, THEME), undefined);
  });

  test('malformed details still render from the content, never throw', () => {
    const render = createWarpMessageRenderer();
    for (const details of [undefined, null, {}, { name: 42 }]) {
      const lines = renderLines(
        render(warpMessage({ details }), { expanded: false, outputPad: 1 }, THEME), 60);
      assertFits(lines, 60);
      assertWarpFrame(lines);
      assert.ok(warpBodyRows(lines).length >= 1, 'at least one row, got ' + JSON.stringify(lines));
    }
  });

  test('the tone is the documented warning role, never an orange role or the customType', () => {
    const theme = recordingTheme();
    const render = createWarpMessageRenderer();
    render(warpMessage(), { expanded: false, outputPad: 1 }, theme).render(60);
    render(warpMessage(), { expanded: true, outputPad: 1 }, theme).render(60);
    const roles = new Set(theme.roles);
    assert.ok(roles.has('warning'), 'git-orange reads as warning: ' + JSON.stringify([...roles]));
    for (const role of roles) {
      assert.ok(['warning', 'muted', 'dim'].includes(role), 'documented role only: ' + role);
    }
    // The installed Pi theme schema exposes no orange role, so the closest
    // documented role (warning, yellow in the built-in themes) carries the
    // tone; that limitation is stated in lib/worktree-card.js and the docs.
  });

  test('the closing rule carries the ctrl+o hint on both states', () => {
    const render = createWarpMessageRenderer();
    for (const expanded of [false, true]) {
      const lines = renderLines(render(warpMessage(), { expanded, outputPad: 1 }, THEME), 60);
      const rules = lines.map((line) => stripAnsi(line)).filter((line) => line.includes('\u2500'));
      assert.equal(rules.length, 1, 'one closing rule');
      assert.ok(rules[0].includes(expanded ? 'ctrl+o to collapse' : 'ctrl+o to expand'),
        'expand hint rides the rule: ' + JSON.stringify(rules[0]));
    }
  });
});

describe('warp card background (R4, S24 roles)', () => {
  // R4 as corrected by S24: the warp/worktree card carries a solid tone
  // background like gentle-shell's float cards (today it has none on the
  // outlined fallback). The roles follow the tone table
  // (info/success toolSuccessBg, warning toolPendingBg, error
  // toolErrorBg); customMessageBg is used nowhere in gentle-shell, so the
  // warp card — tone warning, the documented git-orange match — paints
  // toolPendingBg, and tool failures paint toolErrorBg. No invented hex
  // ever reaches the transcript. Every painted row is full-width (the
  // float rectangle with one-column margins); width, outputPad and ANSI
  // safety hold.
  const BG_OPEN = '\x1b[48;5;235m';
  const BG_RESET = '\x1b[49m';

  function bgTheme() {
    const roles = [];
    return {
      roles,
      fg: (role, text) => { roles.push(role); return text; },
      bg: (role, text) => { roles.push('bg:' + role); return BG_OPEN + text + BG_RESET; },
    };
  }

  function warpMessage(overrides) {
    return {
      customType: 'worktree-warp',
      content: "Worktree warp: now in /repo/to (branch 'feat/cards').",
      display: true,
      details: {
        from: '/repo/from',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 main',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
      ...(overrides || {}),
    };
  }

  test('every warp card row carries the tone background toolPendingBg', () => {
    const render = createWarpMessageRenderer();
    const theme = bgTheme();
    const lines = render(warpMessage(), { expanded: false, outputPad: 1 }, theme).render(60);
    assert.ok(lines.length >= 3, 'header plus both compact rows plus rule, got ' + JSON.stringify(lines));
    assert.ok(theme.roles.includes('bg:toolPendingBg'), 'uses the tone-table role, saw ' + JSON.stringify(theme.roles));
    for (const line of lines) {
      assert.ok(line.includes(BG_OPEN) && line.includes(BG_RESET), 'no transparent gap: ' + JSON.stringify(line));
    }
    assert.ok(!theme.roles.some((role) => role.startsWith('bg:') && role !== 'bg:toolPendingBg'),
      'no invented background role: ' + JSON.stringify(theme.roles));
  });

  test('background holds on every row with width/outputPad/ANSI safety', () => {
    const render = createWarpMessageRenderer();
    for (const width of [30, 60, 100]) {
      for (const outputPad of [0, 1, 2]) {
        const theme = bgTheme();
        const lines = render(warpMessage(), { expanded: false, outputPad }, theme).render(width);
        assert.ok(lines.length > 0, 'rows at ' + width + '/' + outputPad);
        for (const line of lines) {
          const plain = stripAnsi(line);
          assert.ok([...plain].length <= width, 'painted row still fits ' + width + ': ' + JSON.stringify(plain));
          assert.ok(line.includes(BG_OPEN), 'background on every row at ' + width + '/' + outputPad);
        }
      }
    }
    // ANSI smuggled through details never breaks the paint or the width.
    const theme = bgTheme();
    const evil = warpMessage({
      details: {
        from: '/repo/\x1b[31mfrom\x1b[0m',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 \x1b[1mmain\x1b[22m',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
    });
    const lines = render(evil, { expanded: false, outputPad: 1 }, theme).render(60);
    for (const line of lines) {
      assert.ok(line.includes(BG_OPEN), 'paint survives sanitized input');
      const noBg = line.split(BG_OPEN).join('').split(BG_RESET).join('');
      assert.ok(!/\x1b\[[0-9;]*m\x1b\[31m/.test(noBg), 'no smuggled escape survives');
    }
  });

  test('a theme without bg still renders the same rows unpainted', () => {
    const render = createWarpMessageRenderer();
    const plain = { fg: (_role, text) => text };
    const lines = render(warpMessage(), { expanded: false, outputPad: 1 }, plain).render(60);
    assert.ok(lines.length >= 3, 'unpainted fallback still draws');
    for (const line of lines) assert.ok(!line.includes('\x1b'), 'no paint without a bg function');
  });
});

describe('S24 float card recipe (T17 RED)', () => {
  // gentle-shell lib/shell-card.ts, CARD_STYLE.FLOAT: a one-column
  // transparent margin on both sides; float chrome
  // { topLeft:"\u258E", topLead:" ", topRight:"  ", rule:" ", side:"\u258E",
  // rail:" ", bottomLeft:"\u258E", bottomRight:" " }; every row padded to the
  // full target width; a blank padding row above the heading and between
  // heading and body; the opener is theme.bg(role,"") minus its trailing
  // \x1b[49m, re-armed after every inner reset, closed with \x1b[49m; roles
  // by tone (info/success toolSuccessBg, warning toolPendingBg, error
  // toolErrorBg); outlined fallback below width 10 or without the role;
  // the duration rides the closing rule only when it fits, never as a
  // placeholder dash.
  const BG_OPEN = '\x1b[48;5;22m';
  const BG_RESET = '\x1b[49m';

  function floatTheme(over) {
    const bgRoles = [];
    return {
      bgRoles,
      fg: (role, text) => text,
      bg: (role, text) => { bgRoles.push(role); return `${BG_OPEN}${text}${BG_RESET}`; },
      ...(over || {}),
    };
  }

  function warpMsg() {
    return {
      customType: 'worktree-warp',
      content: "Worktree warp: now in /repo/to (branch 'feat/cards').",
      display: true,
      details: {
        from: '/repo/from',
        to: '/repo/to',
        fromDesc: 'principal \u00B7 main',
        name: 'feat-cards',
        branch: 'feat/cards',
      },
    };
  }

  function assertFullWidthPainted(lines, width) {
    assert.ok(lines.length > 0, 'the float card draws rows');
    for (const line of lines) {
      assert.equal(visible(line), width, `every row is the full target width: ${JSON.stringify(stripAnsi(line))}`);
      assert.ok(line.includes(BG_OPEN), `no transparent gap inside a row: ${JSON.stringify(line)}`);
      assert.ok(line.endsWith(`${BG_RESET} `), `the opener closes before the margin: ${JSON.stringify(line)}`);
      const plain = stripAnsi(line);
      assert.ok(plain.startsWith(' ') && plain.endsWith(' '), `one-column transparent margins: ${JSON.stringify(plain)}`);
      assert.equal(plain[1], '\u258E', `the float bar opens the band: ${JSON.stringify(plain)}`);
    }
  }

  test('tool cards paint full-width rows inside one-column margins', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const theme = floatTheme();
      assertFullWidthPainted(renderLines(card.renderCall(callFor(tool), theme, {}), 60), 60);
      assertFullWidthPainted(renderLines(card.renderResult(resultFor(tool), { expanded: false }, theme, {}), 60), 60);
      assertFullWidthPainted(renderLines(card.renderResult(resultFor(tool), { expanded: true }, theme, {}), 100), 100);
    }
  });

  test('the warp card paints full-width rows inside one-column margins', () => {
    const render = createWarpMessageRenderer();
    const theme = floatTheme();
    assertFullWidthPainted(renderLines(render(warpMsg(), { expanded: false }, theme), 60), 60);
    assertFullWidthPainted(renderLines(render(warpMsg(), { expanded: true }, theme), 100), 100);
  });

  test('a blank padding row sits above the heading and between heading and body', () => {
    const render = createWarpMessageRenderer();
    const lines = renderLines(render(warpMsg(), { expanded: false }, floatTheme()), 60)
      .map((line) => stripAnsi(line));
    const isBlank = (row) => /^ \u258E * $/.test(row);
    assert.ok(isBlank(lines[0]), `padding row above the heading: ${JSON.stringify(lines)}`);
    assert.ok(lines[1].includes('Warp'), `the heading follows the padding: ${JSON.stringify(lines)}`);
    assert.ok(isBlank(lines[2]), `padding row between heading and body: ${JSON.stringify(lines)}`);
    assert.ok(lines[3].includes('moved:'), `the body follows: ${JSON.stringify(lines)}`);
  });

  test('the opener is re-armed after every inner reset', () => {
    const theme = floatTheme({ fg: (role, text) => `\x1b[32m${text}\x1b[0m` });
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      for (const lines of [
        renderLines(card.renderCall(callFor(tool), theme, {}), 60),
        renderLines(card.renderResult(resultFor(tool), { expanded: false }, theme, {}), 60),
      ]) {
        assert.ok(lines.some((line) => line.includes('\x1b[0m')), `${tool} carries an inner reset to re-arm`);
        for (const line of lines) {
          let index = -1;
          while ((index = line.indexOf('\x1b[0m', index + 1)) !== -1) {
            assert.equal(line.slice(index, index + 4 + BG_OPEN.length), `\x1b[0m${BG_OPEN}`,
              `${tool} re-arms the opener after every reset: ${JSON.stringify(line)}`);
          }
        }
      }
    }
  });

  test('background roles follow the tone table, never customMessageBg', () => {
    const lib = require('../lib/worktree-card.js');
    assert.equal(lib.floatBgRoleForTone('info'), 'toolSuccessBg');
    assert.equal(lib.floatBgRoleForTone('success'), 'toolSuccessBg');
    assert.equal(lib.floatBgRoleForTone('warning'), 'toolPendingBg');
    assert.equal(lib.floatBgRoleForTone('error'), 'toolErrorBg');
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const okTheme = floatTheme();
      card.renderResult(resultFor(tool), { expanded: false }, okTheme, {}).render(60);
      assert.ok(okTheme.bgRoles.includes('toolPendingBg'), `${tool} settled tone paints toolPendingBg`);
      const errTheme = floatTheme();
      card.renderResult(
        { content: [{ type: 'text', text: 'boom' }], details: resultFor(tool).details, isError: true },
        { expanded: false }, errTheme, {},
      ).render(60);
      assert.ok(errTheme.bgRoles.includes('toolErrorBg'), `${tool} failure paints toolErrorBg`);
      assert.ok(!errTheme.bgRoles.includes('customMessageBg'), `${tool} never paints the wrong role`);
    }
    const render = createWarpMessageRenderer();
    const warpTheme = floatTheme();
    render(warpMsg(), { expanded: false }, warpTheme).render(60);
    assert.ok(warpTheme.bgRoles.length > 0 && !warpTheme.bgRoles.includes('customMessageBg'),
      `the warp card never paints customMessageBg: ${JSON.stringify(warpTheme.bgRoles)}`);
  });

  test('width under 10 falls back to the outlined card with no paint', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const theme = floatTheme();
      for (const lines of [
        renderLines(card.renderCall(callFor(tool), theme, {}), 9),
        renderLines(card.renderResult(resultFor(tool), { expanded: false }, theme, {}), 9),
      ]) {
        assertFits(lines, 9);
        for (const line of lines) assert.ok(!line.includes(BG_OPEN), `${tool} paints nothing below width 10`);
        assert.ok(stripAnsi(lines[0]).replace(/^ /, '').startsWith('\u258E'), `${tool} keeps the outlined bar: ${JSON.stringify(stripAnsi(lines[0]))}`);
      }
    }
    const render = createWarpMessageRenderer();
    const theme = floatTheme();
    const lines = renderLines(render(warpMsg(), { expanded: false }, theme), 9);
    assertFits(lines, 9);
    for (const line of lines) assert.ok(!line.includes(BG_OPEN), 'warp paints nothing below width 10');
  });

  test('a theme whose bg carries no role falls back with no paint', () => {
    const flat = { fg: (_role, text) => text, bg: (_role, text) => text };
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      for (const lines of [
        renderLines(card.renderCall(callFor(tool), flat, {}), 60),
        renderLines(card.renderResult(resultFor(tool), { expanded: false }, flat, {}), 60),
      ]) {
        assertFits(lines, 60);
        for (const line of lines) assert.ok(!line.includes('\x1b'), `${tool} paints nothing without the role`);
      }
    }
    const render = createWarpMessageRenderer();
    const lines = renderLines(render(warpMsg(), { expanded: false }, flat), 60);
    assertFits(lines, 60);
    for (const line of lines) assert.ok(!line.includes('\x1b'), 'warp paints nothing without the role');
  });

  test('the duration rides the closing rule only when it fits, never as a dash', () => {
    for (const tool of TOOLS) {
      const card = createWorktreeCardRenderer(tool);
      const theme = floatTheme();
      const wide = renderLines(
        card.renderResult(resultFor(tool), { expanded: false }, theme, { durationMs: 1200 }), 60);
      assertFullWidthPainted(wide, 60);
      const wideCloser = stripAnsi(wide[wide.length - 1]);
      assert.ok(/1\.2s {1,2}$/.test(wideCloser), `${tool} duration closes the rule when it fits: ${JSON.stringify(wideCloser)}`);
      const narrow = renderLines(
        card.renderResult(resultFor(tool), { expanded: false }, floatTheme(), { durationMs: 1200 }), 20);
      assertFullWidthPainted(narrow, 20);
      const narrowCloser = stripAnsi(narrow[narrow.length - 1]);
      assert.ok(!narrowCloser.includes('1.2s'), `${tool} omits the duration when it cannot fit: ${JSON.stringify(narrowCloser)}`);
      assert.ok(!narrowCloser.includes('\u2500'), `${tool} never renders a placeholder dash: ${JSON.stringify(narrowCloser)}`);
    }
  });
});

describe('S25: collapsed listing card carries each entry odd document', () => {
  function bodyRows(lines) {
    return lines.map((line) => stripAnsi(line).replace(/^\s*\u258E\s?/, '').replace(/\s+$/, ''))
      .filter((row) => !row.includes('\u2500'));
  }

  function listResult(worktrees, count) {
    return {
      content: [{ type: 'text', text: worktrees.map((row) => `worktree list: ${row.name} ${row.branch}`).join('\n') }],
      details: { worktrees, count },
    };
  }

  test('collapsed list shows one odd row per entry that holds odd docs', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const result = listResult([
      { name: 'a-x', path: '/repo/a-x', branch: 'feat/x', odd: ['odd/x.md'] },
      { name: 'b-y', path: '/repo/b-y', branch: 'feat/y', odd: [] },
      { name: 'c-z', path: '/repo/c-z', branch: 'feat/z', odd: ['odd/z-one.md', 'odd/z-two.md'] },
    ], 3);
    for (const width of [60, 100]) {
      const rows = bodyRows(renderLines(card.renderResult(result, { expanded: false }, THEME, {}), width));
      assert.deepStrictEqual(rows, [
        'current: a-x',
        '3 checkouts',
        'odd: a-x \u00B7 odd/x.md',
        'odd: c-z \u00B7 odd/z-one.md,odd/z-two.md',
      ], `collapsed odd rows at ${width}`);
    }
  });

  test('entries without odd docs add no row, and smuggled escapes are stripped', () => {
    const card = createWorktreeCardRenderer('worktree_list');
    const clean = listResult([
      { name: 'a-x', path: '/repo/a-x', branch: 'feat/x', odd: [] },
    ], 1);
    assert.deepStrictEqual(
      bodyRows(renderLines(card.renderResult(clean, { expanded: false }, THEME, {}), 60)),
      ['current: a-x', '1 checkout'],
    );
    const evil = listResult([
      { name: 'a-x', path: '/repo/a-x', branch: 'feat/x', odd: ['\x1b[31modd/evil.md\x1b[0m'] },
    ], 1);
    const lines = renderLines(card.renderResult(evil, { expanded: false }, THEME, {}), 60);
    for (const line of lines) assert.ok(!line.includes('\x1b'), 'escape leaked: ' + JSON.stringify(line));
    assert.ok(
      bodyRows(lines).includes('odd: a-x \u00B7 odd/evil.md'),
      'the cleaned doc still shows: ' + JSON.stringify(bodyRows(lines)),
    );
  });
});
