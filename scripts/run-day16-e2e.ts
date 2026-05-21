// =============================================================================
// scripts/run-day16-e2e.ts — Day 16: Claude Code End-to-End Validation
//
// Demonstrates the complete MCP approval workflow through direct handleToolCall
// invocations (the same code path Claude Code uses when calling opc.* MCP tools).
//
// Mock providers supply controlled patches so results are deterministic and
// the full verification + constitution pipeline runs on real codebase state.
//
// Tasks tested:
//   1. Safe task   — create docs/hello-opc.md (legal patch → should pass)
//   2. Violation   — modify .env (CONST-001 → constitution.check fails)
//
// Run: pnpm e2e:day16
// No API key required — mock providers supply the patches.
// =============================================================================

import { writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { Kernel, loadKernelConfig }   from "../packages/core/src/index.js"
import { TaskStatus }                 from "../packages/memory/src/types.js"
import { AgentType }                  from "../packages/agent/src/types.js"
import { createRuntimeEventBus }      from "../packages/runtime/src/event-bus.js"
import { handleToolCall }             from "../packages/mcp-server/src/tools.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface E2EResult {
  taskId:       string
  workspace:    string
  instruction:  string
  statusPath:   string[]
  approveResult: Record<string, unknown> | null
  detailResult:  Record<string, unknown> | null
  fileCreated:   boolean
  filePath:      string | null
  error:         string | null
}

type ToolResult = Record<string, unknown>

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockProvider(patchJson: string) {
  return {
    name:   "mock",
    models: [],
    estimateCost: () => ({
      inputTokens: 10, estimatedOutputTokens: 20,
      inputCostUsd: 0, estimatedOutputCostUsd: 0, totalEstimatedUsd: 0.0001,
    }),
    complete: async () => ({
      content:    patchJson,
      usage:      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model:      "mock",
      stopReason: "end_turn" as const,
    }),
    stream:      async function*() { /* unused */ },
    healthCheck: async () => true,
  }
}

async function call(
  name: string,
  args: Record<string, unknown>,
  kernel: Kernel,
): Promise<ToolResult> {
  return await handleToolCall(name, args, kernel) as ToolResult
}

async function pollUntil(
  kernel: Kernel,
  taskId: string,
  target: TaskStatus[],
  timeoutMs = 20_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await kernel.getStatus(taskId)
    if (target.includes(status as TaskStatus)) return status
    await new Promise(r => setTimeout(r, 150))
  }
  return await kernel.getStatus(taskId)
}

// ---------------------------------------------------------------------------
// Task 1 — Safe patch: create docs/hello-opc.md
// ---------------------------------------------------------------------------

