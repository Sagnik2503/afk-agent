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

## Install

### Prerequisites

- Node.js `>=22.12.0`
- Git
- Docker (the daemon must be running)
- GitHub CLI (`gh`) authenticated with `gh auth login`
- macOS or Linux. Windows is supported through WSL2 only; native Windows is not supported.

### Install the CLI

```bash
npm install -g afk-agent
afk --version
cd path/to/your-repo
afk setup
```

`afk --version` prints the installed release. `afk setup` checks Git, the Docker
daemon, GitHub CLI authentication, and that the target path is a Git repository.
The path defaults to the current directory; pass one (`afk setup path/to/repo`)
to check a different clone. It reports every failure at once with what to do
next, then builds the Sandbox image (`afk-agent:base`). It writes no
configuration and is safe to run again.

To try it without a global install:

```bash
npx afk-agent --help
```

### Update

```bash
npm install -g afk-agent@latest
```

The Sandbox image lives under the stable, floating tag `afk-agent:base` so
project Dockerfiles can extend it without pinning a version. afk reuses the
cached image while it exists. After upgrading the CLI, refresh the base image
once so the new agent runtime is picked up:

```bash
docker rmi afk-agent:base
afk setup
```

### Commands

| Command      | Purpose                                          |
| ------------ | ------------------------------------------------ |
| `afk setup`  | Check prerequisites and build the Sandbox image. |
| `afk run`    | Run a coding task for a GitHub issue.            |
| `afk logs`   | Stream the logs of a running agent.              |
| `afk status` | List background runs, or show one run in detail. |
| `afk stop`   | Stop a running background agent.                 |

Run `afk` or `afk help` for an overview with examples, and `afk help <command>`
for the flags of a single command.

### Run a coding task

```bash
afk run --repo . --issue 142
```

Replace `142` with the GitHub issue number you want the agent to work on. The
target path must be a local clone whose `origin` points at the GitHub repository
that contains the issue; the existing push and Pull request safety checks compare
the two and refuse to push when they differ.

