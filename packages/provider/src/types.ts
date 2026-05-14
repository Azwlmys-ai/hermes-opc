// =============================================================================
// @hermes/provider — Type definitions only. No implementation. No SDK imports.
// =============================================================================

// ---------------------------------------------------------------------------
// Provider identity
// ---------------------------------------------------------------------------

export enum ProviderName {
  Anthropic = "anthropic",
  OpenAI    = "openai",
  Gemini    = "gemini",
  Grok      = "grok",
  Ollama    = "ollama",
}

export interface ModelConfig {
  id: string
  provider: ProviderName
  /** USD per 1,000,000 input tokens */
  inputPer1mUsd: number
  /** USD per 1,000,000 output tokens */
  outputPer1mUsd: number
  /** USD per 1,000,000 prompt-cache read tokens (provider-specific) */
  cacheReadPer1mUsd?: number
  /** USD per 1,000,000 prompt-cache write tokens (provider-specific) */
  cacheWritePer1mUsd?: number
  contextWindow: number
  notes?: string
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export type MessageRole = "user" | "assistant" | "system"

export interface Message {
  role: MessageRole
  content: string
}

export interface CompletionRequestMetadata {
  taskId: string
  workspace: string
  agentId: string
}

export interface CompletionRequest {
  model: string
  messages: Message[]
  /** Optional top-level system prompt (kept separate from messages) */
  system?: string
  maxTokens?: number
  /** 0.0–1.0. Omit to use provider default. */
  temperature?: number
  metadata?: CompletionRequestMetadata
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
  /** Tokens served from prompt cache (Anthropic) */
  cacheReadTokens: number
  /** Tokens written to prompt cache (Anthropic) */
  cacheWriteTokens: number
}

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "timeout"
  | "cancelled"

export interface CompletionResponse {
  content: string
  usage: TokenUsage
  model: string
  stopReason: StopReason
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

export type StreamChunkType = "text" | "usage" | "stop"

export interface StreamChunk {
  type: StreamChunkType
  /** Present when type === "text" */
  text?: string
  /** Present when type === "usage" or "stop" */
  usage?: TokenUsage
  /** Present when type === "stop" */
  stopReason?: StopReason
}

// ---------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------

export interface CostEstimate {
  /** Exact (from request content length) */
  inputTokens: number
  /** Heuristic — actual may differ */
  estimatedOutputTokens: number
  inputCostUsd: number
  estimatedOutputCostUsd: number
  totalEstimatedUsd: number
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ProviderError {
  code: string
  message: string
  retryable: boolean
  /** HTTP status if applicable */
  statusCode?: number
}

// ---------------------------------------------------------------------------
// Tool use (reserved for v0.2 — types defined now for interface completeness)
// ---------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  /** JSON Schema object describing the tool's input */
  inputSchema: Record<string, unknown>
}

export interface ToolCallResult {
  toolName: string
  result: unknown
  error?: string
}

// ---------------------------------------------------------------------------
// Provider contract
// ---------------------------------------------------------------------------

export interface IProvider {
  readonly name: ProviderName
  readonly models: readonly ModelConfig[]

  /** Blocking completion — waits for full response */
  complete(req: CompletionRequest): Promise<CompletionResponse>

  /** Streaming completion — yields chunks as they arrive */
  stream(req: CompletionRequest): AsyncIterable<StreamChunk>

  /** Pre-flight cost estimate without making an API call */
  estimateCost(req: CompletionRequest): CostEstimate

  /** Returns true if the provider endpoint is reachable */
  healthCheck(): Promise<boolean>
}
