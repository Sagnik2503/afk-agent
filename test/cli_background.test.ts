import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
    findRunForIssue,
    runLogPath,
    saveRunRecord,
    type RunRecord,
} from "../src/harness/run_record.js";
import { readTaskLock } from "../src/harness/lock.js";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const repos: string[] = [];

async function makeRepo(): Promise<string> {
    const repo = await realpath(
        await mkdtemp(join(tmpdir(), "afk-agent-cli-")),
    );
    execFileSync("git", ["init", "--quiet"], { cwd: repo });
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
        state: "succeeded",
        phase: "finished",
        attempts: 1,
        pid: 2_000_000_000,
        startedAt: now,
        updatedAt: now,
        finishedAt: now,
        logPath: runLogPath(repoPath, "issue-5-demo"),
        report: null,
        sync: null,
        error: null,
        ...overrides,
    };
}

afterEach(async () => {
    await Promise.all(
        repos
            .splice(0)
            .map((repo) => rm(repo, { recursive: true, force: true })),
    );
});

describe("afk status", () => {
    it("reports when there are no runs", async () => {
        const repoPath = await makeRepo();

        const { code, stdout } = await runCli(["status", "--repo", repoPath]);

        expect(code).toBe(0);
        expect(stdout).toContain("No runs found");
    });

    it("lists runs with their state and attempt", async () => {
        const repoPath = await makeRepo();
        await saveRunRecord(record(repoPath));

        const { code, stdout } = await runCli(["status", "--repo", repoPath]);

        expect(code).toBe(0);
        expect(stdout).toContain("#5");
        expect(stdout).toContain("issue-5-demo");
        expect(stdout).toContain("succeeded");
        expect(stdout).toContain("1");
    });

    it("shows the detail view for an issue", async () => {
        const repoPath = await makeRepo();
        await saveRunRecord(
            record(repoPath, {
                sync: {
                    pushed: true,
                    branchUrl: "https://github.com/acme/repo/tree/afk/issue-5",
                    pushError: null,
                    commented: true,
                    commentError: null,
                    prUrl: "https://github.com/acme/repo/pull/9",
                    prCreated: true,
                    prReused: false,
                    prError: null,
                },
            }),
        );

        const { code, stdout } = await runCli([
            "status",
            "--repo",
            repoPath,
            "--issue",
            "5",
        ]);

        expect(code).toBe(0);
        expect(stdout).toContain("Branch: afk/issue-5-demo");
        expect(stdout).toContain("Attempts: 1");
        expect(stdout).toContain("GitHub sync: pushed, commented");
        expect(stdout).toContain(
            "Pull request: https://github.com/acme/repo/pull/9",
        );
    });
});

describe("afk logs", () => {
    it("re-reads the persisted log after the Sandbox is gone", async () => {
        const repoPath = await makeRepo();
        const saved = record(repoPath);
        await saveRunRecord(saved);
        await writeFile(saved.logPath, "agent output\nreport: success\n");

        const { code, stdout } = await runCli([
            "logs",
            "--repo",
            repoPath,
            "--issue",
            "5",
        ]);

        expect(code).toBe(0);
        expect(stdout).toContain("agent output");
        expect(stdout).toContain("report: success");
        expect(stdout).toContain(`End of logs for Issue #5 in ${repoPath}.`);
    });
});

describe("afk help", () => {
    it("lists the status command and the background flag", async () => {
        const overview = await runCli([]);
        expect(overview.stdout).toContain("status");

        const runHelp = await runCli(["help", "run"]);
        expect(runHelp.stdout).toContain("--background");
    });
});

describe("afk run --background", () => {
    async function waitForChild(
        repoPath: string,
        taskId: string,
    ): Promise<void> {
        for (let i = 0; i < 400; i += 1) {
            if ((await readTaskLock(repoPath, taskId)) === null) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error("background child did not release the lock");
    }

    it("returns promptly without fetching the GitHub issue", async () => {
        const repoPath = await makeRepo();

        const { code, stdout } = await runCli([
            "run",
            "--background",
            "--repo",
            repoPath,
            "--issue",
            "5",
        ]);

        expect(code).toBe(0);
        expect(stdout).toContain("Started AFK run in the background.");
        expect(stdout).toContain("Task ID: issue-5");
        expect(stdout).toContain("Branch: afk/issue-5");
        expect(stdout).toContain("Log:");
        expect(stdout).toContain(
            `Watch: afk logs --repo ${repoPath} --issue 5`,
        );
        expect(stdout).toContain(
            `Check: afk status --repo ${repoPath} --issue 5`,
        );
        expect(stdout).toContain(`Stop: afk stop --repo ${repoPath} --issue 5`);

        const started = await findRunForIssue(repoPath, 5);
        expect(started?.taskId).toBe("issue-5");

        await waitForChild(repoPath, "issue-5");

        const finished = await findRunForIssue(repoPath, 5);
        expect(finished?.state).toBe("failed");
        expect(finished?.error).not.toBeNull();
    }, 30_000);

    it("starts a fresh log and record for a re-run", async () => {
        const repoPath = await makeRepo();
        const args = [
            "run",
            "--background",
            "--repo",
            repoPath,
            "--issue",
            "5",
        ];

        await runCli(args);
        await waitForChild(repoPath, "issue-5");
        const first = await findRunForIssue(repoPath, 5);
        await writeFile(runLogPath(repoPath, "issue-5"), "STALE LOG LINE\n", {
            flag: "a",
        });

        const { code } = await runCli(args);
        expect(code).toBe(0);
        await waitForChild(repoPath, "issue-5");

        const second = await findRunForIssue(repoPath, 5);
        expect(second?.startedAt).not.toBe(first?.startedAt);
        const log = await readFile(runLogPath(repoPath, "issue-5"), "utf8");
        expect(log).not.toContain("STALE LOG LINE");
    }, 60_000);
});
