// =============================================================================
// workspace-tool.ts — MCP-style tool definitions for workspace file operations.
//
// These tool definitions can be registered alongside the opc.* Kernel tools
// in the MCP server so that Claude Code can read/write workspace files.
// Handlers accept an IWorkspaceService and the raw JSON-RPC arguments.
// =============================================================================

import { Buffer } from "node:buffer"
import type { IWorkspaceService } from "./types.js"

// ---------------------------------------------------------------------------
// Tool schema types (subset of JSON Schema, same pattern as mcp-server)
// ---------------------------------------------------------------------------

interface McpProperty {
  type:         string
  description?: string
  enum?:        string[]
}

export interface WorkspaceToolDefinition {
  name:        string
  description: string
  inputSchema: {
    type:       "object"
    properties: Record<string, McpProperty>
    required:   string[]
  }
}

// ---------------------------------------------------------------------------
// Tool definitions — Claude reads these via tools/list
// ---------------------------------------------------------------------------

export const workspaceToolDefinitions: readonly WorkspaceToolDefinition[] = [
  {
    name:        "workspace.read_file",
    description:
      "Read the contents of a file inside the workspace sandbox. " +
      "All paths are relative to the workspace root; absolute paths are rejected.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type:        "string",
          description: "Workspace slug (e.g. 'hermes-v1').",
        },
        path: {
          type:        "string",
          description: "Relative path to the file (e.g. 'src/index.ts').",
        },
      },
      required: ["workspaceId", "path"],
    },
  },
  {
    name:        "workspace.write_file",
    description:
      "Write content to a file inside the workspace sandbox. " +
      "Parent directories are created automatically. " +
      "Overwrites existing files. Recorded in the workspace audit log.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type:        "string",
          description: "Workspace slug.",
        },
        path: {
          type:        "string",
          description: "Relative path to write.",
        },
        content: {
          type:        "string",
          description: "File content (UTF-8 text).",
        },
        agentId: {
          type:        "string",
          description: "ID of the agent performing the write (for audit).",
        },
      },
      required: ["workspaceId", "path", "content", "agentId"],
    },
  },
  {
    name:        "workspace.list_files",
    description:
      "List files inside the workspace. Optionally filter by a path substring.",
    inputSchema: {
      type: "object",
      properties: {
        workspaceId: {
          type:        "string",
          description: "Workspace slug.",
        },
        pattern: {
          type:        "string",
          description: "Optional substring filter on relative paths.",
        },
      },
      required: ["workspaceId"],
    },
  },
]

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Argument "${key}" must be a non-empty string`)
  }
  return v
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key]
  return typeof v === "string" && v.length > 0 ? v : undefined
}

// ---------------------------------------------------------------------------
// Per-tool handlers
// ---------------------------------------------------------------------------

async function readFile(
  args:    Record<string, unknown>,
  getWs:   (id: string) => IWorkspaceService,
): Promise<unknown> {
  const workspaceId = requireString(args, "workspaceId")
  const path        = requireString(args, "path")
  const ws          = getWs(workspaceId)
  const content     = await ws.readFile(path)
  return { path, sizeBytes: Buffer.byteLength(content, "utf8"), content }
}

async function writeFile(
  args:    Record<string, unknown>,
  getWs:   (id: string) => IWorkspaceService,
): Promise<unknown> {
  const workspaceId = requireString(args, "workspaceId")
  const path        = requireString(args, "path")
  const content     = requireString(args, "content")
  const agentId     = requireString(args, "agentId")
  const ws          = getWs(workspaceId)
  await ws.writeFile(path, content, agentId)
  return { path, sizeBytes: Buffer.byteLength(content, "utf8"), written: true }
}

async function listFiles(
  args:    Record<string, unknown>,
  getWs:   (id: string) => IWorkspaceService,
): Promise<unknown> {
  const workspaceId = requireString(args, "workspaceId")
  const pattern     = optionalString(args, "pattern")
  const ws          = getWs(workspaceId)
  const files       = await ws.listFiles(pattern)
  return { workspaceId, count: files.length, files }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Handle a workspace tool call.
 *
 * @param name    Tool name (e.g. "workspace.read_file")
 * @param args    Raw JSON-RPC arguments
 * @param getWs   Factory that returns an IWorkspaceService for a given id.
 *                Callers can use createWorkspaceService() or a mock.
 */
export async function handleWorkspaceToolCall(
  name:  string,
  args:  Record<string, unknown>,
  getWs: (workspaceId: string) => IWorkspaceService,
): Promise<unknown> {
  switch (name) {
    case "workspace.read_file":  return readFile(args, getWs)
    case "workspace.write_file": return writeFile(args, getWs)
    case "workspace.list_files": return listFiles(args, getWs)
    default:
      throw new Error(`Unknown workspace tool: ${name}`)
  }
}
