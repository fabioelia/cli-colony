import { app, BrowserWindow, shell, globalShortcut, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc-handlers'
import { initDaemon, disconnectDaemon, setOnInstanceListChanged } from './instance-manager'
import { createTray, updateTrayMenu } from './tray'
import { initLogger } from './logger'
import { getSetting } from './settings'

let mainWindow: BrowserWindow | null = null

function sendToRenderer(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, ...args)
  }
}

function getIconPath(): string {
  return join(__dirname, '../../resources/icon.png')
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    height: 800,
    minHeight: 600,
    minWidth: 900,
    show: false,
    title: 'Claude Colony',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'sidebar',
    width: 1200,
    icon: getIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  mainWindow.on('close', (event) => {
    if (process.platform === 'darwin' && !app.isQuitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function buildAppMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Instances',
      submenu: [
        {
          label: 'New Instance',
          accelerator: 'CmdOrCtrl+T',
          click: () => sendToRenderer('shortcut:new-instance'),
        },
        {
          label: 'Close Instance',
          accelerator: 'CmdOrCtrl+W',
          click: () => sendToRenderer('shortcut:close-instance'),
        },
        {
          label: 'Close Split',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => sendToRenderer('shortcut:close-split'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Split View',
          accelerator: 'CmdOrCtrl+\\',
          click: () => sendToRenderer('shortcut:toggle-split'),
        },
        {
          label: 'Focus Left Pane',
          accelerator: 'CmdOrCtrl+Alt+Left',
          click: () => sendToRenderer('shortcut:focus-pane', 'left'),
        },
        {
          label: 'Focus Right Pane',
          accelerator: 'CmdOrCtrl+Alt+Right',
          click: () => sendToRenderer('shortcut:focus-pane', 'right'),
        },
        { type: 'separator' },
        {
          label: 'Find in Terminal',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendToRenderer('shortcut:search'),
        },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Switch to Instance ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => sendToRenderer('shortcut:switch-instance', i),
        })),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const },
        { role: 'forceReload' as const },
        { role: 'toggleDevTools' as const },
        { type: 'separator' as const },
        {
          label: 'Zoom In',
          accelerator: 'CmdOrCtrl+=',
          click: () => sendToRenderer('shortcut:zoom-in'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => sendToRenderer('shortcut:zoom-out'),
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => sendToRenderer('shortcut:zoom-reset'),
        },
        { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        { type: 'separator' as const },
        { role: 'front' as const },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.claude-colony.app')
  app.setName('Claude Colony')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initLogger()
  console.log('[app] Claude Colony starting up')

  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    app.dock.setIcon(getIconPath())
  }

  // Connect to PTY daemon (spawns it if not running)
  initDaemon().then(() => {
    console.log('[app] daemon connected')
  }).catch((err) => {
    console.error('[app] daemon init failed:', err)
  })

  registerIpcHandlers()
  buildAppMenu()
  createWindow()
  createTray(mainWindow)

  // Update tray when instance list changes
  setOnInstanceListChanged(() => updateTrayMenu(mainWindow))

  // Register global hotkey to bring app to front
  const hotkey = getSetting('globalHotkey') || 'CommandOrControl+Shift+Space'
  try {
    globalShortcut.register(hotkey, () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
        mainWindow.focus()
      }
    })
    console.log(`[app] registered global hotkey: ${hotkey}`)
  } catch (err) {
    console.error(`[app] failed to register global hotkey:`, err)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    } else {
      mainWindow?.show()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // Disconnect from daemon but don't kill it — instances survive
    disconnectDaemon()
    app.quit()
  }
})

app.on('before-quit', () => {
  app.isQuitting = true
  // Just disconnect — daemon keeps instances alive for reconnection
  disconnectDaemon()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})

declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean
    }
  }
}
