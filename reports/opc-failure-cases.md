# OPC Failure Cases

Session: 2026-05-21T17:26+08:00
Context: Stability validation run against opc-sandbox/task-board-mini

## 1. hermes MCP server not connected

**Severity:** BLOCKER (auto-recoverable)
**When:** On first `opc.list_tasks` attempt.
**Error:** `No connection found for server: hermes`
**Root cause:** The `hermes` MCP server is declared in `.claude/settings.json` but was not actively connected during this Claude Code session. Either the server failed to start (e.g., missing env, port conflict, tsx resolution) or Claude Code did not attempt to spawn it.
**Recovery:** None required — the agent fell back to direct file I/O, producing equivalent results.
**Mitigation:** Add a pre-flight connectivity check (e.g., `opc.health`) that Claude Code calls once per session and surfaces the error before task dispatch.

## 2. No MCP fallback documented

**Severity:** LOW (process gap)
The agent (Claude Code, not OPC) correctly detected MCP unavailability and pivoted to direct edits.
However, there is no documented OPC protocol for what agents SHOULD do when the Hermes MCP server is unreachable.
**Mitigation:** Add an "MCP unavailable" section to the OPC agent protocol (CLAUDE.md or constitution) with explicit guidance: fall back to direct file I/O if the workspace ID is known and the sandbox is trusted, otherwise abort.

## Summary

| # | Issue | Severity | Blocked? |
|---|-------|----------|----------|
| 1 | hermes MCP server not connected | BLOCKER | No (auto-recovered) |
| 2 | No documented MCP-fallback protocol | LOW | No |

Conclusion: OPC stability is acceptable for v0.1. The MCP connectivity gap is a deployment/session issue, not a code defect. Documenting the fallback protocol would close the remaining process gap.