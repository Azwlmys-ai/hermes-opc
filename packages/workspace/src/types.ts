// =============================================================================
// @hermes/workspace — Type definitions.
// No SDK imports. No internal @hermes/* imports.
// =============================================================================

// ---------------------------------------------------------------------------
// File system
// ---------------------------------------------------------------------------

export interface FileEntry {
  /** Path relative to workspace root */
  path:        string
  sizeBytes:   number
  isDir:       boolean
  /** ISO 8601 */
  modifiedAt:  string
}

// ---------------------------------------------------------------------------
// Diff / Patch
// ---------------------------------------------------------------------------

export interface DiffHunk {
  /** 1-based start line in original file (0 = new file) */
  origStart: number
  origCount: number
  /** 1-based start line in modified file */
  newStart:  number
  newCount:  number
  /** Raw diff lines, each prefixed with " " / "+" / "-" */
  lines:     string[]
}

export interface FilePatch {
  /** Path relative to workspace root */
  path:            string
  originalContent: string
  modifiedContent: string
  /** Unified diff text (empty string when no change) */
  diff:            string
  hunks:           DiffHunk[]
}

export interface PatchProposal {
  taskId:     string
  agentId:    string
  patches:    FilePatch[]
  /** Human-readable summary of what the patches accomplish */
  summary:    string
  /** ISO 8601 */
  proposedAt: string
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export type AuditOp = "read" | "write" | "mkdir" | "patch" | "list"

export interface AuditEntry {
  /** ISO 8601 */
  ts:           string
  op:           AuditOp
  /** Path relative to workspace root */
  path:         string
  agentId:      string
  sizeBytes?:   number
  durationMs?:  number
}

// ---------------------------------------------------------------------------
// Service contract
// ---------------------------------------------------------------------------

export interface IWorkspaceService {
  readonly workspaceId: string
  /** Absolute path to the workspace root directory */
  readonly root:        string

  /**
   * Read file contents.
   * Throws if the path escapes the sandbox or the file doesn't exist.
   */
  readFile(relPath: string, agentId?: string): Promise<string>

  /**
   * Write file, creating any missing parent directories.
   * Records a write entry in the audit log.
   */
  writeFile(relPath: string, content: string, agentId: string): Promise<void>

  /**
   * List files in the workspace.
   * @param pattern Optional substring filter on relative paths.
   */
  listFiles(pattern?: string): Promise<FileEntry[]>

  /** Create directory and parents. Recorded in audit log. */
  mkdir(relPath: string, agentId: string): Promise<void>

  /** Check if a path exists without throwing. */
  exists(relPath: string): Promise<boolean>

  /**
   * Apply a PatchProposal (write each patch's modifiedContent to disk).
   * Returns the list of applied FilePatch objects with computed diffs.
   * Records a patch entry per file in the audit log.
   */
  applyPatch(proposal: PatchProposal): Promise<FilePatch[]>
}
 