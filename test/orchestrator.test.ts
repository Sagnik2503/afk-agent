import { describe, it, expect, vi, beforeEach } from "vitest";
import path from "node:path";
import type { ProcessResult } from "../src/process.js";
import type { HarnessReport } from "../src/harness/report.js";
import { removeWorktree, setupWorktree } from "../src/worktree/manager.js";
import { createDockerAgent } from "../src/agent/docker_runner.js";
import {
    createSandboxCommandRunner,
    prepareSandboxImage,
    projectImageName,
    type SandboxCommandRunner,
} from "../src/agent/sandbox.js";
import { runWithRetries } from "../src/harness/retry.js";
import { getChangedFiles } from "../src/harness/change.js";
import { loadConfig } from "../src/config.js";
import { runTask } from "../src/harness/orchestrator.js";
import {
    buildIssueComment,
    commitLeftovers,
    getBaseRef,
    getCommits,
    postIssueComment,
    pushBranch,
} from "../src/github/sync.js";
import {
    buildPullRequestBody,
    openPullRequest,
    resolveBaseBranch,
} from "../src/github/pull_request.js";
import type { GitHubIssue } from "../src/github/fetch_issues.js";

vi.mock("../src/worktree/manager.js", () => ({
    setupWorktree: vi.fn(),
    removeWorktree: vi.fn(),
}));

vi.mock("../src/github/sync.js", () => ({
    buildIssueComment: vi.fn(),
    commitLeftovers: vi.fn(),
    getBaseRef: vi.fn(),
    getCommits: vi.fn(),
    postIssueComment: vi.fn(),
    pushBranch: vi.fn(),
}));

vi.mock("../src/github/pull_request.js", () => ({
    buildPullRequestBody: vi.fn(),
    openPullRequest: vi.fn(),
    resolveBaseBranch: vi.fn(),
}));

vi.mock("../src/agent/docker_runner.js", () => ({
    createDockerAgent: vi.fn(),
}));

vi.mock("../src/agent/sandbox.js", () => ({
    createSandboxCommandRunner: vi.fn(),
    prepareSandboxImage: vi.fn(),
    projectImageName: vi.fn(),
}));

vi.mock("../src/config.js", () => ({
    loadConfig: vi.fn(),
}));

vi.mock("../src/harness/retry.js", () => ({
    runWithRetries: vi.fn(),
}));

const mockedSetupWorktree = vi.mocked(setupWorktree);
const mockedRemoveWorktree = vi.mocked(removeWorktree);
const mockedCreateDockerAgent = vi.mocked(createDockerAgent);
const mockedCreateSandboxCommandRunner = vi.mocked(createSandboxCommandRunner);
const mockedPrepareSandboxImage = vi.mocked(prepareSandboxImage);
const mockedProjectImageName = vi.mocked(projectImageName);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedRunWithRetries = vi.mocked(runWithRetries);
const mockedBuildIssueComment = vi.mocked(buildIssueComment);
const mockedCommitLeftovers = vi.mocked(commitLeftovers);
const mockedGetBaseRef = vi.mocked(getBaseRef);
const mockedGetCommits = vi.mocked(getCommits);
const mockedPostIssueComment = vi.mocked(postIssueComment);
const mockedPushBranch = vi.mocked(pushBranch);
const mockedBuildPullRequestBody = vi.mocked(buildPullRequestBody);
const mockedOpenPullRequest = vi.mocked(openPullRequest);
const mockedResolveBaseBranch = vi.mocked(resolveBaseBranch);

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
    run: vi.fn(async (): Promise<ProcessResult> => processResult()),
};

const sandboxRunner = {
    prepareImage: vi.fn(async () => {}),
    runCommand: vi.fn<SandboxCommandRunner["runCommand"]>(
        async (): Promise<ProcessResult> => processResult(),
    ),
};

const input = {
    repoPath: "/repo",
    taskId: "task-1",
    issueId: "issue-1",
    prompt: "Fix the failing tests.",
};

const issue: GitHubIssue = {
    number: 1,
    owner: "test-owner",
    repo: "test-repo",
    title: "Fix the failing tests",
    body: "",
    url: "https://github.com/test-owner/test-repo/issues/1",
};

const branchName = "afk/task-1";
const worktreePath = "/repo/.afk/worktrees/task-1";

