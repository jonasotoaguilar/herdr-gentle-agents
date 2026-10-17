'use strict';
// Issue verification for the worktree tools (P2-S2).
//
// `verifyIssues(numbers, opts)` requires at least one integer issue number
// and verifies each EXISTS through `gh issue view <n> --json
// number,title,state`, spawned with a fixed argv (never a shell string)
// and a bounded timeout. There is deliberately no `status:approved`
// requirement: association plus existence is the whole contract (S3).
//
// Every failure mode fails closed with a clear reason:
// - missing/empty/non-integer input tells the agent to create or assign an
//   issue first;
// - a nonexistent issue names that number;
// - a missing/unusable `gh` (absent binary, unauthenticated, or a
//   repository without a GitHub remote) reports the cause instead of
//   treating the issue as valid.
//
// Test-only override for the `gh` binary: `opts.ghBin`, else the
// `GH_BIN_PATH` environment variable, else `gh` on PATH.

const { spawnSync } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 15000;

function ghBinary(opts = {}) {
  if (typeof opts.ghBin === 'string' && opts.ghBin.length > 0) return opts.ghBin;
  const env = opts.env || process.env;
  const fromEnv = env && env.GH_BIN_PATH;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return 'gh';
}

function missingIssuesResult() {
  return {
    ok: false,
    code: 'missing',
    reason: 'worktree_create requires at least one issue: create or assign an issue first, then pass its number in issues[]',
  };
}

// Classify a failed `gh issue view` so the reason tells the agent what to
// fix: auth/remote problems fail closed (never "issue does not exist"),
// everything else names the number that could not be resolved.
function classifyGhFailure(number, result) {
  if (result.error) {
    if (/ENOENT/i.test(result.error)) {
      return {
        ok: false,
        code: 'gh-missing',
        reason: 'gh CLI is not available: install gh or point GH_BIN_PATH at it, then retry',
      };
    }
    if (/ETIMEDOUT|timed out/i.test(result.error)) {
      return {
        ok: false,
        code: 'gh-timeout',
        reason: `timed out verifying issue #${number}: retry once, then check gh and network access`,
      };
    }
    return {
      ok: false,
      code: 'gh-error',
      reason: `cannot verify issue #${number}: ${result.error}`,
    };
  }
  const stderr = (result.stderr || '').toLowerCase();
  if (/not logged in|not authenticated|authentication|auth|gh auth login/.test(stderr)) {
    return {
      ok: false,
      code: 'gh-auth',
      reason: 'gh is not authenticated (run `gh auth login`), so issues cannot be verified',
    };
  }
  if (/no .*remote|no github|not a git repository|no remotes configured/.test(stderr)) {
    return {
      ok: false,
      code: 'no-remote',
      reason: 'this repository has no GitHub remote, so issues cannot be verified through gh',
    };
  }
  return {
    ok: false,
    code: 'not-found',
    reason: `issue #${number} does not exist (gh issue view failed): create or assign a valid issue first`,
  };
}

function verifyOneIssue(ghBin, cwd, timeoutMs, number) {
  const result = spawnSync(ghBin, ['issue', 'view', String(number), '--json', 'number,title,state'], {
    cwd,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
  });
  const outcome = {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    error: result.error ? String((result.error && result.error.message) || result.error) : null,
  };
  return interpretIssueView(number, outcome);
}

// Shared outcome interpreter: the exact validation, failure messages
// and classifier above, used by BOTH the sync and the async runners so
// the two paths can never drift apart (no duplicate classifier).
function interpretIssueView(number, outcome) {
  if (outcome.status !== 0) return classifyGhFailure(number, outcome);
  let doc;
  try {
    doc = JSON.parse(outcome.stdout);
  } catch {
    return {
      ok: false,
      code: 'gh-output',
      reason: `cannot verify issue #${number}: gh returned unparseable output`,
    };
  }
  if (typeof doc !== 'object' || doc === null
    || typeof doc.number !== 'number' || typeof doc.title !== 'string' || typeof doc.state !== 'string') {
    return {
      ok: false,
      code: 'gh-output',
      reason: `cannot verify issue #${number}: gh returned an unexpected shape`,
    };
  }
  return { ok: true, issue: { number: doc.number, title: doc.title, state: doc.state } };
}

