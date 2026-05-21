// =============================================================================
// McpServer — minimal stdio JSON-RPC 2.0 server implementing the MCP protocol.
//
// Transport: newline-delimited JSON over stdin/stdout (MCP stdio transport).
// Protocol:  MCP 2024-11-05 — initialize → tools/list → tools/call loop.
//
// Supported methods:
//   initialize   → return capabilities + serverInfo
//   initialized  → notification, no response
//   ping         → {} (keepalive)
//   tools/list   → opc.* Kernel tools + workspace.* file I/O tools
//   tools/call   → routed by tool name prefix:
//                    opc.*       → handleToolCall(kernel)
//                    workspace.* → handleWorkspaceToolCall(wsFactory)
//
// Workspace services are lazily created per workspaceId and cached for the
// server lifetime. All file operations are sandbox-protected by WorkspaceService.
// =============================================================================

import { createInterface } from "node:readline"
import type { IKernel }    from "@hermes/core"
import {
  createWorkspaceService,
  workspaceToolDefinitions,
  handleWorkspaceToolCall,
} from "@hermes/workspace"
import type { IWorkspaceService } from "@hermes/workspace"
import {
  createRuntimeService,
  runtimeToolDefinitions,
  handleRuntimeToolCall,
} from "@hermes/runtime"
import type { IRuntimeService } from "@hermes/runtime"
import { toolDefinitions, handleToolCall } from "./tools.js"

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

type JsonRpcId = string | number | null

interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?:     JsonRpcId       // absent for notifications
  method:  string
  params?: unknown
}

interface McpToolCallParams {
  name:      string
  arguments: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Combined tool list (built once at startup)
// ---------------------------------------------------------------------------

const allToolDefinitions = [
  ...toolDefinitions,
  ...workspaceToolDefinitions,
  ...runtimeToolDefinitions,
]

export const mcpToolCount = allToolDefinitions.length

// ---------------------------------------------------------------------------
// McpServer
// ---------------------------------------------------------------------------

export class McpServer {
  private readonly kernel:     IKernel
  private readonly hermesRoot: string
  private readonly runtime:    IRuntimeService

  /** Per-workspaceId cache — created on first use, held for server lifetime. */
  private readonly wsCache = new Map<string, IWorkspaceService>()

  constructor(kernel: IKernel, hermesRoot?: string) {
    this.kernel     = kernel
    this.hermesRoot = hermesRoot ?? process.env["HERMES_ROOT"] ?? process.cwd()
    this.runtime    = createRuntimeService(this.hermesRoot)
  }

  /** Start reading from stdin. Blocks until stdin closes. */
  start(): void {
    const rl = createInterface({ input: process.stdin, terminal: false })

    rl.on("line", (line: string) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      void this.handleLine(trimmed)
    })

    rl.on("close", () => {
      void this.kernel.shutdown()
    })

    // Diagnostics go to stderr; stdout is reserved for MCP JSON-RPC output.
    process.stderr.write(`[hermes-mcp] cwd=${process.cwd()}\n`)
    process.stderr.write(`[hermes-mcp] HERMES_ROOT=${this.hermesRoot}\n`)
    process.stderr.write(`[hermes-mcp] registered tool count=${mcpToolCount}\n`)
    process.stderr.write("[hermes-mcp] server ready\n")
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private getWorkspaceService(workspaceId: string): IWorkspaceService {
    let svc = this.wsCache.get(workspaceId)
    if (svc === undefined) {
      svc = createWorkspaceService(workspaceId, this.hermesRoot)
      this.wsCache.set(workspaceId, svc)
    }
    return svc
  }

  private async handleLine(raw: string): Promise<void> {
    let req: JsonRpcRequest
    try {
      req = JSON.parse(raw) as JsonRpcRequest
    } catch {
      this.writeResponse(null, undefined, { code: -32700, message: "Parse error" })
      return
    }

    // Notifications have no id — process without responding
    if (req.id === undefined) {
      await this.dispatchNotification(req)
      return
    }

    try {
      const result = await this.dispatch(req)
      this.writeResponse(req.id, result)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.writeResponse(req.id, undefined, { code: -32603, message })
    }
  }

  private async dispatchNotification(req: JsonRpcRequest): Promise<void> {
    if (req.method === "initialized") return   // acknowledged — no-op
    // All other notifications are silently ignored per JSON-RPC spec
  }

  private async dispatch(req: JsonRpcRequest): Promise<unknown> {
    switch (req.method) {
      // ── Handshake ──────────────────────────────────────────────────────────
      case "initialize":
        return {
          protocolVersion: "2024-11-05",
          capabilities:    { tools: {} },
          serverInfo:      { name: "hermes-mcp", version: "0.1.0" },
        }

      // ── Keepalive ──────────────────────────────────────────────────────────
      case "ping":
        return {}

      // ── Tool discovery ─────────────────────────────────────────────────────
      case "tools/list":
        return { tools: allToolDefinitions }

      // ── Tool execution ─────────────────────────────────────────────────────
      case "tools/call": {
        const params = req.params as McpToolCallParams | undefined
        if (params === undefined || typeof params.name !== "string") {
          throw new Error(
            "tools/call requires params.name (string) and params.arguments (object)",
          )
        }
        const toolArgs: Record<string, unknown> =
          typeof params.arguments === "object" && params.arguments !== null
            ? params.arguments
            : {}

        try {
          const output = await this.routeToolCall(params.name, toolArgs)
          return {
            content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
            isError: false,
          }
        } catch (toolErr) {
          // Tool-level errors → isError:true content (not a JSON-RPC error)
          const msg = toolErr instanceof Error ? toolErr.message : String(toolErr)
          return {
            content: [{ type: "text", text: `Error: ${msg}` }],
            isError: true,
          }
        }
      }

      default:
        throw Object.assign(
          new Error(`Method not found: ${req.method}`),
          { code: -32601 },
        )
    }
  }

  /**
   * Route a tool call to the correct handler based on name prefix:
   *   opc.*       → Kernel tools
   *   workspace.* → WorkspaceService tools (sandbox-protected)
   *   runtime.*   → RuntimeService command execution tools (sandbox-protected)
   */
  private routeToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    if (name.startsWith("workspace.")) {
      return handleWorkspaceToolCall(
        name,
        args,
        (workspaceId) => this.getWorkspaceService(workspaceId),
      )
    }
    if (name.startsWith("runtime.")) {
      return handleRuntimeToolCall(name, args, this.runtime)
    }
    // Default: Kernel (opc.*) tools
    return handleToolCall(name, args, this.kernel)
  }

  private writeResponse(
    id:      JsonRpcId | undefined,
    result?: unknown,
    error?:  { code: number; message: string },
  ): void {
    const response: Record<string, unknown> = { jsonrpc: "2.0", id: id ?? null }
    if (error !== undefined) {
      response["error"] = error
    } else {
      response["result"] = result
    }
    process.stdout.write(JSON.stringify(response) + "\n")
  }
}
