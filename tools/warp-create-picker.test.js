'use strict';
// T36 (customize-command S46) tests: the optional issues + odd
// multi-select steps of the create-from-warp flow.
//
// Lib unit tests (lib/warp-create-picker.js, pure Node, no subprocess,
// no prompt): the pinned `gh` fetch shape (`gh issue list --state open
// --json number,title` with the CLI's own paging flags), the skip paths,
// the number-or-title search filter, the odd listing from the CURRENT
// checkout, pagination, and the reusable multi-select component driven
// with synthetic keys.
//
// Flow tests (same file, extension harness at the bottom): type -> name
// -> issues -> odd -> creation registers the selected values; Esc in
// either new step cancels the whole creation with no state change;
// confirm-with-none proceeds with empty values; both steps skip cleanly
// when empty or unavailable; several odd documents survive; the odd list
// comes from the current checkout; the creation still reuses the existing
// create path (duplicate refusal byte-identical).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const picker = require('../lib/warp-create-picker.js');

// Optional real dependency: the host's pi-tui package. CI installs NO
// dependencies, so resolve it once here and SKIP the tests that genuinely
// need the real module instead of failing (the
// worktree-warp-real-session pattern). Every test that only needs the
// raw-byte fallback keeps running everywhere, with or without the package.
let TUI_AVAILABLE = false;
try {
  require.resolve('@earendil-works/pi-tui');
  TUI_AVAILABLE = true;
} catch {
  TUI_AVAILABLE = false;
}
if (!TUI_AVAILABLE) {
  console.error(
    'warp-create-picker: SKIPPING real-matcher tests (no @earendil-works/pi-tui found; '
    + 'install the package, e.g. npm install @earendil-works/pi-tui, to run them)',
  );
}

const roots = [];
after(() => {
  for (const dir of roots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

function track(p) {
  roots.push(p);
  return p;
}

function scratchDir(tag) {
  return track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-pick-${tag}-`)));
}

describe('gh fetch shape and pagination flags', { concurrency: false }, () => {
  test('the fetch runs gh issue list over open issues as JSON number/title with a limit', async () => {
    const seen = [];
    const spawnImpl = (bin, argv, opts) => {
      seen.push({ bin, argv, cwd: opts && opts.cwd });
      return {
        status: 0,
        stdout: JSON.stringify([{ number: 12, title: 'Fix the crash' }, { number: 7, title: 'Docs' }]),
        stderr: '',
        error: null,
      };
    };
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, true, `expected ok, got ${JSON.stringify(out)}`);
    assert.deepEqual(seen.length, 1, 'exactly one gh call');
    assert.equal(seen[0].bin, 'gh', 'the gh CLI');
    assert.deepEqual(
      seen[0].argv,
      ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '200'],
      'the verified fetch shape with the CLI paging flag',
    );
    assert.equal(seen[0].cwd, '/repo', 'the fetch runs in the current checkout');
    assert.deepEqual(out.issues, [
      { number: 12, title: 'Fix the crash' },
      { number: 7, title: 'Docs' },
    ]);
  });

  test('a search string rides the CLI search flag', async () => {
    const seen = [];
    const spawnImpl = (bin, argv) => {
      seen.push(argv);
      return { status: 0, stdout: '[]', stderr: '', error: null };
    };
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', search: 'crash', spawnImpl });
    assert.equal(out.ok, true);
    assert.deepEqual(out.issues, [], 'no open issues is ok with an empty list');
    assert.deepEqual(
      seen[0],
      ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '200', '--search', 'crash'],
      'the search rides --search behind the same shape',
    );
  });

  test('a missing gh binary skips instead of throwing', async () => {
    const spawnImpl = () => {
      const err = new Error("spawnSync gh ENOENT");
      err.code = 'ENOENT';
      return { status: null, stdout: '', stderr: '', error: err };
    };
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: '/no/such/gh', spawnImpl });
    assert.equal(out.ok, false, 'not ok');
    assert.ok(typeof out.skipped === 'string' && out.skipped.length > 0, 'a skip reason travels along');
  });

  test('an erroring gh skips instead of throwing', async () => {
    const spawnImpl = () => ({ status: 1, stdout: '', stderr: 'Not logged in. Run gh auth login.', error: null });
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, false, 'an unauthenticated gh is a skip, never a block');
    assert.ok(typeof out.skipped === 'string' && out.skipped.length > 0);
  });

  test('unparseable gh output skips instead of throwing', async () => {
    const spawnImpl = () => ({ status: 0, stdout: 'not json', stderr: '', error: null });
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, false);
    assert.ok(typeof out.skipped === 'string' && out.skipped.length > 0);
  });

  test('a non-array gh payload skips instead of throwing', async () => {
    const spawnImpl = () => ({ status: 0, stdout: '{"number":1}', stderr: '', error: null });
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, false);
  });

  test('malformed rows are dropped while good rows survive', async () => {
    const spawnImpl = () => ({
      status: 0,
      stdout: JSON.stringify([
        { number: 3, title: 'Good' },
        { number: 'x', title: 'Bad number' },
        { number: 4 },
        null,
        { number: 5, title: 'Also good' },
      ]),
      stderr: '',
      error: null,
    });
    const out = await picker.fetchOpenIssues({ cwd: '/repo', ghBin: 'gh', spawnImpl });
    assert.equal(out.ok, true);
    assert.deepEqual(out.issues, [
      { number: 3, title: 'Good' },
      { number: 5, title: 'Also good' },
    ]);
  });
});

describe('issues search: number or title from the same box', { concurrency: false }, () => {
  const issues = [
    { number: 12, title: 'Fix the crash on empty' },
    { number: 123, title: 'Docs for warp' },
    { number: 7, title: 'Crash report 12' },
    { number: 45, title: 'Unrelated chore' },
  ];

  test('a numeric query matches by number', () => {
    const found = picker.filterIssueItems(issues, '12').map((i) => i.number).sort((a, b) => a - b);
    assert.deepEqual(found, [7, 12, 123], '12, 123 by number and 7 by its title containing 12');
  });

  test('a text query matches as a case-insensitive substring of the title', () => {
    const found = picker.filterIssueItems(issues, 'CRASH').map((i) => i.number).sort((a, b) => a - b);
    assert.deepEqual(found, [7, 12]);
  });

  test('a query that is neither number nor title filters the row out', () => {
    assert.deepEqual(picker.filterIssueItems(issues, 'zzz'), [], 'nothing matches');
    assert.deepEqual(
      picker.filterIssueItems(issues, '99').map((i) => i.number),
      [],
      'no number contains 99 and no title mentions it',
    );
  });

  test('an empty query returns every row', () => {
    assert.deepEqual(picker.filterIssueItems(issues, '   ').map((i) => i.number), [12, 123, 7, 45]);
  });
});

describe('odd listing comes from the given checkout only', { concurrency: false }, () => {
  function checkoutWithDocs(tag, names) {
    const root = scratchDir(tag);
    fs.mkdirSync(path.join(root, 'odd', 'tasks'), { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(root, 'odd', 'tasks', name), `# ${name}\n`);
    return root;
  }

  test('it lists the top-level odd/tasks/*.md names sorted, with absolute paths', () => {
    const root = checkoutWithDocs('odd-list', ['b-change.md', 'a-change.md', 'notes.txt', 'README']);
    fs.mkdirSync(path.join(root, 'odd', 'tasks', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(root, 'odd', 'tasks', 'sub', 'nested.md'), '# nested\n');
    const docs = picker.listOddTaskDocs(root);
    assert.deepEqual(
      docs.map((d) => d.name),
      ['a-change.md', 'b-change.md'],
      'sorted .md files only, no txt, no nested dir, no bare README',
    );
    for (const doc of docs) {
      assert.equal(doc.abs, path.join(root, 'odd', 'tasks', doc.name), 'the absolute path travels along');
      assert.ok(fs.statSync(doc.abs).isFile(), 'it names a real file');
    }
  });

  test('it lists THAT checkout documents, never another checkout', () => {
    const current = checkoutWithDocs('odd-current', ['current-change.md']);
    const other = checkoutWithDocs('odd-other', ['other-change.md']);
    assert.ok(other.length > 0, 'the other checkout really has its own doc');
    const docs = picker.listOddTaskDocs(current);
    assert.deepEqual(docs.map((d) => d.name), ['current-change.md']);
  });

  test('a missing odd/tasks directory means no documents, never a throw', () => {
    const root = scratchDir('odd-missing');
    assert.deepEqual(picker.listOddTaskDocs(root), [], 'no odd/ at all');
    assert.deepEqual(picker.listOddTaskDocs(path.join(root, 'no-such-checkout')), [], 'no checkout at all');
    fs.mkdirSync(path.join(root, 'odd'), { recursive: true });
    assert.deepEqual(picker.listOddTaskDocs(root), [], 'odd/ without tasks/');
  });
});

describe('pagination', { concurrency: false }, () => {
  test('pages clamp and slice', () => {
    const items = Array.from({ length: 12 }, (_, i) => i);
    assert.deepEqual(picker.paginate(items, 0, 5), { items: [0, 1, 2, 3, 4], page: 0, pageCount: 3, total: 12 });
    assert.deepEqual(picker.paginate(items, 2, 5).items, [10, 11], 'the last page holds the rest');
    assert.equal(picker.paginate(items, 9, 5).page, 2, 'a far page clamps to the last one');
    assert.equal(picker.paginate(items, -3, 5).page, 0, 'a negative page clamps to the first one');
    assert.deepEqual(picker.paginate([], 0, 5), { items: [], page: 0, pageCount: 1, total: 0 });
  });
});

describe('the reusable multi-select component', { concurrency: false }, () => {
  const items = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
  const identityFilter = (rows, q) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(query));
  };

  function open(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select rows (optional)',
      items,
      filterFn: identityFilter,
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  function textOf(view, width = 90) {
    return view.render(width).join('\n');
  }

  test('it renders rules, prompt, search box, DATA rows only and a key footer', () => {
    const { view, finished } = open();
    const lines = view.render(90);
    const text = lines.join('\n');
    assert.ok(/^─+$/.test(lines[0]), 'a thin accent rule opens the component');
    assert.ok(/^─+$/.test(lines[lines.length - 1]), 'a thin accent rule closes it');
    assert.ok(text.includes('Select rows (optional)'), 'the prompt travels');
    assert.ok(text.includes('Search:'), 'the search box sits under the prompt');
    assert.ok(text.includes('row 1'), 'the first page shows');
    assert.ok(!text.includes('row 6'), 'the second page stays off-screen');
    assert.match(text, /page 1\/3/i, 'the footer names the page');
    assert.match(text, /enter.*confirm/i, 'the footer names Enter as the confirm key');
    assert.match(text, /space.*toggle/i, 'the footer names Space as the toggle key');
    assert.match(text, /←\/→ pages/i, 'the footer names LEFT/RIGHT as the page keys');
    assert.match(text, /tab.*back/i, 'the footer reserves Tab for Back');
    assert.match(text, /t search/i, 'the footer names T as the search key');
    assert.ok(!text.includes('← Back'), 'no selectable Back row renders anywhere');
    assert.ok(!text.includes('Back'), 'no Back row label renders anywhere');
    assert.ok(!text.includes('Confirm'), 'there is no Confirm row: Enter confirms');
    // Raw Tab is the only Back affordance: it returns without completing.
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw Tab goes Back with no selectable row');
  });

  test('panels are standalone: no cross-field chips, tabs or step counters leak into the render', () => {
    const { view } = open({
      title: 'Select issues (optional)',
    });
    const text = textOf(view);
    assert.ok(!/\[\d+\/\d+\]/.test(text), 'no [n/m] step counter renders');
    assert.ok(!text.includes('▸'), 'no chip strip renders');
    assert.ok(!text.includes('✓'), 'no answered-step mark renders');
    const { view: second } = open({ title: 'Select odd documents (optional)' });
    const again = textOf(second);
    assert.ok(!/\[\d+\/\d+\]/.test(again), 'the second panel carries no counter either');
    assert.ok(!again.includes('Issues') || !again.includes('Odd'), 'no joint Type/Name/Issues/Odd header groups the panels');
    assert.ok(again.includes('Select odd documents (optional)'), 'each panel keeps only its own title');
    // Pagination of THIS list is fine: it is not a wizard step indicator.
    assert.match(text, /page 1\/3/i, 'the page counter of the current list stays');
  });

  test('focused rows carry the distinct chevron and checked boxes align', () => {
    const { view } = open({ pageSize: 12 });
    view.handleInput('space');
    const lines = view.render(90);
    const row = lines.find((line) => line.includes('row 1'));
    assert.ok(row.includes('[x]'), 'the toggled box reads checked');
    assert.ok(row.includes('❯'), 'the focused row carries the chevron');
    const other = lines.find((line) => line.includes('row 2'));
    assert.ok(other.includes('[ ]'), 'the untoggled box reads empty');
  });

  test('moving pages shows the later rows', () => {
    const { view } = open();
    view.handleInput('pagedown');
    const text = textOf(view);
    assert.ok(text.includes('row 6'), 'the second page shows after pagedown');
    assert.ok(!text.includes('row 1\n') && !text.includes('row 1 '), 'the first page is gone');
    assert.match(text, /page 2\/3/i);
  });

  test('space toggles, enter confirms, tab goes back preserving values', () => {
    const { view, finished } = open();
    view.handleInput('down');
    assert.equal(view.state.focus, 'list', 'arrowing focuses the list');
    view.handleInput('space');
    assert.deepEqual(view.state.selected, [2], 'Space toggles the focused checkbox');
    assert.ok(textOf(view).includes('1 selected'), 'the footer counts the selection');
    view.handleInput('space');
    assert.deepEqual(view.state.selected, [], 'Space toggles it back off');
    assert.deepEqual(finished, [], 'toggling never completes');
    view.handleInput('space');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [2], uiState: { query: '', page: 0, cursor: 1 } }], 'Tab alone returns with selections and list position echoed');
    assert.deepEqual(view.state.selected, [2], 'the selections are kept for the return trip');
  });

  test('multi-word title queries keep working from the T search field', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('x');
    assert.equal(view.state.query, '', 'stray typing in list mode never filters');
    view.handleInput('t');
    assert.equal(view.state.mode, 'search', 'T opens the dedicated search field');
    for (const ch of 'row 1') view.handleInput(ch);
    assert.equal(view.state.query, 'row 1', 'the space typed into the query');
    const text = textOf(view);
    assert.ok(text.includes('row 1'), 'the filter narrows to row 1');
    assert.ok(!text.includes('row 2'), 'row 2 is filtered out');
    assert.deepEqual(view.state.selected, [], 'filtering never selects');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list', 'Enter leaves search for the list');
    assert.deepEqual(finished, [], 'leaving search never confirms');
    assert.equal(view.state.query, 'row 1', 'the filter is retained');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'Enter in list confirms, echoing the kept filter');
  });

  test('confirming with nothing selected is valid and carries an empty list', () => {
    const { view, finished } = open();
    // No Confirm row exists: Enter on the list confirms immediately.
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [], uiState: { query: '', page: 0, cursor: 0 } }]);
  });

  test('typing filters the rows and keeps working after a multi-selection', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('down');
    view.handleInput('space');
    assert.deepEqual(view.state.selected, [2, 3], 'two rows selected');
    view.handleInput('t');
    for (const ch of 'row 1') view.handleInput(ch);
    assert.equal(view.state.query, 'row 1');
    const text = textOf(view);
    assert.ok(text.includes('row 1'), 'the filter narrows to row 1');
    assert.ok(!text.includes('row 2'), 'row 2 is filtered out');
    assert.deepEqual(view.state.selected, [2, 3], 'the selection survives filtering');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list', 'Enter leaves search first');
    assert.deepEqual(finished, [], 'leaving search never confirms');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [2, 3], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'Enter in list confirms the multi-selection, echoing the kept filter');
  });

  test('backspace edits the query', () => {
    const { view } = open({ pageSize: 12 });
    view.handleInput('t');
    view.handleInput('x');
    assert.equal(view.state.query, 'x');
    view.handleInput('backspace');
    assert.equal(view.state.query, '');
    assert.equal(view.state.mode, 'search', 'editing stays in the field');
  });

  test('escape cancels the whole step', () => {
    const { view, finished } = open();
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('escape');
    assert.deepEqual(finished, [null], 'Esc finishes with null: cancel, not confirm');
  });

  test('a key release changes nothing', () => {
    const { view } = open({
      helpers: { isKeyRelease: () => true },
    });
    view.handleInput('down');
    view.handleInput('x');
    view.handleInput('enter');
    assert.equal(view.state.query, '', 'no typing leaked through the release guard');
  });

  test('it never crashes on hostile dimensions', () => {
    const { view } = open();
    assert.deepEqual(view.render(0), []);
    assert.deepEqual(view.render(-4), []);
  });
});

