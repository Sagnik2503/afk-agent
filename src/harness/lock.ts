import { randomUUID } from "node:crypto";
import {
    link,
    mkdir,
    open,
    readFile,
    rename,
    unlink,
    writeFile,
} from "node:fs/promises";
import path from "node:path";

export type TaskLock = {
    pid: number;
    taskId: string;
    issueId: string;
    repoPath: string;
    startedAt: string;
};

function lockPath(repoPath: string, taskId: string): string {
    return path.join(repoPath, ".afk", "locks", `${taskId}.lock`);
}

export function isProcessAlive(pid: number): boolean {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        return false;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
}

async function readLockFile(file: string): Promise<TaskLock | null> {
    try {
        const content = await readFile(file, "utf8");
        return JSON.parse(content) as TaskLock;
    } catch {
        return null;
    }
}

export async function readTaskLock(
    repoPath: string,
    taskId: string,
): Promise<TaskLock | null> {
    return readLockFile(lockPath(repoPath, taskId));
}

export async function acquireTaskLock(input: {
    repoPath: string;
    taskId: string;
    issueId: string;
}): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.taskId)) {
        throw new Error("Invalid task ID");
    }

    const file = lockPath(input.repoPath, input.taskId);
    await mkdir(path.dirname(file), { recursive: true });

    for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
            const handle = await open(file, "wx");
            try {
                await handle.writeFile(
                    JSON.stringify({
                        pid: process.pid,
                        taskId: input.taskId,
                        issueId: input.issueId,
                        repoPath: input.repoPath,
                        startedAt: new Date().toISOString(),
                    } satisfies TaskLock),
                );
            } finally {
                await handle.close();
            }
            return;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                throw error;
            }

            const existing = await readTaskLock(input.repoPath, input.taskId);

            if (existing !== null && isProcessAlive(existing.pid)) {
                throw new Error(
                    `Task ${input.taskId} is already running (pid ${existing.pid}). ` +
                        `Watch it with: afk logs --repo ${input.repoPath} --issue ${input.issueId}`,
                    { cause: error },
                );
            }

            const claim = `${file}.stale-${randomUUID()}`;
            try {
                await rename(file, claim);
            } catch {
                continue;
            }

            const claimed = await readLockFile(claim);

            if (claimed !== null && isProcessAlive(claimed.pid)) {
                const restored = await link(claim, file)
                    .then(() => true)
                    .catch(() => false);
                if (restored) {
                    await unlink(claim).catch(() => undefined);
                }
                continue;
            }

            await unlink(claim).catch(() => undefined);
        }
    }

    throw new Error(`Unable to acquire lock for task ${input.taskId}`);
}

export async function transferTaskLock(input: {
    repoPath: string;
    taskId: string;
    toPid: number;
}): Promise<void> {
    const existing = await readTaskLock(input.repoPath, input.taskId);

    if (existing?.pid !== process.pid) {
        throw new Error(
            `Task ${input.taskId} lock is not held by this process`,
        );
    }

    await writeFile(
        lockPath(input.repoPath, input.taskId),
        JSON.stringify({ ...existing, pid: input.toPid } satisfies TaskLock),
    );
}

export async function releaseTaskLock(input: {
    repoPath: string;
    taskId: string;
    force?: boolean;
}): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.taskId)) {
        return;
    }

    const existing = await readTaskLock(input.repoPath, input.taskId);
    if (input.force !== true && existing?.pid !== process.pid) {
        return;
    }

    await unlink(lockPath(input.repoPath, input.taskId)).catch(() => undefined);
}
