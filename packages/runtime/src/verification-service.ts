// =============================================================================
// VerificationService — pre-approval patch verification pipeline.
//
// Runs a series of checks before a patch is applied to the workspace:
//   A. Patch safety validation (paths, lock files, node_modules)
//   B. TypeScript typecheck (pnpm typecheck in hermesRoot)
//   C. Smoke tests — smoke:runtime and smoke:events if present in package.json
//
// All checks are synchronous under the hood (spawnSync); the public API is
// async to match the rest of the pipeline.
// =============================================================================

import { spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

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
// Minimal patch shape — avoids importing @hermes/workspace (DAG constraint)
// ---------------------------------------------------------------------------

interface PatchItem {
  path: string
}

interface PatchInput {
  patches: PatchItem[]
}

// ---------------------------------------------------------------------------
// VerificationService
// ---------------------------------------------------------------------------

export class VerificationService {
  private readonly hermesRoot: string

  constructor(hermesRoot?: string) {
    this.hermesRoot = hermesRoot ?? process.env["HERMES_ROOT"] ?? process.cwd()
  }

  async verifyWorkspacePatch(proposal: PatchInput): Promise<VerificationResult> {
    const checks: VerificationCheck[] = []

    // A. Patch safety
    checks.push(this.checkPatchPaths(proposal))

    // B. TypeScript typecheck
    checks.push(this.checkTypecheck())

    // C. Smoke tests (fast, no API key required)
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

  // ── B. TypeScript typecheck ───────────────────────────────────────────────

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
