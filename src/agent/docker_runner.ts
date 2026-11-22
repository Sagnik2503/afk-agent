import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageVersion } from "../package_info.js";
import {
    ChildProcess,
    type ProcessResult,
    type ResourceLimit,
} from "../process.js";

export const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free";
export const DEFAULT_IMAGE = `afk-agent:${packageVersion()}`;
export const DEFAULT_DOCKERFILE = fileURLToPath(
    new URL("../../Dockerfile", import.meta.url),
);
export const DEFAULT_TIMEOUT = 10 * 60 * 1000;
export const DEFAULT_MEMORY = "2g";
export const DEFAULT_CPUS = "2";
export const DEFAULT_PIDS_LIMIT = "512";

const MEMORY_PATTERN = /^\d+(\.\d+)?[bkmg]?$/i;
const CPUS_PATTERN = /^\d+(\.\d+)?$/;
const PIDS_PATTERN = /^[1-9]\d*$/;
const PIDS_STDERR_PATTERN =
    /pids|fork:|resource temporarily unavailable|can't create new thread|pthread_create/i;

export function parseMemoryLimit(value: string): string {
    const normalized = value.trim();

    if (
        !MEMORY_PATTERN.test(normalized) ||
        !(Number.parseFloat(normalized) > 0)
    ) {
        throw new Error(
            "Memory must be a positive number with an optional b, k, m, or g unit.",
        );
    }

    return normalized;
}

export function parseCpusLimit(value: string): string {
    const normalized = value.trim();

    if (!CPUS_PATTERN.test(normalized) || !(Number(normalized) > 0)) {
        throw new Error("CPUs must be a positive number.");
    }

    return normalized;
}

export function parsePidsLimit(value: string): string {
    const normalized = value.trim();

    if (!PIDS_PATTERN.test(normalized)) {
        throw new Error("PIDs limit must be a positive integer.");
    }

    return normalized;
}
const CLEANUP_TIMEOUT = 10_000;
const PROVIDER_KEY_ENV = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GEMINI_API_KEY",
    "XAI_API_KEY",
];
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

export type PrepareImageOptions = {
    imageName?: string;
    dockerfilePath?: string;
    timeout?: number;
};

export type DockerAgentOptions = PrepareImageOptions & {
    repoPath: string;
    taskId: string;
    issueId: string;
    model?: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: string;
    build?: boolean;
    env?: NodeJS.ProcessEnv;
};

export type DockerAgent = {
    prepareImage: () => Promise<void>;
    run: (prompt: string) => Promise<ProcessResult>;
};

export type WatchSandboxLogsOptions = {
    repoPath: string;
    issueNumber: number;
    signal?: AbortSignal;
};

type ContainerInspection = {
    running: boolean;
    mounts: string[];
};

export function noRunningAgentMessage(
    repoPath: string,
    issueNumber: number,
): string {
    return `No running agent for issue ${issueNumber} in ${repoPath}.`;
}

function finishedMessage(repoPath: string, issueNumber: number): string {
    return `Agent for issue ${issueNumber} in ${repoPath} has finished.`;
}

async function inspectContainer(
    containerName: string,
): Promise<ContainerInspection | null> {
    const result = await ChildProcess("docker", ["inspect", containerName]);

    if (result.exitCode !== 0) {
        if (
            result.stderr.includes("No such object") ||
            result.stderr.includes("No such container")
        ) {
            return null;
        }

        throw new Error(
            `Unable to inspect Docker container: ${result.stderr.trim()}`,
        );
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(result.stdout);
    } catch {
        throw new Error(
            "Unable to inspect Docker container: invalid inspect output",
        );
    }

    if (!Array.isArray(parsed) || parsed.length === 0) {
        return null;
    }

    const details = parsed[0] as {
        State?: { Running?: boolean };
        Mounts?: Array<{ Source?: string }>;
    };

    const mounts = (details.Mounts ?? []).flatMap((mount) =>
        typeof mount.Source === "string" ? [mount.Source] : [],
    );

    return {
        running: details.State?.Running === true,
        mounts,
    };
}

type ContainerState = {
    OOMKilled?: boolean;
    ExitCode?: number;
};

async function inspectContainerState(
    containerName: string,
): Promise<ContainerState | null> {
    const result = await ChildProcess("docker", [
        "inspect",
        "--format",
        "{{json .State}}",
        containerName,
    ]);

    if (result.exitCode !== 0) {
        return null;
    }

    try {
        return JSON.parse(result.stdout) as ContainerState;
    } catch {
        return null;
    }
}

async function detectResourceLimit(
    containerName: string,
    result: ProcessResult,
    limits: { memory: string; pidsLimit: string },
): Promise<ResourceLimit | null> {
    const state = await inspectContainerState(containerName);

    if (state?.OOMKilled === true || result.exitCode === 137) {
        return {
            kind: "memory",
            value: limits.memory,
            message: `sandbox exceeded its memory limit (${limits.memory}); raise --memory to allow more`,
        };
    }

    if (PIDS_STDERR_PATTERN.test(result.stderr)) {
        return {
            kind: "pids",
            value: limits.pidsLimit,
            message: `sandbox exceeded its process limit (${limits.pidsLimit}); raise --pids-limit to allow more`,
        };
    }

    return null;
}

async function followContainerLogs(
    containerName: string,
    signal?: AbortSignal,
): Promise<ProcessResult> {
    return ChildProcess("docker", ["logs", "--follow", containerName], {
        onOutput: (stream, chunk) => {
            if (stream === "stdout") {
                process.stdout.write(chunk);
            } else {
                process.stderr.write(chunk);
            }
        },
        ...(signal ? { signal } : {}),
    });
}

