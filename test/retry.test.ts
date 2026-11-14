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

type RunAgentFn = (
    worktreePath: string,
    prompt: string,
) => Promise<ProcessResult>;

function makeDeps() {
    return {
        runAgent: vi.fn<RunAgentFn>(async () => agentResult()),
        runTests: vi.fn(async (): Promise<TestResult> => testResult()),
        getChangedFiles: vi.fn(async (): Promise<string[]> => ["src/a.ts"]),
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

        const { reports, error } = await runWithRetries(input, deps);

        expect(error).toBeNull();
        expect(reports).toHaveLength(1);
        expect(reports[0]?.success).toBe(true);
        expect(deps.runAgent).toHaveBeenCalledTimes(1);
        expect(deps.runTests).toHaveBeenCalledTimes(1);
        expect(deps.getChangedFiles).toHaveBeenCalledTimes(1);
    });

    it("returns collected reports and the error when tests throw", async () => {
        const deps = makeDeps();
        deps.runTests
            .mockResolvedValueOnce(testResult({ passed: false }))
            .mockRejectedValueOnce(new Error("npm exploded"));

        const { reports, error } = await runWithRetries(input, deps);

        expect(reports).toHaveLength(1);
        expect(error).toBe("npm exploded");
        expect(deps.runAgent).toHaveBeenCalledTimes(2);
    });

    it("returns collected reports and the error when changed files throw", async () => {
        const deps = makeDeps();
        deps.runTests.mockResolvedValueOnce(testResult({ passed: false }));
        deps.getChangedFiles
            .mockResolvedValueOnce(["src/a.ts"])
            .mockRejectedValueOnce(new Error("git exploded"));

        const { reports, error } = await runWithRetries(input, deps);

        expect(reports).toHaveLength(2);
        expect(reports[1]?.changedFiles).toEqual([]);
        expect(reports[1]?.testsPassed).toBe(true);
        expect(error).toBe("git exploded");
        expect(deps.runAgent).toHaveBeenCalledTimes(2);
    });

    it("runs tests after an agent crash and stops without retrying", async () => {
        const deps = makeDeps();
        deps.runAgent.mockResolvedValue(
            agentResult({ exitCode: 1, stderr: "boom" }),
        );

        const { reports } = await runWithRetries(input, deps);

        expect(reports).toHaveLength(1);
        expect(reports[0]?.success).toBe(false);
        expect(reports[0]?.reasons).toContain("agent exited with code 1");
        expect(deps.runTests).toHaveBeenCalledTimes(1);
        expect(deps.getChangedFiles).toHaveBeenCalledTimes(1);
    });

    it("stops after an agent timeout even if tests pass", async () => {
        const deps = makeDeps();
        deps.runAgent.mockResolvedValue(
            agentResult({ timedOut: true, signal: "SIGTERM" }),
        );

        const { reports } = await runWithRetries(input, deps);

        expect(reports).toHaveLength(1);
        expect(reports[0]?.agentTimedOut).toBe(true);
        expect(reports[0]?.success).toBe(false);
        expect(deps.runTests).toHaveBeenCalledTimes(1);
    });

    it("retries failing tests up to three total attempts", async () => {
        const deps = makeDeps();
        deps.runTests.mockResolvedValue(
            testResult({ passed: false, stderr: "still failing" }),
        );

        const { reports } = await runWithRetries(input, deps);

        expect(reports).toHaveLength(3);
        expect(reports.every((report) => !report.success)).toBe(true);
        expect(deps.runAgent).toHaveBeenCalledTimes(3);
        expect(deps.runTests).toHaveBeenCalledTimes(3);
        expect(
            deps.runAgent.mock.calls.map(([worktreePath]) => worktreePath),
        ).toEqual([input.worktreePath, input.worktreePath, input.worktreePath]);
    });

    it("stops early when a retry passes", async () => {
        const deps = makeDeps();
        deps.runTests
            .mockResolvedValueOnce(testResult({ passed: false }))
            .mockResolvedValueOnce(testResult({ passed: true }));

        const { reports } = await runWithRetries(input, deps);

        expect(reports).toHaveLength(2);
        expect(reports[1]?.success).toBe(true);
        expect(deps.runAgent).toHaveBeenCalledTimes(2);
    });

    it("retries when tests time out", async () => {
        const deps = makeDeps();
        deps.runTests.mockResolvedValue(
            testResult({ passed: false, timedOut: true }),
        );

        const { reports } = await runWithRetries(input, deps);

        expect(reports).toHaveLength(3);
    });

    it("adds the previous test failure and changed files to the retry prompt", async () => {
        const deps = makeDeps();
        deps.runTests
            .mockResolvedValueOnce(
                testResult({
                    passed: false,
                    stdout: "stdout-1",
                    stderr: "stderr-1",
                }),
            )
            .mockResolvedValueOnce(testResult({ passed: true }));

        await runWithRetries(input, deps);

        const retryPrompt = deps.runAgent.mock.calls[1]?.[1];

        expect(retryPrompt).toContain(input.prompt);
        expect(retryPrompt).toContain("stdout-1");
        expect(retryPrompt).toContain("stderr-1");
        expect(retryPrompt).toContain("- src/a.ts");
    });
});
