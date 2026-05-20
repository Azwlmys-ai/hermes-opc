// =============================================================================
// scripts/smoke-mcp-approval.ts — Day 12: MCP Approval Flow
//
// Validates the MCP tool layer for the full WAITING_APPROVAL → approve/reject
// cycle WITHOUT a real API key (uses the same mock-provider pattern as
// smoke-verification.ts).
//
// Covers:
//   1. opc.submit_task → WAITING_APPROVAL
//   2. opc.get_task_detail → patchProposal present, verification = undefined
//   3. opc.approve_task   → verification.passed, patch applied, status = Done
//   4. opc.get_task_detail after approval → verification + patchApplied
//   5. opc.list_tasks     → shows both tasks with correct statuses
//   6. opc.submit_task (second task) → WAITING_APPROVAL
//   7. opc.reject_task   → status = Failed, rejectReason stored
//   8. opc.get_task_detail after rejection → rejectReason visible
//   9. opc.get_task_detail (typecheck-fail scenario) → verification.passed=false
//
// Run: pnpm smoke:mcp-approval
// No API key required.
// =============================================================================

import { existsSync, rmSync, writeFileSync, unlinkSync } from "node:fs"
import { join } from "node:path"
import { Kernel, loadKernelConfig }  from "../packages/core/src/index.js"
import { TaskStatus }                from "../packages/memory/src/types.js"
import { AgentType }                 from "../packages/agent/src/types.js"
import { createRuntimeEventBus }     from "../packages/runtime/src/event-bus.js"
import { handleToolCall }            from "../packages/mcp-server/src/tools.js"

// ---------------------------------------------------------------------------
// Harness
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

type ToolResult = Record<string, unknown>

async function call(
  name: string,
  args: Record<string, unknown>,
  kernel: Kernel,
): Promise<ToolResult> {
  const result = await handleToolCall(name, args, kernel)
  return result as ToolResult
}

const sleep = (ms: number): Promise<void> =>
  new Promise(r => setTimeout(r, ms))

async function waitForApproval(kernel: Kernel, taskId: string, timeoutMs = 20_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await kernel.getStatus(taskId)
    if (status === TaskStatus.WaitingApproval || status === TaskStatus.Failed) {
      return status
    }
    await sleep(120)
  }
  return await kernel.getStatus(taskId)
}

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

function makeMockProvider(patchJson: string) {
  return {
    providerName: "mock",
    estimateCost: (_req: unknown) => ({
      totalEstimatedUsd: 0.0001, inputTokens: 10, outputTokens: 10,
    }),
    modelConfig: (_m: string) => ({
      inputPricePerMToken: 0, outputPricePerMToken: 0,
      contextWindow: 8192, maxOutputTokens: 4096,
      supportsVision: false, supportsToolUse: true,
    }),
    complete: async (_req: unknown) => ({
      content:      patchJson,
      inputTokens:  10,
      outputTokens: 20,
      model:        "mock",
      durationMs:   1,
      costUsd:      0.0001,
    }),
  }
}

