import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getRecentSessions } from './recent-sessions'

export interface CliSession {
  sessionId: string
  name: string | null
  display: string
  project: string
  timestamp: number
  projectName: string
  recentlyOpened: boolean
}

export function scanSessions(limit = 50): CliSession[] {
  const home = app.getPath('home')
  const historyPath = join(home, '.claude', 'history.jsonl')

  if (!existsSync(historyPath)) return []

  try {
    const content = readFileSync(historyPath, 'utf-8')
    const lines = content.trim().split('\n')

    // First pass: collect first message and last /rename per session
    const firstMessage = new Map<string, { display: string; project: string; timestamp: number }>()
    const lastRename = new Map<string, string>()

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (!entry.sessionId || !entry.display) continue

        // Track the first non-command message as the display
        if (!firstMessage.has(entry.sessionId)) {
          firstMessage.set(entry.sessionId, {
            display: entry.display,
            project: entry.project || '',
            timestamp: entry.timestamp || 0,
          })
        }

        // Track /rename commands — keep the last one
        const renameMatch = entry.display.match(/^\/rename\s+(.+)$/i)
        if (renameMatch) {
          lastRename.set(entry.sessionId, renameMatch[1].trim())
        }

        // Update timestamp to the latest
        const existing = firstMessage.get(entry.sessionId)!
        if (entry.timestamp > existing.timestamp) {
          existing.timestamp = entry.timestamp
        }
      } catch {
        // skip bad lines
      }
    }

    // Cross-reference with recent sessions opened in this app
    const recent = getRecentSessions()
    const recentSessionIds = new Set(
      recent.filter((r) => r.sessionId).map((r) => r.sessionId!)
    )

    // Build session list
    const sessions: CliSession[] = []
    for (const [sessionId, data] of firstMessage) {
      const projectPath = data.project
      const parts = projectPath.split('/')
      const name = lastRename.get(sessionId) || null
      const display = data.display

      sessions.push({
        sessionId,
        name,
        display,
        project: projectPath,
        timestamp: data.timestamp,
        projectName: parts[parts.length - 1] || projectPath,
        recentlyOpened: recentSessionIds.has(sessionId),
      })
    }

    return sessions
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
  } catch (err) {
    console.error('[session-scanner] failed to read history:', err)
    return []
  }
}
