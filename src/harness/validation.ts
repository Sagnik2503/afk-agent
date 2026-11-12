import { ChildProcess } from "../process.js";

export async function runTests(
  worktreePath: string
) {
  const result = await ChildProcess(
    "npm",
    ["test"],
    {
      cwd: worktreePath,
      timeout: 120_000
    }
  );

  return {
    passed: result.exitCode === 0 && !result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  };
}
