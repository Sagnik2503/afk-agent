import {
    ChildProcess,
    type ProcessOptions,
    type ProcessResult,
} from "../process.js";
import type { IssueLocation } from "./fetch_issues.js";

export type SyncRun = (
    command: string,
    args: string[],
    options?: ProcessOptions,
) => Promise<ProcessResult>;

export type SyncDependencies = {
    run?: SyncRun;
};

export type PushResult = {
    pushed: boolean;
    branchUrl: string | null;
    reason: string | null;
    baseRef: string | null;
};

export type CommitInfo = {
    sha: string;
    subject: string;
};

export type CommentInput = {
    taskId: string;
    success: boolean;
    attempts: number;
    branchName: string;
    issue: IssueLocation;
    push: PushResult;
    commits: CommitInfo[];
    testsPassed: boolean;
    changedFiles: number;
    reasons: string[];
    pr?: {
        url: string | null;
        error: string | null;
    };
};

const AFK_BRANCH = /^afk\//;
const GITHUB_REMOTE =
    /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i;
const MAX_COMMITS = 50;

const SECRET_PATTERNS = [
    /^\.env(\..*)?$/,
    /^credentials(\..*)?$/,
    /^\.npmrc$/,
    /^id_rsa(\..*)?$/,
    /^id_ed25519(\..*)?$/,
    /\.pem$/,
    /\.key$/,
    /\.p12$/,
    /\.pfx$/,
];

export function firstLine(text: string): string {
    return (
        text
            .split("\n")
            .find((line) => line.trim() !== "")
            ?.trim() ?? ""
    );
}

function parseGitHubRemote(
    url: string,
): { owner: string; repo: string } | null {
    const match = GITHUB_REMOTE.exec(url);
    if (!match) {
        return null;
    }

    const [, owner, repo] = match;
    if (!owner || !repo) {
        return null;
    }

    return { owner, repo };
}

export function isSecretFile(filePath: string): boolean {
    const name = filePath.slice(filePath.lastIndexOf("/") + 1);
    return SECRET_PATTERNS.some((pattern) => pattern.test(name));
}

export function formatCommitLines(
    commits: CommitInfo[],
    issue: IssueLocation,
): string[] {
    const lines = commits
        .slice(0, MAX_COMMITS)
        .map(
            (commit) =>
                `- [\`${commit.sha.slice(0, 7)}\`](https://github.com/${issue.owner}/${issue.repo}/commit/${commit.sha}) ${commit.subject}`,
        );

    const remaining = commits.length - MAX_COMMITS;
    if (remaining > 0) {
        lines.push(`- ... and ${remaining} more`);
    }

    return lines;
}

export async function getBaseRef(
    worktreePath: string,
    run: SyncRun = ChildProcess,
): Promise<string | null> {
    const head = await run(
        "git",
        ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        { cwd: worktreePath },
    );

    const candidates: string[] = [];
    if (head.exitCode === 0 && head.stdout.trim() !== "") {
        candidates.push(head.stdout.trim());
    }
    candidates.push("origin/main", "origin/master");

    for (const ref of candidates) {
        const mergeBase = await run("git", ["merge-base", "HEAD", ref], {
            cwd: worktreePath,
        });

        if (mergeBase.exitCode === 0 && mergeBase.stdout.trim() !== "") {
            return mergeBase.stdout.trim();
        }
    }

    return null;
}

async function changedFilesSince(
    worktreePath: string,
    baseRef: string,
    run: SyncRun,
): Promise<string[]> {
    const diff = await run("git", ["diff", "--name-only", `${baseRef}..HEAD`], {
        cwd: worktreePath,
    });

    if (diff.exitCode !== 0) {
        return [];
    }

    return diff.stdout.split("\n").filter((line) => line !== "");
}

export async function getCommits(
    worktreePath: string,
    baseRef: string | null,
    run: SyncRun = ChildProcess,
): Promise<CommitInfo[]> {
    const args = baseRef
        ? ["log", "--format=%H%x09%s", `${baseRef}..HEAD`]
        : ["log", "--format=%H%x09%s", "-50", "HEAD"];

    const log = await run("git", args, { cwd: worktreePath });

    if (log.exitCode !== 0) {
        return [];
    }

    return log.stdout
        .split("\n")
        .filter((line) => line !== "")
        .flatMap((line) => {
            const separator = line.indexOf("\t");
            if (separator === -1) {
                return [];
            }
            return [
                {
                    sha: line.slice(0, separator),
                    subject: line.slice(separator + 1),
                },
            ];
        });
}

