# Retry Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the agent, always validate the worktree, and retry up to three total attempts only when the agent completed successfully but the tests failed.

**Architecture:** A new pure orchestrator, `src/harness/retry.ts`, composes the existing `buildReport`, and receives `runAgent`, `runTests`, and `getChangedFiles` as injected dependencies. Each attempt runs the agent, then always runs tests and collects changed files (even after a crash), builds a `HarnessReport`, and decides whether to stop. Retries reuse the same worktree and append the previous test output to the prompt.

**Tech Stack:** TypeScript, Node.js, Vitest.

---

## Contracts

```ts
export const MAX_ATTEMPTS = 3;

export type RetryDependencies = {
  runAgent: (worktreePath: string, prompt: string) => Promise<ProcessResult>;
  runTests: (worktreePath: string) => Promise<TestResult>;
  getChangedFiles: (worktreePath: string) => Promise<string[]>;
};

export type RetryInput = {
  taskId: string;
  worktreePath: string;
  prompt: string;
};

export function runWithRetries(
  input: RetryInput,
  deps: RetryDependencies
): Promise<HarnessReport[]>;
```

## Semantics

| Situation | Action |
|---|---|
| Agent exits 0, not timed out, tests pass | Stop. Success. |
| Agent exits 0, tests fail | Retry, up to 3 total attempts. |
| Agent exits non-zero or is killed | Stop. Failure. |
| Agent times out | Stop. Failure. |
| Agent completed, tests timed out | Retry. |
| Any attempt | Tests and changed files always run. |
| Retry prompt | Original prompt + previous test output + changed files. |
| Worktree | Same worktree for every attempt; changes accumulate. |
| Return | Every attempt's `HarnessReport`, oldest first. |

## File Structure

- Create: `src/harness/retry.ts` — the loop, types, and retry-prompt builder.
- Create: `test/retry.test.ts` — fakes for all three dependencies.
- No changes: `src/harness/report.ts`, `src/harness/validation.ts`, `src/harness/change.ts`, `src/harness/result.ts`.

---

### Task 1: One attempt, always validated

**Files:**
- Create: `test/retry.test.ts`
- Create: `src/harness/retry.ts`

- [ ] **Step 1: Write the failing tests**

Create `test/retry.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import type { ProcessResult } from "../src/process.js";
import type { TestResult } from "../src/harness/validation.js";
import { runWithRetries } from "../src/harness/retry.js";

function agentResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
    return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
        ...overrides,
    };
}

function testResult(overrides: Partial<TestResult> = {}): TestResult {
    return {
        passed: true,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...overrides,
    };
}

function makeDeps() {
    return {
        runAgent: vi.fn(
            async (_worktreePath: string, _prompt: string): Promise<ProcessResult> =>
                agentResult()
        ),
        runTests: vi.fn(
            async (_worktreePath: string): Promise<TestResult> => testResult()
        ),
        getChangedFiles: vi.fn(
            async (_worktreePath: string): Promise<string[]> => ["src/a.ts"]
        ),
    };
}

const input = {
    taskId: "task-1",
    worktreePath: "/tmp/worktree",
    prompt: "Fix the failing tests.",
};

describe("runWithRetries", () => {
    it("returns one successful report when the first attempt passes", async () => {
        const deps = makeDeps();

        const reports = await runWithRetries(input, deps);

        expect(reports).toHaveLength(1);
        expect(reports[0]?.success).toBe(true);
        expect(deps.runAgent).toHaveBeenCalledTimes(1);
        expect(deps.runTests).toHaveBeenCalledTimes(1);
        expect(deps.getChangedFiles).toHaveBeenCalledTimes(1);
    });

    it("runs tests after an agent crash and stops without retrying", async () => {
        const deps = makeDeps();
        deps.runAgent.mockResolvedValue(
            agentResult({ exitCode: 1, stderr: "boom" })
        );

        const reports = await runWithRetries(input, deps);

        expect(reports).toHaveLength(1);
        expect(reports[0]?.success).toBe(false);
        expect(reports[0]?.reasons).toContain("agent exited with code 1");
        expect(deps.runTests).toHaveBeenCalledTimes(1);
        expect(deps.getChangedFiles).toHaveBeenCalledTimes(1);
    });

    it("stops after an agent timeout even if tests pass", async () => {
        const deps = makeDeps();
        deps.runAgent.mockResolvedValue(
            agentResult({ timedOut: true, signal: "SIGTERM" })
        );

        const reports = await runWithRetries(input, deps);

        expect(reports).toHaveLength(1);
        expect(reports[0]?.agentTimedOut).toBe(true);
        expect(reports[0]?.success).toBe(false);
        expect(deps.runTests).toHaveBeenCalledTimes(1);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/retry.test.ts`

