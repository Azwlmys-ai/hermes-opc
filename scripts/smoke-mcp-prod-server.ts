// =============================================================================
// scripts/smoke-mcp-prod-server.ts — Day 16C: MCP prod startup smoke
//
// Validates the build output entrypoint used by external MCP clients:
//   1. @hermes/mcp-server build succeeds
//   2. packages/mcp-server/dist/main.js exists
//   3. node packages/mcp-server/dist/main.js responds to initialize
//   4. tools/list includes critical opc.* tools
//
// Run: pnpm smoke:mcp-prod-server
// =============================================================================

import { spawn }      from "node:child_process"
import { existsSync } from "node:fs"
import { join }       from "node:path"
import { setTimeout as delay } from "node:timers/promises"

type JsonRpcResponse = {
  jsonrpc: "2.0"
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

type ToolListResult = {
  tools?: Array<{ name?: string }>
}

const ROOT = process.cwd()
const MAIN_JS = join(ROOT, "packages", "mcp-server", "dist", "main.js")

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  ✓  ${label}`)
}

function fail(label: string, detail = ""): void {
  failed++
  console.error(`  ✗  ${label}${detail ? `\n       ${detail}` : ""}`)
}

function assert(condition: boolean, label: string, detail = ""): void {
  if (condition) pass(label)
  else fail(label, detail)
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
    })
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(
        `${command} ${args.join(" ")} exited ${code ?? "unknown"}\n` +
        `stdout:\n${stdout}\n\nstderr:\n${stderr}`,
      ))
    })
  })
}

async function smokeProdServer(): Promise<{
  initialize: JsonRpcResponse
  toolsList: JsonRpcResponse
  stderr: string
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [MAIN_JS], {
      cwd: ROOT,
      env: {
        ...process.env,
        HERMES_ROOT: process.env["HERMES_ROOT"] ?? ROOT,
      },
      stdio: ["pipe", "pipe", "pipe"],
    })

    let stdout = ""
    let stderr = ""
    const responses = new Map<JsonRpcResponse["id"], JsonRpcResponse>()

    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(
        "Timed out waiting for MCP prod server responses\n" +
        `stdout:\n${stdout}\n\nstderr:\n${stderr}`,
      ))
    }, 5_000)

    function finishIfReady(): void {
      const initialize = responses.get(1)
      const toolsList = responses.get(2)
      if (initialize === undefined || toolsList === undefined) return

      clearTimeout(timeout)
      child.kill()
      resolve({ initialize, toolsList, stderr })
    }

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8")
      for (;;) {
        const newline = stdout.indexOf("\n")
        if (newline === -1) break
        const line = stdout.slice(0, newline).trim()
        stdout = stdout.slice(newline + 1)
        if (line.length === 0) continue
        try {
          const parsed = JSON.parse(line) as JsonRpcResponse
          responses.set(parsed.id, parsed)
          finishIfReady()
        } catch (err) {
          clearTimeout(timeout)
          child.kill()
          reject(new Error(`Invalid JSON-RPC stdout line: ${line}\n${String(err)}`))
          return
        }
      }
    })

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8")
    })
    child.on("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    child.on("exit", (code) => {
      if (responses.has(1) && responses.has(2)) return
      clearTimeout(timeout)
      reject(new Error(
        `MCP prod server exited before smoke completed: ${code ?? "unknown"}\n` +
        `stdout:\n${stdout}\n\nstderr:\n${stderr}`,
      ))
    })

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "hermes-smoke", version: "0.1.0" },
      },
    }) + "\n")

    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    }) + "\n")
  })
}

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  Day 16C — MCP Prod Server Smoke")
  console.log("══════════════════════════════════════════════════════\n")

  try {
    await runCommand("pnpm", ["--filter", "@hermes/mcp-server", "build"])
    pass("@hermes/mcp-server build succeeds")
  } catch (err) {
    fail("@hermes/mcp-server build succeeds", err instanceof Error ? err.message : String(err))
  }

  assert(existsSync(MAIN_JS), "packages/mcp-server/dist/main.js exists")

  if (failed === 0) {
    try {
      const result = await smokeProdServer()
      await delay(10)

      assert(result.initialize.error === undefined, "initialize returns no JSON-RPC error")
      const initResult = result.initialize.result as { serverInfo?: { name?: string } } | undefined
      assert(initResult?.serverInfo?.name === "hermes-mcp", "initialize returns hermes-mcp serverInfo")

      assert(result.toolsList.error === undefined, "tools/list returns no JSON-RPC error")
      const toolsResult = result.toolsList.result as ToolListResult | undefined
      const toolNames = new Set((toolsResult?.tools ?? []).map(t => t.name))

      for (const name of ["opc.list_tasks", "opc.submit_task", "opc.approve_task"]) {
        assert(toolNames.has(name), `tools/list includes ${name}`)
      }

      assert(result.stderr.includes("[hermes-mcp] cwd="), "stderr diagnostics include cwd")
      assert(result.stderr.includes("[hermes-mcp] HERMES_ROOT="), "stderr diagnostics include HERMES_ROOT")
      assert(result.stderr.includes("[hermes-mcp] registered tool count="), "stderr diagnostics include tool count")
      assert(result.stderr.includes("[hermes-mcp] server ready"), "stderr diagnostics include server ready")
    } catch (err) {
      fail("node packages/mcp-server/dist/main.js responds to MCP initialize/tools/list",
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  console.log("\n══════════════════════════════════════════════════════")
  console.log(`  Smoke complete: ${passed} passed, ${failed} failed`)
  console.log("══════════════════════════════════════════════════════\n")

  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