describe('create-from-warp issues + odd steps (S46 flow)', { concurrency: false }, () => {
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
    .replace('import { Type } from "@earendil-works/pi-ai";', TYPE_STUB)
    .replace('import { defineTool } from "@earendil-works/pi-coding-agent";', 'const defineTool = (def) => def;');
  assert.ok(stubbed !== srcText, 'expected both package import lines to be stubbed');

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

  const { pathToFileURL } = require('node:url');
  const { spawnSync } = require('node:child_process');

  async function loadExtension() {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-ext-')));
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
    return { tools, commands, mod };
  }

  function git(cwd, args) {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`);
    return (result.stdout || '').trim();
  }

  function makeRepo(tag) {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), `wt-pick-${tag}-`)));
    git(dir, ['init']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['commit', '--allow-empty', '-m', 'init']);
    const root = fs.realpathSync(dir);
    // The selector only opens (and reaches the create entry) when another
    // checkout exists: register one first, exactly like the S45 suite.
    const slug = 'feat-first';
    const target = path.join(path.dirname(root), `${path.basename(root)}-pick-${slug}`);
    track(target);
    git(root, ['worktree', 'add', '-b', 'feat/first', target, 'HEAD']);
    require('../lib/worktree-registry.js').upsertWorktree(root, {
      branch: 'feat/first', path: fs.realpathSync(target), thread: 'thread-first', issues: [], odd: [],
    });
    return root;
  }

  // `gh` stub answering BOTH `issue list` (the S46 fetch shape) and
  // `issue view <n>` (the existing create-path verification).
  function makeGhStub(entries) {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-gh-')));
    const bin = path.join(dir, 'gh');
    const listJson = JSON.stringify(entries.map(([n, title]) => ({ number: n, title }))).replace(/'/g, "'\\''");
    const cases = entries
      .map(([n, title]) => `    ${n}) printf '{"number":${n},"title":"${title}","state":"OPEN"}\\n'; exit 0;;`)
      .join('\n');
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "issue" ] && [ "$2" = "list" ]; then',
      `  printf '%s\\n' '${listJson}'; exit 0`,
      'fi',
      'if [ "$1" = "issue" ] && [ "$2" = "view" ]; then',
      '  case "$3" in',
      cases,
      '    *) echo "could not resolve to an Issue" >&2; exit 1;;',
      '  esac',
      'fi',
      'echo "gh stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    return bin;
  }

  function makeHerdrCreateStub() {
    const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-herdr-')));
    const bin = path.join(dir, 'herdr');
    fs.writeFileSync(bin, [
      '#!/bin/sh',
      'if [ "$1" = "worktree" ] && [ "$2" = "create" ]; then',
      '  shift 2',
      '  branch=""; base=""; wtpath=""; cwd=""',
      '  while [ $# -gt 0 ]; do',
      '    case "$1" in',
      '      --branch) branch="$2"; shift 2;;',
      '      --base) base="$2"; shift 2;;',
      '      --path) wtpath="$2"; shift 2;;',
      '      --cwd) cwd="$2"; shift 2;;',
      '      *) shift;;',
      '    esac',
      '  done',
      '  [ -n "$branch" ] && [ -n "$wtpath" ] && [ -n "$cwd" ] || { echo "missing args" >&2; exit 1; }',
      '  exec git -C "$cwd" worktree add -b "$branch" "$wtpath" "$base"',
      'fi',
      'echo "herdr stub: unexpected argv $*" >&2; exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    return bin;
  }

  function makeFakeSM(calls) {
    class FakeTarget {
      constructor(cwd, dir, file) {
        this.cwd = cwd;
        this.dir = dir;
        this.file = file;
        this.carried = [];
      }
      getSessionFile() { return this.file; }
      getEntries() { return this.carried; }
      getLeafId() { return this.leaf === undefined ? null : this.leaf; }
      branch(id) { calls.push(['branch', id]); this.leaf = id; }
      appendCustomEntry(type, data) {
        calls.push(['appendCustomEntry', type, data]);
        const id = `warp-entry-${calls.length}`;
        this.carried.push({ id, type: 'custom', customType: type, data });
        this.leaf = id;
        return id;
      }
      appendSessionInfo(name) {
        calls.push(['appendSessionInfo', name]);
        const id = `session-info-${calls.length}`;
        this.carried.push({ id, type: 'session_info', name });
        this.leaf = id;
        return id;
      }
    }
    return class FakeSM {
      static forkFrom(sourcePath, targetCwd, sessionDir) {
        calls.push(['forkFrom', sourcePath, targetCwd, sessionDir]);
        const file = path.join(targetCwd, 'forked-session.jsonl');
        fs.writeFileSync(file, '{"type":"session"}\n');
        return new FakeTarget(targetCwd, sessionDir, file);
      }
      static create(cwd, sessionDir) {
        calls.push(['create', cwd, sessionDir]);
        const file = path.join(cwd, 'created-session.jsonl');
        return { getSessionFile: () => file, getHeader: () => ({ type: 'session', cwd }) };
      }
      static open(file, sessionDir, cwdOverride) {
        calls.push(['open', file, sessionDir, cwdOverride]);
        return new FakeTarget(cwdOverride, sessionDir, file);
      }
    };
  }

  // Selector ctx for the no-argument warp: `selectImpl` answers the
  // checkout selector (take the create entry), `customImpl` answers the
  // inline custom UI when the host offers one (absent by default: the steps skip).
  function makeCtx({ cwd, FakeSM, calls, selectImpl, customImpl = null, sessionFile, sessionDir, entries = [] }) {
    const notes = [];
    const selects = [];
    const customs = [];
    const waited = [];
    const switches = [];
    const sent = [];
    const sm = new FakeSM();
    Object.assign(sm, {
      getSessionFile: () => sessionFile,
      getLeafId: () => 'leaf-1',
      getEntries: () => entries,
      getSessionDir: () => sessionDir,
    });
    const ui = {
      notify: (message, level) => { notes.push([message, level]); },
      setStatus: () => {},
      select: async (title, options) => {
        selects.push([title, options]);
        if (typeof selectImpl === 'function') return selectImpl(title, options);
        return selectImpl;
      },
    };
    if (customImpl !== null) {
      ui.custom = async (factory, opts) => {
        customs.push(opts);
        return customImpl(factory, opts);
      };
    }
    const ctx = {
      cwd,
      ui,
      sessionManager: sm,
      waitForIdle: async () => { waited.push(true); },
      switchSession: async (file, options) => {
        switches.push([file, typeof options?.withSession]);
        if (typeof options?.withSession === 'function') {
          const replaced = {
            ui: { setStatus: () => {} },
            sendMessage: async (message, sendOptions) => { sent.push([message, sendOptions]); },
          };
          await options.withSession(replaced);
        }
        return { cancelled: false };
      },
    };
    return { ctx, notes, selects, customs, waited, switches, sent };
  }

  const CREATE_ENTRY = 'Create new worktree…';

  // Run the no-argument warp with the selector taking the create entry,
  // the type+name seams answering, and the S46 seams wired per test.
  async function runCreate({ root, env, typeValue = 'feat', nameValue = 'picked', issuesSeam = null, oddSeam = null, pickerSeam = null, selectImpl = null, customImpl = null }) {
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-sess-'))), 'session.jsonl');
    fs.writeFileSync(sessionFile, '{"type":"session"}\n');
    const built = makeCtx({
      cwd: root, FakeSM, calls, sessionFile, sessionDir: path.dirname(sessionFile),
      selectImpl: selectImpl || ((title, options) => options[options.length - 1]),
      customImpl,
    });
    setEnv(env);
    try {
      const { commands, mod } = await loadExtension();
      assert.equal(typeof mod.setWarpCreateTypeAsker, 'function', 'type seam exists');
      mod.setWarpCreateTypeAsker(async () => typeValue);
      assert.equal(typeof mod.setWarpCreateNameAsker, 'function', 'name seam exists');
      mod.setWarpCreateNameAsker(async () => nameValue);
      if (issuesSeam !== null) {
        assert.equal(typeof mod.setWarpCreateIssuesFetcher, 'function', 'S46 issues seam exists');
        mod.setWarpCreateIssuesFetcher(issuesSeam);
      }
      if (oddSeam !== null) {
        assert.equal(typeof mod.setWarpCreateOddLister, 'function', 'S46 odd seam exists');
        mod.setWarpCreateOddLister(oddSeam);
      }
      if (pickerSeam !== null) {
        assert.equal(typeof mod.setWarpCreatePicker, 'function', 'S46 picker seam exists');
        mod.setWarpCreatePicker(pickerSeam);
      }
      const def = commands.get('herdr-gentle:warp');
      assert.ok(def, 'warp command registered');
      await def.handler('', built.ctx);
      return { ...built, calls, mod };
    } finally {
      restoreEnv();
    }
  }

  function flowEnv(herdrBin, ghBin) {
    return {
      GENTLE_WORKTREE_LIB_DIR: LIB_DIR,
      GENTLE_STATUS_STATE_DIR: track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-mode-'))),
      HERDR_BIN_PATH: herdrBin,
      GH_BIN_PATH: ghBin,
      GENTLE_WORKTREE_THREAD: 'warp-pick-thread',
    };
  }

  function writeOddTasks(root, names) {
    fs.mkdirSync(path.join(root, 'odd', 'tasks'), { recursive: true });
    for (const name of names) fs.writeFileSync(path.join(root, 'odd', 'tasks', name), `# ${name}\n`);
  }

  function registryOf(root) {
    return require('../lib/worktree-registry.js').readRegistry(root);
  }

  // Mount-0 is the Warp selector when custom UI exists (showTab:false).
  const INLINE_MOUNT_TIMEOUT_MS = 2000;
  function inlineMountText(view) {
    try {
      const lines = view.render(90);
      return Array.isArray(lines) ? lines.join('\n') : '';
    } catch { return ''; }
  }
  function isWarpSelectorView(view) {
    const t = inlineMountText(view);
    return t.includes('Warp session') && t.includes(CREATE_ENTRY);
  }
  function driveWarpSelectorCreate(view, name) {
    const t = inlineMountText(view);
    assert.ok(t.includes('Warp session'), name + ': expected selector');
    assert.ok(t.includes(CREATE_ENTRY), name + ': selector offers create');
    assert.ok(!/Tab back/i.test(t), name + ': selector has no Tab Back');
    view.handleInput('down');
    view.handleInput('enter');
  }

  test('selecting issues and several odd documents registers them on the new worktree', async () => {
    const root = makeRepo('flow-pick');
    writeOddTasks(root, ['one.md', 'two.md', 'three.md', 'notes.txt']);
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First'], [12, 'Second']]);
    const kinds = [];
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      typeValue: 'feat', nameValue: 'picked',
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }, { number: 12, title: 'Second' }] }),
      oddSeam: null, // the real listing reads THIS checkout's odd/tasks
      pickerSeam: async (ctx, { kind, items }) => {
        kinds.push([kind, items.map((i) => i.label)]);
        if (kind === 'issues') return { cancelled: false, selected: [11, 12] };
        return { cancelled: false, selected: items.map((i) => i.id) };
      },
    });
    assert.deepEqual(kinds.map(([k]) => k), ['issues', 'odd'], 'the issues step runs before the odd step');
    assert.deepEqual(kinds[0][1], ['#11 First', '#12 Second'], 'the offered issues carry number and title');
    assert.deepEqual(
      kinds[1][1],
      ['one.md', 'three.md', 'two.md'],
      'the odd step offers THIS checkout odd/tasks/*.md, sorted, no txt',
    );
    const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
    assert.ok(entry, 'the new checkout is registered');
    assert.deepEqual(entry.issues, [11, 12], 'the selected issues are stored');
    assert.equal(entry.odd.length, 3, `several odd documents survive: ${JSON.stringify(entry.odd)}`);
    for (const name of ['one.md', 'two.md', 'three.md']) {
      assert.ok(entry.odd.some((o) => String(o).includes(name)), `odd keeps ${name}`);
    }
    assert.equal(r.switches.length, 1, 'the session warped into the new checkout');
    assert.deepEqual(r.notes, [], 'no refusal, no filler');
  });

  test('confirming with nothing selected proceeds with empty values', async () => {
    const root = makeRepo('flow-empty');
    writeOddTasks(root, ['one.md']);
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }] }),
      pickerSeam: async () => ({ cancelled: false, selected: [] }),
    });
    const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
    assert.ok(entry, 'the checkout is still created');
    assert.deepEqual(entry.issues, [], 'empty confirmation stores no issues');
    assert.deepEqual(entry.odd || [], [], 'empty confirmation stores no odd');
    assert.equal(r.switches.length, 1, 'the warp still follows');
    assert.deepEqual(r.notes, [], 'nothing to refuse');
  });

  test('Esc in the issues step cancels the whole creation and changes nothing', async () => {
    const root = makeRepo('flow-esc-issues');
    writeOddTasks(root, ['one.md']);
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    const before = registryOf(root);
    let oddAsked = 0;
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }] }),
      pickerSeam: async (ctx, { kind }) => {
        if (kind === 'odd') oddAsked += 1;
        return null; // Esc: cancel
      },
    });
    assert.equal(oddAsked, 0, 'the odd step never opens after an issues Esc');
    assert.equal(require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked'), null, 'nothing created');
    assert.deepEqual(registryOf(root), before, 'the registry is untouched');
    assert.deepEqual(r.calls, [], 'no fork');
    assert.deepEqual(r.switches, [], 'no session switch');
    assert.deepEqual(r.notes, [], 'cancel notifies nothing');
  });

  test('Esc in the odd step cancels the whole creation and changes nothing', async () => {
    const root = makeRepo('flow-esc-odd');
    writeOddTasks(root, ['one.md']);
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    const before = registryOf(root);
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }] }),
      pickerSeam: async (ctx, { kind }) => {
        if (kind === 'issues') return { cancelled: false, selected: [11] };
        return null; // Esc at the odd step
      },
    });
    assert.equal(require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked'), null, 'nothing created');
    assert.deepEqual(registryOf(root), before, 'the registry is untouched');
    assert.deepEqual(r.calls, [], 'no fork');
    assert.deepEqual(r.switches, [], 'no session switch');
    assert.deepEqual(r.notes, [], 'cancel notifies nothing');
  });

  test('an erroring gh skips the issues step silently and still offers the odd step', async () => {
    const root = makeRepo('flow-gh-skip');
    writeOddTasks(root, ['one.md']);
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    const kinds = [];
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      issuesSeam: async () => ({ ok: false, skipped: 'gh exploded' }),
      pickerSeam: async (ctx, { kind, items }) => {
        kinds.push(kind);
        if (kind === 'odd') return { cancelled: false, selected: [] };
        throw new Error(`the ${kind} step must be skipped`);
      },
    });
    assert.deepEqual(kinds, ['odd'], 'only the odd step opened');
    const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
    assert.ok(entry, 'the creation is never blocked by a gh failure');
    assert.equal(r.switches.length, 1, 'the warp still follows');
    assert.deepEqual(r.notes, [], 'the skip stays silent');
  });

  test('no odd documents skips the odd step silently', async () => {
    const root = makeRepo('flow-odd-skip');
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    const kinds = [];
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }] }),
      oddSeam: async () => [],
      pickerSeam: async (ctx, { kind, items }) => {
        kinds.push(kind);
        if (kind === 'issues') return { cancelled: false, selected: [11] };
        throw new Error(`the ${kind} step must be skipped`);
      },
    });
    assert.deepEqual(kinds, ['issues'], 'only the issues step opened');
    const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
    assert.ok(entry, 'the creation proceeds');
    assert.deepEqual(entry.issues, [11]);
    assert.deepEqual(entry.odd || [], []);
    assert.equal(r.switches.length, 1, 'the warp still follows');
  });

  test('without a custom host both steps skip silently and the S45 flow is unchanged', async () => {
    const root = makeRepo('flow-no-overlay');
    writeOddTasks(root, ['one.md']);
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    // No seams at all and no ctx.ui.custom: no gh is spawned for the
    // fetch (GH_BIN_PATH points at nothing usable) and no prompt opens.
    const env = flowEnv(herdrBin, undefined);
    env.GH_BIN_PATH = path.join(os.tmpdir(), 'definitely-not-a-gh-binary-pick');
    const r = await runCreate({ root, env, typeValue: 'feat', nameValue: 'picked' });
    const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
    assert.ok(entry, 'the checkout is still created');
    assert.deepEqual(entry.issues, [], 'empty issues, exactly like today');
    assert.deepEqual(entry.odd || [], [], 'no odd, exactly like today');
    assert.equal(r.switches.length, 1, 'the warp still follows');
    assert.deepEqual(r.notes, [], 'the skips stay silent');
  });

  test('a duplicate branch refuses byte-identical with the create path and creates nothing', async () => {
    const root = makeRepo('flow-dup');
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([]);
    git(root, ['worktree', 'add', '-b', 'feat/dup', path.join(path.dirname(root), `${path.basename(root)}-pick-feat-dup`), 'HEAD']);
    require('../lib/worktree-registry.js').upsertWorktree(root, {
      branch: 'feat/dup',
      path: git(root, ['worktree', 'list', '--porcelain']).split('\n').find((l) => l.startsWith('worktree ') && l.includes('pick-feat-dup')).slice('worktree '.length),
      thread: 't', issues: [], odd: [],
    });
    const before = registryOf(root);
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      typeValue: 'feat', nameValue: 'dup',
      issuesSeam: async () => ({ ok: true, issues: [] }),
      oddSeam: async () => [],
      pickerSeam: async () => { throw new Error('no step opens when both lists are empty'); },
    });
    // The direct comparison runs inside the same lib env the flow used
    // (exactly like the S45 duplicate test structures it).
    setEnv(flowEnv(herdrBin, ghBin));
    let direct;
    try {
      direct = await r.mod.executeWorktreeCreate({ branch: 'feat/dup' }, { cwd: root });
    } finally {
      restoreEnv();
    }
    assert.ok(direct.isError, 'the create tool refuses the duplicate too');
    assert.equal(r.notes.length, 1, 'exactly one refusal');
    assert.equal(r.notes[0][0], direct.text, 'byte-identical to the create tool refusal');
    assert.deepEqual(r.calls, [], 'no fork');
    assert.deepEqual(r.switches, [], 'no session switch');
    assert.deepEqual(registryOf(root), before, 'the registry is untouched');
  });

  test('the real inline custom UI drives the shared component: Space toggles, Enter confirms', async () => {
    const root = makeRepo('flow-overlay');
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First'], [12, 'Second']]);
    // No picker seam: the default path renders the shared component
    // through ctx.ui.custom with NO overlay options — the host shows it
    // inline in the editor container, the same bottom-anchored region as
    // the select/input dialogs (S48). Mount 0 is the Warp selector
    // (showTab:false): down+Enter on Create. Next is the issues panel.
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    const mountFailures = [];
    const drive = (factory) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mountFailures.push('overlay timeout');
        reject(new Error('overlay: mount timed out'));
      }, INLINE_MOUNT_TIMEOUT_MS);
      let view;
      try {
        view = factory(hostTui, null, {}, (v) => { clearTimeout(timer); resolve(v); });
      } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); return; }
      try {
        if (isWarpSelectorView(view)) { driveWarpSelectorCreate(view, 'overlay'); return; }
        const t = inlineMountText(view);
        assert.ok(t.includes('Select issues (optional)'), 'overlay: issues panel, got ' + t.slice(0, 120));
        view.handleInput('down');
        view.handleInput('space');
        view.handleInput('enter');
      } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); }
    });
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      typeValue: 'feat', nameValue: 'picked',
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }, { number: 12, title: 'Second' }] }),
      oddSeam: async () => [],
      selectImpl: () => { throw new Error('overlay: no fallback select'); },
      customImpl: (factory, opts) => drive(factory),
    });
    assert.deepEqual(mountFailures, [], 'mounts settle with expected titles');
    assert.equal(r.selects.length, 0, 'no fallback select');
    assert.equal(r.customs.length, 2, 'selector plus one issues picker (odd skipped)');
    for (const o of r.customs) assert.equal(o, undefined, 'S48 inline');
    const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
    assert.ok(entry, 'the checkout is created');
    assert.deepEqual(entry.issues, [12], 'the Space-toggled issue is registered');
    assert.equal(r.switches.length, 1, 'the warp still follows');
    assert.deepEqual(r.notes, [], 'no refusal, no filler');
  });

  test('Esc in the real inline picker cancels the whole creation', async () => {
    const root = makeRepo('flow-overlay-esc');
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    const before = registryOf(root);
    const mountFailures = [];
    const escImpl = (factory) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { mountFailures.push('esc timeout'); reject(new Error('esc: mount timed out')); }, INLINE_MOUNT_TIMEOUT_MS);
      let view;
      try {
        view = factory(hostTui, null, {}, (v) => { clearTimeout(timer); resolve(v); });
      } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); return; }
      try {
        if (isWarpSelectorView(view)) { driveWarpSelectorCreate(view, 'esc'); return; }
        const t = inlineMountText(view);
        assert.ok(t.includes('Select issues (optional)'), 'esc reaches issues, got ' + t.slice(0, 120));
        view.handleInput('escape');
      } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); }
    });
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      typeValue: 'feat', nameValue: 'picked',
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }] }),
      oddSeam: async () => [],
      selectImpl: () => { throw new Error('esc: no fallback select'); },
      customImpl: escImpl,
    });
    assert.deepEqual(mountFailures, [], 'mounts settle with expected titles');
    assert.equal(r.selects.length, 0, 'no fallback select');
    assert.equal(r.customs.length, 2, 'selector plus issues picker that Esc cancels');
    assert.equal(require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked'), null, 'nothing created');
    assert.deepEqual(registryOf(root), before, 'the registry is untouched');
    assert.deepEqual(r.calls, [], 'no fork');
    assert.deepEqual(r.switches, [], 'no session switch');
    assert.deepEqual(r.notes, [], 'cancel notifies nothing');
  });

  test('Back walks the wizard back with every value kept; one creation at the end', async () => {
    const root = makeRepo('flow-back');
    writeOddTasks(root, ['one.md', 'two.md']);
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First'], [12, 'Second']]);
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-sess-'))), 'session.jsonl');
    fs.writeFileSync(sessionFile, '{"type":"session"}\n');
    const names = [];
    const built = makeCtx({
      cwd: root, FakeSM, calls, sessionFile, sessionDir: path.dirname(sessionFile),
      selectImpl: (title, options) => options[options.length - 1],
    });
    setEnv(flowEnv(herdrBin, ghBin));
    try {
      const { commands, mod } = await loadExtension();
      mod.setWarpCreateTypeAsker(async () => 'feat');
      const nameAnswers = ['picked', 'picked'];
      mod.setWarpCreateNameAsker(async (ctx, previous) => {
        names.push(previous || null);
        return nameAnswers.shift();
      });
      mod.setWarpCreateIssuesFetcher(async () => ({
        ok: true, issues: [{ number: 11, title: 'First' }, { number: 12, title: 'Second' }],
      }));
      const picks = [];
      let issuesCalls = 0;
      let oddCalls = 0;
      mod.setWarpCreatePicker(async (ctx, { kind, initialSelected }) => {
        picks.push([kind, (initialSelected || []).slice()]);
        if (kind === 'issues') {
          issuesCalls += 1;
          if (issuesCalls === 1) return { cancelled: false, selected: [11] };
          if (issuesCalls === 2) return { back: true };
          return { cancelled: false, selected: [11] };
        }
        if (kind === 'odd') {
          oddCalls += 1;
          if (oddCalls === 1) return { back: true };
          return { cancelled: false, selected: [] };
        }
        throw new Error(`unexpected pick ${kind}`);
      });
      const def = commands.get('herdr-gentle:warp');
      await def.handler('', built.ctx);
      assert.deepEqual(picks[0], ['issues', []], 'the first issues pass starts empty');
      assert.deepEqual(picks[1], ['odd', []], 'the first odd pass starts empty');
      assert.deepEqual(picks[2], ['issues', [11]], 'Back from odd restores the kept issues');
      assert.deepEqual(names, [null, 'picked'], 'Back from issues re-asks the name showing the kept value');
      assert.deepEqual(picks[3], ['issues', [11]], 'the re-asked name returns to issues with values kept');
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
      assert.ok(entry, 'exactly one checkout is created at the end');
      assert.deepEqual(entry.issues, [11], 'the final issues confirmation wins');
      assert.equal(built.switches.length, 1, 'the warp follows once');
      assert.deepEqual(built.notes, [], 'no refusal, no filler');
    } finally {
      restoreEnv();
    }
  });

  test('issue and odd sources fetch once per wizard despite Back revisits', async () => {
    const root = makeRepo('flow-fetch-once');
    writeOddTasks(root, ['one.md']);
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    let issueCalls = 0;
    let oddCalls = 0;
    let pickCalls = 0;
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      typeValue: 'feat', nameValue: 'picked',
      issuesSeam: async () => { issueCalls += 1; return { ok: true, issues: [{ number: 11, title: 'First' }] }; },
      oddSeam: async () => { oddCalls += 1; return [{ name: 'one.md', abs: path.join(root, 'odd', 'tasks', 'one.md') }]; },
      pickerSeam: async (ctx, { kind }) => {
        pickCalls += 1;
        if (pickCalls === 1) return { cancelled: false, selected: [11] };
        if (pickCalls === 2) return { back: true };
        if (pickCalls === 3) return { back: true };
        if (pickCalls === 4) return { cancelled: false, selected: [11] };
        return { cancelled: false, selected: [] };
      },
    });
    assert.equal(issueCalls, 1, 'the issues source fetches once per wizard invocation, never per revisit');
    assert.equal(oddCalls, 1, 'the odd source lists once per wizard invocation, never per revisit');
    const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
    assert.ok(entry, 'exactly one checkout is created at the end');
    assert.deepEqual(entry.issues, [11], 'the final issues confirmation wins');
    assert.equal(r.switches.length, 1, 'the warp follows once');
    assert.deepEqual(r.notes, [], 'no refusal, no filler');
  });

  test('issue filter and selection survive a Back round trip through the real inline UI', async () => {
    const root = makeRepo('flow-filter-kept');
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First'], [12, 'Second']]);
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-sess-'))), 'session.jsonl');
    fs.writeFileSync(sessionFile, '{"type":"session"}\n');
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    const seen = [];
    let call = 0;
    const mountFailures = [];
    const built = makeCtx({
      cwd: root, FakeSM, calls, sessionFile, sessionDir: path.dirname(sessionFile),
      selectImpl: () => { throw new Error('filter-kept: no fallback select'); },
      customImpl: (factory) => new Promise((resolve, reject) => {
        const m = call++;
        const timer = setTimeout(() => { mountFailures.push('m' + m); reject(new Error('filter-kept mount ' + m + ' timed out')); }, INLINE_MOUNT_TIMEOUT_MS);
        let view;
        try {
          view = factory(hostTui, null, {}, (v) => { clearTimeout(timer); resolve(v); });
        } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); return; }
        try {
          if (isWarpSelectorView(view)) { assert.equal(m, 0); driveWarpSelectorCreate(view, 'filter'); return; }
          const t = inlineMountText(view);
          assert.ok(t.includes('Select issues (optional)'), 'issues panel, got ' + t.slice(0, 120));
          if (m === 1) {
            view.handleInput('down');
            view.handleInput(' ');
            view.handleInput('t');
            for (const ch of 'Second') view.handleInput(ch);
            view.handleInput('\t');
          } else {
            assert.equal(m, 2);
            seen.push({ query: view.state.query, selected: view.state.selected.slice() });
            view.handleInput('\r');
          }
        } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); }
      }),
    });
    setEnv(flowEnv(herdrBin, ghBin));
    try {
      const { commands, mod } = await loadExtension();
      mod.setWarpCreateTypeAsker(async () => 'feat');
      mod.setWarpCreateNameAsker(async () => 'picked');
      mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: [{ number: 11, title: 'First' }, { number: 12, title: 'Second' }] }));
      mod.setWarpCreateOddLister(async () => []);
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.deepEqual(mountFailures, [], 'mounts settle with expected titles');
      assert.equal(built.selects.length, 0, 'no fallback select');
      assert.equal(call, 3, 'selector plus issues opened, went Back, and re-opened: three mounts');
      assert.deepEqual(seen, [{ query: 'Second', selected: [12] }], 'the revisit restores the kept filter and the kept selection');
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
      assert.ok(entry, 'the checkout is created after the return trip');
      assert.deepEqual(entry.issues, [12], 'the kept selection confirms');
      assert.equal(built.switches.length, 1, 'the warp follows once');
      assert.deepEqual(built.notes, [], 'no refusal, no filler');
    } finally {
      restoreEnv();
    }
  });

  test('kept type restores the cursor on the inline re-ask', async () => {
    const root = makeRepo('flow-type-cursor');
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([]);
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-sess-'))), 'session.jsonl');
    fs.writeFileSync(sessionFile, '{"type":"session"}\n');
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    let call = 0;
    const mountFailures = [];
    const built = makeCtx({
      cwd: root, FakeSM, calls, sessionFile, sessionDir: path.dirname(sessionFile),
      selectImpl: () => { throw new Error('type-cursor: no fallback select'); },
      customImpl: (factory) => new Promise((resolve, reject) => {
        const m = call++;
        const timer = setTimeout(() => { mountFailures.push('m' + m); reject(new Error('type-cursor mount ' + m + ' timed out')); }, INLINE_MOUNT_TIMEOUT_MS);
        let view;
        try {
          view = factory(hostTui, null, {}, (v) => { clearTimeout(timer); resolve(v); });
        } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); return; }
        try {
          if (isWarpSelectorView(view)) { assert.equal(m, 0); driveWarpSelectorCreate(view, 'cursor'); return; }
          const t = inlineMountText(view);
          if (m === 1) {
            assert.ok(t.includes('New worktree change type'));
            view.handleInput('down');
            view.handleInput('enter');
          } else if (m === 2) {
            assert.ok(t.includes('New worktree change name'));
            view.handleInput('\t');
          } else if (m === 3) {
            assert.ok(t.includes('New worktree change type'));
            view.handleInput('enter');
          } else {
            assert.equal(m, 4);
            assert.ok(t.includes('New worktree change name'));
            for (const ch of 'picked') view.handleInput(ch);
            view.handleInput('enter');
          }
        } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); }
      }),
    });
    setEnv(flowEnv(herdrBin, ghBin));
    try {
      const { commands, mod } = await loadExtension();
      mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: [] }));
      mod.setWarpCreateOddLister(async () => []);
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.deepEqual(mountFailures, [], 'mounts settle with expected titles');
      assert.equal(built.selects.length, 0, 'no fallback select');
      assert.equal(call, 5, 'selector, type, name, type again, name again — sequential mounts');
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'fix/picked');
      assert.ok(entry, 'the re-asked type kept the cursor on fix: Enter confirmed it without moving');
      assert.equal(built.switches.length, 1, 'the warp follows once');
      assert.deepEqual(built.notes, [], 'no refusal, no filler');
    } finally {
      restoreEnv();
    }
  });

  test('nothing mutates until the odd step confirms (deferred creation)', async () => {
    const root = makeRepo('flow-deferred');
    writeOddTasks(root, ['one.md']);
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    const seen = [];
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      typeValue: 'feat', nameValue: 'picked',
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }] }),
      oddSeam: null,
      pickerSeam: async (ctx, { kind }) => {
        const listed = git(root, ['branch', '--list', 'feat/picked']);
        const registered = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
        seen.push([kind, listed, registered]);
        if (kind === 'issues') return { cancelled: false, selected: [11] };
        return { cancelled: false, selected: [] };
      },
    });
    assert.equal(seen.length, 2, 'both steps ran before any mutation');
    for (const [kind, branch, registered] of seen) {
      assert.equal(branch, '', `no git branch exists during the ${kind} step`);
      assert.equal(registered, null, `no registry row exists during the ${kind} step`);
    }
    assert.ok(require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked'), 'created after all confirmations');
    assert.equal(r.switches.length, 1, 'the warp follows');
  });

  test('create-from-warp never invokes Herdr: git checkout plus registry only', async () => {
    const root = makeRepo('flow-gitonly');
    writeOddTasks(root, ['one.md']);
    const marker = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-herdrspy-'))), 'called');
    const spyDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-spy-')));
    const spy = path.join(spyDir, 'herdr');
    fs.writeFileSync(spy, [
      '#!/bin/sh',
      `touch ${JSON.stringify(marker)}`,
      'echo "herdr spy: must never run in the git-only wizard" >&2; exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    const ghBin = makeGhStub([[11, 'First']]);
    const r = await runCreate({
      root, env: flowEnv(spy, ghBin),
      typeValue: 'feat', nameValue: 'picked',
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }] }),
      oddSeam: null,
      pickerSeam: async (ctx, { kind }) => {
        if (kind === 'issues') return { cancelled: false, selected: [11] };
        return { cancelled: false, selected: [] };
      },
    });
    assert.equal(fs.existsSync(marker), false, 'no Herdr invocation happened');
    const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
    assert.ok(entry, 'the checkout is registered');
    assert.ok(git(root, ['worktree', 'list', '--porcelain']).includes(entry.path), 'a live git checkout backs it');
    assert.equal(r.switches.length, 1, 'the warp follows');
    assert.deepEqual(r.notes, [], 'no refusal, no filler');
  });

  test('a failing custom host STOPS the creation loudly, never silently', async () => {
    const root = makeRepo('flow-stop');
    const herdrBin = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    const before = registryOf(root);
    const mountFailures = [];
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    const failImpl = (factory) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { mountFailures.push('stop timeout'); reject(new Error('stop: mount timed out')); }, INLINE_MOUNT_TIMEOUT_MS);
      let view;
      try {
        view = factory(hostTui, null, {}, (v) => { clearTimeout(timer); resolve(v); });
      } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); return; }
      try {
        if (isWarpSelectorView(view)) { driveWarpSelectorCreate(view, 'stop'); return; }
        const t = inlineMountText(view);
        assert.ok(t.includes('Select issues (optional)'), 'stop at issues, got ' + t.slice(0, 120));
        clearTimeout(timer);
        reject(new Error('host render exploded'));
      } catch (e) {
        clearTimeout(timer);
        if (String((e && e.message) || e) === 'host render exploded') { reject(e); return; }
        mountFailures.push(String(e)); reject(e);
      }
    });
    const r = await runCreate({
      root, env: flowEnv(herdrBin, ghBin),
      typeValue: 'feat', nameValue: 'picked',
      issuesSeam: async () => ({ ok: true, issues: [{ number: 11, title: 'First' }] }),
      oddSeam: async () => [],
      selectImpl: () => { throw new Error('stop: no fallback select'); },
      customImpl: failImpl,
    });
    assert.deepEqual(mountFailures, [], 'selector settles');
    assert.equal(r.selects.length, 0, 'no fallback select');
    assert.equal(r.customs.length, 2, 'selector plus failing issues picker');
    assert.equal(r.notes.length, 1, 'exactly one actionable error');
    assert.match(r.notes[0][0], /nothing was created/, 'the refusal says nothing was created');
    assert.equal(require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked'), null, 'nothing created');
    assert.deepEqual(registryOf(root), before, 'the registry is untouched');
    assert.deepEqual(r.switches, [], 'no session switch');
  });

  test('create-from-warp from a linked worktree lands beside the principal with the worktree HEAD', async () => {
    const root = makeRepo('flow-canon');
    const linked = path.join(path.dirname(root), `${path.basename(root)}-linked`);
    track(linked);
    git(root, ['worktree', 'add', linked, '-b', 'feat/base']);
    const headBefore = git(linked, ['rev-parse', 'HEAD']);
    const expected = path.join(path.dirname(root), `${path.basename(root)}-worktrees`, 'feat-picked');
    assert.ok(!expected.startsWith(fs.realpathSync(linked)), 'the canonical path is never nested in the worktree');
    const marker = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-nospy-'))), 'called');
    const spyDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-spy2-')));
    const spy = path.join(spyDir, 'herdr');
    fs.writeFileSync(spy, [
      '#!/bin/sh',
      `touch ${JSON.stringify(marker)}`,
      'echo "herdr spy: must never run" >&2; exit 1',
      '',
    ].join('\n'), { mode: 0o755 });
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-sess-'))), 'session.jsonl');
    fs.writeFileSync(sessionFile, '{"type":"session"}\n');
    const built = makeCtx({
      cwd: fs.realpathSync(linked), FakeSM, calls, sessionFile, sessionDir: path.dirname(sessionFile),
      selectImpl: (title, options) => options[options.length - 1],
    });
    setEnv(flowEnv(spy, undefined));
    try {
      const { commands, mod } = await loadExtension();
      mod.setWarpCreateTypeAsker(async () => 'feat');
      mod.setWarpCreateNameAsker(async () => 'picked');
      mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: [] }));
      mod.setWarpCreateOddLister(async () => []);
      mod.setWarpCreatePicker(async () => { throw new Error('no step opens when both lists are empty'); });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.equal(fs.existsSync(marker), false, 'no Herdr invocation happened');
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
      assert.ok(entry, 'the checkout is registered');
      assert.equal(fs.realpathSync(entry.path), fs.realpathSync(expected), 'sibling to the principal, not the worktree');
      assert.equal(git(entry.path, ['rev-parse', 'HEAD']), headBefore, 'the branch is born from the current checkout HEAD');
      assert.equal(built.switches.length, 1, 'the warp follows');
      assert.deepEqual(built.notes, [], 'no refusal, no filler');
    } finally {
      restoreEnv();
    }
  });

  test('Tab Back from the name returns to the type with values kept; one UI at a time', async () => {
    const root = makeRepo('flow-nameback');
    const spy = makeHerdrCreateStub();
    const ghBin = makeGhStub([[11, 'First']]);
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const sessionFile = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-sess-'))), 'session.jsonl');
    fs.writeFileSync(sessionFile, '{"type":"session"}\n');
    const hostTui = { requestRender: () => {}, terminal: { rows: 24 } };
    let active = 0;
    let maxActive = 0;
    let call = 0;
    const mountFailures = [];
    const drives = [
      (view) => {
        const t = inlineMountText(view);
        assert.ok(t.includes('New worktree change name'), 'name panel, got ' + t.slice(0, 120));
        view.handleInput('\t');
      },
      (view) => {
        const t = inlineMountText(view);
        assert.ok(t.includes('New worktree change name'), 'name re-ask, got ' + t.slice(0, 120));
        for (const ch of 'picked') view.handleInput(ch); view.handleInput('enter');
      },
      (view) => {
        const t = inlineMountText(view);
        assert.ok(t.includes('Select issues (optional)'), 'issues last, got ' + t.slice(0, 120));
        view.handleInput(' '); view.handleInput('enter');
      },
    ];
    const built = makeCtx({
      cwd: root, FakeSM, calls, sessionFile, sessionDir: path.dirname(sessionFile),
      selectImpl: () => { throw new Error('nameback: no fallback select'); },
      customImpl: (factory) => {
        const n = call++;
        return (async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          try {
            return await new Promise((resolve, reject) => {
              const timer = setTimeout(() => { mountFailures.push('n' + n); reject(new Error('nameback mount ' + n + ' timed out')); }, INLINE_MOUNT_TIMEOUT_MS);
              let view;
              try {
                view = factory(hostTui, null, {}, (v) => { clearTimeout(timer); resolve(v); });
              } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); return; }
              try {
                if (isWarpSelectorView(view)) { assert.equal(n, 0); driveWarpSelectorCreate(view, 'name'); return; }
                assert.ok(n >= 1 && n <= 3, 'mount ' + n);
                drives[n - 1](view);
              } catch (e) { clearTimeout(timer); mountFailures.push(String(e)); reject(e); }
            });
          } finally {
            active -= 1;
          }
        })();
      },
    });
    setEnv(flowEnv(spy, ghBin));
    try {
      const { commands, mod } = await loadExtension();
      let typeCount = 0;
      mod.setWarpCreateTypeAsker(async () => { typeCount += 1; return 'feat'; });
      mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: [{ number: 11, title: 'First' }] }));
      mod.setWarpCreateOddLister(async () => []);
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.deepEqual(mountFailures, [], 'mounts settle with expected titles');
      assert.equal(built.selects.length, 0, 'no fallback select');
      assert.equal(typeCount, 2, 'Tab Back from the name re-asks the type');
      assert.equal(call, 4, 'selector, name, name again, then issues — sequential mounts');
      assert.equal(maxActive, 1, 'exactly one mounted UI at a time, never nested');
      for (const opts of built.customs) assert.equal(opts, undefined, 'every step stays inline, no overlay');
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
      assert.ok(entry, 'the checkout is created after the return trip');
      assert.deepEqual(entry.issues, [11], 'the issues confirmation lands');
      assert.equal(built.switches.length, 1, 'the warp follows once');
      assert.deepEqual(built.notes, [], 'no refusal, no filler');
    } finally {
      restoreEnv();
    }
  });

  test('an allocated-but-missing session with nothing in memory refuses before any mutation', async () => {
    const root = makeRepo('flow-preflight-refuse');
    const spy = makeHerdrCreateStub();
    const ghBin = makeGhStub([]);
    const ghost = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-ghost-'))), 'missing.jsonl');
    assert.equal(fs.existsSync(ghost), false, 'the allocated file was never written');
    const before = registryOf(root);
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const built = makeCtx({
      cwd: root, FakeSM, calls, sessionFile: ghost, sessionDir: os.tmpdir(), entries: [],
      selectImpl: (title, options) => options[options.length - 1],
    });
    setEnv(flowEnv(spy, ghBin));
    try {
      const { commands, mod } = await loadExtension();
      mod.setWarpCreateTypeAsker(async () => 'feat');
      mod.setWarpCreateNameAsker(async () => 'picked');
      mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: [] }));
      mod.setWarpCreateOddLister(async () => []);
      mod.setWarpCreatePicker(async () => { throw new Error('no step opens when both lists are empty'); });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      assert.equal(built.notes.length, 1, 'exactly one refusal');
      assert.match(built.notes[0][0], /no persisted session/, 'the refusal names the missing session');
      assert.equal(git(root, ['branch', '--list', 'feat/picked']), '', 'no branch was created');
      assert.equal(require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked'), null, 'nothing registered');
      assert.deepEqual(registryOf(root), before, 'the registry is untouched');
      assert.deepEqual(calls, [], 'no fork, no create-time session call');
      assert.deepEqual(built.switches, [], 'no session switch');
    } finally {
      restoreEnv();
    }
  });

  test('an allocated-but-missing session with entries in memory still carries over', async () => {
    const root = makeRepo('flow-preflight-carry');
    const spy = makeHerdrCreateStub();
    const ghBin = makeGhStub([]);
    const ghost = path.join(track(fs.mkdtempSync(path.join(os.tmpdir(), 'wt-pick-ghost-'))), 'missing.jsonl');
    const calls = [];
    const FakeSM = makeFakeSM(calls);
    const built = makeCtx({
      cwd: root, FakeSM, calls, sessionFile: ghost, sessionDir: os.tmpdir(),
      entries: [{ id: 'e1', parentId: null, type: 'message' }],
      selectImpl: (title, options) => options[options.length - 1],
    });
    setEnv(flowEnv(spy, ghBin));
    try {
      const { commands, mod } = await loadExtension();
      mod.setWarpCreateTypeAsker(async () => 'feat');
      mod.setWarpCreateNameAsker(async () => 'picked');
      mod.setWarpCreateIssuesFetcher(async () => ({ ok: true, issues: [] }));
      mod.setWarpCreateOddLister(async () => []);
      mod.setWarpCreatePicker(async () => { throw new Error('no step opens when both lists are empty'); });
      await commands.get('herdr-gentle:warp').handler('', built.ctx);
      const entry = require('../lib/worktree-registry.js').findByBranch(root, 'feat/picked');
      assert.ok(entry, 'the checkout is created');
      assert.ok(!calls.some(([name]) => name === 'forkFrom'), 'no fork from the missing file');
      assert.ok(calls.some(([name]) => name === 'create'), 'the in-memory carry path cloned the entries');
      assert.equal(built.switches.length, 1, 'the warp follows');
      assert.deepEqual(built.notes, [], 'no refusal, no filler');
    } finally {
      restoreEnv();
    }
  });
});

