#!/usr/bin/env node
import { spawn } from "node:child_process";
import { open, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Command, InvalidArgumentError } from "commander";
import { runTask } from "./harness/orchestrator.js";
import {
    deriveTaskId,
    fetchGitHubIssue,
    parseIssueNumber,
    parseIssueUrl,
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
import { errorMessage } from "./errors.js";
import { packageVersion } from "./package_info.js";
import { formatPreflightFailures, runPreflight } from "./preflight.js";
import {
    acquireTaskLock,
    releaseTaskLock,
    transferTaskLock,
} from "./harness/lock.js";
import { createColors } from "./ui/color.js";
import { formatRunReport } from "./ui/report.js";
import {
    findRunForIssue,
    listRunRecords,
    resolveRunState,
    runLogPath,
    startRunRecord,
    updateRunRecord,
} from "./harness/run_record.js";
import { formatRunDetail, formatRunList } from "./ui/status.js";
import { stopRun } from "./harness/stop.js";

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
            throw new InvalidArgumentError(errorMessage(error));
        }
    };
}

const parseMemory = argumentParser(parseMemoryLimit);
const parseCpus = argumentParser(parseCpusLimit);
const parsePids = argumentParser(parsePidsLimit);

async function reportPreflight(
    repoPath: string,
    requireValidationConfig = true,
): Promise<boolean> {
    const failures = await runPreflight({ repoPath, requireValidationConfig });

    if (failures.length > 0) {
        console.error(formatPreflightFailures(failures));
        process.exitCode = 1;
        return false;
    }

    return true;
}

const commandExamples: Record<string, string> = {
    setup: "afk setup",
    run: "afk run --repo . --issue 142",
    logs: "afk logs --repo . --issue 142",
    status: "afk status --repo .",
    stop: "afk stop --repo . --issue 142",
    help: "afk help run",
};

type RunOptions = {
    repo: string;
    issue: string;
    model?: string;
    timeout?: number;
    memory?: string;
    cpus?: string;
    pidsLimit?: string;
    image?: string;
    push?: boolean;
    pr?: boolean;
    background?: boolean;
};

function backgroundChildArgs(options: RunOptions): string[] {
    const args = ["run", "--repo", options.repo, "--issue", options.issue];

    if (options.model !== undefined) {
        args.push("--model", options.model);
    }
    if (options.timeout !== undefined) {
        args.push("--timeout", String(options.timeout));
    }
    if (options.memory !== undefined) {
        args.push("--memory", options.memory);
    }
    if (options.cpus !== undefined) {
        args.push("--cpus", options.cpus);
    }
    if (options.pidsLimit !== undefined) {
        args.push("--pids-limit", options.pidsLimit);
    }
    if (options.image !== undefined) {
        args.push("--image", options.image);
    }
    if (options.push === false) {
        args.push("--no-push");
    }
    if (options.pr === false) {
        args.push("--no-pr");
    }

    return args;
}

function nodeInvocation(): string[] {
    const self = fileURLToPath(import.meta.url);
    return self.endsWith(".ts") ? ["--import", "tsx", self] : [self];
}

