/**
 * Environment Manager — business logic for environment CRUD operations.
 * Bridges envd to Electron's IPC layer. Manages instance.json files,
 * port allocation, and the discovery agent workflow.
 */

import { app } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import { getEnvDaemonClient, EnvDaemonClient } from './env-daemon-client'
import { allocatePorts, isPortInUse } from './port-allocator'
import { removeWorktree, isWorktree, getBareRepoForWorktree, pruneAllBareRepos, migrateReposToBare } from '../shared/git-worktree'
import { buildContext, resolveTemplate as resolveTemplateVars, findUnresolved } from '../shared/template-resolver'
import { readAndReconcileState, emptyState, writeState } from '../shared/env-state'
import { addToIndex, removeFromIndex, allEnvDirs } from '../shared/env-index'
import { broadcast } from './broadcast'
import { appendActivity } from './activity-manager'
import { runSetup } from './env-setup'
import { gitRemoteUrl } from './settings'
import { getAllRepoConfigs, getRepoConfig, clearRepoConfigCache } from './repo-config-loader'
import { getRepos } from './github'
import type { InstanceManifest, EnvStatus, EnvironmentTemplate } from '../daemon/env-protocol'

import { colonyPaths } from '../shared/colony-paths'
import { genId, slugify } from '../shared/utils'

const HOME = process.env.HOME || '/'
const ENVIRONMENTS_DIR = colonyPaths.environments


// ---- Helpers ----
// genId and slugify imported from shared/utils

// ---- Daemon event wiring ----

let _wired = false

export function wireEnvDaemonEvents(): void {
  if (_wired) return
  _wired = true

  const client = getEnvDaemonClient()

  client.on('env-changed', (environments: EnvStatus[]) => {
    broadcast('env:list', environments)
  })

  client.on('service-output', (envId: string, service: string, data: string) => {
    broadcast('env:service-output', { envId, service, data })
  })

  client.on('service-crashed', (envId: string, service: string, exitCode: number) => {
    broadcast('env:service-crashed', { envId, service, exitCode })
    appendActivity({ source: 'env', name: envId, summary: `Service "${service}" crashed (exit ${exitCode}) in environment "${envId}"`, level: 'error' })
  })

  client.on('connected', () => {
    console.log('[env-manager] envd connected')
    // After (re)connection, fetch current state and broadcast to renderer
    // so the UI is always in sync with the daemon
    client.status().then((environments) => {
      broadcast('env:list', environments)
    }).catch(() => {})
  })

  client.on('disconnected', () => {
    console.log('[env-manager] envd disconnected')
  })
}

// ---- Init ----

let watchInterval: ReturnType<typeof setInterval> | null = null
const knownManifests = new Set<string>()

export async function initEnvDaemon(): Promise<void> {
  try {
    const client = getEnvDaemonClient()
    await client.connect()
    wireEnvDaemonEvents()
    console.log('[env-manager] envd initialized')

    // Migrate legacy shallow clones to bare repos (one-time, non-blocking)
    migrateReposToBare().catch(err => {
      console.warn('[env-manager] repo migration failed (non-fatal):', err)
    })

    // Prune stale worktree entries from all bare repos
    try { pruneAllBareRepos() } catch { /* non-fatal */ }

    // Register existing environments from disk
    await syncEnvironmentsFromDisk()

    // Load .colony/ configs from all known repos
    refreshRepoConfigs()

    // Broadcast current state to renderer so it doesn't have to wait for polling
    try {
      const environments = await client.status()
      broadcast('env:list', environments)
    } catch { /* envd may have no environments yet */ }

    // Watch for new environments created by the Instance Agent
    startWatchingForNewEnvironments()
  } catch (err) {
    console.error('[env-manager] failed to init envd:', err)
  }
}

const knownTemplates = new Set<string>()

