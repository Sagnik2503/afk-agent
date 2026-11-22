import { describe, it, expect } from "vitest";
import type { RunRecord } from "../src/harness/run_record.js";
import { formatRunDetail, formatRunList } from "../src/ui/status.js";

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

describe("formatRunList", () => {
    it("lists issue, task, state, start, attempts, and phase", () => {
        const output = formatRunList([
            record({
                startedAt: "2026-01-01T00:00:00.000Z",
                attempts: 2,
                phase: "running",
            }),
        ]);

        expect(output).toContain("#20");
        expect(output).toContain("issue-20-background");
        expect(output).toContain("running");
        expect(output).toContain("2026-01-01T00:00:00.000Z");
        expect(output).toContain("2");
    });

    it("shows a vanished process as stale", () => {
        const output = formatRunList([record({ pid: 2_000_000_000 })]);

        expect(output).toContain("stale");
    });

    it("reports when there are no runs", () => {
        expect(formatRunList([])).toBe("No runs found.");
    });
});

describe("formatRunDetail", () => {
    it("shows branch, attempts, sync, and pull request in the detail view", () => {
        const output = formatRunDetail(
            record({
                state: "succeeded",
                phase: "finished",
                attempts: 1,
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
