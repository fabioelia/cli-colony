import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'

export function registerTaskQueueHandlers(): void {
  const TASK_WORKSPACE = colonyPaths.taskWorkspace
  const QUEUE_DIR = colonyPaths.taskQueues

  ipcMain.handle('taskQueue:getWorkspacePath', () => {
    if (!fs.existsSync(TASK_WORKSPACE)) fs.mkdirSync(TASK_WORKSPACE, { recursive: true })
    return TASK_WORKSPACE
  })

  ipcMain.handle('taskQueue:createTaskDir', (_e, queueName: string, taskName: string) => {
    const safeName = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 60)
    const dir = join(TASK_WORKSPACE, safeName(queueName), safeName(taskName))
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    return dir
  })

  ipcMain.handle('taskQueue:listRuns', () => {
    if (!fs.existsSync(TASK_WORKSPACE)) fs.mkdirSync(TASK_WORKSPACE, { recursive: true })
    try {
      const queues = fs.readdirSync(TASK_WORKSPACE).filter((d: string) => {
        try { return fs.statSync(join(TASK_WORKSPACE, d)).isDirectory() } catch { return false }
      })
      return queues.map((queueDir: string) => {
        const queuePath = join(TASK_WORKSPACE, queueDir)
        const tasks = fs.readdirSync(queuePath).filter((d: string) => {
          try { return fs.statSync(join(queuePath, d)).isDirectory() } catch { return false }
        })
        return {
          name: queueDir,
          path: queuePath,
          tasks: tasks.map((taskDir: string) => {
            const taskPath = join(queuePath, taskDir)
            const files = fs.readdirSync(taskPath).filter((f: string) => {
              try { return fs.statSync(join(taskPath, f)).isFile() } catch { return false }
            })
            return {
              name: taskDir,
              path: taskPath,
              files: files.map((f: string) => ({
                name: f,
                path: join(taskPath, f),
                size: fs.statSync(join(taskPath, f)).size,
              })),
            }
          }),
        }
      })
    } catch { return [] }
  })

  ipcMain.handle('taskQueue:listOutputRuns', (_e, queueOutputDir: string) => {
    const resolved = queueOutputDir.replace(/^~/, app.getPath('home'))
    if (!fs.existsSync(resolved)) return []
    try {
      const entries = fs.readdirSync(resolved)
      const runs: Array<{ name: string; path: string; files: Array<{ name: string; path: string; size: number }> }> = []
      for (const entry of entries) {
        const full = join(resolved, entry)
        try {
          const stat = fs.statSync(full)
          if (stat.isDirectory()) {
            const files = fs.readdirSync(full)
              .filter((f: string) => { try { return fs.statSync(join(full, f)).isFile() } catch { return false } })
              .map((f: string) => {
                const fp = join(full, f)
                return { name: f, path: fp, size: fs.statSync(fp).size }
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
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true })
    try {
      return fs.readdirSync(QUEUE_DIR)
        .filter((f: string) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.endsWith('.memory.md'))
        .map((f: string) => ({
          name: f,
          path: join(QUEUE_DIR, f),
          content: fs.readFileSync(join(QUEUE_DIR, f), 'utf-8'),
        }))
    } catch { return [] }
  })

  ipcMain.handle('taskQueue:save', (_e, name: string, content: string) => {
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true })
    const filePath = join(QUEUE_DIR, name)
    fs.writeFileSync(filePath, content, 'utf-8')
    return filePath
  })

  ipcMain.handle('taskQueue:delete', (_e, name: string) => {
    const filePath = join(QUEUE_DIR, name)
    if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true }
    return false
  })

  ipcMain.handle('taskQueue:getMemory', (_e, queueName: string) => {
    const memPath = join(QUEUE_DIR, `${queueName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    return fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8') : ''
  })

  ipcMain.handle('taskQueue:saveMemory', (_e, queueName: string, content: string) => {
    if (!fs.existsSync(QUEUE_DIR)) fs.mkdirSync(QUEUE_DIR, { recursive: true })
    const memPath = join(QUEUE_DIR, `${queueName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    fs.writeFileSync(memPath, content, 'utf-8')
    return true
  })
}