async function startBackgroundRun(options: RunOptions): Promise<void> {
    const repoPath = await validateRepository(options.repo);
    const issueNumber = parseIssueNumber(options.issue);
    // The Issue fetch happens in the child so the parent returns promptly;
    // reuse a known Task ID or fall back to the issue number.
    const existing = await findRunForIssue(repoPath, issueNumber);
    const taskId = existing?.taskId ?? `issue-${issueNumber}`;
    const logPath = runLogPath(repoPath, taskId);

    await acquireTaskLock({ repoPath, taskId, issueId: options.issue });

    await mkdir(path.dirname(logPath), { recursive: true });
    const logHandle = await open(logPath, "w");

    let child;

    try {
        child = spawn(
            process.execPath,
            [
                ...nodeInvocation(),
                ...backgroundChildArgs({ ...options, repo: repoPath }),
            ],
            {
                cwd: path.dirname(fileURLToPath(import.meta.url)),
                detached: true,
                stdio: ["ignore", logHandle.fd, logHandle.fd],
                env: {
                    ...process.env,
                    AFK_BACKGROUND_CHILD: "1",
                    AFK_TASK_ID: taskId,
                },
            },
        );
    } catch (error) {
        await logHandle.close();
        await releaseTaskLock({ repoPath, taskId });
        throw error;
    }

    const pid = child.pid;

    if (pid === undefined) {
        await logHandle.close();
        await releaseTaskLock({ repoPath, taskId });
        throw new Error("Unable to start the background run");
    }

    try {
        await transferTaskLock({ repoPath, taskId, toPid: pid });
    } catch (error) {
        child.kill("SIGTERM");
        await logHandle.close();
        await releaseTaskLock({ repoPath, taskId });
        throw error;
    }

    await logHandle.close();
    child.unref();

    await startRunRecord({
        repoPath,
        taskId,
        issueId: options.issue,
        issueNumber,
        pid,
    });

    console.log("Started AFK run in the background.");
    console.log(
        "Issue:",
        parseIssueUrl(options.issue) !== null
            ? options.issue
            : `#${issueNumber}`,
    );
    console.log("Task ID:", taskId);
    console.log("Branch:", `afk/${taskId}`);
    console.log("Log:", logPath);
    console.log(`Watch: afk logs --repo ${repoPath} --issue ${issueNumber}`);
    console.log(`Check: afk status --repo ${repoPath} --issue ${issueNumber}`);
    console.log(`Stop: afk stop --repo ${repoPath} --issue ${issueNumber}`);
}

const program = new Command();

const colors = createColors({
    isTTY: process.stdout.isTTY === true,
    env: process.env,
});

function printPhase(label: string): void {
    console.log(colors.cyan(`→ ${label}…`));
}

function printBanner(): void {
    console.log(
        `${colors.bold(program.name())} ${colors.dim(packageVersion())}`,
    );
    console.log(colors.dim(program.description()));
    console.log("");
}

function printOverview(): void {
    printBanner();
    console.log("Commands:");

    // Iterate registered commands so a new command can never be missing here.
    for (const command of program.commands) {
        const name = command.name();

        console.log(`  ${name.padEnd(8)}${command.description()}`);

        const example = commandExamples[name];

        if (example !== undefined) {
            console.log(`          Example: ${example}`);
        }
    }

    console.log("");
    console.log(
        "Add --background to 'afk run' to detach, then track it with status, logs, and stop.",
    );
    console.log("Run 'afk help <command>' for command details.");
}

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
            if (!(await reportPreflight(repoPath, false))) {
                return;
            }

            console.log("All checks passed. Building Sandbox image...");
            await prepareSandboxImage();
            console.log("Sandbox image ready:", DEFAULT_IMAGE);
        } catch (error) {
            console.error("AFK setup failed:", errorMessage(error));
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
        "--image <image>",
        "Use a prebuilt Sandbox image instead of building",
    )
    .option("--no-push", "Skip pushing the branch to GitHub")
    .option("--no-pr", "Skip opening a pull request")
    .option("--background", "Run in the background and return immediately")
    .action(async (options: RunOptions) => {
        printBanner();

        if (options.background === true) {
            await startBackgroundRun(options);
            return;
        }

        await executeRun(options, process.env["AFK_BACKGROUND_CHILD"] === "1");
    });

