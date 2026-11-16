import path from "node:path";
import { ChildProcess, type ProcessResult } from "../process.js";
import { streamContainerLogs } from "../process.js";

export const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free";
export const DEFAULT_IMAGE = "afk-agent:latest";
export const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const CLEANUP_TIMEOUT = 10_000;
const GIT_ENV = [
    "GIT_AUTHOR_NAME=afk-agent",
    "GIT_AUTHOR_EMAIL=afk-agent@localhost",
    "GIT_COMMITTER_NAME=afk-agent",
    "GIT_COMMITTER_EMAIL=afk-agent@localhost",
    // The bind-mounted worktree is owned by the host user, not the node user.
    "GIT_CONFIG_COUNT=1",
    "GIT_CONFIG_KEY_0=safe.directory",
    "GIT_CONFIG_VALUE_0=*",
];

export type DockerAgentOptions = {
    repoPath: string;
    taskId: string;
    issueId: string;
    model?: string;
    imageName?: string;
    dockerfilePath?: string;
    timeout?: number;
};

export type DockerAgent = {
    prepareImage: () => Promise<void>;
    run: (prompt: string) => Promise<ProcessResult>;
    streamLogs: () => Promise<void>;
};

export function createDockerAgent(options: DockerAgentOptions): DockerAgent {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.taskId)) {
        throw new Error("Invalid task ID");
    }

    if (!options.issueId.trim() || /[\r\n\0]/.test(options.issueId)) {
        throw new Error("Invalid issue ID");
    }

    const repoPath = path.resolve(options.repoPath);

    const worktreePath = path.resolve(
        repoPath,
        ".afk",
        "worktrees",
        options.taskId,
    );

    const gitDir = path.resolve(repoPath, ".git");
    const model = options.model ?? DEFAULT_MODEL;
    const imageName = options.imageName ?? DEFAULT_IMAGE;

    const dockerfilePath =
        options.dockerfilePath ?? path.resolve(repoPath, "Dockerfile");

    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const containerName = `afk-${options.taskId}`;

    async function removeContainer(): Promise<void> {
        const result = await ChildProcess(
            "docker",
            ["rm", "-f", containerName],
            { timeout: CLEANUP_TIMEOUT },
        );

        if (
            result.exitCode !== 0 &&
            !result.stderr.includes("No such container")
        ) {
            throw new Error(
                `Docker container removal failed: ${result.stderr}`,
            );
        }
    }

    async function prepareImage(): Promise<void> {
        const inspected = await ChildProcess(
            "docker",
            ["image", "inspect", imageName],
            { timeout },
        );

        if (inspected.exitCode === 0) {
            return;
        }

        if (inspected.timedOut) {
            throw new Error(
                `Docker image inspection timed out: ${inspected.stderr}`,
            );
        }

        if (!inspected.stderr.includes("No such image")) {
            throw new Error(
                `Docker image inspection failed: ${inspected.stderr}`,
            );
        }

        const build = await ChildProcess(
            "docker",
            ["build", "-t", imageName, "-f", dockerfilePath, repoPath],
            { timeout },
        );

        if (build.timedOut || build.exitCode !== 0) {
            throw new Error(`Docker image build failed: ${build.stderr}`);
        }
    }

    async function run(prompt: string): Promise<ProcessResult> {
        await removeContainer();

        let result: ProcessResult | undefined;
        let executionError: unknown;
        let cleanupError: unknown;

        try {
            result = await ChildProcess(
                "docker",
                [
                    "run",
                    "--name",
                    containerName,
                    "--user",
                    "node",
                    "-w",
                    worktreePath,
                    "-v",
                    `${worktreePath}:${worktreePath}`,
                    "-v",
                    `${gitDir}:${gitDir}`,
                    "-e",
                    `AFK_TASK_ID=${options.taskId}`,
                    "-e",
                    `AFK_ISSUE_ID=${options.issueId}`,
                    ...GIT_ENV.flatMap((value) => ["-e", value]),
                    imageName,
                    "opencode",
                    "run",
                    "--auto",
                    "--pure",
                    "--model",
                    model,
                    prompt,
                ],
                { timeout },
            );
        } catch (error) {
            executionError = error;
        } finally {
            try {
                await removeContainer();
            } catch (error) {
                cleanupError = error;
            }
        }

        if (executionError !== undefined) {
            throw executionError;
        }

        if (cleanupError !== undefined) {
            throw cleanupError;
        }

        return result!;
    }

    return { prepareImage, run, streamLogs: () => streamContainerLogs(containerName), };
}