export function watchSandboxLogs(
    options: WatchSandboxLogsOptions,
): Promise<void>;
export function watchSandboxLogs(
    repoPath: string,
    issueNumber: number,
    signal?: AbortSignal,
): Promise<void>;
export async function watchSandboxLogs(
    optionsOrRepoPath: WatchSandboxLogsOptions | string,
    issueNumberArg?: number,
    signalArg?: AbortSignal,
): Promise<void> {
    const resolved =
        typeof optionsOrRepoPath === "string"
            ? {
                  repoPath: optionsOrRepoPath,
                  issueNumber: issueNumberArg,
                  signal: signalArg,
              }
            : optionsOrRepoPath;
    const { repoPath, issueNumber, signal } = resolved;

    if (
        issueNumber === undefined ||
        !Number.isSafeInteger(issueNumber) ||
        issueNumber <= 0
    ) {
        throw new Error(`Invalid issue number: ${issueNumber}`);
    }

    const prefix = `afk-issue-${issueNumber}-`;
    const listed = await ChildProcess("docker", [
        "ps",
        "--filter",
        `name=${prefix}`,
        "--format",
        "{{.Names}}",
    ]);

    if (listed.exitCode !== 0) {
        throw new Error(
            `Unable to list Docker containers: ${listed.stderr.trim()}`,
        );
    }

    const candidates = listed.stdout
        .split(/\r?\n/)
        .map((name) => name.trim())
        .filter((name) => name.length > 0 && name.startsWith(prefix));

    if (candidates.length === 0) {
        throw new Error(noRunningAgentMessage(repoPath, issueNumber));
    }

    if (candidates.length > 1) {
        throw new Error(
            `Multiple running agents found for issue ${issueNumber} in ${repoPath}.`,
        );
    }

    const containerName = candidates[0]!;
    const inspection = await inspectContainer(containerName);

    if (!inspection || !inspection.running) {
        throw new Error(noRunningAgentMessage(repoPath, issueNumber));
    }

    const worktreesRoot = path.resolve(repoPath, ".afk", "worktrees");
    const ownsWorktree = inspection.mounts.some((source) =>
        path.resolve(source).startsWith(`${worktreesRoot}${path.sep}`),
    );

    if (!ownsWorktree) {
        throw new Error(noRunningAgentMessage(repoPath, issueNumber));
    }

    const result = await followContainerLogs(containerName, signal);

    if (signal?.aborted) {
        return;
    }

    if (result.exitCode === 0) {
        console.log(finishedMessage(repoPath, issueNumber));
        return;
    }

    const after = await inspectContainer(containerName);

    if (!after || !after.running) {
        console.log(finishedMessage(repoPath, issueNumber));
        return;
    }

    throw new Error(`Unable to stream container logs: ${result.stderr.trim()}`);
}

export async function prepareSandboxImage(
    options: PrepareImageOptions = {},
): Promise<void> {
    const imageName = options.imageName ?? DEFAULT_IMAGE;
    const dockerfilePath = options.dockerfilePath ?? DEFAULT_DOCKERFILE;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const buildContext = path.dirname(dockerfilePath);

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
        throw new Error(`Docker image inspection failed: ${inspected.stderr}`);
    }

    const build = await ChildProcess(
        "docker",
        ["build", "-t", imageName, "-f", dockerfilePath, buildContext],
        { timeout },
    );

    if (build.timedOut || build.exitCode !== 0) {
        throw new Error(`Docker image build failed: ${build.stderr}`);
    }
}

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
    const buildImage = options.build ?? true;

    const dockerfilePath = options.dockerfilePath ?? DEFAULT_DOCKERFILE;

    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const memory = parseMemoryLimit(options.memory ?? DEFAULT_MEMORY);
    const cpus = parseCpusLimit(options.cpus ?? DEFAULT_CPUS);
    const pidsLimit = parsePidsLimit(options.pidsLimit ?? DEFAULT_PIDS_LIMIT);
    const containerName = `afk-${options.taskId}`;
    const env = options.env ?? process.env;
    const providerEnv = PROVIDER_KEY_ENV.filter(
        (key) => env[key] !== undefined,
    ).flatMap((key) => ["-e", key]);

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
        if (!buildImage) {
            return;
        }

        await prepareSandboxImage({ imageName, dockerfilePath });
    }

    async function run(prompt: string): Promise<ProcessResult> {
        await removeContainer();

        let result: ProcessResult | undefined;
        let executionError: unknown;
        let cleanupError: unknown;

        try {
            const runResult = await ChildProcess(
                "docker",
                [
                    "run",
                    "--name",
                    containerName,
                    "--memory",
                    memory,
                    "--cpus",
                    cpus,
                    "--pids-limit",
                    pidsLimit,
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
                    ...providerEnv,
                    imageName,
                    "opencode",
                    "run",
                    "--auto",
                    "--pure",
                    "--model",
                    model,
                    prompt,
                ],
                { timeout, env },
            );

            if (runResult.exitCode !== 0) {
                const resourceLimit = await detectResourceLimit(
                    containerName,
                    runResult,
                    { memory, pidsLimit },
                );

                result =
                    resourceLimit === null
                        ? runResult
                        : { ...runResult, resourceLimit };
            } else {
                result = runResult;
            }
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

    return {
        prepareImage,
        run,
    };
}
