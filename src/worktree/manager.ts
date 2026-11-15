import fs from "node:fs/promises";
import path from "node:path";
import { ChildProcess } from "../process.js";

export async function createWorktree(
    repoPath: string,
    branchName: string,
    worktreePath: string,
    startPoint?: string,
): Promise<void> {
    const args = startPoint
        ? ["worktree", "add", "-b", branchName, worktreePath, startPoint]
        : ["worktree", "add", "-b", branchName, worktreePath];

    const child = await ChildProcess("git", args, { cwd: repoPath });

    if (child.exitCode !== 0) {
        throw new Error(`Git worktree creation failed: ${child.stderr}`);
    }
}

export async function attachWorktree(
    repoPath: string,
    branchName: string,
    worktreePath: string,
): Promise<void> {
    const child = await ChildProcess(
        "git",
        ["worktree", "add", worktreePath, branchName],
        { cwd: repoPath },
    );

    if (child.exitCode !== 0) {
        throw new Error(`Git worktree attachment failed: ${child.stderr}`);
    }
}

async function branchExists(
    repoPath: string,
    branchName: string,
): Promise<boolean> {
    const result = await ChildProcess("git", ["branch", "--list", branchName], {
        cwd: repoPath,
    });

    if (result.exitCode !== 0) {
        throw new Error(`Git branch lookup failed: ${result.stderr}`);
    }

    return result.stdout.trim() !== "";
}

async function remoteBranchExists(
    repoPath: string,
    branchName: string,
): Promise<boolean> {
    const result = await ChildProcess(
        "git",
        ["ls-remote", "--exit-code", "--heads", "origin", branchName],
        { cwd: repoPath, timeout: 30_000 },
    );

    return result.exitCode === 0;
}

export async function listWorktrees(repoPath: string): Promise<string[]> {
    const child = await ChildProcess(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: repoPath },
    );

    if (child.exitCode !== 0) {
        throw new Error(`Git worktree list failed: ${child.stderr}`);
    }

    return child.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim());
}

export async function removeWorktree(
    repoPath: string,
    worktreePath: string,
): Promise<void> {
    const child = await ChildProcess(
        "git",
        ["worktree", "remove", worktreePath],
        { cwd: repoPath },
    );

    if (child.exitCode !== 0) {
        throw new Error(`Git worktree removal failed: ${child.stderr}`);
    }
}

export async function setupWorktree(
    repoPath: string,
    taskId: string,
): Promise<{
    branchName: string;
    worktreePath: string;
}> {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) {
        throw new Error("Invalid task ID");
    }

    await ChildProcess("git", ["worktree", "prune"], { cwd: repoPath });

    const existingWorktrees = await listWorktrees(repoPath);

    const branchName = `afk/${taskId}`;
    const worktreePath = path.join(repoPath, ".afk", "worktrees", taskId);
    const resolvedWorktreePath = path.join(
        await fs.realpath(repoPath),
        ".afk",
        "worktrees",
        taskId,
    );

    if (existingWorktrees.includes(resolvedWorktreePath)) {
        throw new Error(`Worktree already exists for task: ${taskId}`);
    }

    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    if (await branchExists(repoPath, branchName)) {
        await attachWorktree(repoPath, branchName, worktreePath);
    } else if (await remoteBranchExists(repoPath, branchName)) {
        const fetched = await ChildProcess(
            "git",
            [
                "fetch",
                "origin",
                `refs/heads/${branchName}:refs/remotes/origin/${branchName}`,
            ],
            { cwd: repoPath, timeout: 60_000 },
        );

        if (fetched.exitCode !== 0) {
            throw new Error(`Git fetch failed: ${fetched.stderr}`);
        }

        await createWorktree(
            repoPath,
            branchName,
            worktreePath,
            `origin/${branchName}`,
        );

        await ChildProcess(
            "git",
            ["branch", "--set-upstream-to", `origin/${branchName}`, branchName],
            { cwd: repoPath },
        );
    } else {
        await createWorktree(repoPath, branchName, worktreePath);
    }

    return {
        branchName,
        worktreePath,
    };
}
