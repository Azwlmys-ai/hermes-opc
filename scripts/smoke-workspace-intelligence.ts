#!/usr/bin/env tsx
// =============================================================================
// Smoke test for @hermes/workspace-intelligence
// Validates: repo scanning, package discovery, symbol resolution, import graph,
// patch context building.
// =============================================================================

const OPC_ROOT = process.env.HERMES_ROOT ?? "/Users/libo/opc"

async function main() {
  const { createWorkspaceIntelligence } = await import(
    "../packages/workspace-intelligence/src/index.js"
  )
  console.log("=== OPC Workspace Intelligence Smoke Test ===\n")
  console.log(`Repo root: ${OPC_ROOT}\n`)

  const wi = createWorkspaceIntelligence({ repoRoot: OPC_ROOT })

  // ── 1. RepoIndex: scan packages ────────────────────────────────────────
  console.log("── 1. RepoIndex: Scanning packages ──")
  const packages = await wi.repoIndex.scan()
  console.log(`  Found ${packages.length} packages:`)
  for (const pkg of packages) {
    console.log(`    @${pkg.name} → ${pkg.relativePath}`)
    console.log(`      deps: ${Object.keys(pkg.dependencies).join(", ") || "(none)"}`)
    console.log(`      entry: ${pkg.entryFile ?? "(none)"}`)
  }

  // Verify key packages exist
  const requiredPackages = [
    "@hermes/core",
    "@hermes/agent",
    "@hermes/workspace",
    "@hermes/runtime",
    "@hermes/memory",
    "@hermes/provider",
    "@hermes/mcp-server",
    "@hermes/workspace-intelligence",
  ]

  console.log("\n  Package existence check:")
  let allPkgsFound = true
  for (const name of requiredPackages) {
    const found = wi.repoIndex.getPackage(name) !== null
    console.log(`    ${found ? "✅" : "❌"} ${name}`)
    if (!found) allPkgsFound = false
  }

  // ── 2. SourceFileIndex: scan .ts files ─────────────────────────────────
  console.log("\n── 2. SourceFileIndex: Scanning .ts files ──")
  const files = await wi.sourceFileIndex.scan()
  console.log(`  Found ${files.length} .ts files`)
  const filesWithImports = files.filter((f) => f.imports.length > 0)
  const filesWithExports = files.filter((f) => f.exports.length > 0)
  const filesWithSymbols = files.filter((f) => f.symbols.length > 0)
  console.log(`  With imports: ${filesWithImports.length}`)
  console.log(`  With exports: ${filesWithExports.length}`)
  console.log(`  With symbols: ${filesWithSymbols.length}`)

  // ── 3. RepoGraph: build graph ────────────────────────────────────────
  console.log("\n── 3. RepoGraph: Building graphs ──")
  await wi.repoGraph.build()

  const packageDeps = wi.repoGraph.getPackageDependencies()
  console.log("  Package dependency DAG:")
  for (const [pkg, deps] of Object.entries(packageDeps)) {
    console.log(`    ${pkg} → [${deps.join(", ") || "(none)"}]`)
  }

  // ── 4. Symbol search ──────────────────────────────────────────────────
  console.log("\n── 4. Symbol search ──")
  const keySymbols = ["IKernel", "RuntimeService", "RepoIndex", "BaseAgent", "IWorkspaceService"]
  for (const sym of keySymbols) {
    const found = wi.sourceFileIndex.findFilesBySymbol(sym)
    console.log(`  ${found.length > 0 ? "✅" : "❌"} Symbol "${sym}" — ${found.length} file(s):`)
    for (const f of found) {
      console.log(`      ${f.relativePath}`)
    }
  }

  // ── 5. Importers lookup ───────────────────────────────────────────────
  console.log("\n── 5. Importers lookup ──")
  // Find kernel.ts absolute path
  const kernelFile = files.find((f) => f.relativePath.endsWith("core/src/kernel.ts"))
  if (kernelFile) {
    const importers = wi.repoGraph.getFileImporters(kernelFile.absolutePath)
    console.log(`  File: ${kernelFile.relativePath}`)
    console.log(`  Imported by (${importers.length} files):`)
    for (const imp of importers) {
      // Show relative path
      const rel = imp.replace(OPC_ROOT + "/", "")
      console.log(`    → ${rel}`)
    }
  }

  // ── 6. Runtime entry hints ────────────────────────────────────────────
  console.log("\n── 6. Runtime entry hints ──")
  const hints = wi.repoGraph.getRuntimeEntryHints()
  console.log(`  Found ${hints.length} entry hints:`)
  for (const hint of hints) {
    const rel = hint.replace(OPC_ROOT + "/", "")
    console.log(`    → ${rel}`)
  }

  // ── 7. PatchContext for a file ─────────────────────────────────────────
  console.log("\n── 7. PatchContext (file target) ──")
  if (kernelFile) {
    const ctx = await wi.patchContextBuilder.build(kernelFile.absolutePath)
    if (ctx) {
      console.log(`  Target: ${ctx.target}`)
      console.log(`  Kind: ${ctx.targetKind}`)
      console.log(`  Package owner: ${ctx.packageOwner?.name ?? "(none)"}`)
      console.log(`  Exported symbols: [${ctx.exportedSymbols.join(", ")}]`)
      console.log(`  Importers: ${ctx.importers.length}`)
      console.log(`  Dependent packages: [${ctx.dependentPackages.join(", ") || "(none)"}]`)
      console.log(`  Typecheck: ${ctx.typecheckCommand ?? "(none)"}`)
      console.log(`  Test: ${ctx.testCommand ?? "(none)"}`)
      console.log(`  Sibling files: ${ctx.siblingFiles.length}`)
    } else {
      console.log("  ❌ Could not build PatchContext")
    }
  }

  // ── 8. PatchContext for a symbol ───────────────────────────────────────
  console.log("\n── 8. PatchContext (symbol target) ──")
  const ctx = await wi.patchContextBuilder.build("BaseAgent")
  if (ctx) {
    console.log(`  Target: ${ctx.target}`)
    console.log(`  Kind: ${ctx.targetKind}`)
    console.log(`  Definition files: ${ctx.definitionFiles.length}`)
    for (const f of ctx.definitionFiles) {
      console.log(`    → ${f.replace(OPC_ROOT + "/", "")}`)
    }
    console.log(`  Package owner: ${ctx.packageOwner?.name ?? "(none)"}`)
    console.log(`  Importers: ${ctx.importers.length}`)
  } else {
    console.log("  ⚠️  No definition found for BaseAgent (may be unresolvable)")
  }

  // ── 9. No cycle check (basic) ────────────────────────────────────────
  console.log("\n── 9. Cycle check (basic) ──")
  let hasCycle = false
  for (const [pkg, deps] of Object.entries(packageDeps)) {
    for (const dep of deps) {
      const depDeps = packageDeps[dep]
      if (depDeps?.includes(pkg)) {
        console.log(`  ❌ Cycle detected: ${pkg} ↔ ${dep}`)
        hasCycle = true
      }
    }
  }
  if (!hasCycle) {
    console.log("  ✅ No direct cycles detected")
  }

  // ── 10. Scope check ──────────────────────────────────────────────────
  console.log("\n── 10. Scope check ──")
  let outsideFileCount = 0
  for (const file of files) {
    if (!file.absolutePath.startsWith(OPC_ROOT)) {
      console.log(`  ❌ File outside repo root: ${file.absolutePath}`)
      outsideFileCount++
    }
  }
  if (outsideFileCount === 0) {
    console.log("  ✅ All files within repo root")
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log("\n=== Summary ===")
  console.log(`  Packages found: ${packages.length} / ${requiredPackages.length} required`)
  console.log(`  .ts files indexed: ${files.length}`)
  console.log(`  Symbols indexed: ${filesWithSymbols.length} files`)
  console.log(`  Package DAG entries: ${Object.keys(packageDeps).length}`)
  console.log(`  Entry hints: ${hints.length}`)
  console.log(`  Cycles: ${hasCycle ? "YES ❌" : "None ✅"}`)
  console.log(`  Scope breach: ${outsideFileCount > 0 ? "YES ❌" : "None ✅"}`)

  const allPassed = allPkgsFound && !hasCycle && outsideFileCount === 0
  console.log(`\n  Overall: ${allPassed ? "PASSED ✅" : "FAILED ❌"}`)
  process.exit(allPassed ? 0 : 1)
}

main().catch((err) => {
  console.error("Smoke test failed:", err)
  process.exit(1)
})