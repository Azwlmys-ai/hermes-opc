// =============================================================================
// @hermes/workspace-intelligence — RepoIndex
// Scans packages/* and reads each package.json to build PackageManifest records.
// Zero internal @hermes/* dependencies.
// =============================================================================

import { readFile, readdir, access } from "node:fs/promises"
import { join, relative } from "node:path"
import type { PackageManifest, IRepoIndex, WorkspaceIntelligenceConfig } from "./types.js"

interface PackageJsonFields {
  name?: string
  version?: string
  main?: string
  types?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  scripts?: Record<string, string>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RepoIndex implements IRepoIndex {
  private readonly repoRoot: string
  private packages: Map<string, PackageManifest> = new Map()
  private scanned = false

  constructor(config: WorkspaceIntelligenceConfig) {
    this.repoRoot = config.repoRoot
  }

  async scan(): Promise<PackageManifest[]> {
    if (this.scanned) return Array.from(this.packages.values())
    this.scanned = true

    const packagesDir = join(this.repoRoot, "packages")
    const dirs = await readdirSafe(packagesDir)

    const manifests: PackageManifest[] = []

    for (const dirName of dirs) {
      const rootDir = join(packagesDir, dirName)
      const pkgJsonPath = join(rootDir, "package.json")

      try {
        await access(pkgJsonPath)
      } catch {
        continue // skip directories without package.json
      }

      const raw = await readFile(pkgJsonPath, "utf-8")
      let parsed: PackageJsonFields
      try {
        parsed = JSON.parse(raw) as PackageJsonFields
      } catch {
        continue // skip invalid JSON
      }

      const name = parsed.name ?? dirName
      const version = parsed.version ?? "0.0.0"
      const dependencies = parsed.dependencies ?? {}
      const devDependencies = parsed.devDependencies ?? {}
      const scripts = parsed.scripts ?? {}
      const relativePath = relative(this.repoRoot, rootDir)

      let entryFile: string | null = null
      if (parsed.main) {
        // Resolve relative to rootDir
        const resolved = join(rootDir, parsed.main)
        entryFile = resolved
      }

      // Detect src directory
      let srcDir: string | null = null
      const candidateSrc = join(rootDir, "src")
      try {
        await access(candidateSrc)
        srcDir = relative(rootDir, "src")
      } catch {
        srcDir = null
      }

      const manifest: PackageManifest = {
        name,
        rootDir,
        relativePath,
        version,
        dependencies,
        devDependencies,
        scripts,
        entryFile,
        srcDir,
      }

      manifests.push(manifest)
      this.packages.set(name, manifest)
      this.packages.set(relativePath, manifest)
    }

    return manifests
  }

  getPackage(name: string): PackageManifest | null {
    return this.packages.get(name) ?? null
  }

  listPackages(): string[] {
    return Array.from(this.packages.entries())
      .filter(([key]) => key.startsWith("@"))
      .map(([key]) => key)
  }

  getPackageByPath(relativePath: string): PackageManifest | null {
    return this.packages.get(relativePath) ?? null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readdirSafe(dirPath: string): Promise<string[]> {
  try {
    await access(dirPath)
  } catch {
    return []
  }
  const entries = await readdir(dirPath, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}