import { ipcMain, dialog, shell, app, clipboard } from 'electron'
import { promises as fsp } from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { getAllInstances } from './instance-manager'
import { getSettings, setSetting, detectGitProtocol } from './settings'
import { getLogs, clearLogs } from './logger'
import { updateColonyContext, getColonyContextPath, getColonyContextInstruction } from './colony-context'

// Handler modules
import { registerInstanceHandlers } from './ipc/instance-handlers'
import { registerAgentHandlers } from './ipc/agent-handlers'
import { registerSessionHandlers } from './ipc/session-handlers'
import { registerGitHubHandlers } from './ipc/github-handlers'
import { registerPipelineHandlers } from './ipc/pipeline-handlers'
import { registerTaskQueueHandlers } from './ipc/task-queue-handlers'
import { registerEnvHandlers } from './ipc/env-handlers'
import { registerPersonaHandlers } from './ipc/persona-handlers'
import { registerActivityHandlers } from './ipc/activity-handlers'
import { registerMcpCatalogHandlers } from './ipc/mcp-catalog-handlers'
import { registerTasksBoardHandlers } from './ipc/tasks-board-handlers'
import { registerAuditHandlers } from './ipc/audit-handlers'
import { registerMcpAuditHandlers } from './ipc/mcp-audit-handlers'
import { registerCommitAttributorHandlers } from './ipc/commit-attributor-handlers'
import { registerArenaHandlers } from './ipc/arena-handlers'
import { registerForkHandlers } from './ipc/fork-handlers'
import { registerSessionTemplateHandlers } from './ipc/session-template-handlers'
import { registerOutputsHandlers } from './ipc/outputs-handlers'
import { registerApprovalRulesHandlers } from './ipc/approval-rules-handlers'
import { registerBatchHandlers } from './ipc/batch-handlers'
import { registerTeamHandlers } from './ipc/team-handlers'
import { registerAppUpdateHandlers } from './ipc/app-update-handlers'
import { registerOnboardingHandlers } from './ipc/onboarding-handlers'

export function registerIpcHandlers(): void {
  // Delegated handler modules
  registerInstanceHandlers()
  registerAgentHandlers()
  registerSessionHandlers()
  registerGitHubHandlers()
  registerPipelineHandlers()
  registerTaskQueueHandlers()
  registerEnvHandlers()
  registerPersonaHandlers()
  registerActivityHandlers()
  registerMcpCatalogHandlers()
  registerTasksBoardHandlers()
  registerAuditHandlers()
  registerMcpAuditHandlers()
  registerCommitAttributorHandlers()
  registerArenaHandlers()
  registerForkHandlers()
  registerSessionTemplateHandlers()
  registerOutputsHandlers()
  registerApprovalRulesHandlers()
  registerBatchHandlers()
  registerTeamHandlers()
  registerAppUpdateHandlers()
  registerOnboardingHandlers()

  // ---- Temp files ----
  ipcMain.handle('fs:writeTempFile', async (_e, prefix: string, content: string) => {
    const dir = path.join(os.tmpdir(), 'claude-colony')
    await fsp.mkdir(dir, { recursive: true })
    const filePath = path.join(dir, `${prefix}-${Date.now()}.txt`)
    await fsp.writeFile(filePath, content, 'utf-8')
    return filePath
  })

  // ---- Settings ----
  ipcMain.handle('settings:getAll', () => getSettings())
  ipcMain.handle('settings:getShells', async () => {
    try {
      const content = await fsp.readFile('/etc/shells', 'utf-8')
      return content.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
    } catch {
      return ['/bin/zsh', '/bin/bash', '/bin/sh']
    }
  })
  ipcMain.handle('settings:detectGitProtocol', () => detectGitProtocol())
  ipcMain.handle('settings:set', async (_e, key: string, value: string) => {
    await setSetting(key, value)
    return true
  })

  // ---- Logs ----
  ipcMain.handle('logs:get', async () => {
    const appLogs = getLogs()
    const daemonLogPath = colonyPaths.daemonLog
    let daemonLogs = ''
    try {
      const full = await fsp.readFile(daemonLogPath, 'utf-8')
      const lines = full.split('\n')
      daemonLogs = lines.slice(-200).join('\n')
    } catch { /* */ }
    return daemonLogs ? `${appLogs}\n\n--- Daemon Logs ---\n${daemonLogs}` : appLogs
  })
  ipcMain.handle('logs:getScheduler', async () => {
    try {
      const lines = (await fsp.readFile(colonyPaths.schedulerLog, 'utf-8')).split('\n').filter(Boolean)
      return lines.slice(-20)
    } catch { return [] }
  })
  ipcMain.handle('logs:clear', async () => {
    clearLogs()
    try { await fsp.writeFile(colonyPaths.daemonLog, '', 'utf-8') } catch { /* */ }
    return true
  })

  // ---- Shell / Dialog ----
  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))
  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })

  // ---- File System ----
  registerFsHandlers()

  // ---- Colony Context ----
  ipcMain.handle('colony:updateContext', () => updateColonyContext())
  ipcMain.handle('colony:getContextPath', () => getColonyContextPath())
  ipcMain.handle('colony:getContextInstruction', () => getColonyContextInstruction())
  ipcMain.handle('colony:writePromptFile', async (_e, content: string) => {
    const promptsDir = colonyPaths.pipelinePrompts
    await fsp.mkdir(promptsDir, { recursive: true })
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const filePath = join(promptsDir, `${id}.md`)
    await fsp.writeFile(filePath, content, 'utf-8')
    return filePath
  })

  // ---- Resource Monitor ----
  registerResourceHandlers()

  // ---- Window Management ----
  ipcMain.handle('window:toggleFullScreen', (_e) => {
    const { BrowserWindow } = require('electron')
    const win = BrowserWindow.getFocusedWindow()
    if (win) {
      win.setFullScreen(!win.isFullScreen())
    }
    return true
  })
}

