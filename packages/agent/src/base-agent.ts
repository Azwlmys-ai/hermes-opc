// =============================================================================
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
// =============================================================================

import type { IProvider, CompletionRequest } from "@hermes/provider"
import type { IMemoryService }               from "@hermes/memory"
import { TaskStatus }                        from "@hermes/memory"
import type { PatchProposal }                from "@hermes/workspace"
import type {
  AgentConfig,
  AgentContext,
  AgentResult,
  IAgent,
  Task,
  TokenUsage,
} from "./types.js"
import { AgentStatus } from "./types.js"

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** Assemble the user turn from task instruction + injected memory. */
function buildUserMessage(task: Task, ctx: AgentContext): string {
  const lines: string[] = []

  if (ctx.memoryEntries.length > 0) {
    lines.push("## Project Memory\n")
    for (const entry of ctx.memoryEntries) {
      lines.push(`- [${entry.type}] ${entry.key}: ${entry.value}`)
    }
    lines.push("")
  }

  if (ctx.permissionsSummary.length > 0) {
    lines.push("## Permissions\n")
    lines.push(ctx.permissionsSummary)
    lines.push("")
  }

  lines.push("## Task\n")
  lines.push(task.instruction)

  return lines.join("\n")
}

/** Exact cost from token usage + ModelConfig pricing. Returns 0 for unknown models. */
function calcCostUsd(usage: TokenUsage, modelId: string, provider: IProvider): number {
  const cfg = provider.models.find(m => m.id === modelId)
  if (cfg === undefined) return 0
  return (
    (usage.inputTokens      / 1_000_000) * cfg.inputPer1mUsd +
    (usage.outputTokens     / 1_000_000) * cfg.outputPer1mUsd +
    (usage.cacheReadTokens  / 1_000_000) * (cfg.cacheReadPer1mUsd  ?? 0) +
    (usage.cacheWriteTokens / 1_000_000) * (cfg.cacheWritePer1mUsd ?? 0)
  )
}

const ZERO_USAGE: TokenUsage = {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
}

// ---------------------------------------------------------------------------
// BaseAgent
// ---------------------------------------------------------------------------

export abstract class BaseAgent implements IAgent {
  readonly config: AgentConfig

  protected readonly provider: IProvider
  protected readonly memory:   IMemoryService

  private _status: AgentStatus = AgentStatus.Idle
  private _cancelRequested = false

  constructor(config: AgentConfig, provider: IProvider, memory: IMemoryService) {
    this.config   = config
    this.provider = provider
    this.memory   = memory
  }

  getStatus(): AgentStatus {
    return this._status
  }

  cancel(): Promise<void> {
    this._cancelRequested = true
    return Promise.resolve()
  }

  /** Subclasses return the full system prompt string for their agent role. */
  protected abstract buildSystemPrompt(task: Task): string

  /**
   * Optional post-processing hook called after the raw LLM response arrives.
   * Subclasses may override to parse structured output (e.g. CoderAgent JSON).
   * The base implementation returns the raw content unchanged.
   */
  protected postProcess(
    content: string,
    _task:   Task,
    _agentId: string,
  ): { output: string; patchProposal?: PatchProposal } {
    return { output: content }
  }

  // -------------------------------------------------------------------------
  // execute
  // -------------------------------------------------------------------------

  async execute(task: Task, ctx: AgentContext): Promise<AgentResult> {
    this._status          = AgentStatus.Running
    this._cancelRequested = false

    if (this._cancelRequested) return this.cancelledResult(task)

    // Resolve model: agent config override → first model in provider list
    const model = this.config.model ?? this.provider.models[0]?.id
    if (model === undefined) {
      this._status = AgentStatus.Failed
      throw new Error(
        `Agent ${this.config.id}: no model configured and provider exposes no models`,
      )
    }

    const req: CompletionRequest = {
      model,
      system:    this.buildSystemPrompt(task),
      messages:  [{ role: "user", content: buildUserMessage(task, ctx) }],
      // Honour token budget but cap at provider-side safe maximum
      maxTokens: Math.min(8192, ctx.tokenBudget),
      metadata: {
        taskId:    task.id,
        workspace: task.workspace,
        agentId:   this.config.id,
      },
    }

    const startedAt = new Date().toISOString()

    let response
    try {
      response = await this.provider.complete(req)
    } catch (err) {
      this._status = AgentStatus.Failed
      await this.memory.recordTask({
        taskId:      task.id,
        agentId:     this.config.id,
        workspace:   task.workspace,
        status:      TaskStatus.Failed,
        costUsd:     0,
        tokensUsed:  0,
        startedAt,
        completedAt: new Date().toISOString(),
      })
      throw err
    }

    if (this._cancelRequested) return this.cancelledResult(task)

    const costUsd    = calcCostUsd(response.usage, response.model, this.provider)
    const tokensUsed = response.usage.inputTokens + response.usage.outputTokens
    const completedAt = new Date().toISOString()

    // Run postProcess before recording so we know the correct terminal status
    const { output, patchProposal } = this.postProcess(
      response.content,
      task,
      this.config.id,
    )

    // Tasks with a non-empty patch proposal wait for explicit approval before
    // being written to disk — record the pending state in memory accordingly.
    const hasPendingPatches =
      patchProposal !== undefined && patchProposal.patches.length > 0

    await this.memory.recordTask({
      taskId:    task.id,
      agentId:   this.config.id,
      workspace: task.workspace,
      status:    hasPendingPatches ? TaskStatus.WaitingApproval : TaskStatus.Done,
      costUsd,
      tokensUsed,
      startedAt,
      completedAt,
    })

    this._status = AgentStatus.Done

    const result: AgentResult = {
      taskId:      task.id,
      agentId:     this.config.id,
      status:      AgentStatus.Done,
      output,
      done:        [],
      deferred:    [],
      risks:       [],
      toolCalls:   [],
      usage:       response.usage,
      costUsd,
      completedAt,
    }
    if (patchProposal !== undefined) result.patchProposal = patchProposal
    return result
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private cancelledResult(task: Task): AgentResult {
    this._status = AgentStatus.Cancelled
    return {
      taskId:      task.id,
      agentId:     this.config.id,
      status:      AgentStatus.Cancelled,
      output:      "",
      done:        [],
      deferred:    [],
      risks:       [],
      toolCalls:   [],
      usage:       { ...ZERO_USAGE },
      costUsd:     0,
      completedAt: new Date().toISOString(),
    }
  }
}
