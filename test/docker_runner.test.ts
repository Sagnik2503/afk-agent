import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProcessResult } from "../src/process.js";
import { ChildProcess } from "../src/process.js";
import { createDockerAgent } from "../src/agent/docker_runner.js";

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

describe("createDockerAgent", () => {
    it("rejects an invalid task id before running Docker", () => {
        expect(() =>
            createDockerAgent({ ...options, taskId: "../escape" }),
        ).toThrow("Invalid task ID");
        expect(mockedChildProcess).not.toHaveBeenCalled();
    });

    it("rejects an invalid issue id before running Docker", () => {
        expect(() =>
            createDockerAgent({ ...options, issueId: "issue\n" }),
        ).toThrow("Invalid issue ID");
        expect(mockedChildProcess).not.toHaveBeenCalled();
    });

    it("skips the build when the image already exists", async () => {
        const agent = createDockerAgent(options);

        await agent.prepareImage();

        expect(mockedChildProcess).toHaveBeenCalledTimes(1);
        expect(mockedChildProcess).toHaveBeenCalledWith(
            "docker",
            ["image", "inspect", "afk-agent:latest"],
            expect.anything(),
        );
    });

    it("builds the image when it is missing", async () => {
        mockedChildProcess
            .mockResolvedValueOnce(
                result({ exitCode: 1, stderr: "No such image" }),
            )
            .mockResolvedValueOnce(result());

        const agent = createDockerAgent(options);

        await agent.prepareImage();

        expect(mockedChildProcess).toHaveBeenNthCalledWith(
            2,
            "docker",
            [
                "build",
                "-t",
                "afk-agent:latest",
                "-f",
                "/repo/Dockerfile",
                "/repo",
            ],
            expect.anything(),
        );
    });

    it("throws with the build stderr when the build fails", async () => {
        mockedChildProcess
            .mockResolvedValueOnce(
                result({ exitCode: 1, stderr: "No such image" }),
            )
            .mockResolvedValueOnce(
                result({ exitCode: 1, stderr: "no base image" }),
            );

        const agent = createDockerAgent(options);

        await expect(agent.prepareImage()).rejects.toThrow("no base image");
    });

    it("does not build when the image inspect times out", async () => {
        mockedChildProcess.mockResolvedValueOnce(
            result({ exitCode: null, timedOut: true, stderr: "hang" }),
        );

        const agent = createDockerAgent(options);

        await expect(agent.prepareImage()).rejects.toThrow("hang");
        expect(mockedChildProcess).toHaveBeenCalledTimes(1);
    });

    it("throws when inspection fails for a reason other than a missing image", async () => {
        mockedChildProcess.mockResolvedValueOnce(
            result({
                exitCode: 1,
                stderr: "Cannot connect to the Docker daemon",
            }),
        );

        const agent = createDockerAgent(options);

        await expect(agent.prepareImage()).rejects.toThrow(
            "Cannot connect to the Docker daemon",
        );
        expect(mockedChildProcess).toHaveBeenCalledTimes(1);
    });

    it("removes a stale container before running the agent", async () => {
        const agent = createDockerAgent(options);

        await agent.run("Fix it");

        expect(mockedChildProcess).toHaveBeenNthCalledWith(
            1,
            "docker",
            ["rm", "-f", "afk-task-1"],
            { timeout: 10_000 },
        );
    });

    it("ignores a missing stale container", async () => {
        mockedChildProcess.mockResolvedValueOnce(
            result({ exitCode: 1, stderr: "No such container" }),
        );

        const agent = createDockerAgent(options);

        await expect(agent.run("Fix it")).resolves.toBeDefined();
    });

    it("throws when a genuine stale-container removal fails", async () => {
        mockedChildProcess.mockResolvedValueOnce(
            result({ exitCode: 1, stderr: "permission denied" }),
        );

        const agent = createDockerAgent(options);

        await expect(agent.run("Fix it")).rejects.toThrow("permission denied");
    });

    it("removes the container again after a successful run", async () => {
        const agent = createDockerAgent(options);

        await agent.run("Fix it");

        expect(mockedChildProcess).toHaveBeenNthCalledWith(
            3,
            "docker",
            ["rm", "-f", "afk-task-1"],
            { timeout: 10_000 },
        );
    });

    it("throws the cleanup error when the run succeeds but cleanup fails", async () => {
        mockedChildProcess
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(
                result({ exitCode: 1, stderr: "permission denied" }),
            );

        const agent = createDockerAgent(options);

        await expect(agent.run("Fix it")).rejects.toThrow("permission denied");
    });

    it("keeps the run error when cleanup also fails", async () => {
        mockedChildProcess
            .mockResolvedValueOnce(result())
            .mockRejectedValueOnce(new Error("run exploded"))
            .mockRejectedValueOnce(new Error("cleanup exploded"));

        const agent = createDockerAgent(options);

        await expect(agent.run("Fix it")).rejects.toThrow("run exploded");
    });

    it("produces the run argv for the task", async () => {
        const agent = createDockerAgent(options);

        await agent.run("Fix it");

        const worktree = "/repo/.afk/worktrees/task-1";

        expect(mockedChildProcess).toHaveBeenNthCalledWith(
            2,
            "docker",
            [
                "run",
                "--name",
                "afk-task-1",
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
                "afk-agent:latest",
                "opencode",
                "run",
                "--auto",
                "--pure",
                "--model",
                "opencode/deepseek-v4.1-flash-free",
                "Fix it",
            ],
            { timeout: 600_000 },
        );
    });

    it("uses the override model, image, Dockerfile, and timeout", async () => {
        const agent = createDockerAgent({
            ...options,
            model: "anthropic/claude",
            imageName: "custom:1",
            dockerfilePath: "/repo/docker/Dockerfile",
            timeout: 1_000,
        });

        mockedChildProcess
            .mockResolvedValueOnce(
                result({ exitCode: 1, stderr: "No such image" }),
            )
            .mockResolvedValueOnce(result());

        await agent.prepareImage();
        await agent.run("Fix it");

        expect(mockedChildProcess).toHaveBeenNthCalledWith(
            2,
            "docker",
            [
                "build",
                "-t",
                "custom:1",
                "-f",
                "/repo/docker/Dockerfile",
                "/repo",
            ],
            { timeout: 1_000 },
        );

        const runArgs = mockedChildProcess.mock.calls[3]?.[1] ?? [];
        expect(runArgs).toContain("custom:1");
        expect(runArgs).toContain("anthropic/claude");
        expect(mockedChildProcess.mock.calls[3]?.[2]).toEqual({
            timeout: 1_000,
        });
    });

    it("returns the process result unchanged", async () => {
        const expected = result({
            stdout: "done",
            exitCode: 1,
            signal: "SIGTERM",
            timedOut: true,
            outputTruncated: true,
        });
        mockedChildProcess
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(expected);

        const agent = createDockerAgent(options);

        await expect(agent.run("Fix it")).resolves.toEqual(expected);
    });

    it("force-removes the container after a timeout", async () => {
        mockedChildProcess
            .mockResolvedValueOnce(result())
            .mockResolvedValueOnce(result({ timedOut: true }))
            .mockResolvedValueOnce(result());

        const agent = createDockerAgent(options);

        await agent.run("Fix it");

        expect(mockedChildProcess).toHaveBeenNthCalledWith(
            3,
            "docker",
            ["rm", "-f", "afk-task-1"],
            { timeout: 10_000 },
        );
    });
});