function startWatchingForNewEnvironments(): void {
  if (watchInterval) return
  if (!fs.existsSync(ENVIRONMENTS_DIR)) fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true })
  ensureTemplatesDir()

  // Poll every 5 seconds for new instance.json files AND new templates
  watchInterval = setInterval(async () => {
    // Watch instances
    try {
      const entries = fs.readdirSync(ENVIRONMENTS_DIR)
      for (const entry of entries) {
        const manifestPath = path.join(ENVIRONMENTS_DIR, entry, 'instance.json')
        if (knownManifests.has(manifestPath)) continue
        if (!fs.existsSync(manifestPath)) continue

        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InstanceManifest
          if (manifest.version === 2 && manifest.id) {
            knownManifests.add(manifestPath)
            const client = getEnvDaemonClient()
            await client.register(manifest)
            console.log(`[env-manager] auto-registered new environment: ${manifest.name}`)
          }
        } catch { /* skip invalid/incomplete */ }
      }
    } catch { /* ignore */ }

    // Watch templates — notify renderer when new ones appear
    try {
      let newTemplate = false
      for (const file of fs.readdirSync(TEMPLATES_DIR)) {
        if (!file.endsWith('.json')) continue
        const fp = path.join(TEMPLATES_DIR, file)
        if (!knownTemplates.has(fp)) {
          knownTemplates.add(fp)
          newTemplate = true
        }
      }
      if (newTemplate) {
        broadcast('env:templates-changed', listTemplates())
      }
    } catch { /* ignore */ }
  }, 5000)
}

async function syncEnvironmentsFromDisk(): Promise<void> {
  if (!fs.existsSync(ENVIRONMENTS_DIR)) return

  const client = getEnvDaemonClient()
  const entries = fs.readdirSync(ENVIRONMENTS_DIR)

  for (const entry of entries) {
    const manifestPath = path.join(ENVIRONMENTS_DIR, entry, 'instance.json')
    if (!fs.existsSync(manifestPath)) continue

    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InstanceManifest
      if (manifest.version === 2 && manifest.id) {
        knownManifests.add(manifestPath)
        await client.register(manifest)
      }
    } catch { /* skip invalid */ }
  }
}

// ---- Template Management ----

const TEMPLATES_DIR = colonyPaths.templates

function ensureTemplatesDir(): void {
  if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true })
}

export function listTemplates(): EnvironmentTemplate[] {
  ensureTemplatesDir()
  const templates: EnvironmentTemplate[] = []

  // 1. User templates (from ~/.claude-colony/environment-templates/)
  for (const file of fs.readdirSync(TEMPLATES_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const content = fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf-8')
      const t = JSON.parse(content) as EnvironmentTemplate
      t.source = t.source || 'user'
      templates.push(t)
    } catch { /* skip invalid */ }
  }

  // 2. Repo templates (from .colony/templates/ in tracked repos)
  try {
    const repoConfigs = getAllRepoConfigs()
    console.log(`[env-manager] listTemplates: ${templates.length} user templates, ${repoConfigs.length} repo configs`)
    const seenNames = new Set(templates.map(t => t.name))
    for (const repoConfig of repoConfigs) {
      console.log(`[env-manager]   repo ${repoConfig.repoSlug}: ${repoConfig.templates.length} templates`)
      for (const t of repoConfig.templates) {
        // Skip duplicates: user templates take precedence, and the same repo
        // template can appear in multiple cache entries if loaded via different paths
        if (!seenNames.has(t.name)) {
          seenNames.add(t.name)
          templates.push(t)
        }
      }
    }
  } catch (err) {
    console.warn('[env-manager] repo template loading failed:', err)
  }

  console.log(`[env-manager] listTemplates: returning ${templates.length} total`)
  return templates.sort((a, b) => a.name.localeCompare(b.name))
}

export function getTemplate(id: string): EnvironmentTemplate | null {
  const templates = listTemplates()
  return templates.find(t => t.id === id) || null
}

export function saveTemplate(template: EnvironmentTemplate): void {
  ensureTemplatesDir()
  const safeName = template.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  const filePath = path.join(TEMPLATES_DIR, `${safeName}.json`)
  template.updatedAt = new Date().toISOString()
  fs.writeFileSync(filePath, JSON.stringify(template, null, 2), 'utf-8')
}