// ---- File system handlers ----

function registerFsHandlers(): void {
  ipcMain.handle('fs:listDir', async (_e, dirPath: string, depth: number = 2) => {
    interface FileNode {
      name: string
      path: string
      type: 'file' | 'directory'
      children?: FileNode[]
    }

    const IGNORE = new Set(['.git', 'node_modules', '.next', '__pycache__', '.venv', 'venv',
      '.DS_Store', '.claude', 'dist', 'build', 'out', '.cache', 'coverage', '.turbo', '.nuxt'])

    async function scan(dir: string, currentDepth: number): Promise<FileNode[]> {
      try {
        const entries = (await fsp.readdir(dir, { withFileTypes: true }))
          .filter((e) => !e.name.startsWith('.') || e.name === '.env' || e.name === '.github')
          .filter((e) => !IGNORE.has(e.name))
          .sort((a, b) => {
            if (a.isDirectory() && !b.isDirectory()) return -1
            if (!a.isDirectory() && b.isDirectory()) return 1
            return a.name.localeCompare(b.name)
          })

        const nodes: FileNode[] = []
        for (const e of entries) {
          const fullPath = path.join(dir, e.name)
          const isDir = e.isDirectory()
          const node: FileNode = { name: e.name, path: fullPath, type: isDir ? 'directory' : 'file' }
          if (isDir && currentDepth < depth) {
            node.children = await scan(fullPath, currentDepth + 1)
          }
          nodes.push(node)
        }
        return nodes
      } catch {
        return []
      }
    }

    return scan(dirPath, 0)
  })

  ipcMain.handle('fs:pasteClipboardImage', async () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    const tmpDir = colonyPaths.screenshots
    await fsp.mkdir(tmpDir, { recursive: true })
    const fileName = `screenshot-${Date.now()}.png`
    const filePath = join(tmpDir, fileName)
    await fsp.writeFile(filePath, img.toPNG())
    return filePath
  })

  ipcMain.handle('fs:saveClipboardImage', async (_e, base64Data: string) => {
    const tmpDir = colonyPaths.screenshots
    await fsp.mkdir(tmpDir, { recursive: true })
    const fileName = `screenshot-${Date.now()}.png`
    const filePath = join(tmpDir, fileName)
    const buffer = Buffer.from(base64Data, 'base64')
    await fsp.writeFile(filePath, buffer)
    return filePath
  })

  ipcMain.handle('fs:searchContent', async (_e, dirPath: string, query: string, ignoreDirs?: string[]) => {

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
        resolve(results)
      })
    })
  })

  ipcMain.handle('fs:readFile', async (_e, filePath: string) => {
    try {
      const stat = await fsp.stat(filePath)
      if (stat.size > 1024 * 1024) return { error: 'File too large (>1MB)' }
      return { content: await fsp.readFile(filePath, 'utf-8') }
    } catch (err: any) {
      return { error: err.message }
    }
  })
}

// ---- Resource monitor ----

function registerResourceHandlers(): void {
  ipcMain.handle('resources:getUsage', async () => {
    const instances = await getAllInstances()
    const pids = instances
      .filter((i) => i.pid && i.status === 'running')
      .map((i) => ({ id: i.id, pid: i.pid! }))

    if (pids.length === 0) {
      return { perInstance: {}, total: { cpu: 0, memory: 0 } }
    }

    return new Promise<{
      perInstance: Record<string, { cpu: number; memory: number }>
      total: { cpu: number; memory: number }
    }>((resolve) => {
      const pidList = pids.map((p) => p.pid).join(',')
      execFile('ps', ['-o', 'pid,ppid,%cpu,rss', '-p', pidList], { timeout: 5000 }, (err, stdout) => {
        const perInstance: Record<string, { cpu: number; memory: number }> = {}
        let totalCpu = 0
        let totalMem = 0

        if (!err && stdout) {
          const lines = stdout.trim().split('\n').slice(1)
          for (const line of lines) {
            const parts = line.trim().split(/\s+/)
            if (parts.length < 4) continue
            const pid = parseInt(parts[0], 10)
            const cpu = parseFloat(parts[2]) || 0
            const rss = parseInt(parts[3], 10) || 0
            const memMB = rss / 1024

            const entry = pids.find((p) => p.pid === pid)
            if (entry) {
              perInstance[entry.id] = { cpu, memory: Math.round(memMB * 10) / 10 }
              totalCpu += cpu
              totalMem += memMB
            }
          }
        }

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

              if (!pidSet.has(pid) && pidToInstance.has(ppid)) {
                const cpu = parseFloat(parts[2]) || 0
                const rss = parseInt(parts[3], 10) || 0
                const memMB = rss / 1024
                const instanceId = pidToInstance.get(ppid)!

                if (perInstance[instanceId]) {
                  perInstance[instanceId].cpu += cpu
                  perInstance[instanceId].memory += Math.round(memMB * 10) / 10
                }
                totalCpu += cpu
                totalMem += memMB
              }
            }
          }

          resolve({
            perInstance,
            total: {
              cpu: Math.round(totalCpu * 10) / 10,
              memory: Math.round(totalMem * 10) / 10,
            },
          })
        })
      })
    })
  })
}
