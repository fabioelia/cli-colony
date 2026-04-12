/**
 * envd — Environment Daemon
 *
 * Standalone Node.js process that manages background service processes
 * (web servers, workers, etc.) for development environments.
 * Survives Electron app crashes/restarts. Communicates over Unix domain sockets.
 *
 * Launched via: ELECTRON_RUN_AS_NODE=1 <electron-binary> <this-script>
 *
 * Key differences from pty-daemon:
 * - No PTY allocation — uses child_process.spawn with piped stdout/stderr
 * - Captures output to log files, not terminal buffers
 * - Health checking and crash recovery with exponential backoff
 * - Topological service startup ordering
 * - Template variable resolution in manifests
 * - Persists registry to disk for recovery after daemon restart
 */

import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { spawn, ChildProcess } from 'child_process'
import type {
  InstanceManifest,
  ServiceDef,
  ServiceStatus,
  ServiceState,
  EnvStatus,
  EnvState,
  EnvRequest,
  EnvResponse,
  EnvEvent,
} from './env-protocol'

// ---- Paths ----

import { colonyPaths } from '../shared/colony-paths'

const HOME = process.env.HOME || '/'
const COLONY_DIR = colonyPaths.root
const SOCKET_PATH = colonyPaths.envdSock
const PID_PATH = colonyPaths.envdPid
// Registry replaced by per-env state.json + environments.json index
const ENVIRONMENTS_DIR = path.join(COLONY_DIR, 'environments')
const LOG_PATH = path.join(COLONY_DIR, 'envd.log')

// ---- Shell environment ----

import { loadShellEnv } from '../shared/shell-env'

const shellEnv = loadShellEnv()

// ---- Logging ----

function log(msg: string): void {
  const ts = new Date().toISOString().substring(11, 23)
  const line = `[envd ${ts}] ${msg}\n`
  try { fs.appendFileSync(LOG_PATH, line) } catch { /* */ }
}

// ---- State Persistence & Template Resolution ----

import { createResolver, resolveService } from '../shared/template-resolver'
import { writeState, readAndReconcileState, emptyState, isPidAlive, type EnvState, type ServiceState as FileServiceState } from '../shared/env-state'
import { allEnvDirs, addToIndex } from '../shared/env-index'
import { pruneAllBareRepos } from '../shared/git-worktree'

/**
 * Resolves ${...} template variables in a string against the manifest.
 * Uses 'keep-original' mode — unresolved variables are preserved (the manifest
 * should already have all values resolved by env-manager, so anything left is
 * likely not a template variable, e.g. bash ${VAR} syntax).
 */
function resolveTemplate(template: string, manifest: InstanceManifest): string {
  const resolve = createResolver(manifest as any, { onUnresolved: 'keep-original', label: 'envd' })
  return resolve(template)
}

function resolveServiceDef(def: ServiceDef, manifest: InstanceManifest): ServiceDef {
  const resolve = createResolver(manifest as any, { onUnresolved: 'keep-original', label: 'envd' })
  return resolveService(def, resolve) as ServiceDef
}

// ---- Topological Sort ----

function topoSort(services: Record<string, ServiceDef>): string[][] {
  const names = Object.keys(services)
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const name of names) {
    inDegree.set(name, 0)
    dependents.set(name, [])
  }

  for (const name of names) {
    const deps = services[name].dependsOn || []
    for (const dep of deps) {
      if (names.includes(dep)) {
        inDegree.set(name, (inDegree.get(name) || 0) + 1)
        dependents.get(dep)!.push(name)
      }
    }
  }

  const waves: string[][] = []
  const remaining = new Set(names)

  while (remaining.size > 0) {
    const wave: string[] = []
    for (const name of remaining) {
      if ((inDegree.get(name) || 0) === 0) {
        wave.push(name)
      }
    }
    if (wave.length === 0) {
      // Circular dependency — just add all remaining
      waves.push([...remaining])
      break
    }
    waves.push(wave)
    for (const name of wave) {
      remaining.delete(name)
      for (const dep of dependents.get(name) || []) {
        inDegree.set(dep, (inDegree.get(dep) || 0) - 1)
      }
    }
  }

  return waves
}

// ---- Service Process Management ----

