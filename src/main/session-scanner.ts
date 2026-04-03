import { readFileSync, existsSync, readdirSync, statSync, openSync, readSync, closeSync, createReadStream } from 'fs'
import { join } from 'path'
import { execSync } from 'child_process'
import { createInterface } from 'readline'
import { app } from 'electron'
import { getRecentSessions } from './recent-sessions'
import { getAllInstances } from './instance-manager'
import type { CliSession } from '../shared/types'

// Re-export for existing consumers
export type { CliSession }

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

// ---- External session discovery ----

export interface ExternalSession {
  pid: number
  name: string
  cwd: string
  sessionId: string | null
  args: string
}

export async function scanExternalSessions(): Promise<ExternalSession[]> {
  try {
    const psOutput = execSync('ps aux', { encoding: 'utf-8', timeout: 5000 })

    const instances = await getAllInstances()
    const managedPids = new Set(instances.map(i => i.pid).filter(Boolean))

    const external: ExternalSession[] = []

    for (const line of psOutput.split('\n')) {
      const parts = line.trim().split(/\s+/)
      const pid = parseInt(parts[1])
      if (isNaN(pid) || managedPids.has(pid)) continue

      const fullCmd = parts.slice(10).join(' ')

      const cmdBin = fullCmd.split(/\s/)[0]
      const baseName = cmdBin.split('/').pop() || ''
      if (baseName !== 'claude') continue
      if (/claude-electron|Electron|ShipIt/.test(fullCmd)) continue
      const nameMatch = fullCmd.match(/--name\s+([^\s]+(?:\s+[^\s-][^\s]*)*?)(?=\s+--|$)/)
      const name = nameMatch ? nameMatch[1] : `claude (pid ${pid})`
      const dirMatch = fullCmd.match(/--add-dir\s+(\S+)/)
      let cwd = dirMatch ? dirMatch[1] : ''
      const resumeMatch = fullCmd.match(/--resume\s+(\S+)/)
      let sessionId = resumeMatch ? resumeMatch[1] : null

      if (!cwd) {
        try {
          const lsofCwd = execSync(`lsof -p ${pid} -d cwd -Fn 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 })
          const cwdMatch = lsofCwd.match(/\nn(.+)/)
          if (cwdMatch) cwd = cwdMatch[1]
        } catch { /* skip */ }
      }

      if (!sessionId) {
        try {
          const lsofOutput = execSync(`lsof -p ${pid} 2>/dev/null`, { encoding: 'utf-8', timeout: 3000 })
          const jsonlMatch = lsofOutput.match(/\.claude\/projects\/[^\s]+\/([a-f0-9-]{36})\.jsonl/i)
          if (jsonlMatch) sessionId = jsonlMatch[1]
        } catch { /* skip */ }
      }

      if (!sessionId && cwd) {
        try {
          const home = app.getPath('home')
          const projectDirName = cwd.replace(/[/.]/g, '-')
          const projectDir = join(home, '.claude', 'projects', projectDirName)
          let searchDir = existsSync(projectDir) ? projectDir : null

          if (!searchDir) {
            const projectsDir = join(home, '.claude', 'projects')
            if (existsSync(projectsDir)) {
              for (const dir of readdirSync(projectsDir)) {
                const decoded = dir.startsWith('-') ? dir.substring(1).replace(/-/g, '/') : dir.replace(/-/g, '/')
                if (cwd === '/' + decoded || cwd.startsWith('/' + decoded + '/')) {
                  const candidate = join(projectsDir, dir)
                  if (existsSync(candidate)) {
                    searchDir = candidate
                    break
                  }
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
            if (newest && (Date.now() - newest.mtime) < 86400000) {
              sessionId = newest.name.replace('.jsonl', '')
            }
          }
        } catch { /* skip */ }
      }

      external.push({ pid, name, cwd, sessionId, args: fullCmd.slice(0, 200) })
    }

    return external
  } catch { return [] }
}

// ---- Session messages ----

export interface SessionMessage {
  role: string
  text: string
  timestamp?: string
  type?: string
}

export function readSessionMessages(sessionId: string, limit: number = 50): { messages: SessionMessage[]; project: string | null } {
  const home = app.getPath('home')
  const projectsDir = join(home, '.claude', 'projects')
  if (!existsSync(projectsDir)) return { messages: [], project: null }

  let sessionFile: string | null = null
  let projectPath: string | null = null
  try {
    for (const dir of readdirSync(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
      if (existsSync(candidate)) {
        sessionFile = candidate
        projectPath = dir.replace(/-/g, '/')
        break
      }
    }
  } catch { /* skip */ }

  if (!sessionFile) return { messages: [], project: projectPath }

  try {
    const MAX_READ = 2 * 1024 * 1024
    const stat = statSync(sessionFile)
    let content: string
    if (stat.size > MAX_READ) {
      const fd = openSync(sessionFile, 'r')
      const buf = Buffer.alloc(MAX_READ)
      readSync(fd, buf, 0, MAX_READ, stat.size - MAX_READ)
      closeSync(fd)
      const str = buf.toString('utf-8')
      const nl = str.indexOf('\n')
      content = nl >= 0 ? str.slice(nl + 1) : str
    } else {
      content = readFileSync(sessionFile, 'utf-8')
    }

    const lines = content.trim().split('\n')
    const messages: SessionMessage[] = []

    for (const line of lines) {
      try {
        const entry = JSON.parse(line)
        if (!entry.message) continue
        const role = entry.message.role || entry.type

        if (role === 'user' && entry.type === 'user') {
          let text = ''
          if (typeof entry.message.content === 'string') {
            text = entry.message.content
          } else if (Array.isArray(entry.message.content)) {
            const hasToolResult = entry.message.content.some((c: any) => c.type === 'tool_result')
            if (hasToolResult) continue
            text = entry.message.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n')
          }
          if (text && text.trim()) {
            messages.push({ role: 'human', text: text.slice(0, 1000), timestamp: entry.timestamp || undefined, type: 'user' })
          }
        } else if (role === 'assistant') {
          let text = ''
          if (typeof entry.message.content === 'string') {
            text = entry.message.content
          } else if (Array.isArray(entry.message.content)) {
            text = entry.message.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n')
          }
          if (text && text.trim()) {
            messages.push({ role: 'assistant', text: text.slice(0, 2000), timestamp: entry.timestamp || undefined, type: 'assistant' })
          }
        }
      } catch { /* skip bad lines */ }
    }

    return { messages: messages.slice(-limit), project: projectPath }
  } catch {
    return { messages: [], project: projectPath }
  }
}

// ---- Session search ----

export interface SessionSearchResult {
  sessionId: string
  name: string | null
  project: string
  match: string
}

export async function searchSessions(query: string): Promise<SessionSearchResult[]> {
  const home = app.getPath('home')
  const projectsDir = join(home, '.claude', 'projects')
  if (!existsSync(projectsDir)) return []

  const q = query.toLowerCase()
  const results: SessionSearchResult[] = []

  for (const dir of readdirSync(projectsDir)) {
    if (results.length >= 30) break
    const dirPath = join(projectsDir, dir)
    try {
      const files = readdirSync(dirPath).filter((f: string) => f.endsWith('.jsonl'))
      for (const file of files) {
        if (results.length >= 30) break
        const sessionId = file.replace('.jsonl', '')
        try {
          await new Promise<void>((resolve) => {
            let customTitle: string | null = null
            let matchLine: string | null = null
            let projectPath = ''
            const rl = createInterface({ input: createReadStream(join(dirPath, file), { encoding: 'utf-8' }) })
            rl.on('line', (line: string) => {
              if (!line.trim()) return
              try {
                const entry = JSON.parse(line)
                if (entry.type === 'custom-title' && entry.customTitle) customTitle = entry.customTitle
                if (entry.cwd) projectPath = entry.cwd
                const display = entry.display || ''
                if (!matchLine && display.toLowerCase().includes(q)) {
                  matchLine = display.slice(0, 100)
                  rl.close()
                }
              } catch { /* skip bad lines */ }
            })
            rl.on('close', () => {
              if (matchLine) {
                results.push({
                  sessionId,
                  name: customTitle,
                  project: projectPath.split('/').pop() || projectPath,
                  match: matchLine,
                })
              }
              resolve()
            })
          })
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
  }
  return results
}

// ---- Session takeover ----

export interface TakeoverResult {
  cwd: string
  args: string[]
  name: string
}

export async function takeoverSession(opts: { pid: number; sessionId: string | null; name: string; cwd: string }): Promise<TakeoverResult> {
  let cwd = opts.cwd
  if (!cwd) {
    try {
      const lsofCwd = execSync(`lsof -p ${opts.pid} -d cwd -Fn 2>/dev/null`, {
        encoding: 'utf-8', timeout: 3000,
      })
      const cwdMatch = lsofCwd.match(/\nn(.+)/)
      if (cwdMatch) cwd = cwdMatch[1]
    } catch { /* */ }
  }

  if (opts.sessionId && !cwd) {
    const home = app.getPath('home')
    const projectsDir = join(home, '.claude', 'projects')
    try {
      if (existsSync(projectsDir)) {
        for (const dir of readdirSync(projectsDir)) {
          const candidate = join(projectsDir, dir, `${opts.sessionId}.jsonl`)
          if (existsSync(candidate)) {
            cwd = '/' + dir.substring(1).replace(/-/g, '/')
            break
          }
        }
      }
    } catch { /* */ }
  }

  if (!cwd) cwd = process.env.HOME || '/'

  try {
    process.kill(opts.pid, 'SIGTERM')
    await new Promise(r => setTimeout(r, 1000))
    try {
      process.kill(opts.pid, 0)
      process.kill(opts.pid, 'SIGKILL')
      await new Promise(r => setTimeout(r, 500))
    } catch { /* already dead */ }
  } catch { /* process may already be gone */ }

  const args: string[] = []
  if (opts.sessionId) args.push('--resume', opts.sessionId)
  return { cwd, args, name: opts.name }
}
