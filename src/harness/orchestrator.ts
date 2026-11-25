import path from "node:path";
import { randomUUID } from "node:crypto";
import {
    createDockerAgent,
    type DockerAgentOptions,
} from "../agent/docker_runner.js";
import {
    createSandboxCommandRunner,
    prepareSandboxImage,
    projectImageName,
} from "../agent/sandbox.js";
import { setupWorktree } from "../worktree/manager.js";
import {
    buildIssueComment,
    commitLeftovers,
    getBaseRef,
    getCommits,
    postIssueComment,
    pushBranch,
    type PushResult,
    type SyncRun,
} from "../github/sync.js";
import {
    buildPullRequestBody,
    openPullRequest,
    resolveBaseBranch,
    type PullRequestResult,
} from "../github/pull_request.js";
import type { GitHubIssue } from "../github/fetch_issues.js";
import { getChangedFiles } from "./change.js";
import { disposeWorktree, type DisposeWorktreeInput } from "./dispose.js";
import { errorMessage } from "../errors.js";
import type { HarnessReport } from "./report.js";
import { runWithRetries } from "./retry.js";
import { runValidation } from "./validation.js";
import { loadConfig } from "../config.js";

export type RunPhase = "image" | "sandbox";

export type RunTaskInput = {
    repoPath: string;
    taskId?: string;
    issueId: string;
    prompt: string;
    onPhase?: (phase: RunPhase) => void | Promise<void>;
    onAttempt?: (attempt: number) => void | Promise<void>;
    issue?: GitHubIssue;
    push?: boolean;
    pr?: boolean;
    model?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: string;
    imageName?: string;
    build?: boolean;
    timeout?: number;
};

export type RunTaskDependencies = {
    run?: SyncRun;
};

export type SyncInfo = {
    pushed: boolean;
    branchUrl: string | null;
    pushError: string | null;
    commented: boolean;
    commentError: string | null;
    prUrl: string | null;
    prCreated: boolean;
    prReused: boolean;
    prError: string | null;
};

export type RunTaskResult = {
    branchName: string;
    worktreePath: string;
    reports: HarnessReport[];
    error: string | null;
    sync: SyncInfo | null;
    worktreeRemoved: boolean;
    cleanupError: string | null;
};

function isSuccess(reports: HarnessReport[], error: string | null): boolean {
    return reports.at(-1)?.success === true && error === null;
}

async function disposeAfterFailure(
    input: DisposeWorktreeInput,
    deps: RunTaskDependencies,
): Promise<void> {
    const { error } = await disposeWorktree(input, deps);

    if (error) {
        console.error("Worktree cleanup failed:", error);
    }
}

async function syncAfterRun(
    input: {
        worktreePath: string;
        branchName: string;
        taskId: string;
        issue: GitHubIssue;
        reports: HarnessReport[];
        error: string | null;
        pushEnabled: boolean;
        prEnabled: boolean;
    },
    deps: RunTaskDependencies,
): Promise<SyncInfo> {
    const lastReport = input.reports.at(-1);
    const success = isSuccess(input.reports, input.error);

    await commitLeftovers(
        {
            worktreePath: input.worktreePath,
            taskId: input.taskId,
            attempt: input.reports.length,
        },
        deps,
    );

    const baseRef = await getBaseRef(input.worktreePath, deps.run);
    const commits = await getCommits(input.worktreePath, baseRef, deps.run);

    let push: PushResult;

    if (!input.pushEnabled) {
        push = {
            pushed: false,
            branchUrl: null,
            reason: "push disabled",
            baseRef,
        };
    } else if (commits.length === 0) {
        push = {
            pushed: false,
            branchUrl: null,
            reason: "no commits",
            baseRef,
        };
    } else {
        push = await pushBranch(
            {
                worktreePath: input.worktreePath,
                branchName: input.branchName,
                issue: input.issue,
            },
            deps,
        );
    }

    const attempts = input.reports.length;
    const testsPassed = lastReport?.testsPassed === true;
    const changedFiles = lastReport?.changedFiles.length ?? 0;

    let pr: PullRequestResult = {
        created: false,
        reused: false,
        url: null,
        error: null,
    };

    const shouldOpenPr =
        success &&
        commits.length > 0 &&
        input.pushEnabled &&
        push.pushed &&
        input.prEnabled;

    if (shouldOpenPr) {
        try {
            const baseBranch = await resolveBaseBranch(
                input.worktreePath,
                deps.run,
            );

            pr = await openPullRequest(
                {
                    worktreePath: input.worktreePath,
                    branchName: input.branchName,
                    issue: input.issue,
                    baseBranch,
                    title: input.issue.title,
                    body: buildPullRequestBody({
                        issue: input.issue,
                        taskId: input.taskId,
                        attempts,
                        testsPassed,
                        changedFiles,
                        commits,
                    }),
                    rerunComment: `AFK re-run: attempt ${attempts}, tests ${testsPassed ? "passing" : "failing"}, ${changedFiles} files changed.`,
                },
                deps,
            );
        } catch (error) {
            pr = {
                created: false,
                reused: false,
                url: null,
                error: errorMessage(error),
            };
        }
    }

    const body = buildIssueComment({
        taskId: input.taskId,
        success,
        attempts,
        branchName: input.branchName,
        issue: input.issue,
        push,
        commits,
        testsPassed,
        changedFiles,
        reasons:
            lastReport?.reasons ?? (input.error === null ? [] : [input.error]),
        pr: { url: pr.url, error: pr.error },
    });

    const comment = await postIssueComment({ issue: input.issue, body }, deps);

    return {
        pushed: push.pushed,
        branchUrl: push.branchUrl,
        pushError: push.pushed ? null : push.reason,
        commented: comment.commented,
        commentError: comment.error,
        prUrl: pr.url,
        prCreated: pr.created,
        prReused: pr.reused,
        prError: pr.error,
    };
}

