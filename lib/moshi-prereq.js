'use strict';
// Moshi enable prerequisites (customize-command S38, T28).
//
// Before the Moshi switch flips to On, the enable path verifies (a) the
// `moshi-hook` CLI resolves on PATH by exact name, and (b)
// `moshi-hook status --json` reports a top-level `paired: true`. Pairing
// is what lets a notification reach the phone; the token itself is only
// ever consumed by `moshi-hook pair --token` and is never read, logged,
// stored, or returned here — only the `paired` flag the CLI reports.
//
// Rules this module enforces:
// - PATH is scanned for the exact name; the CLI is never run through a
//   shell (fixed argv array, no `shell` option).
// - `status --json` runs with a short timeout; a non-zero exit,
//   unparseable output, a non-object document, or any `paired` value other
//   than `true` all refuse fail-closed.
// - The `pi` hooks entry is deliberately NOT required: enabling excludes
//   `extensions/moshi-hooks.ts` on purpose, so this plugin is the single
//   notifier.
// - The disable path never calls here; disabling stays unconditional.
//
// The installed extension copy (`extensions/gentle-herdr-state.ts`) ships
// without sibling modules, so it carries an inline mirror of this logic
// with injectable seams for tests. Keep the three refusal literals
// byte-identical in both files (a test pins the shared phrases).
//
// No dependencies beyond node builtins; safe to require from any tool.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MOSHI_BIN_NAME = 'moshi-hook';
const MOSHI_STATUS_ARGS = ['status', '--json'];
// Short timeout: the enable path blocks on this one call, so it must fail
// fast instead of hanging the panel when the daemon is unresponsive.
const MOSHI_STATUS_TIMEOUT_MS = 5000;
// Literal placeholder only — a real pairing token never flows through here.
const MOSHI_PAIR_COMMAND = 'moshi-hook pair --token <pairing-token>';

function candidateNames(platform) {
  if (platform === 'win32') return ['moshi-hook.exe', 'moshi-hook.cmd', 'moshi-hook.bat', MOSHI_BIN_NAME];
  return [MOSHI_BIN_NAME];
}

// Scan PATH for the exact CLI name. Pure readdir-free probe: join + stat,
// no shell, no spawn. Returns the absolute candidate path or null.
function resolveMoshiHook({
  env = process.env,
  delimiter = path.delimiter,
  joinFn = path.join,
  statSync = fs.statSync,
  platform = process.platform,
} = {}) {
  const pathEnv = env && typeof env.PATH === 'string' ? env.PATH : '';
  const names = candidateNames(platform);
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = joinFn(dir, name);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Unreadable entries never decide; keep scanning.
      }
    }
  }
  return null;
}

// Run `moshi-hook status --json` with a fixed argv and a short timeout,
// and require a top-level `paired === true`. Every other field the CLI
// reports (baseUrl, displayName, hostId, logPath, platform, secretStore,
// socketPath, hooks) is ignored and never returned.
function runMoshiStatus(cliPath, { spawnSyncFn = spawnSync, timeoutMs = MOSHI_STATUS_TIMEOUT_MS } = {}) {
  let result;
  try {
    result = spawnSyncFn(cliPath, [...MOSHI_STATUS_ARGS], {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
    });
  } catch {
    return { ok: false, reason: 'spawn-failed' };
  }
  if (!result || result.status !== 0) {
    return { ok: false, reason: 'non-zero-exit', status: result ? result.status : null };
  }
  const out = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!out) return { ok: false, reason: 'unparseable' };
  let doc;
  try {
    doc = JSON.parse(out);
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return { ok: false, reason: 'missing-field' };
  if (doc.paired !== true) return { ok: false, reason: doc.paired === false ? 'not-paired' : 'missing-field' };
  return { ok: true };
}

function missingCliMessage() {
  return 'Moshi notifications cannot be enabled: the `moshi-hook` CLI was not found on PATH; install the Moshi CLI, then re-apply On from /herdr-gentle:customize.';
}

function notPairedMessage() {
  return 'Moshi notifications cannot be enabled: `moshi-hook status --json` reports paired:false (this device is not paired); run `moshi-hook pair --token <pairing-token>`, then re-apply On from /herdr-gentle:customize.';
}

function statusDetail(reason, status) {
  if (reason === 'non-zero-exit') return `exited with status ${status ?? 'unknown'}`;
  if (reason === 'unparseable') return 'produced no parseable JSON';
  if (reason === 'missing-field') return 'reported no paired flag';
  return 'could not be run';
}

function statusFailedMessage(reason, status) {
  return `Moshi notifications cannot be enabled: \`moshi-hook status --json\` did not confirm pairing (${statusDetail(reason, status)}); make sure the Moshi CLI is installed and paired (\`moshi-hook pair --token <pairing-token>\`), then re-apply On from /herdr-gentle:customize.`;
}

// One verdict for the enable path. `resolve`/`run` default to the real
// implementations; tests inject stubs so no real `moshi-hook` ever spans.
function checkMoshiPrereqs({ resolve = resolveMoshiHook, run = runMoshiStatus } = {}) {
  let cliPath = null;
  try {
    cliPath = resolve();
  } catch {
    cliPath = null;
  }
  if (typeof cliPath !== 'string' || cliPath.length === 0) {
    return { ok: false, code: 'missing-cli', text: missingCliMessage() };
  }
  let status;
  try {
    status = run(cliPath);
  } catch {
    status = { ok: false, reason: 'spawn-failed' };
  }
  if (status && status.ok === true) return { ok: true, cliPath };
  if (status && status.reason === 'not-paired') {
    return { ok: false, code: 'not-paired', text: notPairedMessage() };
  }
  const reason = status && typeof status.reason === 'string' ? status.reason : 'spawn-failed';
  return {
    ok: false,
    code: 'status-failed',
    text: statusFailedMessage(reason, status ? status.status : null),
  };
}

module.exports = {
  MOSHI_BIN_NAME,
  MOSHI_STATUS_ARGS,
  MOSHI_STATUS_TIMEOUT_MS,
  MOSHI_PAIR_COMMAND,
  resolveMoshiHook,
  runMoshiStatus,
  checkMoshiPrereqs,
  missingCliMessage,
  notPairedMessage,
  statusFailedMessage,
};
