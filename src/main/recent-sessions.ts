import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { CliBackend } from '../daemon/protocol'

export interface RecentSession {
  instanceName: string
  sessionId: string | null
  workingDirectory: string
  color: string
  args: string[]
  /** Which CLI was used; omitted in older saved files (treat as Claude). */
  cliBackend?: CliBackend
  pinned?: boolean
  openedAt: string
  closedAt: string | null
  exitType: 'running' | 'exited' | 'killed'
}

import { colonyPaths } from '../shared/colony-paths'

function getFilePath(): string {
  return colonyPaths.recentSessions
}

function ensureDir(): void {
  if (!existsSync(colonyPaths.root)) mkdirSync(colonyPaths.root, { recursive: true })
}

function load(): RecentSession[] {
  const path = getFilePath()
  try {
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, 'utf-8'))
    }
  } catch {
    // corrupted
  }
  return []
}

function save(sessions: RecentSession[]): void {
  ensureDir()
  writeFileSync(getFilePath(), JSON.stringify(sessions, null, 2), 'utf-8')
}

export function trackOpened(opts: {
  instanceName: string
  sessionId: string | null
  workingDirectory: string
  color: string
  args: string[]
  cliBackend?: CliBackend
  pinned?: boolean
}): void {
  const sessions = load()
  sessions.unshift({
    instanceName: opts.instanceName,
    sessionId: opts.sessionId,
    workingDirectory: opts.workingDirectory,
    color: opts.color,
    args: opts.args,
    cliBackend: opts.cliBackend,
    pinned: opts.pinned || false,
    openedAt: new Date().toISOString(),
    closedAt: null,
    exitType: 'running',
  })
  // Keep last 50
  save(sessions.slice(0, 50))
}

export function trackClosed(instanceName: string, exitType: 'exited' | 'killed'): void {
  const sessions = load()
  // Find the most recent matching open session
  const match = sessions.find(
    (s) => s.instanceName === instanceName && s.closedAt === null
  )
  if (match) {
    match.closedAt = new Date().toISOString()
    match.exitType = exitType
    save(sessions)
  }
}

export function getRecentSessions(): RecentSession[] {
  return load()
}

export function getRestorableSessions(): RecentSession[] {
  const cutoff = Date.now() - 12 * 60 * 60 * 1000 // only from last 12 hours
  return load().filter((s) => {
    if (s.exitType !== 'running' && s.exitType !== 'exited') return false
    if (!s.sessionId) return false // can't resume without a session ID
    const opened = s.openedAt ? new Date(s.openedAt).getTime() : 0
    return opened > cutoff
  })
}

export function clearRestorable(): void {
  const sessions = load()
  for (const s of sessions) {
    if (s.closedAt === null) {
      s.closedAt = new Date().toISOString()
      s.exitType = 'exited'
    }
  }
  save(sessions)
}
