/**
 * Instance Manager — thin proxy that delegates to the PTY daemon.
 *
 * Preserves the same export signatures so ipc-handlers.ts and tray.ts
 * need zero changes. All PTY ownership lives in the daemon process.
 */

import { app, BrowserWindow, shell } from 'electron'
import { exec, execFile } from 'child_process'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { getDaemonRouter } from './daemon-router'
import type { UpgradeState } from './daemon-router'
import { getDefaultArgs, getSetting, getDefaultCliBackend } from './settings'
import { notify } from './notifications'
import { DAEMON_VERSION } from '../daemon/protocol'
import type { CliBackend, ColonyComment } from '../shared/types'
import { trackOpened, trackClosed } from './recent-sessions'
import { broadcast } from './broadcast'
import { buildMcpConfig, cleanMcpConfigFile } from './mcp-catalog'
import { setRateLimited } from './rate-limit-state'
import { scanNewCommits } from './commit-attributor'
import { markChecklistItem } from './onboarding-state'
import { appendActivity } from './activity-manager'
import { parseErrorSummary } from './error-parser'
import { transitionTicket, addComment } from './jira'

export type { ClaudeInstance } from '../daemon/protocol'
import type { ClaudeInstance } from '../daemon/protocol'

// Track MCP config files by instance ID so we can clean them up on exit
const _mcpConfigPaths = new Map<string, string>()

// Track Jira ticket attached at creation time — overlaid onto ClaudeInstance for the renderer
const _instanceTickets = new Map<string, { source: 'jira'; key: string; summary: string }>()

// Track last output timestamp per instance for idle detection
const _lastOutputAt = new Map<string, number>()

// Rate-limit cost checks: track last check timestamp per instance (30s throttle)
const _lastCostCheckAt = new Map<string, number>()
// Track which instances have already been budget-stopped (prevent double-stop)
const _budgetStopped = new Set<string>()

/** Check if an instance was stopped due to budget exceeded. */
export function wasBudgetStopped(instanceId: string): boolean {
  return _budgetStopped.has(instanceId)
}

/** Get idle info for all running instances. Only includes instances that have output tracking. */
export function getIdleInfo(): Array<{ id: string; idleMs: number }> {
  const now = Date.now()
  const result: Array<{ id: string; idleMs: number }> = []
  for (const [id, lastAt] of _lastOutputAt) {
    result.push({ id, idleMs: now - lastAt })
  }
  return result
}

// Callback to resolve persona cost cap — registered by persona-manager at startup to avoid circular import
let _costCapResolver: ((instanceId: string) => number | undefined) | null = null
export function setCostCapResolver(fn: (instanceId: string) => number | undefined): void {
  _costCapResolver = fn
}

// Approval count getter — registered by pipeline-engine at startup to avoid circular import
let _approvalCountGetter: () => number = () => 0
export function setApprovalCountGetter(fn: () => number): void {
  _approvalCountGetter = fn
}

// Attention count getter — registered by persona-manager at startup to avoid circular import
let _attentionCountGetter: () => number = () => 0
export function setAttentionCountGetter(fn: () => number): void {
  _attentionCountGetter = fn
}

export function updateDockBadge(): void {
  getDaemonRouter().getAllInstances().then(instances => {
    const waitingCount = instances.filter(i => i.status === 'running' && i.activity === 'waiting').length
    const total = waitingCount + _approvalCountGetter() + _attentionCountGetter()
    if (process.platform === 'darwin') {
      app.dock?.setBadge(total > 0 ? String(total) : '')
    } else {
      app.setBadgeCount(total)
    }
  }).catch(() => {})
}

// Tray update callback
let onInstanceListChanged: (() => void) | null = null
export function setOnInstanceListChanged(cb: () => void): void {
  onInstanceListChanged = cb
}

// Session exit callback — registered at startup to avoid circular imports
let onSessionExitCallback: ((instanceId: string) => void) | null = null
export function setOnSessionExit(cb: (instanceId: string) => void): void {
  onSessionExitCallback = cb
}

