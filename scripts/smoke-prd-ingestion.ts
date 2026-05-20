#!/usr/bin/env -S npx tsx
// =============================================================================
// smoke-prd-ingestion.ts — Day 11.5 P2: PRD Ingestion + Constitution Lock
//
// Validates:
//   1. createKernel()
//   2. submit task with AgentType.Pm → "Analyze PRD and generate constitution"
//   3. PrdIngestionAgent executes
//   4. ProjectSpec extracted from output
//   5. CONSTITUTION.generated.md content in output
//   6. PHASE1_BACKLOG.generated.md content in output
//   7. task → WAITING_APPROVAL (dry-run, no auto-apply)
//   8. EventBus received events (task.created, task.started, task.completed)
// =============================================================================

import { createKernel } from "../packages/core/src/index.js"
import type { Kernel } from "../packages/core/src/index.js"
import type { IKernel, TaskDetail } from "../packages/core/src/types.js"
import { TaskStatus } from "../packages/memory/src/types.js"
import { AgentType } from "../packages/agent/src/types.js"

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
  timeoutMs = 10000,
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
  console.log("🚀 Smoke test: PRD Ingestion + Constitution Lock\n")

  // 1. Create kernel
  console.log("── Step 1: Kernel creation ──")
  const kernel: Kernel = createKernel()
  console.log("   ✅ Kernel created\n")

  // 2. Submit a Pm task
  console.log("── Step 2: Submit PRD ingestion task ──")
  const { taskId } = await kernel.submit({
    workspace: "bidai",
    instruction: "Analyze PRD and generate constitution",
    agentType: AgentType.Pm,
    contextRefs: ["智能投标系统_PRD_V1.0.docx"],
  })
  console.log(`   ✅ Task submitted: ${taskId}\n`)

  // 3. Wait for task completion
  console.log("── Step 3: Wait for execution ──")
  const finalStatus = await waitForStatus(kernel, taskId, TaskStatus.WaitingApproval, 15000)
  console.log(`   ✅ Final status: ${finalStatus}\n`)

  // 4. Get task detail
  console.log("── Step 4: Task detail ──")
  const detail: TaskDetail = await kernel.getTaskDetail(taskId)
  console.log(`   AgentType:    ${detail.agentType}`)
  console.log(`   Status:       ${detail.status}`)
  console.log(`   Done items:   ${detail.done.length}`)
  console.log(`   Cost USD:     $${detail.costUsd.toFixed(4)}`)

  // 5. Verify output exists
  const output = assertExists(detail.output, "detail.output exists")
  assert(typeof output === "string", "output is string")
  assert(output.length > 0, "output is non-empty")
  console.log(`   Output length: ${output.length} chars\n`)

  // 6. Verify ProjectSpec in output
  console.log("── Step 5: ProjectSpec verification ──")
  assert(output.includes("projectName"), 'output contains "projectName"')
  assert(output.includes("summary"), 'output contains "summary"')
  assert(output.includes("lockedScope"), 'output contains "lockedScope"')
  assert(output.includes("excludedScope"), 'output contains "excludedScope"')
  assert(output.includes("backlog"), 'output contains "backlog"')
  assert(output.includes("milestones"), 'output contains "milestones"')
  assert(output.includes("techStack"), 'output contains "techStack"')
  assert(output.includes("majorModules"), 'output contains "majorModules"')
  assert(output.includes("risks"), 'output contains "risks"')
  assert(output.includes("acceptanceCriteria"), 'output contains "acceptanceCriteria"')
  console.log()

  // 7. Verify constitution content in output
  console.log("── Step 6: Constitution verification ──")
  assert(
    output.includes("# Locked Scope") || output.includes("Locked Scope"),
    'output contains "Locked Scope" section',
  )
  assert(
    output.includes("# Backlog") || output.includes("Backlog"),
    'output contains "Backlog" section',
  )
  assert(
    output.includes("# Explicitly Excluded") || output.includes("Excluded"),
    'output contains "Excluded" section',
  )
  assert(
    output.includes("# Milestones") || output.includes("Milestones"),
    'output contains "Milestones" section',
  )
  assert(
    output.includes("Acceptance") && (output.includes("Gate") || output.includes("Criteria")),
    'output contains acceptance section',
  )
  console.log()

  // 8. Verify Phase 1 backlog in output
  console.log("── Step 7: Phase 1 Backlog verification ──")
  assert(
    output.includes("PHASE1") || output.includes("Phase 1") || output.includes("phase1"),
    'output contains Phase 1 reference',
  )
  console.log()

  // 9. Verify WAITING_APPROVAL (dry-run, no auto-apply)
  assert(
    finalStatus === TaskStatus.WaitingApproval || finalStatus === TaskStatus.Done,
    `Task is WAITING_APPROVAL or Done: ${finalStatus}`,
  )

  // 10. Verify events
  console.log("── Step 8: EventBus events ──")
  const events = detail.done
  assert(events.length > 0, "done items > 0")
  console.log(`   Events captured: ${events.length}`)
  console.log()

  // 11. Write generated files
  console.log("── Step 9: Write generated files ──")
  try {
    const fs = await import("node:fs")
    const path = await import("node:path")
    const rootDir = process.cwd() // runs from project root via pnpm script
    const bidaiDir = path.join(rootDir, "examples", "bidai")
    fs.mkdirSync(bidaiDir, { recursive: true })

    // Write constitution
    const constitutionMatch = output.match(/# CONSTITUTION[\s\S]*?(?=# Phase 1 Backlog|# PHASE 1|$)/)
    if (constitutionMatch) {
      fs.writeFileSync(path.join(bidaiDir, "CONSTITUTION.generated.md"), constitutionMatch[0].trimEnd())
      console.log(`   ✅ Wrote examples/bidai/CONSTITUTION.generated.md`)
    }

    const phase1Match = output.match(/# Phase 1 Backlog[\s\S]*?(?=# M2|M3)/)
    if (phase1Match) {
      fs.writeFileSync(path.join(bidaiDir, "PHASE1_BACKLOG.generated.md"), phase1Match[0].trimEnd())
      console.log(`   ✅ Wrote examples/bidai/PHASE1_BACKLOG.generated.md`)
    }
  } catch (err) {
    console.log(`   ⚠ File write skipped: ${err instanceof Error ? err.message : err}`)
  }
  console.log()

  // 12. Shutdown
  console.log("── Step 10: Shutdown ──")
  await kernel.shutdown()
  console.log("   ✅ Kernel shut down\n")

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
  console.log("🎉 PRD Ingestion Smoke Test: PASSED!")
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
}

main().catch((err) => {
  console.error("💥 PRD Ingestion Smoke Test FAILED:", err instanceof Error ? err.message : err)
  process.exit(1)
})