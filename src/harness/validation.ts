import { ChildProcess } from "../process.js";

export type TestResult = {
    passed: boolean;
    stdout: string;
    stderr: string;
    timedOut: boolean;
};

export async function runTests(
    worktreePath: string,
    command = "npm test",
): Promise<TestResult> {
    const result = await ChildProcess("sh", ["-c", command], {
        cwd: worktreePath,
        timeout: 120_000,
    });

    return {
        passed: result.exitCode === 0 && !result.timedOut,
        stdout: result.stdout,
        stderr: result.stderr,
        timedOut: result.timedOut,
    };
}
