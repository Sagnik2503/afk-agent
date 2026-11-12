import { describe, it, expect } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTests } from "../src/harness/validation.js";

async function makeProject(testScript: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "afk-agent-validation-"));
    await writeFile(
        join(directory, "package.json"),
        JSON.stringify({ name: "fixture", scripts: { test: testScript } })
    );
    return directory;
}

describe("runTests", () => {
    it("runs the package test script in the worktree", async () => {
        const directory = await makeProject("node -e \"console.log('passed')\"");

        try {
            const result = await runTests(directory);

            expect(result.passed).toBe(true);
            expect(result.stdout).toContain("passed");
            expect(result.timedOut).toBe(false);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("returns the failure details when the tests fail", async () => {
        const directory = await makeProject(
            "node -e \"console.error('nope'); process.exit(1)\""
        );

        try {
            const result = await runTests(directory);

            expect(result.passed).toBe(false);
            expect(result.stderr).toContain("nope");
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
});
