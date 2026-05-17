// =============================================================================
// ToolUseAgent — Day 11 P1: Minimal Agent Tool-Use Loop (dry-run).
//
// Implements: plan → inspect workspace → build patch context → propose
//             patch → generate verification plan
//
// v0.1 uses deterministic rule-based planning (no real LLM call).
// This validates the tool-use LOOP, not the intelligence quality.
//
// No file writes. No real LLM calls. No EventBus. No kernel integration.
// =============================================================================

import { createWorkspaceIntelligence } from "@hermes/workspace-intelligence"
import type {
  WorkspaceIntelligence,
  PatchContext,
} from "@hermes/workspace-intelligence"
import type { PatchProposal } from "@hermes/workspace"
import type {
  AgentPlan,
  AgentPlanStep,
  AgentToolCall,
  WorkspaceInspectionResult,
  VerificationPlan,
  ToolUseAgentResult,
  Task,
} from "./types.js"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Record wall-clock start → end and return ms. */
function timeStart(): [number, number] {
  return [Date.now(), 0]
}
function timeEnd(start: [number, number]): number {
  start[1] = Date.now()
  return start[1] - start[0]
}

/** Format a duration as a human-readable string. */
function formatMs(ms: number): string {
  return `${ms}ms`
}

/** Extract a target symbol from a natural-language instruction.
 *  v0.1: simple keyword scanning. */
function extractTargetSymbol(instruction: string): string {
  const knownSymbols = [
    "BaseAgent",
    "CoderAgent",
    "WriterAgent",
    "RuntimeService",
    "IKernel",
    "IWorkspaceService",
    "IRepoIndex",
    "ISourceFileIndex",
  ]
  const lower = instruction.toLowerCase()
  for (const sym of knownSymbols) {
    if (lower.includes(sym.toLowerCase())) return sym
  }
  // Fallback: try to find any PascalCase word
  const match = instruction.match(/\b([A-Z][a-zA-Z]+)\b/)
  return match?.[1] ?? "BaseAgent"
}

/** Extract a target file from a natural-language instruction.
 *  v0.1: simple path detection. */
function extractTargetFile(
  instruction: string,
  symbol: string,
  wi: WorkspaceIntelligence,
): string | null {
  // Try to find files containing the symbol
  const entries = wi.sourceFileIndex.findFilesBySymbol(symbol)
  if (entries.length > 0) {
    const first = entries[0]
    if (first) return first.relativePath
  }
  // Fallback: detect explicit paths in instruction
  const pathMatch = instruction.match(/(?:src\/|packages\/|scripts\/)[^\s,]+\.ts/)
  return pathMatch ? pathMatch[0] : null
}

// ---------------------------------------------------------------------------
// Plan generation (deterministic, rule-based)
// ---------------------------------------------------------------------------

function generatePlan(
  task: Task,
  symbol: string,
  targetFile: string | null,
): AgentPlan {
  const steps: AgentPlanStep[] = [
    {
      step: 1,
      description: `Inspect workspace to locate symbol "${symbol}"`,
      toolName: "workspace-intelligence:findSymbol",
      expectedOutput: `SourceFileEntry(s) for ${symbol}`,
    },
    {
      step: 2,
      description: `Build patch context for ${targetFile ?? symbol}`,
      toolName: "workspace-intelligence:buildPatchContext",
      expectedOutput: `PatchContext with package owner, importers, exports`,
    },
    {
      step: 3,
      description: `Analyze patch context and draft proposed changes`,
      toolName: "reasoning",
      expectedOutput: `Structured description of what to change`,
    },
    {
      step: 4,
      description: `Generate dry-run patch proposal`,
      toolName: "patch:propose",
      expectedOutput: `PatchProposal JSON (not applied)`,
    },
    {
      step: 5,
      description: `Generate verification plan`,
      toolName: "verification:plan",
      expectedOutput: `VerificationPlan with typecheck/test commands`,
    },
  ]

  return {
    goal: task.instruction,
    steps,
    targetSymbols: [symbol],
    targetFiles: targetFile ? [targetFile] : [],
    expectedOutputs: [
      "Workspace inspection results",
      "Patch context for target",
      "Patch proposal (dry-run)",
      "Verification plan",
    ],
  }
}

