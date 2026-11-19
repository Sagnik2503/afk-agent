import { spawn } from "node:child_process";
import { execPath } from "node:process";
import { describe, expect, it } from "vitest";
import { packageVersion } from "../src/package_info.js";

const cliPath = new URL("../src/cli.ts", import.meta.url).pathname;

function runCli(
    args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(execPath, ["--import", "tsx", cliPath, ...args], {
            env: { ...process.env, NO_COLOR: "1" },
        });

        let stdout = "";
        let stderr = "";

        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
}

describe("afk command overview", () => {
    it("prints the overview and exits 0 when run without arguments", async () => {
        const { code, stdout } = await runCli([]);

        expect(code).toBe(0);
        expect(stdout).toContain("setup");
        expect(stdout).toContain("run");
        expect(stdout).toContain("logs");
        expect(stdout).toContain("afk run --repo . --issue 142");
    });

    it("prints the same overview for `afk help`", async () => {
        const bare = await runCli([]);
        const help = await runCli(["help"]);

        expect(help.code).toBe(0);
        expect(help.stdout).toBe(bare.stdout);
        expect(help.stdout).toContain("afk logs --repo . --issue 142");
    });

    it("delegates `afk help run` to the command help with its flags", async () => {
        const { code, stdout } = await runCli(["help", "run"]);

        expect(code).toBe(0);
        expect(stdout).toContain("--repo");
        expect(stdout).toContain("--issue");
        expect(stdout).toContain("--model");
        expect(stdout).toContain("--timeout");
    });

    it("prints the package version for `afk --version`", async () => {
        const { code, stdout } = await runCli(["--version"]);

        expect(code).toBe(0);
        expect(stdout.trim()).toBe(packageVersion());
    });
});
