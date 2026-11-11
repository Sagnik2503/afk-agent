import { describe, it, expect } from "vitest";
import { mkdtemp, rm, access, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorktree, removeWorktree, listWorktrees, setupWorktree } from "../src/worktree/manager.js";
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

describe("removeWorktree", () => {
    it("successfully removes an existing worktree", async () => {
        const repo = await makeRepo();
        const worktree = join(repo, "..", `afk-agent-wt-${Date.now()}`);

        try {
            await createWorktree(repo, "remove-me", worktree);
            await removeWorktree(repo, worktree);

            await expect(access(worktree)).rejects.toThrow();
        } finally {
            await rm(worktree, { recursive: true, force: true });
            await rm(repo, { recursive: true, force: true });
        }
    });

    it("fails when the worktree doesn't exist", async () => {
        const repo = await makeRepo();

        try {
            await expect(
                removeWorktree(repo, join(repo, "no-such-worktree"))
            ).rejects.toThrow(/worktree removal failed/i);
        } finally {
            await rm(repo, { recursive: true, force: true });
        }
    });

    it("doesn't remove the original working directory", async () => {
        const repo = await makeRepo();
        const worktree = join(repo, "..", `afk-agent-wt-${Date.now()}`);

        try {
            await createWorktree(repo, "keep-repo", worktree);
            await removeWorktree(repo, worktree);

            await expect(access(repo)).resolves.toBeUndefined();
        } finally {
            await rm(worktree, { recursive: true, force: true });
            await rm(repo, { recursive: true, force: true });
        }
    });
});

describe("listWorktrees", () => {
    it("returns the main repo and any created worktree paths", async () => {
        const repo = await makeRepo();
        const worktree = join(repo, "..", `afk-agent-wt-${Date.now()}`);

        try {
            await createWorktree(repo, "listed-branch", worktree);
            const paths = await listWorktrees(repo);

            expect(paths).toContain(await realpath(worktree));
            expect(paths.length).toBe(2);
        } finally {
            await rm(worktree, { recursive: true, force: true });
            await rm(repo, { recursive: true, force: true });
        }
    });
});

describe("setupWorktree", () => {
    it("creates a worktree on an afk-prefixed branch inside .afk/worktrees", async () => {
        const repo = await makeRepo();
        const taskId = `task-${Date.now()}`;

        try {
            const result = await setupWorktree(repo, taskId);

            expect(result.branchName).toBe(`afk/${taskId}`);
            expect(result.worktreePath).toBe(join(repo, ".afk", "worktrees", taskId));
            await expect(access(result.worktreePath)).resolves.toBeUndefined();

            const branches = await ChildProcess("git", ["branch", "--list", `afk/${taskId}`], { cwd: repo });
            expect(branches.stdout).toContain(`afk/${taskId}`);
        } finally {
            await rm(repo, { recursive: true, force: true });
        }
    });

    it("fails when the task's branch already exists", async () => {
        const repo = await makeRepo();
        const taskId = `task-${Date.now()}`;

        try {
            await setupWorktree(repo, taskId);

            await expect(setupWorktree(repo, taskId)).rejects.toThrow(
                /worktree creation failed/i
            );
        } finally {
            await rm(repo, { recursive: true, force: true });
        }
    });
});
