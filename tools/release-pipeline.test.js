'use strict';

// Regression tests for the per-package release pipeline (S4).
//
// Fully offline and deterministic: each test spawns the real
// scripts/release-preflight / scripts/release-publish / scripts/release-verify
// with RELEASE_TAG/RELEASE_COMMIT/RELEASE_REPOSITORY and mock binaries on
// PATH that log argv and replay fixtures, in an isolated temp workdir.
// Tag series: pi-vX.Y.Z (Pi npm package) and herdr-vX.Y.Z (Herdr plugin).
// The bare v* series is rejected.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PREFLIGHT = path.join(REPO_ROOT, 'scripts', 'release-preflight');
const PUBLISH = path.join(REPO_ROOT, 'scripts', 'release-publish');
const VERIFY = path.join(REPO_ROOT, 'scripts', 'release-verify');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');
const RELEASE_YML = path.join(REPO_ROOT, '.github', 'workflows', 'release.yml');

const PI_TAG = 'pi-v0.2.0';
const HERDR_TAG = 'herdr-v0.2.0';
const PI_VERSION = '0.2.0';

const MOCK_GH = `#!/bin/sh
log="\${GH_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  case "\${MOCK_VIEW:-missing}" in
    missing) echo "release not found for tag \${RELEASE_TAG:-herdr-v0.2.0}" >&2; exit 1 ;;
    transient) echo "mock gh: API temporarily unavailable" >&2; exit 1 ;;
    term) kill -TERM $PPID; sleep 2; exit 0 ;;
    int) kill -INT $PPID; sleep 2; exit 0 ;;
    draft)
      printf '{"tagName":"%s","isDraft":true,"isPrerelease":false}\\n' "\${RELEASE_TAG:-herdr-v0.2.0}"
      exit 0 ;;
    published)
      printf '{"tagName":"%s","isDraft":false,"isPrerelease":false}\\n' "\${RELEASE_TAG:-herdr-v0.2.0}"
      exit 0 ;;
    prerelease)
      printf '{"tagName":"%s","isDraft":false,"isPrerelease":true}\\n' "\${RELEASE_TAG:-herdr-v0.2.0}"
      exit 0 ;;
  esac
  exit 1
fi
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "create" ]; then
  for a in "$@"; do
    case "$a" in
      *.sha256)
        if [ -f "$a" ] && [ -n "\${MOCK_CHECKSUM_COPY:-}" ]; then
          cp "$a" "$MOCK_CHECKSUM_COPY" 2>/dev/null || true
        fi
        ;;
    esac
  done
  case "\${MOCK_CREATE:-ok}" in
    ok) exit 0 ;;
    fail) echo "mock gh: create failed" >&2; exit 1 ;;
    term) kill -TERM $PPID; sleep 2; exit 0 ;;
    int) kill -INT $PPID; sleep 2; exit 0 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "upload" ]; then
  case "\${MOCK_UPLOAD:-ok}" in
    ok) exit 0 ;;
    fail) echo "mock gh: upload failed" >&2; exit 1 ;;
    term) kill -TERM $PPID; sleep 2; exit 0 ;;
    int) kill -INT $PPID; sleep 2; exit 0 ;;
  esac
  exit 0
fi
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "delete" ]; then
  exit 0
fi
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "download" ]; then
  dir=""
  prev=""
  for a in "$@"; do
    if [ "$prev" = "--dir" ]; then dir="$a"; fi
    prev="$a"
  done
  case "\${MOCK_DOWNLOAD:-match}" in
    match) cp install.sh "$dir/install.sh"; exit 0 ;;
    match-with-sha256) cp install.sh "$dir/install.sh"; printf 'deadbeef  install.sh\\n' > "$dir/install.sh.sha256"; exit 0 ;;
    mismatch) printf 'different content for mismatch\\n' > "$dir/install.sh"; exit 0 ;;
    missing) exit 0 ;;
    fail) echo "mock gh: download failed" >&2; exit 1 ;;
    term) kill -TERM $PPID; sleep 2; cp install.sh "$dir/install.sh" 2>/dev/null || true; exit 0 ;;
    int) kill -INT $PPID; sleep 2; cp install.sh "$dir/install.sh" 2>/dev/null || true; exit 0 ;;
  esac
  exit 0
fi
echo "mock gh: unknown command $*" >&2
exit 1
`;

