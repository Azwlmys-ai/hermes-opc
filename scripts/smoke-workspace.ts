// =============================================================================
// scripts/smoke-workspace.ts — Day 9 workspace sandbox smoke test
//
// Tests WorkspaceService directly (no MCP protocol layer).
// Verifies:
//   · write / read / list round-trip
//   · sandbox blocks ../ path traversal
//   · sandbox blocks absolute paths
//   · audit log is written
//
// Run: pnpm smoke:workspace
// No API key required — pure filesystem test.
// =============================================================================

import { WorkspaceService } from "../packages/workspace/src/workspace-service.js"
import { rmSync, existsSync, readFileSync } from "node:fs"
import { join }                             from "node:path"

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  ✓  ${label}`)
}

function fail(label: string, detail = ""): void {
  failed++
  console.error(`  ✗  ${label}${detail ? `\n       ${detail}` : ""}`)
}

function assert(condition: boolean, label: string, detail = ""): void {
  if (condition) pass(label)
  else           fail(label, detail)
}

/** Assert that fn() throws (sync or async). Returns the caught error. */
async function assertThrows(
  fn:    () => unknown,
  label: string,
): Promise<Error | undefined> {
  try {
    await fn()
    fail(`${label} — expected an error but none was thrown`)
    return undefined
  } catch (err) {
    pass(label)
    return err instanceof Error ? err : new Error(String(err))
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  Hermes v0.1 — Workspace Sandbox Smoke Test")
  console.log("══════════════════════════════════════════════════════\n")

  const ROOT        = process.env["HERMES_ROOT"] ?? process.cwd()
  const WORKSPACE   = "smoke-ws-test"
  const wsRoot      = join(ROOT, "projects", WORKSPACE)
  const auditLog    = join(ROOT, "audit", `${WORKSPACE}.log`)

  // Clean up from any prior run
  if (existsSync(wsRoot))   rmSync(wsRoot,   { recursive: true, force: true })
  if (existsSync(auditLog)) rmSync(auditLog, { force: true })

  const ws = new WorkspaceService(WORKSPACE, ROOT)

  // ── 1. Workspace root created ─────────────────────────────────────────────
  console.log("─── 1. Workspace creation ─────────────────────────────────────\n")
  assert(existsSync(wsRoot), `workspace root created at ${wsRoot}`)
  assert(ws.root === wsRoot, `ws.root matches expected path`)

  // ── 2. writeFile ──────────────────────────────────────────────────────────
  console.log("\n─── 2. writeFile ──────────────────────────────────────────────\n")

  await ws.writeFile("hello.txt", "Hello, Hermes!", "smoke-agent")
  assert(existsSync(join(wsRoot, "hello.txt")), "hello.txt exists on disk")

  await ws.writeFile("sub/dir/nested.txt", "nested content", "smoke-agent")
  assert(existsSync(join(wsRoot, "sub", "dir", "nested.txt")), "nested file created with parent dirs")

  // ── 3. readFile ───────────────────────────────────────────────────────────
  console.log("\n─── 3. readFile ───────────────────────────────────────────────\n")

  const content = await ws.readFile("hello.txt", "smoke-agent")
  assert(content === "Hello, Hermes!", `readFile returns correct content (got: "${content}")`)

  const nested = await ws.readFile("sub/dir/nested.txt", "smoke-agent")
  assert(nested === "nested content", "readFile works for nested paths")

  // ── 4. listFiles ─────────────────────────────────────────────────────────
  console.log("\n─── 4. listFiles ──────────────────────────────────────────────\n")

  const files = await ws.listFiles()
  const paths  = files.map(f => f.path)

  assert(
    paths.some(p => p === "hello.txt" || p.endsWith("hello.txt")),
    `listFiles contains hello.txt (got: [${paths.join(", ")}])`,
  )
  assert(
    paths.some(p => p.includes("nested.txt")),
    "listFiles contains nested.txt",
  )
  assert(files.every(f => f.sizeBytes >= 0), "all entries have sizeBytes ≥ 0")

  // Pattern filter
  const filtered = await ws.listFiles("nested")
  assert(
    filtered.length === 1 && filtered[0] !== undefined && filtered[0].path.includes("nested"),
    `listFiles("nested") returns exactly 1 match (got ${filtered.length})`,
  )

  // ── 5. exists ─────────────────────────────────────────────────────────────
  console.log("\n─── 5. exists ─────────────────────────────────────────────────\n")

  assert(await ws.exists("hello.txt"),           "exists() true for present file")
  assert(!await ws.exists("nonexistent.txt"),    "exists() false for absent file")

  // ── 6. mkdir ──────────────────────────────────────────────────────────────
  console.log("\n─── 6. mkdir ──────────────────────────────────────────────────\n")

  await ws.mkdir("new-dir/child", "smoke-agent")
  assert(existsSync(join(wsRoot, "new-dir", "child")), "mkdir creates nested directories")

  // ── 7. Sandbox: path traversal (../) blocked ──────────────────────────────
  console.log("\n─── 7. Sandbox — path traversal blocked ───────────────────────\n")

  const errTraverse = await assertThrows(
    () => ws.readFile("../outside.txt", "smoke-agent"),
    'readFile("../outside.txt") throws sandbox error',
  )
  assert(
    errTraverse?.message.includes("escapes") === true,
    `error message mentions "escapes" (got: "${errTraverse?.message ?? ""}")`,
  )

  await assertThrows(
    () => ws.writeFile("../../etc/passwd", "pwned", "smoke-agent"),
    'writeFile("../../etc/passwd") throws sandbox error',
  )

  await assertThrows(
    () => ws.readFile("sub/../../outside.txt", "smoke-agent"),
    'readFile("sub/../../outside.txt") throws sandbox error',
  )

  // ── 8. Sandbox: absolute paths blocked ────────────────────────────────────
  console.log("\n─── 8. Sandbox — absolute paths blocked ───────────────────────\n")

  const errAbsRead = await assertThrows(
    () => ws.readFile("/tmp/outside.txt", "smoke-agent"),
    'readFile("/tmp/outside.txt") throws absolute-path error',
  )
  assert(
    errAbsRead?.message.includes("absolute") === true,
    `error message mentions "absolute" (got: "${errAbsRead?.message ?? ""}")`,
  )

  await assertThrows(
    () => ws.writeFile("/tmp/outside.txt", "pwned", "smoke-agent"),
    'writeFile("/tmp/outside.txt") throws absolute-path error',
  )

  await assertThrows(
    () => ws.mkdir("/tmp/evil", "smoke-agent"),
    'mkdir("/tmp/evil") throws absolute-path error',
  )

  // ── 9. Audit log written ──────────────────────────────────────────────────
  console.log("\n─── 9. Audit log ──────────────────────────────────────────────\n")

  assert(existsSync(auditLog), "audit log file created")

  const logLines = readFileSync(auditLog, "utf8")
    .split("\n")
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as { op: string; path: string; agentId: string })

  assert(logLines.length >= 4, `audit log has ≥ 4 entries (got ${logLines.length})`)
  assert(
    logLines.some(e => e.op === "write" && e.path === "hello.txt"),
    'audit log contains write entry for hello.txt',
  )
  assert(
    logLines.some(e => e.op === "read"  && e.path === "hello.txt"),
    'audit log contains read entry for hello.txt',
  )
  assert(
    logLines.every(e => typeof e.agentId === "string"),
    "all audit entries have agentId",
  )

  console.log(`\n  Sample audit entries:`)
  for (const entry of logLines.slice(0, 3)) {
    console.log(`    ${JSON.stringify(entry)}`)
  }

  // ── 10. applyPatch round-trip ─────────────────────────────────────────────
  console.log("\n─── 10. applyPatch ────────────────────────────────────────────\n")

  const applied = await ws.applyPatch({
    taskId:     "task-smoke-001",
    agentId:    "coder-smoke",
    summary:    "Update hello.txt",
    proposedAt: new Date().toISOString(),
    patches: [
      {
        path:            "hello.txt",
        originalContent: "",
        modifiedContent: "Hello, Hermes! Patch applied.",
        diff:            "",
        hunks:           [],
      },
    ],
  })

  assert(applied.length === 1,                        "applyPatch returns 1 applied patch")
  assert(applied[0]?.diff !== "",                     "applyPatch computes diff")
  assert(applied[0]?.diff.includes("---") === true,   "diff contains unified diff header")

  const afterPatch = await ws.readFile("hello.txt")
  assert(
    afterPatch === "Hello, Hermes! Patch applied.",
    `readFile after applyPatch returns updated content (got: "${afterPatch}")`,
  )

  // ── Clean up ──────────────────────────────────────────────────────────────
  rmSync(wsRoot, { recursive: true, force: true })

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n══════════════════════════════════════════════════════`)
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log(`══════════════════════════════════════════════════════\n`)

  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error("\nUnhandled error:", err)
  process.exit(1)
})
