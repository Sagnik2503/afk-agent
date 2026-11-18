import { describe, expect, it, vi } from "vitest";
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

describe("runPreflight", () => {
    it("returns no failures when every check passes", async () => {
        const run = passingRun();

        await expect(runPreflight({ repoPath: "/repo", run })).resolves.toEqual(
            [],
        );

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
            { cwd: "/repo", timeout: 10_000 },
        );
    });

    it("reports Git when it cannot be run", async () => {
        const run: PreflightRun = vi.fn(async (command) => {
            if (command === "git") {
                throw new Error("spawn git ENOENT");
            }
            return result();
        });

        const failures = await runPreflight({ repoPath: "/repo", run });

        expect(failures.map((failure) => failure.check)).toContain("Git");
    });

    it("reports the Docker daemon when it is not running", async () => {
        const run: PreflightRun = vi.fn(async (command) =>
            command === "docker" ? result(1) : result(),
        );

        const failures = await runPreflight({ repoPath: "/repo", run });

        expect(failures).toEqual([
            expect.objectContaining({ check: "Docker daemon" }),
        ]);
    });

    it("reports the GitHub CLI when it is not authenticated", async () => {
        const run: PreflightRun = vi.fn(async (command) =>
            command === "gh" ? result(1) : result(),
        );

        const failures = await runPreflight({ repoPath: "/repo", run });

        expect(failures).toEqual([
            expect.objectContaining({ check: "GitHub CLI" }),
        ]);
    });

    it("reports a path that is not a Git repository", async () => {
        const run: PreflightRun = vi.fn(async (_command, args) =>
            args[0] === "rev-parse" ? result(128) : result(),
        );

        const failures = await runPreflight({ repoPath: "/repo", run });

        expect(failures).toEqual([
            expect.objectContaining({ check: "Git repository" }),
        ]);
    });

    it("reports every failed check at once", async () => {
        const run: PreflightRun = vi.fn(async () => result(1));

        const failures = await runPreflight({ repoPath: "/repo", run });

        expect(failures.map((failure) => failure.check)).toEqual([
            "Git",
            "Docker daemon",
            "GitHub CLI",
            "Git repository",
        ]);
    });

    it("includes actionable guidance in the formatted report", () => {
        const report = formatPreflightFailures([
            { check: "Docker daemon", guidance: "Start Docker." },
        ]);

        expect(report).toContain("Docker daemon: Start Docker.");
    });
});
