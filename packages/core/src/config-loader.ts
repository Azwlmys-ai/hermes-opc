// =============================================================================
// config-loader.ts — reads kernel/config.yaml and returns KernelConfig.
//
// Rules:
//   · No any — all YAML output narrowed via type guards
//   · Caller (createKernel) holds the result; no caching here
//   · Falls back to HERMES_ROOT env var, then process.cwd() for path resolution
// =============================================================================

import { readFileSync } from "node:fs"
import { join }         from "node:path"
import { parse as parseYaml } from "yaml"
import type { KernelConfig, CostGuardConfig } from "./types.js"

// ---------------------------------------------------------------------------
// Raw YAML shape — mirrors kernel/config.yaml (snake_case)
// ---------------------------------------------------------------------------

interface RawBudget {
  global_daily_limit_usd:      number
  per_agent_session_limit_usd: number
  alert_threshold:             number
  hard_stop_threshold:         number
}

interface RawProvider {
  default:       string
  default_model: string
}

interface RawAgent {
  max_concurrent: number
}

interface RawConfig {
  version:  string
  budget:   RawBudget
  provider: RawProvider
  agent:    RawAgent
}

// ---------------------------------------------------------------------------
// Type guards — narrow from unknown without any
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function isString(v: unknown): v is string { return typeof v === "string" }
function isNumber(v: unknown): v is number { return typeof v === "number" }

function isRawBudget(v: unknown): v is RawBudget {
  if (!isRecord(v)) return false
  return (
    isNumber(v["global_daily_limit_usd"])      &&
    isNumber(v["per_agent_session_limit_usd"]) &&
    isNumber(v["alert_threshold"])             &&
    isNumber(v["hard_stop_threshold"])
  )
}

function isRawProvider(v: unknown): v is RawProvider {
  if (!isRecord(v)) return false
  return isString(v["default"]) && isString(v["default_model"])
}

function isRawAgent(v: unknown): v is RawAgent {
  if (!isRecord(v)) return false
  return isNumber(v["max_concurrent"])
}

function isRawConfig(v: unknown): v is RawConfig {
  if (!isRecord(v)) return false
  return (
    isString(v["version"])       &&
    isRawBudget(v["budget"])     &&
    isRawProvider(v["provider"]) &&
    isRawAgent(v["agent"])
  )
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load KernelConfig from `{hermesRoot}/kernel/config.yaml`.
 *
 * @param hermesRoot  Absolute path to the Hermes root dir.
 *                    Falls back to HERMES_ROOT env var, then process.cwd().
 */
export function loadKernelConfig(hermesRoot?: string): KernelConfig {
  const root     = hermesRoot ?? process.env["HERMES_ROOT"] ?? process.cwd()
  const filePath = join(root, "kernel", "config.yaml")

  let content: string
  try {
    content = readFileSync(filePath, "utf8")
  } catch (cause) {
    throw new Error(`kernel/config.yaml not found at: ${filePath}`, { cause })
  }

  const raw: unknown = parseYaml(content)

  if (!isRawConfig(raw)) {
    throw new Error(
      `kernel/config.yaml has unexpected structure at: ${filePath}. ` +
      "Expected: { version, budget, provider, agent }",
    )
  }

  const budget: CostGuardConfig = {
    globalDailyLimitUsd:     raw.budget.global_daily_limit_usd,
    perAgentSessionLimitUsd: raw.budget.per_agent_session_limit_usd,
    alertThreshold:          raw.budget.alert_threshold,
    hardStopThreshold:       raw.budget.hard_stop_threshold,
  }

  return {
    version:             raw.version,
    budget,
    defaultProvider:     raw.provider.default,
    defaultModel:        raw.provider.default_model,
    maxConcurrentAgents: raw.agent.max_concurrent,
    providerRoutes:      [],   // v0.1: no per-type routes in config.yaml
  }
}
