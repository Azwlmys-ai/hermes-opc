#!/usr/bin/env -S npx tsx
// =============================================================================
// Smoke test: Runtime EventBus subscription against real Kernel
//
// Verifies:
//   1. Kernel creates a real RuntimeEventBus
//   2. External subscriber receives events:
//      - task.created
//      - task.started
//      - task.plan.generated
//      - task.patch.context.built
//      - workspace.patch.proposed
//      - task.approval.waiting
//   3. Every event has: id, ts, source, type, level, workspaceId, payload
//   4. taskId is present on task-scoped events (all except maybe some)
//   5. Final task status = WAITING_APPROVAL
//   6. Dry-run: no files actually modified
// =============================================================================

import { createKernel } from "../packages/core/src/index.js"
import { createRuntimeEventBus } from "../packages/runtime/src/index.js"
import type { RuntimeEvent } from "../packages/runtime/src/index.js"
import { TaskStatus } from "../packages/memory/src/index.js"

// ---------------------------------------------------------------------------
// Expected event types (in order)
// ---------------------------------------------------------------------------

const EXPECTED_EVENTS = [
  "task.created",
  "task.started",
  "task.plan.generated",
  "task.patch.context.built",
  "workspace.patch.proposed",
  "task.approval.waiting",
] as const

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

