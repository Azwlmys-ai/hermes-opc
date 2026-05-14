// =============================================================================
// CoderAgent — handles AgentType.Coder tasks.
//
// v0.1 capability:
//   · Single non-streaming LLM call (no tool use)
//   · Asks the model to return a structured PatchProposal JSON
//   · Does NOT write files — the proposal is returned for human/Kernel review
//
// Expected LLM response format (strict JSON, no markdown fences):
// {
//   "summary": "one-line description of changes",
//   "patches": [
//     { "path": "src/foo.ts", "content": "<full new file content>" }
//   ]
// }
//
// AgentResult.patchProposal is populated when the response parses correctly.
// AgentResult.output always contains the raw LLM response for debugging.
// =============================================================================

import type { IProvider }     from "@hermes/provider"
import type { IMemoryService } from "@hermes/memory"
import type { PatchProposal }  from "@hermes/workspace"
import { BaseAgent }           from "../base-agent.js"
import type { AgentConfig, Task } from "../types.js"

// ---------------------------------------------------------------------------
// Raw JSON shape the model is asked to produce
// ---------------------------------------------------------------------------

interface RawPatch    { path: string; content: string }
interface RawProposal { summary: string; patches: RawPatch[] }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}
function isString(v: unknown): v is string { return typeof v === "string" }

function isRawPatch(v: unknown): v is RawPatch {
  if (!isRecord(v)) return false
  return isString(v["path"]) && isString(v["content"])
}

function isRawProposal(v: unknown): v is RawProposal {
  if (!isRecord(v)) return false
  if (!isString(v["summary"])) return false
  if (!Array.isArray(v["patches"])) return false
  return (v["patches"] as unknown[]).every(isRawPatch)
}

// ---------------------------------------------------------------------------
// CoderAgent
// ---------------------------------------------------------------------------

export class CoderAgent extends BaseAgent {
  constructor(config: AgentConfig, provider: IProvider, memory: IMemoryService) {
    super(config, provider, memory)
  }

  protected buildSystemPrompt(task: Task): string {
    const forbidden = this.config.permissions.forbidden

    const lines = [
      "You are a senior software engineer inside the Hermes AI-native operating system.",
      `Workspace: ${task.workspace}`,
    ]

    if (forbidden.length > 0) {
      lines.push(
        "",
        "FORBIDDEN paths — never read or write:",
        ...forbidden.map(p => `  · ${p}`),
      )
    }

    lines.push(
      "",
      "RESPONSE FORMAT — return ONLY this JSON object (no markdown, no prose outside):",
      "{",
      '  "summary": "<one-line description of what the patches accomplish>",',
      '  "patches": [',
      '    { "path": "<relative/path/to/file>", "content": "<complete new file content>" }',
      '  ]',
      "}",
      "",
      "Rules:",
      "  · JSON only — no markdown code fences, no explanation outside the object.",
      "  · Each patch must contain the FULL file content (not a diff).",
      "  · No placeholders, no TODOs unless the task explicitly asks for them.",
      "  · Output only what was asked — no unsolicited refactoring or extra files.",
    )

    return lines.join("\n")
  }

  // Override the postProcess hook to parse the structured proposal
  protected override postProcess(
    content: string,
    task:    Task,
    agentId: string,
  ): { output: string; patchProposal?: PatchProposal } {
    // Strip possible markdown code fences the model sometimes adds
    const stripped = content
      .replace(/^```(?:json)?\s*/m, "")
      .replace(/\s*```$/m, "")
      .trim()

    let parsed: unknown
    try {
      parsed = JSON.parse(stripped)
    } catch {
      return { output: content }
    }

    if (!isRawProposal(parsed)) {
      return { output: content }
    }

    const proposal: PatchProposal = {
      taskId:     task.id,
      agentId,
      summary:    parsed.summary,
      proposedAt: new Date().toISOString(),
      patches:    parsed.patches.map(p => ({
        path:            p.path,
        originalContent: "",   // filled by WorkspaceService.applyPatch
        modifiedContent: p.content,
        diff:            "",   // computed on apply
        hunks:           [],
      })),
    }

    return { output: stripped, patchProposal: proposal }
  }
}
