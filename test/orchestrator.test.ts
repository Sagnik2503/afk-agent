import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import type { ProcessResult } from "../src/process.js";
import type { HarnessReport } from "../src/harness/report.js";
import { setupWorktree } from "../src/worktree/manager.js";
import { createDockerAgent } from "../src/agent/docker_runner.js";
import { runWithRetries } from "../src/harness/retry.js";
import { runTests } from "../src/harness/validation.js";
import { getChangedFiles } from "../src/harness/change.js";
import { runTask } from "../src/harness/orchestrator.js";

vi.mock("../src/worktree/manager.js", () => ({
    setupWorktree: vi.fn(),
}));

vi.mock("../src/agent/docker_runner.js", () => ({
    createDockerAgent: vi.fn(),
}));

vi.mock("../src/harness/retry.js", () => ({
    runWithRetries: vi.fn(),
}));

const mockedSetupWorktree = vi.mocked(setupWorktree);
const mockedCreateDockerAgent = vi.mocked(createDockerAgent);
const mockedRunWithRetries = vi.mocked(runWithRetries);

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

const agent = {
    prepareImage: vi.fn(async () => {}),
    run: vi.fn(
        async (_prompt: string): Promise<ProcessResult> => processResult()
    ),
};

const input = {
    repoPath: "/repo",
    taskId: "task-1",
    issueId: "issue-1",
    prompt: "Fix the failing tests.",
};

const branchName = "afk/task-1";
const worktreePath = "/repo/.afk/worktrees/task-1";

beforeEach(() => {
    mockedSetupWorktree.mockReset();
    mockedCreateDockerAgent.mockReset();
    mockedRunWithRetries.mockReset();
    agent.prepareImage.mockReset();
    agent.run.mockReset();

    agent.prepareImage.mockResolvedValue(undefined);
    agent.run.mockResolvedValue(processResult());
    mockedCreateDockerAgent.mockReturnValue(agent);
    mockedSetupWorktree.mockResolvedValue({ branchName, worktreePath });
    mockedRunWithRetries.mockResolvedValue({ reports: [], error: null });
});

describe("runTask", () => {
    it("rejects an empty prompt before touching the repo or Docker", async () => {
        await expect(
            runTask({ ...input, prompt: "   " })
        ).rejects.toThrow("Prompt is required");

        expect(mockedCreateDockerAgent).not.toHaveBeenCalled();
        expect(mockedSetupWorktree).not.toHaveBeenCalled();
        expect(agent.prepareImage).not.toHaveBeenCalled();
        expect(mockedRunWithRetries).not.toHaveBeenCalled();
    });

    it("creates the agent, worktree, and image before running retries", async () => {
        await runTask(input);

        const createOrder = mockedCreateDockerAgent.mock.invocationCallOrder[0]!;
        const setupOrder = mockedSetupWorktree.mock.invocationCallOrder[0]!;
        const imageOrder = agent.prepareImage.mock.invocationCallOrder[0]!;
        const retryOrder = mockedRunWithRetries.mock.invocationCallOrder[0]!;

        expect(createOrder).toBeLessThan(setupOrder);
        expect(setupOrder).toBeLessThan(imageOrder);
        expect(imageOrder).toBeLessThan(retryOrder);
    });

    it("passes the resolved repo path to the agent and worktree manager", async () => {
        await runTask({ ...input, repoPath: "relative/repo" });

        const resolved = path.resolve("relative/repo");

        expect(mockedCreateDockerAgent).toHaveBeenCalledWith({
            repoPath: resolved,
            taskId: input.taskId,
            issueId: input.issueId,
        });
        expect(mockedSetupWorktree).toHaveBeenCalledWith(
            resolved,
            input.taskId
        );
    });

    it("passes optional model, image, and timeout overrides through", async () => {
        await runTask({
            ...input,
            model: "anthropic/claude",
            imageName: "custom:1",
            timeout: 1_000,
        });

        expect(mockedCreateDockerAgent).toHaveBeenCalledWith({
            repoPath: "/repo",
            taskId: input.taskId,
            issueId: input.issueId,
            model: "anthropic/claude",
            imageName: "custom:1",
            timeout: 1_000,
        });
    });

    it("runs retries with the task, worktree, prompt, and host validators", async () => {
        await runTask(input);

        expect(mockedRunWithRetries).toHaveBeenCalledWith(
            {
                taskId: input.taskId,
                worktreePath,
                prompt: input.prompt,
            },
            expect.objectContaining({})
        );

        const deps = mockedRunWithRetries.mock.calls[0]?.[1];

        expect(deps?.runTests).toBe(runTests);
        expect(deps?.getChangedFiles).toBe(getChangedFiles);
    });

    it("binds the agent to its own worktree, ignoring the retry path", async () => {
        const expected = processResult({ stdout: "done" });
        agent.run.mockResolvedValue(expected);

        await runTask(input);

        const deps = mockedRunWithRetries.mock.calls[0]?.[1];
        const result = await deps?.runAgent("/ignored/worktree", input.prompt);

        expect(result).toEqual(expected);
        expect(agent.run).toHaveBeenCalledWith(input.prompt);
    });

    it("generates a unique task id for each execution when none is provided", async () => {
        const withoutTaskId = {
            repoPath: "/repo",
            issueId: "issue-1",
            prompt: "Fix the failing tests.",
        };

        await runTask(withoutTaskId);
        await runTask(withoutTaskId);

        const firstTaskId = mockedSetupWorktree.mock.calls[0]?.[1];
        const secondTaskId = mockedSetupWorktree.mock.calls[1]?.[1];
        const uuidPattern =
            /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

        expect(firstTaskId).toMatch(uuidPattern);
        expect(secondTaskId).toMatch(uuidPattern);
        expect(firstTaskId).not.toBe(secondTaskId);
        expect(mockedCreateDockerAgent.mock.calls[0]?.[0].taskId).toBe(
            firstTaskId
        );
        expect(mockedCreateDockerAgent.mock.calls[0]?.[0].issueId).toBe(
            withoutTaskId.issueId
        );
        expect(mockedRunWithRetries.mock.calls[0]?.[0].taskId).toBe(
            firstTaskId
        );
    });

    it("returns the branch, worktree, reports, and error", async () => {
        const reports = [] as HarnessReport[];
        mockedRunWithRetries.mockResolvedValue({
            reports,
            error: "tests exploded",
        });

        const result = await runTask(input);

        expect(result).toEqual({
            branchName,
            worktreePath,
            reports,
            error: "tests exploded",
        });
    });

    it("throws when the worktree cannot be created and skips the image and retries", async () => {
        mockedSetupWorktree.mockRejectedValue(
            new Error("Branch already exists: afk/task-1")
        );

        await expect(runTask(input)).rejects.toThrow("Branch already exists");

        expect(agent.prepareImage).not.toHaveBeenCalled();
        expect(mockedRunWithRetries).not.toHaveBeenCalled();
    });

    it("throws when the image build fails and skips retries", async () => {
        agent.prepareImage.mockRejectedValue(
            new Error("Docker image build failed: no base image")
        );

        await expect(runTask(input)).rejects.toThrow(
            "Docker image build failed"
        );

        expect(mockedRunWithRetries).not.toHaveBeenCalled();
    });
});
