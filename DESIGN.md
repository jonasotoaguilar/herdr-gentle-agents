# herdr-gentle-agents — DESIGN.md (Task 4)

Status protocol for the Herdr sidebar: producer (Pi sidecar extension) →
pane-metadata tokens → consumer (plugin daemon) → sidebar state + badges.

Status: protocol design. No implementation. Unresolved product/policy
decisions are listed explicitly in §10 and are not decided here.

## 1. Context

### Consumers

- Herdr sidebar (`[ui.sidebar.agents]` + `[ui.sidebar.spaces]` blocks): shows
  one state label per pane plus an optional session-changes badge.
- The human operator watching Pi + Gentle Shell agents: needs to distinguish
  `working` (orchestrator/main) vs the active TaskStore role (`explorer`,
  `worker`, `verify`, `rdd`), `ask` (blocked on user input), `blocked`
  (error), `done`, and `idle` at a glance. No visible text ever carries
  a subagent count.

### Current boundary and interaction

- Transport already exists and is not redesigned: Pi extensions publish
  per-pane key=value tokens via `pane.report_metadata` /
  `workspace.report_metadata` over `HERDR_SOCKET_PATH`, with a CLI fallback
  (`herdr pane report-metadata <pane> --source <src> --token name=value`).
- The consumer is a poller, not a subscriber: the plugin daemon reads the
  Herdr snapshot on a cadence and reduces pane tokens to sidebar state.
  No new socket, webhook, broker, or persistent connection is introduced.
- The existing native producer `herdr-agent-state.ts` (managed-by-herdr, v9,
  source `herdr:pi`) already reports main-agent `working`/`blocked`/`idle` +
  session ref. It is **read-only evidence**: never edited, reinstalled, or
  removed by this plugin.

### Style choice and reason

- Style: **polled token sidecar** (same style as `herdr-pi-tree`): short-TTL
  `name=value` tokens on the pane, reduced by a snapshot poller.
- Reason (smallest fitting style): the transport, snapshot source, 16-token
  budget, TTL/expiry convention, and sidebar token-name mapping already exist
  and are deployed. A new push channel (SSE/WebSocket/webhook) or a new RPC
  would add infrastructure without changing the authoritative outcome, which
  remains "what does the sidebar show for this pane right now". The design
  therefore **extends the established boundary** (new `gentle_*` token names,
  same value grammar, same report path) instead of introducing another style.

### Non-goals (tasks 5–8 scope excluded)

- No `herdr-plugin.toml`, no `README.md`, no `extensions/` producer code, no
  `bin/` consumer code, no directory scaffold.
- No fork or modification of `herdr-pi-tree`; no edit of
  `~/.pi/agent/extensions/herdr-agent-state.ts`.
- No toast/notification UI design beyond exactly-once ownership rules (§7).
- No deep security, performance, or observability design beyond contract
  properties (trust expectations, limits, failure semantics).

## 2. Existing API evidence

All paths verified read-only by scout `mu8wojpu-1-aia3` (2026-09-19).
Do-not-edit sources are marked.

| # | File | Lines | Observable fact (contract surface) |
|---|------|-------|-------------------------------------|
| E1 | `~/.pi/agent/extensions/herdr-agent-state.ts` (DO NOT EDIT, managed-by-herdr) | v9 header; `HERDR_INTEGRATION_ID=pi`, source `herdr:pi` | Publishes main-agent `working`/`blocked`/`idle` + session ref only; transport `HERDR_SOCKET_PATH` via `pane.report_agent_session` / `pane.report_agent` |
| E2 | `~/.config/herdr/plugins/github/herdr-pi-tree-41b1ee3237d2/lib/state.js` | 356–358 | Token `pi_subagents_work_v1` grammar verbatim `/^([A-Za-z0-9_-]{43}):(0\|[1-9]\d{0,15}):([1-9]\d{0,15})$/` = `<sessionHash>:<count>:<expiry>` |
| E3 | same `lib/state.js` | `sessionHash` def | `sessionHash = sha256(agent_session path).base64url` (43 chars) |
| E4 | same plugin | expiry rule | `expiry <= now + 60000` (60 s TTL horizon) |
| E5 | same plugin | reducer | `delegatedStatus = working` when native in `{idle, done}` and `count > 0` |
| E6 | same plugin | `composeBadge` | Badge = indent + delegated glyph `↳` (U+21B3) + count, e.g. `↳3`, default heading placement |
| E7 | same plugin | token-name encoding | State encoded in token NAMES `state_working` / `state_done` / `state_blocked` / `state_idle_fresh` / `state_idle` / `state_idle_stale` / `state_unknown` + `title_<state>` |
| E8 | same plugin | `MAX_TOKENS_PER_REPORT=16` | Reports chunked to fit 16 tokens per report; transport `pane.report_metadata` / `workspace.report_metadata` via socket IPC with CLI fallback `herdr pane report-metadata <pane> --source <src> --token name=value` |
| E9 | same plugin | attention rule | NO toast from plugin side; Herdr fires native attention on `blocked` |
| E10 | Herdr sidebar config | `[ui.sidebar.agents]` + `[ui.sidebar.spaces]` | Sidebar consumes managed blocks; token-name → label/badge mapping is configuration |
| G1 | `/home/jona/repos/gentle-shell/lib/session-changes.ts` | `SESSION_CHANGE_ENTRY`, `gentle-pi.session-change/v1` | `SessionChanges` model: `files[{path,status,added,deleted}]` + `added`/`deleted` totals |
| G2 | `/home/jona/repos/gentle-shell/lib/session-change-capture.ts` | capture rule | Captured ONLY from explicit `write`\|`edit` tool outcomes; never `git status` |
| G3 | `/home/jona/repos/gentle-shell/lib/agents-protocol.ts` | `TASK_STATUS`, `TaskStore` | `queued`/`running`/`waiting`/`finished` + `TaskStore` `list`/`summary` (`running`, `queued`, `waiting`, `finished`); labels = `TaskRecord.label`/`agent` |
| G4 | `/home/jona/repos/gentle-shell/extensions/ask-user-choice.ts` | `ASK_USER_CHOICE_BLOCKED_EVENT`, `gentle-pi:ask-user-choice:blocked` | Authoritative in-process `ask` signal |
| G5 | `/home/jona/repos/gentle-shell/extensions/gentle-ai.ts` | review tools | Registers `gentle_review` tools; contract `gentle-ai.review-integration/v2` |

