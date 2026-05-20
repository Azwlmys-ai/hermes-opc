// =============================================================================
// VerificationService — pre-approval patch verification pipeline.
//
// Runs a series of checks before a patch is applied to the workspace:
//   A. patch.safe-paths  — low-level path safety (traversal, lock files)
//   B. constitution.check — rule-based policy gate (see ConstitutionService)
//   C. typecheck         — pnpm typecheck in hermesRoot
//   D. smoke:runtime / smoke:events — fast regression smoke tests
//
// All checks are synchronous under the hood (spawnSync); the public API is
// async to match the rest of the pipeline.
// =============================================================================

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { ConstitutionService } from "./constitution-service.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface VerificationCheck {
  name: string
  passed: boolean
  details?: string
}

export interface VerificationResult {
  passed: boolean
  checks: VerificationCheck[]
  summary: string
}

// ---------------------------------------------------------------------------
// Minimal patch shape — avoids importing @hermes/workspace (DAG constraint).
// modifiedContent is optional: present when coming from PatchProposal,
// absent in stub inputs (e.g. empty-patch tests).
// ---------------------------------------------------------------------------

interface PatchItem {
  path: string
  modifiedContent?: string
}

interface PatchInput {
  patches: PatchItem[]
}

// ---------------------------------------------------------------------------
// VerificationService
// ---------------------------------------------------------------------------

export class VerificationService {
  private readonly hermesRoot:      string
  private readonly constitutionSvc: ConstitutionService

  constructor(hermesRoot?: string) {
    this.hermesRoot      = hermesRoot ?? process.env["HERMES_ROOT"] ?? process.cwd()
    this.constitutionSvc = new ConstitutionService(this.hermesRoot)
  }

  async verifyWorkspacePatch(proposal: PatchInput): Promise<VerificationResult> {
    const checks: VerificationCheck[] = []

    // A. Low-level patch safety (traversal, lock files, node_modules)
    checks.push(this.checkPatchPaths(proposal))

    // B. Constitution policy gate
    checks.push(this.checkConstitution(proposal))

    // C. TypeScript typecheck
    checks.push(this.checkTypecheck())

    // D. Smoke tests (fast, no API key required)
    checks.push(...this.checkSmokeTests())

    const passed = checks.every(c => c.passed)
    const failed = checks.filter(c => !c.passed)
    const summary = passed
      ? `All ${checks.length} check${checks.length === 1 ? "" : "s"} passed`
      : `${failed.length}/${checks.length} check${checks.length === 1 ? "" : "s"} failed: ${failed.map(c => c.name).join(", ")}`

    return { passed, checks, summary }
  }

  // ── A. Patch path safety ──────────────────────────────────────────────────

  private checkPatchPaths(proposal: PatchInput): VerificationCheck {
    if (proposal.patches.length === 0) {
      return {
        name: "patch.not-empty",
        passed: false,
        details: "Patch proposal contains no patches",
      }
    }

    const violations: string[] = []
    for (const { path: p } of proposal.patches) {
      if (p.includes("..")) {
        violations.push(`${p} (path traversal)`)
      } else if (p.includes("node_modules")) {
        violations.push(`${p} (node_modules)`)
      } else if (
        p === "pnpm-lock.yaml" ||
        p === "package-lock.json" ||
        p === "yarn.lock"
      ) {
        violations.push(`${p} (lock file)`)
      }
    }

    if (violations.length > 0) {
      return {
        name: "patch.safe-paths",
        passed: false,
        details: `Illegal paths: ${violations.join(", ")}`,
      }
    }

    return { name: "patch.safe-paths", passed: true }
  }

  // ── B. Constitution policy gate ──────────────────────────────────────────

  private checkConstitution(proposal: PatchInput): VerificationCheck {
    const result = this.constitutionSvc.evaluatePatch(proposal.patches)

    if (result.passed) {
      return { name: "constitution.check", passed: true }
    }

    const allIssues = [...result.violations, ...result.warnings]
    const details = allIssues
      .map(v => `[${v.ruleId}/${v.severity}] ${v.description}: ${v.path ?? "content"}`)
      .join(" | ")

    return { name: "constitution.check", passed: false, details }
  }

  // ── C. TypeScript typecheck ───────────────────────────────────────────────

  private checkTypecheck(): VerificationCheck {
    const result = spawnSync("pnpm", ["typecheck"], {
      cwd: this.hermesRoot,
      encoding: "utf8",
      timeout: 120_000,
      env: process.env,
    })

    if (result.error !== undefined) {
      return {
        name: "typecheck",
        passed: false,
        details: `Could not run pnpm typecheck: ${result.error.message}`,
      }
    }

    const passed = result.status === 0

    if (passed) return { name: "typecheck", passed: true }

    const raw = [result.stderr, result.stdout].filter(Boolean).join("\n")
    return {
      name: "typecheck",
      passed: false,
      details: raw.slice(0, 600) || "typecheck exited non-zero",
    }
  }

  // ── C. Smoke tests ────────────────────────────────────────────────────────

  private checkSmokeTests(): VerificationCheck[] {
    const pkgPath = join(this.hermesRoot, "package.json")
    if (!existsSync(pkgPath)) return []

    let scripts: Record<string, string> = {}
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>
      }
      scripts = pkg.scripts ?? {}
    } catch {
      return []
    }

    const targets = ["smoke:runtime", "smoke:events"] as const
    const checks: VerificationCheck[] = []

    for (const target of targets) {
      if (!(target in scripts)) continue
      const scriptCmd = scripts[target] ?? ""
      const tokens = scriptCmd.trim().split(/\s+/)
      const [cmd, ...args] = tokens
      if (cmd === undefined || cmd.length === 0) continue

      const result = spawnSync(cmd, args, {
        cwd: this.hermesRoot,
        encoding: "utf8",
        timeout: 90_000,
        env: process.env,
      })

      const passed = result.error === undefined && result.status === 0

      if (passed) {
        checks.push({ name: target, passed: true })
      } else {
        const raw = [result.stderr, result.stdout].filter(Boolean).join("\n")
        checks.push({
          name: target,
          passed: false,
          details: raw.slice(0, 400) || `${target} exited non-zero`,
        })
      }
    }

    return checks
  }
}

export function createVerificationService(hermesRoot?: string): VerificationService {
  return new VerificationService(hermesRoot)
}
