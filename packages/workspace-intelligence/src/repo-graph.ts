// =============================================================================
// @hermes/workspace-intelligence — RepoGraph
// Builds package dependency DAG and file import graph from RepoIndex + SourceFileIndex.
// Zero internal @hermes/* dependencies.
// =============================================================================

import type {
  PackageManifest,
  SourceFileEntry,
  ImportInfo,
  IRepoGraph,
  IRepoIndex,
  ISourceFileIndex,
} from "./types.js"

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class RepoGraph implements IRepoGraph {
  private readonly repoIndex: IRepoIndex
  private readonly sourceFileIndex: ISourceFileIndex

  /** Package name → list of package names it depends on */
  private packageDeps: Record<string, string[]> = {}
  /** Absolute file path → list of absolute file paths that import it */
  private fileImporters: Map<string, string[]> = new Map()
  /** Absolute file path → list of import info exported by it */
  private fileImports: Map<string, ImportInfo[]> = new Map()
  /** Absolute path → owning package manifest */
  private filePackage: Map<string, PackageManifest> = new Map()

  private built = false

  constructor(repoIndex: IRepoIndex, sourceFileIndex: ISourceFileIndex) {
    this.repoIndex = repoIndex
    this.sourceFileIndex = sourceFileIndex
  }

  async build(): Promise<void> {
    if (this.built) return
    this.built = true

    // Ensure both indexes are scanned
    const packages = await this.repoIndex.scan()
    const files = await this.sourceFileIndex.scan()

    // 1. Build package dependency graph
    this.buildPackageDeps(packages)

    // 2. Build file-level import graph
    this.buildFileGraph(files, packages)
  }

  private buildPackageDeps(packages: PackageManifest[]): void {
    // Create a lookup: package name → manifest
    const nameMap = new Map<string, PackageManifest>()
    for (const pkg of packages) {
      nameMap.set(pkg.name, pkg)
    }

    for (const pkg of packages) {
      const deps: string[] = []

      // Check all dependencies if they match any known package
      for (const depName of Object.keys(pkg.dependencies)) {
        if (nameMap.has(depName)) {
          deps.push(depName)
        }
      }

      this.packageDeps[pkg.name] = deps
    }
  }

  private buildFileGraph(files: SourceFileEntry[], packages: PackageManifest[]): void {
    // Build package lookup by relative path
    const packageByPath = new Map<string, PackageManifest>()
    for (const pkg of packages) {
      packageByPath.set(pkg.relativePath, pkg)
    }

    // Initialize file → package mapping
    for (const file of files) {
      if (file.owningPackage) {
        const pkg = packageByPath.get(file.owningPackage)
        if (pkg) {
          this.filePackage.set(file.absolutePath, pkg)
        } else {
          // Try to look up by path
          const pathPkg = this.repoIndex.getPackageByPath(file.owningPackage)
          if (pathPkg) {
            this.filePackage.set(file.absolutePath, pathPkg)
          }
        }
      }
    }

    // Build reverse index: each file → list of importers
    for (const file of files) {
      for (const imp of file.imports) {
        if (!imp.resolvedPath) continue

        const importers = this.fileImporters.get(imp.resolvedPath)
        if (importers) {
          importers.push(file.absolutePath)
        } else {
          this.fileImporters.set(imp.resolvedPath, [file.absolutePath])
        }
      }

      // Store forward imports
      this.fileImports.set(file.absolutePath, file.imports)
    }
  }

  getPackageDependencies(): Record<string, string[]> {
    return { ...this.packageDeps }
  }

  getFileImporters(absolutePath: string): string[] {
    return this.fileImporters.get(absolutePath) ?? []
  }

  getFileExports(absolutePath: string): ImportInfo[] {
    return this.fileImports.get(absolutePath) ?? []
  }

  getRuntimeEntryHints(): string[] {
    const hints: string[] = []

    // Look for files that are imported by many other files (likely common libs)
    // Identify entry points: files in packages/*/src/index.ts, main.ts, or server.ts
    for (const [absPath] of this.fileImports) {
      if (
        absPath.endsWith("/index.ts") ||
        absPath.endsWith("/main.ts") ||
        absPath.endsWith("/server.ts")
      ) {
        hints.push(absPath)
      }
    }

    // Also find scripts/ files
    for (const [absPath] of this.fileImports) {
      if (absPath.includes("/scripts/") && absPath.endsWith(".ts")) {
        hints.push(absPath)
      }
    }

    return hints
  }

  findPackageForFile(absolutePath: string): PackageManifest | null {
    return this.filePackage.get(absolutePath) ?? null
  }
}