export function deleteTemplate(id: string): boolean {
  ensureTemplatesDir()
  for (const file of fs.readdirSync(TEMPLATES_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const content = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf-8'))
      if (content.id === id) {
        fs.unlinkSync(path.join(TEMPLATES_DIR, file))
        return true
      }
    } catch { /* skip */ }
  }
  return false
}

// ---- Repo Config Refresh ----

/** Scan all known repos for .colony/ directories and cache their configs.
 *  Fetches bare repos first so we read the latest remote state. */
export function refreshRepoConfigs(): void {
  try {
    clearRepoConfigCache()
    const repos = getRepos()
    let loaded = 0
    for (const repo of repos) {
      const localPath = repo.localPath
      if (!localPath || !fs.existsSync(localPath)) continue
      // Fetch latest for bare repos so .colony/ discovery reads current remote state
      if (localPath.endsWith('.git')) {
        try { execSync('git fetch origin --prune', { cwd: localPath, timeout: 15000, stdio: 'ignore' }) } catch { /* non-fatal */ }
      }
      const config = getRepoConfig(localPath, `${repo.owner}/${repo.name}`)
      if (config) loaded++
    }
    console.log(`[env-manager] refreshed .colony/ configs: ${loaded}/${repos.length} repos have configs`)
  } catch (err) {
    console.warn('[env-manager] repo config refresh failed (non-fatal):', err)
  }
}

// ---- Public API ----

export interface CreateEnvironmentOpts {
  name: string
  branch?: string
  baseBranch?: string
  projectType?: string
  sourceDir?: string // if cloning from local repos
  target?: string // 'develop' | 'stage'
  targetDir?: string // custom directory for the environment
  templateId?: string // create from template
}

/**
 * Create an environment from a template. Template-driven — no hardcoded assumptions.
 */
