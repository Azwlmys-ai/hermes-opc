// =============================================================================
// scripts/smoke-runtime.ts — RuntimeService sandbox smoke test
//
// Tests RuntimeService directly (no MCP protocol layer).
// Verifies whitelisted execution, sandbox constraints, blocked commands,
// timeout handling, and audit logging.
//
// Run: pnpm smoke:runtime
// No API key required — pure local process/sandbox test.
// =============================================================================

import { existsSync, readFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { RuntimeService } from "../packages/runtime/src/runtime-service.js"

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
  else fail(label, detail)
}

async function assertThrows(
  fn: () => unknown,
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

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  RuntimeService Sandbox Smoke Test")
  console.log("══════════════════════════════════════════════════════\n")

  const ROOT = process.env["HERMES_ROOT"] ?? process.cwd()
  const WORKSPACE = "smoke-runtime-test"
  const workspaceRoot = join(ROOT, "projects", WORKSPACE)
  const auditLog = join(ROOT, "audit", `${WORKSPACE}.log`)

  if (existsSync(workspaceRoot)) rmSync(workspaceRoot, { recursive: true, force: true })
  if (existsSync(auditLog)) rmSync(auditLog, { force: true })

  const runtime = new RuntimeService(ROOT)

  console.log("─── 1. Whitelisted command execution ─────────────────────────\n")
  const version = await runtime.execCommand({ workspaceId: WORKSPACE, command: "node --version" })
  assert(version.exitCode === 0, `node --version exits 0 (got ${version.exitCode})`)
  assert(version.stdout.trim().startsWith("v"), `stdout contains node version (${version.stdout.trim()})`)
  assert(existsSync(workspaceRoot), `workspace root created at ${workspaceRoot}`)

  console.log("\n─── 2. cwd sandbox ───────────────────────────────────────────\n")
  const cwdResult = await runtime.execCommand({
    workspaceId: WORKSPACE,
    cwd: "nested/dir",
    command: "node -e console.log(process.cwd())",
  })
  assert(cwdResult.exitCode === 0, `cwd command exits 0 (got ${cwdResult.exitCode})`)
  assert(
    cwdResult.stdout.trim() === join(workspaceRoot, "nested", "dir"),
    `cwd is inside workspace (got ${cwdResult.stdout.trim()})`,
  )

  console.log("\n─── 3. Command allowlist ─────────────────────────────────────\n")
  const blockedErr = await assertThrows(
    () => runtime.execCommand({ workspaceId: WORKSPACE, command: "curl https://example.invalid" }),
    "blocked command throws",
  )
  assert(
    blockedErr?.message.includes("not allowed") === true,
    `blocked error mentions not allowed (got: ${blockedErr?.message ?? ""})`,
  )

  console.log("\n─── 4. Sandbox traversal ─────────────────────────────────────\n")
  const traversalErr = await assertThrows(
    () => runtime.execCommand({ workspaceId: "../outside", command: "node --version" }),
    "workspaceId traversal throws",
  )
  assert(
    traversalErr?.message.includes("safe relative") === true,
    `workspaceId error is descriptive (got: ${traversalErr?.message ?? ""})`,
  )

  const cwdErr = await assertThrows(
    () => runtime.execCommand({ workspaceId: WORKSPACE, cwd: "../outside", command: "node --version" }),
    "cwd traversal throws",
  )
  assert(
    cwdErr?.message.includes("escapes") === true,
    `cwd error mentions escapes (got: ${cwdErr?.message ?? ""})`,
  )

  console.log("\n─── 5. Timeout ───────────────────────────────────────────────\n")
  const timeoutResult = await runtime.execCommand({
    workspaceId: WORKSPACE,
    command: "node -e setTimeout(()=>{},5000)",
    timeoutMs: 100,
  })
  assert(timeoutResult.timedOut, "long-running command is marked timedOut")
  assert(timeoutResult.durationMs < 2_000, `timeout returns quickly (${timeoutResult.durationMs}ms)`)

  console.log("\n─── 6. Audit log ─────────────────────────────────────────────\n")
  assert(existsSync(auditLog), "audit log file created")
  const entries = readFileSync(auditLog, "utf8")
    .split("\n")
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as { op: string; command: string; workspaceId: string })
  assert(entries.length >= 3, `audit log has ≥ 3 entries (got ${entries.length})`)
  assert(entries.some(entry => entry.command === "node --version"), "audit log records command")
  assert(entries.every(entry => entry.workspaceId === WORKSPACE), "audit log records workspaceId")

  runtime.shutdown()

  console.log("\n══════════════════════════════════════════════════════")
  console.log(`  Smoke complete: ${passed} passed, ${failed} failed`)
  console.log("══════════════════════════════════════════════════════\n")

  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})