// ---------------------------------------------------------------------------
// Verification plan generation
// ---------------------------------------------------------------------------

function generateVerificationPlan(
  symbol: string,
  targetFile: string | null,
  patchContext: PatchContext | null,
): VerificationPlan {
  const commands: string[] = ["pnpm typecheck"]

  const affectedPackages: string[] = []

  if (patchContext?.packageOwner) {
    const pkgName = patchContext.packageOwner.name
    affectedPackages.push(pkgName)
    commands.push(`pnpm --filter ${pkgName} typecheck`)
    if (patchContext.typecheckCommand) {
      commands.push(patchContext.typecheckCommand)
    }
  }

  // Add package-specific smoke scripts if they exist
  if (patchContext?.packageOwner) {
    for (const [script] of Object.entries(patchContext.packageOwner.scripts)) {
      if (script.startsWith("smoke:")) {
        // Broader smoke scripts may be root-level, but we suggest them
        commands.push(`pnpm ${script}`)
      }
    }
  }

  // General smoke
  if (targetFile) {
    if (targetFile.startsWith("packages/workspace-intelligence")) {
      commands.push("pnpm smoke:workspace-intelligence")
    } else if (targetFile.startsWith("packages/runtime")) {
      commands.push("pnpm smoke:runtime")
      commands.push("pnpm smoke:events")
    }
  }

  return {
    goal: `Verify changes to ${symbol} pass all checks`,
    commands,
    affectedPackages,
    expectTypecheckPass: true,
  }
}

// ---------------------------------------------------------------------------
// Patch proposal generation (dry-run, deterministic)
// ---------------------------------------------------------------------------

