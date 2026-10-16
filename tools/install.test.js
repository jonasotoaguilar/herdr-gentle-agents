'use strict';

// Behavior-first isolated tests for install.sh (two-package installer).
//
// Isolation contract: every test builds a temp fixture (HOME, XDG_STATE_HOME,
// PI_AGENT_DIR default under temp HOME) plus fake `herdr`/`pi`/`npm` binaries
// that log argv and replay canned output. The live Herdr/Pi/npm config is
// never touched: HERDR_BIN_PATH/PI_BIN_PATH/NPM_BIN_PATH stay unset so the
// tools resolve via a fixture PATH, and HERDR_GENTLE_PLUGIN_ROOT is set only
// in the override tests.
//
// Fixture plugin roots hold logging stub configure/status scripts (no real
// config or daemon is touched). Fixture Pi roots hold a copy of the real
// Pi-owned exclusion helper (lib/pi-extension-exclusion.js), so the
// coexistence step runs the real helper against fixture settings.json.
// The retired managed-copy install is NOT covered here: a fresh install
// must never create $PI_DIR/extensions/gentle-herdr-state.ts.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const REAL_HELPER = path.join(REPO_ROOT, 'lib', 'pi-extension-exclusion.js');
const EXCLUSION_ENTRY = '-extensions/herdr-agent-state.ts';
const PI_NPM_SPEC = 'npm:@jonasotoaguilar/herdr-gentle-agents';
const PI_GIT_SPEC = 'git:github.com/jonasotoaguilar/herdr-gentle-agents';

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
# Fake curl for install.sh tests: logs argv, replays canned releases JSON.
log="\${CURL_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
mode="\${FAKE_CURL_MODE:-ok}"
tags="\${FAKE_CURL_TAGS:-herdr-v0.2.0}"
if [ "$mode" = "fail" ]; then echo "curl: stub failure" >&2; exit 1; fi
if [ "$mode" = "single" ]; then
  printf '{"tag_name":"%s"}\\n' "$tags"
  exit 0
fi
out="["
sep=""
for t in $tags; do
  out="$out$sep"'{"tag_name":"'"$t"'"}'
  sep=","
done
out="$out]"
printf '%s\\n' "$out"
exit 0
`;

const FAKE_GIT = `#!/bin/sh
# Fake git for install.sh tests: logs argv, replays canned ls-remote tags.
log="\${GIT_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
if [ "\${1:-}" = "ls-remote" ]; then
  mode="\${FAKE_GIT_MODE:-fail}"
  if [ "$mode" = "fail" ]; then echo "git: stub ls-remote failure" >&2; exit 1; fi
  for t in \${FAKE_GIT_TAGS:-herdr-v0.2.0}; do
    printf '0000000000000000000000000000000000000000\\trefs/tags/%s\\n' "$t"
  done
  exit 0
fi
exec "__REAL_GIT__" "$@"
`;

const FAKE_PI = `#!/bin/sh
# Fake pi for install.sh tests: logs argv, replays canned list output.
log="\${PI_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
if [ -n "\${ORDER_LOG:-}" ]; then printf 'pi %s\\n' "$*" >>"$ORDER_LOG"; fi
if [ "\${1:-}" = "install" ]; then
  if [ "\${FAKE_PI_INSTALL_MODE:-ok}" = "fail" ]; then echo "pi: stub install failure" >&2; exit 1; fi
  exit 0
fi
if [ "\${1:-}" = "remove" ]; then
  if [ "\${FAKE_PI_REMOVE_MODE:-ok}" = "fail" ]; then echo "pi: stub refusal: package not installed" >&2; exit 1; fi
  exit 0
fi
if [ "\${1:-}" = "list" ]; then
  if [ "\${FAKE_PI_LIST_MODE:-valid-npm}" = "fail" ]; then echo "pi: stub list failure" >&2; exit 1; fi
  root="\${FAKE_PI_ROOT:-/nonexistent}"
  case "\${FAKE_PI_LIST_MODE:-valid-npm}" in
    valid-npm)
      printf 'User packages:\\n  npm:@jonasotoaguilar/herdr-gentle-agents\\n    %s\\n' "$root"
      exit 0 ;;
    valid-git)
      printf 'User packages:\\n  git:github.com/jonasotoaguilar/herdr-gentle-agents\\n    %s\\n' "$root"
      exit 0 ;;
    absent)
      printf 'User packages:\\n'
      exit 0 ;;
  esac
  exit 0
