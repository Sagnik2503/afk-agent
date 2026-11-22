import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    findRunForIssue,
    listRunRecords,
    readRunRecord,
    resolveRunState,
    runLogPath,
    runRecordPath,
    saveRunRecord,
    startRunRecord,
    updateRunRecord,
    type RunRecord,
} from "../src/harness/run_record.js";

const repos: string[] = [];

async function makeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "afk-agent-runs-"));
    repos.push(repo);
    return repo;
}

function record(overrides: Partial<RunRecord> = {}): RunRecord {
    const now = new Date().toISOString();
    return {
        taskId: "issue-20-background",
        issueId: "20",
        issueNumber: 20,
        repoPath: "/repo",
        branchName: "afk/issue-20-background",
        state: "running",
        phase: "running",
        attempts: 0,
        pid: process.pid,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        logPath: "/repo/.afk/runs/issue-20-background/run.log",
        report: null,
        sync: null,
        error: null,
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(
        repos
            .splice(0)
            .map((repo) => rm(repo, { recursive: true, force: true })),
    );
});

describe("run records", () => {
    it("round-trips a record under .afk/runs/<task-id>/", async () => {
        const repoPath = await makeRepo();
        const saved = record({ repoPath });

        await saveRunRecord(saved);

        expect(runRecordPath(repoPath, saved.taskId)).toContain(
            join(".afk", "runs", saved.taskId, "run.json"),
        );
        expect(runLogPath(repoPath, saved.taskId)).toContain(
            join(".afk", "runs", saved.taskId, "run.log"),
        );
        await expect(readRunRecord(repoPath, saved.taskId)).resolves.toEqual(
            saved,
        );
    });

    it("lists the newest runs first", async () => {
        const repoPath = await makeRepo();
        await saveRunRecord(
            record({
                repoPath,
                taskId: "issue-1-old",
                issueNumber: 1,
                startedAt: "2026-01-01T00:00:00.000Z",
            }),
        );
        await saveRunRecord(
            record({
                repoPath,
                taskId: "issue-2-new",
                issueNumber: 2,
                startedAt: "2026-02-01T00:00:00.000Z",
            }),
        );

        const runs = await listRunRecords(repoPath);

        expect(runs.map((run) => run.taskId)).toEqual([
            "issue-2-new",
            "issue-1-old",
        ]);
    });

    it("finds the newest run for an issue", async () => {
        const repoPath = await makeRepo();
        await saveRunRecord(
            record({
                repoPath,
                taskId: "issue-3-old",
                issueNumber: 3,
                startedAt: "2026-01-01T00:00:00.000Z",
            }),
        );
        await saveRunRecord(
            record({
                repoPath,
                taskId: "issue-3-new",
                issueNumber: 3,
                startedAt: "2026-02-01T00:00:00.000Z",
            }),
        );

        await expect(findRunForIssue(repoPath, 3)).resolves.toMatchObject({
            taskId: "issue-3-new",
        });
        await expect(findRunForIssue(repoPath, 99)).resolves.toBeNull();
    });

    it("reports a vanished process as stale instead of running", async () => {
        const repoPath = await makeRepo();
        const saved = record({ repoPath, pid: 2_000_000_000 });
        await saveRunRecord(saved);

        const [run] = await listRunRecords(repoPath);
        expect(run).toBeDefined();
        expect(resolveRunState(run!)).toBe("stale");
    });

    it("keeps a live process running", () => {
        expect(resolveRunState(record())).toBe("running");
    });
});

describe("run lifecycle updates", () => {
    it("starts a fresh run over a finished record", async () => {
        const repoPath = await makeRepo();
        const old = record({
            repoPath,
            state: "failed",
            phase: "failed",
            attempts: 3,
            startedAt: "2026-01-01T00:00:00.000Z",
            finishedAt: "2026-01-01T00:10:00.000Z",
            error: "boom",
            pid: 2_000_000_000,
        });
        await saveRunRecord(old);

        await startRunRecord({
            repoPath,
            taskId: old.taskId,
            issueId: "20",
            issueNumber: 20,
            pid: process.pid,
        });

        const fresh = await readRunRecord(repoPath, old.taskId);
        expect(fresh).toMatchObject({
            state: "running",
            phase: "starting",
            attempts: 0,
            pid: process.pid,
            finishedAt: null,
            error: null,
            report: null,
            sync: null,
        });
        expect(fresh?.startedAt).not.toBe(old.startedAt);
    });

    it("merges phase and attempt updates without resetting the start time", async () => {
        const repoPath = await makeRepo();
        const identity = {
            repoPath,
            taskId: "issue-20-background",
            issueId: "20",
            issueNumber: 20,
        };
        await startRunRecord({ ...identity, pid: process.pid });
        const started = await readRunRecord(repoPath, identity.taskId);

        await updateRunRecord({ ...identity, phase: "sandbox", attempts: 2 });

        const updated = await readRunRecord(repoPath, identity.taskId);
        expect(updated?.startedAt).toBe(started?.startedAt);
        expect(updated?.phase).toBe("sandbox");
        expect(updated?.attempts).toBe(2);
        expect(updated?.state).toBe("running");
    });

    it("creates a record with defaults when none exists", async () => {
        const repoPath = await makeRepo();

        await updateRunRecord({
            repoPath,
            taskId: "issue-20-background",
            issueId: "20",
            issueNumber: 20,
            state: "failed",
            phase: "failed",
            error: "boom",
        });

        const created = await readRunRecord(repoPath, "issue-20-background");
        expect(created).toMatchObject({
            state: "failed",
            attempts: 0,
            pid: null,
            finishedAt: null,
            error: "boom",
            branchName: "afk/issue-20-background",
        });
        expect(created?.startedAt).toEqual(expect.any(String));
    });
});

describe("stale record persistence", () => {
    it("does not require a log file to exist", async () => {
        const repoPath = await makeRepo();
        const saved = record({ repoPath });
        await saveRunRecord(saved);

        await writeFile(runLogPath(repoPath, saved.taskId), "hello\n");
        expect(runLogPath(repoPath, saved.taskId)).toContain("run.log");
    });
});