interface ManagedService {
  name: string
  def: ServiceDef
  resolved: ServiceDef
  process: ChildProcess | null
  pid: number | null
  status: ServiceState
  startedAt: number | null
  restarts: number
  maxRestarts: number
  logStream: fs.WriteStream | null
  healthTimer: ReturnType<typeof setInterval> | null
  backoffTimer: ReturnType<typeof setTimeout> | null
  initialTimer: ReturnType<typeof setTimeout> | null
}

interface ManagedEnvironment {
  manifest: InstanceManifest
  services: Map<string, ManagedService>
  wasRunning: boolean // track if it was running before envd stopped (for auto-restart)
}

const environments = new Map<string, ManagedEnvironment>()

/** Write current service state to the environment's state.json */
function persistState(env: ManagedEnvironment): void {
  const envDir = env.manifest.paths?.root
  if (!envDir) return

  const services: Record<string, FileServiceState> = {}
  for (const [name, svc] of env.services) {
    services[name] = {
      status: svc.status as FileServiceState['status'],
      pid: svc.pid,
      port: svc.resolved?.port != null ? parseInt(String(svc.resolved.port), 10) || null : null,
      startedAt: svc.startedAt,
      restarts: svc.restarts,
    }
  }

  const hasRunning = Array.from(env.services.values()).some(s => s.status === 'running')
  const state: EnvState = {
    envId: env.manifest.id,
    services,
    shouldBeRunning: hasRunning || env.wasRunning,
    updatedAt: new Date().toISOString(),
  }
  writeState(envDir, state)
}

// Registry replaced by per-environment state.json files; saveRegistry removed.

// ---- Log File Management ----

function ensureLogDir(manifest: InstanceManifest): string {
  const logDir = manifest.logs?.dir
    ? resolveTemplate(manifest.logs.dir, manifest)
    : path.join(manifest.paths.root || ENVIRONMENTS_DIR, 'logs')
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true })
  }
  return logDir
}

function openLogStream(manifest: InstanceManifest, serviceName: string): fs.WriteStream {
  const logDir = ensureLogDir(manifest)
  const logPath = path.join(logDir, `${serviceName}.log`)

  // Rotate if too large
  const maxSize = (manifest.logs?.maxSizeKb || 500) * 1024
  try {
    if (fs.existsSync(logPath)) {
      const stat = fs.statSync(logPath)
      if (stat.size > maxSize) {
        const retention = manifest.logs?.retention || 5
        // Shift old logs
        for (let i = retention; i >= 1; i--) {
          const from = i === 1 ? logPath : path.join(logDir, `${serviceName}.${i - 1}.log`)
          const to = path.join(logDir, `${serviceName}.${i}.log`)
          if (fs.existsSync(from)) {
            try { fs.renameSync(from, to) } catch { /* */ }
          }
        }
      }
    }
  } catch { /* */ }

  return fs.createWriteStream(logPath, { flags: 'a' })
}

// ---- Health Checking ----

function checkPortTcp(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket()
    socket.setTimeout(2000)
    socket.on('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => {
      socket.destroy()
      resolve(false)
    })
    socket.connect(port, '127.0.0.1')
  })
}

// isPidAlive imported from shared/env-state

// ---- Stale PID Cleanup ----

/**
 * Kill stale processes from a previous daemon session.
 * Uses SIGTERM first, waits up to 5s, then SIGKILL.
 * Returns after all processes are confirmed dead or timeout.
 */
async function killStalePids(pids: Record<string, number>, envName: string): Promise<void> {
  const alive: Array<{ name: string; pid: number }> = []

  for (const [name, pid] of Object.entries(pids)) {
    if (isPidAlive(pid)) {
      alive.push({ name, pid })
    }
  }

  if (alive.length === 0) return

  // SIGTERM all alive processes (try process group first, then direct)
  for (const { name, pid } of alive) {
    log(`[${envName}/${name}] killing stale process pid=${pid} (SIGTERM, process group)`)
    try { process.kill(-pid, 'SIGTERM') } catch {
      try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
    }
  }

  // Wait up to 5s for graceful shutdown
  const deadline = Date.now() + 5000
  await new Promise<void>((resolve) => {
    const check = () => {
      const stillAlive = alive.filter(({ pid }) => isPidAlive(pid))
      if (stillAlive.length === 0 || Date.now() >= deadline) {
        // SIGKILL any survivors (process group first)
        for (const { name, pid } of stillAlive) {
          log(`[${envName}/${name}] force-killing stale process pid=${pid} (SIGKILL, process group)`)
          try { process.kill(-pid, 'SIGKILL') } catch {
            try { process.kill(pid, 'SIGKILL') } catch { /* */ }
          }
        }
        resolve()
      } else {
        setTimeout(check, 250)
      }
    }
    check()
  })
}

