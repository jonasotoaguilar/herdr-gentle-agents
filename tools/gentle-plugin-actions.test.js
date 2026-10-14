'use strict';
// T4 manifest/docs/public-manifest slice (S1-S7 integration): the parent-owned
// manifest surface plus the public help contracts of the read-only
// diagnostics CLIs, tested through public entrypoints only.
//
// Isolation contract: manifest assertions read herdr-plugin.toml as text.
// CLI assertions drive the real bins via fixed-argv HERDR_BIN_PATH against
// a temp fake `herdr` replaying canned `agent list` JSON. Rejected input
// must cause zero Herdr calls and zero filesystem writes. Never invoke
// --once/--refresh/--stop/--run and never touch live config, live state,
// or the network.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(REPO_ROOT, 'herdr-plugin.toml');
const DOCTOR = path.join(REPO_ROOT, 'bin', 'gentle-doctor.js');
const TRACE = path.join(REPO_ROOT, 'bin', 'gentle-trace.js');
const WHOIS = path.join(REPO_ROOT, 'bin', 'gentle-whois.js');

// Minimal strict TOML reader for this manifest's shape only: top-level
// `key = "value"` scalars plus [[startup]]/[[events]]/[[actions]] tables
// with scalar and inline-array values. Anything else throws.
function parseManifest(text) {
  const top = {};
  const startup = [];
  const events = [];
  const actions = [];
  let current = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const section = line.match(/^\[\[(startup|events|actions)\]\]$/);
    if (section) {
      current = {};
      if (section[1] === 'startup') startup.push(current);
      else if (section[1] === 'events') events.push(current);
      else actions.push(current);
      continue;
    }
    if (/^\[/.test(line)) throw new Error(`unsupported section: ${line}`);
    const kv = line.match(/^([A-Za-z0-9_]+)\s*=\s*(.+)$/);
    if (!kv) throw new Error(`unparseable line: ${line}`);
    const value = parseValue(kv[2]);
    if (current) current[kv[1]] = value;
    else top[kv[1]] = value;
  }
  return { top, startup, events, actions };
}

function parseValue(raw) {
  const s = raw.trim().replace(/,(\s*#.*)?$/, '');
  if (s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => {
      const v = part.trim();
      if (!v.startsWith('"') || !v.endsWith('"')) throw new Error(`bad array item: ${part}`);
      return v.slice(1, -1);
    });
  }
  throw new Error(`unsupported value: ${raw}`);
}

function readManifest() {
  return parseManifest(fs.readFileSync(MANIFEST, 'utf8'));
}

const FAKE_HERDR = `#!/bin/sh
# Fake herdr: logs every argv with framing, replays canned agent list JSON.
printf -- '---CALL---\\n' >>"$CALL_LOG"
i=0
for a in "$@"; do printf 'arg%s=<%s>\\n' "$i" "$a" >>"$CALL_LOG"; i=$((i+1)); done
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  if [ -n "$AGENTS_EXIT" ] && [ "$AGENTS_EXIT" != "0" ]; then exit "$AGENTS_EXIT"; fi
  cat "$AGENTS_FILE"
  exit 0
fi
echo '{"error":"unexpected-args"}'
exit 1
`;

let sandbox;
let stateDir;

function mkSandbox() {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-manifest-'));
  stateDir = path.join(sandbox, 'state');
  fs.mkdirSync(stateDir, { recursive: true });
  const bin = path.join(sandbox, 'herdr');
  fs.writeFileSync(bin, FAKE_HERDR, { mode: 0o755 });
  fs.writeFileSync(path.join(sandbox, 'calls.log'), '');
  fs.writeFileSync(path.join(sandbox, 'agents.json'), '{"result":{"agents":[]}}');
  fs.writeFileSync(path.join(sandbox, 'herdr.toml'), '# fixture config\n');
  return bin;
}

function fixtureEnv(extra = {}) {
  return {
    ...process.env,
    HERDR_BIN_PATH: path.join(sandbox, 'herdr'),
    CALL_LOG: path.join(sandbox, 'calls.log'),
    AGENTS_FILE: path.join(sandbox, 'agents.json'),
    GENTLE_STATUS_STATE_DIR: stateDir,
    HERDR_CONFIG_PATH: path.join(sandbox, 'herdr.toml'),
    ...extra,
  };
}

function run(bin, args, extraEnv = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    env: fixtureEnv(extraEnv),
    encoding: 'utf8',
    timeout: 10000,
  });
}

