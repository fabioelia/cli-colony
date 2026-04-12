/**
 * RepoConfigLoader — reads .colony/ directories from repositories.
 *
 * Discovery: walk up from a directory to find .colony/ (like .git/ discovery).
 * Caching: in-memory with filesystem mtime invalidation.
 * Bare repo support: use `git show HEAD:.colony/...` for bare-only repos.
 */

import { promises as fsp } from 'fs'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { execFile } from 'child_process'
import { resolveCommand } from './resolve-command'
import { parseYaml } from '../shared/yaml-parser'
import type {
  RepoColonyConfig,
  CachedRepoConfig,
  ColonyProjectConfig,
  RepoPipelineDef,
} from '../shared/repo-config-types'
import type { EnvironmentTemplate, QuickPrompt } from '../shared/types'

// ---- Cache ----

const cache = new Map<string, CachedRepoConfig>()

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex')
}

/** Run a git command asynchronously. Returns stdout or null on error. */
function git(args: string[], cwd: string, timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(resolveCommand('git'), args, { cwd, encoding: 'utf-8', timeout }, (err, stdout) => {
      if (err) resolve(null)
      else resolve(stdout)
    })
  })
}

/** Check if a path exists (async). */
async function pathExists(p: string): Promise<boolean> {
  try { await fsp.stat(p); return true } catch { return false }
}

// ---- Walk-up discovery ----

/**
 * Walk up from startPath looking for a .colony/ directory.
 * Stops at filesystem root or when .colony/ is found.
 * Returns the repo root (parent of .colony/) or null.
 */
export function findColonyDir(startPath: string): string | null {
  let dir = path.resolve(startPath)
  const root = path.parse(dir).root

  while (dir !== root) {
    const colonyDir = path.join(dir, '.colony')
    try {
      if (fs.existsSync(colonyDir) && fs.statSync(colonyDir).isDirectory()) {
        return dir
      }
    } catch { /* permission denied, etc */ }

    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ---- Loading from working tree ----

/**
 * Load a .colony/ directory from a repo with a working tree.
 * Returns null if no .colony/ directory exists.
 */
export async function loadRepoConfig(repoPath: string): Promise<RepoColonyConfig | null> {
  const colonyDir = path.join(repoPath, '.colony')
  try {
    const stat = await fsp.stat(colonyDir)
    if (!stat.isDirectory()) return null
  } catch { return null }

  const repoSlug = await resolveRepoSlug(repoPath)

  const config = await loadConfigYaml(colonyDir)
  const templates = await loadTemplates(colonyDir, repoSlug)
  const pipelines = await loadPipelines(colonyDir, repoSlug)
  const prompts = await loadPrompts(colonyDir, repoSlug)
  const context = await loadContext(colonyDir)

  // Compute hashes for security tracking
  const hashes: RepoColonyConfig['hashes'] = { pipelines: {}, templates: {} }
  for (const p of pipelines) {
    const filePath = path.join(colonyDir, 'pipelines', p.fileName)
    try { hashes.pipelines[p.fileName] = sha256(await fsp.readFile(filePath, 'utf-8')) } catch { /* */ }
  }
  const templatesDir = path.join(colonyDir, 'templates')
  if (await pathExists(templatesDir)) {
    const allFiles = await fsp.readdir(templatesDir)
    for (const f of allFiles.filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      try { hashes.templates[f] = sha256(await fsp.readFile(path.join(templatesDir, f), 'utf-8')) } catch { /* */ }
    }
  }

  return { repoPath, repoSlug, config, templates, pipelines, prompts, context, hashes }
}

// ---- Loading from bare repo ----

/**
 * Load .colony/ from a bare git repo using `git show`.
 * Returns null if the bare repo doesn't have a .colony/ directory.
 */
export async function loadRepoConfigFromBare(bareRepoDir: string, repoSlug: string): Promise<RepoColonyConfig | null> {
  try {
    // Resolve the best ref to read from — prefer origin's default branch over local HEAD
    // (local branch in a bare repo often lags behind after `git fetch`)
    const ref = await resolveBareRef(bareRepoDir)

    // Check if .colony/ exists at the resolved ref
    const treeOutput = await git(['ls-tree', ref, '.colony/'], bareRepoDir)
    if (!treeOutput?.trim()) return null

    const config = await loadConfigYamlFromBare(bareRepoDir, ref)
    const templates = await loadTemplatesFromBare(bareRepoDir, repoSlug, ref)
    const pipelines = await loadPipelinesFromBare(bareRepoDir, repoSlug, ref)
    const prompts = await loadPromptsFromBare(bareRepoDir, repoSlug, ref)
    const context = await gitShow(bareRepoDir, '.colony/context.md', ref)

    const hashes: RepoColonyConfig['hashes'] = { pipelines: {}, templates: {} }
    for (const p of pipelines) {
      const content = await gitShow(bareRepoDir, `.colony/pipelines/${p.fileName}`, ref)
      if (content) hashes.pipelines[p.fileName] = sha256(content)
    }

    return {
      repoPath: bareRepoDir,
      repoSlug,
      config,
      templates,
      pipelines,
      prompts,
      context,
      hashes,
    }
  } catch {
    return null
  }
}

// ---- Cached access ----

/**
 * Get repo config with caching and mtime invalidation.
 * Works for both working trees and bare repos.
 */
export async function getRepoConfig(repoPath: string, repoSlug?: string): Promise<RepoColonyConfig | null> {
  const cached = cache.get(repoPath)
  if (cached) {
    // Check mtime for invalidation
    try {
      const colonyDir = path.join(repoPath, '.colony')
      const stat = await fsp.stat(colonyDir)
      if (stat.mtimeMs === cached.mtimeMs) return cached.config
    } catch { /* */ }
  }

  // Try working tree first
  let config = await loadRepoConfig(repoPath)

  // Try bare repo
  if (!config && repoPath.endsWith('.git')) {
    console.log(`[repo-config] trying bare repo: ${repoPath} slug=${repoSlug}`)
    config = await loadRepoConfigFromBare(repoPath, repoSlug || repoPath)
    console.log(`[repo-config] bare repo result: ${config ? `${config.templates.length} templates` : 'null'}`)
  }

  if (config) {
    const colonyDir = path.join(repoPath, '.colony')
    let mtimeMs = 0
    try { mtimeMs = (await fsp.stat(colonyDir)).mtimeMs } catch { /* */ }
    cache.set(repoPath, { config, loadedAt: Date.now(), mtimeMs, repoPath })
  } else {
    cache.delete(repoPath)
  }

  return config
}

/**
 * Get repo context.md for a working directory (walk-up discovery).
 */
export async function getRepoContext(workingDirectory: string): Promise<string | null> {
  const repoRoot = findColonyDir(workingDirectory)
  if (!repoRoot) return null
  const config = await getRepoConfig(repoRoot)
  return config?.context || null
}

/**
 * Get all loaded repo configs from the cache.
 */
export function getAllRepoConfigs(): RepoColonyConfig[] {
  return Array.from(cache.values()).map(c => c.config)
}

/**
 * Clear the cache (e.g., on repo removal).
 */
export function clearRepoConfigCache(repoPath?: string): void {
  if (repoPath) {
    cache.delete(repoPath)
  } else {
    cache.clear()
  }
}

// ---- Internal helpers ----

async function resolveRepoSlug(repoPath: string): Promise<string> {
  const remoteUrl = await git(['remote', 'get-url', 'origin'], repoPath, 3000)
  if (remoteUrl) {
    const match = remoteUrl.trim().match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
    if (match) return `${match[1]}/${match[2]}`
  }
  // Fallback: use directory name
  return path.basename(repoPath)
}

/**
 * Resolve the best ref to read .colony/ from in a bare repo.
 * Prefers the remote default branch (origin/HEAD → origin/main or origin/develop)
 * because `git fetch` updates remote refs but not local branches.
 */
async function resolveBareRef(bareRepoDir: string): Promise<string> {
  // Try origin/HEAD (set by git clone --bare, points to default branch)
  const symRef = await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], bareRepoDir, 2000)
  if (symRef?.trim()) return symRef.trim() // e.g. "refs/remotes/origin/main"

  // Try common default branch names on origin
  for (const branch of ['origin/develop', 'origin/main', 'origin/master']) {
    const result = await git(['rev-parse', '--verify', branch], bareRepoDir, 2000)
    if (result) return branch
  }

  // Fallback to HEAD (local branch — might be stale)
  return 'HEAD'
}

