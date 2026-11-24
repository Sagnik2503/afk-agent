import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProcessResult } from "../src/process.js";
import type { SandboxCommandRunner } from "../src/agent/sandbox.js";
import { runTests } from "../src/harness/validation.js";

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
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

const runCommand = vi.fn<SandboxCommandRunner["runCommand"]>();

beforeEach(() => {
    runCommand.mockReset();
    runCommand.mockResolvedValue(processResult());
});

describe("runTests", () => {
    it("runs every Validation command in order inside the Sandbox", async () => {
        runCommand.mockResolvedValue(processResult({ stdout: "passed" }));

        const result = await runTests(runCommand, ["npm ci", "npm test"]);

        expect(runCommand.mock.calls).toEqual([
            [["sh", "-c", "npm ci"], { timeout: 120_000 }],
            [["sh", "-c", "npm test"], { timeout: 120_000 }],
        ]);
        expect(result.passed).toBe(true);
        expect(result.failedCommand).toBeNull();
        expect(result.commands).toEqual(["npm ci", "npm test"]);
    });

    it("stops at the first failing command and labels it with its output", async () => {
        runCommand.mockResolvedValueOnce(processResult()).mockResolvedValueOnce(
            processResult({
                exitCode: 1,
                stdout: "test output",
                stderr: "nope",
            }),
        );

        const result = await runTests(runCommand, [
            "npm ci",
            "npm test",
            "npm run lint",
        ]);

        expect(runCommand).toHaveBeenCalledTimes(2);
        expect(result.passed).toBe(false);
        expect(result.failedCommand).toBe("npm test");
        expect(result.stdout).toContain("test output");
        expect(result.stderr).toContain("nope");
    });

    it("runs no checks for an empty Validation list", async () => {
        const result = await runTests(runCommand, []);

        expect(runCommand).not.toHaveBeenCalled();
        expect(result.passed).toBe(true);
        expect(result.commands).toEqual([]);
        expect(result.failedCommand).toBeNull();
    });

    it("reports a timed-out command as failed and timed out", async () => {
        runCommand.mockResolvedValue(
            processResult({ exitCode: null, timedOut: true }),
        );

        const result = await runTests(runCommand, ["npm test"]);

        expect(result.passed).toBe(false);
        expect(result.timedOut).toBe(true);
        expect(result.failedCommand).toBe("npm test");
    });

    it("fails a timed-out command even when it reports exit 0", async () => {
        runCommand.mockResolvedValue(
            processResult({ exitCode: 0, timedOut: true }),
        );

        const result = await runTests(runCommand, ["npm test"]);

        expect(result.passed).toBe(false);
        expect(result.timedOut).toBe(true);
    });
});
