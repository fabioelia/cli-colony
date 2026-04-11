/**
 * Activity Manager — unified event log for persona, pipeline, and environment events.
 *
 * Writes to ~/.claude-colony/activity.json (last 100 events, ring buffer).
 * Tracks an in-memory unread count that resets on markRead().
 */

import { promises as fsp } from 'fs'
import { colonyPaths } from '../shared/colony-paths'
import { broadcast } from './broadcast'
import type { ActivityEvent } from '../shared/types'

const MAX_EVENTS = 100
let _counter = 0
let _lastReadId: string | null = null

// In-memory canonical state — loaded once on first access, never re-read inside
// appendActivity. This eliminates the read-modify-write race where concurrent
// callers (pipeline poll + session exit) could overwrite each other's append.
let _events: ActivityEvent[] | null = null

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
