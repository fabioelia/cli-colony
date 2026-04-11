/**
 * Activity Manager — unified event log for persona, pipeline, and environment events.
 *
 * Writes to ~/.claude-colony/activity.json (last 100 events, ring buffer).
 * Also persists every event to a daily log file (activity-YYYY-MM-DD.json)
 * for historical browsing. Daily logs older than 30 days are cleaned up on startup.
 * Tracks an in-memory unread count that resets on markRead().
 */

import { promises as fsp } from 'fs'
import * as path from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { broadcast } from './broadcast'
import type { ActivityEvent } from '../shared/types'

const MAX_EVENTS = 100
const DAILY_LOG_RETENTION_DAYS = 30
let _counter = 0
let _lastReadId: string | null = null

// In-memory canonical state — loaded once on first access, never re-read inside
// appendActivity. This eliminates the read-modify-write race where concurrent
// callers (pipeline poll + session exit) could overwrite each other's append.
let _events: ActivityEvent[] | null = null

// Daily log in-memory cache — keyed by date string. Only caches the current
// day (+ yesterday briefly during midnight rollover) to avoid unbounded growth.
// Eliminates read-modify-write race where concurrent appends drop events.
const _dailyCache = new Map<string, ActivityEvent[]>()

async function getEvents(): Promise<ActivityEvent[]> {
  if (_events === null) {
    try {
      const data = JSON.parse(await fsp.readFile(colonyPaths.activityLog, 'utf-8'))
      _events = data.events ?? data // support both { events, lastReadId } and bare array
      _lastReadId = data.lastReadId ?? null
    } catch {
      _events = []
    }
  }
  return _events!
}

function computeUnreadCount(events: ActivityEvent[]): number {
  if (!_lastReadId) return events.length
  const idx = events.findIndex(e => e.id === _lastReadId)
  if (idx === -1) return events.length
  return events.length - idx - 1
}

async function writeLog(events: ActivityEvent[]): Promise<void> {
  try {
    await fsp.writeFile(colonyPaths.activityLog, JSON.stringify({ events, lastReadId: _lastReadId }, null, 2), 'utf-8')
  } catch { /* non-fatal */ }
}

function todayDateStr(): string {
  return new Date().toISOString().slice(0, 10)
}

async function getDailyEvents(date: string): Promise<ActivityEvent[]> {
  if (_dailyCache.has(date)) return _dailyCache.get(date)!
  const logPath = colonyPaths.activityDailyLog(date)
  let events: ActivityEvent[] = []
  try {
    events = JSON.parse(await fsp.readFile(logPath, 'utf-8'))
  } catch { /* file doesn't exist yet */ }
  // Only cache today (and yesterday for midnight rollover) — evict stale dates
  const today = todayDateStr()
  for (const cached of _dailyCache.keys()) {
    if (cached !== today && cached !== date) _dailyCache.delete(cached)
  }
  _dailyCache.set(date, events)
  return events
}

async function appendToDailyLog(event: ActivityEvent): Promise<void> {
  const date = event.timestamp.slice(0, 10)
  try {
    const events = await getDailyEvents(date)
    events.push(event)
    const logPath = colonyPaths.activityDailyLog(date)
    await fsp.writeFile(logPath, JSON.stringify(events), 'utf-8')
  } catch { /* non-fatal */ }
}

export async function loadActivityForDate(date: string): Promise<ActivityEvent[]> {
  // Validate date format to prevent path traversal
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return []
  return getDailyEvents(date)
}

export async function cleanupOldDailyLogs(): Promise<void> {
  const cutoff = Date.now() - DAILY_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000
  try {
    const files = await fsp.readdir(colonyPaths.root)
    const dailyLogs = files.filter(f => /^activity-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    for (const file of dailyLogs) {
      const dateStr = file.slice('activity-'.length, -'.json'.length)
      const fileDate = new Date(dateStr + 'T00:00:00Z').getTime()
      if (fileDate < cutoff) {
        await fsp.unlink(path.join(colonyPaths.root, file)).catch(() => {})
      }
    }
  } catch { /* non-fatal */ }
}

export async function appendActivity(event: Omit<ActivityEvent, 'id' | 'timestamp'>): Promise<void> {
  const events = await getEvents()
  const newEvent: ActivityEvent = {
    id: `${Date.now()}-${++_counter}`,
    timestamp: new Date().toISOString(),
    ...event,
  }
  events.push(newEvent)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  await writeLog(events)
  // Persist to daily log for historical browsing
  appendToDailyLog(newEvent).catch(() => {})
  const unreadCount = computeUnreadCount(events)
  broadcast('activity:new', { event: newEvent, unreadCount })
}

export async function listActivity(): Promise<ActivityEvent[]> {
  return getEvents()
}

export async function getUnreadCount(): Promise<number> {
  const events = await getEvents()
  return computeUnreadCount(events)
}

export async function markRead(): Promise<void> {
  const events = await getEvents()
  if (events.length > 0) {
    _lastReadId = events[events.length - 1].id
    await writeLog(events)
  }
  broadcast('activity:unread', { count: 0 })
}

export async function clearActivity(): Promise<void> {
  _events = []
  _lastReadId = null
  await writeLog([])
  broadcast('activity:unread', { count: 0 })
}
