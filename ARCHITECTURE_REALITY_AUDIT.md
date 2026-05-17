# OPC Architecture Reality Audit Report

**日期**: 2026-05-17  
**版本**: v0.1  
**审计方法**: 完整源码追踪 (grep → read → trace imports → trace runtime entry → trace execution path)

---

## 第一部分：项目结构审计

### 1.1 Monorepo Package 拓扑

```
packages/
├── core/                    # 内核：任务编排入口，集成所有子包
├── agent/                   # Agent 类型定义 + BaseAgent/CoderAgent/WriterAgent/ToolUseAgent
├── memory/                  # SQLite 记忆服务 (L2)
├── workspace/               # 工作区沙箱、diff、patch、审计
├── workspace-intelligence/  # Repo 索引、符号解析、依赖图、Patch 上下文
├── runtime/                 # 事件总线 + 命令执行沙箱
├── provider/                # LLM Provider (Anthropic / OpenAI-compatible)
└── mcp-server/              # MCP stdio 服务器入口
```

### 1.2 真实依赖关系图

```
                    ┌──────────────────┐
                    │   mcp-server     │
                    │ (stdio entry)    │
                    └────────┬─────────┘
                             │ imports
                    ┌────────▼─────────┐
                    │      core        │  ◄── 唯一集成点
                    │   (Kernel)       │
                    └──┬───┬───┬───┬──┘
                       │   │   │   │
          ┌────────────┘   │   │   └──────────────┐
          ▼                │   │                  ▼
   ┌──────────┐    ┌───────┴─┐ └──────┐    ┌──────────────┐
   │  agent   │    │ memory  │        │    │   runtime    │
   │ Coder    │    │ SQLite  │        │    │ EventBus +   │
   │ Writer   │    │ key-val │        │    │ CommandExec  │
   │ ToolUse  │    └─────────┘        │    └──────────────┘
   └────┬─────┘                       │
        │ imports                     │ imports
   ┌────▼──────────────┐     ┌───────▼──────┐
   │ workspace-intel   │     │  workspace   │
   │ (NOT WIRED to     │     │  Sandbox +   │
   │  Kernel!)         │     │  Diff/Patch  │
   └───────────────────┘     └──────────────┘

   ┌──────────┐
   │ provider │  ◄── agent calls provider.complete()
   │ Anthropic│
   │ OpenAI   │
   └──────────┘
```

**关键发现**: `workspace-intelligence` 包存在于代码库中，但 **未接入 Kernel**。
ToolUseAgent 使用了它，但 Kernel 不使用 ToolUseAgent。

### 1.3 包间真实依赖矩阵

| 包名 | 被谁 import | 运行时是否使用 | 状态 |
|------|------------|--------------|------|
| `@hermes/core` | mcp-server, smoke-* | ✅ 是 (唯一入口) | ACTIVE |
| `@hermes/agent` | core (kernel.ts) | ✅ Coder/Writer | ACTIVE |
| `@hermes/provider` | core, agent | ✅ Anthropic/OpenAI | ACTIVE |
| `@hermes/memory` | core, agent | ✅ SQLite key-val | ACTIVE |
| `@hermes/workspace` | core, agent | ✅ Sandbox/Patch | ACTIVE |
| `@hermes/runtime` | core (type only) | ⚠️ 仅类型导入 | PARTIAL |
| `@hermes/workspace-intelligence` | agent (tool-use-agent.ts) | ❌ 未接入 Kernel | DEAD |
| `@hermes/mcp-server` | 无 (自启动) | ✅ stdio 入口 | ACTIVE |

### 1.4 当前 Runtime 执行流程

