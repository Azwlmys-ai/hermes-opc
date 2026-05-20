// =============================================================================
// scripts/smoke-constitution.ts — Day 15: Constitution Layer Smoke
//
// Tests ConstitutionService in isolation and through the VerificationService
// pipeline. No LLM calls, no API key required.
//
// Sections:
//   1. ConstitutionService — rule evaluation in isolation
//       a. Legal patch passes all rules
//       b. .env modification rejected (CONST-001)
//       c. node_modules modification rejected (CONST-003)
//       d. Absolute path rejected (CONST-005, cross-workspace)
//       e. package.json empty-content rejected (CONST-006)
//       f. packages/core/src/kernel.ts elevated review (CONST-008)
//       g. Dangerous command in content rejected (CONST-010)
//   2. VerificationService pipeline includes constitution.check
//       a. Verify constitution.check appears in checks array
//       b. Illegal path → constitution.check failed, pipeline failed
//   3. ConstitutionService with no file — graceful pass
//   4. Multiple violations in one patch — all reported
//
// Run: pnpm smoke:constitution
// =============================================================================

import { join }  from "node:path"
import { ConstitutionService }  from "../packages/runtime/src/constitution-service.js"
import { VerificationService }  from "../packages/runtime/src/verification-service.js"
import type { ConstitutionResult } from "../packages/runtime/src/constitution-service.js"

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let passed = 0
let failed = 0

function pass(label: string): void {
  passed++
  console.log(`  ✓  ${label}`)
}

function fail(label: string, detail = ""): void {
  failed++
  console.error(`  ✗  ${label}${detail ? `\n       ${detail}` : ""}`)
}

function assert(condition: boolean, label: string, detail = ""): void {
  if (condition) pass(label)
  else           fail(label, detail)
}

