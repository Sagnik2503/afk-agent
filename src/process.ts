import {spawn} from "node:child_process"

export type ProcessResult={
    stdout: string,
    stderr: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null;
}
export function ChildProcess(command: string, args: string[], cwd?:string): Promise<ProcessResult> {
    
    return new Promise((resolve,reject)=>{
        const child = spawn(command, args, {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout?.on('data',(data:Buffer)=>{
            stdout+=data.toString()
        })

        child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        });

        child.on("error", (error) => {
        reject(error);
        });

        child.on("close", (exitCode, signal) => {
        resolve({
            stdout,
            stderr,
            exitCode,
            signal,
            });
        })
    });
}
    