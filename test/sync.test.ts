import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChildProcess } from "../src/process.js";
import type { ProcessResult } from "../src/process.js";
import {
    buildIssueComment,
    commitLeftovers,
    getCommits,
    isSecretFile,
    postIssueComment,
    pushBranch,
} from "../src/github/sync.js";

const issue = { owner: "test-owner", repo: "test-repo", number: 1 };
const originUrl = "https://github.com/test-owner/test-repo.git";

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

async function git(cwd: string, args: string[]): Promise<ProcessResult> {
    const output = await ChildProcess("git", args, { cwd });
    if (output.exitCode !== 0) {
        throw new Error(`git ${args.join(" ")}: ${output.stderr}`);
    }
    return output;
}

async function makeRepo(): Promise<{
    root: string;
    repo: string;
    origin: string;
}> {
    const root = await mkdtemp(join(tmpdir(), "afk-agent-sync-"));
    const repo = join(root, "repo");
    const origin = join(root, "origin.git");

    await mkdir(repo);
    await git(root, ["init", "-q", "--bare", origin]);
    await git(repo, ["init", "-q"]);
    await git(repo, [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        "init",
    ]);
    await git(repo, ["branch", "-M", "main"]);
    await git(repo, ["remote", "add", "origin", originUrl]);
    await git(repo, ["config", `url.${origin}.insteadOf`, originUrl]);
    await git(repo, ["push", "-q", "-u", "origin", "main"]);

    return { root, repo, origin };
}

async function startBranch(repo: string, branch: string): Promise<void> {
    await git(repo, ["checkout", "-q", "-b", branch]);
}

describe("isSecretFile", () => {
    it("matches environment and credential files", () => {
        expect(isSecretFile(".env")).toBe(true);
        expect(isSecretFile(".env.local")).toBe(true);
        expect(isSecretFile("config/id_rsa")).toBe(true);
        expect(isSecretFile("certs/server.pem")).toBe(true);
        expect(isSecretFile("test/credentials.ts")).toBe(true);
    });

    it("allows ordinary source files", () => {
        expect(isSecretFile("src/slug.ts")).toBe(false);
        expect(isSecretFile("test/slug.test.ts")).toBe(false);
        expect(isSecretFile("README.md")).toBe(false);
    });
});

describe("buildIssueComment", () => {
    const commits = [
        {
            sha: "a1b2c3d4e5f6",
            subject: "feat(slug): add slugify helper",
        },
    ];
    const push = {
        pushed: true,
        branchUrl: "https://github.com/test-owner/test-repo/tree/afk/issue-1-x",
        reason: null,
        baseRef: "deadbeef",
    };
    const base = {
        taskId: "issue-1-x",
        branchName: "afk/issue-1-x",
        issue,
        commits,
        testsPassed: true,
        changedFiles: 3,
        reasons: [] as string[],
    };

    it("describes a successful pushed run", () => {
        const body = buildIssueComment({
            ...base,
            success: true,
            attempts: 2,
            push,
        });

        expect(body).toContain("SUCCESS (attempt 2)");
        expect(body).toContain(
            "[afk/issue-1-x](https://github.com/test-owner/test-repo/tree/afk/issue-1-x)",
        );
        expect(body).toContain(
            "[`a1b2c3d`](https://github.com/test-owner/test-repo/commit/a1b2c3d4e5f6)",
        );
        expect(body).toContain("Tests: passing");
        expect(body).toContain("Files changed: 3");
    });

    it("explains why a branch was not pushed", () => {
        const body = buildIssueComment({
            ...base,
            success: false,
            attempts: 3,
            reasons: ["tests failed"],
            push: {
                pushed: false,
                branchUrl: null,
                reason: "origin mismatch",
                baseRef: null,
            },
        });

        expect(body).toContain("FAILED (attempt 3)");
        expect(body).toContain("not pushed: origin mismatch");
        expect(body).toContain("tests failed");
    });

    it("caps a long commit list", () => {
        const many = Array.from({ length: 60 }, (_, index) => ({
            sha: `sha${index}`,
            subject: `change ${index}`,
        }));

        const body = buildIssueComment({
            ...base,
            commits: many,
            success: true,
            attempts: 1,
            push,
        });

        expect(body).toContain("and 10 more");
    });
});

