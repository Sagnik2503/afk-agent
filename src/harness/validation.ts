import type { SandboxCommandRunner } from "../agent/sandbox.js";

export type TestResult = {
    passed: boolean;
    stdout: string;
    stderr: string;
    timedOut: boolean;
};

export async function runTests(
    runCommand: SandboxCommandRunner["runCommand"],
    command = "npm test",
): Promise<TestResult> {
    const result = await runCommand(["sh", "-c", command], {
        timeout: 120_000,
    });

    return {
        passed: result.exitCode === 0 && !result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
    };
}
