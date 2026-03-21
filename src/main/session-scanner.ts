import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { getRecentSessions } from './recent-sessions'

export interface CliSession {
  sessionId: string
  name: string | null
  display: string
  lastMessage: string | null
  messageCount: number
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

    // First pass: collect first message, last message, count, and last /rename per session
    const sessionData = new Map<string, {
      firstDisplay: string
      lastDisplay: string
      project: string
      timestamp: number
      messageCount: number
    }>()
    const lastRename = new Map<string, string>()

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (!entry.sessionId || !entry.display) continue

        const existing = sessionData.get(entry.sessionId)
        if (!existing) {
          sessionData.set(entry.sessionId, {
            firstDisplay: entry.display,
            lastDisplay: entry.display,
            project: entry.project || '',
            timestamp: entry.timestamp || 0,
            messageCount: 1,
          })
        } else {
          existing.lastDisplay = entry.display
          existing.messageCount++
          if (entry.timestamp > existing.timestamp) {
            existing.timestamp = entry.timestamp
          }
        }

        // Track /rename commands — keep the last one
        const renameMatch = entry.display.match(/^\/rename\s+(.+)$/i)
        if (renameMatch) {
          lastRename.set(entry.sessionId, renameMatch[1].trim())
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
    for (const [sessionId, data] of sessionData) {
      const projectPath = data.project
      const parts = projectPath.split('/')
      const name = lastRename.get(sessionId) || null
      const lastMsg = data.lastDisplay !== data.firstDisplay ? data.lastDisplay : null

      sessions.push({
        sessionId,
        name,
        display: data.firstDisplay,
        lastMessage: lastMsg,
        messageCount: data.messageCount,
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
