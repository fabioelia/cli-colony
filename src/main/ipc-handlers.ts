import { ipcMain, dialog, shell, app } from 'electron'
import { join } from 'path'
import {
  createInstance,
  writeToInstance,
  resizeInstance,
  killInstance,
  removeInstance,
  renameInstance,
  recolorInstance,
  restartInstance,
  pinInstance,
  unpinInstance,
  getAllInstances,
  getInstance,
  getInstanceBuffer,
  restartDaemon,
} from './instance-manager'
import { scanAgents, createAgent } from './agent-scanner'
import { scanSessions } from './session-scanner'
import { getRestorableSessions, clearRestorable, getRecentSessions } from './recent-sessions'
import { getSettings, setSetting } from './settings'
import { getLogs, clearLogs } from './logger'
import {
  checkGhAuth, fetchPRs, getRepos, addRepo, removeRepo,
  updateRepoPath, getPrompts, savePrompts, resolvePrompt, writePrContext,
  getPrMemory, savePrMemory, getPrMemoryPath, getPrWorkspacePath,
  fetchChecks, fetchCheckLogs,
} from './github'
import type { GitHubRepo, QuickPrompt, GitHubPR } from './github'
import { updateColonyContext, getColonyContextPath, getColonyContextInstruction } from './colony-context'