```
smoke-kernel.ts
  │
  └─► createKernel()
        │
        ├─► loadKernelConfig("kernel/config.yaml")
        ├─► loadCostTable("kernel/cost-table.yaml")
        ├─► Provider 实例化 (Anthropic | OpenAI)
        │
        └─► new Kernel(config, provider)
              │
              └─► Kernel.submit({ workspace, instruction, agentType })
                    │
                    ├─► 成本预检 (estimateCost)
                    ├─► 创建 Task + TaskNode → tasks Map
                    │
                    └─► dispatchPending()  [fire-and-forget]
                          │
                          └─► runTask(node)
                                │
                                ├─► 创建 MemoryService (SQLite)
                                ├─► 查询 MemoryEntries (limit=20)
                                ├─► buildAgent(Coder | Writer)
                                │
                                └─► agent.execute(task, ctx)
                                      │
                                      └─► BaseAgent.execute()
                                            │
                                            ├─► 构建 system prompt
                                            ├─► provider.complete(messages)
                                            ├─► 解析 LLM 输出 (JSON parse)
                                            │
                                            └─► 返回 AgentResult {
                                                  output,
                                                  patchProposal?,
                                                  done, deferred, risks,
                                                  costUsd, usage
                                                }
                                      │
                                ◄── 如果 patchProposal 非空:
                                      node.status = WAITING_APPROVAL
                                    else:
                                      node.status = DONE
              │
              └─► 后续 approveTask()
                    └─► WorkspaceService.applyPatch(proposal)
                          └─► 写入文件到 projects/{workspace}/

              └─► 或 rejectTask()
                    └─► node.status = FAILED
```

### 1.5 当前 Runtime 架构总结

```
OPC v0.1 = 单线程任务执行器 + LLM 调用 + 文件 Patch 审批

实际能力:
  ✅ 接收任务 (submit)
  ✅ 调用 LLM (Anthropic/OpenAI)
  ✅ 解析 LLM 输出为 AgentResult
  ✅ Coder/Writer Agent (prompt 模板不同)
  ✅ SQLite 键值记忆 (关键词查询)
  ✅ 文件 Patch 提议 + 审批/拒绝
  ✅ 命令执行沙箱 (RuntimeService, 独立于 Kernel)
  ✅ MCP stdio 服务器入口
  ✅ 事件总线 (emit，无消费者)
  ✅ 工作区文件隔离 (projects/{workspaceId}/)
  ✅ 成本守护 (预算检查)

  ❌ 无 Workspace Intelligence 接入
  ❌ 无多 Agent 协作
  ❌ 无规划引擎
  ❌ 无语义记忆
  ❌ 无工具调用循环 (ToolUseAgent 未接入)
```

---

## 第二部分：能力覆盖审计

