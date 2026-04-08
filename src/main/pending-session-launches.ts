/**
 * Pending Session Launches — queue a Claude session to spawn once an environment
 * is fully up (all services running) or spawn an auto-heal session if any
 * required service fails.
 *
 * Callers register a pending launch with `registerPendingLaunch`. The module
 * subscribes to env status updates (fed by env-manager) and spawns the session
 * at the right time. On crash/failure, prepends an auto-heal prompt to the first
 * message so the launched agent can investigate.
 *
 * Timeout: 5 minutes. If nothing resolves cleanly, spawn the session anyway so
 * the user isn't stuck in a waiting state forever.
 */

import { broadcast } from './broadcast'
import { createInstance } from './instance-manager'
import { getEnvironmentLogs } from './env-manager'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { genId } from '../shared/utils'
import type { EnvStatus, EnvServiceStatus } from '../shared/types'

const READY_TIMEOUT_MS = 5 * 60 * 1000

// Services considered optional — crashes here do not trigger auto-heal
const OPTIONAL_SERVICES = new Set(['mcp-server'])

export type PendingLaunchState =
  | 'waiting'
  | 'ready'
  | 'failed'
  | 'timeout'
  | 'cancelled'

export interface PendingLaunchSpawnOpts {
  name?: string
  workingDirectory?: string
  color?: string
  args?: string[]
  parentId?: string
}

export interface PendingLaunchRecord {
  id: string
  envId: string
  envName: string
  state: PendingLaunchState
  createdAt: number
  services: EnvServiceStatus[]
}

interface PendingLaunchEntry {
  id: string
  envId: string
  envName: string
  spawnOpts: PendingLaunchSpawnOpts
  initialPrompt?: string
  createdAt: number
  timer: ReturnType<typeof setTimeout> | null
  state: PendingLaunchState
  lastServices: EnvServiceStatus[]
}

const _pending = new Map<string, PendingLaunchEntry>()

function toRecord(entry: PendingLaunchEntry): PendingLaunchRecord {
  return {
    id: entry.id,
    envId: entry.envId,
    envName: entry.envName,
    state: entry.state,
    createdAt: entry.createdAt,
    services: entry.lastServices,
  }
}

function broadcastStatus(entry: PendingLaunchEntry): void {
  broadcast('pendingLaunch:status', toRecord(entry))
}

/** Register a pending launch. Returns the pending ID. */
export function registerPendingLaunch(opts: {
  envId: string
  envName: string
  spawnOpts: PendingLaunchSpawnOpts
  initialPrompt?: string
}): string {
  const id = genId()
  const entry: PendingLaunchEntry = {
    id,
    envId: opts.envId,
    envName: opts.envName,
    spawnOpts: opts.spawnOpts,
    initialPrompt: opts.initialPrompt,
    createdAt: Date.now(),
    state: 'waiting',
    lastServices: [],
    timer: null,
  }
  entry.timer = setTimeout(() => handleTimeout(id), READY_TIMEOUT_MS)
  _pending.set(id, entry)
  broadcastStatus(entry)
  return id
}

/** Cancel a pending launch. Does NOT tear down the env. */
export function cancelPendingLaunch(id: string): boolean {
  const entry = _pending.get(id)
  if (!entry) return false
  if (entry.timer) clearTimeout(entry.timer)
  entry.state = 'cancelled'
  broadcastStatus(entry)
  _pending.delete(id)
  return true
}

export function getPendingLaunches(envId?: string): PendingLaunchRecord[] {
  const list = Array.from(_pending.values()).map(toRecord)
  return envId ? list.filter(r => r.envId === envId) : list
}

/** Clear all pending launches (test helper) */
export function _resetPendingLaunches(): void {
  for (const entry of _pending.values()) {
    if (entry.timer) clearTimeout(entry.timer)
  }
  _pending.clear()
}

/**
 * Inspect env status for pending launches and resolve any that are ready or failed.
 * env-manager calls this whenever environment status changes.
 */
