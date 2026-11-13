# Run Agent in Docker

Status: ready-for-agent

## Problem Statement

The harness runs the coding agent directly on the developer's machine. The agent gets full access to the host: the main checkout, the developer's credentials, and everything outside its worktree. The product is meant to be left running while the user is away from the keyboard, so an unattended agent must not be able to touch anything except its own task.

## Solution

Run the agent inside a Docker container instead of on the host. The container is built from the repository's Dockerfile and reused across sessions. It mounts only the task's worktree and the repository's Git directory, starts in the worktree, receives the task id and issue id, and runs the agent with a free model. The harness receives the same process result it gets today, so retries, execution status, and reports stay unchanged.

## User Stories

1. As a developer, I want the agent to run inside a container, so that an unattended agent cannot change files outside its worktree.
2. As a developer, I want the container to use the repository's Dockerfile, so that the agent environment is defined in one place.
3. As a developer, I want the image built automatically when it is missing, so that the first run needs no manual setup.
4. As a developer, I want the image reused when it already exists, so that later runs start quickly.
5. As a developer, I want a clear error when the image build fails, so that I can tell a broken image from a failed agent run.
6. As a developer, I want the task's worktree mounted into the container, so that the agent edits the task branch.
7. As a developer, I want the repository's Git directory mounted at the same path, so that Git commands inside the worktree keep working.
8. As a developer, I want the container to start in the worktree, so that relative paths in the agent's commands resolve correctly.
9. As a developer, I want a free model to be the default, so that unattended runs do not cost money.
10. As a developer, I want to override the model, so that I can choose another model when I need one.
11. As a developer, I want the task id in the container name, so that I can find and inspect the container for a task.
12. As a developer, I want the task id and issue id in the container environment, so that the agent and its tools can reference the task.
13. As a developer, I want permissions to be auto-approved, so that a non-interactive run does not stop and wait for input.
14. As a developer, I want a timeout on the agent run, so that a stuck agent cannot run forever.
15. As a developer, I want a timed-out container removed, so that no orphan container keeps running.
16. As a developer, I want a stale container with the same name removed before a run, so that a previous crash cannot block the next run.
17. As a developer, I want the same process result as today, so that the retry loop and the report need no changes.
18. As a developer, I want standard output and standard error captured, so that I can review what the agent did.
19. As a developer, I want large output truncated and flagged, so that a chatty agent cannot flood memory or the terminal.
20. As a developer, I want invalid task ids rejected before Docker runs, so that a bad task id cannot make an invalid container name.
21. As a developer, I want the container to have network access, so that the agent can reach the model API.
22. As a developer, I want no credentials copied into the container, so that free-model runs do not expose secrets.
23. As a developer, I want one agent handle per task, so that the task id and issue id are set once and reused across retries.
24. As a developer, I want a small image build context, so that image builds do not send the node modules and Git history to Docker.
25. As a developer, I want tests to stay on the host, so that this change does not alter test behavior.

## Implementation Decisions

- Add a Docker agent module in the agent area. It exposes a factory that takes the static per-task values and returns two operations: build the image, and run the agent.
- Factory input: repository path, task id, issue id, model, image name, Dockerfile path, and run timeout. Model, image, Dockerfile, and timeout have defaults.
- Default model is the free model `opencode/deepseek-v4.1-flash-free`.
- Default image name is `afk-agent:latest`.
- Default timeout is ten minutes for both the image build and the agent run.
- Image preparation inspects the image first. It builds only when the image is missing. A build failure throws an error that includes the build standard error.
- An agent run removes any stale container with the task's container name, ignoring the error when no container exists.
- Container name is `afk-<taskId>`.
- The run mounts the worktree at its absolute host path and the repository Git directory at its absolute host path, and sets the container working directory to the worktree.
- The run passes `AFK_TASK_ID` and `AFK_ISSUE_ID` as environment variables.
- The agent command is `opencode run` with the auto-approve flag and the selected model, followed by the prompt.
- The container uses the default Docker network, so the agent can reach the model API.
- The container runs as the image's `node` user.
- If the run times out, the module force-removes the container and still returns the process result with `timedOut` set.
- The run returns the existing `ProcessResult` shape, so the retry loop and the report are unchanged.
- Task ids are validated with the same `[a-zA-Z0-9_-]+` rule as the worktree manager, as a trust boundary before Docker.
- Add a Docker ignore file so the build context excludes node modules, Git metadata, and AFK worktrees.
- No changes to the retry loop, the report builder, the test runner, the change detector, or the worktree manager.

## Testing Decisions

- Good tests assert external behavior: the Docker argv the module produces and the process result it returns. They do not assert private helpers or argument-building internals.
- The single seam is the process runner. Tests mock that module and verify build, run, and cleanup calls.
- Only the Docker agent module is tested in this change.
- Prior art: the retry tests mock dependencies with `vi.fn`; the report tests use plain inputs and assert output; the process tests own real child processes. This change follows the retry style by mocking the process runner.
- Test scenarios: skip the build when the image exists; build when the image is missing; throw when the build fails; produce the exact run argv for image, name, mounts, working directory, environment, model, and prompt; remove the container after a timeout; return the process result unchanged; reject an invalid task id.

## Out of Scope

- Wiring the Docker agent into the CLI or an end-to-end orchestrator.
- Running tests inside the container.
- Mounting or installing node modules for the agent.
- Linux user and group mapping.
- Parsing the agent's JSON output or recording token usage.
- Rebuilding the image when the Dockerfile changes.
- Concurrent runs for the same task id.
- Mounting credentials or authentication state into the container.

## Further Notes

- Verified: `opencode run` with the free DeepSeek model works with zero credentials.
- The Dockerfile installs `@opencode/cli`, while the local CLI is a different version. Verify that the auto-approve and model flags match at the first real container run.
- Risk: the Git directory is mounted read-write, so a misbehaving agent can change shared references.
- Risk: without the Docker ignore file, the build context would include node modules and Git history.
- The repository has no domain glossary or ADRs, so this spec uses the vocabulary from the README.
