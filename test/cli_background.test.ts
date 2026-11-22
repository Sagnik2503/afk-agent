import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";
import { afterEach, describe, expect, it } from "vitest";
import {
    runLogPath,
    saveRunRecord,
    type RunRecord,
} from "../src/harness/run_record.js";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;
const repos: string[] = [];

async function makeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "afk-agent-cli-"));
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
        attempt: 1,
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
