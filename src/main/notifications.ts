/**
 * Central notification module for Colony desktop notifications.
 *
 * Wraps Electron's Notification API with:
 * - A per-setting opt-out (notificationsEnabled)
 * - Click handler that focuses the Colony window and optionally broadcasts a route
 * - In-memory ring buffer (last 200) persisted to notification-history.json
 */

import { BrowserWindow, Notification } from 'electron'
import { join } from 'path'
import { promises as fsp } from 'fs'
import { getSetting } from './settings'
import { broadcast } from './broadcast'
import { colonyPaths } from '../shared/colony-paths'
import type { NotificationEntry } from '../shared/types'

const MAX_HISTORY = 200
const DEBOUNCE_MS = 2000

function isInQuietHours(start: string, end: string): boolean {
  const now = new Date()
  const [sh, sm] = start.split(':').map(Number)
  const [eh, em] = end.split(':').map(Number)
  const nowMin = now.getHours() * 60 + now.getMinutes()
  const startMin = sh * 60 + sm
  const endMin = eh * 60 + em
  if (startMin <= endMin) {
    return nowMin >= startMin && nowMin < endMin
  } else {
    return nowMin >= startMin || nowMin < endMin
  }
}

let _history: NotificationEntry[] = []
let _loaded = false
let _saveTimer: ReturnType<typeof setTimeout> | null = null

function getIconPath(): string {
  return join(__dirname, '../../resources/icon.png')
}

function getFocusedWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0]
  return win && !win.isDestroyed() ? win : null
}

function generateId(): string {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

/** Load notification history from disk (once). */
async function ensureLoaded(): Promise<void> {
  if (_loaded) return
  _loaded = true
  try {
    const raw = await fsp.readFile(colonyPaths.notificationHistory, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      _history = parsed.slice(-MAX_HISTORY)
    }
  } catch {
    // File doesn't exist yet or is corrupt — start fresh
  }
}

/** Debounced persist to disk. */
function scheduleSave(): void {
  if (_saveTimer) return
  _saveTimer = setTimeout(async () => {
    _saveTimer = null
    try {
      await fsp.writeFile(colonyPaths.notificationHistory, JSON.stringify(_history), 'utf-8')
    } catch {
      // Best-effort — don't crash on write failure
    }
  }, DEBOUNCE_MS)
}

/**
 * Infer a source category from the notification title/body.
 */
function inferSource(title: string): string {
  const t = title.toLowerCase()
  if (t.includes('pipeline')) return 'pipeline'
  if (t.includes('persona')) return 'persona'
  if (t.includes('approval')) return 'approval'
  if (t.includes('session')) return 'session'
  if (t.includes('budget') || t.includes('cost')) return 'budget'
  return 'system'
}

/**
 * Show a desktop notification and record it in the history ring buffer.
 *
 * @param title  Short title (shown bold in OS notification center)
 * @param body   Body text
 * @param route  Optional route key broadcast to renderer on click
 *               (e.g. 'pipelines', 'personas', { type: 'session', id: '...' })
 */
export async function notify(
  title: string,
  body: string,
  route?: string | Record<string, unknown>,
  source?: string
): Promise<void> {
  await ensureLoaded()

  // Record in history regardless of notification setting
  const entry: NotificationEntry = {
    id: generateId(),
    title,
    body,
    route,
    timestamp: Date.now(),
    read: false,
    source: source ?? inferSource(title),
  }
  _history.push(entry)
  if (_history.length > MAX_HISTORY) {
    _history = _history.slice(-MAX_HISTORY)
  }
  scheduleSave()

  // Broadcast to renderer for live updates
  broadcast('notification:new', entry)

  // Desktop notification (respects user opt-out)
  if (await getSetting('notificationsEnabled') === 'false') return
  if (await getSetting('quietHoursEnabled') === 'true') {
    const start = await getSetting('quietHoursStart')
    const end = await getSetting('quietHoursEnd')
    if (start && end && isInQuietHours(start, end)) return
  }
  const sourceKey = entry.source ? `notify${entry.source.charAt(0).toUpperCase() + entry.source.slice(1)}` : ''
  if (await getSetting(sourceKey) === 'false') return
  if (!Notification.isSupported()) return

  const notif = new Notification({
    title,
    body,
    silent: true,
    icon: getIconPath(),
  })

  notif.on('click', () => {
    const win = getFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
    if (route) {
      broadcast('app:navigate', { route })
    }
  })

  notif.show()
}

/** Get all notification history entries. */
export async function getHistory(): Promise<NotificationEntry[]> {
  await ensureLoaded()
  return [..._history].reverse() // newest first
}

/** Mark a single notification as read by ID. */
export async function markRead(id: string): Promise<void> {
  await ensureLoaded()
  const entry = _history.find(e => e.id === id)
  if (entry) {
    entry.read = true
    scheduleSave()
  }
}

/** Mark all notifications as read. */
export async function markAllRead(): Promise<void> {
  await ensureLoaded()
  for (const entry of _history) {
    entry.read = true
  }
  scheduleSave()
}

/** Clear all notification history. */
export async function clearHistory(): Promise<void> {
  _history = []
  scheduleSave()
}

/** Get count of unread notifications. */
export async function getUnreadCount(): Promise<number> {
  await ensureLoaded()
  return _history.filter(e => !e.read).length
}
