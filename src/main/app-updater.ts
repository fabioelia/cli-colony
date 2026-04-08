/**
 * Auto-update wrapper around electron-updater.
 *
 * - Initialises the updater on `app.whenReady()` (called from index.ts).
 * - Runs a daily check when `autoUpdate.enabled !== 'false'` (default on).
 * - Also checks once on window focus, debounced to 6h.
 * - Dev mode (`!app.isPackaged`) is a no-op — just reports back `enabledInEnv: false`.
 * - Broadcasts status events to the renderer so the banner + settings panel stay live.
 */

import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { broadcast } from './broadcast'
import { getSetting, setSetting } from './settings'
import type { UpdateStatus, UpdateInfo } from '../shared/types'

const DAILY_MS = 24 * 60 * 60 * 1000
const FOCUS_DEBOUNCE_MS = 6 * 60 * 60 * 1000  // 6 hours

let status: UpdateStatus = {
  state: 'idle',
  currentVersion: app.getVersion(),
  info: null,
  downloadPercent: 0,
  lastCheckAt: null,
  lastError: null,
  enabledInEnv: false,
}

let autoUpdaterInstance: any = null  // electron-updater's AppUpdater type
let dailyTimer: NodeJS.Timeout | null = null
let lastFocusCheckAt = 0

function mergeStatus(patch: Partial<UpdateStatus>): void {
  status = { ...status, ...patch }
  broadcast('app:updateStatus', status)
}

export function getUpdateStatus(): UpdateStatus {
  return status
}

/**
 * Record the user's auto-check preference and (re-)start the daily timer if enabled.
 */
export function setAutoUpdateEnabled(enabled: boolean): void {
  setSetting('autoUpdateEnabled', enabled ? 'true' : 'false')
  if (enabled) {
    scheduleDailyCheck()
    // Fire an immediate check after enabling so users see feedback
    void checkForUpdatesManual()
  } else if (dailyTimer) {
    clearInterval(dailyTimer)
    dailyTimer = null
  }
}

export function isAutoUpdateEnabled(): boolean {
  return getSetting('autoUpdateEnabled') !== 'false'
}

function scheduleDailyCheck(): void {
  if (dailyTimer) clearInterval(dailyTimer)
  dailyTimer = setInterval(() => {
    if (!isAutoUpdateEnabled()) return
    void runCheck('scheduled')
  }, DAILY_MS)
}

/**
 * Called by the user from Settings → Updates. Always runs, even if disabled.
 * Returns the latest status after the check resolves (or errors).
 */
export async function checkForUpdatesManual(): Promise<UpdateStatus> {
  await runCheck('manual')
  return status
}

/**
 * Wired from the main window's `focus` event. Debounced to once per 6h so we
 * don't hammer the release server when the user alt-tabs.
 */
export function checkOnFocus(): void {
  if (!isAutoUpdateEnabled()) return
  const now = Date.now()
  if (now - lastFocusCheckAt < FOCUS_DEBOUNCE_MS) return
  lastFocusCheckAt = now
  void runCheck('focus')
}

async function runCheck(source: 'startup' | 'scheduled' | 'focus' | 'manual'): Promise<void> {
  if (!autoUpdaterInstance) {
    // Dev mode or updater not initialised — just record the attempt
    mergeStatus({
      state: 'not-available',
      lastCheckAt: Date.now(),
      lastError: status.enabledInEnv ? null : 'Updates disabled in development mode',
    })
    return
  }
  mergeStatus({ state: 'checking', lastError: null })
  try {
    await autoUpdaterInstance.checkForUpdates()
    mergeStatus({ lastCheckAt: Date.now() })
    // Persist lastCheckAt for Settings display across app restarts
    setSetting('autoUpdateLastCheckAt', String(Date.now()))
  } catch (err: any) {
    const msg = err?.message || String(err)
    // Silently swallow "no published releases yet" — not a user-visible error
    if (isBenignNoReleaseError(msg)) {
      mergeStatus({ state: 'not-available', lastCheckAt: Date.now(), lastError: null })
      console.log(`[app-updater] no releases published yet (check source: ${source})`)
      return
    }
    console.warn(`[app-updater] check failed (${source}):`, msg)
    mergeStatus({ state: 'error', lastError: msg, lastCheckAt: Date.now() })
  }
}

function isBenignNoReleaseError(msg: string): boolean {
  return /404|ENOENT|not found|no published versions|Cannot find latest/i.test(msg)
}

export async function downloadUpdate(): Promise<void> {
  if (!autoUpdaterInstance) return
  try {
    mergeStatus({ state: 'downloading', downloadPercent: 0 })
    await autoUpdaterInstance.downloadUpdate()
  } catch (err: any) {
    mergeStatus({ state: 'error', lastError: err?.message || String(err) })
  }
}

