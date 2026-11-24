import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadValidationCommands(
    repoPath: string,
): Promise<string[]> {
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

    if (
        typeof config !== "object" ||
        config === null ||
        !("validate" in config)
    ) {
        throw new Error(
            `Missing "validate" key in ${configPath}. Add an ordered list of commands, e.g. { "validate": ["npm test"] }, or { "validate": [] } to run with no Validation.`,
        );
    }

    const validate = config.validate;

    if (
        !Array.isArray(validate) ||
        validate.some((command: unknown) => typeof command !== "string")
    ) {
        throw new Error(
            `"validate" in ${configPath} must be an array of command strings, e.g. { "validate": ["npm test"] }.`,
        );
    }

    return validate;
}