/** Overlay ticket metadata onto instances from the in-memory map. */
function applyTickets(instances: ClaudeInstance[]): ClaudeInstance[] {
  return instances.map(inst => {
    const ticket = _instanceTickets.get(inst.id)
    return ticket ? { ...inst, ticket } : inst
  })
}

/** Expand ~ and trim; default to ~/.claude-colony for Colony sessions. */
function resolveWorkingDirectory(input: string | undefined, home: string): string {
  const raw = (input ?? '').trim()
  if (!raw) return join(home, '.claude-colony')
  if (raw === '~') return home
  if (raw.startsWith('~/')) return join(home, raw.slice(2))
  return raw
}

// ---- Daemon event wiring ----

let _wired = false

export function wireDaemonEvents(): void {
  if (_wired) return
  _wired = true

  const router = getDaemonRouter()
  router.wireEvents(router.primaryClient)

  // Forward output to renderer + track idle time + check persona cost cap
  router.on('output', (instanceId: string, data: string) => {
    broadcast('instance:output', { id: instanceId, data })
    _lastOutputAt.set(instanceId, Date.now())

    // Rate-limited persona cost cap check (every 30s)
    if (!_budgetStopped.has(instanceId)) {
      const now = Date.now()
      const last = _lastCostCheckAt.get(instanceId) ?? 0
      if (now - last >= 30_000) {
        _lastCostCheckAt.set(instanceId, now)
        const cap = _costCapResolver?.(instanceId)
        if (cap != null) {
          router.getInstance(instanceId).then(inst => {
            if (!inst || _budgetStopped.has(instanceId)) return
            const cost = inst.tokenUsage?.cost ?? 0
            if (cost >= cap) {
              _budgetStopped.add(instanceId)
              console.log(`[instance-manager] budget exceeded for ${inst.name}: $${cost.toFixed(2)} >= $${cap.toFixed(2)} — stopping`)
              router.killInstance(instanceId).catch(() => {})
              broadcast('instance:budgetExceeded', { id: instanceId, cost, cap })
              notify(
                `Colony: ${inst.name} stopped`,
                `Cost limit reached ($${cost.toFixed(2)} / $${cap.toFixed(2)})`,
                { type: 'session', id: instanceId }, 'session'
              )
              appendActivity({
                source: 'persona',
                name: inst.name.replace('Persona: ', ''),
                summary: `Budget exceeded — session stopped ($${cost.toFixed(2)} / $${cap.toFixed(2)})`,
                level: 'warn',
                sessionId: instanceId,
              }).catch(() => {})
            }
          }).catch(() => {})
        }
      }
    }
  })

  // Forward activity changes + notify when Claude finishes processing
  router.on('activity', async (instanceId: string, activity: string) => {
    broadcast('instance:activity', { id: instanceId, activity })
    updateDockBadge()

    // When an instance transitions to 'waiting', Claude finished its task
    if (activity === 'waiting') {
      const soundEnabled = await getSetting('soundOnFinish') !== 'false'

      // Only notify if the app window is not focused (user is elsewhere)
      const win = BrowserWindow.getAllWindows()[0]
      const appFocused = win && !win.isDestroyed() && win.isFocused()

      if (soundEnabled && !appFocused) {
        exec('afplay /System/Library/Sounds/Glass.aiff', (err) => {
          if (err) shell.beep()
        })
      }

      // Show native notification if app is not focused
      if (!appFocused) {
        notify('Colony: Claude is waiting', 'A session finished and needs your attention.',
          { type: 'session', id: instanceId }, 'session')
      }
    }
  })

  // Forward tool-deferred events + desktop notification
  router.on('tool-deferred', async (instanceId: string, sessionId: string, toolName?: string) => {
    broadcast('instance:tool-deferred', { id: instanceId, sessionId, toolName })
    const inst = await router.getInstance(instanceId).catch(() => null)
    const name = inst?.name || 'Session'
    notify(
      'Tool Deferred',
      `${name}: ${toolName || 'A tool'} needs approval`,
      { type: 'session', id: instanceId }, 'session'
    )
  })

  // Rate limit detection — pause Colony crons
  router.on('rateLimitDetected', (_instanceId: string, retryAfterSecs: number | null, rawMessage: string) => {
    console.warn(`[instance-manager] rate limit detected: ${rawMessage.slice(0, 100)}`)
    setRateLimited(retryAfterSecs, rawMessage)
  })

  // Forward exit events + handle auto-cleanup + track session closure
  router.on('exited', async (instanceId: string, exitCode: number) => {
    // Capture ticket BEFORE clearing — _instanceTickets.delete runs below
    const exitTicket = _instanceTickets.get(instanceId)
    broadcast('instance:exited', { id: instanceId, exitCode })
    updateDockBadge()
    trackClosed(instanceId, 'exited')
    _lastOutputAt.delete(instanceId)
    _lastCostCheckAt.delete(instanceId)
    _budgetStopped.delete(instanceId)
    _instanceTickets.delete(instanceId)
    onSessionExitCallback?.(instanceId)

    // Parse error summary from PTY buffer on non-zero exit
    if (exitCode !== 0) {
      router.getInstanceBuffer(instanceId).then(buffer => {
        if (!buffer) return
        const errorSummary = parseErrorSummary(buffer)
        if (errorSummary) {
          broadcast('instance:errorSummary', { id: instanceId, errorSummary })
        }
      }).catch(() => {})
    }

    // Single getInstance call — shared by activity log + commit attribution
    router.getInstance(instanceId).then(inst => {
      if (!inst) return

      appendActivity({
        source: 'session',
        name: inst.name,
        summary: exitCode === 0
          ? 'Session exited normally'
          : `Session exited with code ${exitCode}`,
        level: exitCode === 0 ? 'info' : 'warn',
        sessionId: instanceId,
      }).catch(() => {})

      if (inst.workingDirectory) {
        const personaName = inst.name.startsWith('Persona: ')
          ? inst.name.slice('Persona: '.length)
          : undefined
        scanNewCommits(
          instanceId,
          inst.name,
          inst.workingDirectory,
          new Date(inst.createdAt).getTime(),
          personaName,
          inst.tokenUsage?.cost
        ).catch(() => {})
      }

      // Post session-end comment to Jira if ticket attached and setting enabled
      if (exitTicket?.key && inst.workingDirectory) {
        getSetting('jiraSessionEndComment').then(async enabled => {
          if (enabled !== 'true') return
          try {
            const stdout = await new Promise<string>((resolve, reject) =>
              execFile('git', [
                'log', `--since=${new Date(inst.createdAt).toISOString()}`,
                '--pretty=format:%h %s', '--no-merges', '--max-count=50',
              ], { cwd: inst.workingDirectory }, (err, out) => err ? reject(err) : resolve(out))
            )
            const lines = stdout.trim().split('\n').filter(Boolean)
            if (lines.length === 0) return
            const display = lines.slice(0, 20)
            const extra = lines.length > 20 ? `\n... and ${lines.length - 20} more` : ''
            const durationMins = Math.round((Date.now() - new Date(inst.createdAt).getTime()) / 60000)
            const envLabel = inst.gitRepo ?? 'local'
            const body = [
              `Colony session "${inst.name}" completed.`,
              '',
              `Commits (${lines.length}):`,
              ...display.map(l => `- ${l}`),
              ...(extra ? [extra] : []),
              '',
              `Duration: ${durationMins}m | Env: ${envLabel}`,
            ].join('\n')
            await addComment(exitTicket.key, body)
          } catch { /* swallow — never block exit flow */ }
        }).catch(() => {})
      }
    }).catch(() => {})
    const mcpPath = _mcpConfigPaths.get(instanceId)
    if (mcpPath) {
      cleanMcpConfigFile(mcpPath).catch(() => {})
      _mcpConfigPaths.delete(instanceId)
    }

    // Auto-cleanup (skip persona sessions — they're kept for review)
    const cleanupMins = parseInt(await getSetting('autoCleanupMinutes') || '5', 10)
    if (cleanupMins > 0) {
      setTimeout(async () => {
        try {
          const inst = await router.getInstance(instanceId)
          if (inst && inst.status === 'exited' && !inst.name.startsWith('Persona: ')) {
            await router.removeInstance(instanceId)
          }
        } catch { /* daemon may be gone */ }
      }, cleanupMins * 60 * 1000)
    }
  })

  // Forward list changes
  router.on('list-changed', (instances: ClaudeInstance[]) => {
    broadcast('instance:list', applyTickets(instances))
    onInstanceListChanged?.()
  })

  // Forward comments push
  router.on('comments', (instanceId: string, comments: ColonyComment[]) => {
    broadcast('session:comments', { instanceId, comments })
  })

  router.on('disconnected', () => {
    console.log('[instance-manager] daemon disconnected')
  })

  router.on('connection-failed', () => {
    console.error('[instance-manager] daemon reconnect exhausted — notifying renderer')
    broadcast('daemon:connection-failed', { error: 'Daemon reconnect failed after multiple attempts' })
  })

  router.on('connected', () => {
    console.log('[instance-manager] daemon connected')
    updateDockBadge()
  })

  router.on('version-mismatch', (info: { running: number; expected: number }) => {
    console.warn(`[instance-manager] daemon version mismatch: running=${info.running} expected=${info.expected}`)
    broadcast('daemon:version-mismatch', info)
  })

  router.on('daemon-unresponsive', () => {
    console.error('[instance-manager] daemon unresponsive — force-killed, auto-reconnecting')
    broadcast('daemon:unresponsive', {})
  })

  // Rolling upgrade events
  router.on('upgrade-started', () => {
    broadcast('daemon:upgrade-started', {})
  })

  router.on('upgrade-draining', (info: { remaining: number }) => {
    broadcast('daemon:upgrade-draining', info)
  })

  router.on('upgrade-complete', () => {
    broadcast('daemon:upgrade-complete', {})
  })

  router.on('instance-migrated', (info: { oldId: string; newId: string }) => {
    broadcast('daemon:instance-migrated', info)
  })
}

