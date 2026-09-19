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
  `working` (main only) from `working (name)/(n)` (delegated subagents),
  `ask` (blocked on user input), `review` (RDD/native review in flight),
  `error`, `done`, and `idle` at a glance.

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

### O4. Badge slot (`↳` taken) → FIXED SPLIT PLACEMENT, NO SLOT SHARING

- **Chosen:** the `↳N` leading-badge slot stays owned by pi-tree and MUST be
  absent under single-writer handoff (O1). Gentle renders two fixed segments:
  state segment (left, in the label: `working (name)` / `working (n)`) and
  changes segment (right, session-changes suffix `±N` / `~N`). The consumer
  never writes `↳`, never parses it, and never arithmetically combines it
  with the changes badge (no subtraction, no merging).
- **Why:** sharing one glyph slot between "delegated count" and "files
  changed" makes the badge unreadable and couples two independent facts.
  Fixed split placement keeps each fact independently observable.

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
| `agent_start` / `isIdle=false`, 0 active subs (native + TaskStore) | `gentle_work_v1=<hash>:0:<exp>`; clear `herdr:blocked` labels | `working` (main) |
| TaskStore `running`/`queued` non-empty (G3) | `gentle_work_v1=<hash>:<count>:<exp>` + `gentle_names_v1=<csv>` (names = `TaskRecord.label`/`agent`) | `working (name)` (1 sub) / `working (n)` (>1 or label withheld) |
| `ASK_USER_CHOICE_BLOCKED_EVENT` / `gentle-pi:ask-user-choice:blocked` (G4), incl. questionnaire + tool-gated `ui_prompt` | `herdr:blocked` label `ask:<intentId>` | `ask` |
| review-integration `gentle-ai.review-integration/v2` consent/capture/validation in flight (G5) | `herdr:blocked` label `review:<reviewId>` | `review` |
| agent error / task failed / transport failure | `herdr:blocked` label `error:<code>` | `error` |
| `agent_settled` + 0 active subs | `gentle_work_v1=<hash>:0:<exp>`; clear `blocked` labels | `done` |
| `SESSION_CHANGE_ENTRY` `gentle-pi.session-change/v1` tool outcome (G1/G2) | `gentle_changes_v1=<hash>:<files>:<added+deleted>:<exp>` | changes badge only (orthogonal to state) |

`waiting`/`finished` TaskStore entries never count as active. Active =
`running` + `queued` only.

### 4.3 Token formats (ABNF-ish, strict)

```text
sessionHash = 43*[A-Za-z0-9_-]   ; base64url(sha256(agent_session path))
expiry      = 1*15DIGIT           ; unix-ms, MUST satisfy expiry <= now+60000 at write
count       = "0" / [1-9] 0*15DIGIT
gentle_work_v1    = sessionHash ":" count ":" expiry
gentle_changes_v1 = sessionHash ":" count ":" count ":" expiry
                    ; <hash>:<files>:<added+deleted>:<expiry>
gentle_names_v1   = label *("," label)   ; label = TaskRecord.label/agent, 1*64 chars
herdr:blocked     = "ask:" intentId / "review:" reviewId / "error:" code
```

Validation: consumers MUST reject tokens failing the grammar (wrong hash
length, `expiry` in the past or `> now+60000` at read, non-numeric counts)
and treat the pane as `unknown → idle` for that signal (§7).

### 4.4 Examples

```text
pane.report_metadata --source gentle:v1 --token gentle_work_v1=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:2:1789000000000
pane.report_metadata --source gentle:v1 --token gentle_names_v1=planner,code-writer
pane.report_metadata --source gentle:v1 --token gentle_changes_v1=Ab3_xK9q2mZ7QwErTyUiOpAsDfGhJkL012345678:5:132:1789000000000
herdr:blocked labels: ["ask:q-7f3a"] | ["review:r-42"] | ["error:transport-timeout"]
```

Example reads: 2 delegated subs (`planner`, `code-writer`) → sidebar
`working (2)` (labels available, so `working (planner)` may rotate — see
§5.3); 5 files / +132−0 session delta → badge suffix `±132` (exact) or `~132`
(approximate — see §10 U5).

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

## 5. Consumer contract (daemon; snapshot → sidebar)

### 5.1 Snapshot inputs (read-only)

Per pane: native `working`/`blocked`/`idle` + session ref (E1), `herdr:blocked`
labels (§4.2), `gentle_work_v1`, `gentle_names_v1`, `gentle_changes_v1`.
Foreign `pi_subagents_work_v1` / `state_*` / `title_*` are observed only to
ignore them under O1 (never parsed for state, never deleted).

### 5.2 Reducer (priority order, first match wins)