async function runSafeTask(ROOT: string): Promise<E2EResult> {
  const WS         = "day16-e2e-safe"
  const wsDir      = join(ROOT, "projects", WS)
  const targetFile = join(wsDir, "docs", "hello-opc.md")
  const statusPath: string[] = []

  const patchContent = [
    "# OPC MCP Approval Workflow — Day 16",
    "",
    "The Hermes OPC system's Claude Code MCP integration is now fully operational.",
    "",
    "## Approval Workflow",
    "",
    "```",
    "opc.submit_task",
    "  → task.created (PENDING)",
    "  → task.started (RUNNING)",
    "  → agent generates patch proposal",
    "  → task.approval.waiting (WAITING_APPROVAL)",
    "",
    "opc.approve_task",
    "  → verification pipeline:",
    "      A. patch.safe-paths   — path traversal, lock files",
    "      B. constitution.check — 10 security rules (CONST-001..CONST-010)",
    "      C. typecheck          — pnpm typecheck across all packages",
    "      D. smoke:runtime      — RuntimeService regression",
    "      E. smoke:events       — EventBus regression",
    "  → PASSED: workspace.patch.applied → task.approved (DONE)",
    "  → FAILED: task.verification.failed → task.failed (FAILED)",
    "```",
    "",
    "## MCP Tools",
    "",
    "| Tool | Purpose |",
    "|------|---------|",
    "| opc.submit_task | Dispatch task to agent |",
    "| opc.get_task_detail | Structured status + verification + rejectReason |",
    "| opc.list_tasks | Task list with workspace filter |",
    "| opc.approve_task | Run verification pipeline, apply patch |",
    "| opc.reject_task | Reject without applying, record reason |",
    "",
    `_Generated: ${new Date().toISOString()}_`,
  ].join("\n")

  const PATCH_JSON = JSON.stringify({
    summary: "Add hello-opc.md documenting MCP approval workflow",
    patches: [{ path: "docs/hello-opc.md", content: patchContent }],
  })

  const config = loadKernelConfig(ROOT)
  const bus    = createRuntimeEventBus(300)
  const kernel = new Kernel(config, makeMockProvider(PATCH_JSON) as never, bus)

  try {
    // Submit
    const submitR = await call("opc.submit_task", {
      workspace:   WS,
      instruction: "Create docs/hello-opc.md explaining the OPC MCP approval workflow.",
      agentType:   "coder",
    }, kernel)
    const taskId = submitR["taskId"] as string
    statusPath.push(`PENDING (${taskId})`)

    // Poll
    const reachedStatus = await pollUntil(
      kernel, taskId,
      [TaskStatus.WaitingApproval, TaskStatus.Failed],
    )
    statusPath.push(reachedStatus)

    if (reachedStatus !== TaskStatus.WaitingApproval) {
      return {
        taskId, workspace: WS, instruction: "Create docs/hello-opc.md",
        statusPath, approveResult: null, detailResult: null,
        fileCreated: false, filePath: null,
        error: `Task did not reach WAITING_APPROVAL (got ${reachedStatus})`,
      }
    }

    // get_task_detail before approve
    const detailBefore = await call("opc.get_task_detail", { taskId }, kernel)

    // Approve
    const approveR = await call("opc.approve_task", { taskId }, kernel)
    const finalStatus = approveR["status"] as string
    statusPath.push(finalStatus)

    // get_task_detail after approve
    const detailAfter = await call("opc.get_task_detail", { taskId }, kernel)

    const fileCreated = existsSync(targetFile)

    return {
      taskId,
      workspace: WS,
      instruction: "Create docs/hello-opc.md explaining the OPC MCP approval workflow.",
      statusPath,
      approveResult:  approveR,
      detailResult:   { before: detailBefore, after: detailAfter },
      fileCreated,
      filePath:       fileCreated ? targetFile : null,
      error:          null,
    }
  } finally {
    await kernel.shutdown()
  }
}

// ---------------------------------------------------------------------------
// Task 2 — Security violation: inject .env patchProposal, run approve_task
//
// ToolUseCoderAgent is a deterministic rule-based engine that always patches
// workspace TypeScript symbols (e.g. BaseAgent) — it will never propose a
// .env patch on its own. To test the constitution gate end-to-end through
// the MCP opc.approve_task path, we:
//   1. Submit a real task → wait for WAITING_APPROVAL (with legit patch)
//   2. Inject an .env patchProposal into the kernel's in-memory task node
//   3. Call opc.approve_task → constitution.check fires → CONST-001 → FAILED
// ---------------------------------------------------------------------------