// ---- Public API (same signatures as before) ----

export async function createInstance(opts: {
  name?: string
  workingDirectory?: string
  color?: string
  args?: string[]
  parentId?: string
  cliBackend?: CliBackend
  mcpServers?: string[]
  model?: string
  permissionMode?: 'autonomous' | 'supervised'
  env?: Record<string, string>
  pipelineName?: string
  pipelineRunId?: string
  ticket?: { source: 'jira'; key: string; summary: string }
}): Promise<ClaudeInstance> {
  const defaultArgs = await getDefaultArgs()
  const home = app.getPath('home')
  const cwd = resolveWorkingDirectory(opts.workingDirectory, home)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`Working directory is missing or not a folder: ${cwd}`)
  }
  const cliBackend = opts.cliBackend ?? await getDefaultCliBackend()

  // Build MCP config file if servers are requested
  let mcpConfigPath: string | null = null
  const baseArgs = opts.args ?? []
  let finalArgs = baseArgs
  if (opts.mcpServers && opts.mcpServers.length > 0) {
    const configId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    mcpConfigPath = await buildMcpConfig(opts.mcpServers, configId)
    if (mcpConfigPath) {
      finalArgs = [...baseArgs, '--mcp-config', mcpConfigPath]
    }
  }

  const inst = await getDaemonRouter().createInstance({
    ...opts,
    args: finalArgs,
    workingDirectory: cwd,
    defaultArgs,
    cliBackend,
  })

  if (mcpConfigPath) {
    _mcpConfigPaths.set(inst.id, mcpConfigPath)
  }
  if (opts.ticket) {
    _instanceTickets.set(inst.id, opts.ticket)
    getSetting('jiraSessionStartTransition').then(name => {
      const trimmed = name.trim()
      if (!trimmed) return
      transitionTicket(opts.ticket!.key, trimmed)
        .catch(err => console.warn('[instance] session-start transition failed:', err))
    }).catch(() => {})
  }
  _lastOutputAt.set(inst.id, Date.now())

  markChecklistItem('createdSession')

  appendActivity({
    source: 'session',
    name: inst.name,
    summary: `Session started in ${(cwd || '').split('/').pop() || cwd}`,
    level: 'info',
    sessionId: inst.id,
  }).catch(() => {})

  // Track in recent sessions
  const allArgs = inst.args || []
  const resumeIdx = allArgs.indexOf('--resume')
  const sessionIdFromArgs = resumeIdx >= 0 ? allArgs[resumeIdx + 1] : null
  trackOpened({
    instanceName: inst.name,
    instanceId: inst.id,
    sessionId: sessionIdFromArgs,
    workingDirectory: cwd,
    color: inst.color,
    args: allArgs,
    cliBackend: inst.cliBackend,
    pid: inst.pid ?? null,
    ticket: opts.ticket,
  })

  return opts.ticket ? { ...inst, ticket: opts.ticket } : inst
}