export async function createEnvironment(opts: CreateEnvironmentOpts): Promise<InstanceManifest> {
  const client = getEnvDaemonClient()
  const id = genId()
  const displayName = opts.name
  const name = slugify(opts.name)
  const envDir = opts.targetDir ? path.join(opts.targetDir, name) : path.join(ENVIRONMENTS_DIR, name)

  if (fs.existsSync(envDir)) throw new Error(`Environment '${name}' already exists at ${envDir}`)

  // Load template if specified
  let template: EnvironmentTemplate | null = null
  if (opts.templateId) {
    template = getTemplate(opts.templateId)
    if (!template) throw new Error(`Template '${opts.templateId}' not found`)
  }

  const branch = opts.branch || template?.branches?.default || 'develop'
  const baseBranch = opts.baseBranch || opts.target || template?.branches?.default || 'develop'

  // Create directory
  fs.mkdirSync(envDir, { recursive: true })
  fs.mkdirSync(path.join(envDir, 'logs'), { recursive: true })

  // Build paths from template repos
  const paths: Record<string, string> = { root: envDir }
  if (template?.repos) {
    for (const repo of template.repos) {
      paths[repo.as] = path.join(envDir, repo.name)
    }
  }

  // Build port map from template's "ports" array (e.g. ["backend", "frontend"])
  const portNames = Array.isArray(template?.ports) && template.ports.length > 0
    ? template.ports
    : ['backend'] // fallback if template has no port config
  const portMap = await allocatePorts(portNames)

  // Build repos lookup so templates can reference ${repos.backend.localPath} etc.
  // Enrich with localPath from the tracked repo registry if not set in the template.
  // Prefer a working-tree clone over the bare repo (bare repos end with .git and lack a working tree).
  const trackedRepos = getRepos()
  const repos: Record<string, any> = {}
  if (template?.repos) {
    for (const repo of template.repos) {
      const enriched = { ...repo }
      if (!enriched.localPath) {
        const tracked = trackedRepos.find(r => r.owner === repo.owner && r.name === repo.name)
        if (tracked?.localPath && !tracked.localPath.endsWith('.git')) {
          enriched.localPath = tracked.localPath
        } else if (tracked?.localPath?.endsWith('.git')) {
          // Bare repo — check for a working-tree clone at common locations
          const homeProjects = path.join(app.getPath('home'), 'projects', repo.name)
          if (fs.existsSync(path.join(homeProjects, '.git'))) {
            enriched.localPath = homeProjects
          }
        }
      }
      repos[repo.as] = enriched
    }
  }

  // Resolve all template variables (services, hooks, resources) using shared resolver
  const context = buildContext({ name, ports: portMap, paths, resources: {}, repos, branch })
  const { services, hooks, resources } = resolveTemplateVars(
    { services: template?.services, hooks: template?.hooks, resources: template?.resources },
    context,
    'env-manager:create'
  )

  // Build git remotes
  const remotes: Record<string, string> = {}
  if (template?.repos) {
    for (const repo of template.repos) {
      remotes[repo.as] = repo.remoteUrl || gitRemoteUrl(repo.owner, repo.name)
    }
  }

  // Build URLs
  const urls: Record<string, string> = {}
  for (const [key, port] of Object.entries(portMap)) {
    urls[key] = `http://${name}.localhost:${port}`
  }

  // Build setup steps from hooks
  const setupSteps: Array<{ name: string; status: string }> = [{ name: 'Clone repos', status: 'pending' }]
  if (hooks.postClone) for (const h of hooks.postClone) setupSteps.push({ name: h.name || h.command?.slice(0, 30), status: 'pending' })
  if (hooks.postCreate) for (const h of hooks.postCreate) setupSteps.push({ name: h.name || h.command?.slice(0, 30), status: 'pending' })

  const manifest: InstanceManifest = {
    version: 2,
    id,
    name,
    displayName: displayName !== name ? displayName : undefined,
    projectType: template?.projectType || opts.projectType || 'generic',
    createdAt: new Date().toISOString(),
    git: { branch, baseBranch, remotes },
    services,
    ports: portMap,
    paths,
    resources,
    urls,
    logs: { dir: path.join(envDir, 'logs'), maxSizeKb: 500, retention: 5 },
    hooks,
    setup: { status: 'creating', steps: setupSteps, error: null },
    meta: { templateId: template?.id, templateName: template?.name },
  }

  // Validate: scan manifest for unresolved ${...} variables before writing
  const manifestJson = JSON.stringify(manifest, null, 2)
  const unresolved = findUnresolved(manifestJson)
  if (unresolved.length > 0) {
    console.error(`[env-manager] WARNING: ${unresolved.length} unresolved template variable(s) in manifest: ${unresolved.join(', ')}`)
  }

  fs.writeFileSync(path.join(envDir, 'instance.json'), manifestJson, 'utf-8')

  // Write initial state.json with all services stopped
  writeState(envDir, emptyState(manifest.id, Object.keys(services)))

  // Register in the environment index
  addToIndex(manifest.id, envDir)

  await client.register(manifest)
  return manifest
}

/**
 * Run the setup pipeline for a newly created environment.
 * Delegates to env-setup.ts for the actual pipeline execution.
 */
export async function setupEnvironment(envId: string): Promise<void> {
  const envDir = findEnvDir(envId)
  if (!envDir) throw new Error(`Environment ${envId} not found`)
  return runSetup(envDir, getTemplate)
}

// ---- Helpers ----

function findEnvDir(envId: string): string | null {
  // Check the environment index first (fast lookup)
  const index = allEnvDirs()
  const indexed = index.find(e => e.id === envId)
  if (indexed) return indexed.dir

  // Fallback: scan default environments directory
  if (fs.existsSync(ENVIRONMENTS_DIR)) {
    for (const entry of fs.readdirSync(ENVIRONMENTS_DIR)) {
      const manifestPath = path.join(ENVIRONMENTS_DIR, entry, 'instance.json')
      if (!fs.existsSync(manifestPath)) continue
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
        if (manifest.id === envId) {
          const dir = manifest.paths?.root || path.join(ENVIRONMENTS_DIR, entry)
          addToIndex(envId, dir) // auto-heal index
          return dir
        }
      } catch { /* skip */ }
    }
  }
  return null
}

// ---- Query / Control ----

