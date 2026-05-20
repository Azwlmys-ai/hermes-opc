# Hermes MCP Server — Claude Code Integration Guide

Connect Claude Code to the Hermes kernel so `opc.*` tools are available in every conversation.

---

## Prerequisites

- Node.js 22+
- pnpm 9+
- `ANTHROPIC_API_KEY` set in `.env` or the shell
- Repo cloned to `/Users/libo/opc`

---

## 1 — Build the MCP server

```bash
cd /Users/libo/opc
pnpm install
pnpm build          # builds all packages, including @hermes/mcp-server
```

Alternatively, skip the build and run via `tsx` directly (development mode):

```bash
pnpm mcp:server     # tsx --env-file=.env packages/mcp-server/src/main.ts
```

---

## 2 — Configure Claude Code

Add the server to your Claude Code MCP settings.

### Option A — Project-scoped (`.claude/settings.json`)

Stored in `/Users/libo/opc/.claude/settings.json`. Only active inside this repo.

```json
{
  "mcpServers": {
    "hermes": {
      "command": "node",
      "args": ["/Users/libo/opc/packages/mcp-server/dist/main.js"],
      "cwd": "/Users/libo/opc",
      "env": {
        "ANTHROPIC_API_KEY": "YOUR_KEY_HERE",
        "HERMES_ROOT": "/Users/libo/opc",
        "HERMES_DEFAULT_WORKSPACE": "default"
      }
    }
  }
}
```

### Option B — Development mode (tsx, no build required)

```json
{
  "mcpServers": {
    "hermes": {
      "command": "npx",
      "args": ["tsx", "--env-file=.env", "/Users/libo/opc/packages/mcp-server/src/main.ts"],
      "cwd": "/Users/libo/opc"
    }
  }
}
```

> **Note:** `ANTHROPIC_API_KEY` must be present — either in `.env` (Option B) or the `env` block (Option A). Never commit real keys.

---

## 3 — Verify the connection

After Claude Code restarts (or reloads MCP servers), confirm the tools appear:

```
/mcp
```

You should see `hermes` listed with 13+ tools including the `opc.*` namespace.

You can also ask Claude directly:

> "List the available hermes tools"

Expected response includes all 7 `opc.*` tools:

| Tool | Purpose |
|------|---------|
| `opc.submit_task` | Dispatch a task to a Hermes agent |
| `opc.get_task` | Raw TaskDetail by taskId |
| `opc.get_task_detail` | Structured detail: status, patch, verification, rejectReason |
| `opc.list_tasks` | All tasks, optionally filtered by workspace |
| `opc.cancel_task` | Cancel a pending task |
| `opc.approve_task` | Run verification pipeline, then apply patch |
| `opc.reject_task` | Reject a proposal without applying changes |

---

## 4 — Example tool calls

### List tasks

```
Use the hermes opc.list_tasks tool to show all tasks in workspace "my-project"
```

### Submit a task

```
Use opc.submit_task to ask the coder agent to "add a health-check endpoint to src/server.ts" in workspace "my-project"
```

### Inspect a task waiting for approval

```
Use opc.get_task_detail for task ID task-my-project-...
```

Expected response includes:
- `status: "WAITING_APPROVAL"`
- `patchProposal.paths`: files that will be modified
- `verification`: absent until `approve_task` is called

### Approve a task

```
Use opc.approve_task for task ID task-my-project-...
```

Expected response:
```json
{
  "taskId": "task-my-project-...",
  "status": "DONE",
  "verification": {
    "passed": true,
    "summary": "All 4 checks passed",
    "checks": [
      { "name": "patch.safe-paths", "passed": true },
      { "name": "typecheck",        "passed": true },
      { "name": "smoke:runtime",    "passed": true },
      { "name": "smoke:events",     "passed": true }
    ]
  },
  "patchApplied": {
    "summary": "...",
    "patchCount": 1,
    "paths": ["src/server.ts"]
  },
  "message": "Task task-my-project-... approved — verification passed, status is DONE."
}
```

If verification fails (typecheck error, unsafe path, smoke regression), the response will have:
```json
{
  "status": "FAILED",
  "verification": {
    "passed": false,
    "failedChecks": [{ "name": "typecheck", "details": "..." }]
  }
}
```

No files are written on failure.

### Reject a task

```
Use opc.reject_task for task ID task-my-project-... with reason "Patch modifies too many files, scope down first"
```

---

## 5 — Troubleshooting

| Symptom | Fix |
|---------|-----|
| `[hermes-mcp] Failed to initialise kernel` | Check `ANTHROPIC_API_KEY` is set and `kernel/config.yaml` exists |
| Tools list is empty | Run `pnpm build` and confirm `packages/mcp-server/dist/main.js` exists |
| `pnpm mcp:server` crashes immediately | Check `.env` has `ANTHROPIC_API_KEY=sk-ant-...` and `HERMES_ROOT=/Users/libo/opc` |
| Verification fails on every approve | Run `pnpm typecheck` manually — there may be a pre-existing type error |

---

## 6 — Smoke test (no Claude Code required)

Verify the MCP server layer without starting the full server:

```bash
pnpm smoke:mcp-server
```

This checks: tool registry (7 opc.* tools), JSON Schema shapes, and McpServer instantiation.
