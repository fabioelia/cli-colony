import { ipcMain } from 'electron'
import { listActivity, markRead, getUnreadCount } from '../activity-manager'

export function registerActivityHandlers(): void {
  ipcMain.handle('activity:list', () => listActivity())
  ipcMain.handle('activity:markRead', async () => { await markRead(); return true })
  ipcMain.handle('activity:unreadCount', () => getUnreadCount())
}