## 3. Overlap reconciliation (chosen modes)

Prefixing with `gentle_` is necessary but not sufficient. Each overlap gets
an explicit writer-ownership decision. Rationale follows each choice.

### O1. Pane-token namespace + 16-token budget → SINGLE-WRITER HANDOFF

- **Chosen:** while this plugin is installed and enabled for a pane, it is
  the sole writer of subagent/work/changes tokens for that pane;
  `herdr-pi-tree` must be disabled (`enabled:false`, its current state) for
  the same panes. The consumer never writes `pi_subagents_work_v1`,
  `state_*`, or `title_*` names owned by pi-tree.
- **Budget rule:** the gentle producer keeps its own per-report token count
  ≤ 16 (same chunking discipline as E8) so a single writer can never overflow
  the budget; two concurrent writers could, which is why dual-write is banned.
- **Why not dual-write:** two writers sharing one namespace and one budget
  produce badge collisions (`↳N` vs changes suffix) and silent token eviction
  on chunking. Single-writer makes the budget a local invariant.
- **Fallback:** if foreign `pi_subagents_work_v1` tokens are observed while
  gentle owns the pane, the consumer ignores them (read-only, never deletes
  foreign tokens). If gentle is disabled, it writes nothing and leaves
  pi-tree output untouched.

### O2. Reuse vs replace `pi_subagents_work_v1` → REPLACE (do not reuse count)

- **Chosen:** the gentle producer publishes its own `gentle_work_v1` token;
  the consumer treats it as source of truth and ignores
  `pi_subagents_work_v1` while gentle owns the pane.
- **Why not reuse:** the two counts have different name sources that will
  disagree — `TaskStore.label`/`agent` (G3, authoritative for Gentle
  delegation) vs pi-tree's session-file scan. Reusing the foreign count would
  show names the Gentle orchestrator never assigned. Same value grammar, new
  token name, authoritative local source.

### O3. `blocked` → notification ownership → CONSUMER NOTIFIES ASK ONCE; REVIEW NEVER

- **Chosen:** producer signals via `herdr:blocked` labels (`ask:`/`review:`/
  `error:`); native Herdr attention still fires on `blocked` (E9 unchanged).
  The consumer sends at most one `herdr notification` per ask intent, keyed on
  `(sessionHash, intentId)`, only on the `¬ask → ask` transition. `review`
  transitions never produce a plugin notification (the user is already
  engaged in the review flow; review attention stays native).
- **Why:** `ask` needs an out-of-band nudge (the run cannot proceed without
  the user); `review` does not (the user is mid-ritual). Exactly-once scope is
  per intent, not per poll — repeated polls while still `ask` are silent.
  See §7 for dedup/lease semantics.

### O4. Badge slot (`↳` taken) → TWO-ROW PI LAYOUT, NO SLOT SHARING

- **Chosen:** the `↳N` leading-badge slot stays owned by pi-tree and MUST be
  absent under single-writer handoff (O1). Gentle renders exactly two rows
  for the `pi` agent: row 1 is the heading context as exactly one active
  cell — the active `gentle_heading_*` value holds `<icon> <project>` plus
  compact nonempty changes segments (` +N`, ` -N`, ` ↑N`) in that same
  cell (e.g. `● myproj +110 -22 ↑3`). Exactly one row-1 cell is nonempty,
  so Herdr inserts zero inter-cell `·` separators. The cell sits on white
  `#ffffff` (SIDEBAR_PROJECT) so the project text stays white; symbol
  `contains` rules recolor the icon (unchanged state mapping) plus ` +`
  green (added), ` -` red (deleted, leading-space match so hyphens inside
  project names never turn red), and ` ↑` blue (pull). `gentle_project`,
  `gentle_changes_summary`, and the change-segment tokens stay published
  and owned for compatibility but are wired into no visible row; row 2 is
  the agent context (the
  dedicated `gentle_agent` identity cell plus the presence-encoded
  `gentle_title_*` state labels — Herdr's native `·` separator renders the
  visible `pi · worker`). The consumer never writes
  `↳`, never parses it, never arithmetically combines segments, and never
  emits the retired combined `~N` badge (no subtraction, no merging).