function callCount() {
  const log = fs.readFileSync(path.join(sandbox, 'calls.log'), 'utf8');
  return log.split('---CALL---').length - 1;
}

function stateSnapshot() {
  const out = {};
  for (const name of fs.readdirSync(stateDir)) {
    out[name] = fs.readFileSync(path.join(stateDir, name), 'utf8');
  }
  return out;
}

beforeEach(() => {
  mkSandbox();
});

afterEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('manifest compatibility floor (S5: min 0.9.4, no release bump)', () => {
  it('requires Herdr >= 0.9.4', () => {
    assert.equal(readManifest().top.min_herdr_version, '0.9.4');
  });

  it('keeps the current plugin version (release not authorized)', () => {
    assert.equal(readManifest().top.version, '0.3.3');
  });

  it('stays linux-only', () => {
    assert.deepEqual(readManifest().top.platforms, ['linux']);
  });
});

describe('manifest configure/unconfigure pair untouched (PRESERVE)', () => {
  it('keeps the exact configure action', () => {
    const actions = readManifest().actions;
    const configure = actions.find((a) => a.id === 'configure');
    assert.deepEqual(configure.command, ['node', 'bin/configure.js', '--apply', '--reload']);
    assert.equal(configure.title, 'Configure: install the pi-only sidebar override');
  });

  it('keeps the exact unconfigure action', () => {
    const actions = readManifest().actions;
    const unconfigure = actions.find((a) => a.id === 'unconfigure');
    assert.deepEqual(unconfigure.command, ['node', 'bin/configure.js', '--uninstall', '--reload']);
  });
});

describe('manifest read-only diagnostic actions (S2/S5)', () => {
  it('exposes a read-only doctor action', () => {
    const doctor = readManifest().actions.find((a) => a.id === 'doctor');
    assert.deepEqual(doctor.command, ['node', 'bin/gentle-doctor.js']);
    assert.deepEqual(doctor.platforms, ['linux']);
    assert.match(doctor.description, /read-only/i);
    for (const banned of ['--apply', '--stop', '--reload', '--purge', '--once', '--refresh']) {
      assert.ok(!doctor.command.includes(banned), `doctor action must not carry ${banned}`);
    }
  });

  it('exposes a read-only whois action', () => {
    const whois = readManifest().actions.find((a) => a.id === 'whois');
    assert.deepEqual(whois.command, ['node', 'bin/gentle-whois.js']);
    assert.deepEqual(whois.platforms, ['linux']);
    assert.match(whois.description, /read-only/i);
    for (const banned of ['--apply', '--stop', '--reload', '--purge', '--once', '--refresh']) {
      assert.ok(!whois.command.includes(banned), `whois action must not carry ${banned}`);
    }
  });

  it('wires no static trace action (trace needs an explicit pane id)', () => {
    const hit = readManifest().actions.find((a) => a.id === 'trace');
    assert.equal(hit, undefined);
  });

  it('wires no guessed sidebar action form (sidebar unit owns the helper)', () => {
    // The sidebar unit (bin/gentle-sidebar.js + docs/sidebar-control.md) is
    // still in flight: this slice asserts only that no invented sidebar
    // command is wired, without pinning what the future action must look
    // like. The configure/unconfigure pair above stays the only sidebar
    // wiring until the sidebar unit delivers its forms.
    const hit = readManifest().actions.find((a) => a.id === 'sidebar');
    if (hit !== undefined) {
      assert.ok(
        (hit.command ?? []).every((part) => part !== 'bin/gentle-sidebar.js' || fs.existsSync(part)),
        'no sidebar action pointing at a helper that does not exist',
      );
    }
  });
});

