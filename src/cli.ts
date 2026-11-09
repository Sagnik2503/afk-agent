import { ChildProcess } from "./process.js";

const result = await ChildProcess("touch", ["version.ts"]);
console.log(result.stdout)
console.log(result.stderr)
console.log(result.signal)
console.log(result.exitCode)