- **Why:** sharing one glyph slot between "delegated count" and "files
  changed" makes the badge unreadable and couples two independent facts.
  Two fixed rows keep each fact independently observable and match the
  herdr-pi-tree tree shape.

### O5. `done`/`idle` freshness vs pi-tree done-hold + idle grace → TTL WINS; SWEEP OWN TOKENS ONLY

- **Chosen:** every gentle token carries an absolute `expiry <= now + 60000`
  (same 60 s horizon as E4). The consumer treats missing or expired gentle
  tokens as `unknown → idle` fallback (never holds `done` past expiry).
  On handover (gentle disabled/uninstalled) the consumer sweeps only token
  names it wrote (`gentle_*`, `herdr:blocked` labels it set); it never deletes
  pi-tree or native tokens.
- **Why:** holding `done` past TTL shows a finished state for a pane that may
  have started new work; expiring to `idle` (native fallback) is the safe
  direction. Scoped sweep prevents orphan `gentle_*` badges without
  destroying a successor writer's state.

## 4. Producer contract (Pi sidecar extension; events → tokens)

Sidecar only: ships beside `herdr-agent-state.ts`, never modifies it.

### 4.1 Identity and trust

- Source id: `gentle:v1` (token `--source` value and `herdr:blocked` origin).
- Session binding: `sessionHash = base64url(sha256(agent_session path))`,
  43 chars `[A-Za-z0-9_-]{43}` (same derivation as E3 so pane correlation
  matches pi-tree conventions without reusing its tokens).
- Trust: producer runs in-process with the Pi agent; it reports only facts
  from Gentle tool outcomes and protocol stores (G1–G5). It never reports
  `git status` diffs (G2) and never invents review state (see §10 U4).

### 4.2 Events → tokens mapping

| Producer event (source) | Tokens written | v1 state contribution |
|---|---|---|
| `agent_start` / `isIdle=false` (main actively working, incl. 0 active subs) | `gentle_work_v1=<hash>:0:<exp>` + `gentle_orchestrating_v1=<hash>:<exp>` (root marker while main actively works) + clear `herdr:blocked` labels | `gentle` (machine key `orchestrating`) while the principal session actively works, even with zero subagents |
| TaskStore `running`/`queued` non-empty (G3) | `gentle_work_v1=<hash>:<count>:<exp>` (internal total, never rendered) + `gentle_roles_v1=<csv>` (roles from `TaskRecord.agent`, authoritative) + `gentle_names_v1=<csv>` (compat transport only, never rendered) + `gentle_orchestrating_v1=<hash>:<exp>` (root-only marker, §4.3) | newest recognized role (`explorer` / `worker` / `verify` / `rdd`), else `working` — count and names never render; a fresh root marker reduces to `orchestrating` only when no recognized role is active |
| `ASK_USER_CHOICE_BLOCKED_EVENT` / `gentle-pi:ask-user-choice:blocked` (G4), incl. questionnaire + tool-gated `ui_prompt`, plus direct Pi in-process `tool_call` opens / `tool_result` closes for the exact tools `ask_user_question` and `ask_user_choice`, tracked by `toolCallId` in a call-id set (overlapping calls correct; cleared on result/reset/shutdown; event legs and error > ask > review precedence unchanged; boundary: only what Pi emits as a `tool_call` event is observable — a host ask UI that never emits one stays covered by the event legs only), plus consent-eligible `gentle_review` starts (ordinary-mode `start` / `select-intended-untracked`, tracked by `toolCallId` while pending: renders `ask` until the call resolves, then falls back to `review:` or the next state) | `herdr:blocked` label `ask:<intentId>` + durable `gentle_ask_v1=<hash>:<intentId>:<exp>` on every beat while ask is active (null/clear when inactive — repairs a missed label edge; §4.3) | `ask` (existing machine key, user-facing `ask`, amber/orange, native `?`) |
| Pi in-process `tool_call` opens / `tool_result` closes for the exact registered tools `gentle_review`, `gentle_review_capture`, `gentle_review_capture_group`, `gentle_review_scope` (G5), tracked by `toolCallId`; reserved `gentle-pi:review:blocked` hook remains OR-combined. Exception: a consent-eligible `gentle_review` start (ordinary-mode `start` / `select-intended-untracked`, fail-closed eligibility) is classified into the ask leg above while pending, never here | `herdr:blocked` label `review:<reviewId>` | `review` (machine key `review`) — during a capture-group run the single parent capture-group call stays in flight across the whole multi-reviewer span, so that one call alone holds the label |
| agent error / task failed / transport failure | `herdr:blocked` label `error:<code>` | `blocked` (machine key `error`) |
| `agent_settled` + 0 active subs | `gentle_work_v1=<hash>:0:<exp>`; clear `blocked` labels | `done` |
| `SESSION_CHANGE_ENTRY` `gentle-pi.session-change/v1` tool outcome (G1/G2) | `gentle_changes_v2=<hash>:<files>:<added>:<deleted>:<exp>` (+ legacy `gentle_changes_v1` dual-emit, §4.3) | change segments only (orthogonal to state) |

