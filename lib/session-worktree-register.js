'use strict';
// Session worktree registration for the worktree tools (customize-command
// T41/S50).
//
// gentle-shell registers a host tool named `session_worktree_register`
// (extensions/gentle-shell.ts:1875, default `direct` exposure so it is
// callable while active): it validates the path through its per-session
// SessionWorktreeRegistry (same-git-clone check, current-session check)
// and appends a `gentle-pi.session-worktree/v1` custom entry to the
// session file, which is what puts the checkout inside the `/gentle:changes`
// scope (`sessionChangeRoots` unions those entries with captured evidence).
// Merely creating a checkout elsewhere never updates the creating
// session's scope — the registry only auto-registers the session's own
// cwd at `session_start` — so the create tool calls this explicitly.
//
// The host API is `ctx.executeTool(name, args)` (Pi 1.3.0,
// dist/core/extensions/types.d.ts:280): it never rejects for tool
// failures (unknown tool, validation error, blocked call and thrown
// errors all come back as `isError: true`), and `ctx.tools`
// (types.d.ts:271) lists the tools it can call. Availability therefore
// means: `ctx.executeTool` is a function AND `ctx.tools` names the
// tool. Everything routes through the calling tool's context, so it is
// injectable in tests via a ctx double and no gentle-shell module is
// ever imported here.

const SESSION_WORKTREE_TOOL = 'session_worktree_register';

// True only when the host tool is actually available on this context:
// callable through `ctx.executeTool` and listed in `ctx.tools`. A
// context without a tool list (older doubles) counts as unavailable.
function isSessionWorktreeToolAvailable(ctx) {
  try {
    if (!ctx || typeof ctx.executeTool !== 'function') return false;
    const tools = ctx.tools;
    if (!Array.isArray(tools)) return false;
    return tools.some((tool) => tool && tool.name === SESSION_WORKTREE_TOOL);
  } catch {
    return false;
  }
}

// Register `checkoutPath` on the current session. Resolves to true only
// when the host tool ran and reported success; every other outcome —
// unavailable tool, empty path, `isError`, thrown error — resolves to
// false and never rejects, so the caller can skip silently.
async function registerSessionWorktree(ctx, checkoutPath) {
  if (!isSessionWorktreeToolAvailable(ctx)) return false;
  if (typeof checkoutPath !== 'string' || checkoutPath.length === 0) return false;
  try {
    const outcome = await ctx.executeTool(SESSION_WORKTREE_TOOL, { path: checkoutPath });
    if (!outcome || outcome.isError === true) return false;
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  SESSION_WORKTREE_TOOL,
  isSessionWorktreeToolAvailable,
  registerSessionWorktree,
};
