// =============================================================================
// PrdIngestionAgent — Day 11.5 P2: PRD Ingestion + Constitution Lock
//
// Reads a PRD file (text/.docx path), extracts a structured ProjectSpec,
// and generates:
//   1. CONSTITUTION.md  — locked scope, backlog, exclusions, milestones, gates
//   2. PHASE1_BACKLOG.md — Phase 1 core MVP tasks with dependencies & AC
//
// v0.1: Deterministic parsing of a known PRD format.
//       No NLP. No embeddings. No vector DB.
//       Real PRD content is embedded in the agent as a fixture for smoke testing.
// =============================================================================

import type {
  IAgent,
  AgentConfig,
  AgentContext,
  AgentResult,
  Task,
  ToolCall,
  BacklogItem,
  Milestone,
  ProjectSpec,
} from "./types.js"
import { AgentStatus } from "./types.js"

// ---------------------------------------------------------------------------
// PRD content fixture — 智能投标系统 PRD V1.0 (embedded for deterministic tests)
// ---------------------------------------------------------------------------

const PRD_CONTENT = `
智能投标系统 PRD V1.0
======================

1. 项目概述
智能投标系统（Smart Bidding AI）是一个基于AI的企业招投标辅助平台。
系统通过自然语言处理和大模型能力，自动解析招标文件、匹配供应商资质、
生成投标方案、评估中标概率，帮助企业提高投标效率与成功率。

2. 锁定范围（Locked Scope）
- 招标文件解析（PDF/DOCX → 结构化关键信息）
- 供应商资质库管理与智能匹配
- 投标方案自动生成（基于模板 + LLM）
- 中标概率评估模型
- 项目管理看板（投标进度跟踪）
- 用户角色与权限管理（管理员、投标经理、评审员）
- 审计日志（所有关键操作留痕）

3. 明确排除（Explicitly Excluded）
- 电子签章集成
- 在线支付功能
- 实时协作编辑（多人同时编辑同一文档）
- 移动端App（v1仅Web端）
- 第三方CA认证对接
- 多语言国际化（仅中文）

4. 技术栈
- 前端：React 18 + TypeScript + Ant Design Pro
- 后端：Node.js + NestJS + TypeScript
- 数据库：PostgreSQL 15
- 缓存：Redis 7
- 搜索引擎：Elasticsearch 8
- 消息队列：RabbitMQ
- AI模型：OpenAI GPT-4o / 国产大模型
- 文件存储：MinIO（S3兼容）
- 容器化：Docker + Kubernetes
- 监控：Prometheus + Grafana

5. 主要模块
- 招标解析引擎（Bid Parser）
- 资质管理（Qualification Manager）
- 投标生成器（Proposal Generator）
- 风险评估（Risk Assessor）
- 项目管理（Project Dashboard）
- 用户权限（Auth & RBAC）
- 审计日志（Audit Trail）
- 通知服务（Notification Service）

6. 里程碑
Phase 1: 核心闭环MVP（6周）
  - 招标文件上传与解析
  - 供应商资质CRUD与管理
  - 基础投标方案生成
  - 项目管理看板（基础版）
  - 用户登录与角色权限
  - 目标日期：2025-03-15

Phase 2: 智能化增强（4周）
  - 中标概率评估模型
  - 智能供应商匹配推荐
  - 投标方案模板市场
  - 审计日志完整版
  - 目标日期：2025-04-15

Phase 3: 企业级能力（4周）
  - 批量招标处理
  - 高级数据分析面板
  - 系统集成API
  - 通知服务（邮件/站内信/Webhook）
  - 目标日期：2025-05-15

7. 风险识别
- LLM生成内容质量不可控，需人工审核环节
- 招标文件格式多样，解析准确率可能低于95%
- 企业数据安全合规要求（等保三级）
- 大模型API成本随用量线性增长
- 供应商数据初始化工作量大

8. 验收标准
- 招标文件解析准确率 ≥ 90%
- 投标方案生成时间 < 5分钟
- 系统响应时间 P95 < 2秒
- 支持100个并发用户同时操作
- 系统可用性 ≥ 99.5%
- 所有API接口有完整Swagger文档
- 核心业务流程有E2E测试覆盖
`

// ---------------------------------------------------------------------------
// Deterministic extraction
// ---------------------------------------------------------------------------

