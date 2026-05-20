// =============================================================================
// tools.ts — MCP tool definitions and dispatch for the opc.* tools.
//
// Tool names use the "opc." prefix to namespace them within Claude Code.
// All args arrive as Record<string,unknown> from JSON-RPC; we validate
// eagerly and throw descriptive errors on bad input.
// =============================================================================

import type { IKernel, AgentType, Priority, VerificationCheck } from "@hermes/core"

// ---------------------------------------------------------------------------
// MCP tool schema types (subset of JSON Schema)
// ---------------------------------------------------------------------------

interface McpProperty {
  type:         string
  description?: string
  enum?:        string[]
}

interface McpInputSchema {
  type:       "object"
  properties: Record<string, McpProperty>
  required:   string[]
}

export interface McpToolDefinition {
  name:        string
  description: string
  inputSchema: McpInputSchema
}

// ---------------------------------------------------------------------------
// Tool definitions — Claude reads these at startup via tools/list
// ---------------------------------------------------------------------------

export const toolDefinitions: readonly McpToolDefinition[] = [
  {
    name:        "opc.submit_task",
    description:
      "Submit a natural-language task to the Hermes kernel for agent execution. " +
      "Returns immediately with a taskId — use opc.get_task to poll for the result.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type:        "string",
          description: "Target workspace slug (e.g. 'hermes-v1').",
        },
        instruction: {
          type:        "string",
          description: "What the agent should do, in plain language.",
        },
        agentType: {
          type:        "string",
          enum:        ["coder", "writer"],
          description: "Agent specialisation. Default: coder.",
        },
        priority: {
          type:        "string",
          enum:        ["P0_CRITICAL", "P1_HIGH", "P2_NORMAL", "P3_LOW"],
          description: "Execution priority. Default: P2_NORMAL.",
        },
        budgetLimitUsd: {
          type:        "number",
          description: "Per-session USD budget override. Omit to use kernel default.",
        },
      },
      required: ["workspace", "instruction"],
    },
  },
  {
    name:        "opc.get_task",
    description: "Get the full status and result of a previously submitted task.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type:        "string",
          description: "Task ID returned by opc.submit_task.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name:        "opc.get_task_detail",
    description:
      "Get a human-readable, structured breakdown of a task: status, patch proposal, " +
      "verification pipeline result (passed/failed checks), reject reason, and cost. " +
      "Prefer this over opc.get_task when the approval flow matters.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type:        "string",
          description: "Task ID returned by opc.submit_task.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name:        "opc.list_tasks",
    description:
      "List all tasks tracked by the kernel, optionally filtered to one workspace.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: {
          type:        "string",
          description: "Filter by workspace slug. Omit to list tasks across all workspaces.",
        },
      },
      required: [],
    },
  },
  {
    name:        "opc.cancel_task",
    description:
      "Cancel a PENDING task. Running tasks cannot be cancelled in v0.1 — " +
      "they will complete or fail on their own.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type:        "string",
          description: "Task ID to cancel.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name:        "opc.approve_task",
    description:
      "Approve a WAITING_APPROVAL task. Runs the verification pipeline first " +
      "(typecheck + smoke tests + patch safety). If verification passes, any " +
      "PatchProposal is applied to the workspace and the task is marked Done. " +
      "If verification fails, the task is marked Failed and no files are written. " +
      "The response always includes the full verification result.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type:        "string",
          description: "Task ID to approve.",
        },
      },
      required: ["taskId"],
    },
  },
  {
    name:        "opc.reject_task",
    description:
      "Reject a WAITING_APPROVAL task without applying its patch proposal. " +
      "The task is marked Failed and no files are written.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type:        "string",
          description: "Task ID to reject.",
        },
        reason: {
          type:        "string",
          description: "Optional explanation for why the proposal was rejected.",
        },
      },
      required: ["taskId"],
    },
  },
]

// ---------------------------------------------------------------------------
// Argument helpers — safe extraction from unknown JSON args
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

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key]
  return typeof v === "number" ? v : undefined
}

// ---------------------------------------------------------------------------
// Per-tool handlers
// ---------------------------------------------------------------------------

async function submitTask(
  args: Record<string, unknown>,
  kernel: IKernel,
): Promise<unknown> {
  const workspace    = requireString(args, "workspace")
  const instruction  = requireString(args, "instruction")
  const agentTypeStr = optionalString(args, "agentType")
  const priorityStr  = optionalString(args, "priority")
  const budgetLimit  = optionalNumber(args, "budgetLimitUsd")

  // Build request, respecting exactOptionalPropertyTypes (no explicit undefined)
  const req: Parameters<IKernel["submit"]>[0] = { workspace, instruction }
  if (agentTypeStr !== undefined) req.agentType = agentTypeStr as AgentType
  if (priorityStr  !== undefined) req.priority  = priorityStr  as Priority
  if (budgetLimit  !== undefined) req.budgetLimitUsd = budgetLimit

  const response = await kernel.submit(req)

  return {
    taskId:           response.taskId,
    status:           response.status,
    estimatedCostUsd: response.estimatedCost.totalEstimatedUsd,
    message:
      `Task submitted (${response.taskId}). ` +
      `Poll with opc.get_task to check progress.`,
  }
}

async function getTask(
  args: Record<string, unknown>,
  kernel: IKernel,
): Promise<unknown> {
  const taskId = requireString(args, "taskId")
  const detail = await kernel.getTaskDetail(taskId)
  return detail
}

