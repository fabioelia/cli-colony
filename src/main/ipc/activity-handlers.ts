import { ipcMain } from 'electron'
import { listActivity, markRead, getUnreadCount, clearActivity, loadActivityForDate } from '../activity-manager'

export function registerActivityHandlers(): void {
  ipcMain.handle('activity:list', () => listActivity())
  ipcMain.handle('activity:forDate', (_e, date: string) => loadActivityForDate(date))
  ipcMain.handle('activity:markRead', async () => { await markRead(); return true })
  ipcMain.handle('activity:unreadCount', () => getUnreadCount())
  ipcMain.handle('activity:clear', async () => { await clearActivity(); return true })
}
