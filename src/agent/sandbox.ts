import path from "node:path";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { taskWorktreePath } from "../worktree/manager.js";
import {
    ChildProcess,
    type ProcessResult,
    type ResourceLimit,
} from "../process.js";

export const DEFAULT_IMAGE = "afk-agent:base";
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

export type PrepareImageOptions = {
    imageName?: string;
    dockerfilePath?: string;
    timeout?: number;
};

export type SandboxCommandRunnerOptions = PrepareImageOptions & {
    repoPath: string;
    taskId: string;
    issueId: string;
    memory?: string;
    cpus?: string;
    pidsLimit?: string;
    build?: boolean;
    env?: NodeJS.ProcessEnv;
};

export type SandboxCommandRunner = {
    prepareImage: () => Promise<void>;
    runCommand: (
        command: string[],
        options?: { timeout?: number },
    ) => Promise<ProcessResult>;
};

export function sandboxContainerName(taskId: string): string {
    return `afk-${taskId}`;
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

    // Exit 137 alone is not OOM evidence: timeout SIGKILL and afk stop also produce it.
    if (state?.OOMKilled === true) {
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

export async function prepareSandboxImage(
    options: PrepareImageOptions = {},
): Promise<void> {
    const imageName = options.imageName ?? DEFAULT_IMAGE;
    const dockerfilePath = options.dockerfilePath ?? DEFAULT_DOCKERFILE;
    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const buildContext = path.dirname(dockerfilePath);
    // Only afk's own base image is rebuilt when its bundled Dockerfile changes.
    // Project images hash their Dockerfile into the tag, and a prebuilt --image
    // (build: false) never reaches here.
    const tracksDockerfile =
        imageName === DEFAULT_IMAGE && dockerfilePath === DEFAULT_DOCKERFILE;
    const contentHash = tracksDockerfile
        ? await dockerfileHash(dockerfilePath)
        : null;

    const inspected = await ChildProcess(
        "docker",
        tracksDockerfile
            ? [
                  "image",
                  "inspect",
                  "--format",
                  "{{json .Config.Labels}}",
                  imageName,
              ]
            : ["image", "inspect", imageName],
        { timeout },
    );

    if (inspected.exitCode === 0) {
        if (!tracksDockerfile) {
            return;
        }

        // A cached base from an older afk build lacks the current Dockerfile
        // hash, so upgrades flow through without users editing FROM lines.
        if (imageLabel(inspected.stdout, BASE_IMAGE_LABEL) === contentHash) {
            return;
        }
    } else {
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
    }

    const buildArgs = ["build", "-t", imageName, "-f", dockerfilePath];

    if (contentHash !== null) {
        buildArgs.push("--label", `${BASE_IMAGE_LABEL}=${contentHash}`);
    }

    buildArgs.push(buildContext);

    const build = await ChildProcess("docker", buildArgs, { timeout });

    if (build.timedOut || build.exitCode !== 0) {
        throw new Error(`Docker image build failed: ${build.stderr}`);
    }
}

export const BASE_IMAGE_LABEL = "afk.base.dockerfile-hash";

export async function dockerfileHash(dockerfilePath: string): Promise<string> {
    const content = await readFile(dockerfilePath);

    return createHash("sha256").update(content).digest("hex").slice(0, 12);
}

function imageLabel(stdout: string, label: string): string | undefined {
    try {
        const labels = JSON.parse(stdout) as Record<string, string> | null;

        return labels?.[label];
    } catch {
        return undefined;
    }
}

export async function projectImageName(
    dockerfilePath: string,
): Promise<string> {
    const content = await readFile(dockerfilePath);
    const hash = createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, 12);

    return `afk-agent:project-${hash}`;
}

export function createSandboxCommandRunner(
    options: SandboxCommandRunnerOptions,
): SandboxCommandRunner {
    if (!/^[a-zA-Z0-9_-]+$/.test(options.taskId)) {
        throw new Error("Invalid task ID");
    }

    if (!options.issueId.trim() || /[\r\n\0]/.test(options.issueId)) {
        throw new Error("Invalid issue ID");
    }

    const repoPath = path.resolve(options.repoPath);

    const worktreePath = taskWorktreePath(repoPath, options.taskId);

    const gitDir = path.resolve(repoPath, ".git");
    const imageName = options.imageName ?? DEFAULT_IMAGE;
    const buildImage = options.build ?? true;

    const dockerfilePath = options.dockerfilePath ?? DEFAULT_DOCKERFILE;

    const timeout = options.timeout ?? DEFAULT_TIMEOUT;
    const memory = parseMemoryLimit(options.memory ?? DEFAULT_MEMORY);
    const cpus = parseCpusLimit(options.cpus ?? DEFAULT_CPUS);
    const pidsLimit = parsePidsLimit(options.pidsLimit ?? DEFAULT_PIDS_LIMIT);
    const containerName = sandboxContainerName(options.taskId);
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

    function containerArgs(command: string[]): string[] {
        return [
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
            ...command,
        ];
    }

    async function runCommand(
        command: string[],
        runOptions: { timeout?: number } = {},
    ): Promise<ProcessResult> {
        await removeContainer();

        let result: ProcessResult | undefined;
        let executionError: unknown;
        let cleanupError: unknown;

        try {
            const runResult = await ChildProcess(
                "docker",
                containerArgs(command),
                { timeout: runOptions.timeout ?? timeout, env },
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
        runCommand,
    };
}
