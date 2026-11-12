# AFK Agent

**Send coding agents off to work while you're away from the keyboard.**

AFK Agent is an MVP for running autonomous coding tasks without babysitting them. You hand it a task, it gives that task its own corner of your repo, and it lets an agent work there while you get on with your life. Come back to a branch you can review, not a terminal you have to untangle.

The name is the whole design brief: if you're away, the thing has to be isolated, bounded, and safe to leave running.

## How we're getting there

Two ideas do most of the work.

### 1. One task, one worktree

Every task gets its own git worktree at `.afk/worktrees/<task-id>`, checked out on a branch named `afk/<task-id>`. Nothing is stashed, copied, or shared. An agent can edit, delete, commit, and make a mess in its worktree while your checkout stays exactly as you left it. When it's done, the result is a normal branch you can diff, merge, or throw away.

The worktree lifecycle lives in `src/worktree/manager.ts`:

- `setupWorktree(repo, taskId)` validates the ID, refuses duplicates, and creates branch + worktree.
- `listWorktrees(repo)` reports what already exists.
- `removeWorktree(repo, worktreePath)` removes the worktree; the branch stays for review.
- `createWorktree(...)` is the lower-level primitive underneath them.

Task IDs are restricted to `[a-zA-Z0-9_-]`, so a task named `../escape` fails loudly instead of writing outside `.afk/`.

### 2. A process runner that can't hang or flood

Agents are just child processes, and child processes misbehave: they hang, ignore signals, and dump megabytes into your terminal. `src/process.ts` wraps `spawn` so that every run is bounded:

- **Timeouts.** Exceed the limit and the whole process group gets `SIGTERM`; if it's still alive 5 seconds later, `SIGKILL`. No orphaned agents.
- **Output caps.** stdout and stderr share a 1 MB budget by default. Beyond that, output is dropped and flagged, not accumulated.
- **Honest results.** Every call resolves with `stdout`, `stderr`, `exitCode`, `signal`, `timedOut`, and `outputTruncated`, so callers can tell "finished" from "gave up" from "went quiet."

Together, those two pieces are the foundation: an agent can run unattended because it's boxed into its own worktree and boxed into a predictable process lifetime.

## Quickstart

```bash
npm install
npm test        # unit + integration tests
npm run dev     # runs the example CLI
```

Requires Node.js 18+ and `git` on your `PATH`. The example in `src/cli.ts` shells out to `opencode`, so that needs to be installed too if you want to run it as-is.

## What it looks like in practice

```ts
import { ChildProcess } from "./src/process.js";
import { setupWorktree, removeWorktree } from "./src/worktree/manager.js";

const repo = process.cwd();
const { branchName, worktreePath } = await setupWorktree(repo, "fix-flaky-test");

const result = await ChildProcess(
  "opencode",
  ["run", "Fix the flaky test. Do not push."],
  { cwd: worktreePath, timeout: 10 * 60 * 1000 },
);

if (result.timedOut) {
  console.log("Agent ran out of time. Partial work is still on", branchName);
}

// Review the branch, then clean up when you're satisfied.
await removeWorktree(repo, worktreePath);
```

## Project layout

```text
src/
  process.ts             bounded child-process runner
  worktree/manager.ts    git worktree lifecycle
  cli.ts                 example entry point
  index.ts
test/
  process.test.ts        timeouts, signals, truncation
  worktree.test.ts       create/list/remove/setup
  worktree.integration.test.ts
```

## License

ISC
