// =============================================================================
// @hermes/agent — Type definitions only. No implementation. No SDK imports.
// Imports from @hermes/provider and @hermes/memory are type-only.
// =============================================================================

import type { TokenUsage } from "@hermes/provider"
import type { MemoryEntry, TaskStatus } from "@hermes/memory"
import type { PatchProposal } from "@hermes/workspace"
import type { PatchContext } from "@hermes/workspace-intelligence"

// Re-export imported types so consumers of @hermes/agent get the full picture
// without needing to know which package a type originated in.
export type { TokenUsage, MemoryEntry, TaskStatus, PatchProposal, PatchContext }

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
  /** Agent's execution plan (populated by ToolUseAgent-backed agents) */
  plan?: AgentPlan
  /** Patch context from workspace intelligence (populated by ToolUseAgent-backed agents) */
  patchContext?: PatchContext
  /** Verification plan for this patch (populated by ToolUseAgent-backed agents) */
  verificationPlan?: VerificationPlan
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

// ---------------------------------------------------------------------------
// Day 11 P1: Agent Tool-Use Loop types
// ---------------------------------------------------------------------------

/** A single step in an agent's execution plan. */
export interface AgentPlanStep {
  /** Step number (1-based) */
  step: number
  /** Human-readable description of what this step does */
  description: string
  /** Tool name used in this step (null for pure reasoning steps) */
  toolName: string | null
  /** Expected output from this step */
  expectedOutput: string
}

/** Structured execution plan produced before acting. */
export interface AgentPlan {
  /** High-level goal */
  goal: string
  /** Ordered list of steps */
  steps: AgentPlanStep[]
  /** Symbols the plan needs to inspect */
  targetSymbols: string[]
  /** Files the plan needs to read/modify */
  targetFiles: string[]
  /** Overall expected outputs */
  expectedOutputs: string[]
}

/** Record of a single tool invocation during agent execution. */
export interface AgentToolCall {
  /** Name of the tool invoked */
  toolName: string
  /** Input arguments passed to the tool */
  input: Record<string, unknown>
  /** Serialisable summary of tool output */
  outputSummary: string
  /** Whether the tool call succeeded */
  success: boolean
  /** Wall-clock duration in milliseconds */
  durationMs: number
}

/** Result of workspace intelligence inspection. */
export interface WorkspaceInspectionResult {
  /** Number of packages discovered */
  packageCount: number
  /** Number of source files indexed */
  sourceFileCount: number
  /** Which symbols were found during inspection */
  foundSymbols: string[]
  /** Package dependency graph entries */
  packageDependencies: Record<string, string[]>
  /** Runtime entry hints discovered */
  entryHints: string[]
}

/** Structured verification commands for a patch proposal. */
export interface VerificationPlan {
  /** Description of what to verify */
  goal: string
  /** Ordered list of verification commands to run */
  commands: string[]
  /** Packages affected by verification */
  affectedPackages: string[]
  /** Whether the plan expects changes to compile */
  expectTypecheckPass: boolean
}

/** Complete result from a ToolUseAgent execution. */
export interface ToolUseAgentResult {
  /** Unique task identifier */
  taskId: string
  /** The structured plan generated */
  plan: AgentPlan
  /** Workspace inspection results */
  inspection: WorkspaceInspectionResult
  /** Patch context for the target */
  patchContext: PatchContext | null
  /** The generated patch proposal (dry-run only in v0.1) */
  patchProposal: PatchProposal | null
  /** Suggested verification commands */
  verificationPlan: VerificationPlan
  /** Ordered list of all tool calls made */
  toolCalls: AgentToolCall[]
  /** Terminal status */
  status: "PLAN_EXECUTED" | "FAILED"
  /** Why it failed (if applicable) */
  error?: string
}