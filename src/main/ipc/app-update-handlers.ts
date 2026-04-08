import { ipcMain } from 'electron'
import {
  getUpdateStatus,
  checkForUpdatesManual,
  downloadUpdate,
  quitAndInstall,
  setAutoUpdateEnabled,
  isAutoUpdateEnabled,
} from '../app-updater'

export function registerAppUpdateHandlers(): void {
  ipcMain.handle('appUpdate:getStatus', () => getUpdateStatus())
  ipcMain.handle('appUpdate:checkNow', () => checkForUpdatesManual())
  ipcMain.handle('appUpdate:download', async () => {
    await downloadUpdate()
    return getUpdateStatus()
  })
  ipcMain.handle('appUpdate:quitAndInstall', () => {
    quitAndInstall()
    return true
  })
  ipcMain.handle('appUpdate:setAutoEnabled', (_e, enabled: boolean) => {
    setAutoUpdateEnabled(!!enabled)
    return true
  })
  ipcMain.handle('appUpdate:getAutoEnabled', () => isAutoUpdateEnabled())
}
