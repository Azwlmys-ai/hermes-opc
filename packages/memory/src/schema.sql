-- =============================================================================
-- Hermes v0.1 — L2 Project Memory Schema
--
-- One SQLite file per workspace:  projects/{slug}/.hermes/memory.db
-- Applied once at workspace initialisation via CREATE TABLE IF NOT EXISTS.
--
-- Column naming: snake_case (SQL convention).
-- Field naming in TypeScript: camelCase (see types.ts).
-- =============================================================================

PRAGMA journal_mode = WAL;      -- Better concurrent read performance
PRAGMA foreign_keys = ON;

-- =============================================================================
-- knowledge
-- Structured facts, constraints, preferences, warnings, and decisions
-- captured during agent execution within a project.
-- =============================================================================
CREATE TABLE IF NOT EXISTS knowledge (
  id           TEXT NOT NULL PRIMARY KEY,
  workspace    TEXT NOT NULL,
  type         TEXT NOT NULL
                 CHECK (type IN ('FACT','CONSTRAINT','PREFERENCE','WARNING','DECISION')),
  key          TEXT NOT NULL,           -- Human-readable slug, unique per workspace
  value        TEXT NOT NULL,
  source_agent TEXT,                    -- Agent ID that wrote this entry
  tags         TEXT,                    -- JSON array: ["auth","security"]
  created_at   TEXT NOT NULL,           -- ISO 8601
  updated_at   TEXT NOT NULL,           -- ISO 8601

  UNIQUE (workspace, key)               -- Upsert target
);

CREATE INDEX IF NOT EXISTS idx_knowledge_workspace_type
  ON knowledge (workspace, type);

CREATE INDEX IF NOT EXISTS idx_knowledge_updated
  ON knowledge (workspace, updated_at DESC);

-- FTS5 full-text index deferred to v0.2.
-- v0.1 uses LIKE queries — sufficient for small data volumes.
-- v0.2 will introduce sqlite-vss or FTS5 with proper trigger maintenance.

-- =============================================================================
-- tasks_history
-- Immutable record of every task execution for cost tracking and learning.
-- Rows are only inserted, never updated — status is the final terminal value.
-- =============================================================================
CREATE TABLE IF NOT EXISTS tasks_history (
  task_id        TEXT NOT NULL PRIMARY KEY,
  agent_id       TEXT NOT NULL,
  workspace      TEXT NOT NULL,
  status         TEXT NOT NULL
                   CHECK (status IN (
                     'PENDING','READY','RUNNING','DONE',
                     'FAILED','BLOCKED','WAITING_APPROVAL'
                   )),
  result_summary TEXT,                  -- One-paragraph outcome summary
  cost_usd       REAL NOT NULL DEFAULT 0.0,
  tokens_used    INTEGER NOT NULL DEFAULT 0,
  started_at     TEXT NOT NULL,         -- ISO 8601
  completed_at   TEXT                   -- NULL until terminal state reached
);

CREATE INDEX IF NOT EXISTS idx_tasks_workspace_status
  ON tasks_history (workspace, status);

CREATE INDEX IF NOT EXISTS idx_tasks_started
  ON tasks_history (workspace, started_at DESC);

-- =============================================================================
-- file_context
-- Cached one-paragraph summaries of files agents have read or written.
-- Avoids re-reading large files on every agent call.
-- =============================================================================
CREATE TABLE IF NOT EXISTS file_context (
  id               TEXT NOT NULL PRIMARY KEY,
  path             TEXT NOT NULL,       -- Relative to workspace root
  workspace        TEXT NOT NULL,
  summary          TEXT NOT NULL,
  tags             TEXT,                -- JSON array
  last_accessed_at TEXT NOT NULL,       -- ISO 8601
  last_written_at  TEXT,               -- ISO 8601 — NULL if never written by agent

  UNIQUE (workspace, path)             -- Upsert target
);

CREATE INDEX IF NOT EXISTS idx_file_context_workspace
  ON file_context (workspace);

-- =============================================================================
-- decisions
-- Significant architectural or technical decisions made during the project.
-- Append-only — decisions are never updated, only superseded by new ones.
-- =============================================================================
CREATE TABLE IF NOT EXISTS decisions (
  id             TEXT NOT NULL PRIMARY KEY,
  workspace      TEXT NOT NULL,
  agent_id       TEXT NOT NULL,
  decision_type  TEXT NOT NULL
                   CHECK (decision_type IN ('TECH_CHOICE','ARCH','TRADEOFF','CONSTRAINT')),
  summary        TEXT NOT NULL,
  reasoning      TEXT NOT NULL,
  files_affected TEXT,                  -- JSON array of relative paths
  created_at     TEXT NOT NULL          -- ISO 8601
);

CREATE INDEX IF NOT EXISTS idx_decisions_workspace_type
  ON decisions (workspace, decision_type);

CREATE INDEX IF NOT EXISTS idx_decisions_created
  ON decisions (workspace, created_at DESC);
