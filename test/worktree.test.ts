import { describe, it, expect } from "vitest";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree } from "../src/worktree/manager.js";
import { ChildProcess } from "../src/process.js";

async function makeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "afk-agent-repo-"));
    await ChildProcess("git", ["init", "-q"], { cwd: repo });
    await ChildProcess(
        "git",
        ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "init"],
        { cwd: repo }
    );
    return repo;
}

describe("createWorktree", () => {
    it("creates a worktree on a new branch", async () => {
        const repo = await makeRepo();
        const worktree = join(repo, "..", `afk-agent-wt-${Date.now()}`);

        try {
            await createWorktree(repo, "feature-branch", worktree);

            await expect(access(worktree)).resolves.toBeUndefined();

            const branches = await ChildProcess("git", ["branch", "--list", "feature-branch"], { cwd: repo });
            expect(branches.stdout).toContain("feature-branch");
        } finally {
            await rm(worktree, { recursive: true, force: true });
            await rm(repo, { recursive: true, force: true });
        }
    });

    it("throws when the repo path is not a git repository", async () => {
        const directory = await mkdtemp(join(tmpdir(), "afk-agent-not-repo-"));

        try {
            await expect(
                createWorktree(directory, "feature-branch", join(directory, "worktree"))
            ).rejects.toThrow(/worktree creation failed/i);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
