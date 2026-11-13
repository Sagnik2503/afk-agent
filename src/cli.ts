import { Command } from "commander";
import { runTask } from "./harness/orchestrator.js";

const program = new Command();

program
  .name("afk-agent")
  .description("A safe, bounded AFK coding agent")
  .version("1.0.0");

program
  .command("run")
  .description("Run an AFK coding task")
  .requiredOption("--repo <path>", "Repository path")
  .requiredOption("--task <id>", "Internal task ID")
  .requiredOption("--issue <id>", "External issue ID")
  .requiredOption("--prompt <text>", "Task instructions")
  .action((options) => {
    console.log("Repository:", options.repo);
    console.log("Task:", options.task);
    console.log("Issue:", options.issue);
  });

program
  .action(async (options) => {
  try {
    const result = await runTask({
      repoPath: options.repo,
      taskId: options.task,
      issueId: options.issue,
      prompt: options.prompt,
    });

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

    console.log("\nTask completed.");
    console.log("Branch:", result.branchName);
    console.log("Worktree:", result.worktreePath);
    console.log("Reports:", result.reports.length);

    if (result.error) {
      console.error("Error:", result.error);
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