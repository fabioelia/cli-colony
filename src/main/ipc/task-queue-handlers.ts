import { ipcMain, app } from 'electron'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'

export function registerTaskQueueHandlers(): void {
  const TASK_WORKSPACE = colonyPaths.taskWorkspace
  const QUEUE_DIR = colonyPaths.taskQueues

  ipcMain.handle('taskQueue:getWorkspacePath', () => {
    const { existsSync, mkdirSync } = require('fs') as typeof import('fs')
    if (!existsSync(TASK_WORKSPACE)) mkdirSync(TASK_WORKSPACE, { recursive: true })
    return TASK_WORKSPACE
  })

  ipcMain.handle('taskQueue:createTaskDir', (_e, queueName: string, taskName: string) => {
    const { existsSync, mkdirSync } = require('fs') as typeof import('fs')
    const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 60)
    const dir = join(TASK_WORKSPACE, safeName(queueName), safeName(taskName))
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  })

  ipcMain.handle('taskQueue:listRuns', () => {
    const { readdirSync, statSync, existsSync, mkdirSync } = require('fs') as typeof import('fs')
    if (!existsSync(TASK_WORKSPACE)) mkdirSync(TASK_WORKSPACE, { recursive: true })
    try {
      const queues = readdirSync(TASK_WORKSPACE).filter((d: string) => {
        try { return statSync(join(TASK_WORKSPACE, d)).isDirectory() } catch { return false }
      })
      return queues.map((queueDir: string) => {
        const queuePath = join(TASK_WORKSPACE, queueDir)
        const tasks = readdirSync(queuePath).filter((d: string) => {
          try { return statSync(join(queuePath, d)).isDirectory() } catch { return false }
        })
        return {
          name: queueDir,
          path: queuePath,
          tasks: tasks.map((taskDir: string) => {
            const taskPath = join(queuePath, taskDir)
            const files = readdirSync(taskPath).filter((f: string) => {
              try { return statSync(join(taskPath, f)).isFile() } catch { return false }
            })
            return {
              name: taskDir,
              path: taskPath,
              files: files.map((f: string) => ({
                name: f,
                path: join(taskPath, f),
                size: statSync(join(taskPath, f)).size,
              })),
            }
          }),
        }
      })
    } catch { return [] }
  })

  ipcMain.handle('taskQueue:listOutputRuns', (_e, queueOutputDir: string) => {
    const { readdirSync, statSync, existsSync } = require('fs') as typeof import('fs')
    const resolved = queueOutputDir.replace(/^~/, app.getPath('home'))
    if (!existsSync(resolved)) return []
    try {
      const entries = readdirSync(resolved)
      const runs: Array<{ name: string; path: string; files: Array<{ name: string; path: string; size: number }> }> = []
      for (const entry of entries) {
        const full = join(resolved, entry)
        try {
          const stat = statSync(full)
          if (stat.isDirectory()) {
            const files = readdirSync(full)
              .filter((f: string) => { try { return statSync(join(full, f)).isFile() } catch { return false } })
              .map((f: string) => {
                const fp = join(full, f)
                return { name: f, path: fp, size: statSync(fp).size }
              })
            if (files.length > 0) runs.push({ name: entry, path: full, files })
          } else {
            if (!runs.some(r => r.name === '_root')) runs.push({ name: '_root', path: resolved, files: [] })
            const rootRun = runs.find(r => r.name === '_root')!
            rootRun.files.push({ name: entry, path: full, size: stat.size })
          }
        } catch { /* skip */ }
      }
      return runs.sort((a, b) => b.name.localeCompare(a.name))
    } catch { return [] }
  })

  ipcMain.handle('taskQueue:list', () => {
    const { readdirSync, readFileSync, existsSync, mkdirSync } = require('fs') as typeof import('fs')
    if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true })
    try {
      return readdirSync(QUEUE_DIR)
        .filter((f: string) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.endsWith('.memory.md'))
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

  ipcMain.handle('taskQueue:getMemory', (_e, queueName: string) => {
    const { readFileSync, existsSync } = require('fs') as typeof import('fs')
    const memPath = join(QUEUE_DIR, `${queueName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    return existsSync(memPath) ? readFileSync(memPath, 'utf-8') : ''
  })

  ipcMain.handle('taskQueue:saveMemory', (_e, queueName: string, content: string) => {
    const { writeFileSync, existsSync, mkdirSync } = require('fs') as typeof import('fs')
    if (!existsSync(QUEUE_DIR)) mkdirSync(QUEUE_DIR, { recursive: true })
    const memPath = join(QUEUE_DIR, `${queueName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    writeFileSync(memPath, content, 'utf-8')
    return true
  })
}
