// =============================================================================
// scripts/smoke-mcp-server.ts — Day 14: MCP Server Registry Smoke
//
// Validates the MCP server layer without starting a real server or needing
// a Claude Code connection:
//
//   1. Tool registry — 7 opc.* tools present with correct names
//   2. Schema shapes — required fields, correct JSON-schema types
//   3. Key tool schemas — opc.get_task_detail, opc.approve_task, opc.reject_task
//   4. Combined registry — opc.* + workspace.* + runtime.* total count
//   5. McpServer instantiation — no crash on construction
//   6. Protocol simulation — initialize + tools/list responses correct
//
// Run: pnpm smoke:mcp-server
// No API key required.
// =============================================================================

import { existsSync } from "node:fs"
import { join }       from "node:path"

import { toolDefinitions, handleToolCall }  from "../packages/mcp-server/src/tools.js"
import type { McpToolDefinition }           from "../packages/mcp-server/src/tools.js"
import { McpServer }                        from "../packages/mcp-server/src/server.js"
import { workspaceToolDefinitions }         from "../packages/workspace/src/workspace-tool.js"
import { runtimeToolDefinitions }           from "../packages/runtime/src/runtime-tool.js"
import { Kernel, loadKernelConfig }         from "../packages/core/src/index.js"
import { createRuntimeEventBus }            from "../packages/runtime/src/event-bus.js"

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

// ---------------------------------------------------------------------------
// Mock provider (no API key required)
// ---------------------------------------------------------------------------

