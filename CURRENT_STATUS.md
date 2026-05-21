# Current Status

## Release State

OPC is in **v0.1 Foundation Stable**.

The foundation is stable enough to freeze as a baseline. Active feature development and sandbox validation are paused until the external MCP client attachment blocker is resolved.

## Completed

- Kernel task lifecycle basics are implemented.
- Runtime service and event flow are implemented.
- EventBus smoke coverage is present.
- Approval gate is implemented with `WAITING_APPROVAL` as the handoff point before patch application.
- Verification pipeline is implemented and covered by smoke validation.
- Constitution layer is implemented and covered by smoke validation.
- MCP server exposes the expected tool registry.
- MCP production stdio entrypoint exists at `packages/mcp-server/dist/main.js`.
- MCP production smoke verifies `initialize` and `tools/list`.
- Documentation now marks direct file I/O fallback as forbidden.

## Partially Completed

- Workspace tools exist and are available through the MCP server.
- Runtime tools exist and are available through the MCP server.
- Agent execution paths exist, but v0.1 is treated as a foundation baseline rather than a finished product workflow.
- `workspace-intelligence` has package structure, build output, and smoke coverage, but its capabilities are not yet fully integrated into the main OPC workflow.

## Not Yet Connected

- External Claude/Cline/Codex MCP client attachment is not stable.
- Sandbox validation is not resumed.
- A reliable external client call to `opc.list_tasks` has not been confirmed after the production MCP entrypoint work.
- Local CLI flow is not yet the primary validated path.
- Workspace intelligence is not yet fully integrated into approval and execution flows.

## Current Freeze

OPC v0.1 remains frozen as a foundation-stable baseline.

The project should not continue feature development, sandbox validation, or fallback editing until the MCP client attachment path is reliable.

## Non-Negotiable Rule

Direct file I/O fallback is forbidden. If `hermes` MCP is not connected, the agent must stop.