export function registerIpcHandlers(): void {
  ipcMain.handle('instance:create', (_e, opts) => createInstance(opts || {}))
  ipcMain.handle('instance:write', (_e, id: string, data: string) => writeToInstance(id, data))
  ipcMain.handle('instance:resize', (_e, id: string, cols: number, rows: number) => resizeInstance(id, cols, rows))
  ipcMain.handle('instance:kill', (_e, id: string) => killInstance(id))
  ipcMain.handle('instance:remove', (_e, id: string) => removeInstance(id))
  ipcMain.handle('instance:rename', (_e, id: string, name: string) => renameInstance(id, name))
  ipcMain.handle('instance:recolor', (_e, id: string, color: string) => recolorInstance(id, color))
  ipcMain.handle('instance:restart', (_e, id: string) => restartInstance(id))
  ipcMain.handle('instance:pin', (_e, id: string) => pinInstance(id))
  ipcMain.handle('instance:unpin', (_e, id: string) => unpinInstance(id))
  ipcMain.handle('instance:list', () => getAllInstances())
  ipcMain.handle('instance:get', (_e, id: string) => getInstance(id))
  ipcMain.handle('instance:buffer', (_e, id: string) => getInstanceBuffer(id))
  ipcMain.handle('daemon:restart', () => restartDaemon())

  ipcMain.handle('agents:list', () => scanAgents())
  ipcMain.handle('agents:create', (_e, name: string, scope: string, projectPath?: string) =>
    createAgent(name, scope as 'personal' | 'project', projectPath)
  )
  ipcMain.handle('agents:export', async (_e, agentPaths: string[]) => {
    const { createWriteStream, readFileSync, existsSync } = require('fs') as typeof import('fs')
    const { basename } = require('path') as typeof import('path')
    const archiver = require('archiver') as any
    const result = await dialog.showSaveDialog({
      defaultPath: 'agents.zip',
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
    })
    if (result.canceled || !result.filePath) return false
    return new Promise<boolean>((resolve) => {
      const output = createWriteStream(result.filePath!)
      const archive = archiver('zip', { zlib: { level: 9 } })
      archive.pipe(output)
      for (const p of agentPaths) {
        if (existsSync(p)) {
          archive.file(p, { name: basename(p) })
        }
      }
      output.on('close', () => resolve(true))
      archive.on('error', () => resolve(false))
      archive.finalize()
    })
  })

  ipcMain.handle('agents:import', async (_e, targetDir: string) => {
    const { mkdirSync, existsSync, createReadStream, createWriteStream } = require('fs') as typeof import('fs')
    const { join, basename } = require('path') as typeof import('path')
    const unzipper = require('unzipper') as any
    const result = await dialog.showOpenDialog({
      filters: [{ name: 'ZIP', extensions: ['zip'] }],
      properties: ['openFile'],
    })
    if (result.canceled || result.filePaths.length === 0) return 0
    // Resolve personal agents path if empty
    const resolvedDir = targetDir || join(app.getPath('home'), '.claude', 'agents')
    if (!existsSync(resolvedDir)) mkdirSync(resolvedDir, { recursive: true })
    return new Promise<number>((resolve) => {
      let count = 0
      createReadStream(result.filePaths[0])
        .pipe(unzipper.Parse())
        .on('entry', (entry: any) => {
          const name = basename(entry.path)
          if (name.endsWith('.md') && !name.startsWith('.')) {
            count++
            entry.pipe(createWriteStream(join(resolvedDir, name)))
          } else {
            entry.autodrain()
          }
        })
        .on('close', () => resolve(count))
        .on('error', () => resolve(count))
    })
  })

  ipcMain.handle('agents:read', (_e, filePath: string) => {
    const { readFileSync } = require('fs') as typeof import('fs')
    try {
      return readFileSync(filePath, 'utf-8')
    } catch {
      return null
    }
  })
  ipcMain.handle('agents:write', (_e, filePath: string, content: string) => {
    const { writeFileSync } = require('fs') as typeof import('fs')
    try {
      writeFileSync(filePath, content, 'utf-8')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('sessions:list', (_e, limit?: number) => scanSessions(limit))
  ipcMain.handle('sessions:restorable', () => getRestorableSessions())
  ipcMain.handle('sessions:clearRestorable', () => { clearRestorable(); return true })
  ipcMain.handle('sessions:recent', () => getRecentSessions())

  ipcMain.handle('settings:getAll', () => getSettings())
  ipcMain.handle('settings:getShells', () => {
    const { readFileSync } = require('fs') as typeof import('fs')
    try {
      const content = readFileSync('/etc/shells', 'utf-8')
      return content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    } catch {
      return ['/bin/zsh', '/bin/bash', '/bin/sh']
    }
  })
  ipcMain.handle('settings:getSearchIgnore', () => {
    const raw = getSetting('searchIgnore')
    return raw ? raw.split(',').map((s: string) => s.trim()).filter(Boolean) : []
  })
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    setSetting(key, value)
    return true
  })

  ipcMain.handle('logs:get', () => {
    const appLogs = getLogs()
    // Also include daemon logs
    const { readFileSync, existsSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    const daemonLogPath = join(app.getPath('home'), '.claude-colony', 'daemon.log')
    let daemonLogs = ''
    try {
      if (existsSync(daemonLogPath)) {
        const full = readFileSync(daemonLogPath, 'utf-8')
        // Last 200 lines
        const lines = full.split('\n')
        daemonLogs = lines.slice(-200).join('\n')
      }
    } catch { /* */ }
    return daemonLogs ? `${appLogs}\n\n--- Daemon Logs ---\n${daemonLogs}` : appLogs
  })
  ipcMain.handle('logs:clear', () => {
    clearLogs()
    const { writeFileSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    try { writeFileSync(join(app.getPath('home'), '.claude-colony', 'daemon.log'), '', 'utf-8') } catch { /* */ }
    return true
  })

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // File system
  ipcMain.handle('fs:listDir', async (_e, dirPath: string, depth: number = 2) => {
    const { readdirSync, statSync } = require('fs') as typeof import('fs')
    const { join, basename } = require('path') as typeof import('path')

    interface FileNode {
      name: string
      path: string
      type: 'file' | 'directory'
      children?: FileNode[]
    }

    const IGNORE = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'venv',
      '.DS_Store', '.claude', 'dist', 'build', 'out', '.cache', 'coverage', '.turbo', '.nuxt'])

    function scan(dir: string, currentDepth: number): FileNode[] {
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((e) => !e.name.startsWith('.') || e.name === '.env' || e.name === '.github')
          .filter((e) => !IGNORE.has(e.name))
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1
            if (!a.isDirectory() && b.isDirectory()) return 1
            return a.name.localeCompare(b.name)
          })

        return entries.map((e) => {
          const fullPath = join(dir, e.name)
          const isDir = e.isDirectory()
          const node: FileNode = { name: e.name, path: fullPath, type: isDir ? 'directory' : 'file' }
          if (isDir && currentDepth < depth) {
            node.children = scan(fullPath, currentDepth + 1)
          }
          return node
        })
      } catch {
        return []
      }
    }

    return scan(dirPath, 0)
  })

  // Check if clipboard has an image, save it, return path (or null if no image)
  ipcMain.handle('fs:pasteClipboardImage', async () => {
    const { clipboard } = require('electron') as typeof import('electron')
    const { writeFileSync, mkdirSync, existsSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const tmpDir = join(app.getPath('home'), '.claude-colony', 'screenshots')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
    const fileName = `screenshot-${Date.now()}.png`
    const filePath = join(tmpDir, fileName)
    writeFileSync(filePath, img.toPNG())
    return filePath
  })

  ipcMain.handle('fs:saveClipboardImage', async (_e, base64Data: string) => {
    const { writeFileSync, mkdirSync, existsSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    const tmpDir = join(app.getPath('home'), '.claude-colony', 'screenshots')
    if (!existsSync(tmpDir)) mkdirSync(tmpDir, { recursive: true })
    const fileName = `screenshot-${Date.now()}.png`
    const filePath = join(tmpDir, fileName)
    const buffer = Buffer.from(base64Data, 'base64')
    writeFileSync(filePath, buffer)
    return filePath
  })

  ipcMain.handle('fs:searchContent', async (_e, dirPath: string, query: string, ignoreDirs?: string[]) => {
    const { execFile } = require('child_process') as typeof import('child_process')

    console.log(`[search] query="${query}" dir="${dirPath}"`)
    if (!query || query.length < 2) return []

    interface SearchResult {
      file: string
      matches: Array<{ line: number; text: string }>
    }

    const defaultExclude = ['--exclude-dir=.git', '--exclude-dir=node_modules', '--exclude-dir=.next',
      '--exclude-dir=__pycache__', '--exclude-dir=.venv', '--exclude-dir=venv',
      '--exclude-dir=dist', '--exclude-dir=build', '--exclude-dir=out',
      '--exclude-dir=.cache', '--exclude-dir=coverage', '--exclude-dir=.turbo', '--exclude-dir=.nuxt']
    const customExclude = (ignoreDirs || []).map((d) => `--exclude-dir=${d}`)
    const includes = [
      '--include=*.ts', '--include=*.tsx', '--include=*.js', '--include=*.jsx',
      '--include=*.py', '--include=*.rs', '--include=*.go', '--include=*.java',
      '--include=*.md', '--include=*.json', '--include=*.yaml', '--include=*.yml',
      '--include=*.css', '--include=*.scss', '--include=*.html', '--include=*.sql',
      '--include=*.sh', '--include=*.toml', '--include=*.cfg', '--include=*.txt',
      '--include=*.rb', '--include=*.php', '--include=*.swift', '--include=*.c',
      '--include=*.cpp', '--include=*.h', '--include=*.xml', '--include=*.vue',
      '--include=*.svelte', '--include=*.graphql', '--include=*.proto',
    ]

    const args = ['-rni', '-m', '5', ...defaultExclude, ...customExclude, ...includes, '--', query, dirPath]

    return new Promise<SearchResult[]>((resolve) => {
      execFile('grep', args, { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
        if (!stdout) {
          console.log(`[search] no results (err: ${err?.message || 'none'})`)
          resolve([])
          return
        }
        const byFile = new Map<string, Array<{ line: number; text: string }>>()
        for (const line of stdout.split('\n')) {
          const match = line.match(/^(.+?):(\d+):(.*)$/)
          if (!match) continue
          const [, file, lineNum, text] = match
          if (!byFile.has(file)) byFile.set(file, [])
          byFile.get(file)!.push({ line: parseInt(lineNum, 10), text: text.trim().slice(0, 200) })
        }
        const results: SearchResult[] = []
        for (const [file, matches] of byFile) {
          results.push({ file, matches })
        }
        console.log(`[search] done: ${results.length} files matched`)
        resolve(results)
      })
    })
  })

  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    const { readFileSync, statSync } = require('fs') as typeof import('fs')
    try {
      const stat = statSync(filePath)
      // Skip files larger than 1MB
      if (stat.size > 1024 * 1024) return { error: 'File too large (>1MB)' }
      return { content: readFileSync(filePath, 'utf-8') }
    } catch (err: any) {
      return { error: err.message }
    }
  })

  // GitHub
  ipcMain.handle('github:authStatus', () => checkGhAuth())
  ipcMain.handle('github:fetchPRs', (_e, repo: GitHubRepo) => fetchPRs(repo))
  ipcMain.handle('github:getRepos', () => getRepos())
  ipcMain.handle('github:addRepo', (_e, repo: GitHubRepo) => addRepo(repo))
  ipcMain.handle('github:removeRepo', (_e, owner: string, name: string) => removeRepo(owner, name))
  ipcMain.handle('github:updateRepoPath', (_e, owner: string, name: string, localPath: string) => updateRepoPath(owner, name, localPath))
  ipcMain.handle('github:getPrompts', () => getPrompts())
  ipcMain.handle('github:savePrompts', (_e, prompts: QuickPrompt[]) => savePrompts(prompts))
  ipcMain.handle('github:resolvePrompt', (_e, prompt: QuickPrompt, pr: GitHubPR, repo: GitHubRepo) => resolvePrompt(prompt, pr, repo))
  ipcMain.handle('github:writePrContext', (_e, prsByRepo: Record<string, GitHubPR[]>) => writePrContext(prsByRepo))
  ipcMain.handle('github:getPrMemory', () => getPrMemory())
  ipcMain.handle('github:savePrMemory', (_e, content: string) => savePrMemory(content))
  ipcMain.handle('github:getPrMemoryPath', () => getPrMemoryPath())
  ipcMain.handle('github:getPrWorkspacePath', () => getPrWorkspacePath())
  ipcMain.handle('github:getCommentsFile', (_e, repoSlug: string, prNumber: number) => {
    const { readFileSync, existsSync } = require('fs') as typeof import('fs')
    const { join } = require('path') as typeof import('path')
    const commentsDir = join(app.getPath('home'), '.claude-colony', 'pr-workspace', 'comments')
    const safeSlug = repoSlug.replace(/\//g, '-')
    const filePath = join(commentsDir, `${safeSlug}-${prNumber}.md`)
    if (!existsSync(filePath)) return null
    return readFileSync(filePath, 'utf-8')
  })
  ipcMain.handle('github:fetchChecks', (_e, repo: GitHubRepo, prNumber: number) => fetchChecks(repo, prNumber))
  ipcMain.handle('github:fetchCheckLogs', (_e, repo: GitHubRepo, prNumber: number, checkName: string) => fetchCheckLogs(repo, prNumber, checkName))

  // Colony context
  ipcMain.handle('colony:updateContext', () => updateColonyContext())
  ipcMain.handle('colony:getContextPath', () => getColonyContextPath())
  ipcMain.handle('colony:getContextInstruction', () => getColonyContextInstruction())

  // Task queue file I/O
  const QUEUE_DIR = join(app.getPath('home'), '.claude-colony', 'task-queues')
  ipcMain.handle('taskQueue:list', () => {
    const { readdirSync, readFileSync, existsSync, mkdirSync } = require('fs') as typeof import('fs')
    if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true })
    try {
      return readdirSync(QUEUE_DIR)
        .filter((f: string) => f.endsWith('.yaml') || f.endsWith('.yml') || f.endsWith('.md'))
        .map((f: string) => ({
          name: f,
          path: join(QUEUE_DIR, f),
          content: readFileSync(join(QUEUE_DIR, f), 'utf-8'),
        }))
    } catch { return [] }
  })
  ipcMain.handle('taskQueue:save', (_e, name: string, content: string) => {
    const { writeFileSync, existsSync, mkdirSync } = require('fs') as typeof import('fs')
    if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true })
    const filePath = join(QUEUE_DIR, name)
    writeFileSync(filePath, content, 'utf-8')
    return filePath
  })
  ipcMain.handle('taskQueue:delete', (_e, name: string) => {
    const { unlinkSync, existsSync } = require('fs') as typeof import('fs')
    const filePath = join(QUEUE_DIR, name)
    if (existsSync(filePath)) { unlinkSync(filePath); return true }
    return false
  })

  // Resource monitor — get CPU/memory for all instance PIDs
  ipcMain.handle('resources:getUsage', async () => {
    const { execFile } = require('child_process') as typeof import('child_process')
    const instances = await getAllInstances()
    const pids = instances
      .filter((i) => i.pid && i.status === 'running')
      .map((i) => ({ id: i.id, pid: i.pid! }))

    if (pids.length === 0) {
      return { perInstance: {}, total: { cpu: 0, memory: 0 } }
    }

    // Use ps to get CPU and RSS for each PID and its children
    return new Promise<{
      perInstance: Record<string, { cpu: number; memory: number }>
      total: { cpu: number; memory: number }
    }>((resolve) => {
      const pidList = pids.map((p) => p.pid).join(',')
      // Get the process and all children via pgrep + ps
      execFile('ps', ['-o', 'pid,ppid,%cpu,rss', '-p', pidList], { timeout: 5000 }, (err, stdout) => {
        const perInstance: Record<string, { cpu: number; memory: number }> = {}
        let totalCpu = 0
        let totalMem = 0

        if (!err && stdout) {
          const lines = stdout.trim().split('\n').slice(1) // skip header
          for (const line of lines) {
            const parts = line.trim().split(/\s+/)
            if (parts.length < 4) continue
            const pid = parseInt(parts[0], 10)
            const cpu = parseFloat(parts[2]) || 0
            const rss = parseInt(parts[3], 10) || 0 // KB
            const memMB = rss / 1024

            // Find which instance owns this PID
            const entry = pids.find((p) => p.pid === pid)
            if (entry) {
              perInstance[entry.id] = { cpu, memory: Math.round(memMB * 10) / 10 }
              totalCpu += cpu
              totalMem += memMB
            }
          }
        }

        // Also get child processes
        execFile('ps', ['-eo', 'pid,ppid,%cpu,rss'], { timeout: 5000 }, (err2, stdout2) => {
          if (!err2 && stdout2) {
            const pidSet = new Set(pids.map((p) => p.pid))
            const pidToInstance = new Map<number, string>()
            for (const p of pids) pidToInstance.set(p.pid, p.id)

            const lines = stdout2.trim().split('\n').slice(1)
            for (const line of lines) {
              const parts = line.trim().split(/\s+/)
              if (parts.length < 4) continue
              const pid = parseInt(parts[0], 10)
              const ppid = parseInt(parts[1], 10)
              const cpu = parseFloat(parts[2]) || 0
              const rss = parseInt(parts[3], 10) || 0
              const memMB = rss / 1024

              // Is this a child of one of our instance PIDs?
              if (pidSet.has(ppid) && !pidSet.has(pid)) {
                const instId = pidToInstance.get(ppid)
                if (instId) {
                  if (!perInstance[instId]) perInstance[instId] = { cpu: 0, memory: 0 }
                  perInstance[instId].cpu += cpu
                  perInstance[instId].memory += Math.round(memMB * 10) / 10
                  totalCpu += cpu
                  totalMem += memMB
                }
              }
            }
          }

          resolve({
            perInstance,
            total: {
              cpu: Math.round(totalCpu * 10) / 10,
              memory: Math.round(totalMem),
            },
          })
        })
      })
    })
  })
}