describe('freeze/cancel/key regression (S52: real matcher + raw fallback)', { concurrency: false }, () => {
  const items = [
    { id: 11, label: '#11 First' },
    { id: 12, label: '#12 Second' },
  ];
  const identityFilter = (rows, q) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(query));
  };

  function open(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select issues (optional)',
      items,
      filterFn: identityFilter,
      pageSize: 8,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  test("the installed matcher accepts the ids the picker passes ('escape', 'enter', 'tab')", { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    assert.equal(typeof tui.matchesKey, 'function', 'the host exposes matchesKey');
    // The explorer claim that 'escape' is invalid never executed: the
    // installed keys.js matches BOTH spellings, plus raw sequences.
    assert.equal(tui.matchesKey('\x1b', 'escape'), true, 'raw Esc matches escape');
    assert.equal(tui.matchesKey('\x1b', 'esc'), true, 'raw Esc matches esc');
    assert.equal(tui.matchesKey('\r', 'enter'), true, 'raw CR matches enter');
    assert.equal(tui.matchesKey('\r', 'return'), true, 'raw CR matches return');
    assert.equal(tui.matchesKey('\t', 'tab'), true, 'raw Tab matches tab');
  });

  test('with the real helpers, raw terminal keys drive the picker', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const helpers = { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease };
    const first = open({ helpers });
    first.view.handleInput('\x1b');
    assert.deepEqual(first.finished, [null], 'raw Esc cancels');
    const second = open({ helpers });
    second.view.handleInput('\x1b[B');
    second.view.handleInput(' ');
    assert.deepEqual(second.view.state.selected, [12], 'raw arrow moved, raw Space toggled');
    second.view.handleInput('\r');
    assert.deepEqual(second.finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'raw CR confirms');
    const third = open({ helpers });
    third.view.handleInput('\t');
    assert.deepEqual(third.finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw Tab goes Back with selections and position echoed');
    const fourth = open({ helpers });
    fourth.view.handleInput('\x1b[C');
    assert.equal(fourth.view.state.page, 0, 'one page: RIGHT clamps');
  });

  test('without helpers, raw control sequences still work (never a dead picker)', () => {
    const esc = open();
    esc.view.handleInput('\x1b');
    assert.deepEqual(esc.finished, [null], 'raw Esc cancels with no helpers');
    const enter = open();
    enter.view.handleInput('\r');
    assert.deepEqual(enter.finished, [{ selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw CR confirms empty with no helpers');
    const space = open();
    space.view.handleInput(' ');
    assert.deepEqual(space.view.state.selected, [11], 'raw Space toggles the focused row');
    const tab = open();
    tab.view.handleInput('\t');
    assert.deepEqual(tab.finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'raw Tab goes Back, never toggles');
    const arrows = open();
    arrows.view.handleInput('\x1b[B');
    arrows.view.handleInput(' ');
    assert.deepEqual(arrows.view.state.selected, [12], 'raw arrow moves before toggling');
    const bs = open({ pageSize: 12 });
    bs.view.handleInput('t');
    bs.view.handleInput('x');
    bs.view.handleInput('\x7f');
    assert.equal(bs.view.state.query, '', 'raw DEL edits the query');
  });

  test('completion fires exactly once under an input storm', () => {
    const { view, finished } = open();
    view.handleInput('escape');
    view.handleInput('escape');
    view.handleInput('enter');
    view.handleInput('\x1b');
    view.handleInput('\r');
    view.handleInput('tab');
    view.handleInput(' ');
    assert.deepEqual(finished, [null], 'one cancel, never a second resolution');
    const confirm = open();
    confirm.view.handleInput('enter');
    confirm.view.handleInput('enter');
    confirm.view.handleInput('escape');
    confirm.view.handleInput('tab');
    assert.equal(confirm.finished.length, 1, 'one confirm, never a second resolution');
    assert.deepEqual(confirm.finished[0], { selected: [], uiState: { query: '', page: 0, cursor: 0 } });
    const back = open();
    back.view.handleInput('tab');
    back.view.handleInput('tab');
    back.view.handleInput('enter');
    assert.deepEqual(back.finished, [{ back: true, selected: [], uiState: { query: '', page: 0, cursor: 0 } }], 'one back, never a second resolution');
  });

  test('Enter confirms the step (empty valid); Space toggles; no Confirm row, no Back row', () => {
    const { view, finished } = open();
    const text = view.render(90).join('\n');
    assert.ok(!text.includes('Confirm'), 'no Confirm row renders: Enter confirms');
    assert.ok(!text.includes('Back'), 'no selectable Back row renders: Tab goes back');
    // No phantom focus row after the last data item: the cursor roams
    // data rows only, so Enter on the last row still confirms.
    view.handleInput('down');
    view.handleInput('down');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [], uiState: { query: '', page: 0, cursor: 1 } }], 'Enter on the last data row confirms, never goes back');
  });

  test('Space toggles the focused checkbox without completing', () => {
    const { view, finished } = open();
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [11], 'Space toggles on');
    assert.deepEqual(finished, [], 'toggling never completes');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [], 'Space toggles off');
    view.handleInput('down');
    view.handleInput(' ');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'Enter confirms the toggled selection');
  });

  test('Tab alone returns to the previous step; Enter always confirms, Space always toggles', () => {
    const { view, finished } = open();
    view.handleInput('down');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [12], 'the second item is selected');
    // No selectable Back row exists, so moving past the last data item
    // clamps there and Enter still confirms the selection.
    view.handleInput('down');
    view.handleInput('down');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'Enter past the last row confirms, never a Back row');
    const viaSpace = open();
    viaSpace.view.handleInput('down');
    viaSpace.view.handleInput('down');
    viaSpace.view.handleInput('down');
    viaSpace.view.handleInput(' ');
    assert.deepEqual(viaSpace.view.state.selected, [12], 'Space past the last row toggles data, never a Back row');
    assert.deepEqual(viaSpace.finished, [], 'toggling never completes');
    const viaTab = open();
    viaTab.view.handleInput('down');
    viaTab.view.handleInput(' ');
    viaTab.view.handleInput('\t');
    assert.deepEqual(viaTab.finished, [{ back: true, selected: [12], uiState: { query: '', page: 0, cursor: 1 } }], 'raw Tab alone goes back with values and position kept');
    assert.deepEqual(viaTab.view.state.selected, [12], 'the selections survive for the return trip');
  });

  test('initialSelected restores the previous pass selections', () => {
    const { view, finished } = open({ initialSelected: [12] });
    assert.deepEqual(view.state.selected, [12], 'the earlier selection survives the round trip');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [12], uiState: { query: '', page: 0, cursor: 0 } }], 'Enter confirms the restored selection');
  });

  test('an empty filter renders no selectable rows; raw Tab still goes back', () => {
    const { view, finished } = open();
    view.handleInput('t');
    for (const ch of 'zzz-no-match') view.handleInput(ch);
    const text = view.render(90).join('\n');
    assert.ok(text.includes('(no matches)'), 'items filter out');
    assert.ok(!text.includes('Confirm'), 'no Confirm row appears on an empty filter either');
    assert.ok(!text.includes('Back'), 'no selectable Back row appears on an empty filter either');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list', 'Enter leaves search for the list');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [], uiState: { query: 'zzz-no-match', page: 0, cursor: 0 } }], 'raw Tab goes Back even with an empty filter');
  });

  test('T reopens the kept query; clearing it restores every row', () => {
    const { view, finished } = open({ pageSize: 12 });
    view.handleInput('t');
    for (const ch of 'zzz') view.handleInput(ch);
    assert.ok(view.render(120).join('\n').includes('(no matches)'), 'the live filter hides every row');
    view.handleInput('enter');
    assert.equal(view.state.mode, 'list');
    view.handleInput('t');
    assert.equal(view.state.mode, 'search', 'T reopens the field');
    assert.equal(view.state.query, 'zzz', 'the kept query is there for editing');
    for (let i = 0; i < 3; i += 1) view.handleInput('backspace');
    assert.equal(view.state.query, '', 'clearing empties the query');
    view.handleInput('enter');
    const text = view.render(120).join('\n');
    assert.ok(text.includes('#11 First') && text.includes('#12 Second'), 'clearing restores every row');
    assert.deepEqual(finished, [], 'nothing completed along the way');
  });

  test('Esc in search exits to the list without cancelling', () => {
    const { view, finished } = open();
    view.handleInput('t');
    view.handleInput('1');
    view.handleInput('escape');
    assert.equal(view.state.mode, 'list', 'Esc leaves search for the list');
    assert.equal(view.state.query, '1', 'the filter is retained');
    assert.deepEqual(finished, [], 'Esc in search never cancels the step');
    view.handleInput('escape');
    assert.deepEqual(finished, [null], 'Esc in list still cancels');
  });

  test('T and Space in search are text; arrows never page there', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null, done: () => {},
    });
    const textOf = () => view.render(120).join('\n');
    view.handleInput('t');
    view.handleInput('t');
    view.handleInput(' ');
    view.handleInput('t');
    assert.equal(view.state.query, 't t', 'T and Space type inside the field');
    view.handleInput('left');
    view.handleInput('right');
    assert.match(textOf(), /page 1\/3/i, 'LEFT/RIGHT in search never page');
    assert.equal(view.state.mode, 'search', 'the field stays open');
    const footer = textOf();
    assert.match(footer, /back to list/i, 'the search footer says how to leave');
    assert.match(footer, /filter kept/i, 'the search footer promises the retained filter');
  });

  test('selections persist across filters and pages', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null,
      filterFn: (list, q) => {
        const query = String(q || '').trim().toLowerCase();
        if (!query) return list;
        return list.filter((r) => r.label.toLowerCase().includes(query));
      },
      done: (out) => { finished.push(out); },
    });
    view.handleInput(' ');
    view.handleInput('right');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [1, 6], 'one per page');
    view.handleInput('t');
    for (const ch of 'row 1') view.handleInput(ch);
    assert.deepEqual(view.state.selected, [1, 6], 'filtering keeps selections');
    view.handleInput('enter');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [1, 6], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'confirm carries selections across filters and pages');
  });

  test('LEFT/RIGHT turn item pages; selections and search survive', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null,
      done: (out) => { finished.push(out); },
    });
    const textOf = () => view.render(90).join('\n');
    assert.match(textOf(), /page 1\/3/i);
    view.handleInput('right');
    assert.match(textOf(), /page 2\/3/i, 'RIGHT turns to the next page');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [6], 'Space toggles on the new page');
    view.handleInput('left');
    assert.match(textOf(), /page 1\/3/i, 'LEFT turns back');
    view.handleInput('right');
    assert.deepEqual(view.state.selected, [6], 'the selection survives page changes');
    view.handleInput('right');
    view.handleInput('right');
    assert.match(textOf(), /page 3\/3/i, 'the last page clamps');
    view.handleInput('left');
    view.handleInput('left');
    view.handleInput('left');
    assert.match(textOf(), /page 1\/3/i, 'the first page clamps');
    view.handleInput('enter');
    assert.deepEqual(finished, [{ selected: [6], uiState: { query: '', page: 0, cursor: 0 } }], 'Enter confirms across pages');
  });

  test('raw LEFT/RIGHT sequences page; raw arrows respect search mode', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
    const view = picker.createMultiSelect({
      title: 'Paged', items: rows, pageSize: 5, helpers: null, hostTui: null, theme: null, done: () => {},
      filterFn: (list, q) => {
        const query = String(q || '').trim().toLowerCase();
        if (!query) return list;
        return list.filter((r) => r.label.toLowerCase().includes(query));
      },
    });
    const textOf = () => view.render(120).join('\n');
    view.handleInput('\x1b[C');
    assert.match(textOf(), /page 2\/3/i, 'raw RIGHT turns the page');
    view.handleInput('\x1b[D');
    assert.match(textOf(), /page 1\/3/i, 'raw LEFT turns back');
    view.handleInput('t');
    assert.equal(view.state.mode, 'search', 'T opens the search field');
    view.handleInput('q');
    assert.equal(view.state.query, 'q', 'typing filters inside the field');
    assert.equal(view.state.page, 0, 'typing resets to the first page');
    view.handleInput('\x1b[C');
    assert.match(textOf(), /page 1\/1/i, 'raw RIGHT in search never pages');
    assert.equal(view.state.mode, 'search', 'search mode is kept');
    view.handleInput('\x1b[B');
    assert.equal(view.state.mode, 'list', 'raw DOWN moves from the search into the rows');
  });

  test('the async gh fetch keeps the verified argv shape', async () => {
    const seen = [];
    const { EventEmitter } = require('node:events');
    const spawnFn = (bin, argv, opts) => {
      seen.push({ bin, argv });
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      setImmediate(() => {
        proc.stdout.emit('data', JSON.stringify([{ number: 5, title: 'Async row' }]));
        proc.emit('close', 0);
      });
      return proc;
    };
    const out = await picker.fetchOpenIssuesAsync({ cwd: '/repo', ghBin: 'gh', spawnFn });
    assert.equal(out.ok, true);
    assert.deepEqual(out.issues, [{ number: 5, title: 'Async row' }]);
    assert.deepEqual(
      seen[0].argv,
      ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', '200'],
      'same shape as the sync fetch, never a shell string',
    );
  });

  test('the async gh fetch aborts on timeout instead of blocking', async () => {
    const out = await picker.fetchOpenIssuesAsync({
      cwd: '/repo', ghBin: 'gh', timeoutMs: 20,
      spawnFn: () => ({ stdout: '', stderr: '', on: () => {}, kill: () => {} }),
    });
    assert.equal(out.ok, false, 'a hanging gh becomes a silent skip, never a frozen wizard');
  });
});

