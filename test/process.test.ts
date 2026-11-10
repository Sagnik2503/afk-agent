import { describe, it, expect } from "vitest";
import { ChildProcess } from "../src/process.js";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execPath } from "node:process";

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

    it("runs the process in the specified directory", async () => {
        const directory = await mkdtemp(join(tmpdir(), "afk-agent-"));

        try {
            const result = await ChildProcess(
            execPath,
            ["-e", "console.log(process.cwd())"],
            {cwd:directory}
            );

            expect(result.stdout.trim()).toBe(await realpath(directory));
            expect(result.exitCode).toBe(0);
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });

    it("does not time out when the process finishes in time", async () => {
        const result = await ChildProcess(
            execPath,
            ["-e", "console.log('Finished')"],
            { timeout: 2000 }
        );

        expect(result.timedOut).toBe(false);
        expect(result.exitCode).toBe(0);
        });

        it("terminates the process when the timeout is exceeded", async () => {
        const result = await ChildProcess(
            execPath,
            ["-e", "setTimeout(() => console.log('Finished'), 5000)"],
            { timeout: 1000 }
        );

        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGTERM");
        });

        it("force-kills a process that ignores SIGTERM for 5 seconds", async () => {
        const result = await ChildProcess(
            execPath,
            ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
            { timeout: 200 }
        );

        expect(result.timedOut).toBe(true);
        expect(result.signal).toBe("SIGKILL");
        }, 15000);

        it("should capture a non-zero exit code", async () => {
            const result = await ChildProcess("node", [
            "-e",
            "process.exit(2)",
            ]);

            expect(result.exitCode).toBe(2);
        });

        it("should execute inside the specified working directory", async () => {
            const result = await ChildProcess(
            "node",
            ["-e", "console.log(process.cwd())"],
            { cwd: process.cwd() }
            );

            expect(result.stdout.trim()).toBe(process.cwd());
        });

        it("should capture all output when within the maxOutput limit", async () => {
            const result = await ChildProcess(
            execPath,
            ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
            { maxOutput: 100 }
            );

            expect(result.stdout).toBe("out");
            expect(result.stderr).toBe("err");
        });

        it("should truncate output when the maxOutput limit is exceeded", async () => {
            const result = await ChildProcess(
            execPath,
            ["-e", "process.stdout.write('x'.repeat(100))"],
            { maxOutput: 10 }
            );

            expect(result.stdout).toBe("x".repeat(10));
            expect(result.stderr).toBe("");
        });

        it("should not report truncation when output stays within the limit", async () => {
            const result = await ChildProcess(
            execPath,
            ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
            { maxOutput: 100 }
            );

            expect(result.outputTruncated).toBe(false);
        });

        it("should report truncation when stdout exceeds the limit", async () => {
            const result = await ChildProcess(
            execPath,
            ["-e", "process.stdout.write('x'.repeat(100))"],
            { maxOutput: 10 }
            );

            expect(result.outputTruncated).toBe(true);
        });

        it("should report truncation when stderr exceeds the limit", async () => {
            const result = await ChildProcess(
            execPath,
            ["-e", "process.stderr.write('x'.repeat(100))"],
            { maxOutput: 10 }
            );

            expect(result.outputTruncated).toBe(true);
        });
});