async function gitShow(bareRepoDir: string, filePath: string, ref = 'HEAD'): Promise<string | null> {
  return git(['show', `${ref}:${filePath}`], bareRepoDir)
}

async function loadConfigYaml(colonyDir: string): Promise<ColonyProjectConfig | null> {
  const configPath = path.join(colonyDir, 'config.yaml')
  try {
    const content = await fsp.readFile(configPath, 'utf-8')
    const parsed = parseYaml(content)
    if (!parsed?.name) return null
    return parsed as ColonyProjectConfig
  } catch {
    return null
  }
}

async function loadConfigYamlFromBare(bareRepoDir: string, ref = 'HEAD'): Promise<ColonyProjectConfig | null> {
  const content = await gitShow(bareRepoDir, '.colony/config.yaml', ref)
  if (!content) return null
  const parsed = parseYaml(content)
  if (!parsed?.name) return null
  return parsed as ColonyProjectConfig
}

async function loadTemplates(colonyDir: string, repoSlug: string): Promise<(EnvironmentTemplate & { source: string })[]> {
  const templatesDir = path.join(colonyDir, 'templates')
  if (!await pathExists(templatesDir)) return []
  const templates: (EnvironmentTemplate & { source: string })[] = []

  for (const file of await fsp.readdir(templatesDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    try {
      const content = await fsp.readFile(path.join(templatesDir, file), 'utf-8')
      const template = parseTemplateYaml(content, repoSlug)
      if (template) templates.push(template)
    } catch { /* skip invalid */ }
  }
  return templates
}

async function loadTemplatesFromBare(bareRepoDir: string, repoSlug: string, ref = 'HEAD'): Promise<(EnvironmentTemplate & { source: string })[]> {
  try {
    const listing = await git(['ls-tree', '--name-only', ref, '.colony/templates/'], bareRepoDir)
    if (!listing?.trim()) return []

    const templates: (EnvironmentTemplate & { source: string })[] = []
    for (const filePath of listing.trim().split('\n')) {
      if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) continue
      const content = await gitShow(bareRepoDir, filePath, ref)
      if (content) {
        const template = parseTemplateYaml(content, repoSlug)
        if (template) templates.push(template)
      }
    }
    return templates
  } catch {
    return []
  }
}

