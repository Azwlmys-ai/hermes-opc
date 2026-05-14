// =============================================================================
// AnthropicProvider — implements IProvider for the Anthropic Claude API.
//
// Rules enforced here:
//   · No any — all SDK output narrowed via instanceof / type discriminants
//   · constructor does not read process.env — caller injects apiKey
//   · system role in messages[] extracted to Anthropic top-level system field
//   · max_tokens defaults to 8192 when caller omits it
//   · Only text content blocks are surfaced; tool_use / image blocks skipped
//   · All SDK exceptions wrapped into AnthropicProviderError
// =============================================================================

import Anthropic from "@anthropic-ai/sdk"
import type {
  CompletionRequest,
  CompletionResponse,
  CostEstimate,
  IProvider,
  ModelConfig,
  StreamChunk,
  TokenUsage,
} from "../types.js"
import { ProviderName } from "../types.js"

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_TOKENS = 8192

// ---------------------------------------------------------------------------
// Private error class
// Extends Error so callers get a real stack trace.
// Carries ProviderError-shaped fields so Kernel can read them structurally.
// ---------------------------------------------------------------------------

export class AnthropicProviderError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly statusCode: number | undefined

  constructor(
    code: string,
    message: string,
    retryable: boolean,
    statusCode?: number,
  ) {
    super(message)
    this.name = "AnthropicProviderError"
    this.code = code
    this.retryable = retryable
    this.statusCode = statusCode
  }
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function mapStopReason(
  reason: string | null | undefined,
): CompletionResponse["stopReason"] {
  switch (reason) {
    case "end_turn":      return "end_turn"
    case "max_tokens":    return "max_tokens"
    case "stop_sequence": return "stop_sequence"
    default:              return "end_turn"
  }
}

function mapUsage(
  inputTokens: number,
  outputTokens: number,
  cacheRead: number | null | undefined,
  cacheWrite: number | null | undefined,
): TokenUsage {
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens:  cacheRead  ?? 0,
    cacheWriteTokens: cacheWrite ?? 0,
  }
}

function wrapError(err: unknown): AnthropicProviderError {
  if (err instanceof Anthropic.APIError) {
    // 429 = rate limit, 529 = overloaded — both are transient
    const retryable = err.status === 429 || err.status === 529
    return new AnthropicProviderError(
      String(err.status),
      err.message,
      retryable,
      err.status,
    )
  }
  const message = err instanceof Error ? err.message : String(err)
  return new AnthropicProviderError("UNKNOWN", message, false)
}

/**
 * Split a CompletionRequest into the Anthropic messages array and a combined
 * system prompt string.
 *
 * Anthropic's API rejects role:"system" inside messages[] — system content
 * must be in the top-level `system` parameter. We extract it here so callers
 * can use our generic Message type without worrying about Anthropic quirks.
 *
 * Merge order: req.system → any role:"system" messages (top to bottom).
 */
function buildAnthropicMessages(req: CompletionRequest): {
  messages: Anthropic.MessageParam[]
  systemPrompt: string | undefined
} {
  const systemParts: string[] = []
  const messages: Anthropic.MessageParam[] = []

  // Top-level system field comes first
  if (req.system !== undefined) {
    systemParts.push(req.system)
  }

  for (const msg of req.messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content)
    } else {
      // TypeScript narrows msg.role to "user" | "assistant" here —
      // both are valid Anthropic.MessageParam roles.
      messages.push({ role: msg.role, content: msg.content })
    }
  }

  const systemPrompt =
    systemParts.length > 0 ? systemParts.join("\n\n") : undefined

  return { messages, systemPrompt }
}

