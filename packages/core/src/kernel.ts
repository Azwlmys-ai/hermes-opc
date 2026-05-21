// =============================================================================
// Kernel — implements IKernel: serial task execution, routing, cost guard.
//
// v0.1 constraints (all intentional):
//   · Serial only — one task running at a time (maxConcurrentAgents = 1)
//   · In-memory task graph — not persisted across restarts
//   · Daily spend counter resets on restart (no DB query at boot)
//   · Coder tasks use ToolUseCoderAgent (real workspace-intelligence integration)
//   · Writer tasks use WriterAgent
//   · Coder tasks can reach WAITING_APPROVAL with dry-run patch proposals
//   · No force-cancel on shutdown — running task completes naturally
// =============================================================================

import { randomUUID }   from "node:crypto"
import {
  loadCostTable,
  AnthropicProvider,
  OpenAICompatibleProvider,
} from "@hermes/provider"
import type { IProvider, CompletionRequest } from "@hermes/provider"
import { createMemoryService, TaskStatus }   from "@hermes/memory"
import type { IMemoryService }               from "@hermes/memory"
import { createWorkspaceService }            from "@hermes/workspace"
import { createRuntimeEventBus, VerificationService } from "@hermes/runtime"
import type {
  IRuntimeEventBus,
  RuntimeEventType,
  RuntimeEventSource,
  RuntimeEventLevel,
} from "@hermes/runtime"
import {
  AgentStatus,
  AgentType,
  AgentTier,
  Priority,
  WriterAgent,
  ToolUseCoderAgent,
  PrdIngestionAgent,
} from "@hermes/agent"
import type {
  AgentConfig,
  AgentPermissions,
  IAgent,
  Task,
} from "@hermes/agent"
import type {
  IKernel,
  KernelConfig,
  SubmitRequest,
  SubmitResponse,
  TaskDetail,
  TaskNode,
  TaskSummary,
} from "./types.js"
import { loadKernelConfig } from "./config-loader.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_BUDGET = 8192

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function buildPermissions(agentType: AgentType): AgentPermissions {
  switch (agentType) {
    case AgentType.Coder:
      return {
        read:      ["**/*"],
        write:     ["src/**", "packages/**", "scripts/**"],
        execute:   [
          "npm test", "npm run build", "npm run lint",
          "npm run typecheck", "npx tsc --noEmit",
          "pytest", "python -m pytest",
        ],
        forbidden: [".env", "kernel/**", "audit/**", "**/*.db"],
      }
    case AgentType.Writer:
      return {
        read:      ["**/*.md", "docs/**", "README*"],
        write:     ["**/*.md", "docs/**"],
        execute:   [],
        forbidden: ["src/**", ".env", "kernel/**", "**/*.db"],
      }
    case AgentType.Pm:
      return {
        read:      ["**/*.md", "docs/**", "examples/**", "*.docx"],
        write:     ["docs/**", "examples/**"],
        execute:   [],
        forbidden: ["src/**", ".env", "kernel/**", "**/*.db"],
      }
    default:
      return { read: [], write: [], execute: [], forbidden: ["**/*"] }
  }
}

function tierFor(agentType: AgentType): AgentTier {
  switch (agentType) {
    case AgentType.Pm:
    case AgentType.Arch:
    case AgentType.Qa:
    case AgentType.Ops:
    case AgentType.Gtm:
      return AgentTier.Head
    case AgentType.Ephemeral:
      return AgentTier.Ephemeral
    default:
      return AgentTier.Specialist
  }
}

