'use strict';
// T3 lifecycle/recovery/interruption tests (odd/tasks/supervision-diagnostics.md).
//
// Isolation contract: every test builds a temp sandbox (state dir, agents
// file, panes file, meta log, fake `herdr` binary) and drives the real
// daemon binary (`bin/gentle-status.js`) with GENTLE_STATUS_STATE_DIR and
// HERDR_BIN_PATH pointed at the sandbox. HOME/XDG/HERDR_CONFIG_PATH are
// also pinned inside the sandbox and HERDR_SOCKET_PATH points at a
// nonexistent file, so the socket transport always degrades to the CLI
// fallback; every Herdr call is served by the fake binary. No live daemon,
// token publish, or global Herdr state is ever touched. The daemon under
// test polls at a 250 ms floor (GENTLE_STATUS_POLL_MS) so multi-frame
// assertions stay finite; every wait is deadline-bounded.
//
// Teardown discipline (C1 incident: detached fixture daemons outlived the
// suite because a missing pidfile was read as success): every daemon a
// case may have created — tracked child handle or detached pid via the
// pidfile — is signalled and awaited dead before its state dir is
// deleted. A missing pidfile after an async spawn is waited on bounded,
// never assumed clean. Only pids proven to be this run's fixture daemons
// (argv is this repo's daemon in --run mode AND environ pins
// GENTLE_STATUS_STATE_DIR under a sandbox root from this run) are ever
// signalled; anything else is a cleanup refusal, never bypassed. An
// end-of-run audit fails the suite if any owned fixture daemon remains.

const { describe, it, beforeEach, afterEach, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DAEMON = path.join(REPO_ROOT, 'herdr-plugin', 'bin', 'gentle-status.js');
const contract = require('../herdr-plugin/lib/gentle-tokens.js');

const FAKE_HERDR = `#!/bin/sh
# Fake herdr for lifecycle tests: replays canned agent/pane JSON, logs
# every report-metadata call, optionally fails list reads.
if [ "$1" = "agent" ] && [ "$2" = "list" ]; then
  if [ -n "$AGENTS_FAIL" ] && [ -f "$AGENTS_FAIL" ]; then exit 1; fi
  cat "$AGENTS_FILE"
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "list" ]; then
  if [ -n "$PANES_FAIL" ] && [ -f "$PANES_FAIL" ]; then exit 1; fi
  cat "$PANES_FILE"
  exit 0
fi
if [ "$1" = "pane" ] && [ "$2" = "report-metadata" ]; then
  if [ -n "$REPORT_FAIL" ] && [ -f "$REPORT_FAIL" ]; then exit 1; fi
  printf -- '---META--- %s :: %s\\n' "$3" "$*" >>"$META_LOG"
  printf '{"ok":true}\\n'
  exit 0
fi
echo "fake-herdr: unknown command $*" >&2
exit 1
`;

let sandbox = null;
let daemonChild = null; // tracked --run child handle for the active case
let caseMayHaveSpawned = false; // set when a CLI call reports `daemon started`
const sandboxRoots = []; // every {root, stateDir} created this run (orphan-audit scope)
const ownedDaemonPids = []; // every fixture daemon pid learned this run (orphan-audit scope)

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gentle-lifecycle-'));
  const stateDir = path.join(root, 'state');
  const workDir = path.join(root, 'work');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });
  const fake = path.join(root, 'herdr-fake.sh');
  fs.writeFileSync(fake, FAKE_HERDR, { mode: 0o755 });
  const sb = {
    root,
    stateDir,
    workDir,
    fake,
    agentsFile: path.join(root, 'agents.json'),
    panesFile: path.join(root, 'panes.json'),
    metaLog: path.join(root, 'meta.log'),
    agentsFail: path.join(root, 'agents-fail'),
    panesFail: path.join(root, 'panes-fail'),
    reportFail: path.join(root, 'report-fail'),
    socketPath: path.join(root, 'no-such-herdr.sock'),
  };
  fs.writeFileSync(sb.agentsFile, '{"result":{"agents":[]}}\n');
  fs.writeFileSync(sb.panesFile, '{"result":{"panes":[]}}\n');
  fs.writeFileSync(sb.metaLog, '');
  sandboxRoots.push({ root: sb.root, stateDir: sb.stateDir });
  return sb;
}

