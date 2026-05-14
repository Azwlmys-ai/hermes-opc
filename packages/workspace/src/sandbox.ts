// =============================================================================
// sandbox.ts — Path-containment enforcement for workspace operations.
//
// Rules:
//   · Absolute paths are always rejected (all caller paths must be relative)
//   · After resolving to absolute, the result must be inside workspaceRoot
//   · Normalisation happens before the check — no "a/b/../../../etc" escapes
//   · Symlinks are NOT followed (resolveWorkspacePath is not realpath)
//     A symlink inside the workspace that points outside is a workspace
//     misconfiguration, not a concern of the sandbox layer.
// =============================================================================

import { normalize, resolve, relative, isAbsolute, sep } from "node:path"

/**
 * Resolve a caller-supplied path within the workspace root and verify it
 * does not escape the sandbox.
 *
 * @param workspaceRoot  Absolute path to the workspace root directory.
 * @param relPath        Caller-supplied relative path (must NOT be absolute).
 * @returns              Absolute, normalized path guaranteed to be inside root.
 * @throws               If the path is absolute or escapes the sandbox.
 */
export function assertSafe(workspaceRoot: string, relPath: string): string {
  if (isAbsolute(relPath)) {
    throw new Error(
      `Workspace paths must be relative — got absolute path: "${relPath}"`,
    )
  }

  // Resolve then normalise — this collapses any ../ segments
  const abs = normalize(resolve(workspaceRoot, relPath))

  // relative() returns a path starting with ".." when abs is outside root
  const rel = relative(workspaceRoot, abs)

  if (rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    throw new Error(
      `Path "${relPath}" escapes the workspace sandbox. ` +
      `All paths must remain within: "${workspaceRoot}"`,
    )
  }

  return abs
}

/**
 * Return the absolute path to a workspace root directory.
 * Does NOT check existence.
 */
export function resolveWorkspacePath(hermesRoot: string, workspaceId: string): string {
  return normalize(resolve(hermesRoot, "projects", workspaceId))
}
