#!/usr/bin/env node
// =============================================================================
// smoke-agent-tool-loop — Day 11→17 Validation
//
// Validates: ToolUseAgent executes the full tool-use loop:
//   inspect workspace → build patch context → LLM call (mock) → patch proposal
//   → verification plan
//
// Uses a deterministic mock provider so no API key is required.
//
// Usage: npx tsx scripts/smoke-agent-tool-loop.ts
// =============================================================================

import { resolve, dirname } from "node:path"
import type { IProvider, CompletionRequest, CompletionResponse, CostEstimate, ModelConfig } from "../packages/provider/src/types.js"
import { ProviderName } from "../packages/provider/src/types.js"

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..")

import { ToolUseAgent } from "../packages/agent/src/tool-use-agent.js"
import { AgentType, Priority } from "../packages/agent/src/types.js"

// ---------------------------------------------------------------------------
// Mock provider — returns a deterministic valid PatchProposal JSON
// ---------------------------------------------------------------------------

function makeMockProvider(patchJson: string): IProvider {
  const model: ModelConfig = {
    id: "mock-model",
    provider: ProviderName.Anthropic,
    inputPer1mUsd:  0,
    outputPer1mUsd: 0,
    contextWindow:  8192,
  }

  return {
    name:   ProviderName.Anthropic,
    models: [model],

    complete: async (_req: CompletionRequest): Promise<CompletionResponse> => ({
      content:    patchJson,
      usage:      { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model:      "mock-model",
      stopReason: "end_turn",
    }),

    stream: async function*() { /* not used */ },

    estimateCost: (_req: CompletionRequest): CostEstimate => ({
      inputTokens:              10,
      estimatedOutputTokens:    20,
      inputCostUsd:             0,
      estimatedOutputCostUsd:   0,
      totalEstimatedUsd:        0,
    }),

    healthCheck: async () => true,
  }
}

const MOCK_PATCH_JSON_1 = JSON.stringify({
  summary: "Add JSDoc to BaseAgent explaining the postProcess hook",
  patches: [
    {
      path: "packages/agent/src/base-agent.ts",
      content: "// JSDoc added by smoke test mock\nexport abstract class BaseAgent {}\n",
    },
  ],
})

const MOCK_PATCH_JSON_2 = JSON.stringify({
  summary: "Refactor RuntimeService to add structured logging",
  patches: [
    {
      path: "packages/runtime/src/runtime-service.ts",
      content: "// Structured logging added by smoke test mock\nexport class RuntimeService {}\n",
    },
  ],
})

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Smoke: Agent Tool-Use Loop (Day 17 — LLM-backed) ===\n")

  // ---------------------------------------------------------------
  // Test 1: Target = BaseAgent
  // ---------------------------------------------------------------
  console.log("--- Test 1: Target BaseAgent ---\n")

  const agent1 = new ToolUseAgent({
    repoRoot,
    provider: makeMockProvider(MOCK_PATCH_JSON_1),
    model:    "mock-model",
  })

  const result = await agent1.execute({
    id: "task-smoke-agent-tool-loop-001",
    type: AgentType.Coder,
    workspace: "opc",
    instruction: "Add JSDoc to BaseAgent explaining the postProcess hook",
    contextRefs: ["packages/agent/src/base-agent.ts"],
    priority: Priority.Normal,
    budgetLimitUsd: 0.05,
    deps: [],
    createdAt: new Date().toISOString(),
  })

  console.log(`Status: ${result.status}\n`)

  // Plan
  console.log(`Plan: ${result.plan.steps.length} steps`)
  for (const step of result.plan.steps) {
    console.log(`  Step ${step.step}: ${step.description}`)
  }
  console.log(`  Target files:   [${result.plan.targetFiles.join(", ")}]`)
  console.log()

  // Inspection
  console.log(`Inspection:`)
  console.log(`  Packages:     ${result.inspection.packageCount}`)
  console.log(`  Source files: ${result.inspection.sourceFileCount}`)
  console.log(`  Package deps:  ${Object.keys(result.inspection.packageDependencies).length} entries`)
  console.log()

  // Patch Context
  if (result.patchContext) {
    console.log(`Patch Context:`)
    console.log(`  Package owner:      ${result.patchContext.packageOwner?.name ?? "none"}`)
    console.log(`  Importers:          ${result.patchContext.importers.length}`)
    console.log(`  Exported symbols:   ${result.patchContext.exportedSymbols.length}`)
    console.log()
  } else {
    console.log("Patch Context: null\n")
  }

  // Patch Proposal
  if (result.patchProposal) {
    console.log(`Patch Proposal (from LLM):`)
    console.log(`  Summary:  ${result.patchProposal.summary}`)
    console.log(`  Patches:  ${result.patchProposal.patches.length}`)
    for (const p of result.patchProposal.patches) {
      console.log(`    ${p.path}`)
    }
    console.log()
  } else {
    console.log("Patch Proposal: null (LLM call returned no valid proposal)\n")
  }

  // Usage + cost
  console.log(`Usage:  input=${result.usage.inputTokens} output=${result.usage.outputTokens}`)
  console.log(`Cost:   $${result.costUsd.toFixed(6)}\n`)

  // Verification Plan
  console.log(`Verification Plan:`)
  console.log(`  Goal:     ${result.verificationPlan.goal}`)
  console.log(`  Commands: ${result.verificationPlan.commands.length}`)
  for (const cmd of result.verificationPlan.commands) {
    console.log(`    $ ${cmd}`)
  }
  console.log()

  // Tool Calls
  console.log(`Tool Calls:`)
  for (const tc of result.toolCalls) {
    console.log(`  [${tc.toolName}] ${tc.outputSummary} (${tc.durationMs}ms, success=${tc.success})`)
  }

  // Validate LLM was called
  const llmCall = result.toolCalls.find(tc => tc.toolName === "llm:plan-and-patch")
  if (!llmCall) {
    console.error("❌ FAIL: llm:plan-and-patch tool call not found")
    process.exit(1)
  }
  if (!llmCall.success) {
    console.error(`❌ FAIL: LLM call failed — ${llmCall.outputSummary}`)
    process.exit(1)
  }
  if (!result.patchProposal) {
    console.error("❌ FAIL: patchProposal is null (LLM output not parsed)")
    process.exit(1)
  }
  console.log("\n   ✅ LLM call succeeded and patch proposal parsed")

  // ---------------------------------------------------------------
  // Test 2: Target = RuntimeService
  // ---------------------------------------------------------------
  console.log("\n--- Test 2: Target RuntimeService ---\n")

  const agent2 = new ToolUseAgent({
    repoRoot,
    provider: makeMockProvider(MOCK_PATCH_JSON_2),
    model:    "mock-model",
  })

  const result2 = await agent2.execute({
    id: "task-smoke-agent-tool-loop-002",
    type: AgentType.Coder,
    workspace: "opc",
    instruction: "Refactor RuntimeService to add structured logging",
    contextRefs: ["packages/runtime/src/runtime-service.ts"],
    priority: Priority.Normal,
    budgetLimitUsd: 0.05,
    deps: [],
    createdAt: new Date().toISOString(),
  })

  console.log(`Status: ${result2.status}`)
  console.log(`Plan: ${result2.plan.steps.length} steps, files=[${result2.plan.targetFiles.join(", ")}]`)
  console.log(`Inspection: ${result2.inspection.packageCount} packages, ${result2.inspection.sourceFileCount} source files`)
  console.log(`PatchContext: ${result2.patchContext ? "found" : "null"}`)
  console.log(`PatchProposal: ${result2.patchProposal ? `${result2.patchProposal.patches.length} patch(es)` : "null"}`)
  console.log(`Verification: ${result2.verificationPlan.commands.length} commands`)

  if (!result2.patchProposal) {
    console.error("❌ FAIL: Test 2 patchProposal is null")
    process.exit(1)
  }
  console.log("\n   ✅ Test 2 passed")

  console.log("\n=== ALL SMOKE TESTS PASSED ===")
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err)
  process.exit(1)
})
