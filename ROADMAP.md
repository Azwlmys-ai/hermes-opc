# Roadmap

This roadmap is intentionally narrow. OPC v0.1 is a foundation baseline, and the next work should strengthen integration paths rather than expand product scope.

## v0.2 Robust MCP Integration

- Make external MCP client attachment reliable across supported clients.
- Keep the production entrypoint as the recommended path:
  `node packages/mcp-server/dist/main.js`.
- Validate a real external client call to `opc.list_tasks`.
- Document client-specific setup only when it has been verified.

## Local CLI Path

- Provide a local command path for controlled task submission and inspection.
- Preserve the approval gate and verification requirements.
- Keep the CLI path aligned with MCP behavior instead of creating a separate bypass.

## Intelligence Integration

- Integrate `workspace-intelligence` into the normal execution and approval workflow.
- Use intelligence output to improve task context and patch review.
- Keep integration incremental and covered by focused smoke tests.

## Out of Scope

- Broad product expansion.
- Cloud orchestration.
- Dashboard work.
- Reconnect managers or daemon processes.
- Any direct file I/O fallback path.
