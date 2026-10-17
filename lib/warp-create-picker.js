'use strict';
// Reusable multi-select picker for the create-from-warp flow
// (customize-command S46/T36): the open-issues step (fed by the `gh`
// CLI) and the odd-documents step (the `.md` files under `odd/tasks/`
// of the CURRENT checkout) share this one component, never two.
//
// Pure Node, no package imports: `child_process` and `fs` resolve lazily
// inside the functions (or ride the injected seams), so the extension
// stays lazily-loaded and the copy-to-.mjs test loaders keep working.
// Every external call is injectable (`spawnImpl`, `fsImpl`), so tests
// never spawn `gh` or open a real prompt.
//
// Host component contract (the same seam the customize panel uses):
// `createMultiSelect` returns `{ render(width), handleInput(data),
// invalidate(), state }`; the factory never writes state, notifies, or
// reloads — `done({ selected: [...] })` confirms (an empty list is a
// valid confirmation) and `done(null)` cancels (Esc). Selection is
// tracked by item id, so it survives filtering and paging.

const path = require('node:path');

// The `gh` fetch shape (verified against gh 2.102.0): open issues as
// JSON number/title. `--limit` is the CLI's own paging flag (its default
// is 30, too small for a long list); `--search` is accepted only when the
// caller passes one — the search BOX filters locally, never remotely.
const GH_FETCH_LIMIT_DEFAULT = 200;
const GH_FETCH_TIMEOUT_MS = 15000;

// Rows per selector page when the caller names none.
const MULTI_SELECT_PAGE_SIZE_DEFAULT = 8;
const MULTI_SELECT_MAX_HEIGHT = 24;

function ghFetchArgv({ limit, search } = {}) {
  const argv = ['issue', 'list', '--state', 'open', '--json', 'number,title', '--limit', String(limit ?? GH_FETCH_LIMIT_DEFAULT)];
  if (typeof search === 'string' && search.trim() !== '') argv.push('--search', search);
  return argv;
}

// The `gh` binary, following lib/worktree-issues.js: an explicit
// override first, then GH_BIN_PATH, then `gh` on PATH.
function resolveGhBin(opts = {}) {
  if (typeof opts.ghBin === 'string' && opts.ghBin.length > 0) return opts.ghBin;
  const env = opts.env || process.env;
  const fromEnv = env && env.GH_BIN_PATH;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return 'gh';
}

// Fetch the OPEN issues through the `gh` CLI. Never throws and never
// blocks: a missing binary, an unauthenticated or erroring CLI, and
// unparseable output all resolve to `{ ok: false, skipped }` so the
// caller skips the step silently. An empty open list resolves to
// `{ ok: true, issues: [] }` — likewise skipped, but distinctly.
async function fetchOpenIssues(opts = {}) {
  const bin = resolveGhBin(opts);
  const cwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : undefined;
  const timeoutMs = opts.timeoutMs || GH_FETCH_TIMEOUT_MS;
  let spawnImpl = opts.spawnImpl;
  if (typeof spawnImpl !== 'function') {
    try {
      spawnImpl = require('node:child_process').spawnSync;
    } catch {
      return { ok: false, skipped: 'cannot list open issues: child_process is unavailable' };
    }
  }
  let result;
  try {
    result = spawnImpl(bin, ghFetchArgv({ limit: opts.limit, search: opts.search }), {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf8',
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, skipped: `cannot list open issues: ${shortError(err)}` };
  }
  if (!result || typeof result !== 'object') {
    return { ok: false, skipped: 'cannot list open issues: gh returned nothing usable' };
  }
  if (result.error) {
    return { ok: false, skipped: `cannot list open issues: ${shortError(result.error)}` };
  }
  if (result.status !== 0) {
    const stderr = String(result.stderr || '').trim().split('\n')[0] || `exit ${result.status}`;
    return { ok: false, skipped: `cannot list open issues (gh said: ${stderr})` };
  }
  let doc;
  try {
    doc = JSON.parse(String(result.stdout || ''));
  } catch {
    return { ok: false, skipped: 'cannot list open issues: gh returned unparseable output' };
  }
  if (!Array.isArray(doc)) {
    return { ok: false, skipped: 'cannot list open issues: gh returned an unexpected shape' };
  }
  // Harden each row: only integer numbers with string titles survive; a
  // malformed row never poisons the whole list.
  const issues = [];
  for (const entry of doc) {
    if (!entry || typeof entry !== 'object') continue;
    if (!Number.isInteger(entry.number)) continue;
    if (typeof entry.title !== 'string') continue;
    issues.push({ number: entry.number, title: entry.title });
  }
  return { ok: true, issues };
}

// Async twin of `fetchOpenIssues` for the interactive wizard: the same
// `gh` shape and the same silent-skip contract, but the CLI runs on a
// spawned child with a bounded timeout instead of blocking the host
// event loop for up to GH_FETCH_TIMEOUT_MS (a 15s spawnSync freeze
// reads as a hung picker). `spawnFn` defaults to
// `require('node:child_process').spawn` and is injectable in tests.
// Never throws and never rejects: every failure resolves to
// `{ ok: false, skipped }`.
async function fetchOpenIssuesAsync(opts = {}) {
  const bin = resolveGhBin(opts);
  const cwd = typeof opts.cwd === 'string' && opts.cwd.length > 0 ? opts.cwd : undefined;
  const timeoutMs = opts.timeoutMs || GH_FETCH_TIMEOUT_MS;
  let spawnFn = opts.spawnFn;
  if (typeof spawnFn !== 'function') {
    try {
      spawnFn = require('node:child_process').spawn;
    } catch {
      return { ok: false, skipped: 'cannot list open issues: child_process is unavailable' };
    }
  }
  const argv = ghFetchArgv({ limit: opts.limit, search: opts.search });
  let child;
  try {
    child = spawnFn(bin, argv, { cwd, windowsHide: true });
  } catch (err) {
    return { ok: false, skipped: `cannot list open issues: ${shortError(err)}` };
  }
  if (!child || typeof child.on !== 'function') {
    return { ok: false, skipped: 'cannot list open issues: gh returned nothing usable' };
  }
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try { clearTimeout(timer); } catch { /* a dead timer never blocks the skip */ }
      resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* killing a dead child never blocks the skip */ }
      finish({ ok: false, skipped: 'cannot list open issues: gh took too long' });
    }, timeoutMs);
    try {
      if (child.stdout && typeof child.stdout.on === 'function') {
        child.stdout.on('data', (chunk) => { stdout += String(chunk); });
      }
      if (child.stderr && typeof child.stderr.on === 'function') {
        child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      }
      child.on('error', (err) => {
        finish({ ok: false, skipped: `cannot list open issues: ${shortError(err)}` });
      });
      child.on('close', (code) => {
        if (code !== 0) {
          const first = String(stderr).trim().split('\n')[0] || `exit ${code}`;
          finish({ ok: false, skipped: `cannot list open issues (gh said: ${first})` });
          return;
        }
        let doc;
        try {
          doc = JSON.parse(String(stdout || ''));
        } catch {
          finish({ ok: false, skipped: 'cannot list open issues: gh returned unparseable output' });
          return;
        }
        if (!Array.isArray(doc)) {
          finish({ ok: false, skipped: 'cannot list open issues: gh returned an unexpected shape' });
          return;
        }
        const issues = [];
        for (const entry of doc) {
          if (!entry || typeof entry !== 'object') continue;
          if (!Number.isInteger(entry.number)) continue;
          if (typeof entry.title !== 'string') continue;
          issues.push({ number: entry.number, title: entry.title });
        }
        finish({ ok: true, issues });
      });
    } catch (err) {
      finish({ ok: false, skipped: `cannot list open issues: ${shortError(err)}` });
    }
  });
}

