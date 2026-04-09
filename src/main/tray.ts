import { Tray, Menu, BrowserWindow, nativeImage, app, screen } from 'electron'
import { join } from 'path'
import { getAllInstances, ClaudeInstance } from './instance-manager'

let tray: Tray | null = null

export function createTray(mainWindow: BrowserWindow | null): void {
  // Use -Template naming so macOS auto-handles light/dark mode
  // nativeImage automatically picks up @2x for Retina
  const trayIconPath = join(__dirname, '../../resources/tray-iconTemplate.png')
  const icon = nativeImage.createFromPath(trayIconPath)
  icon.setTemplateImage(true)

  tray = new Tray(icon)
  tray.setToolTip('Claude Colony')

  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })

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
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
        mainWindow.webContents.send('instance:focus', { id: inst.id })
      }
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
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
          // Center on current display
          const bounds = mainWindow.getBounds()
          const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
          const { width: dw, height: dh, x: dx, y: dy } = display.workArea
          mainWindow.setPosition(
            Math.round(dx + (dw - bounds.width) / 2),
            Math.round(dy + (dh - bounds.height) / 2),
          )
          if (process.platform === 'darwin') app.dock?.show()
        }
      },
    },
    {
      label: 'New Instance',
      click: () => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.show()
          mainWindow.focus()
          mainWindow.webContents.send('shortcut:new-instance')
        }
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
