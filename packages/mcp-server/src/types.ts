// =============================================================================
// @hermes/mcp-server — Type definitions only. No server implementation.
// These types define the MCP tool interface exposed to Claude Code / VS Code.
//
// Note: MCP I/O types are intentionally separate from @hermes/core types.
// They are JSON-Schema-compatible (plain strings/numbers) so the MCP runtime
// can serialise/deserialise them without knowledge of internal Hermes types.
// The mapping between MCP I/O and core types is the server implementation's job.
// =============================================================================

// ---------------------------------------------------------------------------
// Tool names — the stable identifiers Claude Code will call
// ---------------------------------------------------------------------------

export enum HermesTool {
  TaskSubmit = "hermes:task-submit",
  TaskStatus = "hermes:task-status",
  CostStatus = "hermes:cost-status",
}

// ---------------------------------------------------------------------------
// MCP protocol shapes
// ---------------------------------------------------------------------------

/** JSON Schema "object" descriptor for a tool's input. */
export interface MCPToolInputSchema {
  type: "object"
  properties: Record<string, unknown>
  required: string[]
}

export interface MCPToolDefinition {
  name: HermesTool
  description: string
  inputSchema: MCPToolInputSchema
}

// ---------------------------------------------------------------------------
// hermes:task-submit
// ---------------------------------------------------------------------------

export interface TaskSubmitInput {
  /** The task instruction in natural language. */
  instruction: string
  /** Workspace slug. Falls back to HERMES_DEFAULT_WORKSPACE if omitted. */
  workspace?: string
  /** One of: P0_CRITICAL | P1_HIGH | P2_NORMAL | P3_LOW */
  priority?: string
}

export interface TaskSubmitOutput {
  taskId: string
  estimatedCostUsd: number
  /** Initial status — always "PENDING" on successful submission. */
  status: string
  /** Human-readable confirmation message. */
  message: string
}

// ---------------------------------------------------------------------------
// hermes:task-status
// ---------------------------------------------------------------------------

export interface TaskStatusInput {
  taskId: string
}

export interface TaskStatusOutput {
  taskId: string
  /** One of the TaskStatus enum values serialised as a string. */
  status: string
  /** Short description of current progress, if available. */
  progress?: string
  /** Summarised result, present once status is DONE or FAILED. */
  result?: string
  costUsd?: number
}

// ---------------------------------------------------------------------------
// hermes:cost-status
// ---------------------------------------------------------------------------

export interface CostStatusInput {
  /** Workspace slug. Omit to aggregate across all workspaces. */
  workspace?: string
}

export interface CostBreakdownItem {
  agentType: string
  costUsd: number
  tasks: number
}

export interface CostStatusOutput {
  workspace: string
  usedUsd: number
  limitUsd: number
  /** 0–100 */
  percentage: number
  remainingUsd: number
  breakdown: CostBreakdownItem[]
}

// ---------------------------------------------------------------------------
// Static tool definitions — the registry Claude Code reads at startup
// ---------------------------------------------------------------------------

export const HERMES_TOOL_DEFINITIONS: readonly MCPToolDefinition[] = [
  {
    name: HermesTool.TaskSubmit,
    description:
      "Submit a natural-language task to Hermes for agent execution. " +
      "Returns a task ID and a pre-flight cost estimate. " +
      "Use hermes:task-status to poll for completion.",
    inputSchema: {
      type: "object",
      properties: {
        instruction: {
          type: "string",
          description: "What the agent should do, in plain language.",
        },
        workspace: {
          type: "string",
          description:
            "Target workspace slug (e.g. 'hermes-v1'). " +
            "Defaults to HERMES_DEFAULT_WORKSPACE.",
        },
        priority: {
          type: "string",
          enum: ["P0_CRITICAL", "P1_HIGH", "P2_NORMAL", "P3_LOW"],
          description: "Execution priority. Defaults to P2_NORMAL.",
        },
      },
      required: ["instruction"],
    },
  },
  {
    name: HermesTool.TaskStatus,
    description:
      "Query the current status and result of a previously submitted task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "The task ID returned by hermes:task-submit.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name: HermesTool.CostStatus,
    description:
      "Get current token cost usage against budget limits. " +
      "Returns per-agent breakdown. Omit workspace to see all workspaces.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type: "string",
          description:
            "Workspace slug to filter by. Omit for global summary.",
        },
      },
      required: [],
    },
  },
] as const