// ---- Service Lifecycle ----

function spawnService(env: ManagedEnvironment, svc: ManagedService): void {
  const manifest = env.manifest
  const resolved = resolveServiceDef(svc.def, manifest)
  svc.resolved = resolved

  // Always run through a shell — commands use shell builtins (source, &&, ||, pipes, etc.)
  const cmd = '/bin/bash'
  const args = ['-c', resolved.command]

  const cwd = resolved.cwd
  if (!fs.existsSync(cwd)) {
    log(`[${manifest.name}/${svc.name}] cwd does not exist: ${cwd}`)
    svc.status = 'crashed'
    return
  }

  // Build environment
  const serviceEnv = {
    ...shellEnv,
    ...(resolved.env || {}),
  }

  // Open log stream
  if (svc.logStream) {
    try { svc.logStream.end() } catch { /* */ }
  }
  svc.logStream = openLogStream(manifest, svc.name)

  log(`[${manifest.name}/${svc.name}] spawning: ${cmd} ${args.join(' ')} (cwd: ${cwd})`)

  // Write spawn info to service log so there's always something to read on crash
  const spawnInfo = `[envd] spawning: ${resolved.command}\n[envd] cwd: ${cwd}\n[envd] pid: pending\n`
  if (svc.logStream) svc.logStream.write(spawnInfo)

  try {
    const child = spawn(cmd, args, {
      cwd,
      env: serviceEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // creates a new process group so we can kill the entire tree
    })

    svc.process = child
    svc.pid = child.pid || null
    svc.status = 'starting'
    svc.startedAt = Date.now()

    if (svc.logStream) svc.logStream.write(`[envd] started with pid ${child.pid}\n`)

    const ts = () => new Date().toISOString().substring(11, 23)

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      const stamped = `[${ts()}] ${text}`
      if (svc.logStream) svc.logStream.write(stamped)
      broadcastEvent({
        type: 'service-output',
        envId: manifest.id,
        service: svc.name,
        data: text,
      })
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      const stamped = `[${ts()} ERR] ${text}`
      if (svc.logStream) svc.logStream.write(stamped)
      broadcastEvent({
        type: 'service-output',
        envId: manifest.id,
        service: svc.name,
        data: text,
      })
    })

    child.on('exit', (code, signal) => {
      log(`[${manifest.name}/${svc.name}] exited code=${code} signal=${signal}`)
      const exitMsg = `[envd] process exited with code=${code} signal=${signal}\n`
      if (svc.logStream) svc.logStream.write(exitMsg)
      broadcastEvent({ type: 'service-output', envId: manifest.id, service: svc.name, data: exitMsg })
      svc.process = null
      svc.pid = null

      if (svc.status === 'stopped') {
        return
      }

      svc.status = 'crashed'
      broadcastEvent({
        type: 'service-crashed',
        envId: manifest.id,
        service: svc.name,
        exitCode: code ?? -1,
      })

      if (svc.restarts < svc.maxRestarts) {
        const backoff = [1000, 5000, 15000][svc.restarts] || 15000
        log(`[${manifest.name}/${svc.name}] restarting in ${backoff}ms (attempt ${svc.restarts + 1}/${svc.maxRestarts})`)
        svc.backoffTimer = setTimeout(() => {
          svc.restarts++
          spawnService(env, svc)
        }, backoff)
      } else {
        log(`[${manifest.name}/${svc.name}] max restarts reached, staying crashed`)
      }

      notifyChanged()
    })

    child.on('error', (err) => {
      log(`[${manifest.name}/${svc.name}] spawn error: ${err}`)
      const errMsg = `[envd] spawn error: ${err}\n`
      if (svc.logStream) svc.logStream.write(errMsg)
      broadcastEvent({ type: 'service-output', envId: manifest.id, service: svc.name, data: errMsg })
      svc.process = null
      svc.pid = null
      svc.status = 'crashed'
      notifyChanged()
    })

    // Start health check
    startHealthCheck(env, svc)
    notifyChanged()

  } catch (err) {
    log(`[${manifest.name}/${svc.name}] failed to spawn: ${err}`)
    const errMsg = `[envd] failed to spawn: ${err}\n`
    if (svc.logStream) svc.logStream.write(errMsg)
    broadcastEvent({ type: 'service-output', envId: manifest.id, service: svc.name, data: errMsg })
    svc.status = 'crashed'
    notifyChanged()
  }
}