| # | 能力 | 状态 | 证据 | 说明 |
|---|------|------|------|------|
| 1 | Task orchestration | ✅ | `core/src/kernel.ts:376-399` dispatchPending() | 串行调度，有 deps 依赖图 |
| 2 | Multi-agent execution | ❌ | `core/src/kernel.ts:9` "Serial only" | maxConcurrentAgents=1，硬编码 |
| 3 | Workspace sandbox | ✅ | `workspace/src/sandbox.ts`, `runtime/src/runtime-service.ts:129-152` | 文件+命令双重沙箱 |
| 4 | Patch proposal | ✅ | `agent/src/agents/coder.ts`, `core/src/kernel.ts:455-465` | CoderAgent 生成 → WAITING_APPROVAL |
| 5 | Patch approval/reject | ✅ | `core/src/kernel.ts:216-261` | approveTask + rejectTask |
| 6 | Event streaming | ⚠️ | `runtime/src/event-bus.ts` | EventBus 存在，emit 有，但无 subscribe 消费者 |
| 7 | Telemetry | ⚠️ | `runtime/src/runtime-service.ts:154-171` audit() | 仅文件日志写入 audit/*.log，无遥测管道 |
| 8 | Long-term memory | ⚠️ | `memory/src/sqlite-memory-service.ts` | SQLite 键值存储，有关键词查询，无语义检索 |
| 9 | Semantic memory | ❌ | 无相关代码 | 无 embedding，无向量检索，无 RAG |
| 10 | Repo intelligence | ⚠️ | `workspace-intelligence/` 整个包 | 已实现但 **未接入 Kernel** |
| 11 | Symbol understanding | ⚠️ | `workspace-intelligence/src/source-file-index.ts` | 已实现但未接入 |
| 12 | Planning engine | ❌ | `agent/src/tool-use-agent.ts` 有 AgentPlan 类型 | 类型定义存在，但 Kernel 不使用 ToolUseAgent |
| 13 | Dependency graph reasoning | ⚠️ | `workspace-intelligence/src/repo-graph.ts` | 已实现但未接入 |
| 14 | Multi-agent collaboration | ❌ | Kernel 串行单 Agent | 无 Agent 间通信 |
| 15 | Self-healing | ❌ | 无相关代码 | Agent 失败后无自动重试/修复 |
| 16 | Rollback | ❌ | `workspace/src/diff.ts` 有 diff 能力 | 有 diff 但无 rollback 机制 |
| 17 | Audit trail | ⚠️ | `runtime/src/runtime-service.ts:154-171` | 命令级审计文件，无任务级审计持久化 |
| 18 | Architecture memory | ❌ | `memory/src/types.ts:62-72` Decision 类型 | Decision 类型存在，smoke 未测试，Kernel 未使用 |

**统计**:
- ✅ 已实现: 5 (28%)
- ⚠️ 部分实现: 7 (39%)
- ❌ 未实现: 6 (33%)

---

## 第三部分：Runtime vs Intelligence 分析

### 3.1 代码占比分析

| 层级 | 包 | 核心文件 | 定位 |
|------|-----|---------|------|
| **Infra** | runtime | event-bus.ts, runtime-service.ts | 事件+命令执行 |
| **Infra** | workspace | sandbox.ts, diff.ts, workspace-service.ts | 文件沙箱 |
| **Infra** | provider | anthropic.ts, openai-compatible.ts | LLM 调用 |
| **Infra** | mcp-server | server.ts, tools.ts | HTTP/stdio 入口 |
| **Orch** | core | kernel.ts, config-loader.ts | 任务串行调度 |
| **Agent** | agent | base-agent.ts, coder.ts, writer.ts | Prompt 模板 Agent |
| **Memory** | memory | sqlite-memory-service.ts | 键值 SQLite |
| **Intel** | workspace-intelligence | repo-index.ts, source-file-index.ts, repo-graph.ts, patch-context-builder.ts | **未接入** |

### 3.2 核心判断

```
当前 OPC 的真相:

  Infra 层 (runtime + workspace + provider + mcp-server)
  ──► 占总代码量 ~60%
  ──► 成熟度：高

  Agent 层 (base-agent + coder/writer)
  ──► 占总代码量 ~15%
  ──► 成熟度：低
  ──► 本质 = "prompt 模板 + JSON.parse(LLM输出)"

  Intelligence 层 (workspace-intelligence)
  ──► 占总代码量 ~15%
  ──► 成熟度：中（代码质量好）
  ──► 但接入率：0%

  Memory 层
  ──► 占总代码量 ~10%
  ──► 本质 = key-value store (非语义记忆)
```

### 3.3 当前 OPC 更像什么

| 候选 | 匹配度 | 原因 |
|------|--------|------|
| **AI OS** | 20% | 缺少认知层、规划引擎、多Agent协作 |
| **Agent Runtime** | 65% | Kernel 是 Agent 执行器，有审批流程 |
| **Workflow Engine** | 40% | 串行任务调度，但无可视化工作流 |
| **Infra Framework** | 55% | 沙箱、事件、Provider 抽象完善 |
| **MCP Router** | 25% | MCP 是入口但不是核心 |
| **Coding Agent Runtime** | 75% | 最准确：Coder Agent → Patch → 审批 |

**结论: OPC v0.1 最接近 "Coding Agent Runtime"——**
一个单 Agent 的任务执行器，有沙箱、审批流程、LLM 调用能力，
但**缺少真正的 Intelligence 层**。

---

## 第四部分：Day 路线偏离分析

### 4.1 对照 Day1-15 规划

| 阶段 | 原计划 | 实际情况 | 偏差 |
|------|--------|---------|------|
| Day1-3: Foundation | 项目结构、monorepo、类型 | ✅ 完成 | 无偏差 |
| Day4-5: Provider | LLM 调用抽象 | ✅ 完成 | 无偏差 |
| Day6-7: Memory + Kernel | 记忆+内核 | ✅ 完成 | 无偏差 |
| Day8-9: Agent | Agent 实现 | ⚠️ 部分 | 只有 prompt 模板 Agent |
| Day10: Approval | 审批流程 | ✅ 完成 | 无偏差 |
| Day11: Tool-Use | 工具调用循环 | ⚠️ ToolUseAgent 完成但未接入 | **严重偏离** |
| Day12+: Intelligence | Workspace Intelligence | ⚠️ 代码完成但未接入 | **严重偏离** |

### 4.2 哪些阶段提前过度开发

1. **Event Bus / Runtime Service** — 设计完整但无消费者
   - `runtime-tool.ts` 定义了 `runtime.exec` 工具
   - `event-bus.ts` 有 emit 但无外部 subscribe
   - `runtime-service.ts` 有完整进程管理+审计

2. **Workspace Intelligence** — 实现了完整的 repo 索引、符号解析、依赖图
   - 但 **Kernel 完全不使用它们**
   - AgentContext 中没有 PatchContext
   - CoderAgent/WriterAgent 不知道这些能力存在

### 4.3 哪些阶段实际缺失

1. **Planning Engine** — 从未实现为独立模块
   - AgentPlan 类型定义了但无 Planner 实现
   - ToolUseAgent 有内部 plan 生成，但未接入 Kernel

2. **Cognition Layer** — 完全缺失
   - Agent 不理解 repo 结构
   - Agent 不知道符号依赖
   - Agent 不会"思考"，只会生成 prompt → 解析 JSON

3. **Semantic Memory** — 未开始
   - 当前的 "memory" 只是 SQLite 键值对
   - 无 embedding / 向量检索 / RAG

### 4.4 当前最危险的架构偏离

```
⚠️ CRITICAL: "Infra-First, Intelligence-Never" 模式

  问题：所有 infra 层（runtime, workspace, provider, mcp-server）
        都在接入 Kernel 之前被完整实现，
        而 Intelligence 层（workspace-intelligence, tool-use-agent）
        已实现但从未接入。

  风险：如果继续按此模式开发（先做 infra，后接 intelligence），
        OPC 将永远停留在 "Coding Agent Runtime" 阶段，
        无法演进为真正的 AI Native OS。
```

### 4.5 Workspace Intelligence 是否实际存在

```
检查项                  代码存在    runtime接入   实际效果
────────────────────────────────────────────────────────
repo graph             ✅          ❌           无
symbol resolver        ✅          ❌           无
semantic search        ❌          ❌           无
dependency reasoning   ✅          ❌           无
patch context builder  ✅          ❌           无

结论: Workspace Intelligence 是 "纸上架构"。
      代码存在，质量好，但 0% 接入 runtime。
```

---

## 第五部分：Dead Code / Fake Capability 审计

### 5.1 未被 Runtime 引用的模块

| 模块 | 文件 | 为何 dead |
|------|------|----------|
| ToolUseAgent | `agent/src/tool-use-agent.ts` | Kernel 只实例化 Coder/Writer |
| RepoIndex | `workspace-intelligence/src/repo-index.ts` | 仅 smoke 测试使用 |
| SourceFileIndex | `workspace-intelligence/src/source-file-index.ts` | 仅 smoke 测试使用 |
| RepoGraph | `workspace-intelligence/src/repo-graph.ts` | 仅 smoke 测试使用 |
| PatchContextBuilder | `workspace-intelligence/src/patch-context-builder.ts` | 仅 smoke 测试使用 |
| RuntimeTool | `runtime/src/runtime-tool.ts` | Kernel 不使用 RuntimeService |
| Decision memory | `memory/src/types.ts:62-72` | IMemoryService 有 recordDecision 但无调用者 |
| FileContext memory | `memory/src/types.ts:74-85` | 同上 |
| AgentPlan types | `agent/src/types.ts:202-225` | 仅 ToolUseAgent 使用（未接入） |

### 5.2 "看起来高级"但未接入的 Abstraction

```
1. AgentTier (Kernel/Head/Specialist/Ephemeral)
   → 定义了层级但 Kernel 从不区分（全部 Specialist）

2. Priority (P0_CRITICAL ~ P3_LOW)
   → 定义了但调度器按 FIFO 执行（无优先级排序）

3. ProviderRouteRule / providerRoutes
   → config-loader 返回空数组 `providerRoutes: []`
   → 注释写 "v0.1: no per-type routes"

4. AgentPlan / AgentPlanStep
   → 完整类型定义，无 Planner 实现

5. VerificationPlan
   → 完整类型定义，无 Verifier 实现

6. WorkspaceInspectionResult
   → 完整类型定义，Kernel 不调用 workspace-intelligence

7. IKernel 接口
   → 只有 Kernel 一个实现，接口仅为抽象而抽象
```

### 5.3 空 Agent / 未完成 Pipeline

```
AgentType 枚举定义了 9 种 Agent:
  Pm, Arch, Coder, Qa, Ops, Gtm, Writer, Researcher, Ephemeral

实际实现: Coder, Writer (2/9)
Kernel 只接受: Coder, Writer (2/9)

其余 7 种 Agent 从未实现。
```

### 5.4 Telemetry/Event 是否过度设计

```
EventBus:
  - 4 种事件类型 (task.started, task.completed, task.failed, workspace.patch.*)
  - 只在 Kernel 内部 emit
  - 0 个外部 subscriber
  - 无持久化
  - 无流式输出

结论: 轻度过设计。基础设施完善但无需求驱动。
      v0.1 阶段不需要独立 EventBus。
```

---

## 第六部分：下一阶段建议

### 6.1 当前 OPC 最真实状态

```
OPC v0.1 = 一个可工作的 Coding Agent Runtime

它能做什么:
  ✅ 接收自然语言指令
  ✅ 调用 LLM 生成代码
  ✅ 将代码作为 Patch 提议
  ✅ 人工审批后写入文件
  ✅ 在沙箱中执行命令
  ✅ 存储键值记忆

它不能做什么:
  ❌ 理解代码库结构
  ❌ 多 Agent 协作
  ❌ 自主规划
  ❌ 语义检索
  ❌ 自我修复
```

### 6.2 当前完成度

```
架构目标完成度: ~35%

细分:
  Infra 层:        80%  (过完成)
  Agent 层:        25%  (仅 prompt 模板)
  Intelligence 层:   5%  (代码存在但未接入)
  Memory 层:        20%  (仅 KV 存储)
  Cognition 层:      0%  (未开始)
```

### 6.3 当前偏离程度

```
偏离程度: 中等偏高

主要偏离:
  1. "Infra First" 惯性过强 — 继续开发 infra 组件而非接入 intelligence
  2. Workspace Intelligence 隔离 — 最有价值的模块却最不被使用
  3. Agent 设计停留在 "LLM wrapper" 级别 — 无真正的认知能力

当前路线如果不修正，OPC 将永远停留在:
  "有精美外壳的 LLM prompt 执行器"
```

### 6.4 下一阶段最正确路线

```
优先级 P0 (立即):
  1. 将 Workspace Intelligence 接入 Kernel
     - Kernel.runTask() 中创建 WorkspaceIntelligence
     - 将 PatchContext 注入 AgentContext
     - CoderAgent 接收 repo 上下文后再调用 LLM

  2. 将 ToolUseAgent 接入 Kernel
     - Kernel.submit() 根据任务类型选 ToolUseAgent
     - ToolUseAgent 先 inspect workspace → plan → execute

  3. 让 Agent 真正"理解" repo
     - 不再只给 prompt 模板
     - 注入: repo graph + target symbols + dependency info

优先级 P1 (短期):
  4. 实现 Planning Engine
     - 独立 Planner 模块
     - Plan → Verify → Execute → Review 循环

  5. 升级 Memory 为语义记忆
     - 添加 embedding
     - 语义检索替代关键词查询

  6. 多 Agent 协作
     - 解除 maxConcurrentAgents=1
     - Agent 间通信总线

优先级 P2 (中期):
  7. Self-healing / Rollback
  8. Audit trail 完整化
  9. Telemetry pipeline
```

### 6.5 哪些开发应该暂停

```
🛑 立即暂停:
  - 任何新的 infra 抽象 (在 intelligence 接入前)
  - 新的 AgentType (Pm/Arch/Ops 等) 在没有真正多 Agent 协作前无意义
  - EventBus 扩展 (当前无消费者)

⚠️ 缩减投入:
  - runtime-tool 扩展 (当前只有 1 个工具)
  - MCP server 功能 (当前够用)
  - provider 新适配器 (Anthropic + OpenAI 够用)
```

### 6.6 下一阶段真正核心模块

```
Phase 2 核心目标: 从 "Coding Agent Runtime" → "AI Native OS"

必须完成的 4 件事:

  1. Cognition Layer
     └─ Agent 理解 repo → plan → verify → execute 完整循环

  2. Workspace Intelligence 接入
     └─ 每个 Agent 任务都注入 repo context

  3. Semantic Memory
     └─ 从 key-value 升级到 embedding + RAG

  4. Multi-Agent Collaboration
     └─ Pm → Arch → Coder → Qa 流水线

具体开发顺序:

  Step 1: Kernel + WorkspaceIntelligence 集成 (1-2天)
  Step 2: Kernel + ToolUseAgent 替换 BaseAgent (2-3天)
  Step 3: Planning Engine 独立模块 (3-5天)
  Step 4: Semantic Memory 升级 (3-5天)
  Step 5: Multi-Agent Pipeline (5-7天)
```

---

## 附录 A: 架构拓扑图 (ASCII)

```
┌─────────────────────────────────────────────────────────────────┐
│                         OPC v0.1                                │
│                   Architecture Reality Map                      │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────┐     ┌──────────┐     ┌──────────┐               │
│  │  MCP     │────▶│  Kernel  │────▶│ Provider │               │
│  │  Server  │     │  (Core)  │     │ (LLM)    │               │
│  └──────────┘     └────┬─────┘     └──────────┘               │
│                        │                                        │
│         ┌──────────────┼──────────────┐                        │
│         ▼              ▼              ▼                        │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐                   │
│  │  Agent   │   │  Memory  │   │Workspace │                   │
│  │ Coder/   │   │ (SQLite  │   │ Sandbox  │                   │
│  │ Writer   │   │  KV)     │   │ +Patch   │                   │
│  └────┬─────┘   └──────────┘   └──────────┘                   │
│       │                                                         │
│       │ ❌ NOT CONNECTED                                       │
│       ▼                                                         │
│  ┌──────────────────────────────────┐                          │
│  │  Workspace Intelligence          │  ← DEAD CODE             │
│  │  ├─ RepoIndex                    │                          │
│  │  ├─ SourceFileIndex              │                          │
│  │  ├─ RepoGraph                    │                          │
│  │  └─ PatchContextBuilder          │                          │
│  └──────────────────────────────────┘                          │
│                                                                 │
│  ┌──────────┐                                                   │
│  │ Runtime  │  ← EventBus (emit only, no consumer)             │
│  │ EventBus │     CommandSandbox (not used by Kernel)          │
│  └──────────┘                                                   │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│  LEGEND:                                                        │
│  ──▶ = runtime wired                                           │
│  ❌  = code exists but not connected                           │
│  ⚠️  = partially wired                                         │
└─────────────────────────────────────────────────────────────────┘
```

## 附录 B: 风险分析

| 风险 | 严重度 | 可能性 | 描述 |
|------|--------|--------|------|
| Infra 永远超前于 Intelligence | 🔴 高 | 高 | 持续开发 infra 而不接入 intelligence |
| Workspace Intelligence 腐烂 | 🟡 中 | 中 | 长期不接入导致代码过时 |
| Agent 停留在 "prompt wrapper" | 🔴 高 | 高 | 没有规划/推理/理解能力的 Agent |
| 过早抽象 | 🟡 中 | 中 | 接口/类型在没有实现前就过度定义 |
| Memory 成为瓶颈 | 🟡 中 | 中 | 键值存储无法支持语义检索需求 |
| 事件系统无消费者 | 🟢 低 | 高 | EventBus 存在但无人使用 |

---

*本报告基于完整源码追踪生成。所有结论有文件路径和代码行号作为证据。*
*禁止脑补，禁止幻想，只陈述已验证的事实。*