import type { ProcessResult } from "../process.js";
import { getExecutionStatus, type ExecutionStatus } from "./result.js";
import type { TestResult } from "./validation.js";

export type HarnessReport = {
    taskId: string;
    executionStatus: ExecutionStatus;
    success: boolean;
    testsPassed: boolean;
    agentTimedOut: boolean;
    changedFiles: string[];
    reasons: string[];
    agent: {
        stdout: string;
        stderr: string;
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        outputTruncated: boolean;
    };
    tests: TestResult;
};

export type ReportInput = {
    taskId: string;
    agentResult: ProcessResult;
    testResult: TestResult;
    changedFiles: string[];
};

export function buildReport(input: ReportInput): HarnessReport {
    const { taskId, agentResult, testResult, changedFiles } = input;
    const executionStatus = getExecutionStatus(agentResult);
    const success = executionStatus === "completed" && testResult.passed;
    const reasons: string[] = [];

    if (agentResult.timedOut) {
        reasons.push("agent timed out");
    } else if (agentResult.exitCode !== 0) {
        reasons.push(
            agentResult.exitCode === null
                ? `agent terminated by ${agentResult.signal ?? "signal"}`
                : `agent exited with code ${agentResult.exitCode}`,
        );
    }

    if (!testResult.passed) {
        reasons.push(testResult.timedOut ? "tests timed out" : "tests failed");
    }

    if (changedFiles.length === 0) {
        reasons.push("no files changed");
    }

    return {
        taskId,
        executionStatus,
        success,
        testsPassed: testResult.passed,
        agentTimedOut: agentResult.timedOut,
        changedFiles,
        reasons,
        agent: {
            stdout: agentResult.stdout,
            stderr: agentResult.stderr,
            exitCode: agentResult.exitCode,
            signal: agentResult.signal,
            outputTruncated: agentResult.outputTruncated,
        },
        tests: testResult,
    };
}
