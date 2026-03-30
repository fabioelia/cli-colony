import { ipcMain, app } from 'electron'
import { join } from 'path'
import { getAllInstances } from '../instance-manager'
import { scanSessions } from '../session-scanner'
import { getRestorableSessions, clearRestorable, getRecentSessions } from '../recent-sessions'

export function registerSessionHandlers(): void {
  ipcMain.handle('sessions:list', (_e, limit?: number) => scanSessions(limit))

  ipcMain.handle('sessions:external', async () => {
    const { execSync } = require('child_process') as typeof import('child_process')
    try {
      const psOutput = execSync('ps aux', { encoding: 'utf-8', timeout: 5000 })

      const instances = await getAllInstances()
      const managedPids = new Set(instances.map(i => i.pid).filter(Boolean))

      const external: Array<{ pid: number; name: string; cwd: string; sessionId: string | null; args: string }> = []

      for (const line of psOutput.split('\n')) {
        const parts = line.trim().split(/\s+/)
        const pid = parseInt(parts[1])
        if (isNaN(pid) || managedPids.has(pid)) continue

        const fullCmd = parts.slice(10).join(' ')

        // Only match actual Claude CLI processes — the command must BE "claude",
        // not just contain "claude" somewhere in the path (e.g. vite under .claude-colony/)
        const cmdBin = fullCmd.split(/\s/)[0]
        const baseName = cmdBin.split('/').pop() || ''
        if (baseName !== 'claude') continue
        // Skip Colony's own processes
        if (/claude-electron|Electron|ShipIt/.test(fullCmd)) continue
        const nameMatch = fullCmd.match(/--name\s+([^\s]+(?:\s+[^\s-][^\s]*)*?)(?=\s+--|$)/)
        const name = nameMatch ? nameMatch[1] : `claude (pid ${pid})`
        const dirMatch = fullCmd.match(/--add-dir\s+(\S+)/)
        let cwd = dirMatch ? dirMatch[1] : ''
        const resumeMatch = fullCmd.match(/--resume\s+(\S+)/)
        let sessionId = resumeMatch ? resumeMatch[1] : null

        // Resolve CWD from lsof if not known from args
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

        // Fallback: match CWD to most recently modified session file in the project dir
        if (!sessionId && cwd) {
          try {
            const { readdirSync, statSync, existsSync } = require('fs') as typeof import('fs')
            const home = app.getPath('home')
            // Claude CLI encodes project paths by replacing both / and . with -
            const projectDirName = cwd.replace(/[/.]/g, '-')
            const projectDir = join(home, '.claude', 'projects', projectDirName)
            let searchDir = existsSync(projectDir) ? projectDir : null

            // Fallback: search all project dirs for one that decodes to our CWD
            if (!searchDir) {
              const projectsDir = join(home, '.claude', 'projects')
              if (existsSync(projectsDir)) {
                for (const dir of readdirSync(projectsDir)) {
                  // Reverse the encoding: leading - is /, then split on - and check if it matches cwd
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
              // Only use if modified in the last 24 hours (likely an active session)
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
  })

  ipcMain.handle('sessions:messages', async (_e, sessionId: string, limit: number = 50) => {
    const { readdirSync, existsSync, statSync, openSync, readSync, closeSync } = require('fs') as typeof import('fs')
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
      // Only read the last ~2MB of large files (messages at the end are most relevant)
      const MAX_READ = 2 * 1024 * 1024
      const stat = statSync(sessionFile)
      let content: string
      if (stat.size > MAX_READ) {
        const fd = openSync(sessionFile, 'r')
        const buf = Buffer.alloc(MAX_READ)
        readSync(fd, buf, 0, MAX_READ, stat.size - MAX_READ)
        closeSync(fd)
        // Skip the first partial line
        const str = buf.toString('utf-8')
        const nl = str.indexOf('\n')
        content = nl >= 0 ? str.slice(nl + 1) : str
      } else {
        const { readFileSync } = require('fs') as typeof import('fs')
        content = readFileSync(sessionFile, 'utf-8')
      }

      const lines = content.trim().split('\n')
      const messages: Array<{ role: string; text: string; timestamp?: string; type?: string }> = []

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
  })

  ipcMain.handle('sessions:takeover', async (_e, opts: { pid: number; sessionId: string | null; name: string; cwd: string }) => {
    // Resolve CWD BEFORE killing the process (lsof won't work on a dead process)
    let cwd = opts.cwd
    if (!cwd) {
      const { execSync } = require('child_process') as typeof import('child_process')
      try {
        const lsofCwd = execSync(`lsof -p ${opts.pid} -d cwd -Fn 2>/dev/null`, {
          encoding: 'utf-8', timeout: 3000,
        })
        const cwdMatch = lsofCwd.match(/\nn(.+)/)
        if (cwdMatch) cwd = cwdMatch[1]
      } catch { /* */ }
    }

    // When we have a sessionId, derive the correct project path from the session file
    if (opts.sessionId && !cwd) {
      const { readdirSync, existsSync } = require('fs') as typeof import('fs')
      const home = app.getPath('home')
      const projectsDir = join(home, '.claude', 'projects')
      try {
        if (existsSync(projectsDir)) {
          for (const dir of readdirSync(projectsDir)) {
            const candidate = join(projectsDir, dir, `${opts.sessionId}.jsonl`)
            if (existsSync(candidate)) {
              // Decode the project dir name back to a path
              // Claude CLI encodes: /Users/fabio/project → -Users-fabio-project
              // Note: this is lossy (dots become dashes too), so we use it as best-effort
              cwd = '/' + dir.substring(1).replace(/-/g, '/')
              break
            }
          }
        }
      } catch { /* */ }
    }

    if (!cwd) cwd = process.env.HOME || '/'

    // Now kill the external process
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
  })

  ipcMain.handle('sessions:search', async (_e, query: string) => {
    const { readdirSync, existsSync, createReadStream } = require('fs') as typeof import('fs')
    const { createInterface } = require('readline') as typeof import('readline')
    const home = app.getPath('home')
    const projectsDir = join(home, '.claude', 'projects')
    if (!existsSync(projectsDir)) return []

    const q = query.toLowerCase()
    const results: Array<{ sessionId: string; name: string | null; project: string; match: string }> = []

    for (const dir of readdirSync(projectsDir)) {
      if (results.length >= 30) break
      const dirPath = join(projectsDir, dir)
      try {
        const files = readdirSync(dirPath).filter((f: string) => f.endsWith('.jsonl'))
        for (const file of files) {
          if (results.length >= 30) break
          const sessionId = file.replace('.jsonl', '')
          // Stream line-by-line to avoid reading 50-100MB files into memory
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
  })

  ipcMain.handle('sessions:restorable', () => getRestorableSessions())
  ipcMain.handle('sessions:clearRestorable', () => { clearRestorable(); return true })
  ipcMain.handle('sessions:recent', () => getRecentSessions())
}
