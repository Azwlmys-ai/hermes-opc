import type { ExecCommandInput, IRuntimeService } from "./types.js"

interface McpProperty {
  type: string
  description?: string
}

export interface RuntimeToolDefinition {
  name: string
  description: string
  inputSchema: {
    type: "object"
    properties: Record<string, McpProperty>
    required: string[]
  }
}

export const runtimeToolDefinitions: readonly RuntimeToolDefinition[] = [
  {
    name: "runtime.exec",
    description:
      "Execute a whitelisted command inside projects/{workspaceId}. " +
      "cwd is relative to the workspace root and cannot escape the sandbox.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: { type: "string", description: "Workspace slug." },
        command: { type: "string", description: "Command to execute." },
        cwd: { type: "string", description: "Optional cwd relative to workspace root." },
        timeoutMs: { type: "number", description: "Optional timeout in milliseconds." },
      },
      required: ["workspaceId", "command"],
    },
  },
]

export function handleRuntimeToolCall(
  name: string,
  args: Record<string, unknown>,
  runtime: IRuntimeService,
): Promise<unknown> {
  if (name !== "runtime.exec") throw new Error(`Unknown runtime tool: ${name}`)

  const input: ExecCommandInput = {
    workspaceId: requireString(args, "workspaceId"),
    command: requireString(args, "command"),
  }
  const cwd = optionalString(args, "cwd")
  if (cwd !== undefined) input.cwd = cwd
  const timeoutMs = optionalNumber(args, "timeoutMs")
  if (timeoutMs !== undefined) input.timeoutMs = timeoutMs

  return runtime.execCommand(input)
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Argument "${key}" must be a non-empty string`)
  }
  return value
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const value = args[key]
  return typeof value === "number" ? value : undefined
}