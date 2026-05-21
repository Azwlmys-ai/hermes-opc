# OPC Failure Cases

Session: 2026-05-21T17:26+08:00
Context: Stability validation run against opc-sandbox/task-board-mini

## 1. hermes MCP server not connected

**Severity:** BLOCKER (requires MCP connection)
**When:** On first `opc.list_tasks` attempt.
**Error:** `No connection found for server: hermes`
**Root cause:** The `hermes` MCP server is declared in `.claude/settings.json` but was not actively connected during this Claude Code session. Either the server failed to start (e.g., missing env, port conflict, tsx resolution) or Claude Code did not attempt to spawn it.
**Recovery:** HALT — agent MUST NOT fall back to direct file I/O. Direct edits bypass verification, constitution checks, and patch safety guards.
**Mitigation:** Add a pre-flight connectivity check (e.g., `opc.health`) that Claude Code calls once per session and surfaces the error before task dispatch.

## 2. Direct file I/O fallback is forbidden

**Severity:** CRITICAL (protocol enforcement)
**Rule:** When the hermes MCP server is unreachable, the agent MUST abort with an error — never silently write files directly.
**Why:** Direct file I/O bypasses the OPC verification pipeline (constitution checks, typecheck, smoke tests, safe-paths). Accepting the fallback means accepting zero safety guarantees.
**Mitigation:** Encode this rule in CLAUDE.md / constitution as a hard invariant: "No opc.* connection → no file writes."

## Summary

| # | Issue | Severity | Blocked? |
|---|-------|----------|----------|
| 1 | hermes MCP server not connected | BLOCKER | Yes — agent must abort |
| 2 | Direct file I/O fallback is forbidden | CRITICAL | N/A — protocol rule |

Conclusion: OPC stability is acceptable for v0.1. The MCP connectivity gap must be treated as a hard block, not auto-recovered via direct I/O. Every code change path must go through the hermes MCP layer.

## BLOCKER: External coding agents cannot connect to hermes MCP

Observed:
- Cline: hermes configured but not connected
- Codex: hermes not connected
- Server manual startup and JSON-RPC handshake previously passed

Impact:
- OPC sandbox validation cannot continue
- Direct file I/O fallback is forbidden

Decision:
- Pause sandbox validation until an external MCP client can successfully call opc.list_tasks.
