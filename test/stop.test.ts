import { describe, it, expect, afterEach, vi } from "vitest";
import { spawn } from "node:child_process";
import { execPath } from "node:process";
import {
    access,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    realpath,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcess, type ProcessResult } from "../src/process.js";
import { stopRun } from "../src/harness/stop.js";
import { setupWorktree } from "../src/worktree/manager.js";
import { isProcessAlive, readTaskLock } from "../src/harness/lock.js";
import {
    readRunRecord,
    runLogPath,
    saveRunRecord,
    type RunRecord,
} from "../src/harness/run_record.js";

const repos: string[] = [];

async function makeRepo(): Promise<string> {
    const repo = await realpath(
        await mkdtemp(join(tmpdir(), "afk-agent-stop-")),
    );
    await ChildProcess("git", ["init", "-q"], { cwd: repo });
    await ChildProcess(
        "git",
        [
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ],
        { cwd: repo },
    );
    repos.push(repo);
    return repo;
}

function record(
    repoPath: string,
    overrides: Partial<RunRecord> = {},
): RunRecord {
    const now = new Date().toISOString();
    return {
        taskId: "issue-5-demo",
        issueId: "5",
        issueNumber: 5,
        repoPath,
        branchName: "afk/issue-5-demo",
        state: "running",
        phase: "running",
        attempt: 1,
        pid: 2_000_000_000,
        startedAt: now,
        updatedAt: now,
        finishedAt: null,
        logPath: runLogPath(repoPath, "issue-5-demo"),
        report: null,
        sync: null,
        error: null,
        ...overrides,
    };
}

function processResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
    return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
        ...overrides,
    };
}

const coordinatorScript = `
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
fs.writeFileSync(process.argv[1], String(child.pid));
setInterval(() => {}, 1000);
`;