describe('the inline name input (S52 Back on every field)', { concurrency: false }, () => {
  function open(overrides = {}) {
    const finished = [];
    const view = picker.createTextInput({
      title: 'New worktree change name',
      placeholder: 'name-change',
      initial: '',
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }

  test('it renders the questionnaire frame with a write footer and no cross-field header', () => {
    const { view } = open();
    const lines = view.render(90);
    const text = lines.join('\n');
    assert.ok(/^─+$/.test(lines[0]), 'a thin accent rule opens');
    assert.ok(/^─+$/.test(lines[lines.length - 1]), 'a thin accent rule closes');
    assert.ok(!/\[\d+\/\d+\]/.test(text), 'no [n/m] step counter renders');
    assert.ok(!text.includes('Type') || !text.includes('Issues'), 'no joint Type Name Issues Odd header groups the panels');
    assert.ok(!text.includes('Odd'), 'the name panel leaks no Odd tab');
    assert.ok(text.includes('New worktree change name'), 'the panel keeps only its own title');
    assert.match(text, /enter.*confirm/i, 'Enter confirms');
    assert.match(text, /tab.*back/i, 'Tab goes back');
    assert.match(text, /esc.*cancel/i, 'Esc cancels');
  });

  test('the name field starts truly empty: no example text in the rendered input', () => {
    const { view } = open();
    assert.equal(view.state.value, '', 'the initial value is empty, not prefilled');
    const text = view.render(90).join('\n');
    assert.ok(!text.includes('name-change'), 'no example placeholder renders inside the input');
    assert.ok(!text.includes('picked'), 'no stale value renders either');
  });

  test('first typing lands as the actual value with the cursor after it', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const { view } = open();
    view.handleInput('a');
    assert.equal(view.state.value, 'a', 'the first keystroke is the actual value');
    const line = view.render(90).join('\n').split('\n').find((l) => l.includes('❯'));
    assert.ok(line, 'the input line renders');
    assert.ok(line.includes('a'), 'the typed value renders in the input line');
    const marker = tui.CURSOR_MARKER;
    const at = line.indexOf(marker);
    assert.ok(at >= 0, 'the real Pi cursor marker renders in the input line');
    assert.equal(line[at + marker.length], '▊', 'the visual cursor sits immediately after the marker');
    assert.ok(line.indexOf('a') < at, 'the marker (and cursor) sit after the actual value, never after a placeholder');
  });

  test('the cursor marker is zero-width: Unicode/ANSI width stays exact', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const { view } = open();
    for (const ch of 'caf\u00e9 \u4e2d') view.handleInput(ch);
    const line = view.render(120).join('\n').split('\n').find((l) => l.includes('caf'));
    assert.ok(line, 'the unicode value renders');
    const stripped = String(line).replace(/\x1b\[[0-9;]*m/g, '');
    const withMarker = tui.visibleWidth(stripped);
    const withoutMarker = tui.visibleWidth(stripped.split(tui.CURSOR_MARKER).join(''));
    assert.equal(withMarker, withoutMarker - 1 + 1, 'marker is zero-width, cursor cell counts one');
    assert.ok(withoutMarker > [...'caf\u00e9 \u4e2d'].length, 'wide characters count wider than codepoints');
  });

  test('Back restores only the actually typed prior value, still with no example text', () => {
    const { view, finished } = open({ initial: 'picked' });
    assert.equal(view.state.value, 'picked', 'the actually typed value is restored');
    const text = view.render(90).join('\n');
    assert.ok(text.includes('picked'), 'the restored value renders');
    assert.ok(!text.includes('name-change'), 'the example never renders, even on return');
    view.handleInput('tab');
    assert.deepEqual(finished, [{ back: true, value: 'picked' }], 'Tab alone goes back carrying the typed value');
    assert.equal(view.state.value, 'picked', 'the typed value is kept for the return trip');
  });

  test('typing appends (spaces included), Enter submits, Esc cancels, Tab goes back', () => {
    const { view, finished } = open();
    for (const ch of 'my change') view.handleInput(ch);
    assert.equal(view.state.value, 'my change', 'spaces type in a text input');
    view.handleInput('backspace');
    assert.equal(view.state.value, 'my chang');
    view.handleInput('enter');
    assert.deepEqual(finished, ['my chang'], 'Enter submits the typed value');
  });

  test('Tab returns {back:true} with the typed value and Esc returns null, exactly once', () => {
    const tab = open();
    tab.view.handleInput('t');
    tab.view.handleInput('tab');
    assert.deepEqual(tab.finished, [{ back: true, value: 't' }], 'Tab alone goes back carrying the typed value');
    assert.equal(tab.view.state.value, 't', 'the typed value is kept for the return trip');
    tab.view.handleInput('tab');
    tab.view.handleInput('escape');
    assert.deepEqual(tab.finished, [{ back: true, value: 't' }], 'one back, never a second resolution');
    const esc = open();
    esc.view.handleInput('escape');
    esc.view.handleInput('enter');
    assert.deepEqual(esc.finished, [null], 'one cancel, never a second resolution');
  });

  test('the initial value is kept for editing', () => {
    const { view, finished } = open({ initial: 'picked' });
    assert.equal(view.state.value, 'picked', 'Back from a later step restores the kept name');
    view.handleInput('enter');
    assert.deepEqual(finished, ['picked'], 'submitting unchanged keeps it');
  });

  test('raw terminal keys drive it with real helpers', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const helpers = { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease };
    const first = open({ helpers });
    first.view.handleInput('a');
    first.view.handleInput('\x7f');
    first.view.handleInput('b');
    first.view.handleInput('\t');
    assert.deepEqual(first.finished, [{ back: true, value: 'b' }], 'raw Tab goes back carrying the typed value with real helpers');
  });
  test('raw terminal keys drive it with the raw fallback (no helpers)', () => {
    const second = open();
    second.view.handleInput('x');
    second.view.handleInput('\x1b');
    assert.deepEqual(second.finished, [null], 'raw Esc cancels with no helpers');
    const third = open();
    third.view.handleInput('y');
    third.view.handleInput('\r');
    assert.deepEqual(third.finished, ['y'], 'raw CR submits with no helpers');
    const fourth = open();
    fourth.view.handleInput(' ');
    assert.equal(fourth.view.state.value, ' ', 'raw Space types with no helpers');
  });
});

