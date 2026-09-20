'use strict';

// Behavior-first isolated tests for install.sh (remote-installer task 2).
//
// Isolation contract: every test builds a temp fixture (HOME, XDG_STATE_HOME,
// PI_AGENT_DIR default under temp HOME, HERDR_CONFIG_PATH) plus a fake `herdr`
// binary that logs argv and replays canned JSON. The live Herdr/Pi config is
// never touched: HERDR_BIN_PATH is unset so `herdr` resolves via a fixture
// PATH, and HERDR_GENTLE_PLUGIN_ROOT is set only in the override tests.
//
// Fixture plugin roots copy the real repo extension source
// (extensions/gentle-herdr-state.ts) so the byte-identity and checksum
// assertions pin real content; bin/configure.js and bin/gentle-status.js are
// logging stubs so no real config or daemon is touched.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const REAL_EXTENSION = path.join(REPO_ROOT, 'extensions', 'gentle-herdr-state.ts');

const FAKE_HERDR = `#!/bin/sh
# Fake herdr for install.sh tests: logs argv, replays canned plugin-list JSON.
log="\${HERDR_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
if [ -n "\${ORDER_LOG:-}" ]; then printf 'herdr %s\\n' "$*" >>"$ORDER_LOG"; fi
if [ "\${1:-}" = "plugin" ] && [ "\${2:-}" = "list" ]; then
  mode="\${FAKE_LIST_MODE:-valid}"
  root="\${FAKE_PLUGIN_ROOT:-/nonexistent}"
  case "$mode" in
    valid)
      printf '{"result":{"plugins":[{"plugin_id":"herdr-gentle-agents","plugin_root":"%s","source":{"kind":"remote"}}]}}\\n' "$root"
      exit 0 ;;
    local)
      printf '{"result":{"plugins":[{"plugin_id":"herdr-gentle-agents","plugin_root":"%s","source":{"kind":"local"}}]}}\\n' "$root"
      exit 0 ;;
    empty)
      printf '{"result":{"plugins":[]}}\\n'
      exit 0 ;;
    malformed)
      printf 'not json{{{\\n'
      exit 0 ;;
    multiple)
      printf '{"result":{"plugins":[{"plugin_id":"herdr-gentle-agents","plugin_root":"%s-a","source":{"kind":"remote"}},{"plugin_id":"herdr-gentle-agents","plugin_root":"%s-b","source":{"kind":"remote"}}]}}\\n' "$root" "$root"
      exit 0 ;;
    relative)
      printf '{"result":{"plugins":[{"plugin_id":"herdr-gentle-agents","plugin_root":"relative/path","source":{"kind":"remote"}}]}}\\n'
      exit 0 ;;
    missing-field)
      printf '{"result":{"plugins":[{"plugin_id":"herdr-gentle-agents","source":{"kind":"remote"}}]}}\\n'
      exit 0 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "plugin" ] && [ "\${2:-}" = "install" ]; then exit 0; fi
if [ "\${1:-}" = "plugin" ] && [ "\${2:-}" = "enable" ]; then exit 0; fi
if [ "\${1:-}" = "plugin" ] && [ "\${2:-}" = "uninstall" ]; then
  case "\${FAKE_UNINSTALL_MODE:-ok}" in
    ok) exit 0 ;;
    absent) echo "herdr: plugin herdr-gentle-agents is not installed" >&2; exit 1 ;;
    hard-fail) echo "herdr: backend exploded" >&2; exit 1 ;;
  esac
fi
if [ "\${1:-}" = "server" ]; then
  if [ "\${FAKE_RELOAD_FAIL:-0}" = "1" ]; then echo "herdr: no server running" >&2; exit 1; fi
  exit 0
fi
echo "herdr: unknown command $*" >&2
exit 1
`;