function ruleIds(result: ConstitutionResult): string[] {
  return [...result.violations, ...result.warnings].map(v => v.ruleId)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log("\n══════════════════════════════════════════════════════")
  console.log("  Day 15 — Constitution Layer Smoke")
  console.log("══════════════════════════════════════════════════════\n")

  const ROOT  = process.env["HERMES_ROOT"] ?? process.cwd()
  const CONST = join(ROOT, "constitution", "opc.constitution.json")
  const svc   = new ConstitutionService(ROOT, CONST)

  // ── Section 1: ConstitutionService in isolation ────────────────────────────
  console.log("─── 1. ConstitutionService rule evaluation ───────────────────\n")

  // 1a. Legal patch — should pass all rules
  const legalResult = svc.evaluatePatch([
    { path: "src/feature/hello.ts", modifiedContent: "export const x = 1\n" },
    { path: "packages/agent/src/new-agent.ts", modifiedContent: "// new agent\n" },
  ])
  assert(legalResult.passed,                    "1a. Legal patch: passed = true")
  assert(legalResult.violations.length === 0,   "1a. Legal patch: no violations")
  assert(legalResult.warnings.length   === 0,   "1a. Legal patch: no warnings")
  assert(typeof legalResult.summary === "string", "1a. Legal patch: summary present")
  assert(legalResult.summary.includes("passed"), `1a. Legal patch: summary says passed (got: ${legalResult.summary})`)

  // 1b. .env modification — CONST-001
  const envResult = svc.evaluatePatch([
    { path: ".env", modifiedContent: "API_KEY=leaked\n" },
  ])
  assert(!envResult.passed,                       "1b. .env: passed = false")
  assert(ruleIds(envResult).includes("CONST-001"), "1b. .env: CONST-001 triggered")
  const envViolation = envResult.violations.find(v => v.ruleId === "CONST-001")
  assert(envViolation?.path === ".env",            "1b. .env: violation path is .env")
  assert(envViolation?.severity === "violation",   "1b. .env: severity = violation")

  // .env.local variant
  const envLocalResult = svc.evaluatePatch([{ path: ".env.local" }])
  assert(!envLocalResult.passed,                       "1b. .env.local: passed = false")
  assert(ruleIds(envLocalResult).includes("CONST-001"), "1b. .env.local: CONST-001 triggered")

  // Nested .env
  const nestedEnvResult = svc.evaluatePatch([{ path: "packages/config/.env" }])
  assert(!nestedEnvResult.passed,                       "1b. nested .env: passed = false")
  assert(ruleIds(nestedEnvResult).includes("CONST-001"), "1b. nested .env: CONST-001 triggered")

  // 1c. node_modules — CONST-003
  const nmResult = svc.evaluatePatch([
    { path: "node_modules/lodash/index.js", modifiedContent: "tampered" },
  ])
  assert(!nmResult.passed,                       "1c. node_modules: passed = false")
  assert(ruleIds(nmResult).includes("CONST-003"), "1c. node_modules: CONST-003 triggered")

  // Nested node_modules
  const nmNested = svc.evaluatePatch([{ path: "packages/core/node_modules/foo/bar.js" }])
  assert(!nmNested.passed,                       "1c. nested node_modules: passed = false")
  assert(ruleIds(nmNested).includes("CONST-003"), "1c. nested node_modules: CONST-003 triggered")

  // 1d. Absolute path (cross-workspace) — CONST-005
  const absResult = svc.evaluatePatch([
    { path: "/Users/libo/opc/projects/other-workspace/secret.ts" },
  ])
  assert(!absResult.passed,                       "1d. absolute path: passed = false")
  assert(ruleIds(absResult).includes("CONST-005"), "1d. absolute path: CONST-005 triggered")
  const absViolation = absResult.violations.find(v => v.ruleId === "CONST-005")
  assert(absViolation?.severity === "violation", "1d. absolute path: severity = violation")

  // 1e. Deletion of scaffold file — CONST-006
  const deleteResult = svc.evaluatePatch([
    { path: "package.json", modifiedContent: "" },
  ])
  assert(!deleteResult.passed,                        "1e. empty package.json: passed = false")
  assert(ruleIds(deleteResult).includes("CONST-006"),  "1e. empty package.json: CONST-006 triggered")

  // turbo.json deletion
  const turboResult = svc.evaluatePatch([
    { path: "turbo.json", modifiedContent: "   " },
  ])
  assert(!turboResult.passed,                        "1e. empty turbo.json: passed = false")
  assert(ruleIds(turboResult).includes("CONST-006"),  "1e. empty turbo.json: CONST-006 triggered")

  // Non-empty package.json modification hits CONST-007 (elevated_review), not CONST-006
  const modPkgResult = svc.evaluatePatch([
    { path: "package.json", modifiedContent: '{"name":"hermes","version":"0.2.0"}' },
  ])
  assert(!modPkgResult.passed,                        "1e. modified package.json: passed = false")
  assert(ruleIds(modPkgResult).includes("CONST-007"),  "1e. modified package.json: CONST-007 triggered")
  const pkgWarning = modPkgResult.warnings.find(v => v.ruleId === "CONST-007")
  assert(pkgWarning?.severity === "elevated_review",   "1e. modified package.json: severity = elevated_review")

  // 1f. packages/core/src/kernel.ts — CONST-008
  const kernelResult = svc.evaluatePatch([
    { path: "packages/core/src/kernel.ts", modifiedContent: "// change" },
  ])
  assert(!kernelResult.passed,                         "1f. kernel.ts: passed = false")
  assert(ruleIds(kernelResult).includes("CONST-008"),   "1f. kernel.ts: CONST-008 triggered")
  const kernelWarning = kernelResult.warnings.find(v => v.ruleId === "CONST-008")
  assert(kernelWarning?.severity === "elevated_review", "1f. kernel.ts: severity = elevated_review")
  assert(kernelWarning?.path === "packages/core/src/kernel.ts", "1f. kernel.ts: path recorded")

  // packages/runtime/src/verification-service.ts — CONST-009
  const vsSvcResult = svc.evaluatePatch([
    { path: "packages/runtime/src/verification-service.ts", modifiedContent: "// change" },
  ])
  assert(!vsSvcResult.passed,                          "1f. verification-service.ts: passed = false")
  assert(ruleIds(vsSvcResult).includes("CONST-009"),    "1f. verification-service.ts: CONST-009 triggered")

  // 1g. Dangerous command in content — CONST-010
  const dangerResult = svc.evaluatePatch([
    {
      path: "scripts/deploy.sh",
      modifiedContent: "#!/bin/bash\nrm -rf /\necho done",
    },
  ])
  assert(!dangerResult.passed,                          "1g. rm -rf /: passed = false")
  assert(ruleIds(dangerResult).includes("CONST-010"),    "1g. rm -rf /: CONST-010 triggered")
  const dangerViolation = dangerResult.violations.find(v => v.ruleId === "CONST-010")
  assert(dangerViolation?.severity === "violation",      "1g. rm -rf /: severity = violation")

  // sudo rm -rf variant
  const sudoResult = svc.evaluatePatch([
    { path: "Makefile", modifiedContent: "clean:\n\tsudo rm -rf node_modules\n" },
  ])
  assert(!sudoResult.passed,                            "1g. sudo rm -rf: passed = false")
  assert(ruleIds(sudoResult).includes("CONST-010"),      "1g. sudo rm -rf: CONST-010 triggered")

  // chmod -R 777 variant
  const chmodResult = svc.evaluatePatch([
    { path: "setup.sh", modifiedContent: "chmod -R 777 /var/www" },
  ])
  assert(!chmodResult.passed,                           "1g. chmod -R 777: passed = false")
  assert(ruleIds(chmodResult).includes("CONST-010"),     "1g. chmod -R 777: CONST-010 triggered")

  // ── Section 2: VerificationService pipeline ────────────────────────────────
  console.log("\n─── 2. VerificationService includes constitution.check ────────\n")

  const verifySvc = new VerificationService(ROOT)

  // 2a. Legal path — constitution.check passes
  const verLegal = await verifySvc.verifyWorkspacePatch({
    patches: [{ path: "src/utils.ts", modifiedContent: "export const util = 1\n" }],
  })
  const constitutionCheck = verLegal.checks.find(c => c.name === "constitution.check")
  assert(constitutionCheck !== undefined,          "2a. Legal: constitution.check present in checks")
  assert(constitutionCheck?.passed === true,       "2a. Legal: constitution.check passed")

  // Position: between patch.safe-paths and typecheck
  const checkNames = verLegal.checks.map(c => c.name)
  const patchIdx  = checkNames.indexOf("patch.safe-paths")
  const constIdx  = checkNames.indexOf("constitution.check")
  const tcIdx     = checkNames.indexOf("typecheck")
  assert(patchIdx !== -1,   "2a. patch.safe-paths in checks")
  assert(constIdx !== -1,   "2a. constitution.check in checks")
  assert(tcIdx    !== -1,   "2a. typecheck in checks")
  assert(patchIdx < constIdx && constIdx < tcIdx,
    `2a. Order: patch.safe-paths(${patchIdx}) < constitution.check(${constIdx}) < typecheck(${tcIdx})`,
  )

  // 2b. .env patch → constitution.check failed, pipeline failed
  const verEnv = await verifySvc.verifyWorkspacePatch({
    patches: [{ path: ".env", modifiedContent: "SECRET=exposed" }],
  })
  const envCheck = verEnv.checks.find(c => c.name === "constitution.check")
  assert(envCheck !== undefined,                         "2b. .env: constitution.check present")
  assert(envCheck?.passed === false,                     "2b. .env: constitution.check failed")
  assert(verEnv.passed === false,                        "2b. .env: overall pipeline failed")
  assert(typeof envCheck?.details === "string",          "2b. .env: details string present")
  assert(envCheck?.details?.includes("CONST-001") === true,
    `2b. .env: details contain CONST-001 (got: ${envCheck?.details ?? "undefined"})`,
  )

  // 2c. kernel.ts patch → constitution.check failed (elevated_review)
  const verKernel = await verifySvc.verifyWorkspacePatch({
    patches: [{ path: "packages/core/src/kernel.ts", modifiedContent: "// modified" }],
  })
  const kernCheck = verKernel.checks.find(c => c.name === "constitution.check")
  assert(kernCheck?.passed === false,   "2c. kernel.ts: constitution.check failed")
  assert(verKernel.passed === false,    "2c. kernel.ts: pipeline failed")
  assert(kernCheck?.details?.includes("CONST-008") === true,
    `2c. kernel.ts: details contain CONST-008 (got: ${kernCheck?.details ?? "undefined"})`,
  )

  // ── Section 3: No constitution file — graceful pass ────────────────────────
  console.log("\n─── 3. No constitution file — graceful pass ──────────────────\n")

  const noFileSvc = new ConstitutionService(ROOT, "/nonexistent/path/const.json")
  const noFileResult = noFileSvc.evaluatePatch([
    { path: ".env", modifiedContent: "SUPER_SECRET=yes" },
  ])
  assert(noFileResult.passed,                "3. No file: passed = true (no rules)")
  assert(noFileResult.violations.length === 0, "3. No file: no violations")
  assert(noFileResult.warnings.length   === 0, "3. No file: no warnings")
  assert(
    noFileResult.summary.includes("No constitution") === true,
    `3. No file: summary mentions no constitution (got: ${noFileResult.summary})`,
  )

  // ── Section 4: Multiple violations in one patch ────────────────────────────
  console.log("\n─── 4. Multiple violations in a single patch ─────────────────\n")

  // Path triggers CONST-001 (.env) AND content triggers CONST-010 (rm -rf /)
  const multiResult = svc.evaluatePatch([
    { path: ".env", modifiedContent: "rm -rf /\nSECRET=yes" },
  ])
  assert(!multiResult.passed,                         "4. Multi: passed = false")
  // CONST-001 for path, CONST-010 for content
  assert(ruleIds(multiResult).includes("CONST-001"),   "4. Multi: CONST-001 in violations")
  assert(ruleIds(multiResult).includes("CONST-010"),   "4. Multi: CONST-010 in violations")
  assert(
    [...multiResult.violations, ...multiResult.warnings].length >= 2,
    `4. Multi: ≥ 2 issues found (got ${[...multiResult.violations, ...multiResult.warnings].length})`,
  )

  // ── Section 5: Summary field quality ──────────────────────────────────────
  console.log("\n─── 5. Summary field quality ─────────────────────────────────\n")

  assert(
    legalResult.summary.includes("passed"),
    `5. Legal summary says "passed" (got: ${legalResult.summary})`,
  )
  assert(
    envResult.summary.includes("failed"),
    `5. Violation summary says "failed" (got: ${envResult.summary})`,
  )
  assert(
    envResult.summary.includes("CONST-001"),
    `5. Violation summary includes rule ID (got: ${envResult.summary})`,
  )

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log("\n══════════════════════════════════════════════════════")
  console.log(`  Smoke complete: ${passed} passed, ${failed} failed`)
  console.log("══════════════════════════════════════════════════════\n")

  if (failed > 0) process.exit(1)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
