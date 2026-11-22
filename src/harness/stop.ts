import { stat } from "node:fs/promises";
import path from "node:path";
import { noRunningAgentMessage } from "../agent/docker_runner.js";
import { ChildProcess } from "../process.js";
import { commitLeftovers, type SyncRun } from "../github/sync.js";
import { removeWorktree } from "../worktree/manager.js";
import { isProcessAlive, releaseTaskLock } from "./lock.js";
import {
    findRunForIssue,
    readRunRecord,
    saveRunRecord,
    type RunRecord,
} from "./run_record.js";

export type StopRunInput = {
    repoPath: string;
    issueNumber: number;
};

export type StopRunDependencies = {
    run?: SyncRun;
};

export type StopRunResult = {
    record: RunRecord;
    cleanupError: string | null;
};

const TERMINATE_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const POLL_INTERVAL_MS = 100;
const SANDBOX_CLEANUP_TIMEOUT_MS = 10_000;

function tryKill(target: number, signal: NodeJS.Signals): boolean {
    try {
        process.kill(target, signal);
        return true;
    } catch {
        return false;
    }
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
    if (!tryKill(-pid, signal)) {
        tryKill(pid, signal);
    }
}

async function waitUntilDead(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (!isProcessAlive(pid)) {
            return true;
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    return !isProcessAlive(pid);
}

async function terminateProcess(pid: number | null): Promise<void> {
    if (pid === null || !isProcessAlive(pid)) {
        return;
    }

    signalTree(pid, "SIGTERM");
    if (await waitUntilDead(pid, TERMINATE_GRACE_MS)) {
        return;
    }

    signalTree(pid, "SIGKILL");
    await waitUntilDead(pid, KILL_GRACE_MS);
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function disposeWorktree(input: {
    repoPath: string;
    taskId: string;
    attempt: number;
}): Promise<string | null> {
    const worktreePath = path.join(
        input.repoPath,
        ".afk",
        "worktrees",
        input.taskId,
    );
    const exists = await stat(worktreePath)
        .then(() => true)
        .catch(() => false);

    if (!exists) {
        return null;
    }

    let commitError: string | null = null;

    try {
        await commitLeftovers({
            worktreePath,
            taskId: input.taskId,
            attempt: input.attempt,
        });
    } catch (error) {
        commitError = errorMessage(error);
    }

    try {
        await removeWorktree(input.repoPath, worktreePath, { force: true });
    } catch (error) {
        const removalError = errorMessage(error);
        return commitError ? `${commitError}; ${removalError}` : removalError;
    }

    return commitError;
}

export async function stopRun(
    input: StopRunInput,
    deps: StopRunDependencies = {},
): Promise<StopRunResult> {
    const run = deps.run ?? ChildProcess;
    const repoPath = path.resolve(input.repoPath);
    const record = await findRunForIssue(repoPath, input.issueNumber);

    if (record === null || record.state !== "running") {
        throw new Error(noRunningAgentMessage(repoPath, input.issueNumber));
    }

    await terminateProcess(record.pid);

    let sandboxError: string | null = null;

    try {
        const removal = await run(
            "docker",
            ["rm", "-f", `afk-${record.taskId}`],
            {
                timeout: SANDBOX_CLEANUP_TIMEOUT_MS,
            },
        );

        if (
            removal.exitCode !== 0 &&
            !removal.stderr.includes("No such container")
        ) {
            sandboxError = `Sandbox removal failed: ${removal.stderr.trim()}`;
        }
    } catch (error) {
        sandboxError = `Sandbox removal failed: ${errorMessage(error)}`;
    }

    const worktreeError = await disposeWorktree({
        repoPath,
        taskId: record.taskId,
        attempt: record.attempt,
    });
    const cleanupError =
        [sandboxError, worktreeError]
            .filter((message) => message !== null)
            .join("; ") || null;

    await releaseTaskLock({ repoPath, taskId: record.taskId, force: true });

    const latest = (await readRunRecord(repoPath, record.taskId)) ?? record;
    const now = new Date().toISOString();
    const stopped: RunRecord = {
        ...latest,
        state: "stopped",
        phase: "stopped",
        pid: null,
        updatedAt: now,
        finishedAt: now,
        error: "Stopped by user via afk stop.",
    };
    await saveRunRecord(stopped);

    return { record: stopped, cleanupError };
}
