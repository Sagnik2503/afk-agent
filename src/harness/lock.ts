import { mkdir, open, readFile, unlink } from "node:fs/promises";
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

function isProcessAlive(pid: number): boolean {
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

export async function readTaskLock(
    repoPath: string,
    taskId: string,
): Promise<TaskLock | null> {
    try {
        const content = await readFile(lockPath(repoPath, taskId), "utf8");
        return JSON.parse(content) as TaskLock;
    } catch {
        return null;
    }
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

            await unlink(file).catch(() => undefined);
        }
    }

    throw new Error(`Unable to acquire lock for task ${input.taskId}`);
}

export async function releaseTaskLock(input: {
    repoPath: string;
    taskId: string;
}): Promise<void> {
    if (!/^[a-zA-Z0-9_-]+$/.test(input.taskId)) {
        return;
    }

    const existing = await readTaskLock(input.repoPath, input.taskId);
    if (existing?.pid !== process.pid) {
        return;
    }

    await unlink(lockPath(input.repoPath, input.taskId)).catch(() => undefined);
}
