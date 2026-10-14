# Supervision (daemon lifecycle, recovery, interruptions, sidebar gate)

The consumer daemon (`herdr-plugin/bin/gentle-status.js`) polls `agent list`, reduces
each pane with `herdr-plugin/lib/gentle-tokens.js`, and publishes the owned `gentle_*`
sidebar family. One daemon per host; the daemon is the sole persistent
writer of `gentle-interruptions.json`. Diagnostic readers
(`herdr-plugin/bin/gentle-doctor.js`, `herdr-plugin/bin/gentle-trace.js`, `herdr-plugin/bin/gentle-whois.js`)
never write. No sidebar new states, notifications, spool, telemetry, or
tokens carrying private data are added here.

## Modes

- `node herdr-plugin/bin/gentle-status.js` — ensure the daemon is running (Herdr
  `[[startup]]`). Prints `daemon started` or `already running (pid N)`.
- `node herdr-plugin/bin/gentle-status.js --run` — BE the daemon (the poll loop).
  Refuses to start when another daemon owns the pidfile (exit 1).
- `node herdr-plugin/bin/gentle-status.js --refresh` — ensure exactly one daemon,
  then request a coalesced immediate refresh. Prints `already running`
  or `daemon started` plus `refresh requested` (exit 0). Renders no
  frame itself, so it can never become a second ledger writer loop, and
  never touches the sidebar flag, so event hooks cannot silently
  reactivate a deselected sidebar. This is the command event hooks use:
  `pane.agent_detected`, `pane.agent_status_changed`, `pane.exited`,
  `pane.closed` (all confirmed in the installed 0.9.4 schema; minimum
  Herdr version is parent-owned).
- `node herdr-plugin/bin/gentle-status.js --once` — one frame, then exit (debugging).
  Publishes like the loop but never writes the interruption ledger.
- `node herdr-plugin/bin/gentle-status.js --stop [--purge]` — stop the daemon, then
  the scoped handover sweep (live panes keep their family until TTL or
  a successor writer takes over); `--purge` clears every owned token
  instead. Only owned `gentle_*` names under this daemon's own source
  tag are ever cleared; producer/foreign tokens are never touched.

## Recovery and acceleration

- Dead-daemon recovery: `--refresh` (and no-args) respawns the daemon
  when the pidfile is missing, stale, or points at a recycled PID. A
  Linux `/proc` cmdline check rejects pidfiles whose PID no longer
  names this daemon, so an unrelated reused PID is never signalled.
- Coalesced refresh: `--refresh` writes only a timestamp request file;
  the loop consumes it (delete) and runs one extra frame. N concurrent
  requests collapse to one frame; frames stay sequential, never
  overlapping. No self-feedback: `--refresh` publishes nothing, and the
  daemon's own metadata writes emit no agent lifecycle events.
- Adaptive polling fallback is kept: 10 s baseline
  (`GENTLE_STATUS_POLL_MS`), 2 s fast cycle while recent ask activity or
  send/publish failures are observed, N quiet frames or a TTL-bounded
  window to recover, 250 ms floor, single dynamic `setTimeout` chain.
- Failed snapshots are "no data", never "empty": nothing is published,
  swept, or recorded on a failed read. A failed pane list is
  distinguishable from an empty list (null vs `[]`): sweeps report
  incomplete and absence decisions are skipped while presence is unknown.

## Interruption ledger (`gentle-interruptions.json`)

Exact schema: `{version:1,panes:{[pane_id]:{session_hash:string|null,
observed_display:string,last_fresh_ts:number,interrupted_at:number,
reason:"agent_disappeared"}}}`. Only the identity hash, finite
timestamps, whitelisted unfinished displays (`working`, `orchestrating`,
`explorer`, `worker`, `verify`, `judge`, `ask`, `review`, `error`), and
the fixed reason are stored or exposed.

- Record only on explicit disappearance of a previously live, fresh
  unfinished owned agent while the pane still exists.
- Never on stale TTL alone, `done` (fresh count 0 is settled proof),
  graceful pane close, malformed data, producer session mismatch, or
  transport failure.
- Remove records on fresh new activity or explicit pane close/confirmed
  pane absence; otherwise retain the diagnostic-only `Interrumpido`
  (machine `interrupted`) until one of those arrives.
- Persisted only when records change (prior sightings stay memory-only);
  writes are atomic (tmp + rename). No sidebar vocabulary changes.

## Sidebar gate (S7 shared surface)

The sibling sidebar unit owns writing `<stateDir>/gentle-sidebar-mode.json`
(`{version:1,enabled:boolean}`); the daemon only reads it, every frame,
so toggles apply without a restart. Missing file defaults to enabled
(current installations unchanged). Valid `enabled:false` selects the
native sidebar: the daemon publishes no sidebar tokens and clears only
its owned family once per pane (transport failure retries on the next
frame and arms the fast cycle). Malformed content fails closed as
disabled — a truthy check could otherwise reactivate a deliberately
disabled mode — with one stderr/err-file report per distinct content.
The daemon never writes the flag.

## Environment

- `GENTLE_STATUS_STATE_DIR` (else `HERDR_PLUGIN_STATE_DIR`, else the
  default plugins state dir) — pidfile, refresh request, ledger, err
  log, sidebar flag. All fixtures in tests; never live global state.
- `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH` — Herdr transport (socket with
  one CLI fallback each).
- `GENTLE_STATUS_POLL_MS` / `GENTLE_STATUS_FAST_POLL_MS` /
  `GENTLE_STATUS_FAST_QUIET_FRAMES` / `GENTLE_STATUS_FAST_WINDOW_MS` —
  adaptive poll tuning (floors apply).