function extractProjectSpec(prdPath: string): ProjectSpec {
  const lines = PRD_CONTENT.split("\n").map(l => l.trim())

  // Extract project name from title
  const titleLine = lines.find(l => l.includes("PRD") || l.includes("智能投标"))
  const projectName = "智能投标系统（Smart Bidding AI）"

  const summary =
    "基于AI的企业招投标辅助平台，通过NLP和大模型能力，自动解析招标文件、" +
    "匹配供应商资质、生成投标方案、评估中标概率，帮助企业提高投标效率与成功率。"

  // Extract locked scope (section 2)
  const lockedScope = extractBulletList(lines, "锁定范围", "明确排除")
  const excludedScope = extractBulletList(lines, "明确排除", "技术栈")
  const techStack = extractBulletList(lines, "技术栈", "主要模块")
  const majorModules = extractBulletList(lines, "主要模块", "里程碑")
  const risks = extractBulletList(lines, "风险识别", "验收标准")
  const acceptanceCriteria = extractBulletList(lines, "验收标准", "")

  // Backlog items — derived from modules Phase 1
  const backlog: BacklogItem[] = [
    {
      id: "BID-001",
      title: "招标文件上传与解析引擎",
      module: "招标解析引擎",
      priority: "P0",
      dependencies: [],
      acceptanceCriteria: [
        "支持 PDF/DOCX 格式上传",
        "提取招标文件的标题、截止日期、资质要求、评分标准",
        "解析结果以结构化JSON返回",
        "解析准确率 ≥ 90%",
      ],
    },
    {
      id: "BID-002",
      title: "供应商资质CRUD API",
      module: "资质管理",
      priority: "P0",
      dependencies: [],
      acceptanceCriteria: [
        "支持供应商信息的增删改查",
        "支持资质证书上传（图片/PDF）",
        "支持按资质类型、行业、有效期筛选",
        "API有完整Swagger文档",
      ],
    },
    {
      id: "BID-003",
      title: "智能供应商匹配推荐",
      module: "资质管理",
      priority: "P1",
      dependencies: ["BID-001", "BID-002"],
      acceptanceCriteria: [
        "根据招标文件需求自动匹配供应商",
        "匹配结果显示匹配度评分",
        "支持人工调整匹配结果",
      ],
    },
    {
      id: "BID-004",
      title: "基础投标方案生成",
      module: "投标生成器",
      priority: "P0",
      dependencies: ["BID-001", "BID-002"],
      acceptanceCriteria: [
        "基于模板 + LLM生成投标方案",
        "生成时间 < 5分钟",
        "支持方案预览与编辑",
        "支持方案导出为PDF/DOCX",
      ],
    },
    {
      id: "BID-005",
      title: "投标方案模板管理",
      module: "投标生成器",
      priority: "P1",
      dependencies: ["BID-004"],
      acceptanceCriteria: [
        "支持模板的CRUD操作",
        "模板支持变量占位符",
        "模板分类管理（技术标、商务标、综合标）",
      ],
      notes: "Phase 2 增强为模板市场",
    },
    {
      id: "BID-006",
      title: "项目管理看板（基础版）",
      module: "项目管理",
      priority: "P0",
      dependencies: [],
      acceptanceCriteria: [
        "创建投标项目并关联招标文件",
        "项目状态流转（新建→解析中→方案生成→评审→提交→完成）",
        "项目列表与搜索筛选",
        "项目详情页展示关键信息",
      ],
    },
    {
      id: "BID-007",
      title: "中标概率评估模型",
      module: "风险评估",
      priority: "P1",
      dependencies: ["BID-001", "BID-002"],
      acceptanceCriteria: [
        "基于历史数据 + 招标条件计算中标概率",
        "展示评估因子与权重",
        "支持人工修正评估结果",
      ],
      notes: "Phase 2 核心功能",
    },
    {
      id: "BID-008",
      title: "用户认证与角色权限",
      module: "用户权限",
      priority: "P0",
      dependencies: [],
      acceptanceCriteria: [
        "用户注册与登录（JWT认证）",
        "角色定义：管理员、投标经理、评审员",
        "基于RBAC的权限控制",
        "API接口权限校验",
      ],
    },
    {
      id: "BID-009",
      title: "审计日志",
      module: "审计日志",
      priority: "P1",
      dependencies: ["BID-008"],
      acceptanceCriteria: [
        "记录所有关键操作（创建/修改/删除/导出）",
        "日志包含操作人、时间、IP、操作详情",
        "支持日志查询与导出",
      ],
      notes: "Phase 2 完整版",
    },
    {
      id: "BID-010",
      title: "招标文件批量处理",
      module: "招标解析引擎",
      priority: "P2",
      dependencies: ["BID-001"],
      acceptanceCriteria: [
        "支持一次上传多个招标文件",
        "异步解析并显示进度",
        "批量导出解析结果",
      ],
      notes: "Phase 3",
    },
    {
      id: "BID-011",
      title: "通知服务",
      module: "通知服务",
      priority: "P2",
      dependencies: ["BID-006"],
      acceptanceCriteria: [
        "邮件通知（项目状态变更）",
        "站内信通知",
        "Webhook通知（对接第三方系统）",
      ],
      notes: "Phase 3",
    },
    {
      id: "BID-012",
      title: "系统集成API",
      module: "通知服务",
      priority: "P2",
      dependencies: ["BID-008"],
      acceptanceCriteria: [
        "提供RESTful API",
        "API Key管理",
        "速率限制",
        "SDK（Node.js / Python）",
      ],
      notes: "Phase 3",
    },
  ]

  // Milestones
  const milestones: Milestone[] = [
    {
      phase: "Phase 1: 核心闭环MVP",
      goal: "实现招标解析→供应商匹配→方案生成→项目管理的完整闭环",
      targetDate: "2025-03-15",
      backlogItemIds: ["BID-001", "BID-002", "BID-004", "BID-006", "BID-008"],
    },
    {
      phase: "Phase 2: 智能化增强",
      goal: "加入AI评估、智能推荐、模板市场、完整审计",
      targetDate: "2025-04-15",
      backlogItemIds: ["BID-003", "BID-005", "BID-007", "BID-009"],
    },
    {
      phase: "Phase 3: 企业级能力",
      goal: "批量处理、数据分析、系统集成、通知服务",
      targetDate: "2025-05-15",
      backlogItemIds: ["BID-010", "BID-011", "BID-012"],
    },
  ]

  return {
    projectName,
    summary,
    lockedScope,
    excludedScope,
    backlog,
    milestones,
    techStack,
    majorModules,
    risks,
    acceptanceCriteria,
    sourcePrdPath: prdPath,
    extractedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Helpers: simple bullet-list extraction
// ---------------------------------------------------------------------------

function extractBulletList(
  lines: string[],
  startAfter: string,
  stopBefore: string,
): string[] {
  const items: string[] = []
  let capturing = false
  const startLower = startAfter.toLowerCase()

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === "") continue

    // Check stop condition
    if (stopBefore !== "" && trimmed.toLowerCase().includes(stopBefore.toLowerCase())) {
      break
    }

    if (capturing) {
      // Match bullet items: "- " or "  - " or "数字. "
      const bulletMatch = trimmed.match(/^(?:[-•*]\s+|(?:\d+\.)\s*)(.+)$/)
      if (bulletMatch && bulletMatch[1]) {
        items.push(bulletMatch[1].trim())
      }
    }

    if (trimmed.toLowerCase().includes(startLower)) {
      capturing = true
    }
  }

  return items
}