function shortError(err) {
  if (err === null || err === undefined) return 'unknown error';
  if (typeof err === 'string') return err.split('\n')[0];
  if (err.code === 'ENOENT' || /ENOENT/i.test(String((err && err.message) || err))) {
    return 'gh CLI is not available';
  }
  return String((err && err.message) || err).split('\n')[0];
}

// The `.md` files directly under `odd/tasks/` of the given checkout
// root — the branch the worktree will be born from, so inside a
// worktree that worktree's documents, never the principal's or another
// checkout's. Returns `[{ name, abs }]` sorted by name. Never throws:
// a missing directory (or no checkout at all) means no documents.
function listOddTaskDocs(checkoutRoot, opts = {}) {
  const out = [];
  try {
    if (typeof checkoutRoot !== 'string' || checkoutRoot.length === 0) return out;
    const fsImpl = opts.fsImpl || require('node:fs');
    const dir = path.join(checkoutRoot, 'odd', 'tasks');
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    const names = [];
    for (const entry of entries || []) {
      let name = null;
      let isFile = false;
      try {
        name = entry && entry.name;
        isFile = typeof entry.isFile === 'function' ? entry.isFile() : false;
      } catch {
        continue;
      }
      if (typeof name !== 'string' || !name.endsWith('.md')) continue;
      if (!isFile) continue;
      names.push(name);
    }
    names.sort();
    for (const name of names) out.push({ name, abs: path.join(dir, name) });
  } catch {
    return [];
  }
  return out;
}

// The issues search box accepts EITHER the number or the title: a row
// survives when the raw query appears in its number or as a
// case-insensitive substring of its title; a query that is neither
// filters the row out. One box, no modes — it keeps working while
// paginated and after a multi-selection, because selection lives outside
// the filter.
function filterIssueItems(items, query) {
  const raw = String(query ?? '').trim();
  if (raw === '') return Array.isArray(items) ? items.slice() : [];
  const lowered = raw.toLowerCase();
  const out = [];
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const byNumber = String(item.number ?? item.id ?? '').includes(raw);
    const title = item.title ?? item.label ?? '';
    const byTitle = String(title).toLowerCase().includes(lowered);
    if (byNumber || byTitle) out.push(item);
  }
  return out;
}

// The odd search box filters by document name (case-insensitive
// substring); anything else filters the row out.
function filterOddItems(items, query) {
  const raw = String(query ?? '').trim().toLowerCase();
  if (raw === '') return Array.isArray(items) ? items.slice() : [];
  const out = [];
  for (const item of items || []) {
    if (!item || typeof item !== 'object') continue;
    const name = item.name ?? item.label ?? '';
    if (String(name).toLowerCase().includes(raw)) out.push(item);
  }
  return out;
}

// Pick-list adapters: the component renders `{ id, label }` rows while
// the matchers above keep working on the carried fields.
function issuePickItems(issues) {
  const out = [];
  for (const issue of issues || []) {
    if (!issue || typeof issue !== 'object') continue;
    if (!Number.isInteger(issue.number) || typeof issue.title !== 'string') continue;
    out.push({ id: issue.number, label: `#${issue.number} ${issue.title}`, number: issue.number, title: issue.title });
  }
  return out;
}

