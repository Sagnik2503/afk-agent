import { stat } from "node:fs/promises";
import path from "node:path";
import {
    noRunningAgentMessage,
    sandboxContainerName,
} from "../agent/docker_runner.js";
import { ChildProcess } from "../process.js";
import type { SyncRun } from "../github/sync.js";
import { taskWorktreePath } from "../worktree/manager.js";
import { errorMessage } from "../errors.js";
import { disposeWorktree } from "./dispose.js";
import { isProcessAlive, releaseTaskLock } from "./lock.js";
import {
    findRunForIssue,
    readRunRecord,
    resolveRunState,
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

async function disposeStoppedWorktree(input: {
    repoPath: string;
    taskId: string;
    attempt: number;
}): Promise<string | null> {
    const worktreePath = taskWorktreePath(input.repoPath, input.taskId);
    const exists = await stat(worktreePath)
        .then(() => true)
        .catch(() => false);

    if (!exists) {
        return null;
    }

    const { error } = await disposeWorktree({
        repoPath: input.repoPath,
        worktreePath,
        taskId: input.taskId,
        attempt: input.attempt,
    });
    return error;
}

export async function stopRun(
    input: StopRunInput,
    deps: StopRunDependencies = {},
): Promise<StopRunResult> {
    const run = deps.run ?? ChildProcess;
    const repoPath = path.resolve(input.repoPath);
    const record = await findRunForIssue(repoPath, input.issueNumber);

    if (record === null) {
        throw new Error(noRunningAgentMessage(repoPath, input.issueNumber));
    }

    const state = resolveRunState(record);

    if (state !== "running" && state !== "stale") {
        throw new Error(noRunningAgentMessage(repoPath, input.issueNumber));
    }

    const stale = state === "stale";

    await terminateProcess(record.pid);

    let sandboxError: string | null = null;

    try {
        const removal = await run(
            "docker",
            ["rm", "-f", sandboxContainerName(record.taskId)],
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

    const worktreeError = await disposeStoppedWorktree({
        repoPath,
        taskId: record.taskId,
        attempt: record.attempts,
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
        error: stale
            ? "Stale run cleaned up by afk stop."
            : "Stopped by user via afk stop.",
    };
    await saveRunRecord(stopped);

    if (stale) {
        if (cleanupError !== null) {
            console.error("Cleanup warning:", cleanupError);
        }
        throw new Error(noRunningAgentMessage(repoPath, input.issueNumber));
    }

    return { record: stopped, cleanupError };
}
