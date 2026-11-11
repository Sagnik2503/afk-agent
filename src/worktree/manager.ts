import fs from "node:fs/promises";
import path from "node:path";
import { ChildProcess } from "../process.js";

export async function createWorktree(
    repoPath: string,
    branchName: string,
    worktreePath: string
): Promise<void> {
    const child = await ChildProcess(
        "git",
        ["worktree", "add", "-b", branchName, worktreePath],
        { cwd: repoPath }
    );

    if (child.exitCode !== 0) {
        throw new Error(
            `Git worktree creation failed: ${child.stderr}`
        );
    }
}

export async function listWorktrees(
    repoPath: string
): Promise<string[]> {
    const child = await ChildProcess(
        "git",
        ["worktree", "list", "--porcelain"],
        { cwd: repoPath }
    );

    if (child.exitCode !== 0) {
        throw new Error(
            `Git worktree list failed: ${child.stderr}`
        );
    }

    return child.stdout
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim());
}

export async function removeWorktree(
    repoPath: string,
    worktreePath: string
): Promise<void> {
    const child = await ChildProcess(
        "git",
        ["worktree", "remove",worktreePath],
        { cwd: repoPath }
    );

    if (child.exitCode !== 0) {
        throw new Error(
            `Git worktree removal failed: ${child.stderr}`
        );
    }
}

export async function setupWorktree(
    repoPath: string,
    taskId: string
): Promise<{
    branchName: string;
    worktreePath: string;
}> {
   
    const branchName = `afk/${taskId}`;
    const worktreePath = path.join(
        repoPath,
        ".afk",
        "worktrees",
        taskId
    );
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await createWorktree(repoPath, branchName, worktreePath);
    return {
    branchName,
    worktreePath,
  };

}