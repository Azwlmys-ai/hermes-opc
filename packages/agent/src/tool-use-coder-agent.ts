// =============================================================================
// ToolUseCoderAgent — IAgent wrapper that delegates to ToolUseAgent.
//
// Receives repoRoot at construction time and passes it through to the
// internal ToolUseAgent for workspace-intelligence integration.
// =============================================================================

import type {
  IAgent,
  AgentConfig,
  AgentContext,
  AgentResult,
  Task,
  ToolCall,
} from "./types.js"
import { AgentStatus } from "./types.js"
import { ToolUseAgent } from "./tool-use-agent.js"
import type { ToolUseAgentOptions } from "./tool-use-agent.js"

export class ToolUseCoderAgent implements IAgent {
  readonly config: AgentConfig
  private repoRoot: string
  private status: AgentStatus = AgentStatus.Idle

  constructor(config: AgentConfig, options: ToolUseAgentOptions) {
    this.config = config
    this.repoRoot = options.repoRoot
  }

  async execute(task: Task, _ctx: AgentContext): Promise<AgentResult> {
    this.status = AgentStatus.Running

    const agent = new ToolUseAgent({ repoRoot: this.repoRoot })

    try {
      const result = await agent.execute(task)

      // Base result fields (no optional ones yet)
      const base: Omit<
        AgentResult,
        "patchProposal" | "plan" | "patchContext" | "verificationPlan"
      > = {
        taskId: result.taskId,
        agentId: this.config.id,
        status:
          result.status === "PLAN_EXECUTED"
            ? AgentStatus.WaitingApproval
            : AgentStatus.Failed,
        output: JSON.stringify({
          plan: result.plan,
          inspection: result.inspection,
          patchContextSnippet: result.patchContext
            ? `${result.patchContext.packageOwner?.name ?? "none"} | ${result.patchContext.exportedSymbols.length} symbols`
            : "none",
          patchProposalSnippet: result.patchProposal
            ? result.patchProposal.summary
            : "none",
          verificationPlan: result.verificationPlan.goal,
        }),
        done: result.patchProposal
          ? [`Generated patch proposal: ${result.patchProposal.summary}`]
          : [],
        deferred: [],
        risks: [],
        toolCalls: result.toolCalls.map(
          (tc): ToolCall => ({
            toolName: tc.toolName,
            args: tc.input,
            result: tc.outputSummary,
            durationMs: tc.durationMs,
          }),
        ),
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        costUsd: 0,
        completedAt: new Date().toISOString(),
      }

      // Merge optional fields only when they have a value.
      // exactOptionalPropertyTypes forbids assigning undefined to them.
      const agentResult = { ...base } as AgentResult

      if (result.patchProposal) {
        agentResult.patchProposal = result.patchProposal
      }
      if (result.plan) {
        agentResult.plan = result.plan
      }
      if (result.patchContext) {
        agentResult.patchContext = result.patchContext
      }
      if (result.verificationPlan) {
        agentResult.verificationPlan = result.verificationPlan
      }

      this.status = AgentStatus.WaitingApproval
      return agentResult
    } catch (err) {
      this.status = AgentStatus.Failed
      const message = err instanceof Error ? err.message : String(err)
      return {
        taskId: task.id,
        agentId: this.config.id,
        status: AgentStatus.Failed,
        output: `ToolUseAgent failed: ${message}`,
        done: [],
        deferred: [],
        risks: [message],
        toolCalls: [],
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        costUsd: 0,
        completedAt: new Date().toISOString(),
      }
    }
  }

  async cancel(): Promise<void> {
    this.status = AgentStatus.Cancelled
  }

  getStatus(): AgentStatus {
    return this.status
  }
}