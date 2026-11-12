import { ChildProcess } from "../process.js";

export async function getChangedFiles(worktreePath: string): Promise<string[]> {
    const result = await ChildProcess("git", ["status", "--short"], {
        cwd: worktreePath,
    });

    if (result.exitCode !== 0) {
        throw new Error(`Git status failed: ${result.stderr}`);
    }

    return result.stdout
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => {
            const path = line.slice(3);
            const renamed = path.indexOf(" -> ");
            return renamed === -1 ? path : path.slice(renamed + 4);
        });
}
