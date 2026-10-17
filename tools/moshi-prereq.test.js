'use strict';
// T28 (customize-command S38) unit tests for lib/moshi-prereq.js.
//
// The Moshi switch may flip to On only when (a) the `moshi-hook` CLI
// resolves on PATH by exact name (never through a shell), and (b)
// `moshi-hook status --json` (fixed argv, short timeout) reports a
// top-level `paired: true`. Anything else refuses fail-closed. Only the
// `paired` flag the CLI itself reports is ever read — never the secret
// store, never a token value.
//
// These tests stub the filesystem scan and the spawn call, so they never
// spawn a real `moshi-hook` (which may talk to a daemon) and never need
// Moshi installed.

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const prereq = require('../lib/moshi-prereq.js');

const roots = [];
after(() => {
  for (const dir of roots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function track(dir) {
  roots.push(dir);
  return dir;
}

function makeBin({ names = ['moshi-hook'] } = {}) {
  const dir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'moshi-prereq-bin-')));
  for (const name of names) {
    const file = path.join(dir, name);
    if (name.endsWith('/')) {
      fs.mkdirSync(file.slice(0, -1), { recursive: true });
    } else {
      fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }
  }
  return dir;
}

function statusResult({ stdout = '', status = 0 } = {}) {
  return { status, stdout, stderr: '', error: undefined };
}

describe('resolveMoshiHook: PATH scan by exact name, never a shell', { concurrency: false }, () => {
  test('finds the exact name on PATH', async () => {
    const bin = makeBin();
    const found = prereq.resolveMoshiHook({ env: { PATH: bin }, delimiter: path.delimiter });
    assert.equal(found, path.join(bin, 'moshi-hook'));
  });

  test('the first PATH entry wins', async () => {
    const first = makeBin();
    const second = makeBin();
    const found = prereq.resolveMoshiHook({
      env: { PATH: [first, second].join(path.delimiter) },
      delimiter: path.delimiter,
    });
    assert.equal(found, path.join(first, 'moshi-hook'));
  });

  test('skips entries without the exact name and keeps scanning', async () => {
    const empty = makeBin({ names: [] });
    const full = makeBin();
    const found = prereq.resolveMoshiHook({
      env: { PATH: [empty, full].join(path.delimiter) },
      delimiter: path.delimiter,
    });
    assert.equal(found, path.join(full, 'moshi-hook'));
  });

  test('a near-miss name never matches', async () => {
    const bin = makeBin({ names: ['moshi-hook-extra', 'moshi-hook.json'] });
    const found = prereq.resolveMoshiHook({ env: { PATH: bin }, delimiter: path.delimiter });
    assert.equal(found, null);
  });

  test('a directory named moshi-hook never matches', async () => {
    const bin = makeBin({ names: ['moshi-hook/'] });
    const found = prereq.resolveMoshiHook({ env: { PATH: bin }, delimiter: path.delimiter });
    assert.equal(found, null);
  });

  test('missing or empty PATH resolves to null', async () => {
    assert.equal(prereq.resolveMoshiHook({ env: {}, delimiter: path.delimiter }), null);
    assert.equal(prereq.resolveMoshiHook({ env: { PATH: '' }, delimiter: path.delimiter }), null);
  });

  test('an unreadable entry fails closed to null, never throws', async () => {
    const found = prereq.resolveMoshiHook({
      env: { PATH: '/definitely/not/here' },
      delimiter: path.delimiter,
    });
    assert.equal(found, null);
    const throwing = prereq.resolveMoshiHook({
      env: { PATH: '/x' },
      delimiter: path.delimiter,
      statSync: () => { throw new Error('EACCES'); },
    });
    assert.equal(throwing, null);
  });
});

describe('runMoshiStatus: fixed argv, short timeout, paired flag only', { concurrency: false }, () => {
  test('paired:true is ok and the spawn uses the fixed argv with no shell', async () => {
    const calls = [];
    const seen = prereq.runMoshiStatus('/bin/moshi-hook', {
      spawnSyncFn: (cmd, args, opts) => {
        calls.push([cmd, args, opts]);
        return statusResult({ stdout: '{"paired":true,"secretStore":"x","hooks":[]}\n' });
      },
    });
    assert.deepEqual(seen, { ok: true });
    assert.equal(calls.length, 1);
    const [cmd, args, opts] = calls[0];
    assert.equal(cmd, '/bin/moshi-hook');
    assert.deepEqual(args, ['status', '--json']);
    assert.equal(opts.shell, undefined, 'never run through a shell');
    assert.equal(typeof opts.timeout, 'number');
    assert.ok(opts.timeout <= 10000, 'a short timeout bounds the enable path');
  });

  test('paired:false refuses as not-paired', async () => {
    const seen = prereq.runMoshiStatus('/bin/moshi-hook', {
      spawnSyncFn: () => statusResult({ stdout: '{"paired":false}\n' }),
    });
    assert.deepEqual(seen, { ok: false, reason: 'not-paired' });
  });

  test('a missing paired field refuses as missing-field', async () => {
    for (const stdout of ['{}\n', '{"paired":"yes"}\n', '{"paired":1}\n', '[]\n', '"paired"\n', '\n']) {
      const seen = prereq.runMoshiStatus('/bin/moshi-hook', {
        spawnSyncFn: () => statusResult({ stdout }),
      });
      assert.equal(seen.ok, false, `expected refusal for ${JSON.stringify(stdout)}`);
      assert.ok(['missing-field', 'unparseable'].includes(seen.reason), `reason for ${JSON.stringify(stdout)}`);
    }
  });

  test('unparseable output refuses fail-closed', async () => {
    const seen = prereq.runMoshiStatus('/bin/moshi-hook', {
      spawnSyncFn: () => statusResult({ stdout: 'not json\n' }),
    });
    assert.deepEqual(seen, { ok: false, reason: 'unparseable' });
  });

  test('a non-zero exit refuses fail-closed', async () => {
    const seen = prereq.runMoshiStatus('/bin/moshi-hook', {
      spawnSyncFn: () => statusResult({ stdout: '{"paired":true}\n', status: 1 }),
    });
    assert.deepEqual(seen, { ok: false, reason: 'non-zero-exit', status: 1 });
  });

  test('a spawn throw refuses fail-closed', async () => {
    const seen = prereq.runMoshiStatus('/bin/moshi-hook', {
      spawnSyncFn: () => { throw new Error('ENOENT'); },
    });
    assert.deepEqual(seen, { ok: false, reason: 'spawn-failed' });
  });

  test('extra fields (secretStore, hooks) are ignored and never returned', async () => {
    const seen = prereq.runMoshiStatus('/bin/moshi-hook', {
      spawnSyncFn: () => statusResult({
        stdout: '{"paired":true,"secretStore":"opaque","hooks":[{"id":"pi"}]}\n',
      }),
    });
    assert.deepEqual(seen, { ok: true }, 'only the paired flag matters; nothing is echoed back');
  });
});