function report(overrides: Partial<HarnessReport> = {}): HarnessReport {
    return {
        taskId: "task-1",
        executionStatus: "completed",
        success: true,
        testsPassed: true,
        agentTimedOut: false,
        changedFiles: ["src/slug.ts"],
        reasons: [],
        agent: {
            stdout: "",
            stderr: "",
            exitCode: 0,
            signal: null,
            outputTruncated: false,
        },
        tests: {
            passed: true,
            stdout: "",
            stderr: "",
            timedOut: false,
            commands: ["npm test"],
            failedCommand: null,
        },
        ...overrides,
    };
}

beforeEach(() => {
    mockedSetupWorktree.mockReset();
    mockedRemoveWorktree.mockReset();
    mockedCreateDockerAgent.mockReset();
    mockedCreateSandboxCommandRunner.mockReset();
    mockedPrepareSandboxImage.mockReset();
    mockedProjectImageName.mockReset();
    mockedLoadConfig.mockReset();
    mockedRunWithRetries.mockReset();
    agent.prepareImage.mockReset();
    agent.run.mockReset();
    sandboxRunner.prepareImage.mockReset();
    sandboxRunner.runCommand.mockReset();
    mockedBuildIssueComment.mockReset();
    mockedCommitLeftovers.mockReset();
    mockedGetBaseRef.mockReset();
    mockedGetCommits.mockReset();
    mockedPostIssueComment.mockReset();
    mockedPushBranch.mockReset();
    mockedBuildPullRequestBody.mockReset();
    mockedOpenPullRequest.mockReset();
    mockedResolveBaseBranch.mockReset();

    agent.prepareImage.mockResolvedValue(undefined);
    agent.run.mockResolvedValue(processResult());
    mockedCreateDockerAgent.mockReturnValue(agent);
    sandboxRunner.prepareImage.mockResolvedValue(undefined);
    sandboxRunner.runCommand.mockResolvedValue(processResult());
    mockedCreateSandboxCommandRunner.mockReturnValue(sandboxRunner);
    mockedPrepareSandboxImage.mockResolvedValue(undefined);
    mockedProjectImageName.mockResolvedValue("afk-agent:project-test");
    mockedLoadConfig.mockResolvedValue({
        validate: ["npm test"],
        dockerfile: null,
    });
    mockedSetupWorktree.mockResolvedValue({ branchName, worktreePath });
    mockedRemoveWorktree.mockResolvedValue(undefined);
    mockedRunWithRetries.mockResolvedValue({ reports: [], error: null });
    mockedBuildIssueComment.mockReturnValue("comment body");
    mockedCommitLeftovers.mockResolvedValue(false);
    mockedGetBaseRef.mockResolvedValue("base-sha");
    mockedGetCommits.mockResolvedValue([]);
    mockedPostIssueComment.mockResolvedValue({
        commented: true,
        error: null,
    });
    mockedPushBranch.mockResolvedValue({
        pushed: true,
        branchUrl: "https://github.com/test-owner/test-repo/tree/afk/task-1",
        reason: null,
        baseRef: "base-sha",
    });
    mockedBuildPullRequestBody.mockReturnValue("pull request body");
    mockedResolveBaseBranch.mockResolvedValue("main");
    mockedOpenPullRequest.mockResolvedValue({
        created: true,
        reused: false,
        url: "https://github.com/test-owner/test-repo/pull/7",
        error: null,
    });
});

