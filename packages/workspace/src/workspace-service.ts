// =============================================================================
// WorkspaceService — sandboxed file I/O for a single workspace.
//
// All paths are relative to:  {HERMES_ROOT}/projects/{workspaceId}/
// All writes are logged to:   {HERMES_ROOT}/audit/{workspaceId}.log
//
// No path may escape the sandbox (assertSafe enforces this).
// All sync fs calls are wrapped in Promise.resolve() to satisfy the async
// IWorkspaceService contract while keeping the implementation simple.
// =============================================================================

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs"
import { join, dirname, relative, sep } from "node:path"
import { assertSafe, resolveWorkspacePath } from "./sandbox.js"
import { AuditLogger }                      from "./audit.js"
import { computeDiff, parseDiffHunks }      from "./diff.js"
import type {
  IWorkspaceService,
  FileEntry,
  FilePatch,
  PatchProposal,
} from "./types.js"

// ── Minimal event bus interface (local, to avoid cross-package dependency) ──

interface IEventBus {
  emit<TPayload = Record<string, unknown>>(input: {
    source: string
    type: string
    level?: string
    workspaceId: string
    taskId?: string
    payload?: TPayload
  }): unknown
  queryEvents?(query: Record<string, unknown>): unknown[]
}

// ---------------------------------------------------------------------------
// WorkspaceService
// ---------------------------------------------------------------------------

export class WorkspaceService implements IWorkspaceService {
  readonly workspaceId: string
  readonly root:        string

  private readonly audit:    AuditLogger
  private readonly eventBus: IEventBus | undefined

  constructor(workspaceId: string, hermesRoot: string, eventBus?: IEventBus) {
    this.workspaceId = workspaceId
    this.root        = resolveWorkspacePath(hermesRoot, workspaceId)
    this.audit       = new AuditLogger(hermesRoot, workspaceId)
    this.eventBus    = eventBus

    // Ensure the workspace directory exists
    mkdirSync(this.root, { recursive: true })
  }

  // ── readFile ──────────────────────────────────────────────────────────────

  readFile(relPath: string, agentId = "system"): Promise<string> {
    const abs   = assertSafe(this.root, relPath)
    const start = Date.now()
    const content = readFileSync(abs, "utf8")
    this.audit.log({
      ts:          new Date().toISOString(),
      op:          "read",
      path:        relPath,
      agentId,
      sizeBytes:   Buffer.byteLength(content, "utf8"),
      durationMs:  Date.now() - start,
    })
    return Promise.resolve(content)
  }

  // ── writeFile ─────────────────────────────────────────────────────────────

