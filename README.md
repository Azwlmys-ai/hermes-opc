# OPC

OPC is an AI-native runtime foundation for controlled agent execution. It is not a business application yet; it is the base layer for submitting agent tasks, holding proposed work at an approval gate, verifying changes, applying constitutional safety rules, and exposing the system through an MCP server.

## Current Stage

OPC is currently at **v0.1 Foundation Stable**.

The core foundation has passed local smoke coverage for the runtime, kernel, event flow, approval path, verification layer, constitution layer, and MCP server protocol surface. The project is intentionally frozen at the foundation layer until external MCP client attachment is stable.

## Implemented Capabilities

- **Kernel**: accepts tasks, tracks task state, routes agent execution, and exposes task detail for approval workflows.
- **Runtime**: provides guarded execution services and command/tool boundaries used by the system.
- **EventBus**: supports runtime event flow used by kernel and execution paths.
- **Approval Gate**: holds generated work in `WAITING_APPROVAL` before patch application.
- **Verification Pipeline**: checks proposed changes before approval can apply them.
- **Constitution Layer**: applies policy rules around scope, safety, and allowed file changes.
- **MCP Server**: exposes `opc.*`, `workspace.*`, and `runtime.*` tools over stdio JSON-RPC, with a production `node` entrypoint.

## Current Blocker

The current blocker is **external MCP client attachment instability**.

The MCP server itself has passed smoke tests, including the production stdio entrypoint. However, mounting the server from external clients such as Claude, Cline, or Codex remains client-dependent and has not been proven stable enough to resume sandbox validation.

## Hard Rule

Direct file I/O fallback is forbidden.

If the MCP server is not connected, agents must stop instead of editing project or sandbox files directly. Direct file writes bypass the approval gate, verification pipeline, constitution checks, and sandbox boundaries.

## Recommended MCP Production Configuration

```json
{
  "mcpServers": {
    "hermes": {
      "command": "node",
      "args": ["packages/mcp-server/dist/main.js"],
      "cwd": "/Users/libo/opc"
    }
  }
}
```

Before using this configuration, build the project:

```bash
pnpm build
```

## Validation

The foundation validation target for this release is:

```bash
pnpm typecheck
pnpm build
pnpm smoke:mcp-server
pnpm smoke:mcp-prod-server
```

Sandbox validation is paused until an external MCP client can reliably attach to `hermes` and call `opc.list_tasks`.