```text
error         := herdr:blocked has error:* (fresh, §5.4)
ask           := herdr:blocked has ask:* (fresh)
review        := herdr:blocked has review:* (fresh)
working(subs) := gentle_work_v1 fresh AND count > 0
working(main) := native working (E1) OR (gentle_work_v1 fresh AND count = 0 AND agent not settled)
done          := agent_settled observed AND no fresh error/ask/review AND active subs = 0
idle          := otherwise (native fallback; also all-gentle-tokens-missing-or-expired)
```

Priority: `error > ask > review > working(subs) > working(main) > done > idle`
(feature v1 matrix). `blocked` labels are namespaced, so simultaneous
`ask:` + `review:` resolves deterministically to `ask`.

### 5.3 Publication (sidebar tokens)

- The consumer publishes its reduced state under `gentle_`-prefixed token
  names only (never bare `state_*`/`title_*`): e.g.
  `gentle_state_<working|working_subs|ask|review|error|done|idle>` and
  `gentle_title_<state>` carrying the human label. Sidebar config maps these
  names to the agents/spaces blocks (E10); exact block wiring is install
  configuration, not protocol.
- Label shapes: `working` | `working (name)` (exactly 1 active sub with a
  displayable label) | `working (n)` (n > 1, or label withheld/overlong) |
  `ask` | `review` | `error` | `done` | `idle`.
- Changes badge: right-hand suffix from fresh `gentle_changes_v1`:
  `±N` exact / `~N` approximate (aggregation rule pending — see §10 U5);
  rendered only when `files > 0`, orthogonal to the state label.
- Placement: state segment left (label), changes segment right (suffix).
  The consumer never emits `↳` (O4).

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

- Token budget: ≤ 16 tokens per report per pane (E8 discipline); producer
  chunks `gentle_names_v1` and drops lowest-priority name tokens first
  (names are advisory; counts are normative).
- TTL: `expiry <= now + 60000` at write; readers use `now` at read.
  Clock skew assumption ≤ 5 s (documented; not compensated).
- Field bounds: `count` ≤ 16 digits; `label` ≤ 64 chars; names CSV total ≤
  ~1 KB per pane (chunked); `intentId`/`reviewId`/`code` ≤ 64 chars,
  `[A-Za-z0-9_-]+`.
- Poll cadence: unresolved — must be ≪ 60 s TTL to avoid flapping
  (see §10 U2). No cadence is normatively set here.
- Scale: one producer per Pi pane; one consumer daemon per host; no
  cross-pane aggregation in v1.

## 9. Compatibility and migration

- Additive only in v1: new token names (`gentle_work_v1`,
  `gentle_names_v1`, `gentle_changes_v1`, `gentle_state_*`,
  `gentle_title_*`); no change to `pi_subagents_work_v1`, `state_*`,
  `title_*`, or native `working`/`blocked`/`idle` semantics.
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
- **U3. pi-tree producer file:** which file in `herdr-pi-tree` emits
  `pi_subagents_work_v1` (only `lib/state.js` consumers were traced); needed
  to confirm no shared writer path.
- **U4. Review-in-progress matcher:** exact event/field that opens and closes
  a `review` span from `gentle-ai.review-integration/v2` + `gentle_review`
  tool state (consent vs capture vs validation boundaries).
- **U5. Changes badge:** `±N` vs `~N` selection rule, aggregation
  (sum `added+deleted` vs files count), and cross-process transport of
  `SESSION_CHANGE_ENTRY` facts to the Pi producer extension.
- **U6. Gentle source pin:** canonical `gentle-shell` checkout vs versioned
  package pin the producer/consumer build against.

## 11. Verification criteria (task 4 close)

Docs-only task: no test runner (TDD n/a). Verify by re-reading this file and
confirming each criterion has a normative section:

| # | Criterion (sidebar behavior) | Normative section |
|---|------------------------------|-------------------|
| V1 | Sidebar shows `working (name)` with live subagents | §4.2 (names source G3), §5.2–§5.3 |
| V2 | Sidebar shows `ask` on open question | §4.2 (G4 → `ask:`), §5.2 priority, §7 notify-once |
| V3 | Sidebar shows `review` during native review | §4.2 (G5 → `review:`), §5.2 priority |
| V4 | Changes badge renders from Gentle session-changes | §4.2/§4.4 (`gentle_changes_v1`), §5.3 suffix |
| V5 | No collision with pi-tree `↳N` / `state_*` names | §3 O1/O2/O4, §9 rollback |
| V6 | Stale panes fall back to `idle`, orphans swept on handover | §3 O5, §5.4, §6 |

Task closes when V1–V6 are all traceable above and the file re-read reports
path + line count. Any untraceable cell → `status: partial` with the gap
list, not silent.