Expected: FAIL — cannot resolve `../src/harness/retry.js`.

- [ ] **Step 3: Write the minimal implementation**

Create `src/harness/retry.ts`:

```ts
import type { ProcessResult } from "../process.js";
import { buildReport, type HarnessReport } from "./report.js";
import type { TestResult } from "./validation.js";

export const MAX_ATTEMPTS = 3;

export type RetryDependencies = {
  runAgent: (worktreePath: string, prompt: string) => Promise<ProcessResult>;
  runTests: (worktreePath: string) => Promise<TestResult>;
  getChangedFiles: (worktreePath: string) => Promise<string[]>;
};

export type RetryInput = {
  taskId: string;
  worktreePath: string;
  prompt: string;
};

export async function runWithRetries(
  input: RetryInput,
  deps: RetryDependencies
): Promise<HarnessReport[]> {
  const agentResult = await deps.runAgent(input.worktreePath, input.prompt);
  const testResult = await deps.runTests(input.worktreePath);
  const changedFiles = await deps.getChangedFiles(input.worktreePath);

  return [
    buildReport({
      taskId: input.taskId,
      agentResult,
      testResult,
      changedFiles,
    }),
  ];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/retry.test.ts`

Expected: PASS — 3 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 6: Commit (only if the user asks for a commit)**

```bash
git add src/harness/retry.ts test/retry.test.ts
git commit -m "feat: add single-attempt harness runner"
```

---

### Task 2: Retry failing tests, cap at three

**Files:**
- Modify: `test/retry.test.ts`
- Modify: `src/harness/retry.ts`

- [ ] **Step 1: Add the failing tests**

Append inside the existing `describe("runWithRetries", ...)` block, after the timeout test:

```ts
    it("retries failing tests up to three total attempts", async () => {
        const deps = makeDeps();
        deps.runTests.mockResolvedValue(
            testResult({ passed: false, stderr: "still failing" })
        );

        const reports = await runWithRetries(input, deps);

        expect(reports).toHaveLength(3);
        expect(reports.every((report) => !report.success)).toBe(true);
        expect(deps.runAgent).toHaveBeenCalledTimes(3);
        expect(deps.runTests).toHaveBeenCalledTimes(3);
        expect(deps.runAgent.mock.calls.map(([worktreePath]) => worktreePath)).toEqual([
            input.worktreePath,
            input.worktreePath,
            input.worktreePath,
        ]);
    });

    it("stops early when a retry passes", async () => {
        const deps = makeDeps();
        deps.runTests
            .mockResolvedValueOnce(testResult({ passed: false }))
            .mockResolvedValueOnce(testResult({ passed: true }));

        const reports = await runWithRetries(input, deps);

        expect(reports).toHaveLength(2);
        expect(reports[1]?.success).toBe(true);
        expect(deps.runAgent).toHaveBeenCalledTimes(2);
    });

    it("retries when tests time out", async () => {
        const deps = makeDeps();
        deps.runTests.mockResolvedValue(
            testResult({ passed: false, timedOut: true })
        );

        const reports = await runWithRetries(input, deps);

        expect(reports).toHaveLength(3);
    });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/retry.test.ts`

Expected: FAIL — the three new tests expect more than one attempt.

- [ ] **Step 3: Replace `runWithRetries` with the loop**

Replace the body of `runWithRetries` in `src/harness/retry.ts` with:

