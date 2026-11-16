# AFK Agent

**Send coding agents off to work while you're away from the keyboard.**

AFK Agent is an autonomous coding agent runner that lets you delegate software development tasks without babysitting the process.

Give it a GitHub issue. AFK Agent creates an isolated Git worktree, starts a Docker sandbox, and runs an AI coding agent inside it. It validates the changes, retries when appropriate, and leaves you with a branch, a pull request on success, and an execution report to review.

The goal is simple: **come back to code you can review, not a terminal you have to untangle.**

AFK Agent is being built around three principles:

- **Isolation:** Every task gets its own Git worktree and Docker environment.
- **Bounded execution:** Agent runs have timeouts, output limits, and controlled retries.
- **Reviewability:** Changes are preserved on a dedicated branch, with a report explaining what happened.

---

## How it works

AFK Agent orchestrates the entire execution lifecycle.

```text
                 GitHub Issue
                      |
                      v
                  AFK Agent
                      |
              Fetch issue using gh
                      |
                      v
             Generate unique Task ID
                      |
                      v
              Create Git Worktree
                      |
                      v
              Build Docker Image
                      |
                      v
             Start Docker Container
                      |
                      v
                OpenCode Agent
                      |
                      v
              Inspect & Implement
                      |
                      v
                Run Tests
                       |
                +------+------+
                |             |
              Pass           Fail
                |             |
                |       Retry if allowed
                |             |
                +------+------+
                       |
                       v
                 Push Branch
                       |
                       v
        Open Pull Request (success only)
                       |
                       v
                 Final Report
                       |
                       v
              Branch ready for review
```

Each execution is associated with two identifiers:

- **Issue ID:** The external GitHub issue being worked on.
- **Task ID:** A stable identifier derived from the issue, such as `issue-142-add-slug-helper`.

The same GitHub issue always maps to the same branch. Re-running an issue resumes its existing branch instead of creating a new one.

## Core design

### 1. One task, one worktree

Every task gets its own Git worktree:

```text
.afk/
  worktrees/
    <task-id>/
```

Each worktree is checked out on a dedicated branch:

```text
afk/<task-id>
# e.g. afk/issue-142-add-slug-helper
```

Worktrees provide separate working directories while sharing the underlying Git repository.

This means:

- The agent can modify files without changing your main checkout.
- Multiple tasks can run independently.
- On success, the worktree remains available for review.
- You can inspect, diff, merge, or discard the resulting branch.

A worktree is disposable scratch space; the branch is the durable record. On
failure, AFK Agent commits any leftover changes to the branch, removes the
worktree, and keeps the branch. Re-running the same issue reclaims any stale
worktree automatically.

The worktree lifecycle lives in `src/worktree/manager.ts`.

### 2. Docker sandbox

A Git worktree provides workspace separation, but it is not a security boundary.

AFK Agent uses Docker to provide an additional isolation layer for agent execution.

The container:

- Mounts the task's worktree.
- Runs OpenCode inside the container.
- Uses a non-root user.
- Applies resource and execution restrictions.
- Is removed after execution.

The intention is to give the agent access to the task workspace without exposing your entire development environment.

### 3. Bounded process execution

Agents are child processes, and child processes can misbehave.

`src/process.ts` wraps process execution with:

- **Timeouts:** Terminates processes that exceed their execution limit.
- **Output limits:** Prevents excessive stdout and stderr from consuming memory.
- **Process termination:** Sends SIGTERM and escalates to SIGKILL when necessary.
- **Structured results:** Captures stdout, stderr, exit code, signal, timeout status, and output truncation.

Every execution returns a predictable result instead of leaving the caller guessing whether the process finished successfully.

### 4. Harness and retries

The harness controls the agent's execution lifecycle.

It:

1. Runs the coding agent.
2. Executes the repository's tests.
3. Collects changed files.
4. Evaluates the result.
5. Retries eligible failures with feedback from the previous attempt.

The current retry policy is deliberately conservative:

| Agent execution | Tests      | Behaviour                |
| --------------- | ---------- | ------------------------ |
| Completed       | Passed     | Success                  |
| Completed       | Failed     | Retry if attempts remain |
| Crashed         | Any result | Stop                     |
| Timed out       | Any result | Stop                     |

The maximum number of attempts is three.

All attempts are reported, and changes accumulate in the same worktree.

---

## Quickstart

### Prerequisites

- Node.js 18+
- Git
- Docker
- GitHub CLI (`gh`)
- OpenCode
- An AI provider configured for OpenCode

### Setup

Clone the repository and install dependencies:

```bash
git clone <repository-url>
cd afk-agent
npm install
```

Authenticate with GitHub CLI:

```bash
gh auth login
gh auth status
```

Make sure Docker is running and OpenCode has a working AI provider configuration.

### Run tests

```bash
npm test
```

Run TypeScript checks:

```bash
npx tsc --noEmit
```

### Run a coding task

```bash
npm run dev -- run --repo . --issue 142
```

Replace `142` with the GitHub issue number you want the agent to work on.

AFK Agent will:

1. Validate the repository.
2. Fetch the GitHub issue.
3. Derive a stable task ID from the issue.
4. Create or resume a worktree and branch.
5. Prepare the Docker image.
6. Execute OpenCode.
7. Run tests and retries.
8. Commit any leftover changes.
9. Push the branch.
10. Open a pull request into the default branch on success; reuse an existing open pull request on re-runs.
11. Comment on the issue with the branch, pull request, commits, and test result.
12. Remove the worktree if the task failed, keeping the branch.
13. Print the final execution report.

Pass `--no-push` to keep the branch local; this also skips the pull request. Pass
`--no-pr` to push the branch but skip the pull request. The issue comment is
still posted.

---

## What happens after execution?

The branch is preserved. On success, the worktree is preserved too, so you can
review the result in place:

```text
your-repo/
├── src/
├── test/
├── .afk/
│   └── worktrees/
│       └── <task-id>/
│           ├── src/
│           └── test/
└── ...
```

The corresponding branch is:

```text
afk/<task-id>
```

On failure, AFK Agent commits any leftover changes to the branch with a
`wip(afk)` commit when possible, then removes the worktree. Any committed work
survives on the branch. Uncommitted changes are discarded when they cannot be
committed; reclaiming a stale worktree does not attempt to commit them.

On success or failure, AFK Agent pushes that branch to `origin` and posts a
comment on the issue with the branch link, commit list, test result, and any
remaining problems. The push is refused when the branch is not under `afk/`,
when `origin` does not match the issue's repository, when the branch would
need a force-push, or when a changed file looks like a secret (for example
`.env`, `*.pem`, or `id_rsa`). A refused push does not block worktree cleanup.

On a successful run whose branch was pushed, AFK Agent also opens a pull request
from the task branch into the repository's default branch. The title is the
issue title; the body links the issue, adds `Closes #N`, and summarizes the run
(attempts, tests, changed files, and commits). Re-running an issue reuses the
existing open pull request and adds a short run comment instead of opening a
second one. Pull request creation is best effort: a failure is reported in the
issue comment and the report, but it does not fail the run or block worktree
cleanup. No pull request is opened when the run fails, when there are no
commits, when push is disabled, or when `--no-pr` is passed.

When the worktree is kept, you can inspect the changes with:

```bash
git -C .afk/worktrees/<task-id> status
```

Or inspect the diff:

```bash
git -C .afk/worktrees/<task-id> diff
```

For any run, you can inspect the branch:

```bash
git log afk/<task-id>
```

The main checkout remains separate from the agent's working directory.

---

## Project structure

```text
src/
├── agent/
│   ├── docker_runner.ts
│   └── prompt.ts
├── github/
│   ├── fetch_issues.ts
│   ├── pull_request.ts
│   ├── repo_validation.ts
│   └── sync.ts
├── harness/
│   ├── change.ts
│   ├── orchestrator.ts
│   ├── report.ts
│   ├── result.ts
│   ├── retry.ts
│   └── validation.ts
├── worktree/
│   └── manager.ts
├── process.ts
├── cli.ts
└── index.ts

test/
```

---

## Current scope

AFK Agent is an MVP focused on getting unattended coding execution right.

Currently, the focus is on:

- GitHub issue ingestion.
- Unique task and worktree creation.
- Docker-based agent execution.
- OpenCode integration.
- Bounded process execution.
- Test validation and retries.
- Execution reporting.
- GitHub pull request creation after successful validation.

Future capabilities include:

- Structured implementation summaries.
- Better execution monitoring and recovery.
- More granular sandbox permissions and network controls.

---

## Design philosophy

AFK Agent is intentionally small.

Rather than building another general-purpose coding agent, it focuses on the infrastructure around unattended agent execution.

The interesting problem isn't just getting an AI agent to write code.

It's making sure that the agent:

- Works in the right place.
- Has only the access it needs.
- Doesn't run indefinitely.
- Can recover from manageable failures.
- Leaves behind work that a developer can confidently review.

**The objective is to make leaving a coding agent unattended a reasonable engineering decision.**

## License

ISC