export async function killInstance(id: string): Promise<boolean> {
  const result = await getDaemonRouter().killInstance(id)
  trackClosed(id, 'killed')
  return result
}

export async function restartInstance(id: string): Promise<ClaudeInstance | null> {
  const defaultArgs = await getDefaultArgs()
  return getDaemonRouter().restartInstance(id, defaultArgs)
}

export async function getAllInstances(): Promise<ClaudeInstance[]> {
  try {
    return applyTickets(await getDaemonRouter().getAllInstances())
  } catch {
    return []
  }
}

/**
 * No longer kills instances — the daemon keeps them alive.
 * Only disconnects the client.
 */
export function disconnectDaemon(): void {
  getDaemonRouter().disconnect()
}

/**
 * Fully shut down the daemon (kills all instances).
 * Use only when the user explicitly quits.
 */
export async function shutdownDaemon(): Promise<void> {
  await getDaemonRouter().shutdownDaemon()
}

export async function getDaemonVersion(): Promise<{ running: number; expected: number }> {
  try {
    const res = await getDaemonRouter().request({ type: 'version', reqId: `v-${Date.now()}` }) as { version?: number } | undefined
    return { running: res?.version ?? 0, expected: DAEMON_VERSION }
  } catch {
    return { running: 0, expected: DAEMON_VERSION }
  }
}

