# Herdr Gentle Agents

Local Herdr plugin so the sidebar recognises Pi + Gentle Shell agents.

## What It Does

Reports per-pane agent state (`working` for the orchestrator/main agent
when settled with no fresh root marker, `gentle` in pink while the principal
session actively works with no recognized role active — even with zero
subagents — (machine display key
`orchestrating`, pink palette unchanged),
the active TaskStore role — `explorer`, `worker`, `verify`, `rdd` — with
delegated subagents (any recognized role shows over root `gentle`), `ask` (event legs plus
in-flight `ask_user_question`/`ask_user_choice` tool calls plus consent-eligible native review
starts while pending, amber/orange `?`), `blocked`, `done`, `idle`) plus compact
changes segments folded into the single row-1 heading cell (nonempty ` +N`/` -N`/` ↑N`
with leading spaces, symbols color-distinguished by `contains` rules: ` +` green for added,
` -` red for deleted, ` ↑` blue for pull — added stays green, deleted stays red),
reduced from `gentle_*`
pane-metadata tokens. It coexists with `herdr-pi-tree` through a single-writer handoff: while
this plugin owns a pane, `herdr-pi-tree` stays disabled for that pane, so the
two never share token names or the 16-token budget. Details live in
[DESIGN.md](DESIGN.md).

## Quick Start

Prerequisites: Linux, Node >= 18, Herdr meeting `min_herdr_version` in `herdr-plugin.toml`, and
`herdr-pi-tree` installed (it stays installed but disabled for gentle-owned
panes).

One pinned script installs both halves at the same release tag: the Herdr plugin
plus a managed copy of `extensions/gentle-herdr-state.ts` at
`~/.pi/agent/extensions/gentle-herdr-state.ts`.

Review the pinned script before piping it to a shell — fetch the tag URL
(never `main`) and read it first. The installer never uses `sudo` and never
handles credentials.

### Public install (pinned, one command)

```sh
curl -fsSL https://raw.githubusercontent.com/jonasotoaguilar/herdr-gentle-agents/v0.1.0/install.sh | sh -s -- --ref v0.1.0
```

What the installer does:

- Installs and enables the Herdr plugin at the pinned `--ref`.
- Atomically copies `extensions/gentle-herdr-state.ts` from the Herdr-managed
  checkout into `~/.pi/agent/extensions/gentle-herdr-state.ts` (temp file plus
  rename) with a SHA-256 ownership record. A conflicting destination — including
  a locally modified managed copy, symlink, directory, or special file — is moved
  aside to a timestamped backup, never silently destroyed.
- Runs the managed Herdr sidebar `configure --apply` plus `--check`, then best-effort
  `herdr server reload-config` and best-effort daemon ensure via `bin/gentle-status.js`.
  Best-effort reload/daemon failures warn without rolling back the completed install
  and config. The `configure` action itself only writes the managed Herdr sidebar
  block described below.
- Running Pi sessions still need `/reload` (or a restart) to pick up the updated extension.

### Local development

Point Herdr at this checkout (from this directory). `herdr plugin link`
only registers this directory; it runs no build.

```sh
herdr plugin link --enabled .
herdr plugin action invoke configure --plugin herdr-gentle-agents
```

Then run `/reload` in Pi to pick up the local package.

For isolated/local use the installer honors a `PI_AGENT_DIR` override (default
`$HOME/.pi/agent`) without touching the live Pi dir, e.g.
`PI_AGENT_DIR=/tmp/pi-agent-test sh install.sh --ref v0.1.0`. Do not use
`pi install` as the production path for this installer — the managed copy at
`~/.pi/agent/extensions/gentle-herdr-state.ts` is the supported Pi half.

### Update

Re-run the same script pattern at the new tag with the new `--ref`:

```sh
curl -fsSL https://raw.githubusercontent.com/jonasotoaguilar/herdr-gentle-agents/<new-tag>/install.sh | sh -s -- --ref <new-tag>
```

A modified managed Pi copy is backed up before replacement, same as on install.