  writeFile(relPath: string, content: string, agentId: string): Promise<void> {
    const abs   = assertSafe(this.root, relPath)
    const start = Date.now()
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content, "utf8")
    this.audit.log({
      ts:          new Date().toISOString(),
      op:          "write",
      path:        relPath,
      agentId,
      sizeBytes:   Buffer.byteLength(content, "utf8"),
      durationMs:  Date.now() - start,
    })
    return Promise.resolve()
  }

  // ── listFiles ─────────────────────────────────────────────────────────────

  listFiles(pattern?: string): Promise<FileEntry[]> {
    this.audit.log({
      ts:      new Date().toISOString(),
      op:      "list",
      path:    pattern ?? "**",
      agentId: "system",
    })

    const entries = readdirSync(this.root, { recursive: true, withFileTypes: true })
    const result: FileEntry[] = []

    for (const entry of entries) {
      // Skip directories; callers can detect them via isDir in mixed listings
      const absEntry = join(entry.parentPath, entry.name)
      const rel      = relative(this.root, absEntry)

      if (pattern !== undefined) {
        // Simple substring / prefix filter (full glob deferred to v0.2)
        const needle = pattern.replace(/\*+/g, "")
        if (needle.length > 0 && !rel.includes(needle)) continue
      }

      try {
        const stat = statSync(absEntry)
        result.push({
          path:       rel.split(sep).join("/"),   // normalise to forward slashes
          sizeBytes:  stat.size,
          isDir:      stat.isDirectory(),
          modifiedAt: stat.mtime.toISOString(),
        })
      } catch {
        // File may have been removed between readdir and stat — skip
      }
    }

    return Promise.resolve(result)
  }

  // ── mkdir ─────────────────────────────────────────────────────────────────

  mkdir(relPath: string, agentId: string): Promise<void> {
    const abs = assertSafe(this.root, relPath)
    mkdirSync(abs, { recursive: true })
    this.audit.log({
      ts:      new Date().toISOString(),
      op:      "mkdir",
      path:    relPath,
      agentId,
    })
    return Promise.resolve()
  }

  // ── exists ────────────────────────────────────────────────────────────────

  exists(relPath: string): Promise<boolean> {
    try {
      const abs = assertSafe(this.root, relPath)
      return Promise.resolve(existsSync(abs))
    } catch {
      return Promise.resolve(false)
    }
  }

  // ── applyPatch ────────────────────────────────────────────────────────────

  /**
   * Apply a PatchProposal to disk (full-file replacement per patch).
   *
   * For each patch:
   *   1. Read the current file content (empty string if new file)
   *   2. Compute unified diff: current → modifiedContent
   *   3. Write modifiedContent to disk
   *   4. Append a "patch" entry to the audit log
   *   5. Collect applied FilePatch for the caller
   *
   * Throws on the first sandbox violation; successfully written files are
   * NOT rolled back (atomic transactional writes are deferred to v0.2).
   */
  async applyPatch(proposal: PatchProposal): Promise<FilePatch[]> {
    // Emit patch.proposed before applying
    if (this.eventBus) {
      this.eventBus.emit({
        source: "workspace",
        type: "workspace.patch.proposed",
        level: "info",
        workspaceId: this.workspaceId,
        taskId: proposal.taskId,
        payload: {
          summary: proposal.summary,
          patchCount: proposal.patches.length,
          paths: proposal.patches.map(patch => patch.path),
          agentId: proposal.agentId,
        },
      })
    }

    const applied: FilePatch[] = []

    for (const patch of proposal.patches) {
      const abs   = assertSafe(this.root, patch.path)
      const start = Date.now()

      // Read current content (may not exist for new files)
      let currentContent = ""
      if (existsSync(abs)) {
        currentContent = readFileSync(abs, "utf8")
      }

      // Compute diff before writing
      const diff  = computeDiff(currentContent, patch.modifiedContent, patch.path)
      const hunks = parseDiffHunks(diff)

      // Write
      mkdirSync(dirname(abs), { recursive: true })
      writeFileSync(abs, patch.modifiedContent, "utf8")

      this.audit.log({
        ts:          new Date().toISOString(),
        op:          "patch",
        path:        patch.path,
        agentId:     proposal.agentId,
        sizeBytes:   Buffer.byteLength(patch.modifiedContent, "utf8"),
        durationMs:  Date.now() - start,
      })

      applied.push({
        path:            patch.path,
        originalContent: currentContent,
        modifiedContent: patch.modifiedContent,
        diff,
        hunks,
      })
    }

    // Emit patch.applied after all writes
    if (this.eventBus) {
      this.eventBus.emit({
        source: "workspace",
        type: "workspace.patch.applied",
        level: "info",
        workspaceId: this.workspaceId,
        taskId: proposal.taskId,
        payload: {
          summary: proposal.summary,
          patchCount: applied.length,
          paths: applied.map(patch => patch.path),
          agentId: proposal.agentId,
        },
      })
    }

    return applied
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a WorkspaceService for the given workspace.
 * Uses HERMES_ROOT env var or process.cwd() as the Hermes root.
 */
export function createWorkspaceService(
  workspaceId: string,
  hermesRoot?: string,
  eventBus?: IEventBus,
): WorkspaceService {
  const root = hermesRoot ?? process.env["HERMES_ROOT"] ?? process.cwd()
  return new WorkspaceService(workspaceId, root, eventBus)
}