function buildPermissionsSummary(config: AgentConfig): string {
  const { permissions: p } = config
  const lines = [
    `Agent: ${config.role} (tier ${config.tier})`,
    `Read:  ${p.read.join(", ")}`,
    `Write: ${p.write.join(", ")}`,
  ]
  if (p.execute.length > 0) lines.push(`Execute: ${p.execute.join(", ")}`)
  if (p.forbidden.length > 0) lines.push(`Forbidden: ${p.forbidden.join(", ")}`)
  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Kernel
// ---------------------------------------------------------------------------

export class Kernel implements IKernel {
  private readonly config:            KernelConfig
  private readonly provider:          IProvider
  private readonly verificationSvc:   VerificationService
  // SQLiteMemoryService typed directly so we can call .close() on shutdown
  private readonly memSvcs  = new Map<string, ReturnType<typeof createMemoryService>>()
  // WorkspaceService per workspace, lazily created on first approveTask call
  private readonly wsSvcs   = new Map<string, ReturnType<typeof createWorkspaceService>>()
  private readonly tasks     = new Map<string, TaskNode>()

  private dailySpendUsd     = 0
  private executing         = false
  private shutdownRequested = false

  constructor(config: KernelConfig, provider: IProvider, eventBus: IRuntimeEventBus) {
    this._eventBus       = eventBus
    this.config          = config
    this.provider        = provider
    this.verificationSvc = new VerificationService(
      process.env["HERMES_ROOT"] ?? process.cwd(),
    )
  }

  /** Expose EventBus for external subscribers (smoke tests, monitoring). */
  get eventBus(): IRuntimeEventBus {
    return this._eventBus
  }

  private readonly _eventBus: IRuntimeEventBus

  // ── IKernel.submit ────────────────────────────────────────────────────────

  async submit(req: SubmitRequest): Promise<SubmitResponse> {
    if (this.shutdownRequested) {
      throw new Error("Kernel is shutting down — new tasks are not accepted")
    }

    const agentType = req.agentType ?? AgentType.Coder

    if (
      agentType !== AgentType.Coder &&
      agentType !== AgentType.Writer &&
      agentType !== AgentType.Pm
    ) {
      throw new Error(
        `AgentType "${agentType}" is not implemented in v0.1. ` +
        "Only Coder, Writer, and Pm are available.",
      )
    }

    // Resolve model: per-type route override → kernel default
    const route = this.config.providerRoutes.find(r => r.taskType === agentType)
    const model  = route?.model ?? this.config.defaultModel

    // Pre-flight cost estimate (instruction only; system prompt excluded — conservative under-count)
    const estimateReq: CompletionRequest = {
      model,
      messages:  [{ role: "user", content: req.instruction }],
      maxTokens: DEFAULT_TOKEN_BUDGET,
    }
    const estimate = this.provider.estimateCost(estimateReq)

    // Budget guard — reject before spending anything
    const sessionLimit = req.budgetLimitUsd ?? this.config.budget.perAgentSessionLimitUsd
    if (estimate.totalEstimatedUsd > sessionLimit) {
      throw new Error(
        `Estimated cost $${estimate.totalEstimatedUsd.toFixed(4)} exceeds ` +
        `session limit $${sessionLimit.toFixed(2)}`,
      )
    }
    const projectedDaily = this.dailySpendUsd + estimate.totalEstimatedUsd
    if (projectedDaily > this.config.budget.globalDailyLimitUsd) {
      throw new Error(
        `Task would push daily spend to $${projectedDaily.toFixed(4)}, ` +
        `exceeding daily limit $${this.config.budget.globalDailyLimitUsd.toFixed(2)}`,
      )
    }

    const taskId = `task-${req.workspace}-${Date.now()}-${randomUUID().slice(0, 8)}`
    const now    = new Date().toISOString()

    const task: Task = {
      id:             taskId,
      type:           agentType,
      workspace:      req.workspace,
      instruction:    req.instruction,
      contextRefs:    req.contextRefs ?? [],
      priority:       req.priority    ?? Priority.Normal,
      budgetLimitUsd: sessionLimit,
      deps:           [],
      createdAt:      now,
    }

    const node: TaskNode = {
      task,
      status:    TaskStatus.Pending,
      blockedBy: [],
      unblocks:  [],
    }

    this.tasks.set(taskId, node)

    // Emit task.created event
    this.emitEvent("kernel", "task.created", "info", node, {
      agentType: task.type,
      instruction: task.instruction,
      priority: task.priority,
    })

    // Dispatch without blocking the caller
    void this.dispatchPending()

    return { taskId, estimatedCost: estimate, status: TaskStatus.Pending }
  }

  // ── IKernel.getStatus ─────────────────────────────────────────────────────

  async getStatus(taskId: string): Promise<TaskStatus> {
    const node = this.tasks.get(taskId)
    if (node === undefined) throw new Error(`Task not found: ${taskId}`)
    return node.status
  }

  // ── IKernel.approveTask ───────────────────────────────────────────────────

  async approveTask(taskId: string): Promise<void> {
    const node = this.tasks.get(taskId)
    if (node === undefined) throw new Error(`Task not found: ${taskId}`)
    if (node.status !== TaskStatus.WaitingApproval) {
      throw new Error(
        `Task ${taskId} is not in WAITING_APPROVAL state (status: ${node.status})`,
      )
    }

    const proposal = node.result?.patchProposal

    // ── Verification pipeline ────────────────────────────────────────────────
    // Run even when there is no patch — the typecheck + smoke still apply.
    this.emitEvent("kernel", "task.verification.started", "info", node, {
      hasPatch: proposal !== undefined && proposal.patches.length > 0,
    })

    const verResult = await this.verificationSvc.verifyWorkspacePatch(
      proposal ?? { patches: [] },
    )
    node.verificationResult = verResult

    if (!verResult.passed) {
      this.emitEvent("kernel", "task.verification.failed", "warn", node, {
        summary: verResult.summary,
        failedChecks: verResult.checks
          .filter(c => !c.passed)
          .map(c => ({ name: c.name, details: c.details })),
      })
      node.status = TaskStatus.Failed
      this.emitEvent("kernel", "task.failed", "warn", node, {
        status: node.status,
        reason: `Verification failed: ${verResult.summary}`,
      })
      return
    }

    this.emitEvent("kernel", "task.verification.passed", "info", node, {
      summary: verResult.summary,
      checkCount: verResult.checks.length,
    })
    // ── Apply patch ───────────────────────────────────────────────────────────

    if (proposal !== undefined && proposal.patches.length > 0) {
      this.emitEvent("workspace", "workspace.patch.approved", "info", node, {
        summary: proposal.summary,
        patchCount: proposal.patches.length,
        paths: proposal.patches.map(patch => patch.path),
      })
      const ws = this.getOrCreateWorkspace(node.task.workspace)
      const applied = await ws.applyPatch(proposal)
      this.emitEvent("workspace", "workspace.patch.applied", "info", node, {
        summary: proposal.summary,
        patchCount: applied.length,
        paths: applied.map(patch => patch.path),
      })
    }

    this.emitEvent("kernel", "task.approved", "info", node, {
      previousStatus: TaskStatus.WaitingApproval,
      approved: true,
    })

    node.status = TaskStatus.Done
    this.emitEvent("kernel", "task.completed", "info", node, { status: node.status, approved: true })
  }

  // ── IKernel.rejectTask ────────────────────────────────────────────────────

  async rejectTask(taskId: string, reason?: string): Promise<void> {
    const node = this.tasks.get(taskId)
    if (node === undefined) throw new Error(`Task not found: ${taskId}`)
    if (node.status !== TaskStatus.WaitingApproval) {
      throw new Error(
        `Task ${taskId} is not in WAITING_APPROVAL state (status: ${node.status})`,
      )
    }
    // Emit task.rejected event
    this.emitEvent("kernel", "task.rejected", "info", node, {
      reason: reason ?? "Task rejected",
    })

    node.status = TaskStatus.Failed
    if (reason !== undefined) node.rejectReason = reason
    this.emitEvent("kernel", "task.failed", "warn", node, {
      status: node.status,
      reason: reason ?? "Task rejected",
    })
  }

  // ── IKernel.getTaskDetail ─────────────────────────────────────────────────

  async getTaskDetail(taskId: string): Promise<TaskDetail> {
    const node = this.tasks.get(taskId)
    if (node === undefined) throw new Error(`Task not found: ${taskId}`)
    const { task } = node

    const detail: TaskDetail = {
      taskId:      task.id,
      workspace:   task.workspace,
      agentType:   task.type,
      status:      node.status,
      instruction: task.instruction,
      createdAt:   task.createdAt,
      done:        [],
      deferred:    [],
      risks:       [],
      costUsd:     0,
    }

    if (node.agentId !== undefined) detail.agentId = node.agentId

    if (node.result !== undefined) {
      detail.output      = node.result.output
      detail.done        = node.result.done
      detail.deferred    = node.result.deferred
      detail.risks       = node.result.risks
      detail.costUsd     = node.result.costUsd
      detail.completedAt = node.result.completedAt
      if (node.result.patchProposal !== undefined) {
        detail.patchProposal = node.result.patchProposal
      }
    }

    if (node.rejectReason !== undefined)       detail.rejectReason   = node.rejectReason
    if (node.verificationResult !== undefined) detail.verification   = node.verificationResult

    return detail
  }

  // ── IKernel.listTasks ─────────────────────────────────────────────────────

  async listTasks(workspace?: string): Promise<TaskSummary[]> {
    const result: TaskSummary[] = []
    for (const [taskId, node] of this.tasks) {
      if (workspace !== undefined && node.task.workspace !== workspace) continue
      result.push({
        taskId,
        workspace:   node.task.workspace,
        agentType:   node.task.type,
        status:      node.status,
        instruction: node.task.instruction.slice(0, 120),
        createdAt:   node.task.createdAt,
      })
    }
    return result
  }

  // ── IKernel.cancelTask ────────────────────────────────────────────────────

  async cancelTask(taskId: string): Promise<void> {
    const node = this.tasks.get(taskId)
    if (node === undefined) throw new Error(`Task not found: ${taskId}`)
    if (
      node.status === TaskStatus.Pending ||
      node.status === TaskStatus.Ready
    ) {
      node.status = TaskStatus.Failed
      return
    }
    if (node.status === TaskStatus.Running) {
      throw new Error(
        `Task ${taskId} is currently running — cancel is not supported for running tasks in v0.1`,
      )
    }
    throw new Error(
      `Task ${taskId} is already in terminal state: ${node.status}`,
    )
  }

  // ── IKernel.shutdown ──────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    this.shutdownRequested = true
    for (const svc of this.memSvcs.values()) {
      svc.close()
    }
    this.memSvcs.clear()
  }

  // ── Private: execution ────────────────────────────────────────────────────

  private getOrCreateMemory(workspace: string): IMemoryService {
    let svc = this.memSvcs.get(workspace)
    if (svc === undefined) {
      svc = createMemoryService(workspace)
      this.memSvcs.set(workspace, svc)
    }
    return svc
  }

  private getOrCreateWorkspace(workspaceId: string): ReturnType<typeof createWorkspaceService> {
    let svc = this.wsSvcs.get(workspaceId)
    if (svc === undefined) {
      const root = this.resolveWorkspaceRoot()
      svc = createWorkspaceService(workspaceId, root, this._eventBus)
      this.wsSvcs.set(workspaceId, svc)
    }
    return svc
  }

  /**
   * Serial dispatcher — finds the next PENDING/READY task with all deps Done,
   * then runs it. Calls itself recursively (via fire-and-forget) after each task.
   */
  private async dispatchPending(): Promise<void> {
    if (this.executing || this.shutdownRequested) return

    let nextNode: TaskNode | undefined
    for (const node of this.tasks.values()) {
      const isReady =
        (node.status === TaskStatus.Pending || node.status === TaskStatus.Ready) &&
        node.blockedBy.every(id => this.tasks.get(id)?.status === TaskStatus.Done)
      if (isReady) {
        nextNode = node
        break
      }
    }
    if (nextNode === undefined) return

    this.executing = true
    try {
      await this.runTask(nextNode)
    } catch {
      // Error already recorded on the node; swallow here to keep dispatcher alive
    } finally {
      this.executing = false
      void this.dispatchPending()
    }
  }

  private async runTask(node: TaskNode): Promise<void> {
    const { task } = node
    node.status = TaskStatus.Running
    this.emitEvent("kernel", "task.started", "info", node, {
      status: node.status,
      agentType: task.type,
      instruction: task.instruction,
    })

    const memory  = this.getOrCreateMemory(task.workspace)
    const agentId = `${task.type}-${task.workspace}-${Date.now()}`
    node.agentId  = agentId

    // Resolve model for this task
    const route = this.config.providerRoutes.find(r => r.taskType === task.type)
    const model  = route?.model ?? this.config.defaultModel

    const agentConfig: AgentConfig = {
      id:          agentId,
      role:        task.type,
      tier:        tierFor(task.type),
      workspace:   task.workspace,
      permissions: buildPermissions(task.type),
      budget: {
        sessionLimitUsd: task.budgetLimitUsd,
        alertThreshold:  this.config.budget.alertThreshold,
        hardStop:        true,
      },
      model,
    }

    const agent = this.buildAgent(task.type, agentConfig)

    // Retrieve relevant memory entries for context
    const memoryEntries = await memory.query({
      workspace: task.workspace,
      limit:     20,
    })

    const ctx = {
      memoryEntries,
      permissionsSummary: buildPermissionsSummary(agentConfig),
      tokenBudget:        DEFAULT_TOKEN_BUDGET,
    }

    try {
      const result = await agent.execute(task, ctx)
      node.result   = result
      // Cost is always recorded — API call already happened
      this.dailySpendUsd += result.costUsd

      // CoderAgent returns a patchProposal when it has code changes to propose.
      // Pm/other agents may report WaitingApproval for plan/doc review.
      // In both cases, the task waits for explicit human approval.
      const hasPendingPatches =
        result.patchProposal !== undefined &&
        result.patchProposal.patches.length > 0

      node.status =
        hasPendingPatches || result.status === AgentStatus.WaitingApproval
          ? TaskStatus.WaitingApproval
          : TaskStatus.Done

      // Emit workspace-aware events from agent result
      if (result.plan !== undefined) {
        this.emitEvent("kernel", "task.plan.generated", "info", node, {
          goal: result.plan.goal,
          stepCount: result.plan.steps.length,
        })
      }
      if (result.patchContext !== undefined && result.patchContext !== null) {
        this.emitEvent("kernel", "task.patch.context.built", "info", node, {
          target: result.patchContext.target,
          exportedSymbols: result.patchContext.exportedSymbols.length,
          importers: result.patchContext.importers.length,
        })
      }
      if (result.verificationPlan !== undefined) {
        this.emitEvent("kernel", "task.verification.planned", "info", node, {
          goal: result.verificationPlan.goal,
        })
      }

      if (hasPendingPatches && result.patchProposal !== undefined) {
        this.emitEvent("workspace", "workspace.patch.proposed", "info", node, {
          summary: result.patchProposal.summary,
          patchCount: result.patchProposal.patches.length,
          paths: result.patchProposal.patches.map(patch => patch.path),
        })

        // Emit task.approval.waiting
        this.emitEvent("kernel", "task.approval.waiting", "info", node, {
          patchSummary: result.patchProposal.summary,
          patchCount: result.patchProposal.patches.length,
        })
      } else {
        this.emitEvent("kernel", "task.completed", "info", node, {
          status: node.status,
          costUsd: result.costUsd,
        })
      }
    } catch (err) {
      node.status = TaskStatus.Failed
      this.emitEvent("kernel", "task.failed", "error", node, {
        status: node.status,
        error: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  }

  private emitEvent(
    source: RuntimeEventSource,
    type: RuntimeEventType,
    level: RuntimeEventLevel,
    node: TaskNode,
    payload: Record<string, unknown>,
  ): void {
    this._eventBus.emit({
      source,
      type,
      level,
      workspaceId: node.task.workspace,
      taskId: node.task.id,
      payload,
    })
  }

  /**
   * Resolve workspace root from HERMES_ROOT or process.cwd().
   */
  private resolveWorkspaceRoot(): string {
    return process.env["HERMES_ROOT"] ?? process.cwd()
  }

  private buildAgent(agentType: AgentType, config: AgentConfig): IAgent {
    const memory = this.getOrCreateMemory(config.workspace)
    switch (agentType) {
      case AgentType.Coder:
        return new ToolUseCoderAgent(config, {
          repoRoot: this.resolveWorkspaceRoot(),
          provider: this.provider,
          model:    config.model ?? this.config.defaultModel,
        })
      case AgentType.Writer:
        return new WriterAgent(config, this.provider, memory)
      case AgentType.Pm:
        return new PrdIngestionAgent(config)
      default:
        throw new Error(`AgentType "${agentType}" is not implemented in v0.1`)
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ready-to-use Kernel from kernel/config.yaml.
 *
 * Reads:
 *   ANTHROPIC_API_KEY    — required when defaultProvider = "anthropic"
 *   OPENAI_API_KEY       — required when defaultProvider = "openai-compatible"
 *   OPENAI_BASE_URL      — base URL override for openai-compatible provider
 *   HERMES_ROOT          — Hermes root directory (falls back to process.cwd())
 *
 * @param hermesRoot  Optional override for the Hermes root path.
 */
export function createKernel(hermesRoot?: string): Kernel {
  const root      = hermesRoot ?? process.env["HERMES_ROOT"] ?? process.cwd()
  const config    = loadKernelConfig(root)
  const costTable = loadCostTable(root)

  let provider: IProvider
  const providerName = config.defaultProvider.toLowerCase()

  if (providerName === "anthropic") {
    const apiKey = process.env["ANTHROPIC_API_KEY"] ?? ""
    provider = new AnthropicProvider(apiKey, costTable)
  } else if (providerName === "openai" || providerName === "openai-compatible") {
    const apiKey  = process.env["OPENAI_API_KEY"] ?? ""
    const baseURL = process.env["OPENAI_BASE_URL"] ?? "https://api.openai.com/v1"
    provider = new OpenAICompatibleProvider({ apiKey, baseURL, costTable })
  } else {
    throw new Error(
      `Unknown provider "${config.defaultProvider}" in kernel/config.yaml. ` +
      "v0.1 supports: anthropic | openai | openai-compatible",
    )
  }

  const eventBus = createRuntimeEventBus()
  return new Kernel(config, provider, eventBus)
}
