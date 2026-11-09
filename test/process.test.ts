import { describe, it, expect } from "vitest";
import { ChildProcess } from "../src/process";

describe("ChildProcess", () => {
    it("spawns the command and returns a running child", () => {
        const child = ChildProcess("node", ["--version"]);

        expect(child.pid).toBeTypeOf("number");
        expect(child.exitCode).toBeNull();

        child.kill();
    });

    it("passes the args to the command and captures its output", async () => {
        const child = ChildProcess("node", ["--version"]);

        const stdout = await new Promise<string>((resolve, reject) => {
            let output = "";
            child.stdout?.on("data", (chunk: string) => (output += chunk));
            child.on("error", reject);
            child.on("close", () => resolve(output.trim()));
        });

        expect(stdout).toMatch(/^v\d+\.\d+\.\d+/);
    });

    it("does not block while the process runs", () => {
        const child = ChildProcess("node", ["-e", "setTimeout(() => {}, 5000)"]);

        expect(child.exitCode).toBeNull();

        child.kill();
    });

    it("wraps synchronous spawn failures", () => {
        expect(() => ChildProcess(undefined as unknown as string, [])).toThrow(
            /Failed to spawn/,
        );
    });

    it("surfaces async errors when the command does not exist", async () => {
        const child = ChildProcess("afk-agent-no-such-command", []);

        await expect(
            new Promise((_, reject) => child.on("error", reject)),
        ).rejects.toThrow();
    });
});