const MOCK_NPM = `#!/bin/sh
log="\${NPM_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
if [ "\${1:-}" = "pack" ]; then
  if printf '%s\\n' "$*" | grep -q -- "--json"; then
    printf '%s\\n' "\${MOCK_PACK_JSON:-[]}"
    exit "\${MOCK_PACK_EXIT:-0}"
  fi
  echo "mock npm pack dry-run ok"
  exit "\${MOCK_PACK_EXIT:-0}"
fi
if [ "\${1:-}" = "view" ]; then
  printf '%s\\n' "\${MOCK_NPM_VIEW:-0.2.0}"
  exit "\${MOCK_NPM_VIEW_EXIT:-0}"
fi
if [ "\${1:-}" = "publish" ]; then
  exit "\${MOCK_NPM_PUBLISH_EXIT:-0}"
fi
echo "mock npm: unknown command $*" >&2
exit 1
`;

const MOCK_SHELLCHECK = `#!/bin/sh
log="\${SHELLCHECK_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
exit "\${MOCK_SHELLCHECK_EXIT:-0}"
`;

function goodPackJson() {
  return JSON.stringify([{
    id: 'mock@0.2.0',
    name: 'mock',
    version: '0.2.0',
    filename: 'mock-0.2.0.tgz',
    files: [
      { path: 'package.json' },
      { path: 'extensions/gentle-herdr-state.ts' },
      { path: 'bin/gentle-sidebar.js' },
      { path: 'lib/gentle-sidebar.js' },
    ],
  }]);
}

function badPackJson(extraPath) {
  return JSON.stringify([{
    id: 'mock@0.2.0',
    name: 'mock',
    version: '0.2.0',
    filename: 'mock-0.2.0.tgz',
    files: [
      { path: 'package.json' },
      { path: 'extensions/gentle-herdr-state.ts' },
      { path: extraPath },
    ],
  }]);
}

function missingExtPackJson() {
  return JSON.stringify([{
    id: 'mock@0.2.0',
    name: 'mock',
    version: '0.2.0',
    filename: 'mock-0.2.0.tgz',
    files: [{ path: 'package.json' }, { path: 'bin/gentle-sidebar.js' }],
  }]);
}

function setup(t) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'herdr-release-test-'));
  t.after(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });
  const fakeBin = path.join(tmp, 'fakebin');
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(fakeBin, 'gh'), MOCK_GH, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'npm'), MOCK_NPM, { mode: 0o755 });
  fs.writeFileSync(path.join(fakeBin, 'shellcheck'), MOCK_SHELLCHECK, { mode: 0o755 });
  const workdir = path.join(tmp, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  fs.copyFileSync(INSTALL_SH, path.join(workdir, 'install.sh'));
  const ghLog = path.join(tmp, 'gh.log');
  fs.writeFileSync(ghLog, '');
  const npmLog = path.join(tmp, 'npm.log');
  fs.writeFileSync(npmLog, '');
  const checksumCopy = path.join(tmp, 'checksum.copy');
  return { tmp, fakeBin, workdir, ghLog, npmLog, checksumCopy };
}

