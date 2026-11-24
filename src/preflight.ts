import path from "node:path";
import {
    ChildProcess,
    type ProcessOptions,
    type ProcessResult,
} from "./process.js";
import { loadValidationCommands } from "./config.js";
import { errorMessage } from "./errors.js";

export type PreflightRun = (
    command: string,
    args: string[],
    options?: ProcessOptions,
) => Promise<ProcessResult>;

export type PreflightFailure = {
    check: string;
    guidance: string;
};

export type PreflightInput = {
    repoPath: string;
    run?: PreflightRun;
};

async function passes(
    run: PreflightRun,
    command: string,
    args: string[],
    options: ProcessOptions,
): Promise<boolean> {
    try {
        const result = await run(command, args, options);
        return result.exitCode === 0 && !result.timedOut;
    } catch {
        return false;
    }
}

export async function runPreflight(
    input: PreflightInput,
): Promise<PreflightFailure[]> {
    const run = input.run ?? ChildProcess;
    const repoPath = path.resolve(input.repoPath);
    const failures: PreflightFailure[] = [];

    if (!(await passes(run, "git", ["--version"], { timeout: 10_000 }))) {
        failures.push({
            check: "Git",
            guidance: "Install Git and make sure `git` is on your PATH.",
        });
    }

    if (!(await passes(run, "docker", ["info"], { timeout: 30_000 }))) {
        failures.push({
            check: "Docker daemon",
            guidance:
                "Install Docker and make sure the daemon is running (Docker Desktop or the docker daemon), then re-run.",
        });
    }

    if (!(await passes(run, "gh", ["auth", "status"], { timeout: 30_000 }))) {
        failures.push({
            check: "GitHub CLI",
            guidance:
                "Install the GitHub CLI and sign in with `gh auth login`.",
        });
    }

    if (
        !(await passes(run, "git", ["rev-parse", "--show-toplevel"], {
            cwd: repoPath,
            timeout: 10_000,
        }))
    ) {
        failures.push({
            check: "Git repository",
            guidance: `Point afk at a Git repository (checked ${repoPath}).`,
        });
    }

    try {
        await loadValidationCommands(repoPath);
    } catch (error) {
        failures.push({
            check: "Validation config",
            guidance: errorMessage(error),
        });
    }

    return failures;
}

export function formatPreflightFailures(failures: PreflightFailure[]): string {
    return [
        "afk found problems:",
        ...failures.map((failure) => `- ${failure.check}: ${failure.guidance}`),
    ].join("\n");
}