describe('the inline type single-select (Tab Back, no selectable rows)', { concurrency: false }, () => {
  const TYPE_ITEMS = [
    'Feature (feat)', 'Bug fix (fix)', 'Chore (chore)', 'Docs (docs)', 'Style (style)',
    'Refactor (refactor)', 'Performance (perf)', 'Test (test)', 'Build (build)', 'CI (ci)', 'Revert (revert)',
  ];
  function openType(overrides = {}) {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'New worktree change type',
      items: TYPE_ITEMS,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  test('it renders eleven data rows only with a Tab-back footer', () => {
    const { view, finished } = openType();
    const text = view.render(90).join('\n');
    assert.equal(TYPE_ITEMS.length, 11, 'eleven conventional types');
    for (const item of TYPE_ITEMS) assert.ok(text.includes(item), `renders ${item}`);
    assert.ok(!text.includes('Back'), 'no selectable Back row anywhere');
    assert.ok(!text.includes('Confirm'), 'no selectable Confirm row anywhere');
    assert.ok(!/\[\d+\/\d+\]/.test(text), 'no [n/m] step counter renders');
    assert.ok(!text.includes('Name') && !text.includes('Issues') && !text.includes('Odd'), 'the type panel leaks no other-field tabs');
    assert.ok(text.includes('New worktree change type'), 'the panel keeps only its own title');
    assert.match(text, /enter.*confirm/i, 'the footer names Enter as confirm');
    assert.match(text, /tab.*back/i, 'the footer names Tab as back');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true }], 'raw Tab returns Back (single-select carries no list state)');
  });
  test('raw keys with the real matcher: arrows move, Enter confirms, Tab goes back', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    const helpers = { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease };
    const first = openType({ helpers });
    first.view.handleInput('\x1b[B');
    first.view.handleInput('\r');
    assert.deepEqual(first.finished, ['Bug fix (fix)'], 'raw arrow moved, raw CR confirmed the data row');
    const second = openType({ helpers });
    second.view.handleInput('\t');
    assert.deepEqual(second.finished, [{ back: true }], 'raw Tab goes Back with the real matcher');
    const third = openType({ helpers });
    third.view.handleInput('\x1b');
    assert.deepEqual(third.finished, [null], 'raw Esc cancels');
  });
  test('Enter on the last data row confirms; no phantom row after it', () => {
    const { view, finished } = openType();
    for (let i = 0; i < 20; i += 1) view.handleInput('down');
    view.handleInput('\r');
    assert.deepEqual(finished, ['Revert (revert)'], 'clamped on the last data row, Enter confirms it');
  });
  test('prior selection on return restores the cursor', () => {
    const { view, finished } = openType({ initialSelected: 'Bug fix (fix)' });
    view.handleInput('\r');
    assert.deepEqual(finished, ['Bug fix (fix)'], 'the kept type confirms directly');
  });
});

