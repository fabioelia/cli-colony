/**
 * Task Queue Manager — filesystem operations for task queues and runs.
 * Extracted from IPC handlers to keep handler files thin.
 */

import * as fs from 'fs'
import { basename, join } from 'path'
import { app } from 'electron'
import { colonyPaths } from '../shared/colony-paths'
import { slugify } from '../shared/utils'

const TASK_WORKSPACE = colonyPaths.taskWorkspace
const QUEUE_DIR = colonyPaths.taskQueues

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

export function getWorkspacePath(): string {
  ensureDir(TASK_WORKSPACE)
  return TASK_WORKSPACE
}

export function createTaskDir(queueName: string, taskName: string): string {
  const dir = join(TASK_WORKSPACE, slugify(queueName), slugify(taskName))
  ensureDir(dir)
  return dir
}

export interface TaskFile {
  name: string
  path: string
  size: number
}

export interface TaskRun {
  name: string
  path: string
  files: TaskFile[]
}

export interface QueueRun {
  name: string
  path: string
  tasks: TaskRun[]
}

export function listRuns(): QueueRun[] {
  ensureDir(TASK_WORKSPACE)
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
}

export function listOutputRuns(queueOutputDir: string): TaskRun[] {
  const resolved = queueOutputDir.replace(/^~/, app.getPath('home'))
  if (!fs.existsSync(resolved)) return []
  try {
    const entries = fs.readdirSync(resolved)
    const runs: TaskRun[] = []
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
}

export interface QueueDef {
  name: string
  path: string
  content: string
}

export function listQueues(): QueueDef[] {
  ensureDir(QUEUE_DIR)
  try {
    return fs.readdirSync(QUEUE_DIR)
      .filter((f: string) => (f.endsWith('.yaml') || f.endsWith('.yml')) && !f.endsWith('.memory.md'))
      .map((f: string) => ({
        name: f,
        path: join(QUEUE_DIR, f),
        content: fs.readFileSync(join(QUEUE_DIR, f), 'utf-8'),
      }))
  } catch { return [] }
}

export function saveQueue(name: string, content: string): string {
  ensureDir(QUEUE_DIR)
  const filePath = join(QUEUE_DIR, basename(name))
  fs.writeFileSync(filePath, content, 'utf-8')
  return filePath
}

export function deleteQueue(name: string): boolean {
  const filePath = join(QUEUE_DIR, basename(name))
  if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); return true }
  return false
}

export function getQueueMemory(queueName: string): string {
  const memPath = join(QUEUE_DIR, `${queueName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
  return fs.existsSync(memPath) ? fs.readFileSync(memPath, 'utf-8') : ''
}

export function saveQueueMemory(queueName: string, content: string): boolean {
  ensureDir(QUEUE_DIR)
  const memPath = join(QUEUE_DIR, `${queueName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
  fs.writeFileSync(memPath, content, 'utf-8')
  return true
}
