/**
 * Environment Manager — business logic for environment CRUD operations.
 * Bridges envd to Electron's IPC layer. Manages instance.json files,
 * port allocation, and the discovery agent workflow.
 */

import { app } from 'electron'
import { promises as fsp } from 'fs'
import * as path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolveCommand } from './resolve-command'
const execFileAsync = promisify(execFile)

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}
import { getEnvDaemonClient, EnvDaemonClient } from './env-daemon-client'
import { allocatePorts, commitAllocations, isPortInUse } from './port-allocator'
import { removeWorktree, isWorktree, getBareRepoForWorktree, pruneAllBareRepos, migrateReposToBare } from '../shared/git-worktree'
import { unmountAllForEnv, cleanupOrphans } from './worktree-manager'
import { buildContext, resolveTemplate as resolveTemplateVars, findUnresolved } from '../shared/template-resolver'
import { readAndReconcileState, emptyState, writeState } from '../shared/env-state'
import { addToIndex, removeFromIndex, allEnvDirs } from '../shared/env-index'
import { broadcast } from './broadcast'
import { appendActivity } from './activity-manager'
import { handleEnvStatusUpdate } from './pending-session-launches'
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

function detectServiceLanguage(command: string): 'node' | 'python' | null {
  if (/\b(node|npm|npx|tsx|ts-node|bun)\b/.test(command)) return 'node'
  if (/\b(python|manage\.py|django|gunicorn|uvicorn|flask)\b/.test(command)) return 'python'
  return null
}

// ---- Daemon event wiring ----

let _wired = false

export function wireEnvDaemonEvents(): void {
  if (_wired) return
  _wired = true

  const client = getEnvDaemonClient()

  client.on('env-changed', (environments: EnvStatus[]) => {
    broadcast('env:list', environments)
    try { handleEnvStatusUpdate(environments) } catch (err) {
      console.warn('[env-manager] pending-session-launches update failed:', err)
    }
  })

  client.on('service-output', (envId: string, service: string, data: string) => {
    broadcast('env:service-output', { envId, service, data })
  })

  client.on('service-crashed', (envId: string, service: string, exitCode: number) => {
    broadcast('env:service-crashed', { envId, service, exitCode })
    appendActivity({ source: 'env', name: envId, summary: `Service "${service}" crashed (exit ${exitCode}) in environment "${envId}"`, level: 'error' })

    // Auto-restart crashed service if policy is 'on-crash'
    getRestartPolicy(envId).then(policy => {
      if (policy === 'on-crash') {
        setTimeout(() => {
          getEnvDaemonClient().restartService(envId, service).catch(err => {
            console.warn(`[env-manager] auto-restart of ${service} in ${envId} failed:`, err)
          })
        }, 5000)
      }
    }).catch(() => {})
  })

  client.on('connected', () => {
    console.log('[env-manager] envd connected')
    // After (re)connection, fetch current state and broadcast to renderer
    // so the UI is always in sync with the daemon
    client.status().then((environments) => {
      broadcast('env:list', environments)
      try { handleEnvStatusUpdate(environments) } catch { /* non-fatal */ }
    }).catch(() => {})
  })

  client.on('disconnected', () => {
    console.log('[env-manager] envd disconnected')
  })
}

// ---- Init ----

let watchInterval: ReturnType<typeof setInterval> | null = null
const knownManifests = new Set<string>()

export function stopWatching(): void {
  if (watchInterval) {
    clearInterval(watchInterval)
    watchInterval = null
  }
}

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

    // Clean up worktrees whose environment no longer exists (fire-and-forget)
    const envIds = allEnvDirs().map(e => e.id)
    cleanupOrphans(envIds).catch(err => console.warn('[env-manager] worktree orphan cleanup failed:', err))

    // Load .colony/ configs from all known repos (fire-and-forget — non-blocking)
    void refreshRepoConfigs()

    // Broadcast current state to renderer so it doesn't have to wait for polling
    try {
      const environments = await client.status()
      broadcast('env:list', environments)
    } catch { /* envd may have no environments yet */ }

    // Watch for new environments created by the Instance Agent
    await startWatchingForNewEnvironments()
  } catch (err) {
    console.error('[env-manager] failed to init envd:', err)
  }
}