export async function commitLeftovers(
    input: { worktreePath: string; taskId: string; attempt: number },
    deps: SyncDependencies = {},
): Promise<boolean> {
    const run = deps.run ?? ChildProcess;

    const status = await run("git", ["status", "--porcelain"], {
        cwd: input.worktreePath,
    });

    if (status.exitCode !== 0 || status.stdout.trim() === "") {
        return false;
    }

    const added = await run("git", ["add", "-A"], {
        cwd: input.worktreePath,
    });

    if (added.exitCode !== 0) {
        return false;
    }

    const commit = await run(
        "git",
        [
            "-c",
            "user.name=afk-agent",
            "-c",
            "user.email=afk-agent@localhost",
            "commit",
            "-m",
            `wip(afk): uncommitted work from attempt ${input.attempt}`,
            "-m",
            `AFK-Task: ${input.taskId}`,
        ],
        { cwd: input.worktreePath },
    );

    return commit.exitCode === 0;
}

export async function pushBranch(
    input: {
        worktreePath: string;
        branchName: string;
        issue: IssueLocation;
    },
    deps: SyncDependencies = {},
): Promise<PushResult> {
    const run = deps.run ?? ChildProcess;
    const refused = (reason: string, baseRef: string | null): PushResult => ({
        pushed: false,
        branchUrl: null,
        reason,
        baseRef,
    });

    if (!AFK_BRANCH.test(input.branchName)) {
        return refused("refusing to push outside the afk/ namespace", null);
    }

    // config, not `remote get-url`, so url.*.insteadOf rewrites stay local.
    const remote = await run("git", ["config", "--get", "remote.origin.url"], {
        cwd: input.worktreePath,
    });

    if (remote.exitCode !== 0) {
        return refused("no origin remote", null);
    }

    const remoteUrl = remote.stdout.trim();
    const parsed = parseGitHubRemote(remoteUrl);
    const expected = `${input.issue.owner}/${input.issue.repo}`;

    if (
        !parsed ||
        parsed.owner !== input.issue.owner ||
        parsed.repo !== input.issue.repo
    ) {
        return refused(`origin ${remoteUrl} does not match ${expected}`, null);
    }

    const baseRef = await getBaseRef(input.worktreePath, run);

    if (baseRef) {
        const changed = await changedFilesSince(
            input.worktreePath,
            baseRef,
            run,
        );
        const secretFiles = changed.filter(isSecretFile);

        if (secretFiles.length > 0) {
            return refused(
                `refusing to push secret-like files: ${secretFiles.join(", ")}`,
                baseRef,
            );
        }
    }

    const push = await run("git", ["push", "-u", "origin", input.branchName], {
        cwd: input.worktreePath,
        timeout: 60_000,
        env: {
            ...process.env,
            GIT_TERMINAL_PROMPT: "0",
        },
    });

    if (push.exitCode !== 0) {
        return refused(firstLine(push.stderr) || "git push failed", baseRef);
    }

    return {
        pushed: true,
        branchUrl: `https://github.com/${parsed.owner}/${parsed.repo}/tree/${input.branchName}`,
        reason: null,
        baseRef,
    };
}

export function buildIssueComment(input: CommentInput): string {
    const status = input.success ? "SUCCESS" : "FAILED";
    const lines = [`**AFK run** — ${status} (attempt ${input.attempts})`];

    if (input.push.pushed && input.push.branchUrl) {
        lines.push(`Branch: [${input.branchName}](${input.push.branchUrl})`);
    } else {
        lines.push(
            `Branch: \`${input.branchName}\` (not pushed: ${input.push.reason ?? "unknown"})`,
        );
    }

    if (input.pr?.url) {
        lines.push(`PR: ${input.pr.url}`);
    } else if (input.pr?.error) {
        lines.push(`PR: not created (${input.pr.error})`);
    }

    if (input.commits.length === 0) {
        lines.push("Commits: none");
    } else {
        lines.push("Commits:");
        lines.push(...formatCommitLines(input.commits, input.issue));
    }

    lines.push(
        `Tests: ${input.testsPassed ? "passing" : "failing"}. Files changed: ${input.changedFiles}.`,
    );

    if (input.reasons.length > 0) {
        lines.push(`Reasons: ${input.reasons.join("; ")}.`);
    }

    return lines.join("\n");
}

export async function postIssueComment(
    input: { issue: IssueLocation; body: string },
    deps: SyncDependencies = {},
): Promise<{ commented: boolean; error: string | null }> {
    const run = deps.run ?? ChildProcess;

    const result = await run(
        "gh",
        [
            "issue",
            "comment",
            String(input.issue.number),
            "--repo",
            `${input.issue.owner}/${input.issue.repo}`,
            "--body",
            input.body,
        ],
        { timeout: 30_000 },
    );

    if (result.timedOut) {
        return { commented: false, error: "GitHub comment timed out" };
    }

    if (result.exitCode !== 0) {
        return {
            commented: false,
            error: result.stderr.trim() || "Failed to comment on issue",
        };
    }

    return { commented: true, error: null };
}
