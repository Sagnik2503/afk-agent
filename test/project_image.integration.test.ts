import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcess } from "../src/process.js";
import {
    createSandboxCommandRunner,
    prepareSandboxImage,
    projectImageName,
} from "../src/agent/sandbox.js";
import { runValidation } from "../src/harness/validation.js";

const dockerReady = await ChildProcess("docker", ["info"])
    .then((result) => result.exitCode === 0)
    .catch(() => false);

const validateCommand =
    "test -f /home/node/afk-project-marker && echo validation-ran-in-sandbox";

describe.skipIf(!dockerReady)("Project image Validation integration", () => {
    const taskId = `project-image-${process.pid}-${Date.now()}`;
    const containerName = `afk-${taskId}`;
    let repo = "";
    let dockerfile = "";
    let projectImage = "";

    beforeAll(
        async () => {
            repo = await realpath(
                await mkdtemp(join(tmpdir(), "afk-project-image-")),
            );
            await mkdir(join(repo, ".afk"), { recursive: true });
            dockerfile = join(repo, ".afk", "Dockerfile");
            await writeFile(
                dockerfile,
                [
                    "FROM afk-agent:base",
                    "RUN echo project > /home/node/afk-project-marker",
                    "",
                ].join("\n"),
            );
            await writeFile(
                join(repo, ".afk", "config.json"),
                JSON.stringify({
                    validate: [validateCommand],
                    dockerfile: ".afk/Dockerfile",
                }),
            );
            await writeFile(join(repo, "README.md"), "A shell-only project.\n");

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
                { cwd: repo },
            );

            await prepareSandboxImage();
            projectImage = await projectImageName(dockerfile);
            await prepareSandboxImage({
                imageName: projectImage,
                dockerfilePath: dockerfile,
            });
            await mkdir(join(repo, ".afk", "worktrees", taskId), {
                recursive: true,
            });
        },
        10 * 60 * 1000,
    );

    afterAll(async () => {
        await ChildProcess("docker", ["rm", "-f", containerName]);
        if (projectImage) {
            await ChildProcess("docker", ["rmi", "-f", projectImage]);
        }
        if (repo) {
            await rm(repo, { recursive: true, force: true });
        }
    }, 120_000);

    it(
        "runs a non-node repository's Validation inside the Project image Sandbox",
        async () => {
            const runner = createSandboxCommandRunner({
                repoPath: repo,
                taskId,
                issueId: "issue-1",
                imageName: projectImage,
                dockerfilePath: dockerfile,
                build: false,
            });

            const result = await runValidation(runner.runCommand, [
                validateCommand,
            ]);

            expect(result.passed, result.stderr).toBe(true);
            expect(result.failedCommand).toBeNull();
            expect(result.stdout).toContain("validation-ran-in-sandbox");
        },
        5 * 60 * 1000,
    );
});
