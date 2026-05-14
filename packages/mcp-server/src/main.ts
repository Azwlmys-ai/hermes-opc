// =============================================================================
// main.ts — MCP server entry point.
//
// Usage:
//   node dist/main.js
//
// Environment variables required (via .env or shell):
//   ANTHROPIC_API_KEY    API key for the default Anthropic provider
//   HERMES_ROOT          Absolute path to this repo (falls back to process.cwd())
//   HERMES_DEFAULT_WORKSPACE  Default workspace slug (optional)
//
// Claude Code .claude/settings.json MCP config example:
//   {
//     "mcpServers": {
//       "hermes": {
//         "command": "node",
//         "args": ["/path/to/opc/packages/mcp-server/dist/main.js"]
//       }
//     }
//   }
// =============================================================================

import { createKernel } from "@hermes/core"
import { McpServer }    from "./server.js"

function main(): void {
  let kernel
  try {
    kernel = createKernel()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[hermes-mcp] Failed to initialise kernel: ${msg}\n`)
    process.exit(1)
  }

  const server = new McpServer(kernel)
  server.start()
}

main()
