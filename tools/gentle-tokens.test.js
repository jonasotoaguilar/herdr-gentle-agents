'use strict';

// Formal regression tests for the current sidebar reducer
// (lib/gentle-tokens.js). Production files are untouched; this file only
// pins the reducer contract with deterministic hash/expiry values.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tokens = require('../lib/gentle-tokens.js');

const NOW = 1700000000000;
const EXPIRY = NOW + 10000;
const SESSION_PATH = '/tmp/gentle-test-session';

function baseEntry(overrides = {}) {
  return {
    agent_session: { agent: 'pi', kind: 'path', value: SESSION_PATH },
    agent_status: 'unknown',
    group: 'myproj',
    tokens: {},
    ...overrides,
  };
}

function sessionHashFor(entry) {
  const hash = tokens.expectedSessionHash(entry);
  assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
  return hash;
}

// Fresh gentle_work_v1 token bound to the entry's session hash.
function workToken(hash, count = 0, expiry = EXPIRY) {
  return `${hash}:${count}:${expiry}`;
}

function roleEntry(roleCsv, { count = 0, stateLabels, extraTokens, ...rest } = {}) {
  const entry = baseEntry({ ...rest });
  const hash = sessionHashFor(entry);
  entry.tokens = {
    gentle_work_v1: workToken(hash, count),
    gentle_roles_v1: roleCsv,
    ...(extraTokens || {}),
  };
  if (stateLabels !== undefined) entry.state_labels = stateLabels;
  return { entry, hash };
}

describe('fresh count=0 role hint', () => {
  const cases = [
    { roles: 'worker', display: 'worker', label: 'worker' },
    { roles: 'explorer', display: 'explorer', label: 'explore' },
    { roles: 'verify', display: 'verify', label: 'verify' },
    { roles: 'rdd', display: 'review', label: 'review' },
  ];
  for (const { roles, display, label } of cases) {
    it(`${roles} yields ${display}/${label} with no (n)`, () => {
      const { entry } = roleEntry(roles, { count: 0 });
      const reduced = tokens.reducePane(entry, NOW);
      assert.equal(reduced.display, display);
      assert.equal(reduced.label, label);
      assert.equal(reduced.owned, true);

      const row = tokens.rowValueFor(reduced.display, reduced.agent, reduced.label);
      assert.equal(row, `pi · ${label}`);
      assert.doesNotMatch(row, /\(\d+\)/);
      assert.doesNotMatch(reduced.label, /\(/);

      const patch = tokens.displayTokens(reduced);
      const rowTokenName = tokens.ROW_TOKENS[display];
      assert.equal(patch[rowTokenName], `pi · ${label}`);
      assert.doesNotMatch(patch[rowTokenName], /\(\d+\)/);
    });
  }

  it('newest recognized role wins most-recent-first', () => {
    const { entry } = roleEntry('verify,worker', { count: 0 });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'verify');
    assert.equal(reduced.label, 'verify');
  });
});

describe('native icons', () => {
  it('role/working use ●, done ✓, blocked/error ?, idle ○, ask ?', () => {
    assert.equal(tokens.iconValueFor('working'), '●');
    assert.equal(tokens.iconValueFor('explorer'), '●');
    assert.equal(tokens.iconValueFor('worker'), '●');
    assert.equal(tokens.iconValueFor('verify'), '●');
    assert.equal(tokens.iconValueFor('review'), '●');
    assert.equal(tokens.iconValueFor('done'), '✓');
    assert.equal(tokens.iconValueFor('error'), '?');
    assert.equal(tokens.iconValueFor('ask'), '?');
    assert.equal(tokens.iconValueFor('idle'), '○');
  });

  it('heading holds `<icon> <project>` only; no changes, no separators on row 1', () => {
    assert.equal(tokens.headingValueFor('worker', 'myproj'), '● myproj');
    assert.equal(tokens.headingValueFor('done', 'myproj'), '✓ myproj');
    assert.equal(tokens.headingValueFor('error', 'myproj'), '? myproj');
    assert.equal(tokens.headingValueFor('idle', 'myproj'), '○ myproj');
    assert.equal(tokens.headingValueFor('ask', 'myproj'), '? myproj');
    assert.equal(tokens.headingValueFor('orchestrating', 'myproj'), '● myproj');
    assert.equal(tokens.projectValueFor('myproj'), 'myproj');
    assert.equal(tokens.projectValueFor(''), 'workspace');
  });

  it('heading uses the workspace and ignores change args (white structural cell, no rules)', () => {
    assert.equal(
      tokens.headingValueFor('worker', 'myproj', '+110', '-22', '↑3'),
      '● myproj',
    );
    assert.equal(tokens.headingValueFor('worker', 'myproj', '+110', '', ''), '● myproj');
    assert.equal(tokens.headingValueFor('worker', 'myproj', '', '', ''), '● myproj');
    assert.equal(tokens.headingValueFor('worker', ''), '● workspace');
    assert.equal(tokens.headingValueFor('unknown', 'myproj'), null);
  });

  it('project keeps hyphens; heading carries no separator; deleted segment stays exact in its row-2 cell', () => {
    assert.equal(tokens.projectValueFor('my-proj'), 'my-proj');
    const reduced = {
      display: 'worker',
      label: 'worker',
      agent: 'pi',
      workspace: 'my-proj',
      added: '+1',
      deleted: '-2',
      pull: '',
    };
    const patch = tokens.displayTokens(reduced);
    assert.equal(patch[tokens.HEADING_TOKENS.worker], '● my-proj');
    assert.equal(patch[tokens.PROJECT_TOKEN], 'my-proj');
    assert.equal(patch[tokens.CHANGES_DELETED_TOKEN], '-2');
    assert.doesNotMatch(patch[tokens.HEADING_TOKENS.worker], /·/);
    assert.ok(!patch[tokens.HEADING_TOKENS.worker].includes('+1'));
    assert.ok(!patch[tokens.HEADING_TOKENS.worker].includes('-2'));
    assert.ok(!patch[tokens.HEADING_TOKENS.worker].includes('↑'));
  });
});

