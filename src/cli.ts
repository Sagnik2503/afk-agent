#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { runTask } from "./harness/orchestrator.js";
import {
    deriveTaskId,
    fetchGitHubIssue,
    parseIssueNumber,
} from "./github/fetch_issues.js";
import { validateRepository } from "./github/repo_validation.js";
import { buildIssuePrompt } from "./agent/prompt.js";
import {
    DEFAULT_CPUS,
    DEFAULT_IMAGE,
    DEFAULT_MEMORY,
    DEFAULT_PIDS_LIMIT,
    parseCpusLimit,
    parseMemoryLimit,
    parsePidsLimit,
    prepareSandboxImage,
    watchSandboxLogs,
} from "./agent/docker_runner.js";
import { packageVersion } from "./package_info.js";
import { formatPreflightFailures, runPreflight } from "./preflight.js";
import { acquireTaskLock, releaseTaskLock } from "./harness/lock.js";

function parseTimeout(value: string): number {
    const timeout = Number(value);

    if (!Number.isSafeInteger(timeout) || timeout <= 0) {
        throw new InvalidArgumentError(
            "Timeout must be a positive integer of milliseconds.",
        );
    }

    return timeout;
}

function argumentParser<T>(parse: (value: string) => T): (value: string) => T {
    return (value: string): T => {
        try {
            return parse(value);
        } catch (error) {
            throw new InvalidArgumentError(
                error instanceof Error ? error.message : String(error),
            );
        }
    };
}

const parseMemory = argumentParser(parseMemoryLimit);
const parseCpus = argumentParser(parseCpusLimit);
const parsePids = argumentParser(parsePidsLimit);

async function reportPreflight(repoPath: string): Promise<boolean> {
    const failures = await runPreflight({ repoPath });

    if (failures.length > 0) {
        console.error(formatPreflightFailures(failures));
        process.exitCode = 1;
        return false;
    }

    return true;
}

const program = new Command();

program
    .name("afk-agent")
    .description("A safe, bounded AFK coding agent")
    .version(packageVersion());

program
    .command("setup")
    .description("Check prerequisites and build the Sandbox image")
    .argument("[path]", "repository path", ".")
    .action(async (repoPath: string) => {
        try {
            if (!(await reportPreflight(repoPath))) {
                return;
            }

            console.log("All checks passed. Building Sandbox image...");
            await prepareSandboxImage();
            console.log("Sandbox image ready:", DEFAULT_IMAGE);
        } catch (error) {
            console.error(
                "AFK setup failed:",
                error instanceof Error ? error.message : error,
            );
            process.exitCode = 1;
        }
    });

