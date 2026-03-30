import { BrowserWindow } from 'electron'

/**
 * Broadcast an IPC message to all open renderer windows.
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}