describe('ask and blocked precedence', () => {
  it('ask outranks role activity and notifies', () => {
    const { entry, hash } = roleEntry('worker', {
      count: 1,
      stateLabels: { 0: 'ask:q1' },
    });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'ask');
    assert.equal(reduced.label, 'ask');
    assert.deepEqual(reduced.notify, { sessionHash: hash, intentId: 'q1', expiry: EXPIRY });
  });

  it('error outranks ask and renders blocked silently', () => {
    const { entry } = roleEntry('worker', {
      count: 1,
      stateLabels: { 0: 'ask:q1', 1: 'error:e1' },
    });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'error');
    assert.equal(reduced.label, 'blocked');
    assert.equal(reduced.notify, null);
  });

  it('error outranks role activity alone', () => {
    const { entry } = roleEntry('worker', {
      count: 1,
      stateLabels: { 0: 'error:e9' },
    });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'error');
    assert.equal(reduced.label, 'blocked');
  });

  it('review outranks role activity but loses to ask', () => {
    const { entry: reviewEntry } = roleEntry('worker', {
      count: 1,
      stateLabels: { 0: 'review:r1' },
    });
    const reviewReduced = tokens.reducePane(reviewEntry, NOW);
    assert.equal(reviewReduced.display, 'review');
    assert.equal(reviewReduced.label, 'review');
    assert.equal(reviewReduced.notify, null);

    const { entry: askWins } = roleEntry('worker', {
      count: 1,
      stateLabels: { 0: 'review:r1', 1: 'ask:q2' },
    });
    const askReduced = tokens.reducePane(askWins, NOW);
    assert.equal(askReduced.display, 'ask');
    assert.equal(askReduced.label, 'ask');
  });

  it('review outranks error-less ask-less role ordering (error > ask > review)', () => {
    assert.deepEqual(tokens.parseBlockedLabel({ 0: 'review:r1', 1: 'ask:q1', 2: 'error:e1' }), {
      kind: 'error',
      id: 'e1',
    });
    assert.deepEqual(tokens.parseBlockedLabel({ 0: 'review:r1', 1: 'ask:q1' }), {
      kind: 'ask',
      id: 'q1',
    });
    assert.deepEqual(tokens.parseBlockedLabel({ 0: 'review:r1' }), { kind: 'review', id: 'r1' });
  });
});

describe('workspace name', () => {
  it('group wins over cwd and workspace_id', () => {
    const entry = baseEntry({
      group: 'myproj',
      workspace_id: 'wA2',
      cwd: '/repo/other',
      foreground_cwd: '/repo/other',
    });
    assert.equal(tokens.parseWorkspaceName(entry), 'myproj');
    const { entry: roleEntryValue } = roleEntry('worker', { count: 0 });
    roleEntryValue.group = 'myproj';
    roleEntryValue.workspace_id = 'wA2';
    const reduced = tokens.reducePane(roleEntryValue, NOW);
    assert.equal(reduced.workspace, 'myproj');
  });

  it('cwd basename fallback when group is absent', () => {
    const entry = baseEntry({ group: undefined, cwd: '/repo/myapp', foreground_cwd: '/repo/myapp/' });
    delete entry.group;
    assert.equal(tokens.parseWorkspaceName(entry), 'myapp');
  });

  it('never uses workspace_id; falls back to literal workspace', () => {
    const entry = baseEntry({ workspace_id: 'wA2', cwd: undefined, foreground_cwd: undefined });
    delete entry.group;
    delete entry.cwd;
    delete entry.foreground_cwd;
    assert.equal(tokens.parseWorkspaceName(entry), 'workspace');
    assert.notEqual(tokens.parseWorkspaceName(entry), 'wA2');
  });
});

