import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    loadProjectDockerfile,
    loadValidationCommands,
} from "../src/config.js";

const repos: string[] = [];

async function makeRepo(config?: string): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), "afk-config-"));
    repos.push(repo);

    if (config !== undefined) {
        await mkdir(join(repo, ".afk"), { recursive: true });
        await writeFile(join(repo, ".afk", "config.json"), config);
    }

    return repo;
}

afterEach(async () => {
    await Promise.all(
        repos
            .splice(0)
            .map((repo) => rm(repo, { recursive: true, force: true })),
    );
});

describe("loadValidationCommands", () => {
    it("reads the ordered validate list from .afk/config.json", async () => {
        const repo = await makeRepo(
            JSON.stringify({
                validate: ["npm ci", "npm test", "npm run lint"],
            }),
        );

        await expect(loadValidationCommands(repo)).resolves.toEqual([
            "npm ci",
            "npm test",
            "npm run lint",
        ]);
    });

    it("refuses a missing config file with actionable guidance", async () => {
        const repo = await makeRepo();

        await expect(loadValidationCommands(repo)).rejects.toThrow(
            /\.afk\/config\.json.*validate/s,
        );
    });

    it("refuses a config without a validate key", async () => {
        const repo = await makeRepo(JSON.stringify({ model: "x" }));

        await expect(loadValidationCommands(repo)).rejects.toThrow(
            /"validate".*\.afk\/config\.json|\.afk\/config\.json.*"validate"/s,
        );
    });

    it("refuses invalid JSON with actionable guidance", async () => {
        const repo = await makeRepo("{ not json");

        await expect(loadValidationCommands(repo)).rejects.toThrow(
            /Invalid JSON.*\.afk\/config\.json/s,
        );
    });

    it("refuses a validate value that is not a list of command strings", async () => {
        const repo = await makeRepo(JSON.stringify({ validate: "npm test" }));

        await expect(loadValidationCommands(repo)).rejects.toThrow(
            /array of command strings/,
        );

        const mixed = await makeRepo(
            JSON.stringify({ validate: ["npm test", 42] }),
        );

        await expect(loadValidationCommands(mixed)).rejects.toThrow(
            /array of command strings/,
        );
    });

    it("treats an empty validate list as a deliberate opt-out", async () => {
        const repo = await makeRepo(JSON.stringify({ validate: [] }));

        await expect(loadValidationCommands(repo)).resolves.toEqual([]);
    });
});

describe("loadProjectDockerfile", () => {
    it("returns null when the config has no dockerfile key", async () => {
        const repo = await makeRepo(JSON.stringify({ validate: [] }));

        await expect(loadProjectDockerfile(repo)).resolves.toBeNull();
    });

    it("resolves the dockerfile path relative to the repository", async () => {
        const repo = await makeRepo(
            JSON.stringify({ validate: [], dockerfile: ".afk/Dockerfile" }),
        );
        await writeFile(
            join(repo, ".afk", "Dockerfile"),
            "FROM afk-agent:base\n",
        );

        await expect(loadProjectDockerfile(repo)).resolves.toBe(
            join(repo, ".afk", "Dockerfile"),
        );
    });

    it("refuses a dockerfile value that is not a non-empty string", async () => {
        const numeric = await makeRepo(
            JSON.stringify({ validate: [], dockerfile: 42 }),
        );
        await expect(loadProjectDockerfile(numeric)).rejects.toThrow(
            /"dockerfile"/,
        );

        const empty = await makeRepo(
            JSON.stringify({ validate: [], dockerfile: "  " }),
        );
        await expect(loadProjectDockerfile(empty)).rejects.toThrow(
            /"dockerfile"/,
        );
    });

    it("refuses a dockerfile key that points at a missing file", async () => {
        const repo = await makeRepo(
            JSON.stringify({ validate: [], dockerfile: ".afk/Dockerfile" }),
        );

        await expect(loadProjectDockerfile(repo)).rejects.toThrow(
            /Dockerfile.*does not exist/s,
        );
    });
});
