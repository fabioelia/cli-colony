/**
 * RepoConfigLoader — reads .colony/ directories from repositories.
 *
 * Discovery: walk up from a directory to find .colony/ (like .git/ discovery).
 * Caching: in-memory with filesystem mtime invalidation.
 * Bare repo support: use `git show HEAD:.colony/...` for bare-only repos.
 */

import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import { execSync } from 'child_process'
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
export function loadRepoConfig(repoPath: string): RepoColonyConfig | null {
  const colonyDir = path.join(repoPath, '.colony')
  if (!fs.existsSync(colonyDir) || !fs.statSync(colonyDir).isDirectory()) {
    return null
  }

  const repoSlug = resolveRepoSlug(repoPath)

  const config = loadConfigYaml(colonyDir)
  const templates = loadTemplates(colonyDir, repoSlug)
  const pipelines = loadPipelines(colonyDir, repoSlug)
  const prompts = loadPrompts(colonyDir, repoSlug)
  const context = loadContext(colonyDir)

  // Compute hashes for security tracking
  const hashes: RepoColonyConfig['hashes'] = { pipelines: {}, templates: {} }
  for (const p of pipelines) {
    const filePath = path.join(colonyDir, 'pipelines', p.fileName)
    try { hashes.pipelines[p.fileName] = sha256(fs.readFileSync(filePath, 'utf-8')) } catch { /* */ }
  }
  const templatesDir = path.join(colonyDir, 'templates')
  if (fs.existsSync(templatesDir)) {
    for (const f of fs.readdirSync(templatesDir).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))) {
      try { hashes.templates[f] = sha256(fs.readFileSync(path.join(templatesDir, f), 'utf-8')) } catch { /* */ }
    }
  }

  return { repoPath, repoSlug, config, templates, pipelines, prompts, context, hashes }
}

// ---- Loading from bare repo ----

/**
 * Load .colony/ from a bare git repo using `git show`.
 * Returns null if the bare repo doesn't have a .colony/ directory.
 */
export function loadRepoConfigFromBare(bareRepoDir: string, repoSlug: string): RepoColonyConfig | null {
  try {
    // Resolve the best ref to read from — prefer origin's default branch over local HEAD
    // (local branch in a bare repo often lags behind after `git fetch`)
    const ref = resolveBareRef(bareRepoDir)

    // Check if .colony/ exists at the resolved ref
    const treeOutput = execSync(`git ls-tree ${ref} .colony/`, {
      cwd: bareRepoDir,
      encoding: 'utf-8',
      timeout: 5000,
    }).trim()

    if (!treeOutput) return null

    const config = loadConfigYamlFromBare(bareRepoDir, ref)
    const templates = loadTemplatesFromBare(bareRepoDir, repoSlug, ref)
    const pipelines = loadPipelinesFromBare(bareRepoDir, repoSlug, ref)
    const prompts = loadPromptsFromBare(bareRepoDir, repoSlug, ref)
    const context = gitShow(bareRepoDir, '.colony/context.md', ref)

    const hashes: RepoColonyConfig['hashes'] = { pipelines: {}, templates: {} }
    for (const p of pipelines) {
      const content = gitShow(bareRepoDir, `.colony/pipelines/${p.fileName}`, ref)
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
export function getRepoConfig(repoPath: string, repoSlug?: string): RepoColonyConfig | null {
  const cached = cache.get(repoPath)
  if (cached) {
    // Check mtime for invalidation
    try {
      const colonyDir = path.join(repoPath, '.colony')
      if (fs.existsSync(colonyDir)) {
        const currentMtime = fs.statSync(colonyDir).mtimeMs
        if (currentMtime === cached.mtimeMs) return cached.config
      }
    } catch { /* */ }
  }

  // Try working tree first
  let config = loadRepoConfig(repoPath)

  // Try bare repo
  if (!config && repoPath.endsWith('.git')) {
    console.log(`[repo-config] trying bare repo: ${repoPath} slug=${repoSlug}`)
    config = loadRepoConfigFromBare(repoPath, repoSlug || repoPath)
    console.log(`[repo-config] bare repo result: ${config ? `${config.templates.length} templates` : 'null'}`)
  }

  if (config) {
    const colonyDir = path.join(repoPath, '.colony')
    let mtimeMs = 0
    try { mtimeMs = fs.statSync(colonyDir).mtimeMs } catch { /* */ }
    cache.set(repoPath, { config, loadedAt: Date.now(), mtimeMs, repoPath })
  } else {
    cache.delete(repoPath)
  }

  return config
}

/**
 * Get repo context.md for a working directory (walk-up discovery).
 */
export function getRepoContext(workingDirectory: string): string | null {
  const repoRoot = findColonyDir(workingDirectory)
  if (!repoRoot) return null
  const config = getRepoConfig(repoRoot)
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

function resolveRepoSlug(repoPath: string): string {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      cwd: repoPath, encoding: 'utf-8', timeout: 3000,
    }).trim()
    // Extract owner/name from SSH or HTTPS URL
    const match = remoteUrl.match(/[:/]([^/]+)\/([^/]+?)(?:\.git)?$/)
    if (match) return `${match[1]}/${match[2]}`
  } catch { /* */ }
  // Fallback: use directory name
  return path.basename(repoPath)
}

/**
 * Resolve the best ref to read .colony/ from in a bare repo.
 * Prefers the remote default branch (origin/HEAD → origin/main or origin/develop)
 * because `git fetch` updates remote refs but not local branches.
 */
function resolveBareRef(bareRepoDir: string): string {
  // Try origin/HEAD (set by git clone --bare, points to default branch)
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD', {
      cwd: bareRepoDir, encoding: 'utf-8', timeout: 2000,
    }).trim()
    if (ref) return ref // e.g. "refs/remotes/origin/main"
  } catch { /* not set */ }

  // Try common default branch names on origin
  for (const branch of ['origin/develop', 'origin/main', 'origin/master']) {
    try {
      execSync(`git rev-parse --verify ${branch}`, {
        cwd: bareRepoDir, encoding: 'utf-8', timeout: 2000,
      })
      return branch
    } catch { /* doesn't exist */ }
  }

  // Fallback to HEAD (local branch — might be stale)
  return 'HEAD'
}

