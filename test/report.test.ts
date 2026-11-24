import { describe, it, expect } from "vitest";
import type { ProcessResult } from "../src/process.js";
import type { TestResult } from "../src/harness/validation.js";
import { buildReport } from "../src/harness/report.js";
import type { RunTaskResult } from "../src/harness/orchestrator.js";
import { createColors } from "../src/ui/color.js";
import { formatRunReport } from "../src/ui/report.js";

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
        commands: ["npm test"],
        failedCommand: null,
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

    it("names a resource limit kill and hints how to raise it", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult({
                exitCode: 137,
                resourceLimit: {
                    kind: "memory",
                    value: "2g",
                    message:
                        "sandbox exceeded its memory limit (2g); raise --memory to allow more",
                },
            }),
            testResult: makeTestResult(),
            changedFiles: ["src/a.ts"],
        });

        expect(report.success).toBe(false);
        expect(report.executionStatus).toBe("failed");
        expect(report.reasons).toContain(
            "sandbox exceeded its memory limit (2g); raise --memory to allow more",
        );
        expect(report.reasons).not.toContain("agent exited with code 137");
    });

    it("names the timeout before a resource limit when both are present", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult({
                exitCode: 137,
                timedOut: true,
                signal: "SIGKILL",
                resourceLimit: {
                    kind: "memory",
                    value: "2g",
                    message:
                        "sandbox exceeded its memory limit (2g); raise --memory to allow more",
                },
            }),
            testResult: makeTestResult(),
            changedFiles: ["src/a.ts"],
        });

        expect(report.executionStatus).toBe("timed_out");
        expect(report.reasons).toContain("agent timed out");
        expect(report.reasons).not.toContain(
            "sandbox exceeded its memory limit (2g); raise --memory to allow more",
        );
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

const plain = createColors({ isTTY: false, env: {} });

function makeRunResult(overrides: Partial<RunTaskResult> = {}): RunTaskResult {
    return {
        branchName: "afk/issue-18-polish",
        worktreePath: "/repo/.afk/worktrees/issue-18",
        reports: [
            buildReport({
                taskId: "task-1",
                agentResult: makeAgentResult(),
                testResult: makeTestResult(),
                changedFiles: ["src/a.ts"],
            }),
        ],
        error: null,
        sync: null,
        worktreeRemoved: false,
        cleanupError: null,
        ...overrides,
    };
}

describe("formatRunReport", () => {
    it("groups the report into readable sections and reports success", () => {
        const { text, exitCode } = formatRunReport(makeRunResult(), {
            pushEnabled: true,
            color: plain,
        });

        expect(exitCode).toBe(0);
        expect(text).toContain("Branch / Worktree");
        expect(text).toContain("afk/issue-18-polish");
        expect(text).toContain("Attempts");
        expect(text).toContain("GitHub sync");
        expect(text).toContain("Status");
        expect(text).toContain("SUCCESS");
        expect(text).not.toContain("\u001b[");
    });

    it("marks a removed worktree while keeping the branch visible", () => {
        const { text } = formatRunReport(
            makeRunResult({ worktreeRemoved: true }),
            { pushEnabled: true, color: plain },
        );

        expect(text).toContain("removed (branch kept)");
    });

    it("shows a resource-limit failure and its suggested action", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult({
                exitCode: 137,
                resourceLimit: {
                    kind: "memory",
                    value: "2g",
                    message:
                        "sandbox exceeded its memory limit (2g); raise --memory to allow more",
                },
            }),
            testResult: makeTestResult(),
            changedFiles: ["src/a.ts"],
        });

        const { text, exitCode } = formatRunReport(
            makeRunResult({ reports: [report] }),
            { pushEnabled: true, color: plain },
        );

        expect(exitCode).toBe(1);
        expect(text).toContain("FAILED");
        expect(text).toContain(
            "sandbox exceeded its memory limit (2g); raise --memory to allow more",
        );
    });

    it("fails when tests pass but the push was requested and failed", () => {
        const { text, exitCode } = formatRunReport(
            makeRunResult({
                sync: {
                    pushed: false,
                    branchUrl: null,
                    pushError: "no commits",
                    commented: true,
                    commentError: null,
                    prUrl: null,
                    prCreated: false,
                    prReused: false,
                    prError: null,
                },
            }),
            { pushEnabled: true, color: plain },
        );

        expect(exitCode).toBe(1);
        expect(text).toContain("not pushed (no commits)");
        expect(text).toContain("FAILED");
    });

    it("succeeds when the push was explicitly disabled", () => {
        const { text, exitCode } = formatRunReport(
            makeRunResult({
                sync: {
                    pushed: false,
                    branchUrl: null,
                    pushError: "push disabled",
                    commented: true,
                    commentError: null,
                    prUrl: null,
                    prCreated: false,
                    prReused: false,
                    prError: null,
                },
            }),
            { pushEnabled: false, color: plain },
        );

        expect(exitCode).toBe(0);
        expect(text).toContain("SUCCESS");
    });

    it("surfaces an execution error in plain text", () => {
        const { text, exitCode } = formatRunReport(
            makeRunResult({ error: "docker is not running", reports: [] }),
            { pushEnabled: true, color: plain },
        );

        expect(exitCode).toBe(1);
        expect(text).toContain("FAILED");
        expect(text).toContain("docker is not running");
    });

    it("shows Validation: none for an empty Validation list", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult(),
            testResult: makeTestResult({ commands: [] }),
            changedFiles: ["src/a.ts"],
        });

        const { text, exitCode } = formatRunReport(
            makeRunResult({ reports: [report] }),
            { pushEnabled: true, color: plain },
        );

        expect(exitCode).toBe(0);
        expect(text).toContain("Validation: none");
    });

    it("shows the Validation command count when checks are configured", () => {
        const report = buildReport({
            taskId: "task-1",
            agentResult: makeAgentResult(),
            testResult: makeTestResult({ commands: ["npm ci", "npm test"] }),
            changedFiles: ["src/a.ts"],
        });

        const { text } = formatRunReport(makeRunResult({ reports: [report] }), {
            pushEnabled: true,
            color: plain,
        });

        expect(text).toContain("Validation: 2 commands");
        expect(text).not.toContain("Validation: none");
    });
});
