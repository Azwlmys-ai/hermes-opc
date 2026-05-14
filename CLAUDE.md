# Hermes — AI Native OPC Operating System

One-person company OS: a single human founder + multi-agent TypeScript system
that decomposes tasks, routes them to specialised agents, tracks cost, and
persists project memory across sessions.

**Current state: v0.1 skeleton — all types defined, no implementation yet.**
Day 2 begins with `packages/provider` (Anthropic SDK integration).

---

## Tech Stack

- **Language**: TypeScript 5.7 (strict mode, no `any`)
- **Runtime**: Node.js 22+
- **Package manager**: pnpm 9 with workspace
- **Build**: Turborepo + tsup (ESM + CJS dual output)
- **Database**: SQLite per workspace (Day 3)
- **Vector search**: deferred to v0.2

---

## Directory Structure

```
hermes/
├── packages/
│   ├── provider/      LLM provider abstraction (IProvider interface)
│   ├── memory/        L2 project memory — SQLite types + schema
│   ├── agent/         Agent contracts — IAgent, Task, AgentResult
│   ├── core/          Kernel — IKernel, task routing, cost guard
│   ├── workspace/     Sandboxed file I/O — WorkspaceService, diff, audit log
│   ├── runtime/       Sandboxed command execution — RuntimeService
│   └── mcp-server/    MCP tool definitions for Claude Code / VS Code
│
├── kernel/
│   ├── config.yaml    Global runtime config (budget, provider defaults)
│   ├── registry.yaml  Agent type registry (which types are implemented)
│   └── cost-table.yaml  Per-model pricing ($/1M tokens)
│
├── projects/          Workspace root — one sub-dir per project (runtime)
├── memory/            L3 global memory root (v0.2)
├── audit/             Append-only audit logs (runtime)
└── .env.example       All required env vars with descriptions
```

---

## Package Responsibilities (one line each)

| Package | Responsibility |
|---------|---------------|
| `@hermes/provider` | Defines how Hermes talks to any LLM — `IProvider` + request/response types |
| `@hermes/memory` | L2 SQLite schema + `IMemoryService` for project-scoped memory |
| `@hermes/agent` | `IAgent`, `Task`, `AgentResult` — the unit of work and its executor contract |
| `@hermes/core` | `IKernel` — task submission, routing, cost guard, approval flow |
| `@hermes/workspace` | Sandboxed file I/O, unified diff, audit log, patch proposal |
| `@hermes/runtime` | Sandboxed command execution with allowlist, timeout, and audit log |
| `@hermes/mcp-server` | MCP server tools for kernel, workspace, and runtime operations |

### Dependency graph (strict DAG — no cycles allowed)

```
mcp-server → core → agent → workspace → (none)
    │             ↘        ↘ provider
    ↓              memory
 runtime
```

---

## Common Commands

```bash
pnpm install          # Install all workspace dependencies
pnpm build            # Build all packages (respects dependency order via Turborepo)
pnpm typecheck        # tsc --noEmit across all packages
pnpm clean            # Delete all dist/ directories
pnpm smoke:runtime    # RuntimeService sandbox smoke test
```

---

## Development Conventions

1. **No `any`** — use `unknown` and narrow with type guards
2. **Enums use string values** — `enum Foo { Bar = "BAR" }` not `Bar = 0`
3. **`import type`** for cross-package type-only imports
4. **`.js` extension** in relative imports (`./types.js` not `./types`)
5. **No `const enum`** — tsup/esbuild cannot inline them across module boundaries; use regular `enum`
6. **No circular deps** — the DAG above is enforced; `provider` and `memory` import nothing internal
7. **`.env` never commits** — use `.env.example` for declarations

---

## v0.1 Explicitly Does NOT Include

The following are **out of scope** for v0.1. Do not implement or import them:

- Any LLM SDK (`@anthropic-ai/sdk`, `openai`, etc.)
- Any Agent business logic or System Prompt text
- Any SQLite connection or query code (`better-sqlite3`, `drizzle-orm`, etc.)
- Any MCP server runtime (`@modelcontextprotocol/sdk` server mode)
- Docker / docker-compose
- Web framework (express, hono, fastify)
- Frontend code
- OpenAI / Gemini / Grok / Ollama provider implementations
- L3 vector search (ChromaDB, pgvector)
- Permission engine business logic
- CI/CD (`.github/workflows`)
- Test files (test framework config is OK, test cases are not)

---

## What's Implemented vs Planned

| Area | v0.1 Status | Starts |
|------|-------------|--------|
| Type definitions (all packages) | ✅ Done | Day 1 |
| Anthropic provider implementation | ✅ Done | Day 2 |
| L2 SQLite memory service | ✅ Done | Day 3 |
| CoderAgent + WriterAgent | ✅ Done | Day 4 |
| Kernel (serial task execution) | ✅ Done | Day 5 |
| MCP server (4 tools) | ✅ Done | Day 6 |
| End-to-end integration test | ✅ Done | Day 7 |
| Workspace Sandbox (WorkspaceService + sandbox + diff + audit) | ✅ Done | Day 8 |
| MCP Server integrates workspace tools (7 tools total) | ✅ Done | Day 9 |
| Runtime command sandbox + MCP runtime.exec | ✅ Done | Day 10 |

---

## Environment Variables

Copy `.env.example` to `.env` and fill in:

```bash
ANTHROPIC_API_KEY=sk-ant-...   # Required from Day 2 onwards
HERMES_ROOT=/Users/libo/opc    # Absolute path to this directory
HERMES_DEFAULT_WORKSPACE=...   # Your default workspace slug
```

Full list and descriptions: see `.env.example`.