// Minimal preflight fixture: real node/python3/sh gates run against these
// files while npm and shellcheck stay stubbed.
function setupPreflight(t, { pkgVersion = PI_VERSION, tomlVersion = PI_VERSION } = {}) {
  const fx = setup(t);
  const w = fx.workdir;
  fs.writeFileSync(path.join(w, 'package.json'), JSON.stringify({ name: 'x', version: pkgVersion }));
  fs.mkdirSync(path.join(w, 'herdr-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(w, 'herdr-plugin', 'herdr-plugin.toml'),
    `id = "herdr-gentle-agents"\nname = "Herdr Gentle Agents"\nversion = "${tomlVersion}"\nmin_herdr_version = "0.9.4"\n`,
  );
  for (const dir of ['bin', 'lib', path.join('herdr-plugin', 'bin'), path.join('herdr-plugin', 'lib'), 'tools']) {
    fs.mkdirSync(path.join(w, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(w, 'bin', 'a.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(w, 'lib', 'a.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(w, 'herdr-plugin', 'bin', 'a.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(w, 'herdr-plugin', 'lib', 'a.js'), 'console.log(1);\n');
  fs.writeFileSync(path.join(w, 'tools', 'pass.test.js'), "const { it } = require('node:test');\nit('passes', () => {});\n");
  return fx;
}

function baseEnv(fx, overrides = {}) {
  const env = { ...process.env };
  for (const k of [
    'GH_TOKEN', 'RELEASE_TAG', 'RELEASE_COMMIT', 'RELEASE_REPOSITORY',
    'MOCK_VIEW', 'MOCK_CREATE', 'MOCK_UPLOAD', 'MOCK_DOWNLOAD',
    'MOCK_PACK_JSON', 'MOCK_PACK_EXIT', 'MOCK_NPM_VIEW', 'MOCK_NPM_VIEW_EXIT',
    'MOCK_SHELLCHECK_EXIT',
  ]) delete env[k];
  Object.assign(env, {
    PATH: `${fx.fakeBin}${path.delimiter}${process.env.PATH}`,
    GH_TOKEN: 'test-token',
    RELEASE_TAG: HERDR_TAG,
    RELEASE_COMMIT: 'abc123',
    GH_LOG: fx.ghLog,
    NPM_LOG: fx.npmLog,
    MOCK_CHECKSUM_COPY: fx.checksumCopy,
    MOCK_PACK_JSON: goodPackJson(),
  }, overrides);
  return env;
}

function runPreflight(fx, overrides = {}) {
  return spawnSync('sh', [PREFLIGHT], {
    encoding: 'utf8',
    env: baseEnv(fx, overrides),
    cwd: fx.workdir,
  });
}

function runPublish(fx, overrides = {}) {
  return spawnSync('sh', [PUBLISH], {
    encoding: 'utf8',
    env: baseEnv(fx, overrides),
    cwd: fx.workdir,
  });
}

function runVerify(fx, overrides = {}) {
  return spawnSync('sh', [VERIFY], {
    encoding: 'utf8',
    env: baseEnv(fx, overrides),
    cwd: fx.workdir,
  });
}

function ghLogLines(fx) {
  return fs.readFileSync(fx.ghLog, 'utf8').split('\n').filter((l) => l.length > 0);
}

function npmLogLines(fx) {
  return fs.readFileSync(fx.npmLog, 'utf8').split('\n').filter((l) => l.length > 0);
}

function createLines(fx) {
  return ghLogLines(fx).filter((l) => l.includes('release create'));
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('release tag series (S4)', () => {
  for (const script of [['preflight', runPreflight], ['publish', runPublish], ['verify', runVerify]]) {
    it(`${script[0]} accepts pi-vX.Y.Z`, (t) => {
      const fx = script[0] === 'preflight' ? setupPreflight(t) : setup(t);
      const tag = PI_TAG;
      const extra = script[0] === 'verify' ? { MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'match' } : { MOCK_VIEW: 'missing', MOCK_CREATE: 'ok' };
      const r = script[1](fx, { RELEASE_TAG: tag, ...extra });
      assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    });
    it(`${script[0]} accepts herdr-vX.Y.Z`, (t) => {
      const fx = script[0] === 'preflight' ? setupPreflight(t) : setup(t);
      const extra = script[0] === 'verify' ? { MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'match' } : { MOCK_VIEW: 'missing', MOCK_CREATE: 'ok' };
      const r = script[1](fx, { RELEASE_TAG: HERDR_TAG, ...extra });
      assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    });
  }

  it('preflight rejects the bare v* series naming both series', (t) => {
    const fx = setupPreflight(t);
    const r = runPreflight(fx, { RELEASE_TAG: 'v0.2.0' });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /pi-vX\.Y\.Z/);
    assert.match(r.stderr, /herdr-vX\.Y\.Z/);
  });

  it('publish rejects prerelease tags naming both series', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { RELEASE_TAG: 'pi-v0.2.0-rc.1' });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /pi-vX\.Y\.Z/);
    assert.match(r.stderr, /herdr-vX\.Y\.Z/);
  });

  it('verify rejects build-metadata tags naming both series', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { RELEASE_TAG: 'herdr-v0.2.0+build' });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /pi-vX\.Y\.Z/);
    assert.match(r.stderr, /herdr-vX\.Y\.Z/);
  });

  it('publish rejects garbage tags with a non-zero exit', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { RELEASE_TAG: 'latest' });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /RELEASE_TAG/);
  });
});

