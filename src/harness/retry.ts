import type { ProcessResult } from "../process.js";
import { errorMessage } from "../errors.js";
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
    onAttempt?: (attempt: number) => void | Promise<void>;
};

export type RetryResult = {
    reports: HarnessReport[];
    error: string | null;
};

function buildRetryPrompt(
    prompt: string,
    testResult: TestResult,
    changedFiles: string[],
): string {
    return [
        prompt,
        "",
        "The previous attempt did not pass Validation. Fix the failures and try again.",
        "",
        `Failed command: ${testResult.failedCommand}`,
        "",
        "Changed files:",
        ...changedFiles.map((file) => `- ${file}`),
        "",
        "Command stdout:",
        testResult.stdout,
        "",
        "Command stderr:",
        testResult.stderr,
    ].join("\n");
}

export async function runWithRetries(
    input: RetryInput,
    deps: RetryDependencies,
): Promise<RetryResult> {
    const reports: HarnessReport[] = [];
    let prompt = input.prompt;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        await input.onAttempt?.(attempt);

        // Agent launch errors propagate to the caller.
        const agentResult = await deps.runAgent(input.worktreePath, prompt);

        let testResult: TestResult;

        try {
            testResult = await deps.runTests(input.worktreePath);
        } catch (error) {
            return { reports, error: errorMessage(error) };
        }

        let changedFiles: string[];

        try {
            changedFiles = await deps.getChangedFiles(input.worktreePath);
        } catch (error) {
            // Preserve the agent and test results in a report.
            const report = buildReport({
                taskId: input.taskId,
                agentResult,
                testResult,
                changedFiles: [],
            });

            reports.push(report);

            return { reports, error: errorMessage(error) };
        }

        const report = buildReport({
            taskId: input.taskId,
            agentResult,
            testResult,
            changedFiles,
        });

        reports.push(report);

        if (report.executionStatus !== "completed" || testResult.passed) {
            break;
        }

        if (attempt < MAX_ATTEMPTS) {
            prompt = buildRetryPrompt(input.prompt, testResult, changedFiles);
        }
    }

    return { reports, error: null };
}
