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