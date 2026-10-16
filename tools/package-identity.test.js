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

  it('declares the Pi extensions and every declared file exists', () => {
    const declared = PKG.pi?.extensions ?? [];
    // The package ships more than one extension now (the state producer and
    // the worktree tools), so this pins membership rather than a closed list.
    assert.ok(declared.includes('./extensions/gentle-herdr-state.ts'), `declared: ${declared.join(', ')}`);
    assert.ok(declared.includes('./extensions/gentle-worktree-tools.ts'), `declared: ${declared.join(', ')}`);
    for (const rel of declared) {
      assert.ok(fs.existsSync(path.join(REPO_ROOT, rel)), `missing extension ${rel}`);
    }
  });

  it('ships only Pi-side surfaces in the npm tarball', () => {
    assert.ok(Array.isArray(PKG.files) && PKG.files.length > 0, 'package.json must declare files[]');
    for (const required of ['extensions', 'bin', 'lib', 'docs', 'rules', 'README.md', 'DESIGN.md']) {
      assert.ok(PKG.files.includes(required), `files[] must include ${required}`);
    }
    for (const excluded of ['herdr-plugin', 'tools', 'scripts', 'odd']) {
      assert.ok(!PKG.files.includes(excluded), `files[] must not include ${excluded}`);
    }
  });

  it('ships the worktree rules file, which the package injects only when asked', () => {
    assert.ok(PKG.files.includes('rules'), 'files[] must include rules, or rules/worktrees.md never ships');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'rules', 'worktrees.md')), 'rules/worktrees.md must exist');
  });

  it('declares the repository a provenance attestation binds to', () => {
    // npm provenance — and the trusted publisher that generates it — binds a
    // publish to a PUBLIC repository that package.json names, case-sensitively.
    // A published version is immutable, so the field has to be right before the
    // first publish rather than after it.
    const url = PKG.repository && PKG.repository.url ? String(PKG.repository.url) : '';
    const normalized = url.replace(/^git\+/, '').replace(/\.git$/, '');
    assert.equal(
      normalized,
      'https://github.com/jonasotoaguilar/herdr-gentle-agents',
      `repository.url must name this repository, got: ${url}`,
    );
  });

  it('declares the license the published package is bound to', () => {
    // A published version is immutable, so the license has to be right BEFORE
    // the first publish: npm shows it on the package page and nothing can
    // correct it afterwards.
    assert.equal(PKG.license, 'MIT', 'package.json must declare the license');
    assert.ok(fs.existsSync(path.join(REPO_ROOT, 'LICENSE')), 'LICENSE must exist at the repository root');
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
