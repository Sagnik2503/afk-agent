import path from "node:path";
import {
    createSandboxCommandRunner,
    type PrepareImageOptions,
} from "./sandbox.js";
import { ChildProcess, type ProcessResult } from "../process.js";

export const DEFAULT_MODEL = "opencode/deepseek-v4.1-flash-free";

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

export {
    DEFAULT_CPUS,
    DEFAULT_DOCKERFILE,
    DEFAULT_IMAGE,
    DEFAULT_MEMORY,
    DEFAULT_PIDS_LIMIT,
    DEFAULT_TIMEOUT,
    parseCpusLimit,
    parseMemoryLimit,
    parsePidsLimit,
    prepareSandboxImage,
    sandboxContainerName,
} from "./sandbox.js";
export type { PrepareImageOptions } from "./sandbox.js";

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

    const baseName = `afk-issue-${issueNumber}`;
    const prefix = `${baseName}-`;
    const listed = await ChildProcess("docker", [
        "ps",
        "--filter",
        `name=${baseName}`,
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
        .filter(
            (name) =>
                name.length > 0 &&
                (name === baseName || name.startsWith(prefix)),
        );

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

export function createDockerAgent(options: DockerAgentOptions): DockerAgent {
    const model = options.model ?? DEFAULT_MODEL;
    const sandbox = createSandboxCommandRunner(options);

    return {
        prepareImage: sandbox.prepareImage,
        run: (prompt) =>
            sandbox.runCommand([
                "opencode",
                "run",
                "--auto",
                "--pure",
                "--model",
                model,
                prompt,
            ]),
    };
}
