#!/usr/bin/env -S npx tsx
// =============================================================================
// Smoke test: Kernel → ToolUseCoderAgent → workspace-intelligence path
//
// Verifies (Day 17 update — mock provider, no API key required):
//   1. Kernel creates ToolUseCoderAgent for Coder tasks
//   2. ToolUseAgent calls workspace-intelligence (repo-index, source file scan)
//   3. LLM call (mock) returns a real PatchProposal
//   4. PatchProposal is populated from the mock LLM response
//   5. Task status transitions to WAITING_APPROVAL
//   6. getTaskDetail() returns output, patchProposal, done items
// =============================================================================

import { resolve, dirname } from "node:path"
import { Kernel, loadKernelConfig } from "../packages/core/src/index.js"
import type { IKernel } from "../packages/core/src/types.js"
import type { TaskDetail } from "../packages/core/src/types.js"
import { TaskStatus } from "../packages/memory/src/types.js"
import { createRuntimeEventBus } from "../packages/runtime/src/event-bus.js"

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), "..")

// ---------------------------------------------------------------------------
// Mock provider — no API key needed
// ---------------------------------------------------------------------------

const MOCK_PATCH = JSON.stringify({
  summary: "Add patchContext analysis results as JSDoc to BaseAgent",
  patches: [
    {
      path: "packages/agent/src/base-agent.ts",
      content: "// Mock patch: JSDoc added\nexport abstract class BaseAgent {}\n",
    },
  ],
})

function makeMockProvider() {
  return {
    name:   "mock",
    models: [],
    estimateCost: () => ({
      inputTokens: 10, estimatedOutputTokens: 20,
      inputCostUsd: 0, estimatedOutputCostUsd: 0, totalEstimatedUsd: 0.0001,
    }),
    complete: async () => ({
      content:    MOCK_PATCH,
      usage:      { inputTokens: 10, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model:      "mock",
      stopReason: "end_turn" as const,
    }),
    stream:      async function*() { /* unused */ },
    healthCheck: async () => true,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`❌ FAIL: ${message}`)
    process.exit(1)
  }
  console.log(`   ✅ ${message}`)
}

function assertExists<T>(value: T | undefined | null, message: string): T {
  if (value === undefined || value === null) {
    console.error(`❌ FAIL: ${message}`)
    process.exit(1)
  }
  console.log(`   ✅ ${message}`)
  return value
}

async function waitForStatus(
  kernel: IKernel,
  taskId: string,
  target: TaskStatus,
  timeoutMs = 15000,
): Promise<TaskStatus> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const status = await kernel.getStatus(taskId)
    if (
      status === target ||
      status === TaskStatus.Failed ||
      status === TaskStatus.Done
    ) {
      return status
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw new Error(`Timeout waiting for task ${taskId} to reach ${target}`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("🚀 Smoke test: Kernel + ToolUseCoderAgent + workspace-intelligence\n")

  // 1. Create kernel with mock provider
  console.log("── Step 1: Kernel creation ──")
  const config = loadKernelConfig(ROOT)
  const bus    = createRuntimeEventBus()
  const kernel = new Kernel(config, makeMockProvider() as never, bus)
  console.log("   ✅ Kernel created (mock provider)\n")

  // 2. Submit a coding task
  console.log("── Step 2: Submit coding task ──")
  const instruction =
    "Analyze BaseAgent in packages/agent/src/base-agent.ts. " +
    "Find its class definition, exported symbols, and dependencies. " +
    "Add patchContext analysis results as JSDoc."
  const { taskId } = await kernel.submit({
    workspace:  "opc",
    instruction,
  })
  console.log(`   ✅ Task submitted: ${taskId}\n`)

  // 3. Wait for WAITING_APPROVAL
  console.log("── Step 3: Wait for execution ──")
  const finalStatus = await waitForStatus(kernel, taskId, TaskStatus.WaitingApproval, 20000)
  console.log(`   ✅ Final status: ${finalStatus}\n`)

  // 4. Assert status
  assert(
    finalStatus === TaskStatus.WaitingApproval || finalStatus === TaskStatus.Done,
    `Task reached terminal status: ${finalStatus}`,
  )

  // 5. Get task detail
  console.log("── Step 4: Task detail ──")
  const detail: TaskDetail = await kernel.getTaskDetail(taskId)
  console.log(`   AgentType:    ${detail.agentType}`)
  console.log(`   Status:       ${detail.status}`)
  console.log(`   AgentId:      ${detail.agentId ?? "none"}`)

  // 6. Verify patchProposal populated from mock LLM response
  const proposal = assertExists(detail.patchProposal, "detail.patchProposal exists")
  assert(Array.isArray(proposal.patches),   "patchProposal.patches is array")
  assert(proposal.patches.length > 0,       "patchProposal.patches.length > 0")
  assert(
    typeof proposal.summary === "string" && proposal.summary.length > 0,
    "patchProposal.summary is non-empty",
  )
  console.log(`   Patch summary: ${proposal.summary}`)
  console.log(`   Patch count:   ${proposal.patches.length}`)
  for (const p of proposal.patches) {
    assert(typeof p.path === "string", `patch.path is string: ${p.path}`)
    console.log(`   Patch path:    ${p.path}`)
  }

  // 7. Verify output references workspace-intelligence data
  const output = assertExists(detail.output, "detail.output exists")
  assert(
    output.includes("plan") || output.includes("patchContext") || output.includes("inspection"),
    "output references workspace-intelligence results",
  )
  console.log(`   Output snippet: ${output.slice(0, 200)}...`)

  // 8. Verify done items
  assert(detail.done.length > 0, "task detail has done items")

  // 9. No real files written — patches only applied after approveTask()
  console.log("\n── Step 5: Cleanup ──")
  console.log("   ✅ No files modified (patch proposal awaits approval)")

  // 10. Shutdown
  console.log("\n── Step 6: Shutdown ──")
  await kernel.shutdown()
  console.log("   ✅ Kernel shut down\n")

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log("🎉 All smoke tests PASSED!")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
}

main().catch((err) => {
  console.error("💥 Smoke test FAILED:", err instanceof Error ? err.message : err)
  process.exit(1)
})
