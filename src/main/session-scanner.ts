import { promises as fsp } from 'fs'
import { join } from 'path'
import { execFile } from 'child_process'
import { createReadStream } from 'fs'
import { createInterface } from 'readline'
import { app } from 'electron'
import { getRecentSessions, discoverSessionId } from './recent-sessions'
import { getAllInstances } from './instance-manager'
import type { CliSession } from '../shared/types'

/** Run a command and return stdout, or null on error. */
function run(cmd: string, args: string[], timeout = 5000): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(cmd, args, { encoding: 'utf-8', timeout }, (err, stdout) => {
      if (err) resolve(null)
      else resolve(stdout)
    })
  })
}

export async function scanSessions(limit = 50): Promise<CliSession[]> {
  const home = app.getPath('home')
  const historyPath = join(home, '.claude', 'history.jsonl')

  try {
    await fsp.stat(historyPath)
  } catch {
    return []
  }

  try {
    const content = await fsp.readFile(historyPath, 'utf-8')
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
    const recent = await getRecentSessions()
    const recentSessionIds = new Set(
      recent.filter((r) => r.sessionId).map((r) => r.sessionId!)
    )

    // Read customTitle from session JSONL files (set via --name or /rename)
    const customTitles = new Map<string, string>()
    try {
      const projectsDir = join(home, '.claude', 'projects')
      try {
        const projectDirs = await fsp.readdir(projectsDir)
        for (const dir of projectDirs) {
          const dirPath = join(projectsDir, dir)
          try {
            const files = (await fsp.readdir(dirPath)).filter((f: string) => f.endsWith('.jsonl'))
            for (const file of files) {
              const sessionId = file.replace('.jsonl', '')
              if (customTitles.has(sessionId)) continue
              try {
                // Only read the first few lines — customTitle is usually first
                const fd = await fsp.readFile(join(dirPath, file), 'utf-8')
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
      } catch { /* projectsDir doesn't exist */ }
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
    const psOutput = await run('ps', ['aux'])
    if (!psOutput) return []

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
        const lsofCwd = await run('lsof', ['-p', String(pid), '-d', 'cwd', '-Fn'], 3000)
        if (lsofCwd) {
          const cwdMatch = lsofCwd.match(/\nn(.+)/)
          if (cwdMatch) cwd = cwdMatch[1]
        }
      }

      if (!sessionId) {
        // Use shared session discovery with 24h recency window for external sessions
        sessionId = await discoverSessionId(pid, cwd || '', 86400000)
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

export async function readSessionMessages(sessionId: string, limit: number = 50): Promise<{ messages: SessionMessage[]; project: string | null }> {
  const home = app.getPath('home')
  const projectsDir = join(home, '.claude', 'projects')
  try { await fsp.stat(projectsDir) } catch { return { messages: [], project: null } }

  let sessionFile: string | null = null
  let projectPath: string | null = null
  try {
    for (const dir of await fsp.readdir(projectsDir)) {
      const candidate = join(projectsDir, dir, `${sessionId}.jsonl`)
      try {
        await fsp.stat(candidate)
        sessionFile = candidate
        projectPath = dir.replace(/-/g, '/')
        break
      } catch { /* doesn't exist */ }
    }
  } catch { /* skip */ }

  if (!sessionFile) return { messages: [], project: projectPath }

  try {
    const MAX_READ = 2 * 1024 * 1024
    const stat = await fsp.stat(sessionFile)
    let content: string
    if (stat.size > MAX_READ) {
      const fh = await fsp.open(sessionFile, 'r')
      const buf = Buffer.alloc(MAX_READ)
      await fh.read(buf, 0, MAX_READ, stat.size - MAX_READ)
      await fh.close()
      const str = buf.toString('utf-8')
      const nl = str.indexOf('\n')
      content = nl >= 0 ? str.slice(nl + 1) : str
    } else {
      content = await fsp.readFile(sessionFile, 'utf-8')
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
  try { await fsp.stat(projectsDir) } catch { return [] }

  const q = query.toLowerCase()
  const results: SessionSearchResult[] = []

  for (const dir of await fsp.readdir(projectsDir)) {
    if (results.length >= 30) break
    const dirPath = join(projectsDir, dir)
    try {
      const files = (await fsp.readdir(dirPath)).filter((f: string) => f.endsWith('.jsonl'))
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
    const lsofCwd = await run('lsof', ['-p', String(opts.pid), '-d', 'cwd', '-Fn'], 3000)
    if (lsofCwd) {
      const cwdMatch = lsofCwd.match(/\nn(.+)/)
      if (cwdMatch) cwd = cwdMatch[1]
    }
  }

  if (opts.sessionId && !cwd) {
    const home = app.getPath('home')
    const projectsDir = join(home, '.claude', 'projects')
    try {
      for (const dir of await fsp.readdir(projectsDir)) {
        const candidate = join(projectsDir, dir, `${opts.sessionId}.jsonl`)
        try {
          await fsp.stat(candidate)
          cwd = '/' + dir.substring(1).replace(/-/g, '/')
          break
        } catch { /* doesn't exist */ }
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
