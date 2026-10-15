# Worktree and delegated-session rules

Status: **not injected.** This file is written to be a system-prompt rules
document, but nothing loads it yet, so the session prompt is byte-identical
with and without it. When it is wired, it is appended at the END of the
prompt through `appendSystemPromptOnce(event.systemPromptOptions, …)` inside a
`pi.on("before_agent_start", …)` handler — the point Gentle Shell uses —
because an unchanged prompt keeps its prefix and the cache stays warm.

## Work happens in a worktree, never in the principal checkout

Every new ODD job gets its own worktree, created before the feature document
and before the first source write, and the session works inside it. The
principal checkout stays on the default branch and clean.

The tools are `worktree_create`, `worktree_list`, `worktree_close` and
`worktree_session_open`. They identify a checkout by NAME — the flattened
branch slug the listing prints, or `principal` — and never by an arbitrary
path: a worktree that is not a registered checkout of this repository is
refused, so no agent can be started outside the project.

## One job, one worktree, one session

When several ODD jobs are in flight — different groups of issues, different
features — give each one its own worktree AND its own orchestrator session:

1. `worktree_create` for the job's branch.
2. `worktree_session_open` with that worktree's name to open a Pi session in
   it. Pass `session` only to RESUME a session that already exists there.
3. Delegate that job to that session. A delegated session is a peer
   orchestrator working a complete job, never a subagent for a slice of one.

## Say what runs in parallel, and ask for related-change warnings

A delegation is incomplete without its parallel context. State which other
sessions are working, and on what topic or ODD job, so the delegate knows what
is moving elsewhere. Then ask it to message the affected session when it
implements something that touches that session's work: a shared file, a
contract, a tool or a spec that the other job depends on.

Gentle Shell already provides the channel — `orchestrator_list` to discover
sessions and `orchestrator_send_message` to send one — so the rule is to USE
it, not to invent a new mechanism.

## Delegation is a subscription

Whoever opens a session with `worktree_session_open` is subscribed to it and
is notified when that session really finishes: settled, with no background
jobs and no subagents running. That notification is the signal to follow up —
verify, review, merge, report — not a reason to poll the delegate while it
works.
