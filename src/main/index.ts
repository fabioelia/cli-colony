import { app, BrowserWindow, shell, globalShortcut, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc-handlers'
import { initDaemon, disconnectDaemon, setOnInstanceListChanged } from './instance-manager'
import { initEnvDaemon } from './env-manager'
import { createTray, updateTrayMenu } from './tray'
import { initLogger } from './logger'
import { getSetting } from './settings'
import { updateColonyContext } from './colony-context'

const COLONY_CLI_SCRIPT = `#!/bin/bash
# colony — control Colony environments from the command line.
# Usage: colony {start|stop|status} [env-id]
SOCKET="\${HOME}/.claude-colony/envd.sock"
send() { echo "$1" | nc -U "$SOCKET" -w 5 2>/dev/null | head -1; }
case "\${1:-}" in
  start)
    [ -z "$2" ] && echo "Usage: colony start <env-id>" && exit 1
    resp=$(send '{"type":"start","reqId":"cli-'$$'","envId":"'"$2"'"}')
    echo "$resp" | python3 -c "import json,sys; r=json.load(sys.stdin); print('Started' if r.get('type')=='ok' else f'Error: {r.get(\\\"message\\\",\\\"unknown\\\")}')" 2>/dev/null || echo "$resp"
    ;;
  stop)
    [ -z "$2" ] && echo "Usage: colony stop <env-id>" && exit 1
    resp=$(send '{"type":"stop","reqId":"cli-'$$'","envId":"'"$2"'"}')
    echo "$resp" | python3 -c "import json,sys; r=json.load(sys.stdin); print('Stopped' if r.get('type')=='ok' else f'Error: {r.get(\\\"message\\\",\\\"unknown\\\")}')" 2>/dev/null || echo "$resp"
    ;;
  status)
    if [ -n "$2" ]; then
      resp=$(send '{"type":"status-one","reqId":"cli-'$$'","envId":"'"$2"'"}')
    else
      resp=$(send '{"type":"status","reqId":"cli-'$$'"}')
    fi
    echo "$resp" | python3 -c "
import json, sys
r = json.load(sys.stdin)
if r.get('type') == 'error': print(f'Error: {r.get(\\\"message\\\")}'); sys.exit(1)
data = r.get('data')
if not data: print('No environments'); sys.exit(0)
envs = data if isinstance(data, list) else [data]
for e in envs:
    svcs = ', '.join(f'{s[\\\"name\\\"]}={s[\\\"status\\\"]}' for s in e.get('services', []))
    print(f'{e[\\\"name\\\"]} [{e[\\\"status\\\"]}] id={e[\\\"id\\\"]} — {svcs}')
" 2>/dev/null || echo "$resp"
    ;;
  *) echo "Usage: colony {start|stop|status} [env-id]"; exit 1 ;;
esac
`
import { seedDefaultPipelines, startPipelines } from './pipeline-engine'

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
    // Helps first paint / ready-to-show on macOS vibrancy windows; matches renderer theme
    backgroundColor: '#1a1a2e',
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

  const fallbackShowTimer = setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      console.warn(
        '[app] Main window was still hidden after timeout; calling show(). ' +
          'If the window is blank, confirm you started via `yarn dev` (Vite) or ran `yarn build`, and check the terminal for errors.'
      )
      mainWindow.show()
    }
  }, 5000)

  mainWindow.on('ready-to-show', () => {
    clearTimeout(fallbackShowTimer)
    mainWindow?.show()
  })

  mainWindow.on('closed', () => {
    clearTimeout(fallbackShowTimer)
  })

  mainWindow.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return
      console.error('[app] Renderer did-fail-load:', { errorCode, errorDescription, validatedURL })
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show()
      }
    }
  )

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('[app] render-process-gone:', details)
  })

  // Prevent Electron from handling Cmd+- / Cmd+= / Cmd+0 as native zoom
  // so our custom font size zoom works instead
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.meta || input.control) && (input.key === '-' || input.key === '=' || input.key === '+' || input.key === '0')) {
      // Let it through to the renderer — don't let Electron's default zoom handle it
      // We need to explicitly send to renderer since Electron eats these
      if (input.key === '-') {
        event.preventDefault()
        sendToRenderer('shortcut:zoom-out')
      }
    }
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
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+K',
          click: () => sendToRenderer('shortcut:command-palette'),
        },
        {
          label: 'Find in Terminal',
          accelerator: 'CmdOrCtrl+F',
          click: () => sendToRenderer('shortcut:search'),
        },
        { type: 'separator' },
        {
          label: 'Next Instance',
          accelerator: 'Alt+Tab',
          click: () => sendToRenderer('shortcut:cycle-instance', 1),
        },
        {
          label: 'Previous Instance',
          accelerator: 'Alt+Shift+Tab',
          click: () => sendToRenderer('shortcut:cycle-instance', -1),
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
          label: 'Zoom In (Plus)',
          accelerator: 'CmdOrCtrl+Plus',
          visible: false,
          click: () => sendToRenderer('shortcut:zoom-in'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => sendToRenderer('shortcut:zoom-out'),
        },
        {
          label: 'Zoom Out (Underscore)',
          accelerator: 'CmdOrCtrl+_',
          visible: false,
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

  registerIpcHandlers()
  buildAppMenu()
  createWindow()
  createTray(mainWindow)

  // Update tray when instance list changes — set before daemon connect so no events are missed
  setOnInstanceListChanged(() => updateTrayMenu(mainWindow))

  // Seed default pipelines before daemon connects
  seedDefaultPipelines()

  // Connect to PTY daemon (spawns it if not running)
  initDaemon().then(async () => {
    console.log('[app] daemon connected')
    updateTrayMenu(mainWindow)
    // Generate initial colony context
    await updateColonyContext()
    console.log('[app] colony context initialized')
    // Install colony CLI script
    try {
      const { mkdirSync, writeFileSync, chmodSync } = require('fs') as typeof import('fs')
      const { join: pathJoin } = require('path') as typeof import('path')
      const binDir = pathJoin(app.getPath('home'), '.claude-colony', 'bin')
      mkdirSync(binDir, { recursive: true })
      const cliDst = pathJoin(binDir, 'colony')
      writeFileSync(cliDst, COLONY_CLI_SCRIPT, 'utf-8')
      chmodSync(cliDst, 0o755)
    } catch { /* ignore */ }
    // Ensure all repos have shallow clones for template agent
    try {
      const { ensureRepoClones } = require('./github')
      ensureRepoClones()
    } catch { /* ignore */ }
    // Start pipeline polling
    startPipelines().then(() => {
      console.log('[app] pipelines started')
    }).catch((err) => {
      console.error('[app] pipelines failed to start:', err)
    })
  }).catch((err) => {
    console.error('[app] daemon init failed:', err)
  })

  // Connect to environment daemon (spawns it if not running)
  initEnvDaemon().then(() => {
    console.log('[app] envd connected')
  }).catch((err) => {
    console.error('[app] envd init failed:', err)
  })

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
