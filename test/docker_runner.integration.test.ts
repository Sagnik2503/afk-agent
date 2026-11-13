import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, copyFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildProcess } from "../src/process.js";
import {
    createDockerAgent,
    DEFAULT_MODEL,
} from "../src/agent/docker_runner.js";
import { setupWorktree } from "../src/worktree/manager.js";

const dockerReady = await ChildProcess("docker", ["info"])
    .then((result) => result.exitCode === 0)
    .catch(() => false);

describe.skipIf(!dockerReady)("Docker agent integration", () => {
    const sourceDockerfile = fileURLToPath(
        new URL("../Dockerfile", import.meta.url)
    );
    const sourceDockerignore = fileURLToPath(
        new URL("../.dockerignore", import.meta.url)
    );
    const runTimeout = 5 * 60 * 1000;
    const taskId = `integration-${process.pid}-${Date.now()}`;
    const imageName = `afk-agent-integration:${process.pid}`;
    const containerName = `afk-${taskId}`;
    let repo = "";

    beforeAll(async () => {
        repo = await realpath(
            await mkdtemp(join(tmpdir(), "afk-agent-docker-"))
        );

        await ChildProcess("git", ["init", "-q"], { cwd: repo });
        await copyFile(sourceDockerfile, join(repo, "Dockerfile"));
        await copyFile(sourceDockerignore, join(repo, ".dockerignore"));
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
            { cwd: repo }
        );
        await setupWorktree(repo, taskId);
    }, 60_000);

    afterAll(async () => {
        await ChildProcess("docker", ["rm", "-f", containerName]);
        await ChildProcess("docker", ["rmi", "-f", imageName]);
        if (repo) {
            await rm(repo, { recursive: true, force: true });
        }
    }, 120_000);

    it(
        "builds the image, checks git, runs opencode, and removes the container",
        async () => {
            const agent = createDockerAgent({
                repoPath: repo,
                taskId,
                issueId: "issue-1",
                imageName,
                model: DEFAULT_MODEL,
                timeout: runTimeout,
            });

            await agent.prepareImage();

            const worktreePath = join(repo, ".afk", "worktrees", taskId);
            const gitDir = join(repo, ".git");
            const git = await ChildProcess(
                "docker",
                [
                    "run",
                    "--rm",
                    "--user",
                    "node",
                    "-w",
                    worktreePath,
                    "-v",
                    `${worktreePath}:${worktreePath}`,
                    "-v",
                    `${gitDir}:${gitDir}`,
                    imageName,
                    "git",
                    "rev-parse",
                    "--show-toplevel",
                ],
                { timeout: 60_000 }
            );

            expect(git.exitCode).toBe(0);
            expect(git.stdout.trim()).toBe(worktreePath);

            const started = Date.now();
            const result = await agent.run(
                [
                    "Inspect the repository and explain its directory structure.",
                    "Do not modify any files.",
                ].join("\n")
            );
            const elapsed = Date.now() - started;

            expect(result.timedOut).toBe(false);
            expect(result.exitCode).toBe(0);
            expect(elapsed).toBeLessThan(runTimeout);
            expect(typeof result.stdout).toBe("string");
            expect(typeof result.stderr).toBe("string");
            expect(result.stdout.length + result.stderr.length).toBeGreaterThan(
                0
            );

            const remaining = await ChildProcess("docker", [
                "ps",
                "-a",
                "--filter",
                `name=^${containerName}$`,
                "--format",
                "{{.Names}}",
            ]);

            expect(remaining.stdout.trim()).toBe("");
        },
        15 * 60 * 1000
    );
});
