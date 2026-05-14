// =============================================================================
// @hermes/core — Type definitions only. No implementation. No SDK imports.
// The Kernel is the integration point: all other packages converge here.
// =============================================================================

import type { AgentType, Task, AgentResult, AgentContext, Priority } from "@hermes/agent"
import type { CostEstimate } from "@hermes/provider"
import type { IMemoryService, MemoryEntry, TaskStatus } from "@hermes/memory"
import type { PatchProposal }  from "@hermes/workspace"
import type { IRuntimeEventBus } from "@hermes/runtime"

// Re-export types that callers of @hermes/core commonly need,
// so they don't have to know which sub-package owns them.
export type {
  AgentType,
  Task,
  AgentResult,
  AgentContext,
  Priority,
  CostEstimate,
  IMemoryService,
  MemoryEntry,
  TaskStatus,
  PatchProposal,
  IRuntimeEventBus,
}

// ---------------------------------------------------------------------------
// Budget / cost guard
// ---------------------------------------------------------------------------

export interface CostGuardConfig {
  /** USD hard limit across all workspaces per calendar day */
  globalDailyLimitUsd: number
  /** USD hard limit for a single agent session */
  perAgentSessionLimitUsd: number
  /** Fraction of any limit at which to emit an alert (0.0–1.0) */
  alertThreshold: number
  /** Fraction at which the guard force-terminates the agent (typically 1.0) */
  hardStopThreshold: number
}

export interface CostUsageSnapshot {
  workspace: string
  /** Cumulative spend for today (UTC) */
  dailyUsedUsd: number
  /** Cumulative spend for the current calendar month */
  monthlyUsedUsd: number
  remainingDailyUsd: number
  remainingMonthlyUsd: number
}

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------

export interface ProviderRouteRule {
  /** When a task of this type is submitted… */
  taskType: AgentType
  /** …use this provider name */
  provider: string
  /** …and this model ID */
  model: string
  /**
   * Optional condition expression evaluated at runtime.
   * Reserved for v0.2 (e.g. "budget.remaining < 1.00").
   */
  condition?: string
}

// ---------------------------------------------------------------------------
// Kernel configuration (loaded from kernel/config.yaml)
// ---------------------------------------------------------------------------

export interface KernelConfig {
  version: string
  budget: CostGuardConfig
  defaultProvider: string
  defaultModel: string
  /** v0.1 is always 1 (serial execution). >1 enables parallel agents in v0.2. */
  maxConcurrentAgents: number
  providerRoutes: ProviderRouteRule[]
}

// ---------------------------------------------------------------------------
// Task submission
// ---------------------------------------------------------------------------

export interface SubmitRequest {
  instruction: string
  workspace: string
  /** Which agent type to use. Defaults to AgentType.Coder when omitted. */
  agentType?: AgentType
  priority?: Priority
  /** Override the global session budget limit for this specific task */
  budgetLimitUsd?: number
  /** Files to pre-load as read context (relative to workspace root) */
  contextRefs?: string[]
}

export interface SubmitResponse {
  taskId: string
  estimatedCost: CostEstimate
  /** Immediately PENDING — becomes READY once deps are resolved */
  status: TaskStatus
}

// ---------------------------------------------------------------------------
// Context bundle — what the Kernel assembles and hands to an agent
// ---------------------------------------------------------------------------

export interface ContextBundle {
  task: Task
  /** Memory entries retrieved from L2 for this task */
  memoryEntries: MemoryEntry[]
  /** Plain-text permissions summary injected into the agent's system prompt */
  permissionsSummary: string
  /** Max tokens the agent may use for its context window this session */
  tokenBudget: number
}

// ---------------------------------------------------------------------------
// Human-in-the-loop approval
// ---------------------------------------------------------------------------

export interface ApprovalRequest {
  taskId: string
  agentId: string
  /** Short verb describing the action: "delete", "push", "send" */
  action: string
  /** Human-readable resource description: "src/old-api/v1.ts" */
  resource: string
  /** Agent's stated reason for needing this action */
  reason: string
  /** ISO 8601 */
  requestedAt: string
}

export interface ApprovalDecision {
  taskId: string
  approved: boolean
  /** Required when approved === false */
  rejectionReason?: string
  /** ISO 8601 */
  decidedAt: string
}

// ---------------------------------------------------------------------------
// Task graph node (internal scheduling state)
// ---------------------------------------------------------------------------

export interface TaskNode {
  task: Task
  status: TaskStatus
  agentId?: string
  /** Task IDs that must be Done before this becomes Ready */
  blockedBy: string[]
  /** Task IDs that are waiting on this one */
  unblocks: string[]
  approvalRequest?: ApprovalRequest
  result?: AgentResult
  /** Stored when rejectTask() is called */
  rejectReason?: string
}

// ---------------------------------------------------------------------------
// Task query types — public view of in-memory task state
// ---------------------------------------------------------------------------

export interface TaskSummary {
  taskId:      string
  workspace:   string
  agentType:   AgentType
  status:      TaskStatus
  /** Truncated to first 120 chars for list views */
  instruction: string
  createdAt:   string
}

export interface TaskDetail {
  taskId:       string
  workspace:    string
  agentType:    AgentType
  status:       TaskStatus
  instruction:  string
  createdAt:    string
  agentId?:     string
  /** Agent's primary output text — present once status is Done */
  output?:      string
  done:         string[]
  deferred:     string[]
  risks:        string[]
  /** Actual spend — 0 until task reaches a terminal state */
  costUsd:      number
  completedAt?: string
  /** Patch proposal from CoderAgent — present when status is WAITING_APPROVAL or Done */
  patchProposal?: PatchProposal
  /** Reason provided to rejectTask() — present when status is Failed after rejection */
  rejectReason?:  string
}

// ---------------------------------------------------------------------------
// Kernel contract
// ---------------------------------------------------------------------------

export interface IKernel {
  /**
   * Accept a new task. Returns immediately with a task ID and cost estimate.
   * The task is queued and executed according to its deps and priority.
   */
  submit(req: SubmitRequest): Promise<SubmitResponse>

  /** Poll the current status of a task by ID. */
  getStatus(taskId: string): Promise<TaskStatus>

  /** Return full detail (status + result) for a task. */
  getTaskDetail(taskId: string): Promise<TaskDetail>

  /** List tasks, optionally filtered to a single workspace. */
  listTasks(workspace?: string): Promise<TaskSummary[]>

  /**
   * Cancel a PENDING or READY task.
   * Throws if the task is already Running or in a terminal state.
   */
  cancelTask(taskId: string): Promise<void>

  /**
   * Approve a WAITING_APPROVAL task.
   * Applies any pending PatchProposal to the workspace, then marks the task Done.
   */
  approveTask(taskId: string): Promise<void>

  /**
   * Reject a WAITING_APPROVAL task.
   * Marks the task Failed and stores the optional rejection reason.
   */
  rejectTask(taskId: string, reason?: string): Promise<void>

  /**
   * Gracefully shut down the kernel.
   * Running agents are cancelled; queued tasks are persisted.
   */
  shutdown(): Promise<void>
}
