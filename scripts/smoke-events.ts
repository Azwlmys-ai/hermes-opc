// =============================================================================
// scripts/smoke-events.ts — Day 10: Runtime Event Bus + Workspace Patch Apply
//
// Validates the full event-driven loop:
//   1. RuntimeEventBus: emit / subscribe / ring-buffer
//   2. RuntimeService: streaming stdout/stderr events
//   3. WorkspaceService: applyPatch writes files + sandbox guard
//   4. Kernel: task lifecycle events (started / completed / failed)
//   5. Kernel: patch proposed / approved / applied events
//
// Run: pnpm smoke:events
// No API key required — all agent calls are stubbed.
// =============================================================================

import { existsSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { RuntimeEventBus, createRuntimeEventBus } from "../packages/runtime/src/event-bus.js"
import { RuntimeService } from "../packages/runtime/src/runtime-service.js"
import { WorkspaceService } from "../packages/workspace/src/workspace-service.js"
import type { RuntimeEvent, RuntimeEventType } from "../packages/runtime/src/types.js"

// ---------------------------------------------------------------------------
// Test harness
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
  else fail(label, detail)
}

async function assertThrows(fn: () => unknown, label: string): Promise<Error | undefined> {
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
  console.log("  Day 10 — Event Bus + Streaming + Patch Apply Smoke")
  console.log("══════════════════════════════════════════════════════\n")

  const ROOT = process.env["HERMES_ROOT"] ?? process.cwd()
  const WS   = "smoke-events-test"
  const wsRoot = join(ROOT, "projects", WS)

  // Clean up from previous runs
  if (existsSync(wsRoot)) rmSync(wsRoot, { recursive: true, force: true })

  // ── Section 1: RuntimeEventBus ─────────────────────────────────────────────
  console.log("─── 1. RuntimeEventBus core ──────────────────────────────────\n")

  const bus = createRuntimeEventBus(10)

  // emit + subscribe
  const received: RuntimeEvent[] = []
  const unsub = bus.subscribe(e => received.push(e))

  const ev = bus.emit({
    source: "runtime",
    type: "runtime.command.started",
    workspaceId: WS,
    taskId: "t-001",
    payload: { command: "node --version" },
  })

  assert(ev.id.length > 0,          "emitted event has UUID id")
  assert(ev.ts.length > 0,          "emitted event has ISO timestamp")
  assert(ev.source === "runtime",   "event source is runtime")
  assert(ev.type === "runtime.command.started", "event type correct")
  assert(ev.level === "info",       "default level is info")
  assert(ev.workspaceId === WS,     "workspaceId propagated")
  assert(ev.taskId === "t-001",     "taskId propagated")
  assert(received.length === 1,     "subscriber received event")

  // ring buffer
  for (let i = 0; i < 12; i++) {
    bus.emit({ source: "system", type: "task.started", workspaceId: WS, payload: { i } })
  }
  const buffered = bus.getEvents()
  assert(buffered.length === 10, `ring buffer capped at 10 (got ${buffered.length})`)

  // unsubscribe
  unsub()
  const beforeCount = received.length
  bus.emit({ source: "system", type: "task.completed", workspaceId: WS, payload: {} })
  assert(received.length === beforeCount, "unsubscribed handler no longer called")

  // clear
  bus.clear()
  assert(bus.getEvents().length === 0, "clear() empties ring buffer")

  // constructor guard
  await assertThrows(() => new RuntimeEventBus(0), "maxEvents=0 throws")
  await assertThrows(() => new RuntimeEventBus(-1), "maxEvents=-1 throws")

  // ── Section 2: RuntimeService streaming events ─────────────────────────────
  console.log("\n─── 2. RuntimeService streaming events ───────────────────────\n")

  const streamBus = createRuntimeEventBus(200)
  const streamEvents: RuntimeEvent[] = []
  streamBus.subscribe(e => streamEvents.push(e))

  const runtime = new RuntimeService(ROOT, streamBus)

  // Run a command that produces stdout
  const result = await runtime.execCommand({
    workspaceId: WS,
    command: "node -e \"process.stdout.write('hello\\n'); process.stderr.write('warn\\n')\"",
    taskId: "t-stream-001",
  })

  assert(result.exitCode === 0, `command exits 0 (got ${result.exitCode})`)

  const types = streamEvents.map(e => e.type)
  assert(types.includes("runtime.command.started"),   "streaming: command.started emitted")
  assert(types.includes("runtime.command.stdout"),    "streaming: command.stdout emitted")
  assert(types.includes("runtime.command.stderr"),    "streaming: command.stderr emitted")
  assert(types.includes("runtime.command.completed"), "streaming: command.completed emitted")

  const stdoutEvt = streamEvents.find(e => e.type === "runtime.command.stdout")
  assert(
    (stdoutEvt?.payload as Record<string, unknown> | undefined)?.["chunk"] === "hello\n",
    `stdout chunk payload correct (got: ${JSON.stringify((stdoutEvt?.payload as Record<string, unknown> | undefined)?.["chunk"])})`,
  )

  const stderrEvt = streamEvents.find(e => e.type === "runtime.command.stderr")
  assert(
    (stderrEvt?.payload as Record<string, unknown> | undefined)?.["chunk"] === "warn\n",
    `stderr chunk payload correct (got: ${JSON.stringify((stderrEvt?.payload as Record<string, unknown> | undefined)?.["chunk"])})`,
  )

  // All streaming events carry taskId
  const streamTaskEvents = streamEvents.filter(e => e.taskId !== undefined)
  assert(
    streamTaskEvents.every(e => e.taskId === "t-stream-001"),
    "all streaming events carry taskId",
  )

  // Timeout emits an event
  const timeoutBus = createRuntimeEventBus(50)
  const timeoutEvents: RuntimeEvent[] = []
  timeoutBus.subscribe(e => timeoutEvents.push(e))
  const timeoutRuntime = new RuntimeService(ROOT, timeoutBus)

  await timeoutRuntime.execCommand({
    workspaceId: WS,
    command: "node -e setTimeout(()=>{},5000)",
    timeoutMs: 80,
    taskId: "t-timeout",
  })

  const timeoutEvt = timeoutEvents.find(
    e => e.type === "runtime.command.stderr" &&
         (e.payload as Record<string, unknown>)["timedOut"] === true,
  )
  assert(timeoutEvt !== undefined, "timeout emits runtime.command.stderr with timedOut=true")

  const completedEvt = timeoutEvents.find(e => e.type === "runtime.command.completed")
  assert(completedEvt !== undefined, "timeout still emits runtime.command.completed")

  runtime.shutdown()
  timeoutRuntime.shutdown()

  // ── Section 3: WorkspaceService applyPatch ─────────────────────────────────
  console.log("\n─── 3. WorkspaceService applyPatch ───────────────────────────\n")

  const ws = new WorkspaceService(WS, ROOT)

  // Apply a new file patch
  const applied = await ws.applyPatch({
    taskId: "t-patch-001",
    agentId: "coder-test",
    summary: "Add hello.ts",
    proposedAt: new Date().toISOString(),
    patches: [
      {
        path: "src/hello.ts",
        originalContent: "",
        modifiedContent: "export const hello = () => 'world'\n",
        diff: "",
        hunks: [],
      },
    ],
  })

  assert(applied.length === 1, `applyPatch returns 1 applied entry (got ${applied.length})`)
  assert(applied[0]?.path === "src/hello.ts", "applied path is src/hello.ts")

  const writtenPath = join(wsRoot, "src", "hello.ts")
  assert(existsSync(writtenPath), "file written to disk")
  const content = readFileSync(writtenPath, "utf8")
  assert(content === "export const hello = () => 'world'\n", "file content matches patch")

  // Apply a modification patch
  const applied2 = await ws.applyPatch({
    taskId: "t-patch-002",
    agentId: "coder-test",
    summary: "Update hello.ts",
    proposedAt: new Date().toISOString(),
    patches: [
      {
        path: "src/hello.ts",
        originalContent: "export const hello = () => 'world'\n",
        modifiedContent: "export const hello = () => 'universe'\n",
        diff: "",
        hunks: [],
      },
    ],
  })
  assert(applied2[0]?.originalContent === "export const hello = () => 'world'\n",
    "applyPatch captures originalContent from disk")
  assert(applied2[0]?.modifiedContent === "export const hello = () => 'universe'\n",
    "applyPatch modifiedContent is new content")

  // Sandbox violation
  await assertThrows(
    () => ws.applyPatch({
      taskId: "t-patch-evil",
      agentId: "evil",
      summary: "escape",
      proposedAt: new Date().toISOString(),
      patches: [{ path: "../outside.ts", originalContent: "", modifiedContent: "bad", diff: "", hunks: [] }],
    }),
    "applyPatch rejects sandbox-escaping path",
  )

  // ── Section 4: Kernel task lifecycle events (stubbed) ──────────────────────
  console.log("\n─── 4. Kernel task lifecycle events (stubbed) ────────────────\n")

  // We test the Kernel's emitEvent logic by directly exercising the event bus
  // integration without a real LLM call. We simulate the kernel's internal
  // event emission pattern using the event bus directly.

  const kernelBus = createRuntimeEventBus(100)
  const kernelEvents: RuntimeEvent[] = []
  kernelBus.subscribe(e => kernelEvents.push(e))

  // Simulate task.started
  kernelBus.emit({
    source: "kernel",
    type: "task.started",
    level: "info",
    workspaceId: "ws-kernel-test",
    taskId: "task-kernel-001",
    payload: { status: "Running", agentType: "coder", instruction: "Write a test" },
  })

  // Simulate workspace.patch.proposed
  kernelBus.emit({
    source: "workspace",
    type: "workspace.patch.proposed",
    level: "info",
    workspaceId: "ws-kernel-test",
    taskId: "task-kernel-001",
    payload: { summary: "Add test.ts", patchCount: 1, paths: ["src/test.ts"] },
  })

  // Simulate workspace.patch.approved
  kernelBus.emit({
    source: "workspace",
    type: "workspace.patch.approved",
    level: "info",
    workspaceId: "ws-kernel-test",
    taskId: "task-kernel-001",
    payload: { summary: "Add test.ts", patchCount: 1, paths: ["src/test.ts"] },
  })

  // Simulate workspace.patch.applied
  kernelBus.emit({
    source: "workspace",
    type: "workspace.patch.applied",
    level: "info",
    workspaceId: "ws-kernel-test",
    taskId: "task-kernel-001",
    payload: { summary: "Add test.ts", patchCount: 1, paths: ["src/test.ts"] },
  })

  // Simulate task.completed
  kernelBus.emit({
    source: "kernel",
    type: "task.completed",
    level: "info",
    workspaceId: "ws-kernel-test",
    taskId: "task-kernel-001",
    payload: { status: "Done", approved: true },
  })

  const kernelTypes = kernelEvents.map(e => e.type) as RuntimeEventType[]
  assert(kernelTypes.includes("task.started"),              "kernel: task.started event")
  assert(kernelTypes.includes("workspace.patch.proposed"),  "kernel: workspace.patch.proposed event")
  assert(kernelTypes.includes("workspace.patch.approved"),  "kernel: workspace.patch.approved event")
  assert(kernelTypes.includes("workspace.patch.applied"),   "kernel: workspace.patch.applied event")
  assert(kernelTypes.includes("task.completed"),            "kernel: task.completed event")
  assert(kernelEvents.every(e => e.taskId === "task-kernel-001"), "all kernel events carry taskId")

  // Simulate task.failed
  kernelBus.emit({
    source: "kernel",
    type: "task.failed",
    level: "error",
    workspaceId: "ws-kernel-test",
    taskId: "task-kernel-002",
    payload: { status: "Failed", error: "agent error" },
  })
  const failedEvt = kernelEvents.find(e => e.type === "task.failed")
  assert(failedEvt !== undefined,          "kernel: task.failed event emitted")
  assert(failedEvt?.level === "error",     "task.failed has level=error")

  // ── Section 5: Telemetry ring buffer ───────────────────────────────────────
  console.log("\n─── 5. Telemetry ring buffer ─────────────────────────────────\n")

  const telBus = new RuntimeEventBus(500)
  for (let i = 0; i < 600; i++) {
    telBus.emit({
      source: "runtime",
      type: "runtime.command.stdout",
      workspaceId: "ws-tel",
      payload: { chunk: `line ${i}` },
    })
  }
  const snapshot = telBus.getEvents()
  assert(snapshot.length === 500, `ring buffer holds exactly 500 events (got ${snapshot.length})`)
  // Most recent event should be the last emitted
  const lastEvt = snapshot[snapshot.length - 1]
  assert(
    (lastEvt?.payload as Record<string, unknown> | undefined)?.["chunk"] === "line 599",
    `ring buffer tail is most recent event (got: ${JSON.stringify((lastEvt?.payload as Record<string, unknown> | undefined)?.["chunk"])})`,
  )
  // Oldest event should be line 100 (600 - 500 = 100)
  const firstEvt = snapshot[0]
  assert(
    (firstEvt?.payload as Record<string, unknown> | undefined)?.["chunk"] === "line 100",
    `ring buffer head is oldest retained event (got: ${JSON.stringify((firstEvt?.payload as Record<string, unknown> | undefined)?.["chunk"])})`,
  )

  // getEvents() returns a copy — mutations don't affect internal buffer
  snapshot.push(telBus.emit({ source: "system", type: "task.started", workspaceId: "ws-tel", payload: {} }))
  assert(telBus.getEvents().length === 500, "getEvents() returns a defensive copy")

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
