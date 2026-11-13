
import { ChildProcess } from "../process.js";

export type GitHubIssue = {
  title: string;
  body: string;
  url: string;
};

export async function fetchGitHubIssue(
  repoPath: string,
  issueId: string
): Promise<GitHubIssue> {
  const result = await ChildProcess(
    "gh",
    [
      "issue",
      "view",
      issueId,
      "--json",
      "title,body,url",
    ],
    {
      cwd: repoPath,
      timeout: 30_000,
    }
  );

  if (result.timedOut) {
    throw new Error("GitHub issue fetch timed out");
  }

  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || "Failed to fetch GitHub issue"
    );
  }

  const issue = JSON.parse(result.stdout);

  return {
    title: issue.title,
    body: issue.body ?? "",
    url: issue.url,
  };
}