// ---------------------------------------------------------------------------
// AnthropicProvider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements IProvider {
  readonly name = ProviderName.Anthropic
  readonly models: readonly ModelConfig[]

  private readonly client: Anthropic
  private readonly costTable: Map<string, ModelConfig>
  private readonly _apiKey: string

  constructor(apiKey: string, costTable: Map<string, ModelConfig>) {
    if (apiKey.trim().length === 0) {
      throw new AnthropicProviderError(
        "INVALID_API_KEY",
        "Anthropic API key must not be empty",
        false,
      )
    }
    this._apiKey = apiKey
    this.client = new Anthropic({ apiKey })
    this.costTable = costTable
    // Expose only the models belonging to this provider
    this.models = [...costTable.values()].filter(
      (m) => m.provider === ProviderName.Anthropic,
    )
  }

  // -------------------------------------------------------------------------
  // healthCheck
  // Format-only check — no API call, no token cost.
  // Real connectivity is confirmed on the first complete() / stream() call.
  // -------------------------------------------------------------------------

  healthCheck(): Promise<boolean> {
    const valid =
      this._apiKey.startsWith("sk-ant-") && this._apiKey.length > 30
    return Promise.resolve(valid)
  }

  // -------------------------------------------------------------------------
  // estimateCost
  // Pre-flight estimate: no API call. Used by CostGuard before dispatching.
  // Accuracy target: within ±20% of actual (biased towards over-estimation).
  // -------------------------------------------------------------------------

  estimateCost(req: CompletionRequest): CostEstimate {
    const model = this.costTable.get(req.model)
    if (model === undefined) {
      throw new AnthropicProviderError(
        "UNKNOWN_MODEL",
        `Model not found in cost table: ${req.model}`,
        false,
      )
    }

    // ~4 chars per token (English text). Under-counts CJK — acceptable for
    // a pre-flight guard that errs on the side of caution.
    let charCount = req.system?.length ?? 0
    for (const msg of req.messages) {
      charCount += msg.content.length
    }
    const inputTokens = Math.ceil(charCount / 4)

    // Use maxTokens as output upper bound — we don't know actual output yet
    const estimatedOutputTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS

    const inputCostUsd =
      (inputTokens / 1_000_000) * model.inputPer1mUsd
    const estimatedOutputCostUsd =
      (estimatedOutputTokens / 1_000_000) * model.outputPer1mUsd

    return {
      inputTokens,
      estimatedOutputTokens,
      inputCostUsd,
      estimatedOutputCostUsd,
      totalEstimatedUsd: inputCostUsd + estimatedOutputCostUsd,
    }
  }

  // -------------------------------------------------------------------------
  // complete
  // Blocking call — waits for the full response before returning.
  // -------------------------------------------------------------------------

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    const { messages, systemPrompt } = buildAnthropicMessages(req)

    try {
      const response = await this.client.messages.create({
        model:      req.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages,
        ...(systemPrompt  !== undefined ? { system:      systemPrompt      } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      })

      // Concatenate text blocks; skip image / tool_use / tool_result blocks
      let text = ""
      for (const block of response.content) {
        if (block.type === "text") {
          text += block.text
        }
      }

      return {
        content:    text,
        usage:      mapUsage(
          response.usage.input_tokens,
          response.usage.output_tokens,
          response.usage.cache_read_input_tokens,
          response.usage.cache_creation_input_tokens,
        ),
        model:      response.model,
        stopReason: mapStopReason(response.stop_reason),
      }
    } catch (err) {
      throw wrapError(err)
    }
  }

  // -------------------------------------------------------------------------
  // stream
  // Yields StreamChunks as the model generates tokens.
  //
  // Chunk sequence per call:
  //   { type:"text", text:"..." }  × N   (one per SDK text_delta event)
  //   { type:"usage", usage:{...} }      (once, from message_delta)
  //   { type:"stop",  stopReason:"..." } (once, from message_stop)
  // -------------------------------------------------------------------------

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const { messages, systemPrompt } = buildAnthropicMessages(req)

    // Accumulators — populated as events arrive
    let accInputTokens  = 0
    let accOutputTokens = 0
    let accCacheRead    = 0
    let accCacheWrite   = 0
    let finalStopReason: CompletionResponse["stopReason"] = "end_turn"

    try {
      const sdkStream = this.client.messages.stream({
        model:      req.model,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages,
        ...(systemPrompt  !== undefined ? { system:      systemPrompt      } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      })

      for await (const event of sdkStream) {
        if (event.type === "message_start") {
          const u = event.message.usage
          accInputTokens = u.input_tokens
          // cache_* are optional in the SDK type — default to 0 if absent
          accCacheRead  = u.cache_read_input_tokens  ?? 0
          accCacheWrite = u.cache_creation_input_tokens ?? 0

        } else if (event.type === "content_block_delta") {
          // Only surface text deltas; skip input_json_delta (tool use)
          if (event.delta.type === "text_delta") {
            yield { type: "text", text: event.delta.text }
          }

        } else if (event.type === "message_delta") {
          accOutputTokens = event.usage.output_tokens
          finalStopReason = mapStopReason(event.delta.stop_reason)

        } else if (event.type === "message_stop") {
          // Stream is done — emit final usage then stop sentinel
          yield {
            type: "usage",
            usage: mapUsage(
              accInputTokens,
              accOutputTokens,
              accCacheRead,
              accCacheWrite,
            ),
          }
          yield { type: "stop", stopReason: finalStopReason }
        }
      }
    } catch (err) {
      throw wrapError(err)
    }
  }
}
