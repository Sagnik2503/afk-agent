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
The Docker container that runs the agent and its Validation inside the worktree. A worktree alone is not a security boundary; the sandbox is.
_Avoid_: container (when speaking about the guarantee), jail

**Sandbox image**:
The Docker image containing the agent runtime, built from AFK Agent's packaged `Dockerfile` and maintained under a stable tag. It assumes nothing about the repository's language.
_Avoid_: agent image, base image (when speaking about what the Sandbox runs)

**Project image**:
The Sandbox image extended with a repository's own toolchain, defined by a Dockerfile in the repository. The Sandbox runs the Project image when the repository defines one, and the Sandbox image otherwise.
_Avoid_: custom image, language image

**Sandbox logs**:
The live stdout and stderr of a running Sandbox. They are streamed while the Sandbox exists and disappear with it; they are not the Run report.
_Avoid_: run log, post-mortem log

**Agent run**:
One bounded execution of the coding agent inside the sandbox. Attempts after a failure are new runs, not continuations.
_Avoid_: session, invocation

**Background run**:
A task execution started with `afk run --background`: the CLI hands the work to a detached child and returns immediately while the run continues unattended.
_Avoid_: daemon, detached job

**Run record**:
The persisted state of one Background run: its phase, Attempt count (one Attempt per Agent run), process, timestamps, and outcome. Re-running the same Task ID resets the record instead of continuing it.
_Avoid_: run log (that is the child's output), status file

### Outcomes

**Attempt**:
One run plus its Validation. A task has at most three attempts.
_Avoid_: retry (use as the verb only)

**Validation**:
The ordered set of checks that an Attempt's work is correct, run after each Agent run. Each repository defines its own Validation. An empty set is a deliberate choice of no checks, not an absence of configuration. Language-agnostic: tests, type checks, linters, or any project-specific check.
_Avoid_: test command, test validation, check loop

**Run report**:
The final record of all attempts: what the agent did, test results, and remaining problems.
_Avoid_: summary, log

**Pull request**:
The review artifact opened from a Task branch into the Base branch after a successful, pushed run.
_Avoid_: PR, merge request
