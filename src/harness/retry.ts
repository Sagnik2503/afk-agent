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

  return reports;
}
