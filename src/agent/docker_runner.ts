import path from "node:path";
import { ChildProcess, type ProcessResult } from "../process.js";

export const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free";
export const DEFAULT_IMAGE = "afk-agent:latest";
export const DEFAULT_TIMEOUT = 10 * 60 * 1000;
const CLEANUP_TIMEOUT = 10_000;

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
        options.taskId
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
            { timeout: CLEANUP_TIMEOUT }
        );

        if (
            result.exitCode !== 0 &&
            !result.stderr.includes("No such container")
        ) {
            throw new Error(
                `Docker container removal failed: ${result.stderr}`
            );
        }
    }

    async function prepareImage(): Promise<void> {
        const inspected = await ChildProcess(
            "docker",
            ["image", "inspect", imageName],
            { timeout }
        );

        if (inspected.exitCode === 0) {
            return;
        }

        if (inspected.timedOut) {
            throw new Error(
                `Docker image inspection timed out: ${inspected.stderr}`
            );
        }

        if (!inspected.stderr.includes("No such image")) {
            throw new Error(
                `Docker image inspection failed: ${inspected.stderr}`
            );
        }

        const build = await ChildProcess(
            "docker",
            ["build", "-t", imageName, "-f", dockerfilePath, repoPath],
            { timeout }
        );

        if (build.timedOut || build.exitCode !== 0) {
            throw new Error(
                `Docker image build failed: ${build.stderr}`
            );
        }
    }

    async function run(prompt: string): Promise<ProcessResult> {
        await removeContainer();

        let executionError: unknown;

        try {
            return await ChildProcess(
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
                    imageName,
                    "opencode",
                    "run",
                    "--auto",
                    "--pure",
                    "--model",
                    model,
                    prompt,
                ],
                { timeout }
            );
        } catch (error) {
            executionError = error;
            throw error;
        } finally {
            try {
                await removeContainer();
            } catch (cleanupError) {
                if (executionError === undefined) {
                    throw cleanupError;
                }
            }
        }
    }

    return { prepareImage, run };
}