describe('orchestrating marker parse', () => {
  it('accepts a fresh session-bound marker', () => {
    const { entry, hash } = roleEntry('worker', { count: 1 });
    assert.ok(entry);
    const parsed = tokens.parseOrchestrating(`${hash}:${EXPIRY}`, hash, NOW);
    assert.deepEqual(parsed, { expiry: EXPIRY });
    assert.equal(tokens.ORCH_TOKEN, 'gentle_orchestrating_v1');
  });

  it('rejects foreign hash, stale expiry, zero expiry, and malformed values', () => {
    const { hash } = roleEntry('worker', { count: 1 });
    const foreign = sessionHashFor(baseEntry({ agent_session: { agent: 'pi', kind: 'path', value: '/other/session' } }));
    assert.equal(tokens.parseOrchestrating(`${foreign}:${EXPIRY}`, hash, NOW), null);
    assert.equal(tokens.parseOrchestrating(`${hash}:${NOW}`, hash, NOW), null);
    assert.equal(tokens.parseOrchestrating(`${hash}:0`, hash, NOW), null);
    assert.equal(tokens.parseOrchestrating(`${hash}:${NOW + 60001}`, hash, NOW), null);
    assert.equal(tokens.parseOrchestrating(`${hash}:${EXPIRY}:extra`, hash, NOW), null);
    assert.equal(tokens.parseOrchestrating('not-a-marker', hash, NOW), null);
    assert.equal(tokens.parseOrchestrating(null, hash, NOW), null);
    assert.equal(tokens.parseOrchestrating(`${hash}:${EXPIRY}`, null, NOW), null);
  });
});

describe('orchestrating reduction', () => {
  function orchEntry(roleCsv, { count = 1, stateLabels, stale = false } = {}) {
    const built = roleEntry(roleCsv, { count, stateLabels });
    built.entry.tokens[tokens.ORCH_TOKEN] = stale ? `${built.hash}:${NOW}` : `${built.hash}:${EXPIRY}`;
    return built;
  }

  it('recognized role outranks a fresh marker (role-over-root priority)', () => {
    const { entry } = orchEntry('worker,explorer', { count: 2 });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'worker');
    assert.equal(reduced.label, 'worker');
    assert.equal(reduced.owned, true);
    assert.equal(reduced.notify, null);
  });

  it('role hint wins at count 0 even with a fresh marker (pending-launch case)', () => {
    const { entry } = orchEntry('worker', { count: 0 });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'worker');
    assert.equal(reduced.label, 'worker');
  });

  it('fresh marker wins with no recognized role (would-be working)', () => {
    const built = roleEntry('', { count: 3 });
    built.entry.tokens[tokens.ORCH_TOKEN] = `${built.hash}:${EXPIRY}`;
    const reduced = tokens.reducePane(built.entry, NOW);
    assert.equal(reduced.display, 'orchestrating');
  });

  it('fresh root marker with zero subagents and no roles selects gentle (main work)', () => {
    const built = roleEntry('', { count: 0 });
    built.entry.tokens[tokens.ORCH_TOKEN] = `${built.hash}:${EXPIRY}`;
    const reduced = tokens.reducePane(built.entry, NOW);
    assert.equal(reduced.display, 'orchestrating');
    assert.equal(reduced.label, 'gentle');
    assert.equal(reduced.owned, true);
    assert.equal(reduced.notify, null);
  });

  it('terminal done outranks roles and a fresh marker', () => {
    const built = orchEntry('worker', { count: 0 });
    built.entry.agent_status = 'done';
    const reduced = tokens.reducePane(built.entry, NOW);
    assert.equal(reduced.display, 'done');
    assert.equal(reduced.label, 'done');
  });

  it('attention states outrank the marker', () => {
    const cases = [
      [{ 0: 'ask:q1' }, 'ask', 'ask'],
      [{ 0: 'error:e1' }, 'error', 'blocked'],
      [{ 0: 'review:r1' }, 'review', 'review'],
    ];
    for (const [labels, display, label] of cases) {
      const { entry } = orchEntry('worker', { count: 1, stateLabels: labels });
      const reduced = tokens.reducePane(entry, NOW);
      assert.equal(reduced.display, display);
      assert.equal(reduced.label, label);
    }
  });

  it('stale or absent marker preserves existing role behavior', () => {
    const staleBuilt = orchEntry('worker', { count: 1, stale: true });
    const staleReduced = tokens.reducePane(staleBuilt.entry, NOW);
    assert.equal(staleReduced.display, 'worker');

    const absentBuilt = roleEntry('verify,worker', { count: 2 });
    const absentReduced = tokens.reducePane(absentBuilt.entry, NOW);
    assert.equal(absentReduced.display, 'verify');

    const workingBuilt = roleEntry('', { count: 3 });
    const workingReduced = tokens.reducePane(workingBuilt.entry, NOW);
    assert.equal(workingReduced.display, 'working');
  });
});