const STUB_CONFIGURE = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (process.env.CONFIGURE_LOG) fs.appendFileSync(process.env.CONFIGURE_LOG, args + '\\n');
if (process.env.ORDER_LOG) fs.appendFileSync(process.env.ORDER_LOG, 'configure ' + args + '\\n');
if (process.env.FAKE_CONFIGURE_FAIL === '1') {
  console.error('configure: stub failure');
  process.exit(1);
}
`;

const STUB_STATUS = `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const args = process.argv.slice(2).join(' ');
if (process.env.STATUS_LOG) fs.appendFileSync(process.env.STATUS_LOG, args + '\\n');
if (process.env.ORDER_LOG) fs.appendFileSync(process.env.ORDER_LOG, 'status ' + args + '\\n');
if (process.env.FAKE_STATUS_FAIL === '1') {
  console.error('gentle-status: stub failure');
  process.exit(1);
}
`;

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readLog(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function truncate(file) {
  fs.writeFileSync(file, '');
}

// Build an isolated fixture. opts: { listMode, fakeEnv, withSource,
// withConfigure, withStatus }. PI_AGENT_DIR is deliberately left unset so the
// installer default ($HOME/.pi/agent) is exercised.
function setup(t, opts = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-install-test-'));
  t.after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup of the temp fixture.
    }
  });
  const home = path.join(tmp, 'home');
  const stateBase = path.join(tmp, 'state');
  const fakeBin = path.join(tmp, 'fakebin');
  const pluginRoot = path.join(tmp, 'plugin-root');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stateBase, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  const herdrLog = path.join(tmp, 'herdr.log');
  const orderLog = path.join(tmp, 'order.log');
  const configureLog = path.join(tmp, 'configure.log');
  const statusLog = path.join(tmp, 'status.log');
  for (const f of [herdrLog, orderLog, configureLog, statusLog]) fs.writeFileSync(f, '');

  const herdrPath = path.join(fakeBin, 'herdr');
  fs.writeFileSync(herdrPath, FAKE_HERDR, { mode: 0o755 });

  const withSource = opts.withSource !== false;
  const withConfigure = opts.withConfigure !== false;
  const withStatus = opts.withStatus !== false;
  if (withSource) {
    assert.ok(fs.existsSync(REAL_EXTENSION), 'repo extension source must exist');
    fs.mkdirSync(path.join(pluginRoot, 'extensions'), { recursive: true });
    fs.copyFileSync(REAL_EXTENSION, path.join(pluginRoot, 'extensions', 'gentle-herdr-state.ts'));
  }
  if (withConfigure || withStatus) fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
  if (withConfigure) {
    fs.writeFileSync(path.join(pluginRoot, 'bin', 'configure.js'), STUB_CONFIGURE, { mode: 0o755 });
  }
  if (withStatus) {
    fs.writeFileSync(path.join(pluginRoot, 'bin', 'gentle-status.js'), STUB_STATUS, { mode: 0o755 });
  }

  const env = { ...process.env };
  delete env.PI_AGENT_DIR;
  delete env.HERDR_BIN_PATH;
  delete env.HERDR_GENTLE_PLUGIN_ROOT;
  delete env.FAKE_CONFIGURE_FAIL;
  delete env.FAKE_STATUS_FAIL;
  delete env.FAKE_UNINSTALL_MODE;
  delete env.FAKE_RELOAD_FAIL;
  delete env.FAKE_LIST_MODE;
  Object.assign(env, {
    HOME: home,
    XDG_STATE_HOME: stateBase,
    HERDR_CONFIG_PATH: path.join(tmp, 'herdr-config.toml'),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    HERDR_LOG: herdrLog,
    ORDER_LOG: orderLog,
    CONFIGURE_LOG: configureLog,
    STATUS_LOG: statusLog,
    FAKE_PLUGIN_ROOT: pluginRoot,
    FAKE_LIST_MODE: opts.listMode || 'valid',
  }, opts.fakeEnv || {});

  const piDir = path.join(home, '.pi', 'agent');
  const dest = path.join(piDir, 'extensions', 'gentle-herdr-state.ts');
  const stateFile = path.join(stateBase, 'herdr', 'plugins', 'herdr-gentle-agents', 'installer-state');
  return { tmp, home, stateBase, pluginRoot, env, herdrLog, orderLog, configureLog, statusLog, piDir, dest, stateFile };
}

function run(args, env) {
  return spawnSync('sh', [INSTALL_SH, ...args], { encoding: 'utf8', env });
}

function backupsBeside(dest) {
  const dir = path.dirname(dest);
  try {
    return fs.readdirSync(dir).filter((n) => n.startsWith(`${path.basename(dest)}.bak.`));
  } catch {
    return [];
  }
}

describe('install.sh isolated behavior', () => {
  it('sh -n syntax check passes', () => {
    const r = spawnSync('sh', ['-n', INSTALL_SH], { encoding: 'utf8' });
    assert.equal(r.status, 0, `sh -n failed: ${r.stderr}`);
  });

  it('--help exits zero and documents the pinned flow', (t) => {
    const fx = setup(t);
    const r = run(['--help'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--ref/);
    assert.match(r.stdout, /--uninstall/);
    assert.match(r.stdout, /v0\.1\.0/);
    assert.equal(readLog(fx.herdrLog), '', 'help must not call herdr');
  });

  it('fresh install copies bytes, records ownership, and pins default ref v0.1.0', (t) => {
    const fx = setup(t);
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.ok(fs.existsSync(fx.dest), 'managed extension must exist');
    assert.equal(
      fs.readFileSync(fx.dest, 'utf8'),
      fs.readFileSync(path.join(fx.pluginRoot, 'extensions', 'gentle-herdr-state.ts'), 'utf8'),
      'destination bytes must equal source bytes',
    );
    assert.equal(fs.readFileSync(fx.stateFile, 'utf8').trim(), sha256File(fx.dest));
    const log = readLog(fx.herdrLog);
    assert.match(log, /plugin install jonasotoaguilar\/herdr-gentle-agents --ref v0\.1\.0 --yes/);
    assert.match(log, /plugin enable herdr-gentle-agents/);
    assert.match(log, /server reload-config/);
    assert.doesNotMatch(log, /\bmain\b/);
    const order = readLog(fx.orderLog);
    assert.ok(order.indexOf('configure --apply') !== -1 && order.indexOf('configure --check') !== -1);
    assert.ok(order.indexOf('configure --apply') < order.indexOf('configure --check'));
    assert.match(readLog(fx.statusLog), /^$/m, 'daemon ensure is invoked with no args');
    assert.match(r.stdout, /\/reload/);
    assert.equal(backupsBeside(fx.dest).length, 0, 'fresh install creates no backup');
  });

  it('custom --ref is passed through to plugin install', (t) => {
    const fx = setup(t);
    const r = run(['--ref', 'v0.2.0'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readLog(fx.herdrLog), /--ref v0\.2\.0/);
  });

  it('repeated identical install is idempotent and creates no backup', (t) => {
    const fx = setup(t);
    assert.equal(run([], fx.env).status, 0);
    const before = sha256File(fx.dest);
    const r = run([], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(sha256File(fx.dest), before);
    assert.equal(backupsBeside(fx.dest).length, 0, 'identical reinstall must not back up');
  });

  it('conflicting unmanaged target is backed up before replace', (t) => {
    const fx = setup(t);
    fs.mkdirSync(path.dirname(fx.dest), { recursive: true });
    fs.writeFileSync(fx.dest, '// user-owned conflicting content\n');
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const backups = backupsBeside(fx.dest);
    assert.equal(backups.length, 1, `expected one backup, got ${backups}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(fx.dest), backups[0]), 'utf8'),
      '// user-owned conflicting content\n',
    );
    assert.equal(
      fs.readFileSync(fx.dest, 'utf8'),
      fs.readFileSync(path.join(fx.pluginRoot, 'extensions', 'gentle-herdr-state.ts'), 'utf8'),
    );
  });

  it('symlink destination is moved aside, never followed', (t) => {
    const fx = setup(t);
    const outside = path.join(fx.tmp, 'outside.txt');
    fs.writeFileSync(outside, 'outside target\n');
    fs.mkdirSync(path.dirname(fx.dest), { recursive: true });
    fs.symlinkSync(outside, fx.dest);
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.ok(!fs.lstatSync(fx.dest).isSymbolicLink(), 'destination must be a regular managed copy');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside target\n', 'link target untouched');
    assert.equal(backupsBeside(fx.dest).length, 1);
  });

  it('modified managed target is backed up on update', (t) => {
    const fx = setup(t);
    assert.equal(run([], fx.env).status, 0);
    fs.writeFileSync(fx.dest, '// locally modified after install\n');
    const r = run([], fx.env);
    assert.equal(r.status, 0, r.stderr);
    const backups = backupsBeside(fx.dest);
    assert.equal(backups.length, 1, `expected one backup, got ${backups}`);
    assert.equal(
      fs.readFileSync(path.join(path.dirname(fx.dest), backups[0]), 'utf8'),
      '// locally modified after install\n',
    );
    assert.equal(
      fs.readFileSync(fx.dest, 'utf8'),
      fs.readFileSync(path.join(fx.pluginRoot, 'extensions', 'gentle-herdr-state.ts'), 'utf8'),
    );
  });

  it('locally linked plugin refuses remote replacement before install', (t) => {
    const fx = setup(t, { listMode: 'local' });
    const r = run(['--ref', 'v0.1.0'], fx.env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /local/);
    assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
    assert.ok(!fs.existsSync(fx.dest), 'destination must not be created on refusal');
    assert.ok(!fs.existsSync(fx.stateFile), 'no ownership record on refusal');
  });

  it('absent-server reload warns but the install succeeds', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_RELOAD_FAIL: '1' } });
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stderr=${r.stderr}`);
    assert.match(r.stderr, /reload/);
    assert.ok(fs.existsSync(fx.dest));
  });

  it('uninstall removes the owned target with ordered cleanup', (t) => {
    const fx = setup(t);
    assert.equal(run([], fx.env).status, 0);
    for (const f of [fx.herdrLog, fx.orderLog, fx.configureLog, fx.statusLog]) truncate(f);
    const r = run(['--uninstall'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.ok(!fs.existsSync(fx.dest), 'owned extension must be removed');
    assert.ok(!fs.existsSync(fx.stateFile), 'installer state must be removed');
    assert.match(readLog(fx.configureLog), /--uninstall/);
    assert.match(readLog(fx.statusLog), /--stop --purge/);
    assert.match(readLog(fx.herdrLog), /plugin uninstall herdr-gentle-agents/);
    const order = readLog(fx.orderLog);
    const idx = (s) => order.indexOf(s);
    assert.ok(idx('configure --uninstall') !== -1, `order log:\n${order}`);
    assert.ok(idx('status --stop --purge') !== -1, `order log:\n${order}`);
    assert.ok(idx('herdr server reload-config') !== -1, `order log:\n${order}`);
    assert.ok(idx('herdr plugin uninstall') !== -1, `order log:\n${order}`);
    assert.ok(idx('configure --uninstall') < idx('status --stop --purge'));
    assert.ok(idx('status --stop --purge') < idx('herdr server reload-config'));
    assert.ok(idx('herdr server reload-config') < idx('herdr plugin uninstall'));
  });

  it('uninstall preserves a modified target but still uninstalls the plugin', (t) => {
    const fx = setup(t);
    assert.equal(run([], fx.env).status, 0);
    fs.writeFileSync(fx.dest, '// user-modified managed copy\n');
    const r = run(['--uninstall'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.equal(fs.readFileSync(fx.dest, 'utf8'), '// user-modified managed copy\n');
    assert.match(r.stderr, /preserv/);
    assert.ok(!fs.existsSync(fx.stateFile), 'state is removed after the ownership decision');
    assert.match(readLog(fx.herdrLog), /plugin uninstall herdr-gentle-agents/);
  });

  it('uninstall preserves the target when no ownership record exists', (t) => {
    const fx = setup(t);
    fs.mkdirSync(path.dirname(fx.dest), { recursive: true });
    fs.writeFileSync(fx.dest, '// foreign file, no record\n');
    const r = run(['--uninstall'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(fx.dest, 'utf8'), '// foreign file, no record\n');
    assert.match(r.stderr, /preserv/);
  });

  it('invalid refs are rejected before touching anything', (t) => {
    const bad = ['-v0.1.0', '--ref', 'has space', 'a;b', '$(x)', 'a`b`', 'a\nb'];
    for (const ref of bad) {
      const fx = setup(t);
      const args = ref === '--ref' ? ['--ref'] : [`--ref=${ref}`];
      // Empty-string case is covered separately below.
      const r = run(args, fx.env);
      assert.equal(r.status, 2, `ref ${JSON.stringify(ref)} must exit 2, got ${r.status}: ${r.stderr}`);
      assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
      assert.ok(!fs.existsSync(fx.dest), `ref ${JSON.stringify(ref)} must not create dest`);
    }
    const fx = setup(t);
    const r = run(['--ref', ''], fx.env);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(!fs.existsSync(fx.dest));
  });

  it('mutable ref main is rejected with no install and no state changes', (t) => {
    for (const args of [['--ref', 'main'], ['--ref=main']]) {
      const fx = setup(t);
      const r = run(args, fx.env);
      assert.equal(r.status, 2, `ref main (${args.join(' ')}) must exit 2, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /main.*mutable|mutable.*main|not allowed/i);
      assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
      assert.ok(!fs.existsSync(fx.dest), `ref main (${args.join(' ')}) must not create dest`);
      assert.ok(!fs.existsSync(fx.stateFile), `ref main (${args.join(' ')}) must not record state`);
    }
  });

  it('malformed and ambiguous plugin_root JSON fails closed', (t) => {
    for (const mode of ['malformed', 'multiple', 'relative', 'empty', 'missing-field']) {
      const fx = setup(t, { listMode: mode });
      const r = run([], fx.env);
      assert.notEqual(r.status, 0, `list mode ${mode} must fail`);
      assert.match(r.stderr, /plugin_root|plugin list|malformed|ambiguous|absolute|zero|no plugin_root/i,
        `mode ${mode}: ${r.stderr}`);
      assert.ok(!fs.existsSync(fx.dest), `mode ${mode} must not install dest`);
      assert.ok(!fs.existsSync(fx.stateFile), `mode ${mode} must not record state`);
    }
  });

  it('missing extension source fails visibly', (t) => {
    const fx = setup(t, { withSource: false });
    const r = run([], fx.env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /missing|source/i);
    assert.ok(!fs.existsSync(fx.dest));
  });

  it('missing configure script fails visibly without claiming success', (t) => {
    const fx = setup(t, { withConfigure: false });
    const r = run([], fx.env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /configure/i);
  });

  it('uninstall tolerates already-absent plugin only when classifiable', (t) => {
    const fx = setup(t);
    assert.equal(run([], fx.env).status, 0);
    const absentEnv = { ...fx.env, FAKE_UNINSTALL_MODE: 'absent' };
    const rAbsent = run(['--uninstall'], absentEnv);
    assert.equal(rAbsent.status, 0, `classifiable absent must succeed: ${rAbsent.stderr}`);

    const fx2 = setup(t);
    assert.equal(run([], fx2.env).status, 0);
    const hardEnv = { ...fx2.env, FAKE_UNINSTALL_MODE: 'hard-fail' };
    const rHard = run(['--uninstall'], hardEnv);
    assert.notEqual(rHard.status, 0, 'unclassifiable uninstall failure must fail visibly');
    assert.match(rHard.stderr, /uninstall failed|exploded/);
  });

  it('explicit plugin-root override must be absolute; absolute override bypasses lookup', (t) => {
    const fx = setup(t, { listMode: 'malformed' });
    const rel = run([], { ...fx.env, HERDR_GENTLE_PLUGIN_ROOT: 'relative/path' });
    assert.notEqual(rel.status, 0);
    assert.match(rel.stderr, /absolute/);

    const ok = run([], { ...fx.env, HERDR_GENTLE_PLUGIN_ROOT: fx.pluginRoot });
    assert.equal(ok.status, 0, `absolute override must bypass malformed list: ${ok.stderr}`);
    assert.ok(fs.existsSync(fx.dest));
  });

  it('touches nothing outside the temp fixture', (t) => {
    const fx = setup(t);
    const canary = path.join(os.tmpdir(), `herdr-install-canary-${process.pid}.txt`);
    fs.writeFileSync(canary, 'canary\n');
    t.after(() => {
      try {
        fs.rmSync(canary, { force: true });
      } catch {
        // Best-effort canary cleanup.
      }
    });
    const repoHashBefore = sha256File(REAL_EXTENSION);
    assert.ok(fx.env.HOME.startsWith(fx.tmp), 'HOME must be inside the fixture');
    assert.ok(fx.dest.startsWith(fx.tmp), 'destination must be inside the fixture');
    assert.ok(fx.stateFile.startsWith(fx.tmp), 'state file must be inside the fixture');
    const r = run([], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(canary, 'utf8'), 'canary\n', 'sibling temp file untouched');
    assert.equal(sha256File(REAL_EXTENSION), repoHashBefore, 'repo source untouched');
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'installer-state')), 'no state leaked into repo');
  });
});
