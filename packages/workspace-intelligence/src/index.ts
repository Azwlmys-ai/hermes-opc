// =============================================================================
// @hermes/workspace-intelligence — Public API
// =============================================================================

// Types
export type {
  PackageManifest,
  ImportInfo,
  ExportInfo,
  SymbolInfo,
  SourceFileEntry,
  PackageNode,
  FileNode,
  PatchContext,
  IRepoIndex,
  ISourceFileIndex,
  IRepoGraph,
  IPatchContextBuilder,
  WorkspaceIntelligenceConfig,
} from "./types.js"

// Implementations
export { RepoIndex } from "./repo-index.js"
export { SourceFileIndex } from "./source-file-index.js"
export { RepoGraph } from "./repo-graph.js"
export { PatchContextBuilder } from "./patch-context-builder.js"

// Convenience: create a complete Workspace Intelligence instance
import { RepoIndex } from "./repo-index.js"
import { SourceFileIndex } from "./source-file-index.js"
import { RepoGraph } from "./repo-graph.js"
import { PatchContextBuilder } from "./patch-context-builder.js"
import type {
  WorkspaceIntelligenceConfig,
  IRepoIndex,
  ISourceFileIndex,
  IRepoGraph,
  IPatchContextBuilder,
} from "./types.js"

export interface WorkspaceIntelligence {
  repoIndex: IRepoIndex
  sourceFileIndex: ISourceFileIndex
  repoGraph: IRepoGraph
  patchContextBuilder: IPatchContextBuilder
}

export function createWorkspaceIntelligence(
  config: WorkspaceIntelligenceConfig,
): WorkspaceIntelligence {
  const repoIndex = new RepoIndex(config)
  const sourceFileIndex = new SourceFileIndex(config)
  const repoGraph = new RepoGraph(repoIndex, sourceFileIndex)
  const patchContextBuilder = new PatchContextBuilder(repoIndex, sourceFileIndex, repoGraph)

  return {
    repoIndex,
    sourceFileIndex,
    repoGraph,
    patchContextBuilder,
  }
}