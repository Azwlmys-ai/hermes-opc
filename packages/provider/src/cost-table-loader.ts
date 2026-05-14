// =============================================================================
// cost-table-loader.ts
// Reads kernel/cost-table.yaml and returns a Map<modelId, ModelConfig>.
//
// No caching — callers (Kernel) load once at startup and hold the result.
// No file watching — a process restart picks up changes.
// No any — all YAML output is narrowed through type guards.
// =============================================================================

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { parse as parseYaml } from "yaml"
import { ProviderName } from "./types.js"
import type { ModelConfig } from "./types.js"

// ---------------------------------------------------------------------------
// Raw internal types — reflect the structure of kernel/cost-table.yaml.
// These are private to this module; only ModelConfig is exported.
// ---------------------------------------------------------------------------

interface RawModel {
  id: string
  input_per_1m_usd: number
  output_per_1m_usd: number
  cache_read_per_1m_usd?: number
  cache_write_per_1m_usd?: number
  context_window: number
  notes?: string
}

interface RawProvider {
  implemented: boolean
  base_url?: string
  models: RawModel[]
}

interface RawCostTable {
  providers: Record<string, RawProvider>
}

// ---------------------------------------------------------------------------
// YAML provider key → ProviderName enum
// ---------------------------------------------------------------------------

const PROVIDER_KEYS: Readonly<Record<string, ProviderName>> = {
  anthropic:          ProviderName.Anthropic,
  openai:             ProviderName.OpenAI,
  "openai-compatible": ProviderName.OpenAI,   // relay providers (PawMaaS, OpenRouter, etc.)
  google:             ProviderName.Gemini,
  xai:                ProviderName.Grok,
  ollama:             ProviderName.Ollama,
}

// ---------------------------------------------------------------------------
// Type guards — narrow from unknown without any
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string {
  return typeof v === "string"
}

function isNumber(v: unknown): v is number {
  return typeof v === "number"
}

function isBoolean(v: unknown): v is boolean {
  return typeof v === "boolean"
}

function isRawModel(v: unknown): v is RawModel {
  if (!isRecord(v)) return false

  // Required fields
  if (!isString(v["id"]))                   return false
  if (!isNumber(v["input_per_1m_usd"]))     return false
  if (!isNumber(v["output_per_1m_usd"]))    return false
  if (!isNumber(v["context_window"]))       return false

  // Optional fields — validate type only if the key is present
  if (v["cache_read_per_1m_usd"]  !== undefined && !isNumber(v["cache_read_per_1m_usd"]))  return false
  if (v["cache_write_per_1m_usd"] !== undefined && !isNumber(v["cache_write_per_1m_usd"])) return false
  if (v["notes"]                  !== undefined && !isString(v["notes"]))                  return false

  return true
}

function isRawProvider(v: unknown): v is RawProvider {
  if (!isRecord(v))               return false
  if (!isBoolean(v["implemented"])) return false
  if (!Array.isArray(v["models"])) return false
  return v["models"].every(isRawModel)
}

function isRawCostTable(v: unknown): v is RawCostTable {
  if (!isRecord(v))                    return false
  if (!isRecord(v["providers"]))       return false
  return Object.values(v["providers"]).every(isRawProvider)
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the provider cost table from `{hermesRoot}/kernel/cost-table.yaml`.
 *
 * @param hermesRoot  Absolute path to the Hermes root directory.
 *                    Falls back to HERMES_ROOT env var, then process.cwd().
 * @returns           Map from model ID to ModelConfig.
 *                    Only models from providers with `implemented: true` are included.
 * @throws            Error if the file is missing or its structure is invalid.
 */
export function loadCostTable(hermesRoot?: string): Map<string, ModelConfig> {
  const root     = hermesRoot ?? process.env["HERMES_ROOT"] ?? process.cwd()
  const filePath = join(root, "kernel", "cost-table.yaml")

  let fileContent: string
  try {
    fileContent = readFileSync(filePath, "utf8")
  } catch (cause) {
    throw new Error(`cost-table.yaml not found at: ${filePath}`, { cause })
  }

  // yaml.parse() returns any — assign to unknown immediately
  const raw: unknown = parseYaml(fileContent)

  if (!isRawCostTable(raw)) {
    throw new Error(
      `cost-table.yaml has unexpected structure at: ${filePath}\n` +
      `Expected: { providers: Record<string, { implemented: boolean, models: RawModel[] }> }`,
    )
  }

  const result = new Map<string, ModelConfig>()

  for (const [providerKey, provider] of Object.entries(raw.providers)) {
    // Skip providers not yet implemented (OpenAI, Gemini, Grok, Ollama in v0.1)
    if (!provider.implemented) continue

    const providerName = PROVIDER_KEYS[providerKey]

    // noUncheckedIndexedAccess: providerName may be undefined for unknown keys
    if (providerName === undefined) continue

    for (const model of provider.models) {
      // Build ModelConfig — handle optional fields with explicit checks to
      // satisfy exactOptionalPropertyTypes (no spreading undefined values)
      const config: ModelConfig = {
        id:              model.id,
        provider:        providerName,
        inputPer1mUsd:   model.input_per_1m_usd,
        outputPer1mUsd:  model.output_per_1m_usd,
        contextWindow:   model.context_window,
      }

      if (model.cache_read_per_1m_usd !== undefined) {
        config.cacheReadPer1mUsd = model.cache_read_per_1m_usd
      }
      if (model.cache_write_per_1m_usd !== undefined) {
        config.cacheWritePer1mUsd = model.cache_write_per_1m_usd
      }
      if (model.notes !== undefined) {
        config.notes = model.notes
      }

      result.set(model.id, config)
    }
  }

  return result
}
