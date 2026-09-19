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

Linking this checkout into Herdr and live verification are pending task 8 and
are unverified here — no link command is documented yet.

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
  (`bin/`); both directories are placeholders until then.
- Resolve the open decisions in [DESIGN.md](DESIGN.md) §10 before implementing
  against them.
- Link and verify live in Herdr (pending task 8).
