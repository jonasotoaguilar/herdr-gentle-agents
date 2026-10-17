# Agent worktree tools (`worktree_*`)

Four Pi extension tools plus one mode command, so an agent can manage its
own checkout the way `~/.pi/agent/AGENTS.md` prescribes — one worktree per
thread — and open delegated Pi sessions inside those checkouts —
without hand-rolled `git worktree` argv. without hand-rolled `git worktree` argv. Everything below is
checkable against `extensions/gentle-worktree-tools.ts` and
`lib/worktree-*.js`; nothing here is plan, only code.

## Tools

All four are registered with `pi.registerTool()` from
`extensions/gentle-worktree-tools.ts` (listed in the Pi package's
`pi.extensions`). Failures return `isError: true` with structured
`details`; success output is terse, one line per worktree at most. Every
tool draws its own native compact/expandable card (`lib/worktree-card.js`
through `renderShell: "self"`): one git-branch glyph (⎇) and the
warning theme role — the closest documented role to git orange, since the
Pi theme schema exposes no orange — on the opening rule, the `ctrl+o to
expand`/`to collapse` hint and the evidence-backed duration right-aligned
on the closing rule, and ordered short body lines in the collapsed card
(create: `branch:`/`path:` plus `issues:` when present; list: `current:`
plus the checkout count, plus one `odd: <name> · <docs>` row per entry
that holds odd documents, with the full rows only when expanded; close:
`removed:` plus branch kept/removed; session open: `worktree:` plus
`session:`, marked when resumed). The cards follow gentle-shell's float
recipe (`gentle-shell/lib/shell-card.ts`, `CARD_STYLE.FLOAT`): one-column
transparent margins, every row padded to the full target width, a blank
padding row above the heading and between heading and body, and every row
painted behind the tone background (`toolSuccessBg` for info/success,
`toolPendingBg` for warning, `toolErrorBg` for error — `customMessageBg`
is used nowhere in gentle-shell), re-armed after every inner reset; a
theme without the role, or a width under 10, keeps the outlined card, and
the duration rides the closing rule only when it fits, never as a
placeholder dash. The agent-facing text stays precise and
short; the longer prose lives in `details` and the expanded view. The
declared `min_herdr_version` in `herdr-plugin/herdr-plugin.toml` tracks
the version this code has actually been exercised against: `0.9.4`,
verified read-only (`herdr --version`, `herdr plugin list --json`, and
`--help` for every command the plugin depends on — `plugin list`,
`plugin install`, `plugin update`, `worktree list`, `worktree create`,
`worktree remove`, `worktree open`, `pane list`, `agent start`, `agent get`,
`agent list` — all present with the flags the
allowlist uses). It is never lowered to a version that cannot be tested.

| Tool | Parameters | Approval | Success text |
| --- | --- | --- | --- |
| `worktree_create` | `branch: string` (required), `issues: number[]` (optional), `odd: string` (optional — the path of the odd `.md` to associate, must exist, exactly like supplied `issues`) | Prompts via `ctx.ui.confirm` when the host offers dialog UI (`ctx.hasUI`); non-interactive sessions proceed without it, and a refusal mutates nothing | `created: <name> · <branch>` / `path: <path>` (plus `issues: <n,n>` only when issues were given and `odd: <doc>` only when odd docs are stored; the already-owned checkout says `· already exists` on the first line, an update says `updated: <name> · <branch>`). A real creation additionally ends with `changes: already registered for this session` when gentle-shell's `session_worktree_register` host tool is available (the created checkout joins the current session's `/gentle:changes` scope, so the agent does not re-register it); when that tool is unavailable or its call fails, nothing is appended and the create still succeeds. The `.agents`/`.claude`/`.odd` symlinks (below) are silent and never add a line |
| `worktree_list` | `all?: boolean` (optional) | None — prunes dead rows (see below), otherwise read-only | The session's own checkout first — the principal or a registered worktree — then the principal line when the session is not in it, then the remaining `worktree list: …` agent rows |
| `worktree_close` | `name?: string`, `path?: string`, `branch?: string` (at most one required — exactly one selector; `name` accepts a name OR a path, name first then path), `force?: boolean` | Same `ctx.ui.confirm` gate as create (naming pending changes as `Pending changes: N files, +N/-N` when dirty, nothing when clean); a refusal keeps checkout and entry | `removed: <name> · <branch>` / `branch kept` (`branch deleted` when the branch went with it), plus `session warped to principal` when a live session was warped out first, plus `herdr workspace step skipped (…)` when the Herdr workspace step was skipped (see the close sequence) |
| `worktree_session_open` | `worktree: string` (required — the NAME `worktree list` prints, a branch name, or the checkout path; name first then path), `session?: string` (a Pi session id to RESUME; absent means a new session), `name?: string` (the agent/pane name, defaulting to the worktree name), `notify?: boolean` (default true; accepted and reported here, honoured by the finish subscription) | None — worktree-scoped by construction (see scope guard) | `opened: <worktree> · <session-id>` / `path: <path>` (`resumed` instead of the path line when an existing session is resumed) |
| `worktree_warp` | `name: string` (required — the worktree NAME `worktree list` prints, or the checkout path; name first then path), `changes?: string \| string[]` (optional — pending changes to copy into the destination checkout: omit or pass `""` or `[]` for no copy, `"all"` for everything, a list of files for selected changes only; there is no selector in the tool) | None — never opens a selector (selectors are human-only); warping to the checkout the session already runs in changes nothing | `moved: <source name>` / `to: <target name>` plus `path: now in "<path>"` / `branch: now in "<branch>"`, and a continuation turn keeps working in the new checkout |

The session moves between checkouts through `/herdr-gentle:warp <name>` (its own command for humans — a selector, or an explicit name) and through the `worktree_warp` agent tool (a required name-or-path, an optional `changes` selection, no selector, then a continuation turn so the agent keeps working). The command's success text is the two-line compact `moved: <name> · <branch>` / `to: <name> · <branch>` (a raw path only when the checkout left sits outside every known checkout); the tool's result text is the S42 card rows (`moved: <name>` / `to: <name>` plus `path: now in "<path>"` / `branch: now in "<branch>"`). Warping to the checkout the session already runs in returns `worktree warp: <name> (already there)` (byte-identical text) but shows nothing and changes nothing.

Pending changes travel only when asked (S61). Before the command moves the session it summarizes the source checkout's uncommitted changes through the shared `lib/worktree-changes.js` helper (staged and unstaged combined against HEAD, untracked files measured from disk, deletions and renames covered, binary files labelled never faked — `N files, +N/-N`). A clean checkout warps with no prompt; a dirty one opens a concise `YES COPY` / `NO COPY` choice where `Esc`/`Ctrl+C` cancels the warp with no switch and no copy. `YES COPY` copies every pending change into the destination checkout and then warps ordinarily; `NO COPY` warps ordinarily with nothing copied. The copy never mutates the source or either index, and a destination that already modifies a selected path rejects the whole warp with nothing copied, warped or switched. The tool's `changes` option is the same transfer without a prompt: omitted/empty means no copy, `"all"` copies everything, a list of files copies only those; an unknown file or a destination overlap fails the tool with no switch.

