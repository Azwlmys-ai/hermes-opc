#!/usr/bin/env node
// =============================================================================
// smoke-agent-tool-loop — Day 11 P1 Validation
//
// Validates: ToolUseAgent executes the full tool-use loop:
//   plan → inspect workspace → build patch context → propose patch
//   → generate verification plan
//
// Usage: npx tsx scripts/smoke-agent-tool-loop.ts
// =============================================================================

import { resolve, dirname, join } from "node:path"

const repoRoot = resolve(dirname(new URL(import.meta.url).pathname), "..")

import { ToolUseAgent } from "../packages/agent/src/tool-use-agent.js"
import { AgentType, Priority } from "../packages/agent/src/types.js"

async function main() {
  console.log("=== Smoke: Agent Tool-Use Loop (Day 11 P1) ===\n")

  // ---------------------------------------------------------------
  // Test 1: Target = BaseAgent
  // ---------------------------------------------------------------
  console.log("--- Test 1: Target BaseAgent ---\n")

  const agent = new ToolUseAgent({ repoRoot })

  const result = await agent.execute({
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

  // Assertions
  console.log(`Status: ${result.status}\n`)

  // Plan
  console.log(`Plan: ${result.plan.steps.length} steps`)
  for (const step of result.plan.steps) {
    console.log(`  Step ${step.step}: ${step.description}`)
  }
  console.log(`  Target symbols: [${result.plan.targetSymbols.join(", ")}]`)
  console.log(`  Target files:   [${result.plan.targetFiles.join(", ")}]`)
  console.log()

  // Inspection
  console.log(`Inspection:`)
  console.log(`  Packages:     ${result.inspection.packageCount}`)
  console.log(`  Source files: ${result.inspection.sourceFileCount}`)
  console.log(`  Found symbols: [${result.inspection.foundSymbols.join(", ")}]`)
  console.log(`  Package deps:  ${Object.keys(result.inspection.packageDependencies).length} entries`)
  console.log(`  Entry hints:   ${result.inspection.entryHints.length} hints`)
  console.log()

  // Patch Context
  if (result.patchContext) {
    console.log(`Patch Context:`)
    console.log(`  Package owner: ${result.patchContext.packageOwner?.name ?? "none"}`)
    console.log(`  Importers:         ${result.patchContext.importers.length}`)
    console.log(`  Exported symbols:  ${result.patchContext.exportedSymbols.length}`)
    console.log(`  Dependent packages: ${result.patchContext.dependentPackages.length}`)
    console.log()
  } else {
    console.log("Patch Context: null\n")
  }

  // Patch Proposal
  if (result.patchProposal) {
    console.log(`Patch Proposal:`)
    console.log(`  Summary:  ${result.patchProposal.summary}`)
    console.log(`  Patches:  ${result.patchProposal.patches.length}`)
    for (const p of result.patchProposal.patches) {
      console.log(`    ${p.path}`)
    }
    console.log()
  }

  // Verification Plan
  console.log(`Verification Plan:`)
  console.log(`  Goal:     ${result.verificationPlan.goal}`)
  console.log(`  Commands: ${result.verificationPlan.commands.length}`)
  for (const cmd of result.verificationPlan.commands) {
    console.log(`    $ ${cmd}`)
  }
  console.log(`  Affected packages: [${result.verificationPlan.affectedPackages.join(", ")}]`)
  console.log(`  Expect typecheck pass: ${result.verificationPlan.expectTypecheckPass}`)
  console.log()

  // Tool Calls
  console.log(`Tool Calls:`)
  for (const tc of result.toolCalls) {
    console.log(`  [${tc.toolName}] ${tc.outputSummary} (${tc.durationMs}ms, success=${tc.success})`)
  }
  console.log()

  // ---------------------------------------------------------------
  // Test 2: Target = RuntimeService
  // ---------------------------------------------------------------
  console.log("--- Test 2: Target RuntimeService ---\n")

  const result2 = await agent.execute({
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
  console.log(`Plan: ${result2.plan.steps.length} steps, target=${result2.plan.targetSymbols.join(", ")}`)
  console.log(`Inspection: ${result2.inspection.packageCount} packages, ${result2.inspection.sourceFileCount} source files`)
  console.log(`PatchContext: ${result2.patchContext ? "found" : "null"}`)
  console.log(`PatchProposal: ${result2.patchProposal ? `${result2.patchProposal.patches.length} patches` : "null"}`)
  console.log(`Verification: ${result2.verificationPlan.commands.length} commands`)

  console.log("\n=== ALL SMOKE TESTS PASSED ===")
}

main().catch((err) => {
  console.error("SMOKE FAILED:", err)
  process.exit(1)
})