```ts
export async function runWithRetries(
  input: RetryInput,
  deps: RetryDependencies
): Promise<HarnessReport[]> {
  const reports: HarnessReport[] = [];
  let prompt = input.prompt;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const agentResult = await deps.runAgent(input.worktreePath, prompt);
    const testResult = await deps.runTests(input.worktreePath);
    const changedFiles = await deps.getChangedFiles(input.worktreePath);

    reports.push(
      buildReport({
        taskId: input.taskId,
        agentResult,
        testResult,
        changedFiles,
      })
    );

    const agentCompleted = agentResult.exitCode === 0 && !agentResult.timedOut;
    if (!agentCompleted || testResult.passed) {
      break;
    }

    prompt = input.prompt;
  }

  return reports;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/retry.test.ts`

Expected: PASS — 6 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 6: Commit (only if the user asks for a commit)**

```bash
git add src/harness/retry.ts test/retry.test.ts
git commit -m "feat: retry failed tests up to three attempts"
```

---

### Task 3: Feed the failure back into the retry prompt

**Files:**
- Modify: `test/retry.test.ts`
- Modify: `src/harness/retry.ts`

- [ ] **Step 1: Add the failing test**

Append inside the existing `describe("runWithRetries", ...)` block:

```ts
    it("adds the previous test failure and changed files to the retry prompt", async () => {
        const deps = makeDeps();
        deps.runTests
            .mockResolvedValueOnce(
                testResult({ passed: false, stdout: "stdout-1", stderr: "stderr-1" })
            )
            .mockResolvedValueOnce(testResult({ passed: true }));

        await runWithRetries(input, deps);

        const retryPrompt = deps.runAgent.mock.calls[1]?.[1];

        expect(retryPrompt).toContain(input.prompt);
        expect(retryPrompt).toContain("stdout-1");
        expect(retryPrompt).toContain("stderr-1");
        expect(retryPrompt).toContain("- src/a.ts");
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/retry.test.ts`

Expected: FAIL — the second prompt is identical to the first.

- [ ] **Step 3: Add the prompt builder and use it**

Add this function before `runWithRetries` in `src/harness/retry.ts`:

```ts
function buildRetryPrompt(
  prompt: string,
  testResult: TestResult,
  changedFiles: string[]
): string {
  return [
    prompt,
    "",
    "The previous attempt did not pass the tests. Fix the failures and try again.",
    "",
    "Changed files:",
    ...changedFiles.map((file) => `- ${file}`),
    "",
    "Test stdout:",
    testResult.stdout,
    "",
    "Test stderr:",
    testResult.stderr,
  ].join("\n");
}
```

Then replace the placeholder assignment at the end of the loop:

```ts
    prompt = input.prompt;
```

with:

```ts
    prompt = buildRetryPrompt(input.prompt, testResult, changedFiles);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/retry.test.ts`

Expected: PASS — 7 tests.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit`

Expected: no output.

- [ ] **Step 6: Commit (only if the user asks for a commit)**

```bash
git add src/harness/retry.ts test/retry.test.ts
git commit -m "feat: include test feedback in retry prompt"
```

---

### Task 4: Verify the whole suite

**Files:** none.

- [ ] **Step 1: Run the full suite**

Run: `npx vitest run`

Expected: PASS — all test files, including the pre-existing 44 tests plus 7 new retry tests.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`

Expected: no output.

---

## Self-Review

- **Spec coverage:** max 3 attempts (Task 2), retry only when agent completed and tests failed (Task 2), stop on crash/timeout (Task 1), tests always run after a crash (Task 1), retry feedback prompt (Task 3), injected dependencies (Tasks 1–3), `retry.ts` location (Task 1), attempt history returned (all tasks), same worktree across attempts (Task 2 assertion).
- **Placeholders:** none.
- **Type consistency:** `RetryInput`, `RetryDependencies`, `MAX_ATTEMPTS`, `runWithRetries`, `buildRetryPrompt`, `HarnessReport`, `TestResult`, `ProcessResult` all match the contracts above.
