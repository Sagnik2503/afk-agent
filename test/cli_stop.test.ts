import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { execPath } from "node:process";
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setupWorktree } from "../src/worktree/manager.js";
import {
    readRunRecord,
    runLogPath,
    saveRunRecord,
    type RunRecord,
} from "../src/harness/run_record.js";
import { readTaskLock } from "../src/harness/lock.js";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const repos: string[] = [];

async function makeRepo(): Promise<string> {
    const repo = await realpath(
        await mkdtemp(join(tmpdir(), "afk-agent-cli-stop-")),
    );
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
    execFileSync(
        "git",
        [
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "--quiet",
            "--allow-empty",
            "-m",
            "init",
        ],
        { cwd: repo },
    );
    repos.push(repo);
    return repo;
}

function runCli(
    args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(execPath, ["--import", "tsx", cliPath, ...args], {
            env: { ...process.env, NO_COLOR: "1" },
        });

        let stdout = "";
        let stderr = "";

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
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

describe("afk stop", () => {
    it("prints the no-running-agent message and exits non-zero when there is no run", async () => {
        const repoPath = await makeRepo();
        const other = record(repoPath, {
            taskId: "issue-6-other",
            issueId: "6",
            issueNumber: 6,
            state: "succeeded",
            phase: "finished",
            finishedAt: new Date().toISOString(),
            logPath: runLogPath(repoPath, "issue-6-other"),
        });
        await saveRunRecord(other);

        const { code, stderr } = await runCli([
            "stop",
            "--repo",
            repoPath,
            "--issue",
            "5",
        ]);

        expect(code).not.toBe(0);
        expect(stderr).toContain(
            `No running agent for issue 5 in ${repoPath}.`,
        );
        await expect(readRunRecord(repoPath, "issue-6-other")).resolves.toEqual(
            other,
        );
    });

    it("refuses to stop a finished run without touching it", async () => {
        const repoPath = await makeRepo();
        const finished = record(repoPath, {
            state: "succeeded",
            phase: "finished",
            finishedAt: new Date().toISOString(),
        });
        await saveRunRecord(finished);

        const { code, stderr } = await runCli([
            "stop",
            "--repo",
            repoPath,
            "--issue",
            "5",
        ]);

        expect(code).not.toBe(0);
        expect(stderr).toContain(
            `No running agent for issue 5 in ${repoPath}.`,
        );
        await expect(readRunRecord(repoPath, finished.taskId)).resolves.toEqual(
            finished,
        );
    });

    it("stops a running agent given an issue URL, then status and logs reflect it", async () => {
        const repoPath = await makeRepo();
        const { worktreePath, branchName } = await setupWorktree(
            repoPath,
            "issue-5-demo",
        );
        await writeFile(join(worktreePath, "leftover.txt"), "unsaved work");

        const coordinator = spawn(
            execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            { detached: true, stdio: "ignore" },
        );
        coordinator.on("exit", () => {});
        coordinator.unref();
        const pid = coordinator.pid;
        expect(pid).toBeDefined();

        const running = record(repoPath, { pid: pid! });
        await saveRunRecord(running);
        await writeLock(repoPath, running.taskId, pid!);
        await writeFile(running.logPath, "persisted agent output\n");

        const stop = await runCli([
            "stop",
            "--repo",
            repoPath,
            "--issue",
            "https://github.com/acme/repo/issues/5",
        ]);

        expect(stop.code).toBe(0);
        expect(stop.stdout).toContain("Stopped");
        expect(stop.stdout).toContain(branchName);

        const stopped = await readRunRecord(repoPath, running.taskId);
        expect(stopped?.state).toBe("stopped");
        expect(stopped?.finishedAt).toEqual(expect.any(String));
        await expect(
            readTaskLock(repoPath, running.taskId),
        ).resolves.toBeNull();

        const branch = execFileSync("git", ["branch", "--list", branchName], {
            cwd: repoPath,
            encoding: "utf8",
        });
        expect(branch.trim()).not.toBe("");
        const committed = execFileSync(
            "git",
            ["show", `${branchName}:leftover.txt`],
            { cwd: repoPath, encoding: "utf8" },
        );
        expect(committed).toBe("unsaved work");

        const status = await runCli([
            "status",
            "--repo",
            repoPath,
            "--issue",
            "5",
        ]);
        expect(status.code).toBe(0);
        expect(status.stdout).toContain("State: stopped");
        expect(status.stdout).toMatch(/Finished: \d{4}-/);

        const logs = await runCli(["logs", "--repo", repoPath, "--issue", "5"]);
        expect(logs.code).toBe(0);
        expect(logs.stdout).toContain("persisted agent output");

        const content = await readFile(running.logPath, "utf8");
        expect(content).toContain("persisted agent output");
    }, 30_000);
});
