import { Tray, Menu, BrowserWindow, nativeImage, app, screen } from 'electron'
import { join } from 'path'
import { getAllInstances, ClaudeInstance } from './instance-manager'

let tray: Tray | null = null

/**
 * Force the window out of any fullscreen mode. Native macOS fullscreen +
 * vibrancy + hiddenInset can render an invisible window on a separate Space.
 */
function forceExitFullscreen(mainWindow: BrowserWindow): void {
  try { if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false) } catch { /* */ }
  if (process.platform === 'darwin') {
    try { if (mainWindow.isSimpleFullScreen()) mainWindow.setSimpleFullScreen(false) } catch { /* */ }
  }
}

/**
 * Reliably bring the main window to the user's current Space and foreground.
 * Plain show()/focus() doesn't cross macOS Spaces or wake a minimized window.
 */
function bringToFront(mainWindow: BrowserWindow | null): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  forceExitFullscreen(mainWindow)
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  if (process.platform === 'darwin') {
    // Pull the window to whatever Space the user is currently on
    mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    mainWindow.setVisibleOnAllWorkspaces(false, { visibleOnFullScreen: true })
    app.dock?.show()
    app.focus({ steal: true })
  }
  mainWindow.moveTop()
  mainWindow.focus()
}

export function createTray(mainWindow: BrowserWindow | null): void {
  const trayIconPath =
    process.platform === 'win32'
      ? join(__dirname, '../../resources/icon.ico')
      : join(__dirname, '../../resources/tray-iconTemplate.png')
  const icon = nativeImage.createFromPath(trayIconPath)
  if (process.platform === 'darwin') icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Claude Colony')

  tray.on('click', () => bringToFront(mainWindow))

  updateTrayMenu(mainWindow)
}

export async function updateTrayMenu(mainWindow: BrowserWindow | null): Promise<void> {
  if (!tray) {
    console.log('[tray] updateTrayMenu called but tray is null')
    return
  }

  const instances = await getAllInstances()
  const running = instances.filter((i) => i.status === 'running')
  console.log(`[tray] updating menu: ${instances.length} total, ${running.length} running`)

  const cliLabel = (b: string | undefined) => (b === 'cursor-agent' ? 'Cursor' : 'Claude')

  const instanceItems: Electron.MenuItemConstructorOptions[] = running.map((inst) => ({
    label: `${inst.name} (${cliLabel(inst.cliBackend)}) — ${inst.workingDirectory.split('/').pop()}`,
    click: () => {
      bringToFront(mainWindow)
      mainWindow?.webContents.send('instance:focus', { id: inst.id })
    },
  }))

  const template: Electron.MenuItemConstructorOptions[] = [
    ...(running.length > 0
      ? [
          { label: `${running.length} running`, enabled: false },
          { type: 'separator' as const },
          ...instanceItems,
          { type: 'separator' as const },
        ]
      : [{ label: 'No instances running', enabled: false }, { type: 'separator' as const }]),
    {
      label: 'Show Colony',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        // If the window is off-screen (e.g. disconnected monitor), recenter first
        const bounds = mainWindow.getBounds()
        const cursor = screen.getCursorScreenPoint()
        const display = screen.getDisplayNearestPoint(cursor)
        const { x: dx, y: dy, width: dw, height: dh } = display.workArea
        const offScreen =
          bounds.x + bounds.width < dx || bounds.x > dx + dw ||
          bounds.y + bounds.height < dy || bounds.y > dy + dh
        if (offScreen) {
          mainWindow.setPosition(
            Math.round(dx + (dw - bounds.width) / 2),
            Math.round(dy + (dh - bounds.height) / 2),
          )
        }
        bringToFront(mainWindow)
      },
    },
    {
      label: 'Exit Fullscreen',
      click: () => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        forceExitFullscreen(mainWindow)
        bringToFront(mainWindow)
      },
    },
    {
      label: 'New Instance',
      click: () => {
        bringToFront(mainWindow)
        mainWindow?.webContents.send('shortcut:new-instance')
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Colony',
      click: () => {
        app.isQuitting = true
        app.quit()
      },
    },
  ]

  const menu = Menu.buildFromTemplate(template)
  tray.setContextMenu(menu)

  // Show running count on macOS tray title
  if (process.platform === 'darwin') {
    tray.setTitle(running.length > 0 ? `${running.length}` : '')
  }
}
