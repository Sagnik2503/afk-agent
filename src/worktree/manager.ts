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