async function safeSync(
    input: Parameters<typeof syncAfterRun>[0],
    deps: RunTaskDependencies,
): Promise<SyncInfo> {
    try {
        return await syncAfterRun(input, deps);
    } catch (error) {
        return {
            pushed: false,
            branchUrl: null,
            pushError: errorMessage(error),
            commented: false,
            commentError: null,
            prUrl: null,
            prCreated: false,
            prReused: false,
            prError: null,
        };
    }
}

export async function runTask(
    input: RunTaskInput,
    deps: RunTaskDependencies = {},
): Promise<RunTaskResult> {
    if (!input.prompt.trim()) {
        throw new Error("Prompt is required");
    }

    const repoPath = path.resolve(input.repoPath);
    const taskId = input.taskId ?? randomUUID();

    const config = await loadConfig(repoPath);
    const validateCommands = config.validate;
    const projectImage =
        input.imageName === undefined ? config.dockerfile : null;

    const agentOptions: DockerAgentOptions = {
        repoPath,
        taskId,
        issueId: input.issueId,
    };
    if (input.model !== undefined) {
        agentOptions.model = input.model;
    }
    if (input.memory !== undefined) {
        agentOptions.memory = input.memory;
    }
    if (input.cpus !== undefined) {
        agentOptions.cpus = input.cpus;
    }
    if (input.pidsLimit !== undefined) {
        agentOptions.pidsLimit = input.pidsLimit;
    }
    if (input.imageName !== undefined) {
        agentOptions.imageName = input.imageName;
    }
    if (input.build !== undefined) {
        agentOptions.build = input.build;
    }
    if (input.timeout !== undefined) {
        agentOptions.timeout = input.timeout;
    }
    if (projectImage !== null) {
        agentOptions.imageName = await projectImageName(projectImage);
        agentOptions.dockerfilePath = projectImage;
    }

    const agent = createDockerAgent(agentOptions);
    const validationSandbox = createSandboxCommandRunner(agentOptions);

    const { branchName, worktreePath } = await setupWorktree(repoPath, taskId);

    try {
        await input.onPhase?.("image");
        if (projectImage !== null) {
            await prepareSandboxImage();
        }
        await agent.prepareImage();
    } catch (error) {
        await disposeAfterFailure(
            { repoPath, worktreePath, taskId, attempt: 0 },
            deps,
        );
        throw error;
    }

    const syncInput = {
        worktreePath,
        branchName,
        taskId,
        pushEnabled: input.push !== false,
        prEnabled: input.pr !== false,
    };

    let retryResult;

    try {
        await input.onPhase?.("sandbox");
        retryResult = await runWithRetries(
            {
                taskId,
                worktreePath,
                prompt: input.prompt,
                ...(input.onAttempt !== undefined
                    ? { onAttempt: input.onAttempt }
                    : {}),
            },
            {
                runAgent: (_worktreePath, prompt) => agent.run(prompt),
                runValidation: () =>
                    runValidation(
                        validationSandbox.runCommand,
                        validateCommands,
                    ),
                getChangedFiles,
            },
        );
    } catch (error) {
        if (input.issue !== undefined) {
            await safeSync(
                {
                    ...syncInput,
                    issue: input.issue,
                    reports: [],
                    error: errorMessage(error),
                },
                deps,
            );
        }

        await disposeAfterFailure(
            { repoPath, worktreePath, taskId, attempt: 0 },
            deps,
        );

        throw error;
    }

    const sync =
        input.issue !== undefined
            ? await safeSync(
                  {
                      ...syncInput,
                      issue: input.issue,
                      reports: retryResult.reports,
                      error: retryResult.error,
                  },
                  deps,
              )
            : null;

    let worktreeRemoved = false;
    let cleanupError: string | null = null;

    if (!isSuccess(retryResult.reports, retryResult.error)) {
        const cleanup = await disposeWorktree(
            {
                repoPath,
                worktreePath,
                taskId,
                attempt: retryResult.reports.length,
            },
            deps,
        );
        worktreeRemoved = cleanup.removed;
        cleanupError = cleanup.error;
    }

    return {
        branchName,
        worktreePath,
        reports: retryResult.reports,
        error: retryResult.error,
        sync,
        worktreeRemoved,
        cleanupError,
    };
}
