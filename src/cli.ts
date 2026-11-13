
import { randomUUID } from "node:crypto";
import { Command } from "commander";
import { runTask } from "./harness/orchestrator.js";
import { fetchGitHubIssue } from "./github/fetch_issues.js";
import { validateRepository } from "./github/repo_validation.js";
import { buildIssuePrompt } from "./agent/prompt.js";

const program = new Command();

program
  .name("afk-agent")
  .description("A safe, bounded AFK coding agent")
  .version("1.0.0");

program
  .command("run")
  .description("Run an AFK coding task")
  .requiredOption("--repo <path>", "Repository path")
  .requiredOption("--issue <id>", "GitHub issue ID")
  .action(async (options) => {
    try {
      const repoPath = await validateRepository(options.repo);
      console.log("Validated repository:", repoPath);
      
      // 1. Fetch GitHub issue
      const issue = await fetchGitHubIssue(
        repoPath,
        options.issue
      );

      console.log("\n--- GitHub Issue ---");
      console.log("Title:", issue.title);
      console.log("URL:", issue.url);

      // 2. Build agent prompt
      const prompt = buildIssuePrompt(issue);

      // 3. Execute task
      const result = await runTask({
        repoPath,
        taskId: randomUUID(),
        issueId: options.issue,
        prompt,
      });

      // 4. Display report
      const lastReport = result.reports.at(-1);

      console.log("\n--- AFK Agent Report ---");
      console.log("Branch:", result.branchName);
      console.log("Worktree:", result.worktreePath);
      console.log("Attempts:", result.reports.length);

      if (result.error) {
        console.error("Execution error:", result.error);
        process.exitCode = 1;
      } else if (lastReport?.success) {
        console.log("Status: SUCCESS");
      } else {
        console.log("Status: FAILED");
        process.exitCode = 1;
      }

      if (lastReport) {
        console.log("Changed files:", lastReport.changedFiles);
        console.log("Reasons:", lastReport.reasons);
      }
    } catch (error) {
      console.error(
        "AFK Agent failed:",
        error instanceof Error ? error.message : error
      );
      process.exitCode = 1;
    }
  });

program.parse();