function sandboxEnv(sb, extra = {}) {
  return {
    ...process.env,
    // Pin every ambient resolution inside the sandbox: state, sockets,
    // config lookups, and HOME (git/cwd probes) never reach live paths.
    HOME: sb.root,
    XDG_STATE_HOME: path.join(sb.root, 'xdg-state'),
    XDG_CONFIG_HOME: path.join(sb.root, 'xdg-config'),
    HERDR_CONFIG_PATH: path.join(sb.root, 'no-herdr-config.toml'),
    HERDR_BIN_PATH: sb.fake,
    HERDR_SOCKET_PATH: sb.socketPath,
    GENTLE_STATUS_STATE_DIR: sb.stateDir,
    GENTLE_STATUS_POLL_MS: '250',
    AGENTS_FILE: sb.agentsFile,
    PANES_FILE: sb.panesFile,
    META_LOG: sb.metaLog,
    AGENTS_FAIL: sb.agentsFail,
    PANES_FAIL: sb.panesFail,
    REPORT_FAIL: sb.reportFail,
    ...extra,
  };
}

function runCli(sb, args, extraEnv = {}) {
  const result = spawnSync(process.execPath, [DAEMON, ...args], {
    encoding: 'utf8',
    timeout: 15000,
    env: sandboxEnv(sb, extraEnv),
  });
  // `daemon started` means a detached daemon was just spawned into this
  // sandbox asynchronously: its pidfile may not exist yet, so teardown
  // must wait for it bounded instead of reading absence as success.
  if (typeof result.stdout === 'string' && result.stdout.includes('daemon started')) {
    caseMayHaveSpawned = true;
  }
  return result;
}

function startDaemon(sb) {
  daemonChild = spawn(process.execPath, [DAEMON, '--run'], {
    env: sandboxEnv(sb),
    stdio: 'ignore',
    windowsHide: true,
  });
  return daemonChild;
}

function pidFile(sb) {
  return path.join(sb.stateDir, 'gentle-status.pid');
}

function interruptionsFile(sb) {
  return path.join(sb.stateDir, 'gentle-interruptions.json');
}

function refreshFile(sb) {
  return path.join(sb.stateDir, 'gentle-status.refresh');
}