export function handleEnvStatusUpdate(environments: EnvStatus[]): void {
  if (_pending.size === 0) return
  for (const entry of Array.from(_pending.values())) {
    if (entry.state !== 'waiting') continue
    const env = environments.find(e => e.id === entry.envId)
    if (!env) continue

    entry.lastServices = env.services

    // Still creating — emit status and continue waiting
    if (env.status === 'creating') {
      broadcastStatus(entry)
      continue
    }

    // Error during setup phase — auto-heal
    if (env.status === 'error') {
      void firePending(entry, env, true)
      continue
    }

    // Filter to required services — optional services (mcp-server) are ignored
    const required = env.services.filter(s => !OPTIONAL_SERVICES.has(s.name))
    if (required.length === 0) {
      // No services to wait on (rare); spawn as ready
      void firePending(entry, env, false)
      continue
    }

    const anyCrashed = required.some(s => s.status === 'crashed')
    const allRunning = required.every(s => s.status === 'running')

    if (anyCrashed) {
      void firePending(entry, env, true)
      continue
    }

    if (allRunning) {
      void firePending(entry, env, false)
      continue
    }

    // Still transitioning (starting/stopped) — emit status
    broadcastStatus(entry)
  }
}

async function firePending(
  entry: PendingLaunchEntry,
  env: EnvStatus,
  failed: boolean,
): Promise<void> {
  if (entry.timer) clearTimeout(entry.timer)
  entry.state = failed ? 'failed' : 'ready'
  broadcastStatus(entry)
  _pending.delete(entry.id)

  try {
    let promptText = entry.initialPrompt ?? ''
    if (failed) {
      const autoHealPrefix = await buildAutoHealPrompt(entry.envId, env)
      promptText = promptText ? `${autoHealPrefix}\n\n${promptText}` : autoHealPrefix
    }
    const inst = await createInstance(entry.spawnOpts)
    broadcast('pendingLaunch:spawned', {
      pendingId: entry.id,
      envId: env.id,
      instanceId: inst.id,
      autoHeal: failed,
    })
    if (promptText) {
      void sendPromptWhenReady(inst.id, { prompt: promptText }).catch(err => {
        console.warn('[pending-session-launches] sendPromptWhenReady failed:', err)
      })
    }
  } catch (err) {
    console.error('[pending-session-launches] createInstance failed:', err)
  }
}

async function buildAutoHealPrompt(envId: string, env: EnvStatus): Promise<string> {
  const failedSvcs = env.services.filter(s => s.status === 'crashed' && !OPTIONAL_SERVICES.has(s.name))
  const names = failedSvcs.map(s => s.name)

  // Grab last 50 lines for the first failed service (keep the prompt small)
  let logs = ''
  if (failedSvcs.length > 0) {
    try {
      const raw = await getEnvironmentLogs(envId, failedSvcs[0].name, 50)
      logs = raw.length > 4000 ? raw.slice(-4000) : raw
    } catch {
      logs = '(logs unavailable)'
    }
  }

  return [
    `⚠️ Environment '${env.name}' failed to start cleanly.`,
    `Failed services: ${names.length > 0 ? names.join(', ') : '(setup error)'}.`,
    '',
    'Recent logs:',
    '```',
    logs.trim() || '(empty)',
    '```',
    '',
    'Please investigate, fix the root cause, and restart the failed services.',
  ].join('\n')
}

function handleTimeout(id: string): void {
  const entry = _pending.get(id)
  if (!entry || entry.state !== 'waiting') return
  entry.state = 'timeout'
  _pending.delete(id)
  broadcastStatus(entry)
  console.warn(`[pending-session-launches] env '${entry.envName}' did not reach ready within ${READY_TIMEOUT_MS / 1000}s — spawning anyway`)
  createInstance(entry.spawnOpts).then(inst => {
    broadcast('pendingLaunch:spawned', {
      pendingId: entry.id,
      envId: entry.envId,
      instanceId: inst.id,
      autoHeal: false,
      timedOut: true,
    })
  }).catch(err => {
    console.error('[pending-session-launches] timeout spawn failed:', err)
  })
}
