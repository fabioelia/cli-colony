import { readFileSync, existsSync, readdirSync } from 'fs'
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

    // Read customTitle from session JSONL files (set via --name or /rename)
    const customTitles = new Map<string, string>()
    try {
      const projectsDir = join(home, '.claude', 'projects')
      if (existsSync(projectsDir)) {
        const projectDirs = readdirSync(projectsDir)
        for (const dir of projectDirs) {
          const dirPath = join(projectsDir, dir)
          try {
            const files = readdirSync(dirPath).filter((f: string) => f.endsWith('.jsonl'))
            for (const file of files) {
              const sessionId = file.replace('.jsonl', '')
              if (customTitles.has(sessionId)) continue
              try {
                // Only read the first few lines — customTitle is usually first
                const fd = readFileSync(join(dirPath, file), 'utf-8')
                const firstLines = fd.slice(0, 500).split('\n')
                for (const line of firstLines) {
                  try {
                    const entry = JSON.parse(line)
                    if (entry.type === 'custom-title' && entry.customTitle) {
                      customTitles.set(entry.sessionId || sessionId, entry.customTitle)
                      break
                    }
                  } catch { /* skip */ }
                }
              } catch { /* skip */ }
            }
          } catch { /* skip */ }
        }
      }
    } catch { /* skip */ }

    // Build session list
    const sessions: CliSession[] = []
    for (const [sessionId, data] of sessionData) {
      const projectPath = data.project
      const parts = projectPath.split('/')
      // Priority: /rename from CLI > customTitle from --name > null
      const name = lastRename.get(sessionId) || customTitles.get(sessionId) || null
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