Deleting a checkout always confirms first, and the confirmation names the checkout's pending changes when it has any (`Pending changes: N files, +N/-N`, read through the same helper; a clean checkout omits the warning). The shared close still needs `force: true` for a dirty checkout — the confirmation alone never smuggles force in — except in the warp selector's `Ctrl+D` flow, where the explicit Yes for that approved row passes `force: true` deliberately for exactly that target (never the principal, never protected/foreign, whose refusals run first).

Structured `details` on success:

- create: `{path, branch, issues, created, branchCreated, hooks, warnings, pruned, replacedRows, symlinks, changesRegistered}` — `created`
  is `false` when the call returned the thread's existing checkout (see
  per-thread ownership); `branchCreated` is `false` when the worktree
  adopted an existing branch and `true` when the branch was created with
  the checkout (see branch adoption); on the adopt path `herdrAssociated`
  reports whether the best-effort `herdr worktree open` association
  happened (`true`/`false`, absent on the create path); `pruned` lists the stale git records a
  `git worktree prune` recovery dropped (empty when nothing was stale);
  `replacedRows` lists the stale registry rows dropped by the one-owner-per-path
  rule below (`[{branch, path}]`, empty when nothing shared the target path);
  `symlinks` is the silent principal dot-dir report (`{created, skippedTracked}`,
  see below — never text, details only); `changesRegistered` is `true` when the
  created checkout was registered on the current session via
  `session_worktree_register` (the trailing `changes:` line is then present)
  and `false` otherwise;
  when the recovery itself fails, the create fails with the row intact and
  `pruneError` carries the cause; `hooks` is the creation-hook report (`{ok,
  steps, warnings}`), so a failed hook step stays visible there and never
  turns success into an error. When the write replaced a malformed
  registry, the sibling backup path travels as `registryBackup`; when no
  backup could be written, the failure travels as `registryBackupError`
  (best-effort, never fatal). `warnings` carries the hook warnings plus,
  when a same-branch row pointing at a different live checkout was kept,
  the conflict line naming that checkout; on the adopt path, the adoption
  line naming the adopted branch (plus the Herdr-association outcome when
  it failed).
- list: `{worktrees: [{name, path, branch, thread, issues, status, kind}], count,
  all, pruned, warnings, pruneError}` — `name` is the printed first column (slug or `principal`); `path` is the absolute checkout path; `status` is `live`, `missing`
  (registered and still on disk but no live checkout, or a non-absolute
  path that can never name one), or `unregistered` (only with `all:
  true`); `kind` is `principal` for the principal checkout, `agent` for a
  registry row, or `unregistered` (only with `all: true`). `pruned` lists the registry paths dropped by the self-heal
  below (empty when nothing was dead, or when the prune write failed —
  then `pruneError` carries the cause); `warnings` carries the one line
  naming them (see below) and is empty otherwise.
- close: `{path, branch, removed: true, branchKept: true, thread}` —
  `thread` is the owning thread, or `null` when none was recorded. The
  checkout is selected by `name`, `path`, or `branch` (at most one): a
  `name` is the flattened branch slug the listing prints (or `principal`)
  resolved through the same resolver the warp uses — and `name` also
  accepts a checkout path (name first, then path; a path resolves only
  when it exists and belongs to this project's worktrees). An unknown name fails
  closed like an unknown path, naming the closest names, and two registry
  rows flattening to one name are ambiguous and fail closed naming both,
  never picking one. `principal` cannot be closed — it is not a registered
  agent worktree: a name or path resolving to it is refused before any
  approval, removal or registry write, with checkout and registry left
  untouched (S32). When the close warped a live session out first,
  `details.warp` carries `{name: 'principal', path, branch, sessionFile}`
  (the warped session now living in the principal); when the Herdr
  workspace step reconciled or skipped, `details.herdrWorkspace` carries
  `{status: 'reconciled', closedWorkspace, closedWorkspaces, openedWorkspace, session}` or
  `{status: 'skipped' | 'reconciled-partial', notice, closedWorkspaces?, failedWorkspace?, ...}` (see the
  close sequence).
- warp tool (`worktree_warp`, T40/S49): `{tool: 'worktree_warp', name, path, branch, kind, fromName, fromDesc, from, to, alreadyThere, cancelled, resumed}` — same `kind`/`alreadyThere`/`cancelled` shapes as the command; `resumed` is `true` when the destination's recorded session was resumed. The tool never awaits `waitForIdle` (a self-deadlock from inside a tool) and switches through `withSession`, emitting the S42 card from the fresh context and starting the continuation turn with `triggerTurn: true` and `deliverAs: "followUp"`; refusals list the available checkouts. Its card (through the tool-card contract) keeps the S42 shape: compact `moved: <name>` / `to: <name>` with names only, expanded showing the full result text with the `path:`/`branch:` rows.
- warp (its own command, not a tool): `{name, path, branch, kind, alreadyThere,
  cancelled}` — `kind` is `principal`, `agent`, or `unregistered` (a lone live
  checkout the registry does not own); `alreadyThere` is `true`
  only for the `worktree warp: <name> (already there)` no-op; `cancelled`
  is `true` only when the session switch was cancelled, in which case the
  forked target session file was removed and nothing else changed.
- session open: `{worktree, branch, path, paneId, workspaceId, sessionId,
  resumed, agentName, notify}` — exactly these nine keys. `worktree` is
  the printed NAME (the slug, even when a branch spelling was passed);
  `sessionId` is the resumed id or the minted UUID; `resumed` tells which;
  `agentName` is `name` or the worktree-name default; `notify` is the
  accepted subscription flag (`true` unless `notify: false` was passed).
  Failures are errors, never partial successes: each names the herdr call
  that failed and its exit, and a failure after the workspace was opened
  by this call names that workspace id so no half-created workspace goes
  unmentioned.

List line format (pinned by the tool tests):

```text
worktree list: <name> <branch> principal
worktree list: <name> <branch> thread=<thread> issues=<n,n[,n...]> [odd=<doc[,doc...]>]
worktree list: <name> <branch> thread=<thread> issues=<n,n> missing
worktree list: <name> <branch> unregistered        # only with all: true
```

Every agent row carries the checkout's odd document (`odd=` suffix, only
when the checkout holds any): the stored names plus whatever `odd/*.md`
the worktree holds right now, auto-detected from inside that worktree —
no manual bookkeeping. `details.worktrees[].odd` carries the same array,
alongside the absolute checkout `path` every row keeps.

The FIRST column is the NAME (S24): the flattened branch slug
(`feat/worktree-warp` → `feat-worktree-warp`), or `principal` for the
principal checkout — the identifier the warp command accepts and the close
`name` selector takes for every registered row and for the principal. The
absolute path is not dropped: it stays in `details.worktrees[].path`
(alongside `details.worktrees[].name`). One case is printed but NOT
selectable by close-by-name, and fails closed instead of picking a checkout:
any name that more than one live checkout carries — including `principal`,
which is reserved, so a branch whose slug is also `principal` makes that name
ambiguous. Pass the path or the branch in that case. An unregistered checkout
is shown with `all: true` while close (and session-open) act on registered
rows only; the warp moves to a lone unregistered checkout, and a name shared
with a registered row stays ambiguous and fails closed.

