export interface ExecCommandInput {
  workspaceId: string
  command: string
  cwd?: string
  timeoutMs?: number
}

export interface ExecCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
  command: string
}

export interface IRuntimeService {
  execCommand(input: ExecCommandInput): Promise<ExecCommandResult>
  killProcess(pid: number): boolean
  shutdown(): void
}

export interface RuntimeAuditEntry {
  ts: string
  op: "exec"
  workspaceId: string
  cwd: string
  command: string
  exitCode: number | null
  durationMs: number
  timedOut: boolean
}