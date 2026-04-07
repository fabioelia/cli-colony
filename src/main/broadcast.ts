import { BrowserWindow } from 'electron'

type BroadcastListener = (channel: string, ...args: unknown[]) => void
const _listeners: BroadcastListener[] = []

/** Subscribe to all broadcast events (e.g. for SSE relay). Returns an unsubscribe fn. */
export function addBroadcastListener(fn: BroadcastListener): () => void {
  _listeners.push(fn)
  return () => {
    const idx = _listeners.indexOf(fn)
    if (idx !== -1) _listeners.splice(idx, 1)
  }
}

/**
 * Broadcast an IPC message to all open renderer windows.
 */
export function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
  for (const fn of _listeners) {
    fn(channel, ...args)
  }
}