async function executeRun(
    options: RunOptions,
    backgroundChild: boolean,
): Promise<void> {
    let failureRepoPath: string | null = null;
    let failureTaskId: string | null = null;
    let failureIssueNumber: number | null = null;

    try {
        printPhase("Validating repository");
        if (!(await reportPreflight(options.repo))) {
            await markBackgroundFailure(
                options,
                "preflight",
                "Preflight checks failed",
            );
            return;
        }

        const repoPath = await validateRepository(options.repo);
        failureRepoPath = repoPath;
        console.log("Repository:", repoPath);

        // 1. Fetch GitHub issue
        printPhase(`Fetching Issue #${options.issue}`);
        const issue = await fetchGitHubIssue(repoPath, options.issue);
        failureIssueNumber = issue.number;

        console.log("\n--- GitHub Issue ---");
        console.log("Title:", issue.title);
        console.log("URL:", issue.url);

        // 2. Build agent prompt
        const prompt = buildIssuePrompt(issue);

        // 3. Execute task
        const existing = await findRunForIssue(repoPath, issue.number);
        const taskId = backgroundChild
            ? (process.env["AFK_TASK_ID"] ??
              existing?.taskId ??
              deriveTaskId(issue))
            : (existing?.taskId ?? deriveTaskId(issue));
        failureTaskId = taskId;

        if (backgroundChild) {
            await updateRunRecord({
                repoPath,
                taskId,
                issueId: options.issue,
                issueNumber: issue.number,
                state: "running",
                phase: "running",
                pid: process.pid,
            });
        } else {
            await acquireTaskLock({
                repoPath,
                taskId,
                issueId: options.issue,
            });
        }

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
                onPhase: async (phase) => {
                    printPhase(
                        phase === "image"
                            ? "Preparing Sandbox image"
                            : "Running Sandbox",
                    );

                    if (backgroundChild) {
                        await updateRunRecord({
                            repoPath,
                            taskId,
                            issueId: options.issue,
                            issueNumber: issue.number,
                            phase,
                        });
                    }
                },
                onAttempt: async (attempt) => {
                    if (backgroundChild) {
                        await updateRunRecord({
                            repoPath,
                            taskId,
                            issueId: options.issue,
                            issueNumber: issue.number,
                            attempts: attempt,
                        });
                    }
                },
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
                ...(options.cpus !== undefined ? { cpus: options.cpus } : {}),
                ...(options.pidsLimit !== undefined
                    ? { pidsLimit: options.pidsLimit }
                    : {}),
                ...(options.image !== undefined
                    ? { imageName: options.image, build: false }
                    : {}),
            });

            // 4. Display report
            const report = formatRunReport(result, {
                pushEnabled: options.push !== false,
                color: colors,
            });

            console.log("");
            console.log(report.text);
            process.exitCode = report.exitCode;

            if (backgroundChild) {
                await updateRunRecord({
                    repoPath,
                    taskId,
                    issueId: options.issue,
                    issueNumber: issue.number,
                    state: report.exitCode === 0 ? "succeeded" : "failed",
                    phase: "finished",
                    attempts: result.reports.length,
                    report: result.reports.at(-1) ?? null,
                    sync: result.sync,
                    error: result.error,
                    finishedAt: new Date().toISOString(),
                });
            }
        } finally {
            process.off("SIGINT", onSigint);
            process.off("SIGTERM", onSigterm);
            await releaseTaskLock({ repoPath, taskId });
        }
    } catch (error) {
        const message = errorMessage(error);

        if (
            backgroundChild &&
            failureRepoPath !== null &&
            failureTaskId !== null
        ) {
            await updateRunRecord({
                repoPath: failureRepoPath,
                taskId: failureTaskId,
                issueId: options.issue,
                issueNumber: failureIssueNumber ?? 0,
                state: "failed",
                phase: "failed",
                error: message,
                finishedAt: new Date().toISOString(),
            }).catch(() => undefined);
        }

        console.error("AFK Agent failed:", message);
        process.exitCode = 1;
    } finally {
        const taskId = process.env["AFK_TASK_ID"];

        if (backgroundChild && taskId !== undefined) {
            await releaseTaskLock({
                repoPath: path.resolve(options.repo),
                taskId,
            });
        }
    }
}

type StatusOptions = {
    repo: string;
    issue?: string;
};

async function markBackgroundFailure(
    options: RunOptions,
    phase: string,
    message: string,
): Promise<void> {
    const taskId = process.env["AFK_TASK_ID"];

    if (process.env["AFK_BACKGROUND_CHILD"] !== "1" || taskId === undefined) {
        return;
    }

    await updateRunRecord({
        repoPath: path.resolve(options.repo),
        taskId,
        issueId: options.issue,
        issueNumber: parseIssueNumber(options.issue),
        state: "failed",
        phase,
        error: message,
        finishedAt: new Date().toISOString(),
    }).catch(() => undefined);
}

