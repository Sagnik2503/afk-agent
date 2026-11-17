#!/usr/bin/env node
import { Command } from "commander";
import { runTask } from "./harness/orchestrator.js";
import {
    deriveTaskId,
    fetchGitHubIssue,
    parseIssueNumber,
} from "./github/fetch_issues.js";
import { validateRepository } from "./github/repo_validation.js";
import { buildIssuePrompt } from "./agent/prompt.js";
import { watchSandboxLogs } from "./agent/docker_runner.js";
import { packageVersion } from "./package_info.js";

const program = new Command();

program
    .name("afk-agent")
    .description("A safe, bounded AFK coding agent")
    .version(packageVersion());

program
    .command("run")
    .description("Run an AFK coding task")
    .requiredOption("--repo <path>", "Repository path")
    .requiredOption("--issue <id>", "GitHub issue ID")
    .option("--no-push", "Skip pushing the branch to GitHub")
    .option("--no-pr", "Skip opening a pull request")
    .action(async (options) => {
        try {
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
            const result = await runTask({
                repoPath,
                taskId: deriveTaskId(issue),
                issueId: options.issue,
                issue,
                prompt,
                push: options.push !== false,
                pr: options.pr !== false,
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
                console.error("Worktree cleanup failed:", result.cleanupError);
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
                    console.warn("Pull request warning:", result.sync.prError);
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
