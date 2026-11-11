import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupWorktree, listWorktrees } from "../src/worktree/manager.js";
import { ChildProcess } from "../src/process.js";

describe("setupWorktree integration", () => {
    let repo: string;

    beforeEach(async () => {
        repo = await mkdtemp(join(tmpdir(), "afk-agent-integration-"));
        await ChildProcess("git", ["init", "-q"], { cwd: repo });
        await ChildProcess(
            "git",
            ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "init"],
            { cwd: repo }
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
            /already exists for task/i
        );
    });

    it("fails for an invalid task ID such as ../test", async () => {
        await expect(setupWorktree(repo, "../test")).rejects.toThrow(
            /Invalid task ID/i
        );
    });
});
