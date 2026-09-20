# Herdr Gentle Agents

Local Herdr plugin so the sidebar recognises Pi + Gentle Shell agents.

## What It Does

Reports per-pane agent state (`working`, `working (name)` / `working (n)` with
delegated subagents, `ask`, `review`, `error`, `done`, `idle`) plus a
session-changes badge (`±N` / `~N`), reduced from `gentle_*` pane-metadata
tokens. It coexists with `herdr-pi-tree` through a single-writer handoff: while
this plugin owns a pane, `herdr-pi-tree` stays disabled for that pane, so the
two never share token names or the 16-token budget. Details live in
[DESIGN.md](DESIGN.md).

## Quick Start

Prerequisites: Herdr meeting `min_herdr_version` in `herdr-plugin.toml`, and
`herdr-pi-tree` installed (it stays installed but disabled for gentle-owned
panes).

Link this checkout into Herdr (from this directory):

```sh
herdr plugin link --enabled .
herdr plugin action invoke configure --plugin herdr-gentle-agents
```

The `configure` action runs `node bin/configure.js --apply --reload`: it
appends one marked pi-only `[ui.sidebar.agents.rows_by_agent]` override for
canonical agent `pi` and reloads the server. Direct equivalents:

```sh
node bin/configure.js --check
node bin/configure.js --apply
node bin/configure.js --apply --reload   # apply + `herdr server reload-config`
node bin/configure.js --uninstall --reload
```

### Sidebar override (non-destructive, pi-only)

`bin/configure.js` manages only its marked block and never edits the
user-owned `[ui.sidebar.agents]` table it sits under. The managed row keeps
the default context segments and renders the daemon-owned state labels plus
the changes badge:

```toml
# BEGIN herdr-gentle-agents (managed; do not edit)
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "machine", "workspace", "tab"], ["agent", "$gentle_title_working", "$gentle_title_working_subs", "$gentle_title_ask", "$gentle_title_review", "$gentle_title_error", "$gentle_title_done", "$gentle_title_idle", "$gentle_badge"]]
# END herdr-gentle-agents
```

Only one `gentle_title_*` token carries a value per frame (presence
encoding), so the active label shows while the rest render empty;
`$gentle_badge` renders `~N` or empty, independent of the state label. Other
agents are unaffected. `--apply` refuses (exit 2, no write) when an
unmanaged `rows_by_agent` override already exists; remove or rename it, then
re-run. Writes are atomic (temp file plus rename) with a backup at
`<config>.herdr-gentle-agents.bak`. The config path resolves exactly like
`bin/gentle-status.js` (`HERDR_CONFIG_PATH`, then `XDG_CONFIG_HOME`, then
the platform default).

### Verification

```sh
node --check bin/configure.js
node --check bin/gentle-status.js
HERDR_CONFIG_PATH=/tmp/herdr-fixture.toml node bin/configure.js --apply
HERDR_CONFIG_PATH=/tmp/herdr-fixture.toml node bin/configure.js --check
HERDR_CONFIG_PATH=/tmp/herdr-fixture.toml node bin/configure.js --uninstall
herdr plugin action invoke configure --plugin herdr-gentle-agents
herdr server reload-config
```

Live check: with the daemon running and the override applied, open a Pi pane
with delegated subagents and confirm the sidebar shows `working (name)` /
`working (n)`, then `ask` on an open question; `review` applies during native
review. Never point the fixture commands at the live config: keep
`HERDR_CONFIG_PATH` on a temp file for apply/uninstall checks.

## Core Workflow

A Pi sidecar extension publishes `gentle_*` tokens per pane; a plugin daemon
reduces the Herdr snapshot to sidebar state on a poll cadence. Same transport
and TTL discipline as `herdr-pi-tree`, new token names, no new socket or
webhook. See [DESIGN.md](DESIGN.md) §4 (producer) and §5 (consumer).

## Key Features You Should Know About

- Full v1 state matrix including delegated-subagent labels from the Gentle
  `TaskStore`, `ask` on blocked user input, and `review` during native review.
- Session-changes badge sourced from Gentle tool outcomes, never `git status`.
- Single-writer coexistence with `herdr-pi-tree`: no shared token names, no
  dual-write, scoped sweep of own tokens on handover.
- TTL-bounded tokens: stale panes fall back to native `idle`.

## Documentation

| Your task | Start here |
| --- | --- |
| Protocol, token grammar, reducer, and coexistence rules | [DESIGN.md](DESIGN.md) |
| Compatibility, migration, and rollback | [DESIGN.md](DESIGN.md) §9 |
| Open decisions blocking implementation | [DESIGN.md](DESIGN.md) §10 |

## Next Steps

- Ship the Pi producer extension (`extensions/`) and the Herdr consumer daemon
  (`bin/`); the daemon ships, the sidebar override installs via the
  `configure` plugin action above.
- Resolve the open decisions in [DESIGN.md](DESIGN.md) §10 before implementing
  against them.
- Live sidebar eyeball with subagents/`ask` remains the final acceptance check
  (see Verification above).
