// Package identity for the two-package split (S5, S8).
//
// The repository root is the Pi package and herdr-plugin/ is the Herdr
// plugin. These assertions read the two published identities through their
// public files (package.json, herdr-plugin/herdr-plugin.toml) and pin the
// invariants the installer and the release gate depend on: a scoped npm
// name with the pi-package keyword, a Pi manifest whose extension exists,
// an npm tarball that never ships the Herdr plugin, and two independent
// versions.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const MANIFEST_DIR = path.join(REPO_ROOT, 'herdr-plugin');
const MANIFEST_PATH = path.join(MANIFEST_DIR, 'herdr-plugin.toml');

function manifestVersion() {
  const line = fs
    .readFileSync(MANIFEST_PATH, 'utf8')
    .split('\n')
    .find((l) => l.startsWith('version'));
  const match = /=\s*"([^"]+)"/.exec(line ?? '');
  assert.ok(match, 'herdr-plugin.toml must declare a quoted version');
  return match[1];
}

describe('Pi package identity', () => {
  it('is published under the scoped npm name with the pi-package keyword', () => {
    assert.equal(PKG.name, '@jonasotoaguilar/herdr-gentle-agents');
    assert.ok(PKG.keywords.includes('pi-package'), `keywords: ${PKG.keywords.join(', ')}`);
  });

  it('declares exactly one Pi extension and that file exists', () => {
    assert.deepEqual(PKG.pi?.extensions, ['./extensions/gentle-herdr-state.ts']);
    for (const rel of PKG.pi.extensions) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `missing extension ${rel}`);
    }
  });

  it('ships only Pi-side surfaces in the npm tarball', () => {
    assert.ok(Array.isArray(PKG.files) && PKG.files.length > 0, 'package.json must declare files[]');
    for (const required of ['extensions', 'bin', 'lib', 'docs', 'README.md', 'DESIGN.md']) {
      assert.ok(PKG.files.includes(required), `files[] must include ${required}`);
    }
    for (const excluded of ['herdr-plugin', 'tools', 'scripts', 'odd']) {
      assert.ok(!PKG.files.includes(excluded), `files[] must not include ${excluded}`);
    }
  });

  it('no longer carries the Herdr plugin manifest at the repository root', () => {
    assert.equal(fs.existsSync(path.join(REPO_ROOT, 'herdr-plugin.toml')), false);
  });
});

describe('Herdr plugin identity', () => {
  it('keeps its own manifest, id and independent semver version', () => {
    assert.ok(fs.existsSync(MANIFEST_PATH), 'herdr-plugin/herdr-plugin.toml must exist');
    assert.match(fs.readFileSync(MANIFEST_PATH, 'utf8'), /^id = "herdr-gentle-agents"$/m);
    assert.match(manifestVersion(), /^\d+\.\d+\.\d+$/);
  });

  it('is installable as a repository subdirectory', () => {
    // `herdr plugin install <OWNER/REPO[/SUBDIR]>` resolves the manifest
    // inside the subdirectory, so every command path must stay relative to
    // that directory rather than to the repository root.
    for (const rel of ['bin/gentle-status.js', 'bin/configure.js']) {
      assert.ok(fs.existsSync(path.join(MANIFEST_DIR, rel)), `missing ${rel} under herdr-plugin/`);
    }
  });

  it('versions the two packages independently', () => {
    assert.match(PKG.version, /^\d+\.\d+\.\d+$/);
    // No equality requirement between the two series: each is released from
    // its own tag (pi-vX.Y.Z and herdr-vX.Y.Z) against its own version.
    assert.equal(typeof manifestVersion(), 'string');
  });
});