describe('role-over-root-marker precedence', () => {
  // User priority (task 18): any active recognized role
  // (explorer/worker/verify/rdd) shows over root `gentle`; the marker
  // renders only with no recognized role active. Attention states stay
  // highest and terminal `done` stays above activity (covered above).
  // Slug contract: the producer maps the actual registry agent
  // `gentle-ai-explore` (plus the `gentle-ai-explorer` alias) to the
  // `explorer` slug, so every case below exercises the producer's
  // gentle-ai-explore path at the reducer boundary.
  function markedRoleEntry(roleCsv, count = 1) {
    const built = roleEntry(roleCsv, { count });
    built.entry.tokens[tokens.ORCH_TOKEN] = `${built.hash}:${EXPIRY}`;
    return built.entry;
  }

  const cases = [
    { roles: 'explorer', display: 'explorer', label: 'explore' },
    { roles: 'worker', display: 'worker', label: 'worker' },
    { roles: 'verify', display: 'verify', label: 'verify' },
    { roles: 'rdd', display: 'review', label: 'review' },
  ];
  for (const { roles, display, label } of cases) {
    it(`${roles} beats a fresh marker (${display}/${label})`, () => {
      const reduced = tokens.reducePane(markedRoleEntry(roles), NOW);
      assert.equal(reduced.display, display);
      assert.equal(reduced.label, label);
      assert.equal(reduced.owned, true);
    });
  }

  it('explorer slug parses and displays (gentle-ai-explore / alias contract)', () => {
    assert.deepEqual(tokens.parseRoles('explorer'), ['explorer']);
    assert.equal(tokens.roleToDisplay('explorer'), 'explorer');
    const reduced = tokens.reducePane(markedRoleEntry('explorer', 0), NOW);
    assert.equal(reduced.display, 'explorer');
    assert.equal(reduced.label, 'explore');
  });

  it('newest role wins over a fresh marker', () => {
    const reduced = tokens.reducePane(markedRoleEntry('worker,explorer', 2), NOW);
    assert.equal(reduced.display, 'worker');
  });

  it('marker still renders with no recognized role', () => {
    const reduced = tokens.reducePane(markedRoleEntry('', 3), NOW);
    assert.equal(reduced.display, 'orchestrating');
    assert.equal(reduced.label, 'gentle');
  });
});

describe('orchestrating display family', () => {
  it('display key stays orchestrating; label, icon, heading, row use gentle', () => {
    assert.ok(tokens.DISPLAYS.includes('orchestrating'));
    assert.equal(tokens.DISPLAYS.length, 10);
    assert.equal(tokens.DISPLAY_LABELS.orchestrating, 'gentle');
    assert.equal(tokens.iconValueFor('orchestrating'), '●');
    assert.equal(tokens.headingValueFor('orchestrating', 'myproj'), '● myproj');
    assert.equal(tokens.projectValueFor('myproj'), 'myproj');
    assert.equal(tokens.rowValueFor('orchestrating', 'pi', 'gentle'), 'pi · gentle');
  });

  it('displayTokens presence-encodes the orchestrating family', () => {
    const reduced = {
      display: 'orchestrating',
      label: 'gentle',
      agent: 'pi',
      workspace: 'myproj',
      added: '',
      deleted: '',
      pull: '',
    };
    const patch = tokens.displayTokens(reduced);
    assert.equal(patch[tokens.STATE_TOKENS.orchestrating], 'orchestrating');
    assert.equal(patch[tokens.TITLE_TOKENS.orchestrating], 'gentle');
    assert.equal(patch[tokens.AGENT_TOKENS.orchestrating], 'pi');
    assert.equal(patch[tokens.ICON_TOKENS.orchestrating], '●');
    assert.equal(patch[tokens.HEADING_TOKENS.orchestrating], '● myproj');
    assert.equal(patch[tokens.ROW_TOKENS.orchestrating], 'pi · gentle');
    assert.equal(patch[tokens.PROJECT_TOKEN], 'myproj');
    assert.equal(patch[tokens.CHANGES_SUMMARY_TOKEN], null);
    for (const display of tokens.DISPLAYS) {
      if (display === 'orchestrating') continue;
      assert.equal(patch[tokens.STATE_TOKENS[display]], null);
      assert.equal(patch[tokens.TITLE_TOKENS[display]], null);
      assert.equal(patch[tokens.HEADING_TOKENS[display]], null);
      assert.equal(patch[tokens.ROW_TOKENS[display]], null);
    }
  });

  it('owned and sweep lists grow by the project + summary addition (64 + 2 = 66)', () => {
    assert.equal(tokens.OWNED_TOKENS.length, 66);
    const names = [
      'gentle_state_orchestrating',
      'gentle_title_orchestrating',
      'gentle_agent_orchestrating',
      'gentle_icon_orchestrating',
      'gentle_heading_orchestrating',
      'gentle_row_orchestrating',
    ];
    for (const name of names) {
      assert.ok(tokens.OWNED_TOKENS.includes(name));
      assert.ok(tokens.SWEEP_TOKENS.includes(name));
    }
    assert.ok(tokens.OWNED_TOKENS.includes('gentle_project'));
    assert.ok(tokens.OWNED_TOKENS.includes('gentle_changes_summary'));
    assert.ok(tokens.SWEEP_TOKENS.includes('gentle_project'));
    assert.ok(tokens.SWEEP_TOKENS.includes('gentle_changes_summary'));
  });
});

