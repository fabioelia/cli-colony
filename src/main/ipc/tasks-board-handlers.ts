import { ipcMain } from 'electron'
import { promises as fsp, watch, type FSWatcher } from 'fs'
import * as path from 'path'
import { colonyPaths } from '../../shared/colony-paths'
import { broadcast } from '../broadcast'
import type { TaskBoardItem, TaskStatus } from '../../shared/types'

const VALID_STATUSES: Set<TaskStatus> = new Set(['todo', 'in_progress', 'done', 'blocked'])

let _watcher: FSWatcher | null = null

export function registerTasksBoardHandlers(): void {
  ipcMain.handle('tasks:board:list', () => readBoard())

  ipcMain.handle('tasks:board:save', async (_e, item: TaskBoardItem) => {
    // Validate required fields
    if (!item.id || typeof item.id !== 'string') {
      throw new Error('Task item must have a non-empty string id')
    }
    if (!VALID_STATUSES.has(item.status)) {
      throw new Error(`Invalid task status: ${item.status}. Must be one of: ${[...VALID_STATUSES].join(', ')}`)
    }

    const items = await readBoard()
    const idx = items.findIndex(t => t.id === item.id)
    if (idx >= 0) {
      items[idx] = { ...items[idx], ...item, updated: new Date().toISOString() }
    } else {
      items.push({ ...item, created: item.created ?? new Date().toISOString(), updated: new Date().toISOString() })
    }
    await writeBoard(items)
  })

  ipcMain.handle('tasks:board:delete', async (_e, id: string) => {
    const items = (await readBoard()).filter(t => t.id !== id)
    await writeBoard(items)
  })

  // Start watching the file for external edits (e.g., agents writing tasks)
  startWatcher()
}

async function readBoard(): Promise<TaskBoardItem[]> {
  try {
    const raw = await fsp.readFile(colonyPaths.taskBoard, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.tasks)) return parsed.tasks
    return []
  } catch {
    return []
  }
}

async function writeBoard(items: TaskBoardItem[]): Promise<void> {
  await fsp.mkdir(path.dirname(colonyPaths.taskBoard), { recursive: true })
  const tmp = colonyPaths.taskBoard + '.tmp'
  await fsp.writeFile(tmp, JSON.stringify(items, null, 2), 'utf-8')
  await fsp.rename(tmp, colonyPaths.taskBoard)
  broadcast('tasks:board:updated', items)
}

export function stopTasksBoardWatcher(): void {
  if (_watcher) {
    _watcher.close()
    _watcher = null
  }
}

function startWatcher(): void {
  if (_watcher) return
  // Watch the directory — file may not exist yet
  const dir = colonyPaths.root
  let debounce: ReturnType<typeof setTimeout> | null = null
  try {
    _watcher = watch(dir, (_event, filename) => {
      if (filename !== 'colony-tasks.json') return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        readBoard().then(items => broadcast('tasks:board:updated', items)).catch(() => {})
      }, 200)
    })
    _watcher.on('error', () => { _watcher = null })
  } catch { /* ignore — non-critical */ }
}