// Default async runner: the shared non-blocking argv runner with the
// same `{status, stdout, stderr, error}` shape the interpreter reads.
// Lazily required so this module stays dependency-light at load.
function defaultRunAsync(bin, argv, runOpts) {
  try {
    const git = require('./worktree-git.js');
    if (git && typeof git.runArgvAsync === 'function') {
      return git.runArgvAsync(bin, argv, runOpts);
    }
  } catch {
    // Fall through to the gh-error below.
  }
  return Promise.resolve({
    status: null, stdout: '', stderr: '', error: 'async runner unavailable',
  });
}

async function verifyOneIssueAsync(ghBin, cwd, timeoutMs, number, runAsync) {
  const run = typeof runAsync === 'function' ? runAsync : defaultRunAsync;
  let result;
  let timer;
  try {
    // Bound injected runners too: they may never settle, unlike the
    // production child-process runner which owns its own kill timeout.
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve({
        status: null, stdout: '', stderr: '', error: 'timed out verifying issue',
      }), timeoutMs);
    });
    result = await Promise.race([
      Promise.resolve().then(() => run(ghBin, ['issue', 'view', String(number), '--json', 'number,title,state'], {
        cwd,
        timeoutMs,
        windowsHide: true,
      })),
      deadline,
    ]);
  } catch (err) {
    return classifyGhFailure(number, {
      status: null, stdout: '', stderr: '', error: (err && err.message) || String(err),
    });
  } finally {
    clearTimeout(timer);
  }
  const outcome = result && typeof result === 'object' ? result : {};
  return interpretIssueView(number, {
    status: outcome.status,
    stdout: outcome.stdout || '',
    stderr: outcome.stderr || '',
    error: outcome.error ? String(outcome.error) : null,
  });
}

// Verify a list of issue numbers. Returns
// `{ok: true, issues: [{number, title, state}]}` or
// `{ok: false, reason, code}`. Never throws for input or gh problems.
function verifyIssues(numbers, opts = {}) {
  if (!Array.isArray(numbers) || numbers.length === 0) return missingIssuesResult();
  for (const entry of numbers) {
    if (!Number.isInteger(entry)) {
      return {
        ok: false,
        code: 'invalid',
        reason: `issue numbers must be integers, got ${JSON.stringify(entry)}: create or assign an issue first, then pass its number in issues[]`,
      };
    }
  }
  const ghBin = ghBinary(opts);
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const issues = [];
  for (const number of numbers) {
    const verified = verifyOneIssue(ghBin, cwd, timeoutMs, number);
    if (!verified.ok) return verified;
    issues.push(verified.issue);
  }
  return { ok: true, issues };
}

// Async twin for interactive paths (the gitOnly/wizard creation): the
// same fixed argv, the same validation, failure messages, classifier,
// timeout and result shape as verifyIssues — only the wait is
// non-blocking. `opts.runAsync` injects the runner (used by tests);
// production defaults to the shared runArgvAsync. Never throws for
// input or gh problems.
async function verifyIssuesAsync(numbers, opts = {}) {
  if (!Array.isArray(numbers) || numbers.length === 0) return missingIssuesResult();
  for (const entry of numbers) {
    if (!Number.isInteger(entry)) {
      return {
        ok: false,
        code: 'invalid',
        reason: `issue numbers must be integers, got ${JSON.stringify(entry)}: create or assign an issue first, then pass its number in issues[]`,
      };
    }
  }
  const ghBin = ghBinary(opts);
  const cwd = opts.cwd;
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const runAsync = typeof opts.runAsync === 'function' ? opts.runAsync : null;
  const issues = [];
  for (const number of numbers) {
    const verified = await verifyOneIssueAsync(ghBin, cwd, timeoutMs, number, runAsync);
    if (!verified.ok) return verified;
    issues.push(verified.issue);
  }
  return { ok: true, issues };
}

module.exports = {
  verifyIssues,
  verifyIssuesAsync,
  ghBinary,
};