describe('changes summary cell', () => {
  it('joins nonempty segments with spaces; null when all absent', () => {
    assert.equal(tokens.changesSummaryValue('+110', '-22', ''), '+110 -22');
    assert.equal(tokens.changesSummaryValue('+110', '', '↑3'), '+110 ↑3');
    assert.equal(tokens.changesSummaryValue('', '', '↑3'), '↑3');
    assert.equal(tokens.changesSummaryValue('+1', '-2', '↑3'), '+1 -2 ↑3');
    assert.equal(tokens.changesSummaryValue('', '', ''), null);
    assert.equal(tokens.changesSummaryValue(null, undefined, ''), null);
  });

  it('displayTokens publishes segments as structural row-2 cells while the heading stays `<icon> <project>`', () => {
    const reduced = {
      display: 'worker',
      label: 'worker',
      agent: 'pi',
      workspace: 'myproj',
      added: '+110',
      deleted: '-22',
      pull: '↑3',
    };
    const patch = tokens.displayTokens(reduced);
    assert.equal(patch[tokens.CHANGES_ADDED_TOKEN], '+110');
    assert.equal(patch[tokens.CHANGES_DELETED_TOKEN], '-22');
    assert.equal(patch[tokens.CHANGES_PULL_TOKEN], '↑3');
    assert.equal(patch[tokens.CHANGES_SUMMARY_TOKEN], '+110 -22 ↑3');
    assert.doesNotMatch(patch[tokens.CHANGES_SUMMARY_TOKEN], /·/);
    assert.equal(patch[tokens.HEADING_TOKENS.worker], '● myproj');
    assert.equal(patch[tokens.PROJECT_TOKEN], 'myproj');
    assert.doesNotMatch(patch[tokens.HEADING_TOKENS.worker], /·/);
    assert.ok(!patch[tokens.HEADING_TOKENS.worker].includes('+110'));
    assert.ok(!patch[tokens.HEADING_TOKENS.worker].includes('-22'));
    assert.ok(!patch[tokens.HEADING_TOKENS.worker].includes('↑3'));
  });

  it('row 1 presence-encoding leaves exactly one nonempty `<icon> <project>` heading', () => {
    const reduced = {
      display: 'worker',
      label: 'worker',
      agent: 'pi',
      workspace: 'myproj',
      added: '+1',
      deleted: '',
      pull: '',
    };
    const patch = tokens.displayTokens(reduced);
    const nonempty = tokens.DISPLAYS.filter((display) => patch[tokens.HEADING_TOKENS[display]] !== null);
    assert.deepEqual(nonempty, ['worker']);
    assert.equal(patch[tokens.HEADING_TOKENS.worker], '● myproj');
    assert.equal(patch[tokens.PROJECT_TOKEN], 'myproj');
    assert.equal(patch[tokens.CHANGES_ADDED_TOKEN], '+1');
    assert.doesNotMatch(patch[tokens.HEADING_TOKENS.worker], /·/);
  });

  it('added stays +N and deleted stays -N (never swapped)', () => {
    const reduced = {
      display: 'worker',
      label: 'worker',
      agent: 'pi',
      workspace: 'myproj',
      added: '+7',
      deleted: '-3',
      pull: '',
    };
    const patch = tokens.displayTokens(reduced);
    assert.equal(patch[tokens.CHANGES_ADDED_TOKEN], '+7');
    assert.equal(patch[tokens.CHANGES_DELETED_TOKEN], '-3');
  });

  it('summary collapses to null with no changes', () => {
    const reduced = {
      display: 'idle',
      label: 'idle',
      agent: 'pi',
      workspace: 'myproj',
      added: '',
      deleted: '',
      pull: '',
    };
    const patch = tokens.displayTokens(reduced);
    assert.equal(patch[tokens.CHANGES_SUMMARY_TOKEN], null);
  });
});

