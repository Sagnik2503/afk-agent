import {spawn, type ChildProcess as ChildProcessType} from "node:child_process"

export function ChildProcess(command: string, args: string[]): ChildProcessType {
    try {
        return spawn(command, args)
    } catch (error) {
        throw new Error(`Failed to spawn "${command}"`, { cause: error })
    }
}
