# OPC MCP Approval Workflow — Day 16 Milestone

The Hermes OPC system's Claude Code MCP integration is fully operational as of Day 16.

## What Was Built

The OPC (One-Person Company) operating system exposes its kernel operations as MCP tools
that Claude Code (and any MCP client) can call directly.

## Full Approval Workflow

```
opc.submit_task(instruction, workspace, agentType)
  → task.created  [PENDING]
  → task.started  [RUNNING]
  → agent runs (ToolUseCoderAgent / WriterAgent / PrdIngestionAgent)
  → task.approval.waiting  [WAITING_APPROVAL]

opc.get_task_detail(taskId)
  → status, patchProposal, verification (once approved), rejectReason

opc.approve_task(taskId)
  → Verification Pipeline:
      A. patch.safe-paths   — path traversal, lock file guard
      B. constitution.check — 10 security rules (CONST-001..CONST-010)
      C. typecheck          — pnpm typecheck across all packages
      D. smoke:runtime      — RuntimeService regression check
      E. smoke:events       — EventBus regression check
  → PASSED: workspace.patch.applied → task.approved  [DONE]
  → FAILED: task.verification.failed → task.failed   [FAILED]

opc.reject_task(taskId, reason)
  → task.rejected  [FAILED]  — no files written, reason stored
```

## Constitution Security Rules (10 active)

| Rule | Severity | Description |
|------|----------|-------------|
| CONST-001 | violation | `.env` files forbidden |
| CONST-002 | violation | Credential/key files forbidden |
| CONST-003 | violation | `node_modules/**` forbidden |
| CONST-004 | violation | `.git/**` forbidden |
| CONST-005 | violation | Absolute paths forbidden (cross-workspace) |
| CONST-006 | violation | Scaffold files must not be emptied |
| CONST-007 | elevated_review | `package.json` / `pnpm-lock.yaml` changes |
| CONST-008 | elevated_review | `kernel.ts` changes |
| CONST-009 | elevated_review | `verification-service.ts` changes |
| CONST-010 | violation | Dangerous shell commands in content |

## MCP Tools Registry (7 opc.* + 4 workspace.* + runtime.*)

| Tool | Purpose |
|------|---------|
| `opc.submit_task` | Dispatch task to Hermes agent |
| `opc.get_task` | Raw TaskDetail |
| `opc.get_task_detail` | Structured view: status, patch, verification, rejectReason |
| `opc.list_tasks` | Task list with workspace filter |
| `opc.cancel_task` | Cancel a pending task |
| `opc.approve_task` | Run verification pipeline, apply patch |
| `opc.reject_task` | Reject without applying, record reason |

## Claude Code Configuration

Add to `.claude/settings.json`:

```json
{
  "mcpServers": {
    "hermes": {
      "command": "npx",
      "args": ["tsx", "--env-file=.env", "packages/mcp-server/src/main.ts"],
      "cwd": "/Users/libo/opc"
    }
  }
}
```

See `docs/claude-code-mcp.md` for the full configuration guide.

---

_Day 16 — End-to-end MCP approval workflow verified._
