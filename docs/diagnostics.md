# Diagnostics (read-only)

Three standalone Node CLIs for supervision triage. All are read-only:
they never create the state directory, write tokens/config/ledger, start
or stop the daemon, read transcripts, or dump private raw tokens, task
labels, or review verdicts. Herdr is reached only through fixed-argv
`HERDR_BIN_PATH` list commands; no socket calls are made or claimed.

## Commands

- `node herdr-plugin/bin/gentle-doctor.js [--help]` — daemon pidfile liveness
  (signal 0; presence alone is not liveness), producer/token freshness
  from one `herdr agent list` snapshot, managed sidebar override marker
  scan. Prints `pass:`/`warn:`/`fail:` lines plus actionable `remedy:`
  lines. When `/herdr-gentle:sidebar disable` selects native mode, skips
  inactive Gentle daemon/producer/override checks and still checks snapshot
  availability. An invalid mode file fails closed without exposing its contents.
  Exit 0 pass/warn only, 1 any fail or failed snapshot, 2 bad args.
- `node herdr-plugin/bin/gentle-trace.js <pane-id>` — one JSON document for a pane
  (e.g. `wBG:p1`): safe ids, agent, display, roles, count, freshness
  booleans, identity session hash, and the safe interruption record.
  A disappeared agent whose pane is still present traces as
  `display: interrupted` / `label: Interrumpido` with the safe record;
  confirmed pane absence stays `pane_not_found`. A failed snapshot or
  unknown pane is a JSON `ok:false` failure, never an empty success.
  Exit 0 traced, 1 unavailable/not-found, 2 bad args.
- `node herdr-plugin/bin/gentle-whois.js [--all]` — concise `PANE AGENT STATE ROLES
  WORKSPACE` table in stable pane order, fitted to narrow widths with
  control characters stripped. Default lists only plugin-owned panes;
  `--all` also lists native/foreign panes without task names.
  `Interrumpido` is diagnostic-only (valid ledger record while the pane
  shows no fresh activity); the sidebar vocabulary is unchanged. Ledger
  rows for panes missing from the agent list are confirmed with one
  extra `pane list` call: confirmed presence renders the row, confirmed
  absence shows no ghost, and a failed pane list fails explicitly.
  Exit 0 rendered, 1 snapshot unavailable, 2 bad args.

Invalid arguments are rejected with exit 2 before any state read or
Herdr call. A failed `agent list` snapshot is always a failure (exit 1),
distinct from an empty-but-successful view.

## Environment

- `HERDR_BIN_PATH` — Herdr binary (default `herdr`).
- `GENTLE_STATUS_STATE_DIR` (else `HERDR_PLUGIN_STATE_DIR`, else the
  default plugins state dir) — read for `gentle-status.pid` and the
  `gentle-sidebar-mode.json` (`{version:1,enabled:boolean}`; missing defaults
  to Gentle mode), and the `gentle-interruptions.json` ledger
  (`{version:1,panes:{...}}` with only
  identity hash, whitelisted unfinished displays, finite timestamps, and
  reason `agent_disappeared`). A missing ledger is tolerated; a malformed
  one is ignored with a warning and its arbitrary fields never exposed.
- `HERDR_CONFIG_PATH` — read for the managed sidebar marker scan.
- `COLUMNS` — whois table width (default 80, clamped 20–512).

## Shared library

`herdr-plugin/lib/gentle-diagnostics.js` holds the read-only helpers (path
resolution without mkdir, bounded reads, sanitization/width fitting,
strict ledger validation, pidfile signal-0 check, per-pane whitelist
summary via `herdr-plugin/lib/gentle-tokens.js`). It exposes only safe pane/workspace
ids, validated agent names, the agent_status enum, role slugs, running
counts, freshness booleans, and the identity hash.
