import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HarnessReport } from "./report.js";
import type { SyncInfo } from "./orchestrator.js";
import { isProcessAlive } from "./lock.js";

export type RunState = "running" | "succeeded" | "failed" | "stopped";
export type RunDisplayState = RunState | "stale";

export type RunRecord = {
    taskId: string;
    issueId: string;
    issueNumber: number;
    repoPath: string;
    branchName: string;
    state: RunState;
    phase: string;
    attempts: number;
    pid: number | null;
    startedAt: string;
    updatedAt: string;
    finishedAt: string | null;
    logPath: string;
    report: HarnessReport | null;
    sync: SyncInfo | null;
    error: string | null;
};

export type RunRecordIdentity = {
    repoPath: string;
    taskId: string;
    issueId: string;
    issueNumber: number;
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

export type RunRecordUpdate = RunRecordIdentity & Partial<RunRecord>;

function newRunRecord(
    input: RunRecordIdentity,
    pid: number | null,
    now: string,
): RunRecord {
    return {
        taskId: input.taskId,
        issueId: input.issueId,
        issueNumber: input.issueNumber,
        repoPath: input.repoPath,
        branchName: `afk/${input.taskId}`,
        state: "running",
        phase: "starting",
        attempts: 0,
        pid,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        logPath: runLogPath(input.repoPath, input.taskId),
        report: null,
        sync: null,
        error: null,
    };
}

// A new run for the same task resets the record; in-run updates merge into it.
export async function startRunRecord(
    input: RunRecordIdentity & { pid: number },
): Promise<void> {
    await saveRunRecord(
        newRunRecord(input, input.pid, new Date().toISOString()),
    );
}

export async function updateRunRecord(input: RunRecordUpdate): Promise<void> {
    const existing = await readRunRecord(input.repoPath, input.taskId);
    const now = new Date().toISOString();
    const base = existing ?? newRunRecord(input, null, now);

    await saveRunRecord({ ...base, ...input, updatedAt: now });
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
