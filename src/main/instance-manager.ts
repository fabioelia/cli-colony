/**
 * Instance Manager — thin proxy that delegates to the PTY daemon.
 *
 * Preserves the same export signatures so ipc-handlers.ts and tray.ts
 * need zero changes. All PTY ownership lives in the daemon process.
 */

import { app, BrowserWindow, Notification, shell } from 'electron'
import { exec } from 'child_process'
import { join } from 'path'
import { existsSync, statSync } from 'fs'
import { getDaemonClient, DaemonClient } from './daemon-client'
import { getDefaultArgs, getSetting, getDefaultCliBackend } from './settings'
import { DAEMON_VERSION } from '../daemon/protocol'
import type { CliBackend } from '../daemon/protocol'
import { trackOpened, trackClosed } from './recent-sessions'
import { onSessionExit as onPersonaSessionExit } from './persona-manager'
import { broadcast } from './broadcast'

export type { ClaudeInstance } from '../daemon/protocol'
import type { ClaudeInstance } from '../daemon/protocol'

// Tray update callback
let onInstanceListChanged: (() => void) | null = null
export function setOnInstanceListChanged(cb: () => void): void {
  onInstanceListChanged = cb
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

  // Forward output to renderer
  client.on('output', (instanceId: string, data: string) => {
    broadcast('instance:output', { id: instanceId, data })
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
      if (!appFocused && Notification.isSupported()) {
        const iconPath = join(__dirname, '../../resources/icon.png')
        const notif = new Notification({
          title: 'Claude is waiting',
          body: 'A session finished processing and needs your attention.',
          silent: true, // we already play our own sound
          icon: iconPath,
        })
        notif.on('click', () => {
          if (win && !win.isDestroyed()) {
            win.show()
            win.focus()
            broadcast('instance:focus', { id: instanceId })
          }
        })
        notif.show()
      }
    }
  })

  // Forward exit events + handle auto-cleanup + track session closure
  client.on('exited', (instanceId: string, exitCode: number) => {
    broadcast('instance:exited', { id: instanceId, exitCode })
    trackClosed(instanceId, 'exited')
    onPersonaSessionExit(instanceId)

    // Auto-cleanup
    const cleanupMins = parseInt(getSetting('autoCleanupMinutes') || '5', 10)
    if (cleanupMins > 0) {
      setTimeout(async () => {
        try {
          const inst = await client.getInstance(instanceId)
          if (inst && inst.status === 'exited') {
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
}): Promise<ClaudeInstance> {
  const defaultArgs = getDefaultArgs()
  const home = app.getPath('home')
  const cwd = resolveWorkingDirectory(opts.workingDirectory, home)
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
    throw new Error(`Working directory is missing or not a folder: ${cwd}`)
  }
  const cliBackend = opts.cliBackend ?? getDefaultCliBackend()

  const inst = await getDaemonClient().createInstance({
    ...opts,
    workingDirectory: cwd,
    defaultArgs,
    cliBackend,
  })

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

export async function writeToInstance(id: string, data: string): Promise<boolean> {
  return getDaemonClient().writeToInstance(id, data)
}

export async function resizeInstance(id: string, cols: number, rows: number): Promise<boolean> {
  return getDaemonClient().resizeInstance(id, cols, rows)
}

export async function killInstance(id: string): Promise<boolean> {
  const result = await getDaemonClient().killInstance(id)
  trackClosed(id, 'killed')
  return result
}

export async function removeInstance(id: string): Promise<boolean> {
  return getDaemonClient().removeInstance(id)
}

export async function renameInstance(id: string, name: string): Promise<boolean> {
  return getDaemonClient().renameInstance(id, name)
}

export async function recolorInstance(id: string, color: string): Promise<boolean> {
  return getDaemonClient().recolorInstance(id, color)
}

export async function restartInstance(id: string): Promise<ClaudeInstance | null> {
  const defaultArgs = getDefaultArgs()
  return getDaemonClient().restartInstance(id, defaultArgs)
}

export async function pinInstance(id: string): Promise<boolean> {
  return getDaemonClient().pinInstance(id)
}

export async function unpinInstance(id: string): Promise<boolean> {
  return getDaemonClient().unpinInstance(id)
}

export async function getAllInstances(): Promise<ClaudeInstance[]> {
  try {
    return await getDaemonClient().getAllInstances()
  } catch {
    return []
  }
}

export async function getInstance(id: string): Promise<ClaudeInstance | null> {
  return getDaemonClient().getInstance(id)
}

export async function getInstanceBuffer(id: string): Promise<string> {
  return getDaemonClient().getInstanceBuffer(id)
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
