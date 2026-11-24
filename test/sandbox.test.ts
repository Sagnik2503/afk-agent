import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult } from "../src/process.js";
import { ChildProcess } from "../src/process.js";
import {
    createSandboxCommandRunner,
    DEFAULT_CPUS,
    DEFAULT_IMAGE,
    DEFAULT_MEMORY,
    DEFAULT_PIDS_LIMIT,
    projectImageName,
} from "../src/agent/sandbox.js";

vi.mock("../src/process.js", () => ({
    ChildProcess: vi.fn(),
}));

const mockedChildProcess = vi.mocked(ChildProcess);

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
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

const options = {
    repoPath: "/repo",
    taskId: "task-1",
    issueId: "issue-9",
};

beforeEach(() => {
    mockedChildProcess.mockReset();
    mockedChildProcess.mockResolvedValue(result());
});

describe("createSandboxCommandRunner", () => {
    it("runs an arbitrary command with the Sandbox image and Worktree mounts", async () => {
        const runner = createSandboxCommandRunner({ ...options, env: {} });

        await runner.runCommand(["npm", "test"]);

        const worktree = "/repo/.afk/worktrees/task-1";

        expect(mockedChildProcess).toHaveBeenNthCalledWith(
            2,
            "docker",
            [
                "run",
                "--name",
                "afk-task-1",
                "--memory",
                DEFAULT_MEMORY,
                "--cpus",
                DEFAULT_CPUS,
                "--pids-limit",
                DEFAULT_PIDS_LIMIT,
                "--user",
                "node",
                "-w",
                worktree,
                "-v",
                `${worktree}:${worktree}`,
                "-v",
                "/repo/.git:/repo/.git",
                "-e",
                "AFK_TASK_ID=task-1",
                "-e",
                "AFK_ISSUE_ID=issue-9",
                "-e",
                "GIT_AUTHOR_NAME=afk-agent",
                "-e",
                "GIT_AUTHOR_EMAIL=afk-agent@localhost",
                "-e",
                "GIT_COMMITTER_NAME=afk-agent",
                "-e",
                "GIT_COMMITTER_EMAIL=afk-agent@localhost",
                "-e",
                "GIT_CONFIG_COUNT=1",
                "-e",
                "GIT_CONFIG_KEY_0=safe.directory",
                "-e",
                "GIT_CONFIG_VALUE_0=*",
                DEFAULT_IMAGE,
                "npm",
                "test",
            ],
            { timeout: 600_000, env: {} },
        );
    });

    it("captures the exit code, stdout, and stderr", async () => {
        const expected = result({
            exitCode: 1,
            stdout: "out",
            stderr: "err",
        });
        mockedChildProcess
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(expected)
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(result());

        const runner = createSandboxCommandRunner(options);

        await expect(runner.runCommand(["npm", "test"])).resolves.toEqual(
            expected,
        );
    });

    it("honors the configured timeout for the command", async () => {
        const runner = createSandboxCommandRunner({
            ...options,
            timeout: 1_000,
            env: {},
        });

        await runner.runCommand(["npm", "test"]);

        expect(mockedChildProcess.mock.calls[1]?.[2]).toEqual({
            timeout: 1_000,
            env: {},
        });
    });

    it("reports a timed-out command as timed out", async () => {
        const timedOut = result({ exitCode: null, timedOut: true });
        mockedChildProcess
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(timedOut);

        const runner = createSandboxCommandRunner(options);

        await expect(runner.runCommand(["npm", "test"])).resolves.toEqual(
            timedOut,
        );
    });

    it("removes the container before and after the command", async () => {
        const runner = createSandboxCommandRunner(options);

        await runner.runCommand(["npm", "test"]);

        expect(mockedChildProcess).toHaveBeenNthCalledWith(
            1,
            "docker",
            ["rm", "-f", "afk-task-1"],
            { timeout: 10_000 },
        );
        expect(mockedChildProcess).toHaveBeenNthCalledWith(
            3,
            "docker",
            ["rm", "-f", "afk-task-1"],
            { timeout: 10_000 },
        );
    });

    it("uses the configured image for the command", async () => {
        const runner = createSandboxCommandRunner({
            ...options,
            imageName: "project:1",
            env: {},
        });

        await runner.runCommand(["node", "--version"]);

        const runArgs = mockedChildProcess.mock.calls[1]?.[1] ?? [];

        expect(runArgs).toContain("project:1");
        expect(runArgs).not.toContain(DEFAULT_IMAGE);
    });

    it("detects a resource limit kill for the command", async () => {
        mockedChildProcess
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(result({ exitCode: 137 }))
            .mockResolvedValueOnce(
                result({
                    stdout: JSON.stringify({ OOMKilled: true, ExitCode: 137 }),
                }),
            )
            .mockResolvedValueOnce(result());

        const runner = createSandboxCommandRunner(options);
        const runResult = await runner.runCommand(["npm", "test"]);

        expect(runResult.resourceLimit).toEqual({
            kind: "memory",
            value: "2g",
            message:
                "sandbox exceeded its memory limit (2g); raise --memory to allow more",
        });
    });

    it("rejects an invalid task id before running Docker", () => {
        expect(() =>
            createSandboxCommandRunner({ ...options, taskId: "../escape" }),
        ).toThrow("Invalid task ID");
        expect(mockedChildProcess).not.toHaveBeenCalled();
    });

    it("honors a per-command timeout override", async () => {
        const runner = createSandboxCommandRunner({
            ...options,
            timeout: 600_000,
            env: {},
        });

        await runner.runCommand(["npm", "test"], { timeout: 120_000 });

        expect(mockedChildProcess.mock.calls[1]?.[2]).toEqual({
            timeout: 120_000,
            env: {},
        });
    });
});

describe("projectImageName", () => {
    const dirs: string[] = [];

    async function makeDockerfile(content: string): Promise<string> {
        const dir = await mkdtemp(join(tmpdir(), "afk-project-"));
        dirs.push(dir);
        const file = join(dir, "Dockerfile");
        await writeFile(file, content);
        return file;
    }

    afterEach(async () => {
        await Promise.all(
            dirs
                .splice(0)
                .map((dir) => rm(dir, { recursive: true, force: true })),
        );
    });

    it("tags the Project image with a hash of the Dockerfile content", async () => {
        const file = await makeDockerfile("FROM afk-agent:base\n");

        await expect(projectImageName(file)).resolves.toBe(
            "afk-agent:project-f9e16c444785",
        );
    });

    it("reuses the tag for unchanged content and rebuilds when it changes", async () => {
        const file = await makeDockerfile("FROM afk-agent:base\n");
        const first = await projectImageName(file);

        await writeFile(file, "FROM afk-agent:base\n");
        await expect(projectImageName(file)).resolves.toBe(first);

        await writeFile(file, "FROM afk-agent:base\nRUN echo hi\n");
        await expect(projectImageName(file)).resolves.toBe(
            "afk-agent:project-19c058f3dfa0",
        );
    });
});
