// =============================================================================
// SQLiteMemoryService — L2 Project Memory backed by node:sqlite (built-in).
//
// Design decisions:
//   · node:sqlite (Node 22+) replaces better-sqlite3 — no native compilation
//   · Synchronous DB API wrapped in Promise.resolve() to satisfy IMemoryService
//   · One DB file per workspace: projects/{slug}/.hermes/memory.db
//   · schema.sql injected by caller — class has no filesystem knowledge
//   · No any — all DB rows narrowed from unknown via type guards
//   · Parameterised queries only — no SQL string concatenation of user data
//   · tags / filesAffected stored as JSON text, parsed on read
//   · DB null  →  TS undefined (exactOptionalPropertyTypes compliant)
// =============================================================================

import { DatabaseSync } from "node:sqlite"
import { randomUUID }   from "node:crypto"
import type {
  IMemoryService,
  MemoryEntry,
  MemoryQuery,
  TaskRecord,
  FileContext,
  Decision,
} from "./types.js"
import { KnowledgeType, TaskStatus } from "./types.js"
import type { DecisionType } from "./types.js"

// ---------------------------------------------------------------------------
// Private row types — DB column names in snake_case
// Never exported; the public API uses the camelCase TS types.
// ---------------------------------------------------------------------------

interface KnowledgeRow {
  id:           string
  workspace:    string
  type:         string
  key:          string
  value:        string
  source_agent: string | null
  tags:         string | null
  created_at:   string
  updated_at:   string
}

interface TaskRow {
  task_id:        string
  agent_id:       string
  workspace:      string
  status:         string
  result_summary: string | null
  cost_usd:       number
  tokens_used:    number
  started_at:     string
  completed_at:   string | null
}

interface FileContextRow {
  id:               string
  path:             string
  workspace:        string
  summary:          string
  tags:             string | null
  last_accessed_at: string
  last_written_at:  string | null
}

interface DecisionRow {
  id:             string
  workspace:      string
  agent_id:       string
  decision_type:  string
  summary:        string
  reasoning:      string
  files_affected: string | null
  created_at:     string
}

// ---------------------------------------------------------------------------
// Primitive type guards
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string {
  return typeof v === "string"
}

function isNumber(v: unknown): v is number {
  return typeof v === "number"
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string"
}

// ---------------------------------------------------------------------------
// Row-shape type guards (narrow unknown DB output)
// ---------------------------------------------------------------------------

function isKnowledgeRow(v: unknown): v is KnowledgeRow {
  if (!isRecord(v)) return false
  return (
    isString(v["id"])           &&
    isString(v["workspace"])    &&
    isString(v["type"])         &&
    isString(v["key"])          &&
    isString(v["value"])        &&
    isNullableString(v["source_agent"]) &&
    isNullableString(v["tags"]) &&
    isString(v["created_at"])   &&
    isString(v["updated_at"])
  )
}

function isTaskRow(v: unknown): v is TaskRow {
  if (!isRecord(v)) return false
  return (
    isString(v["task_id"])      &&
    isString(v["agent_id"])     &&
    isString(v["workspace"])    &&
    isString(v["status"])       &&
    isNullableString(v["result_summary"]) &&
    isNumber(v["cost_usd"])     &&
    isNumber(v["tokens_used"])  &&
    isString(v["started_at"])   &&
    isNullableString(v["completed_at"])
  )
}

function isFileContextRow(v: unknown): v is FileContextRow {
  if (!isRecord(v)) return false
  return (
    isString(v["id"])            &&
    isString(v["path"])          &&
    isString(v["workspace"])     &&
    isString(v["summary"])       &&
    isNullableString(v["tags"])  &&
    isString(v["last_accessed_at"]) &&
    isNullableString(v["last_written_at"])
  )
}

