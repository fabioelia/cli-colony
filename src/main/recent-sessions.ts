import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { join } from 'path'
import { app } from 'electron'
import type { CliBackend } from '../shared/types'

export interface RecentSession {
  instanceName: string
  /** daemon instance ID — used to match close events back to this record */
  instanceId?: string
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

/** Separate file that only exists between app quit and next app launch. */
function getRestoreSnapshotPath(): string {
  return join(colonyPaths.root, 'restore-snapshot.json')
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

/**
 * Discover the Claude session ID for a running PTY process.
 * Claude CLI opens a .jsonl file under ~/.claude/projects/<encoded-path>/<uuid>.jsonl.
 * We can find it via lsof on the child PID or by scanning the project dir.
 *
 * @param pid - Process ID to check via lsof (null to skip lsof)
 * @param workingDirectory - The session's working directory (used for project dir scanning)
 * @param recencyMs - Only consider session files modified within this window (default: 60s)
 */
export function discoverSessionId(pid: number | null, workingDirectory: string, recencyMs: number = 60_000): string | null {
  // 1. Try lsof on the PID -- most reliable for running processes
  if (pid) {
    try {
      const lsofOutput = execSync(`lsof -p ${pid} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 })
      const jsonlMatch = lsofOutput.match(/\.claude\/projects\/[^\s]+\/([a-f0-9-]{36})\.jsonl/i)
      if (jsonlMatch) return jsonlMatch[1]
    } catch { /* skip */ }
  }

  // 2. Fallback: find the most recently modified session file for this working directory
  try {
    const home = app.getPath('home')
    const projectDirName = workingDirectory.replace(/[/.]/g, '-')
    const projectDir = join(home, '.claude', 'projects', projectDirName)
    let searchDir = existsSync(projectDir) ? projectDir : null

    if (!searchDir) {
      const projectsDir = join(home, '.claude', 'projects')
      if (existsSync(projectsDir)) {
        for (const dir of readdirSync(projectsDir)) {
          const decoded = dir.startsWith('-') ? dir.substring(1).replace(/-/g, '/') : dir.replace(/-/g, '/')
          if (workingDirectory === '/' + decoded || workingDirectory.startsWith('/' + decoded + '/')) {
            const candidate = join(projectsDir, dir)
            if (existsSync(candidate)) { searchDir = candidate; break }
          }
        }
      }
    }

    if (searchDir) {
      const files = readdirSync(searchDir).filter((f: string) => f.endsWith('.jsonl'))
      let newest: { name: string; mtime: number } | null = null
      for (const f of files) {
        const st = statSync(join(searchDir, f))
        if (!newest || st.mtimeMs > newest.mtime) {
          newest = { name: f, mtime: st.mtimeMs }
        }
      }
      if (newest && (Date.now() - newest.mtime) < recencyMs) {
        return newest.name.replace('.jsonl', '')
      }
    }
  } catch { /* skip */ }

  return null
}

export function trackOpened(opts: {
  instanceName: string
  instanceId: string
  sessionId: string | null
  workingDirectory: string
  color: string
  args: string[]
  cliBackend?: CliBackend
  pinned?: boolean
  pid?: number | null
}): void {
  const sessions = load()
  sessions.unshift({
    instanceName: opts.instanceName,
    instanceId: opts.instanceId,
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

  // For new sessions (no sessionId yet), schedule discovery after CLI has time to create its file
  if (!opts.sessionId && opts.pid) {
    const pid = opts.pid
    const cwd = opts.workingDirectory
    const instId = opts.instanceId
    setTimeout(() => {
      try {
        const discovered = discoverSessionId(pid, cwd)
        if (discovered) {
          updateSessionId(instId, discovered)
        }
      } catch { /* non-fatal */ }
    }, 3000)
  }
}

/** Update the sessionId for an instance after it has been discovered. */
export function updateSessionId(instanceId: string, sessionId: string): void {
  const sessions = load()
  const match = sessions.find((s) => s.instanceId === instanceId && !s.sessionId)
  if (match) {
    match.sessionId = sessionId
    save(sessions)
  }
}

/** Mark a session as closed. Matches by instanceId (daemon UUID) for precision. */
export function trackClosed(instanceId: string, exitType: 'exited' | 'killed'): void {
  const sessions = load()
  const match = sessions.find(
    (s) => s.instanceId === instanceId && s.closedAt === null
  )
  if (match) {
    match.closedAt = new Date().toISOString()
    match.exitType = exitType

    // Last chance: if we still have no sessionId, try lsof/directory scan now
    if (!match.sessionId) {
      const discovered = discoverSessionId(null, match.workingDirectory)
      if (discovered) match.sessionId = discovered
    }

    save(sessions)
  }
}

export function getRecentSessions(): RecentSession[] {
  return load()
}

/**
 * Called on app quit (before-quit). Snapshots the currently-running sessions
 * to a separate file. Only these sessions should be offered for restore.
 * This separates "was running when app quit" from "user previously stopped."
 */
export function snapshotRunning(): void {
  const running = load().filter((s) => s.closedAt === null && s.exitType === 'running' && s.sessionId)
  if (running.length === 0) return
  // Deduplicate by sessionId — keep most recent record for each
  const bySessionId = new Map<string, RecentSession>()
  for (const s of running) {
    if (!s.sessionId) continue
    const existing = bySessionId.get(s.sessionId)
    if (!existing || new Date(s.openedAt).getTime() > new Date(existing.openedAt).getTime()) {
      bySessionId.set(s.sessionId, s)
    }
  }
  ensureDir()
  writeFileSync(getRestoreSnapshotPath(), JSON.stringify([...bySessionId.values()], null, 2), 'utf-8')
}

/**
 * Get sessions eligible for restore — reads from the quit-time snapshot.
 * Only sessions that were actively running when the app last quit are returned.
 * Deduplicates against sessions already running in the daemon.
 */
export function getRestorableSessions(alreadyRunningSessionIds?: Set<string>): RecentSession[] {
  const snapshotPath = getRestoreSnapshotPath()
  try {
    if (!existsSync(snapshotPath)) return []
    const snapshot: RecentSession[] = JSON.parse(readFileSync(snapshotPath, 'utf-8'))

    // Filter out sessions the daemon already has (reconnected automatically)
    return snapshot.filter((s) => {
      if (!s.sessionId) return false
      if (alreadyRunningSessionIds?.has(s.sessionId)) return false
      return true
    })
  } catch {
    return []
  }
}

/**
 * Clear the restore snapshot — called after the user restores or dismisses.
 * Also marks any still-running records in recent-sessions.json as exited.
 */
export function clearRestorable(): void {
  // Remove snapshot file
  const snapshotPath = getRestoreSnapshotPath()
  try { if (existsSync(snapshotPath)) unlinkSync(snapshotPath) } catch { /* ok */ }

  // Mark any still-running records as exited in the main list
  const sessions = load()
  let changed = false
  for (const s of sessions) {
    if (s.closedAt === null) {
      s.closedAt = new Date().toISOString()
      s.exitType = 'exited'
      changed = true
    }
  }
  if (changed) save(sessions)
}
