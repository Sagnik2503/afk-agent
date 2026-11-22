import { commitLeftovers, type SyncRun } from "../github/sync.js";
import { removeWorktree } from "../worktree/manager.js";
import { errorMessage } from "../errors.js";

export type DisposeWorktreeInput = {
    repoPath: string;
    worktreePath: string;
    taskId: string;
    attempt: number;
};

export type DisposeWorktreeResult = {
    removed: boolean;
    error: string | null;
};

// Commit leftovers (best effort), then force-remove the worktree; the branch
// survives. See ADR-0001.
export async function disposeWorktree(
    input: DisposeWorktreeInput,
    deps: { run?: SyncRun } = {},
): Promise<DisposeWorktreeResult> {
    let commitError: string | null = null;

    try {
        await commitLeftovers(
            {
                worktreePath: input.worktreePath,
                taskId: input.taskId,
                attempt: input.attempt,
            },
            deps,
        );
    } catch (error) {
        commitError = errorMessage(error);
    }

    try {
        await removeWorktree(input.repoPath, input.worktreePath, {
            force: true,
        });
        return { removed: true, error: commitError };
    } catch (error) {
        const removalError = errorMessage(error);
        return {
            removed: false,
            error: commitError
                ? `${commitError}; ${removalError}`
                : removalError,
        };
    }
}
