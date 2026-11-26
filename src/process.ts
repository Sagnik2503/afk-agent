import { spawn } from "node:child_process";

export type ResourceLimit = {
    kind: "memory" | "pids";
    value: string;
    message: string;
};

export type ProcessResult = {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    outputTruncated: boolean;
    resourceLimit?: ResourceLimit;
};

export type ProcessOptions = {
    cwd?: string;
    timeout?: number;
    maxOutput?: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    onOutput?: (stream: "stdout" | "stderr", chunk: string) => void;
};

export function ChildProcess(
    command: string,
    args: string[],
    options: ProcessOptions = {},
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            stdio: ["ignore", "pipe", "pipe"],
            detached: true,
            ...(options.env ? { env: options.env } : {}),
        });

        let outputTruncated = false;
        let timedOut_flag = false;
        let stdout = "";
        let stderr = "";
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
        let terminating = false;
        let capturedBytes = 0;
        const maxOutput = options.maxOutput ?? 1024 * 1024;

        function terminate(): void {
            if (terminating) return;
            terminating = true;

            if (child.pid !== undefined) {
                try {
                    process.kill(-child.pid, "SIGTERM");
                } catch {
                    child.kill("SIGTERM");
                }
            }

            forceKillTimer = setTimeout(() => {
                if (child.pid === undefined) return;
                try {
                    process.kill(-child.pid, "SIGKILL");
                } catch {
                    child.kill("SIGKILL");
                }
            }, 5000);
        }

        const timer = options.timeout
            ? setTimeout(() => {
                  timedOut_flag = true;
                  terminate();
              }, options.timeout)
            : undefined;

        const onAbort = (): void => {
            terminate();
        };

        if (options.signal) {
            if (options.signal.aborted) {
                onAbort();
            } else {
                options.signal.addEventListener("abort", onAbort, {
                    once: true,
                });
            }
        }

        child.stdout?.on("data", (data: Buffer) => {
            options.onOutput?.("stdout", data.toString());
            const remaining = maxOutput - capturedBytes;
            if (remaining <= 0) {
                outputTruncated = true;
                return;
            }
            const chunk = data.subarray(0, remaining);
            if (chunk.length < data.length) {
                outputTruncated = true;
            }
            stdout += chunk.toString();
            capturedBytes += chunk.length;
        });

        child.stderr?.on("data", (data: Buffer) => {
            options.onOutput?.("stderr", data.toString());
            const remaining = maxOutput - capturedBytes;
            if (remaining <= 0) {
                outputTruncated = true;
                return;
            }
            const chunk = data.subarray(0, remaining);
            if (chunk.length < data.length) {
                outputTruncated = true;
            }
            if (remaining <= 0) return;
            stderr += chunk.toString();
            capturedBytes += chunk.length;
        });

        function cleanup(): void {
            if (timer) clearTimeout(timer);
            if (forceKillTimer) clearTimeout(forceKillTimer);
            options.signal?.removeEventListener("abort", onAbort);
        }

        child.on("error", (error) => {
            cleanup();
            reject(error);
        });

        child.on("close", (exitCode, signal) => {
            cleanup();

            resolve({
                stdout,
                stderr,
                exitCode,
                signal,
                timedOut: timedOut_flag,
                outputTruncated: outputTruncated,
            });
        });
    });
}