function startHealthCheck(env: ManagedEnvironment, svc: ManagedService): void {
  if (svc.healthTimer) clearInterval(svc.healthTimer)

  const hc = svc.resolved.healthCheck || svc.def.healthCheck
  if (!hc) {
    // No health check defined — mark as running after a short delay
    svc.initialTimer = setTimeout(() => {
      svc.initialTimer = null
      if (svc.process && svc.status === 'starting') {
        svc.status = 'running'
        notifyChanged()
      }
    }, 2000)
    return
  }

  const interval = hc.intervalMs || (hc.interval ? hc.interval * 1000 : 5000)

  const check = async () => {
    if (!svc.process && svc.status !== 'starting') return

    let healthy = false

    if (hc.type === 'http' && hc.url) {
      const url = resolveTemplate(hc.url, env.manifest)
      const expectedStatus = hc.expectedStatus // undefined = any response means healthy
      const timeout = hc.timeoutMs || 5000
      try {
        const http = require('http') as typeof import('http')
        healthy = await new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => { req.destroy(); resolve(false) }, timeout)
          const req = http.get(url, (res) => {
            clearTimeout(timer)
            // If expectedStatus is set, match exactly. Otherwise, any response = alive.
            resolve(expectedStatus ? res.statusCode === expectedStatus : (res.statusCode ?? 0) < 500)
            res.resume()
          })
          req.on('error', () => { clearTimeout(timer); resolve(false) })
        })
      } catch { healthy = false }
    } else if (hc.type === 'tcp' && hc.port) {
      const port = parseInt(resolveTemplate(String(hc.port), env.manifest), 10)
      if (!isNaN(port)) {
        healthy = await checkPortTcp(port)
      }
    } else if (hc.type === 'process') {
      healthy = svc.pid != null && isPidAlive(svc.pid)
    }

    if (healthy && svc.status === 'starting') {
      svc.status = 'running'
      log(`[${env.manifest.name}/${svc.name}] healthy`)
      notifyChanged()
      // Stop health probes — service is running, no need to keep checking
      if (svc.healthTimer) {
        clearInterval(svc.healthTimer)
        svc.healthTimer = null
      }
    }
  }

  // Initial check after 2s, then on interval
  svc.initialTimer = setTimeout(check, 2000)
  svc.healthTimer = setInterval(check, interval)
}

function stopService(svc: ManagedService): void {
  svc.status = 'stopped'

  if (svc.healthTimer) {
    clearInterval(svc.healthTimer)
    svc.healthTimer = null
  }

  if (svc.backoffTimer) {
    clearTimeout(svc.backoffTimer)
    svc.backoffTimer = null
  }

  if (svc.initialTimer) {
    clearTimeout(svc.initialTimer)
    svc.initialTimer = null
  }

  if (svc.process) {
    const pid = svc.process.pid
    try {
      // Kill the entire process group (negative pid) so child processes die too
      if (pid) process.kill(-pid, 'SIGTERM')
    } catch {
      // Fallback to direct kill if process group kill fails
      try { svc.process.kill('SIGTERM') } catch { /* already dead */ }
    }
    // Force kill after 5s if still alive
    setTimeout(() => {
      if (pid && isPidAlive(pid)) {
        try { process.kill(-pid, 'SIGKILL') } catch {
          try { process.kill(pid, 'SIGKILL') } catch { /* */ }
        }
      }
    }, 5000)
    svc.process = null
    svc.pid = null
  } else if (svc.pid != null) {
    // No ChildProcess handle (e.g., orphaned from previous daemon session) — kill by PID directly
    const pid = svc.pid
    try { process.kill(-pid, 'SIGTERM') } catch {
      try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
    }
    setTimeout(() => {
      if (isPidAlive(pid)) {
        try { process.kill(-pid, 'SIGKILL') } catch {
          try { process.kill(pid, 'SIGKILL') } catch { /* */ }
        }
      }
    }, 5000)
    svc.pid = null
  }

  if (svc.logStream) {
    try { svc.logStream.end() } catch { /* */ }
    svc.logStream = null
  }

  svc.restarts = 0
}

