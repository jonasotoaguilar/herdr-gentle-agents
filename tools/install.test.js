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
const REAL_HELPER = path.join(REPO_ROOT, 'lib', 'pi-extension-exclusion.js');
const EXCLUSION_ENTRY = '-extensions/herdr-agent-state.ts';
const NATIVE_BASE = 'herdr-agent-state.ts';

const FAKE_HERDR = `#!/bin/sh
# Fake herdr for install.sh tests: logs argv, replays canned plugin-list JSON.
log="\${HERDR_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
if [ -n "\${ORDER_LOG:-}" ]; then printf 'herdr %s\\n' "$*" >>"$ORDER_LOG"; fi
if [ "\${1:-}" = "plugin" ] && [ "\${2:-}" = "list" ]; then
  mode="\${FAKE_LIST_MODE:-valid}"
  root="\${FAKE_PLUGIN_ROOT:-/nonexistent}"
  ver="\${FAKE_PLUGIN_VERSION:-}"
  if [ -n "$ver" ]; then
    vfrag=',"version":"'"$ver"'"'
  else
    vfrag=""
  fi
  case "$mode" in
    valid)
      printf '{"result":{"plugins":[{"plugin_id":"herdr-gentle-agents","plugin_root":"%s","source":{"kind":"remote"}%s}]}}\\n' "$root" "$vfrag"
      exit 0 ;;
    local)
      printf '{"result":{"plugins":[{"plugin_id":"herdr-gentle-agents","plugin_root":"%s","source":{"kind":"local"}%s}]}}\\n' "$root" "$vfrag"
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
if [ "\${1:-}" = "plugin" ] && [ "\${2:-}" = "unlink" ]; then exit 0; fi
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

const FAKE_CURL = `#!/bin/sh
# Fake curl for install.sh tests: logs argv, replays canned release-latest JSON.
log="\${CURL_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
mode="\${FAKE_CURL_MODE:-ok}"
tag="\${FAKE_LATEST_TAG:-v0.2.0}"
if [ "$mode" = "fail" ]; then echo "curl: stub failure" >&2; exit 1; fi
if [ "$mode" = "spaced" ]; then printf '{ "tag_name" : "%s" }\\n' "$tag"; exit 0; fi
printf '{"tag_name":"%s","prerelease":false,"draft":false}\\n' "$tag"
exit 0
`;

const FAKE_GIT = `#!/bin/sh
# Fake git for install.sh tests: logs argv, replays canned ls-remote tags.
log="\${GIT_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
if [ "\${1:-}" = "ls-remote" ]; then
  mode="\${FAKE_GIT_MODE:-fail}"
  if [ "$mode" = "fail" ]; then echo "git: stub ls-remote failure" >&2; exit 1; fi
  for t in \${FAKE_GIT_TAGS:-v0.2.0}; do
    printf '0000000000000000000000000000000000000000\\trefs/tags/%s\\n' "$t"
  done
  exit 0
fi
exec "__REAL_GIT__" "$@"
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
  const curlLog = path.join(tmp, 'curl.log');
  const gitLog = path.join(tmp, 'git.log');
  for (const f of [herdrLog, orderLog, configureLog, statusLog, curlLog, gitLog]) fs.writeFileSync(f, '');

  const herdrPath = path.join(fakeBin, 'herdr');
  fs.writeFileSync(herdrPath, FAKE_HERDR, { mode: 0o755 });

  // Fake curl replays the releases/latest JSON without network; fake git
  // replays ls-remote tags (default: failure, so no network is ever hit).
  fs.writeFileSync(path.join(fakeBin, 'curl'), FAKE_CURL, { mode: 0o755 });
  let realGit = '/usr/bin/git';
  try {
    const found = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
    if (found) realGit = found;
  } catch {
    // Fall back to /usr/bin/git for non-ls-remote delegation.
  }
  fs.writeFileSync(path.join(fakeBin, 'git'), FAKE_GIT.split('__REAL_GIT__').join(realGit), { mode: 0o755 });

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
  if (fs.existsSync(REAL_HELPER)) {
    fs.mkdirSync(path.join(pluginRoot, 'lib'), { recursive: true });
    fs.copyFileSync(REAL_HELPER, path.join(pluginRoot, 'lib', 'pi-extension-exclusion.js'));
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
  delete env.FAKE_PLUGIN_VERSION;
  delete env.FAKE_CURL_MODE;
  delete env.FAKE_LATEST_TAG;
  delete env.FAKE_GIT_MODE;
  delete env.FAKE_GIT_TAGS;
  delete env.CURL_LOG;
  delete env.GIT_LOG;
  delete env.HERDR_GENTLE_LATEST_URL;
  Object.assign(env, {
    HOME: home,
    XDG_STATE_HOME: stateBase,
    HERDR_CONFIG_PATH: path.join(tmp, 'herdr-config.toml'),
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    HERDR_LOG: herdrLog,
    ORDER_LOG: orderLog,
    CONFIGURE_LOG: configureLog,
    STATUS_LOG: statusLog,
    CURL_LOG: curlLog,
    GIT_LOG: gitLog,
    HERDR_GENTLE_LATEST_URL: 'https://example.invalid/releases/latest',
    FAKE_LATEST_TAG: 'v0.2.0',
    FAKE_CURL_MODE: 'ok',
    FAKE_GIT_MODE: 'fail',
    FAKE_PLUGIN_ROOT: pluginRoot,
    FAKE_LIST_MODE: opts.listMode || 'valid',
  }, opts.fakeEnv || {});

  const piDir = path.join(home, '.pi', 'agent');
  const dest = path.join(piDir, 'extensions', 'gentle-herdr-state.ts');
  const stateFile = path.join(stateBase, 'herdr', 'plugins', 'herdr-gentle-agents', 'installer-state');
  const settingsFile = path.join(piDir, 'settings.json');
  const exclusionMarker = path.join(stateBase, 'herdr', 'plugins', 'herdr-gentle-agents', 'pi-extension-exclusion-owned');
  return { tmp, home, stateBase, pluginRoot, env, herdrLog, orderLog, configureLog, statusLog, curlLog, gitLog, piDir, dest, stateFile, settingsFile, exclusionMarker };
}

