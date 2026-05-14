// =============================================================================
// diff.ts — Unified diff computation and patch application.
//
// v0.1 scope:
//   · computeDiff   — produce a unified diff between two strings
//   · applyPatch    — replace content (full-file replacement, no hunk merging)
//   · parseDiffHunks — extract DiffHunk[] from a unified diff string
//
// The diff algorithm finds common prefix/suffix lines, then emits a single
// hunk for the changed middle section. This produces correct unified diffs
// for the common case (agent rewrites a contiguous block). Multi-hunk diffs
// from external tools can be stored in FilePatch.diff as-is.
//
// v0.2 will introduce proper Myers/patience diff for multi-hunk output.
// =============================================================================

import type { DiffHunk } from "./types.js"

// ---------------------------------------------------------------------------
// computeDiff
// ---------------------------------------------------------------------------

/**
 * Compute a unified diff between `original` and `modified`.
 *
 * Returns an empty string when the contents are identical.
 * The header uses git-style `a/` and `b/` prefixes.
 */
export function computeDiff(
  original: string,
  modified: string,
  filePath: string,
): string {
  if (original === modified) return ""

  const origLines = splitLines(original)
  const modLines  = splitLines(modified)

  // Find longest common prefix (line-by-line)
  let prefixLen = 0
  while (
    prefixLen < origLines.length &&
    prefixLen < modLines.length &&
    origLines[prefixLen] === modLines[prefixLen]
  ) prefixLen++

  // Find longest common suffix, working backwards from the ends
  // but not overlapping the already-matched prefix
  let origTail = origLines.length - 1
  let modTail  = modLines.length  - 1
  while (
    origTail >= prefixLen &&
    modTail  >= prefixLen &&
    origLines[origTail] === modLines[modTail]
  ) {
    origTail--
    modTail--
  }

  // The changed region in each file
  const removedLines = origLines.slice(prefixLen, origTail  + 1)
  const addedLines   = modLines.slice( prefixLen, modTail   + 1)

  const origStart = prefixLen + 1           // 1-based
  const newStart  = prefixLen + 1
  const origCount = removedLines.length
  const newCount  = addedLines.length

  const header = `--- a/${filePath}\n+++ b/${filePath}`
  const hunk   = `@@ -${origStart},${origCount} +${newStart},${newCount} @@`
  const body   = [
    ...removedLines.map(l => `-${l}`),
    ...addedLines.map(l =>   `+${l}`),
  ].join("\n")

  return `${header}\n${hunk}\n${body}`
}

// ---------------------------------------------------------------------------
// parseDiffHunks
// ---------------------------------------------------------------------------

/**
 * Parse hunk metadata from a unified diff string.
 * Lines are stored verbatim (with their +/-/space prefix).
 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  if (diff.trim().length === 0) return []

  const hunks:   DiffHunk[] = []
  let   current: DiffHunk | undefined

  for (const line of diff.split("\n")) {
    // @@ -origStart,origCount +newStart,newCount @@
    const m = line.match(/^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/)
    if (m !== null) {
      if (current !== undefined) hunks.push(current)
      current = {
        origStart: parseInt(m[1]!, 10),
        origCount: parseInt(m[2]!, 10),
        newStart:  parseInt(m[3]!, 10),
        newCount:  parseInt(m[4]!, 10),
        lines:     [],
      }
      continue
    }
    if (current !== undefined && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      current.lines.push(line)
    }
  }
  if (current !== undefined) hunks.push(current)

  return hunks
}

// ---------------------------------------------------------------------------
// applyPatch
// ---------------------------------------------------------------------------

/**
 * Apply a unified diff patch to `original`.
 *
 * v0.1 strategy: hunk-by-hunk line replacement with strict offset tracking.
 * Assumes the patch was generated against `original` (no conflict resolution).
 *
 * Returns the patched content, or throws if a hunk cannot be applied cleanly.
 */
export function applyPatch(original: string, diff: string): string {
  if (diff.trim().length === 0) return original

  const hunks    = parseDiffHunks(diff)
  const lines    = splitLines(original)
  const output:  string[] = []
  let   srcIdx   = 0   // 0-based index into `lines`

  for (const hunk of hunks) {
    const hunkStart = hunk.origStart - 1    // convert to 0-based

    if (hunkStart < srcIdx) {
      throw new Error(
        `Patch hunk at line ${hunk.origStart} overlaps already-applied content`,
      )
    }

    // Copy unchanged lines up to this hunk
    for (let i = srcIdx; i < hunkStart; i++) {
      output.push(lines[i] ?? "")
    }
    srcIdx = hunkStart

    // Apply hunk lines
    for (const diffLine of hunk.lines) {
      const prefix = diffLine[0]
      const body   = diffLine.slice(1)

      if (prefix === " ") {
        // Context line — must match source
        if (lines[srcIdx] !== body) {
          throw new Error(
            `Context mismatch at line ${srcIdx + 1}: ` +
            `expected "${lines[srcIdx] ?? ""}", got "${body}"`,
          )
        }
        output.push(body)
        srcIdx++
      } else if (prefix === "-") {
        // Remove line — consume from source without emitting
        srcIdx++
      } else if (prefix === "+") {
        // Add line — emit without consuming source
        output.push(body)
      }
    }
  }

  // Copy remaining unchanged lines
  for (let i = srcIdx; i < lines.length; i++) {
    output.push(lines[i] ?? "")
  }

  return output.join("\n")
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function splitLines(text: string): string[] {
  if (text === "") return []
  // Preserve trailing newline behaviour: "a\n" → ["a"] not ["a",""]
  const lines = text.split("\n")
  if (lines.at(-1) === "") lines.pop()
  return lines
}
