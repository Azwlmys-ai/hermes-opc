// =============================================================================
// audit.ts — Append-only audit log for workspace write operations.
//
// Format: one JSON object per line (newline-delimited JSON / NDJSON).
// Location: {HERMES_ROOT}/audit/{workspaceId}.log
//
// appendFileSync is used intentionally — it is atomic for single-process
// writes on POSIX and avoids buffering-related log loss on crash.
// =============================================================================

import { appendFileSync, mkdirSync } from "node:fs"
import { join }                      from "node:path"
import type { AuditEntry }           from "./types.js"

export class AuditLogger {
  private readonly logPath: string

  constructor(hermesRoot: string, workspaceId: string) {
    const auditDir = join(hermesRoot, "audit")
    mkdirSync(auditDir, { recursive: true })
    this.logPath = join(auditDir, `${workspaceId}.log`)
  }

  /** Append one audit entry (one JSON line). Never throws. */
  log(entry: AuditEntry): void {
    try {
      appendFileSync(this.logPath, JSON.stringify(entry) + "\n", "utf8")
    } catch {
      // Audit failure must never crash the agent — silently swallow
    }
  }
}
