import type { RunTaskResult } from "../harness/orchestrator.js";
import type { Colors } from "./color.js";

export type RunReportOptions = {
    pushEnabled: boolean;
    color: Colors;
};

export type RunReport = {
    text: string;
    exitCode: number;
};

function pushLabel(result: RunTaskResult): string {
    if (result.sync === null) {
        return "not requested";
    }

    return result.sync.pushed
        ? (result.sync.branchUrl ?? "pushed")
        : `not pushed (${result.sync.pushError ?? "unknown"})`;
}

function commentLabel(result: RunTaskResult): string {
    if (result.sync === null) {
        return "not requested";
    }

    return result.sync.commented
        ? "posted"
        : `failed (${result.sync.commentError ?? "unknown"})`;
}

function pullRequestLabel(result: RunTaskResult): string {
    if (result.sync === null) {
        return "not requested";
    }

    if (result.sync.prUrl) {
        return result.sync.prUrl;
    }

    return result.sync.prError
        ? `failed (${result.sync.prError})`
        : "not opened";
}

export function formatRunReport(
    result: RunTaskResult,
    options: RunReportOptions,
): RunReport {
    const { color, pushEnabled } = options;
    const lastReport = result.reports.at(-1);
    const pushFailed =
        result.sync !== null && !result.sync.pushed && pushEnabled;
    const success =
        result.error === null && lastReport?.success === true && !pushFailed;
    const lines: string[] = [];

    lines.push(color.bold("AFK Agent Report"));
    lines.push("");

    lines.push(color.bold("Branch / Worktree"));
    lines.push(`  Branch:   ${result.branchName}`);
    lines.push(
        `  Worktree: ${
            result.worktreeRemoved
                ? "removed (branch kept)"
                : result.worktreePath
        }`,
    );
    if (result.cleanupError) {
        lines.push(`  Cleanup:  ${color.red(result.cleanupError)}`);
    }
    lines.push("");

    lines.push(color.bold("Attempts"));
    lines.push(`  Attempts:      ${result.reports.length}`);
    if (lastReport) {
        lines.push(`  Changed files: ${lastReport.changedFiles.length}`);
        lines.push("  Reasons:");
        if (lastReport.reasons.length === 0) {
            lines.push("    none");
        }
        for (const reason of lastReport.reasons) {
            lines.push(`    - ${reason}`);
        }
    }
    lines.push("");

    lines.push(color.bold("GitHub sync"));
    lines.push(`  Push:          ${pushLabel(result)}`);
    lines.push(`  Issue comment: ${commentLabel(result)}`);
    lines.push(`  Pull request:  ${pullRequestLabel(result)}`);
    lines.push("");

    lines.push(color.bold("Status"));
    if (result.error) {
        lines.push(`  ${color.red("FAILED")}: ${result.error}`);
    } else if (pushFailed) {
        lines.push(
            `  ${color.red("FAILED")}: tests passed but GitHub sync failed`,
        );
    } else if (success) {
        lines.push(`  ${color.green("SUCCESS")}`);
    } else {
        lines.push(`  ${color.red("FAILED")}`);
    }

    return { text: lines.join("\n"), exitCode: success ? 0 : 1 };
}