### Removal

```sh
curl -fsSL https://raw.githubusercontent.com/jonasotoaguilar/herdr-gentle-agents/v0.1.0/install.sh | sh -s -- --uninstall
```

Uninstall runs `configure --uninstall`, best-effort daemon `--stop --purge` and
`herdr server reload-config`, then removes the Herdr plugin. The managed Pi copy
is ownership-checked: a locally modified `~/.pi/agent/extensions/gentle-herdr-state.ts`
is preserved with a warning, never deleted.

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
user-owned `[ui.sidebar.agents]` table it sits under. The managed override is
exactly two pi-only rows: row 1 is the native Herdr tokens `state_icon`,
`workspace`, `agent` in that order as plain native token strings (no custom
cells, no colors wired here — row-1 glyph and identity coloring, including
the native `state_icon`, is Herdr-native and not plugin-controlled); row 2
wires the ten presence-encoded `gentle_title_*` state cells (state word
only, one current title per frame, each in its state's semantic color as
base fg with no rules) followed by the three change-segment tokens (added
green `+N`, deleted red `-N`, pull blue `↑N`, each its own color cell with
no rules, never swapped). The review leg renders the user-facing word
`review` in blue `#89b4fa` (same as explorer/pull; internal TaskStore role
slug stays `rdd`, machine display key and token names stay `review`); the
error value renders `blocked`; the orchestrating leg renders the
user-facing word `gentle` (machine key stays `orchestrating`, pink
`#f5c2e7`). Remaining state colors: working/worker amber `#f9e2af`,
explorer blue `#89b4fa`, verify teal `#94e2d5`, ask orange `#fab387`,
error red `#f38ba8`, done green `#a6e3a1`, idle grey `#7c7f93`. Added
stays green and deleted stays red; the mapping is never swapped. The custom
`$gentle_heading_*` / `$gentle_project` / `$gentle_agent` cells and
`gentle_changes_summary` stay published and owned for compatibility but are
wired into no visible row.
Only one `gentle_title_*` token carries a value per frame (presence
encoding), so row 2 shows the current state word plus any nonempty change
segments while the rest render empty; native separators on row 2 are
acceptable. Row 1 holds 3 native cells and row 2 holds 13 cells (10 state
+ 3 changes), each within Herdr's 16-token per-row ceiling (full block below).

```toml
# BEGIN herdr-gentle-agents (managed; do not edit)
# Sidebar override owned by herdr-gentle-agents: two pi-only rows —
# row 1 native state_icon + workspace + agent, row 2 state word + changes.
# The parent [ui.sidebar.agents] table is user-owned and never touched here.
[ui.sidebar.agents.rows_by_agent]
pi = [["state_icon", "workspace", "agent"], [{ token = "$gentle_title_working", fg = "#f9e2af" }, { token = "$gentle_title_orchestrating", fg = "#f5c2e7" }, { token = "$gentle_title_explorer", fg = "#89b4fa" }, { token = "$gentle_title_worker", fg = "#f9e2af" }, { token = "$gentle_title_verify", fg = "#94e2d5" }, { token = "$gentle_title_ask", fg = "#fab387" }, { token = "$gentle_title_review", fg = "#89b4fa" }, { token = "$gentle_title_error", fg = "#f38ba8" }, { token = "$gentle_title_done", fg = "#a6e3a1" }, { token = "$gentle_title_idle", fg = "#7c7f93" }, { token = "$gentle_changes_added", fg = "#a6e3a1" }, { token = "$gentle_changes_deleted", fg = "#f38ba8" }, { token = "$gentle_changes_pull", fg = "#89b4fa" }]]
# END herdr-gentle-agents
```