The principal checkout (S19) is the main worktree of git's listing — the
entry whose resolved path equals the main root recovered from the shared
common dir (`<principal>/.git` is the common dir for a normal
repository). It is always listed when git's listing names it, printed
distinguished as `principal` (never with `thread=`/`issues=`), never
pruned (the registry holds agent rows only), and never reported as
`unregistered`. When git's listing names no such entry, no principal line
is invented. `worktree list: none` is retired: with no agent worktrees the
output is exactly the principal line.

The session's own checkout is the FIRST line, whether that is the
principal or a registered worktree: the checkout containing or equal to
the tool context's working directory, deepest match winning, the principal
as a candidate. A session inside a registered worktree sees that worktree
(with its `thread=`/`issues=`) first, then the principal, then the
remaining agent rows in registry order. A session in the principal, or
outside every checkout, sees the principal first. A session in an
unregistered checkout sees the principal first too, unless `all: true`
asks for unregistered checkouts: then that checkout leads the listing and
the order of everything else is unchanged. The agent-row text is
unchanged.

`all: true` appends live checkouts the registry does not know about,
sorted by path — except the session's own unregistered checkout, which
leads the listing instead, and is therefore listed as `unregistered`
whenever the session runs inside one. Close refuses an unregistered target and names the three
closest registered candidates (common-prefix rank on branch, small bonus
on path match) instead of removing anything; passing both `path` and
`branch` that disagree is an error telling the caller to pass only one.

`worktree_list` self-heals (S16) through the one consolidated liveness
definition (`checkoutState` in `extensions/gentle-worktree-tools.ts`, plus
`isLiveGitRecord`/`liveIdentities` built on it): a live checkout is a path
whose state exists AND is a directory, resolved without the process cwd
(absolute inputs directly, relative inputs against the repository root)
and matched by resolved realpath identity — a row reaching a live checkout
through a symlink IS live, a FILE at the path is never live even when git
names it, and a dangling symlink reads as absent. Every absolute
registered path is checked
on every call. A row is `live` only when its state exists, is a
directory, and its realpath matches a live checkout's realpath — a FILE at the path is never
`live`, even when git names it. A path where nothing exists (the user
deleted the checkout by hand) is removed from the listing AND pruned from
the registry in one atomic write, so the tool always exposes only real
checkouts; the pruned paths travel in `details.pruned` and in a warning
line that also says git may still record the checkout until `git worktree
prune`. When the prune write itself fails, the listing still excludes
them and the warning says so (plus `details.pruneError`). A path that
exists but git no longer lists stays `missing` and is never pruned; a
non-absolute entry can never be verified without the process cwd, so it
stays `missing` (never live), exactly as before. The `all: true` extras
obey the same rule: they are built from the post-prune registry, and every
git entry is existence-checked on its absolute form (a relative entry
resolves against the repository root, never the process cwd) — a path that
does not exist is never reported, in any status, so a hand-deleted checkout
git still records cannot reappear as `unregistered` on the next call, and
`details.worktrees` never carries a path that fails the existence check.

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
(a sibling temp file created exclusively with an unpredictable suffix
plus rename, retrying a new name a bounded number of times and refusing
with a clear error rather than following or reusing anything; a write that
fails after the temp file was created unlinks it best-effort before
rethrowing, so a failed write never leaves a temp file behind and never
reports success) and
serialized by `withRegistryLock`, an
exclusive lock file beside the registry with a bounded wait and
stale-lock recovery. A malformed file is replaced on the next upsert,
never merged — and before the replacement the previous bytes are copied
to a sibling backup named `<registry>.corrupt-<timestamp>-<random>` in the same
directory (best-effort, never fatal, never clobbering: created exclusively
with an unpredictable suffix, retrying a new name a bounded number of
times, and continuing without a backup when none can be written), whose path is reported in the
upsert result and in the `worktree_create` details as `registryBackup` (or
`registryBackupError` when no backup could be written) so
the caller can name it. A valid registry is never backed up.

`worktree_create` never unregisters a live checkout (S14): when a row
already carries the branch being created but points at a DIFFERENT live
checkout, that row is not replaced — it keeps its registration, the new
checkout is recorded alongside it (`appendWorktree`, which always appends
instead of replacing by branch), and the conflict is reported in the
create `warnings` naming the kept checkout. Liveness is one consolidated
predicate (`checkoutState` in `extensions/gentle-worktree-tools.ts`): a
path names a live checkout only when something exists there AND it is a
directory (a FILE is never a checkout; a dangling symlink reads as
absent) AND its resolved realpath matches a live checkout's realpath —
relative inputs resolving against the repository root, never the process
cwd — so a row that reaches a live checkout through a symlink is live
and is kept and warned about, while a row whose path git still lists but
which no longer exists is never a live conflict. Every
same-branch row is examined, so the warning names the live checkout
regardless of row order — even when a dead row comes first. Replacement by
branch still applies to every other row.

One owner per path: when a create lands on its target path, that path ends
with exactly ONE registry row — the one just created. Any other row whose
path resolves to the same path (whatever its branch or thread: the same
absolute spelling, the same spelling with a trailing slash, or a symlink to
the target) is stale by definition and is dropped as part of the create, in
addition to the thread-owned stale row dropped after verification. A row for
a different path is never dropped, and relative rows never match. The dropped
rows travel in `details.replacedRows` (`[{branch, path}]`) and in a warning
line naming each dropped branch (for example `replaced 1 stale registry
row(s) at the same path <target>: branch 'feat/foo' at <path>; one path has
one owner ...`). Without this rule a slug collision (`feat/foo` deleted by
hand, then `feat-foo` created on the same flattened path) left two rows for
one path, and closing the old branch deleted the new checkout.

