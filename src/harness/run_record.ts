import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessReport } from "./report.js";
import type { SyncInfo } from "./orchestrator.js";
import { isProcessAlive } from "./lock.js";

export type RunState = "running" | "succeeded" | "failed";
export type RunDisplayState = RunState | "stale";

export type RunRecord = {
    taskId: string;
    issueId: string;
    issueNumber: number;
    repoPath: string;
    branchName: string;
    state: RunState;
    phase: string;
    attempt: number;
    pid: number | null;
    startedAt: string;
    updatedAt: string;
    finishedAt: string | null;
    logPath: string;
    report: HarnessReport | null;
    sync: SyncInfo | null;
    error: string | null;
};

export function runsRoot(repoPath: string): string {
    return path.join(repoPath, ".afk", "runs");
}

export function runDir(repoPath: string, taskId: string): string {
    return path.join(runsRoot(repoPath), taskId);
}

export function runLogPath(repoPath: string, taskId: string): string {
    return path.join(runDir(repoPath, taskId), "run.log");
}

export function runRecordPath(repoPath: string, taskId: string): string {
    return path.join(runDir(repoPath, taskId), "run.json");
}

export async function saveRunRecord(record: RunRecord): Promise<void> {
    const dir = runDir(record.repoPath, record.taskId);
    await mkdir(dir, { recursive: true });
    await writeFile(
        runRecordPath(record.repoPath, record.taskId),
        `${JSON.stringify(record, null, 2)}\n`,
    );
}

export type RunRecordUpdate = {
    repoPath: string;
    taskId: string;
    issueId: string;
    issueNumber: number;
    state: RunState;
    phase: string;
    attempt: number;
    pid: number;
    report: HarnessReport | null;
    sync: SyncInfo | null;
    error: string | null;
    finishedAt?: string | null;
};

export async function updateRunRecord(input: RunRecordUpdate): Promise<void> {
    const existing = await readRunRecord(input.repoPath, input.taskId);
    const now = new Date().toISOString();

    await saveRunRecord({
        taskId: input.taskId,
        issueId: input.issueId,
        issueNumber: input.issueNumber,
        repoPath: input.repoPath,
        branchName: `afk/${input.taskId}`,
        state: input.state,
        phase: input.phase,
        attempt: input.attempt,
        pid: input.pid,
        startedAt: existing?.startedAt ?? now,
        updatedAt: now,
        finishedAt: input.finishedAt ?? null,
        logPath: runLogPath(input.repoPath, input.taskId),
        report: input.report,
        sync: input.sync,
        error: input.error,
    });
}

export async function readRunRecord(
    repoPath: string,
    taskId: string,
): Promise<RunRecord | null> {
    try {
        const content = await readFile(runRecordPath(repoPath, taskId), "utf8");
        return JSON.parse(content) as RunRecord;
    } catch {
        return null;
    }
}

export async function listRunRecords(repoPath: string): Promise<RunRecord[]> {
    let entries;

    try {
        entries = await readdir(runsRoot(repoPath), { withFileTypes: true });
    } catch {
        return [];
    }

    const records = await Promise.all(
        entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => readRunRecord(repoPath, entry.name)),
    );

    return records
        .filter((record): record is RunRecord => record !== null)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function findRunForIssue(
    repoPath: string,
    issueNumber: number,
): Promise<RunRecord | null> {
    const records = await listRunRecords(repoPath);
    return records.find((record) => record.issueNumber === issueNumber) ?? null;
}

export function resolveRunState(record: RunRecord): RunDisplayState {
    if (record.state === "running" && !isProcessAlive(record.pid ?? 0)) {
        return "stale";
    }

    return record.state;
}

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
            String(record.attempt),
            outcome,
        ].join("\t");
    });

    return [
        ["ISSUE", "TASK", "STATE", "STARTED", "ATTEMPT", "PHASE"].join("\t"),
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
        `Attempts: ${record.attempt}`,
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
