// =============================================================================
// ConstitutionService — evaluates patch proposals against a set of named rules
// loaded from a JSON constitution file.
//
// Rule types:
//   path_glob         — glob pattern match against patch path
//   path_absolute     — path starts with "/" or "\" (cross-workspace/system)
//   path_empty_content — path matches + modifiedContent is empty (deletion)
//   path_exact        — exact path string match
//   content_pattern   — modifiedContent contains a forbidden string
//
// All severity levels (violation / warning / elevated_review) cause the
// check to fail in v0.1. Violations populate `violations`; warnings and
// elevated_review items populate `warnings`. Both lists contribute to `passed`.
//
// If the constitution file is missing, evaluatePatch returns passed=true
// (no rules = no violations). This allows graceful degradation.
// =============================================================================

import { existsSync, readFileSync } from "node:fs"
import { join }                     from "node:path"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ConstitutionSeverity = "violation" | "warning" | "elevated_review"

export type ConstitutionRuleType =
  | "path_glob"
  | "path_absolute"
  | "path_empty_content"
  | "path_exact"
  | "content_pattern"

export interface ConstitutionRule {
  id:          string
  severity:    ConstitutionSeverity
  description: string
  type:        ConstitutionRuleType
  /** Glob or content substring patterns (path_glob, content_pattern) */
  patterns?:   string[]
  /** Exact path list (path_exact, path_empty_content) */
  paths?:      string[]
}

export interface ConstitutionViolation {
  ruleId:      string
  description: string
  severity:    ConstitutionSeverity
  /** Which file path triggered the rule (absent for content-only checks) */
  path?:       string
  detail?:     string
}

export interface ConstitutionResult {
  passed:     boolean
  violations: ConstitutionViolation[]
  warnings:   ConstitutionViolation[]
  summary:    string
}

// ---------------------------------------------------------------------------
// Internal — constitution file shape
// ---------------------------------------------------------------------------

interface ConstitutionFile {
  version:     string
  name:        string
  description?: string
  rules:       ConstitutionRule[]
}

// ---------------------------------------------------------------------------
// Internal — minimal patch shape (avoids @hermes/workspace import)
// ---------------------------------------------------------------------------

interface PatchItem {
  path:             string
  modifiedContent?: string
}

// ---------------------------------------------------------------------------
// ConstitutionService
// ---------------------------------------------------------------------------

export class ConstitutionService {
  private readonly constitutionPath: string
  private constitution: ConstitutionFile | null = null

  constructor(hermesRoot: string, constitutionPath?: string) {
    this.constitutionPath =
      constitutionPath ??
      join(hermesRoot, "constitution", "opc.constitution.json")
    this.tryLoad()
  }

  private tryLoad(): void {
    if (!existsSync(this.constitutionPath)) return
    try {
      this.constitution = JSON.parse(
        readFileSync(this.constitutionPath, "utf8"),
      ) as ConstitutionFile
    } catch {
      // Malformed constitution — silently treat as no-rules
    }
  }

  evaluatePatch(patches: PatchItem[]): ConstitutionResult {
    if (this.constitution === null) {
      return {
        passed:     true,
        violations: [],
        warnings:   [],
        summary:    "No constitution loaded — all patches permitted",
      }
    }

    const allFound: ConstitutionViolation[] = []

    for (const patch of patches) {
      for (const rule of this.constitution.rules) {
        const hit = this.evalRule(rule, patch)
        if (hit !== null) allFound.push(hit)
      }
    }

    const violations = allFound.filter(v => v.severity === "violation")
    const warnings   = allFound.filter(v => v.severity !== "violation")
    const passed     = allFound.length === 0

    const ruleSummary = allFound
      .map(v => `${v.ruleId}(${v.path ?? "content"})`)
      .join(", ")

    const summary = passed
      ? `All ${this.constitution.rules.length} constitution rule(s) passed`
      : `Constitution check failed — ${violations.length} violation(s), ` +
        `${warnings.length} warning(s): ${ruleSummary}`

    return { passed, violations, warnings, summary }
  }

  // ── Rule evaluation ───────────────────────────────────────────────────────

  private evalRule(
    rule: ConstitutionRule,
    patch: PatchItem,
  ): ConstitutionViolation | null {
    const triggered = this.testRule(rule, patch)
    if (!triggered) return null
    return {
      ruleId:      rule.id,
      description: rule.description,
      severity:    rule.severity,
      path:        patch.path,
    }
  }

  private testRule(rule: ConstitutionRule, patch: PatchItem): boolean {
    switch (rule.type) {
      case "path_glob":
        return (rule.patterns ?? []).some(p => matchGlob(patch.path, p))

      case "path_absolute":
        return patch.path.startsWith("/") || patch.path.startsWith("\\")

      case "path_empty_content":
        return (
          (rule.paths ?? []).includes(patch.path) &&
          patch.modifiedContent !== undefined &&
          patch.modifiedContent.trim() === ""
        )

      case "path_exact":
        return (rule.paths ?? []).includes(patch.path)

      case "content_pattern":
        if (patch.modifiedContent === undefined) return false
        return (rule.patterns ?? []).some(p =>
          patch.modifiedContent!.includes(p),
        )
    }
  }
}

// ---------------------------------------------------------------------------
// Glob matching — no external dependencies
// ---------------------------------------------------------------------------

function matchGlob(path: string, pattern: string): boolean {
  const normPath    = path.replace(/\\/g, "/")
  const normPattern = pattern.replace(/\\/g, "/")

  // Build a regex from the glob pattern, character by character
  let regexStr = ""
  let i = 0
  while (i < normPattern.length) {
    const ch = normPattern[i]

    if (ch === "*" && normPattern[i + 1] === "*") {
      // ** matches any sequence of characters including slashes
      regexStr += ".*"
      i += 2
      // consume optional trailing slash after **
      if (normPattern[i] === "/") i++
    } else if (ch === "*") {
      // * matches any sequence except a slash
      regexStr += "[^/]*"
      i++
    } else if (ch === "?") {
      // ? matches any single character except slash
      regexStr += "[^/]"
      i++
    } else if (ch !== undefined && /[.+^${}()|[\]\\]/.test(ch)) {
      // Escape regex-special characters
      regexStr += `\\${ch}`
      i++
    } else {
      regexStr += ch ?? ""
      i++
    }
  }

  try {
    return new RegExp(`^${regexStr}$`).test(normPath)
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createConstitutionService(
  hermesRoot: string,
  constitutionPath?: string,
): ConstitutionService {
  return new ConstitutionService(hermesRoot, constitutionPath)
}
