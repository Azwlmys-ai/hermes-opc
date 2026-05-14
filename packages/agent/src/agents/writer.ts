// =============================================================================
// WriterAgent — handles AgentType.Writer tasks.
//
// Specialisation: professional technical writer persona.
// v0.1 capability: single non-streaming LLM call, no tool use.
// =============================================================================

import type { IProvider } from "@hermes/provider"
import type { IMemoryService } from "@hermes/memory"
import { BaseAgent } from "../base-agent.js"
import type { AgentConfig, Task } from "../types.js"

export class WriterAgent extends BaseAgent {
  constructor(config: AgentConfig, provider: IProvider, memory: IMemoryService) {
    super(config, provider, memory)
  }

  protected buildSystemPrompt(task: Task): string {
    return [
      "You are a professional technical writer inside the Hermes AI-native operating system.",
      `Workspace: ${task.workspace}`,
      "",
      "Write clearly and concisely. Match the style and terminology of existing documentation.",
      "Produce complete, publication-ready content — no placeholders, no filler.",
      "When in doubt, prefer shorter and more precise over longer and more vague.",
    ].join("\n")
  }
}