describe('preflight per-series version gate (S4)', () => {
  it('pi tag must equal package.json version', (t) => {
    const fx = setupPreflight(t, { pkgVersion: '9.9.9', tomlVersion: PI_VERSION });
    const r = runPreflight(fx, { RELEASE_TAG: PI_TAG });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /package\.json/);
  });

  it('herdr tag must equal herdr-plugin.toml version', (t) => {
    const fx = setupPreflight(t, { pkgVersion: PI_VERSION, tomlVersion: '9.9.9' });
    const r = runPreflight(fx, { RELEASE_TAG: HERDR_TAG });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /herdr-plugin\.toml/);
  });

  it('pi tag ignores a mismatching manifest version', (t) => {
    const fx = setupPreflight(t, { pkgVersion: PI_VERSION, tomlVersion: '9.9.9' });
    const r = runPreflight(fx, { RELEASE_TAG: PI_TAG });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  });

  it('herdr tag ignores a mismatching package.json version', (t) => {
    const fx = setupPreflight(t, { pkgVersion: '9.9.9', tomlVersion: PI_VERSION });
    const r = runPreflight(fx, { RELEASE_TAG: HERDR_TAG });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
  });
});

describe('preflight tarball surface (S4)', () => {
  for (const bad of ['herdr-plugin/bin/configure.js', 'tools/x.js', 'scripts/release-preflight', 'odd/tasks/notes.md']) {
    it(`tarball containing ${bad} fails`, (t) => {
      const fx = setupPreflight(t);
      const r = runPreflight(fx, { RELEASE_TAG: PI_TAG, MOCK_PACK_JSON: badPackJson(bad) });
      assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
      assert.match(r.stderr, new RegExp(bad.split('/')[0]));
    });
  }

  it('tarball missing extensions/gentle-herdr-state.ts fails', (t) => {
    const fx = setupPreflight(t);
    const r = runPreflight(fx, { RELEASE_TAG: PI_TAG, MOCK_PACK_JSON: missingExtPackJson() });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /extensions\/gentle-herdr-state\.ts/);
  });

  it('clean tarball passes and npm pack ran with --dry-run', (t) => {
    const fx = setupPreflight(t);
    const r = runPreflight(fx, { RELEASE_TAG: PI_TAG, MOCK_PACK_JSON: goodPackJson() });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const log = npmLogLines(fx).join('\n');
    assert.ok(log.includes('pack'), `npm pack must run, log:\n${log}`);
    assert.ok(log.includes('--dry-run'), `npm pack must use --dry-run, log:\n${log}`);
  });
});

describe('release-publish asset wiring (blocker 2, part 1)', () => {
  it('create argv carries install.sh and install.sh.sha256, never a bare create', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { RELEASE_TAG: HERDR_TAG, MOCK_VIEW: 'missing', MOCK_CREATE: 'ok' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const creates = createLines(fx);
    assert.ok(creates.length >= 1, `expected a release create call, log:\n${ghLogLines(fx).join('\n')}`);
    for (const line of creates) {
      assert.ok(line.includes('install.sh'), `create must carry install.sh: ${line}`);
      const hasSha = line.split(' ').some((tok) => path.basename(tok) === 'install.sh.sha256');
      assert.ok(hasSha, `create must carry a path with basename install.sh.sha256: ${line}`);
    }
    assert.match(r.stdout, /published GitHub Release herdr-v0\.2\.0/);
  });

  it('pi series also publishes the installer assets', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { RELEASE_TAG: PI_TAG, MOCK_VIEW: 'missing', MOCK_CREATE: 'ok' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const creates = createLines(fx);
    assert.equal(creates.length, 1, `expected one create, log:\n${ghLogLines(fx).join('\n')}`);
    assert.ok(creates[0].includes('install.sh'), `create must carry install.sh: ${creates[0]}`);
    assert.ok(creates[0].split(' ').some((tok) => path.basename(tok) === 'install.sh.sha256'), `create must carry sha256: ${creates[0]}`);
    assert.match(r.stdout, /published GitHub Release pi-v0\.2\.0/);
  });

  it('checksum bytes equal sha256sum install.sh and no --clobber is used', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { RELEASE_TAG: HERDR_TAG, MOCK_VIEW: 'missing', MOCK_CREATE: 'ok' });
    assert.equal(r.status, 0, r.stderr);
    const expected = fs.readFileSync(path.join(fx.workdir, 'install.sh'));
    const expectedLine = `${sha256File(path.join(fx.workdir, 'install.sh'))}  install.sh\n`;
    assert.ok(fs.existsSync(fx.checksumCopy), 'mock must have captured the sha256 file passed to create');
    assert.equal(fs.readFileSync(fx.checksumCopy, 'utf8'), expectedLine);
    assert.ok(expected.length > 0);
    const fullLog = ghLogLines(fx).join('\n');
    assert.ok(!fullLog.includes('--clobber'), `--clobber must never appear:\n${fullLog}`);
  });

  it('create failure exits 1 and uploads nothing', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { RELEASE_TAG: HERDR_TAG, MOCK_VIEW: 'missing', MOCK_CREATE: 'fail' });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(!r.stdout.includes('published GitHub Release'), 'success line must not print on failure');
    const fullLog = ghLogLines(fx).join('\n');
    assert.ok(!fullLog.includes('release upload'), `no upload may run after a failed create:\n${fullLog}`);
  });
});

