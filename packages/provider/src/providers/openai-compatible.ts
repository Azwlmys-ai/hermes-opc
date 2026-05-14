// =============================================================================
// OpenAICompatibleProvider — implements IProvider for any OpenAI-style relay.
//
// Compatible with: PawMaaS · OpenRouter · OneAPI · NewAPI · LiteLLM ·
//                  SiliconFlow · FastGPT · DeepSeek · Groq · any /v1/chat/completions
//
// Rules:
//   · No any — all SDK output narrowed via discriminants or type guards
//   · constructor does not read process.env — caller injects options
//   · Tolerates relays that omit usage in stream responses
//   · All SDK exceptions wrapped into OpenAICompatibleProviderError
//   · No tool_use / function calling in v0.1
// =============================================================================

import OpenAI from "openai"
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
// Construction options
// ---------------------------------------------------------------------------

export interface OpenAICompatibleOptions {
  apiKey: string
  baseURL: string
  costTable: Map<string, ModelConfig>
}

// ---------------------------------------------------------------------------
// Private error class — real Error with structured fields
// ---------------------------------------------------------------------------

export class OpenAICompatibleProviderError extends Error {
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
    this.name = "OpenAICompatibleProviderError"
    this.code = code
    this.retryable = retryable
    this.statusCode = statusCode
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mapStopReason(
  reason: string | null | undefined,
): CompletionResponse["stopReason"] {
  switch (reason) {
    case "stop":       return "end_turn"
    case "length":     return "max_tokens"
    case "tool_calls": return "end_turn"   // treat tool_calls finish as end_turn for now
    default:           return "end_turn"
  }
}

function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
}

function sdkUsageToTokenUsage(
  u: { prompt_tokens?: number; completion_tokens?: number } | null | undefined,
): TokenUsage {
  if (u === null || u === undefined) return zeroUsage()
  return {
    inputTokens:      u.prompt_tokens     ?? 0,
    outputTokens:     u.completion_tokens ?? 0,
    cacheReadTokens:  0,
    cacheWriteTokens: 0,
  }
}

function isValidUrl(raw: string): boolean {
  try {
    new URL(raw)
    return true
  } catch {
    return false
  }
}

function wrapError(err: unknown): OpenAICompatibleProviderError {
  // OpenAI SDK wraps HTTP errors in APIError
  if (err instanceof OpenAI.APIError) {
    const retryable = err.status === 429 || err.status === 503
    return new OpenAICompatibleProviderError(
      String(err.status),
      err.message,
      retryable,
      err.status,
    )
  }
  const message = err instanceof Error ? err.message : String(err)
  return new OpenAICompatibleProviderError("UNKNOWN", message, false)
}

// ---------------------------------------------------------------------------
// OpenAICompatibleProvider
// ---------------------------------------------------------------------------

export class OpenAICompatibleProvider implements IProvider {
  readonly name = ProviderName.OpenAI   // closest semantic match for relay providers
  readonly models: readonly ModelConfig[]

  private readonly client: OpenAI
  private readonly costTable: Map<string, ModelConfig>
  private readonly _apiKey: string
  private readonly _baseURL: string

  constructor(options: OpenAICompatibleOptions) {
    const { apiKey, baseURL, costTable } = options

    if (apiKey.trim().length === 0) {
      throw new OpenAICompatibleProviderError(
        "INVALID_API_KEY",
        "API key must not be empty",
        false,
      )
    }
    if (!isValidUrl(baseURL)) {
      throw new OpenAICompatibleProviderError(
        "INVALID_BASE_URL",
        `baseURL is not a valid URL: ${baseURL}`,
        false,
      )
    }

    this._apiKey = apiKey
    this._baseURL = baseURL
    this.costTable = costTable
    this.client = new OpenAI({ apiKey, baseURL })

    // Expose all models from the cost table (relay supports any model)
    this.models = [...costTable.values()]
  }

  // -------------------------------------------------------------------------
  // healthCheck — format-only, no API call
  // -------------------------------------------------------------------------

  healthCheck(): Promise<boolean> {
    const keyOk = this._apiKey.length > 8
    const urlOk = isValidUrl(this._baseURL)
    return Promise.resolve(keyOk && urlOk)
  }

