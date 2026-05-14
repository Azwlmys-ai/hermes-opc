// =============================================================================
// @hermes/memory — Type definitions only. No implementation. No SDK imports.
// =============================================================================

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export enum KnowledgeType {
  Fact        = "FACT",
  Constraint  = "CONSTRAINT",
  Preference  = "PREFERENCE",
  Warning     = "WARNING",
  Decision    = "DECISION",
}

export enum TaskStatus {
  Pending         = "PENDING",
  Ready           = "READY",
  Running         = "RUNNING",
  Done            = "DONE",
  Failed          = "FAILED",
  Blocked         = "BLOCKED",
  WaitingApproval = "WAITING_APPROVAL",
}

export type DecisionType = "TECH_CHOICE" | "ARCH" | "TRADEOFF" | "CONSTRAINT"

// ---------------------------------------------------------------------------
// L2 entity types — mirror the schema.sql tables
// ---------------------------------------------------------------------------

export interface MemoryEntry {
  id: string
  workspace: string
  type: KnowledgeType
  /** Unique key within a workspace — used for upsert */
  key: string
  value: string
  sourceAgent?: string
  tags?: string[]
  /** ISO 8601 */
  createdAt: string
  /** ISO 8601 */
  updatedAt: string
}

export interface TaskRecord {
  taskId: string
  agentId: string
  workspace: string
  status: TaskStatus
  resultSummary?: string
  costUsd: number
  tokensUsed: number
  /** ISO 8601 */
  startedAt: string
  /** ISO 8601 — undefined until terminal state */
  completedAt?: string
}

export interface Decision {
  id: string
  workspace: string
  agentId: string
  decisionType: DecisionType
  summary: string
  reasoning: string
  filesAffected: string[]
  /** ISO 8601 */
  createdAt: string
}

export interface FileContext {
  /** Path relative to workspace root */
  path: string
  workspace: string
  /** One-paragraph summary of file content (saves tokens on re-read) */
  summary: string
  tags: string[]
  /** ISO 8601 */
  lastAccessedAt: string
  /** ISO 8601 — undefined if never written by an agent */
  lastWrittenAt?: string
}

// ---------------------------------------------------------------------------
// Query types
// ---------------------------------------------------------------------------

export interface MemoryQuery {
  workspace: string
  keywords?: string[]
  type?: KnowledgeType
  /** Max results to return */
  limit: number
  /** Only entries created after this ISO 8601 timestamp */
  sinceDate?: string
}

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

export interface IMemoryService {
  /** Insert or update a knowledge entry (keyed on workspace + key) */
  upsert(entry: MemoryEntry): Promise<void>

  /** Full-text search across knowledge entries */
  query(q: MemoryQuery): Promise<MemoryEntry[]>

  /** Append a completed task record */
  recordTask(record: TaskRecord): Promise<void>

  /** Return recent task records for a workspace, newest first */
  getTaskHistory(workspace: string, limit: number): Promise<TaskRecord[]>

  /** Return cached file summary, or null if not yet seen */
  getFileContext(workspace: string, path: string): Promise<FileContext | null>

  /** Insert or update a file context summary */
  upsertFileContext(ctx: FileContext): Promise<void>

  /** Append an architectural or technical decision */
  recordDecision(decision: Decision): Promise<void>

  /** Return recent decisions for a workspace, newest first */
  getDecisions(workspace: string, limit: number): Promise<Decision[]>
}