// ---- Hook Execution ----

async function runHooks(manifest: InstanceManifest, hookName: string): Promise<void> {
  const hooks = (manifest.hooks as any)?.[hookName] as any[] | undefined
  if (!hooks || hooks.length === 0) return

  const { exec } = require('child_process') as typeof import('child_process')
  for (const hook of hooks) {
    if (!hook.command) continue
    log(`[${manifest.name}] running ${hookName} hook "${hook.name}"`)
    try {
      await new Promise<void>((resolve) => {
        exec(hook.command, {
          cwd: hook.cwd || manifest.paths?.root,
          timeout: 15000,
          env: shellEnv,
        }, (err) => {
          if (err) {
            log(`[${manifest.name}] ${hookName} hook "${hook.name}" failed: ${err.message}`)
          }
          resolve() // always continue
        })
      })
    } catch (err) {
      log(`[${manifest.name}] ${hookName} hook "${hook.name}" error: ${err}`)
    }
  }
}

// ---- Environment Operations ----

function registerEnvironment(manifest: InstanceManifest): void {
  if (environments.has(manifest.id)) {
    const existing = environments.get(manifest.id)!
    existing.manifest = manifest
    log(`updated environment ${manifest.name} (${manifest.id})`)
  } else {
    const services = new Map<string, ManagedService>()

    // Try to load existing state from disk (survives daemon restarts)
    const envDir = manifest.paths?.root
    const existingState = envDir ? readAndReconcileState(envDir) : null

    for (const [name, def] of Object.entries(manifest.services)) {
      const savedSvc = existingState?.services?.[name]
      services.set(name, {
        name,
        def,
        resolved: def,
        process: null,
        pid: savedSvc?.pid ?? null,
        status: savedSvc?.status ?? 'stopped',
        startedAt: savedSvc?.startedAt ?? null,
        restarts: savedSvc?.restarts ?? 0,
        maxRestarts: 3,
        logStream: null,
        healthTimer: null,
        backoffTimer: null,
        initialTimer: null,
      })
    }

    const wasRunning = existingState?.shouldBeRunning ?? false
    environments.set(manifest.id, { manifest, services, wasRunning })
    log(`registered environment ${manifest.name} (${manifest.id}) with ${services.size} services${existingState ? ' (restored state from disk)' : ''}`)

    // Ensure it's in the environment index
    if (envDir) addToIndex(manifest.id, envDir)
  }
  notifyChanged()
}

function unregisterEnvironment(envId: string): boolean {
  const env = environments.get(envId)
  if (!env) return false

  // Stop all services first
  for (const svc of env.services.values()) {
    stopService(svc)
  }

  environments.delete(envId)
  notifyChanged()
  log(`unregistered environment ${env.manifest.name} (${envId})`)
  return true
}

async function startEnvironment(envId: string, serviceNames?: string[]): Promise<void> {
  const env = environments.get(envId)
  if (!env) throw new Error(`environment ${envId} not found`)

  env.wasRunning = true
  const manifest = env.manifest
  const servicesToStart = serviceNames
    ? serviceNames.filter(n => env.services.has(n))
    : Array.from(env.services.keys())

  // Get startup order
  const allServices: Record<string, ServiceDef> = {}
  for (const name of servicesToStart) {
    allServices[name] = env.services.get(name)!.def
  }
  const waves = topoSort(allServices)

  // Run preStart hooks before spawning any services
  await runHooks(manifest, 'preStart')

  log(`[${manifest.name}] starting services in ${waves.length} wave(s): ${waves.map(w => w.join(',')).join(' -> ')}`)

  for (const wave of waves) {
    for (const name of wave) {
      const svc = env.services.get(name)
      if (svc && svc.status !== 'running') {
        svc.restarts = 0
        spawnService(env, svc)
      }
    }

    // Wait for this wave's services to become healthy before next wave
    // Timeout after 60s per wave
    const waveStart = Date.now()
    const WAVE_TIMEOUT = 60000

    await new Promise<void>((resolve) => {
      const checkWave = () => {
        const allHealthy = wave.every(name => {
          const svc = env.services.get(name)
          return svc && (svc.status === 'running' || svc.status === 'crashed')
        })
        if (allHealthy || Date.now() - waveStart > WAVE_TIMEOUT) {
          resolve()
        } else {
          setTimeout(checkWave, 1000)
        }
      }
      checkWave()
    })
  }

  notifyChanged()
}