  // -------------------------------------------------------------------------
  // estimateCost — pre-flight, no API call
  // -------------------------------------------------------------------------

  estimateCost(req: CompletionRequest): CostEstimate {
    const model = this.costTable.get(req.model)
    if (model === undefined) {
      // Unknown model — return a zero estimate rather than throwing.
      // Many relay models aren't in the cost table; we still allow the call.
      const inputTokens = Math.ceil(
        ((req.system?.length ?? 0) +
          req.messages.reduce((s, m) => s + m.content.length, 0)) / 4,
      )
      const estimatedOutputTokens = req.maxTokens ?? DEFAULT_MAX_TOKENS
      return {
        inputTokens,
        estimatedOutputTokens,
        inputCostUsd: 0,
        estimatedOutputCostUsd: 0,
        totalEstimatedUsd: 0,
      }
    }

    let charCount = req.system?.length ?? 0
    for (const msg of req.messages) charCount += msg.content.length
    const inputTokens = Math.ceil(charCount / 4)
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
  // complete — blocking, uses chat.completions.create
  // -------------------------------------------------------------------------

  async complete(req: CompletionRequest): Promise<CompletionResponse> {
    // Build messages — system role IS valid in OpenAI chat format
    const messages: OpenAI.ChatCompletionMessageParam[] = []

    if (req.system !== undefined) {
      messages.push({ role: "system", content: req.system })
    }

    for (const msg of req.messages) {
      if (msg.role === "system") {
        // Merge any inline system messages into a leading system message
        messages.push({ role: "system", content: msg.content })
      } else {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    try {
      const response = await this.client.chat.completions.create({
        model:      req.model,
        messages,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        stream: false,
      })

      // Extract text from first choice
      const choice = response.choices[0]
      const content = choice?.message?.content ?? ""
      const stopReason = mapStopReason(choice?.finish_reason)
      const usage = sdkUsageToTokenUsage(response.usage)

      return { content, usage, model: response.model, stopReason }
    } catch (err) {
      throw wrapError(err)
    }
  }

  // -------------------------------------------------------------------------
  // stream — SSE streaming via chat.completions.create({ stream: true })
  //
  // Compatibility notes:
  //   · Some relays (PawMaaS, OpenRouter) send usage in the final chunk
  //     under stream_options.include_usage — others send nothing.
  //   · We request include_usage: true and tolerate absence gracefully.
  //   · content delta may be null on the final chunk — we skip it.
  // -------------------------------------------------------------------------

  async *stream(req: CompletionRequest): AsyncIterable<StreamChunk> {
    const messages: OpenAI.ChatCompletionMessageParam[] = []

    if (req.system !== undefined) {
      messages.push({ role: "system", content: req.system })
    }
    for (const msg of req.messages) {
      if (msg.role === "system") {
        messages.push({ role: "system", content: msg.content })
      } else {
        messages.push({ role: msg.role, content: msg.content })
      }
    }

    let finalUsage: TokenUsage | undefined
    let finalStopReason: CompletionResponse["stopReason"] = "end_turn"

    try {
      const sdkStream = await this.client.chat.completions.create({
        model:      req.model,
        messages,
        max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        stream: true,
        stream_options: { include_usage: true },
      })

      for await (const chunk of sdkStream) {
        const choice = chunk.choices[0]

        // Text delta
        const delta = choice?.delta?.content
        if (typeof delta === "string" && delta.length > 0) {
          yield { type: "text", text: delta }
        }

        // Stop reason (present on the last choice chunk)
        if (choice?.finish_reason !== null && choice?.finish_reason !== undefined) {
          finalStopReason = mapStopReason(choice.finish_reason)
        }

        // Usage — some relays send this on the final chunk (choices: [])
        if (chunk.usage !== null && chunk.usage !== undefined) {
          finalUsage = sdkUsageToTokenUsage(chunk.usage)
        }
      }
    } catch (err) {
      throw wrapError(err)
    }

    // Emit usage chunk (may be zero if relay didn't send it — that's fine)
    yield {
      type:  "usage",
      usage: finalUsage ?? zeroUsage(),
    }
    yield { type: "stop", stopReason: finalStopReason }
  }
}
