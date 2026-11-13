
import { stat } from "node:fs/promises";
import path from "node:path";
import { ChildProcess } from "../process.js";

export async function validateRepository(repoPath: string): Promise<string> {
  const absolutePath = path.resolve(repoPath);

  let details;

  try {
    details = await stat(absolutePath);
  } catch {
    throw new Error(`Repository path does not exist: ${absolutePath}`);
  }

  if (!details.isDirectory()) {
    throw new Error("Repository path must be a directory");
  }

  const result = await ChildProcess(
    "git",
    ["rev-parse", "--show-toplevel"],
    { cwd: absolutePath }
  );

  if (result.exitCode !== 0) {
    throw new Error("The provided path is not a Git repository");
  }

  return result.stdout.trim();
}