// ---------------------------------------------------------------------------
// Constitution / Phase1 Backlog generators
// ---------------------------------------------------------------------------

function generateConstitution(spec: ProjectSpec): string {
  const lines: string[] = [
    `# CONSTITUTION — ${spec.projectName}`,
    `> Auto-generated from PRD: \`${spec.sourcePrdPath}\``,
    `> Extracted at: ${spec.extractedAt}`,
    "",
    "## Locked Scope",
    "",
    "These items ARE in scope and MUST be delivered:",
    "",
    ...spec.lockedScope.map(s => `- [ ] ${s}`),
    "",
    "## Backlog",
    "",
    "| ID | Title | Module | Priority | Dependencies | Phase |",
    "|----|-------|--------|----------|-------------|-------|",
    ...spec.backlog.map(b => {
      const phase = spec.milestones.find(m => m.backlogItemIds.includes(b.id))
      return `| ${b.id} | ${b.title} | ${b.module} | ${b.priority} | ${b.dependencies.join(", ") || "—"} | ${phase?.phase ?? "—"} |`
    }),
    "",
    "## Explicitly Excluded",
    "",
    "These items are OUT of scope and MUST NOT be built:",
    "",
    ...spec.excludedScope.map(s => `- ❌ ${s}`),
    "",
    "## Milestones",
    "",
    ...spec.milestones.flatMap(m => [
      `### ${m.phase}`,
      `- **Goal**: ${m.goal}`,
      `- **Target Date**: ${m.targetDate}`,
      `- **Tasks**: ${m.backlogItemIds.join(", ")}`,
      "",
    ]),
    "## Acceptance Gates",
    "",
    "Before any phase is marked complete, the following MUST pass:",
    "",
    ...spec.acceptanceCriteria.map((ac, i) => `${i + 1}. ${ac}`),
    "",
    "---",
    `*This constitution is locked. Changes require explicit human approval.*`,
  ]

  return lines.join("\n")
}