export function quitAndInstall(): void {
  if (!autoUpdaterInstance) return
  try {
    autoUpdaterInstance.quitAndInstall()
  } catch (err: any) {
    console.error('[app-updater] quitAndInstall failed:', err)
    mergeStatus({ state: 'error', lastError: err?.message || String(err) })
  }
}

/**
 * Initialise the auto-updater. Called once from index.ts after `app.whenReady`.
 * In dev mode we register no-op state and skip loading electron-updater entirely.
 */
export function initAppUpdater(mainWindow: BrowserWindow | null): void {
  const packaged = app.isPackaged
  mergeStatus({ enabledInEnv: packaged })

  // Restore lastCheckAt from settings so the Settings panel doesn't look stale across restarts
  const persistedLast = Number(getSetting('autoUpdateLastCheckAt') || 0) || null
  if (persistedLast) mergeStatus({ lastCheckAt: persistedLast })

  if (!packaged) {
    console.log('[app-updater] dev mode — auto-update disabled')
    return
  }

  try {
    autoUpdaterInstance = autoUpdater
    autoUpdater.autoDownload = false
    autoUpdater.autoInstallOnAppQuit = false

    autoUpdater.on('checking-for-update', () => {
      mergeStatus({ state: 'checking' })
    })

    autoUpdater.on('update-available', (info: any) => {
      const updateInfo: UpdateInfo = {
        version: info?.version || 'unknown',
        releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
        releaseDate: info?.releaseDate,
      }
      mergeStatus({ state: 'available', info: updateInfo })
      broadcast('app:updateAvailable', updateInfo)
    })

    autoUpdater.on('update-not-available', () => {
      mergeStatus({ state: 'not-available' })
    })

    autoUpdater.on('download-progress', (progress: any) => {
      const percent = Math.round(progress?.percent ?? 0)
      mergeStatus({ state: 'downloading', downloadPercent: percent })
      broadcast('app:updateDownloadProgress', {
        percent,
        bytesPerSecond: progress?.bytesPerSecond ?? 0,
        total: progress?.total ?? 0,
      })
    })

    autoUpdater.on('update-downloaded', (info: any) => {
      const updateInfo: UpdateInfo = {
        version: info?.version || status.info?.version || 'unknown',
        releaseNotes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : undefined,
        releaseDate: info?.releaseDate,
      }
      mergeStatus({ state: 'ready', info: updateInfo, downloadPercent: 100 })
      broadcast('app:updateReady', updateInfo)
    })

    autoUpdater.on('error', (err: any) => {
      const msg = err?.message || String(err)
      if (isBenignNoReleaseError(msg)) {
        mergeStatus({ state: 'not-available', lastError: null })
        return
      }
      console.warn('[app-updater] error:', msg)
      mergeStatus({ state: 'error', lastError: msg })
      broadcast('app:updateError', { message: msg })
    })
  } catch (err: any) {
    console.warn('[app-updater] failed to load electron-updater:', err?.message || err)
    mergeStatus({ enabledInEnv: false })
    return
  }

  // Wire main window focus to debounced check
  if (mainWindow) {
    mainWindow.on('focus', () => checkOnFocus())
  }

  // Kick off startup check + daily schedule if the user hasn't opted out
  if (isAutoUpdateEnabled()) {
    // Delay the first check so it doesn't compete with daemon / pipeline startup
    setTimeout(() => void runCheck('startup'), 10_000)
    scheduleDailyCheck()
  }
}

/** Shut down timers and listeners. Called on app quit. */
export function shutdownAppUpdater(): void {
  if (dailyTimer) {
    clearInterval(dailyTimer)
    dailyTimer = null
  }
}

// Exported for tests — lets us inject a fake updater without touching require()
export function __setAutoUpdaterForTest(instance: any, state?: Partial<UpdateStatus>): void {
  autoUpdaterInstance = instance
  if (state) mergeStatus(state)
}

export function __resetForTest(): void {
  autoUpdaterInstance = null
  if (dailyTimer) {
    clearInterval(dailyTimer)
    dailyTimer = null
  }
  lastFocusCheckAt = 0
  status = {
    state: 'idle',
    currentVersion: app.getVersion(),
    info: null,
    downloadPercent: 0,
    lastCheckAt: null,
    lastError: null,
    enabledInEnv: false,
  }
}

// Helper exports for tests
export const __test = {
  isBenignNoReleaseError,
  runCheck,
  get lastFocusCheckAt() { return lastFocusCheckAt },
  set lastFocusCheckAt(v: number) { lastFocusCheckAt = v },
}
