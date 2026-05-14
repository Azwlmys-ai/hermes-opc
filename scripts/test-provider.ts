// =============================================================================
// scripts/test-provider.ts — Day 2 smoke test for @hermes/provider (Anthropic)
//
// Run: pnpm test:provider   (requires .env with ANTHROPIC_API_KEY)
// =============================================================================

import {
  AnthropicProvider,
  AnthropicProviderError,
  loadCostTable,
  type ModelConfig,
} from "../packages/provider/src/index.js"

function assert(condition: boolean, label: string): void {
  if (!condition) {
    console.error(`\n  FAIL  ${label}`)
    process.exit(1)
  }
  console.log(`  PASS  ${label}`)
}

function assertDefined<T>(value: T | undefined | null, label: string): asserts value is T {
  if (value === undefined || value === null) {
    console.error(`\n  FAIL  ${label} — value is ${String(value)}`)
    process.exit(1)
  }
  console.log(`  PASS  ${label}`)
}

async function main(): Promise<void> {
  const apiKey = process.env["ANTHROPIC_API_KEY"]

  if (!apiKey || apiKey.trim().length === 0) {
    console.error(
      "\n  ERROR  ANTHROPIC_API_KEY is not set.\n" +
      "  Create a .env file in the project root with:\n\n" +
      "    ANTHROPIC_API_KEY=sk-ant-...\n",
    )
    process.exit(1)
  }

  const costTable    = loadCostTable()
  const cheapestModel = [...costTable.values()].reduce<ModelConfig | undefined>(
    (best, m) => (best === undefined || m.inputPer1mUsd < best.inputPer1mUsd ? m : best),
    undefined,
  )
  assertDefined(cheapestModel, "cost table contains at least one model")
  console.log(`\n  Using model: ${cheapestModel.id}`)

  const provider = new AnthropicProvider(apiKey, costTable)
  const testRequest = {
    model:    cheapestModel.id,
    messages: [{ role: "user" as const, content: "Reply with exactly: HERMES_OK" }],
    maxTokens: 16,
  }

  // TEST 1 — healthCheck
  console.log("\n─── TEST 1: healthCheck ───────────────────────────────────────")
  const healthy = await provider.healthCheck()
  assert(healthy === true, "healthCheck() returns true for valid key format")

  // TEST 2 — estimateCost
  console.log("\n─── TEST 2: estimateCost ──────────────────────────────────────")
  const estimate = provider.estimateCost(testRequest)
  assert(estimate.inputTokens > 0,       "inputTokens > 0")
  assert(estimate.inputCostUsd >= 0,      "inputCostUsd >= 0")
  assert(estimate.totalEstimatedUsd >= 0, "totalEstimatedUsd >= 0")
  console.log(`  inputTokens (est):  ${estimate.inputTokens}`)
  console.log(`  totalCost (est):    $${estimate.totalEstimatedUsd.toFixed(8)} USD`)

  // TEST 3 — complete()
  console.log("\n─── TEST 3: complete() ────────────────────────────────────────")
  const t0       = Date.now()
  const response = await provider.complete(testRequest)
  const elapsed  = Date.now() - t0

  assert(response.content.includes("HERMES_OK"), `content includes "HERMES_OK"`)
  assert(response.usage.inputTokens  > 0, "usage.inputTokens > 0")
  assert(response.usage.outputTokens > 0, "usage.outputTokens > 0")

  const actualCostUsd =
    (response.usage.inputTokens  / 1_000_000) * cheapestModel.inputPer1mUsd +
    (response.usage.outputTokens / 1_000_000) * cheapestModel.outputPer1mUsd
  const accuracyPct =
    actualCostUsd > 0
      ? (1 - Math.abs(estimate.totalEstimatedUsd - actualCostUsd) / actualCostUsd) * 100
      : 100

  console.log(`  content:  "${response.content.trim()}"`)
  console.log(`  tokens:   in=${response.usage.inputTokens} out=${response.usage.outputTokens}`)
  console.log(`  cost est: $${estimate.totalEstimatedUsd.toFixed(8)}  actual: $${actualCostUsd.toFixed(8)}`)
  console.log(`  accuracy: ${accuracyPct.toFixed(1)}%   elapsed: ${elapsed}ms`)

  // TEST 4 — stream()
  console.log("\n─── TEST 4: stream() ──────────────────────────────────────────")
  let textChunks = 0, usageChunk = false, stopChunk = false, streamedText = ""
  const t1 = Date.now()

  try {
    for await (const chunk of provider.stream(testRequest)) {
      if (chunk.type === "text")  { textChunks++; streamedText += chunk.text }
      else if (chunk.type === "usage") {
        usageChunk = true
        assert((chunk.usage?.inputTokens ?? 0) > 0, "stream usage.inputTokens > 0")
      }
      else if (chunk.type === "stop") stopChunk = true
    }
  } catch (err) {
    if (err instanceof AnthropicProviderError)
      console.error(`  ERROR  [${err.code}] ${err.message}`)
    else
      console.error("  ERROR  unexpected:", err)
    process.exit(1)
  }

  assert(textChunks >= 1, `received ≥1 text chunks (got ${textChunks})`)
  assert(usageChunk,       "received usage chunk")
  assert(stopChunk,        "received stop chunk")
  assert(streamedText.includes("HERMES_OK"), `streamed content includes "HERMES_OK"`)
  console.log(`  streamed: "${streamedText.trim()}"  chunks=${textChunks}  elapsed=${Date.now()-t1}ms`)

  console.log("\n══════════════════════════════════════════════════════════════")
  console.log("  ALL TESTS PASSED — AnthropicProvider Day 2 PASS")
  console.log(`  cost: $${actualCostUsd.toFixed(8)} USD  tokens: ${response.usage.inputTokens + response.usage.outputTokens}`)
  console.log("══════════════════════════════════════════════════════════════\n")
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
