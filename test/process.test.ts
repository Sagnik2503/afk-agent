import { describe, it, expect } from "vitest";
import { ChildProcess } from "../src/process";

describe("ChildProcess", () => {
    it("succeeds: resolves with stdout and exit code 0", async () => {
        const result = await ChildProcess("node", ["-e", "console.log('ok')"]);

        expect(result.exitCode).toBe(0);
        expect(result.signal).toBeNull();
        expect(result.stdout).toContain("ok");
        expect(result.stderr).toBe("");
    });

    it("runs but exits with an error code", async () => {
        const result = await ChildProcess("node", [
            "-e",
            "console.error('boom'); process.exit(3)",
        ]);

        expect(result.exitCode).toBe(3);
        expect(result.signal).toBeNull();
        expect(result.stderr).toContain("boom");
    });

    it("cannot be started: rejects with the spawn error", async () => {
        await expect(
            ChildProcess("afk-agent-no-such-command", []),
        ).rejects.toMatchObject({ code: "ENOENT" });
    });
});