async function stopEnvironment(envId: string, serviceNames?: string[]): Promise<void> {
  const env = environments.get(envId)
  if (!env) return

  const servicesToStop = serviceNames
    ? serviceNames.filter(n => env.services.has(n))
    : Array.from(env.services.keys())

  for (const name of servicesToStop) {
    const svc = env.services.get(name)
    if (svc) stopService(svc)
  }

  // If all services stopped, mark as not running and run postStop hooks
  if (!serviceNames) {
    env.wasRunning = false
    await runHooks(env.manifest, 'postStop')
  }

  notifyChanged()
}

/**
 * Full teardown: stop services, wait for them to die, run preTeardown hooks, unregister.
 * Runs entirely in the daemon process so the main process isn't blocked.
 */
async function teardownEnvironment(envId: string): Promise<void> {
  const env = environments.get(envId)
  if (!env) return

  const manifest = env.manifest

  // 1. Stop all services
  await stopEnvironment(envId)

  // 2. Wait for all processes to actually die (up to 8s)
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    const anyAlive = Array.from(env.services.values()).some(svc =>
      svc.pid != null && isPidAlive(svc.pid)
    )
    if (!anyAlive) break
    await new Promise(r => setTimeout(r, 200))
  }

  // 3. Force kill anything still alive (process group first)
  for (const svc of env.services.values()) {
    if (svc.pid != null && isPidAlive(svc.pid)) {
      try { process.kill(-svc.pid, 'SIGKILL') } catch {
        try { process.kill(svc.pid, 'SIGKILL') } catch { /* */ }
      }
    }
  }

  // 4. Run preTeardown hooks in this process (not the main process)
  await runHooks(manifest, 'preTeardown')

  // 5. Unregister
  unregisterEnvironment(envId)
}

function restartService(envId: string, serviceName: string): void {
  const env = environments.get(envId)
  if (!env) return

  const svc = env.services.get(serviceName)
  if (!svc) return

  stopService(svc)
  svc.restarts = 0
  spawnService(env, svc)
}

function getServiceLogs(envId: string, serviceName: string, lines: number = 200): string {
  const env = environments.get(envId)
  if (!env) return ''

  const manifest = env.manifest
  const logDir = manifest.logs?.dir
    ? resolveTemplate(manifest.logs.dir, manifest)
    : path.join(manifest.paths.root || ENVIRONMENTS_DIR, 'logs')
  const logPath = path.join(logDir, `${serviceName}.log`)

  try {
    if (!fs.existsSync(logPath)) return ''
    const content = fs.readFileSync(logPath, 'utf-8')
    const allLines = content.split('\n')
    return allLines.slice(-lines).join('\n')
  } catch {
    return ''
  }
}

// ---- Status ----

function getServiceStatus(svc: ManagedService): ServiceStatus {
  return {
    name: svc.name,
    status: svc.status,
    pid: svc.pid,
    port: svc.resolved.port != null ? parseInt(String(svc.resolved.port), 10) || null : null,
    uptime: svc.startedAt ? Math.floor((Date.now() - svc.startedAt) / 1000) : 0,
    restarts: svc.restarts,
  }
}