`waiting`/`finished` TaskStore entries never count as active. Active =
`running` + `queued` only. The count is a direct projection of the Gentle
Shell TaskStore `running`/`queued` records carried in
`event.details.gentleAgents` — never a calculated pending-call estimate —
and stays internal: no visible label renders it. The visible activity state
is the bounded `gentle_roles_v1` CSV derived from `TaskRecord.agent`
(most-recent first): exact `gentle-ai-explore` (actual package agent name,
verified in the project registry alongside `gentle-ai-worker` /
`gentle-ai-verify` / review agents; the legacy `gentle-ai-explorer` alias
is preserved for compatibility) → `explorer`, exact `gentle-ai-worker` →
`worker`, exact `gentle-ai-verify` → `verify`, and a
review agent / `gentle-ai-review*` / any role containing `review` → `rdd`;
any other agent is unrecognized and degrades to orchestrator/main `working`.
The consumer displays the newest recognized role when several are active.
Pending subagent tool calls are label correlation state for a later
`gentleAgents.taskId` result and a role-only display hint while the call is
in flight — never a count. WHY role-only: task-mode `subagent_run` stays in
flight with no TaskStore record until it returns `tool_result`, so the exact
agent name in the pending `tool_call` input is the only live role evidence;
counting it would inflate the normative `gentle_work_v1` total with an
estimate, while publishing its role slug as a bounded-CSV hint keeps the
sidebar on the active role (`worker`, not generic `working`) with the count
authoritative at 0. The hint merges with authoritative active TaskStore roles
(newest-first) and clears when the tool result arrives, the call is
cancelled, or the agent settles. On a tool
result the producer reads the pending record before deleting it and uses it
only to preserve the task label on the authoritative task record; no task
record is created when `details.gentleAgents` is missing. No local
age/staleness timeout is applied — Gentle Shell owns lifecycle/status truth.
Finished/failed/cancelled records may linger in the map but never count;
old records are dropped only on session reset (plus the bounded-map guard).
The root session emits `gentle_orchestrating_v1` while the main session is
actively working (`agentActive`, even with zero subagents), retaining
coverage while the authoritative active list is non-empty or any
`subagent_run`/`subagent_continue` launch is pending, and clears it (null)
once the main session settles — settled, or any non-root session. The marker carries no
count and changes neither the work total nor the roles CSV: it is a pure
freshness-bound presence flag (`<hash>:<exp>`, same binding/TTL style as
gentle_work_v1) that the consumer reduces to `orchestrating` only when no
recognized role is active (§5.2): below attention (error/ask/review),
terminal `done`/native-`blocked`, and recognized roles; ahead of main
`working` only.

### 4.3 Token formats (ABNF-ish, strict)

```text
sessionHash = 43*[A-Za-z0-9_-]   ; base64url(sha256(agent_session path))
expiry      = 1*15DIGIT           ; unix-ms, MUST satisfy expiry <= now+60000 at write
count       = "0" / [1-9] 0*15DIGIT
gentle_work_v1    = sessionHash ":" count ":" expiry
gentle_changes_v1 = sessionHash ":" count ":" count ":" expiry
                    ; <hash>:<files>:<added+deleted>:<expiry> — LEGACY, see below
gentle_changes_v2 = sessionHash ":" count ":" count ":" count ":" expiry
                    ; <hash>:<files>:<added>:<deleted>:<expiry>
                    ; normative: exact added/deleted totals kept separate so
                    ; the sidebar renders +N/-N without a guessed split
gentle_names_v1   = label *("," label)   ; label = TaskRecord.label/agent, 1*64 chars
                    ; compat transport only — never rendered
role            = "explorer" / "worker" / "verify" / "rdd"
                    ; canonical TaskRecord.agent derivations, most-recent first
                    ; (`review` accepted as a legacy alias of `rdd`)
gentle_roles_v1   = role *("," role)       ; total <= ~512 chars; null (clear)
                    ; when no active recognized roles
gentle_orchestrating_v1 = sessionHash ":" expiry
                    ; root-only presence marker, no count — fresh while the
                    ; root main session actively works (even with zero subs),
                    ; retaining running/queued-sub or pending-launch coverage;
                    ; null (clear) once the main session settles
gentle_ask_v1         = sessionHash ":" intentId ":" expiry
                    ; durable ask signal, session-bound + TTL-fresh like
                    ; gentle_orchestrating_v1 — emitted on every beat while
                    ; ask is active, null (clear) when inactive; repairs a
                    ; missed edge-triggered herdr:blocked ask label
herdr:blocked     = "ask:" intentId / "review:" reviewId / "error:" code
```