function parseTemplateYaml(content: string, repoSlug: string): (EnvironmentTemplate & { source: string }) | null {
  const parsed = parseYaml(content)
  if (!parsed?.name) return null
  return {
    id: `repo:${repoSlug}:${parsed.name}`,
    name: parsed.name,
    description: parsed.description,
    projectType: parsed.projectType || 'custom',
    createdAt: new Date().toISOString(),
    repos: parsed.repos || [],
    services: parsed.services || {},
    resources: parsed.resources,
    ports: parsed.ports,
    hooks: parsed.hooks,
    branches: parsed.branches,
    source: `repo:${repoSlug}`,
  }
}

async function loadPipelines(colonyDir: string, repoSlug: string): Promise<(RepoPipelineDef & { source: string; fileName: string })[]> {
  const pipelinesDir = path.join(colonyDir, 'pipelines')
  if (!await pathExists(pipelinesDir)) return []
  const pipelines: (RepoPipelineDef & { source: string; fileName: string })[] = []

  for (const file of await fsp.readdir(pipelinesDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    try {
      const content = await fsp.readFile(path.join(pipelinesDir, file), 'utf-8')
      const parsed = parseYaml(content) as RepoPipelineDef | null
      if (parsed?.name && parsed?.trigger && parsed?.action) {
        pipelines.push({ ...parsed, source: `repo:${repoSlug}`, fileName: file })
      }
    } catch { /* skip invalid */ }
  }
  return pipelines
}

async function loadPipelinesFromBare(bareRepoDir: string, repoSlug: string, ref = 'HEAD'): Promise<(RepoPipelineDef & { source: string; fileName: string })[]> {
  try {
    const listing = await git(['ls-tree', '--name-only', ref, '.colony/pipelines/'], bareRepoDir)
    if (!listing?.trim()) return []

    const pipelines: (RepoPipelineDef & { source: string; fileName: string })[] = []
    for (const filePath of listing.trim().split('\n')) {
      const fileName = path.basename(filePath)
      if (!fileName.endsWith('.yaml') && !fileName.endsWith('.yml')) continue
      const content = await gitShow(bareRepoDir, filePath, ref)
      if (content) {
        const parsed = parseYaml(content) as RepoPipelineDef | null
        if (parsed?.name && parsed?.trigger && parsed?.action) {
          pipelines.push({ ...parsed, source: `repo:${repoSlug}`, fileName })
        }
      }
    }
    return pipelines
  } catch {
    return []
  }
}

async function loadPrompts(colonyDir: string, repoSlug: string): Promise<(QuickPrompt & { source: string })[]> {
  const promptsDir = path.join(colonyDir, 'prompts')
  if (!await pathExists(promptsDir)) return []
  const prompts: (QuickPrompt & { source: string })[] = []

  for (const file of await fsp.readdir(promptsDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    try {
      const content = await fsp.readFile(path.join(promptsDir, file), 'utf-8')
      const parsed = parseYaml(content)
      if (parsed?.prompts && Array.isArray(parsed.prompts)) {
        for (const p of parsed.prompts) {
          if (p.id && p.label && p.prompt) {
            prompts.push({ ...p, scope: p.scope || 'pr', source: `repo:${repoSlug}` })
          }
        }
      }
    } catch { /* skip invalid */ }
  }
  return prompts
}

async function loadPromptsFromBare(bareRepoDir: string, repoSlug: string, ref = 'HEAD'): Promise<(QuickPrompt & { source: string })[]> {
  try {
    const listing = await git(['ls-tree', '--name-only', ref, '.colony/prompts/'], bareRepoDir)
    if (!listing?.trim()) return []

    const prompts: (QuickPrompt & { source: string })[] = []
    for (const filePath of listing.trim().split('\n')) {
      if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) continue
      const content = await gitShow(bareRepoDir, filePath, ref)
      if (content) {
        const parsed = parseYaml(content)
        if (parsed?.prompts && Array.isArray(parsed.prompts)) {
          for (const p of parsed.prompts) {
            if (p.id && p.label && p.prompt) {
              prompts.push({ ...p, scope: p.scope || 'pr', source: `repo:${repoSlug}` })
            }
          }
        }
      }
    }
    return prompts
  } catch {
    return []
  }
}

async function loadContext(colonyDir: string): Promise<string | null> {
  const contextPath = path.join(colonyDir, 'context.md')
  try {
    return await fsp.readFile(contextPath, 'utf-8')
  } catch {
    return null
  }
}
