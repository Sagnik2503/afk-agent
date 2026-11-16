import { ChildProcess } from "../process.js";
import type { GitHubIssue, IssueLocation } from "./fetch_issues.js";
import {
    firstLine,
    formatCommitLines,
    type CommitInfo,
    type SyncDependencies,
    type SyncRun,
} from "./sync.js";

export type PullRequestInput = {
    worktreePath: string;
    branchName: string;
    issue: IssueLocation;
    baseBranch: string;
    title: string;
    body: string;
    rerunComment: string;
};

export type PullRequestResult = {
    created: boolean;
    reused: boolean;
    url: string | null;
    error: string | null;
};

export type PullRequestBodyInput = {
    issue: GitHubIssue;
    taskId: string;
    attempts: number;
    testsPassed: boolean;
    changedFiles: number;
    commits: CommitInfo[];
};

export async function resolveBaseBranch(
    worktreePath: string,
    run: SyncRun = ChildProcess,
): Promise<string> {
    const head = await run(
        "git",
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { cwd: worktreePath },
    );

    if (head.exitCode === 0) {
        const detected = head.stdout.trim().replace(/^origin\//, "");
        if (detected !== "") {
            return detected;
        }
    }

    for (const candidate of ["main", "master"]) {
        const exists = await run(
            "git",
            [
                "rev-parse",
                "--verify",
                "--quiet",
                `refs/remotes/origin/${candidate}`,
            ],
            { cwd: worktreePath },
        );

        if (exists.exitCode === 0) {
            return candidate;
        }
    }

    return "main";
}

export function buildPullRequestBody(input: PullRequestBodyInput): string {
    const { issue } = input;
    const lines = [
        `Closes #${issue.number}`,
        "",
        `Issue: [#${issue.number} — ${issue.title}](${issue.url})`,
        "",
        "## AFK run",
        "",
        `- Task: \`${input.taskId}\``,
        `- Attempts: ${input.attempts}`,
        `- Tests: ${input.testsPassed ? "passing" : "failing"}`,
        `- Files changed: ${input.changedFiles}`,
        "",
        "### Commits",
    ];

    if (input.commits.length === 0) {
        lines.push("None");
    } else {
        lines.push(...formatCommitLines(input.commits, issue));
    }

    return lines.join("\n");
}

function existingPullRequestUrl(stdout: string): string | null {
    try {
        const parsed: unknown = JSON.parse(stdout);
        if (!Array.isArray(parsed)) {
            return null;
        }

        const first: unknown = parsed[0];
        if (
            typeof first === "object" &&
            first !== null &&
            "url" in first &&
            typeof first.url === "string" &&
            first.url !== ""
        ) {
            return first.url;
        }
    } catch {
        return null;
    }

    return null;
}

export async function openPullRequest(
    input: PullRequestInput,
    deps: SyncDependencies = {},
): Promise<PullRequestResult> {
    const run = deps.run ?? ChildProcess;
    const repo = `${input.issue.owner}/${input.issue.repo}`;

    const lookup = await run(
        "gh",
        [
            "pr",
            "list",
            "--repo",
            repo,
            "--head",
            input.branchName,
            "--state",
            "open",
            "--json",
            "url",
        ],
        { timeout: 30_000 },
    );

    if (lookup.timedOut) {
        return {
            created: false,
            reused: false,
            url: null,
            error: "GitHub pull request lookup timed out",
        };
    }

    if (lookup.exitCode !== 0) {
        return {
            created: false,
            reused: false,
            url: null,
            error:
                firstLine(lookup.stderr) ||
                "Failed to look up open pull requests",
        };
    }

    const existingUrl = existingPullRequestUrl(lookup.stdout);

    if (existingUrl) {
        const comment = await run(
            "gh",
            [
                "pr",
                "comment",
                existingUrl,
                "--repo",
                repo,
                "--body",
                input.rerunComment,
            ],
            { timeout: 30_000 },
        );

        if (comment.timedOut) {
            return {
                created: false,
                reused: true,
                url: existingUrl,
                error: "GitHub pull request comment timed out",
            };
        }

        if (comment.exitCode !== 0) {
            return {
                created: false,
                reused: true,
                url: existingUrl,
                error:
                    firstLine(comment.stderr) ||
                    "Failed to comment on pull request",
            };
        }

        return { created: false, reused: true, url: existingUrl, error: null };
    }

    const created = await run(
        "gh",
        [
            "pr",
            "create",
            "--repo",
            repo,
            "--head",
            input.branchName,
            "--base",
            input.baseBranch,
            "--title",
            input.title,
            "--body",
            input.body,
        ],
        { timeout: 60_000 },
    );

    if (created.timedOut) {
        return {
            created: false,
            reused: false,
            url: null,
            error: "GitHub pull request creation timed out",
        };
    }

    if (created.exitCode !== 0) {
        return {
            created: false,
            reused: false,
            url: null,
            error: firstLine(created.stderr) || "Failed to create pull request",
        };
    }

    const url = firstLine(created.stdout);

    if (url === "") {
        return {
            created: false,
            reused: false,
            url: null,
            error: "Pull request created without a URL",
        };
    }

    return { created: true, reused: false, url, error: null };
}
