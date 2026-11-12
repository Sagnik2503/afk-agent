import { describe, it, expect } from "vitest";
import type { ProcessResult } from "../src/process.js";
import { getExecutionStatus } from "../src/harness/result.js";

function makeResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
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

describe("getExecutionStatus", () => {
    it("returns timed_out when the process timed out", () => {
        const result = makeResult({ timedOut: true, signal: "SIGTERM" });

        expect(getExecutionStatus(result)).toBe("timed_out");
    });

    it("returns failed when the process exited non-zero", () => {
        const result = makeResult({ exitCode: 1 });

        expect(getExecutionStatus(result)).toBe("failed");
    });

    it("returns completed when the process exited cleanly", () => {
        const result = makeResult({ exitCode: 0 });

        expect(getExecutionStatus(result)).toBe("completed");
    });
});
