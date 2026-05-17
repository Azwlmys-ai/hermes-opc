// =============================================================================
// @hermes/workspace-intelligence — SourceFileIndex
// Scans .ts files under packages/* and projects/*, extracting imports, exports,
// and top-level symbol declarations via regex (no TypeScript compiler API dependency).
// =============================================================================

import { readFile, readdir, access } from "node:fs/promises"
import { join, relative, dirname, extname } from "node:path"
import type {
  SourceFileEntry,
  ImportInfo,
  ExportInfo,
  SymbolInfo,
  ISourceFileIndex,
  WorkspaceIntelligenceConfig,
} from "./types.js"

// ---------------------------------------------------------------------------
// Regex patterns
// ---------------------------------------------------------------------------

const IMPORT_RE =
  // Matches: import ... from "..." or import "..." or const x = await import("...")
  /(?:import\s+(?:type\s+)?(?:[\w*,\s{}]+)\s+from\s+['"]([^'"]+)['"]|import\s+['"]([^'"]+)['"])/g

const EXPORT_RE =
  // Matches: export { ... }, export default ..., export const/function/class/interface/type/enum
  /export\s+(?:(default\s+)?(?:(?:const|let|var|function|class|interface|type|enum)\s+)?(\w+)|(\*\s+from\s+['"]([^'"]+)['"])|\{([^}]*)\})/g

const EXPORT_TYPE_RE =
  /export\s+type\s+\{([^}]*)\}/g

const DECLARATION_RE =
  // Matches top-level declarations
  /^export\s+(?:const|let|var)\s+(\w+)/gm

// Symbols we track: class, function, interface, type, enum, variable
const CLASS_RE = /^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/gm
const FUNC_RE = /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm
const IFACE_RE = /^(?:export\s+)?interface\s+(\w+)/gm
const TYPE_RE = /^(?:export\s+)?type\s+(\w+)/gm
const ENUM_RE = /^(?:export\s+)?enum\s+(\w+)/gm
const VAR_RE = /^(?:export\s+)?(?:const|let|var)\s+(\w+)/gm

// Comment stripping
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT_RE = /\/\/.*$/gm

// ---------------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------------

/** Map of source file relative path → absolute path, built during scan */
type ResolveMap = Map<string, string>

