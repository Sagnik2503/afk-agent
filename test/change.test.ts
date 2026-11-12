import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChangedFiles } from "../src/harness/change.js";
import { ChildProcess } from "../src/process.js";

async function makeRepo(): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "afk-agent-changes-"));
    await ChildProcess("git", ["init", "-q"], { cwd: repo });
    await ChildProcess(
        "git",
        ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "init"],
        { cwd: repo }
    );
    return repo;
}

describe("getChangedFiles", () => {
    it("returns modified and untracked files", async () => {
        const repo = await makeRepo();

        try {
            await writeFile(join(repo, "tracked.txt"), "one");
            await ChildProcess("git", ["add", "tracked.txt"], { cwd: repo });
            await ChildProcess(
                "git",
                ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "add tracked"],
                { cwd: repo }
            );

            await writeFile(join(repo, "tracked.txt"), "two");
            await writeFile(join(repo, "untracked.txt"), "new");

            const files = await getChangedFiles(repo);

            expect(files.sort()).toEqual(["tracked.txt", "untracked.txt"]);
        } finally {
            await rm(repo, { recursive: true, force: true });
        }
    });

    it("returns only the new path for a renamed file", async () => {
        const repo = await makeRepo();

        try {
            await writeFile(join(repo, "before.txt"), "content");
            await ChildProcess("git", ["add", "before.txt"], { cwd: repo });
            await ChildProcess(
                "git",
                ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "-m", "add before"],
                { cwd: repo }
            );
            await ChildProcess("git", ["mv", "before.txt", "after.txt"], { cwd: repo });

            const files = await getChangedFiles(repo);

            expect(files).toEqual(["after.txt"]);
        } finally {
            await rm(repo, { recursive: true, force: true });
        }
    });

    it("throws when the path is not a git repository", async () => {
        const directory = await mkdtemp(join(tmpdir(), "afk-agent-changes-not-repo-"));

        try {
            await expect(getChangedFiles(directory)).rejects.toThrow(
                /Git status failed/i
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
