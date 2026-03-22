import { Tray, Menu, BrowserWindow, nativeImage, app } from 'electron'
import { join } from 'path'
import { getAllInstances, ClaudeInstance } from './instance-manager'

let tray: Tray | null = null

export function createTray(mainWindow: BrowserWindow | null): void {
  const iconPath = join(__dirname, '../../resources/icon.png')
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 22, height: 22 })
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

  const instanceItems: Electron.MenuItemConstructorOptions[] = running.map((inst) => ({
    label: `${inst.name} — ${inst.workingDirectory.split('/').pop()}`,
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
      label: 'Quit',
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
