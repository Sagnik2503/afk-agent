import type { SandboxCommandRunner } from "../agent/sandbox.js";

export type TestResult = {
    passed: boolean;
    stdout: string;
    stderr: string;
    timedOut: boolean;
    commands: string[];
    failedCommand: string | null;
};

export async function runTests(
    runCommand: SandboxCommandRunner["runCommand"],
    commands: string[],
): Promise<TestResult> {
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    for (const command of commands) {
        const result = await runCommand(["sh", "-c", command], {
            timeout: 120_000,
        });

        stdout = result.stdout;
        stderr = result.stderr;
        timedOut = result.timedOut;

        if (result.exitCode !== 0 || result.timedOut) {
            return {
                passed: false,
                stdout,
                stderr,
                timedOut,
                commands,
                failedCommand: command,
            };
        }
    }

    return {
        passed: true,
        stdout,
        stderr,
        timedOut,
        commands,
        failedCommand: null,
    };
}