async function tailRunLog(
    logPath: string,
    signal: AbortSignal,
    shouldContinue: () => Promise<boolean>,
): Promise<void> {
    let offset = 0;

    for (;;) {
        // shortcut: re-reads the whole log each poll; switch to a byte-range read if logs get large.
        const content = await readFile(logPath, "utf8").catch(() => "");

        if (content.length > offset) {
            process.stdout.write(content.slice(offset));
            offset = content.length;
        }

        if (signal.aborted || !(await shouldContinue())) {
            return;
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

program
    .command("status")
    .description("Show background run status")
    .requiredOption("--repo <path>", "Repository path")
    .option("--issue <number-or-url>", "GitHub issue number or URL")
    .action(async (options: StatusOptions) => {
        try {
            const repoPath = await validateRepository(options.repo);

            if (options.issue !== undefined) {
                const issueNumber = parseIssueNumber(options.issue);
                const record = await findRunForIssue(repoPath, issueNumber);

                if (record === null) {
                    console.error(`No runs found for issue ${issueNumber}.`);
                    process.exitCode = 1;
                    return;
                }

                console.log(formatRunDetail(record));
                return;
            }

            console.log(formatRunList(await listRunRecords(repoPath)));
        } catch (error) {
            console.error("Unable to read run status:", errorMessage(error));
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
            const record = await findRunForIssue(repoPath, issueNumber);

            console.log(
                colors.cyan(
                    `Sandbox logs for Issue #${issueNumber} in ${repoPath}`,
                ),
            );

            if (record === null) {
                await watchSandboxLogs({
                    repoPath,
                    issueNumber,
                    signal: controller.signal,
                });
                return;
            }

            if (resolveRunState(record) === "running") {
                try {
                    await watchSandboxLogs({
                        repoPath,
                        issueNumber,
                        signal: controller.signal,
                    });
                } catch (error) {
                    if (controller.signal.aborted) {
                        return;
                    }

                    const message = errorMessage(error);

                    if (!message.includes("No running agent")) {
                        throw error;
                    }
                }
            }

            await tailRunLog(record.logPath, controller.signal, async () => {
                const latest = await findRunForIssue(repoPath, issueNumber);

                return latest !== null && resolveRunState(latest) === "running";
            });

            if (!controller.signal.aborted) {
                console.log(
                    colors.cyan(
                        `End of logs for Issue #${issueNumber} in ${repoPath}.`,
                    ),
                );
            }
        } catch (error) {
            if (!controller.signal.aborted) {
                console.error("Unable to monitor agent:", errorMessage(error));
                process.exitCode = 1;
            }
        } finally {
            process.off("SIGINT", onSignal);
            process.off("SIGTERM", onSignal);
        }
    });

type StopOptions = {
    repo: string;
    issue: string;
};

program
    .command("stop")
    .description("Stop a running background AFK agent")
    .requiredOption("--repo <path>", "Repository path")
    .requiredOption("--issue <number-or-url>", "GitHub issue number or URL")
    .action(async (options: StopOptions) => {
        try {
            const repoPath = await validateRepository(options.repo);
            const issueNumber = parseIssueNumber(options.issue);
            const result = await stopRun({ repoPath, issueNumber });

            console.log("Stopped AFK run.");
            console.log("Task ID:", result.record.taskId);
            console.log("Branch kept:", result.record.branchName);

            if (result.cleanupError !== null) {
                console.error("Cleanup warning:", result.cleanupError);
            }
        } catch (error) {
            console.error(errorMessage(error));
            process.exitCode = 1;
        }
    });

program.action(() => {
    printOverview();
});

program
    .command("help [command]")
    .description("Display help for a command")
    .action((commandName?: string) => {
        if (commandName === undefined) {
            printOverview();
            return;
        }

        const command = program.commands.find(
            (item) => item.name() === commandName,
        );

        if (!command) {
            program.error(`error: unknown command '${commandName}'`);
            return;
        }

        command.help();
    });

program.parse();