describe('checkMoshiPrereqs: one verdict for the enable path', { concurrency: false }, () => {
  test('a found CLI plus paired:true passes with the CLI path', async () => {
    const verdict = prereq.checkMoshiPrereqs({
      resolve: () => '/bin/moshi-hook',
      run: () => ({ ok: true }),
    });
    assert.deepEqual(verdict, { ok: true, cliPath: '/bin/moshi-hook' });
  });

  test('a missing CLI refuses and names the CLI plus the install fix', async () => {
    const runs = [];
    const verdict = prereq.checkMoshiPrereqs({
      resolve: () => null,
      run: (cli) => { runs.push(cli); return { ok: true }; },
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'missing-cli');
    assert.match(verdict.text, /moshi-hook/);
    assert.match(verdict.text, /install/i);
    assert.deepEqual(runs, [], 'no status run without a CLI');
  });

  test('a throwing resolver still refuses as missing-cli', async () => {
    const verdict = prereq.checkMoshiPrereqs({
      resolve: () => { throw new Error('EACCES'); },
      run: () => ({ ok: true }),
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'missing-cli');
  });

  test('unpaired refuses and names pairing plus the pair fix command', async () => {
    const verdict = prereq.checkMoshiPrereqs({
      resolve: () => '/bin/moshi-hook',
      run: () => ({ ok: false, reason: 'not-paired' }),
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'not-paired');
    assert.match(verdict.text, /paired/);
    assert.ok(
      verdict.text.includes('moshi-hook pair --token <pairing-token>'),
      'the fix command is named literally (never a real token)',
    );
  });

  test('erroring or unparseable status refuses fail-closed', async () => {
    for (const reason of ['non-zero-exit', 'unparseable', 'missing-field', 'spawn-failed']) {
      const verdict = prereq.checkMoshiPrereqs({
        resolve: () => '/bin/moshi-hook',
        run: () => ({ ok: false, reason }),
      });
      assert.equal(verdict.ok, false, `expected refusal for ${reason}`);
      assert.equal(verdict.code, 'status-failed');
      assert.match(verdict.text, /status --json/);
    }
  });

  test('a throwing runner refuses fail-closed', async () => {
    const verdict = prereq.checkMoshiPrereqs({
      resolve: () => '/bin/moshi-hook',
      run: () => { throw new Error('boom'); },
    });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, 'status-failed');
  });

  test('no verdict ever carries a token or credential value', async () => {
    for (const verdict of [
      prereq.checkMoshiPrereqs({ resolve: () => null, run: () => ({ ok: true }) }),
      prereq.checkMoshiPrereqs({ resolve: () => '/x', run: () => ({ ok: false, reason: 'not-paired' }) }),
      prereq.checkMoshiPrereqs({ resolve: () => '/x', run: () => ({ ok: false, reason: 'unparseable' }) }),
      prereq.checkMoshiPrereqs({ resolve: () => '/x', run: () => ({ ok: true }) }),
    ]) {
      assert.ok(!JSON.stringify(verdict).includes('token-'), 'no token value travels in a verdict');
      assert.ok(!JSON.stringify(verdict).includes('secret'), 'no credential store travels in a verdict');
    }
  });
});

describe('message parity with the in-extension gate', { concurrency: false }, () => {
  test('the extension carries the identical refusal literals (self-contained install copy)', async () => {
    const ext = fs.readFileSync(path.resolve(__dirname, '../extensions/gentle-herdr-state.ts'), 'utf8');
    for (const literal of [
      'was not found on PATH',
      'moshi-hook pair --token <pairing-token>',
      'moshi-hook status --json',
    ]) {
      assert.ok(ext.includes(literal), `extension must carry ${JSON.stringify(literal)}`);
      assert.ok(
        fs.readFileSync(path.resolve(__dirname, '../lib/moshi-prereq.js'), 'utf8').includes(literal),
        `lib must carry ${JSON.stringify(literal)}`,
      );
    }
  });
});
