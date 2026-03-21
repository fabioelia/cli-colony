import { ipcMain, dialog, shell } from 'electron'
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
} from './instance-manager'
import { scanAgents } from './agent-scanner'
import { scanSessions } from './session-scanner'
import { getRestorableSessions, clearRestorable, getRecentSessions } from './recent-sessions'
import { getSettings, setSetting } from './settings'
import { getLogs, clearLogs } from './logger'

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

  ipcMain.handle('agents:list', () => scanAgents())
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
  ipcMain.handle('settings:set', (_e, key: string, value: string) => {
    setSetting(key, value)
    return true
  })

  ipcMain.handle('logs:get', () => getLogs())
  ipcMain.handle('logs:clear', () => { clearLogs(); return true })

  ipcMain.handle('shell:openExternal', (_e, url: string) => shell.openExternal(url))

  ipcMain.handle('dialog:openDirectory', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
}
