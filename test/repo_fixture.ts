import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repos: string[] = [];

export async function makeRepo(
    prefix: string,
    config?: string,
): Promise<string> {
    const repo = await mkdtemp(join(tmpdir(), prefix));
    repos.push(repo);

    if (config !== undefined) {
        await mkdir(join(repo, ".afk"), { recursive: true });
        await writeFile(join(repo, ".afk", "config.json"), config);
    }

    return repo;
}

export async function cleanupRepos(): Promise<void> {
    await Promise.all(
        repos
            .splice(0)
            .map((repo) => rm(repo, { recursive: true, force: true })),
    );
}