Registry entry paths must be absolute. A `worktree_close` whose entry
path is not absolute is refused with an error naming the entry and the
reason, with no mutation of any checkout and no registry change; the
pre-removal liveness check goes through the same predicate (the target
must exist as a directory AND be recorded by git, so a hand-deleted
checkout git still records, or a path replaced by a FILE, is refused as a
stale entry with the row kept), and the pre-removal check, any removal,
and the post-removal verification all use
the same absolute value derived from the entry, and `worktree_list`'s
live cross-check likewise never resolves a registry path against the
process cwd (a non-absolute entry is reported `missing`, never live).
Entry lookup matches by exact branch equality or exact absolute path
equality only. The close drops its entry by resolved identity (`removeWorktreeByPath`
with `pathIdentities`): every row that reaches the removed checkout
is dropped — the same absolute value, a realpath-equal row, or a row
whose path is a symlink (live or dangling) to it, resolved through an
explicit readlink walk that never touches the process cwd — so no stale
duplicate and no hand-written symlink row survives the close: one path
identity end to end from resolve
through verify and remove to drop, so duplicate branches or a branch that
equals another entry's path can never divert the drop; a relative row
still cannot be matched, which stays documented. The readlink walk is
bounded: a hand-written chain longer than 10 links is not followed, so a
row behind a longer chain can survive a close. That is a stated bound, not
a silent bug. `removeWorktree`'s
branch-first behaviour is kept for any other caller and is unreachable in
the close flow. A Herdr workspace id is used only when its list entry's
path resolves to exactly that same absolute target: absolute entries
compare directly, relative entries resolve against the repository root
derived from the caller's checkout (never the process cwd) for the
comparison only and are never used as a removal base. When more than one
list entry resolves to the target with different workspace ids, that is
ambiguity: no id is returned, Herdr is skipped entirely, and the close
uses the git path instead. One entry, or several entries carrying the
same id, still resolves. When no entry
matches, Herdr is skipped entirely and the close falls back to `git
worktree remove` with fixed argv; no removal argv ever names a workspace
that is not the verified target. After a removal completes, on both the
herdr and the git paths — and also when the remover itself exits
non-zero — the close compares the live checkouts against the
pre-removal snapshot BEFORE any early return: when a checkout other than
the target
disappeared, the close fails naming the vanished path (on a non-zero exit
the backend's own reason is quoted first, then the vanished path),
refuses to treat the close as successful, and leaves the registry entry
in place in both cases.
Removing only the target never trips this check. The comparison never
depends on the post-removal listing alone and compares resolved realpath
identity, never bare spellings: when that listing fails, the
close falls back to an existence check on the pre-removal live paths
through the same consolidated predicate (`checkoutState`, relative
entries resolving against the repository root) — a pre-removal live
checkout where nothing exists anymore has vanished and is named, on both
exit codes and both
removal paths, with the registry entry kept in every case. A path replaced
by a FILE reads `missing`, never vanished, so both legs agree on files.

## Close sequence (S33/S34)

`worktree_close` removes in a fixed order — warp, workspace, checkout —
and every step before the removal refuses or skips without mutating
anything it does not own:

1. **Resolve, then refuse the principal.** Name first, then path (S29),
   through the same resolver the warp uses; a name or path resolving to
   the principal checkout is refused before any approval, removal or
   registry write (S32).
2. **Warp a live session out first.** After approval, and only then:
   - A Pi session that is NOT ours but is live in that checkout
     (evidenced by `herdr agent list` agents cwd'd in the checkout)
     refuses the close with an actionable message — warp it to the
     principal from that session and retry — and changes nothing:
     checkout, branch and registry entry are left untouched. A failing
     or unparseable agent list is no evidence, so a missing Herdr never
     blocks the removal on this leg.
   - Our own session (the tool context's cwd inside the target) warps
     to the principal FIRST through the existing warp machinery
     (`executeWorktreeWarp`), and the close continues only when that
     warp actually succeeded; a failed warp stops the close before
     anything is removed. A plain tool context cannot warp (session
     control lives on the command context), so from there this fails
     closed with the warp's own message instead of removing the
     checkout from under the session.
3. **Reconcile the Herdr workspaces — only after such a warp, group-aware (S35/S36).** Herdr
   exposes no workspace path move, so the recorded fallback runs: EVERY
   workspace of the removed checkout's group is closed in order — the
   linked worktree workspaces whose list entry resolves exactly to the
   removed checkout FIRST, then the group's root — and only then a single
   normal workspace is opened at the principal (`herdr workspace create
   --cwd <principal> --no-focus`), resuming the warped session now living
   there (`lib/worktree-close-herdr.js`). The group is resolved through a
   bare `herdr workspace list` (JSON by default — `--json` is never passed,
   it yields empty output) from the fields that actually exist: every
   workspace whose `worktree.repo_key` matches the target's belongs to the
   group, the root is the member whose `worktree.checkout_path` equals its
   own `worktree.repo_root` (equivalently `is_linked_worktree === false`),
   and the linked members are the rest — live entries carry no group-id key,
   so a group derived from one would miss the root. Hypothetical group-id
   keys survive only as a fallback for entries that name no `repo_key`.
   Closing the root while a linked member is still
   open fails with `workspace_group_close_required`, so linked-first order
   is mandatory and that code is handled into a friendly order message,
   never surfaced raw. A member that is already gone (`workspace_not_found`)
   is tolerated without failing. A foreign workspace — any `worktree.repo_key`
   that matches none of the target's — is never touched. A member that cannot
   be closed stops the sequence with a partial-group report naming that
   member (`details.herdrWorkspace.failedWorkspace`, notice `herdr workspace
   step partially reconciled (…)`, `closedWorkspaces` listing what did
   close), and no reopen is claimed; a failed reopen is likewise partial,
   never success. Without a warped session this step stays silent: the
   removal below already retires the workspace with the checkout. Any other
   Herdr failure (unavailable CLI, failed lookup) skips this step with a
   short visible notice (`herdr workspace step skipped (…)`, in the result
   text and `details.herdrWorkspace`) while the checkout removal still
   proceeds.
4. **Only then remove the checkout exactly as before** (`git worktree
   remove` + registry deletion, herdr-first with the git fallback and
   the vanished-checkout guards above). After a warp the removal and its
   verification run anchored on the principal the warp moved to — the
   caller's checkout is the doomed target itself — instead of spawning
   inside the checkout being removed; without a warp the anchor is the
   caller's checkout and the removal is byte-identical to before.

## Creation path

`worktree_create` validates in order: mode gate, branch, thread identity,
issues, then repository/path refusals. Branch validation is `git
check-ref-format --branch` as the authority, after up-front rejection of
empty names, a leading `-`, whitespace, control characters, and Unicode
bidi marks. Refusals: the branch is already checked out at a LIVE path,
the target path is already a live worktree, or the target sits inside any
existing checkout or the shared git common dir. LIVE is the one
consolidated definition below (`checkoutState`): a path whose state exists
AND is a directory, resolved without the process cwd and matched by
resolved identity — so a git record whose path is gone (the user deleted
the checkout by hand) or was replaced by a FILE never blocks a create on
its own. When such stale records are the ONLY thing holding the branch or
the target path, the tool recovers with a scoped `git worktree prune`
(which drops only records whose directories are missing) and proceeds to
create; the pruned paths travel in `details.pruned` and in a warning line.
A branch genuinely checked out at a LIVE path is refused exactly as before.
No worktree path in any tool is ever resolved against the process cwd:
absolute inputs resolve directly, relative inputs (registry rows, relative
listing paths) resolve against the repository root.

The target path flattens the branch into one component
(`feat/foo-bar` → `feat-foo-bar`) at
`<repo-parent>/<repo-name>-worktrees/<slug>` (`slugifyBranch` /
`worktreePath` in `lib/worktree-git.js`). `worktree_create` is
create-or-update on the same branch: when the branch owns no live
checkout the worktree is created in that sibling layout; when it already
owns a live checkout and the caller supplied `issues` and/or `odd`, the
stored values are updated instead — a supplied `issues` (including `[]`)
and a supplied `odd` (including an empty value) REPLACE what was stored,
while an omitted field stays untouched, so removal and replacement are
the same operation and an update never wipes data the caller did not
mention. Updates report `updated: <name> · <branch>` with
`{created: false, updated: true}` and never destroy the branch, the path,
or unsupplied values. The principal checkout is editable the same way
(its record is created on demand) but is never created by this tool and
never removable. Branch adoption (S20) is
resolved BEFORE creating: when `refs/heads/<branch>` already exists (and
the branch is not checked out at a live checkout — already refused), the
worktree checks out that EXISTING branch with `git worktree add <path>
<branch>` — no `-b`, no base, the ref never created, rewritten or deleted
— and the result reports `branchCreated: false` plus a warning naming the
adopted branch. Because `herdr worktree create` cannot adopt an existing
branch, the adopt case goes through git and then associates the Herdr
workspace best-effort with `herdr worktree open --path <path> --cwd
<root>` (values as separate elements, like every other backend call);
whether that association happened travels in `details.herdrAssociated`,
and the checkout succeeding never depends on herdr. When the ref does not
exist, creation is herdr-first (`herdr
worktree create` with fixed argv, values as separate elements because
herdr rejects `--flag=value`) with a `git worktree add -b` fallback and
reports `branchCreated: true`; when
the branch ref already exists (the same-branch recovery above) the fallback
checks the existing branch out at the fresh path instead of failing on
`-b`. The
base ref is the repository's current `HEAD`. Neither backend passes
`--focus` or `--trust-repository`: trusting a repository is a human
decision these tools never take. Success is verified against `git
worktree list --porcelain -z` before anything is claimed, never trusted
from Herdr JSON. Every external process uses a fixed argv array — no
shell string is ever built. The herdr binary resolves from `HERDR_BIN_PATH`
when set, else `herdr` on `PATH`; under the test harness
(`GENTLE_WORKTREE_LIB_DIR` set by the test loaders) with no explicit
binary injected, resolution fails closed instead of spawning a live Herdr,
so tests must always inject `HERDR_BIN_PATH`. Supplied issues are verified to exist through `gh
issue view <n> --json number,title,state` (see limitations); an omitted or
empty `issues` field skips verification and records `issues: []`.

A pre-existing entry of ANY kind at the target path — an empty or
non-empty directory, a file, a FIFO, a socket, or a symlink — is refused
before any backend runs: `target path <path> is occupied by a <kind>:
remove it by hand or pick another branch; the registry was left
untouched` (the article follows the kind: `an empty directory`). `<kind>`
names what is actually there: a symlink reports `symlink to a file` or
`symlink to a directory` when its referent is one, and a bare `symlink`
otherwise — dangling, or a referent that is neither. Git's raw `fatal: '<path>' already exists` never surfaces
(and the empty directory is refused precisely because git would silently
adopt it), and no registry row is written, so removing the occupant lets
the next create at the same path succeed. The single exception is the
thread's own registered checkout, which the idempotency contract returns
as `created: false`.

The remaining path decisions share the one predicate (exists AND is a
directory, realpath identity where identity is the question):
`isPathInAnyCheckout` (`lib/worktree-git.js`) skips non-directory records and
compares both spellings and realpaths (resolving non-existent tails through
their parents), so a symlink spelling of a checkout gives the same
inside-verdict as the real spelling; `vanishedCheckouts` excludes the close
target by absolute-or-realpath identity (never lexical spelling alone) and
names only paths where nothing exists on both legs, so a FILE reads `missing`
and is never reported vanished — list, create and close cannot disagree about
the same path in any shape.

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
- **`codegraph init`** when the CLI is on `PATH` (`skipped` with a reason
  when absent). The tools do not index for you beyond this.

Creation links the principal dot-dirs (T42/S51, superseding the S21 "no
symlinks" rule for exactly these three names): on every real creation,
for each of `.agents`, `.claude` and `.odd`, when that entry exists in
the PRINCIPAL checkout — the source is always the principal, never the
current checkout — a symlink to it is created inside the new worktree,
replacing any entry already there. The step is ALL-OR-NOTHING on the
repository's tracked state (the principal's git state, read with `git
ls-files`, never guessed): when ANY of the three is tracked, no symlink
is created for any of them; only when NONE is tracked do the symlinks
apply. No symlink ever points at a missing target (an absent or
dangling source is skipped). The step is a silent hook: it adds NOTHING
to the create output in any branch and never fails the create.

What remains unchanged besides the three links: untracked env
copies, stack-detected dependency installs, and `codegraph init` when
available. Two consequences are recorded rather than hidden: a worktree
reaches `odd/` only when the repository tracks it — a tracked `odd/` is
checked out as a real directory, so a session there finds it both as the
worktree-relative `odd/…` and as the principal's absolute path, while an
untracked `odd/` is reachable in the principal alone; and closing a
tool-created checkout still needs `force` wherever env copies or a
`codegraph init` leave untracked files (a checkout with neither closes
without `force`).

The principal checkout is recovered from the shared common dir (for a
normal repository, `<principal>/.git` is the common dir), not assumed
from the caller's checkout.

## Mode switch (`/herdr-gentle:customize` — `Worktree tools` rows)

`Enabled` / `Disabled` in the customize panel flip the shared mode file (the old `/herdr-gentle:worktree enabled|disabled|status` command is removed; `customize status` is its read-only replacement and writes nothing). Writing the mode refuses a symlinked or
non-regular mode path with a clear error and touches nothing (the normal
path stays atomic: a sibling temp file created exclusively with an
unpredictable suffix and renamed into place, retrying a new name a
bounded number of times and refusing with a clear message rather than
following or reusing anything; a write that fails after the temp file was
created unlinks it best-effort before rethrowing, so a failed write never
leaves a temp file behind and never reports success), and the
command surfaces that refusal instead of claiming success. The shared mode file is
`gentle-worktree-mode.json` (`{version: 1, enabled: boolean}`) in the
plugin state directory — `GENTLE_STATUS_STATE_DIR`, else
`HERDR_PLUGIN_STATE_DIR`, else
`$XDG_STATE_HOME/herdr/plugins/herdr-gentle-agents` — exactly like the
sidebar's. Missing means **enabled**; malformed never enables.

Gating is two-level: at load, the tools register only when the mode reads
enabled (the panel itself always registers, so the mode can be flipped
back); at execution, each tool re-reads the mode and fails with
`worktree tools are disabled; open /herdr-gentle:customize and apply the
Worktree tools Enabled row to enable them` when disabled. One switch covers
all five tools — create, list, close, warp, and session open share the same gate
and the same registration, with no separate session toggle; the panel's
`Enabled` row names that coverage outright (`agents can create, list, close,
warp between and open sessions in agent worktrees`). Registration
changes reload the extension runtime automatically when the registration
must change; `customize status` reports mode state, whether the tools are
registered in this session, and whether a reload ran, e.g. `customize
status: sidebar=gentle moshi=off worktree=enabled`.

### Herdr plugin version check at startup

At session startup the extension compares the installed Herdr plugin for
id `herdr-gentle-shell` against the version this package ships in
`herdr-plugin/herdr-plugin.toml` (read-only `herdr plugin list --json`, the
same lookup the sidebar wiring uses). When the plugin is missing, installed
only under the retired id `herdr-gentle-agents`, disabled, or at another
version, one short alert names the mismatch and the real command — the
remote install plus enable (`herdr plugin install
jonasotoaguilar/herdr-gentle-agents/herdr-plugin --ref herdr-vX.Y.Z` then
`herdr plugin enable herdr-gentle-shell`), the update (`herdr plugin update
herdr-gentle-shell`), or the enable for a disabled install. A locally
linked plugin counts as installed and is reported as linked, never as
missing. An absent or erroring Herdr CLI, or unreadable metadata, fails
silent and harmless: the check never throws, never blocks loading, never
writes user config, never repeats the alert within the session, and never
mentions `/reload`. The logic lives in `lib/herdr-plugin-check.js` and is
pinned in `tools/herdr-plugin-check.test.js` with every external call
stubbed.

### Warp command (`/herdr-gentle:warp`, S23)

`/herdr-gentle:warp <name>` moves the session to the named
checkout, where `<name>` is the flattened branch slug the listing prints
(`feat/worktree-warp` → `feat-worktree-warp`), or `principal`. With no
argument it opens a selector of the project's other live checkouts — the
principal first, then the registry rows, then the live checkouts the
registry does not own — with the active checkout travelling in the title as
text, never as an option; a final `Create new worktree…` entry (always
last, plain action text with no `+` prefix and no separator row above it —
the host selector has no non-selectable row, so every option is a real pick) first asks for the change
type through an inline custom single-select — feat, fix, chore, docs,
style, refactor, perf, test, build, ci, revert with their human labels,
feat first, eleven data rows only with no selectable Back or Confirm row
(Tab alone returns quietly to the checkout selector; the host `select`
remains the fallback where no custom UI exists, there Esc cancels) — then
for the change name through an inline custom text input in the same dock
starting truly empty (no example text renders inside the input; only the
actually typed value ever shows, with the Pi cursor marker after it; Tab
goes Back to the type field with the kept name and the kept type restores
the cursor; the host `input` remains the fallback where no custom UI
exists), deriving
branch `<type>/<slug>` and checkout `<type>-<slug>` per the branch-pr
skill's `^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$`
before creating through a git-only creation (a plain git checkout plus
the registry row through the same `worktree_create` validations — never a
Herdr workspace; the checkout lands beside the PRINCIPAL checkout even
when the wizard runs inside a linked worktree, while the branch HEAD
still comes from the current checkout) and warping
into it — between the name field and the creation run two optional
multi-select panels sharing one component in the gentle-shell ask/choice
questionnaire style (thin accent rules, the panel's own prompt, aligned
`[ ]`/`[x]` data rows with a focused chevron, a `page n/m · k selected`
count of the current list, dim key footer): first the open issues fetched
through
the `gh` CLI asynchronously with a bounded timeout (`gh issue list --state open --json number,title`, searched
by number or title), then the `.md` files under `odd/tasks/` of the
current checkout (the branch the worktree will be born from, searched by
name), both rendered inline through `ctx.ui.custom` with no overlay
options — the same bottom-anchored region as the type/name prompts — instead of a floating overlay (S48). Each field is a standalone panel
(its own title, its own rows, its own footer — never shared chips, tabs
or step counters across fields; the `page n/m` count paginates the
current list only). Keys per panel: Up/Down move,
Left/Right turn pages, T opens the dedicated top search field (typing
filters live, Enter/Esc leaves it keeping the filter without confirming
or cancelling), Space toggles the focused checkbox, Enter confirms the
field (empty is valid, so there is no Confirm row and no phantom row
after the last data item), Tab returns to the previous field with every
value kept (there is no selectable Back row anywhere, even on an empty
filter), Esc cancels the whole creation.
Confirming with nothing selected proceeds with empty values; the
issues step is skipped silently when `gh` is missing, unauthenticated,
erroring, timing out, or reports no open issues, and the odd step when there are no
documents — neither ever blocks the creation. A picker that cannot load
or render STOPS the creation loudly instead of silently skipping it.
The wizard is sequential (type, name, issues, odd — one standalone panel
at a time, never nested, the previous panel disposed first): Tab Back
re-opens the previous field with the kept type, name,
issues and odd values, and the creation plus the warp run exactly once
after the odd field confirms — and after a session preflight, so an
allocated-but-missing session file with nothing in memory refuses before
any branch, checkout or registry write (a usable file, or valid
in-memory entries the carry path clones, proceeds). The issues and odd
sources fetch once per wizard invocation (prefetched while the type/name
panels hold the user; revisits reuse the cache, never refetch), and each
revisit restores the exact pass left behind — kept selections, filter
text, page and cursor — through the echoed revisit state. Cancelling at any field
(Esc) changes nothing, an empty or unrepresentable name refuses with an
actionable message, and a duplicate branch refuses with the create tool's
own message; an
explicit `<name>` skips the selector and also resolves a lone unregistered
checkout. The project's live checkouts are discovered at session startup
(S28: every repository worktree through git is registered when missing —
the creation path is only where new ones are born) and freshly on every
warp invocation. The agent tool (`worktree_warp`) resolves the same way — a required name-or-path, name first then path, unknown/foreign/ambiguous failing closed with the available checkouts listed — but never awaits `waitForIdle` (a self-deadlock from inside a tool) and never opens a selector. The command keeps the idle-slot wait (`await ctx.waitForIdle()` before forking); the tool switches through `withSession` from the tool context, emitting the S42 card from the fresh session and starting the continuation turn (`triggerTurn: true`, `deliverAs: "followUp"`). Session control
(`waitForIdle`/`switchSession`) lives on the extension command context, so
a tool context cannot do this. The name resolves through the same resolver
as close-by-name — one place, never two: an unknown name fails closed
naming the closest names (up to three), and a name that more than one live
checkout carries is ambiguous and fails closed naming each of them, with the
unregistered one marked as such when the warp is not allowed to take it.
`principal` is reserved, so a branch whose
slug is also `principal` makes that name ambiguous too.

Success text is the two-line compact `moved: <name> · <branch>` / `to: <name> · <branch>`, both read from the checkout's CURRENT branch and head in git (a stale registry row never shows); warping to the checkout
the session already runs in returns `worktree warp: <name> (already there)`
(the text is byte-identical) and changes nothing and shows nothing — no fork,
no switch, no OSC-7, no notification, no message, no record write (R1). Exactly ONE visible confirmation exists per real first move: the fork's styled card — one short notice naming the new checkout (`Worktree warp: now in <path> (branch '<branch>').`). A resume switches silently (R2: the recorded session already carries its notice, so re-entering appends no copy); already-there warps show nothing at all, and cancelled switches (the host never runs the session callback for those) and refusals send none. A target whose path does not exist or is not a checkout of this repository fails closed before any fork or notice (`no live checkout for "<name>" at <path>`, naming `git worktree list`). The command itself stays silent on success (no duplicate notification), and the notice renders as a styled card — not Pi's default `[worktree-warp]` block — through the `worktree-warp` message renderer the extension registers. The card carries the shared branch glyph, the capitalised label `Warp · moved`, and the compact ordered name-only lines `moved: <source name>` / `to: <target name>` (no branch, no path on either row) read from the message details; expanded (ctrl+o) it appends exactly `path: now in "<current absolute path>"` and `branch: now in "<current branch>"` in that order, never the prose notice. In the expanded form nothing is cut: long lines wrap to the inner width, and only the compact row may clip. Its tone is the documented `warning` role: the installed Pi theme schema exposes no orange role, so warning (yellow in the built-in themes) is the closest documented match for git-orange. Like the tool cards it follows gentle-shell's float recipe: full-width rows in one-column transparent margins with a blank padding row above the heading and between heading and body, every row painted behind `toolPendingBg` (the tone-table role for warning; `customMessageBg` is used nowhere in gentle-shell) and re-armed after every inner reset — a theme without the role, or a width under 10, keeps the outlined card. Refusals and cancellations send no card, so only failures notify. Fork vs resume is a filtered-point comparison (S43): the point of a session is its ACTIVE branch — the live leaf's `parentId` path exactly as `getBranch(leaf)` walks it, never all append-only entries (an abandoned leg after a branch-off does not count) — filtered to entries that are not our own bookkeeping, and it still travels on the records for inspection. Bookkeeping is exactly four proven shapes: the `custom` warp marker, the `custom_message` warp notice the switched-to session sends (it persists through the runtime's message entry, which is why the old filter re-forked every warp back), the `custom` session-worktree registration entry startup appends, and every `session_info` checkout rename. Anything else — user/assistant/tool entries, model/thinking changes, unknown custom shapes — is session content and counts, so a fresh fork's filtered point still equals its source's. The leaf of a session file is recovered the way the runtime itself does (its index keeps the last entry's id; no separate leaf pointer is persisted). Every transition records BOTH sides at their post-transition points read FRESH — the destination file as re-read after the switch (the file the live runtime kept appending to, never the stale pre-switch manager and never copied from the source) and the session file just left, each its OWN point — and a warp resumes the destination file only when that record names an absolute session file that still exists AND the destination file's actual point equals the current session's point (same content, no fork, no notice); a checkout with no usable record, an unreadable destination, or a different point because real work happened, forks. Limitation: a model or thinking-level change counts as content (it changes the effective session), so a hop across one forks; concurrent warps may each fork with the last writer winning. Every fork branches from the highest identical ancestor: the warp climbs the session tree's `parentSession` chain while each ancestor's filtered point equals the current session's and forks from the highest such ancestor (bounded, failing safe to the last good file), so an untouched fork yields a sibling of the first fork while an advanced session yields its own child. Because a sibling fork was cut from the ancestor, the current leaf (a notice or rename the fork appended later) is not in it: positioning then falls back to the deepest non-bookkeeping entry of the current active branch, which the climb guarantees the fork holds. Each fork is renamed through `SessionManager.open(path).appendSessionInfo(name)` to carry its checkout (the session's original name — its first `session_info` entry, else the current name, else the checkout label alone — + " · " + the checkout name written once, never on resume, never rewritten when already there). Work written after a visit stays in the thread where it was written: warping back later resumes each checkout's own session instead of copying the new work over. A missing, corrupt, or stale record (its
session file is gone) forks once more and overwrites the record; a corrupt
record never fails the warp. The record lives in its own repo-scoped file
`<git-common-dir>/pi-warp-sessions.json` (beside `pi-worktrees.json`, never
inside it), mapping each checkout realpath to `{sessionFile, tipId, count,
updatedAt}` (`{sessionFile, leafId, entryCount, updatedAt}` reads identically
for records written before the fix); it is written only after a successful switch, so refusals, `Esc`,
and the already-there no-op write nothing. The mechanism is
`await ctx.waitForIdle()`, capture the session file/leaf/cwd, refuse when
there is no persisted session, refuse when the target is not a live checkout
of this repository, resume the recorded session file when it is still usable
and its point equals the current session's (status update only, no message), else `SessionManager.forkFrom` from the highest identical ancestor (or, for a session
Pi has not written to disk yet — brand-new, living only in memory — clone
the in-memory entries into a session allocated for the target cwd via
`SessionManager.create` + `open`), `branch(leaf)` (or `resetLeaf()` when
there is no leaf) plus one `appendCustomEntry` transition record naming both
cwds — skipped when the target already carries that exact transition, so the
custom-entry sequence never accumulates duplicates — then `ctx.switchSession`
with a status update and the one-line transition notice (triggering no
turn). `cancelled` is a real outcome, not a success:
it removes the forked target session file (a cancelled resume keeps the
recorded file, which still belongs to the checkout), reports it, and changes
nothing else.

