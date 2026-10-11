'use strict';

// Regression tests for the release pipeline (installer-update-path, unit B).
//
// Fully offline and deterministic: each test spawns the real
// scripts/release-publish / scripts/release-verify with GH_TOKEN,
// RELEASE_TAG, RELEASE_COMMIT, RELEASE_REPOSITORY and a mock `gh` on PATH
// that logs argv and replays fixtures, in a temp directory containing a copy
// of install.sh.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PUBLISH = path.join(REPO_ROOT, 'scripts', 'release-publish');
const VERIFY = path.join(REPO_ROOT, 'scripts', 'release-verify');
const INSTALL_SH = path.join(REPO_ROOT, 'install.sh');

const MOCK_GH = `#!/bin/sh
log="\${GH_LOG:-/dev/null}"
printf '%s\\n' "$*" >>"$log"
if [ "\${1:-}" = "release" ] && [ "\${2:-}" = "view" ]; then
  case "\${MOCK_VIEW:-missing}" in
    missing) echo "release not found for tag \${RELEASE_TAG:-v0.2.0}" >&2; exit 1 ;;
    transient) echo "mock gh: API temporarily unavailable" >&2; exit 1 ;;
    term) kill -TERM $PPID; sleep 2; exit 0 ;;
    int) kill -INT $PPID; sleep 2; exit 0 ;;
    draft)
      printf '{"tagName":"%s","isDraft":true,"isPrerelease":false}\\n' "\${RELEASE_TAG:-v0.2.0}"
      exit 0 ;;
    published)
      printf '{"tagName":"%s","isDraft":false,"isPrerelease":false}\\n' "\${RELEASE_TAG:-v0.2.0}"
      exit 0 ;;
    prerelease)
      printf '{"tagName":"%s","isDraft":false,"isPrerelease":true}\\n' "\${RELEASE_TAG:-v0.2.0}"
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
  const ghPath = path.join(fakeBin, 'gh');
  fs.writeFileSync(ghPath, MOCK_GH, { mode: 0o755 });
  const workdir = path.join(tmp, 'work');
  fs.mkdirSync(workdir, { recursive: true });
  fs.copyFileSync(INSTALL_SH, path.join(workdir, 'install.sh'));
  const ghLog = path.join(tmp, 'gh.log');
  fs.writeFileSync(ghLog, '');
  const checksumCopy = path.join(tmp, 'checksum.copy');
  return { tmp, fakeBin, workdir, ghLog, checksumCopy };
}

function baseEnv(fx, overrides = {}) {
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.RELEASE_TAG;
  delete env.RELEASE_COMMIT;
  delete env.RELEASE_REPOSITORY;
  delete env.MOCK_VIEW;
  delete env.MOCK_CREATE;
  delete env.MOCK_UPLOAD;
  delete env.MOCK_DOWNLOAD;
  Object.assign(env, {
    PATH: `${fx.fakeBin}${path.delimiter}${process.env.PATH}`,
    GH_TOKEN: 'test-token',
    RELEASE_TAG: 'v0.2.0',
    RELEASE_COMMIT: 'abc123',
    GH_LOG: fx.ghLog,
    MOCK_CHECKSUM_COPY: fx.checksumCopy,
  }, overrides);
  return env;
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
  const raw = fs.readFileSync(fx.ghLog, 'utf8');
  return raw.split('\n').filter((l) => l.length > 0);
}

function createLines(fx) {
  return ghLogLines(fx).filter((l) => l.includes('release create'));
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

describe('release-publish asset wiring (blocker 2, part 1)', () => {
  it('create argv carries install.sh and install.sh.sha256, never a bare create', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { MOCK_VIEW: 'missing', MOCK_CREATE: 'ok' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    const creates = createLines(fx);
    assert.ok(creates.length >= 1, `expected a release create call, log:\n${ghLogLines(fx).join('\n')}`);
    for (const line of creates) {
      assert.ok(line.includes('install.sh'), `create must carry install.sh: ${line}`);
      const hasSha = line.split(' ').some((tok) => path.basename(tok) === 'install.sh.sha256');
      assert.ok(hasSha, `create must carry a path with basename install.sh.sha256: ${line}`);
    }
    assert.match(r.stdout, /published GitHub Release v0\.2\.0/);
  });

  it('checksum bytes equal sha256sum install.sh and no --clobber is used', (t) => {
    const fx = setup(t);
    const r = runPublish(fx, { MOCK_VIEW: 'missing', MOCK_CREATE: 'ok' });
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
    const r = runPublish(fx, { MOCK_VIEW: 'missing', MOCK_CREATE: 'fail' });
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
    assert.match(r.stderr, /v0\.2\.0/);
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
    assert.match(r.stdout, /published GitHub Release v0\.2\.0/);
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
    assert.match(r.stdout, /verified GitHub Release v0\.2\.0/);
  });

  it('sibling install.sh.sha256 asset does not change a matching verdict', (t) => {
    const fx = setup(t);
    const r = runVerify(fx, { MOCK_VIEW: 'published', MOCK_DOWNLOAD: 'match-with-sha256' });
    assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);
    assert.match(r.stdout, /verified GitHub Release v0\.2\.0/);
  });
});
