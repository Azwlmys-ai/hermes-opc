// =============================================================================
// @hermes/agent — Type definitions only. No implementation. No SDK imports.
// Imports from @hermes/provider and @hermes/memory are type-only.
// =============================================================================

import type { TokenUsage } from "@hermes/provider"
import type { MemoryEntry, TaskStatus } from "@hermes/memory"
import type { PatchProposal } from "@hermes/workspace"

// Re-export imported types so consumers of @hermes/agent get the full picture
// without needing to know which package a type originated in.
export type { TokenUsage, MemoryEntry, TaskStatus, PatchProposal }

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum AgentType {
  Pm         = "pm",
  Arch       = "arch",
  Coder      = "coder",
  Qa         = "qa",
  Ops        = "ops",
  Gtm        = "gtm",
  Writer     = "writer",
  Researcher = "researcher",
  Ephemeral  = "ephemeral",
}

/** Governance tier. Lower number = broader authority. */
export enum AgentTier {
  Kernel     = "KERNEL",     // tier 0 — orchestrator only
  Head       = "HEAD",       // tier 1 — department heads
  Specialist = "SPECIALIST", // tier 2 — domain experts
  Ephemeral  = "EPHEMERAL",  // tier 3 — single-use
}

export enum AgentStatus {
  Idle            = "IDLE",
  Running         = "RUNNING",
  Done            = "DONE",
  Failed          = "FAILED",
  WaitingApproval = "WAITING_APPROVAL",
  Cancelled       = "CANCELLED",
}

export enum Priority {
  Critical = "P0_CRITICAL",
  High     = "P1_HIGH",
  Normal   = "P2_NORMAL",
  Low      = "P3_LOW",
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface AgentPermissions {
  /** Glob patterns the agent may read (relative to workspace root) */
  read: string[]
  /** Glob patterns the agent may write */
  write: string[]
  /** Exact command strings the agent may execute (whitelist) */
  execute: string[]
  /** Glob patterns that are always denied, regardless of read/write */
  forbidden: string[]
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

export interface AgentBudget {
  /** USD limit for a single agent session */
  sessionLimitUsd: number
  /** Fraction of limit at which to warn (0.0–1.0) */
  alertThreshold: number
  /** Whether to force-terminate the agent when limit is reached */
  hardStop: boolean
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AgentConfig {
  /** Unique instance ID: "{type}-{workspace}-{timestamp}" */
  id: string
  role: AgentType
  tier: AgentTier
  workspace: string
  permissions: AgentPermissions
  budget: AgentBudget
  /** Override the default provider for this agent instance */
  provider?: string
  /** Override the default model for this agent instance */
  model?: string
}

// ---------------------------------------------------------------------------
// Task — the unit of work handed to an agent
// ---------------------------------------------------------------------------

export interface Task {
  /** Unique ID: "task-{workspace}-{sequence}" */
  id: string
  type: AgentType
  workspace: string
  instruction: string
  /** File paths to inject as read context (relative to workspace root) */
  contextRefs: string[]
  priority: Priority
  budgetLimitUsd: number
  /** Task IDs that must reach Done before this task becomes Ready */
  deps: string[]
  /** ISO 8601 */
  createdAt: string
  /** ISO 8601 — hard deadline, agent is cancelled if exceeded */
  deadline?: string
}

// ---------------------------------------------------------------------------
// Tool calls — recorded for audit and memory extraction
// ---------------------------------------------------------------------------

export interface ToolCall {
  toolName: string
  /** Input arguments passed to the tool */
  args: Record<string, unknown>
  /** Serialisable result returned by the tool */
  result?: unknown
  /** Error message if the tool call failed */
  error?: string
  /** Wall-clock duration in milliseconds */
  durationMs?: number
}

// ---------------------------------------------------------------------------
// Result — structured output from a completed agent session
// ---------------------------------------------------------------------------

export interface AgentResult {
  taskId: string
  agentId: string
  status: AgentStatus
  /** Primary output — code, text, analysis, etc. */
  output: string
  /** Structured patch proposal from CoderAgent (absent for other agent types) */
  patchProposal?: PatchProposal
  /** Bullet list of what was fully completed */
  done: string[]
  /** Bullet list of what was intentionally deferred */
  deferred: string[]
  /** Identified risks or issues for human review */
  risks: string[]
  /** Ordered list of all tool calls made during this session */
  toolCalls: ToolCall[]
  usage: TokenUsage
  costUsd: number
  /** ISO 8601 */
  completedAt: string
}

// ---------------------------------------------------------------------------
// Context injected into the agent at execution time
// ---------------------------------------------------------------------------

export interface AgentContext {
  /** Relevant memory entries retrieved for this task */
  memoryEntries: MemoryEntry[]
  /** Plain-text summary of what this agent is and is not allowed to do */
  permissionsSummary: string
  /** Maximum tokens the agent may consume for its context window */
  tokenBudget: number
}

// ---------------------------------------------------------------------------
// Agent contract
// ---------------------------------------------------------------------------

export interface IAgent {
  readonly config: AgentConfig

  /**
   * Execute the given task with injected context.
   * Implementations must honour config.budget and config.permissions.
   */
  execute(task: Task, ctx: AgentContext): Promise<AgentResult>

  /** Request graceful cancellation. execute() should resolve with status Cancelled. */
  cancel(): Promise<void>

  getStatus(): AgentStatus
}
