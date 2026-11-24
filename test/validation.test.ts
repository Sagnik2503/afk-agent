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
    it("runs the default test command inside the Sandbox", async () => {
        runCommand.mockResolvedValue(processResult({ stdout: "passed" }));

        const result = await runTests(runCommand);

        expect(runCommand).toHaveBeenCalledWith(["sh", "-c", "npm test"], {
            timeout: 120_000,
        });
        expect(result.passed).toBe(true);
        expect(result.stdout).toContain("passed");
        expect(result.timedOut).toBe(false);
    });

    it("captures the failure output from the Sandbox", async () => {
        runCommand.mockResolvedValue(
            processResult({
                exitCode: 1,
                stdout: "test output",
                stderr: "nope",
            }),
        );

        const result = await runTests(runCommand);

        expect(result.passed).toBe(false);
        expect(result.stdout).toContain("test output");
        expect(result.stderr).toContain("nope");
    });

    it("runs a custom validation command inside the Sandbox", async () => {
        runCommand.mockResolvedValue(processResult({ stdout: "custom-check" }));

        const result = await runTests(runCommand, "make check");

        expect(runCommand).toHaveBeenCalledWith(["sh", "-c", "make check"], {
            timeout: 120_000,
        });
        expect(result.passed).toBe(true);
        expect(result.stdout).toContain("custom-check");
    });

    it("fails when the Sandbox command fails", async () => {
        runCommand.mockResolvedValue(processResult({ exitCode: 2 }));

        const result = await runTests(runCommand, "make check");

        expect(result.passed).toBe(false);
    });

    it("reports a timed-out command as failed and timed out", async () => {
        runCommand.mockResolvedValue(
            processResult({ exitCode: null, timedOut: true }),
        );

        const result = await runTests(runCommand);

        expect(result.passed).toBe(false);
        expect(result.timedOut).toBe(true);
    });

    it("fails a timed-out command even when it reports exit 0", async () => {
        runCommand.mockResolvedValue(
            processResult({ exitCode: 0, timedOut: true }),
        );

        const result = await runTests(runCommand);

        expect(result.passed).toBe(false);
        expect(result.timedOut).toBe(true);
    });
});
