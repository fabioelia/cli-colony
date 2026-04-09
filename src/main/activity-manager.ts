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
let unreadCount = 0

// In-memory canonical state — loaded once on first access, never re-read inside
// appendActivity. This eliminates the read-modify-write race where concurrent
// callers (pipeline poll + session exit) could overwrite each other's append.
let _events: ActivityEvent[] | null = null

async function getEvents(): Promise<ActivityEvent[]> {
  if (_events === null) {
    try {
      _events = JSON.parse(await fsp.readFile(colonyPaths.activityLog, 'utf-8'))
    } catch {
      _events = []
    }
  }
  return _events!
}

async function writeLog(events: ActivityEvent[]): Promise<void> {
  try {
    await fsp.writeFile(colonyPaths.activityLog, JSON.stringify(events, null, 2), 'utf-8')
  } catch { /* non-fatal */ }
}

export async function appendActivity(event: Omit<ActivityEvent, 'id' | 'timestamp'>): Promise<void> {
  const events = await getEvents()
  const newEvent: ActivityEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...event,
  }
  events.push(newEvent)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  await writeLog(events)
  unreadCount++
  broadcast('activity:new', { event: newEvent, unreadCount })
}

export async function listActivity(): Promise<ActivityEvent[]> {
  return getEvents()
}

export function getUnreadCount(): number {
  return unreadCount
}

export function markRead(): void {
  unreadCount = 0
  broadcast('activity:unread', { count: 0 })
}