`afk run` performs the same preflight checks as `afk setup` and builds the
Sandbox image (or the repository's Project image) if it is missing, so
`afk setup` is a convenience rather than a hard gate.

A per-task lock refuses overlapping runs: starting the same issue again while a
run is active fails with the PID of the run holding the lock.

AFK Agent will:

1. Check prerequisites and validate the repository.
2. Fetch the GitHub issue.
3. Derive a stable task ID from the issue.
4. Create or resume a worktree and branch.
5. Prepare the Docker image (Sandbox image, or Project image when defined).
6. Execute OpenCode.
7. Run Validation and retries.
8. Commit any leftover changes.
9. Push the branch.
10. Open a pull request into the default branch on success; reuse an existing open pull request on re-runs.
11. Comment on the issue with the branch, pull request, commits, and test result.
12. Remove the worktree if the task failed, keeping the branch.
13. Print the final execution report.

### Options

| Flag               | Purpose                                                                |
| ------------------ | ---------------------------------------------------------------------- |
| `--model <model>`  | Model used inside the Sandbox.                                         |
| `--timeout <ms>`   | Agent run time limit in milliseconds.                                  |
| `--memory <size>`  | Sandbox memory ceiling, e.g. `2g` (default: `2g`).                     |
| `--cpus <count>`   | Sandbox CPU ceiling (default: `2`).                                    |
| `--pids-limit <n>` | Sandbox process-count ceiling (default: `512`).                        |
| `--image <image>`  | Use a supplied image instead of building the Sandbox or Project image. |
| `--no-push`        | Keep the branch local; also skips the pull request.                    |
| `--no-pr`          | Push the branch but skip the pull request.                             |
| `--background`     | Run in the background and return immediately.                          |

Every Sandbox starts with a memory, CPU, and process-count ceiling so an
unattended agent run cannot exhaust the host. The defaults are 2g of memory,
2 CPUs, and 512 processes; the `--memory`, `--cpus`, and `--pids-limit` flags
override them for a single run. Memory accepts a positive number with an
optional `b`, `k`, `m`, or `g` unit, CPUs accept a positive decimal, and the
process limit accepts a positive integer. Invalid values are rejected before
the Sandbox starts. If an Attempt is killed for exceeding a limit, it stops
without retrying and the report names the limit and the flag to raise.

### Validation

Each repository defines its own Validation as an ordered list of commands in
`.afk/config.json` under a `validate` key:

```json
{ "validate": ["npm ci", "npm test", "npm run lint"] }
```

The commands run in order inside the Sandbox after each Agent run and stop at the
first failure; the retry prompt names the failed command and carries its output.
Validation is language-agnostic: tests, type checks, linters, or any
project-specific check. Because the commands run in a fresh worktree, make each
one self-sufficient (install dependencies as part of the command, as `npm ci`
does above).

A missing `.afk/config.json` or a missing `validate` key refuses the run at
preflight with an actionable error. An empty list is a deliberate opt-out:

```json
{ "validate": [] }
```

It runs with no checks and the Run report shows `Validation: none`.

### Project images

The Sandbox image ships the agent runtime (Node, Git, OpenCode) and assumes
nothing about your repository's language. A repository that needs another
toolchain defines a **Project image**: a Dockerfile extending the Sandbox image,
referenced by an optional `dockerfile` key in `.afk/config.json`:

```json
{ "dockerfile": ".afk/Dockerfile", "validate": ["cargo test"] }
```

The path is relative to the repository root. The Dockerfile must start
`FROM afk-agent:base` — the stable tag afk maintains for the Sandbox image — so
you never pin a version. afk builds the Project image from it and uses it for
**both** the Agent run and Validation. The image is tagged with a hash of the
Dockerfile content (`afk-agent:project-<hash>`): an unchanged file reuses the
cached image, and editing the file triggers a rebuild. A repository without a
`dockerfile` key keeps using the Sandbox image unchanged.

Copy-paste templates (save as `.afk/Dockerfile`):

**Python**

```dockerfile
FROM afk-agent:base
USER root
RUN apt-get update && \
    apt-get install -y python3 python3-pip python3-venv && \
    rm -rf /var/lib/apt/lists/*
USER node
```

```json
{
    "dockerfile": ".afk/Dockerfile",
    "validate": [
        "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt",
        ".venv/bin/python -m pytest"
    ]
}
```

**Rust**

```dockerfile
FROM afk-agent:base
USER root
RUN apt-get update && \
    apt-get install -y curl build-essential && \
    rm -rf /var/lib/apt/lists/*
USER node
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
ENV PATH="/home/node/.cargo/bin:${PATH}"
```

```json
{ "dockerfile": ".afk/Dockerfile", "validate": ["cargo test"] }
```

**Go**

```dockerfile
FROM afk-agent:base
USER root
RUN apt-get update && \
    apt-get install -y golang-go && \
    rm -rf /var/lib/apt/lists/*
USER node
```

```json
{ "dockerfile": ".afk/Dockerfile", "validate": ["go test ./..."] }
```

The Go template uses Debian's packaged Go; install a newer toolchain from
[go.dev](https://go.dev/dl/) if your project needs one. Each validate command
runs in a fresh worktree, so make it self-sufficient (install dependencies as
part of the command, as the Python example does).

### Providers and credentials

The default model is free and works with no API key. To use a paid provider,
export its key and pass `--model`:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
afk run --repo . --issue 142 --model anthropic/claude
```

AFK Agent forwards only these variables into the Sandbox, and only when they are
already present in your environment:

`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`,
`XAI_API_KEY` (xAI).

Keys apply to a single Agent run. AFK Agent never writes them to disk, a Run
report, an Issue comment, or a Pull request, and it does not mount your host
OpenCode state.

Docker records container environment variables, so a forwarded key is visible to
anyone who can run `docker inspect` on that machine. This is accepted for a
single-user local tool.

### Background runs

Add `--background` to detach the run and get your terminal back:

```bash
afk run --repo . --issue 142 --background
```

The command prints the Task ID, branch, and log path, then returns immediately.
The run continues in a detached process with the same limits, retries, and
GitHub sync as a foreground run. Track it with:

```bash
afk status --repo .              # list all runs, newest first
afk status --repo . --issue 142  # one run: state, phase, attempts, sync, PR
afk logs --repo . --issue 142    # follow the run's output
afk stop --repo . --issue 142    # stop the run
```

Background runs persist their state under `.afk/runs/<task-id>/`: `run.json`
(the Run record) and `run.log` (the full run output). These survive the run, so
`afk logs` can replay the output and `afk status` can show the outcome after the
agent finishes. A run whose process died without finishing is shown as `stale`;
`afk stop` cleans it up.

`afk stop` terminates the run (SIGTERM, then SIGKILL if needed), removes the
Sandbox, commits any leftover changes to the branch, and removes the worktree.
The branch is kept. A stopped run does not push or comment on the issue.

### Watch Sandbox logs

Stream the live Sandbox output of a running agent in a second terminal:

```bash
afk logs --repo . --issue 142
```

`--issue` accepts a bare issue number or a GitHub issue URL. The command
discovers the running Sandbox for that issue, verifies it belongs to the given
repository, and follows its Docker logs. It does not call GitHub, so it works
offline and without `gh` authentication.

The stream ends when the current Attempt finishes, and you can re-run the command
to watch the next Attempt. Press Ctrl-C (or send SIGTERM) to stop watching; this
also stops the underlying `docker logs` process.

For foreground runs, Sandbox logs are ephemeral: the Sandbox is disposable and
is removed at the end of an agent run, so run the `logs` command while the agent
is still running. Background runs persist their full output to
`.afk/runs/<task-id>/run.log`, and `afk logs` follows that file across Attempts
and replays it after the run finishes.

---

## Development

Install dependencies in a clone of this repository:

```bash
npm install
```

Run tests:

```bash
npm test
```

Run TypeScript checks:

```bash
npx tsc --noEmit
```

Run the CLI from source:

```bash
npm run dev -- run --repo . --issue 142
```

### Releasing

Releases are published to npm by the `Publish` workflow. To cut one:

1. Bump `version` in `package.json` and commit the change.
2. Push a tag matching the version, for example `v0.2.0` for version `0.2.0`.
3. Store an npm automation token in the repository's `NPM_TOKEN` secret.

The workflow runs the same quality checks as CI, verifies the tag matches the
manifest version, and only then publishes the package. A missing `NPM_TOKEN`
secret fails the job before publishing with a clear error.

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
remaining problems. Runs stopped with `afk stop` are the exception: their
changes stay local on the branch. The push is refused when the branch is not under `afk/`,
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
│   ├── dispose.ts
│   ├── lock.ts
│   ├── orchestrator.ts
│   ├── report.ts
│   ├── result.ts
│   ├── retry.ts
│   ├── run_record.ts
│   ├── stop.ts
│   └── validation.ts
├── ui/
│   ├── color.ts
│   ├── report.ts
│   └── status.ts
├── worktree/
│   └── manager.ts
├── cli.ts
├── errors.ts
├── package_info.ts
├── preflight.ts
└── process.ts

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
- Background runs with persisted status and logs, and stop support.
- Per-task locking against overlapping runs.

Future capabilities include:

- Structured implementation summaries.
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
