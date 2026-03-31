/**
 * Types for the .colony/ repo configuration convention.
 */

import type { EnvironmentTemplate, QuickPrompt } from './types'

/** Parsed .colony/config.yaml */
export interface ColonyProjectConfig {
  name: string
  description?: string
  projectType?: string
  defaultWorkingDirectory?: string
  settings?: Record<string, string>
  repos?: Array<{ owner: string; name: string; as: string }>
}

/** A pipeline definition from .colony/pipelines/ */
export interface RepoPipelineDef {
  name: string
  description?: string
  enabled?: boolean
  trigger: Record<string, any>
  condition?: Record<string, any>
  action: Record<string, any>
  dedup?: Record<string, any>
}

/** The full parsed representation of a .colony/ directory */
export interface RepoColonyConfig {
  /** Absolute path to repo root (parent of .colony/) */
  repoPath: string

  /** Repo identity — "owner/name" or derived from git remote */
  repoSlug: string

  /** .colony/config.yaml contents */
  config: ColonyProjectConfig | null

  /** .colony/templates/*.yaml — parsed into EnvironmentTemplate[] */
  templates: (EnvironmentTemplate & { source: string })[]

  /** .colony/pipelines/*.yaml — raw pipeline defs */
  pipelines: (RepoPipelineDef & { source: string; fileName: string })[]

  /** .colony/prompts/*.yaml — parsed QuickPrompt[] */
  prompts: (QuickPrompt & { source: string })[]

  /** .colony/context.md — raw string */
  context: string | null

  /** Content hashes for security tracking */
  hashes: {
    pipelines: Record<string, string>  // fileName -> sha256
    templates: Record<string, string>
  }
}

/** Cache entry with mtime tracking */
export interface CachedRepoConfig {
  config: RepoColonyConfig
  loadedAt: number
  mtimeMs: number
  repoPath: string
}
