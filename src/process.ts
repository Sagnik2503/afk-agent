import {spawn} from "node:child_process"

export type ProcessResult={
    stdout: string,
    stderr: string,
    exitCode: number | null,
    signal: NodeJS.Signals | null;
    timedOut: boolean;
}

export type ProcessOptions = {
  cwd?: string;
  timeout?: number;
};

export function ChildProcess(command: string, args: string[], options:ProcessOptions={}): Promise<ProcessResult> {
    
    return new Promise((resolve,reject)=>{
        const child = spawn(command, args, {
        cwd: options.cwd,
        stdio: ["ignore", "pipe", "pipe"], //input, output, error
        detached: true
        });

        let timedOut_flag=false
        let stdout = "";
        let stderr = "";
        let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

        const timer=options.timeout?setTimeout(()=>{
            timedOut_flag=true
            if(child.pid!==undefined){
                try{
                    process.kill(-child.pid, "SIGTERM"); //process. targets the process grp whereas child. targets the child only
                }catch {
                child.kill("SIGTERM");
              }
            }

            //give 5 seconds and kill the process instead of graceful shutdown
            forceKillTimer=setTimeout(()=>{
                if(child.pid===undefined)return;
                try{
                    process.kill(-child.pid,"SIGKILL")
                }catch {
                    child.kill("SIGKILL");
                }
            },5000)

        },options.timeout):undefined

        child.stdout?.on('data',(data:Buffer)=>{
            stdout+=data.toString()
        })

        child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
        });

        child.on("error", (error) => {
        if (timer) clearTimeout(timer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        reject(error);
        });

        child.on("close", (exitCode, signal) => {
            if (timer) clearTimeout(timer);
            if(forceKillTimer)clearTimeout(forceKillTimer)

            resolve({
                stdout,
                stderr,
                exitCode,
                signal,
                timedOut:timedOut_flag
            });
        });
    });
}
    