/**
 * Restart the daemon — kills all instances, shuts down, then reconnects.
 * For backward compat; prefer startDaemonUpgrade() for zero-downtime upgrades.
 */
export async function restartDaemon(): Promise<void> {
  console.log('[instance-manager] restarting daemon...')
  try {
    await getDaemonRouter().shutdownDaemon()
  } catch { /* daemon may already be gone */ }
  getDaemonRouter().disconnect()
  await new Promise((r) => setTimeout(r, 500))
  await getDaemonRouter().connect()
  console.log('[instance-manager] daemon restarted')
}

/** Start a rolling upgrade — spawn new daemon, drain old, promote when empty. */
export async function startDaemonUpgrade(): Promise<void> {
  return getDaemonRouter().startUpgrade()
}

/** Migrate a specific instance from old daemon to new during an upgrade. */
export async function migrateInstance(instanceId: string): Promise<ClaudeInstance | null> {
  return getDaemonRouter().migrateInstance(instanceId)
}

/** Migrate all running instances from old daemon to new. */
export async function migrateAllInstances(): Promise<void> {
  return getDaemonRouter().migrateAll()
}

/** Get the current upgrade state. */
export function getUpgradeState(): { state: UpgradeState; remaining: number } {
  return getDaemonRouter().getUpgradeStatus()
}

/**
 * Connect to the daemon and wire up events.
 * Call this once during app startup. Retries up to 3 times with a stale-daemon
 * kill between attempts so a hung daemon doesn't permanently block the app.
 */
export async function initDaemon(): Promise<void> {
  wireDaemonEvents()
  const router = getDaemonRouter()
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await router.connect()
      return
    } catch (err) {
      console.error(`[instance-manager] daemon connect attempt ${attempt}/3 failed:`, err)
      if (attempt < 3) {
        router.killDaemonProcess()
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
  }
  throw new Error('daemon init failed after 3 attempts')
}