describe('row value identity', () => {
  it('agent + separator remain, no ANSI (color is config-level)', () => {   const row = tokens.rowValueFor('worker', 'pi', 'worker');
    assert.equal(row, 'pi · worker');
    assert.match(row, / · /);
    assert.doesNotMatch(row, //);
    assert.doesNotMatch(row, /\\u001b/);

    const reduced = {
      display: 'worker',
      label: 'worker',
      agent: 'pi',
      workspace: 'myproj',
      added: '',
      deleted: '',
      pull: '',
    };
    const patch = tokens.displayTokens(reduced);
    assert.equal(patch[tokens.ROW_TOKENS.worker], 'pi · worker');
    assert.doesNotMatch(patch[tokens.ROW_TOKENS.worker], //);
  });
});

describe('sidebar row layout (bin/configure.js)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'bin', 'configure.js'), 'utf8');
  function rowBlock(name) {
    const start = src.indexOf('const ' + name + ' = [');
    assert.ok(start >= 0, name + ' defined');
    const end = src.indexOf('];', start);
    assert.ok(end > start, name + ' closed');
    return src.slice(start, end);
  }
  const row1 = rowBlock('PI_ROW_1');
  const row2 = rowBlock('PI_ROW_2');
  const cells = (block) => block.split("sidebarCell('").length - 1;

  it('row 1 is exactly native state_icon, workspace, agent in order', () => {
    const order = ['"state_icon"', '"workspace"', '"agent"'];
    let prev = -1;
    for (const token of order) {
      const idx = row1.indexOf(token);
      assert.ok(idx > prev, token + ' in order on row 1');
      prev = idx;
    }
    assert.ok(!row1.includes('sidebarCell'));
    assert.ok(!row1.includes('$gentle_'));
    assert.ok(!row1.includes('token ='));
    assert.ok(!row1.includes('rules'));
    assert.ok(!row1.includes('$gentle_heading_'));
    assert.ok(!row1.includes('$gentle_project'));
    assert.ok(!row1.includes('$gentle_agent'));
    assert.ok(!row1.includes('$gentle_title_'));
    assert.ok(!row1.includes('$gentle_changes_'));
  });

  it('row 1 uses plain native token strings, no custom cells', () => {
    assert.ok(row1.includes('"state_icon"'));
    assert.ok(row1.includes('"workspace"'));
    assert.ok(row1.includes('"agent"'));
    assert.ok(!row1.includes('$gentle_heading_'));
    assert.ok(!row1.includes('$gentle_project'));
    assert.ok(!row1.includes('$gentle_agent'));
    assert.ok(!row1.includes('sidebarCell'));
  });

  it('row 2 is state word + added + deleted + pull in exact order, no rules', () => {
    const order = [
      '$gentle_title_working',
      '$gentle_title_orchestrating',
      '$gentle_title_explorer',
      '$gentle_title_worker',
      '$gentle_title_verify',
      '$gentle_title_ask',
      '$gentle_title_review',
      '$gentle_title_error',
      '$gentle_title_done',
      '$gentle_title_idle',
      '$gentle_changes_added',
      '$gentle_changes_deleted',
      '$gentle_changes_pull',
    ];
    let prev = -1;
    for (const token of order) {
      const idx = row2.indexOf(token);
      assert.ok(idx > prev, token + ' in order on row 2');
      prev = idx;
    }
    assert.equal(cells(row2), 13);
    assert.ok(!row2.includes('rules'));
    assert.ok(!row2.includes('$gentle_heading_'));
    assert.ok(!row2.includes('$gentle_project'));
    assert.ok(!row2.includes('$gentle_agent'));
    assert.ok(!row2.includes('$gentle_changes_summary'));
  });

  it('row 2 keeps agent off; state colors preserved; added green, deleted red, pull blue', () => {
    assert.ok(!row2.includes("'$gentle_agent'"));
    const expected = [
      ['$gentle_title_working', 'SIDEBAR_AMBER'],
      ['$gentle_title_orchestrating', 'SIDEBAR_FUCHSIA'],
      ['$gentle_title_explorer', 'SIDEBAR_BLUE'],
      ['$gentle_title_worker', 'SIDEBAR_AMBER'],
      ['$gentle_title_verify', 'SIDEBAR_TEAL'],
      ['$gentle_title_ask', 'SIDEBAR_ORANGE'],
      ['$gentle_title_review', 'SIDEBAR_BLUE'],
      ['$gentle_title_error', 'SIDEBAR_RED'],
      ['$gentle_title_done', 'SIDEBAR_GREEN'],
      ['$gentle_title_idle', 'SIDEBAR_GREY'],
      ['$gentle_changes_added', 'SIDEBAR_GREEN'],
      ['$gentle_changes_deleted', 'SIDEBAR_RED'],
      ['$gentle_changes_pull', 'SIDEBAR_BLUE'],
    ];
    for (const [token, color] of expected) {
      assert.ok(row2.includes("sidebarCell('" + token + "', " + color + ')'), token + ' ' + color);
    }
  });
});

describe('README managed example matches generated config exactly', () => {
  const fsReadme = require('node:fs');
  const pathReadme = require('node:path');
  const configure = require('../bin/configure.js');
  const readme = fsReadme.readFileSync(pathReadme.join(__dirname, '..', 'README.md'), 'utf8');

  it('README embeds the exact generated pi row (row 1 native, row 2 title + changes)', () => {
    assert.ok(configure.PI_ROW.startsWith('pi = [["state_icon", "workspace", "agent"]'));
    assert.ok(readme.includes(configure.PI_ROW));
  });

  it('README block carries the managed markers and review-blue title cell', () => {
    assert.ok(readme.includes(configure.MANAGED_BEGIN));
    assert.ok(readme.includes(configure.MANAGED_END));
    assert.ok(readme.includes('{ token = "$gentle_title_review", fg = "#89b4fa" }'));
    assert.ok(readme.includes('{ token = "$gentle_title_idle", fg = "#7c7f93" }'));
  });

  it('README example wires no heading/agent/project cells and claims no heading rules', () => {
    const begin = readme.indexOf(configure.MANAGED_BEGIN);
    const end = readme.indexOf(configure.MANAGED_END, begin);
    assert.ok(begin >= 0 && end > begin);
    const block = readme.slice(begin, end);
    assert.ok(!block.includes('$gentle_heading_'));
    assert.ok(!block.includes('$gentle_agent'));
    assert.ok(!block.includes('$gentle_project'));
    assert.ok(!block.includes('$gentle_changes_summary'));
    assert.ok(!block.includes('rules ='));
    assert.ok(!block.includes('#cba6f7'));
  });
});

describe('durable ask token (gentle_ask_v1)', () => {
  function askCase({ intentId = 'q1', expiry = EXPIRY, roles = '', count = 0, stateLabels } = {}) {
    const built = roleEntry(roles, { count, stateLabels });
    built.entry.tokens.gentle_ask_v1 = `${built.hash}:${intentId}:${expiry}`;
    return built;
  }

  it('fresh ask token reduces to ask with notify and no labels', () => {
    assert.equal(tokens.ASK_TOKEN, 'gentle_ask_v1');
    const { entry, hash } = askCase({});
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'ask');
    assert.equal(reduced.label, 'ask');
    assert.deepEqual(reduced.notify, { sessionHash: hash, intentId: 'q1', expiry: EXPIRY });
    assert.equal(reduced.owned, true);
  });

  it('stale ask token is ignored (fail closed)', () => {
    const { entry } = askCase({ expiry: NOW });
    assert.equal(tokens.parseAsk(entry.tokens.gentle_ask_v1, sessionHashFor(entry), NOW), null);
    const reduced = tokens.reducePane(entry, NOW);
    assert.notEqual(reduced.display, 'ask');
    assert.equal(reduced.notify, null);
  });

  it('foreign-session ask token is ignored (fail closed)', () => {
    const built = askCase({});
    const foreign = sessionHashFor(
      baseEntry({ agent_session: { agent: 'pi', kind: 'path', value: '/other/session' } }),
    );
    built.entry.tokens.gentle_ask_v1 = `${foreign}:q1:${EXPIRY}`;
    assert.equal(tokens.parseAsk(built.entry.tokens.gentle_ask_v1, built.hash, NOW), null);
    const reduced = tokens.reducePane(built.entry, NOW);
    assert.notEqual(reduced.display, 'ask');
    assert.equal(reduced.notify, null);
  });

  it('malformed ask token is ignored (fail closed)', () => {
    const hash = 'x'.repeat(43);
    for (const bad of [
      'not-a-token',
      '',
      null,
      `${hash}:q1`,
      `${hash}:q1:${EXPIRY}:extra`,
      `${hash}:bad id!:${EXPIRY}`,
      `${hash}:q1:0`,
    ]) {
      assert.equal(tokens.parseAsk(bad, hash, NOW), null);
    }
    const built = askCase({ intentId: 'bad id!' });
    const reduced = tokens.reducePane(built.entry, NOW);
    assert.notEqual(reduced.display, 'ask');
    assert.equal(reduced.notify, null);
  });

  it('ask token outranks a review label (error > ask > review)', () => {
    const { entry, hash } = askCase({ stateLabels: { 0: 'review:r1' } });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'ask');
    assert.equal(reduced.label, 'ask');
    assert.deepEqual(reduced.notify, { sessionHash: hash, intentId: 'q1', expiry: EXPIRY });
  });

  it('error label still outranks a fresh ask token', () => {
    const { entry } = askCase({ stateLabels: { 0: 'error:e1' } });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'error');
    assert.equal(reduced.label, 'blocked');
    assert.equal(reduced.notify, null);
  });
});

