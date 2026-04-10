import { ipcMain } from 'electron'
import { getHistory, markRead, markAllRead, clearHistory, getUnreadCount } from '../notifications'

export function registerNotificationHandlers(): void {
  ipcMain.handle('notifications:history', () => getHistory())
  ipcMain.handle('notifications:markRead', (_e, id: string) => markRead(id))
  ipcMain.handle('notifications:markAllRead', () => markAllRead())
  ipcMain.handle('notifications:clearAll', () => clearHistory())
  ipcMain.handle('notifications:unreadCount', () => getUnreadCount())
}
