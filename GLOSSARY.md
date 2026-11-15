# AFK Agent

Unattended execution of coding agents against GitHub issues: isolated worktree, sandboxed run, reviewed branch.

## Language

### Inputs

**Issue**:
The external GitHub issue being delegated to the agent.
_Avoid_: ticket, task (for the issue itself)

**Task ID**:
The stable identifier derived from an issue (e.g. `issue-142-add-slug-helper`). The same issue always maps to the same Task ID.
_Avoid_: run ID, session ID

### Execution environment

**Worktree**:
The per-task Git worktree under `.afk/worktrees/<task-id>/`, checked out on branch `afk/<task-id>`.
_Avoid_: workspace, checkout

**Sandbox**:
The Docker container that runs the agent inside the worktree. A worktree alone is not a security boundary; the sandbox is.
_Avoid_: container (when speaking about the guarantee), jail

**Agent run**:
One bounded execution of the coding agent inside the sandbox. Attempts after a failure are new runs, not continuations.
_Avoid_: session, invocation

### Outcomes

**Attempt**:
One run plus its test validation. A task has at most three attempts.
_Avoid_: retry (use as the verb only)

**Run report**:
The final record of all attempts: what the agent did, test results, and remaining problems.
_Avoid_: summary, log
