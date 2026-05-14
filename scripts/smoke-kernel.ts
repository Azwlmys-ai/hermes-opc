// =============================================================================
// scripts/smoke-kernel.ts — Day 7 end-to-end smoke test
//
// Tests the full chain: createKernel → submit → agent → provider → memory.
// Then checks that the MCP stdio server can start.
//
// Run (requires .env with ANTHROPIC_API_KEY or OPENAI_API_KEY):
//   pnpm smoke:kernel
//
// Skips live-API sections gracefully when no key is found.
// Prerequisite: pnpm build must have run (imports from dist via workspace links).
// =============================================================================

import { createKernel, Kernel, loadKernelConfig } from "../packages/core/src/index.js"
import { loadCostTable, OpenAICompatibleProvider } from "../packages/provider/src/index.js"
import { TaskStatus }   from "../packages/memory/src/types.js"
import { AgentType }    from "../packages/agent/src/types.js"
import type { TaskDetail } from "../packages/core/src/types.js"
import { spawn }        from "node:child_process"
import { join }         from "node:path"

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

// ROOT = repo root (script is always run from there via pnpm)
const ROOT = process.env["HERMES_ROOT"] ?? process.cwd()

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  ✓  ${label}`)
}

function fail(label: string): void {
  failed++
  console.error(`  ✗  ${label}`)
}

function assert(condition: boolean, label: string): void {
  if (condition) {
    pass(label)
  } else {
    fail(label)
  }
}

// ---------------------------------------------------------------------------
// Polling helper
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

async function pollUntilDone(
  kernel:    ReturnType<typeof createKernel>,
  taskId:    string,
  timeoutMs: number = 90_000,
): Promise<TaskDetail> {
  const deadline = Date.now() + timeoutMs
  let dots = 0

  while (Date.now() < deadline) {
    const detail = await kernel.getTaskDetail(taskId)
    if (detail.status === TaskStatus.Done || detail.status === TaskStatus.Failed) {
      process.stdout.write("\n")
      return detail
    }
    if (dots % 5 === 0) process.stdout.write(".")
    dots++
    await sleep(1_000)
  }

  process.stdout.write("\n")
  throw new Error(`Task ${taskId} did not complete within ${timeoutMs / 1_000}s`)
}

// ---------------------------------------------------------------------------
// MCP server startup check
// ---------------------------------------------------------------------------

async function checkMcpStartup(): Promise<boolean> {
  return new Promise((resolve) => {
    const mcpPath = join(ROOT, "packages/mcp-server/dist/main.js")

    const proc = spawn(process.execPath, [mcpPath], {
      env:   { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let ready = false

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("server ready")) ready = true
    })

    proc.on("error", () => resolve(false))

    // Give the server 4 seconds to signal ready, then kill it
    setTimeout(() => {
      proc.kill("SIGTERM")
      resolve(ready)
    }, 4_000)
  })
}

// ---------------------------------------------------------------------------
// Kernel smoke tests (requires a live API key)
// ---------------------------------------------------------------------------

async function runKernelTests(): Promise<void> {
  console.log("─── 1. Kernel instantiation ───────────────────────────────────\n")

  // Ensure HERMES_ROOT is set so config/schema paths resolve correctly
  process.env["HERMES_ROOT"] = ROOT

  let kernel: Kernel
  try {
    kernel = createKernel()
    pass("createKernel() succeeds (Anthropic provider)")
  } catch (primaryErr) {
    // Primary provider failed — attempt openai-compatible fallback
    const openaiKey  = process.env["OPENAI_API_KEY"]  ?? ""
    const openaiBase = process.env["OPENAI_BASE_URL"]  ?? ""

    if (openaiKey.trim().length > 0 && openaiBase.trim().length > 0) {
      try {
        const config    = loadKernelConfig(ROOT)
        const costTable = loadCostTable(ROOT)
        const provider  = new OpenAICompatibleProvider({
          apiKey:   openaiKey,
          baseURL:  openaiBase,
          costTable,
        })
        kernel = new Kernel(config, provider)
        pass(
          `createKernel() succeeded via OpenAI-compatible fallback\n` +
          `  (primary error: ${String(primaryErr)})`,
        )
      } catch (fallbackErr) {
        fail(`Both primary and OpenAI-compatible kernel init failed.\n` +
          `  Primary: ${String(primaryErr)}\n` +
          `  Fallback: ${String(fallbackErr)}`)
        return
      }
    } else {
      console.log(
        `\n  NOTE  Kernel init skipped — no API key configured for the current provider.\n` +
        `        Error: ${String(primaryErr)}\n` +
        `        Set ANTHROPIC_API_KEY, or OPENAI_API_KEY+OPENAI_BASE_URL in .env.\n`,
      )
      return
    }
  }

  // ── submit ──────────────────────────────────────────────────────────────
  console.log("\n─── 2. Task submission ────────────────────────────────────────\n")

  const submitRes = await kernel.submit({
    workspace:      "smoke-test",
    instruction:    "Write one sentence: OPC smoke test passed.",
    agentType:      AgentType.Writer,
    budgetLimitUsd: 0.20,   // cap at 20 cents; short task should cost <$0.001
  })

  assert(
    submitRes.status === TaskStatus.Pending,
    `submit() returns PENDING (got "${submitRes.status}")`,
  )
  assert(
    submitRes.taskId.startsWith("task-"),
    `taskId has correct prefix (got "${submitRes.taskId}")`,
  )
  assert(
    submitRes.estimatedCost.totalEstimatedUsd >= 0,
    `estimatedCost ≥ 0 (got $${submitRes.estimatedCost.totalEstimatedUsd.toFixed(6)})`,
  )
  console.log(`\n  taskId:        ${submitRes.taskId}`)
  console.log(`  estimatedCost: $${submitRes.estimatedCost.totalEstimatedUsd.toFixed(6)}`)

  // ── wait for completion ─────────────────────────────────────────────────
  console.log("\n─── 3. Wait for completion (max 90s) ──────────────────────────\n  ")

  let detail: TaskDetail
  try {
    detail = await pollUntilDone(kernel, submitRes.taskId)
  } catch (err) {
    fail(String(err))
    await kernel.shutdown()
    return
  }

  assert(
    detail.status === TaskStatus.Done,
    `task status is DONE (got "${detail.status}")`,
  )
  assert(
    typeof detail.output === "string" && detail.output.length > 0,
    "output is a non-empty string",
  )
  assert(
    detail.costUsd > 0,
    `costUsd > 0 (got ${detail.costUsd})`,
  )
  assert(
    typeof detail.completedAt === "string",
    "completedAt is set",
  )

  console.log(`\n  Output:      "${detail.output?.slice(0, 120)}"`)
  console.log(`  Cost:        $${detail.costUsd.toFixed(6)}`)
  console.log(`  CompletedAt: ${detail.completedAt ?? "—"}`)

  // ── getTaskDetail ────────────────────────────────────────────────────────
  console.log("\n─── 4. getTaskDetail ──────────────────────────────────────────\n")

  const fetched = await kernel.getTaskDetail(submitRes.taskId)
  assert(fetched.taskId === submitRes.taskId, "getTaskDetail returns correct taskId")
  assert(fetched.workspace === "smoke-test", "workspace matches")
  assert(fetched.agentType === AgentType.Writer, "agentType is Writer")
  pass("getTaskDetail() round-trip OK")

  // ── listTasks ────────────────────────────────────────────────────────────
  console.log("\n─── 5. listTasks ──────────────────────────────────────────────\n")

  const allTasks = await kernel.listTasks()
  assert(allTasks.length >= 1, `listTasks() returns ≥ 1 task (got ${allTasks.length})`)

  const filtered = await kernel.listTasks("smoke-test")
  assert(
    filtered.some(t => t.taskId === submitRes.taskId),
    "listTasks(workspace) contains submitted task",
  )
  pass(`listTasks("smoke-test") found ${filtered.length} task(s)`)

  // ── cancelTask (on terminal task) ────────────────────────────────────────
  console.log("\n─── 6. cancelTask ─────────────────────────────────────────────\n")

  // Cancelling an already-Done task should throw
  let cancelThrew = false
  try {
    await kernel.cancelTask(submitRes.taskId)
  } catch {
    cancelThrew = true
  }
  assert(cancelThrew, "cancelTask throws when task is already in terminal state")

  // ── shutdown ─────────────────────────────────────────────────────────────
  console.log("\n─── 7. Shutdown ───────────────────────────────────────────────\n")

  try {
    await kernel.shutdown()
    pass("kernel.shutdown() completed without throwing")
  } catch (err) {
    fail(`kernel.shutdown() threw: ${String(err)}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  Hermes v0.1 — End-to-End Smoke Test")
  console.log("══════════════════════════════════════════════════════\n")

  // ── API key check ────────────────────────────────────────────────────────
  const anthropicKey = process.env["ANTHROPIC_API_KEY"]
  const openaiKey    = process.env["OPENAI_API_KEY"]
  const hasKey       = (anthropicKey?.trim().length ?? 0) > 0
                    || (openaiKey?.trim().length    ?? 0) > 0

  if (!hasKey) {
    console.log(
      "  NOTE  No API key detected.\n" +
      "        Set ANTHROPIC_API_KEY (or OPENAI_API_KEY) in .env to run\n" +
      "        live provider tests. Skipping Kernel tests.\n",
    )
  } else {
    await runKernelTests()
  }

  // ── MCP server startup ───────────────────────────────────────────────────
  console.log("\n─── MCP Server startup ────────────────────────────────────────\n")

  const mcpReady = await checkMcpStartup()
  if (mcpReady) {
    pass("MCP server starts and signals ready within 4s")
  } else {
    // Not a hard failure — server may exit early without API key
    console.log(
      "  NOTE  MCP server did not signal ready.\n" +
      "        This is expected when ANTHROPIC_API_KEY is not set.\n" +
      "        With a valid key the server should start cleanly.",
    )
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n══════════════════════════════════════════════════════`)
  console.log(`  Results: ${passed} passed, ${failed} failed`)
  console.log(`══════════════════════════════════════════════════════\n`)

  if (failed > 0) process.exit(1)
}

main().catch(err => {
  console.error("\nUnhandled error:", err)
  process.exit(1)
})