function getEnvStatus(env: ManagedEnvironment): EnvStatus {
  const manifest = env.manifest
  const services = Array.from(env.services.values()).map(getServiceStatus)

  let status: EnvState
  if (manifest.setup?.status === 'creating') {
    status = 'creating'
  } else if (manifest.setup?.status === 'error') {
    status = 'error'
  } else {
    const running = services.filter(s => s.status === 'running').length
    const total = services.length
    if (running === 0) status = 'stopped'
    else if (running === total) status = 'running'
    else status = 'partial'
  }

  return {
    id: manifest.id,
    name: manifest.name,
    displayName: manifest.displayName,
    projectType: manifest.projectType,
    branch: manifest.git?.branch || '',
    status,
    services,
    urls: manifest.urls || {},
    ports: manifest.ports || {},
    paths: manifest.paths || {},
    createdAt: manifest.createdAt,
  }
}

function getAllStatus(): EnvStatus[] {
  return Array.from(environments.values()).map(getEnvStatus)
}

// ---- Event Broadcasting ----

const subscribers = new Set<net.Socket>()

function broadcastEvent(event: EnvEvent): void {
  const line = JSON.stringify(event) + '\n'
  for (const client of subscribers) {
    try {
      client.write(line)
    } catch { /* dead client */ }
  }
}

function notifyChanged(): void {
  // Persist state to disk for all environments
  for (const env of environments.values()) {
    persistState(env)
  }
  broadcastEvent({ type: 'env-changed', environments: getAllStatus() })
}

// ---- Request Handler ----

function handleRequest(req: EnvRequest, socket: net.Socket): void {
  const send = (resp: EnvResponse) => {
    try { socket.write(JSON.stringify(resp) + '\n') } catch { /* dead */ }
  }

  try {
    switch (req.type) {
      case 'register': {
        registerEnvironment(req.manifest)
        send({ type: 'ok', reqId: req.reqId })
        break
      }
      case 'unregister': {
        const ok = unregisterEnvironment(req.envId)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'teardown': {
        teardownEnvironment(req.envId)
          .then(() => send({ type: 'ok', reqId: req.reqId }))
          .catch(err => send({ type: 'error', reqId: req.reqId, message: String(err) }))
        break
      }
      case 'start': {
        startEnvironment(req.envId, req.services)
          .then(() => send({ type: 'ok', reqId: req.reqId }))
          .catch(err => send({ type: 'error', reqId: req.reqId, message: String(err) }))
        break
      }
      case 'stop': {
        stopEnvironment(req.envId, req.services)
          .then(() => send({ type: 'ok', reqId: req.reqId }))
          .catch(err => send({ type: 'error', reqId: req.reqId, message: String(err) }))
        break
      }
      case 'restart-service': {
        restartService(req.envId, req.service)
        send({ type: 'ok', reqId: req.reqId })
        break
      }
      case 'status': {
        send({ type: 'ok', reqId: req.reqId, data: getAllStatus() })
        break
      }
      case 'status-one': {
        const env = environments.get(req.envId)
        send({ type: 'ok', reqId: req.reqId, data: env ? getEnvStatus(env) : null })
        break
      }
      case 'logs': {
        const logs = getServiceLogs(req.envId, req.service, req.lines)
        send({ type: 'ok', reqId: req.reqId, data: logs })
        break
      }
      case 'subscribe': {
        subscribers.add(socket)
        send({ type: 'ok', reqId: req.reqId })
        break
      }
      case 'ping': {
        send({ type: 'ok', reqId: req.reqId })
        broadcastEvent({ type: 'pong' })
        break
      }
      case 'shutdown': {
        send({ type: 'ok', reqId: req.reqId })
        log('shutdown requested')
        shutdown()
        break
      }
      default:
        send({ type: 'error', reqId: (req as EnvRequest).reqId, message: 'unknown request type' })
    }
  } catch (err) {
    send({ type: 'error', reqId: req.reqId, message: String(err) })
  }
}

// ---- Socket Server ----

function setupSocket(socket: net.Socket): void {
  let buffer = ''

  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.substring(0, newlineIdx).trim()
      buffer = buffer.substring(newlineIdx + 1)
      if (!line) continue
      try {
        const req = JSON.parse(line) as EnvRequest
        handleRequest(req, socket)
      } catch (err) {
        log(`failed to parse request: ${err}`)
      }
    }
  })

  socket.on('close', () => {
    subscribers.delete(socket)
  })

  socket.on('error', () => {
    subscribers.delete(socket)
  })
}

// ---- Lifecycle ----

