import { BrowserWindow, globalShortcut } from 'electron'

/** Register (or re-register) the global hotkey that brings the app to front. */
export function registerGlobalHotkey(hotkey: string): { success: boolean; error?: string } {
  try {
    globalShortcut.unregisterAll()
    globalShortcut.register(hotkey, () => {
      const win = BrowserWindow.getAllWindows()[0]
      if (win && !win.isDestroyed()) {
        win.show()
        win.focus()
      }
    })
    console.log(`[app] registered global hotkey: ${hotkey}`)
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(`[app] failed to register global hotkey:`, msg)
    return { success: false, error: msg }
  }
}
