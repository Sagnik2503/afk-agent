import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
    access,
    copyFile,
    mkdtemp,
    realpath,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildProcess } from "../src/process.js";
import { DEFAULT_MODEL } from "../src/agent/docker_runner.js";
import { runTask } from "../src/harness/orchestrator.js";
import { listWorktrees } from "../src/worktree/manager.js";

const dockerReady = await ChildProcess("docker", ["info"])
    .then((result) => result.exitCode === 0)
    .catch(() => false);

const failOnceTest = `
const fs = require("node:fs");

if (fs.existsSync(".ran")) {
    process.exit(0);
}

fs.writeFileSync(".ran", "");
console.error("first run fails");
process.exit(1);
`;

describe.skipIf(!dockerReady)("runTask integration", () => {
    const sourceDockerfile = fileURLToPath(
        new URL("../Dockerfile", import.meta.url)
    );
    const sourceDockerignore = fileURLToPath(
        new URL("../.dockerignore", import.meta.url)
    );
    const runTimeout = 10 * 60 * 1000;
    const taskId = `orchestrator-${process.pid}-${Date.now()}`;
    const imageName = `afk-agent-orchestrator:${process.pid}`;
    const containerName = `afk-${taskId}`;
    const prompt = [
        "Inspect the repository and explain its directory structure.",
        "Do not modify any files.",
    ].join("\n");
    let repo = "";

    beforeAll(async () => {
        repo = await realpath(
            await mkdtemp(join(tmpdir(), "afk-agent-orchestrator-"))
        );

        await copyFile(sourceDockerfile, join(repo, "Dockerfile"));
        await copyFile(sourceDockerignore, join(repo, ".dockerignore"));
        await writeFile(
            join(repo, "package.json"),
            JSON.stringify({
                name: "orchestrator-fixture",
                scripts: { test: "node test.js" },
            })
        );
        await writeFile(join(repo, "test.js"), failOnceTest);

        await ChildProcess("git", ["init", "-q"], { cwd: repo });
        await ChildProcess("git", ["add", "."], { cwd: repo });
        await ChildProcess(
            "git",
            [
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-q",
                "-m",
                "fixture",
            ],
            { cwd: repo }
        );
    }, 60_000);

    afterAll(async () => {
        await ChildProcess("docker", ["rm", "-f", containerName]);
        await ChildProcess("docker", ["rmi", "-f", imageName]);
        if (repo) {
            await rm(repo, { recursive: true, force: true });
        }
    }, 120_000);

    it(
        "runs the full task flow and leaves the branch and worktree",
        async () => {
            const result = await runTask({
                repoPath: repo,
                taskId,
                issueId: "issue-1",
                prompt,
                imageName,
                model: DEFAULT_MODEL,
                timeout: runTimeout,
            });

            expect(result.error).toBeNull();
            expect(result.branchName).toBe(`afk/${taskId}`);
            expect(result.worktreePath).toBe(
                join(repo, ".afk", "worktrees", taskId)
            );

            expect(result.reports).toHaveLength(2);
            expect(result.reports[0]?.testsPassed).toBe(false);
            expect(result.reports[1]?.testsPassed).toBe(true);
            expect(result.reports[1]?.executionStatus).toBe("completed");
            expect(result.reports[1]?.success).toBe(true);
            expect(result.reports[1]?.changedFiles).toContain(".ran");

            await expect(access(result.worktreePath)).resolves.toBeUndefined();

            const worktrees = await listWorktrees(repo);
            expect(worktrees).toContain(await realpath(result.worktreePath));

            const branches = await ChildProcess(
                "git",
                ["branch", "--list", result.branchName],
                { cwd: repo }
            );
            expect(branches.stdout).toContain(result.branchName);
        },
        25 * 60 * 1000
    );
});
