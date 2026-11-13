import path from "node:path";
import { randomUUID } from "node:crypto";
import {
    createDockerAgent,
    type DockerAgentOptions,
} from "../agent/docker_runner.js";
import { setupWorktree } from "../worktree/manager.js";
import { getChangedFiles } from "./change.js";
import type { HarnessReport } from "./report.js";
import { runWithRetries } from "./retry.js";
import { runTests } from "./validation.js";

export type RunTaskInput = {
    repoPath: string;
    taskId?: string;
    issueId: string;
    prompt: string;
    model?: string;
    imageName?: string;
    timeout?: number;
};

export type RunTaskResult = {
    branchName: string;
    worktreePath: string;
    reports: HarnessReport[];
    error: string | null;
};

export async function runTask(input: RunTaskInput): Promise<RunTaskResult> {
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

    const { branchName, worktreePath } = await setupWorktree(
        repoPath,
        taskId
    );

    await agent.prepareImage();

    const { reports, error } = await runWithRetries(
        {
            taskId,
            worktreePath,
            prompt: input.prompt,
        },
        {
            runAgent: (_worktreePath, prompt) => agent.run(prompt),
            runTests,
            getChangedFiles,
        }
    );

    return { branchName, worktreePath, reports, error };
}
