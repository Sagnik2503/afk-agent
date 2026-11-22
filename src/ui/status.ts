import { resolveRunState, type RunRecord } from "../harness/run_record.js";
import type { SyncInfo } from "../harness/orchestrator.js";

export function formatRunList(records: RunRecord[]): string {
    if (records.length === 0) {
        return "No runs found.";
    }

    const rows = records.map((record) => {
        const state = resolveRunState(record);
        const outcome =
            record.state === "running"
                ? record.phase
                : (record.error ?? record.phase);

        return [
            `#${record.issueNumber}`,
            record.taskId,
            state,
            record.startedAt,
            String(record.attempts),
            outcome,
        ].join("\t");
    });

    return [
        ["ISSUE", "TASK", "STATE", "STARTED", "ATTEMPTS", "PHASE"].join("\t"),
        ...rows,
    ].join("\n");
}

export function formatRunDetail(record: RunRecord): string {
    const lines = [
        `Issue: #${record.issueNumber}`,
        `Task: ${record.taskId}`,
        `Branch: ${record.branchName}`,
        `State: ${resolveRunState(record)}`,
        `Phase: ${record.phase}`,
        `Started: ${record.startedAt}`,
        `Finished: ${record.finishedAt ?? "-"}`,
        `Attempts: ${record.attempts}`,
        `GitHub sync: ${formatSync(record.sync)}`,
        `Pull request: ${record.sync?.prUrl ?? "-"}`,
    ];

    if (record.error !== null) {
        lines.push(`Error: ${record.error}`);
    }

    return lines.join("\n");
}

function formatSync(sync: SyncInfo | null): string {
    if (sync === null) {
        return "-";
    }

    if (!sync.pushed) {
        return `not pushed (${sync.pushError ?? "unknown"})`;
    }

    return sync.commented ? "pushed, commented" : "pushed";
}
