// =============================================================================
// scripts/test-openai-compatible.ts — Day 3 smoke test
//
// Run: pnpm test:openai-compatible
// Requires .env with: OPENAI_API_KEY, OPENAI_BASE_URL, OPENAI_MODEL
// =============================================================================

import {
  OpenAICompatibleProvider,
  OpenAICompatibleProviderError,
  loadCostTable,
  type ModelConfig,
} from "../packages/provider/src/index.js"

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Main — wraps all top-level await so the file works in CJS mode
// ---------------------------------------------------------------------------

async function main(): Promise<void> {

  // Guard: require env vars
  const apiKey  = process.env["OPENAI_API_KEY"]
  const baseURL = process.env["OPENAI_BASE_URL"]
  const model   = process.env["OPENAI_MODEL"]

  if (!apiKey || apiKey.trim().length === 0) {
    console.error("\n  ERROR  OPENAI_API_KEY is not set in .env\n")
    process.exit(1)
  }
  if (!baseURL || baseURL.trim().length === 0) {
    console.error("\n  ERROR  OPENAI_BASE_URL is not set in .env\n")
    process.exit(1)
  }
  if (!model || model.trim().length === 0) {
    console.error("\n  ERROR  OPENAI_MODEL is not set in .env\n")
    process.exit(1)
  }

  // Setup
  const costTable = loadCostTable()
  const provider  = new OpenAICompatibleProvider({ apiKey, baseURL, costTable })

  const testRequest = {
    model,
    messages: [{ role: "user" as const, content: "Reply with exactly: HERMES_OK" }],
    maxTokens: 32,
  }

  console.log(`\n  Provider:  OpenAICompatibleProvider`)
  console.log(`  BaseURL:   ${baseURL}`)
  console.log(`  Model:     ${model}`)
  console.log(`  CostTable: ${costTable.size} model(s) loaded`)

  // ── TEST 1: healthCheck ───────────────────────────────────────────────────

  console.log("\n─── TEST 1: healthCheck ───────────────────────────────────────")
  const healthy = await provider.healthCheck()
  assert(healthy === true, "healthCheck() returns true")

  // ── TEST 2: estimateCost ──────────────────────────────────────────────────

  console.log("\n─── TEST 2: estimateCost ──────────────────────────────────────")
  const estimate = provider.estimateCost(testRequest)
  assert(estimate.inputTokens > 0,        "inputTokens > 0")
  assert(estimate.totalEstimatedUsd >= 0,  "totalEstimatedUsd >= 0")
  console.log(`  inputTokens (est):  ${estimate.inputTokens}`)
  console.log(`  outputTokens (est): ${estimate.estimatedOutputTokens}`)
  console.log(`  totalCost (est):    $${estimate.totalEstimatedUsd.toFixed(8)} USD`)

  // ── TEST 3: complete() ────────────────────────────────────────────────────

  console.log("\n─── TEST 3: complete() ────────────────────────────────────────")
  const t0 = Date.now()
  let response: Awaited<ReturnType<typeof provider.complete>>

  try {
    response = await provider.complete(testRequest)
  } catch (err) {
    if (err instanceof OpenAICompatibleProviderError) {
      console.error(`  ERROR  [${err.code}] ${err.message}`)
    } else {
      console.error("  ERROR  unexpected:", err)
    }
    process.exit(1)
  }

  const elapsedMs = Date.now() - t0

  assert(
    response.content.includes("HERMES_OK"),
    `content includes "HERMES_OK" (got: "${response.content.trim()}")`,
  )
  assert(response.usage.inputTokens  > 0, "usage.inputTokens > 0")
  assert(response.usage.outputTokens > 0, "usage.outputTokens > 0")
  assert(
    ["end_turn", "max_tokens", "stop_sequence"].includes(response.stopReason),
    `stopReason is known (got: "${response.stopReason}")`,
  )

  const modelCfg: ModelConfig | undefined = costTable.get(model)
  const actualCostUsd = modelCfg
    ? (response.usage.inputTokens  / 1_000_000) * modelCfg.inputPer1mUsd
      + (response.usage.outputTokens / 1_000_000) * modelCfg.outputPer1mUsd
    : 0

  const accuracyPct =
    actualCostUsd > 0
      ? (1 - Math.abs(estimate.totalEstimatedUsd - actualCostUsd) / actualCostUsd) * 100
      : null

  console.log(`\n  content:            "${response.content.trim()}"`)
  console.log(`  stopReason:         ${response.stopReason}`)
  console.log(`  inputTokens (real): ${response.usage.inputTokens}`)
  console.log(`  outputTokens(real): ${response.usage.outputTokens}`)
  console.log(`  estimated cost:     $${estimate.totalEstimatedUsd.toFixed(8)} USD`)
  console.log(`  actual cost:        $${actualCostUsd.toFixed(8)} USD`)
  if (accuracyPct !== null) {
    console.log(`  estimate accuracy:  ${accuracyPct.toFixed(1)}%`)
    if (accuracyPct < 80) {
      console.warn(`  WARN  accuracy ${accuracyPct.toFixed(1)}% < 80%`)
    }
  } else {
    console.log(`  estimate accuracy:  N/A (model not in cost table)`)
  }
  console.log(`  elapsed:            ${elapsedMs} ms`)

  // ── TEST 4: stream() ──────────────────────────────────────────────────────

  console.log("\n─── TEST 4: stream() ──────────────────────────────────────────")
  const t1 = Date.now()

  let textChunks   = 0
  let usageChunk   = false
  let stopChunk    = false
  let streamedText = ""
  let streamInputTokens  = 0
  let streamOutputTokens = 0

  try {
    for await (const chunk of provider.stream(testRequest)) {
      if (chunk.type === "text") {
        textChunks++
        streamedText += chunk.text
      } else if (chunk.type === "usage") {
        usageChunk = true
        streamInputTokens  = chunk.usage?.inputTokens  ?? 0
        streamOutputTokens = chunk.usage?.outputTokens ?? 0
      } else if (chunk.type === "stop") {
        stopChunk = true
      }
    }
  } catch (err) {
    if (err instanceof OpenAICompatibleProviderError) {
      console.error(`  ERROR  stream() [${err.code}] ${err.message}`)
    } else {
      console.error("  ERROR  stream() unexpected:", err)
    }
    process.exit(1)
  }

  const streamElapsedMs = Date.now() - t1

  assert(textChunks >= 1, `received ≥1 text chunks (got ${textChunks})`)
  assert(stopChunk,        "received stop chunk")
  assert(
    streamedText.includes("HERMES_OK"),
    `streamed content includes "HERMES_OK" (got: "${streamedText.trim()}")`,
  )

  if (!usageChunk || streamInputTokens === 0) {
    console.warn("  WARN  relay may not support stream usage (include_usage) — tokens may be 0")
  }

  console.log(`\n  streamed content:   "${streamedText.trim()}"`)
  console.log(`  text chunks:        ${textChunks}`)
  console.log(`  usage chunk:        ${String(usageChunk)} (in=${streamInputTokens} out=${streamOutputTokens})`)
  console.log(`  stop chunk:         ${String(stopChunk)}`)
  console.log(`  stream elapsed:     ${streamElapsedMs} ms`)

  // ── Summary ────────────────────────────────────────────────────────────────

  console.log("\n══════════════════════════════════════════════════════════════")
  console.log("  ALL TESTS PASSED — OpenAICompatibleProvider Day 3 PASS")
  console.log(`  Relay:        ${baseURL}`)
  console.log(`  Model:        ${model}`)
  console.log(`  Actual cost:  $${actualCostUsd.toFixed(8)} USD (complete)`)
  console.log(`  Total tokens: ${response.usage.inputTokens + response.usage.outputTokens}`)
  console.log("══════════════════════════════════════════════════════════════\n")
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
})