fi
echo "pi: unknown command $*" >&2
exit 1
`;

const FAKE_NPM = `#!/bin/sh
# Fake npm for install.sh tests: logs argv, replays canned view output.
log="\${NPM_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
if [ "\${1:-}" = "view" ]; then
  if [ "\${FAKE_NPM_MODE:-ok}" = "fail" ]; then echo "npm: stub registry failure" >&2; exit 1; fi
  printf '%s\\n' "\${FAKE_NPM_VERSION:-9.9.9}"
  exit 0
fi
echo "npm: unknown command $*" >&2
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

// Build an isolated fixture. PI_AGENT_DIR is deliberately left unset so the
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
  const piRoot = path.join(tmp, 'pi-root');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(stateBase, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });

  const herdrLog = path.join(tmp, 'herdr.log');
  const piLog = path.join(tmp, 'pi.log');
  const npmLog = path.join(tmp, 'npm.log');
  const orderLog = path.join(tmp, 'order.log');
  const configureLog = path.join(tmp, 'configure.log');
  const statusLog = path.join(tmp, 'status.log');
  const curlLog = path.join(tmp, 'curl.log');
  const gitLog = path.join(tmp, 'git.log');
  for (const f of [herdrLog, piLog, npmLog, orderLog, configureLog, statusLog, curlLog, gitLog]) {
    fs.writeFileSync(f, '');
  }

  fs.writeFileSync(path.join(fakeBin, 'herdr'), FAKE_HERDR, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'pi'), FAKE_PI, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'npm'), FAKE_NPM, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'curl'), FAKE_CURL, { mode: 0o755 });
  let realGit = '/usr/bin/git';
  try {
    const found = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim().split('\n')[0];
    if (found) realGit = found;
  } catch {
    // Fall back to /usr/bin/git for non-ls-remote delegation.
  }
  fs.writeFileSync(path.join(fakeBin, 'git'), FAKE_GIT.split('__REAL_GIT__').join(realGit), { mode: 0o755 });

  // Fake Herdr plugin root: logging stubs only (no real config or daemon).
  const withConfigure = opts.withConfigure !== false;
  const withStatus = opts.withStatus !== false;
  if (withConfigure || withStatus) fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
  if (withConfigure) {
    fs.writeFileSync(path.join(pluginRoot, 'bin', 'configure.js'), STUB_CONFIGURE, { mode: 0o755 });
  }
  if (withStatus) {
    fs.writeFileSync(path.join(pluginRoot, 'bin', 'gentle-status.js'), STUB_STATUS, { mode: 0o755 });
  }

  // Fake installed Pi package root: the real Pi-owned exclusion helper.
  assert.ok(fs.existsSync(REAL_HELPER), 'repo exclusion helper must exist');
  fs.mkdirSync(path.join(piRoot, 'lib'), { recursive: true });
  fs.copyFileSync(REAL_HELPER, path.join(piRoot, 'lib', 'pi-extension-exclusion.js'));

  const env = { ...process.env };
  for (const name of [
    'PI_AGENT_DIR', 'HERDR_BIN_PATH', 'PI_BIN_PATH', 'NPM_BIN_PATH',
    'HERDR_GENTLE_PLUGIN_ROOT', 'HERDR_GENTLE_PI_SOURCE',
    'FAKE_CONFIGURE_FAIL', 'FAKE_STATUS_FAIL', 'FAKE_UNINSTALL_MODE',
    'FAKE_RELOAD_FAIL', 'FAKE_LIST_MODE', 'FAKE_PLUGIN_VERSION',
    'FAKE_CURL_MODE', 'FAKE_CURL_TAGS', 'FAKE_LATEST_TAG',
    'FAKE_GIT_MODE', 'FAKE_GIT_TAGS', 'FAKE_PI_LIST_MODE',
    'FAKE_PI_INSTALL_MODE', 'FAKE_PI_REMOVE_MODE',
    'FAKE_NPM_MODE', 'FAKE_NPM_VERSION',
    'CURL_LOG', 'GIT_LOG', 'PI_LOG', 'NPM_LOG', 'HERDR_GENTLE_LATEST_URL',
  ]) delete env[name];
  Object.assign(env, {
    HOME: home,
    XDG_STATE_HOME: stateBase,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    HERDR_LOG: herdrLog,
    PI_LOG: piLog,
    NPM_LOG: npmLog,
    ORDER_LOG: orderLog,
    CONFIGURE_LOG: configureLog,
    STATUS_LOG: statusLog,
    CURL_LOG: curlLog,
    GIT_LOG: gitLog,
    HERDR_GENTLE_LATEST_URL: 'https://example.invalid/releases',
    FAKE_CURL_MODE: 'ok',
    FAKE_CURL_TAGS: 'herdr-v0.2.0',
    FAKE_GIT_MODE: 'fail',
    FAKE_PLUGIN_ROOT: pluginRoot,
    FAKE_LIST_MODE: opts.listMode || 'valid',
    FAKE_PI_ROOT: piRoot,
    FAKE_PI_LIST_MODE: 'valid-npm',
    FAKE_NPM_MODE: 'ok',
  }, opts.fakeEnv || {});

  const piDir = path.join(home, '.pi', 'agent');
  const dest = path.join(piDir, 'extensions', 'gentle-herdr-state.ts');
  const stateFile = path.join(stateBase, 'herdr', 'plugins', 'herdr-gentle-agents', 'installer-state');
  const settingsFile = path.join(piDir, 'settings.json');
  const exclusionMarker = path.join(stateBase, 'herdr', 'plugins', 'herdr-gentle-agents', 'pi-extension-exclusion-owned');
  return { tmp, home, stateBase, pluginRoot, piRoot, env, herdrLog, piLog, npmLog, orderLog, configureLog, statusLog, curlLog, gitLog, piDir, dest, stateFile, settingsFile, exclusionMarker };
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

function readStateJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Plant a retired managed-copy record: destination bytes plus a sha256
// ownership record in the old shape.
function plantLegacyManagedCopy(fx, content) {
  fs.mkdirSync(path.dirname(fx.dest), { recursive: true });
  fs.writeFileSync(fx.dest, content);
  const sum = crypto.createHash('sha256').update(content).digest('hex');
  fs.mkdirSync(path.dirname(fx.stateFile), { recursive: true });
  fs.writeFileSync(fx.stateFile, `${sum}\n`);
  return sum;
}

describe('install.sh two-package behavior', () => {
  it('sh -n syntax check passes', () => {
    const r = spawnSync('sh', ['-n', INSTALL_SH], { encoding: 'utf8' });
    assert.equal(r.status, 0, `sh -n failed: ${r.stderr}`);
  });

  it('--help exits zero and documents the two-package contract', (t) => {
    const fx = setup(t);
    const r = run(['--help'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /--ref/);
    assert.match(r.stdout, /--pi-source/);
    assert.match(r.stdout, /auto\|npm\|git/);
    assert.match(r.stdout, /--allow-downgrade/);
    assert.match(r.stdout, /--force/);
    assert.match(r.stdout, /deprecat/i);
    assert.match(r.stdout, /--uninstall/);
    assert.match(r.stdout, /pi install/);
    assert.match(r.stdout, /herdr plugin install/);
    assert.match(r.stdout, /pi update --extensions/);
    assert.match(r.stdout, /herdr plugin update herdr-gentle-agents/);
    assert.match(r.stdout, /managed copy/i);
    assert.match(r.stdout, /HERDR_GENTLE_PI_SOURCE/);
    assert.match(r.stdout, /PI_BIN_PATH/);
    assert.match(r.stdout, /NPM_BIN_PATH/);
    assert.match(r.stdout, /HERDR_GENTLE_LATEST_URL/);
    assert.equal(readLog(fx.herdrLog), '', 'help must not call herdr');
    assert.equal(readLog(fx.piLog), '', 'help must not call pi');
  });

  it('fresh install resolves the newest herdr-v* tag from the list API', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_TAGS: 'herdr-v0.1.0 herdr-v0.2.0 herdr-v0.10.0 v9.9.9 pi-v1.0.0' } });
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.curlLog), /example\.invalid/, 'latest resolution must run without network');
    const herdrLog = readLog(fx.herdrLog);
    assert.match(herdrLog, /plugin install jonasotoaguilar\/herdr-gentle-agents\/herdr-plugin --ref herdr-v0\.10\.0 --yes/);
    assert.match(herdrLog, /plugin enable herdr-gentle-agents/);
    assert.ok(herdrLog.indexOf('plugin install') < herdrLog.indexOf('plugin enable'), 'install precedes enable');
    assert.match(readLog(fx.piLog), new RegExp(`install ${PI_NPM_SPEC.replace(/[.:/]/g, (c) => `\\${c}`)}`));
    const order = readLog(fx.orderLog);
    assert.ok(order.indexOf('herdr plugin install') !== -1, `order log:\n${order}`);
    assert.ok(order.indexOf('pi install') !== -1, `order log:\n${order}`);
    assert.ok(order.indexOf('herdr plugin install') < order.indexOf('pi install'), `Herdr before Pi:\n${order}`);
    assert.ok(order.indexOf('pi install') < order.indexOf('configure --apply'), `Pi before configure:\n${order}`);
    assert.ok(order.indexOf('configure --apply') < order.indexOf('configure --check'), `apply before check:\n${order}`);
    const statusLines = readLog(fx.statusLog).split('\n');
    assert.equal(statusLines[0], '--stop', 'daemon restart begins with --stop');
    assert.equal(statusLines[1], '', 'daemon ensure follows with no args');
    assert.ok(!fs.existsSync(fx.dest), 'the retired managed copy must never be recreated');
    const doc = readSettingsJson(fx.settingsFile);
    assert.ok(doc.extensions.includes(EXCLUSION_ENTRY), 'exclusion helper must run from the Pi package root');
    assert.ok(fs.existsSync(fx.exclusionMarker), 'exclusion ownership marker must exist');
    assert.match(r.stdout, /pi-extension-exclusion: recorded/);
    const state = readStateJson(fx.stateFile);
    assert.equal(state.version, 1);
    assert.equal(state.ref, 'herdr-v0.10.0');
    assert.equal(state.plugin_version, '0.10.0');
    assert.equal(state.pi_source, PI_NPM_SPEC);
    assert.ok(typeof state.installed_at === 'string' && state.installed_at.length > 0);
    assert.match(r.stdout, /done \(ref=herdr-v0\.10\.0/);
    assert.match(r.stdout, /\/reload/);
  });

  it('single-object releases JSON still resolves without jq', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_MODE: 'single', FAKE_CURL_TAGS: 'herdr-v0.4.0' } });
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.herdrLog), /--ref herdr-v0\.4\.0/);
  });

  it('git ls-remote fallback resolves the newest herdr-v* tag when curl fails', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_MODE: 'fail', FAKE_GIT_MODE: 'ok', FAKE_GIT_TAGS: 'herdr-v0.1.0 herdr-v0.3.0 v9.9.9' } });
    const r = run([], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.herdrLog), /plugin install jonasotoaguilar\/herdr-gentle-agents\/herdr-plugin --ref herdr-v0\.3\.0 --yes/);
    assert.match(readLog(fx.piLog), /install/);
    assert.ok(!fs.existsSync(fx.dest));
  });

  it('unresolvable latest fails closed naming --ref', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_MODE: 'fail', FAKE_GIT_MODE: 'fail' } });
    const r = run([], fx.env);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /--ref/);
    assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
    assert.equal(readLog(fx.piLog), '', 'pi must not run when ref resolution fails');
    assert.ok(!fs.existsSync(fx.dest));
    assert.ok(!fs.existsSync(fx.stateFile));
  });

  it('explicit --ref is passed through to plugin install', (t) => {
    const fx = setup(t);
    const r = run(['--ref', 'herdr-v0.2.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.herdrLog), /--ref herdr-v0\.2\.0/);
    assert.equal(readStateJson(fx.stateFile).ref, 'herdr-v0.2.0');
  });

  it('non-release ref skips the version gate with one warning and installs', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_PLUGIN_VERSION: '9.9.9' } });
    const r = run(['--ref', 'test-branch'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const warnings = r.stderr.split('\n').filter((l) => l.includes('warning'));
    assert.equal(warnings.length, 1, `exactly one warning line, got:\n${r.stderr}`);
    assert.match(warnings[0], /test-branch/);
    assert.match(warnings[0], /skipping the version check/);
    assert.match(readLog(fx.herdrLog), /--ref test-branch/);
    assert.equal(readStateJson(fx.stateFile).ref, 'test-branch');
  });

  it('already-current install is a no-op with exactly one info line', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_CURL_TAGS: 'herdr-v0.2.0' } });
    assert.equal(run([], fx.env).status, 0);
    const settingsBefore = fs.readFileSync(fx.settingsFile, 'utf8');
    const stateBefore = fs.readFileSync(fx.stateFile, 'utf8');
    const past = new Date('2001-01-01T00:00:00Z');
    fs.utimesSync(fx.settingsFile, past, past);
    fs.utimesSync(fx.stateFile, past, past);
    for (const f of [fx.herdrLog, fx.piLog, fx.npmLog, fx.orderLog, fx.configureLog, fx.statusLog]) truncate(f);
    const r = run([], { ...fx.env, FAKE_PLUGIN_VERSION: '0.2.0' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.equal(r.stdout, 'install.sh: already up to date (herdr-v0.2.0)\n');
    const herdrLog = readLog(fx.herdrLog);
    assert.doesNotMatch(herdrLog, /plugin install/);
    assert.doesNotMatch(herdrLog, /plugin enable/);
    assert.doesNotMatch(herdrLog, /plugin unlink/);
    assert.doesNotMatch(herdrLog, /server reload-config/);
    assert.doesNotMatch(readLog(fx.piLog), /install /);
    assert.equal(fs.readFileSync(fx.settingsFile, 'utf8'), settingsBefore, 'settings bytes must be stable');
    assert.equal(fs.statSync(fx.settingsFile).mtimeMs, past.getTime(), 'settings mtime must be untouched');
    assert.equal(fs.readFileSync(fx.stateFile, 'utf8'), stateBefore, 'state bytes must be stable');
    assert.equal(readLog(fx.configureLog), '', 'configure must not run on no-op');
    assert.equal(readLog(fx.statusLog), '', 'daemon status must not run on no-op');
  });

  it('installed version newer than the target aborts naming --allow-downgrade', (t) => {
    const fx = setup(t);
    const r = run(['--ref', 'herdr-v0.2.0'], { ...fx.env, FAKE_PLUGIN_VERSION: '0.3.0' });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /0\.3\.0/);
    assert.match(r.stderr, /herdr-v0\.2\.0/);
    assert.match(r.stderr, /--allow-downgrade/);
    assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
    assert.equal(readLog(fx.piLog), '', 'pi must not run after a downgrade refusal');
    assert.ok(!fs.existsSync(fx.dest));
    assert.ok(!fs.existsSync(fx.stateFile));
    assert.ok(!fs.existsSync(fx.settingsFile));
  });

  it('--allow-downgrade proceeds when the installed version is newer', (t) => {
    const fx = setup(t);
    const r = run(['--ref', 'herdr-v0.2.0', '--allow-downgrade'], { ...fx.env, FAKE_PLUGIN_VERSION: '0.3.0' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.herdrLog), /--ref herdr-v0\.2\.0/);
    assert.match(readLog(fx.piLog), /install/);
  });

  it('missing or non-numeric installed version proceeds and never aborts', (t) => {
    for (const ver of [null, 'not-a-version', '']) {
      const fx = setup(t);
      const env = { ...fx.env };
      if (ver === null) delete env.FAKE_PLUGIN_VERSION;
      else env.FAKE_PLUGIN_VERSION = ver;
      const r = run(['--ref', 'herdr-v0.2.0'], env);
      assert.equal(r.status, 0, `version ${JSON.stringify(ver)} must proceed: ${r.stderr}`);
      assert.match(readLog(fx.herdrLog), /plugin install/);
      assert.doesNotMatch(`${r.stdout}\n${r.stderr}`, /newer than target/);
    }
  });

  it('locally linked plugin is unlinked before install', (t) => {
    const fx = setup(t, { listMode: 'local' });
    const r = run(['--ref', 'herdr-v0.2.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const log = readLog(fx.herdrLog);
    assert.match(log, /plugin unlink herdr-gentle-agents/);
    assert.match(log, /plugin install jonasotoaguilar\/herdr-gentle-agents\/herdr-plugin --ref herdr-v0\.2\.0 --yes/);
    assert.ok(log.indexOf('plugin unlink') < log.indexOf('plugin install'), 'unlink must precede install');
    assert.match(`${r.stdout}\n${r.stderr}`, /herdr plugin link/);
  });

  it('owned legacy managed copy is migrated away with one info line', (t) => {
    const fx = setup(t);
    plantLegacyManagedCopy(fx, '// legacy owned bytes\n');
    const r = run(['--ref', 'herdr-v0.2.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.ok(!fs.existsSync(fx.dest), 'owned legacy copy must be removed');
    assert.match(r.stdout, new RegExp(`removed legacy managed copy ${fx.dest.replace(/[.:/]/g, (c) => `\\${c}`)}`));
    const state = readStateJson(fx.stateFile);
    assert.equal(state.version, 1, 'old sha record must be replaced by the versioned state');
    assert.equal(state.ref, 'herdr-v0.2.0');
    assert.match(readLog(fx.herdrLog), /plugin install/);
  });

  it('user-modified legacy copy is kept with a warning naming its path', (t) => {
    const fx = setup(t);
    plantLegacyManagedCopy(fx, '// original bytes\n');
    fs.writeFileSync(fx.dest, '// user-edited bytes\n');
    const r = run(['--ref', 'herdr-v0.2.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.equal(fs.readFileSync(fx.dest, 'utf8'), '// user-edited bytes\n', 'unowned content must never be deleted');
    assert.match(r.stderr, /preserv/);
    assert.match(r.stderr, new RegExp(fx.dest.replace(/[.:/]/g, (c) => `\\${c}`)));
    assert.match(readLog(fx.herdrLog), /plugin install/);
  });

  it('pi install failure reports the retry command with --pi-source git', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_PI_INSTALL_MODE: 'fail' } });
    const r = run(['--ref', 'herdr-v0.2.0'], fx.env);
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: ${r.stderr}`);
    assert.match(r.stderr, /pi install/);
    assert.match(r.stderr, /herdr-gentle-agents at herdr-v0\.2\.0/);
    assert.match(r.stderr, /install\.sh --ref herdr-v0\.2\.0 --pi-source git/);
    assert.match(readLog(fx.herdrLog), /plugin install/, 'the Herdr side is already installed when Pi fails');
    assert.ok(!fs.existsSync(fx.stateFile), 'no state is recorded when pi install fails');
  });

  it('--pi-source git uses the git spec without consulting npm', (t) => {
    const fx = setup(t);
    const r = run(['--ref', 'herdr-v0.2.0', '--pi-source', 'git'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.piLog), new RegExp(`install ${PI_GIT_SPEC.replace(/[.:/]/g, (c) => `\\${c}`)}`));
    assert.equal(readLog(fx.npmLog), '', 'explicit git source must not consult the registry');
    assert.equal(readStateJson(fx.stateFile).pi_source, PI_GIT_SPEC);
  });

  it('--pi-source npm uses the npm spec', (t) => {
    const fx = setup(t);
    const r = run(['--ref', 'herdr-v0.2.0', '--pi-source=npm'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readLog(fx.piLog), /install npm:@jonasotoaguilar\/herdr-gentle-agents/);
    assert.equal(readStateJson(fx.stateFile).pi_source, PI_NPM_SPEC);
  });

  it('auto source falls back to git with exactly one warning when npm fails', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_NPM_MODE: 'fail' } });
    const r = run(['--ref', 'herdr-v0.2.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const warnings = r.stderr.split('\n').filter((l) => l.includes('warning'));
    assert.equal(warnings.length, 1, `exactly one warning line, got:\n${r.stderr}`);
    assert.match(warnings[0], /git:github\.com\/jonasotoaguilar\/herdr-gentle-agents/);
    assert.match(readLog(fx.piLog), /install git:github\.com\/jonasotoaguilar\/herdr-gentle-agents/);
    assert.equal(readStateJson(fx.stateFile).pi_source, PI_GIT_SPEC);
  });

  it('unresolvable Pi root warns naming /herdr-gentle:customize and continues', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_PI_LIST_MODE: 'absent' } });
    const r = run(['--ref', 'herdr-v0.2.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /\/herdr-gentle:customize/);
    assert.match(readLog(fx.herdrLog), /plugin install/);
    assert.match(readLog(fx.piLog), /install/);
    assert.equal(readStateJson(fx.stateFile).ref, 'herdr-v0.2.0');
  });

  it('uninstall removes both packages with ordered cleanup', (t) => {
    const fx = setup(t);
    assert.equal(run(['--ref', 'herdr-v0.2.0'], fx.env).status, 0);
    plantSettings(fx, { theme: 'keep', extensions: ['-builtin:codemode', EXCLUSION_ENTRY] });
    // Re-record ownership for the planted settings (marker binds the target).
    assert.equal(run(['--ref', 'herdr-v0.2.0'], { ...fx.env, FAKE_PLUGIN_VERSION: '0.1.0' }).status, 0);
    for (const f of [fx.herdrLog, fx.piLog, fx.orderLog, fx.configureLog, fx.statusLog]) truncate(f);
    const r = run(['--uninstall'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(readLog(fx.statusLog), /--stop --purge/);
    assert.match(readLog(fx.piLog), new RegExp(`remove ${PI_NPM_SPEC.replace(/[.:/]/g, (c) => `\\${c}`)}`));
    assert.match(readLog(fx.herdrLog), /plugin uninstall herdr-gentle-agents/);
    const order = readLog(fx.orderLog);
    assert.ok(order.indexOf('status --stop --purge') !== -1, `order log:\n${order}`);
    assert.ok(order.indexOf('pi remove') !== -1, `order log:\n${order}`);
    assert.ok(order.indexOf('herdr plugin uninstall') !== -1, `order log:\n${order}`);
    assert.ok(order.indexOf('status --stop --purge') < order.indexOf('pi remove'));
    assert.ok(order.indexOf('pi remove') < order.indexOf('herdr plugin uninstall'));
    const doc = readSettingsJson(fx.settingsFile);
    assert.ok(!doc.extensions.includes(EXCLUSION_ENTRY), 'owned exclusion must be removed');
    assert.ok(doc.extensions.includes('-builtin:codemode'), 'unrelated entries survive');
    assert.equal(doc.theme, 'keep');
    assert.ok(!fs.existsSync(fx.exclusionMarker), 'marker must be cleaned up');
    assert.ok(!fs.existsSync(fx.stateFile), 'state file must be removed');
    assert.equal(readLog(fx.configureLog), '', 'uninstall runs no configure step');
  });

  it('uninstall with the state already absent still exits zero', (t) => {
    const fx = setup(t, { fakeEnv: { FAKE_UNINSTALL_MODE: 'absent', FAKE_PI_LIST_MODE: 'absent' } });
    const r = run(['--uninstall'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /done/);
  });

  it('uninstall tolerates a pi remove refusal and still uninstalls herdr', (t) => {
    const fx = setup(t);
    assert.equal(run(['--ref', 'herdr-v0.2.0'], fx.env).status, 0);
    for (const f of [fx.herdrLog, fx.piLog]) truncate(f);
    const r = run(['--uninstall'], { ...fx.env, FAKE_PI_REMOVE_MODE: 'fail' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /pi remove/);
    assert.match(readLog(fx.herdrLog), /plugin uninstall herdr-gentle-agents/);
    assert.ok(!fs.existsSync(fx.stateFile));
  });

  it('uninstall removes an owned legacy copy but preserves a modified one', (t) => {
    const fx = setup(t);
    plantLegacyManagedCopy(fx, '// legacy owned bytes\n');
    const rOwned = run(['--uninstall'], { ...fx.env, FAKE_PI_LIST_MODE: 'absent' });
    assert.equal(rOwned.status, 0, rOwned.stderr);
    assert.ok(!fs.existsSync(fx.dest), 'owned legacy copy must be removed');

    const fx2 = setup(t);
    plantLegacyManagedCopy(fx2, '// original bytes\n');
    fs.writeFileSync(fx2.dest, '// user-edited bytes\n');
    const rMod = run(['--uninstall'], { ...fx2.env, FAKE_PI_LIST_MODE: 'absent' });
    assert.equal(rMod.status, 0, rMod.stderr);
    assert.equal(fs.readFileSync(fx2.dest, 'utf8'), '// user-edited bytes\n');
    assert.match(rMod.stderr, /preserv/);
  });

  it('invalid refs are rejected before touching anything', (t) => {
    const bad = ['-herdr-v0.1.0', 'has space', 'a;b', '$(x)', 'a`b`'];
    for (const ref of bad) {
      const fx = setup(t);
      const r = run([`--ref=${ref}`], fx.env);
      assert.equal(r.status, 2, `ref ${JSON.stringify(ref)} must exit 2, got ${r.status}: ${r.stderr}`);
      assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
      assert.equal(readLog(fx.piLog), '', `ref ${JSON.stringify(ref)} must not call pi`);
      assert.ok(!fs.existsSync(fx.dest), `ref ${JSON.stringify(ref)} must not create dest`);
      assert.ok(!fs.existsSync(fx.stateFile), `ref ${JSON.stringify(ref)} must not record state`);
    }
    const fx = setup(t);
    const r = run(['--ref', ''], fx.env);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(!fs.existsSync(fx.dest));
  });

  it('mutable ref main is rejected with no state changes', (t) => {
    for (const args of [['--ref', 'main'], ['--ref=main']]) {
      const fx = setup(t);
      const r = run(args, fx.env);
      assert.equal(r.status, 2, `ref main (${args.join(' ')}) must exit 2, got ${r.status}: ${r.stderr}`);
      assert.match(r.stderr, /main.*mutable|mutable.*main|not allowed/i);
      assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
      assert.ok(!fs.existsSync(fx.dest));
      assert.ok(!fs.existsSync(fx.stateFile));
    }
  });

  it('unknown flags and bad --pi-source values exit 2 without touching state', (t) => {
    for (const args of [['--bogus'], ['--pi-source', 'tarball'], ['--pi-source=svn']]) {
      const fx = setup(t);
      const r = run(args, fx.env);
      assert.equal(r.status, 2, `args ${args.join(' ')} must exit 2, got ${r.status}: ${r.stderr}`);
      assert.doesNotMatch(readLog(fx.herdrLog), /plugin install/);
      assert.equal(readLog(fx.piLog), '', `args ${args.join(' ')} must not call pi`);
      assert.ok(!fs.existsSync(fx.dest), `args ${args.join(' ')} must not create dest`);
      assert.ok(!fs.existsSync(fx.stateFile), `args ${args.join(' ')} must not record state`);
    }
  });

  it('--force stays a deprecated no-op that still installs', (t) => {
    const fx = setup(t);
    const r = run(['--force', '--ref', 'herdr-v0.2.0'], fx.env);
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(`${r.stdout}\n${r.stderr}`, /deprecat/i);
    assert.match(readLog(fx.herdrLog), /plugin install/);
    assert.ok(!fs.existsSync(fx.dest));
  });

  it('missing herdr/pi binaries fail without touching the fixture', (t) => {
    const fx = setup(t);
    const rHerdr = run(['--ref', 'herdr-v0.2.0'], { ...fx.env, HERDR_BIN_PATH: '/nonexistent/herdr' });
    assert.notEqual(rHerdr.status, 0, 'missing herdr must fail');
    assert.match(rHerdr.stderr, /herdr/);

    const fx2 = setup(t);
    const rPi = run(['--ref', 'herdr-v0.2.0'], { ...fx2.env, PI_BIN_PATH: '/nonexistent/pi' });
    assert.notEqual(rPi.status, 0, 'missing pi must fail');
    assert.match(rPi.stderr, /pi/);

    for (const [fxu, r] of [[fx, rHerdr], [fx2, rPi]]) {
      assert.ok(!fs.existsSync(fxu.dest), 'dest must stay absent');
      assert.ok(!fs.existsSync(fxu.stateFile), 'state must stay absent');
      assert.ok(!fs.existsSync(fxu.settingsFile), 'settings must stay absent');
      assert.equal(readLog(fxu.piLog), '', 'fixture pi must not run');
    }
  });

  it('missing node fails without touching the fixture', (t) => {
    const fx = setup(t);
    const onlyBin = path.join(fx.tmp, 'nonodebin');
    fs.mkdirSync(onlyBin, { recursive: true });
    for (const name of ['sh', 'uname']) {
      const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', env: fx.env }).stdout.trim().split('\n')[0];
      assert.ok(found && found.startsWith('/'), `${name} must resolve`);
      fs.symlinkSync(found, path.join(onlyBin, name));
    }
    fs.symlinkSync(path.join(fx.tmp, 'fakebin', 'herdr'), path.join(onlyBin, 'herdr'));
    fs.symlinkSync(path.join(fx.tmp, 'fakebin', 'pi'), path.join(onlyBin, 'pi'));
    const env = { ...fx.env, PATH: onlyBin };
    assert.notEqual(spawnSync('sh', ['-c', 'command -v node >/dev/null'], { encoding: 'utf8', env }).status, 0, 'node must be absent from PATH');
    const r = run(['--ref', 'herdr-v0.2.0'], env);
    assert.notEqual(r.status, 0, 'missing node must fail');
    assert.match(r.stderr, /node/);
    assert.ok(!fs.existsSync(fx.dest), 'dest must stay absent');
    assert.ok(!fs.existsSync(fx.stateFile), 'state must stay absent');
    assert.ok(!fs.existsSync(fx.settingsFile), 'settings must stay absent');
  });

  it('malformed and ambiguous plugin_root JSON fails closed', (t) => {
    for (const mode of ['malformed', 'multiple', 'relative', 'empty', 'missing-field']) {
      const fx = setup(t, { listMode: mode });
      const r = run(['--ref', 'herdr-v0.2.0'], fx.env);
      assert.notEqual(r.status, 0, `list mode ${mode} must fail`);
      assert.match(r.stderr, /plugin_root|plugin list|malformed|ambiguous|absolute|zero|no plugin_root/i, `mode ${mode}: ${r.stderr}`);
      assert.ok(!fs.existsSync(fx.stateFile), `mode ${mode} must not record state`);
    }
  });

  it('explicit plugin-root override must be absolute; absolute override bypasses lookup', (t) => {
    const fx = setup(t, { listMode: 'malformed' });
    const rel = run(['--ref', 'herdr-v0.2.0'], { ...fx.env, HERDR_GENTLE_PLUGIN_ROOT: 'relative/path' });
    assert.notEqual(rel.status, 0);
    assert.match(rel.stderr, /absolute/);

    const ok = run(['--ref', 'herdr-v0.2.0'], { ...fx.env, HERDR_GENTLE_PLUGIN_ROOT: fx.pluginRoot });
    assert.equal(ok.status, 0, `absolute override must bypass malformed list: ${ok.stderr}`);
    assert.equal(readStateJson(fx.stateFile).ref, 'herdr-v0.2.0');
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
    assert.ok(fx.env.HOME.startsWith(fx.tmp), 'HOME must be inside the fixture');
    const r = run(['--ref', 'herdr-v0.2.0'], fx.env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(canary, 'utf8'), 'canary\n', 'sibling temp file untouched');
    assert.ok(!fs.existsSync(path.join(REPO_ROOT, 'installer-state')), 'no state leaked into repo');
  });
});