function oddPickItems(docs) {
  const out = [];
  for (const doc of docs || []) {
    if (!doc || typeof doc !== 'object') continue;
    if (typeof doc.name !== 'string' || typeof doc.abs !== 'string') continue;
    out.push({ id: doc.abs, label: doc.name, name: doc.name, abs: doc.abs });
  }
  return out;
}

// Slice the (already filtered) rows into pages, clamping the requested
// page into range. The empty list still yields one page so the footer
// never divides by zero.
function paginate(items, page, pageSize) {
  const rows = Array.isArray(items) ? items : [];
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : MULTI_SELECT_PAGE_SIZE_DEFAULT;
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const at = Math.min(Math.max(0, Number.isInteger(page) ? page : 0), pageCount - 1);
  return { items: rows.slice(at * size, at * size + size), page: at, pageCount, total: rows.length };
}

function keyText(helpers, data, names) {
  for (const name of names) {
    try {
      if (helpers && typeof helpers.matchesKey === 'function' && helpers.matchesKey(data, name)) return true;
    } catch {
      // A throwing matcher never matches; the raw fallback below decides.
    }
  }
  // Raw fallback: the terminal bytes the installed matcher accepts in
  // legacy mode, so the picker stays drivable when the helper module
  // failed to load (a picker that ignores Esc/Enter reads as frozen).
  if (typeof data === 'string' && data.length > 0) {
    for (const name of names) {
      const raw = RAW_KEY_BYTES[String(name).toLowerCase()];
      if (raw && raw.includes(data)) return true;
    }
  }
  const text = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
  const lower = String(text).toLowerCase();
  return names.some((name) => lower === String(name).toLowerCase());
}

// Raw terminal bytes per key id, mirroring the installed pi-tui
// keys.js legacy sequences (the same bytes its matchesKey accepts
// without the Kitty protocol). Minimal on purpose: the arrows, the
// toggle/confirm/cancel keys, paging and editing — every key the
// picker binds. `delete` also covers DEL, which terminals send for
// backspace over some transports.
const RAW_KEY_BYTES = {
  escape: ['\x1b'],
  'ctrl+c': ['\x03'],
  'ctrl+d': ['\x04'],
  enter: ['\r', '\n'],
  return: ['\r', '\n'],
  tab: ['\t'],
  space: [' '],
  backspace: ['\x7f', '\b'],
  delete: ['\x1b[3~', '\x7f'],
  '\x7f': ['\x7f'],
  up: ['\x1b[A'],
  down: ['\x1b[B'],
  right: ['\x1b[C'],
  left: ['\x1b[D'],
  pageup: ['\x1b[5~'],
  pagedown: ['\x1b[6~'],
};

function isKeyRelease(helpers, data) {
  try {
    if (helpers && typeof helpers.isKeyRelease === 'function') return helpers.isKeyRelease(data) === true;
  } catch {
    // A throwing classifier never releases; fall through.
  }
  return false;
}