Versioning rule: v2 is a new token name, not a grammar change to v1 (§9).
The producer dual-emits v1 (combined delta, for rollback consumers) and v2
(exact split, normative). The consumer reduces ONLY v2 for display: a
v1-only pane renders no change segments (fail-closed — the split cannot be
recovered from the sum). The retired combined `~N` badge is never emitted;
the sweeper clears the legacy `gentle_badge` name where a previous install
left it.

Validation: consumers MUST reject tokens failing the grammar (wrong hash
length, `expiry` in the past or `> now+60000` at read, non-numeric counts)
and treat the pane as `unknown → idle` for that signal (§7).

### 4.4 Examples

```text
pane.report_metadata --source gentle:v1 --token gentle_work_v1=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:2:1789000000000
pane.report_metadata --source gentle:v1 --token gentle_roles_v1=worker,explorer
pane.report_metadata --source gentle:v1 --token gentle_orchestrating_v1=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:1789000000000
pane.report_metadata --source gentle:v1 --token gentle_names_v1=planner,code-writer
pane.report_metadata --source gentle:v1 --token gentle_changes_v2=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:5:110:22:1789000000000
herdr:blocked labels: ["ask:q-7f3a"] | ["review:r-42"] | ["error:transport-timeout"]
```

Example reads: worker newest + explorer active → sidebar `worker`; 5 files
/ +110/−22 session delta → the single row-1 heading cell
`● myproj +110 -22` (` +` green for added, ` -` red for deleted with a
leading-space match, zero `·` separators because exactly one heading cell
is nonempty).
A review label renders `review` with a blue `●` (`#89b4fa`, same as explorer/pull). A fresh root
`gentle_orchestrating_v1` marker renders pink `gentle` (machine display key
`orchestrating`, pink palette unchanged) while the principal session actively
works — even with zero subagents — only when no recognized role is active
(yielding to any active role and to attention (`ask`/`review`/`blocked`) and
terminal `done` states).

### 4.5 Publication and chunking

- Same transport as E8: socket IPC `pane.report_metadata` /
  `workspace.report_metadata`, CLI fallback
  `herdr pane report-metadata <pane> --source gentle:v1 --token name=value`.
- One report carries at most 16 tokens; `gentle_names_v1` chunks as
  `gentle_names_v1#p=<i>/<m>` suffixes when labels exceed one token, with the
  consumer reassembling by `#p=` order and dropping incomplete sets at TTL.
- Writes are idempotent full-state snapshots per pane (all gentle tokens
  re-emitted each beat), never deltas — a lost report is repaired by the next
  beat.
- Session-change tokens are refreshed/cleared from the current Gentle Shell
  session model every beat and never carried across sessions: zero changed
  files publishes a clear (null over socket metadata, `--clear-token <name>`
  on the CLI fallback) for `gentle_changes_v1` and `gentle_changes_v2`, so a
  new/reloaded session under a different session hash cannot retain the prior
  session's change token. `gentle_names_v1` clears the same way when the
  authoritative active TaskStore list has no labels, and `gentle_roles_v1`
  clears (null) when no active recognized roles remain. v2 stays the visible
  normative source; v1 remains legacy only.

## 5. Consumer contract (daemon; snapshot → sidebar)

### 5.1 Snapshot inputs (read-only)

Per pane: native `working`/`blocked`/`idle` + session ref (E1), `herdr:blocked`
labels (§4.2), `gentle_ask_v1` (durable ask signal + freshness gate for `ask` — repairs a missed `ask:` label edge, §4.3), `gentle_work_v1` (internal running/queued total + freshness
gate — never rendered), `gentle_orchestrating_v1` (root-only presence marker
+ freshness gate for the `orchestrating` display — never rendered as a
count), `gentle_roles_v1` (authoritative activity roles,
most-recent first), `gentle_names_v1` (compat transport only — never
rendered), `gentle_changes_v2` (normative; a
v1-only pane renders no change segments, §4.3). Pane cwd
(`foreground_cwd` ?? `cwd`) feeds the daemon-side pull marker (§5.3).
Foreign `pi_subagents_work_v1` / `state_*` / `title_*` are observed only to
ignore them under O1 (never parsed for state, never deleted).

### 5.2 Reducer (priority order, first match wins)

```text
error         := herdr:blocked has error:* (fresh, §5.4)
ask           := fresh `gentle_ask_v1` (durable per-beat token, §4.3)
                 OR herdr:blocked has ask:* (fresh)
review        := herdr:blocked has review:* (fresh)
role          := gentle_work_v1 fresh AND gentle_roles_v1
                 yields a recognized role (newest first, incl. the
                 in-flight pending role hint at count = 0 for task-mode
                 launches with no TaskStore record yet)
orchestrating := gentle_orchestrating_v1 fresh (root-only per §4.2:
                 fresh while the main session actively works, even with
                 zero subagents, retaining running/queued-sub or pending-
                 launch coverage; renders only when no recognized role is
                 active; absent/stale falls through to working;
                 attention, terminal `done`/native-`blocked`, and roles
                 stay higher)
working(main) := gentle_work_v1 fresh AND count > 0 with no recognized role
                 (orchestrator/main or unrecognized agents)
                 OR native working (E1)
                 OR (gentle_work_v1 fresh AND count = 0 AND agent not settled)
done          := agent_settled observed AND no fresh error/ask/review AND active subs = 0
idle          := otherwise (native fallback; also all-gentle-tokens-missing-or-expired)
```

