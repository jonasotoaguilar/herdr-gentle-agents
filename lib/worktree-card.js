'use strict';
// Reusable native Pi worktree tool card renderer (T6/S13).
//
// One factory per tool — `createWorktreeCardRenderer(toolName, deps)` —
// returning the three render hooks the parent extension spreads over its
// tool definitions (`renderShell: "self"`, `renderCall`, `renderResult`),
// so execute/schema/content/details stay exactly where they are. Compact
// collapsed cards match the gentle-shell reference: an accent left border,
// a readable operation header, a ctrl+o expand hint, a short result, and
// a duration only when lifecycle timing evidence is supplied.
//
// S19 worktree identity: one git-branch glyph for every tool and the
// git-orange tone on the opening rule. The installed Pi theme schema
// exposes no orange role, so the closest documented role — `warning`
// (yellow in the built-in themes) — carries the tone; failures keep the
// `error` role and the running marker keeps `muted`. No other role is
// ever passed to theme.fg.
//
// No new dependencies and no imports of package-private reference
// modules: width and key-hint helpers arrive via injected `deps`
// ({visibleWidth, truncateToWidth, keyHint}) with small local fallbacks,
// consistent with the libRequire architecture. Every hook returns a plain
// Pi component ({render(width), invalidate}) and never throws: untrusted
// strings (branch names, paths, result text) are sanitized so no raw ANSI
// or control character can leak into or reshape the transcript.

const WORKTREE_TOOLS = new Set([
  'worktree_create',
  'worktree_list',
  'worktree_close',
  'worktree_session_open',
  'worktree_warp',
]);

// One branch glyph for all five tools (S19): the worktree tools share a
// single git identity instead of four unrelated marks. U+2387 renders as a
// single column through both the local fallback and pi-tui measurement.
const GLYPH = {
  worktree_create: '⎇',
  worktree_list: '⎇',
  worktree_close: '⎇',
  worktree_session_open: '⎇',
  worktree_warp: '⎇',
};

const TITLE = {
  worktree_create: 'worktree create',
  worktree_list: 'worktree list',
  worktree_close: 'worktree close',
  worktree_session_open: 'worktree session open',
  worktree_warp: 'worktree warp',
};

// Collapsed budget: header + preview rows + closing rule. Operate-mode
// scanability: the transcript stays readable with five tools chattering.
const COLLAPSED_PREVIEW_ROWS = 3;
const ACCENT_BAR = '▎';
const RUNNING_MARK = '…';
const EMPTY_TEXT = '(no output)';

// Matches ANSI SGR escapes and OSC 8 hyperlinks; control characters and
// DEL are stripped separately so multi-line structure (\n, \t) survives.
const ANSI_PATTERN = /\x1b\[[0-9;]*m|\x1b\]8;;.*?\x07/g;
// eslint-disable-next-line no-control-regex
const CONTROL_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;

function stripAnsi(value) {
  return String(value).replace(ANSI_PATTERN, '');
}

function safeText(value) {
  if (typeof value !== 'string') return '';
  return stripAnsi(value).replace(CONTROL_PATTERN, '');
}

function asRecord(value) {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
  return {};
}

function oneLine(value, fallback) {
  const line = safeText(value).split('\n')[0].trim().replace(/\s+/g, ' ');
  return line.length > 0 ? line : fallback;
}

function baseName(value) {
  const text = safeText(value).replace(/\/+$/, '');
  if (text.length === 0) return '';
  const parts = text.split('/');
  return parts[parts.length - 1];
}