function resolveImportSpecifier(
  specifier: string,
  importerAbsolutePath: string,
  resolveMap: ResolveMap,
): string | null {
  // Only try to resolve relative imports
  if (!specifier.startsWith(".")) return null

  const importerDir = dirname(importerAbsolutePath)
  let candidate = join(importerDir, specifier)

  // If the path already has an extension, check it directly
  if (extname(candidate)) {
    if (resolveMap.has(candidate)) return candidate
    // Try .ts variant
    const tsVariant = candidate.replace(/\.[^./]+$/, ".ts")
    if (resolveMap.has(tsVariant)) return tsVariant
    return null
  }

  // Try extensions in order
  for (const ext of [".ts", ".js", "/index.ts", "/index.js"]) {
    const withExt = candidate + ext
    if (resolveMap.has(withExt)) return withExt
  }
  return null
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SourceFileIndex implements ISourceFileIndex {
  private readonly repoRoot: string
  private readonly scanDirs: string[]
  private files: Map<string, SourceFileEntry> = new Map()
  private scanned = false

  constructor(config: WorkspaceIntelligenceConfig) {
    this.repoRoot = config.repoRoot
    this.scanDirs = config.scanDirectories ?? ["packages", "projects"]
  }

  async scan(): Promise<SourceFileEntry[]> {
    if (this.scanned) return Array.from(this.files.values())
    this.scanned = true

    // Phase 1: discover all .ts files and build a resolve map
    const allTsFiles: string[] = []
    for (const scanDir of this.scanDirs) {
      const dirPath = join(this.repoRoot, scanDir)
      const found = await discoverTsFiles(dirPath)
      allTsFiles.push(...found)
    }

    // Also scan scripts/ directory
    const scriptsDir = join(this.repoRoot, "scripts")
    const scriptFiles = await discoverTsFiles(scriptsDir)
    allTsFiles.push(...scriptFiles)

    // Build resolve map: relative path → absolute path
    const resolveMap: ResolveMap = new Map()
    for (const absPath of allTsFiles) {
      resolveMap.set(absPath, absPath)
    }

    // Phase 2: parse each file
    const entries: SourceFileEntry[] = []
    for (const absPath of allTsFiles) {
      const entry = await parseSourceFile(absPath, this.repoRoot, resolveMap)
      entries.push(entry)
      this.files.set(absPath, entry)
    }

    return entries
  }

  getFile(absolutePath: string): SourceFileEntry | null {
    return this.files.get(absolutePath) ?? null
  }

  findFilesBySymbol(symbol: string): SourceFileEntry[] {
    const result: SourceFileEntry[] = []
    for (const [, file] of this.files) {
      for (const sym of file.symbols) {
        if (sym.name === symbol) {
          result.push(file)
          break
        }
      }
    }
    return result
  }

  findImporters(absolutePath: string): SourceFileEntry[] {
    const result: SourceFileEntry[] = []
    for (const [, file] of this.files) {
      for (const imp of file.imports) {
        if (imp.resolvedPath === absolutePath) {
          result.push(file)
          break
        }
      }
    }
    return result
  }
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

async function discoverTsFiles(dirPath: string): Promise<string[]> {
  const results: string[] = []
  try {
    await access(dirPath)
  } catch {
    return results
  }

  const entries = await readdir(dirPath, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name)
    // Skip node_modules and dist
    if (entry.name === "node_modules" || entry.name === "dist") continue
    if (entry.isDirectory()) {
      const nested = await discoverTsFiles(fullPath)
      results.push(...nested)
    } else if (entry.isFile() && (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx"))) {
      results.push(fullPath)
    }
  }
  return results
}

// ---------------------------------------------------------------------------
// Source file parsing
// ---------------------------------------------------------------------------

async function parseSourceFile(
  absolutePath: string,
  repoRoot: string,
  resolveMap: ResolveMap,
): Promise<SourceFileEntry> {
  const relativePath = relative(repoRoot, absolutePath)
  let content: string
  try {
    content = await readFile(absolutePath, "utf-8")
  } catch {
    // Skip unreadable files
    return {
      absolutePath,
      relativePath,
      imports: [],
      exports: [],
      symbols: [],
      owningPackage: null,
    }
  }

  // Determine owning package
  const owningPackage = determineOwningPackage(relativePath)

  // Parse imports
  const imports = parseImports(content, absolutePath, resolveMap)

  // Parse exports
  const exports = parseExports(content)

  // Parse symbols
  const symbols = parseSymbols(content)

  return {
    absolutePath,
    relativePath,
    imports,
    exports,
    symbols,
    owningPackage,
  }
}

function determineOwningPackage(relativePath: string): string | null {
  // e.g. "packages/core/src/kernel.ts" → "packages/core"
  if (!relativePath.startsWith("packages/")) return null
  const parts = relativePath.split("/")
  if (parts.length < 2) return null
  return `${parts[0]}/${parts[1]}`
}

// ---------------------------------------------------------------------------
// Import parsing
// ---------------------------------------------------------------------------

function parseImports(
  content: string,
  importerPath: string,
  resolveMap: ResolveMap,
): ImportInfo[] {
  // Strip comments
  const stripped = content.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "")

  const imports: ImportInfo[] = []
  const seen = new Set<string>()

  for (const match of stripped.matchAll(IMPORT_RE)) {
    const specifier = match[1] ?? match[2]
    if (!specifier || seen.has(specifier)) continue
    seen.add(specifier)

    const isTypeOnly = /import\s+type\s/.test(match[0])
    const resolvedPath = resolveImportSpecifier(specifier, importerPath, resolveMap)

    imports.push({ specifier, resolvedPath, isTypeOnly })
  }

  return imports
}

// ---------------------------------------------------------------------------
// Export parsing
// ---------------------------------------------------------------------------

function parseExports(content: string): ExportInfo[] {
  const stripped = content.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "")
  const exports: ExportInfo[] = []
  const seen = new Set<string>()

  // Match "export const/function/class/interface/type/enum NAME"
  const declRe = /export\s+(?:default\s+)?(?:const|let|var|function|async\s+function|class|interface|type|enum)\s+(\w+)/g
  for (const match of stripped.matchAll(declRe)) {
    const name = match[1]
    if (!name || seen.has(name)) continue
    seen.add(name)
    const isDefault = /export\s+default/.test(match[0])
    exports.push({
      name,
      kind: isDefault ? "default" : "named",
      isTypeOnly: /export\s+type\s/.test(match[0]),
    })
  }

  // Match "export { ... }" named exports
  const namedRe = /export\s+(?:type\s+)?\{([^}]+)\}/g
  for (const match of stripped.matchAll(namedRe)) {
    const isTypeOnly = /export\s+type\s/.test(match[0])
    const names = match[1]!.split(",").map((n) => n.trim().replace(/\s+as\s+.*/, "").trim())
    for (const name of names) {
      if (!name || seen.has(name)) continue
      seen.add(name)
      exports.push({ name, kind: "named", isTypeOnly })
    }
  }

  // Match "export * from '...'" re-exports
  const starRe = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g
  for (const match of stripped.matchAll(starRe)) {
    const from = match[1]
    if (!from || seen.has(`*:${from}`)) continue
    seen.add(`*:${from}`)
    exports.push({ name: `* from '${from}'`, kind: "reexport", isTypeOnly: false })
  }

  return exports
}

// ---------------------------------------------------------------------------
// Symbol parsing
// ---------------------------------------------------------------------------

function parseSymbols(content: string): SymbolInfo[] {
  const lines = content.split("\n")
  const stripped = content.replace(BLOCK_COMMENT_RE, "").replace(LINE_COMMENT_RE, "")
  const symbols: SymbolInfo[] = []
  const seen = new Set<string>()

  const patterns: Array<{ regex: RegExp; kind: SymbolInfo["kind"] }> = [
    { regex: new RegExp(CLASS_RE.source, CLASS_RE.flags), kind: "class" },
    { regex: new RegExp(FUNC_RE.source, FUNC_RE.flags), kind: "function" },
    { regex: new RegExp(IFACE_RE.source, IFACE_RE.flags), kind: "interface" },
    { regex: new RegExp(TYPE_RE.source, TYPE_RE.flags), kind: "type" },
    { regex: new RegExp(ENUM_RE.source, ENUM_RE.flags), kind: "enum" },
    { regex: new RegExp(VAR_RE.source, VAR_RE.flags), kind: "variable" },
  ]

  for (const { regex, kind } of patterns) {
    // Reset lastIndex since we clone
    const re = new RegExp(regex.source, regex.flags)
    for (const match of stripped.matchAll(re)) {
      const name = match[1]
      if (!name || seen.has(name)) continue
      seen.add(name)
      const isExported = /^export\s/.test(
        lines.slice(Math.max(0, (match.index ?? 0) > 0 ? 0 : 0)).join("\n").substring(0, 200)
      ) || match[0].startsWith("export")

      // Find line number
      const beforeMatch = content.substring(0, match.index)
      const line = (beforeMatch.match(/\n/g)?.length ?? 0) + 1

      symbols.push({ name, kind, line, isExported })
    }
  }

  return symbols
}