function isDecisionRow(v: unknown): v is DecisionRow {
  if (!isRecord(v)) return false
  return (
    isString(v["id"])             &&
    isString(v["workspace"])      &&
    isString(v["agent_id"])       &&
    isString(v["decision_type"])  &&
    isString(v["summary"])        &&
    isString(v["reasoning"])      &&
    isNullableString(v["files_affected"]) &&
    isString(v["created_at"])
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse a JSON-serialised string[] stored in a TEXT column. */
function parseTags(raw: string | null): string[] {
  if (raw === null) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter(isString) : []
  } catch {
    return []
  }
}

/** Split schema SQL into individual statements for exec() calls. */
function splitSql(sql: string): string[] {
  return sql
    .split(";")
    .map(s => s.trim())
    .filter(s => s.length > 0)
}

// ---------------------------------------------------------------------------
// Row → TypeScript type converters
// ---------------------------------------------------------------------------

function rowToMemoryEntry(row: KnowledgeRow): MemoryEntry {
  const entry: MemoryEntry = {
    id:        row.id,
    workspace: row.workspace,
    type:      row.type as KnowledgeType,
    key:       row.key,
    value:     row.value,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
  if (row.source_agent !== null) entry.sourceAgent = row.source_agent
  const tags = parseTags(row.tags)
  if (tags.length > 0)           entry.tags = tags
  return entry
}

function rowToTaskRecord(row: TaskRow): TaskRecord {
  const record: TaskRecord = {
    taskId:     row.task_id,
    agentId:    row.agent_id,
    workspace:  row.workspace,
    status:     row.status as TaskStatus,
    costUsd:    row.cost_usd,
    tokensUsed: row.tokens_used,
    startedAt:  row.started_at,
  }
  if (row.result_summary !== null) record.resultSummary = row.result_summary
  if (row.completed_at   !== null) record.completedAt   = row.completed_at
  return record
}

function rowToFileContext(row: FileContextRow): FileContext {
  const ctx: FileContext = {
    path:           row.path,
    workspace:      row.workspace,
    summary:        row.summary,
    tags:           parseTags(row.tags),
    lastAccessedAt: row.last_accessed_at,
  }
  if (row.last_written_at !== null) ctx.lastWrittenAt = row.last_written_at
  return ctx
}

function rowToDecision(row: DecisionRow): Decision {
  return {
    id:            row.id,
    workspace:     row.workspace,
    agentId:       row.agent_id,
    decisionType:  row.decision_type as DecisionType,
    summary:       row.summary,
    reasoning:     row.reasoning,
    filesAffected: parseTags(row.files_affected),
    createdAt:     row.created_at,
  }
}

// ---------------------------------------------------------------------------
// SQLiteMemoryService
// ---------------------------------------------------------------------------

export class SQLiteMemoryService implements IMemoryService {
  private readonly db: DatabaseSync

  /**
   * Opens the SQLite database at `dbPath` and initialises the schema.
   * The parent directory must already exist (use `createMemoryService`).
   *
   * @param dbPath    Absolute path to the .db file (created if absent).
   * @param schemaSql Content of schema.sql — executed once on open.
   */
  constructor(dbPath: string, schemaSql: string) {
    this.db = new DatabaseSync(dbPath)
    for (const stmt of splitSql(schemaSql)) {
      this.db.exec(stmt)
    }
  }

  // ── upsert ────────────────────────────────────────────────────────────────

  upsert(entry: MemoryEntry): Promise<void> {
    this.db.prepare(`
      INSERT INTO knowledge
        (id, workspace, type, key, value, source_agent, tags, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace, key) DO UPDATE SET
        type         = excluded.type,
        value        = excluded.value,
        source_agent = excluded.source_agent,
        tags         = excluded.tags,
        updated_at   = excluded.updated_at
    `).run(
      entry.id,
      entry.workspace,
      entry.type,
      entry.key,
      entry.value,
      entry.sourceAgent   ?? null,
      entry.tags !== undefined ? JSON.stringify(entry.tags) : null,
      entry.createdAt,
      entry.updatedAt,
    )
    return Promise.resolve()
  }

  // ── query ─────────────────────────────────────────────────────────────────

  query(q: MemoryQuery): Promise<MemoryEntry[]> {
    // Build WHERE clause dynamically — only fixed strings are appended,
    // all user values go through positional parameters (no injection risk).
    const conditions: string[]              = ["workspace = ?"]
    const bindings:   (string | number | null)[] = [q.workspace]

    if (q.type !== undefined) {
      conditions.push("type = ?")
      bindings.push(q.type)
    }

    if (q.sinceDate !== undefined) {
      conditions.push("created_at >= ?")
      bindings.push(q.sinceDate)
    }

    if (q.keywords !== undefined && q.keywords.length > 0) {
      for (const kw of q.keywords) {
        // LIKE with % — metachar escaping deferred to v0.2 (ESCAPE clause)
        conditions.push("(key LIKE ? OR value LIKE ?)")
        bindings.push(`%${kw}%`, `%${kw}%`)
      }
    }

    bindings.push(q.limit)

    const sql = `
      SELECT * FROM knowledge
      WHERE ${conditions.join(" AND ")}
      ORDER BY updated_at DESC
      LIMIT ?
    `

    const rows = this.db.prepare(sql).all(...bindings)
    const entries: MemoryEntry[] = []
    for (const row of rows) {
      if (isKnowledgeRow(row)) entries.push(rowToMemoryEntry(row))
    }
    return Promise.resolve(entries)
  }

  // ── recordTask ────────────────────────────────────────────────────────────

  recordTask(record: TaskRecord): Promise<void> {
    this.db.prepare(`
      INSERT INTO tasks_history
        (task_id, agent_id, workspace, status,
         result_summary, cost_usd, tokens_used, started_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.taskId,
      record.agentId,
      record.workspace,
      record.status,
      record.resultSummary ?? null,
      record.costUsd,
      record.tokensUsed,
      record.startedAt,
      record.completedAt   ?? null,
    )
    return Promise.resolve()
  }

  // ── getTaskHistory ────────────────────────────────────────────────────────

  getTaskHistory(workspace: string, limit: number): Promise<TaskRecord[]> {
    const rows = this.db.prepare(`
      SELECT * FROM tasks_history
      WHERE workspace = ?
      ORDER BY started_at DESC
      LIMIT ?
    `).all(workspace, limit)

    const records: TaskRecord[] = []
    for (const row of rows) {
      if (isTaskRow(row)) records.push(rowToTaskRecord(row))
    }
    return Promise.resolve(records)
  }

  // ── getFileContext ────────────────────────────────────────────────────────

  getFileContext(workspace: string, path: string): Promise<FileContext | null> {
    const row = this.db.prepare(`
      SELECT * FROM file_context
      WHERE workspace = ? AND path = ?
    `).get(workspace, path)

    if (!isFileContextRow(row)) return Promise.resolve(null)
    return Promise.resolve(rowToFileContext(row))
  }

  // ── upsertFileContext ─────────────────────────────────────────────────────

  upsertFileContext(ctx: FileContext): Promise<void> {
    this.db.prepare(`
      INSERT INTO file_context
        (id, path, workspace, summary, tags, last_accessed_at, last_written_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace, path) DO UPDATE SET
        summary          = excluded.summary,
        tags             = excluded.tags,
        last_accessed_at = excluded.last_accessed_at,
        last_written_at  = excluded.last_written_at
    `).run(
      randomUUID(),
      ctx.path,
      ctx.workspace,
      ctx.summary,
      JSON.stringify(ctx.tags),
      ctx.lastAccessedAt,
      ctx.lastWrittenAt ?? null,
    )
    return Promise.resolve()
  }

  // ── recordDecision ────────────────────────────────────────────────────────

  recordDecision(decision: Decision): Promise<void> {
    this.db.prepare(`
      INSERT INTO decisions
        (id, workspace, agent_id, decision_type,
         summary, reasoning, files_affected, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.id,
      decision.workspace,
      decision.agentId,
      decision.decisionType,
      decision.summary,
      decision.reasoning,
      decision.filesAffected.length > 0
        ? JSON.stringify(decision.filesAffected)
        : null,
      decision.createdAt,
    )
    return Promise.resolve()
  }

  // ── getDecisions ──────────────────────────────────────────────────────────

  getDecisions(workspace: string, limit: number): Promise<Decision[]> {
    const rows = this.db.prepare(`
      SELECT * FROM decisions
      WHERE workspace = ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(workspace, limit)

    const decisions: Decision[] = []
    for (const row of rows) {
      if (isDecisionRow(row)) decisions.push(rowToDecision(row))
    }
    return Promise.resolve(decisions)
  }

  // ── close ─────────────────────────────────────────────────────────────────

  /** Close the database connection. Call when the Kernel shuts down. */
  close(): void {
    this.db.close()
  }
}
