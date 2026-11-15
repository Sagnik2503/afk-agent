import path from "node:path";
import { randomUUID } from "node:crypto";
import {
    createDockerAgent,
    type DockerAgentOptions,
} from "../agent/docker_runner.js";
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
import type { GitHubIssue } from "../github/fetch_issues.js";
import { getChangedFiles } from "./change.js";
import type { HarnessReport } from "./report.js";
import { runWithRetries } from "./retry.js";
import { runTests } from "./validation.js";

export type RunTaskInput = {
    repoPath: string;
    taskId?: string;
    issueId: string;
    prompt: string;
    issue?: GitHubIssue;
    push?: boolean;
    model?: string;
    imageName?: string;
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
};

export type RunTaskResult = {
    branchName: string;
    worktreePath: string;
    reports: HarnessReport[];
    error: string | null;
    sync: SyncInfo | null;
};

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
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
    },
    deps: RunTaskDependencies,
): Promise<SyncInfo> {
    const lastReport = input.reports.at(-1);
    const success = lastReport?.success === true && input.error === null;

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

    const body = buildIssueComment({
        taskId: input.taskId,
        success,
        attempts: input.reports.length,
        branchName: input.branchName,
        issue: input.issue,
        push,
        commits,
        testsPassed: lastReport?.testsPassed === true,
        changedFiles: lastReport?.changedFiles.length ?? 0,
        reasons:
            lastReport?.reasons ?? (input.error === null ? [] : [input.error]),
    });

    const comment = await postIssueComment({ issue: input.issue, body }, deps);

    return {
        pushed: push.pushed,
        branchUrl: push.branchUrl,
        pushError: push.pushed ? null : push.reason,
        commented: comment.commented,
        commentError: comment.error,
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
            pushError: getErrorMessage(error),
            commented: false,
            commentError: null,
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

    const agentOptions: DockerAgentOptions = {
        repoPath,
        taskId,
        issueId: input.issueId,
    };
    if (input.model !== undefined) {
        agentOptions.model = input.model;
    }
    if (input.imageName !== undefined) {
        agentOptions.imageName = input.imageName;
    }
    if (input.timeout !== undefined) {
        agentOptions.timeout = input.timeout;
    }

    const agent = createDockerAgent(agentOptions);

    const { branchName, worktreePath } = await setupWorktree(repoPath, taskId);

    await agent.prepareImage();

    const syncInput = {
        worktreePath,
        branchName,
        taskId,
        pushEnabled: input.push !== false,
    };

    let retryResult;

    try {
        retryResult = await runWithRetries(
            {
                taskId,
                worktreePath,
                prompt: input.prompt,
            },
            {
                runAgent: (_worktreePath, prompt) => agent.run(prompt),
                runTests,
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
                    error: getErrorMessage(error),
                },
                deps,
            );
        }
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

    return {
        branchName,
        worktreePath,
        reports: retryResult.reports,
        error: retryResult.error,
        sync,
    };
}
