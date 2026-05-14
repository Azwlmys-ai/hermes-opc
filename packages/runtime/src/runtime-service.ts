import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process"
import { appendFileSync, mkdirSync } from "node:fs"
import { Buffer } from "node:buffer"
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path"
import type {
  ExecCommandInput,
  ExecCommandResult,
  IRuntimeService,
  RuntimeAuditEntry,
} from "./types.js"

const DEFAULT_TIMEOUT_MS = 60_000
const BLOCKED_COMMANDS = new Set(["rm", "sudo", "ssh", "curl", "wget", "docker", "brew"])
const ALLOWED_COMMANDS = new Set(["node", "npm", "pnpm", "tsx", "python", "pytest"])

export class RuntimeService implements IRuntimeService {
  private readonly hermesRoot: string
  private readonly children = new Map<number, ChildProcessWithoutNullStreams>()

  constructor(hermesRoot?: string) {
    this.hermesRoot = hermesRoot ?? process.env["HERMES_ROOT"] ?? process.cwd()
  }

  execCommand(input: ExecCommandInput): Promise<ExecCommandResult> {
    const workspaceRoot = this.resolveWorkspaceRoot(input.workspaceId)
    const cwd = this.resolveCwd(workspaceRoot, input.cwd ?? ".")
    const tokens = splitCommand(input.command)
    assertAllowed(tokens)

    const startedAt = Date.now()
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

    return new Promise((resolvePromise, reject) => {
      const [cmd, ...args] = tokens
      if (cmd === undefined) {
        reject(new Error("Command must be non-empty"))
        return
      }

      const child = spawn(cmd, args, { cwd, shell: false })
      if (child.pid !== undefined) this.children.set(child.pid, child)

      let stdout = ""
      let stderr = ""
      let timedOut = false

      const timeout = setTimeout(() => {
        timedOut = true
        terminateChild(child)
      }, timeoutMs)

      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8")
      })

      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8")
      })

      child.on("error", (err: Error) => {
        clearTimeout(timeout)
        if (child.pid !== undefined) this.children.delete(child.pid)
        reject(err)
      })

      child.on("close", (exitCode: number | null) => {
        clearTimeout(timeout)
        if (child.pid !== undefined) this.children.delete(child.pid)
        const result: ExecCommandResult = {
          exitCode,
          stdout,
          stderr,
          durationMs: Date.now() - startedAt,
          timedOut,
          command: input.command,
        }
        this.audit(input.workspaceId, cwd, result)
        resolvePromise(result)
      })
    })
  }

  killProcess(pid: number): boolean {
    const child = this.children.get(pid)
    if (child === undefined) return false
    terminateChild(child)
    return true
  }

  shutdown(): void {
    for (const child of this.children.values()) terminateChild(child)
    this.children.clear()
  }

  private resolveWorkspaceRoot(workspaceId: string): string {
    if (workspaceId.length === 0 || isAbsolute(workspaceId) || workspaceId.includes("..")) {
      throw new Error("workspaceId must be a safe relative project id")
    }
    const projectsRoot = normalize(resolve(this.hermesRoot, "projects"))
    const root = normalize(resolve(projectsRoot, workspaceId))
    const rel = relative(projectsRoot, root)
    if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("workspaceId escapes projects sandbox")
    }
    mkdirSync(root, { recursive: true })
    return root
  }

  private resolveCwd(workspaceRoot: string, relCwd: string): string {
    if (isAbsolute(relCwd)) throw new Error(`cwd must be relative to workspace root: ${relCwd}`)
    const cwd = normalize(resolve(workspaceRoot, relCwd))
    const rel = relative(workspaceRoot, cwd)
    if (rel.startsWith("..") || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("cwd escapes the workspace sandbox")
    }
    mkdirSync(cwd, { recursive: true })
    return cwd
  }

  private audit(workspaceId: string, cwd: string, result: ExecCommandResult): void {
    try {
      const auditDir = join(this.hermesRoot, "audit")
      mkdirSync(auditDir, { recursive: true })
      const entry: RuntimeAuditEntry = {
        ts: new Date().toISOString(),
        op: "exec",
        workspaceId,
        cwd,
        command: result.command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
      }
      appendFileSync(join(auditDir, `${workspaceId}.log`), `${JSON.stringify(entry)}\n`, "utf8")
    } catch {
      // Audit failure must not break command execution.
    }
  }
}

export function createRuntimeService(hermesRoot?: string): RuntimeService {
  return new RuntimeService(hermesRoot)
}

function assertAllowed(tokens: string[]): void {
  const [cmd, subcmd] = tokens
  if (cmd === undefined) throw new Error("Command must be non-empty")
  if (BLOCKED_COMMANDS.has(cmd)) throw new Error(`Command is not allowed: ${cmd}`)
  if (cmd === "git") {
    if (subcmd === "status" || subcmd === "diff") return
    throw new Error("Only git status and git diff are allowed")
  }
  if (!ALLOWED_COMMANDS.has(cmd)) throw new Error(`Command is not allowed: ${cmd}`)
}

function splitCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: '"' | "'" | undefined
  for (const ch of command) {
    if (quote !== undefined) {
      if (ch === quote) quote = undefined
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }
    current += ch
  }
  if (quote !== undefined) throw new Error("Unterminated quote in command")
  if (current.length > 0) tokens.push(current)
  return tokens
}

function terminateChild(child: ChildProcessWithoutNullStreams): void {
  if (child.killed) return
  child.kill("SIGTERM")
  const forceKillTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
    if (!child.killed) child.kill("SIGKILL")
  }, 500)
  forceKillTimer.unref()
}