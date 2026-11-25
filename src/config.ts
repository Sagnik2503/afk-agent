import { access, readFile } from "node:fs/promises";
import path from "node:path";

export type AfkConfig = {
    validate: string[];
    dockerfile: string | null;
};

type RawConfig = {
    config: unknown;
    configPath: string;
};

async function readConfig(repoPath: string): Promise<RawConfig> {
    const configPath = path.join(repoPath, ".afk", "config.json");
    let content: string;

    try {
        content = await readFile(configPath, "utf8");
    } catch {
        throw new Error(
            `Missing ${configPath}. Create it with a "validate" list of commands, e.g. { "validate": ["npm test"] }, or { "validate": [] } to run with no Validation.`,
        );
    }

    let config: unknown;

    try {
        config = JSON.parse(content);
    } catch {
        throw new Error(
            `Invalid JSON in ${configPath}. Fix the file so it parses, e.g. { "validate": ["npm test"] }.`,
        );
    }

    return { config, configPath };
}

function asObject({ config }: RawConfig): Record<string, unknown> | null {
    return typeof config === "object" && config !== null
        ? (config as Record<string, unknown>)
        : null;
}

function parseValidate(raw: RawConfig): string[] {
    const config = asObject(raw);

    if (config === null || !("validate" in config)) {
        throw new Error(
            `Missing "validate" key in ${raw.configPath}. Add an ordered list of commands, e.g. { "validate": ["npm test"] }, or { "validate": [] } to run with no Validation.`,
        );
    }

    const validate = config["validate"];

    if (
        !Array.isArray(validate) ||
        validate.some((command: unknown) => typeof command !== "string")
    ) {
        throw new Error(
            `"validate" in ${raw.configPath} must be an array of command strings, e.g. { "validate": ["npm test"] }.`,
        );
    }

    return validate;
}

async function parseDockerfile(
    raw: RawConfig,
    repoPath: string,
): Promise<string | null> {
    const config = asObject(raw);

    if (config === null || !("dockerfile" in config)) {
        return null;
    }

    const dockerfile = config["dockerfile"];

    if (typeof dockerfile !== "string" || dockerfile.trim() === "") {
        throw new Error(
            `"dockerfile" in ${raw.configPath} must be a non-empty path string, e.g. { "dockerfile": ".afk/Dockerfile" }.`,
        );
    }

    const dockerfilePath = path.resolve(repoPath, dockerfile);

    try {
        await access(dockerfilePath);
    } catch {
        throw new Error(
            `Dockerfile ${dockerfilePath} (from "dockerfile" in ${raw.configPath}) does not exist. Create it extending FROM afk-agent:base, or remove the "dockerfile" key to use the Sandbox image.`,
        );
    }

    return dockerfilePath;
}

export async function loadConfig(repoPath: string): Promise<AfkConfig> {
    const raw = await readConfig(repoPath);

    return {
        validate: parseValidate(raw),
        dockerfile: await parseDockerfile(raw, repoPath),
    };
}

export async function loadValidationCommands(
    repoPath: string,
): Promise<string[]> {
    return parseValidate(await readConfig(repoPath));
}

export async function loadProjectDockerfile(
    repoPath: string,
): Promise<string | null> {
    return parseDockerfile(await readConfig(repoPath), repoPath);
}
