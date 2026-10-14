# Agent worktree tools (`worktree_*`)

Three Pi extension tools plus one mode command, so an agent can manage its
own checkout the way `~/.pi/agent/AGENTS.md` prescribes — one worktree per
thread — without hand-rolled `git worktree` argv. Everything below is
checkable against `extensions/gentle-worktree-tools.ts` and
`lib/worktree-*.js`; nothing here is plan, only code.

## Tools

All three are registered with `pi.registerTool()` from
`extensions/gentle-worktree-tools.ts` (listed in the Pi package's
`pi.extensions`). Failures return `isError: true` with structured
`details`; success output is terse, one line per worktree at most.

| Tool | Parameters | Approval | Success text |
| --- | --- | --- | --- |
| `worktree_create` | `branch: string` (required), `issues: number[]` (required, at least one) | Prompts via `ctx.ui.confirm` when the host offers dialog UI (`ctx.hasUI`); non-interactive sessions proceed without it, and a refusal mutates nothing | `worktree create: <path>` |
| `worktree_list` | `all?: boolean` (optional) | None — read-only, never mutates the registry | One `worktree list: …` line per entry, or `worktree list: none` |
| `worktree_close` | `path?: string`, `branch?: string` (at least one required), `force?: boolean` | Same `ctx.ui.confirm` gate as create; a refusal keeps checkout and entry | `worktree close: <path>` |

Structured `details` on success:

- create: `{path, branch, issues, created, hooks, warnings}` — `created`
  is `false` when the call returned the thread's existing checkout (see
  per-thread ownership); `hooks` is the creation-hook report (`{ok,
  steps, warnings}`), so a failed hook step stays visible there and never
  turns success into an error.
- list: `{worktrees: [{path, branch, thread, issues, status}], count,
  all}` — `status` is `live`, `missing` (registered but no live checkout),
  or `unregistered` (only with `all: true`).
- close: `{path, branch, removed: true, branchKept: true, thread}` —
  `thread` is the owning thread, or `null` when none was recorded.

List line format (pinned by the tool tests):

```text
worktree list: <path> <branch> thread=<thread> issues=<n,n[,n...]>
worktree list: <path> <branch> thread=<thread> issues=<n,n> missing
worktree list: <path> <branch> unregistered        # only with all: true
worktree list: none                                 # nothing registered
```

`all: true` appends live checkouts the registry does not know about,
sorted by path; the caller's own checkout is never listed as
unregistered. Close refuses an unregistered target and names the three
closest registered candidates (common-prefix rank on branch, small bonus
on path match) instead of removing anything; passing both `path` and
`branch` that disagree is an error telling the caller to pass only one.

## Registry

`<git-common-dir>/pi-worktrees.json` (`REGISTRY_NAME =
'pi-worktrees.json'` in `lib/worktree-registry.js`, resolved through `git
rev-parse --git-common-dir`). That is inside `.git`: it never lives in a
working tree, is never committed, and is shared by every checkout of the
repository. Entries carry `{branch, path, thread, issues[], odd[],
createdAt, updatedAt}`.

Reads tolerate damage: a missing file reads as empty, malformed content is
reported (`{ok: false, error}`) instead of thrown, and the file is left
untouched — malformed never silently enables anything. Writes are atomic
(sibling temp file plus rename) and serialized by `withRegistryLock`, an
exclusive lock file beside the registry with a bounded wait and
stale-lock recovery. A malformed file is replaced on the next upsert,
never merged.

## Creation path

`worktree_create` validates in order: mode gate, branch, thread identity,
issues, then repository/path refusals. Branch validation is `git
check-ref-format --branch` as the authority, after up-front rejection of
empty names, a leading `-`, whitespace, control characters, and Unicode
bidi marks. Refusals: the branch is already checked out anywhere, the
target path is already a live worktree, or the target sits inside any
existing checkout or the shared git common dir.

The target path flattens the branch into one component
(`feat/foo-bar` → `feat-foo-bar`) at
`<repo-parent>/<repo-name>-worktrees/<slug>` (`slugifyBranch` /
`worktreePath` in `lib/worktree-git.js`). Creation is herdr-first (`herdr
worktree create` with fixed argv, values as separate elements because
herdr rejects `--flag=value`) with a `git worktree add -b` fallback; the
base ref is the repository's current `HEAD`. Neither backend passes
`--focus` or `--trust-repository`: trusting a repository is a human
decision these tools never take. Success is verified against `git
worktree list --porcelain -z` before anything is claimed, never trusted
from Herdr JSON. Every external process uses a fixed argv array — no
shell string is ever built. Issues are verified to exist through `gh
issue view <n> --json number,title,state` (see limitations).

## Creation hooks

`runCreationHooks` (`lib/worktree-hooks.js`) runs after the registry
write, in order. Every step records `{name, status, detail}` with status
`done` / `skipped` / `failed`; a non-zero exit is a `failed` step plus a
warning and never aborts the remaining steps.

- **Untracked env copies.** Candidates `.env`, `.env.local`,
  `.env.development`, `.env.production`, `.env.test`. Each is copied from
  the principal checkout only when it exists there, is NOT tracked by git
  (`git ls-files --error-unmatch`, failing closed toward "tracked" on any
  runner failure), and does not already exist in the worktree. Never
  overwrites, never copies a tracked file, never fails for a missing
  source.