describe("pushBranch", () => {
    let root = "";
    let repo = "";
    let origin = "";

    beforeEach(async () => {
        ({ root, repo, origin } = await makeRepo());
    });

    afterEach(async () => {
        if (root) {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("refuses to push outside the afk/ namespace", async () => {
        const outcome = await pushBranch({
            worktreePath: repo,
            branchName: "main",
            issue,
        });

        expect(outcome.pushed).toBe(false);
        expect(outcome.reason).toContain("afk/");
    });

    it("refuses when origin does not match the issue repository", async () => {
        await startBranch(repo, "afk/issue-1-x");
        await git(repo, [
            "remote",
            "set-url",
            "origin",
            "https://github.com/other/repo.git",
        ]);

        const outcome = await pushBranch({
            worktreePath: repo,
            branchName: "afk/issue-1-x",
            issue,
        });

        expect(outcome.pushed).toBe(false);
        expect(outcome.reason).toContain("does not match");
    });

    it("pushes the afk branch and reports its URL", async () => {
        await startBranch(repo, "afk/issue-1-x");
        await writeFile(join(repo, "slug.ts"), "export const slug = 1;\n");
        await git(repo, ["add", "."]);
        await git(repo, [
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "-q",
            "-m",
            "feat: add slug",
        ]);

        const outcome = await pushBranch({
            worktreePath: repo,
            branchName: "afk/issue-1-x",
            issue,
        });

        expect(outcome.pushed).toBe(true);
        expect(outcome.branchUrl).toBe(
            "https://github.com/test-owner/test-repo/tree/afk/issue-1-x",
        );

        const remote = await ChildProcess(
            "git",
            ["--git-dir", origin, "rev-parse", "--verify", "afk/issue-1-x"],
            {},
        );
        expect(remote.exitCode).toBe(0);
    });

    it("refuses to push when a secret-like file changed", async () => {
        await startBranch(repo, "afk/issue-1-x");
        await writeFile(join(repo, ".env"), "TOKEN=abc\n");
        await git(repo, ["add", "."]);
        await git(repo, [
            "-c",
            "user.email=test@example.com",
            "-c",
            "user.name=Test",
            "commit",
            "-q",
            "-m",
            "chore: add env",
        ]);

        const outcome = await pushBranch({
            worktreePath: repo,
            branchName: "afk/issue-1-x",
            issue,
        });

        expect(outcome.pushed).toBe(false);
        expect(outcome.reason).toContain(".env");

        const remote = await ChildProcess(
            "git",
            ["--git-dir", origin, "rev-parse", "--verify", "afk/issue-1-x"],
            {},
        );
        expect(remote.exitCode).not.toBe(0);
    });
});

describe("commitLeftovers", () => {
    let root = "";
    let repo = "";

    beforeEach(async () => {
        ({ root, repo } = await makeRepo());
    });

    afterEach(async () => {
        if (root) {
            await rm(root, { recursive: true, force: true });
        }
    });

    it("commits a dirty worktree with the afk identity", async () => {
        await writeFile(join(repo, "leftover.ts"), "export const x = 1;\n");

        const committed = await commitLeftovers({
            worktreePath: repo,
            taskId: "issue-1-x",
            attempt: 2,
        });

        expect(committed).toBe(true);

        const status = await git(repo, ["status", "--porcelain"]);
        expect(status.stdout.trim()).toBe("");

        const log = await git(repo, ["log", "-1", "--format=%s|%an"]);
        expect(log.stdout.trim()).toBe(
            "wip(afk): uncommitted work from attempt 2|afk-agent",
        );
    });

    it("does nothing when the worktree is clean", async () => {
        const committed = await commitLeftovers({
            worktreePath: repo,
            taskId: "issue-1-x",
            attempt: 1,
        });

        expect(committed).toBe(false);
    });
});

describe("getCommits", () => {
    it("lists commits since the base ref", async () => {
        const { root, repo } = await makeRepo();

        try {
            await startBranch(repo, "afk/issue-1-x");
            await writeFile(join(repo, "a.ts"), "a\n");
            await git(repo, ["add", "."]);
            await git(repo, [
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Test",
                "commit",
                "-q",
                "-m",
                "feat: first",
            ]);

            const base = await git(repo, ["merge-base", "HEAD", "origin/main"]);
            const commits = await getCommits(repo, base.stdout.trim());

            expect(commits).toHaveLength(1);
            expect(commits[0]?.subject).toBe("feat: first");
        } finally {
            await rm(root, { recursive: true, force: true });
        }
    });
});

describe("postIssueComment", () => {
    it("posts the body to the issue repository", async () => {
        const run = vi.fn(async () => result());

        const outcome = await postIssueComment(
            { issue, body: "hello" },
            { run },
        );

        expect(outcome).toEqual({ commented: true, error: null });
        expect(run).toHaveBeenCalledWith(
            "gh",
            [
                "issue",
                "comment",
                "1",
                "--repo",
                "test-owner/test-repo",
                "--body",
                "hello",
            ],
            expect.objectContaining({ timeout: 30_000 }),
        );
    });

    it("reports a comment failure without throwing", async () => {
        const run = vi.fn(async () =>
            result({ exitCode: 1, stderr: "gh: not authenticated" }),
        );

        const outcome = await postIssueComment(
            { issue, body: "hello" },
            { run },
        );

        expect(outcome).toEqual({
            commented: false,
            error: "gh: not authenticated",
        });
    });
});