describe('release-publish signals are fatal (blocker 1)', () => {
  it('SIGTERM during create exits non-zero without the success line', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { MOCK_VIEW: 'missing', MOCK_CREATE: 'term' });
    assert.notEqual(r.status, 0, `signal must be fatal, got rc=${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(!r.stdout.includes('published GitHub Release'), `success line must never print, got: ${r.stdout}`);
  });

  it('SIGINT during create exits non-zero without the success line', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { MOCK_VIEW: 'missing', MOCK_CREATE: 'int' });
    assert.notEqual(r.status, 0, `signal must be fatal, got rc=${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(!r.stdout.includes('published GitHub Release'), `success line must never print, got: ${r.stdout}`);
  });

  it('SIGTERM during verify download exits 143 without the success line', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'term' });
    assert.equal(r.status, 143, `signal must exit 143, got rc=${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(!r.stdout.includes('verified GitHub Release'), `success line must never print, got: ${r.stdout}`);
  });

  it('SIGINT during view must not verify', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { MOCK_VIEW: 'int', MOCK_DOWNLOAD: 'match' });
    assert.notEqual(r.status, 0, `signal during view must be fatal, got rc=${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(!r.stdout.includes('verified GitHub Release'), `success line must never print, got: ${r.stdout}`);
    const realFailure = r.stderr.includes('gh release view') || r.status === 130 || r.status === 143;
    assert.ok(realFailure, `view signal must report the real view failure (gh release view message or signal status 130/143), got rc=${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
  });

  it('SIGTERM during view must not publish', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { MOCK_VIEW: 'term', MOCK_CREATE: 'ok' });
    assert.notEqual(r.status, 0, `signal during view must be fatal, got rc=${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(!r.stdout.includes('published GitHub Release'), `success line must never print, got: ${r.stdout}`);
    const realFailure = r.stderr.includes('gh release view') || r.status === 130 || r.status === 143;
    assert.ok(realFailure, `view signal must report the real view failure (gh release view message or signal status 130/143), got rc=${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
  });

  it('transient view failure fails closed with no create call', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { MOCK_VIEW: 'transient', MOCK_CREATE: 'ok' });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.ok(!r.stdout.includes('published GitHub Release'), 'success line must not print on view failure');
    assert.match(r.stderr, /gh release view/);
    assert.match(r.stderr, /herdr-v0\.2\.0/);
    assert.equal(createLines(fx).length, 0, `no create may run after a failing view, log:\n${ghLogLines(fx).join('\n')}`);
  });
});

describe('release-publish existing-release repair path (blocker 2, part 2)', () => {
  it('existing draft is deleted without --cleanup-tag and recreated with assets', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { MOCK_VIEW: 'draft', MOCK_CREATE: 'ok' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const lines = ghLogLines(fx);
    const deletes = lines.filter((l) => l.includes('release delete'));
    assert.equal(deletes.length, 1, `expected one delete, log:\n${lines.join('\n')}`);
    assert.ok(deletes[0].includes('--yes') || deletes[0].includes('-y'), `delete must skip the prompt: ${deletes[0]}`);
    assert.ok(!lines.join('\n').includes('--cleanup-tag'), 'pushed tag must survive: never --cleanup-tag');
    const creates = createLines(fx);
    assert.equal(creates.length, 1, `expected recreation, log:\n${lines.join('\n')}`);
    assert.ok(creates[0].includes('install.sh'), `recreate must carry assets: ${creates[0]}`);
    assert.ok(creates[0].split(' ').some((tok) => path.basename(tok) === 'install.sh.sha256'), `recreate must carry sha256: ${creates[0]}`);
    assert.match(r.stdout, /published GitHub Release herdr-v0\.2\.0/);
  });

  it('existing published release refuses with the guard and uploads nothing', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { MOCK_VIEW: 'published', MOCK_CREATE: 'ok' });
    assert.equal(r.status, 1, `expected exit 1, got ${r.status}: stdout=${r.stdout} stderr=${r.stderr}`);
    assert.match(r.stderr, /refusing to overwrite/);
    assert.ok(!r.stdout.includes('published GitHub Release'), 'success line must not print on refusal');
    const fullLog = ghLogLines(fx).join('\n');
    assert.ok(!fullLog.includes('release upload'), `no upload on refusal:\n${fullLog}`);
    assert.ok(!fullLog.includes('release create'), `no recreate on refusal:\n${fullLog}`);
  });
});

describe('release-verify verdicts', () => {
  it('draft release exits 1', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { MOCK_VIEW: 'draft', MOCK_DOWNLOAD: 'match' });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /is a draft/);
  });

  it('prerelease exits 1', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { MOCK_VIEW: 'prerelease', MOCK_DOWNLOAD: 'match' });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /prerelease/);
  });

  it('missing install.sh asset exits 1', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'missing' });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /not found|asset/);
  });

  it('sha256 mismatch exits 1', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'mismatch' });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /mismatch/);
  });

  it('matching asset exits 0', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'match' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /verified GitHub Release herdr-v0\.2\.0/);
  });

  it('sibling install.sh.sha256 asset does not change a matching verdict', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'match-with-sha256' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /verified GitHub Release herdr-v0\.2\.0/);
  });

  it('pi series checks the published npm version with exact argv', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { RELEASE_TAG: PI_TAG, MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'match', MOCK_NPM_VIEW: '0.2.0' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /verified GitHub Release pi-v0\.2\.0/);
    const npmLog = npmLogLines(fx).join('\n');
    assert.ok(npmLog.includes('view'), `npm view must run, log:\n${npmLog}`);
    assert.ok(npmLog.includes('@jonasotoaguilar/herdr-gentle-agents@0.2.0'), `npm view must target the pinned version, log:\n${npmLog}`);
  });

  it('pi series fails when the npm version mismatches', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { RELEASE_TAG: PI_TAG, MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'match', MOCK_NPM_VIEW: '0.1.0' });
    assert.equal(r.status, 1, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stderr, /npm/);
    assert.ok(!r.stdout.includes('verified GitHub Release'), 'success line must not print on npm mismatch');
  });

  it('herdr series never calls npm view', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { RELEASE_TAG: HERDR_TAG, MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'match' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.equal(npmLogLines(fx).length, 0, `npm must not run for herdr tags, log:\n${npmLogLines(fx).join('\n')}`);
  });
});

describe('release workflow npm routing (S4)', () => {
  const yml = () => fs.readFileSync(RELEASE_YML, 'utf8');

  it('triggers on both series and ends the bare v* series', (t) => {
    void t;
    const y = yml();
    assert.ok(y.includes('pi-v*'), 'workflow must trigger on pi-v*');
    assert.ok(y.includes('herdr-v*'), 'workflow must trigger on herdr-v*');
    assert.ok(!y.match(/^\s*-\s*"v\*"/m), 'bare v* trigger must be gone');
  });

  it('gates npm publish to the pi series with the registry token', (t) => {
    void t;
    const y = yml();
    assert.ok(y.includes("startsWith(github.ref_name, 'pi-v')"), 'npm publish must be gated on pi-v');
    assert.ok(y.includes('NPM_TOKEN'), 'workflow must use the NPM_TOKEN secret');
    assert.ok(y.includes('NODE_AUTH_TOKEN'), 'workflow must pass the token via NODE_AUTH_TOKEN');
    assert.ok(y.includes('registry-url: https://registry.npmjs.org'), 'workflow must set the npm registry');
    assert.ok(y.includes('npm publish --access public'), 'workflow must publish with public access');
  });

  it('fails closed with a clear message when the token is absent', (t) => {
    void t;
    const y = yml();
    assert.match(y, /NPM_TOKEN.*required|required.*NPM_TOKEN/i);
  });

  it('never publishes to npm on a herdr tag', (t) => {
    void t;
    const y = yml();
    const cmds = y.split('\n').filter((l) => /^\s*npm publish --access public\s*$/.test(l));
    assert.equal(cmds.length, 1, `exactly one npm publish command, got ${cmds.length}`);
    const before = y.slice(0, y.indexOf(cmds[0]));
    const gateIdx = before.lastIndexOf("startsWith(github.ref_name, 'pi-v')");
    assert.ok(gateIdx !== -1, 'the single npm publish must sit under the pi-v gate');
    assert.ok(!before.includes("startsWith(github.ref_name, 'herdr-v')"), 'no npm publish may sit under a herdr gate');
  });
});
