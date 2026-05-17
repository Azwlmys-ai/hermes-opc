// =============================================================================
// @hermes/workspace-intelligence — Type definitions.
// Zero internal dependencies. No @hermes/* imports.
// =============================================================================

// ---------------------------------------------------------------------------
// Package index
// ---------------------------------------------------------------------------

/** Parsed package.json essentials for a single package in the monorepo. */
export interface PackageManifest {
  /** Package name from package.json, e.g. "@hermes/core" */
  name: string
  /** Absolute path to the package root directory */
  rootDir: string
  /** Relative path from repo root, e.g. "packages/core" */
  relativePath: string
  /** package.json version field */
  version: string
  /** Dependency map — package name → version range */
  dependencies: Record<string, string>
  /** Dev-dependency map — package name → version range */
  devDependencies: Record<string, string>
  /** Scripts defined in package.json */
  scripts: Record<string, string>
  /** Main entry file path (resolved relative to rootDir) */
  entryFile: string | null
  /** TypeScript source directory (relative to rootDir, detected or inferred) */
  srcDir: string | null
}

// ---------------------------------------------------------------------------
// Source file index
// ---------------------------------------------------------------------------

export interface ImportInfo {
  /** The raw specifier from the import statement, e.g. "@hermes/core" or "./types.js" */
  specifier: string
  /** Resolved absolute file path if resolvable within the workspace */
  resolvedPath: string | null
  /** Whether this is a type-only import */
  isTypeOnly: boolean
}

export interface ExportInfo {
  /** Name of the exported symbol */
  name: string
  /** Export kind */
  kind: "named" | "default" | "type" | "reexport"
  /** Whether this is a type-only export */
  isTypeOnly: boolean
}

export interface SymbolInfo {
  /** Symbol name as extracted from declaration */
  name: string
  /** Kind of declaration */
  kind: "class" | "function" | "interface" | "type" | "enum" | "variable"
  /** Line number of the declaration (1-based) */
  line: number
  /** Whether the symbol is exported */
  isExported: boolean
}

export interface SourceFileEntry {
  /** Absolute path to the .ts file */
  absolutePath: string
  /** Path relative to the repo root */
  relativePath: string
  /** Import statements found in the file */
  imports: ImportInfo[]
  /** Export declarations found in the file */
  exports: ExportInfo[]
  /** Top-level symbol declarations */
  symbols: SymbolInfo[]
  /** Which package owns this file (null if outside packages/) */
  owningPackage: string | null
}

// ---------------------------------------------------------------------------
// Repo graph nodes & edges
// ---------------------------------------------------------------------------

export interface PackageNode {
  manifest: PackageManifest
  /** Package names that this package depends on */
  dependencies: string[]
  /** Package names that depend on this package */
  dependents: string[]
}

export interface FileNode {
  sourceFile: SourceFileEntry
  /** Absolute paths of files that import this file */
  importedBy: string[]
  /** Absolute paths of files that this file imports */
  imports: string[]
}

// ---------------------------------------------------------------------------
// Patch context
// ---------------------------------------------------------------------------

export interface PatchContext {
  /** The target file or symbol that was queried */
  target: string
  /** Kind of target: "file" or "symbol" */
  targetKind: "file" | "symbol"
  /** Source file(s) containing the definition */
  definitionFiles: string[]
  /** Files that import the target file */
  importers: string[]
  /** Symbols exported by the target file */
  exportedSymbols: string[]
  /** The package that owns the target */
  packageOwner: PackageManifest | null
  /** Packages that depend on the owning package */
  dependentPackages: string[]
  /** Suggested typecheck command */
  typecheckCommand: string | null
  /** Suggested test command */
  testCommand: string | null
  /** All source files in the owning package */
  siblingFiles: string[]
}

// ---------------------------------------------------------------------------
// Service contracts
// ---------------------------------------------------------------------------

export interface IRepoIndex {
  /** Scan the repo root and discover all packages under packages/* */
  scan(): Promise<PackageManifest[]>
  /** Get a single package by name */
  getPackage(name: string): PackageManifest | null
  /** List all discovered package names */
  listPackages(): string[]
  /** Get a package by relative path (e.g. "packages/core") */
  getPackageByPath(relativePath: string): PackageManifest | null
}

export interface ISourceFileIndex {
  /** Scan all .ts files under the repo's packages/* and projects/* directories */
  scan(): Promise<SourceFileEntry[]>
  /** Get a single source file entry by absolute path */
  getFile(absolutePath: string): SourceFileEntry | null
  /** Find all source files that declare a given symbol name */
  findFilesBySymbol(symbol: string): SourceFileEntry[]
  /** Find all source files that import a given file path */
  findImporters(absolutePath: string): SourceFileEntry[]
}

export interface IRepoGraph {
  /** Build the full package + file graph from index data */
  build(): Promise<void>
  /** Get the package dependency DAG */
  getPackageDependencies(): Record<string, string[]>
  /** Get files that import a given file */
  getFileImporters(absolutePath: string): string[]
  /** Get files imported by a given file */
  getFileExports(absolutePath: string): ImportInfo[]
  /** Get runtime entry hints — likely entry points across the repo */
  getRuntimeEntryHints(): string[]
  /** Find the package that owns a file */
  findPackageForFile(absolutePath: string): PackageManifest | null
}

export interface IPatchContextBuilder {
  /** Build patch context for a target file path or symbol name */
  build(target: string): Promise<PatchContext | null>
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WorkspaceIntelligenceConfig {
  /** Absolute path to the repo root, e.g. "/Users/libo/opc" */
  repoRoot: string
  /** Subdirectory patterns to scan for source files (defaults to ["packages/*", "projects/*"]) */
  scanDirectories?: string[]
}