import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessResult } from "../src/process.js";
import {
    formatPreflightFailures,
    runPreflight,
    type PreflightRun,
} from "../src/preflight.js";

function result(
    exitCode = 0,
    overrides: Partial<ProcessResult> = {},
): ProcessResult {
    return {
        stdout: "",
        stderr: "",
        exitCode,
        signal: null,
        timedOut: false,
        outputTruncated: false,
        ...overrides,
    };
}

function passingRun(): PreflightRun {
    return vi.fn(async () => result());
}

const repos: string[] = [];

async function makeRepo(config?: string): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "afk-preflight-"));
    repos.push(repo);

    if (config !== undefined) {
        await mkdir(join(repo, ".afk"), { recursive: true });
        await writeFile(join(repo, ".afk", "config.json"), config);
    }

    return repo;
}

const configured = '{"validate":[]}';

afterEach(async () => {
    await Promise.all(
        repos
            .splice(0)
            .map((repo) => rm(repo, { recursive: true, force: true })),
    );
});

describe("runPreflight", () => {
    it("returns no failures when every check passes", async () => {
        const repoPath = await makeRepo(configured);
        const run = passingRun();

        await expect(runPreflight({ repoPath, run })).resolves.toEqual([]);

        expect(run).toHaveBeenCalledWith("git", ["--version"], {
            timeout: 10_000,
        });
        expect(run).toHaveBeenCalledWith("docker", ["info"], {
            timeout: 30_000,
        });
        expect(run).toHaveBeenCalledWith("gh", ["auth", "status"], {
            timeout: 30_000,
        });
        expect(run).toHaveBeenCalledWith(
            "git",
            ["rev-parse", "--show-toplevel"],
            { cwd: repoPath, timeout: 10_000 },
        );
    });

    it("reports Git when it cannot be run", async () => {
        const repoPath = await makeRepo(configured);
        const run: PreflightRun = vi.fn(async (command) => {
            if (command === "git") {
                throw new Error("spawn git ENOENT");
            }
            return result();
        });

        const failures = await runPreflight({ repoPath, run });

        expect(failures.map((failure) => failure.check)).toContain("Git");
    });

    it("reports the Docker daemon when it is not running", async () => {
        const repoPath = await makeRepo(configured);
        const run: PreflightRun = vi.fn(async (command) =>
            command === "docker" ? result(1) : result(),
        );

        const failures = await runPreflight({ repoPath, run });

        expect(failures).toEqual([
            expect.objectContaining({ check: "Docker daemon" }),
        ]);
    });

    it("reports the GitHub CLI when it is not authenticated", async () => {
        const repoPath = await makeRepo(configured);
        const run: PreflightRun = vi.fn(async (command) =>
            command === "gh" ? result(1) : result(),
        );

        const failures = await runPreflight({ repoPath, run });

        expect(failures).toEqual([
            expect.objectContaining({ check: "GitHub CLI" }),
        ]);
    });

    it("reports a path that is not a Git repository", async () => {
        const repoPath = await makeRepo(configured);
        const run: PreflightRun = vi.fn(async (_command, args) =>
            args[0] === "rev-parse" ? result(128) : result(),
        );

        const failures = await runPreflight({ repoPath, run });

        expect(failures).toEqual([
            expect.objectContaining({ check: "Git repository" }),
        ]);
    });

    it("reports every failed check at once", async () => {
        const repoPath = await makeRepo(configured);
        const run: PreflightRun = vi.fn(async () => result(1));

        const failures = await runPreflight({ repoPath, run });

        expect(failures.map((failure) => failure.check)).toEqual([
            "Git",
            "Docker daemon",
            "GitHub CLI",
            "Git repository",
        ]);
    });

    it("refuses a run when the config file is missing", async () => {
        const repoPath = await makeRepo();

        const failures = await runPreflight({
            repoPath,
            run: passingRun(),
        });

        expect(failures).toEqual([
            expect.objectContaining({
                check: "Validation config",
                guidance: expect.stringContaining("validate"),
            }),
        ]);
    });

    it("refuses a run when the validate key is missing", async () => {
        const repoPath = await makeRepo(JSON.stringify({ model: "x" }));

        const failures = await runPreflight({
            repoPath,
            run: passingRun(),
        });

        expect(failures).toEqual([
            expect.objectContaining({
                check: "Validation config",
                guidance: expect.stringContaining("validate"),
            }),
        ]);
    });

    it("refuses a run when the dockerfile key points at a missing file", async () => {
        const repoPath = await makeRepo(
            JSON.stringify({ validate: [], dockerfile: ".afk/Dockerfile" }),
        );

        const failures = await runPreflight({
            repoPath,
            run: passingRun(),
        });

        expect(failures).toEqual([
            expect.objectContaining({
                check: "Validation config",
                guidance: expect.stringContaining("Dockerfile"),
            }),
        ]);
    });

    it("accepts an empty validate list as a deliberate opt-out", async () => {
        const repoPath = await makeRepo(configured);

        await expect(
            runPreflight({ repoPath, run: passingRun() }),
        ).resolves.toEqual([]);
    });

    it("includes actionable guidance in the formatted report", () => {
        const report = formatPreflightFailures([
            { check: "Docker daemon", guidance: "Start Docker." },
        ]);

        expect(report).toContain("Docker daemon: Start Docker.");
    });
});