Priority: `error > ask > review > done > role activity > orchestrating > working(main) > idle`.
`blocked` labels are namespaced, so simultaneous
`ask:` + `review:` resolves deterministically to `ask`. Attention states
(error/ask/review) and the terminal `done` state always outrank the root
marker and activity roles: a review subagent task
and an in-flight review tool call both resolve to the `review` display, and a
settled session renders `done` even against a stale-fresh marker.

### 5.3 Publication (sidebar tokens)

- The consumer publishes its reduced state under `gentle_`-prefixed token
  names only (never bare `state_*`/`title_*`). The visible first row is
  native and carries no plugin wiring: `state_icon`, `workspace`, `agent`
  in that order as plain native token strings. Row-1 glyph and identity
  coloring, including the native `state_icon`, is Herdr-native and not
  plugin-controlled, so no plugin icon/color claim is made for row 1. The
  custom `$gentle_heading_*` / `$gentle_project` / `$gentle_agent` cells
  stay published and owned for compatibility but are wired into no visible
  row. Deleted lines stay red and added lines stay green (never swapped).
  The visible second row is structural, with no rules: the ten
  presence-encoded
  `gentle_title_<working|orchestrating|explorer|worker|verify|ask|review|error|done|idle>`
  state tokens (state word only: `working` / `gentle` (machine key
  `orchestrating`) / `explorer` / `worker` /
  `verify` / `ask` / `blocked` / `done` / `idle` / `review`). Only the
  current display's title token carries a value; the rest are null.
  Each state cell carries its state's semantic color as its base fg with
  no rules — working/worker golden `#f9e2af`, orchestrating pink fuchsia
  `#f5c2e7`, explorer blue `#89b4fa`, verify teal `#94e2d5`,
  ask orange `#fab387`, blocked red `#f38ba8`, done green `#a6e3a1`,
  idle grey `#7c7f93` (recedes), review blue `#89b4fa` (same as
  explorer/pull; internal TaskStore role slug stays `rdd`, machine display
  key stays `review`). Native separators on row 2 are acceptable. The
  `gentle_state_*` / `gentle_agent_*` / `gentle_icon_*` /
  `gentle_row_*` combined names stay published for compatibility but are
  not wired into any visible row. Sidebar config maps the native row-1
  tokens plus the row-2 title and change-segment tokens to
  the pi-only `rows_by_agent` override (E10); exact block wiring is
  install configuration, not protocol.
- Label shapes: `working` (main agent settled with no fresh marker and no
  roles, or active subs with no recognized role and no fresh marker) |
  `gentle` (user-facing word for the `orchestrating` machine key — fresh
  root-session marker with no recognized role active; the principal session is
  actively working, even with zero subagents; pink palette unchanged) | `explorer` / `worker` / `verify` (newest recognized
  TaskStore role) | `ask` | `review` (user-facing word for the `review`
  machine key) | `blocked` (user-facing word for the `error`
  machine key) | `done` | `idle`. No label carries a count.
- Row-2 changes: the nonempty `+N`/`-N`/`↑N` segments ride as their own
  structural row-2 cells after the ten title cells (each its own color
  cell with no rules — added green, deleted red, pull blue, never
  swapped; empty segments collapse so nothing renders). `+N`/`-N` come
  from fresh `gentle_changes_v2`
  (exact SessionChanges evidence totals, never git status); `↑N` (blue)
  marks the pane branch behind its upstream. The pull marker is derived by the daemon from fixed-argv,
  bounded `git status --porcelain=2 --branch` (the `# branch.ab` line
  only — no shell, no diff, no fetch), cached/deduped per cwd over a short
  TTL so panes sharing a worktree cost ~1 call per window. Any pull failure
  resolves to absent (fail-closed).
- Each `+N`/`-N`/`↑N` segment renders only when its total is > 0; each
  rides its own structural row-2 cell (added green, deleted red, pull
  blue, no rules, never swapped; empty segments collapse). `gentle_project`,
  `gentle_heading_*`, `gentle_agent` (both the single and per-display
  forms), and `gentle_changes_summary` stay published for compatibility
  but render no visible row. The retired
  combined `~N`
  badge is never emitted (see the §4.3 versioning rule).
- Placement: exactly two pi-only rows — row 1 the native `state_icon` +
  `workspace` + `agent` strings (3 cells, no custom wiring, no plugin
  colors), row 2 the ten `gentle_title_*` state cells plus the three
  change-segment cells (13 cells: 10 state + 3 changes), each row within
  Herdr's 16-token per-row ceiling — with the
  herdr-pi-tree palette (added green `#a6e3a1`,
  removed red `#f38ba8`, pull blue `#89b4fa`, working golden `#f9e2af`, ask
  orange `#fab387`, orchestrating pink fuchsia `#f5c2e7`, explorer/review blue `#89b4fa` (same color; internal role slug stays `rdd`,
  visible word is `review`), blocked/error red `#f38ba8`,
  done green `#a6e3a1`, idle grey `#7c7f93` (recedes)). The rows stay pi-keyed (pi-only by
  intent); each row value still carries the snapshot-provided identity,
  with no vendor colors invented. The consumer never emits `↳` (O4).

