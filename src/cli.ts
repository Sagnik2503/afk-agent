import { ChildProcess } from "./process.js"

//Example Implementation (Basic)

// const result = await ChildProcess("touch", ["version.ts"]);
// console.log(result.stdout)
// console.log(result.stderr)
// console.log(result.signal)
// console.log(result.exitCode)

try {
  const result = await ChildProcess("opencode", [
    "run",
    "--format",
    "json",
    "Explain this repository. Do not modify any files.",
  ]);

  console.log("Exit code:", result.exitCode);
  console.log("OpenCode output:", result.stdout);
  console.log("OpenCode errors:", result.stderr);
} catch (error) {
  console.error("Could not launch OpenCode:", error);
}