- **Dependency install by detected lockfile.** Every detected stack runs,
  in table order: `bun.lockb`/`bun.lock` → `bun install`,
  `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`, `yarn.lock` →
  `yarn install --frozen-lockfile`, `package-lock.json` → `npm ci` with a
  single fallback to `npm install`, `uv.lock`/`pyproject.toml` → `uv
  sync`, `Cargo.toml` → `cargo fetch`, `go.mod` → `go mod download`. A
  missing binary is `skipped`, never a failure. No lockfile at all is one
  `skipped` install step.
- **Symlinks.** `odd/` always — created in the principal checkout first
  when absent — `.agents/` and `.claude/` only when present in the
  principal. Never `.codegraph/`: each worktree gets a fresh index.
  Existing worktree paths are never replaced; links are relative so the
  layout survives a move.
- **`codegraph init`** when the CLI is on `PATH` (`skipped` with a reason
  when absent). The tools do not index for you beyond this.

The principal checkout is recovered from the shared common dir (for a
normal repository, `<principal>/.git` is the common dir), not assumed
from the caller's checkout.

## Mode command

`/herdr-gentle:worktree enabled|disabled|status` follows the
`/herdr-gentle:sidebar` pattern. `enable`/`disable` are accepted as
aliases; anything else (including a missing verb) prints `Unknown option
"<raw>". Use /herdr-gentle:worktree enabled|disabled|status.` and mutates
nothing. `status` never writes. The shared mode file is
`gentle-worktree-mode.json` (`{version: 1, enabled: boolean}`) in the
plugin state directory — `GENTLE_STATUS_STATE_DIR`, else
`HERDR_PLUGIN_STATE_DIR`, else
`$XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents` — exactly like the
sidebar's. Missing means **enabled**; malformed never enables.

Gating is two-level: at load, the tools register only when the mode reads
enabled (the command itself always registers, so the mode can be flipped
back); at execution, each tool re-reads the mode and fails with
`worktree tools are disabled; run /herdr-gentle:worktree enabled to
enable them` when disabled. Registration changes need **`/reload`**: the
`status` verb reports mode state, whether the tools are registered in this
session, and whether `/reload` is needed, e.g. `Worktree tools are
enabled (default; no mode file) (tools registered: yes; /reload needed:
no). Use /herdr-gentle:worktree enabled|disabled|status.`

## Per-thread ownership

One worktree per thread. Thread identity resolves from
`GENTLE_WORKTREE_THREAD` first, else the Pi host session id via
`ctx.sessionManager.getSessionId()`; without either, `worktree_create`
fails closed (`cannot resolve thread identity: …`) and never adopts
another thread's checkout. A thread that already owns a registered,
still-live worktree gets that checkout back — `worktree create: <path>`
again with `created: false` — never a second checkout. A stale entry
(checkout gone) is dropped best-effort and creation proceeds fresh.
`worktree_list` shows each entry's owning thread; `worktree_close`
reports it (`details.thread`, plus `This checkout is owned by thread
'…'.` in the approval prompt, or `This checkout has no recorded owning
thread.`) rather than refusing — a delivered thread is routinely closed
from a later session.

## Odd-document capture

The extension observes the Pi tool pipeline (`pi.on("tool_call")` and
`pi.on("tool_result")`) for the `read`, `edit`, and `write` tools. For
each call it resolves the touched `.md` path against the principal
checkout's `odd/` directory and associates it with the worktree of the
**agent's context** — the invoking context's working directory matched to
the longest enclosing registry entry — never from the file path itself.
The indirection is load-bearing: `odd/` is a symlink into the principal
checkout, so one real path is shared by every worktree and file identity
cannot tell them apart. A call running in the principal checkout itself
associates nothing; associations are idempotent (`addOddDoc` records each
`odd/<rel>` once, same relative name from every worktree).

`bash` commands touching `odd/` are not reliably parseable (arbitrary
shell text, redirections, quoting), so the per-call capture is
complemented by a bounded re-scan of the worktree's own `odd/` directory
(`.md` only, at most 500 files, depth 10, 5000 entries) on **every**
pipeline event — including `bash` calls, which skip the per-call leg
entirely and still converge through the scan. The hook never throws and
never blocks the pipeline: any failure is swallowed after a best-effort
attempt.

## Known limitations

- **Closing normally needs `force: true`.** `git worktree remove`
  refuses a checkout containing untracked files or modifications unless
  `--force`, and the creation hooks deliberately create untracked files
  (env copies, symlinks) without ever deleting them silently — so a
  normally-created worktree is "dirty" from git's point of view from day
  one. Pass `force: true` (forwarded as `--force` to herdr or git, only
  when asked) to close it. Without `force`, the backend's own refusal is
  the whole error and nothing is mutated: checkout, branch, and registry
  entry are left untouched.
- **The issue check requires `gh` and a GitHub remote, and fails closed
  otherwise.** Missing binary, unauthenticated `gh`, no GitHub remote,
  timeouts, and unparseable output each report their own cause instead of
  treating the issue as valid; a number `gh` cannot resolve is reported
  as nonexistent. There is deliberately no `status:approved` requirement:
  association plus existence is the whole contract.
- **Linux-scoped, like the rest of the project** (see the README
  prerequisites). There is no separate platform gate in the tools.
- **`.codegraph/` is never shared** and the tools do not index for you:
  creation runs `codegraph init` when the CLI is available and nothing
  more; each worktree builds its own fresh index.