export async function listEnvironments(): Promise<EnvStatus[]> {
  try {
    const daemonStatus = await getEnvDaemonClient().status()
    // Merge with on-disk state.json for any envs the daemon shows as all-stopped
    // (handles case where daemon restarted and lost track of running processes)
    for (const env of daemonStatus) {
      const allStopped = env.services.every(s => s.status === 'stopped')
      if (!allStopped) continue
      const envDir = env.paths?.root
      if (!envDir) continue
      const diskState = readAndReconcileState(envDir)
      if (!diskState) continue
      for (const svc of env.services) {
        const diskSvc = diskState.services[svc.name]
        if (diskSvc && diskSvc.status === 'running' && diskSvc.pid != null) {
          svc.status = diskSvc.status
          svc.pid = diskSvc.pid
          svc.restarts = diskSvc.restarts
        }
      }
    }
    return daemonStatus
  } catch {
    // Daemon unreachable — build status from disk
    return listEnvironmentsFromDisk()
  }
}

/** Fallback: read manifests + state.json from disk when daemon is unavailable */
function listEnvironmentsFromDisk(): EnvStatus[] {
  const results: EnvStatus[] = []
  const seen = new Set<string>()

  // Collect all env dirs from the index + default environments directory
  const dirs: string[] = allEnvDirs().map(e => e.dir)

  // Also scan default environments directory for any not in the index
  if (fs.existsSync(ENVIRONMENTS_DIR)) {
    for (const entry of fs.readdirSync(ENVIRONMENTS_DIR)) {
      const d = path.join(ENVIRONMENTS_DIR, entry)
      if (fs.existsSync(path.join(d, 'instance.json'))) dirs.push(d)
    }
  }

  for (const envDir of dirs) {
    const manifestPath = path.join(envDir, 'instance.json')
    if (!fs.existsSync(manifestPath)) continue
    try {
      const manifest: InstanceManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
      if (seen.has(manifest.id)) continue
      seen.add(manifest.id)

      const diskState = readAndReconcileState(envDir)
      const services = Object.keys(manifest.services || {}).map(name => {
        const diskSvc = diskState?.services?.[name]
        return {
          name,
          status: (diskSvc?.status || 'stopped') as 'running' | 'stopped' | 'crashed' | 'starting',
          pid: diskSvc?.pid ?? null,
          port: manifest.ports?.[name] ?? null,
          uptime: diskSvc?.startedAt ? Math.floor((Date.now() - diskSvc.startedAt) / 1000) : 0,
          restarts: diskSvc?.restarts ?? 0,
        }
      })
      const running = services.filter(s => s.status === 'running').length
      const total = services.length
      let status: 'running' | 'stopped' | 'partial' | 'creating' | 'error'
      if (manifest.setup?.status === 'creating') status = 'creating'
      else if (manifest.setup?.status === 'error') status = 'error'
      else if (running === 0) status = 'stopped'
      else if (running === total) status = 'running'
      else status = 'partial'

      // Resolve live git branch from the first repo subdirectory
      let liveBranch = manifest.git?.branch || ''
      try {
        const entries = fs.readdirSync(envDir, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'logs') continue
          const subdir = path.join(envDir, entry.name)
          try {
            liveBranch = execSync('git rev-parse --abbrev-ref HEAD', { cwd: subdir, encoding: 'utf-8', timeout: 2000 }).trim()
            break
          } catch { /* not a git repo, try next */ }
        }
      } catch { /* can't read dir */ }

      results.push({
        id: manifest.id,
        name: manifest.name,
        displayName: manifest.displayName,
        projectType: manifest.projectType,
        branch: liveBranch,
        status,
        services,
        urls: manifest.urls || {},
        ports: manifest.ports || {},
        paths: manifest.paths || {},
        createdAt: manifest.createdAt,
      })
    } catch { /* skip bad manifests */ }
  }

  return results
}

export async function getEnvironment(envId: string): Promise<EnvStatus | null> {
  try {
    return await getEnvDaemonClient().statusOne(envId)
  } catch {
    return null
  }
}

