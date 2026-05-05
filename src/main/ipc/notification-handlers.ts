import { ipcMain } from 'electron'
import { getHistory, markRead, markAllRead, clearHistory, getUnreadCount } from '../notifications'
import { loadChannels, saveChannels, testChannel } from '../notification-channels'
import type { NotificationChannel } from '../../shared/types'

export function registerNotificationHandlers(): void {
  ipcMain.handle('notifications:history', () => getHistory())
  ipcMain.handle('notifications:markRead', (_e, id: string) => markRead(id))
  ipcMain.handle('notifications:markAllRead', () => markAllRead())
  ipcMain.handle('notifications:clearAll', () => clearHistory())
  ipcMain.handle('notifications:unreadCount', () => getUnreadCount())
  ipcMain.handle('notifications:getChannels', () => loadChannels())
  ipcMain.handle('notifications:saveChannels', (_e, channels: NotificationChannel[]) => saveChannels(channels))
  ipcMain.handle('notifications:testChannel', (_e, channel: NotificationChannel) => testChannel(channel))
}
