import { ipcMain } from 'electron'
import * as fs from 'fs'
import { colonyPaths } from '../../shared/colony-paths'
import { broadcast } from '../broadcast'
import type { TaskBoardItem } from '../../shared/types'

let _watcher: fs.FSWatcher | null = null

export function registerTasksBoardHandlers(): void {
  ipcMain.handle('tasks:board:list', (): TaskBoardItem[] => {
    return readBoard()
  })

  ipcMain.handle('tasks:board:save', (_e, item: TaskBoardItem): void => {
    const items = readBoard()
    const idx = items.findIndex(t => t.id === item.id)
    if (idx >= 0) {
      items[idx] = { ...items[idx], ...item, updated: new Date().toISOString() }
    } else {
      items.push({ ...item, created: item.created ?? new Date().toISOString(), updated: new Date().toISOString() })
    }
    writeBoard(items)
  })

  ipcMain.handle('tasks:board:delete', (_e, id: string): void => {
    const items = readBoard().filter(t => t.id !== id)
    writeBoard(items)
  })

  // Start watching the file for external edits (e.g., agents writing tasks)
  startWatcher()
}

function readBoard(): TaskBoardItem[] {
  try {
    if (!fs.existsSync(colonyPaths.taskBoard)) return []
    const raw = fs.readFileSync(colonyPaths.taskBoard, 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed
    if (Array.isArray(parsed?.tasks)) return parsed.tasks
    return []
  } catch {
    return []
  }
}

function writeBoard(items: TaskBoardItem[]): void {
  const tmp = colonyPaths.taskBoard + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2), 'utf-8')
  fs.renameSync(tmp, colonyPaths.taskBoard)
  broadcast('tasks:board:updated', items)
}

function startWatcher(): void {
  if (_watcher) return
  // Watch the directory — file may not exist yet
  const dir = colonyPaths.root
  let debounce: ReturnType<typeof setTimeout> | null = null
  try {
    _watcher = fs.watch(dir, (_event, filename) => {
      if (filename !== 'colony-tasks.json') return
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(() => {
        broadcast('tasks:board:updated', readBoard())
      }, 200)
    })
    _watcher.on('error', () => { _watcher = null })
  } catch { /* ignore — non-critical */ }
}