function run(args, env) {
  return spawnSync('sh', [INSTALL_SH, ...args], { encoding: 'utf8', env });
}

function readSettingsJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function plantSettings(fx, obj) {
  fs.mkdirSync(path.dirname(fx.settingsFile), { recursive: true });
  fs.writeFileSync(fx.settingsFile, `${JSON.stringify(obj, null, 2)}\n`);
}

function nativeBasePath(fx) {
  return path.join(path.dirname(fx.dest), NATIVE_BASE);
}

function plantNativeBase(fx, content = '// native managed base\n') {
  fs.mkdirSync(path.dirname(fx.dest), { recursive: true });
  fs.writeFileSync(nativeBasePath(fx), content);
  return content;
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

  it('--help exits zero and documents the update contract', (t) => {
    const fx = setup(t);
    const r = run(['--help'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--ref/);
    assert.match(r.stdout, /--allow-downgrade/);
    assert.match(r.stdout, /--force/);
    assert.match(r.stdout, /deprecat/i);
    assert.match(r.stdout, /--uninstall/);
    assert.match(r.stdout, /HERDR_GENTLE_LATEST_URL/);
    assert.doesNotMatch(r.stdout, /default: v0\.1\.0/);
    assert.equal(readLog(fx.herdrLog), '', 'help must not call herdr');
  });

  it('fresh install without --ref resolves the newest release tag', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_LATEST_TAG: 'v0.2.0' } });
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
    assert.match(log, /plugin install jonasotoaguilar\/herdr-gentle-agents --ref v0\.2\.0 --yes/);
    assert.match(readLog(fx.curlLog), /example\.invalid/, 'latest resolution must run without network');
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

  it('locally linked plugin is replaced automatically without --force', (t) => {
    const fx = setup(t, { listMode: 'local' });
    const r = run(['--ref', 'v0.1.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const log = readLog(fx.herdrLog);
    assert.match(log, /plugin unlink herdr-gentle-agents/);
    assert.match(log, /plugin install jonasotoaguilar\/herdr-gentle-agents --ref v0\.1\.0 --yes/);
    assert.ok(log.indexOf('plugin unlink') < log.indexOf('plugin install'), 'unlink must precede install');
    const out = `${r.stdout}\n${r.stderr}`;
    assert.match(out, /herdr-gentle-agents/, 'warning names the plugin id');
    assert.match(out, /herdr plugin link/, 'warning names the re-link command');
    assert.ok(!out.includes('refusing remote install'), 'the S6 refusal text must never appear');
    assert.ok(fs.existsSync(fx.dest), 'managed extension must exist after replacement');
    assert.equal(fs.readFileSync(fx.stateFile, 'utf8').trim(), sha256File(fx.dest));
  });

  it('local replacement warning never prints the old refusal text', (t) => {
    for (const args of [['--ref', 'v0.1.0'], ['--force', '--ref', 'v0.1.0']]) {
      const fx = setup(t, { listMode: 'local' });
      const r = run(args, fx.env);
      assert.equal(r.status, 0, `args ${args.join(' ')}: ${r.stderr}`);
      const out = `${r.stdout}\n${r.stderr}`;
      assert.ok(
        !out.includes('refusing remote install: plugin herdr-gentle-agents is locally linked (source.kind=local). Unlink it first or install locally; nothing was changed.'),
        `S6 refusal bytes must be gone (args ${args.join(' ')}): ${out}`,
      );
    }
  });

  it('--force unlinks a locally linked plugin then installs', (t) => {
    const fx = setup(t, { listMode: 'local' });
    const r = run(['--force', '--ref', 'v0.1.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const log = readLog(fx.herdrLog);
    assert.match(log, /plugin unlink herdr-gentle-agents/);
    assert.match(log, /plugin install jonasotoaguilar\/herdr-gentle-agents --ref v0\.1\.0 --yes/);
    assert.ok(log.indexOf('plugin unlink') < log.indexOf('plugin install'), 'unlink must precede install');
    assert.match(`${r.stdout}\n${r.stderr}`, /removed.*local/i);
    assert.ok(fs.existsSync(fx.dest), 'managed extension must exist after forced update');
    assert.equal(fs.readFileSync(fx.stateFile, 'utf8').trim(), sha256File(fx.dest));
  });

  it('--force with a remote source installs without unlink', (t) => {
    const fx = setup(t);
    const r = run(['--force'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const log = readLog(fx.herdrLog);
    assert.doesNotMatch(log, /plugin unlink/);
    assert.match(log, /plugin install jonasotoaguilar\/herdr-gentle-agents/);
    assert.ok(fs.existsSync(fx.dest));
  });

  it('--help marks --force as a deprecated no-op', (t) => {
    const fx = setup(t);
    const r = run(['--help'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--force/);
    assert.match(r.stdout, /deprecat/i);
    assert.equal(readLog(fx.herdrLog), '', 'help must not call herdr');
  });

  it('--force still exits 0 as a deprecated no-op', (t) => {
    const fx = setup(t);
    const r = run(['--force', '--ref', 'v0.2.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /deprecat/i);
    assert.ok(fs.existsSync(fx.dest));
  });

  it('omitted --ref uses the tag from HERDR_GENTLE_LATEST_URL', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_LATEST_TAG: 'v9.8.7' } });
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.herdrLog), /plugin install jonasotoaguilar\/herdr-gentle-agents --ref v9\.8\.7 --yes/);
    assert.match(readLog(fx.curlLog), /example\.invalid/);
  });

  it('spaced tag_name JSON still resolves without jq', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_MODE: 'spaced', FAKE_LATEST_TAG: 'v1.2.3' } });
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.herdrLog), /--ref v1\.2\.3/);
  });

  it('git ls-remote fallback resolves the newest tag when curl fails', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_MODE: 'fail', FAKE_GIT_MODE: 'ok', FAKE_GIT_TAGS: 'v0.1.0 v0.3.0 v0.2.0' } });
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.herdrLog), /plugin install jonasotoaguilar\/herdr-gentle-agents --ref v0\.3\.0 --yes/);
    assert.ok(fs.existsSync(fx.dest));
  });

  it('unresolvable latest fails closed naming --ref', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_MODE: 'fail', FAKE_GIT_MODE: 'fail' } });
    const r = run([], fx.env);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /--ref/);
    assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
    assert.ok(!fs.existsSync(fx.dest), 'nothing must be installed on resolution failure');
    assert.ok(!fs.existsSync(fx.stateFile), 'no ownership record on resolution failure');
  });

  it('explicit --ref equal to a clean installed version is a no-op with zero mutation', (t) => {
    const fx = setup(t);
    assert.equal(run(['--ref', 'v0.2.0'], fx.env).status, 0);
    const destBefore = fs.readFileSync(fx.dest);
    const settingsBefore = fs.readFileSync(fx.settingsFile, 'utf8');
    const past = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(fx.settingsFile, past, past);
    for (const f of [fx.herdrLog, fx.orderLog, fx.configureLog, fx.statusLog]) truncate(f);
    const r = run(['--ref', 'v0.2.0'], { ...fx.env, FAKE_PLUGIN_VERSION: 'v0.2.0' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /install\.sh: already up to date \(v0\.2\.0\)/);
    const log = readLog(fx.herdrLog);
    assert.doesNotMatch(log, /plugin install/);
    assert.doesNotMatch(log, /plugin enable/);
    assert.doesNotMatch(log, /plugin unlink/);
    assert.doesNotMatch(log, /server reload-config/);
    assert.ok(destBefore.equals(fs.readFileSync(fx.dest)), 'managed copy must be byte-identical');
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), settingsBefore, 'settings file must not be written');
    assert.equal(fs.statSync(fx.settingsFile).mtimeMs, past.getTime(), 'settings mtime must be untouched');
    assert.equal(readLog(fx.configureLog), '', 'configure must not run on no-op');
    assert.equal(readLog(fx.statusLog), '', 'daemon status must not run on no-op');
    assert.equal(backupsBeside(fx.dest).length, 0, 'no-op creates no backup');
  });

  it('omitted --ref matching the installed version is a no-op', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_LATEST_TAG: 'v0.2.0' } });
    assert.equal(run([], fx.env).status, 0);
    for (const f of [fx.herdrLog, fx.configureLog, fx.statusLog]) truncate(f);
    const r = run([], { ...fx.env, FAKE_PLUGIN_VERSION: 'v0.2.0' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /already up to date \(v0\.2\.0\)/);
    assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
    assert.equal(readLog(fx.configureLog), '', 'configure must not run on no-op');
  });

  it('drifted managed copy repairs instead of reporting current', (t) => {
    const fx = setup(t);
    assert.equal(run(['--ref', 'v0.2.0'], fx.env).status, 0);
    fs.writeFileSync(fx.dest, '// drifted content\n');
    const r = run(['--ref', 'v0.2.0'], { ...fx.env, FAKE_PLUGIN_VERSION: 'v0.2.0' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /already up to date/);
    assert.equal(
      fs.readFileSync(fx.dest, 'utf8'),
      fs.readFileSync(path.join(fx.pluginRoot, 'extensions', 'gentle-herdr-state.ts'), 'utf8'),
      'drifted copy must be repaired from the plugin source',
    );
    assert.equal(backupsBeside(fx.dest).length, 1, 'drift repair backs up the drifted copy');
  });

  it('installed version greater than the target aborts naming both versions and --allow-downgrade', (t) => {
    const fx = setup(t);
    const r = run(['--ref', 'v0.2.0'], { ...fx.env, FAKE_PLUGIN_VERSION: 'v0.3.0' });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /v0\.3\.0/);
    assert.match(r.stderr, /v0\.2\.0/);
    assert.match(r.stderr, /--allow-downgrade/);
    assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
    assert.ok(!fs.existsSync(fx.dest), 'aborted downgrade must not install');
  });

  it('--allow-downgrade proceeds when the installed version is newer', (t) => {
    const fx = setup(t);
    const r = run(['--ref', 'v0.2.0', '--allow-downgrade'], { ...fx.env, FAKE_PLUGIN_VERSION: 'v0.3.0' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.herdrLog), /plugin install jonasotoaguilar\/herdr-gentle-agents --ref v0\.2\.0 --yes/);
    assert.ok(fs.existsSync(fx.dest));
  });

  it('version comparison is numeric across minor segments', (t) => {
    const fx = setup(t);
    const lower = run(['--ref', 'v0.10.0'], { ...fx.env, FAKE_PLUGIN_VERSION: 'v0.9.0' });
    assert.equal(lower.status, 0, `lower installed must proceed: ${lower.stderr}`);
    assert.match(readLog(fx.herdrLog), /--ref v0\.10\.0/);
    const fx2 = setup(t);
    const higher = run(['--ref', 'v0.9.0'], { ...fx2.env, FAKE_PLUGIN_VERSION: 'v0.10.0' });
    assert.equal(higher.status, 1, `higher installed must abort: ${higher.stderr}`);
    assert.match(higher.stderr, /--allow-downgrade/);
  });

  it('missing or non-numeric installed version proceeds and never aborts', (t) => {
    for (const ver of [null, 'not-a-version', '']) {
      const fx = setup(t);
      const env = { ...fx.env };
      if (ver === null) delete env.FAKE_PLUGIN_VERSION;
      else env.FAKE_PLUGIN_VERSION = ver;
      const r = run(['--ref', 'v0.0.1'], env);
      assert.equal(r.status, 0, `version ${JSON.stringify(ver)} must proceed: ${r.stderr}`);
      assert.match(readLog(fx.herdrLog), /plugin install/);
      assert.ok(fs.existsSync(fx.dest));
    }
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

  it('install records the native exclusion while preserving unrelated settings', (t) => {
    const fx = setup(t);
    plantSettings(fx, { theme: 'Gentleman-Cute', extensions: ['-builtin:codemode', 'extensions/custom.ts'] });
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const doc = readSettingsJson(fx.settingsFile);
    assert.deepEqual(doc.extensions, ['-builtin:codemode', 'extensions/custom.ts', EXCLUSION_ENTRY]);
    assert.equal(doc.theme, 'Gentleman-Cute');
    assert.ok(fs.existsSync(fx.exclusionMarker), 'ownership marker must exist');
    assert.match(`${r.stdout}\n${r.stderr}`, /reload/i);
  });

  it('repeated install leaves the exclusion singular and settings bytes stable', (t) => {
    const fx = setup(t);
    plantSettings(fx, { extensions: [] });
    assert.equal(run([], fx.env).status, 0);
    const once = fs.readFileSync(fx.settingsFile, 'utf8');
    const r = run([], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), once, 'identical reinstall must not rewrite settings');
    assert.equal(readSettingsJson(fx.settingsFile).extensions.filter((e) => e === EXCLUSION_ENTRY).length, 1);
  });

  it('preexisting exclusion is preserved without taking ownership', (t) => {
    const fx = setup(t);
    plantSettings(fx, { extensions: [EXCLUSION_ENTRY] });
    assert.equal(run([], fx.env).status, 0);
    assert.ok(!fs.existsSync(fx.exclusionMarker), 'preexisting entry must not gain a marker');
    const r = run(['--uninstall'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(readSettingsJson(fx.settingsFile).extensions, [EXCLUSION_ENTRY]);
  });

  it('native base file bytes are retained across install and update', (t) => {
    const fx = setup(t);
    const content = plantNativeBase(fx, '// native base v1\n');
    assert.equal(run([], fx.env).status, 0);
    assert.equal(fs.readFileSync(nativeBasePath(fx), 'utf8'), content, 'install must not touch the base file');
    // Simulate Herdr recreating the base file, then update.
    fs.writeFileSync(nativeBasePath(fx), content);
    assert.equal(run([], fx.env).status, 0);
    assert.equal(fs.readFileSync(nativeBasePath(fx), 'utf8'), content, 'update must not touch the recreated base');
    assert.ok(readSettingsJson(fx.settingsFile).extensions.includes(EXCLUSION_ENTRY));
  });

  it('uninstall removes only the owned exclusion and preserves user edits', (t) => {
    const fx = setup(t);
    plantSettings(fx, { theme: 'x', extensions: ['-builtin:codemode'] });
    assert.equal(run([], fx.env).status, 0);
    // User edits after install.
    const mid = readSettingsJson(fx.settingsFile);
    mid.quietStartup = true;
    fs.writeFileSync(fx.settingsFile, `${JSON.stringify(mid, null, 2)}\n`);
    const r = run(['--uninstall'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const doc = readSettingsJson(fx.settingsFile);
    assert.deepEqual(doc.extensions, ['-builtin:codemode']);
    assert.equal(doc.quietStartup, true);
    assert.equal(doc.theme, 'x');
    assert.ok(!fs.existsSync(fx.exclusionMarker), 'marker must be cleaned up');
  });

  it('invalid settings fail closed on install without destructive replacement', (t) => {
    const cases = [
      ['malformed-json', '{not json'],
      ['non-array', JSON.stringify({ extensions: 'nope' })],
      ['non-string-entry', JSON.stringify({ extensions: [42] })],
      ['top-level-array', JSON.stringify([EXCLUSION_ENTRY])],
    ];
    for (const [name, raw] of cases) {
      const fx = setup(t);
      fs.mkdirSync(path.dirname(fx.settingsFile), { recursive: true });
      fs.writeFileSync(fx.settingsFile, raw);
      const r = run([], fx.env);
      assert.notEqual(r.status, 0, `${name} must fail`);
      assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), raw, `${name}: settings bytes must be untouched`);
      assert.match(r.stderr, /exclusion|settings/i, `${name}: ${r.stderr}`);
    }
  });

  it('PI_AGENT_DIR override scopes the exclusion to the override dir', (t) => {
    const fx = setup(t);
    const custom = path.join(fx.tmp, 'custom-agent');
    const r = run([], { ...fx.env, PI_AGENT_DIR: custom });
    assert.equal(r.status, 0, r.stderr);
    const doc = JSON.parse(fs.readFileSync(path.join(custom, 'settings.json'), 'utf8'));
    assert.ok(doc.extensions.includes(EXCLUSION_ENTRY));
    assert.ok(!fs.existsSync(fx.settingsFile), 'default location must stay untouched');
  });

  it('missing settings file is created with only the exclusion; uninstall leaves valid JSON', (t) => {
    const fx = setup(t);
    assert.ok(!fs.existsSync(fx.settingsFile));
    assert.equal(run([], fx.env).status, 0);
    assert.deepEqual(readSettingsJson(fx.settingsFile).extensions, [EXCLUSION_ENTRY]);
    assert.equal(run(['--uninstall'], fx.env).status, 0);
    const doc = readSettingsJson(fx.settingsFile);
    assert.ok(!JSON.stringify(doc).includes(EXCLUSION_ENTRY));
  });

  it('uninstall with invalid settings preserves the file and still uninstalls', (t) => {
    const fx = setup(t);
    assert.equal(run([], fx.env).status, 0);
    const raw = '{broken json';
    fs.writeFileSync(fx.settingsFile, raw);
    const r = run(['--uninstall'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), raw, 'invalid settings must be preserved');
    assert.match(r.stderr, /preserv/i);
    assert.match(readLog(fx.herdrLog), /plugin uninstall herdr-gentle-agents/);
  });

  it('symlinked settings.json stays a symlink and is updated through the link', (t) => {
    const fx = setup(t);
    const target = path.join(fx.tmp, 'linked-settings.json');
    fs.writeFileSync(target, `${JSON.stringify({ extensions: [] })}\n`);
    fs.mkdirSync(path.dirname(fx.settingsFile), { recursive: true });
    fs.symlinkSync(target, fx.settingsFile);
    assert.equal(run([], fx.env).status, 0);
    assert.ok(fs.lstatSync(fx.settingsFile).isSymbolicLink(), 'symlink must survive install');
    assert.ok(JSON.parse(fs.readFileSync(target, 'utf8')).extensions.includes(EXCLUSION_ENTRY));
    assert.equal(run(['--uninstall'], fx.env).status, 0);
    assert.ok(fs.lstatSync(fx.settingsFile).isSymbolicLink(), 'symlink must survive uninstall');
    const after = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.ok(!(after.extensions ?? []).includes(EXCLUSION_ENTRY));
  });

  it('foreign or invalid ownership record never removes a user entry', (t) => {
    const variants = [
      ['garbage-content', 'not-the-entry\n'],
      ['wrong-entry', `${JSON.stringify({ version: 1, entry: '-extensions/other.ts', settings: '/elsewhere/settings.json' })}\n`],
      ['wrong-version', `${JSON.stringify({ version: 99, entry: EXCLUSION_ENTRY, settings: '/elsewhere/settings.json' })}\n`],
    ];
    for (const [name, markerContent] of variants) {
      const fx = setup(t);
      plantSettings(fx, { extensions: [EXCLUSION_ENTRY] });
      assert.equal(run([], fx.env).status, 0, `${name}: install must succeed`);
      const before = fs.readFileSync(fx.settingsFile, 'utf8');
      fs.mkdirSync(path.dirname(fx.exclusionMarker), { recursive: true });
      fs.writeFileSync(fx.exclusionMarker, markerContent);
      const r = run(['--uninstall'], fx.env);
      assert.equal(r.status, 0, `${name}: uninstall must still succeed, got: ${r.stderr}`);
      assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), before, `${name}: user entry must survive byte-identical`);
      assert.ok(readSettingsJson(fx.settingsFile).extensions.includes(EXCLUSION_ENTRY), name);
    }
  });

  it('ownership record bound to another settings file authorizes nothing', (t) => {
    const fx = setup(t);
    plantSettings(fx, { extensions: [EXCLUSION_ENTRY] });
    assert.equal(run([], fx.env).status, 0);
    const before = fs.readFileSync(fx.settingsFile, 'utf8');
    const foreign = { version: 1, entry: EXCLUSION_ENTRY, settings: '/elsewhere/settings.json' };
    fs.mkdirSync(path.dirname(fx.exclusionMarker), { recursive: true });
    fs.writeFileSync(fx.exclusionMarker, `${JSON.stringify(foreign)}\n`);
    const r = run(['--uninstall'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), before, 'entry bound elsewhere must survive byte-identical');
  });

  it('marker creation failure leaves settings byte-identical and copies nothing', (t) => {
    const fx = setup(t);
    plantSettings(fx, { theme: 'keep', extensions: [] });
    const before = fs.readFileSync(fx.settingsFile, 'utf8');
    // Break marker creation only: the marker parent is unreadable for
    // writing, so the settings write succeeds but ownership cannot record.
    fs.mkdirSync(path.dirname(fx.exclusionMarker), { recursive: true });
    fs.chmodSync(path.dirname(fx.exclusionMarker), 0o555);
    t.after(() => {
      try {
        fs.chmodSync(path.dirname(fx.exclusionMarker), 0o755);
      } catch {
        // Best-effort permission restore for fixture cleanup.
      }
    });
    const r = run([], fx.env);
    assert.notEqual(r.status, 0, 'install must fail when ownership cannot be recorded');
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), before, 'settings must be byte-identical');
    assert.ok(!fs.existsSync(fx.dest), 'managed replacement must never be copied');
    assert.doesNotMatch(r.stderr, /left untouched/i, `must not overclaim: ${r.stderr}`);
    assert.match(r.stderr, /cannot record ownership/i, `must report the marker failure: ${r.stderr}`);
  });

  it('leading BOM is accepted like Pi', (t) => {
    const fx = setup(t);
    fs.mkdirSync(path.dirname(fx.settingsFile), { recursive: true });
    fs.writeFileSync(fx.settingsFile, '\uFEFF' + JSON.stringify({ extensions: [] }));
    const r = run([], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(readSettingsJson(fx.settingsFile).extensions.includes(EXCLUSION_ENTRY));
  });

  it('0600 settings mode survives install and uninstall', (t) => {
    const fx = setup(t);
    plantSettings(fx, { extensions: [] });
    fs.chmodSync(fx.settingsFile, 0o600);
    assert.equal(run([], fx.env).status, 0);
    assert.equal(fs.statSync(fx.settingsFile).mode & 0o777, 0o600, 'install must preserve 0600');
    assert.equal(run(['--uninstall'], fx.env).status, 0);
    assert.equal(fs.statSync(fx.settingsFile).mode & 0o777, 0o600, 'uninstall must preserve 0600');
  });

  it('0600 target behind a symlink keeps mode and link', (t) => {
    const fx = setup(t);
    const target = path.join(fx.tmp, '0600-settings.json');
    fs.writeFileSync(target, `${JSON.stringify({ extensions: [] })}\n`, { mode: 0o600 });
    fs.chmodSync(target, 0o600);
    fs.mkdirSync(path.dirname(fx.settingsFile), { recursive: true });
    fs.symlinkSync(target, fx.settingsFile);
    assert.equal(run([], fx.env).status, 0);
    assert.ok(fs.lstatSync(fx.settingsFile).isSymbolicLink(), 'link must survive install');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600, 'install must preserve 0600 through the link');
    assert.ok(JSON.parse(fs.readFileSync(target, 'utf8')).extensions.includes(EXCLUSION_ENTRY));
    assert.equal(run(['--uninstall'], fx.env).status, 0);
    assert.ok(fs.lstatSync(fx.settingsFile).isSymbolicLink(), 'link must survive uninstall');
    assert.equal(fs.statSync(target).mode & 0o777, 0o600, 'uninstall must preserve 0600 through the link');
  });

  it('stale temp files are never clobbered and none are left behind', (t) => {
    const fx = setup(t);
    plantSettings(fx, { extensions: [] });
    const dir = path.dirname(fx.settingsFile);
    const sentinel = path.join(dir, '.settings.json.tmp.99999');
    fs.writeFileSync(sentinel, 'sentinel\n');
    assert.equal(run([], fx.env).status, 0);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel\n', 'foreign temp file must survive');
    assert.deepEqual(fs.readdirSync(dir).filter((n) => n.includes('.tmp.')), ['.settings.json.tmp.99999']);
    assert.equal(run(['--uninstall'], fx.env).status, 0);
    assert.equal(fs.readFileSync(sentinel, 'utf8'), 'sentinel\n');
  });

  it('copy failure after exclusion rolls the exclusion back', (t) => {
    const fx = setup(t);
    plantSettings(fx, { theme: 'keep', extensions: ['-builtin:codemode'] });
    fs.mkdirSync(path.dirname(fx.dest), { recursive: true });
    fs.writeFileSync(fx.dest, '// user content\n');
    fs.chmodSync(path.dirname(fx.dest), 0o555);
    t.after(() => {
      try {
        fs.chmodSync(path.dirname(fx.dest), 0o755);
      } catch {
        // Best-effort permission restore for fixture cleanup.
      }
    });
    const r = run([], fx.env);
    assert.notEqual(r.status, 0, 'install must fail when the copy cannot be staged');
    const doc = readSettingsJson(fx.settingsFile);
    assert.ok(!(doc.extensions ?? []).includes(EXCLUSION_ENTRY), 'exclusion must be rolled back');
    assert.deepEqual(doc.extensions, ['-builtin:codemode']);
    assert.equal(doc.theme, 'keep');
    assert.equal(fs.readFileSync(fx.dest, 'utf8'), '// user content\n', 'user dest untouched');
    assert.ok(!fs.existsSync(fx.exclusionMarker), 'no misleading ownership may remain');
    assert.match(`${r.stdout}\n${r.stderr}`, /roll/i);
  });

  it('configure failure after copy rolls the exclusion back and says the copy stays', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CONFIGURE_FAIL: '1' } });
    plantSettings(fx, { extensions: [] });
    const r = run([], fx.env);
    assert.notEqual(r.status, 0, 'install must fail when configure fails');
    const doc = readSettingsJson(fx.settingsFile);
    assert.ok(!(doc.extensions ?? []).includes(EXCLUSION_ENTRY), 'exclusion must be rolled back');
    assert.ok(fs.existsSync(fx.dest), 'managed copy stays; re-run install to converge');
    assert.ok(!fs.existsSync(fx.exclusionMarker), 'no misleading ownership may remain');
    assert.match(`${r.stdout}\n${r.stderr}`, /roll/i);
  });

  it('second agent dir sharing state cannot orphan first ownership', (t) => {
    const fx = setup(t);
    plantSettings(fx, { theme: 'a', extensions: [] });
    assert.equal(run([], fx.env).status, 0, 'A install must succeed');
    const markerBefore = fs.readFileSync(fx.exclusionMarker, 'utf8');
    const settingsABefore = fs.readFileSync(fx.settingsFile, 'utf8');

    const dirB = path.join(fx.tmp, 'agent-b');
    fs.mkdirSync(dirB, { recursive: true });
    const settingsB = path.join(dirB, 'settings.json');
    const settingsBBefore = `${JSON.stringify({ theme: 'b', extensions: [] })}\n`;
    fs.writeFileSync(settingsB, settingsBBefore);
    const rB = run([], { ...fx.env, PI_AGENT_DIR: dirB });
    assert.notEqual(rB.status, 0, 'B install must fail closed on conflicting ownership');
    assert.match(rB.stderr, /bound to/i, `must name the binding: ${rB.stderr}`);
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), settingsABefore, 'A settings untouched');
    assert.equal(fs.readFileSync(settingsB, 'utf8'), settingsBBefore, 'B settings untouched');
    assert.equal(fs.readFileSync(fx.exclusionMarker, 'utf8'), markerBefore, 'marker untouched');
    assert.ok(!fs.existsSync(path.join(dirB, 'extensions', 'gentle-herdr-state.ts')), 'B copy must never happen');

    const rA = run(['--uninstall'], fx.env);
    assert.equal(rA.status, 0, `A uninstall must still work: ${rA.stderr}`);
    assert.ok(!(readSettingsJson(fx.settingsFile).extensions ?? []).includes(EXCLUSION_ENTRY), 'A entry removed');
    assert.ok(!fs.existsSync(fx.exclusionMarker), 'marker cleaned');
  });

  it('foreign ensure marker stays byte-identical without settings mutation', (t) => {
    const fx = setup(t);
    plantSettings(fx, { extensions: [] });
    const settingsBefore = fs.readFileSync(fx.settingsFile, 'utf8');
    fs.mkdirSync(path.dirname(fx.exclusionMarker), { recursive: true });
    fs.writeFileSync(fx.exclusionMarker, 'not-the-entry\n');
    const markerBefore = fs.readFileSync(fx.exclusionMarker, 'utf8');
    const r = run([], fx.env);
    assert.notEqual(r.status, 0, 'install must fail closed on a foreign record');
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), settingsBefore, 'settings untouched');
    assert.equal(fs.readFileSync(fx.exclusionMarker, 'utf8'), markerBefore, 'foreign marker untouched');
    assert.match(r.stderr, /foreign or invalid/i, `must name the cause: ${r.stderr}`);
  });

  it('git fallback version-sorts and ignores prereleases', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_MODE: 'fail', FAKE_GIT_MODE: 'ok', FAKE_GIT_TAGS: 'v0.9.0 v0.10.0 v1.0.0-rc1' } });
    const r = run([], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readLog(fx.herdrLog), /--ref v0\.10\.0/);
    assert.ok(fs.existsSync(fx.dest));
  });

  it('resolved-latest downgrade aborts without writing', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_LATEST_TAG: 'v0.2.0' } });
    assert.equal(run([], fx.env).status, 0);
    const destBefore = fs.readFileSync(fx.dest);
    const stateBefore = fs.readFileSync(fx.stateFile, 'utf8');
    const settingsBefore = fs.readFileSync(fx.settingsFile, 'utf8');
    for (const f of [fx.herdrLog, fx.orderLog, fx.configureLog, fx.statusLog]) truncate(f);
    const r = run([], { ...fx.env, FAKE_LATEST_TAG: 'v0.1.0', FAKE_PLUGIN_VERSION: 'v0.2.0' });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /v0\.2\.0/);
    assert.match(r.stderr, /v0\.1\.0/);
    assert.match(r.stderr, /--allow-downgrade/);
    assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
    assert.ok(destBefore.equals(fs.readFileSync(fx.dest)), 'managed copy must be byte-identical');
    assert.equal(fs.readFileSync(fx.stateFile, 'utf8'), stateBefore, 'ownership record must be untouched');
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), settingsBefore, 'settings must be untouched');
    assert.equal(backupsBeside(fx.dest).length, 0, 'aborted downgrade creates no backup');
  });

  it('--force on an already-current install does not mutate', (t) => {
    const fx = setup(t);
    assert.equal(run(['--ref', 'v0.2.0'], fx.env).status, 0);
    const destBefore = fs.readFileSync(fx.dest);
    const settingsBefore = fs.readFileSync(fx.settingsFile, 'utf8');
    for (const f of [fx.herdrLog, fx.orderLog, fx.configureLog, fx.statusLog]) truncate(f);
    const r = run(['--force', '--ref', 'v0.2.0'], { ...fx.env, FAKE_PLUGIN_VERSION: 'v0.2.0' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already up to date/);
    assert.match(r.stdout + '\n' + r.stderr, /deprecat/i);
    const log = readLog(fx.herdrLog);
    assert.doesNotMatch(log, /plugin install/);
    assert.doesNotMatch(log, /plugin enable/);
    assert.doesNotMatch(log, /plugin unlink/);
    assert.doesNotMatch(log, /server reload/);
    assert.equal(readLog(fx.configureLog), '', 'configure must not run on no-op');
    assert.equal(readLog(fx.statusLog), '', 'daemon status must not run on no-op');
    assert.ok(destBefore.equals(fs.readFileSync(fx.dest)), 'managed copy must be byte-identical');
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), settingsBefore, 'settings file must not be written');
    assert.equal(backupsBeside(fx.dest).length, 0, 'no-op creates no backup');
  });

  it('non-strict installed versions proceed and never abort', (t) => {
    for (const ver of ['v1.2', 'v1.2.3.4', 'v1.2.3-rc1', '1.2.3', '']) {
      const fx = setup(t);
      const r = run(['--ref', 'v0.2.0'], { ...fx.env, FAKE_PLUGIN_VERSION: ver });
      assert.equal(r.status, 0, ver + ' must proceed: ' + r.stderr);
      assert.match(readLog(fx.herdrLog), /plugin install/, ver + ' must install');
      assert.doesNotMatch(r.stdout + '\n' + r.stderr, /newer than target/, ver + ' must never abort');
      assert.ok(fs.existsSync(fx.dest), ver + ' must install dest');
    }
  });

  it('symlinked managed copy is never reported current', (t) => {
    const fx = setup(t);
    assert.equal(run(['--ref', 'v0.2.0'], fx.env).status, 0);
    const outside = path.join(fx.tmp, 'outside.txt');
    fs.writeFileSync(outside, 'outside target\n');
    fs.rmSync(fx.dest);
    fs.symlinkSync(outside, fx.dest);
    for (const f of [fx.herdrLog, fx.orderLog, fx.configureLog, fx.statusLog]) truncate(f);
    const r = run(['--ref', 'v0.2.0'], { ...fx.env, FAKE_PLUGIN_VERSION: 'v0.2.0' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + '\n' + r.stderr, /already up to date/);
    assert.ok(!fs.lstatSync(fx.dest).isSymbolicLink(), 'destination must be a regular managed copy');
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside target\n', 'link target untouched');
    assert.equal(fs.readFileSync(fx.dest, 'utf8'), fs.readFileSync(path.join(fx.pluginRoot, 'extensions', 'gentle-herdr-state.ts'), 'utf8'));
    assert.equal(backupsBeside(fx.dest).length, 1, 'symlink must be moved aside');
  });

  it('missing managed copy is repaired instead of reporting current', (t) => {
    const fx = setup(t);
    assert.equal(run(['--ref', 'v0.2.0'], fx.env).status, 0);
    fs.rmSync(fx.dest);
    for (const f of [fx.herdrLog, fx.orderLog, fx.configureLog, fx.statusLog]) truncate(f);
    const r = run(['--ref', 'v0.2.0'], { ...fx.env, FAKE_PLUGIN_VERSION: 'v0.2.0' });
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stdout + '\n' + r.stderr, /already up to date/);
    assert.equal(fs.readFileSync(fx.dest, 'utf8'), fs.readFileSync(path.join(fx.pluginRoot, 'extensions', 'gentle-herdr-state.ts'), 'utf8'), 'missing copy must be repaired');
    assert.match(readLog(fx.herdrLog), /plugin install/);
    assert.equal(backupsBeside(fx.dest).length, 0, 'repair of a missing copy creates no backup');
  });

  it('PATH without curl or git fails closed naming --ref', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_MODE: 'fail', FAKE_GIT_MODE: 'fail' } });
    const onlyBin = path.join(fx.tmp, 'nonetbin');
    fs.mkdirSync(onlyBin, { recursive: true });
    const tools = ['sh', 'node', 'sha256sum', 'date', 'sed', 'cut', 'tr', 'expr', 'grep', 'sort', 'tail', 'head', 'mkdir', 'cp', 'mv', 'rm', 'rmdir', 'uname', 'chmod'];
    for (const name of tools) {
      const found = spawnSync('sh', ['-c', 'command -v ' + name], { encoding: 'utf8', env: fx.env }).stdout.trim().split('\n')[0];
      assert.ok(found && found.startsWith('/'), name + ' must resolve for the no-network PATH');
      fs.symlinkSync(found, path.join(onlyBin, name));
    }
    fs.symlinkSync(path.join(fx.tmp, 'fakebin', 'herdr'), path.join(onlyBin, 'herdr'));
    const env = { ...fx.env, PATH: onlyBin };
    assert.equal(spawnSync('sh', ['-c', 'command -v herdr >/dev/null'], { encoding: 'utf8', env }).status, 0, 'fake herdr must stay reachable');
    assert.notEqual(spawnSync('sh', ['-c', 'command -v curl >/dev/null'], { encoding: 'utf8', env }).status, 0, 'curl must be absent from PATH');
    assert.notEqual(spawnSync('sh', ['-c', 'command -v git >/dev/null'], { encoding: 'utf8', env }).status, 0, 'git must be absent from PATH');
    const r = run([], env);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /--ref/);
    assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
    assert.ok(!fs.existsSync(fx.dest), 'nothing must be installed without resolution');
    assert.ok(!fs.existsSync(fx.stateFile), 'no ownership record without resolution');
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