program
    .command("run")
    .description("Run an AFK coding task")
    .requiredOption("--repo <path>", "Repository path")
    .requiredOption("--issue <id>", "GitHub issue ID")
    .option("--model <model>", "Model to use inside the Sandbox")
    .option(
        "--timeout <ms>",
        "Agent run timeout in milliseconds (default: 600000)",
        parseTimeout,
    )
    .option(
        "--memory <size>",
        `Sandbox memory limit, e.g. 2g (default: ${DEFAULT_MEMORY})`,
        parseMemory,
    )
    .option(
        "--cpus <count>",
        `Sandbox CPU limit (default: ${DEFAULT_CPUS})`,
        parseCpus,
    )
    .option(
        "--pids-limit <count>",
        `Sandbox process limit (default: ${DEFAULT_PIDS_LIMIT})`,
        parsePids,
    )
    .option(
        "--test-command <command>",
        "Command used to validate changes (default: npm test)",
    )
    .option(
        "--image <image>",
        "Use a prebuilt Sandbox image instead of building",
    )
    .option("--no-push", "Skip pushing the branch to GitHub")
    .option("--no-pr", "Skip opening a pull request")
    .action(async (options) => {
        try {
            if (!(await reportPreflight(options.repo))) {
                return;
            }

            const repoPath = await validateRepository(options.repo);
            console.log("Validated repository:", repoPath);

            // 1. Fetch GitHub issue
            const issue = await fetchGitHubIssue(repoPath, options.issue);

            console.log("\n--- GitHub Issue ---");
            console.log("Title:", issue.title);
            console.log("URL:", issue.url);

            // 2. Build agent prompt
            const prompt = buildIssuePrompt(issue);

            // 3. Execute task
            const taskId = deriveTaskId(issue);
            await acquireTaskLock({
                repoPath,
                taskId,
                issueId: options.issue,
            });

            const onSigint = (): void => {
                process.off("SIGINT", onSigint);
                process.off("SIGTERM", onSigterm);
                void releaseTaskLock({ repoPath, taskId }).finally(() =>
                    process.exit(130),
                );
            };
            const onSigterm = (): void => {
                process.off("SIGINT", onSigint);
                process.off("SIGTERM", onSigterm);
                void releaseTaskLock({ repoPath, taskId }).finally(() =>
                    process.exit(143),
                );
            };
            process.on("SIGINT", onSigint);
            process.on("SIGTERM", onSigterm);

            try {
                const result = await runTask({
                    repoPath,
                    taskId,
                    issueId: options.issue,
                    issue,
                    prompt,
                    push: options.push !== false,
                    pr: options.pr !== false,
                    ...(options.model !== undefined
                        ? { model: options.model }
                        : {}),
                    ...(options.timeout !== undefined
                        ? { timeout: options.timeout }
                        : {}),
                    ...(options.memory !== undefined
                        ? { memory: options.memory }
                        : {}),
                    ...(options.cpus !== undefined
                        ? { cpus: options.cpus }
                        : {}),
                    ...(options.pidsLimit !== undefined
                        ? { pidsLimit: options.pidsLimit }
                        : {}),
                    ...(options.testCommand !== undefined
                        ? { testCommand: options.testCommand }
                        : {}),
                    ...(options.image !== undefined
                        ? { imageName: options.image, build: false }
                        : {}),
                });

                // 4. Display report
                const lastReport = result.reports.at(-1);

                console.log("\n--- AFK Agent Report ---");
                console.log("Branch:", result.branchName);
                console.log(
                    "Worktree:",
                    result.worktreeRemoved
                        ? "removed (branch kept)"
                        : result.worktreePath,
                );
                if (result.cleanupError) {
                    console.error(
                        "Worktree cleanup failed:",
                        result.cleanupError,
                    );
                }
                console.log("Attempts:", result.reports.length);

                if (result.sync) {
                    console.log(
                        "GitHub:",
                        result.sync.pushed
                            ? result.sync.branchUrl
                            : `not pushed (${result.sync.pushError})`,
                    );
                    if (!result.sync.commented) {
                        console.error(
                            "Issue comment failed:",
                            result.sync.commentError,
                        );
                    }
                    if (result.sync.prUrl) {
                        console.log("Pull request:", result.sync.prUrl);
                    }
                    if (result.sync.prError) {
                        console.warn(
                            "Pull request warning:",
                            result.sync.prError,
                        );
                    }
                }

                const pushFailed =
                    result.sync !== null &&
                    !result.sync.pushed &&
                    options.push !== false;

                if (result.error) {
                    console.error("Execution error:", result.error);
                    process.exitCode = 1;
                } else if (!lastReport?.success) {
                    console.log("Status: FAILED");
                    process.exitCode = 1;
                } else if (pushFailed) {
                    console.error(
                        "Status: FAILED (tests passed, GitHub sync failed)",
                    );
                    process.exitCode = 1;
                } else {
                    console.log("Status: SUCCESS");
                }

                if (lastReport) {
                    console.log("Changed files:", lastReport.changedFiles);
                    console.log("Reasons:", lastReport.reasons);
                }
            } finally {
                process.off("SIGINT", onSigint);
                process.off("SIGTERM", onSigterm);
                await releaseTaskLock({ repoPath, taskId });
            }
        } catch (error) {
            console.error(
                "AFK Agent failed:",
                error instanceof Error ? error.message : error,
            );
            process.exitCode = 1;
        }
    });

program
    .command("logs")
    .description("Stream the Sandbox logs of a running AFK agent")
    .requiredOption("--repo <path>", "Repository path")
    .requiredOption("--issue <number-or-url>", "GitHub issue number or URL")
    .action(async (options) => {
        const controller = new AbortController();
        const onSignal = (): void => controller.abort();

        process.on("SIGINT", onSignal);
        process.on("SIGTERM", onSignal);

        try {
            const issueNumber = parseIssueNumber(options.issue);
            const repoPath = await validateRepository(options.repo);

            await watchSandboxLogs({
                repoPath,
                issueNumber,
                signal: controller.signal,
            });
        } catch (error) {
            if (!controller.signal.aborted) {
                console.error(
                    "Unable to monitor agent:",
                    error instanceof Error ? error.message : error,
                );
                process.exitCode = 1;
            }
        } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
        }
    });

program.parse();