describe('consent-eligible review start (ask while pending, review on resolve)', () => {
  // Producer contract (DESIGN §4.2): a consent-eligible `gentle_review`
  // start (ordinary-mode `start` / `select-intended-untracked`) holds the
  // ask leg while its tool call is pending, then falls back to `review:`
  // or the next state when the call resolves. The reducer needs no change
  // for this — error > ask > review already orders it — so these tests pin
  // the exact label sequences the producer emits across that transition.
  it('ask label co-present with a review label reduces to ask', () => {
    const { entry, hash } = roleEntry('worker', {
      count: 0,
      stateLabels: { 0: 'review:r1', 1: 'ask:q9' },
    });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'ask');
    assert.equal(reduced.label, 'ask');
    assert.deepEqual(reduced.notify, { sessionHash: hash, intentId: 'q9', expiry: EXPIRY });
    assert.equal(reduced.owned, true);
  });

  it('review label alone after the start resolves reduces to review', () => {
    const { entry } = roleEntry('worker', {
      count: 0,
      stateLabels: { 0: 'review:r1' },
    });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'review');
    assert.equal(reduced.label, 'review');
    assert.equal(reduced.notify, null);
    assert.equal(reduced.owned, true);
  });
});

describe('durable review token (gentle_review_v1)', () => {
  function reviewCase({ reviewId = 'r1', expiry = EXPIRY, roles = '', count, stateLabels, askToken } = {}) {
    const built = roleEntry(roles, { count: count ?? 0, stateLabels });
    // Independently of work token presence: drop gentle_work_v1 unless the
    // caller passes an explicit count.
    if (count === undefined) delete built.entry.tokens.gentle_work_v1;
    built.entry.tokens.gentle_review_v1 = `${built.hash}:${reviewId}:${expiry}`;
    if (askToken !== undefined) built.entry.tokens.gentle_ask_v1 = askToken;
    return built;
  }

  it('fresh review token reduces to review silently with no work token', () => {
    assert.equal(tokens.REVIEW_TOKEN, 'gentle_review_v1');
    const { entry } = reviewCase({});
    assert.ok(!('gentle_work_v1' in entry.tokens));
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'review');
    assert.equal(reduced.label, 'review');
    assert.equal(reduced.notify, null);
    assert.equal(reduced.owned, true);
    const patch = tokens.displayTokens(reduced);
    assert.equal(patch[tokens.ROW_TOKENS.review], 'pi · review');
  });

  it('fresh review token repairs a missed review label and outranks roles', () => {
    const { entry, hash } = reviewCase({ roles: 'worker', count: 1 });
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'review');
    assert.equal(reduced.label, 'review');
    assert.equal(reduced.notify, null);
    assert.deepEqual(tokens.parseReview(entry.tokens.gentle_review_v1, hash, NOW), {
      reviewId: 'r1',
      expiry: EXPIRY,
    });
  });

  it('stale review token is ignored (fail closed, no grace)', () => {
    const { entry } = reviewCase({ expiry: NOW, roles: 'worker', count: 1 });
    assert.equal(tokens.parseReview(entry.tokens.gentle_review_v1, sessionHashFor(entry), NOW), null);
    const reduced = tokens.reducePane(entry, NOW);
    assert.equal(reduced.display, 'worker');
    assert.equal(reduced.notify, null);
  });

  it('foreign-session review token is ignored (fail closed)', () => {
    const built = reviewCase({});
    const foreign = sessionHashFor(
      baseEntry({ agent_session: { agent: 'pi', kind: 'path', value: '/other/session' } }),
    );
    built.entry.tokens.gentle_review_v1 = `${foreign}:r1:${EXPIRY}`;
    assert.equal(tokens.parseReview(built.entry.tokens.gentle_review_v1, built.hash, NOW), null);
    const reduced = tokens.reducePane(built.entry, NOW);
    assert.notEqual(reduced.display, 'review');
    assert.equal(reduced.notify, null);
  });

  it('malformed review token is ignored (fail closed)', () => {
    const hash = 'x'.repeat(43);
    for (const bad of [
      'not-a-token',
      '',
      null,
      `${hash}:r1`,
      `${hash}:r1:${EXPIRY}:extra`,
      `${hash}:bad id!:${EXPIRY}`,
      `${hash}:r1:0`,
      `${hash}:r1:${NOW + 60001}`,
    ]) {
      assert.equal(tokens.parseReview(bad, hash, NOW), null);
    }
    const built = reviewCase({ reviewId: 'bad id!' });
    const reduced = tokens.reducePane(built.entry, NOW);
    assert.notEqual(reduced.display, 'review');
    assert.equal(reduced.notify, null);
  });

  it('error > ask > review: labels and durable tokens share one precedence', () => {
    // Label legs ride the work-token beat gate, so these cases keep a fresh
    // work token; the review token itself needs none (pinned above).
    // Review token loses to an ask label.
    const { entry: askWins } = reviewCase({ stateLabels: { 0: 'ask:q2' }, count: 1 });
    const askReduced = tokens.reducePane(askWins, NOW);
    assert.equal(askReduced.display, 'ask');
    assert.equal(askReduced.label, 'ask');
    // Review token loses to an error label.
    const { entry: errorWins } = reviewCase({ stateLabels: { 0: 'error:e1' }, count: 1 });
    const errorReduced = tokens.reducePane(errorWins, NOW);
    assert.equal(errorReduced.display, 'error');
    assert.equal(errorReduced.label, 'blocked');
    // Review token loses to a fresh ask token.
    const askBuilt = reviewCase({});
    askBuilt.entry.tokens.gentle_ask_v1 = `${askBuilt.hash}:q7:${EXPIRY}`;
    const askTokenReduced = tokens.reducePane(askBuilt.entry, NOW);
    assert.equal(askTokenReduced.display, 'ask');
    assert.deepEqual(askTokenReduced.notify, {
      sessionHash: askBuilt.hash,
      intentId: 'q7',
      expiry: EXPIRY,
    });
    // Review token agrees with a review label.
    const { entry: reviewBoth } = reviewCase({ stateLabels: { 0: 'review:r9' }, count: 1 });
    const reviewReduced = tokens.reducePane(reviewBoth, NOW);
    assert.equal(reviewReduced.display, 'review');
    assert.equal(reviewReduced.label, 'review');
    assert.equal(reviewReduced.notify, null);
  });

  it('review token outranks done, orchestrating, and main working', () => {
    const { entry: doneEntry } = reviewCase({});
    doneEntry.agent_status = 'done';
    assert.equal(tokens.reducePane(doneEntry, NOW).display, 'review');

    const orchBuilt = reviewCase({ roles: '', count: 2 });
    orchBuilt.entry.tokens[tokens.ORCH_TOKEN] = `${orchBuilt.hash}:${EXPIRY}`;
    assert.equal(tokens.reducePane(orchBuilt.entry, NOW).display, 'review');

    const { entry: workingEntry } = reviewCase({ roles: '', count: 3 });
    assert.equal(tokens.reducePane(workingEntry, NOW).display, 'review');
  });
});