// Minimal column-width measurement for the local fallback (used only
// when the host injects no helpers): wide East-Asian/emoji code points
// occupy two columns, combining marks none. Runtime rendering goes
// through the real pi-tui visibleWidth; this keeps the fallback honest
// at narrow widths instead of counting code points.
function charWidth(code) {
  if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return 0;
  if (
    (code >= 0x300 && code <= 0x36f) || (code >= 0x1ab0 && code <= 0x1aff) ||
    (code >= 0x1dc0 && code <= 0x1dff) || (code >= 0x20d0 && code <= 0x20ff) ||
    (code >= 0xfe20 && code <= 0xfe2f)
  ) return 0;
  if (
    (code >= 0x1100 && code <= 0x115f) || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0x303e) || (code >= 0x3041 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) || (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

function localVisibleWidth(line) {
  let width = 0;
  for (const char of stripAnsi(line)) width += charWidth(char.codePointAt(0));
  return width;
}

function localTruncate(line, width, ellipsis = '…') {
  if (localVisibleWidth(line) <= width) return line;
  if (width <= 0) return '';
  const mark = localVisibleWidth(ellipsis) >= width ? '' : ellipsis;
  const budget = width - localVisibleWidth(mark);
  let used = 0;
  let out = '';
  for (const char of line) {
    const next = used + charWidth(char.codePointAt(0));
    if (next > budget) break;
    out += char;
    used = next;
  }
  return out + mark;
}

function resolveHelpers(deps) {
  const d = asRecord(deps);
  return {
    visibleWidth: typeof d.visibleWidth === 'function' ? d.visibleWidth : localVisibleWidth,
    truncateToWidth: typeof d.truncateToWidth === 'function' ? d.truncateToWidth : localTruncate,
    keyHint: typeof d.keyHint === 'function' ? d.keyHint : undefined,
  };
}

function themeFg(theme, role, text) {
  try {
    if (theme && typeof theme.fg === 'function') return theme.fg(role, text);
  } catch {
    // A hostile theme never breaks the card; fall through to plain text.
  }
  return text;
}

function expandHint(helpers, expanded) {
  const suffix = expanded ? 'to collapse' : 'to expand';
  if (helpers.keyHint) {
    try {
      const hinted = helpers.keyHint('app.tools.expand', suffix);
      const clean = oneLine(hinted, '');
      if (clean.length > 0) return clean;
    } catch {
      // Fall through to the static hint below.
    }
  }
  return `ctrl+o ${suffix}`;
}

function formatDuration(durationMs) {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) return undefined;
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

// Duration reads ONLY from the host's ToolRenderContext.durationMs — the
// one timing field the installed Pi contract provides (milliseconds the
// execution took, undefined while it runs). ToolRenderResultOptions
// carries no timing, so options timing is never read. Nothing here starts
// a timer, so a card can never fabricate or leak one.
function durationOf(context) {
  return formatDuration(asRecord(context).durationMs);
}

// Shared row mark (the reference's RESULT_MARK pattern): renderResult tags
// the host-owned context.state object, which Pi shares across the call
// and result renders of one execution. While unmarked, the call closes
// its own frame; once marked, the call drops to the top rule and the
// result body closes the single shared frame — never two full cards.
const RESULT_MARK = Symbol.for('herdr-gentle.worktree-card.result');

function markCardResult(state) {
  if (state !== null && typeof state === 'object') {
    try {
      state[RESULT_MARK] = true;
    } catch {
      // A frozen state object never breaks the result render below.
    }
  }
}

function cardAwaitingResult(context) {
  const state = asRecord(context).state;
  if (state !== null && typeof state === 'object') {
    try {
      if (state[RESULT_MARK] === true) return false;
    } catch {
      // An unreadable state reads as awaiting: closed mini-card.
    }
  }
  return true;
}

function resultTextOf(result) {
  try {
    const content = result && Array.isArray(result.content) ? result.content : [];
    const texts = content
      .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
      .map((entry) => safeText(entry.text));
    return texts.join('\n');
  } catch {
    return '';
  }
}

function isErrorResult(result, options, context) {
  if (result && result.isError === true) return true;
  if (asRecord(options).isError === true) return true;
  if (asRecord(context).isError === true) return true;
  return false;
}

// Tool-specific one-line summaries read from result.details — the same
// shapes execute() already returns. Unknown or malformed details fall back
// to the result's first line, never to a throw.
function summarizeWorktreeResult(toolName, result) {
  const details = asRecord(result ? result.details : undefined);
  const text = resultTextOf(result);
  const firstLine = oneLine(text, EMPTY_TEXT);
  const failed = result && result.isError === true;

  switch (toolName) {
    case 'worktree_create': {
      const branch = oneLine(details.branch, '');
      const issues = Array.isArray(details.issues) ? details.issues.filter((n) => typeof n === 'number') : [];
      const target = baseName(details.path) || branch || firstLine;
      if (failed) return branch.length > 0 ? `error · ${branch}` : `error · ${firstLine}`;
      if (details.created === false) return `already at ${target}`;
      const name = branch.length > 0 ? branch : target;
      return issues.length > 0 ? `${name} · issues ${issues.join(',')}` : name;
    }
    case 'worktree_list': {
      const count = typeof details.count === 'number' ? details.count : undefined;
      if (failed) return `error · ${firstLine}`;
      if (count === 0) return 'no worktrees';
      if (count !== undefined) return `${count} checkout${count === 1 ? '' : 's'}`;
      return firstLine;
    }
    case 'worktree_close': {
      const target = baseName(details.path) || oneLine(details.branch, '') || firstLine;
      if (failed) return `error · ${target}`;
      return details.branchKept === false ? `removed ${target}` : `removed ${target} · branch kept`;
    }
    case 'worktree_session_open': {
      const worktree = oneLine(details.worktree, '');
      const session = oneLine(details.sessionId, '');
      const name = [worktree, session].filter((part) => part.length > 0).join(' · ') || firstLine;
      if (failed) return `error · ${name}`;
      return details.resumed === true ? `${name} · resumed` : name;
    }
    case 'worktree_warp': {
      const name = oneLine(details.name, '');
      const branch = oneLine(details.branch, '');
      const label = [name, branch].filter((part) => part.length > 0).join(' · ') || firstLine;
      if (failed) return `error · ${label}`;
      return details.resumed === true ? `${label} · resumed` : label;
    }
    default:
      return firstLine;
  }
}

// The S19 slug: mirrors lib/worktree-git.js slugifyBranch (lowercase,
// non-alphanumeric runs to one dash, trimmed, `worktree` fallback) and
// the extension's slugPart, so the card's compact rows name the same
// identifier the agent text and the listing print, without an import.
function slugify(value) {
  try {
    const slug = safeText(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return slug === '' ? 'worktree' : slug;
  } catch {
    return 'worktree';
  }
}

// Collapsed success bodies (S19): ordered short lines per tool, read from
// the same details execute() already returns, in the same shape as the
// agent text (created:/removed:/opened: heads, path/issues/status tails).
// Malformed details fall back to the result's first line, never to a throw; failures keep the summary
// plus preview shape summarizeWorktreeResult pins.
function compactBodyRows(toolName, result) {
  const details = asRecord(result ? result.details : undefined);
  const text = resultTextOf(result);
  const firstLine = oneLine(text, EMPTY_TEXT);
  switch (toolName) {
    case 'worktree_create': {
      const branch = oneLine(details.branch, '');
      const target = oneLine(details.path, '');
      if (branch.length === 0 && target.length === 0) return [firstLine];
      const name = branch.length > 0 ? branch : target;
      const rows = [`created: ${slugify(name)} · ${name}${details.created === false ? ' · already exists' : ''}`];
      if (target.length > 0) rows.push(`path: ${target}`);
      const issues = Array.isArray(details.issues) ? details.issues.filter((n) => typeof n === 'number') : [];
      if (issues.length > 0) rows.push(`issues: ${issues.join(',')}`);
      return rows;
    }
    case 'worktree_list': {
      // The listing contract prints the session's own checkout first, so
      // the compact names it plus the count; the full rows stay expanded.
      // S25 parity: every entry that holds odd documents adds one `odd:`
      // row naming the entry and its documents — the collapsed form of
      // the `odd=` suffix the agent text and the expanded card already
      // print per row. Entries without odd docs add no row, so listings
      // without odd documents compact exactly as before.
      const count = typeof details.count === 'number' ? details.count : undefined;
      // An empty listing compacts to one line; a result with no text at
      // all still says so, exactly as the placeholder contract pins.
      if (count === 0) return text.length > 0 ? ['no worktrees'] : ['no worktrees', EMPTY_TEXT];
      const rows = Array.isArray(details.worktrees) ? details.worktrees : [];
      const current = rows.length > 0 ? oneLine(rows[0] ? rows[0].name : '', '') : '';
      if (current.length === 0 || count === undefined) return [firstLine];
      const compact = [`current: ${current}`, `${count} checkout${count === 1 ? '' : 's'}`];
      for (const row of rows) {
        const docs = Array.isArray(row && row.odd)
          ? row.odd.map((doc) => oneLine(doc, '')).filter((doc) => doc.length > 0)
          : [];
        if (docs.length === 0) continue;
        const label = oneLine(row && row.name, '');
        compact.push(label.length > 0 ? `odd: ${label} \u00B7 ${docs.join(',')}` : `odd: ${docs.join(',')}`);
      }
      return compact;
    }
    case 'worktree_close': {
      const branch = oneLine(details.branch, '');
      const target = baseName(details.path) || branch;
      if (target.length === 0) return [firstLine];
      const name = branch.length > 0 ? branch : target;
      return [`removed: ${slugify(name)} · ${name}`, details.branchKept === false ? 'branch deleted' : 'branch kept'];
    }
    case 'worktree_session_open': {
      const worktree = oneLine(details.worktree, '');
      const session = oneLine(details.sessionId, '');
      if (worktree.length === 0 && session.length === 0) return [firstLine];
      const head = `opened: ${worktree.length > 0 ? worktree : 'worktree'} · ${session.length > 0 ? session : '(unknown session)'}`;
      if (details.resumed === true) return [head, 'resumed'];
      const target = oneLine(details.path, '');
      return [head, `path: ${target.length > 0 ? target : '(unknown path)'}`];
    }
    case 'worktree_warp': {
      // S42 compact: EXACTLY the two name-only rows, mirroring the warp
      // message renderer below — `moved: <source name>` then
      // `to: <target name>`, no branch and no path on either row. The
      // expanded form shows the full result text (the S42 path/branch
      // rows), so the collapsed pair is the only special case here.
      const from = oneLine(details.fromName, '')
        || oneLine(details.fromDesc, '').split('\u00B7')[0].trim().replace(/\s+/g, ' ');
      const name = oneLine(details.name, '');
      if (from.length > 0 && name.length > 0) return [`moved: ${from}`, `to: ${name}`];
      return [firstLine];
    }
    default:
      return [firstLine];
  }
}

function callSubject(toolName, args) {
  const params = asRecord(args);
  switch (toolName) {
    case 'worktree_create':
      return oneLine(params.branch, '');
    case 'worktree_list':
      return params.all === true ? 'all' : '';
    case 'worktree_close':
      return oneLine(params.name ?? params.branch ?? params.path, '');
    case 'worktree_session_open':
      return oneLine(params.worktree, '');
    case 'worktree_warp':
      return oneLine(params.name, '');
    default:
      return '';
  }
}

function warningLines(details) {
  const warnings = Array.isArray(details.warnings) ? details.warnings : [];
  const extra = [];
  if (typeof details.pruneError === 'string' && details.pruneError.length > 0) extra.push(details.pruneError);
  return [...warnings, ...extra]
    .map((warning) => oneLine(warning, ''))
    .filter((warning) => warning.length > 0);
}

// Host outputPad contract (installed Pi 1.3.0 ToolRenderContext):
// renderShell:self cards apply the pad themselves — the host wraps them
// in a plain Container with no padding, while default-shell content goes
// through setPaddingX(outputPad) on both sides (pi-tui Text: content in
// width − 2×pad, one margin each side). Non-finite or negative pads read
// as zero, so contexts without the field keep the unpadded shape.
function padCount(context) {
  const pad = asRecord(context).outputPad;
  if (typeof pad !== 'number' || !Number.isFinite(pad) || pad <= 0) return 0;
  return Math.floor(pad);
}

// Every row opens with the accent bar (the float-card left border from the
// reference). The header row is the call card's top rule; a null header
// means a body-only result under that rule. The closing rule optionally
// carries the expand hint and the evidence-backed duration; close:false
// omits it so a paired call leaves the frame to its result. Widths too
// narrow for the bar-plus-space prefix degrade to the bar alone rather
// than overflowing; only width 0 — or padding that leaves no column —
// draws nothing.
function buildCard({ helpers, theme, toneRole, header, rows, hint, duration, width, close = true, context, bgRole, wrap = false }) {
  void bgRole;
  const target = Math.max(0, Math.floor(width));
  if (target === 0) return [];
  const wrapRows = (list, budget) => wrap === true
    ? list.flatMap((row) => wrapTextToWidth(row, budget, helpers))
    : list;
  // S24: the float card when the theme carries the tone background at
  // this width — full-width padded rows in one-column margins — else the
  // outlined card below, byte-identical to before.
  const open = floatOpener(theme, toneRole, target);
  if (open.length > 0) {
    return paintFloatRows(floatCardRows({
      helpers, theme, toneRole, header, rows, hint, duration, close,
      inner: target - FLOAT_MARGIN * 2, wrap,
    }), open);
  }
  const pad = padCount(context);
  const body = target - 2 * pad;
  if (body < 1) return [];
  const bar = themeFg(theme, toneRole, ACCENT_BAR);
  const roomy = body >= 2;
  const prefix = roomy ? `${bar} ` : bar;
  const inner = Math.max(0, body - (roomy ? 2 : 1));
  const fit = (text) => {
    const clean = oneLine(text, '');
    let measured = 0;
    try {
      measured = helpers.visibleWidth(stripAnsi(clean));
    } catch {
      measured = localVisibleWidth(clean);
    }
    if (measured <= inner) return clean;
    try {
      return helpers.truncateToWidth(clean, inner, '…');
    } catch {
      return localTruncate(clean, inner);
    }
  };
  const margin = ' '.repeat(pad);
  const lines = [];
  // S39: expanded wraps every row to the inner width; compact clips via fit().
  const bodyRows = wrap === true ? wrapRows(Array.isArray(rows) ? rows : [], inner) : rows;
  const headRows = header !== null && header !== undefined
    ? (wrap === true ? wrapRows([header], inner) : [fit(header)])
    : [];
  for (const line of headRows) {
    lines.push(`${margin}${prefix}${wrap === true ? themeFg(theme, toneRole, line) : themeFg(theme, toneRole, line)}${margin}`);
  }
  for (const row of bodyRows) lines.push(`${margin}${prefix}${wrap === true ? row : fit(row)}${margin}`);
  if (close) {
    // Gentle-shell geometry (S19): the expand hint and the evidence-backed
    // duration right-align on the closing rule. fit() collapses runs of
    // whitespace, so the padded rule is measured directly here; only an
    // over-budget rule degrades through fit().
    const tail = [hint, duration].filter((part) => typeof part === 'string' && part.length > 0).join(' · ');
    let rule = fit('─');
    if (tail.length > 0) {
      let tailWidth = -1;
      try {
        tailWidth = helpers.visibleWidth(stripAnsi(tail));
      } catch {
        tailWidth = localVisibleWidth(stripAnsi(tail));
      }
      const gap = tailWidth >= 0 ? inner - 1 - tailWidth : -1;
      if (gap >= 1) {
        const padded = `─${' '.repeat(gap)}${tail}`;
        let paddedWidth = -1;
        try {
          paddedWidth = helpers.visibleWidth(stripAnsi(padded));
        } catch {
          paddedWidth = localVisibleWidth(stripAnsi(padded));
        }
        rule = paddedWidth >= 0 && paddedWidth <= inner ? padded : fit(`─ ${tail}`);
      } else {
        rule = fit(`─ ${tail}`);
      }
    }
    lines.push(`${margin}${prefix}${rule}${margin}`);
  }
  return lines;
}

// S24 float recipe (gentle-shell lib/shell-card.ts, CARD_STYLE.FLOAT),
// ported mechanics, not an approximation: a one-column transparent margin
// on both sides; float chrome { topLeft:"\u258E", topLead:" ",
// topRight:"  ", rule:" ", side:"\u258E", rail:" ", bottomLeft:"\u258E",
// bottomRight:" " }; every row padded to the full target width so the
// painted band is a full-width rectangle; a blank padding row above the
// heading and between heading and body; the opener is theme.bg(role,"")
// minus its trailing \x1b[49m, re-armed after every inner reset and
// closed with \x1b[49m; roles by tone (info/success toolSuccessBg,
// warning toolPendingBg, error toolErrorBg — customMessageBg is used
// nowhere in gentle-shell); outlined fallback when the theme lacks the
// role or the width is under 10; the duration rides the closing rule
// only when it fits and is omitted entirely otherwise, never as a
// placeholder dash. No invented hex ever reaches the transcript — only
// these documented role names.
const FLOAT_CHROME = { topLeft: '\u258E', topLead: ' ', topRight: '  ', rule: ' ', side: '\u258E', rail: ' ', bottomLeft: '\u258E', bottomRight: ' ' };
const FLOAT_MARGIN = 1;
const FLOAT_MIN_WIDTH = 10;
const FLOAT_BG_ROLE = { info: 'toolSuccessBg', success: 'toolSuccessBg', warning: 'toolPendingBg', error: 'toolErrorBg' };
const BG_RESET = '\x1b[49m';
// Full resets (pi-tui truncation inserts one) and background resets both
// clear the background.
const BG_CLEARING = /\x1b\[(?:0|49)?m/g;

function floatBgRoleForTone(tone) {
  try {
    if (typeof tone === 'string' && Object.prototype.hasOwnProperty.call(FLOAT_BG_ROLE, tone)) {
      return FLOAT_BG_ROLE[tone];
    }
  } catch {
    // An unusable tone reads as no role: the outlined card below.
  }
  return '';
}

// The tone background opener when the float style applies at this width,
// or "" for the outlined card: width under 10, an unknown tone, a theme
// without theme.bg, or a bg that carries no role (no trailing reset).
function floatOpener(theme, tone, width) {
  try {
    if (Math.floor(width) < FLOAT_MIN_WIDTH) return '';
    const role = floatBgRoleForTone(tone);
    if (!role || !theme || typeof theme.bg !== 'function') return '';
    const painted = theme.bg(role, '');
    if (typeof painted !== 'string' || painted.length === 0) return '';
    return painted.endsWith(BG_RESET) ? painted.slice(0, -BG_RESET.length) : '';
  } catch {
    return '';
  }
}

// Paints every row behind its tone background, re-armed after any reset
// the content carries, inside a transparent one-column margin on both
// sides. Padding rows keep their tone-coloured accent just like content.
function paintFloatRows(rows, open) {
  const margin = ' '.repeat(FLOAT_MARGIN);
  return rows.map((row) => `${margin}${open}${String(row).replace(BG_CLEARING, (reset) => reset + open)}${BG_RESET}${margin}`);
}

function floatMeasure(text, helpers) {
  try {
    return helpers.visibleWidth(stripAnsi(text));
  } catch {
    return localVisibleWidth(stripAnsi(text));
  }
}

function floatFit(text, width, helpers) {
  const clean = oneLine(text, '');
  if (floatMeasure(clean, helpers) <= width) return clean;
  try {
    return helpers.truncateToWidth(clean, width, '\u2026');
  } catch {
    return localTruncate(clean, width);
  }
}

// S39 expanded wrapping: in the expanded form NOTHING may be cut — long
// lines wrap to the inner width instead of truncating with an ellipsis.
// Only the compact (collapsed) row may clip. Wrapping is character based
// on visible columns, so every emitted line fits its budget.
function wrapTextToWidth(text, width, helpers) {
  const clean = oneLine(text, '');
  const budget = Math.max(0, Math.floor(width));
  if (budget <= 0) return [clean];
  const measure = (line) => floatMeasure(line, helpers);
  if (measure(clean) <= budget) return [clean];
  const lines = [];
  let current = '';
  for (const char of clean) {
    const next = current + char;
    if (measure(next) <= budget || current.length === 0) {
      current = next;
    } else {
      lines.push(current);
      current = char;
    }
  }
  lines.push(current);
  return lines;
}

// One float content row at exactly `inner` visible columns: the accent
// bar, one space, the text padded out, one space, the right rail.
function floatContentRow({ helpers, theme, toneRole, text, inner, paint, noClip = false }) {
  const bar = themeFg(theme, toneRole, FLOAT_CHROME.side);
  const contentCols = Math.max(0, inner - 4);
  // With noClip (S39 expanded) the text was already wrapped to fit, so it
  // is never truncated here.
  const fit = noClip === true ? oneLine(text, '') : floatFit(text, contentCols, helpers);
  const styled = typeof paint === 'function' ? paint(fit) : fit;
  const padded = `${styled}${' '.repeat(Math.max(0, contentCols - floatMeasure(styled, helpers)))}`;
  return `${bar} ${padded} ${FLOAT_CHROME.rail}`;
}

function floatBlankRow({ theme, toneRole, inner }) {
  const bar = themeFg(theme, toneRole, FLOAT_CHROME.side);
  return `${bar}${' '.repeat(Math.max(0, inner - 1))}`;
}

// The closing rule: the expand hint and the evidence-backed duration
// right-align on it ONLY when they fit with at least one fill column —
// otherwise the duration is omitted entirely (the hint alone when IT
// fits, else a bare rule), never a placeholder dash. With the float
// chrome the rule itself is spaces, so an omitted tail leaves a blank
// painted band, never a bare dash.
function floatBottomRow({ helpers, theme, toneRole, hint, duration, inner }) {
  const bar = themeFg(theme, toneRole, FLOAT_CHROME.bottomLeft);
  const full = [hint, duration].filter((part) => typeof part === 'string' && part.length > 0).join(' \u00B7 ');
  const candidates = [];
  if (full.length > 0) candidates.push(full);
  if (typeof hint === 'string' && hint.length > 0 && hint !== full) candidates.push(hint);
  for (const tail of candidates) {
    const tailWidth = floatMeasure(tail, helpers);
    const fill = inner - tailWidth - 3;
    if (fill >= 1) {
      return `${bar}${' '.repeat(fill)} ${floatFit(tail, tailWidth, helpers)} `;
    }
  }
  return `${bar}${' '.repeat(Math.max(0, inner - 1))}`;
}

function floatCardRows({ helpers, theme, toneRole, header, rows, hint, duration, close, inner, wrap = false }) {
  const blank = floatBlankRow({ theme, toneRole, inner });
  const out = [];
  const contentCols = Math.max(0, inner - 4);
  // S39: expanded wraps every row to the content width (noClip below, so
  // nothing is cut); compact keeps the single clipped row.
  const wrapList = (list) => wrap === true
    ? list.flatMap((row) => wrapTextToWidth(row, contentCols, helpers))
    : list;
  const headed = header !== null && header !== undefined;
  if (headed) {
    out.push(blank);
    for (const line of wrapList([header])) {
      out.push(floatContentRow({
        helpers, theme, toneRole, text: line, inner, paint: (fit) => themeFg(theme, toneRole, fit), noClip: wrap === true,
      }));
    }
  }
  const body = wrapList(Array.isArray(rows) ? rows : []);
  if (body.length > 0) {
    // The separator between heading and body — and the leading padding
    // of a header-less result, so a paired call plus its result still
    // reads as one card with the heading set off from its body.
    out.push(blank);
    for (const row of body) out.push(floatContentRow({ helpers, theme, toneRole, text: row, inner, noClip: wrap === true }));
  }
  if (close) out.push(floatBottomRow({ helpers, theme, toneRole, hint, duration, inner }));
  return out;
}

function createWorktreeCardRenderer(toolName, deps) {
  if (!WORKTREE_TOOLS.has(toolName)) {
    throw new Error(`unknown worktree tool: ${safeText(toolName) || typeof toolName}`);
  }
  const helpers = resolveHelpers(deps);
  const glyph = GLYPH[toolName];
  const title = TITLE[toolName];

  function renderCall(args, theme, context) {
    const ctx = asRecord(context);
    const pending = ctx.isPartial !== false;
    const failed = ctx.isError === true;
    // Git-orange (warning) while running and settled; error only on failure.
    const toneRole = failed ? 'error' : 'warning';
    const subject = callSubject(toolName, args);
    const header = `${glyph} ${title}${subject.length > 0 ? ` · ${subject}` : ''}`;
    // Paired with a result: the top rule only, so the result body below
    // closes the one shared frame. Awaiting: a closed mini-card.
    const awaiting = cardAwaitingResult(ctx);
    const finished = ctx.isPartial === false || failed;
    const hint = !awaiting && finished ? expandHint(helpers, ctx.expanded === true) : undefined;
    const rows = awaiting && pending && !failed ? [themeFg(theme, 'muted', `running${RUNNING_MARK}`)] : [];
    const close = awaiting;
    return {
      render(width) {
        return buildCard({ helpers, theme, toneRole, header, rows, hint, duration: undefined, width, close, context: ctx });
      },
      invalidate() {},
    };
  }

  function renderResult(result, options, theme, context) {
    const opts = asRecord(options);
    const ctx = asRecord(context);
    const expanded = opts.expanded === true || ctx.expanded === true;
    const partial = opts.isPartial === true;
    const failed = isErrorResult(result, opts, ctx);
    // Git-orange (warning) settled; error only on failure.
    const toneRole = failed ? 'error' : 'warning';
    markCardResult(ctx.state);
    // No repeated title: the call card above owns the header. Expanded
    // keeps the summary plus the full text and warnings; collapsed
    // successes read the ordered per-tool lines while failures keep the
    // summary plus the bounded preview.
    const header = null;
    const summary = summarizeWorktreeResult(toolName, result);
    const text = resultTextOf(result);
    const bodyLines = text.length > 0 ? text.split('\n') : [EMPTY_TEXT];
    const warnings = warningLines(asRecord(result ? result.details : undefined));
    const hint = expandHint(helpers, expanded);
    const duration = durationOf(ctx);
    let rows;
    if (failed) {
      rows = [summary];
    } else if (expanded) {
      rows = [summary];
    } else {
      rows = compactBodyRows(toolName, result);
    }
    if (partial && !failed) {
      rows.push(`receiving${RUNNING_MARK}`);
    } else if (expanded || failed) {
      if (expanded) {
        rows.push(...bodyLines);
        for (const warning of warnings) rows.push(`! ${warning}`);
      } else {
        // Collapsed failure: bounded preview after the error summary.
        const preview = bodyLines.filter((line) => line.trim().length > 0).slice(0, COLLAPSED_PREVIEW_ROWS);
        rows.push(...(preview.length > 0 ? preview : [EMPTY_TEXT]));
      }
    }
    return {
      render(width) {
        // S39: expanded wraps long lines to the inner width (nothing cut);
        // only the compact row may clip.
        return buildCard({ helpers, theme, toneRole, header, rows, hint, duration, width, close: true, context: ctx, wrap: expanded === true });
      },
      invalidate() {},
    };
  }

  return { renderShell: 'self', renderCall, renderResult };
}

// Warp confirmation message renderer (customize-command T13/S20).
//
// The warp is a COMMAND, so it never passes through the tool cards above:
// its one visible confirmation is this custom-message renderer, which the
// extension registers for the `worktree-warp` customType via
// `pi.registerMessageRenderer`. Compact shows the capitalised label plus
// the two ordered lines; expanded adds the checkout path on ctrl+o (S41:
// never repeats in the card body what the notice already says) — the same
// geometry as the tool cards
// (accent bar, right-aligned hint, outputPad on the outlined fallback;
// one-column margins and full-width painted rows on the float card). The
// tone is the documented `warning` role: the installed Pi theme schema
// exposes no orange role, so warning (yellow in the built-in themes) is
// the closest documented match for git-orange, and the float card paints
// it behind `toolPendingBg` per the tone table. Compact shows the
// capitalised label plus the two S42 name-only rows; expanded appends
// exactly `path: now in "<path>"` and `branch: now in "<branch>"` in
// that order (S41/S42: the long prose notice never enters the card body).
// Warp failures never send a message (they notify instead), so `error`
// never appears here. The compact rows read from
// message.details — never by parsing text — with a content fallback when
// details are malformed; a foreign customType returns undefined so the
// host default renderer takes over. Untrusted strings are sanitized
// exactly like the tool cards, and the hook never throws.
const WARP_CUSTOM_TYPE = 'worktree-warp';
const WARP_GLYPH = '\u2387';
const WARP_TITLE = 'Warp \u00B7 moved';

function warpMessageText(message) {
  const content = message ? message.content : undefined;
  if (typeof content === 'string') return safeText(content);
  if (Array.isArray(content)) {
    try {
      return content
        .filter((entry) => entry && entry.type === 'text' && typeof entry.text === 'string')
        .map((entry) => safeText(entry.text))
        .join('\n');
    } catch {
      return '';
    }
  }
  return '';
}

// S42 warp compact: EXACTLY two name-only rows — `moved: <source name>`
// then `to: <target name>` — with no branch and no path on either row.
// The source name travels explicitly as details.fromName; details written
// before that field fall back to the name segment of fromDesc (the text
// before "·"), and the target name is details.name. A foreign or
// malformed payload falls back to the message content, never to a throw.
function warpSourceName(details) {
  const named = oneLine(details.fromName, '');
  if (named.length > 0) return named;
  const cut = oneLine(details.fromDesc, '').split('\u00B7')[0].trim().replace(/\s+/g, ' ');
  return cut;
}

function warpCompactRows(message) {
  const details = asRecord(message ? message.details : undefined);
  const from = warpSourceName(details);
  const name = oneLine(details.name, '');
  if (from.length > 0 && name.length > 0) {
    return [`moved: ${from}`, `to: ${name}`];
  }
  return [oneLine(warpMessageText(message), EMPTY_TEXT)];
}

function createWarpMessageRenderer(deps) {
  const helpers = resolveHelpers(deps);
  return function renderWarpMessage(message, options, theme) {
    if (!message || message.customType !== WARP_CUSTOM_TYPE) return undefined;
    const opts = asRecord(options);
    const expanded = opts.expanded === true;
    const context = { outputPad: opts.outputPad };
    const header = `${WARP_GLYPH} ${WARP_TITLE}`;
    let rows = warpCompactRows(message);
    if (expanded) {
      // S42: expanded adds exactly these two rows after the compact pair,
      // in this order — and nothing else (never the prose notice).
      const detail = asRecord(message.details);
      const to = oneLine(detail.to, '');
      const branch = oneLine(detail.branch, '');
      if (to.length > 0) rows = [...rows, `path: now in "${to}"`];
      if (branch.length > 0) rows = [...rows, `branch: now in "${branch}"`];
    }
    const hint = expandHint(helpers, expanded);
    return {
      render(width) {
        // S39: expanded wraps long lines to the inner width (nothing cut);
        // only the compact row may clip.
        return buildCard({ helpers, theme, toneRole: 'warning', header, rows, hint, duration: undefined, width, close: true, context, wrap: expanded === true });
      },
      invalidate() {},
    };
  };
}

module.exports = {
  createWorktreeCardRenderer,
  createWarpMessageRenderer,
  wrapTextToWidth,
  summarizeWorktreeResult,
  floatBgRoleForTone,
  safeText,
  stripAnsi,
  WORKTREE_TOOLS: [...WORKTREE_TOOLS],
};