async function runViolationTask(ROOT: string): Promise<E2EResult> {
  const WS         = "day16-e2e-violation"
  const statusPath: string[] = []

  const config = loadKernelConfig(ROOT)
  const bus    = createRuntimeEventBus(200)
  const kernel = new Kernel(config, makeMockProvider("{}") as never, bus)

  try {
    // Submit any coder task — ToolUseCoderAgent reaches WAITING_APPROVAL
    const submitR = await call("opc.submit_task", {
      workspace:   WS,
      instruction: "Modify .env, write TEST_KEY=123",
      agentType:   "coder",
    }, kernel)
    const taskId = submitR["taskId"] as string
    statusPath.push(`PENDING (${taskId})`)

    // Poll until WAITING_APPROVAL
    const reachedStatus = await pollUntil(
      kernel, taskId,
      [TaskStatus.WaitingApproval, TaskStatus.Failed],
    )
    statusPath.push(reachedStatus)

    if (reachedStatus !== TaskStatus.WaitingApproval) {
      return {
        taskId, workspace: WS, instruction: "Modify .env, write TEST_KEY=123",
        statusPath, approveResult: null, detailResult: null,
        fileCreated: false, filePath: null,
        error: `Task did not reach WAITING_APPROVAL (got ${reachedStatus})`,
      }
    }

    // ── Inject .env patchProposal into the kernel's task node ──────────────
    // ToolUseCoderAgent never generates .env patches on its own.
    // This injection simulates what would happen if a compromised agent
    // returned an .env patch — the constitution gate must catch it.
    const kernelAny = kernel as unknown as Record<string, unknown>
    const tasksMap  = kernelAny["tasks"] as Map<string, Record<string, unknown>>
    const node      = tasksMap.get(taskId)

    if (node !== undefined) {
      const result = (node["result"] ?? {}) as Record<string, unknown>
      result["patchProposal"] = {
        taskId,
        agentId:    "test-injection",
        summary:    "Add TEST_KEY to .env (injected for security test)",
        proposedAt: new Date().toISOString(),
        patches: [{
          path:            ".env",
          modifiedContent: "TEST_KEY=123\n",
          originalContent: "",
          diff:            "",
          hunks:           [],
        }],
      }
      node["result"] = result
    }

    // ── Approve via MCP — constitution.check should block it ──────────────
    const approveR = await call("opc.approve_task", { taskId }, kernel)
    statusPath.push(approveR["status"] as string)

    const detailAfter = await call("opc.get_task_detail", { taskId }, kernel)

    return {
      taskId,
      workspace: WS,
      instruction: "Modify .env, write TEST_KEY=123 [.env patch injected for security test]",
      statusPath,
      approveResult: approveR,
      detailResult:  { after: detailAfter },
      fileCreated:   false,
      filePath:      null,
      error:         null,
    }
  } finally {
    await kernel.shutdown()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const ROOT = process.env["HERMES_ROOT"] ?? process.cwd()

  console.log("╔══════════════════════════════════════════════════════╗")
  console.log("║  Day 16 — OPC Claude Code End-to-End Validation      ║")
  console.log("╚══════════════════════════════════════════════════════╝\n")
  console.log(`Root: ${ROOT}\n`)

  // ── Task 1: Safe patch ─────────────────────────────────────────────────────
  console.log("── Task 1: Safe patch (create docs/hello-opc.md) ─────────────\n")
  const safeResult = await runSafeTask(ROOT)

  console.log(`  taskId:    ${safeResult.taskId}`)
  console.log(`  workspace: ${safeResult.workspace}`)
  console.log(`  statusPath: ${safeResult.statusPath.join(" → ")}`)

  if (safeResult.error !== null) {
    console.error(`  ERROR: ${safeResult.error}`)
  } else {
    const ver = (safeResult.approveResult?.["verification"] ?? {}) as Record<string, unknown>
    console.log(`  verification.passed: ${String(ver["passed"] ?? "??")}`)
    console.log(`  verification.summary: ${String(ver["summary"] ?? "??")}`)

    const checks = (ver["checks"] ?? []) as Array<Record<string, unknown>>
    for (const c of checks) {
      const tick = c["passed"] ? "✓" : "✗"
      console.log(`    ${tick}  ${c["name"] as string}`)
    }

    const patchApplied = safeResult.approveResult?.["patchApplied"] as Record<string, unknown> | undefined
    if (patchApplied !== undefined) {
      console.log(`  patchApplied: ${JSON.stringify(patchApplied["paths"])}`)
    }

    console.log(`\n  fileCreated: ${safeResult.fileCreated}`)
    if (safeResult.filePath !== null) {
      console.log(`  filePath: ${safeResult.filePath}`)
    }
  }

  // ── Task 2: Security violation ─────────────────────────────────────────────
  console.log("\n── Task 2: Security violation (.env modification) ────────────\n")
  const violResult = await runViolationTask(ROOT)

  console.log(`  taskId:    ${violResult.taskId}`)
  console.log(`  workspace: ${violResult.workspace}`)
  console.log(`  statusPath: ${violResult.statusPath.join(" → ")}`)

  if (violResult.error !== null) {
    console.error(`  ERROR: ${violResult.error}`)
  } else {
    const ver = (violResult.approveResult?.["verification"] ?? {}) as Record<string, unknown>
    console.log(`  verification.passed: ${String(ver["passed"] ?? "??")}`)
    console.log(`  verification.summary: ${String(ver["summary"] ?? "??")}`)

    const failedChecks = (ver["failedChecks"] ?? []) as Array<Record<string, unknown>>
    for (const fc of failedChecks) {
      console.log(`  ✗  ${fc["name"] as string}: ${fc["details"] as string}`)
    }

    const detailAfter = (violResult.detailResult?.["after"] ?? {}) as Record<string, unknown>
    const verAfter = (detailAfter["verification"] ?? {}) as Record<string, unknown>
    const constCheck = (verAfter["checks"] as Array<Record<string, unknown>> | undefined)?.find(
      c => c["name"] === "constitution.check",
    )
    if (constCheck !== undefined) {
      console.log(`\n  constitution.check.passed: ${String(constCheck["passed"] ?? "??")}`)
      console.log(`  constitution.check.details: ${String(constCheck["details"] ?? "??")}`)
    }
  }

  // ── opc.list_tasks ────────────────────────────────────────────────────────
  console.log("\n── MCP tool: opc.list_tasks (tools registry) ─────────────────\n")
  const { toolDefinitions } = await import("../packages/mcp-server/src/tools.js")
  console.log(`  Registered opc.* tools (${toolDefinitions.length}):`)
  for (const t of toolDefinitions) {
    console.log(`    • ${t.name}`)
  }

  // ── Persist results JSON ───────────────────────────────────────────────────
  const resultsDir = join(ROOT, "reports")
  mkdirSync(resultsDir, { recursive: true })

  const jsonPath = join(resultsDir, "day16-results.json")
  writeFileSync(
    jsonPath,
    JSON.stringify({ safeResult, violResult, timestamp: new Date().toISOString() }, null, 2),
    "utf8",
  )
  console.log(`\n  Results written to: ${jsonPath}`)

  // ── Cleanup workspaces ────────────────────────────────────────────────────
  for (const ws of ["day16-e2e-safe", "day16-e2e-violation"]) {
    const d = join(ROOT, "projects", ws)
    if (existsSync(d)) rmSync(d, { recursive: true, force: true })
  }

  // ── Final summary ─────────────────────────────────────────────────────────
  console.log("\n╔══════════════════════════════════════════════════════╗")

  const task1ok = safeResult.error === null &&
    (safeResult.approveResult?.["verification"] as Record<string, unknown> | undefined)?.["passed"] === true

  const task2ok = violResult.error === null &&
    (violResult.approveResult?.["verification"] as Record<string, unknown> | undefined)?.["passed"] === false

  console.log(`║  Task 1 (safe patch):       ${task1ok ? "✓ PASSED" : "✗ FAILED"}                    ║`)
  console.log(`║  Task 2 (security gate):    ${task2ok ? "✓ PASSED" : "✗ FAILED"}                    ║`)
  console.log("╚══════════════════════════════════════════════════════╝\n")

  if (!task1ok || !task2ok) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