const mockProvider = {
  providerName: "mock",
  estimateCost: (_req: unknown) => ({ totalEstimatedUsd: 0.0001, inputTokens: 5, outputTokens: 5 }),
  modelConfig:  (_m: string)   => ({
    inputPricePerMToken: 0, outputPricePerMToken: 0,
    contextWindow: 8192, maxOutputTokens: 4096,
    supportsVision: false, supportsToolUse: true,
  }),
  complete: async (_req: unknown) => ({
    content: JSON.stringify({ summary: "noop", patches: [{ path: "src/noop.ts", modifiedContent: "" }] }),
    inputTokens: 5, outputTokens: 5, model: "mock", durationMs: 1, costUsd: 0.0001,
  }),
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  Day 14 — MCP Server Registry Smoke")
  console.log("══════════════════════════════════════════════════════\n")

  const ROOT = process.env["HERMES_ROOT"] ?? process.cwd()

  // ── Section 1: opc.* tool registry ────────────────────────────────────────
  console.log("─── 1. opc.* tool registry ───────────────────────────────────\n")

  const OPC_EXPECTED = [
    "opc.submit_task",
    "opc.get_task",
    "opc.get_task_detail",
    "opc.list_tasks",
    "opc.cancel_task",
    "opc.approve_task",
    "opc.reject_task",
  ] as const

  assert(
    toolDefinitions.length === OPC_EXPECTED.length,
    `opc.* tool count is ${OPC_EXPECTED.length} (got ${toolDefinitions.length})`,
  )

  for (const name of OPC_EXPECTED) {
    const found = toolDefinitions.some(t => t.name === name)
    assert(found, `opc tool registered: ${name}`)
  }

  // ── Section 2: Schema shape validation ────────────────────────────────────
  console.log("\n─── 2. Tool schema shapes ────────────────────────────────────\n")

  for (const tool of toolDefinitions) {
    const t = tool as McpToolDefinition
    assert(
      typeof t.name === "string" && t.name.startsWith("opc."),
      `${t.name}: name starts with opc.`,
    )
    assert(
      typeof t.description === "string" && t.description.length > 0,
      `${t.name}: description non-empty`,
    )
    assert(
      t.inputSchema.type === "object",
      `${t.name}: inputSchema.type = "object"`,
    )
    assert(
      typeof t.inputSchema.properties === "object",
      `${t.name}: inputSchema.properties is object`,
    )
    assert(
      Array.isArray(t.inputSchema.required),
      `${t.name}: inputSchema.required is array`,
    )
  }

  // ── Section 3: Key tool schemas ────────────────────────────────────────────
  console.log("\n─── 3. Key tool schemas ──────────────────────────────────────\n")

  const byName = Object.fromEntries(
    (toolDefinitions as McpToolDefinition[]).map(t => [t.name, t]),
  )

  // opc.get_task_detail
  const gtd = byName["opc.get_task_detail"]
  assert(gtd !== undefined, "opc.get_task_detail: tool exists")
  assert(
    gtd?.inputSchema.required.includes("taskId"),
    "opc.get_task_detail: taskId is required",
  )
  assert(
    "taskId" in (gtd?.inputSchema.properties ?? {}),
    "opc.get_task_detail: taskId in properties",
  )
  assert(
    gtd?.description.includes("verification") === true,
    "opc.get_task_detail: description mentions verification",
  )

  // opc.approve_task
  const at = byName["opc.approve_task"]
  assert(at !== undefined, "opc.approve_task: tool exists")
  assert(
    at?.inputSchema.required.includes("taskId"),
    "opc.approve_task: taskId is required",
  )
  assert(
    at?.description.toLowerCase().includes("verification") === true,
    "opc.approve_task: description mentions verification",
  )

  // opc.reject_task
  const rt = byName["opc.reject_task"]
  assert(rt !== undefined, "opc.reject_task: tool exists")
  assert(
    rt?.inputSchema.required.includes("taskId"),
    "opc.reject_task: taskId is required",
  )
  assert(
    "reason" in (rt?.inputSchema.properties ?? {}),
    "opc.reject_task: optional reason property present",
  )
  assert(
    !rt?.inputSchema.required.includes("reason"),
    "opc.reject_task: reason is optional (not in required)",
  )

  // opc.list_tasks
  const lt = byName["opc.list_tasks"]
  assert(lt !== undefined,               "opc.list_tasks: tool exists")
  assert(
    lt?.inputSchema.required.length === 0,
    "opc.list_tasks: no required fields (workspace is optional)",
  )

  // opc.submit_task
  const st = byName["opc.submit_task"]
  assert(st !== undefined, "opc.submit_task: tool exists")
  assert(
    st?.inputSchema.required.includes("workspace") &&
    st.inputSchema.required.includes("instruction"),
    "opc.submit_task: workspace + instruction required",
  )

  // ── Section 4: Combined registry size ─────────────────────────────────────
  console.log("\n─── 4. Combined tool registry (opc + workspace + runtime) ───\n")

  const allTools = [
    ...toolDefinitions,
    ...workspaceToolDefinitions,
    ...runtimeToolDefinitions,
  ]

  assert(
    allTools.length >= 7,
    `combined registry has ≥ 7 tools (got ${allTools.length})`,
  )
  assert(
    allTools.filter(t => t.name.startsWith("opc.")).length === 7,
    `combined registry has exactly 7 opc.* tools`,
  )
  assert(
    allTools.filter(t => t.name.startsWith("workspace.")).length > 0,
    "combined registry includes workspace.* tools",
  )
  assert(
    allTools.filter(t => t.name.startsWith("runtime.")).length > 0,
    "combined registry includes runtime.* tools",
  )

  console.log(`       Total tools in registry: ${allTools.length}`)

  // ── Section 5: McpServer instantiation ────────────────────────────────────
  console.log("\n─── 5. McpServer instantiation ───────────────────────────────\n")

  const config = loadKernelConfig(ROOT)
  const bus    = createRuntimeEventBus(50)
  const kernel = new Kernel(config, mockProvider as never, bus)

  let server: McpServer | undefined
  let constructionError: string | undefined
  try {
    server = new McpServer(kernel, ROOT)
  } catch (err) {
    constructionError = err instanceof Error ? err.message : String(err)
  }

  assert(constructionError === undefined,
    `McpServer constructs without error${constructionError !== undefined ? `: ${constructionError}` : ""}`,
  )
  assert(server !== undefined, "McpServer instance is defined")

  await kernel.shutdown()

  // ── Section 6: Protocol simulation (initialize + tools/list) ──────────────
  console.log("\n─── 6. Protocol simulation ───────────────────────────────────\n")

  // We call handleToolCall directly for opc.list_tasks (no tasks → empty list)
  // to verify the MCP layer is wired end-to-end without real LLM calls.
  const config2  = loadKernelConfig(ROOT)
  const bus2     = createRuntimeEventBus(50)
  const kernel2  = new Kernel(config2, mockProvider as never, bus2)

  try {
    const listResult = await handleToolCall("opc.list_tasks", {}, kernel2) as {
      count: number
      tasks: unknown[]
    }

    assert(typeof listResult["count"] === "number", "protocol: opc.list_tasks returns count")
    assert(Array.isArray(listResult["tasks"]),       "protocol: opc.list_tasks returns tasks array")
    assert(listResult["count"] === 0,                "protocol: fresh kernel has 0 tasks")

    // Unknown tool → throws (not silently ignored)
    let unknownToolError: string | undefined
    try {
      await handleToolCall("opc.nonexistent_tool", {}, kernel2)
    } catch (err) {
      unknownToolError = err instanceof Error ? err.message : String(err)
    }
    assert(unknownToolError !== undefined,          "protocol: unknown tool throws an error")
    assert(
      unknownToolError?.includes("Unknown tool") === true,
      `protocol: error message says "Unknown tool" (got: ${unknownToolError ?? "none"})`,
    )
  } finally {
    await kernel2.shutdown()
  }

  // ── Section 7: Startup artifact checks ────────────────────────────────────
  console.log("\n─── 7. Startup artifacts ─────────────────────────────────────\n")

  const mainTs = join(ROOT, "packages", "mcp-server", "src", "main.ts")
  assert(existsSync(mainTs), "packages/mcp-server/src/main.ts exists")

  const serverTs = join(ROOT, "packages", "mcp-server", "src", "server.ts")
  assert(existsSync(serverTs), "packages/mcp-server/src/server.ts exists")

  const docsFile = join(ROOT, "docs", "claude-code-mcp.md")
  assert(existsSync(docsFile), "docs/claude-code-mcp.md exists")

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