function measureWidth(helpers, text) {
  try {
    if (helpers && typeof helpers.visibleWidth === 'function') return helpers.visibleWidth(text);
  } catch {
    // Fall through to the codepoint count.
  }
  return [...String(text).replace(/\x1b\[[0-9;]*m/g, '')].length;
}

function fitWidth(helpers, text, width, ellipsis = '…') {
  const clean = String(text).split('\n')[0] ?? '';
  if (measureWidth(helpers, clean) <= width) return clean;
  try {
    if (helpers && typeof helpers.truncateToWidth === 'function') return helpers.truncateToWidth(clean, width, ellipsis);
  } catch {
    // Fall through to the plain slice.
  }
  const chars = [...clean];
  return chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + ellipsis : clean;
}

// Standalone-panel rule: this component renders ONLY its own title, its
// own search box, its own data rows and its own key footer. It never
// renders cross-field wizard chips, tabs or step counters (no `[n/m]`,
// no `Type Name Issues Odd` header): each wizard field is an independent
// panel, mounted alone and disposed before the next opens. Sequential
// data flow is unchanged (the wizard keeps every kept value); only the
// grouping chrome is gone.
// Navigation rows: there is deliberately NO selectable Back row and NO
// Confirm row — the host has no non-selectable row, so any rendered row
// would itself be pickable. Enter confirms the step (empty is valid)
// and Space toggles the focused checkbox. Tab is reserved EXCLUSIVELY
// for Back (previous wizard field, values kept): it never switches
// focus and is never overloaded. Because Space also types multi-word
// queries, the picker tracks an explicit focus zone — the search field
// or the checkbox list.

// ONE reusable multi-select as a STANDALONE panel: a title, a search
// box at the top, paginated data rows, several rows selectable — and
// nothing else. No cross-field chips/tabs/counters, no selectable Back
// row, no Confirm row.
// `items` are `{ id, label }` rows; `filterFn(items, query)` narrows
// them; `initialSelected` restores the ids picked on an earlier pass
// (Tab Back preserves them); `getId`/`getLabel` default to those fields.
// Keys (LIST mode): T opens the dedicated search field at the top;
// up/down move in the list (following across pages); left/right (or
// PageUp/PageDown) turn item pages; Space toggles the focused
// checkbox; Enter confirms with the selected ids (empty is valid);
// Tab goes Back to the previous wizard step; Esc cancels the whole
// step; other printables are ignored. SEARCH mode: typing (T and Space
// included) filters live; Backspace edits; left/right belong to the
// text caret and never page; Enter or Esc leaves search for the list
// keeping the filter (Enter never confirms and Esc never cancels
// there); up/down leaves for the list and moves.
// `done({ selected })` on Enter, `done({ back: true })` on Back,
// `done(null)` on cancel — so the wizard never hangs on an unresolved
// prompt and never double-resolves. The view clips to the live
// terminal height and truncates rows to the width; hostile dimensions
// render nothing.
function createMultiSelect({ title, items, filterFn, getId, getLabel, searchPlaceholder, pageSize, helpers, hostTui, theme, rowsAvailable, initialSelected, initialQuery, initialPage, initialCursor, done }) {
  const rows = Array.isArray(items) ? items.slice() : [];
  const match = typeof filterFn === 'function' ? filterFn : (list) => (Array.isArray(list) ? list.slice() : []);
  const idOf = typeof getId === 'function' ? getId : (item) => item && item.id;
  const labelOf = typeof getLabel === 'function' ? getLabel : (item) => String((item && item.label) ?? '');
  const size = Number.isInteger(pageSize) && pageSize > 0 ? pageSize : MULTI_SELECT_PAGE_SIZE_DEFAULT;
  const rawFinish = typeof done === 'function' ? done : () => {};
  // Exactly-once completion: the host disposes on done, but stray input
  // after it must neither re-resolve nor throw — an unresolved or
  // double-resolved prompt is the freeze.
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    rawFinish(value);
  };

  const state = {
    // A revisit restores the previous pass exactly: the kept filter,
    // page and cursor ride in alongside the kept selections, so Tab
    // Back never loses filter text, paging or toggles.
    query: typeof initialQuery === 'string' ? initialQuery : '',
    page: Number.isInteger(initialPage) && initialPage > 0 ? initialPage : 0,
    cursor: Number.isInteger(initialCursor) && initialCursor > 0 ? initialCursor : 0,
    selected: Array.isArray(initialSelected) ? initialSelected.slice() : [],
    // Dedicated search mode: 'list' drives the checkboxes, 'search'
    // edits the top field. T/t in list mode opens the field (keeping
    // any existing query for editing); Enter or Esc in search mode
    // leaves it for the list while RETAINING the filter — Enter there
    // never confirms the step and Esc there never cancels it. Arrowing
    // focuses the list; nothing else switches implicitly, and Tab is
    // always Back, never a mode switch.
    mode: 'list',
    // Explicit focus zone mirrors the mode ('search' types, Space
    // included; 'list' toggles with Space).
    focus: 'list',
  };
  // A restored page without a cursor starts at that page's first row,
  // so the derived page below lands where the echo left it.
  if (!(Number.isInteger(initialCursor) && initialCursor > 0) && state.page > 0) {
    state.cursor = state.page * size;
  }

  function filtered() {
    try {
      const out = match(rows, state.query);
      return Array.isArray(out) ? out : [];
    } catch {
      // A throwing filter never blanks the list.
      return rows.slice();
    }
  }

  function pageView() {
    const list = filtered();
    const pageCount = Math.max(1, Math.ceil(list.length / size));
    // A restored cursor implies its page: the echo always pairs them,
    // so a revisit lands on the same rows even if the order drifted.
    const page = list.length === 0 ? 0 : Math.min(Math.max(0, Math.floor(Math.min(Math.max(0, state.cursor), list.length - 1) / size)), pageCount - 1);
    const pageItems = list.slice(page * size, page * size + size);
    // The cursor roams DATA rows only (0..list.length-1, clamped).
    // There is no Back row and no Confirm row: Enter always confirms,
    // Tab alone goes back, even on an empty filter.
    const cursor = list.length === 0 ? 0 : Math.min(Math.max(0, state.cursor), list.length - 1);
    return { list, pageCount, page, pageItems, cursor };
  }

  // The revisit echo: the current filter, page and cursor travel with
  // every resolution (confirm AND Back), so the wizard can restore this
  // exact pass when the user returns. Selections ride top-level next to
  // them, never hidden inside.
  function snapshot() {
    const view = pageView();
    return { query: state.query, page: view.page, cursor: view.cursor };
  }

  function availableRows() {
    try {
      if (typeof rowsAvailable === 'function') {
        const n = Math.floor(rowsAvailable());
        if (Number.isFinite(n) && n > 0) return Math.min(MULTI_SELECT_MAX_HEIGHT, n);
      }
    } catch {
      // A hostile rows source never breaks the picker.
    }
    return MULTI_SELECT_MAX_HEIGHT;
  }

  function requestPaint() {
    try {
      if (hostTui && typeof hostTui.requestRender === 'function') hostTui.requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }

  // Visual recipe (gentle-shell ask/choice questionnaire,
  // lib/questionnaire/questionnaire-view.ts): thin accent rules framing
  // the component, an accent-bold prompt for THIS panel only,
  // vertically aligned `[ ]`/`[x]` data rows with a distinct accent ❯
  // cursor, a TOTAL + selection + page count of THIS list
  // (`N total · k selected · page n/m`, or `f of N · k selected · page n/m`
  // while a search filter narrows it — the filtered count never poses as
  // the total), and a dim key footer. The rules are drawn in-component: the questionnaire itself
  // draws none (its frame is host dock chrome), so drawing them here is
  // what guarantees the look inline. No two-pane customize layout, no
  // cross-field chips/tabs/counters, no Back row, no Confirm row,
  // no free-text custom row (the search box covers text).
  function accent(text) {
    try {
      const bolded = theme && typeof theme.bold === 'function' ? theme.bold(text) : text;
      if (theme && typeof theme.fg === 'function') return theme.fg('accent', bolded);
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }

  function dim(text) {
    try {
      if (theme && typeof theme.fg === 'function') return theme.fg('dim', text);
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }

  function muted(text) {
    try {
      if (theme && typeof theme.fg === 'function') return theme.fg('muted', text);
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }

  function rule(width) {
    return accent('─'.repeat(Math.max(0, width)));
  }

  function render(width) {
    const w = typeof width === 'number' && Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    if (!height) return [];
    const view = pageView();
    const lines = [];
    lines.push(rule(w));
    lines.push(accent(String(title ?? 'Select')));
    const searching = state.mode === 'search';
    const searchFocused = searching || state.focus === 'search';
    const shown = state.query !== '' ? state.query : (searching ? '' : (searchPlaceholder ?? ''));
    const caret = searching ? '▊' : '';
    const box = `Search: ${shown}${caret}`;
    lines.push(fitWidth(helpers, `${searchFocused ? accent('❯ ') : '  '}${muted(box)}`, w, ''));
    // Reserve the frame (two rules), the prompt, the search box and
    // the two-line footer (counts plus keys, so narrow terminals keep
    // every documented key): the data items take whatever height is left.
    const room = Math.max(0, Math.min(view.pageItems.length, height - 9));
    for (let i = 0; i < room; i += 1) {
      const absolute = view.page * size + i;
      const item = view.pageItems[i];
      const id = idOf(item);
      const marked = state.selected.some((s) => s === id);
      const focused = state.focus === 'list' && absolute === view.cursor;
      const text = `${focused ? accent('❯ ') : '  '}[${marked ? 'x' : ' '}] ${labelOf(item)}`;
      lines.push(fitWidth(helpers, text, w, ''));
    }
    if (view.list.length === 0) lines.push(muted(fitWidth(helpers, '(no matches)', w, '')));
    const total = rows.length;
    const shownCount = view.list.length;
    const filtering = state.query.trim() !== '';
    const counts = filtering
      ? dim(`${shownCount} of ${total} · ${state.selected.length} selected · page ${view.page + 1}/${view.pageCount}`)
      : dim(`${total} total · ${state.selected.length} selected · page ${view.page + 1}/${view.pageCount}`);
    lines.push(fitWidth(helpers, counts, w, ''));
    const footer = searching
      ? dim(`Search · type to filter · Enter/Esc back to list (filter kept) · Tab back`)
      : dim(`↑↓ move · ←/→ pages · T search · Space toggle · Enter confirm · Tab back · Esc cancel`);
    lines.push(fitWidth(helpers, footer, w, ''));
    lines.push(rule(w));
    return lines.slice(0, Math.max(0, height));
  }

  function moveCursor(delta) {
    const view = pageView();
    const max = Math.max(0, view.list.length - 1);
    const next = Math.min(Math.max(0, view.cursor + delta), max);
    state.cursor = next;
    state.mode = 'list';
    state.focus = 'list';
    if (view.list.length > 0) state.page = Math.floor(next / size);
  }

  function turnPage(delta) {
    const view = pageView();
    const next = Math.min(Math.max(0, view.page + delta), view.pageCount - 1);
    state.page = next;
    state.mode = 'list';
    state.focus = 'list';
    // The cursor follows onto the new page; it never parks on a
    // navigation row because none exists.
    if (view.cursor <= view.list.length - 1 && view.list.length > 0) {
      const start = next * size;
      const end = Math.min(start + size - 1, view.list.length - 1);
      if (state.cursor < start || state.cursor > end) state.cursor = start;
    }
  }

  // Space in list focus toggles the focused data checkbox. There is no
  // navigation row, so Space never leaves the list and never completes.
  function toggleFocused() {
    const view = pageView();
    const item = view.list[view.cursor];
    if (!item) return false;
    const id = idOf(item);
    const at = state.selected.findIndex((s) => s === id);
    if (at >= 0) state.selected.splice(at, 1);
    else state.selected.push(id);
    return false;
  }

  function handleInput(data) {
    if (settled) return;
    if (isKeyRelease(helpers, data)) return;
    // Tab is Back in EVERY mode, exclusively: the previous wizard field
    // with the kept values. Selections and the list position echo along,
    // so the revisit restores them. Tab never switches modes and never
    // toggles, so search mode can never trap the user.
    if (keyText(helpers, data, ['tab'])) {
      finish({ back: true, selected: state.selected.slice(), uiState: snapshot() });
      requestPaint();
      return;
    }
    // SEARCH mode: a dedicated editing field at the top. Typing (T
    // included — it is normal text here) updates the filtered list
    // live; Space and LEFT/RIGHT are normal text/caret keys, never
    // toggle/page. Enter or Esc leaves search for the list while the
    // filter stays on: Enter here never confirms the step and Esc here
    // never cancels it. ↑/↓ also leave for the list and move there.
    if (state.mode === 'search') {
      if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
        state.mode = 'list';
        state.focus = 'list';
        requestPaint();
        return;
      }
      if (keyText(helpers, data, ['enter', 'return'])) {
        state.mode = 'list';
        state.focus = 'list';
        requestPaint();
        return;
      }
      if (keyText(helpers, data, ['up'])) {
        moveCursor(-1);
        requestPaint();
        return;
      }
      if (keyText(helpers, data, ['down'])) {
        moveCursor(1);
        requestPaint();
        return;
      }
      if (keyText(helpers, data, ['backspace', 'delete', '\x7f'])) {
        if (state.query.length > 0) {
          state.query = state.query.slice(0, -1);
          state.page = 0;
          state.cursor = 0;
          requestPaint();
        }
        return;
      }
      if (data === ' ' || keyText(helpers, data, ['space'])) {
        state.query += ' ';
        state.page = 0;
        state.cursor = 0;
        requestPaint();
        return;
      }
      // LEFT/RIGHT (and paging keys) belong to the text caret here:
      // ignored, never paginating, never leaving the mode.
      if (keyText(helpers, data, ['left', 'right', 'pageup', 'pagedown'])) return;
      const typed = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
      if (typeof typed === 'string' && [...typed].length === 1) {
        const ch = typed;
        if (ch >= ' ' && ch !== '\x7f') {
          state.query += ch;
          state.page = 0;
          state.cursor = 0;
          requestPaint();
        }
      }
      return;
    }
    if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
      finish(null);
      return;
    }
    // Enter CONFIRMS the panel with the selected ids (empty is valid),
    // echoing the kept filter and position for a later revisit.
    // No Back row exists: every Enter here confirms.
    if (keyText(helpers, data, ['enter', 'return'])) {
      finish({ selected: state.selected.slice(), uiState: snapshot() });
      return;
    }
    if (keyText(helpers, data, ['up'])) {
      moveCursor(-1);
      requestPaint();
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      moveCursor(1);
      requestPaint();
      return;
    }
    // LEFT/RIGHT (or PageUp/PageDown) turn item pages in list mode.
    // Selections live outside the filter and the page, so they survive
    // page changes; boundaries clamp safely.
    if (keyText(helpers, data, ['left', 'pageup'])) {
      turnPage(-1);
      requestPaint();
      return;
    }
    if (keyText(helpers, data, ['right', 'pagedown'])) {
      turnPage(1);
      requestPaint();
      return;
    }
    // Space toggles the focused data checkbox in list mode.
    if (data === ' ' || keyText(helpers, data, ['space'])) {
      toggleFocused();
      requestPaint();
      return;
    }
    // T/t opens the dedicated search field (keeping any existing
    // query for editing). Every other printable is ignored in list
    // mode: filtering starts from T, never by accident.
    if (data === 't' || data === 'T') {
      state.mode = 'search';
      state.focus = 'search';
      requestPaint();
      return;
    }
    if (keyText(helpers, data, ['backspace', 'delete', '\x7f'])) {
      if (state.query.length > 0) {
        state.query = state.query.slice(0, -1);
        state.page = 0;
        state.cursor = 0;
        state.mode = 'search';
        state.focus = 'search';
        requestPaint();
      }
      return;
    }
  }

  function invalidate() {}
  return { render, handleInput, invalidate, state };
}

// ONE inline single-line text input for the wizard's name field as a
// STANDALONE panel: only its own title, its own value line and its own
// key footer — never cross-field chips/tabs/counters. The host `input`
// primitive carries no Back affordance, so Back on this field needs a
// real component here (never an invented host-metadata API). Same
// questionnaire visual as the multi-select (accent rules, accent prompt,
// dim key footer), same inline dock placement through `ctx.ui.custom`
// with no overlay options. Keys:
// typing appends (spaces included — change names are free text),
// Backspace deletes, Enter submits the value (empty stays empty; the
// caller decides keep-vs-refuse), Tab goes Back with `{back:true}`
// keeping the typed value, Esc cancels with `done(null)`. Arrows do
// nothing (single line, no caret to steal). Completion fires exactly
// once; hostile dimensions render nothing.
function createTextInput({ title, placeholder, initial, helpers, hostTui, theme, rowsAvailable, done }) {
  // `placeholder` is accepted for call-site compatibility but NEVER
  // rendered inside the input line: the field starts truly empty and
  // only the user's actual typed value (or the kept value on Back)
  // ever shows. Rendering the example as ghost text made it look like a
  // real value and parked the cursor after it.
  void placeholder;
  const rawFinish = typeof done === 'function' ? done : () => {};
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    rawFinish(value);
  };
  const state = { value: typeof initial === 'string' ? initial : '' };
  // The real Pi cursor marker, resolved once: the injected helpers first
  // (the live pi-tui module in production), then a lazy package require
  // (plain-node tests pass helpers:null). Empty when unreachable — the
  // visual cursor cell still renders, only hardware positioning degrades.
  let cursorMarker = '';
  try {
    if (helpers && typeof helpers.CURSOR_MARKER === 'string') cursorMarker = helpers.CURSOR_MARKER;
  } catch {
    cursorMarker = '';
  }
  if (cursorMarker === '') {
    try {
      const tui = require('@earendil-works/pi-tui');
      if (tui && typeof tui.CURSOR_MARKER === 'string') cursorMarker = tui.CURSOR_MARKER;
    } catch {
      cursorMarker = '';
    }
  }

  function availableRows() {
    try {
      if (typeof rowsAvailable === 'function') {
        const n = Math.floor(rowsAvailable());
        if (Number.isFinite(n) && n > 0) return Math.min(MULTI_SELECT_MAX_HEIGHT, n);
      }
    } catch {
      // A hostile rows source never breaks the input.
    }
    return MULTI_SELECT_MAX_HEIGHT;
  }

  function requestPaint() {
    try {
      if (hostTui && typeof hostTui.requestRender === 'function') hostTui.requestRender();
    } catch {
      // A repaint failure never breaks typing.
    }
  }

  function accent(text) {
    try {
      const bolded = theme && typeof theme.bold === 'function' ? theme.bold(text) : text;
      if (theme && typeof theme.fg === 'function') return theme.fg('accent', bolded);
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }

  function dim(text) {
    try {
      if (theme && typeof theme.fg === 'function') return theme.fg('dim', text);
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }

  function muted(text) {
    try {
      if (theme && typeof theme.fg === 'function') return theme.fg('muted', text);
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }

  function render(width) {
    const w = typeof width === 'number' && Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    if (!height) return [];
    const lines = [];
    lines.push(accent('─'.repeat(Math.max(0, w))));
    lines.push(accent(String(title ?? 'Write')));
    // The input line carries ONLY the actual value plus the cursor: an
    // empty field renders as just the prompt plus cursor, never example
    // text. CURSOR_MARKER (the real Pi contract, zero-width under
    // visibleWidth/truncateToWidth) sits immediately before the visual
    // cursor cell so the host positions the hardware cursor after the
    // actual value — never after a placeholder. Single-line
    // append-only editing means the end is the only correct position.
    lines.push(fitWidth(helpers, `${accent('❯ ')}${state.value}${cursorMarker}▊`, w, ''));
    lines.push(fitWidth(helpers, dim('type to write · Enter confirm · Tab back · Esc cancel'), w, ''));
    lines.push(accent('─'.repeat(Math.max(0, w))));
    return lines.slice(0, Math.max(0, height));
  }

  function handleInput(data) {
    if (settled) return;
    if (isKeyRelease(helpers, data)) return;
    if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
      finish(null);
      return;
    }
    // Tab is Back, exclusively — the typed value travels along in the
    // payload so the wizard keeps exactly what the user typed.
    if (keyText(helpers, data, ['tab'])) {
      finish({ back: true, value: state.value });
      return;
    }
    if (keyText(helpers, data, ['enter', 'return'])) {
      finish(state.value);
      return;
    }
    if (keyText(helpers, data, ['backspace', 'delete', '\x7f'])) {
      if (state.value.length > 0) {
        state.value = state.value.slice(0, -1);
        requestPaint();
      }
      return;
    }
    // Arrows (and paging keys) do nothing on a single line without a
    // caret: they must neither toggle, page, nor type.
    if (keyText(helpers, data, ['up', 'down', 'left', 'right', 'pageup', 'pagedown'])) return;
    const raw = typeof data === 'string' ? data : (data && (data.name || data.key)) || '';
    if (typeof raw === 'string' && [...raw].length === 1) {
      const ch = raw;
      if (ch >= ' ' && ch !== '\x7f') {
        state.value += ch;
        requestPaint();
      }
    }
  }

  function invalidate() {}
  return { render, handleInput, invalidate, state };
}

// ONE inline single-select for the wizard's type field as a STANDALONE
// panel: only its own title, its eleven data rows and its own key
// footer — never cross-field chips/tabs/counters, never a selectable
// Back or Confirm row. The built-in `ctx.ui.select` cannot return a Tab
// Back (it only resolves picked strings), so this smallest custom
// inline selector carries the consistent Tab raw-key handling the other
// panels already have. `items` are option strings (or `{ id, label }`
// rows via `getId`/`getLabel`); `initialSelected` restores the kept type
// on the return trip by moving the cursor there. Keys: Up/Down move
// over data rows only (clamped, no phantom row after the last item),
// Enter confirms the focused data row, Tab goes Back with `{ back: true }`
// keeping the kept value, Esc cancels with `done(null)`. Completion
// fires exactly once; hostile dimensions render nothing.
// Warp-selector extension (no unrelated redesign): `canDelete` is an
// opt-in predicate `(index, item) => boolean` — when it reports the
// focused row deletable, raw Ctrl+D (`\\x04` via the installed matcher
// or the raw fallback) finishes with `{ delete: true, index, value }`
// and the footer names the actual `Ctrl+D delete` key only on that row;
// on any other row Ctrl+D is a safe no-op. `confirmLabel` renames the
// Enter verb (`warp` for the checkout selector, `confirm` everywhere
// else) and `showTab: false` hides the Tab hint and ignores Tab (the
// top-level warp selector has no previous field). Defaults preserve the
// type panel byte-identically.
function createSingleSelect({ title, items, getId, getLabel, helpers, hostTui, theme, rowsAvailable, initialSelected, canDelete, confirmLabel, showTab, done }) {
  const rows = Array.isArray(items) ? items.slice() : [];
  const idOf = typeof getId === 'function' ? getId : (item) => (item && typeof item === 'object' && 'id' in item ? item.id : String(item));
  const labelOf = typeof getLabel === 'function' ? getLabel : (item) => String((item && typeof item === 'object' && 'label' in item ? item.label : item) ?? '');
  const rawFinish = typeof done === 'function' ? done : () => {};
  let settled = false;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    rawFinish(value);
  };
  const state = { cursor: 0 };
  if (initialSelected !== undefined && initialSelected !== null) {
    const at = rows.findIndex((item) => idOf(item) === initialSelected);
    if (at >= 0) state.cursor = at;
  }
  function availableRows() {
    try {
      if (typeof rowsAvailable === 'function') {
        const n = Math.floor(rowsAvailable());
        if (Number.isFinite(n) && n > 0) return Math.min(MULTI_SELECT_MAX_HEIGHT, n);
      }
    } catch {
      // A hostile rows source never breaks the selector.
    }
    return MULTI_SELECT_MAX_HEIGHT;
  }
  function requestPaint() {
    try {
      if (hostTui && typeof hostTui.requestRender === 'function') hostTui.requestRender();
    } catch {
      // A repaint failure never breaks navigation.
    }
  }
  function accent(text) {
    try {
      const bolded = theme && typeof theme.bold === 'function' ? theme.bold(text) : text;
      if (theme && typeof theme.fg === 'function') return theme.fg('accent', bolded);
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }
  function dim(text) {
    try {
      if (theme && typeof theme.fg === 'function') return theme.fg('dim', text);
    } catch {
      // A hostile theme keeps the plain text.
    }
    return text;
  }
  function render(width) {
    const w = typeof width === 'number' && Number.isFinite(width) ? Math.floor(width) : 0;
    if (w <= 0) return [];
    const height = availableRows();
    if (!height) return [];
    const lines = [];
    lines.push(accent('─'.repeat(Math.max(0, w))));
    lines.push(accent(String(title ?? 'Select')));
    const room = Math.max(0, Math.min(rows.length, height - 4));
    for (let i = 0; i < room; i += 1) {
      const focused = i === state.cursor;
      lines.push(fitWidth(helpers, `${focused ? accent('❯ ') : '  '}  ${labelOf(rows[i])}`, w, ''));
    }
    // Warp delete affordance: the footer names the actual Ctrl+D key ONLY
    // when the focused row is deletable. A hostile predicate never breaks
    // the render and never enables a delete.
    let deletableFocused = false;
    if (typeof canDelete === 'function') {
      try {
        deletableFocused = canDelete(state.cursor, rows[state.cursor]) === true;
      } catch {
        deletableFocused = false;
      }
    }
    const verb = typeof confirmLabel === 'string' && confirmLabel.length > 0 ? confirmLabel : 'confirm';
    const parts = ['↑↓ move', `Enter ${verb}`];
    if (deletableFocused) parts.push('Ctrl+D delete');
    if (showTab !== false) parts.push('Tab back');
    parts.push('Esc cancel');
    lines.push(fitWidth(helpers, dim(parts.join(' · ')), w, ''));
    lines.push(accent('─'.repeat(Math.max(0, w))));
    return lines.slice(0, Math.max(0, height));
  }
  function handleInput(data) {
    if (settled) return;
    if (isKeyRelease(helpers, data)) return;
    // Ctrl+D deletes the focused row ONLY when the opt-in predicate says
    // so (warp selector: eligible worktree rows). On a protected row
    // (principal, create) it is a safe no-op: the selector stays open on
    // the same focus with nothing resolved.
    if (keyText(helpers, data, ['ctrl+d'])) {
      let deletable = false;
      if (typeof canDelete === 'function') {
        try {
          deletable = canDelete(state.cursor, rows[state.cursor]) === true;
        } catch {
          deletable = false;
        }
      }
      if (deletable) {
        const item = rows[state.cursor];
        finish({ delete: true, index: state.cursor, value: idOf(item) });
        try {
          if (hostTui && typeof hostTui.requestRender === 'function') hostTui.requestRender();
        } catch {
          // A repaint failure never breaks navigation.
        }
      }
      return;
    }
    // Tab is Back, exclusively — the kept selection travels via the
    // wizard's own memory, never a selectable row. The top-level warp
    // selector passes showTab:false: Tab is then ignored (no previous
    // field) instead of resolving a Back.
    if (showTab === false && keyText(helpers, data, ['tab'])) return;
    if (keyText(helpers, data, ['tab'])) {
      finish({ back: true });
      requestPaint();
      return;
    }
    if (keyText(helpers, data, ['escape', 'ctrl+c'])) {
      finish(null);
      return;
    }
    if (keyText(helpers, data, ['enter', 'return'])) {
      const item = rows[state.cursor];
      if (item === undefined) {
        finish(null);
        return;
      }
      finish(idOf(item));
      return;
    }
    if (keyText(helpers, data, ['up'])) {
      state.cursor = Math.max(0, state.cursor - 1);
      requestPaint();
      return;
    }
    if (keyText(helpers, data, ['down'])) {
      state.cursor = Math.min(Math.max(0, rows.length - 1), state.cursor + 1);
      requestPaint();
      return;
    }
  }
  function invalidate() {}
  return { render, handleInput, invalidate, state };
}

module.exports = {
  GH_FETCH_LIMIT_DEFAULT,
  MULTI_SELECT_PAGE_SIZE_DEFAULT,
  ghFetchArgv,
  resolveGhBin,
  fetchOpenIssues,
  fetchOpenIssuesAsync,
  listOddTaskDocs,
  filterIssueItems,
  filterOddItems,
  issuePickItems,
  oddPickItems,
  paginate,
  createMultiSelect,
  createSingleSelect,
  createTextInput,
};
