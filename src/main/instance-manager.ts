/**
 * Instance Manager — thin proxy that delegates to the PTY daemon.
 *
 * Preserves the same export signatures so ipc-handlers.ts and tray.ts
 * need zero changes. All PTY ownership lives in the daemon process.
 */

import { app, BrowserWindow, shell } from 'electron'
import { exec } from 'child_process'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { getDaemonClient, DaemonClient } from './daemon-client'
import { getDefaultArgs, getSetting, getDefaultCliBackend } from './settings'
import { notify } from './notifications'
import { DAEMON_VERSION } from '../daemon/protocol'
import type { CliBackend } from '../shared/types'
import { trackOpened, trackClosed } from './recent-sessions'
import { broadcast } from './broadcast'
import { buildMcpConfig, cleanMcpConfigFile } from './mcp-catalog'
import { processOutput, clearPending } from './replay-manager'
import { scanNewCommits } from './commit-attributor'

export type { ClaudeInstance } from '../daemon/protocol'
import type { ClaudeInstance } from '../daemon/protocol'

// Track MCP config files by instance ID so we can clean them up on exit
const _mcpConfigPaths = new Map<string, string>()

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

  const client = getDaemonClient()

  // Forward output to renderer and collect replay events
  client.on('output', (instanceId: string, data: string) => {
    broadcast('instance:output', { id: instanceId, data })
    processOutput(instanceId, data)
  })

  // Forward activity changes + notify when Claude finishes processing
  client.on('activity', (instanceId: string, activity: string) => {
    broadcast('instance:activity', { id: instanceId, activity })

    // When an instance transitions to 'waiting', Claude finished its task
    if (activity === 'waiting') {
      const soundEnabled = getSetting('soundOnFinish') !== 'false'

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
          { type: 'session', id: instanceId })
      }
    }
  })

  // Forward exit events + handle auto-cleanup + track session closure
  client.on('exited', (instanceId: string, exitCode: number) => {
    broadcast('instance:exited', { id: instanceId, exitCode })
    clearPending(instanceId)
    trackClosed(instanceId, 'exited')
    onSessionExitCallback?.(instanceId)

    // Fire-and-forget: attribute any commits made during this session
    client.getInstance(instanceId).then(inst => {
      if (inst?.workingDirectory) {
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
    }).catch(() => {})
    const mcpPath = _mcpConfigPaths.get(instanceId)
    if (mcpPath) {
      cleanMcpConfigFile(mcpPath)
      _mcpConfigPaths.delete(instanceId)
    }

    // Auto-cleanup (skip persona sessions — they're kept for review)
    const cleanupMins = parseInt(getSetting('autoCleanupMinutes') || '5', 10)
    if (cleanupMins > 0) {
      setTimeout(async () => {
        try {
          const inst = await client.getInstance(instanceId)
          if (inst && inst.status === 'exited' && !inst.name.startsWith('Persona: ')) {
            await client.removeInstance(instanceId)
          }
        } catch { /* daemon may be gone */ }
      }, cleanupMins * 60 * 1000)
    }
  })

  // Forward list changes
  client.on('list-changed', (instances: ClaudeInstance[]) => {
    broadcast('instance:list', instances)
    onInstanceListChanged?.()
  })

  client.on('disconnected', () => {
    console.log('[instance-manager] daemon disconnected')
  })

  client.on('connected', () => {
    console.log('[instance-manager] daemon connected')
  })

  client.on('version-mismatch', (info: { running: number; expected: number }) => {
    console.warn(`[instance-manager] daemon version mismatch: running=${info.running} expected=${info.expected}`)
    broadcast('daemon:version-mismatch', info)
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
}): Promise<ClaudeInstance> {
  const defaultArgs = getDefaultArgs()
  const home = app.getPath('home')
  const cwd = resolveWorkingDirectory(opts.workingDirectory, home)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`Working directory is missing or not a folder: ${cwd}`)
  }
  const cliBackend = opts.cliBackend ?? getDefaultCliBackend()

  // Build MCP config file if servers are requested
  let mcpConfigPath: string | null = null
  const baseArgs = opts.args ?? []
  let finalArgs = baseArgs
  if (opts.mcpServers && opts.mcpServers.length > 0) {
    const configId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    mcpConfigPath = buildMcpConfig(opts.mcpServers, configId)
    if (mcpConfigPath) {
      finalArgs = [...baseArgs, '--mcp-config', mcpConfigPath]
    }
  }

  const inst = await getDaemonClient().createInstance({
    ...opts,
    args: finalArgs,
    workingDirectory: cwd,
    defaultArgs,
    cliBackend,
  })

  if (mcpConfigPath) {
    _mcpConfigPaths.set(inst.id, mcpConfigPath)
  }

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
  })

  return inst
}

export async function killInstance(id: string): Promise<boolean> {
  const result = await getDaemonClient().killInstance(id)
  trackClosed(id, 'killed')
  return result
}

export async function restartInstance(id: string): Promise<ClaudeInstance | null> {
  const defaultArgs = getDefaultArgs()
  return getDaemonClient().restartInstance(id, defaultArgs)
}

export async function getAllInstances(): Promise<ClaudeInstance[]> {
  try {
    return await getDaemonClient().getAllInstances()
  } catch {
    return []
  }
}

/**
 * No longer kills instances — the daemon keeps them alive.
 * Only disconnects the client.
 */
export function disconnectDaemon(): void {
  getDaemonClient().disconnect()
}

/**
 * Fully shut down the daemon (kills all instances).
 * Use only when the user explicitly quits.
 */
export async function shutdownDaemon(): Promise<void> {
  await getDaemonClient().shutdownDaemon()
}

/**
 * Restart the daemon — kills all instances, shuts down, then reconnects.
 * The new daemon picks up fresh settings (shell profile, etc).
 */
export async function getDaemonVersion(): Promise<{ running: number; expected: number }> {
  try {
    const res = await getDaemonClient().request({ type: 'version', reqId: `v-${Date.now()}` }) as { version?: number } | undefined
    return { running: res?.version ?? 0, expected: DAEMON_VERSION }
  } catch {
    return { running: 0, expected: DAEMON_VERSION }
  }
}

export async function restartDaemon(): Promise<void> {
  console.log('[instance-manager] restarting daemon...')
  try {
    await getDaemonClient().shutdownDaemon()
  } catch { /* daemon may already be gone */ }
  getDaemonClient().disconnect()
  // Wait for socket cleanup
  await new Promise((r) => setTimeout(r, 500))
  await getDaemonClient().connect()
  console.log('[instance-manager] daemon restarted')
}

/**
 * Connect to the daemon and wire up events.
 * Call this once during app startup.
 */
export async function initDaemon(): Promise<void> {
  wireDaemonEvents()
  await getDaemonClient().connect()
}