let server: net.Server | null = null

function shutdown(): void {
  log('shutting down envd')

  // Stop all services
  for (const env of environments.values()) {
    for (const svc of env.services.values()) {
      stopService(svc)
    }
  }
  environments.clear()

  if (server) {
    server.close()
    server = null
  }

  try { fs.unlinkSync(SOCKET_PATH) } catch { /* */ }
  try { fs.unlinkSync(PID_PATH) } catch { /* */ }

  process.exit(0)
}

/** Scan environment directories for state.json + instance.json and recover */
async function recoverFromDisk(): Promise<void> {
  // Prune stale worktree entries from bare repos (handles unclean shutdowns)
  try {
    pruneAllBareRepos()
    log('pruned stale worktree entries from bare repos')
  } catch (err) {
    log(`worktree prune failed (non-fatal): ${err}`)
  }

  const seen = new Set<string>()
  const dirs: string[] = []

  // Collect from the environment index (knows all env locations)
  for (const entry of allEnvDirs()) {
    if (!seen.has(entry.dir)) {
      seen.add(entry.dir)
      dirs.push(entry.dir)
    }
  }

  // Also scan standard environments directory for any not in the index
  if (fs.existsSync(ENVIRONMENTS_DIR)) {
    for (const entry of fs.readdirSync(ENVIRONMENTS_DIR)) {
      const envDir = path.join(ENVIRONMENTS_DIR, entry)
      if (!seen.has(envDir) && fs.existsSync(path.join(envDir, 'instance.json'))) {
        dirs.push(envDir)
      }
    }
  }

  if (dirs.length === 0) return
  log(`recovering ${dirs.length} environment(s) from disk`)

  for (const envDir of dirs) {
    try {
      const manifestPath = path.join(envDir, 'instance.json')
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as InstanceManifest

      // Read state.json to find stale PIDs and shouldBeRunning
      const state = readAndReconcileState(envDir)

      // Kill stale PIDs from the previous daemon session
      if (state) {
        const stalePids: Record<string, number> = {}
        for (const [name, svc] of Object.entries(state.services)) {
          if (svc.pid != null && svc.status === 'crashed') {
            // readAndReconcileState already marked dead PIDs as crashed
            stalePids[name] = svc.pid
          }
        }
        if (Object.keys(stalePids).length > 0) {
          log(`[${manifest.name}] cleaning up ${Object.keys(stalePids).length} stale PID(s)`)
          await killStalePids(stalePids, manifest.name)
        }
      }

      registerEnvironment(manifest)

      if (state?.shouldBeRunning) {
        log(`auto-starting previously running environment: ${manifest.name}`)
        await startEnvironment(manifest.id).catch(err => {
          log(`failed to auto-start ${manifest.name}: ${err}`)
        })
      }
    } catch (err) {
      log(`failed to recover from ${envDir}: ${err}`)
    }
  }
}

function main(): void {
  // Ensure colony dir exists
  if (!fs.existsSync(COLONY_DIR)) {
    fs.mkdirSync(COLONY_DIR, { recursive: true })
  }
  if (!fs.existsSync(ENVIRONMENTS_DIR)) {
    fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true })
  }

  // Clean up stale socket
  try { fs.unlinkSync(SOCKET_PATH) } catch { /* */ }

  // Write PID
  fs.writeFileSync(PID_PATH, String(process.pid), 'utf-8')
  log(`started with pid ${process.pid}`)

  // Create server
  server = net.createServer((socket) => {
    log('client connected')
    setupSocket(socket)
  })

  server.listen(SOCKET_PATH, () => {
    log(`listening on ${SOCKET_PATH}`)
    try { fs.chmodSync(SOCKET_PATH, 0o700) } catch { /* */ }

    // Recover environments after socket is ready
    recoverFromDisk().catch(err => {
      log(`registry recovery failed: ${err}`)
    })
  })

  server.on('error', (err) => {
    log(`server error: ${err}`)
    shutdown()
  })

  // Handle signals — do NOT kill services on SIGTERM, just detach
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('uncaughtException', (err) => {
    log(`uncaught exception: ${err.stack || err}`)
  })
  process.on('unhandledRejection', (err) => {
    log(`unhandled rejection: ${err}`)
  })
}

main()
