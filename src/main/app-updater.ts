/**
 * Auto-update wrapper around electron-updater.
 *
 * - Initialises the updater on `app.whenReady()` (called from index.ts).
 * - Runs a daily check when `autoUpdate.enabled !== 'false'` (default on).
 * - Also checks once on window focus, debounced to 6h.
 * - Dev mode (`!app.isPackaged`): checks `git fetch` for new commits on origin/main,
 *   "download" runs `git pull && yarn install`, "install" restarts the process.
 * - Broadcasts status events to the renderer so the banner + settings panel stay live.
 */

import { app } from 'electron'
import type { BrowserWindow } from 'electron'
import { autoUpdater } from 'electron-updater'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { broadcast } from './broadcast'
import { getSetting, setSetting } from './settings'
import type { UpdateStatus, UpdateInfo } from '../shared/types'

const execFileAsync = promisify(execFile)

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
export async function setAutoUpdateEnabled(enabled: boolean): Promise<void> {
  await setSetting('autoUpdateEnabled', enabled ? 'true' : 'false')
  if (enabled) {
    scheduleDailyCheck()
    // Fire an immediate check after enabling so users see feedback
    void checkForUpdatesManual()
  } else if (dailyTimer) {
    clearInterval(dailyTimer)
    dailyTimer = null
  }
}

export async function isAutoUpdateEnabled(): Promise<boolean> {
  return await getSetting('autoUpdateEnabled') !== 'false'
}

function scheduleDailyCheck(): void {
  if (dailyTimer) clearInterval(dailyTimer)
  dailyTimer = setInterval(async () => {
    if (!await isAutoUpdateEnabled()) return
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
  const now = Date.now()
  if (now - lastFocusCheckAt < FOCUS_DEBOUNCE_MS) return
  lastFocusCheckAt = now
  isAutoUpdateEnabled().then(enabled => {
    if (enabled) void runCheck('focus')
  }).catch(() => {})
}

async function runCheck(source: 'startup' | 'scheduled' | 'focus' | 'manual'): Promise<void> {
  if (devMode) {
    await devCheck()
    return
  }
  if (!autoUpdaterInstance) {
    mergeStatus({
      state: 'not-available',
      lastCheckAt: Date.now(),
      lastError: 'Updates not available',
    })
    return
  }
  mergeStatus({ state: 'checking', lastError: null })
  try {
    await autoUpdaterInstance.checkForUpdates()
    mergeStatus({ lastCheckAt: Date.now() })
    // Persist lastCheckAt for Settings display across app restarts
    await setSetting('autoUpdateLastCheckAt', String(Date.now()))
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

// ---- Dev-mode git-based updater ----

let devMode = false
let devRepoDir: string | null = null

async function git(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd: devRepoDir! })
  return stdout.trim()
}

async function devCheck(): Promise<void> {
  if (!devRepoDir) return
  mergeStatus({ state: 'checking', lastError: null })
  try {
    await git('fetch', 'origin', 'main', '--quiet')
    const countStr = await git('rev-list', 'HEAD..origin/main', '--count')
    const behind = parseInt(countStr, 10) || 0
    mergeStatus({ lastCheckAt: Date.now() })
    await setSetting('autoUpdateLastCheckAt', String(Date.now()))

    if (behind === 0) {
      mergeStatus({ state: 'not-available' })
      return
    }

    // Get the latest commit message for release notes
    const log = await git('log', 'HEAD..origin/main', '--pretty=format:%s', '--reverse')
    const commits = log.split('\n').filter(Boolean)
    const notes = commits.map(c => `- ${c}`).join('\n')

    const info: UpdateInfo = {
      version: `${behind} commit${behind === 1 ? '' : 's'} behind`,
      releaseNotes: notes,
    }
    mergeStatus({ state: 'available', info })
    broadcast('app:updateAvailable', info)
  } catch (err: any) {
    console.warn('[app-updater] dev git check failed:', err?.message)
    mergeStatus({ state: 'error', lastError: err?.message || String(err), lastCheckAt: Date.now() })
  }
}

async function devDownload(): Promise<void> {
  if (!devRepoDir) return
  try {
    mergeStatus({ state: 'downloading', downloadPercent: 0 })
    // Pull latest
    mergeStatus({ downloadPercent: 30 })
    await git('pull', 'origin', 'main', '--ff-only')
    // Install dependencies
    mergeStatus({ downloadPercent: 60 })
    await execFileAsync('yarn', ['install'], { cwd: devRepoDir })
    mergeStatus({ downloadPercent: 100 })

    const info: UpdateInfo = {
      version: 'latest',
      releaseNotes: 'Pulled latest from origin/main and installed dependencies.',
    }
    mergeStatus({ state: 'ready', info, downloadPercent: 100 })
    broadcast('app:updateReady', info)
  } catch (err: any) {
    console.error('[app-updater] dev pull failed:', err?.message)
    mergeStatus({ state: 'error', lastError: err?.message || String(err) })
  }
}

function devQuitAndInstall(): void {
  // Relaunch the electron app — works in dev mode with electron-vite
  app.relaunch()
  app.quit()
}

function initDevUpdater(mainWindow: BrowserWindow | null): void {
  devMode = true
  // app.getAppPath() returns the project root in dev (electron-vite)
  devRepoDir = app.getAppPath()

  // Derive version from latest git tag instead of package.json
  execFileAsync('git', ['describe', '--tags', '--abbrev=0'], { cwd: devRepoDir })
    .then(({ stdout }) => {
      const tag = stdout.trim().replace(/^v/, '')
      if (tag) mergeStatus({ currentVersion: `${tag}-dev` })
    })
    .catch(() => { /* no tags — keep package.json version */ })

  if (mainWindow) {
    mainWindow.on('focus', () => checkOnFocus())
  }

  // Check on startup (delayed) + schedule periodic checks
  setTimeout(() => void devCheck(), 10_000)
  scheduleDailyCheck()
}

// ---- Shared download/install wrappers ----

export async function downloadUpdate(): Promise<void> {
  if (devMode) return devDownload()
  if (!autoUpdaterInstance) return
  try {
    mergeStatus({ state: 'downloading', downloadPercent: 0 })
    await autoUpdaterInstance.downloadUpdate()
  } catch (err: any) {
    mergeStatus({ state: 'error', lastError: err?.message || String(err) })
  }
}

export function quitAndInstall(): void {
  if (devMode) return devQuitAndInstall()
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
export async function initAppUpdater(mainWindow: BrowserWindow | null): Promise<void> {
  const packaged = app.isPackaged
  mergeStatus({ enabledInEnv: packaged })

  // Restore lastCheckAt from settings so the Settings panel doesn't look stale across restarts
  const persistedLast = Number(await getSetting('autoUpdateLastCheckAt') || 0) || null
  if (persistedLast) mergeStatus({ lastCheckAt: persistedLast })

  if (!packaged) {
    console.log('[app-updater] dev mode — using git-based update detection')
    mergeStatus({ enabledInEnv: true })
    initDevUpdater(mainWindow)
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
  if (await isAutoUpdateEnabled()) {
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
