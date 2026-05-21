// =============================================================================
// ToolUseAgent — Day 17: LLM-backed planning and patch generation.
//
// Flow: inspect workspace → build patch context → LLM call → patch proposal
//       → verification plan
//
// The LLM is given workspace context (packages, source files) and the task
// instruction. It returns a structured JSON patch proposal which is parsed and
// forwarded to the approval pipeline. No files are written here.
// =============================================================================

import { createWorkspaceIntelligence } from "@hermes/workspace-intelligence"
import type {
  WorkspaceIntelligence,
  PatchContext,
  SourceFileEntry,
} from "@hermes/workspace-intelligence"
import type { PatchProposal } from "@hermes/workspace"
import type { IProvider, TokenUsage, CompletionRequest } from "@hermes/provider"
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

function timeStart(): [number, number] {
  return [Date.now(), 0]
}
function timeEnd(start: [number, number]): number {
  start[1] = Date.now()
  return start[1] - start[0]
}

// ---------------------------------------------------------------------------
// JSON parsing — same shape as CoderAgent expects from the LLM
// ---------------------------------------------------------------------------

interface RawPatch    { path: string; content: string }
interface RawProposal { summary: string; patches: RawPatch[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function isString(v: unknown): v is string { return typeof v === "string" }

function isRawPatch(v: unknown): v is RawPatch {
  if (!isRecord(v)) return false
  return isString(v["path"]) && isString(v["content"])
}

function isRawProposal(v: unknown): v is RawProposal {
  if (!isRecord(v)) return false
  if (!isString(v["summary"])) return false
  if (!Array.isArray(v["patches"])) return false
  return (v["patches"] as unknown[]).every(isRawPatch)
}

// ---------------------------------------------------------------------------
// Cost calculation (same formula as BaseAgent)
// ---------------------------------------------------------------------------

function calcCostUsd(usage: TokenUsage, modelId: string, provider: IProvider): number {
  const cfg = provider.models?.find(m => m.id === modelId)
  if (cfg === undefined) return 0
  return (
    (usage.inputTokens      / 1_000_000) * cfg.inputPer1mUsd +
    (usage.outputTokens     / 1_000_000) * cfg.outputPer1mUsd +
    (usage.cacheReadTokens  / 1_000_000) * (cfg.cacheReadPer1mUsd  ?? 0) +
    (usage.cacheWriteTokens / 1_000_000) * (cfg.cacheWritePer1mUsd ?? 0)
  )
}

// ---------------------------------------------------------------------------
// Workspace context builder — summarises the repo for the LLM prompt
// ---------------------------------------------------------------------------

function buildWorkspaceContext(
  repoRoot: string,
  packages: string[],
  scannedFiles: SourceFileEntry[],
): string {
  const lines: string[] = [
    `Repo root: ${repoRoot}`,
    "",
    `Packages (${packages.length}):`,
    ...packages.map(p => `  · ${p}`),
    "",
    `Source files (${scannedFiles.length} total, first 60):`,
    ...scannedFiles.slice(0, 60).map(f => `  · ${f.relativePath}`),
  ]
  if (scannedFiles.length > 60) {
    lines.push(`  … and ${scannedFiles.length - 60} more`)
  }
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Plan builder — derived from LLM patch result
// ---------------------------------------------------------------------------

function buildPlanFromPatches(
  task: Task,
  patches: { path: string }[],
  patchContext: PatchContext | null,
): AgentPlan {
  const targetFiles   = patches.map(p => p.path)
  const targetSymbols = patchContext?.exportedSymbols.slice(0, 3) ?? []

  const steps: AgentPlanStep[] = [
    {
      step: 1,
      description: "Inspect workspace packages and source files",
      toolName: "workspace-intelligence:inspect",
      expectedOutput: "Package map and source file index",
    },
    {
      step: 2,
      description: "Build patch context for primary target",
      toolName: "workspace-intelligence:buildPatchContext",
      expectedOutput: "PatchContext with importers and package owner",
    },
    {
      step: 3,
      description: `Plan and generate patch proposal via LLM (${patches.length} file(s))`,
      toolName: "llm:plan-and-patch",
      expectedOutput: "PatchProposal JSON",
    },
    {
      step: 4,
      description: "Generate verification plan",
      toolName: "verification:plan",
      expectedOutput: "Ordered verification commands",
    },
  ]

  return {
    goal: task.instruction,
    steps,
    targetSymbols,
    targetFiles,
    expectedOutputs: [
      "Workspace inspection results",
      "Patch context for primary target",
      "LLM-generated patch proposal",
      "Verification plan",
    ],
  }
}

// ---------------------------------------------------------------------------
// Verification plan (still deterministic — based on patch paths + context)
// ---------------------------------------------------------------------------

function generateVerificationPlan(
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
    for (const [script] of Object.entries(patchContext.packageOwner.scripts)) {
      if (script.startsWith("smoke:")) {
        commands.push(`pnpm ${script}`)
      }
    }
  }

  if (targetFile) {
    if (targetFile.startsWith("packages/workspace-intelligence")) {
      commands.push("pnpm smoke:workspace-intelligence")
    } else if (targetFile.startsWith("packages/runtime")) {
      commands.push("pnpm smoke:runtime")
      commands.push("pnpm smoke:events")
    }
  }

  return {
    goal: `Verify changes to ${targetFile ?? "target"} pass all checks`,
    commands,
    affectedPackages,
    expectTypecheckPass: true,
  }
}

// ---------------------------------------------------------------------------
// Heuristic fallback — used only to pick a patchContextBuilder query target
// when workspace scan hasn't yielded a concrete file yet
// ---------------------------------------------------------------------------

function extractHeuristicSymbol(instruction: string): string {
  const knownSymbols = [
    "BaseAgent", "CoderAgent", "WriterAgent", "RuntimeService",
    "IKernel", "IWorkspaceService", "IRepoIndex", "ISourceFileIndex",
  ]
  const lower = instruction.toLowerCase()
  for (const sym of knownSymbols) {
    if (lower.includes(sym.toLowerCase())) return sym
  }
  const match = instruction.match(/\b([A-Z][a-zA-Z]+)\b/)
  return match?.[1] ?? "BaseAgent"
}

function extractHeuristicFile(
  instruction: string,
  symbol: string,
  wi: WorkspaceIntelligence,
): string | null {
  const entries = wi.sourceFileIndex.findFilesBySymbol(symbol)
  if (entries.length > 0) {
    const first = entries[0]
    if (first) return first.relativePath
  }
  const pathMatch = instruction.match(/(?:src\/|packages\/|scripts\/|docs\/)[^\s,]+/)
  return pathMatch ? pathMatch[0] : null
}

// ---------------------------------------------------------------------------
// Options & main class
// ---------------------------------------------------------------------------

export interface ToolUseAgentOptions {
  /** Absolute path to the repo root */
  repoRoot: string
  /** LLM provider — used for real patch generation */
  provider: IProvider
  /** Model ID to use for the LLM call */
  model: string
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
}

export class ToolUseAgent {
  private wi:       WorkspaceIntelligence
  private provider: IProvider
  private model:    string
  private repoRoot: string

  constructor(options: ToolUseAgentOptions) {
    this.wi       = createWorkspaceIntelligence({ repoRoot: options.repoRoot })
    this.provider = options.provider
    this.model    = options.model
    this.repoRoot = options.repoRoot
  }

  /**
   * Execute: inspect workspace → build patch context → LLM call →
   *          derive plan → generate verification plan.
   *
   * No files are written. The returned PatchProposal is handed to the
   * kernel's approval pipeline.
   */
  async execute(task: Task): Promise<ToolUseAgentResult> {
    const toolCalls: AgentToolCall[] = []

    // ── Step 1: Workspace scan ────────────────────────────────────────────────
    const tInspect = timeStart()

    await this.wi.repoIndex.scan()
    const packages     = this.wi.repoIndex.listPackages()
    const scannedFiles = await this.wi.sourceFileIndex.scan()
    await this.wi.repoGraph.build()

    const pkgDeps    = this.wi.repoGraph.getPackageDependencies()
    const entryHints = this.wi.repoGraph.getRuntimeEntryHints()
    const inspectMs  = timeEnd(tInspect)

    const inspection: WorkspaceInspectionResult = {
      packageCount:       packages.length,
      sourceFileCount:    scannedFiles.length,
      foundSymbols:       [],
      packageDependencies: pkgDeps,
      entryHints,
    }

    toolCalls.push({
      toolName:    "workspace-intelligence:inspect",
      input:       { action: "scanAll" },
      outputSummary: `${packages.length} packages, ${scannedFiles.length} source files`,
      success:     true,
      durationMs:  inspectMs,
    })

    // ── Step 2: Patch context (heuristic query target) ────────────────────────
    const tContext = timeStart()

    const hSymbol     = extractHeuristicSymbol(task.instruction)
    const hFile       = extractHeuristicFile(task.instruction, hSymbol, this.wi)
    const queryTarget = hFile ?? hSymbol
    const patchContext = await this.wi.patchContextBuilder.build(queryTarget)
    const contextMs   = timeEnd(tContext)

    toolCalls.push({
      toolName:    "workspace-intelligence:buildPatchContext",
      input:       { target: queryTarget },
      outputSummary: patchContext
        ? `${patchContext.importers.length} importers, owner=${patchContext.packageOwner?.name ?? "none"}`
        : "null (target not found)",
      success:     patchContext !== null,
      durationMs:  contextMs,
    })

    // ── Step 3: LLM call — plan + generate patch proposal ────────────────────
    const tLLM = timeStart()

    const workspaceCtx = buildWorkspaceContext(this.repoRoot, packages, scannedFiles)

    const systemPrompt = [
      "You are Hermes CoderAgent — a senior software engineer inside an AI-native OS.",
      "Your job: read the task instruction and workspace context, then produce a precise patch proposal.",
      "",
      "WORKSPACE CONTEXT:",
      workspaceCtx,
      "",
      "RESPONSE FORMAT — return ONLY this JSON object (no markdown, no prose outside):",
      "{",
      '  "summary": "<one-line description of what the patches accomplish>",',
      '  "patches": [',
      '    { "path": "<relative/path/to/file>", "content": "<complete new file content>" }',
      "  ]",
      "}",
      "",
      "Rules:",
      "  · JSON only — no markdown code fences, no explanation outside the object.",
      "  · Each patch must contain the FULL file content (not a diff).",
      "  · 'path' is relative to the repo root.",
      "  · Only create/modify files that directly address the task.",
      "  · No unsolicited refactoring or extra files.",
      "  · FORBIDDEN paths: .env, *.db, kernel/**, audit/**",
    ].join("\n")

    const req: CompletionRequest = {
      model:     this.model,
      system:    systemPrompt,
      messages:  [{ role: "user", content: task.instruction }],
      maxTokens: 8192,
      metadata:  {
        taskId:    task.id,
        workspace: task.workspace,
        agentId:   "tool-use-agent",
      },
    }

    let patchProposal: PatchProposal | null = null
    let usage:   TokenUsage = { ...ZERO_USAGE }
    let llmError: string | null = null

    try {
      const response = await this.provider.complete(req)
      usage = response.usage ?? { ...ZERO_USAGE }

      const stripped = response.content
        .replace(/^```(?:json)?\s*/m, "")
        .replace(/\s*```$/m, "")
        .trim()

      let parsed: unknown
      try {
        parsed = JSON.parse(stripped)
      } catch {
        llmError = `LLM returned invalid JSON (first 200 chars): ${stripped.slice(0, 200)}`
      }

      if (parsed !== undefined) {
        if (isRawProposal(parsed)) {
          patchProposal = {
            taskId:     task.id,
            agentId:    "tool-use-agent-001",
            summary:    parsed.summary,
            proposedAt: new Date().toISOString(),
            patches:    parsed.patches.map(p => ({
              path:            p.path,
              originalContent: "",
              modifiedContent: p.content,
              diff:            "",
              hunks:           [],
            })),
          }
        } else {
          llmError = "LLM response did not match expected PatchProposal schema"
        }
      }
    } catch (err) {
      llmError = err instanceof Error ? err.message : String(err)
    }

    const llmMs   = timeEnd(tLLM)
    const costUsd = calcCostUsd(usage, this.model, this.provider)

    toolCalls.push({
      toolName:    "llm:plan-and-patch",
      input:       { model: this.model, instruction: task.instruction.slice(0, 120) },
      outputSummary: patchProposal
        ? `${patchProposal.patches.length} file(s) — "${patchProposal.summary}"`
        : `failed — ${llmError ?? "unknown error"}`,
      success:     patchProposal !== null,
      durationMs:  llmMs,
    })

    // ── Step 4: Derive plan from LLM patches ─────────────────────────────────
    const plan = buildPlanFromPatches(
      task,
      patchProposal?.patches ?? [],
      patchContext,
    )

    // ── Step 5: Generate verification plan ───────────────────────────────────
    const tVerify = timeStart()
    const firstPatchPath = patchProposal?.patches[0]?.path ?? hFile
    const verificationPlan = generateVerificationPlan(firstPatchPath, patchContext)
    const verifyMs = timeEnd(tVerify)

    toolCalls.push({
      toolName:    "verification:plan",
      input:       { targetFile: firstPatchPath, patchContextExists: patchContext !== null },
      outputSummary: `${verificationPlan.commands.length} commands`,
      success:     true,
      durationMs:  verifyMs,
    })

    return {
      taskId: task.id,
      plan,
      inspection,
      patchContext,
      patchProposal,
      verificationPlan,
      toolCalls,
      status:   "PLAN_EXECUTED",
      usage,
      costUsd,
    }
  }
}
