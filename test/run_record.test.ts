import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    findRunForIssue,
    formatRunDetail,
    formatRunList,
    listRunRecords,
    readRunRecord,
    resolveRunState,
    runLogPath,
    runRecordPath,
    saveRunRecord,
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
        attempt: 0,
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
        expect(formatRunList([run!])).toContain("stale");
    });

    it("keeps a live process running", () => {
        expect(resolveRunState(record())).toBe("running");
    });
});

describe("run formatting", () => {
    it("lists issue, task, state, start, attempt, and phase", () => {
        const output = formatRunList([
            record({
                startedAt: "2026-01-01T00:00:00.000Z",
                attempt: 2,
                phase: "running",
            }),
        ]);

        expect(output).toContain("#20");
        expect(output).toContain("issue-20-background");
        expect(output).toContain("running");
        expect(output).toContain("2026-01-01T00:00:00.000Z");
        expect(output).toContain("2");
        expect(output).toContain("running");
    });

    it("shows branch, attempts, sync, and pull request in the detail view", () => {
        const output = formatRunDetail(
            record({
                state: "succeeded",
                phase: "finished",
                attempt: 1,
                finishedAt: "2026-01-01T00:05:00.000Z",
                sync: {
                    pushed: true,
                    branchUrl: "https://github.com/acme/repo/tree/afk/issue-20",
                    pushError: null,
                    commented: true,
                    commentError: null,
                    prUrl: "https://github.com/acme/repo/pull/7",
                    prCreated: true,
                    prReused: false,
                    prError: null,
                },
            }),
        );

        expect(output).toContain("Branch: afk/issue-20-background");
        expect(output).toContain("Attempts: 1");
        expect(output).toContain("GitHub sync: pushed, commented");
        expect(output).toContain(
            "Pull request: https://github.com/acme/repo/pull/7",
        );
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