function gitShow(bareRepoDir: string, filePath: string, ref = 'HEAD'): string | null {
  try {
    return execSync(`git show ${ref}:${filePath}`, {
      cwd: bareRepoDir, encoding: 'utf-8', timeout: 5000,
    })
  } catch {
    return null
  }
}

function loadConfigYaml(colonyDir: string): ColonyProjectConfig | null {
  const configPath = path.join(colonyDir, 'config.yaml')
  if (!fs.existsSync(configPath)) return null
  try {
    const content = fs.readFileSync(configPath, 'utf-8')
    const parsed = parseYaml(content)
    if (!parsed?.name) return null
    return parsed as ColonyProjectConfig
  } catch {
    return null
  }
}

function loadConfigYamlFromBare(bareRepoDir: string, ref = 'HEAD'): ColonyProjectConfig | null {
  const content = gitShow(bareRepoDir, '.colony/config.yaml', ref)
  if (!content) return null
  const parsed = parseYaml(content)
  if (!parsed?.name) return null
  return parsed as ColonyProjectConfig
}

function loadTemplates(colonyDir: string, repoSlug: string): (EnvironmentTemplate & { source: string })[] {
  const templatesDir = path.join(colonyDir, 'templates')
  if (!fs.existsSync(templatesDir)) return []
  const templates: (EnvironmentTemplate & { source: string })[] = []

  for (const file of fs.readdirSync(templatesDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    try {
      const content = fs.readFileSync(path.join(templatesDir, file), 'utf-8')
      const template = parseTemplateYaml(content, repoSlug)
      if (template) templates.push(template)
    } catch { /* skip invalid */ }
  }
  return templates
}

function loadTemplatesFromBare(bareRepoDir: string, repoSlug: string, ref = 'HEAD'): (EnvironmentTemplate & { source: string })[] {
  try {
    const listing = execSync(`git ls-tree --name-only ${ref} .colony/templates/`, {
      cwd: bareRepoDir, encoding: 'utf-8', timeout: 5000,
    }).trim()
    if (!listing) return []

    const templates: (EnvironmentTemplate & { source: string })[] = []
    for (const filePath of listing.split('\n')) {
      if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) continue
      const content = gitShow(bareRepoDir, filePath, ref)
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

function loadPipelines(colonyDir: string, repoSlug: string): (RepoPipelineDef & { source: string; fileName: string })[] {
  const pipelinesDir = path.join(colonyDir, 'pipelines')
  if (!fs.existsSync(pipelinesDir)) return []
  const pipelines: (RepoPipelineDef & { source: string; fileName: string })[] = []

  for (const file of fs.readdirSync(pipelinesDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    try {
      const content = fs.readFileSync(path.join(pipelinesDir, file), 'utf-8')
      const parsed = parseYaml(content) as RepoPipelineDef | null
      if (parsed?.name && parsed?.trigger && parsed?.action) {
        pipelines.push({ ...parsed, source: `repo:${repoSlug}`, fileName: file })
      }
    } catch { /* skip invalid */ }
  }
  return pipelines
}

function loadPipelinesFromBare(bareRepoDir: string, repoSlug: string, ref = 'HEAD'): (RepoPipelineDef & { source: string; fileName: string })[] {
  try {
    const listing = execSync(`git ls-tree --name-only ${ref} .colony/pipelines/`, {
      cwd: bareRepoDir, encoding: 'utf-8', timeout: 5000,
    }).trim()
    if (!listing) return []

    const pipelines: (RepoPipelineDef & { source: string; fileName: string })[] = []
    for (const filePath of listing.split('\n')) {
      const fileName = path.basename(filePath)
      if (!fileName.endsWith('.yaml') && !fileName.endsWith('.yml')) continue
      const content = gitShow(bareRepoDir, filePath, ref)
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

function loadPrompts(colonyDir: string, repoSlug: string): (QuickPrompt & { source: string })[] {
  const promptsDir = path.join(colonyDir, 'prompts')
  if (!fs.existsSync(promptsDir)) return []
  const prompts: (QuickPrompt & { source: string })[] = []

  for (const file of fs.readdirSync(promptsDir)) {
    if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue
    try {
      const content = fs.readFileSync(path.join(promptsDir, file), 'utf-8')
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

function loadPromptsFromBare(bareRepoDir: string, repoSlug: string, ref = 'HEAD'): (QuickPrompt & { source: string })[] {
  try {
    const listing = execSync(`git ls-tree --name-only ${ref} .colony/prompts/`, {
      cwd: bareRepoDir, encoding: 'utf-8', timeout: 5000,
    }).trim()
    if (!listing) return []

    const prompts: (QuickPrompt & { source: string })[] = []
    for (const filePath of listing.split('\n')) {
      if (!filePath.endsWith('.yaml') && !filePath.endsWith('.yml')) continue
      const content = gitShow(bareRepoDir, filePath, ref)
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

function loadContext(colonyDir: string): string | null {
  const contextPath = path.join(colonyDir, 'context.md')
  try {
    if (fs.existsSync(contextPath)) {
      return fs.readFileSync(contextPath, 'utf-8')
    }
  } catch { /* */ }
  return null
}
