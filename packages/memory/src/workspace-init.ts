// =============================================================================
// workspace-init.ts
// Factory that resolves paths, ensures directories exist, reads schema.sql,
// and returns a ready-to-use SQLiteMemoryService.
//
// Keeps SQLiteMemoryService free of filesystem concerns — easier to test.
// =============================================================================

import { mkdirSync, readFileSync } from "node:fs"
import { join }                    from "node:path"
import { SQLiteMemoryService }     from "./sqlite-memory-service.js"

/**
 * Create and initialise an L2 memory service for the given workspace.
 *
 * Directory layout created (if absent):
 *   {hermesRoot}/projects/{workspace}/.hermes/memory.db
 *
 * Schema read from:
 *   {hermesRoot}/packages/memory/src/schema.sql
 *
 * @param workspace  Workspace slug (e.g. "hermes-v1").
 * @param hermesRoot Absolute path to the Hermes root directory.
 *                   Falls back to HERMES_ROOT env var, then process.cwd().
 */
export function createMemoryService(
  workspace: string,
  hermesRoot?: string,
): SQLiteMemoryService {
  const root       = hermesRoot ?? process.env["HERMES_ROOT"] ?? process.cwd()
  const dbDir      = join(root, "projects", workspace, ".hermes")
  const dbPath     = join(dbDir, "memory.db")
  const schemaPath = join(root, "packages", "memory", "src", "schema.sql")

  mkdirSync(dbDir, { recursive: true })

  const schemaSql = readFileSync(schemaPath, "utf8")
  return new SQLiteMemoryService(dbPath, schemaSql)
}
