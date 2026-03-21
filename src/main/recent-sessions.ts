import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

export interface RecentSession {
  instanceName: string
  sessionId: string | null
  workingDirectory: string
  color: string
  args: string[]
  openedAt: string
  closedAt: string | null
  exitType: 'running' | 'exited' | 'killed'
}

function getFilePath(): string {
  return join(app.getPath('home'), '.claude-colony', 'recent-sessions.json')
}

function ensureDir(): void {
  const dir = join(app.getPath('home'), '.claude-colony')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
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
}): void {
  const sessions = load()
  sessions.unshift({
    instanceName: opts.instanceName,
    sessionId: opts.sessionId,
    workingDirectory: opts.workingDirectory,
    color: opts.color,
    args: opts.args,
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
  // Sessions that were running when the app last closed (not explicitly killed)
  return load().filter((s) => s.exitType === 'running' || s.exitType === 'exited')
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