describe('manifest lifecycle hooks (S2: --refresh per L6)', () => {
  const REFRESH = ['node', 'bin/gentle-status.js', '--refresh'];
  const HOOKS = [
    'pane.agent_detected',
    'pane.agent_status_changed',
    'pane.exited',
    'pane.closed',
  ];

  it('wires all four installed-schema lifecycle events to --refresh', () => {
    const events = readManifest().events;
    for (const on of HOOKS) {
      const hook = events.find((e) => e.on === on);
      assert.deepEqual(hook?.command, REFRESH, `hook ${on} must run --refresh`);
    }
    assert.equal(events.length, HOOKS.length);
  });

  it('keeps the polling-daemon startup bootstrap untouched', () => {
    assert.deepEqual(readManifest().startup, [{ command: ['node', 'bin/gentle-status.js'] }]);
  });
});

describe('public help contracts (exact, through public entrypoints)', () => {
  it('doctor --help exits 0 with usage on stdout and empty stderr', () => {
    const before = { calls: callCount(), state: stateSnapshot() };
    const r = run(DOCTOR, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: gentle-doctor/);
    assert.equal(r.stderr, '');
    assert.equal(callCount(), before.calls);
    assert.deepEqual(stateSnapshot(), before.state);
  });

  it('whois --help exits 0 with usage on stdout and empty stderr', () => {
    const before = { calls: callCount(), state: stateSnapshot() };
    const r = run(WHOIS, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: gentle-whois/);
    assert.equal(r.stderr, '');
    assert.equal(callCount(), before.calls);
    assert.deepEqual(stateSnapshot(), before.state);
  });

  it('trace --help exits 0 with usage on stdout and empty stderr', () => {
    const before = { calls: callCount(), state: stateSnapshot() };
    const r = run(TRACE, ['--help']);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: gentle-trace <pane-id>/);
    assert.equal(r.stderr, '');
    assert.equal(callCount(), before.calls);
    assert.deepEqual(stateSnapshot(), before.state);
  });
});

describe('rejected input leaves state and Herdr untouched (exit 2)', () => {
  it('doctor rejects extra args with usage on stderr', () => {
    const before = { calls: callCount(), state: stateSnapshot() };
    const r = run(DOCTOR, ['--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: gentle-doctor/);
    assert.equal(callCount(), before.calls);
    assert.deepEqual(stateSnapshot(), before.state);
  });

  it('whois rejects extra args with usage on stderr', () => {
    const before = { calls: callCount(), state: stateSnapshot() };
    const r = run(WHOIS, ['--bogus']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: gentle-whois/);
    assert.equal(callCount(), before.calls);
    assert.deepEqual(stateSnapshot(), before.state);
  });

  it('trace rejects a missing pane id with usage on stderr', () => {
    const before = { calls: callCount(), state: stateSnapshot() };
    const r = run(TRACE, []);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /usage: gentle-trace <pane-id>/);
    assert.equal(callCount(), before.calls);
    assert.deepEqual(stateSnapshot(), before.state);
  });
});

describe('fixture read-only runs (no live mutation)', () => {
  it('doctor renders pass/warn lines on an empty snapshot with exit 0', () => {
    const r = run(DOCTOR, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /(pass|warn):/);
    assert.equal(r.stderr, '');
  });

  it('whois renders the header on an empty snapshot with exit 0', () => {
    const r = run(WHOIS, []);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /PANE.*AGENT.*STATE.*ROLES.*WORKSPACE/);
    assert.equal(r.stderr, '');
  });
});
