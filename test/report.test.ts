import { describe, it, expect } from "vitest";
import type { ProcessResult } from "../src/process.js";
import type { TestResult } from "../src/harness/validation.js";
import { buildReport } from "../src/harness/report.js";

function makeAgentResult(
    overrides: Partial<ProcessResult> = {},
): ProcessResult {
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

function makeTestResult(overrides: Partial<TestResult> = {}): TestResult {
    return {
        passed: true,
        stdout: "",
        stderr: "",
        timedOut: false,
        ...overrides,
    };
}

describe("buildReport", () => {
    it("reports success when the agent completed and tests passed", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult(),
            testResult: makeTestResult(),
            changedFiles: ["src/a.ts"],
        });

        expect(report.success).toBe(true);
        expect(report.executionStatus).toBe("completed");
        expect(report.testsPassed).toBe(true);
        expect(report.agentTimedOut).toBe(false);
        expect(report.reasons).toEqual([]);
    });

    it("reports failure when the agent timed out", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult({ timedOut: true, signal: "SIGTERM" }),
            testResult: makeTestResult(),
            changedFiles: ["src/a.ts"],
        });

        expect(report.success).toBe(false);
        expect(report.executionStatus).toBe("timed_out");
        expect(report.agentTimedOut).toBe(true);
        expect(report.reasons).toContain("agent timed out");
    });

    it("reports failure when the agent exited non-zero", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult({ exitCode: 2 }),
            testResult: makeTestResult(),
            changedFiles: ["src/a.ts"],
        });

        expect(report.success).toBe(false);
        expect(report.executionStatus).toBe("failed");
        expect(report.reasons).toContain("agent exited with code 2");
    });

    it("reports failure when the agent was killed without timing out", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult({ exitCode: null, signal: "SIGKILL" }),
            testResult: makeTestResult(),
            changedFiles: ["src/a.ts"],
        });

        expect(report.success).toBe(false);
        expect(report.reasons).toContain("agent terminated by SIGKILL");
    });

    it("reports failure when tests fail", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult(),
            testResult: makeTestResult({ passed: false, stderr: "boom" }),
            changedFiles: ["src/a.ts"],
        });

        expect(report.success).toBe(false);
        expect(report.testsPassed).toBe(false);
        expect(report.reasons).toContain("tests failed");
    });

    it("reports failure when tests time out", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult(),
            testResult: makeTestResult({ passed: false, timedOut: true }),
            changedFiles: ["src/a.ts"],
        });

        expect(report.success).toBe(false);
        expect(report.reasons).toContain("tests timed out");
    });

    it("still succeeds with no changed files but notes it", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult(),
            testResult: makeTestResult(),
            changedFiles: [],
        });

        expect(report.success).toBe(true);
        expect(report.reasons).toContain("no files changed");
    });
});
