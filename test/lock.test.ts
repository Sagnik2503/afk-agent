import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    acquireTaskLock,
    readTaskLock,
    releaseTaskLock,
} from "../src/harness/lock.js";

vi.mock("node:fs/promises", async (importOriginal) => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        rename: vi.fn(actual.rename),
    };
});

const repos: string[] = [];

async function makeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "afk-agent-lock-"));
    repos.push(repo);
    return repo;
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

afterEach(async () => {
    await Promise.all(
        repos
            .splice(0)
            .map((repo) => rm(repo, { recursive: true, force: true })),
    );
});

describe("acquireTaskLock", () => {
    it("creates a lock file with the task details", async () => {
        const repoPath = await makeRepo();

        await acquireTaskLock({
            repoPath,
            taskId: "issue-1-demo",
            issueId: "1",
        });

        const lock = await readTaskLock(repoPath, "issue-1-demo");
        expect(lock).toMatchObject({
            pid: process.pid,
            taskId: "issue-1-demo",
            issueId: "1",
            repoPath,
        });
        expect(lock?.startedAt).toEqual(expect.any(String));
    });

    it("refuses when a live process holds the lock", async () => {
        const repoPath = await makeRepo();
        await acquireTaskLock({
            repoPath,
            taskId: "issue-1-demo",
            issueId: "1",
        });

        await expect(
            acquireTaskLock({
                repoPath,
                taskId: "issue-1-demo",
                issueId: "1",
            }),
        ).rejects.toThrow(/issue-1-demo is already running/);
        await expect(
            acquireTaskLock({
                repoPath,
                taskId: "issue-1-demo",
                issueId: "1",
            }),
        ).rejects.toThrow(`afk logs --repo ${repoPath} --issue 1`);
    });

    it("reclaims a lock left by a dead process", async () => {
        const repoPath = await makeRepo();
        const lockDir = join(repoPath, ".afk", "locks");
        const { mkdir } = await import("node:fs/promises");
        await mkdir(lockDir, { recursive: true });
        await writeFile(
            join(lockDir, "issue-1-demo.lock"),
            JSON.stringify({
                pid: 2_000_000_000,
                taskId: "issue-1-demo",
                issueId: "1",
                repoPath,
                startedAt: new Date().toISOString(),
            }),
        );

        await acquireTaskLock({
            repoPath,
            taskId: "issue-1-demo",
            issueId: "1",
        });

        const lock = await readTaskLock(repoPath, "issue-1-demo");
        expect(lock?.pid).toBe(process.pid);
    });

    it("does not delete a live lock acquired while reclaiming a dead one", async () => {
        const repoPath = await makeRepo();
        const lockDir = join(repoPath, ".afk", "locks");
        const { mkdir } = await import("node:fs/promises");
        await mkdir(lockDir, { recursive: true });
        const lockFile = join(lockDir, "issue-1-demo.lock");
        await writeFile(
            lockFile,
            JSON.stringify({
                pid: 2_000_000_000,
                taskId: "issue-1-demo",
                issueId: "1",
                repoPath,
                startedAt: new Date().toISOString(),
            }),
        );

        const fs = await import("node:fs/promises");
        const renameMock = vi.mocked(fs.rename);
        const realRename = renameMock.getMockImplementation()!;
        let reclaimCalls = 0;
        let secondDone!: () => void;
        const secondAcquired = new Promise<void>((resolve) => {
            secondDone = resolve;
        });
        renameMock.mockImplementation(async (from, to) => {
            if (String(from) === lockFile) {
                reclaimCalls += 1;
                if (reclaimCalls === 1) {
                    await secondAcquired;
                }
            }
            return realRename(from, to);
        });

        const first = acquireTaskLock({
            repoPath,
            taskId: "issue-1-demo",
            issueId: "1",
        });
        const firstOutcome = first.then(
            () => "fulfilled",
            (error: Error) => error.message,
        );

        while (reclaimCalls === 0) {
            await new Promise((resolve) => setTimeout(resolve, 5));
        }

        await acquireTaskLock({
            repoPath,
            taskId: "issue-1-demo",
            issueId: "1",
        });
        secondDone();

        expect(await firstOutcome).toMatch(/already running/);
        await expect(
            readTaskLock(repoPath, "issue-1-demo"),
        ).resolves.toMatchObject({ pid: process.pid });
        renameMock.mockReset();
    });

    it("lets different task IDs run at the same time", async () => {
        const repoPath = await makeRepo();

        await acquireTaskLock({
            repoPath,
            taskId: "issue-1-demo",
            issueId: "1",
        });
        await acquireTaskLock({
            repoPath,
            taskId: "issue-2-other",
            issueId: "2",
        });

        await expect(
            readTaskLock(repoPath, "issue-1-demo"),
        ).resolves.toMatchObject({ taskId: "issue-1-demo" });
        await expect(
            readTaskLock(repoPath, "issue-2-other"),
        ).resolves.toMatchObject({ taskId: "issue-2-other" });
    });
});

describe("releaseTaskLock", () => {
    it("removes the lock it owns", async () => {
        const repoPath = await makeRepo();
        await acquireTaskLock({
            repoPath,
            taskId: "issue-1-demo",
            issueId: "1",
        });

        await releaseTaskLock({ repoPath, taskId: "issue-1-demo" });

        await expect(
            readTaskLock(repoPath, "issue-1-demo"),
        ).resolves.toBeNull();
        await expect(
            exists(join(repoPath, ".afk", "locks", "issue-1-demo.lock")),
        ).resolves.toBe(false);
    });

    it("does not remove another live process's lock", async () => {
        const repoPath = await makeRepo();
        const lockDir = join(repoPath, ".afk", "locks");
        const { mkdir } = await import("node:fs/promises");
        await mkdir(lockDir, { recursive: true });
        await writeFile(
            join(lockDir, "issue-1-demo.lock"),
            JSON.stringify({
                pid: process.pid + 1,
                taskId: "issue-1-demo",
                issueId: "1",
                repoPath,
                startedAt: new Date().toISOString(),
            }),
        );

        await releaseTaskLock({ repoPath, taskId: "issue-1-demo" });

        await expect(
            readTaskLock(repoPath, "issue-1-demo"),
        ).resolves.toMatchObject({ pid: process.pid + 1 });
    });

    it("is safe to call twice", async () => {
        const repoPath = await makeRepo();
        await acquireTaskLock({
            repoPath,
            taskId: "issue-1-demo",
            issueId: "1",
        });

        await releaseTaskLock({ repoPath, taskId: "issue-1-demo" });
        await expect(
            releaseTaskLock({ repoPath, taskId: "issue-1-demo" }),
        ).resolves.toBeUndefined();
    });
});
