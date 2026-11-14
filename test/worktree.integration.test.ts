import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    setupWorktree,
    listWorktrees,
    removeWorktree,
} from "../src/worktree/manager.js";
import { ChildProcess } from "../src/process.js";

describe("setupWorktree integration", () => {
    let repo: string;

    beforeEach(async () => {
        repo = await mkdtemp(join(tmpdir(), "afk-agent-integration-"));
        await ChildProcess("git", ["init", "-q"], { cwd: repo });
        await ChildProcess(
            "git",
            [
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "init",
            ],
            { cwd: repo },
        );
    });

    afterEach(async () => {
        await rm(repo, { recursive: true, force: true });
    });

    it("creates a worktree on branch afk/task-123 and lists it", async () => {
        const result = await setupWorktree(repo, "task-123");

        expect(result.branchName).toBe("afk/task-123");
        await expect(access(result.worktreePath)).resolves.toBeUndefined();

        const worktrees = await listWorktrees(repo);
        expect(worktrees).toContain(await realpath(result.worktreePath));
    });

    it("fails when called twice with the same task ID", async () => {
        await setupWorktree(repo, "task-123");

        await expect(setupWorktree(repo, "task-123")).rejects.toThrow(
            /already exists for task/i,
        );
    });

    it("fails for an invalid task ID such as ../test", async () => {
        await expect(setupWorktree(repo, "../test")).rejects.toThrow(
            /Invalid task ID/i,
        );
    });

    it("resumes an existing local branch after its worktree is removed", async () => {
        const first = await setupWorktree(repo, "task-resume");
        await ChildProcess(
            "git",
            [
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "keep me",
            ],
            { cwd: first.worktreePath },
        );
        await removeWorktree(repo, first.worktreePath);

        const second = await setupWorktree(repo, "task-resume");

        expect(second.branchName).toBe("afk/task-resume");
        expect(second.worktreePath).toBe(first.worktreePath);
        await expect(access(second.worktreePath)).resolves.toBeUndefined();

        const log = await ChildProcess("git", ["log", "-1", "--format=%s"], {
            cwd: second.worktreePath,
        });
        expect(log.stdout.trim()).toBe("keep me");
    });

    it("creates the worktree from the remote branch when only the remote exists", async () => {
        const origin = await mkdtemp(join(tmpdir(), "afk-agent-origin-"));
        const originUrl = "https://github.com/test-owner/test-repo.git";
        const originPath = await realpath(origin);

        await ChildProcess("git", ["init", "-q", "--bare", originPath]);
        await ChildProcess("git", ["remote", "add", "origin", originUrl], {
            cwd: repo,
        });
        await ChildProcess(
            "git",
            ["config", `url.${originPath}.insteadOf`, originUrl],
            { cwd: repo },
        );
        await ChildProcess("git", ["branch", "afk/task-remote"], { cwd: repo });
        await ChildProcess("git", ["push", "-q", "origin", "afk/task-remote"], {
            cwd: repo,
        });
        await ChildProcess("git", ["branch", "-D", "afk/task-remote"], {
            cwd: repo,
        });

        try {
            const result = await setupWorktree(repo, "task-remote");

            const log = await ChildProcess(
                "git",
                ["log", "-1", "--format=%s"],
                { cwd: result.worktreePath },
            );
            expect(log.stdout.trim()).toBe("init");

            const upstream = await ChildProcess(
                "git",
                ["rev-parse", "--abbrev-ref", "afk/task-remote@{upstream}"],
                { cwd: repo },
            );
            expect(upstream.stdout.trim()).toBe("origin/afk/task-remote");
        } finally {
            await rm(originPath, { recursive: true, force: true });
        }
    });
});