const knownTemplates = new Set<string>()

async function startWatchingForNewEnvironments(): Promise<void> {
  if (watchInterval) return
  if (!await pathExists(ENVIRONMENTS_DIR)) await fsp.mkdir(ENVIRONMENTS_DIR, { recursive: true })
  await ensureTemplatesDir()

  // Poll every 5 seconds for new instance.json files AND new templates
  watchInterval = setInterval(async () => {
    // Watch instances
    try {
      const entries = await fsp.readdir(ENVIRONMENTS_DIR)
      for (const entry of entries) {
        const manifestPath = path.join(ENVIRONMENTS_DIR, entry, 'instance.json')
        if (knownManifests.has(manifestPath)) continue
        if (!await pathExists(manifestPath)) continue

        try {
          const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as InstanceManifest
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
      for (const file of await fsp.readdir(TEMPLATES_DIR)) {
        if (!file.endsWith('.json')) continue
        const fp = path.join(TEMPLATES_DIR, file)
        if (!knownTemplates.has(fp)) {
          knownTemplates.add(fp)
          newTemplate = true
        }
      }
      if (newTemplate) {
        broadcast('env:templates-changed', await listTemplates())
      }
    } catch { /* ignore */ }
  }, 5000)
}

async function syncEnvironmentsFromDisk(): Promise<void> {
  if (!await pathExists(ENVIRONMENTS_DIR)) return

  const client = getEnvDaemonClient()
  const entries = await fsp.readdir(ENVIRONMENTS_DIR)

  for (const entry of entries) {
    const manifestPath = path.join(ENVIRONMENTS_DIR, entry, 'instance.json')
    if (!await pathExists(manifestPath)) continue

    try {
      const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as InstanceManifest
      if (manifest.version === 2 && manifest.id) {
        knownManifests.add(manifestPath)
        await client.register(manifest)
      }
    } catch { /* skip invalid */ }
  }
}

// ---- Template Management ----

const TEMPLATES_DIR = colonyPaths.templates

async function ensureTemplatesDir(): Promise<void> {
  if (!await pathExists(TEMPLATES_DIR)) await fsp.mkdir(TEMPLATES_DIR, { recursive: true })
}

export async function listTemplates(): Promise<EnvironmentTemplate[]> {
  await ensureTemplatesDir()
  const templates: EnvironmentTemplate[] = []

  // 1. User templates (from ~/.claude-colony/environment-templates/)
  for (const file of await fsp.readdir(TEMPLATES_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const content = await fsp.readFile(path.join(TEMPLATES_DIR, file), 'utf-8')
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

export async function getTemplate(id: string): Promise<EnvironmentTemplate | null> {
  const templates = await listTemplates()
  return templates.find(t => t.id === id) || null
}

export async function saveTemplate(template: EnvironmentTemplate): Promise<void> {
  await ensureTemplatesDir()
  const safeName = template.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
  const filePath = path.join(TEMPLATES_DIR, `${safeName}.json`)
  template.updatedAt = new Date().toISOString()
  await fsp.writeFile(filePath, JSON.stringify(template, null, 2), 'utf-8')
}

export async function deleteTemplate(id: string): Promise<boolean> {
  await ensureTemplatesDir()
  for (const file of await fsp.readdir(TEMPLATES_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      const content = JSON.parse(await fsp.readFile(path.join(TEMPLATES_DIR, file), 'utf-8'))
      if (content.id === id) {
        await fsp.unlink(path.join(TEMPLATES_DIR, file))
        return true
      }
    } catch { /* skip */ }
  }
  return false
}

// ---- Repo Config Refresh ----

/** Scan all known repos for .colony/ directories and cache their configs.
 *  Fetches bare repos first so we read the latest remote state. */
export async function refreshRepoConfigs(): Promise<void> {
  try {
    clearRepoConfigCache()
    const repos = await getRepos()
    let loaded = 0
    for (const repo of repos) {
      const localPath = repo.localPath
      if (!localPath || !await pathExists(localPath)) continue
      // Fetch latest for bare repos so .colony/ discovery reads current remote state
      if (localPath.endsWith('.git')) {
        try {
          await execFileAsync(resolveCommand('git'), ['fetch', 'origin', '--prune'], { cwd: localPath, timeout: 15000 })
        } catch { /* non-fatal */ }
      }
      const config = await getRepoConfig(localPath, `${repo.owner}/${repo.name}`)
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

  if (await pathExists(envDir)) throw new Error(`Environment '${name}' already exists at ${envDir}`)

  // Load template if specified
  let template: EnvironmentTemplate | null = null
  if (opts.templateId) {
    template = await getTemplate(opts.templateId)
    if (!template) throw new Error(`Template '${opts.templateId}' not found`)
  }

  const branch = opts.branch || template?.branches?.default || 'develop'
  const baseBranch = opts.baseBranch || opts.target || template?.branches?.default || 'develop'

  // Create directory
  await fsp.mkdir(envDir, { recursive: true })
  await fsp.mkdir(path.join(envDir, 'logs'), { recursive: true })

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
  const trackedRepos = await getRepos()
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
          if (await pathExists(path.join(homeProjects, '.git'))) {
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
      remotes[repo.as] = repo.remoteUrl || await gitRemoteUrl(repo.owner, repo.name)
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

  await fsp.writeFile(path.join(envDir, 'instance.json'), manifestJson, 'utf-8')
  commitAllocations(portMap)

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
  const envDir = await findEnvDir(envId)
  if (!envDir) throw new Error(`Environment ${envId} not found`)
  return runSetup(envDir, getTemplate)
}

// ---- Helpers ----

async function findEnvDir(envId: string): Promise<string | null> {
  // Check the environment index first (fast lookup)
  const index = allEnvDirs()
  const indexed = index.find(e => e.id === envId)
  if (indexed) return indexed.dir

  // Fallback: scan default environments directory
  if (await pathExists(ENVIRONMENTS_DIR)) {
    for (const entry of await fsp.readdir(ENVIRONMENTS_DIR)) {
      const manifestPath = path.join(ENVIRONMENTS_DIR, entry, 'instance.json')
      if (!await pathExists(manifestPath)) continue
      try {
        const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'))
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
    return await listEnvironmentsFromDisk()
  }
}

/** Fallback: read manifests + state.json from disk when daemon is unavailable */
async function listEnvironmentsFromDisk(): Promise<EnvStatus[]> {
  const results: EnvStatus[] = []
  const seen = new Set<string>()

  // Collect all env dirs from the index + default environments directory
  const dirs: string[] = allEnvDirs().map(e => e.dir)

  // Also scan default environments directory for any not in the index
  if (await pathExists(ENVIRONMENTS_DIR)) {
    for (const entry of await fsp.readdir(ENVIRONMENTS_DIR)) {
      const d = path.join(ENVIRONMENTS_DIR, entry)
      if (await pathExists(path.join(d, 'instance.json'))) dirs.push(d)
    }
  }

  for (const envDir of dirs) {
    const manifestPath = path.join(envDir, 'instance.json')
    if (!await pathExists(manifestPath)) continue
    try {
      const manifest: InstanceManifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8'))
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

      // Use branch from manifest — avoids N sequential git probes in the fallback path
      const liveBranch = manifest.git?.branch || ''

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

/**
 * Toggle debug mode on an environment. Allocates debug ports when enabling,
 * updates the manifest, and tells envd to restart affected services with debug flags.
 */
export async function toggleDebug(envId: string, enabled: boolean, service?: string): Promise<void> {
  const envDir = await findEnvDir(envId)
  if (!envDir) throw new Error(`Environment ${envId} not found`)

  const manifestPath = path.join(envDir, 'instance.json')
  const manifest = JSON.parse(await fsp.readFile(manifestPath, 'utf-8')) as InstanceManifest

  const serviceNames = service ? [service] : Object.keys(manifest.services)

  if (enabled) {
    // Allocate a debug port for each service that needs one
    const needsPorts = serviceNames.filter(name => !manifest.services[name]?.debug?.port)
    if (needsPorts.length > 0) {
      const debugPortNames = needsPorts.map(name => `debug-${name}`)
      const portMap = await allocatePorts(debugPortNames)
      commitAllocations(portMap)
      for (const name of needsPorts) {
        const svc = manifest.services[name]
        if (!svc) continue
        svc.debug = {
          enabled: true,
          port: portMap[`debug-${name}`],
          language: svc.debug?.language,
        }
      }
    }
    // Enable debug on services that already have a port
    for (const name of serviceNames) {
      const svc = manifest.services[name]
      if (svc?.debug) svc.debug.enabled = true
    }
  } else {
    // Disable debug — keep port allocation for fast re-enable
    for (const name of serviceNames) {
      const svc = manifest.services[name]
      if (svc?.debug) svc.debug.enabled = false
    }
  }

  // Persist manifest
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  // Write debug MCP config for agent sessions
  const debugMcpConfigPath = path.join(envDir, 'debug-mcp-config.json')
  if (enabled) {
    const targets = serviceNames
      .map(name => {
        const svc = manifest.services[name]
        if (!svc?.debug?.enabled || !svc.debug.port) return null
        const lang = svc.debug.language || detectServiceLanguage(svc.command)
        if (!lang) return null
        return { name, language: lang, host: '127.0.0.1', port: svc.debug.port }
      })
      .filter(Boolean)
    if (targets.length > 0) {
      await fsp.writeFile(debugMcpConfigPath, JSON.stringify({ targets }, null, 2))
    }
  } else {
    // Clean up config if no services have debug enabled
    const anyDebug = Object.values(manifest.services).some(s => s.debug?.enabled)
    if (!anyDebug) {
      try { await fsp.unlink(debugMcpConfigPath) } catch { /* */ }
    }
  }

  // Tell envd to toggle + restart affected services
  await getEnvDaemonClient().toggleDebug(envId, enabled, service)
}

export async function getEnvironmentLogs(envId: string, service: string, lines?: number): Promise<string> {
  return await getEnvDaemonClient().logs(envId, service, lines)
}

export async function teardownEnvironment(envId: string): Promise<void> {
  const envDir = await findEnvDir(envId)
  if (!envDir) throw new Error(`Environment ${envId} not found`)

  // Read manifest to get environment slug for branch cleanup
  let envSlug: string | undefined
  try {
    const manifest = JSON.parse(await fsp.readFile(path.join(envDir, 'instance.json'), 'utf-8')) as InstanceManifest
    envSlug = manifest.name
  } catch { /* continue without slug */ }

  // Delegate to the daemon: stops services, waits for them to die, runs hooks, unregisters.
  try {
    await getEnvDaemonClient().teardown(envId)
  } catch (err) {
    console.error(`[env-manager] daemon teardown failed (continuing with cleanup):`, err)
    try { await getEnvDaemonClient().stop(envId) } catch { /* */ }
    try { await getEnvDaemonClient().unregister(envId) } catch { /* */ }
  }

  // Unmount standalone worktrees (new system) — worktrees survive env teardown
  try {
    await unmountAllForEnv(envId)
  } catch (err) {
    console.error(`[env-manager] worktree unmount failed (continuing):`, err)
  }

  // Clean up legacy in-env worktrees (old system — worktrees inside envDir).
  // Only removes worktrees that live inside the env directory itself.
  try {
    if (await pathExists(envDir)) {
      const entries = await fsp.readdir(envDir)
      for (const entry of entries) {
        const subdir = path.join(envDir, entry)
        try {
          if (!(await fsp.stat(subdir)).isDirectory()) continue
        } catch { continue }

        if (isWorktree(subdir)) {
          const bareDir = getBareRepoForWorktree(subdir)
          if (bareDir) {
            console.log(`[env-manager] removing legacy in-env worktree: ${subdir} from ${bareDir}`)
            await removeWorktree(bareDir, subdir, envSlug)
          }
        }
      }
    }
  } catch (err) {
    console.error(`[env-manager] legacy worktree cleanup failed (continuing with rm):`, err)
  }

  // Remove from index
  removeFromIndex(envId)

  // Delete env directory — only contains config, logs, and legacy worktrees (not standalone ones)
  try {
    await fsp.rm(envDir, { recursive: true, force: true })
  } catch (err) {
    console.error(`[env-manager] failed to remove ${envDir}:`, err)
  }
}

/**
 * Get the manifest for an environment by ID.
 */
export async function getManifest(envId: string): Promise<InstanceManifest | null> {
  const envDir = await findEnvDir(envId)
  if (!envDir) return null

  const manifestPath = path.join(envDir, 'instance.json')
  try {
    return JSON.parse(await fsp.readFile(manifestPath, 'utf-8'))
  } catch {
    return null
  }
}

/**
 * Clone an environment — read source manifest and create a new environment with the same config.
 */
export async function cloneEnvironment(sourceEnvId: string, newName: string): Promise<InstanceManifest> {
  const source = await getManifest(sourceEnvId)
  if (!source) throw new Error(`Source environment ${sourceEnvId} not found`)
  const templateId = (source as any).meta?.templateId
  return createEnvironment({
    name: newName,
    branch: source.git?.branch,
    baseBranch: source.git?.baseBranch,
    templateId: templateId || undefined,
  })
}

/**
 * Fix an existing environment — re-resolve template variables with fresh port allocation.
 * Preserves: id, name, createdAt, git, paths, setup status for completed steps.
 * Re-resolves: ports, services, hooks, resources, urls.
 */
export async function fixEnvironment(envId: string): Promise<{ fixed: string[] }> {
  const manifest = await getManifest(envId)
  if (!manifest) throw new Error(`Environment ${envId} not found`)

  const templateId = (manifest as any).meta?.templateId
  const template = templateId ? await getTemplate(templateId) : null
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
  const envDirPath = await findEnvDir(envId)
  if (!envDirPath) throw new Error(`Environment directory not found for ${envId}`)
  await fsp.writeFile(path.join(envDirPath, 'instance.json'), manifestJson, 'utf-8')
  if (portsNeedRealloc) commitAllocations(portMap)
  await getEnvDaemonClient().register(updated).catch(() => {})

  if (fixed.length === 0) fixed.push('no changes needed')
  console.log(`[env-manager:fix] ${manifest.name}: ${fixed.join(', ')}`)
  return { fixed }
}

// ---- Restart Policy ----

async function getRestartPolicy(envId: string): Promise<'manual' | 'on-crash'> {
  const manifest = await getManifest(envId)
  return (manifest?.meta?.restartPolicy as 'manual' | 'on-crash') || 'manual'
}

export async function setRestartPolicy(envId: string, policy: 'manual' | 'on-crash'): Promise<void> {
  const manifest = await getManifest(envId)
  if (!manifest) throw new Error(`Environment ${envId} not found`)
  manifest.meta = { ...manifest.meta, restartPolicy: policy }
  await saveManifest(envId, manifest)
}

// ---- Purpose Tag ----

export type PurposeTag = 'interactive' | 'background' | 'nightly'

export async function getPurposeTag(envId: string): Promise<PurposeTag | null> {
  const manifest = await getManifest(envId)
  return (manifest?.meta?.purposeTag as PurposeTag) || null
}

export async function setPurposeTag(envId: string, tag: PurposeTag | null): Promise<void> {
  const manifest = await getManifest(envId)
  if (!manifest) throw new Error(`Environment ${envId} not found`)
  manifest.meta = { ...manifest.meta, purposeTag: tag ?? undefined }
  await saveManifest(envId, manifest)
}

export async function saveManifest(envId: string, manifest: InstanceManifest): Promise<void> {
  // Validate required fields to prevent malformed data on disk
  if (!manifest || typeof manifest !== 'object') throw new Error('Invalid manifest: not an object')
  if (!manifest.id || !manifest.name) throw new Error('Invalid manifest: missing id or name')
  if (manifest.id !== envId) throw new Error(`Manifest id "${manifest.id}" does not match envId "${envId}"`)
  if (!manifest.services || typeof manifest.services !== 'object') throw new Error('Invalid manifest: missing services')
  if (!manifest.ports || typeof manifest.ports !== 'object') throw new Error('Invalid manifest: missing ports')
  if (!manifest.paths || typeof manifest.paths !== 'object') throw new Error('Invalid manifest: missing paths')

  const envDir = await findEnvDir(envId)
  if (!envDir) throw new Error(`Environment ${envId} not found`)

  const manifestPath = path.join(envDir, 'instance.json')
  await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
  // Re-register with envd
  getEnvDaemonClient().register(manifest).catch(() => {})
}