### 5.4 Freshness

A signal is *fresh* iff its token parses (§4.3) and `expiry > now`. Stale or
unparseable signals are dropped individually (one bad token never poisons the
other two). All gentle signals stale/missing → `idle` (native fallback, O5).

## 6. Failure, retry, idempotency

- Delivery is at-least-once snapshots over an unreliable beat: producer
  re-emits full pane state every beat; consumer reduces the latest snapshot.
  There is no commit/ack; a timeout or lost report never implies the pane
  stopped — only TTL expiry changes the reduced state.
- Retry: producer retries a failed `report_metadata` via CLI fallback once
  per beat, then drops the beat (next beat re-sends full state). No unbounded
  queue; no backlog replay past TTL.
- Duplicate suppression: identical consecutive snapshots are a no-op for the
  consumer (no sidebar rewrite, no notification re-fire).
- Idempotency keys: ask intents carry `intentId` (`ask:<intentId>`); review
  spans carry `reviewId`; notification dedup keys on `(sessionHash,
  intentId)` with a per-intent lease (§7). Re-emitting the same intent is
  safe; a new intent id is a new notification obligation.
- Error containment: transport failure surfaces as `herdr:blocked`
  `error:<code>` (itself a token, subject to the same TTL), never as an
  exception path that stops the producer beat. `error` state clears only on a
  fresh non-error snapshot, not on silence.
- No exactly-once end-to-end claim: at-least-once beats + TTL expiry +
  per-intent notification dedup is the engineered scope (consistent with the
  async/events guidance: never claim exactly-once without a deliberate
  mechanism; the deliberate mechanism here covers *notifications only*).

## 7. Notification ownership (ask exactly-once)

- The consumer emits `herdr notification` for `ask` only, on the `¬ask → ask`
  transition per `(sessionHash, intentId)`. Polls that remain in `ask` for the
  same intent are silent. A new `intentId` re-arms.
- `review` and `error` never emit a plugin notification: `review` attention
  stays in-flow/native; `error` is visible as sidebar state (native `blocked`
  attention on `herdr:blocked` already fires per E9 — the plugin adds no
  second toast path).
- Lease: a notified intent is recorded with the token `expiry`; if the pane
  stays `ask` past TTL and re-asserts the same intent with a fresh expiry,
  the consumer treats it as continuation (silent), not a new transition.
- CLI syntax and any Herdr-side dedup guarantees are unresolved (§10 U1);
  until resolved, the consumer-side transition gate above is the normative
  dedup mechanism.

## 8. Limits

- Token budget: ≤ 16 tokens per report per pane (E8 discipline); the
  producer emits at most 7 tokens per beat (`gentle_work_v1`,
  `gentle_roles_v1`, `gentle_names_v1`, `gentle_orchestrating_v1`,
  `gentle_ask_v1`, `gentle_changes_v2`,
  `gentle_changes_v1`) and the daemon publishes its 66-token owned family
  chunked ≤ 16 per report (row 1 wires the 10 heading tokens with exactly
  one nonempty cell = zero separators, row 2 wires 1 agent + 10 title cells
  = 11 — each within the per-row ceiling). Names are
  advisory and counts internal; roles are authoritative for display.
- TTL: `expiry <= now + 60000` at write; readers use `now` at read.
  Clock skew assumption ≤ 5 s (documented; not compensated).
- Field bounds: `count` ≤ 16 digits; `label` ≤ 64 chars; names/roles CSV
  totals ≤ ~512 chars each; `intentId`/`reviewId`/`code` ≤ 64 chars,
  `[A-Za-z0-9_-]+`.
- Poll cadence: unresolved — must be ≪ 60 s TTL to avoid flapping
  (see §10 U2). No cadence is normatively set here. The `pane.agent_detected`
  event (`node bin/gentle-status.js --once`) is an immediate one-frame refresh
  on agent detection, not the cadence itself; `[[startup]]` (no args)
  remains the polling-daemon bootstrap.
- Scale: one producer per Pi pane; one consumer daemon per host; no
  cross-pane aggregation in v1.

## 9. Compatibility and migration

- Additive only in v1: new token names (`gentle_work_v1`,
  `gentle_roles_v1`, `gentle_names_v1`, `gentle_orchestrating_v1`,
  `gentle_ask_v1`, `gentle_changes_v1`, `gentle_changes_v2`,
  `gentle_state_*`, `gentle_title_*`, `gentle_agent_*`, `gentle_agent`,
  `gentle_icon_*`,
  `gentle_heading_*`, `gentle_project`, `gentle_row_*`, plus display-only
  `gentle_changes_added`, `gentle_changes_deleted`,
  `gentle_changes_pull`, `gentle_changes_summary`); no change to `pi_subagents_work_v1`, `state_*`,
  `title_*`, or native `working`/`blocked`/`idle` semantics.
  `gentle_title_error` keeps its machine-key-derived token name; only its
  user-facing value is `blocked` (§5.3). `gentle_title_review` likewise
  keeps its machine-key-derived token name; only its user-facing value is
  `review`. `gentle_title_orchestrating` likewise keeps its machine-key-derived
  token name; only its user-facing value is `gentle`. The retired `*_working_subs` token family (the old `working (n)`
  count display) is swept, never written.