export async function startEnvironment(envId: string, services?: string[]): Promise<void> {
  await getEnvDaemonClient().start(envId, services)
}

export async function stopEnvironment(envId: string, services?: string[]): Promise<void> {
  await getEnvDaemonClient().stop(envId, services)
}

export async function restartServiceInEnv(envId: string, service: string): Promise<void> {
  await getEnvDaemonClient().restartService(envId, service)
}

export async function getEnvironmentLogs(envId: string, service: string, lines?: number): Promise<string> {
  return await getEnvDaemonClient().logs(envId, service, lines)
}

export async function teardownEnvironment(envId: string): Promise<void> {
  const envDir = findEnvDir(envId)
  if (!envDir) throw new Error(`Environment ${envId} not found`)

  // Read manifest to get environment slug for branch cleanup
  let envSlug: string | undefined
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(envDir, 'instance.json'), 'utf-8')) as InstanceManifest
    envSlug = manifest.name
  } catch { /* continue without slug */ }

  // Delegate to the daemon: stops services, waits for them to die, runs hooks, unregisters.
  // This runs in the daemon process so it doesn't block the Electron main process.
  try {
    await getEnvDaemonClient().teardown(envId)
  } catch (err) {
    console.error(`[env-manager] daemon teardown failed (continuing with cleanup):`, err)
    // Fallback: try to at least stop + unregister
    try { await getEnvDaemonClient().stop(envId) } catch { /* */ }
    try { await getEnvDaemonClient().unregister(envId) } catch { /* */ }
  }

  // Clean up worktrees before deleting directories.
  // For each repo subdirectory that is a worktree, remove it from the bare repo's
  // worktree list and delete the per-env tracking branch.
  try {
    if (fs.existsSync(envDir)) {
      const entries = fs.readdirSync(envDir)
      for (const entry of entries) {
        const subdir = path.join(envDir, entry)
        try {
          if (!fs.statSync(subdir).isDirectory()) continue
        } catch { continue }

        if (isWorktree(subdir)) {
          const bareDir = getBareRepoForWorktree(subdir)
          if (bareDir) {
            console.log(`[env-manager] removing worktree: ${subdir} from ${bareDir}`)
            await removeWorktree(bareDir, subdir, envSlug)
          }
        }
      }
    }
  } catch (err) {
    console.error(`[env-manager] worktree cleanup failed (continuing with rm):`, err)
  }

  // Remove from index
  removeFromIndex(envId)

  // Delete files — always runs even if worktree cleanup failed
  try {
    fs.rmSync(envDir, { recursive: true, force: true })
  } catch (err) {
    console.error(`[env-manager] failed to remove ${envDir}:`, err)
  }
}

/**
 * Get the manifest for an environment by ID.
 */
