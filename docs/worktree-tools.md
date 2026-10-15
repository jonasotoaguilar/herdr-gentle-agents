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
`details`; success output is terse, one line per worktree at most. The
declared `min_herdr_version` in `herdr-plugin/herdr-plugin.toml` tracks
the version this code has actually been exercised against: `0.9.4`,
verified read-only (`herdr --version`, `herdr plugin list --json`, and
`--help` for every command the plugin depends on — `plugin list`,
`plugin install`, `plugin update`, `worktree list`, `worktree create`,
`worktree remove`, `worktree open` — all present with the flags the
allowlist uses). It is never lowered to a version that cannot be tested.

| Tool | Parameters | Approval | Success text |
| --- | --- | --- | --- |
| `worktree_create` | `branch: string` (required), `issues: number[]` (required, at least one) | Prompts via `ctx.ui.confirm` when the host offers dialog UI (`ctx.hasUI`); non-interactive sessions proceed without it, and a refusal mutates nothing | `worktree create: <path>` |
| `worktree_list` | `all?: boolean` (optional) | None — prunes dead rows (see below), otherwise read-only | The session's own checkout first — the principal or a registered worktree — then the principal line when the session is not in it, then the remaining `worktree list: …` agent rows |
| `worktree_close` | `name?: string`, `path?: string`, `branch?: string` (at most one required — exactly one selector), `force?: boolean` | Same `ctx.ui.confirm` gate as create; a refusal keeps checkout and entry | `worktree close: <path>` |

The session moves between checkouts through the mode command's `warp` verb (`/herdr-gentle:worktree warp <name>`, never a tool — the platform keeps session control on the command context). Success text is `worktree warp: <name> -> <path>`; warping to the checkout the session already runs in reports `worktree warp: <name> (already there)` and changes nothing.

Structured `details` on success:

- create: `{path, branch, issues, created, branchCreated, hooks, warnings, pruned, replacedRows}` — `created`
  is `false` when the call returned the thread's existing checkout (see
  per-thread ownership); `branchCreated` is `false` when the worktree
  adopted an existing branch and `true` when the branch was created with
  the checkout (see branch adoption); on the adopt path `herdrAssociated`
  reports whether the best-effort `herdr worktree open` association
  happened (`true`/`false`, absent on the create path); `pruned` lists the stale git records a
  `git worktree prune` recovery dropped (empty when nothing was stale);
  `replacedRows` lists the stale registry rows dropped by the one-owner-per-path
  rule below (`[{branch, path}]`, empty when nothing shared the target path);
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
  resolved through the same resolver the warp uses; an unknown name fails
  closed like an unknown path, naming the closest names, and two registry
  rows flattening to one name are ambiguous and fail closed naming both,
  never picking one. `principal` cannot be closed — it is not a registered
  agent worktree.
- warp (command verb, not a tool): `{name, path, branch, kind, alreadyThere,
  cancelled}` — `kind` is `principal` or `agent`; `alreadyThere` is `true`
  only for the `worktree warp: <name> (already there)` no-op; `cancelled`
  is `true` only when the session switch was cancelled, in which case the
  forked target session file was removed and nothing else changed.

List line format (pinned by the tool tests):

```text
worktree list: <name> <branch> principal
worktree list: <name> <branch> thread=<thread> issues=<n,n[,n...]>
worktree list: <name> <branch> thread=<thread> issues=<n,n> missing
worktree list: <name> <branch> unregistered        # only with all: true
```

The FIRST column is the NAME (S24): the flattened branch slug
(`feat/worktree-warp` → `feat-worktree-warp`), or `principal` for the
principal checkout — the identifier the warp verb accepts and the close
`name` selector takes for every registered row and for the principal. The
absolute path is not dropped: it stays in `details.worktrees[].path`
(alongside `details.worktrees[].name`). Two cases are printed but NOT
selectable by name, and both fail closed instead of picking a checkout: an
unregistered checkout, whose name is shown with `all: true` while close and
warp act on registered rows only; and any name that more than one live
checkout carries — including `principal`, which is reserved, so a branch
whose slug is also `principal` makes that name ambiguous. Pass the path or
the branch in those cases.

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
`worktreePath` in `lib/worktree-git.js`). Branch adoption (S20) is
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
shell string is ever built. Issues are verified to exist through `gh
issue view <n> --json number,title,state` (see limitations).

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

Creation creates NO symlinks (S21, superseding the S8 link requirement):
no `odd/`, `.agents/`, `.claude/` or any other link is created, and `odd/`
is no longer created in the principal checkout either — that directory
existed only to be linked. What remains is unchanged: untracked env
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

## Mode command

`/herdr-gentle:worktree enabled|disabled|status|warp <name>` follows the
`/herdr-gentle:sidebar` pattern. `enable`/`disable` are accepted as
aliases; anything else (including a missing verb) prints `Unknown option
"<raw>". Use /herdr-gentle:worktree enabled|disabled|status|warp <name>.` and mutates
nothing. `status` never writes. Writing the mode refuses a symlinked or
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
enabled (the command itself always registers, so the mode can be flipped
back); at execution, each tool re-reads the mode and fails with
`worktree tools are disabled; run /herdr-gentle:worktree enabled to
enable them` when disabled. Registration changes need **`/reload`**: the
`status` verb reports mode state, whether the tools are registered in this
session, and whether `/reload` is needed, e.g. `Worktree tools are
enabled (default; no mode file) (tools registered: yes; /reload needed:
no). Use /herdr-gentle:worktree enabled|disabled|status|warp <name>.`

### Warp verb (S23)

`/herdr-gentle:worktree warp <name>` moves the session to the named
checkout, where `<name>` is the flattened branch slug the listing prints
(`feat/worktree-warp` → `feat-worktree-warp`), or `principal`. It is a
command verb, never a `worktree_warp` tool: session control
(`waitForIdle`/`switchSession`) lives on the extension command context, so
a tool context cannot do this. The name resolves through the same resolver
as close-by-name — one place, never two: an unknown name fails closed
naming the closest names (up to three), and a name that more than one live
checkout carries is ambiguous and fails closed naming each of them, with the
unregistered one marked as such. `principal` is reserved, so a branch whose
slug is also `principal` makes that name ambiguous too.

Success text is `worktree warp: <name> -> <path>`; warping to the checkout
the session already runs in reports `worktree warp: <name> (already there)`
and changes nothing (no fork, no switch, no OSC-7). The mechanism is
`await ctx.waitForIdle()`, capture the session file/leaf/cwd, refuse when
there is no persisted session, `SessionManager.forkFrom` (or, for a session
Pi has not written to disk yet — brand-new, living only in memory — clone
the in-memory entries into a session allocated for the target cwd via
`SessionManager.create` + `open`), `branch(leaf)` (or `resetLeaf()` when
there is no leaf) plus one `appendCustomEntry` transition record naming both
cwds, then `ctx.switchSession` with a status update and a revalidation
message (triggering no turn) that tells the session to revalidate every path
and cwd-dependent assumption. `cancelled` is a real outcome, not a success:
it removes the target session file, reports it, and changes nothing else.

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

## Per-thread ownership

One worktree per thread. Thread identity resolves from
`GENTLE_WORKTREE_THREAD` first, else the Pi host session id via
`ctx.sessionManager.getSessionId()`; without either, `worktree_create`
fails closed (`cannot resolve thread identity: …`) and never adopts
another thread's checkout. A thread that already owns a registered,
still-live worktree gets that checkout back — `worktree create: <path>`
again with `created: false` — never a second checkout. Still-live is the
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
when the worktree has an `odd/` directory at all. A call running in the principal checkout itself
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