The
single row-1 heading cell mirrors the Gentle Shell SessionChanges model semantics
(write/edit tool outcomes, never `git status`, never an approximate
reaggregation): files keyed by `(root, path)` with snapshot-continuity and
unavailable counts (unavailable files stay in the file count with 0/0); `↑N` shows when the pane
branch is behind its upstream (branch-ab status only, no diff). `gentle_project`,
`gentle_changes_summary`, and the segment
tokens (`gentle_changes_added`/`_deleted`/`_pull`) stay published for
compatibility but render no visible row. `working`
renders for the main agent when settled with no fresh root marker or roles
(or active subs with no recognized role and no fresh marker); pink
`gentle` (machine key `orchestrating`, pink palette unchanged) renders while the principal session actively works — even with zero subagents —
retaining running/queued-subagent or pending-launch coverage (outranking main
`working` only, yielding to any recognized role, `ask`/`review`/`blocked` and
terminal `done`); the newest recognized TaskStore role (`explorer`, `worker`,
`verify`, `rdd`) renders with delegated subagents — never a count, never a
subagent name. The work total is a direct projection of the
Gentle Shell TaskStore `running`/`queued` records, never a calculated
pending-call estimate: pending tool calls are role-only display hints (exact
in-flight subagent agent -> role slug, so task-mode launches show the active
role even at count 0) plus label correlation, and
true concurrent tasks all count.
Errors render as user-facing `blocked`.
Other agents are unaffected. `--apply` refuses (exit 2, no write) when an
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
and confirm row 2 shows pink `gentle` (machine key
`orchestrating`) while
the principal session actively works — even with zero subagents —
(yielding to the active role — `worker`,
`explorer`, `verify`, ... — with no count whenever a recognized role is active), row 1 shows
the single heading cell (`● <project>` plus ` +N`/` -N`/` ↑N` inline, zero `·`) after edits / when behind upstream; then `ask` on an open
question (event legs, in-flight `ask_user_question`/`ask_user_choice`, or a consent-eligible
native review start while its `gentle_review` call is pending) and `blocked` on error. `review` applies during native review once the consent-eligible start resolves (or while any other review call is in flight). The orchestrator-host `ask_user_choice` prompt emits no Pi tool/event observable by this extension and stays covered only by the event legs above. Never point the fixture commands at the live config: keep
`HERDR_CONFIG_PATH` on a temp file for apply/uninstall checks.

## Core Workflow

A Pi sidecar extension publishes `gentle_*` tokens per pane; a plugin daemon
reduces the Herdr snapshot to sidebar state on a poll cadence. Same transport
and TTL discipline as `herdr-pi-tree`, new token names, no new socket or
webhook. `[[startup]] node bin/gentle-status.js` (no args) is the polling-daemon
bootstrap (ensures the 10 s poll daemon is running); `[[events]] on =
"pane.agent_detected"` runs `node bin/gentle-status.js --once` as an immediate
one-frame refresh so a newly opened project name/state renders without waiting
for the next poll tick. See [DESIGN.md](DESIGN.md) §4 (producer) and §5 (consumer).

## Key Features You Should Know About

- Full v1 state matrix including the root-session `orchestrating` marker
  (pink `●` + user-facing word `gentle`, while the principal session actively
  works — even with zero subagents — retaining subagent/pending coverage;
  yielding to recognized roles, `ask`/`review`/`blocked` and terminal `done`;
  outranking main `working` only) and the authoritative TaskStore role signal
  (`explorer` / `worker` / `verify` / `rdd` from `TaskRecord.agent`, newest
  first; `working` for the orchestrator/main or unrecognized agents — never
  a count), `ask` on blocked user input,
  `review` during native review, and user-facing `blocked` for errors.
- Single-cell row-1 heading (`<icon> <project>` plus ` +N`/` -N`/` ↑N`
  inline, exactly one nonempty cell so zero `·` separators; white base with
  `contains` rules keeping ` +` green (added), ` -` red (deleted,
  leading-space match), ` ↑` blue (pull)) mirroring the Gentle Shell
  SessionChanges model semantics over Gentle tool outcomes, never `git`
  status and never an approximate reaggregation (root+path continuity and
  unavailable counts); behind-upstream `↑N` from branch-ab status only.
  Session-change tokens are refreshed/cleared from the current Gentle Shell
  session model and never carried across sessions.
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
