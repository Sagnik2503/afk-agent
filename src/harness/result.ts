import type { ProcessResult } from "../process.js";

export type ExecutionStatus = "timed_out" | "failed" | "completed";

export function getExecutionStatus(result: ProcessResult): ExecutionStatus {
    if (result.timedOut) {
        return "timed_out";
    }

    if (result.exitCode !== 0) {
        return "failed";
    }

    return "completed";
}
