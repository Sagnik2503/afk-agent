# Disposable Worktree, Durable Branch

## Status

Accepted

## Context

A failed task used to leave its Worktree on disk. Re-running the same Issue then
failed with `Worktree already exists for task: <task-id>` until the user removed
`.afk/worktrees/<task-id>/` by hand. The same dead end followed a hard crash or
reboot, where no cleanup ran at all. The leftover Worktree protected little: a
failed run that changed nothing still blocked retries.

The branch `afk/<task-id>` lives in the main repository, not in the Worktree, so
it survives Worktree removal. It is the durable record of the work.

## Decision

Treat the Worktree as disposable scratch and the branch as the durable record.

- **Failure disposal:** after GitHub sync finishes, commit any leftover changes
  to the branch (best effort), then force-remove the Worktree. Keep the branch.
- **Stale reclaim:** when Worktree setup finds a Worktree already registered for
  the Task ID, force-remove it and re-attach the existing branch instead of
  refusing to run. Reclaim does not commit uncommitted leftovers; that would make
  the worktree module depend on the GitHub sync module. Uncommitted changes from
  a hard crash are therefore discarded.
- **Success:** keep the Worktree so the result can be reviewed in place.
- **Ordering:** dispose only after sync has run, so leftovers are committed and
  the branch can be pushed before the Worktree disappears.
- **Error handling:** cleanup failures are reported but never replace the task's
  original failure. If Worktree setup itself fails, no disposal is attempted
  because the run owns nothing to remove.

## Consequences

- Re-running a failed or interrupted Issue always works without manual cleanup.
- Committed progress remains available on the branch; ignored files such as
  `node_modules` and build output are treated as disposable.
- Uncommitted work can be lost after a hard crash. That trade-off is deliberate:
  the alternative is a blocked rerun.
- The Worktree module exposes an explicit `force` option on removal. Callers
  that need the default refusal keep it.
- The task result reports whether the Worktree was removed, and the CLI points
  at the Worktree path only when it still exists.

## Amendments

- **Cancellation (`afk stop`):** stopping a run disposes of the Worktree without
  GitHub sync, an exception to the ordering rule above. Cancellation is
  deliberately immediate: the agent is killed mid-attempt, so there is no
  finished run to push or comment on. Leftover changes are still committed to
  the branch (best effort) before removal, so the durable record survives.