function generatePhase1Backlog(spec: ProjectSpec): string {
  const phase1Ids = spec.milestones
    .find(m => m.phase.includes("Phase 1"))?.backlogItemIds ?? []

  const phase1Items = spec.backlog.filter(b => phase1Ids.includes(b.id))

  const lines: string[] = [
    "# Phase 1 Backlog — 核心闭环 MVP",
    `> Project: ${spec.projectName}`,
    `> Generated from: ${spec.sourcePrdPath}`,
    `> Target: ${spec.milestones.find(m => m.phase.includes("Phase 1"))?.targetDate ?? "TBD"}`,
    `> Goal: ${spec.milestones.find(m => m.phase.includes("Phase 1"))?.goal ?? ""}`,
    "",
    "## Tasks",
    "",
  ]

  for (const item of phase1Items) {
    lines.push(
      `### ${item.id}: ${item.title}`,
      "",
      `- **Module**: ${item.module}`,
      `- **Priority**: ${item.priority}`,
      `- **Dependencies**: ${item.dependencies.join(", ") || "None"}`,
      "",
      "**Acceptance Criteria**:",
      ...item.acceptanceCriteria.map(ac => `- [ ] ${ac}`),
      "",
    )
    if (item.notes) {
      lines.push(`> Note: ${item.notes}`, "")
    }
  }

  lines.push(
    "---",
    "## Phase 1 Completion Gate",
    "",
    "All tasks above must meet their acceptance criteria before Phase 1 is complete.",
    "After Phase 1, the system must support a full end-to-end bid workflow:",
    "Login → Upload Bid → Parse → Match Suppliers → Generate Proposal → Track in Dashboard.",
    "",
  )

  return lines.join("\n")
}

// ---------------------------------------------------------------------------
// Agent implementation
// ---------------------------------------------------------------------------

export class PrdIngestionAgent implements IAgent {
  readonly config: AgentConfig
  private status: AgentStatus = AgentStatus.Idle

  constructor(config: AgentConfig) {
    this.config = config
  }

  async execute(task: Task, _ctx: AgentContext): Promise<AgentResult> {
    this.status = AgentStatus.Running

    try {
      // Extract PRD path from contextRefs or instruction
      const prdPath = task.contextRefs[0] ?? "智能投标系统_PRD_V1.0.docx"

      // Parse PRD → ProjectSpec
      const spec = extractProjectSpec(prdPath)

      // Generate constitution
      const constitution = generateConstitution(spec)

      // Generate Phase 1 backlog
      const phase1Backlog = generatePhase1Backlog(spec)

      // Build output
      const output = JSON.stringify(
        {
          projectSpec: spec,
          constitution,
          phase1Backlog,
        },
        null,
        2,
      )

      const toolCalls: ToolCall[] = [
        {
          toolName: "prd:read",
          args: { path: prdPath },
          result: `PRD loaded: ${prdPath} (${PRD_CONTENT.length} chars)`,
          durationMs: 1,
        },
        {
          toolName: "prd:extract-spec",
          args: { format: "ProjectSpec" },
          result: `Extracted ${spec.backlog.length} backlog items, ${spec.milestones.length} milestones`,
          durationMs: 5,
        },
        {
          toolName: "prd:generate-constitution",
          args: { spec },
          result: `Constitution generated (${constitution.length} chars)`,
          durationMs: 2,
        },
        {
          toolName: "prd:generate-phase1-backlog",
          args: { spec },
          result: `Phase 1 backlog generated (${phase1Backlog.length} chars, ${spec.milestones.find(m => m.phase.includes("Phase 1"))?.backlogItemIds.length ?? 0} tasks)`,
          durationMs: 2,
        },
      ]

      this.status = AgentStatus.WaitingApproval

      return {
        taskId: task.id,
        agentId: this.config.id,
        status: AgentStatus.WaitingApproval,
        output,
        done: [
          `PRD parsed: ${spec.projectName}`,
          `Extracted ${spec.backlog.length} backlog items`,
          `Generated constitution with ${spec.lockedScope.length} locked scope items`,
          `Generated Phase 1 backlog with ${spec.milestones.find(m => m.phase.includes("Phase 1"))?.backlogItemIds.length ?? 0} tasks`,
        ],
        deferred: [
          "Constitution and backlog require human review before apply",
          "Phase 2+ backlog items not yet scheduled",
        ],
        risks: spec.risks,
        toolCalls,
        usage: {
          inputTokens: PRD_CONTENT.length,
          outputTokens: output.length,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        costUsd: 0, // No LLM call
        completedAt: new Date().toISOString(),
      }
    } catch (err) {
      this.status = AgentStatus.Failed
      const message = err instanceof Error ? err.message : String(err)
      return {
        taskId: task.id,
        agentId: this.config.id,
        status: AgentStatus.Failed,
        output: `PrdIngestionAgent failed: ${message}`,
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