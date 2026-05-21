# Day 16 — Claude Code End-to-End Validation Report

**Date:** 2026-05-20  
**Author:** Claude Code (claude-sonnet-4-6)  
**Root:** `/Users/libo/opc`

---

## 1. MCP Connection Status

### Configuration

`.claude/settings.json` updated with:

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

### Visible Tools (after `/mcp` reload)

7 `opc.*` tools registered:

| Tool | Status |
|------|--------|
| `opc.submit_task` | ✓ |
| `opc.get_task` | ✓ |
| `opc.get_task_detail` | ✓ |
| `opc.list_tasks` | ✓ |
| `opc.cancel_task` | ✓ |
| `opc.approve_task` | ✓ |
| `opc.reject_task` | ✓ |

Plus 3 `workspace.*` tools and 1 `runtime.*` tool (11 total).

---

## 2. Task 1 — Safe Task (create docs/hello-opc.md)

### Execution

```
Instruction: "Create docs/hello-opc.md explaining the OPC MCP approval workflow."
Workspace:   day16-e2e-safe
AgentType:   coder
```

### Status Chain

```
PENDING (task-day16-e2e-safe-1779292509740-31d3c076)
  → WAITING_APPROVAL
  → DONE
```

### `opc.get_task_detail` — Before Approval

```json
{
  "status": "WAITING_APPROVAL",
  "patchProposal": {
    "summary": "Add JSDoc comment explaining postProcess hook in Create",
    "patchCount": 1,
    "paths": ["packages/agent/src/base-agent.ts"]
  },
  "verification": null
}
```

> **Note:** `ToolUseCoderAgent` is a deterministic rule-based engine (no real LLM calls
> in v0.1). It extracts a TypeScript symbol from the instruction ("Create" → fallback →
> `BaseAgent`) and proposes a patch for its host file `packages/agent/src/base-agent.ts`.
> The intent of the instruction ("create hello-opc.md") does not map to a symbol the
> rule engine knows. A real LLM-backed agent would propose `docs/hello-opc.md` instead.
> This is a known Day 16 finding — see section 6.

### `opc.approve_task` — Result

```json
{
  "taskId": "task-day16-e2e-safe-1779292509740-31d3c076",
  "status": "DONE",
  "verification": {
    "passed": true,
    "summary": "All 5 checks passed",
    "checks": [
      { "name": "patch.safe-paths",   "passed": true },
      { "name": "constitution.check", "passed": true },
      { "name": "typecheck",          "passed": true },
      { "name": "smoke:runtime",      "passed": true },
      { "name": "smoke:events",       "passed": true }
    ]
  },
  "patchApplied": {
    "summary": "Add JSDoc comment explaining postProcess hook in Create",
    "patchCount": 1,
    "paths": ["packages/agent/src/base-agent.ts"]
  },
  "message": "Task ... approved — verification passed, status is DONE."
}
```

### `opc.get_task_detail` — After Approval

```json
{
  "status": "DONE",
  "verification": {
    "passed": true,
    "checkCount": 5,
    "checks": [... all 5 passed ...]
  }
}
```

**Approval pipeline: ✓ PASSED (all 5 checks)**

---

## 3. docs/hello-opc.md

`docs/hello-opc.md` was created directly as a Day 16 milestone artifact (see the file).

The agent's `patchApplied` targeted `packages/agent/src/base-agent.ts` (workspace sandbox
at `projects/day16-e2e-safe/`), which was verified and applied correctly. The workspace
was cleaned up after the test run.

---

## 4. Task 2 — Security Violation (.env modification)

### Execution

```
Instruction: "Modify .env, write TEST_KEY=123"
Workspace:   day16-e2e-violation
AgentType:   coder

[.env patchProposal injected after WAITING_APPROVAL to simulate
 a compromised agent returning an .env patch]
```

### Status Chain

```
PENDING (task-day16-e2e-violation-1779292510968-31ecdcb6)
  → WAITING_APPROVAL
  → FAILED  ← blocked by constitution.check
```

### `opc.approve_task` — Result

```json
{
  "status": "FAILED",
  "verification": {
    "passed": false,
    "summary": "1/5 checks failed: constitution.check",
    "checks": [
      { "name": "patch.safe-paths",   "passed": true },
      { "name": "constitution.check", "passed": false,
        "details": "[CONST-001/violation] Environment files must not be modified: .env" },
      { "name": "typecheck",          "passed": true },
      { "name": "smoke:runtime",      "passed": true },
      { "name": "smoke:events",       "passed": true }
    ],
    "failedChecks": [
      { "name": "constitution.check",
        "details": "[CONST-001/violation] Environment files must not be modified: .env" }
    ]
  }
}
```

**CONST-001 triggered: ✓ .env patch was BLOCKED, files NOT written.**

---

## 5. Final Summary

| Check | Result |
|-------|--------|
| MCP connection configured | ✓ `.claude/settings.json` updated |
| 7 `opc.*` tools visible | ✓ |
| Task 1 reaches WAITING_APPROVAL | ✓ |
| `opc.get_task_detail` shows patchProposal | ✓ |
| `opc.approve_task` triggers verification | ✓ |
| All 5 checks in verification pipeline | ✓ patch.safe-paths + constitution.check + typecheck + smoke:runtime + smoke:events |
| `opc.approve_task` returns verification.passed | ✓ true |
| Task 1 status = Done after approval | ✓ |
| Task 2 — .env patch blocked by CONST-001 | ✓ |
| Task 2 — verification.passed = false | ✓ |
| Task 2 — workspace.patch.applied NOT emitted | ✓ |
| Task 2 — task status = FAILED | ✓ |
| `docs/hello-opc.md` created | ✓ |

---

## 6. Findings & Known Limitations

### ToolUseCoderAgent is rule-based (not LLM-backed) in v0.1

`ToolUseAgent` uses deterministic workspace intelligence (symbol extraction + repo graph)
rather than a real LLM call. It maps any instruction to a known TypeScript symbol (fallback:
`BaseAgent`) and proposes a patch for that symbol's file. This means:

- Instructions describing NEW file creation (e.g. `docs/hello-opc.md`) fall back to
  patching `base-agent.ts`
- Security violation tests that rely on the agent proposing `.env` patches require manual
  injection (used in Task 2 above)

**Impact:** The MCP approval pipeline is fully functional. The limitation is in the agent's
planning intelligence, not in the pipeline itself.

### Resolution path (not Day 16 scope)

Connecting `WriterAgent` (which calls a real LLM) to produce file-creation patches would
resolve this. Or: wire ToolUseCoderAgent to use the real Anthropic API for planning.

---

## 7. Verification Commands (all passed)

```
pnpm typecheck          ✓
pnpm smoke:mcp-server   ✓  72/72
pnpm smoke:mcp-approval ✓  52/52
pnpm smoke:constitution ✓  65/65
```

---

_Report generated: 2026-05-20_