- Coexistence: `herdr-pi-tree` stays installed but disabled for gentle-owned
  panes (O1). No uninstall, no token migration, no dual-run merge — ownership
  handoff is by enable/disable switch, reversible at any time.
- Rollback: disable this plugin → producer stops writing; consumer sweeps
  only `gentle_*` tokens + labels it set (O5); pi-tree re-enable restores
  `↳N` behavior with zero data migration.
- Future breaking changes (grammar change, TTL change, badge-slot change)
  require a new token version suffix (`_v2`) with a dual-emit period; old
  names are removed only after observed zero-read evidence. Token-name
  versioning (not sidebar-config versioning) is the compatibility mechanism.

## 10. Unresolved decisions (do not implement against guesses)

- **U1. Notification CLI + dedup:** exact `herdr notification` syntax, flags,
  and any Herdr-side dedup/suppression semantics. Normative until resolved:
  consumer-side `¬ask → ask` transition gate (§7).
- **U2. Event catalog + poll cadence:** full `[[events]]` catalog of the
  plugin host and the daemon's snapshot poll cadence (must be ≪ TTL).
  Resolved in part: `pane.agent_detected` invokes
  `node bin/gentle-status.js --once` as an immediate one-frame refresh, while
  `[[startup]]` (no args) remains the polling-daemon bootstrap. The remaining
  catalog beyond this hook stays unresolved.
- **U3. pi-tree producer file:** which file in `herdr-pi-tree` emits
  `pi_subagents_work_v1` (only `lib/state.js` consumers were traced); needed
  to confirm no shared writer path.
- **U4. Review-in-progress matcher — RESOLVED (task 8):** Pi in-process `tool_call`/`tool_result` seam for the exact registered tools `gentle_review`, `gentle_review_capture`, `gentle_review_capture_group`, `gentle_review_scope` (G5), tracked by `toolCallId`, OR-combined with the reserved `gentle-pi:review:blocked` hook. Fail-safe semantics: `review:` label only while a review tool call is in flight (or the hook reports active); `reviewId` is a sanitized correlation id, never a provider verdict. During a capture-group run the single parent capture-group call stays in flight across the whole multi-reviewer span, so that one call alone holds `review:` — no per-reviewer tracking. The consumer renders this leg as user-facing `review` (machine key stays `review`).
- **U5. Changes badge — RESOLVED (two-row contract):** the `±N` vs `~N`
  selection no longer exists — the combined badge is retired in favor of
  independent `+N`/`-N` segments from exact `gentle_changes_v2` added/deleted
  totals, plus the daemon-side `↑N` pull marker (§5.3). The producer mirrors
  the Gentle Shell `SessionChanges` model semantics over the same transcript
  `SESSION_CHANGE_ENTRY` evidence (never git and never an approximate
  reaggregation): files keyed by `(root, path)`, evidence-ID dedup,
  identical before/after records skipped, first `before` preserved with
  latest `after`, unavailable on broken snapshot continuity or any
  `kind: unavailable` snapshot (unavailable files stay in the file count
  with 0 added/0 deleted), and unified-patch line accounting for available
  text/absent snapshots (absent maps to empty text for patch counts).
  Remaining transport note: cross-process delivery of entry facts to the Pi
  producer extension still rides the session transcript.
- **U6. Gentle source pin:** canonical `gentle-shell` checkout vs versioned
  package pin the producer/consumer build against.

## 11. Verification criteria (task 4 close)

Docs-only task: no test runner (TDD n/a). Verify by re-reading this file and
confirming each criterion has a normative section:

| # | Criterion (sidebar behavior) | Normative section |
|---|------------------------------|-------------------|
| V1 | Sidebar shows the active TaskStore role with live subagents | §4.2 (role source G3 + `gentle_roles_v1`), §5.2–§5.3 |
| V2 | Sidebar shows `ask` on open question | §4.2 (G4 → `ask:`), §5.2 priority, §7 notify-once |
| V3 | Sidebar shows `review` during native review | §4.2 (review tool lifecycle → `review:`, incl. capture-group parent call), §5.2 priority |
| V4 | Change segments render from Gentle session-changes | §4.2/§4.4 (`gentle_changes_v2`), §5.3 `+N`/`-N`/`↑N` |
| V5 | No collision with pi-tree `↳N` / `state_*` names | §3 O1/O2/O4, §9 rollback |
| V6 | Stale panes fall back to `idle`, orphans swept on handover | §3 O5, §5.4, §6 |

Task closes when V1–V6 are all traceable above and the file re-read reports
path + line count. Any untraceable cell → `status: partial` with the gap
list, not silent.