Honest scope of the move: the SESSION cwd changes and the tools operate in
the target, while the PROCESS cwd does not (Pi never calls `process.chdir`).
After a successful switch the command emits OSC-7
(`ESC ] 7 ; <file-url> ESC \`, a percent-encoded `file://` URL of the new
cwd, only when the output stream is a TTY) so
the TERMINAL learns the new cwd, and Herdr follows it natively: it embeds
ghostty-vt, whose `pwd_changed` callback is documented as fired by OSC 7,
so its pane pwd tracks the emission and new panes, tabs and workspaces with
`new_cwd = "follow"` inherit it; no cmux-style socket protocol is needed.
That Herdr leg is documented from herdr's own source and changelog and is
NOT exercised end to end here — herdr's CLI offers no way to inject bytes
into a pane and no field for the terminal pwd (`herdr api snapshot` reports
only each agent's `cwd` and `foreground_cwd`) — while the emission itself is
unit-tested for its exact bytes and its TTY guard. The open interactive
shell never changes directory: a child process cannot change its parent
shell's cwd.

## Session open (S25)

`worktree_session_open` opens a Pi session in a Herdr worktree, and only
in a worktree. The scope guard is enforced, not documented: the `worktree`
value resolves through the S24 name resolver (`resolveCheckoutByName` in
`extensions/gentle-worktree-tools.ts` — one resolver, never a second
one) against THIS repository's registered live worktrees only. A branch
spelling resolves through its flattened slug; a name is tried first and
then a path (S29) — a path resolves only when it exists and belongs to
this project's worktrees, while a foreign path is refused before any
backend runs with `pass the worktree NAME
'worktree list' prints, not a path`, so every command it runs is about a
worktree of THIS repository and never about another checkout. The
principal checkout is refused (a session there
delegates nothing), an unknown name fails closed naming the known ones,
and a registered row whose checkout is gone is refused as stale — only a
registered, live worktree proceeds.

Launching is composed, because no single Herdr command starts a worktree
AND a command in it (`herdr worktree create`/`open` and `herdr pane
split` take no command, while `herdr agent start <NAME> --kind <KIND>
--pane <ID> [OPTIONS] [-- [AGENT_ARG]...]` starts an interactive agent in
an EXISTING pane at a shell prompt):

1. `herdr worktree list --cwd <repoRoot>`; the worktree's workspace is the
   entry matching that branch/path, read as `open_workspace_id`.
2. When there is none, `herdr worktree open --branch <branch> --cwd
   <root> --no-focus` opens one, and `root_pane.pane_id` plus
   `workspace.workspace_id` from its JSON (the same shape `worktree
   create` returns) are used. When the open of an already-open worktree
   fails, one fresh list decides whether a workspace appeared anyway
   (proceed) or the failure stands — the open is deliberately not assumed
   idempotent, because that was never tested against the live binary.
3. When there IS one, `herdr pane list --workspace <id>` names the panes
   and the ROOT pane — the lowest `<workspace>:pN` index, the convention
   every observed workspace uses — is used.
4. `herdr agent start <agentName> --kind pi --pane <paneId> --timeout
   <ms> -- <pi argv>`, where the Pi argv is `--name <agentName>` plus
   `--session <id>` when resuming or `--session-id <minted>` for a new
   session. The id is minted as a UUID (`crypto.randomUUID()`), valid in
   Pi's `[A-Za-z0-9._-]` session-id charset, so it is known immediately
   and returned. The pane's id must carry the worktree's workspace — and the
owner a pane reports, when it reports one, must agree with it — and its
cwd, when the pane reports one, must be the worktree or inside it, before
Pi starts, so Pi's own session directory is the worktree's: no
`--session-dir` is ever passed. A pane whose shell moved elsewhere is
refused, because a session started there would not be in the worktree.

Success text is exactly the two ordered lines `opened: <worktree> · <session-id>` and `path: <path>` — or `resumed` as the second line when an existing session id is resumed.
The `herdrArgv` allowlist (`lib/worktree-git.js`) gains exactly the
commands and flags this uses — `worktree open` (`--branch`, `--cwd`,
`--no-focus`), `pane list` (`--workspace`), `agent start` (positional
name, `--kind`, `--pane`, `--timeout`, `--` plus the Pi argv), `agent get`
(positional target) and `agent list` (no flags) — and keeps its refusal
of `--trust-repository`, because trusting a repository is a human
decision these tools never take. The session tool itself only ever passes
`--no-focus`; the allowlist still accepts `--focus` for the `worktree
create`/`open` calls that predate it. The version floor
stays `0.9.4`: every one of those flags was run against the installed
binary before the spec was written.

### Finish subscription (S26)

Opening a session subscribes the creator to that delegate's real finish:
with `notify !== false` (the default) `worktree_session_open` starts ONE
watcher for the pane it just opened; `notify: false` starts none and never
polls. Watchers coexist in a registry keyed by pane id (opening a pane that
already has a watcher replaces it).

The watcher polls `herdr agent get <paneId>` — the pane id the tool returns
in `details.paneId`, never the kind name — on a bounded interval, never a
busy loop: every 15 s by default, with a 60 s launch grace window before
anything is concluded (the delegate is idle right after `agent start`, so a
finish inside it is impossible) and a 4 h maximum wait. The timer is cleared
and unref'd when it ends.

A finish is `agent_status` reading `idle` AFTER that same pane was observed
`working` at least once, and only for the session this tool opened: the
session file the pane publishes must name that session. `blocked` is the
delegate waiting for input and is not a finish. Exactly one of four outcomes
is reported — and delivered, unless the host never accepts the message, in
which case it is dropped when the maximum wait passes rather than retried
forever:

- `finished` — idle after working.
- `never-started` — idle without ever reporting working.
- `vanished` — the pane or agent disappeared (`agent_not_found`).
- `timed-out` — the maximum wait passed with no finish.

None of the last three claims a finish. Delivery is one custom message to
the creating session — the next send waits for the previous one to settle,
and a send that fails is retried rather than repeated, so the creating
session is told once — `customType` `herdr-agent-sessions.finished`, sent as
`{deliverAs: "followUp", triggerTurn: true}`, the route incoming session
messages already use, because the orchestrator has to act on it (verify,
merge, report). The content states which outcome was observed and names the
worktree, the pane and the session id; `details` carries the same facts as
data (`{worktree, branch, path, paneId, workspaceId, sessionId, agentName,
outcome, seenWorking}`).

Honest limits, recorded not hidden: the watched state is another process's
published view, so "never started" and "never reported anything" are
indistinguishable — the never-started message says so — and a vanished pane
is reported as vanished, never as a finish. A finish is concluded only for
the session this tool opened, matched against the session file the pane
publishes, and that leaves three cases worth naming:

- A pane whose agent publishes NO session binding at all leaves the
  published status as the only fact, so a finish is concluded from it. This
  is the pre-binding contract, and the one case where a pane holding
  something other than the delegate could be reported as our finish.
- Resuming with a PARTIAL session id (Pi resolves it to a file) cannot be
  proven ours from the file name, so it reports `never-started` instead of
  claiming a finish.
- Resuming with a RELATIVE path has the same effect: the pane publishes an
  absolute path, and the file name is compared against the id you passed.

## Per-thread ownership

One worktree per thread. Thread identity resolves from
`GENTLE_WORKTREE_THREAD` first, else the Pi host session id via
`ctx.sessionManager.getSessionId()`; without either, `worktree_create`
fails closed (`cannot resolve thread identity: …`) and never adopts
another thread's checkout. A thread that already owns a registered,
still-live worktree gets that checkout back — the same two-line shape with `· already exists` on the first line and `created: false` in details — never a second checkout. Still-live is the
same consolidated predicate (`checkoutState`): the owned row's state must
exist AND be a directory AND its realpath must match a live checkout
(relative inputs resolving against the repository root, never the process
cwd), so an owned row that reaches a live checkout through a symlink is
live and is returned, never dropped. Idempotency consequence: a
tool-created row whose checkout the user deleted by hand is stale even
while git still lists it — the stale git record is pruned (`git worktree
prune`), creation proceeds fresh at the same path (checking out the
surviving branch ref), and the result reports the prune instead of
answering `created: false` at a missing path.
A stale entry
(checkout gone) is remembered and dropped only after its replacement
checkout verifies — a refusal or a failed creation leaves the row intact,
so the tool either creates successfully or fails with the row still
registered and an actionable message, never an empty registry behind a
refusal.
The cleanup drops the one row it identified as the thread's own by row
identity — the (branch, path) pair of the selected entry
(`removeWorktreeExact`) — never by branch alone and never by a path-key
lookup that can match a different row, so a live entry sharing the branch
survives whether the stale path is absolute or relative.
`worktree_list` shows each entry's owning thread; `worktree_close`
reports it (`details.thread`, plus `This checkout is owned by thread
'…'.` in the approval prompt, or `This checkout has no recorded owning
thread.`) rather than refusing — a delivered thread is routinely closed
from a later session.

## Odd-document capture

The extension observes the Pi tool pipeline (`pi.on("tool_call")` and
`pi.on("tool_result")`) for the `read`, `edit`, and `write` tools. The
capture is gated by the worktree mode, read fresh from
`lib/worktree-mode.js` on every event: a disabled or malformed mode
records nothing and performs no registry write at all. For
each call it resolves the touched `.md` path against the principal
checkout's `odd/` directory and associates it with the worktree of the
**agent's context** — the invoking context's working directory matched to
the longest enclosing registry entry — never from the file path itself.
Since S21 removed the creation symlinks, a worktree reaches an `odd/` of
its own only when the repository tracks one: the per-call leg resolves
the touched path against the principal checkout's `odd/`, so a tracked
`odd/` is associated both as the worktree-relative document and as the
principal's absolute path; the re-scan leg below only converges documents
when the worktree has an `odd/` directory at all. The detector is
INACTIVE while the session runs in the principal checkout (S30): no odd
is detected for or assigned there, so the many documents created in the
root checkout never pile up — detection stays active inside agent
worktrees. A call running in the principal checkout itself
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
  (env copies, and the `.codegraph/` index when the CLI is present)
  without ever deleting them silently — so a
  normally-created worktree is "dirty" from git's point of view from day
  one whenever those steps land anything. Pass `force: true` (forwarded as `--force` to herdr or git, only
  when asked) to close it. Without `force`, the backend's own refusal is
  the whole error and nothing is mutated: checkout, branch, and registry
  entry are left untouched.
- **The issue check (only when issues are supplied) requires `gh` and a GitHub remote, and fails closed
  otherwise.** Missing binary, unauthenticated `gh`, no GitHub remote,
  timeouts, and unparseable output each report their own cause instead of
  treating the issue as valid; a number `gh` cannot resolve is reported
  as nonexistent. An omitted or empty `issues` field needs no `gh` at all.
  There is deliberately no `status:approved` requirement:
  association plus existence is the whole contract.
- **Linux-scoped, like the rest of the project** (see the README
  prerequisites). There is no separate platform gate in the tools.
- **`.codegraph/` is never shared** and the tools do not index for you:
  creation runs `codegraph init` when the CLI is available and nothing
  more; each worktree builds its own fresh index.