function readPid(sb) {
  try {
    const pid = Number(fs.readFileSync(pidFile(sb), 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(label, fn, timeoutMs = 4000) {
  const start = Date.now();
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitGone(pid, timeoutMs) {
  const start = Date.now();
  for (;;) {
    if (!pidAlive(pid)) return true;
    if (Date.now() - start > timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

function procCmdlineParts(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
  } catch {
    return null;
  }
}

function procStateDir(pid) {
  // Only the single owned marker is read, never a whole-env dump, and
  // only for pids whose argv already matches our daemon (callers gate on
  // this except in the final audit scan, which reads environ solely for
  // argv-matching candidates).
  try {
    const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
    const m = /GENTLE_STATUS_STATE_DIR=([^\0]*)/.exec(env);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// Ownership proof for a kill-by-number: argv must be this repo's daemon
// script in --run mode AND its environ must pin GENTLE_STATUS_STATE_DIR
// under a sandbox root from this run. The test runner, decoy/user
// processes, the installed daemon (different script path), and recycled
// pids all fail at least one check and are refused, never signalled.
// Unprovable (no /proc) is also a refusal.
function isOwnedFixtureDaemon(pid, roots) {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) return false;
  const parts = procCmdlineParts(pid);
  if (!parts || !parts.includes('--run') || !parts.some((p) => p === DAEMON)) return false;
  const dir = procStateDir(pid);
  if (dir === null) return false;
  return roots.some(({ root, stateDir }) => dir === stateDir || dir.startsWith(root + path.sep));
}

async function terminateVerified(pid, roots, what) {
  ownedDaemonPids.push(pid);
  if (!isOwnedFixtureDaemon(pid, roots)) {
    throw new Error(
      `cleanup refusal: ${what} pid ${pid} is not a verified fixture daemon; refusing to signal`,
    );
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return; // Exited between verification and signal; waitGone confirms.
  }
  if (await waitGone(pid, 5000)) return;
  // Re-verify before escalating: the pid may have been recycled while awaiting exit.
  if (!isOwnedFixtureDaemon(pid, roots)) {
    throw new Error(
      `cleanup refusal: ${what} pid ${pid} no longer verifies as a fixture daemon; refusing SIGKILL`,
    );
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  if (!(await waitGone(pid, 5000))) {
    throw new Error(`cleanup failed: fixture daemon pid ${pid} (${what}) still alive after SIGKILL`);
  }
}

async function stopCaseDaemons(sb) {
  const roots = [{ root: sb.root, stateDir: sb.stateDir }];
  // (a) Tracked child handle: our own spawn, safe to signal by handle.
  // Never signalled by number, so pid recycling cannot redirect it.
  try {
    if (daemonChild && daemonChild.exitCode === null) {
      const pid = daemonChild.pid;
      if (pid) ownedDaemonPids.push(pid);
      daemonChild.kill('SIGTERM');
      let gone = await waitGone(pid, 5000);
      if (!gone) {
        daemonChild.kill('SIGKILL');
        gone = await waitGone(pid, 5000);
      }
      if (!gone) throw new Error(`cleanup failed: tracked daemon child pid ${pid} still alive`);
    }
  } finally {
    daemonChild = null;
  }
  // (b) Detached daemons (spawned by --refresh/no-args ensure-running)
  // surface only via the pidfile, asynchronously. A missing pidfile here
  // proves nothing on its own, so when this case may have spawned one,
  // wait bounded before concluding.
  let pid = null;
  if (caseMayHaveSpawned) {
    try {
      pid = await waitFor('teardown pidfile for async-spawned daemon', () => readPid(sb), 8000);
    } catch {
      pid = readPid(sb);
    }
  } else {
    pid = readPid(sb);
  }
  if (pid !== null) {
    await terminateVerified(pid, roots, 'pidfile');
  } else if (caseMayHaveSpawned) {
    throw new Error(
      'cleanup failed: case may have spawned a daemon asynchronously but no pidfile appeared; refusing to assume success',
    );
  }
  // (c) Case-level proof before the state dir is deleted: a live pid in
  // our pidfile must be either already reaped or verified-and-stopped.
  const leftover = readPid(sb);
  if (leftover !== null && pidAlive(leftover)) {
    await terminateVerified(leftover, roots, 'leftover pidfile');
  }
}

function sessionPath(sb, name) {
  return path.join(sb.root, `session-${name}`);
}

function workerEntry(sb, session, { paneId = 'pane-1', count = 1, roles = 'worker' } = {}) {
  const entry = {
    pane_id: paneId,
    agent_session: { agent: 'pi', kind: 'path', value: session },
    agent_status: 'unknown',
    tokens: { gentle_roles_v1: roles },
    group: 'myproj',
    cwd: sb.workDir,
    foreground_cwd: sb.workDir,
  };
  const hash = contract.expectedSessionHash(entry);
  assert.match(hash, /^[A-Za-z0-9_-]{43}$/);
  entry.tokens.gentle_work_v1 = `${hash}:${count}:${Date.now() + 30000}`;
  return { entry, hash };
}

function writeAgents(sb, agents) {
  fs.writeFileSync(sb.agentsFile, `${JSON.stringify({ result: { agents } })}\n`);
}

function writePanes(sb, panes) {
  fs.writeFileSync(sb.panesFile, `${JSON.stringify({ result: { panes } })}\n`);
}

function metaCalls(sb) {
  try {
    return fs.readFileSync(sb.metaLog, 'utf8').split('\n').filter((l) => l.startsWith('---META---'));
  } catch {
    return [];
  }
}

function readInterruptions(sb) {
  try {
    return JSON.parse(fs.readFileSync(interruptionsFile(sb), 'utf8'));
  } catch {
    return null;
  }
}

function sidebarModeFile(sb) {
  return path.join(sb.stateDir, 'gentle-sidebar-mode.json');
}

function metaSets(sb) {
  return metaCalls(sb).filter((l) => l.includes(' --token gentle_'));
}

beforeEach(() => {
  sandbox = makeSandbox();
  daemonChild = null;
  caseMayHaveSpawned = false;
});

afterEach(async () => {
  if (sandbox) await stopCaseDaemons(sandbox);
  try {
    if (sandbox?.root) fs.rmSync(sandbox.root, { recursive: true, force: true });
  } catch {
    // Best-effort test hygiene; never fail the test on cleanup.
  }
  sandbox = null;
});

after(async () => {
  // End-of-run orphan audit: any live process whose argv is this repo's
  // daemon in --run mode and whose environ pins a sandbox state dir from
  // this run is a leaked fixture daemon. Failing here fails the suite,
  // so a green run proves no fixture daemons outlived it. Environ is read
  // only for argv-matching candidates; nothing is signalled by this audit.
  let entries = [];
  try {
    entries = fs.readdirSync('/proc');
  } catch {
    return; // No /proc: audit is vacuous on this platform.
  }
  const orphans = [];
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    if (pid === process.pid) continue;
    const parts = procCmdlineParts(pid);
    if (!parts || !parts.includes('--run') || !parts.some((p) => p === DAEMON)) continue;
    const dir = procStateDir(pid);
    if (dir === null) continue;
    if (!sandboxRoots.some(({ root, stateDir }) => dir === stateDir || dir.startsWith(root + path.sep))) continue;
    if (pidAlive(pid)) orphans.push(pid);
  }
  assert.deepEqual(orphans, [], `orphaned fixture daemons after suite: ${orphans.join(',')}`);
});

describe('lifecycle --refresh', () => {
  it('--refresh on a dead daemon recovers it and requests a coalesced refresh', async () => {
    assert.equal(readPid(sandbox), null);
    const result = runCli(sandbox, ['--refresh']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /daemon started/);
    assert.match(result.stdout, /refresh requested/);
    assert.equal(result.stderr, '');
    const pid = await waitFor('daemon pidfile after --refresh', () => readPid(sandbox));
    assert.ok(pidAlive(pid), 'recovered daemon must be alive');
    // The daemon consumes the coalesced request promptly; no second writer
    // loop is spawned by the --refresh call itself.
    await waitFor('refresh request consumed', () => !fs.existsSync(refreshFile(sandbox)));
  });

  it('--refresh on a live daemon never spawns a second daemon', async () => {
    startDaemon(sandbox);
    const first = await waitFor('daemon pidfile', () => readPid(sandbox));
    assert.ok(pidAlive(first));
    const [a, b] = await Promise.all([
      new Promise((resolve) => execFile(process.execPath, [DAEMON, '--refresh'], { env: sandboxEnv(sandbox), timeout: 15000 }, (e, stdout, stderr) => resolve({ e, stdout, stderr }))),
      new Promise((resolve) => execFile(process.execPath, [DAEMON, '--refresh'], { env: sandboxEnv(sandbox), timeout: 15000 }, (e, stdout, stderr) => resolve({ e, stdout, stderr }))),
    ]);
    for (const r of [a, b]) {
      assert.equal(r.e, null);
      assert.match(r.stdout, /already running/);
      assert.match(r.stdout, /refresh requested/);
      assert.equal(r.stderr, '');
    }
    assert.equal(readPid(sandbox), first, 'concurrent refresh must not replace the daemon');
    assert.ok(pidAlive(first));
  });
});

describe('lifecycle previous behavior', () => {
  it('--once renders one frame and never writes the interruption ledger', () => {
    const { entry } = workerEntry(sandbox, sessionPath(sandbox, 'once'));
    writeAgents(sandbox, [entry]);
    writePanes(sandbox, [{ pane_id: 'pane-1', tokens: {} }]);
    const result = runCli(sandbox, ['--once']);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.ok(metaCalls(sandbox).length > 0, 'expected the one frame to publish');
    assert.equal(fs.existsSync(interruptionsFile(sandbox)), false);
    assert.equal(fs.existsSync(refreshFile(sandbox)), false);
    assert.equal(fs.existsSync(pidFile(sandbox)), false);
  });

  it('--stop and --stop --purge keep previous behavior with no daemon', () => {
    const stop = runCli(sandbox, ['--stop']);
    assert.equal(stop.status, 0);
    assert.match(stop.stdout, /no running daemon/);
    assert.match(stop.stdout, /handover sweep done/);
    const purge = runCli(sandbox, ['--stop', '--purge']);
    assert.equal(purge.status, 0);
    assert.match(purge.stdout, /no running daemon/);
    assert.match(purge.stdout, /purged owned tokens/);
  });

  it('no-args mode still only ensures the daemon is running', () => {
    const result = runCli(sandbox, []);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /daemon started/);
  });
});

describe('interruption ledger', () => {
  it('records disappearance while the pane still exists, clears on fresh activity or confirmed absence', async () => {
    const session = sessionPath(sandbox, 'live');
    const { entry, hash } = workerEntry(sandbox, session);
    writeAgents(sandbox, [entry]);
    writePanes(sandbox, [{ pane_id: 'pane-1', tokens: {} }]);
    startDaemon(sandbox);
    await waitFor('daemon pidfile', () => readPid(sandbox));
    await waitFor('first publish', () => metaCalls(sandbox).length > 0);

    // Positive disappearance: agent gone, pane still listed.
    writeAgents(sandbox, []);
    const stored = await waitFor('interruption record', () => readInterruptions(sandbox)?.panes?.['pane-1'] && readInterruptions(sandbox));
    assert.equal(stored.version, 1);
    assert.deepEqual(Object.keys(stored), ['version', 'panes']);
    const record = stored.panes['pane-1'];
    assert.deepEqual(Object.keys(record).sort(), ['interrupted_at', 'last_fresh_ts', 'observed_display', 'reason', 'session_hash']);
    assert.equal(record.session_hash, hash);
    assert.equal(record.observed_display, 'worker');
    assert.equal(record.reason, 'agent_disappeared');
    assert.ok(Number.isFinite(record.last_fresh_ts));
    assert.ok(Number.isFinite(record.interrupted_at));

    // Fresh new activity clears the diagnostic-only record.
    const again = workerEntry(sandbox, session).entry;
    writeAgents(sandbox, [again]);
    await waitFor('record cleared on fresh activity', () => {
      const current = readInterruptions(sandbox);
      return current === null || !('pane-1' in current.panes);
    });

    // Disappear again, then confirm pane absence: the record is removed,
    // never retained as a stale Interrumpido.
    writeAgents(sandbox, []);
    await waitFor('interruption record again', () => readInterruptions(sandbox)?.panes?.['pane-1']);
    writePanes(sandbox, []);
    await waitFor('record removed on confirmed pane absence', () => {
      const current = readInterruptions(sandbox);
      return current === null || !('pane-1' in current.panes);
    });
  });

  it('done, stale expiry, malformed data, and failed snapshots never record', async () => {
    const session = sessionPath(sandbox, 'edge');
    const { entry } = workerEntry(sandbox, session);
    // Terminal done with fresh count 0 is settled proof, not disappearance.
    const doneEntry = structuredClone(entry);
    doneEntry.agent_status = 'done';
    doneEntry.tokens.gentle_work_v1 = `${contract.expectedSessionHash(doneEntry)}:0:${Date.now() + 30000}`;
    delete doneEntry.tokens.gentle_roles_v1;
    writeAgents(sandbox, [doneEntry]);
    writePanes(sandbox, [{ pane_id: 'pane-1', tokens: {} }]);
    startDaemon(sandbox);
    await waitFor('daemon pidfile', () => readPid(sandbox));
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(readInterruptions(sandbox), null, 'done must not record');

    // Stale TTL alone is never failure evidence.
    const stale = structuredClone(entry);
    stale.tokens.gentle_work_v1 = `${contract.expectedSessionHash(stale)}:1:${Date.now() - 1000}`;
    writeAgents(sandbox, [stale]);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(readInterruptions(sandbox), null, 'stale expiry must not record');

    // Malformed snapshot data is never evidence.
    writeAgents(sandbox, [{ pane_id: 'pane-1', tokens: 'garbage', agent_session: { agent: 'pi', kind: 'path', value: session } }]);
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(readInterruptions(sandbox), null, 'malformed data must not record');

    // A failed agent snapshot is "no data", never "empty".
    fs.writeFileSync(sandbox.agentsFail, '');
    try {
      await new Promise((r) => setTimeout(r, 800));
      assert.equal(readInterruptions(sandbox), null, 'failed snapshot must not record');
    } finally {
      fs.rmSync(sandbox.agentsFail, { force: true });
    }

    // A failed pane list is distinguishable from an empty list: with a
    // previously fresh unfinished agent now gone but pane presence
    // unknown, nothing may be recorded.
    const fresh = workerEntry(sandbox, session).entry;
    writeAgents(sandbox, [fresh]);
    await waitFor('fresh publish', () => metaCalls(sandbox).length > 0);
    await new Promise((r) => setTimeout(r, 600));
    fs.writeFileSync(sandbox.panesFail, '');
    writeAgents(sandbox, []);
    try {
      await new Promise((r) => setTimeout(r, 900));
      assert.equal(readInterruptions(sandbox), null, 'unknown pane presence must not record');
    } finally {
      fs.rmSync(sandbox.panesFail, { force: true });
    }
    // And the same disappearance with a successful pane list records.
    const recorded = await waitFor('record after pane list recovers', () => readInterruptions(sandbox)?.panes?.['pane-1']);
    assert.equal(recorded.reason, 'agent_disappeared');
  });
});

describe('sidebar mode gate (S7 shared gate)', () => {
  it('missing flag preserves existing publish behavior', () => {
    const { entry } = workerEntry(sandbox, sessionPath(sandbox, 'gate-default'));
    writeAgents(sandbox, [entry]);
    writePanes(sandbox, [{ pane_id: 'pane-1', tokens: {} }]);
    const result = runCli(sandbox, ['--once']);
    assert.equal(result.status, 0);
    assert.equal(result.stderr, '');
    assert.ok(metaSets(sandbox).length > 0, 'missing flag must publish as before');
  });

  it('disabled mode publishes nothing and clears only the owned family once', async () => {
    fs.writeFileSync(sidebarModeFile(sandbox), '{"version":1,"enabled":false}\n');
    const { entry } = workerEntry(sandbox, sessionPath(sandbox, 'gate-off'));
    writeAgents(sandbox, [entry]);
    writePanes(sandbox, [{ pane_id: 'pane-1', tokens: { gentle_state_worker: 'worker' } }]);
    startDaemon(sandbox);
    await waitFor('daemon pidfile', () => readPid(sandbox));
    await waitFor('owned family cleared', () => metaCalls(sandbox).length > 0);
    await new Promise((r) => setTimeout(r, 900));
    const calls = metaCalls(sandbox);
    assert.equal(metaSets(sandbox).length, 0, 'disabled mode must never set sidebar tokens');
    assert.ok(calls.length > 0 && calls.length <= 10, `expected one clear burst, saw ${calls.length}`);
    for (const line of calls) {
      assert.ok(!line.includes(' --token '), `only owned clears, never sets; saw: ${line}`);
    }
    const settled = metaCalls(sandbox).length;
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(metaCalls(sandbox).length, settled, 'clear must happen once, not every frame');
  });

  it('malformed flag fails closed with a bounded error and leaves the flag untouched', () => {
    fs.writeFileSync(sidebarModeFile(sandbox), '{"version":1,"enabled":"nope"}\n');
    const before = fs.readFileSync(sidebarModeFile(sandbox), 'utf8');
    const { entry } = workerEntry(sandbox, sessionPath(sandbox, 'gate-bad'));
    writeAgents(sandbox, [entry]);
    writePanes(sandbox, [{ pane_id: 'pane-1', tokens: {} }]);
    const result = runCli(sandbox, ['--once']);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /sidebar mode/);
    assert.equal(metaSets(sandbox).length, 0, 'malformed flag must not publish');
    assert.equal(fs.readFileSync(sidebarModeFile(sandbox), 'utf8'), before, 'daemon must never rewrite the flag');
  });

  it('--refresh never reactivates sidebar mode', async () => {
    const flag = '{"version":1,"enabled":false}\n';
    fs.writeFileSync(sidebarModeFile(sandbox), flag);
    const { entry } = workerEntry(sandbox, sessionPath(sandbox, 'gate-refresh'));
    writeAgents(sandbox, [entry]);
    writePanes(sandbox, [{ pane_id: 'pane-1', tokens: {} }]);
    const result = runCli(sandbox, ['--refresh']);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /refresh requested/);
    assert.equal(fs.readFileSync(sidebarModeFile(sandbox), 'utf8'), flag);
    await waitFor('daemon pidfile', () => readPid(sandbox));
    await new Promise((r) => setTimeout(r, 900));
    assert.equal(fs.readFileSync(sidebarModeFile(sandbox), 'utf8'), flag, '--refresh must not touch the flag');
    assert.equal(metaSets(sandbox).length, 0, 'no sidebar republish while native is selected');
  });
});
