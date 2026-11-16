import { describe, it, expect, vi } from "vitest";
import type { ProcessResult } from "../src/process.js";
import type { GitHubIssue } from "../src/github/fetch_issues.js";
import {
    buildPullRequestBody,
    openPullRequest,
    resolveBaseBranch,
} from "../src/github/pull_request.js";

const issue: GitHubIssue = {
    number: 42,
    owner: "test-owner",
    repo: "test-repo",
    title: "Add a slug helper",
    body: "",
    url: "https://github.com/test-owner/test-repo/issues/42",
};

function result(overrides: Partial<ProcessResult> = {}): ProcessResult {
    return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        signal: null,
        timedOut: false,
        outputTruncated: false,
        ...overrides,
    };
}

describe("resolveBaseBranch", () => {
    it("uses the branch behind origin/HEAD", async () => {
        const run = vi.fn(async () => result({ stdout: "origin/develop\n" }));

        const branch = await resolveBaseBranch("/worktree", run);

        expect(branch).toBe("develop");
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith(
            "git",
            ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
            { cwd: "/worktree" },
        );
    });

    it("falls back to main when origin/HEAD is missing", async () => {
        const run = vi.fn(async (_command: string, args: string[]) =>
            args.at(-1) === "refs/remotes/origin/main"
                ? result()
                : result({ exitCode: 1 }),
        );

        expect(await resolveBaseBranch("/worktree", run)).toBe("main");
    });

    it("falls back to master when main is missing", async () => {
        const run = vi.fn(async (_command: string, args: string[]) =>
            args.at(-1) === "refs/remotes/origin/master"
                ? result()
                : result({ exitCode: 1 }),
        );

        expect(await resolveBaseBranch("/worktree", run)).toBe("master");
    });

    it("returns main when no candidate exists", async () => {
        const run = vi.fn(async () => result({ exitCode: 1 }));

        expect(await resolveBaseBranch("/worktree", run)).toBe("main");
    });
});

describe("buildPullRequestBody", () => {
    const commits = [
        {
            sha: "a1b2c3d4e5f6",
            subject: "feat(slug): add slugify helper",
        },
    ];

    it("links the issue, closes it, and summarizes the run", () => {
        const body = buildPullRequestBody({
            issue,
            taskId: "issue-42-add-a-slug-helper",
            attempts: 2,
            testsPassed: true,
            changedFiles: 3,
            commits,
        });

        expect(body).toContain("Closes #42");
        expect(body).toContain(
            "[#42 — Add a slug helper](https://github.com/test-owner/test-repo/issues/42)",
        );
        expect(body).toContain("issue-42-add-a-slug-helper");
        expect(body).toContain("Attempts: 2");
        expect(body).toContain("Tests: passing");
        expect(body).toContain("Files changed: 3");
        expect(body).toContain(
            "[`a1b2c3d`](https://github.com/test-owner/test-repo/commit/a1b2c3d4e5f6)",
        );
        expect(body).toContain("feat(slug): add slugify helper");
    });

    it("caps a long commit list", () => {
        const many = Array.from({ length: 60 }, (_, index) => ({
            sha: `sha${index}`,
            subject: `change ${index}`,
        }));

        const body = buildPullRequestBody({
            issue,
            taskId: "task",
            attempts: 1,
            testsPassed: false,
            changedFiles: 1,
            commits: many,
        });

        expect(body).toContain("and 10 more");
    });
});

describe("openPullRequest", () => {
    const input = {
        worktreePath: "/worktree",
        branchName: "afk/task-1",
        issue,
        baseBranch: "main",
        title: "Add a slug helper",
        body: "Closes #42",
        rerunComment: "AFK re-run: attempt 2, tests passing, 3 files changed.",
    };

    it("creates a pull request and returns its URL", async () => {
        const run = vi.fn(async (_command: string, args: string[]) =>
            args[1] === "list"
                ? result({ stdout: "[]" })
                : result({
                      stdout: "https://github.com/test-owner/test-repo/pull/7\n",
                  }),
        );

        const outcome = await openPullRequest(input, { run });

        expect(outcome).toEqual({
            created: true,
            reused: false,
            url: "https://github.com/test-owner/test-repo/pull/7",
            error: null,
        });
        expect(run).toHaveBeenCalledWith(
            "gh",
            [
                "pr",
                "list",
                "--repo",
                "test-owner/test-repo",
                "--head",
                "afk/task-1",
                "--state",
                "open",
                "--json",
                "url",
            ],
            expect.objectContaining({ timeout: 30_000 }),
        );
        expect(run).toHaveBeenCalledWith(
            "gh",
            [
                "pr",
                "create",
                "--repo",
                "test-owner/test-repo",
                "--head",
                "afk/task-1",
                "--base",
                "main",
                "--title",
                "Add a slug helper",
                "--body",
                "Closes #42",
            ],
            expect.objectContaining({ timeout: 60_000 }),
        );
    });

    it("reuses an open pull request and posts the re-run comment", async () => {
        const url = "https://github.com/test-owner/test-repo/pull/3";
        const run = vi.fn(async (_command: string, args: string[]) =>
            args[1] === "list"
                ? result({ stdout: JSON.stringify([{ url }]) })
                : result(),
        );

        const outcome = await openPullRequest(input, { run });

        expect(outcome).toEqual({
            created: false,
            reused: true,
            url,
            error: null,
        });
        expect(run).toHaveBeenCalledWith(
            "gh",
            [
                "pr",
                "comment",
                url,
                "--repo",
                "test-owner/test-repo",
                "--body",
                input.rerunComment,
            ],
            expect.objectContaining({ timeout: 30_000 }),
        );
        expect(run).not.toHaveBeenCalledWith(
            "gh",
            expect.arrayContaining(["create"]),
            expect.anything(),
        );
    });

    it("reports a re-run comment failure but keeps the reused URL", async () => {
        const url = "https://github.com/test-owner/test-repo/pull/3";
        const run = vi.fn(async (_command: string, args: string[]) =>
            args[1] === "list"
                ? result({ stdout: JSON.stringify([{ url }]) })
                : result({ exitCode: 1, stderr: "comment failed" }),
        );

        const outcome = await openPullRequest(input, { run });

        expect(outcome).toEqual({
            created: false,
            reused: true,
            url,
            error: "comment failed",
        });
    });

    it("reports a lookup timeout without throwing", async () => {
        const run = vi.fn(async () => result({ timedOut: true }));

        const outcome = await openPullRequest(input, { run });

        expect(outcome.created).toBe(false);
        expect(outcome.reused).toBe(false);
        expect(outcome.url).toBeNull();
        expect(outcome.error).toContain("timed out");
    });

    it("reports a create failure from stderr", async () => {
        const run = vi.fn(async (_command: string, args: string[]) =>
            args[1] === "list"
                ? result({ stdout: "[]" })
                : result({ exitCode: 1, stderr: "gh: not authenticated" }),
        );

        const outcome = await openPullRequest(input, { run });

        expect(outcome).toEqual({
            created: false,
            reused: false,
            url: null,
            error: "gh: not authenticated",
        });
    });

    it("reports a create timeout without throwing", async () => {
        const run = vi.fn(async (_command: string, args: string[]) =>
            args[1] === "list"
                ? result({ stdout: "[]" })
                : result({ timedOut: true }),
        );

        const outcome = await openPullRequest(input, { run });

        expect(outcome.created).toBe(false);
        expect(outcome.error).toContain("timed out");
    });
});
