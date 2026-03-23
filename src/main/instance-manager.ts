/**
 * Instance Manager — thin proxy that delegates to the PTY daemon.
 *
 * Preserves the same export signatures so ipc-handlers.ts and tray.ts
 * need zero changes. All PTY ownership lives in the daemon process.
 */

import { BrowserWindow, Notification, shell } from 'electron'
import { exec } from 'child_process'
import { join } from 'path'
import { getDaemonClient, DaemonClient } from './daemon-client'
import { getDefaultArgs, getSetting, getDefaultCliBackend } from './settings'
import type { CliBackend } from '../daemon/protocol'
import { trackOpened, trackClosed } from './recent-sessions'

export type { ClaudeInstance } from '../daemon/protocol'
import type { ClaudeInstance } from '../daemon/protocol'

// Tray update callback
let onInstanceListChanged: (() => void) | null = null
export function setOnInstanceListChanged(cb: () => void): void {
  onInstanceListChanged = cb
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
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

  // Forward exit events + handle auto-cleanup
  client.on('exited', (instanceId: string, exitCode: number) => {
    broadcast('instance:exited', { id: instanceId, exitCode })

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
  const cwd = opts.workingDirectory || process.env.HOME || '/'
  const cliBackend = opts.cliBackend ?? getDefaultCliBackend()

  const inst = await getDaemonClient().createInstance({
    ...opts,
    defaultArgs,
    cliBackend,
  })

  // Track in recent sessions
  const allArgs = inst.args || []
  const resumeIdx = allArgs.indexOf('--resume')
  const sessionIdFromArgs = resumeIdx >= 0 ? allArgs[resumeIdx + 1] : null
  trackOpened({
    instanceName: inst.name,
    sessionId: sessionIdFromArgs,
    workingDirectory: cwd,
    color: inst.color,
    args: allArgs,
    cliBackend: inst.cliBackend,
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