export function getManifest(envId: string): InstanceManifest | null {
  const envDir = findEnvDir(envId)
  if (!envDir) return null

  const manifestPath = path.join(envDir, 'instance.json')
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Fix an existing environment — re-resolve template variables with fresh port allocation.
 * Preserves: id, name, createdAt, git, paths, setup status for completed steps.
 * Re-resolves: ports, services, hooks, resources, urls.
 */
export async function fixEnvironment(envId: string): Promise<{ fixed: string[] }> {
  const manifest = getManifest(envId)
  if (!manifest) throw new Error(`Environment ${envId} not found`)

  const templateId = (manifest as any).meta?.templateId
  const template = templateId ? getTemplate(templateId) : null
  if (!template) throw new Error(`No template found for environment ${manifest.name} — cannot re-resolve`)

  const fixed: string[] = []
  const name = manifest.name
  const envDir = manifest.paths.root
  const branch = manifest.git?.branch || 'develop'

  // Re-allocate ports — but preserve current ports if they're still free
  const portNames = Array.isArray(template.ports) && template.ports.length > 0
    ? template.ports
    : ['backend']
  const oldPorts = manifest.ports || {}

  // Check which current ports are still usable
  let portsNeedRealloc = false
  for (const name of portNames) {
    if (typeof oldPorts[name] !== 'number') {
      portsNeedRealloc = true // port missing entirely
      break
    }
    if (await isPortInUse(oldPorts[name])) {
      portsNeedRealloc = true // port is taken by something else
      break
    }
  }

  let portMap: Record<string, number>
  if (portsNeedRealloc) {
    portMap = await allocatePorts(portNames)
    for (const [key, port] of Object.entries(portMap)) {
      if (oldPorts[key] !== port) fixed.push(`port ${key}: ${oldPorts[key] ?? 'none'} → ${port}`)
    }
  } else {
    // Current ports are fine — keep them
    portMap = {}
    for (const name of portNames) portMap[name] = oldPorts[name]
    fixed.push('ports unchanged (all free)')
  }

  // Rebuild paths from template repos (preserve root)
  const paths: Record<string, string> = { root: envDir }
  if (template.repos) {
    for (const repo of template.repos) {
      paths[repo.as] = path.join(envDir, repo.name)
    }
  }

  // Rebuild repos lookup
  const repos: Record<string, any> = {}
  if (template.repos) {
    for (const repo of template.repos) {
      repos[repo.as] = { ...repo }
    }
  }

  // Resolve all template variables using shared resolver
  const context = buildContext({ name, ports: portMap, paths, resources: {}, repos, branch })
  const { services, hooks, resources } = resolveTemplateVars(
    { services: template.services, hooks: template.hooks, resources: template.resources },
    context,
    'env-manager:fix'
  )

  // Rebuild URLs
  const urls: Record<string, string> = {}
  for (const [key, port] of Object.entries(portMap)) {
    urls[key] = `http://${name}.localhost:${port}`
  }

  // Check for unresolved variables
  const unresolvedVars = findUnresolved(JSON.stringify(services))
  if (unresolvedVars.length > 0) {
    fixed.push(`WARNING: ${unresolvedVars.length} unresolved variable(s) remain`)
  }

  // Update manifest — preserve identity, git, setup status
  const updated: InstanceManifest = {
    ...manifest,
    services,
    ports: portMap,
    paths,
    resources,
    urls,
    hooks,
    meta: { ...manifest.meta as any, templateId: template.id, templateName: template.name },
  }

  // Validate
  const manifestJson = JSON.stringify(updated, null, 2)
  const unresolved = findUnresolved(manifestJson)
  if (unresolved.length > 0) {
    console.error(`[env-manager:fix] WARNING: ${unresolved.length} unresolved variable(s): ${unresolved.join(', ')}`)
  }

  // Save and re-register
  const envDirPath = findEnvDir(envId)
  if (!envDirPath) throw new Error(`Environment directory not found for ${envId}`)
  fs.writeFileSync(path.join(envDirPath, 'instance.json'), manifestJson, 'utf-8')
  await getEnvDaemonClient().register(updated).catch(() => {})

  if (fixed.length === 0) fixed.push('no changes needed')
  console.log(`[env-manager:fix] ${manifest.name}: ${fixed.join(', ')}`)
  return { fixed }
}

export function saveManifest(envId: string, manifest: InstanceManifest): void {
  // Validate required fields to prevent malformed data on disk
  if (!manifest || typeof manifest !== 'object') throw new Error('Invalid manifest: not an object')
  if (!manifest.id || !manifest.name) throw new Error('Invalid manifest: missing id or name')
  if (manifest.id !== envId) throw new Error(`Manifest id "${manifest.id}" does not match envId "${envId}"`)
  if (!manifest.services || typeof manifest.services !== 'object') throw new Error('Invalid manifest: missing services')
  if (!manifest.ports || typeof manifest.ports !== 'object') throw new Error('Invalid manifest: missing ports')
  if (!manifest.paths || typeof manifest.paths !== 'object') throw new Error('Invalid manifest: missing paths')

  const envDir = findEnvDir(envId)
  if (!envDir) throw new Error(`Environment ${envId} not found`)

  const manifestPath = path.join(envDir, 'instance.json')
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  // Re-register with envd
  getEnvDaemonClient().register(manifest).catch(() => {})
}
