'use strict';

// Project identity rename (customize-command S15/T9).
//
// Bounded rename only: the published npm name becomes
// `@jonasotoaguilar/herdr-gentle-shell` and the Herdr plugin becomes id
// `herdr-gentle-shell` / display name `Herdr Gentle Shell`. Everything else
// is pinned unchanged: the source repository keeps its current URL (no
// assumed herdr-gentle-shell remote is ever created), the
// `herdr-gentle:*` command verbs keep their names with no new aliases, and
// persistent state paths, managed markers and the internal provider slot
// keep their existing `herdr-gentle-agents` segments for compatibility.
//
// This suite asserts only current on-disk public metadata and contracts
// (package.json, package-lock.json, the plugin manifest, README). The
// behavioral compatibility pins — provider slot, managed markers, command
// registration — live in the existing suites that exercise them
// (tools/customize-panel.test.js, tools/customize-providers.test.js,
// tools/gentle-sidebar-toggle.test.js, tools/gentle-diagnostics.test.js,
// tools/customize-warp.test.js), not here.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const NEW_NPM_NAME = '@jonasotoaguilar/herdr-gentle-shell';
const NEW_PLUGIN_ID = 'herdr-gentle-shell';
// The actual existing repository. The rename never creates a remote under
// the new name and never republishes existing URLs to one.
const KEPT_REPO = 'github.com/jonasotoaguilar/herdr-gentle-agents';

function read(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

describe('project identity rename (S15/T9)', () => {
  it('package root carries the new npm name in the existing scope', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.name, NEW_NPM_NAME);
  });

  it('the lock carries the new name in both root slots, consistent with the package root', () => {
    const pkg = JSON.parse(read('package.json'));
    const lock = JSON.parse(read('package-lock.json'));
    assert.equal(lock.name, NEW_NPM_NAME);
    assert.equal(lock.packages?.['']?.name, NEW_NPM_NAME);
    assert.equal(lock.name, pkg.name);
    assert.equal(lock.packages?.['']?.name, pkg.name);
  });

  it('peer dependencies are unchanged by the rename', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.deepEqual(pkg.peerDependencies, {
      '@earendil-works/pi-coding-agent': '*',
      '@earendil-works/pi-tui': '*',
    });
  });

  it('the Herdr plugin manifest carries the new id and display name', () => {
    const manifest = read('herdr-plugin/herdr-plugin.toml');
    assert.match(manifest, /^id = "herdr-gentle-shell"$/m);
    assert.match(manifest, /^name = "Herdr Gentle Shell"$/m);
  });

  it('the manifest keeps its own independent semver version', () => {
    const manifest = read('herdr-plugin/herdr-plugin.toml');
    const match = /^version = "([^"]+)"$/m.exec(manifest);
    assert.ok(match, 'herdr-plugin.toml must declare a quoted version');
    assert.match(match[1], /^\d+\.\d+\.\d+$/);
  });

  it('published URLs still name the existing repository, never an assumed one', () => {
    const pkg = JSON.parse(read('package.json'));
    for (const url of [pkg.homepage, pkg.bugs?.url, pkg.repository?.url]) {
      assert.ok(
        String(url).includes(KEPT_REPO),
        `published URL must keep the existing repository, got: ${url}`,
      );
    }
    const readme = read('README.md');
    assert.ok(readme.includes(`https://${KEPT_REPO}/releases/latest/download/install.sh`));
    for (const rel of ['package.json', 'package-lock.json', 'herdr-plugin/herdr-plugin.toml', 'README.md']) {
      assert.ok(
        !read(rel).includes('github.com/jonasotoaguilar/herdr-gentle-shell'),
        `${rel} must not invent a repository URL under the new name`,
      );
    }
  });

  it('the README carries the new visible identity', () => {
    const readme = read('README.md');
    assert.ok(readme.startsWith('# Herdr Gentle Shell\n'), 'README title must carry the new project name');
    assert.ok(readme.includes('![Herdr Gentle Shell banner]'), 'README banner alt must carry the new project name');
    assert.ok(readme.includes(`published to npm as \`${NEW_NPM_NAME}\``));
    assert.ok(readme.includes(`\`npm:${NEW_NPM_NAME}\``), 'README npm install spec must carry the new name');
    assert.ok(
      readme.includes('`git:github.com/jonasotoaguilar/herdr-gentle-agents`'),
      'README git install spec must keep the existing repository',
    );
    assert.ok(readme.includes(`--plugin ${NEW_PLUGIN_ID}`), 'README plugin commands must carry the new plugin id');
    assert.ok(readme.includes(`herdr plugin update ${NEW_PLUGIN_ID}`));
    assert.ok(
      readme.includes('The repository root is the Pi package (`@jonasotoaguilar/herdr-gentle-shell`)'),
    );
  });

  it('the README annotates that the source repository keeps its current URL', () => {
    const readme = read('README.md');
    assert.ok(
      readme.includes('github.com/jonasotoaguilar/herdr-gentle-agents')
        && /source repository[\s\S]*keeps|keeps[\s\S]*current URL|retains its current URL/i.test(readme),
      'README must say the source repository keeps its current URL',
    );
  });

  it('the README keeps the existing command verbs with no new aliases', () => {
    // Registration itself is exercised by tools/customize-warp.test.js and
    // tools/customize-panel.test.js; here the public doc contract pins that
    // the rename introduced no new command prefix.
    const readme = read('README.md');
    assert.ok(readme.includes('/herdr-gentle:customize'));
    assert.ok(!readme.includes('herdr-gentle-shell:'));
  });

  it('the README keeps the on-disk managed marker text unchanged', () => {
    // State compatibility at the doc level: the managed block and backup
    // name keep their existing segments. Behavior is pinned by
    // tools/gentle-sidebar-toggle.test.js and tools/gentle-diagnostics.test.js.
    const readme = read('README.md');
    assert.ok(readme.includes('# BEGIN herdr-gentle-agents (managed; do not edit)'));
    assert.ok(readme.includes('# END herdr-gentle-agents'));
    assert.ok(readme.includes('<config>.herdr-gentle-agents.bak'));
  });
});