describe("runTask", () => {
    it("rejects an empty prompt before touching the repo or Docker", async () => {
        await expect(runTask({ ...input, prompt: "   " })).rejects.toThrow(
            "Prompt is required",
        );

        expect(mockedCreateDockerAgent).not.toHaveBeenCalled();
        expect(mockedSetupWorktree).not.toHaveBeenCalled();
        expect(agent.prepareImage).not.toHaveBeenCalled();
        expect(mockedRunWithRetries).not.toHaveBeenCalled();
    });

    it("creates the agent, worktree, and image before running retries", async () => {
        await runTask(input);

        const createOrder =
            mockedCreateDockerAgent.mock.invocationCallOrder[0]!;
        const setupOrder = mockedSetupWorktree.mock.invocationCallOrder[0]!;
        const imageOrder = agent.prepareImage.mock.invocationCallOrder[0]!;
        const retryOrder = mockedRunWithRetries.mock.invocationCallOrder[0]!;

        expect(createOrder).toBeLessThan(setupOrder);
        expect(setupOrder).toBeLessThan(imageOrder);
        expect(imageOrder).toBeLessThan(retryOrder);
    });

    it("announces image preparation and sandbox execution phases", async () => {
        const phases: string[] = [];

        await runTask({
            ...input,
            onPhase: (phase) => {
                phases.push(phase);
            },
        });

        expect(phases).toEqual(["image", "sandbox"]);
    });

    it("awaits async phase callbacks before continuing", async () => {
        const events: string[] = [];
        agent.prepareImage.mockImplementation(async () => {
            events.push("prepare");
        });

        await runTask({
            ...input,
            onPhase: async (phase) => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                events.push(phase);
            },
        });

        expect(events).toEqual(["image", "prepare", "sandbox"]);
    });

    it("passes the attempt callback through to retries", async () => {
        const onAttempt = vi.fn();

        await runTask({ ...input, onAttempt });

        expect(mockedRunWithRetries).toHaveBeenCalledWith(
            expect.objectContaining({ onAttempt }),
            expect.anything(),
        );
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
            input.taskId,
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

    it("passes resource limit overrides through to the agent", async () => {
        await runTask({
            ...input,
            memory: "4g",
            cpus: "0.5",
            pidsLimit: "1024",
        });

        expect(mockedCreateDockerAgent).toHaveBeenCalledWith({
            repoPath: "/repo",
            taskId: input.taskId,
            issueId: input.issueId,
            memory: "4g",
            cpus: "0.5",
            pidsLimit: "1024",
        });
    });

    it("runs retries with the task, worktree, prompt, and sandbox validators", async () => {
        await runTask(input);

        expect(mockedRunWithRetries).toHaveBeenCalledWith(
            {
                taskId: input.taskId,
                worktreePath,
                prompt: input.prompt,
            },
            expect.objectContaining({}),
        );

        expect(mockedCreateSandboxCommandRunner).toHaveBeenCalledWith(
            mockedCreateDockerAgent.mock.calls[0]?.[0],
        );

        const deps = mockedRunWithRetries.mock.calls[0]?.[1];

        expect(deps?.getChangedFiles).toBe(getChangedFiles);

        const result = await deps?.runValidation(worktreePath);

        expect(sandboxRunner.runCommand).toHaveBeenCalledWith(
            ["sh", "-c", "npm test"],
            { timeout: 120_000 },
        );
        expect(result?.passed).toBe(true);
    });

    it("validates with the commands from the repository config", async () => {
        mockedLoadConfig.mockResolvedValue({
            validate: ["make check"],
            dockerfile: null,
        });
        sandboxRunner.runCommand.mockResolvedValue(
            processResult({ stdout: "custom-check" }),
        );

        await runTask(input);

        expect(mockedLoadConfig).toHaveBeenCalledWith("/repo");
        const deps = mockedRunWithRetries.mock.calls[0]?.[1];
        const result = await deps?.runValidation(worktreePath);

        expect(sandboxRunner.runCommand).toHaveBeenCalledWith(
            ["sh", "-c", "make check"],
            { timeout: 120_000 },
        );
        expect(result?.passed).toBe(true);
        expect(result?.stdout).toContain("custom-check");
    });

    it("uses the Project image for the agent and Validation when the repo defines a Dockerfile", async () => {
        mockedLoadConfig.mockResolvedValue({
            validate: ["npm test"],
            dockerfile: "/repo/.afk/Dockerfile",
        });
        mockedProjectImageName.mockResolvedValue("afk-agent:project-abc123");

        await runTask(input);

        expect(mockedProjectImageName).toHaveBeenCalledWith(
            "/repo/.afk/Dockerfile",
        );
        expect(mockedCreateDockerAgent).toHaveBeenCalledWith(
            expect.objectContaining({
                imageName: "afk-agent:project-abc123",
                dockerfilePath: "/repo/.afk/Dockerfile",
            }),
        );
        expect(mockedCreateSandboxCommandRunner).toHaveBeenCalledWith(
            mockedCreateDockerAgent.mock.calls[0]?.[0],
        );
    });

    it("prepares the base image before the Project image", async () => {
        mockedLoadConfig.mockResolvedValue({
            validate: ["npm test"],
            dockerfile: "/repo/.afk/Dockerfile",
        });

        await runTask(input);

        expect(mockedPrepareSandboxImage).toHaveBeenCalledWith();
        const baseOrder =
            mockedPrepareSandboxImage.mock.invocationCallOrder[0]!;
        const imageOrder = agent.prepareImage.mock.invocationCallOrder[0]!;

        expect(baseOrder).toBeLessThan(imageOrder);
    });

    it("keeps the Sandbox image when the repo defines no Dockerfile", async () => {
        await runTask(input);

        expect(mockedCreateDockerAgent).toHaveBeenCalledWith({
            repoPath: "/repo",
            taskId: input.taskId,
            issueId: input.issueId,
        });
        expect(mockedPrepareSandboxImage).not.toHaveBeenCalled();
        expect(mockedProjectImageName).not.toHaveBeenCalled();
    });

    it("prefers an explicit image override over the repo Dockerfile", async () => {
        mockedLoadConfig.mockResolvedValue({
            validate: ["npm test"],
            dockerfile: "/repo/.afk/Dockerfile",
        });

        await runTask({ ...input, imageName: "custom:1" });

        expect(mockedProjectImageName).not.toHaveBeenCalled();
        expect(mockedPrepareSandboxImage).not.toHaveBeenCalled();
        expect(mockedCreateDockerAgent).toHaveBeenCalledWith(
            expect.objectContaining({ imageName: "custom:1" }),
        );
        expect(
            mockedCreateDockerAgent.mock.calls[0]?.[0].dockerfilePath,
        ).toBeUndefined();
    });

    it("refuses the run before Docker or the worktree when config is missing", async () => {
        mockedLoadConfig.mockRejectedValue(
            new Error('Missing /repo/.afk/config.json. Add a "validate" list.'),
        );

        await expect(runTask(input)).rejects.toThrow("validate");

        expect(mockedCreateDockerAgent).not.toHaveBeenCalled();
        expect(mockedSetupWorktree).not.toHaveBeenCalled();
        expect(mockedRunWithRetries).not.toHaveBeenCalled();
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
            firstTaskId,
        );
        expect(mockedCreateDockerAgent.mock.calls[0]?.[0].issueId).toBe(
            withoutTaskId.issueId,
        );
        expect(mockedRunWithRetries.mock.calls[0]?.[0].taskId).toBe(
            firstTaskId,
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
            sync: null,
            worktreeRemoved: true,
            cleanupError: null,
        });
    });

    it("commits leftovers and removes the worktree when the task fails", async () => {
        const reports = [report({ success: false })];
        mockedRunWithRetries.mockResolvedValue({
            reports,
            error: null,
        });

        const result = await runTask(input);

        expect(mockedCommitLeftovers).toHaveBeenCalledWith(
            { worktreePath, taskId: input.taskId, attempt: 1 },
            expect.anything(),
        );
        expect(mockedRemoveWorktree).toHaveBeenCalledWith(
            "/repo",
            worktreePath,
            { force: true },
        );
        expect(result.worktreeRemoved).toBe(true);
        expect(result.cleanupError).toBeNull();
    });

    it("keeps the worktree when the task succeeds", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report()],
            error: null,
        });

        const result = await runTask(input);

        expect(mockedRemoveWorktree).not.toHaveBeenCalled();
        expect(result.worktreeRemoved).toBe(false);
        expect(result.cleanupError).toBeNull();
    });

    it("removes the worktree after a failed push and keeps the branch", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report({ success: false })],
            error: null,
        });
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "wip" },
        ]);
        mockedPushBranch.mockResolvedValue({
            pushed: false,
            branchUrl: null,
            reason: "refusing to push secret-like files: .env",
            baseRef: "base-sha",
        });

        const result = await runTask({ ...input, issue });

        expect(result.sync?.pushed).toBe(false);
        expect(mockedRemoveWorktree).toHaveBeenCalledWith(
            "/repo",
            worktreePath,
            { force: true },
        );
        expect(result.worktreeRemoved).toBe(true);
    });

    it("does not remove the worktree when setup fails", async () => {
        mockedSetupWorktree.mockRejectedValue(new Error("setup exploded"));

        await expect(runTask(input)).rejects.toThrow("setup exploded");

        expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    });

    it("reports a cleanup failure without masking the task failure", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report({ success: false })],
            error: null,
        });
        mockedRemoveWorktree.mockRejectedValue(new Error("busy"));

        const result = await runTask(input);

        expect(result.error).toBeNull();
        expect(result.worktreeRemoved).toBe(false);
        expect(result.cleanupError).toBe("busy");
    });

    it("commits leftovers, pushes, and comments when an issue is provided", async () => {
        const reports = [report()];
        mockedRunWithRetries.mockResolvedValue({ reports, error: null });
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "feat(slug): add helper" },
        ]);

        const result = await runTask({ ...input, issue });

        expect(mockedCommitLeftovers).toHaveBeenCalledWith(
            { worktreePath, taskId: input.taskId, attempt: 1 },
            expect.anything(),
        );
        expect(mockedPushBranch).toHaveBeenCalledWith(
            { worktreePath, branchName, issue },
            expect.anything(),
        );
        expect(mockedPostIssueComment).toHaveBeenCalledWith(
            { issue, body: "comment body" },
            expect.anything(),
        );
        expect(result.sync).toEqual({
            pushed: true,
            branchUrl:
                "https://github.com/test-owner/test-repo/tree/afk/task-1",
            pushError: null,
            commented: true,
            commentError: null,
            prUrl: "https://github.com/test-owner/test-repo/pull/7",
            prCreated: true,
            prReused: false,
            prError: null,
        });
    });

    it("skips the push but still comments when push is disabled", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report()],
            error: null,
        });
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "feat(slug): add helper" },
        ]);

        const result = await runTask({ ...input, issue, push: false });

        expect(mockedPushBranch).not.toHaveBeenCalled();
        expect(mockedOpenPullRequest).not.toHaveBeenCalled();
        expect(mockedBuildIssueComment).toHaveBeenCalledWith(
            expect.objectContaining({
                push: expect.objectContaining({
                    pushed: false,
                    reason: "push disabled",
                }),
            }),
        );
        expect(mockedPostIssueComment).toHaveBeenCalled();
        expect(result.sync).toEqual({
            pushed: false,
            branchUrl: null,
            pushError: "push disabled",
            commented: true,
            commentError: null,
            prUrl: null,
            prCreated: false,
            prReused: false,
            prError: null,
        });
    });

    it("opens a pull request before commenting after a successful push", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report()],
            error: null,
        });
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "feat(slug): add helper" },
        ]);

        await runTask({ ...input, issue });

        expect(mockedResolveBaseBranch).toHaveBeenCalledWith(
            worktreePath,
            undefined,
        );
        expect(mockedBuildPullRequestBody).toHaveBeenCalledWith({
            issue,
            taskId: input.taskId,
            attempts: 1,
            testsPassed: true,
            changedFiles: 1,
            commits: [{ sha: "abc1234", subject: "feat(slug): add helper" }],
        });
        expect(mockedOpenPullRequest).toHaveBeenCalledWith(
            {
                worktreePath,
                branchName,
                issue,
                baseBranch: "main",
                title: issue.title,
                body: "pull request body",
                rerunComment:
                    "AFK re-run: attempt 1, tests passing, 1 files changed.",
            },
            expect.anything(),
        );

        const pushOrder = mockedPushBranch.mock.invocationCallOrder[0]!;
        const prOrder = mockedOpenPullRequest.mock.invocationCallOrder[0]!;
        const commentOrder =
            mockedPostIssueComment.mock.invocationCallOrder[0]!;
        expect(pushOrder).toBeLessThan(prOrder);
        expect(prOrder).toBeLessThan(commentOrder);
    });

    it("skips the pull request when pr is disabled", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report()],
            error: null,
        });
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "feat(slug): add helper" },
        ]);

        const result = await runTask({ ...input, issue, pr: false });

        expect(mockedOpenPullRequest).not.toHaveBeenCalled();
        expect(result.sync?.prUrl).toBeNull();
        expect(result.sync?.prCreated).toBe(false);
        expect(result.sync?.prReused).toBe(false);
        expect(result.sync?.prError).toBeNull();
    });

    it("skips the pull request when the run failed even if the branch was pushed", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report({ success: false })],
            error: null,
        });
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "wip" },
        ]);

        const result = await runTask({ ...input, issue });

        expect(mockedPushBranch).toHaveBeenCalled();
        expect(mockedOpenPullRequest).not.toHaveBeenCalled();
        expect(result.sync?.prUrl).toBeNull();
    });

    it("skips the pull request when there are no commits", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report()],
            error: null,
        });
        mockedGetCommits.mockResolvedValue([]);

        const result = await runTask({ ...input, issue });

        expect(mockedPushBranch).not.toHaveBeenCalled();
        expect(mockedOpenPullRequest).not.toHaveBeenCalled();
        expect(result.sync?.prUrl).toBeNull();
    });

    it("reuses an existing pull request and reports it", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report()],
            error: null,
        });
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "feat(slug): add helper" },
        ]);
        mockedOpenPullRequest.mockResolvedValue({
            created: false,
            reused: true,
            url: "https://github.com/test-owner/test-repo/pull/3",
            error: null,
        });

        const result = await runTask({ ...input, issue });

        expect(result.sync).toEqual(
            expect.objectContaining({
                prUrl: "https://github.com/test-owner/test-repo/pull/3",
                prCreated: false,
                prReused: true,
                prError: null,
            }),
        );
    });

    it("reports a pull request failure without failing the run", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report()],
            error: null,
        });
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "feat(slug): add helper" },
        ]);
        mockedOpenPullRequest.mockResolvedValue({
            created: false,
            reused: false,
            url: null,
            error: "gh: not authenticated",
        });

        const result = await runTask({ ...input, issue });

        expect(result.error).toBeNull();
        expect(result.worktreeRemoved).toBe(false);
        expect(mockedRemoveWorktree).not.toHaveBeenCalled();
        expect(result.sync?.prError).toBe("gh: not authenticated");
        expect(mockedBuildIssueComment).toHaveBeenCalledWith(
            expect.objectContaining({
                pr: { url: null, error: "gh: not authenticated" },
            }),
        );
    });

    it("reports a comment failure without failing the run", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report()],
            error: null,
        });
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "feat(slug): add helper" },
        ]);
        mockedPostIssueComment.mockResolvedValue({
            commented: false,
            error: "gh: not authenticated",
        });

        const result = await runTask({ ...input, issue });

        expect(result.error).toBeNull();
        expect(result.sync?.commented).toBe(false);
        expect(result.sync?.commentError).toBe("gh: not authenticated");
    });

    it("still syncs before rethrowing an agent-loop failure", async () => {
        mockedRunWithRetries.mockRejectedValue(new Error("agent exploded"));
        mockedGetCommits.mockResolvedValue([
            { sha: "abc1234", subject: "wip" },
        ]);

        await expect(runTask({ ...input, issue })).rejects.toThrow(
            "agent exploded",
        );

        expect(mockedCommitLeftovers).toHaveBeenCalledWith(
            { worktreePath, taskId: input.taskId, attempt: 0 },
            expect.anything(),
        );
        expect(mockedPostIssueComment).toHaveBeenCalled();
        expect(mockedRemoveWorktree).toHaveBeenCalledWith(
            "/repo",
            worktreePath,
            { force: true },
        );
    });

    it("throws when the worktree cannot be created and skips the image and retries", async () => {
        mockedSetupWorktree.mockRejectedValue(
            new Error("Branch already exists: afk/task-1"),
        );

        await expect(runTask(input)).rejects.toThrow("Branch already exists");

        expect(agent.prepareImage).not.toHaveBeenCalled();
        expect(mockedRunWithRetries).not.toHaveBeenCalled();
        expect(mockedRemoveWorktree).not.toHaveBeenCalled();
    });

    it("throws when the image build fails and skips retries", async () => {
        agent.prepareImage.mockRejectedValue(
            new Error("Docker image build failed: no base image"),
        );

        await expect(runTask(input)).rejects.toThrow(
            "Docker image build failed",
        );

        expect(mockedRunWithRetries).not.toHaveBeenCalled();
        expect(mockedRemoveWorktree).toHaveBeenCalledWith(
            "/repo",
            worktreePath,
            { force: true },
        );
    });

    it("removes the worktree once after all retries fail", async () => {
        mockedRunWithRetries.mockResolvedValue({
            reports: [report({ success: false }), report({ success: false })],
            error: null,
        });

        await runTask(input);

        expect(mockedRemoveWorktree).toHaveBeenCalledTimes(1);
    });
});
