// =============================================================================
// scripts/smoke-verification.ts — Day 11.6: Approval Verification Gate
//
// Tests the VerificationService pipeline in isolation (no LLM calls):
//   1. Normal (safe) patch → verification passed
//   2. Illegal patch (path traversal / lock file) → patch.safe-paths failed
//   3. Empty patch proposal → patch.not-empty failed
//   4. Typecheck integration — verifies typecheck check runs and passes on
//      the current codebase
//   5. Kernel approveTask event sequence — task.verification.started /
//      task.verification.passed emitted in order
//   6. Kernel approveTask rejects on illegal patch — task.verification.failed
//      emitted, task status becomes Failed
//
// Run: pnpm smoke:verification
// No API key required.
// =============================================================================

import { writeFileSync, unlinkSync, existsSync, rmSync } from "node:fs"
import { join } from "node:path"
import { createRuntimeEventBus }  from "../packages/runtime/src/event-bus.js"
import { VerificationService }    from "../packages/runtime/src/verification-service.js"
import type { VerificationResult } from "../packages/runtime/src/verification-service.js"
import type { RuntimeEvent }      from "../packages/runtime/src/types.js"
import { Kernel, loadKernelConfig } from "../packages/core/src/index.js"
import { TaskStatus }               from "../packages/memory/src/types.js"
import { AgentType }                from "../packages/agent/src/types.js"

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