async function getTaskDetail(
  args: Record<string, unknown>,
  kernel: IKernel,
): Promise<unknown> {
  const taskId = requireString(args, "taskId")
  const d      = await kernel.getTaskDetail(taskId)

  // Structured summary optimised for the approval workflow
  const response: Record<string, unknown> = {
    taskId:      d.taskId,
    workspace:   d.workspace,
    agentType:   d.agentType,
    status:      d.status,
    instruction: d.instruction,
    createdAt:   d.createdAt,
    costUsd:     d.costUsd,
  }

  if (d.completedAt !== undefined) response["completedAt"]  = d.completedAt
  if (d.agentId     !== undefined) response["agentId"]      = d.agentId
  if (d.output      !== undefined) response["outputSnippet"] = d.output.slice(0, 400)

  if (d.patchProposal !== undefined) {
    response["patchProposal"] = {
      summary:    d.patchProposal.summary,
      patchCount: d.patchProposal.patches.length,
      paths:      d.patchProposal.patches.map(p => p.path),
      proposedAt: d.patchProposal.proposedAt,
    }
  }

  if (d.verification !== undefined) {
    const failedChecks = d.verification.checks.filter((c: VerificationCheck) => !c.passed)
    response["verification"] = {
      passed:       d.verification.passed,
      summary:      d.verification.summary,
      checkCount:   d.verification.checks.length,
      checks:       d.verification.checks.map((c: VerificationCheck) => ({
        name:    c.name,
        passed:  c.passed,
        details: c.details,
      })),
      failedChecks: failedChecks.map((c: VerificationCheck) => ({
        name:    c.name,
        details: c.details,
      })),
    }
  }

  if (d.rejectReason !== undefined) response["rejectReason"] = d.rejectReason
  if (d.risks.length   > 0)         response["risks"]        = d.risks
  if (d.done.length    > 0)         response["done"]         = d.done
  if (d.deferred.length > 0)        response["deferred"]     = d.deferred

  return response
}

async function listTasks(
  args: Record<string, unknown>,
  kernel: IKernel,
): Promise<unknown> {
  const workspace = optionalString(args, "workspace")
  const tasks     = await kernel.listTasks(workspace)
  return { count: tasks.length, tasks }
}

async function cancelTask(
  args: Record<string, unknown>,
  kernel: IKernel,
): Promise<unknown> {
  const taskId = requireString(args, "taskId")
  await kernel.cancelTask(taskId)
  return { taskId, cancelled: true }
}

async function approveTask(
  args: Record<string, unknown>,
  kernel: IKernel,
): Promise<unknown> {
  const taskId = requireString(args, "taskId")

  // approveTask runs the verification pipeline internally.
  // It throws only for protocol errors (wrong state, unknown task).
  // Verification failure is surfaced via task status → FAILED, not an exception.
  await kernel.approveTask(taskId)

  const detail = await kernel.getTaskDetail(taskId)

  const response: Record<string, unknown> = {
    taskId,
    status: detail.status,
  }

  if (detail.verification !== undefined) {
    const failed = detail.verification.checks.filter((c: VerificationCheck) => !c.passed)
    response["verification"] = {
      passed:       detail.verification.passed,
      summary:      detail.verification.summary,
      checks:       detail.verification.checks.map((c: VerificationCheck) => ({
        name:    c.name,
        passed:  c.passed,
        details: c.details,
      })),
      failedChecks: failed.map((c: VerificationCheck) => ({ name: c.name, details: c.details })),
    }
  }

  if (detail.patchProposal !== undefined && detail.verification?.passed === true) {
    response["patchApplied"] = {
      summary:    detail.patchProposal.summary,
      patchCount: detail.patchProposal.patches.length,
      paths:      detail.patchProposal.patches.map(p => p.path),
    }
  }

  const verPassed = detail.verification?.passed ?? true
  response["message"] = verPassed
    ? `Task ${taskId} approved — verification passed, status is ${detail.status}.`
    : `Task ${taskId} failed verification — status is ${detail.status}. ` +
      `Checks failed: ${detail.verification?.checks.filter((c: VerificationCheck) => !c.passed).map((c: VerificationCheck) => c.name).join(", ") ?? "unknown"}.`

  return response
}

async function rejectTask(
  args: Record<string, unknown>,
  kernel: IKernel,
): Promise<unknown> {
  const taskId = requireString(args, "taskId")
  const reason = optionalString(args, "reason")
  await kernel.rejectTask(taskId, reason)
  return {
    taskId,
    rejected: true,
    reason:   reason ?? "(no reason provided)",
    message:  `Task ${taskId} rejected — no files were written.`,
  }
}

// ---------------------------------------------------------------------------
// Dispatch — called by McpServer for every tools/call request
// ---------------------------------------------------------------------------

export async function handleToolCall(
  name:   string,
  args:   Record<string, unknown>,
  kernel: IKernel,
): Promise<unknown> {
  switch (name) {
    case "opc.submit_task":    return submitTask(args, kernel)
    case "opc.get_task":       return getTask(args, kernel)
    case "opc.get_task_detail":return getTaskDetail(args, kernel)
    case "opc.list_tasks":     return listTasks(args, kernel)
    case "opc.cancel_task":    return cancelTask(args, kernel)
    case "opc.approve_task":   return approveTask(args, kernel)
    case "opc.reject_task":    return rejectTask(args, kernel)
    default:
      throw new Error(`Unknown tool: ${name}`)
  }
}
