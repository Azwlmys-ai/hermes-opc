export interface ExecCommandInput {
  workspaceId: string
  command: string
  cwd?: string
  timeoutMs?: number
  taskId?: string
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

export type RuntimeEventSource = "kernel" | "runtime" | "workspace" | "system"

export type RuntimeEventType =
  | "task.started"
  | "task.completed"
  | "task.failed"
  | "runtime.command.started"
  | "runtime.command.stdout"
  | "runtime.command.stderr"
  | "runtime.command.completed"
  | "workspace.patch.proposed"
  | "workspace.patch.approved"
  | "workspace.patch.applied"
  | "task.plan.generated"
  | "task.workspace.inspected"
  | "task.patch.context.built"
  | "task.verification.planned"

export type RuntimeEventLevel = "debug" | "info" | "warn" | "error"

export interface RuntimeEvent<TPayload = Record<string, unknown>> {
  id: string
  ts: string
  source: RuntimeEventSource
  type: RuntimeEventType
  level: RuntimeEventLevel
  workspaceId: string
  taskId?: string
  payload: TPayload
}

export interface RuntimeEventInput<TPayload = Record<string, unknown>> {
  source: RuntimeEventSource
  type: RuntimeEventType
  level?: RuntimeEventLevel
  workspaceId: string
  taskId?: string
  payload?: TPayload
}

export type RuntimeEventHandler = (event: RuntimeEvent) => void

export interface IRuntimeEventBus {
  emit<TPayload = Record<string, unknown>>(input: RuntimeEventInput<TPayload>): RuntimeEvent<TPayload>
  subscribe(handler: RuntimeEventHandler): () => void
  getEvents(): RuntimeEvent[]
  clear(): void
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