async function assertThrows(fn: () => unknown, label: string): Promise<void> {
  try {
    await fn()
    fail(`${label} — expected an error but none was thrown`)
  } catch {
    pass(label)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  Day 11.6 — Approval Verification Gate Smoke")
  console.log("══════════════════════════════════════════════════════\n")

  const ROOT = process.env["HERMES_ROOT"] ?? process.cwd()
  const svc  = new VerificationService(ROOT)

  // ── Section 1: Patch validation ────────────────────────────────────────────
  console.log("─── 1. Patch safety checks ───────────────────────────────────\n")

  // 1a. Normal patch — safe paths
  const normalResult: VerificationResult = await svc.verifyWorkspacePatch({
    patches: [
      { path: "src/foo.ts" },
      { path: "packages/agent/src/bar.ts" },
    ],
  })

  const patchCheck = normalResult.checks.find(c => c.name === "patch.safe-paths")
  assert(patchCheck !== undefined,   "normal patch: patch.safe-paths check present")
  assert(patchCheck?.passed === true, "normal patch: patch.safe-paths passed")

  // 1b. Illegal patch — path traversal
  const traversalResult = await svc.verifyWorkspacePatch({
    patches: [{ path: "../outside.ts" }],
  })
  const traversalCheck = traversalResult.checks.find(c => c.name === "patch.safe-paths")
  assert(traversalCheck?.passed === false, "path traversal: patch.safe-paths failed")
  assert(
    traversalCheck?.details?.includes("path traversal") === true,
    `path traversal: details mention 'path traversal' (got: ${traversalCheck?.details ?? "undefined"})`,
  )

  // 1c. Illegal patch — lock file
  const lockResult = await svc.verifyWorkspacePatch({
    patches: [{ path: "pnpm-lock.yaml" }],
  })
  const lockCheck = lockResult.checks.find(c => c.name === "patch.safe-paths")
  assert(lockCheck?.passed === false, "lock file: patch.safe-paths failed")
  assert(
    lockCheck?.details?.includes("lock file") === true,
    `lock file: details mention 'lock file' (got: ${lockCheck?.details ?? "undefined"})`,
  )

  // 1d. Illegal patch — node_modules
  const nmResult = await svc.verifyWorkspacePatch({
    patches: [{ path: "node_modules/lodash/index.js" }],
  })
  const nmCheck = nmResult.checks.find(c => c.name === "patch.safe-paths")
  assert(nmCheck?.passed === false, "node_modules: patch.safe-paths failed")

  // 1e. Empty patch
  const emptyResult = await svc.verifyWorkspacePatch({ patches: [] })
  const emptyCheck = emptyResult.checks.find(c => c.name === "patch.not-empty")
  assert(emptyCheck?.passed === false, "empty patch: patch.not-empty failed")
  assert(emptyResult.passed === false,  "empty patch: overall result is failed")

  // ── Section 2: Typecheck ───────────────────────────────────────────────────
  console.log("\n─── 2. TypeScript typecheck check ────────────────────────────\n")

  const typecheckResult = await svc.verifyWorkspacePatch({
    patches: [{ path: "src/valid.ts" }],
  })
  const tcCheck = typecheckResult.checks.find(c => c.name === "typecheck")
  assert(tcCheck !== undefined,        "typecheck check is present")
  assert(tcCheck?.passed === true,     "typecheck passes on current codebase")
  console.log(`       (ran in VerificationService — pnpm typecheck passed)`)

  // ── Section 3: Typecheck failure scenario ──────────────────────────────────
  console.log("\n─── 3. Typecheck failure scenario ────────────────────────────\n")

  // Write a file with a TypeScript error into an existing package src dir.
  // Clean up immediately regardless of outcome.
  const badFile = join(ROOT, "packages", "runtime", "src", "_smoke_bad_tmp.ts")
  try {
    writeFileSync(badFile, "const x: string = 123 // deliberate type error\n", "utf8")

    const failResult = await svc.verifyWorkspacePatch({
      patches: [{ path: "packages/runtime/src/foo.ts" }],
    })
    const failTc = failResult.checks.find(c => c.name === "typecheck")
    assert(failTc?.passed === false, "typecheck fails when a bad TS file exists")
    assert(failResult.passed === false, "overall result is failed when typecheck fails")
    assert(
      failTc?.details !== undefined && failTc.details.length > 0,
      "typecheck failure includes error details",
    )
  } finally {
    if (existsSync(badFile)) unlinkSync(badFile)
  }

  // ── Section 4: Smoke test checks ──────────────────────────────────────────
  console.log("\n─── 4. Smoke test checks (smoke:runtime + smoke:events) ──────\n")

  // These run as part of verifyWorkspacePatch on the current codebase
  const smokeResult = await svc.verifyWorkspacePatch({
    patches: [{ path: "src/a.ts" }],
  })

  const runtimeSmoke = smokeResult.checks.find(c => c.name === "smoke:runtime")
  const eventsSmoke  = smokeResult.checks.find(c => c.name === "smoke:events")

  assert(runtimeSmoke !== undefined, "smoke:runtime check is present")
  assert(eventsSmoke  !== undefined, "smoke:events check is present")
  assert(runtimeSmoke?.passed === true,
    `smoke:runtime passed (details: ${runtimeSmoke?.details ?? "none"})`)
  assert(eventsSmoke?.passed === true,
    `smoke:events passed (details: ${eventsSmoke?.details ?? "none"})`)

  // ── Section 5: Kernel event sequence ──────────────────────────────────────
  console.log("\n─── 5. Kernel approveTask event sequence (safe patch) ────────\n")

  interface MockProvider {
    complete: (req: unknown) => Promise<{ content: string; inputTokens: number; outputTokens: number; model: string; durationMs: number; costUsd: number }>
    stream?: undefined
    estimateCost: (req: { messages: Array<{ content: string }> }) => { totalEstimatedUsd: number; inputTokens: number; outputTokens: number }
    modelConfig: (model: string) => { inputPricePerMToken: number; outputPricePerMToken: number; contextWindow: number; maxOutputTokens: number; supportsVision: boolean; supportsToolUse: boolean }
    providerName: string
  }

  // Patch proposal that passes all safety checks
  const safePatchJson = JSON.stringify({
    summary: "Add hello.ts",
    patches: [{ path: "src/hello.ts", modifiedContent: "export const x = 1\n" }],
  })

  const mockProvider: MockProvider = {
    providerName: "mock",
    estimateCost: (_req) => ({ totalEstimatedUsd: 0.0001, inputTokens: 10, outputTokens: 10 }),
    modelConfig:  (_m) => ({
      inputPricePerMToken: 0, outputPricePerMToken: 0,
      contextWindow: 8192, maxOutputTokens: 4096,
      supportsVision: false, supportsToolUse: true,
    }),
    complete: async (_req) => ({
      content: safePatchJson,
      inputTokens: 10, outputTokens: 20,
      model: "mock", durationMs: 1, costUsd: 0.0001,
    }),
  }

  const hermesRoot = ROOT
  const config     = loadKernelConfig(hermesRoot)
  const bus        = createRuntimeEventBus(200)
  const events: RuntimeEvent[] = []
  bus.subscribe(e => events.push(e))

  const kernel = new Kernel(config, mockProvider as never, bus)

  const WS = "smoke-verify-kernel-test"
  const wsDir = join(hermesRoot, "projects", WS)

  try {
    const { taskId } = await kernel.submit({
      instruction: "Add hello.ts",
      workspace:   WS,
      agentType:   AgentType.Coder,
    })

    // Wait for task to reach WAITING_APPROVAL (CoderAgent with mock provider)
    let status = await kernel.getStatus(taskId)
    const deadline = Date.now() + 15_000
    while (status !== TaskStatus.WaitingApproval && status !== TaskStatus.Failed && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 100))
      status = await kernel.getStatus(taskId)
    }

    if (status === TaskStatus.WaitingApproval) {
      const beforeApprove = events.length

      await kernel.approveTask(taskId)

      const afterEvents = events.slice(beforeApprove)
      const types = afterEvents.map(e => e.type)

      assert(types.includes("task.verification.started"), "approveTask: task.verification.started emitted")
      assert(types.includes("task.verification.passed"),  "approveTask: task.verification.passed emitted")
      assert(!types.includes("task.verification.failed"), "approveTask: task.verification.failed NOT emitted on safe patch")

      const finalStatus = await kernel.getStatus(taskId)
      assert(finalStatus === TaskStatus.Done, `approveTask: task status is Done after verification pass (got ${finalStatus})`)

      const detail = await kernel.getTaskDetail(taskId)
      assert(detail.verification !== undefined,    "getTaskDetail: verification field present")
      assert(detail.verification?.passed === true, "getTaskDetail: verification.passed = true")
      assert(
        (detail.verification?.checks.length ?? 0) > 0,
        `getTaskDetail: verification.checks populated (got ${detail.verification?.checks.length ?? 0})`,
      )

      // Verify event order: verification.started before verification.passed
      const startIdx  = types.indexOf("task.verification.started")
      const passedIdx = types.indexOf("task.verification.passed")
      assert(startIdx < passedIdx, "event order: task.verification.started before task.verification.passed")
    } else {
      fail(`kernel task did not reach WAITING_APPROVAL (got ${status}) — skipping approval flow checks`)
    }
  } finally {
    await kernel.shutdown()
    if (existsSync(wsDir)) rmSync(wsDir, { recursive: true, force: true })
  }

  // ── Section 6: Kernel rejects when typecheck fails at approveTask ──────────
  console.log("\n─── 6. Kernel approveTask rejects when typecheck fails ────────\n")

  // Same mock provider as Section 5 — produces a valid safe patch proposal.
  // We inject a type error AFTER the task reaches WAITING_APPROVAL so the
  // verification pipeline fails at the typecheck step, not the patch-path step.
  const bus2    = createRuntimeEventBus(200)
  const events2: RuntimeEvent[] = []
  bus2.subscribe(e => events2.push(e))
  const kernel2 = new Kernel(config, mockProvider as never, bus2)
  const WS2     = "smoke-verify-typecheck-fail-test"
  const wsDir2  = join(hermesRoot, "projects", WS2)
  const badFile2 = join(hermesRoot, "packages", "runtime", "src", "_smoke_bad2_tmp.ts")

  try {
    const { taskId: tid2 } = await kernel2.submit({
      instruction: "Add valid file",
      workspace:   WS2,
      agentType:   AgentType.Coder,
    })

    let status2 = await kernel2.getStatus(tid2)
    const deadline2 = Date.now() + 15_000
    while (status2 !== TaskStatus.WaitingApproval && status2 !== TaskStatus.Failed && Date.now() < deadline2) {
      await new Promise(r => setTimeout(r, 100))
      status2 = await kernel2.getStatus(tid2)
    }

    if (status2 === TaskStatus.WaitingApproval) {
      // Inject a bad TS file so typecheck fails during verification
      writeFileSync(badFile2, "const x: string = 999 // deliberate type error for Section 6\n", "utf8")

      const beforeApprove2 = events2.length
      await kernel2.approveTask(tid2)

      const afterEvents2 = events2.slice(beforeApprove2)
      const types2 = afterEvents2.map(e => e.type)

      assert(types2.includes("task.verification.started"), "typecheck fail: task.verification.started emitted")
      assert(types2.includes("task.verification.failed"),  "typecheck fail: task.verification.failed emitted")
      assert(!types2.includes("workspace.patch.applied"),  "typecheck fail: workspace.patch.applied NOT emitted")

      const finalStatus2 = await kernel2.getStatus(tid2)
      assert(finalStatus2 === TaskStatus.Failed,
        `typecheck fail: task status is Failed (got ${finalStatus2})`)

      const detail2 = await kernel2.getTaskDetail(tid2)
      assert(detail2.verification?.passed === false,
        "getTaskDetail: verification.passed = false when typecheck fails")
    } else {
      fail(`kernel2 task did not reach WAITING_APPROVAL (got ${status2}) — skipping typecheck-fail checks`)
    }
  } finally {
    if (existsSync(badFile2)) unlinkSync(badFile2)
    await kernel2.shutdown()
    if (existsSync(wsDir2)) rmSync(wsDir2, { recursive: true, force: true })
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
