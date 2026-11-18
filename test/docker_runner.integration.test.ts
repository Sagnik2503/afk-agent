import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, realpath, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcess } from "../src/process.js";
import {
    createDockerAgent,
    DEFAULT_MODEL,
    watchSandboxLogs,
} from "../src/agent/docker_runner.js";
import { setupWorktree } from "../src/worktree/manager.js";

const dockerReady = await ChildProcess("docker", ["info"])
    .then((result) => result.exitCode === 0)
    .catch(() => false);

describe.skipIf(!dockerReady)("Docker agent integration", () => {
    const runTimeout = 5 * 60 * 1000;
    const taskId = `integration-${process.pid}-${Date.now()}`;
    const imageName = `afk-agent-integration:${process.pid}`;
    const containerName = `afk-${taskId}`;
    let repo = "";

    beforeAll(async () => {
        repo = await realpath(
            await mkdtemp(join(tmpdir(), "afk-agent-docker-")),
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
                    "-e",
                    "GIT_CONFIG_COUNT=1",
                    "-e",
                    "GIT_CONFIG_KEY_0=safe.directory",
                    "-e",
                    "GIT_CONFIG_VALUE_0=*",
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
                { timeout: 60_000 },
            );

            expect(git.exitCode, `Git failed: ${git.stderr}`).toBe(0);
            expect(git.stdout.trim()).toBe(worktreePath);

            const started = Date.now();
            const result = await agent.run(
                [
                    "Inspect the repository and explain its directory structure.",
                    "Do not modify any files.",
                ].join("\n"),
            );
            const elapsed = Date.now() - started;

            expect(result.timedOut).toBe(false);
            expect(result.exitCode).toBe(0);
            expect(elapsed).toBeLessThan(runTimeout);
            expect(typeof result.stdout).toBe("string");
            expect(typeof result.stderr).toBe("string");
            expect(result.stdout.length + result.stderr.length).toBeGreaterThan(
                0,
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
        15 * 60 * 1000,
    );

    describe("sandbox logs", () => {
        beforeAll(async () => {
            const agent = createDockerAgent({
                repoPath: repo,
                taskId,
                issueId: "issue-1",
                imageName,
            });

            await agent.prepareImage();
        }, 120_000);

        function capture(stream: NodeJS.WriteStream): {
            text: () => string;
            restore: () => void;
        } {
            const spy = vi.spyOn(stream, "write");

            return {
                text: () =>
                    spy.mock.calls.map((call) => String(call[0])).join(""),
                restore: () => spy.mockRestore(),
            };
        }

        it("streams Sandbox logs and ends when the container disappears", async () => {
            const issueNumber = 900_000 + (process.pid % 100_000);
            const containerName = `afk-issue-${issueNumber}-${Date.now()}`;
            const worktreePath = join(repo, ".afk", "worktrees", taskId);
            const stdout = capture(process.stdout);
            const stderr = capture(process.stderr);
            let watching: Promise<void> | undefined;

            try {
                const started = await ChildProcess("docker", [
                    "run",
                    "-d",
                    "--name",
                    containerName,
                    "-v",
                    `${worktreePath}:${worktreePath}`,
                    imageName,
                    "node",
                    "-e",
                    [
                        "setInterval(() => {",
                        "console.log('sandbox-stdout-marker');",
                        "console.error('sandbox-stderr-marker');",
                        "}, 200);",
                    ].join(" "),
                ]);

                expect(started.exitCode, started.stderr).toBe(0);

                watching = watchSandboxLogs({
                    repoPath: repo,
                    issueNumber,
                });

                await vi.waitFor(
                    () => {
                        expect(stdout.text()).toContain(
                            "sandbox-stdout-marker",
                        );
                        expect(stderr.text()).toContain(
                            "sandbox-stderr-marker",
                        );
                    },
                    { timeout: 15_000, interval: 100 },
                );

                await ChildProcess("docker", ["rm", "-f", containerName]);

                await expect(watching).resolves.toBeUndefined();
            } finally {
                await ChildProcess("docker", ["rm", "-f", containerName]);
                stdout.restore();
                stderr.restore();
            }
        }, 60_000);

        it("refuses a Sandbox mounted from a different repository", async () => {
            const issueNumber = 900_001 + (process.pid % 100_000);
            const containerName = `afk-issue-${issueNumber}-${Date.now()}`;
            const otherRepo = await mkdtemp(join(tmpdir(), "afk-agent-other-"));
            const otherWorktree = join(
                otherRepo,
                ".afk",
                "worktrees",
                "issue-other",
            );

            await mkdir(otherWorktree, { recursive: true });

            try {
                const started = await ChildProcess("docker", [
                    "run",
                    "-d",
                    "--name",
                    containerName,
                    "-v",
                    `${otherWorktree}:${otherWorktree}`,
                    imageName,
                    "node",
                    "-e",
                    "setInterval(() => {}, 1000)",
                ]);

                expect(started.exitCode, started.stderr).toBe(0);

                await expect(
                    watchSandboxLogs({
                        repoPath: repo,
                        issueNumber,
                    }),
                ).rejects.toThrow(
                    `No running agent for issue ${issueNumber} in ${repo}`,
                );
            } finally {
                await ChildProcess("docker", ["rm", "-f", containerName]);
                await rm(otherRepo, { recursive: true, force: true });
            }
        }, 60_000);
    });
});
