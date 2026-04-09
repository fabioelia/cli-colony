/**
 * Central notification module for Colony desktop notifications.
 *
 * Wraps Electron's Notification API with:
 * - A per-setting opt-out (notificationsEnabled)
 * - Click handler that focuses the Colony window and optionally broadcasts a route
 */

import { BrowserWindow, Notification } from 'electron'
import { join } from 'path'
import { getSetting } from './settings'
import { broadcast } from './broadcast'

function getIconPath(): string {
  return join(__dirname, '../../resources/icon.png')
}

function getFocusedWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0]
  return win && !win.isDestroyed() ? win : null
}

/**
 * Show a desktop notification.
 *
 * @param title  Short title (shown bold in OS notification center)
 * @param body   Body text
 * @param route  Optional route key broadcast to renderer on click
 *               (e.g. 'pipelines', 'personas', { type: 'session', id: '...' })
 */
export async function notify(
  title: string,
  body: string,
  route?: string | Record<string, unknown>
): Promise<void> {
  if (await getSetting('notificationsEnabled') === 'false') return
  if (!Notification.isSupported()) return

  const notif = new Notification({
    title,
    body,
    silent: true,
    icon: getIconPath(),
  })

  notif.on('click', () => {
    const win = getFocusedWindow()
    if (win) {
      win.show()
      win.focus()
    }
    if (route) {
      broadcast('app:navigate', { route })
    }
  })

  notif.show()
}
