/**
 * Activity Manager — unified event log for persona, pipeline, and environment events.
 *
 * Writes to ~/.claude-colony/activity.json (last 100 events, ring buffer).
 * Tracks an in-memory unread count that resets on markRead().
 */

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { colonyPaths } from '../shared/colony-paths'
import { broadcast } from './broadcast'
import type { ActivityEvent } from '../shared/types'

const MAX_EVENTS = 100
let unreadCount = 0

function readLog(): ActivityEvent[] {
  try {
    if (!existsSync(colonyPaths.activityLog)) return []
    return JSON.parse(readFileSync(colonyPaths.activityLog, 'utf-8'))
  } catch {
    return []
  }
}

function writeLog(events: ActivityEvent[]): void {
  try {
    writeFileSync(colonyPaths.activityLog, JSON.stringify(events, null, 2), 'utf-8')
  } catch { /* non-fatal */ }
}

export function appendActivity(event: Omit<ActivityEvent, 'id' | 'timestamp'>): void {
  const events = readLog()
  const newEvent: ActivityEvent = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    ...event,
  }
  events.push(newEvent)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
  writeLog(events)
  unreadCount++
  broadcast('activity:new', { event: newEvent, unreadCount })
}

export function listActivity(): ActivityEvent[] {
  return readLog()
}

export function getUnreadCount(): number {
  return unreadCount
}

export function markRead(): void {
  unreadCount = 0
  broadcast('activity:unread', { count: 0 })
}
