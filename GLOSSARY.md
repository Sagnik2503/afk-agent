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

**Task branch**:
The `afk/<task-id>` branch that carries a task's work. The branch is the durable record; the Worktree is disposable.
_Avoid_: feature branch, work branch

**Worktree**:
The per-task Git worktree under `.afk/worktrees/<task-id>/`, checked out on its Task branch.
_Avoid_: workspace, checkout

**Base branch**:
The repository's default branch (for example `main`), which a Pull request targets.
_Avoid_: target branch, trunk

**Sandbox**:
The Docker container that runs the agent inside the worktree. A worktree alone is not a security boundary; the sandbox is.
_Avoid_: container (when speaking about the guarantee), jail

**Sandbox image**:
The Docker image built from AFK Agent's packaged `Dockerfile`, tagged with the CLI version, that the Sandbox runs.
_Avoid_: agent image

**Sandbox logs**:
The live stdout and stderr of a running Sandbox. They are streamed while the Sandbox exists and disappear with it; they are not the Run report.
_Avoid_: run log, post-mortem log

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

**Pull request**:
The review artifact opened from a Task branch into the Base branch after a successful, pushed run.
_Avoid_: PR, merge request
