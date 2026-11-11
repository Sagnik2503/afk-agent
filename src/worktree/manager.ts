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
   
    const existingWorktrees = await listWorktrees(repoPath);

    const branchName = `afk/${taskId}`;
    const worktreePath = path.join(
        repoPath,
        ".afk",
        "worktrees",
        taskId
    );
    const resolvedWorktreePath = path.join(
        await fs.realpath(repoPath),
        ".afk",
        "worktrees",
        taskId
    );

    //checks if the worktree already exists or not
    if (existingWorktrees.includes(resolvedWorktreePath)) {
        throw new Error(`Worktree already exists for task: ${taskId}`);
    }

    //check for an existing branch whose worktree has not been created
    const result = await ChildProcess(
    "git",
    ["branch", "--list", branchName],
    { cwd: repoPath }
    );

    if (result.stdout.trim() !== "") {
    throw new Error(`Branch already exists: ${branchName}`);
    }
    
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });
    await createWorktree(repoPath, branchName, worktreePath);
    return {
    branchName,
    worktreePath,
  };

}