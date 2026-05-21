# MCP Limitations

## What Is Stable

The Hermes MCP server has passed local smoke validation.

Validated locally:

- tool registry smoke
- `opc.*` tool availability
- production build output
- production stdio entrypoint at `packages/mcp-server/dist/main.js`
- JSON-RPC `initialize`
- JSON-RPC `tools/list`
- diagnostics written to stderr instead of stdout

Recommended production command:

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

## What Remains Unstable

External MCP client attachment is still client-dependent.

Claude, Cline, and Codex each have their own MCP configuration loading, reload behavior, and session lifecycle. The server can be correct while a client still fails to mount it or expose its tools.

The current blocker is not the local MCP server smoke path. The blocker is reliable external client attachment and a confirmed external call to:

```text
opc.list_tasks
```

## Operational Rule

Direct file I/O fallback is forbidden.

If an external client cannot attach to `hermes`, the correct behavior is to stop. The agent must not edit OPC or sandbox files directly as a substitute for an MCP tool call.

## Current Release Decision

OPC v0.1 should remain in foundation-stable freeze until external MCP client attachment is reliable.

Sandbox validation should resume only after an external MCP client can mount `hermes` and successfully call `opc.list_tasks`.
