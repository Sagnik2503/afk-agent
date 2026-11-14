import { ChildProcess } from "../process.js";

export type GitHubIssue = {
    number: number;
    owner: string;
    repo: string;
    title: string;
    body: string;
    url: string;
};

export type IssueLocation = {
    owner: string;
    repo: string;
    number: number;
};

const ISSUE_URL =
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/;

export function parseIssueUrl(url: string): IssueLocation | null {
    const match = ISSUE_URL.exec(url);
    if (!match) {
        return null;
    }

    const [, owner, repo, number] = match;
    if (!owner || !repo || !number) {
        return null;
    }

    return { owner, repo, number: Number(number) };
}

export function slugify(title: string): string {
    return title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)
        .replace(/-+$/g, "");
}

export function deriveTaskId(issue: GitHubIssue): string {
    const slug = slugify(issue.title);
    return slug ? `issue-${issue.number}-${slug}` : `issue-${issue.number}`;
}

export async function fetchGitHubIssue(
    repoPath: string,
    issueId: string,
): Promise<GitHubIssue> {
    const result = await ChildProcess(
        "gh",
        ["issue", "view", issueId, "--json", "number,title,body,url"],
        {
            cwd: repoPath,
            timeout: 30_000,
        },
    );

    if (result.timedOut) {
        throw new Error("GitHub issue fetch timed out");
    }

    if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || "Failed to fetch GitHub issue");
    }

    const issue = JSON.parse(result.stdout);
    const location = parseIssueUrl(issue.url ?? "");

    if (!location) {
        throw new Error(`Cannot parse GitHub issue URL: ${issue.url}`);
    }

    return {
        number: location.number,
        owner: location.owner,
        repo: location.repo,
        title: issue.title,
        body: issue.body ?? "",
        url: issue.url,
    };
}