function generatePatchProposal(
  task: Task,
  symbol: string,
  targetFile: string | null,
): PatchProposal {
  const filePath = targetFile ?? `packages/agent/src/base-agent.ts`

  // Simple mock patch: suggest adding a JSDoc comment
  const modifiedContent =
    `// =============================================================================
// BaseAgent — abstract base class that implements the IAgent contract.
//
// Subclasses supply only:
//   · buildSystemPrompt(task)  — returns the role-specific system prompt string
//
// BaseAgent handles:
//   · Status lifecycle (Idle → Running → Done | Failed | Cancelled)
//   · Provider call + error wrapping
//   · Cost calculation from ModelConfig pricing
//   · recordTask() write-back to L2 memory
//   · Graceful cancellation via a boolean flag (v0.1 serial execution)
//
// NOTE: The postProcess hook is called after the raw LLM response arrives.
//       Override it to parse structured output (e.g. CoderAgent JSON).
//       Base implementation returns raw content unchanged.
// =============================================================================
`

  return {
    taskId: task.id,
    agentId: "tool-use-agent-001",
    summary: `Add JSDoc comment explaining postProcess hook in ${symbol}`,
    proposedAt: new Date().toISOString(),
    patches: [
      {
        path: filePath,
        originalContent: "",
        modifiedContent,
        diff: "",
        hunks: [],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Main: ToolUseAgent
// ---------------------------------------------------------------------------

export interface ToolUseAgentOptions {
  /** Absolute path to the repo root */
  repoRoot: string
}

export class ToolUseAgent {
  private wi: WorkspaceIntelligence

  constructor(options: ToolUseAgentOptions) {
    this.wi = createWorkspaceIntelligence({
      repoRoot: options.repoRoot,
    })
  }

  /**
   * Execute the full tool-use loop for a task.
   *
   * Loop: plan → inspect → patchContext → propose → verify
   *
   * All steps are deterministic (no LLM).
   * No files are written to disk.
   */
  async execute(task: Task): Promise<ToolUseAgentResult> {
    const toolCalls: AgentToolCall[] = []
    const startTime = Date.now()

    // ----------------------------------------------------------------
    // Step 0: Parse task instruction → extract target symbol & file
    // ----------------------------------------------------------------
    const symbol = extractTargetSymbol(task.instruction)
    const targetFile = extractTargetFile(task.instruction, symbol, this.wi)

    // ----------------------------------------------------------------
    // Step 1: Generate plan
    // ----------------------------------------------------------------
    const plan = generatePlan(task, symbol, targetFile)
    toolCalls.push({
      toolName: "plan:generate",
      input: { instruction: task.instruction, symbol, targetFile },
      outputSummary: `Plan: ${plan.steps.length} steps, target=${symbol}`,
      success: true,
      durationMs: Date.now() - startTime,
    })

    // ----------------------------------------------------------------
    // Step 2: Inspect workspace
    // ----------------------------------------------------------------
    const tInspect = timeStart()

    // Scan packages
    await this.wi.repoIndex.scan()
    const packages = this.wi.repoIndex.listPackages()

    // Scan source files (returns all entries)
    const scannedFiles = await this.wi.sourceFileIndex.scan()

    // Build graph
    await this.wi.repoGraph.build()

    const pkgDeps = this.wi.repoGraph.getPackageDependencies()
    const entryHints = this.wi.repoGraph.getRuntimeEntryHints()

    // Find the target symbol in source files
    const symbolFiles = this.wi.sourceFileIndex.findFilesBySymbol(symbol)
    const foundSymbols = symbolFiles.length > 0 ? [symbol] : []

    const inspectDuration = timeEnd(tInspect)

    const inspection: WorkspaceInspectionResult = {
      packageCount: packages.length,
      sourceFileCount: scannedFiles.length,
      foundSymbols,
      packageDependencies: pkgDeps,
      entryHints,
    }

    toolCalls.push({
      toolName: "workspace-intelligence:inspect",
      input: { action: "scanAll" },
      outputSummary:
        `${packages.length} packages, ${symbolFiles.length} file(s) containing ${symbol}`,
      success: true,
      durationMs: inspectDuration,
    })

    // ----------------------------------------------------------------
    // Step 3: Build patch context
    // ----------------------------------------------------------------
    const tContext = timeStart()

    const queryTarget = targetFile ?? symbol
    const patchContext = await this.wi.patchContextBuilder.build(queryTarget)

    const contextDuration = timeEnd(tContext)

    toolCalls.push({
      toolName: "workspace-intelligence:buildPatchContext",
      input: { target: queryTarget },
      outputSummary: patchContext
        ? `PatchContext: ${patchContext.importers.length} importers, owner=${patchContext.packageOwner?.name ?? "none"}`
        : "PatchContext: null (target not found)",
      success: patchContext !== null,
      durationMs: contextDuration,
    })

    // ----------------------------------------------------------------
    // Step 4: Generate patch proposal (dry-run)
    // ----------------------------------------------------------------
    const tPatch = timeStart()

    const patchProposal = generatePatchProposal(task, symbol, targetFile)

    const patchDuration = timeEnd(tPatch)

    toolCalls.push({
      toolName: "patch:propose",
      input: { symbol, targetFile, dryRun: true },
      outputSummary: `PatchProposal: ${patchProposal.patches.length} file(s), summary="${patchProposal.summary}"`,
      success: true,
      durationMs: patchDuration,
    })

    // ----------------------------------------------------------------
    // Step 5: Generate verification plan
    // ----------------------------------------------------------------
    const tVerify = timeStart()

    const verificationPlan = generateVerificationPlan(symbol, targetFile, patchContext)

    const verifyDuration = timeEnd(tVerify)

    toolCalls.push({
      toolName: "verification:plan",
      input: { symbol, targetFile, patchContextExists: patchContext !== null },
      outputSummary: `${verificationPlan.commands.length} verification commands`,
      success: true,
      durationMs: verifyDuration,
    })

    // ----------------------------------------------------------------
    // Assemble result
    // ----------------------------------------------------------------
    const totalMs = Date.now() - startTime

    return {
      taskId: task.id,
      plan,
      inspection,
      patchContext,
      patchProposal,
      verificationPlan,
      toolCalls,
      status: "PLAN_EXECUTED",
    }
  }
}