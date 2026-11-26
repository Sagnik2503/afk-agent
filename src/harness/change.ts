import { ChildProcess } from "../process.js";
import { getBaseRef } from "../github/sync.js";

function statusPath(line: string): string {
    const path = line.slice(3);
    const renamed = path.indexOf(" -> ");
    return renamed === -1 ? path : path.slice(renamed + 4);
}

export async function getChangedFiles(worktreePath: string): Promise<string[]> {
    const result = await ChildProcess("git", ["status", "--short"], {
        cwd: worktreePath,
    });

    if (result.exitCode !== 0) {
        throw new Error(`Git status failed: ${result.stderr}`);
    }

    const files = new Set(
        result.stdout
            .split("\n")
            .filter((line) => line !== "")
            .map(statusPath),
    );

    const baseRef = await getBaseRef(worktreePath);
    if (baseRef !== null) {
        const diff = await ChildProcess(
            "git",
            ["diff", "--name-only", baseRef],
            {
                cwd: worktreePath,
            },
        );

        if (diff.exitCode === 0) {
            for (const file of diff.stdout.split("\n")) {
                if (file !== "") {
                    files.add(file);
                }
            }
        }
    }

    return [...files];
}
