#!/usr/bin/env node
'use strict';

// Package-side CLI for the Gentle/native sidebar switch (S7):
//   node bin/gentle-sidebar.js (enable|disable|status|toggle) [--json]
//
// Same contract as the sidebar rows of `/herdr-gentle:customize` in the Pi extension; see
// lib/gentle-sidebar.js and docs/sidebar-control.md. Isolated use:
//   GENTLE_STATUS_STATE_DIR=/tmp/s PI_CODING_AGENT_DIR=/tmp/a
//   HERDR_CONFIG_PATH=/tmp/c.toml node bin/gentle-sidebar.js status
//
// Exit codes: 0 success; 1 operational failure; 2 usage failure.

const sidebar = require('../lib/gentle-sidebar.js');

function usage() {
  console.error('usage: node bin/gentle-sidebar.js (enable|disable|status|toggle) [--json]');
}

function main() {
  const args = process.argv.slice(2);
  const verb = args[0];
  const json = args.includes('--json');
  for (const flag of args.slice(1)) {
    if (flag !== '--json') {
      console.error(`gentle-sidebar: unknown flag ${flag}`);
      usage();
      process.exit(2);
    }
  }
  let result;
  if (verb === 'enable') result = sidebar.enable();
  else if (verb === 'disable') result = sidebar.disable();
  else if (verb === 'status') result = sidebar.status();
  else if (verb === 'toggle') {
    const mode = sidebar.readMode();
    if (mode.state === 'malformed') {
      console.error(`gentle-sidebar: mode file is malformed (expected {"version":1,"enabled":boolean}); fix or remove it first.`);
      process.exit(1);
    }
    result = mode.publish ? sidebar.disable() : sidebar.enable();
  } else {
    console.error(`gentle-sidebar: unknown verb ${verb === undefined ? '(none)' : JSON.stringify(verb)}`);
    usage();
    process.exit(2);
  }
  if (json) console.log(JSON.stringify({ code: result.code, message: result.message }));
  else if (result.code === 0) console.log(result.message);
  else console.error(result.message);
  process.exit(result.code);
}

if (require.main === module) main();