describe('multi-select revisit state (query, page, cursor, selections)', { concurrency: false }, () => {
  const rows = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` }));
  const filterFn = (list, q) => {
    const query = String(q || '').trim().toLowerCase();
    if (!query) return list;
    return list.filter((r) => r.label.toLowerCase().includes(query));
  };
  function openRevisit(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select rows (optional)',
      items: rows,
      filterFn,
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  test('initialQuery/initialPage/initialCursor restore the previous pass', () => {
    const { view } = openRevisit({ initialQuery: 'row 1', initialPage: 0, initialCursor: 2 });
    assert.equal(view.state.query, 'row 1', 'the kept filter is restored');
    assert.equal(view.state.cursor, 2, 'the kept cursor is restored');
    const text = view.render(120).join('\n');
    assert.ok(text.includes('row 12'), 'the filter still narrows (row 1, 10, 11, 12)');
    assert.ok(!text.includes('row 3'), 'unmatched rows stay filtered out');
    assert.match(text, /page 1\/1/i, 'the restored page fits the filtered list');
  });
  test('Tab Back echoes selections and uiState with a raw Tab', () => {
    const { view, finished } = openRevisit();
    view.handleInput('down');
    view.handleInput(' ');
    assert.deepEqual(view.state.selected, [2], 'the second row is toggled');
    view.handleInput('t');
    view.handleInput('1');
    view.handleInput('\t');
    assert.deepEqual(finished, [{ back: true, selected: [2], uiState: { query: '1', page: 0, cursor: 0 } }], 'raw Tab carries selections plus filter/page/cursor');
  });
  test('Enter confirm echoes uiState alongside the selection', () => {
    const { view, finished } = openRevisit();
    view.handleInput(' ');
    view.handleInput('\r');
    assert.deepEqual(finished, [{ selected: [1], uiState: { query: '', page: 0, cursor: 0 } }], 'raw CR confirms with the list position echoed');
  });
  test('a revisit round-trips filter, page and cursor through the echo', () => {
    const first = openRevisit();
    first.view.handleInput('right');
    first.view.handleInput('t');
    for (const ch of 'row 1') first.view.handleInput(ch);
    first.view.handleInput('\t');
    assert.equal(first.finished.length, 1, 'one back resolution');
    const echo = first.finished[0].uiState;
    assert.equal(echo.query, 'row 1', 'the filter travels in the echo');
    const second = openRevisit({
      initialQuery: echo.query,
      initialPage: echo.page,
      initialCursor: echo.cursor,
      initialSelected: first.finished[0].selected,
    });
    assert.equal(second.view.state.query, 'row 1', 'the revisit restores the filter');
    const text = second.view.render(120).join('\n');
    assert.ok(text.includes('row 1'), 'filtered rows render on revisit');
    second.view.handleInput('\r');
    assert.deepEqual(second.finished, [{ selected: [], uiState: { query: 'row 1', page: 0, cursor: 0 } }], 'confirm on revisit carries the restored filter');
  });
});

describe('warp selector Ctrl+D delete (single-select extension)', { concurrency: false }, () => {
  const ITEMS = ['principal — /tmp/principal', 'feat-one — /tmp/one', 'Create new worktree…'];
  // Eligible: every checkout row except the principal (index 0) and the
  // create row (last). Mirrors the warp selector rule: principal and
  // create are never deletable.
  const canDelete = (index) => index === 1;
  function openWarp(overrides = {}) {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'Warp session · current: principal /tmp/principal',
      items: ITEMS,
      helpers: null,
      hostTui: null,
      theme: null,
      canDelete,
      confirmLabel: 'warp',
      showTab: false,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  test('raw Ctrl+D (\\x04) via the raw fallback invokes delete on the eligible row', () => {
    const { view, finished } = openWarp();
    view.handleInput('down');
    assert.equal(view.state.cursor, 1, 'focus on the eligible worktree');
    view.handleInput('\x04');
    assert.deepEqual(finished, [{ delete: true, index: 1, value: ITEMS[1] }], 'raw Ctrl+D deletes the focused eligible row');
  });
  test('raw Ctrl+D via the installed matcher invokes delete on the eligible row', { skip: !TUI_AVAILABLE }, async () => {
    const tui = await import('@earendil-works/pi-tui');
    assert.equal(tui.matchesKey('\x04', 'ctrl+d'), true, 'precondition: the installed matcher owns Ctrl+D');
    const { view, finished } = openWarp({ helpers: { matchesKey: tui.matchesKey, isKeyRelease: tui.isKeyRelease } });
    view.handleInput('down');
    view.handleInput('\x04');
    assert.deepEqual(finished, [{ delete: true, index: 1, value: ITEMS[1] }], 'installed matcher Ctrl+D deletes');
  });
  test('Ctrl+D on principal and create rows is a safe no-op', () => {
    const { view, finished } = openWarp();
    assert.equal(view.state.cursor, 0, 'starts on the principal');
    view.handleInput('\x04');
    assert.deepEqual(finished, [], 'principal never deletes');
    view.handleInput('down');
    view.handleInput('down');
    assert.equal(view.state.cursor, 2, 'focus on the create row');
    view.handleInput('\x04');
    assert.deepEqual(finished, [], 'create never deletes');
    view.handleInput('\r');
    assert.deepEqual(finished, [ITEMS[2]], 'Enter still confirms the create row');
  });
  test('footer shows Ctrl+D only on the eligible row with the actual key', () => {
    const { view } = openWarp();
    const principalFooter = view.render(90).join('\n');
    assert.match(principalFooter, /enter.*warp/i, 'footer names Enter warp');
    assert.ok(!principalFooter.includes('Ctrl+D'), 'no delete hint on the principal row');
    assert.ok(!principalFooter.includes('Tab'), 'no Tab hint when showTab is false');
    view.handleInput('down');
    const eligibleFooter = view.render(90).join('\n');
    assert.ok(eligibleFooter.includes('Ctrl+D delete'), 'the actual Ctrl+D key shows only on the eligible row');
    view.handleInput('down');
    const createFooter = view.render(90).join('\n');
    assert.ok(!createFooter.includes('Ctrl+D'), 'no delete hint on the create row');
  });
  test('Enter still warps and Esc still cancels with the warp footer', () => {
    const first = openWarp();
    first.view.handleInput('down');
    first.view.handleInput('\r');
    assert.deepEqual(first.finished, [ITEMS[1]], 'Enter confirms the focused checkout');
    const second = openWarp();
    second.view.handleInput('\x1b');
    assert.deepEqual(second.finished, [null], 'Esc cancels');
  });
  test('without canDelete the footer and keys stay byte-identical to before', () => {
    const finished = [];
    const view = picker.createSingleSelect({
      title: 'New worktree change type',
      items: ['Feature (feat)', 'Bug fix (fix)'],
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
    });
    const text = view.render(90).join('\n');
    assert.match(text, /enter.*confirm/i, 'default confirm verb unchanged');
    assert.match(text, /tab.*back/i, 'default Tab hint unchanged');
    assert.ok(!text.includes('Ctrl+D'), 'no delete hint without canDelete');
    view.handleInput('\x04');
    assert.deepEqual(finished, [], 'Ctrl+D without canDelete does nothing');
  });
});

describe('S64 footer totals (T50, test-first RED)', () => {
  function openTotals(overrides = {}) {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select issues (optional)',
      items: Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `row ${i + 1}` })),
      filterFn: (rows, q) => {
        const raw = String(q ?? '').trim().toLowerCase();
        if (raw === '') return rows.slice();
        return rows.filter((r) => String(r.label).toLowerCase().includes(raw));
      },
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
      ...overrides,
    });
    return { view, finished };
  }
  function textOf(view, width = 90) {
    return view.render(width).join('\n');
  }
  test('unfiltered footer names the TOTAL available count', () => {
    const { view } = openTotals();
    const text = textOf(view);
    assert.match(text, /12\s*total/i, 'the original loaded length travels as TOTAL');
    assert.match(text, /0\s*selected/i, 'selection count stays');
    assert.match(text, /page 1\/3/i, 'page stays');
  });
  test('filtered footer distinguishes filtered-available from TOTAL', () => {
    const { view } = openTotals({ pageSize: 12 });
    view.handleInput('t');
    for (const ch of 'row 1') view.handleInput(ch);
    view.handleInput('enter');
    const text = textOf(view);
    assert.match(text, /4\s*of\s*12/i, 'filtered 4 of TOTAL 12, never calling the filtered count the total');
    assert.match(text, /selected/i, 'selection count stays');
    assert.match(text, /page 1\/1/i, 'page stays');
  });
  test('empty list keeps an exact zero TOTAL and a single page', () => {
    const finished = [];
    const view = picker.createMultiSelect({
      title: 'Select issues (optional)',
      items: [],
      filterFn: (rows) => rows.slice(),
      pageSize: 5,
      helpers: null,
      hostTui: null,
      theme: null,
      done: (out) => { finished.push(out); },
    });
    const text = view.render(90).join('\n');
    assert.match(text, /0\s*total/i, 'empty TOTAL is exact');
    assert.match(text, /page 1\/1/i, 'empty list still yields one page');
  });
  test('paging keeps TOTAL stable across pages with a selection', () => {
    const { view } = openTotals();
    view.handleInput('down');
    view.handleInput('space');
    view.handleInput('pagedown');
    const text = textOf(view);
    assert.match(text, /12\s*total/i, 'TOTAL survives paging');
    assert.match(text, /1\s*selected/i, 'selection survives paging');
    assert.match(text, /page 2\/3/i, 'page advances');
  });
});