async function startCoordinator(pidFile: string): Promise<number> {
    const child = spawn(execPath, ["-e", coordinatorScript, pidFile], {
        detached: true,
        stdio: "ignore",
    });
    child.on("exit", () => {});
    child.unref();

    const pid = child.pid;
    if (pid === undefined) {
        throw new Error("Unable to start coordinator");
    }

    for (let i = 0; i < 100; i += 1) {
        const content = await readFile(pidFile, "utf8").catch(() => "");
        if (content.trim() !== "") {
            return pid;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }

    throw new Error("Coordinator did not report its child pid");
}

async function waitForDeath(pid: number): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
        if (!isProcessAlive(pid)) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Process ${pid} is still alive`);
}

async function writeLock(
    repoPath: string,
    taskId: string,
    pid: number,
): Promise<void> {
    const lockDir = join(repoPath, ".afk", "locks");
    await mkdir(lockDir, { recursive: true });
    await writeFile(
        join(lockDir, `${taskId}.lock`),
        JSON.stringify({
            pid,
            taskId,
            issueId: "5",
            repoPath,
            startedAt: new Date().toISOString(),
        }),
    );
}

afterEach(async () => {
    await Promise.all(
        repos
            .splice(0)
            .map((repo) => rm(repo, { recursive: true, force: true })),
    );
});

describe("stopRun", () => {
    it("reports no running agent when the issue has no run", async () => {
        const repoPath = await makeRepo();

        await expect(stopRun({ repoPath, issueNumber: 5 })).rejects.toThrow(
            `No running agent for issue 5 in ${repoPath}.`,
        );
    });

    it("refuses to stop a finished run and leaves it untouched", async () => {
        const repoPath = await makeRepo();
        const saved = record(repoPath, {
            state: "succeeded",
            phase: "finished",
            finishedAt: new Date().toISOString(),
        });
        await saveRunRecord(saved);
        await writeLock(repoPath, saved.taskId, 2_000_000_000);

        await expect(stopRun({ repoPath, issueNumber: 5 })).rejects.toThrow(
            `No running agent for issue 5 in ${repoPath}.`,
        );

        await expect(readRunRecord(repoPath, saved.taskId)).resolves.toEqual(
            saved,
        );
        await expect(
            readTaskLock(repoPath, saved.taskId),
        ).resolves.toMatchObject({ pid: 2_000_000_000 });
    });

    it("terminates the coordinator and its children, releases the lock, and records the stop", async () => {
        const repoPath = await makeRepo();
        const pidFile = join(repoPath, "child.pid");
        const coordinatorPid = await startCoordinator(pidFile);
        const childPid = Number((await readFile(pidFile, "utf8")).trim());
        const saved = record(repoPath, { pid: coordinatorPid });
        await saveRunRecord(saved);
        await writeLock(repoPath, saved.taskId, coordinatorPid);
        const run = vi.fn(async () => processResult());

        await stopRun({ repoPath, issueNumber: 5 }, { run });

        await waitForDeath(coordinatorPid);
        await waitForDeath(childPid);
        expect(run).toHaveBeenCalledWith(
            "docker",
            ["rm", "-f", "afk-issue-5-demo"],
            expect.anything(),
        );
        await expect(readTaskLock(repoPath, saved.taskId)).resolves.toBeNull();

        const stopped = await readRunRecord(repoPath, saved.taskId);
        expect(stopped).toMatchObject({
            state: "stopped",
            error: expect.stringContaining("Stopped by user"),
        });
        expect(stopped?.finishedAt).toEqual(expect.any(String));
        expect(stopped?.startedAt).toBe(saved.startedAt);
    });

    it("commits leftovers, removes the worktree, and keeps the task branch", async () => {
        const repoPath = await makeRepo();
        const { worktreePath, branchName } = await setupWorktree(
            repoPath,
            "issue-5-demo",
        );
        await writeFile(join(worktreePath, "leftover.txt"), "work in progress");
        await saveRunRecord(record(repoPath));
        const run = vi.fn(async () => processResult());

        const result = await stopRun({ repoPath, issueNumber: 5 }, { run });

        expect(result.cleanupError).toBeNull();
        expect(result.record.state).toBe("stopped");
        await expect(access(worktreePath)).rejects.toThrow();

        const branch = await ChildProcess(
            "git",
            ["branch", "--list", branchName],
            { cwd: repoPath },
        );
        expect(branch.stdout.trim()).not.toBe("");

        const committed = await ChildProcess(
            "git",
            ["show", `${branchName}:leftover.txt`],
            { cwd: repoPath },
        );
        expect(committed.exitCode).toBe(0);
        expect(committed.stdout).toBe("work in progress");

        const subjects = await ChildProcess(
            "git",
            ["log", "--format=%s", branchName],
            { cwd: repoPath },
        );
        expect(subjects.stdout).toContain(
            "wip(afk): uncommitted work from attempt 1",
        );
    });

    it("tolerates a sandbox that is already gone", async () => {
        const repoPath = await makeRepo();
        await saveRunRecord(record(repoPath));
        const run = vi.fn(async () =>
            processResult({
                exitCode: 1,
                stderr: "Error: No such container: afk-issue-5-demo",
            }),
        );

        const result = await stopRun({ repoPath, issueNumber: 5 }, { run });

        expect(result.cleanupError).toBeNull();
        expect(result.record.state).toBe("stopped");
    });

    it("force-kills a coordinator that ignores SIGTERM", async () => {
        const repoPath = await makeRepo();
        const readyFile = join(repoPath, "ready");
        const stubborn = spawn(
            execPath,
            [
                "-e",
                'process.on("SIGTERM", () => {}); require("node:fs").writeFileSync(process.argv[1], "ready"); setInterval(() => {}, 1000);',
                readyFile,
            ],
            { detached: true, stdio: "ignore" },
        );
        stubborn.on("exit", () => {});
        stubborn.unref();
        const pid = stubborn.pid;
        expect(pid).toBeDefined();

        for (let i = 0; i < 100; i += 1) {
            const ready = await readFile(readyFile, "utf8").catch(() => "");
            if (ready === "ready") {
                break;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        await saveRunRecord(record(repoPath, { pid: pid! }));
        const run = vi.fn(async () => processResult());

        await stopRun({ repoPath, issueNumber: 5 }, { run });

        await waitForDeath(pid!);
        const stopped = await readRunRecord(repoPath, "issue-5-demo");
        expect(stopped?.state).toBe("stopped");
    }, 15_000);

    it("records the stop even when Docker is unreachable", async () => {
        const repoPath = await makeRepo();
        await saveRunRecord(record(repoPath));
        await writeLock(repoPath, "issue-5-demo", 2_000_000_000);
        const run = vi.fn(async () => {
            throw new Error("Cannot connect to the Docker daemon");
        });

        const result = await stopRun({ repoPath, issueNumber: 5 }, { run });

        expect(result.record.state).toBe("stopped");
        expect(result.cleanupError).toContain(
            "Cannot connect to the Docker daemon",
        );
        await expect(
            readTaskLock(repoPath, "issue-5-demo"),
        ).resolves.toBeNull();
    });
});