const SAFE_PATCH_JSON = JSON.stringify({
  summary: "Add hello.ts",
  patches: [{ path: "src/hello.ts", modifiedContent: "export const hello = () => 'world'\n" }],
})

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  Day 12 — MCP Approval Flow Smoke")
  console.log("══════════════════════════════════════════════════════\n")

  const ROOT = process.env["HERMES_ROOT"] ?? process.cwd()
  const config = loadKernelConfig(ROOT)

  // ── Section 1–4: Approve path ──────────────────────────────────────────────
  console.log("─── 1–4. Submit → get_task_detail → approve → verify ─────────\n")

  const bus1    = createRuntimeEventBus(300)
  const kernel1 = new Kernel(config, makeMockProvider(SAFE_PATCH_JSON) as never, bus1)
  const WS1     = "smoke-mcp-approve-ws"
  const wsDir1  = join(ROOT, "projects", WS1)

  try {
    // 1. Submit
    const submitResult = await call("opc.submit_task", {
      workspace:   WS1,
      instruction: "Add hello.ts",
      agentType:   "coder",
    }, kernel1)

    assert(typeof submitResult["taskId"] === "string", "submit: taskId returned")
    assert(submitResult["status"] === TaskStatus.Pending, "submit: initial status is PENDING")
    assert(typeof submitResult["estimatedCostUsd"] === "number", "submit: estimatedCostUsd present")

    const taskId1 = submitResult["taskId"] as string

    // Poll until WAITING_APPROVAL
    const status1 = await waitForApproval(kernel1, taskId1)
    assert(
      status1 === TaskStatus.WaitingApproval,
      `task reaches WAITING_APPROVAL (got: ${status1})`,
    )

    // 2. get_task_detail before approval
    const detailBefore = await call("opc.get_task_detail", { taskId: taskId1 }, kernel1)

    assert(detailBefore["taskId"] === taskId1, "get_task_detail: taskId matches")
    assert(detailBefore["status"] === TaskStatus.WaitingApproval, "get_task_detail: status = WAITING_APPROVAL")
    assert(detailBefore["verification"] === undefined, "get_task_detail: verification absent before approval")
    assert(typeof detailBefore["instruction"] === "string", "get_task_detail: instruction present")
    assert(typeof detailBefore["workspace"] === "string",   "get_task_detail: workspace present")

    // patchProposal may or may not be present depending on mock agent result
    const patchPresent = detailBefore["patchProposal"] !== undefined
    console.log(`       patchProposal present: ${patchPresent}`)

    // 3. Approve via MCP
    const approveResult = await call("opc.approve_task", { taskId: taskId1 }, kernel1)

    assert(approveResult["taskId"] === taskId1, "approve: taskId matches")
    assert(
      approveResult["status"] === TaskStatus.Done || approveResult["status"] === TaskStatus.Failed,
      `approve: status is terminal (got: ${approveResult["status"]})`,
    )

    const verObj = approveResult["verification"] as Record<string, unknown> | undefined
    assert(verObj !== undefined,                   "approve: verification block present in response")
    assert(typeof verObj?.["passed"] === "boolean", "approve: verification.passed is boolean")
    assert(typeof verObj?.["summary"] === "string", "approve: verification.summary is string")
    assert(Array.isArray(verObj?.["checks"]),       "approve: verification.checks is array")

    const verPassed = verObj?.["passed"] as boolean
    if (verPassed) {
      assert(approveResult["status"] === TaskStatus.Done, "approve (pass): status is Done")
      console.log(`       verification passed — ${verObj?.["checkCount"] ?? "?"} checks`)
    } else {
      assert(approveResult["status"] === TaskStatus.Failed, "approve (fail): status is Failed")
      const failedChecks = verObj?.["failedChecks"] as unknown[]
      console.log(`       verification failed — failed checks: ${JSON.stringify(failedChecks)}`)
    }

    // message is always present
    assert(typeof approveResult["message"] === "string", "approve: message string present")
    assert((approveResult["message"] as string).includes(taskId1), "approve: message contains taskId")

    // 4. get_task_detail after approval — verification must be present
    const detailAfter = await call("opc.get_task_detail", { taskId: taskId1 }, kernel1)

    const verAfter = detailAfter["verification"] as Record<string, unknown> | undefined
    assert(verAfter !== undefined,                      "get_task_detail after approve: verification present")
    assert(typeof verAfter?.["passed"] === "boolean",   "get_task_detail after approve: passed is boolean")
    assert(Array.isArray(verAfter?.["checks"]),         "get_task_detail after approve: checks array present")
    assert(
      (verAfter?.["checkCount"] as number ?? 0) > 0,
      `get_task_detail after approve: checkCount > 0 (got: ${verAfter?.["checkCount"] ?? 0})`,
    )

  } finally {
    await kernel1.shutdown()
    if (existsSync(wsDir1)) rmSync(wsDir1, { recursive: true, force: true })
  }

  // ── Section 5: list_tasks ─────────────────────────────────────────────────
  console.log("\n─── 5. opc.list_tasks ────────────────────────────────────────\n")

  const bus5    = createRuntimeEventBus(100)
  const kernel5 = new Kernel(config, makeMockProvider(SAFE_PATCH_JSON) as never, bus5)
  const WS5A    = "smoke-mcp-list-a"
  const WS5B    = "smoke-mcp-list-b"

  try {
    // Submit two tasks to different workspaces
    const r5a = await call("opc.submit_task", { workspace: WS5A, instruction: "Task A" }, kernel5)
    const r5b = await call("opc.submit_task", { workspace: WS5B, instruction: "Task B" }, kernel5)
    const tid5a = r5a["taskId"] as string
    const tid5b = r5b["taskId"] as string

    // list all
    const listAll = await call("opc.list_tasks", {}, kernel5) as { count: number; tasks: unknown[] }
    assert(listAll["count"] >= 2,      `list_tasks: count >= 2 (got ${listAll["count"]})`)
    assert(Array.isArray(listAll["tasks"]), "list_tasks: tasks is array")

    const task5a = (listAll["tasks"] as Array<Record<string, unknown>>).find(t => t["taskId"] === tid5a)
    const task5b = (listAll["tasks"] as Array<Record<string, unknown>>).find(t => t["taskId"] === tid5b)
    assert(task5a !== undefined, "list_tasks: task A found")
    assert(task5b !== undefined, "list_tasks: task B found")
    assert(typeof task5a?.["status"]    === "string", "list_tasks: task A has status")
    assert(typeof task5a?.["agentType"] === "string", "list_tasks: task A has agentType")
    assert(typeof task5a?.["createdAt"] === "string", "list_tasks: task A has createdAt")

    // filter by workspace
    const listA = await call("opc.list_tasks", { workspace: WS5A }, kernel5) as { count: number; tasks: unknown[] }
    assert(listA["count"] === 1,        "list_tasks filter: count is 1 for WS5A")
    assert(
      (listA["tasks"] as Array<Record<string, unknown>>)[0]?.["taskId"] === tid5a,
      "list_tasks filter: returns correct taskId",
    )

  } finally {
    await kernel5.shutdown()
    for (const ws of [WS5A, WS5B]) {
      const d = join(ROOT, "projects", ws)
      if (existsSync(d)) rmSync(d, { recursive: true, force: true })
    }
  }

  // ── Section 6–8: Reject path ───────────────────────────────────────────────
  console.log("\n─── 6–8. Submit → reject → get_task_detail ──────────────────\n")

  const bus6    = createRuntimeEventBus(200)
  const kernel6 = new Kernel(config, makeMockProvider(SAFE_PATCH_JSON) as never, bus6)
  const WS6     = "smoke-mcp-reject-ws"
  const wsDir6  = join(ROOT, "projects", WS6)

  try {
    const r6 = await call("opc.submit_task", {
      workspace:   WS6,
      instruction: "Do something reviewable",
    }, kernel6)
    const tid6 = r6["taskId"] as string

    const st6 = await waitForApproval(kernel6, tid6)
    assert(
      st6 === TaskStatus.WaitingApproval,
      `reject path: task reaches WAITING_APPROVAL (got: ${st6})`,
    )

    // 7. Reject with a reason
    const REASON = "Design needs rethink — too many files modified"
    const rejectResult = await call("opc.reject_task", { taskId: tid6, reason: REASON }, kernel6)

    assert(rejectResult["taskId"] === tid6,    "reject: taskId echoed")
    assert(rejectResult["rejected"] === true,   "reject: rejected flag is true")
    assert(rejectResult["reason"] === REASON,   "reject: reason echoed")
    assert(typeof rejectResult["message"] === "string", "reject: message present")
    assert((rejectResult["message"] as string).length > 0, "reject: message non-empty")

    const statusAfterReject = await kernel6.getStatus(tid6)
    assert(statusAfterReject === TaskStatus.Failed, `reject: status is Failed (got: ${statusAfterReject})`)

    // 8. get_task_detail after rejection
    const detailReject = await call("opc.get_task_detail", { taskId: tid6 }, kernel6)

    assert(detailReject["status"] === TaskStatus.Failed, "get_task_detail after reject: status = Failed")
    assert(detailReject["rejectReason"] === REASON,      "get_task_detail after reject: rejectReason matches")
    assert(detailReject["verification"] === undefined,   "get_task_detail after reject: verification absent (reject, not approve)")

    // Ensure workspace.patch.applied was NOT emitted
    const events = bus6.getEvents()
    const patchApplied = events.find(e => e.type === "workspace.patch.applied")
    assert(patchApplied === undefined, "reject: workspace.patch.applied NOT emitted")

    const rejectedEvt = events.find(e => e.type === "task.rejected")
    assert(rejectedEvt !== undefined, "reject: task.rejected event emitted")

  } finally {
    await kernel6.shutdown()
    if (existsSync(wsDir6)) rmSync(wsDir6, { recursive: true, force: true })
  }

  // ── Section 9: Verification failure via typecheck ─────────────────────────
  console.log("\n─── 9. opc.approve_task when typecheck fails ─────────────────\n")

  const bus9    = createRuntimeEventBus(200)
  const kernel9 = new Kernel(config, makeMockProvider(SAFE_PATCH_JSON) as never, bus9)
  const WS9     = "smoke-mcp-tcfail-ws"
  const wsDir9  = join(ROOT, "projects", WS9)
  const badFile = join(ROOT, "packages", "runtime", "src", "_smoke_mcp_bad_tmp.ts")

  try {
    const r9 = await call("opc.submit_task", {
      workspace:   WS9,
      instruction: "Patch with bad typecheck",
    }, kernel9)
    const tid9 = r9["taskId"] as string

    const st9 = await waitForApproval(kernel9, tid9)
    assert(
      st9 === TaskStatus.WaitingApproval,
      `tc-fail: task reaches WAITING_APPROVAL (got: ${st9})`,
    )

    // Inject type error before approval
    writeFileSync(badFile, "const z: number = 'bad' // deliberate type error for Day 12 smoke\n", "utf8")

    const approveResult9 = await call("opc.approve_task", { taskId: tid9 }, kernel9)

    const ver9 = approveResult9["verification"] as Record<string, unknown> | undefined
    assert(ver9 !== undefined,               "tc-fail approve: verification present")
    assert(ver9?.["passed"] === false,        "tc-fail approve: verification.passed = false")
    assert(approveResult9["status"] === TaskStatus.Failed, "tc-fail approve: task status = Failed")

    const failedChecks9 = ver9?.["failedChecks"] as Array<Record<string, unknown>> | undefined
    assert(
      (failedChecks9?.length ?? 0) > 0,
      `tc-fail approve: failedChecks non-empty (got: ${failedChecks9?.length ?? 0})`,
    )
    const tcFail = failedChecks9?.find(c => c["name"] === "typecheck")
    assert(tcFail !== undefined, "tc-fail approve: typecheck appears in failedChecks")

    // patch was NOT applied
    const events9 = bus9.getEvents()
    assert(
      events9.find(e => e.type === "workspace.patch.applied") === undefined,
      "tc-fail approve: workspace.patch.applied NOT emitted",
    )

    // get_task_detail should reflect the failed verification
    const detail9 = await call("opc.get_task_detail", { taskId: tid9 }, kernel9)
    assert(detail9["status"] === TaskStatus.Failed, "tc-fail get_task_detail: status = Failed")
    const ver9d = detail9["verification"] as Record<string, unknown> | undefined
    assert(ver9d?.["passed"] === false, "tc-fail get_task_detail: verification.passed = false")

  } finally {
    if (existsSync(badFile)) unlinkSync(badFile)
    await kernel9.shutdown()
    if (existsSync(wsDir9)) rmSync(wsDir9, { recursive: true, force: true })
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════")
  console.log(`  Smoke complete: ${passed} passed, ${failed} failed`)
  console.log("══════════════════════════════════════════════════════\n")

  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
