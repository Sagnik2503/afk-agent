# AFK Agent

**Send coding agents off to work while you're away from the keyboard.**

AFK Agent is an autonomous coding agent runner that lets you delegate software development tasks without babysitting the process.

Give it a GitHub issue. AFK Agent creates an isolated Git worktree, starts a Docker sandbox, and runs an AI coding agent inside it. It validates the changes, retries when appropriate, and leaves you with a branch and execution report to review.

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
                Final Report
                      |
                      v
             Branch ready for review
```

Each execution is associated with two identifiers:

- **Issue ID:** The external GitHub issue being worked on.
- **Task ID:** A unique internal identifier generated for each execution.

This allows the same GitHub issue to be executed multiple times without worktree or branch-name collisions.

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
```

Worktrees provide separate working directories while sharing the underlying Git repository.

This means:

- The agent can modify files without changing your main checkout.
- Multiple tasks can run independently.
- Changes remain available for review after execution.
- You can inspect, diff, merge, or discard the resulting branch.

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

| Agent execution | Tests | Behaviour |
|---|---|---|
| Completed | Passed | Success |
| Completed | Failed | Retry if attempts remain |
| Crashed | Any result | Stop |
| Timed out | Any result | Stop |

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
3. Generate a unique task ID.
4. Create a worktree and branch.
5. Prepare the Docker image.
6. Execute OpenCode.
7. Run tests and retries.
8. Print the final execution report.

---

## What happens after execution?

The agent's changes are preserved in its worktree.

For example:

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

You can inspect the changes with:

```bash
git -C .afk/worktrees/<task-id> status
```

Or inspect the diff:

```bash
git -C .afk/worktrees/<task-id> diff
```

The main checkout remains separate from the agent's working directory.

---

## Project structure

```text
src/
├── agent/
│   ├── docker-runner.ts
│   └── prompt.ts
├── github/
│   └── fetch-issues.ts
├── harness/
│   ├── changes.ts
│   ├── orchestrator.ts
│   ├── report.ts
│   ├── result.ts
│   ├── retry.ts
│   └── validation.ts
├── validation/
│   └── repository.ts
├── worktree/
│   └── manager.ts
├── process.ts
├── cli.ts
└── index.ts

test/
```

*The exact filenames should be kept in sync with the repository as the project evolves.*

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

Future capabilities include:

- Structured implementation summaries.
- Automated commits and branch pushing.
- GitHub pull request creation after successful validation.
- Better execution monitoring and recovery.
- More granular sandbox permissions and network controls.

PR creation is not part of the current workflow yet.

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