function assertEventShape(ev: RuntimeEvent, label: string): void {
  assert(typeof ev.id === "string" && ev.id.length > 0, `[${label}] event.id is non-empty string`)
  assert(typeof ev.ts === "string" && ev.ts.length > 0, `[${label}] event.ts is non-empty string`)
  assert(typeof ev.source === "string" && ev.source.length > 0, `[${label}] event.source is non-empty string`)
  assert(typeof ev.type === "string" && ev.type.length > 0, `[${label}] event.type is non-empty string`)
  assert(typeof ev.level === "string" && ev.level.length > 0, `[${label}] event.level is non-empty string`)
  assert(typeof ev.workspaceId === "string" && ev.workspaceId.length > 0, `[${label}] event.workspaceId is non-empty string`)
  assert(typeof ev.payload === "object" && ev.payload !== null, `[${label}] event.payload is object`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("🚀 Smoke test: Runtime EventBus subscription against Kernel\n")

  // ── Step 1: Create Kernel + subscribe before submit ──────────────────────
  console.log("── Step 1: Kernel creation + EventBus subscription ──")

  const kernel = createKernel()
  assert(kernel !== undefined, "Kernel created")

  const received: RuntimeEvent[] = []

  const unsubscribe = kernel.eventBus.subscribe((event) => {
    received.push(event)
    // Only log task-scoped events (not cost/agent internal noise)
    if (event.type.startsWith("task.") || event.type.startsWith("workspace.")) {
      console.log(`   📡 received: ${event.source}.${event.type} [level=${event.level}]`)
    }
  })

  assert(typeof unsubscribe === "function", "subscribe() returns unsubscribe function")

  // ── Step 2: Submit coding task ───────────────────────────────────────────
  console.log("\n── Step 2: Submit coding task ──")

  const res = await kernel.submit({
    workspace: "smoke-eventbus",
    instruction: "Read packages/agent/src/base-agent.ts and find BaseAgent symbol. Do NOT modify any files.",
    contextRefs: ["base-agent.ts"],
  })
  assert(typeof res.taskId === "string", "submit() returns taskId")
  console.log(`   Task ID: ${res.taskId}`)

  // ── Step 3: Wait for execution to finish ─────────────────────────────────
  console.log("\n── Step 3: Wait for execution ──")

  const deadline = Date.now() + 30000
  let finalStatus = TaskStatus.Pending
  while (Date.now() < deadline) {
    finalStatus = await kernel.getStatus(res.taskId)
    if (
      finalStatus === TaskStatus.Done ||
      finalStatus === TaskStatus.WaitingApproval ||
      finalStatus === TaskStatus.Failed
    ) {
      break
    }
    await new Promise(r => setTimeout(r, 200))
  }
  const statusLabel = (TaskStatus[finalStatus] ?? String(finalStatus))
  console.log(`   Final status: ${statusLabel} (${finalStatus})`)
  assert(
    finalStatus === TaskStatus.WaitingApproval || finalStatus === TaskStatus.Done,
    `Status is WAITING_APPROVAL or DONE (got ${statusLabel})`,
  )

  // ── Step 4: Verify we received ALL expected events ───────────────────────
  console.log("\n── Step 4: Verify expected events received ──")

  const receivedTypes = new Set(received.map(e => e.type))

  for (const expectedType of EXPECTED_EVENTS) {
    const found = receivedTypes.has(expectedType)
    assert(found, `Event "${expectedType}" was received`)
  }

  // ── Step 5: Verify event shape for all received events ───────────────────
  console.log("\n── Step 5: Verify event payload shapes ──")

  const taskEvents = received.filter(
    e => EXPECTED_EVENTS.includes(e.type as typeof EXPECTED_EVENTS[number]),
  )

  assert(taskEvents.length >= EXPECTED_EVENTS.length,
    `At least ${EXPECTED_EVENTS.length} task-scoped events received (got ${taskEvents.length})`)

  for (const ev of taskEvents) {
    assertEventShape(ev, ev.type)
    // task-scoped events MUST have taskId
    assert(typeof ev.taskId === "string" && ev.taskId.length > 0,
      `[${ev.type}] event.taskId is non-empty string`)
  }

  // ── Step 6: Verify event timeline order ──────────────────────────────────
  console.log("\n── Step 6: Verify event timeline order ──")

  const timeline = taskEvents.map(e => e.type)

  // Check relative order: created → started → plan.generated → patch.context.built
  //   → workspace.patch.proposed → task.approval.waiting
  const idx = (t: string) => timeline.indexOf(t)

  assert(idx("task.created") < idx("task.started"),
    "task.created happens before task.started")
  assert(idx("task.started") < idx("task.plan.generated"),
    "task.started happens before task.plan.generated")
  assert(idx("task.plan.generated") < idx("task.patch.context.built"),
    "task.plan.generated happens before task.patch.context.built")
  assert(idx("task.patch.context.built") < idx("workspace.patch.proposed"),
    "task.patch.context.built happens before workspace.patch.proposed")
  assert(idx("workspace.patch.proposed") < idx("task.approval.waiting"),
    "workspace.patch.proposed happens before task.approval.waiting")

  // ── Step 7: Verify detail ────────────────────────────────────────────────
  console.log("\n── Step 7: Verify task detail ──")

  const detail = await kernel.getTaskDetail(res.taskId)

  assert(detail.patchProposal !== undefined, "detail.patchProposal exists")
  assert(Array.isArray(detail.patchProposal!.patches), "patchProposal.patches is array")
  assert(detail.patchProposal!.patches.length > 0, "patchProposal.patches.length > 0")
  assert(typeof detail.patchProposal!.summary === "string" && detail.patchProposal!.summary.length > 0,
    "patchProposal.summary is non-empty")
  assert(detail.output !== undefined, "detail.output exists")

  // ── Step 8: Verify NO files were modified (dry-run) ────────────────────
  console.log("\n── Step 8: Verify dry-run (no files modified) ──")

  // Check that no "workspace.patch.applied" or "workspace.patch.approved" events fired
  const appliedEvents = received.filter((e) =>
    (e.type as string) === "workspace.patch.applied" || (e.type as string) === "workspace.patch.approved",
  )
  assert(appliedEvents.length === 0,
    "No workspace.patch.applied/approved events — patches were never applied")

  // ── Step 8a: Verify queryEvents API ──────────────────────────────────────
  console.log("\n── Step 8a: Verify EventBus.queryEvents API ──")

  const createdEvents = kernel.eventBus.queryEvents({ types: ["task.created"] })
  assert(createdEvents.length >= 1, "queryEvents({ types: ['task.created'] }) returns events")

  const byTaskId = kernel.eventBus.queryEvents({ taskIds: [res.taskId] })
  assert(byTaskId.length >= 1, `queryEvents({ taskIds: ['${res.taskId}'] }) returns events for this task`)

  const byWorkspace = kernel.eventBus.queryEvents({ workspaceIds: ["smoke-eventbus"] })
  assert(byWorkspace.length >= 1, "queryEvents({ workspaceIds: ['smoke-eventbus'] }) returns events")

  // ── Step 8b: Independent EventBus instance ────────────────────────────────
  console.log("\n── Step 8b: Standalone createRuntimeEventBus ──")

  const standaloneBus = createRuntimeEventBus(50)
  const standaloneEvents: RuntimeEvent[] = []
  standaloneBus.subscribe((ev) => standaloneEvents.push(ev))

  standaloneBus.emit({
    source: "system",
    type: "task.created",
    level: "info",
    workspaceId: "test-standalone",
    taskId: "task-123",
  })
  standaloneBus.emit({
    source: "system",
    type: "task.completed",
    level: "info",
    workspaceId: "test-standalone",
    taskId: "task-456",
  })
  standaloneBus.emit({
    source: "workspace",
    type: "workspace.patch.proposed",
    level: "info",
    workspaceId: "test-standalone",
  })

  assert(standaloneEvents.length === 3, "Standalone EventBus captures all emitted events")
  assert(standaloneBus.getEvents().length === 3, "getEvents() returns all events")

  // query by source
  const wsEvents = standaloneBus.queryEvents({ sources: ["workspace"] })
  assert(wsEvents.length === 1 && wsEvents[0] !== undefined && wsEvents[0].source === "workspace",
    "queryEvents by source returns correct events")

  // query by taskId
  const task123Events = standaloneBus.queryEvents({ taskIds: ["task-123"] })
  assert(task123Events.length === 1 && task123Events[0] !== undefined && task123Events[0].taskId === "task-123",
    "queryEvents by taskId returns correct events")

  // query with limit
  const limited = standaloneBus.queryEvents({ limit: 2 })
  assert(limited.length === 2, "queryEvents with limit:2 returns at most 2 events")

  // ── Step 8c: Filtered subscribe ──────────────────────────────────────────
  console.log("\n── Step 8c: Filtered subscribe ──")

  const filteredStandalone = createRuntimeEventBus(50)
  const filtered: RuntimeEvent[] = []
  filteredStandalone.subscribe(
    { types: ["workspace.patch.proposed", "workspace.patch.applied"], sources: ["workspace"] },
    (ev) => filtered.push(ev),
  )

  filteredStandalone.emit({ source: "kernel", type: "task.created", level: "info", workspaceId: "ws1" })
  filteredStandalone.emit({ source: "workspace", type: "workspace.patch.proposed", level: "info", workspaceId: "ws1" })
  filteredStandalone.emit({ source: "workspace", type: "workspace.patch.applied", level: "info", workspaceId: "ws1" })
  filteredStandalone.emit({ source: "workspace", type: "task.completed", level: "info", workspaceId: "ws1" })

  assert(filtered.length === 2, "Filtered subscribe receives only matching events")
  assert(filtered[0] !== undefined && filtered[0].type === "workspace.patch.proposed", "First filtered event is workspace.patch.proposed")
  assert(filtered[1] !== undefined && filtered[1].type === "workspace.patch.applied", "Second filtered event is workspace.patch.applied")

  console.log("   ✅ All EventBus API tests passed")

  // ── Step 9: Unsubscribe + Shutdown ───────────────────────────────────────
  console.log("\n── Step 9: Cleanup ──")

  unsubscribe()
  // Verify unsubscribe removed handler: emit a manual event, should not add to received
  const beforeUnsub = received.length
  ;(kernel.eventBus.emit as any)({
    source: "kernel",
    type: "test.after.unsubscribe",
    level: "debug",
    workspaceId: "smoke-eventbus",
  })
  assert(received.length === beforeUnsub,
    "Unsubscribe works: no new events captured after unsubscribe()")

  await kernel.shutdown()
  console.log("   ✅ Kernel shut down")

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${"─".repeat(50)}`)
  console.log("📊 Event Timeline:")
  console.log(`${"─".repeat(50)}`)
  for (let i = 0; i < timeline.length; i++) {
    console.log(`   ${i + 1}. ${timeline[i]}`)
  }
  console.log(`${"─".repeat(50)}`)
  console.log(`Total events received: ${received.length}`)
  console.log(`Task-scoped events:    ${taskEvents.length}`)
  console.log(`Expected events:       ${EXPECTED_EVENTS.length}`)
  console.log(`${"─".repeat(50)}`)
  console.log("🎉 All smoke tests PASSED!")
  console.log(`${"─".repeat(50)}\n`)
}

main().catch((err) => {
  console.error("❌ Smoke test failed:", err)
  process.exit(1)
})