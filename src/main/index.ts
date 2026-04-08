import { app, BrowserWindow, shell, globalShortcut, Menu, nativeImage } from 'electron'

// Prevent non-fatal pipe/socket errors (EIO, EPIPE) from crashing the app.
// These occur when child processes exit before their stdio pipes are fully drained.
process.on('uncaughtException', (err) => {
  if (err && typeof err === 'object' && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EIO' || code === 'EPIPE' || code === 'ERR_IPC_CHANNEL_CLOSED') {
      console.warn(`[main] suppressed non-fatal error: ${code} — ${err.message}`)
      return
    }
  }
  // Re-throw everything else so the crash dialog still works
  throw err
})
import * as fs from 'fs'
import { join } from 'path'

// Enable Chrome DevTools Protocol on a fixed port for Playwright recording
if (process.env.COLONY_CDP_PORT) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.COLONY_CDP_PORT)
}

import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { registerIpcHandlers } from './ipc-handlers'
import { initDaemon, disconnectDaemon, setOnInstanceListChanged, setOnSessionExit, getAllInstances } from './instance-manager'
import { initEnvDaemon, refreshRepoConfigs } from './env-manager'
import { createTray, updateTrayMenu } from './tray'
import { initLogger } from './logger'
import { getSetting } from './settings'
import { updateColonyContext } from './colony-context'
import { killAllShells } from './shell-pty'
import { snapshotRunning } from './recent-sessions'
import { ensureRepoClones } from './github'
import { loadPersonas, startWatcher as startPersonaWatcher, startScheduler as startPersonaScheduler, onSessionExit as onPersonaSessionExit, runPersona, getPersonaList, addWhisper } from './persona-manager'
import { initTriggerWatcher } from './persona-triggers'
import { recordWorkerExit } from './team-metrics'

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
import { broadcast } from './broadcast'
import { seedDefaultPipelines, startPipelines, getPipelineList } from './pipeline-engine'
import { cleanupStaleForkGroups } from './fork-manager'
import { startWebhookServer, stopWebhookServer } from './webhook-server'
import { colonyPaths } from '../shared/colony-paths'

let mainWindow: BrowserWindow | null = null

// ---- Window state persistence ----

interface WindowState {
  x?: number
  y?: number
  width?: number
  height?: number
  isMaximized?: boolean
  isFullScreen?: boolean
}

function getWindowStatePath(): string {
  return join(colonyPaths.root, 'window-state.json')
}

function loadWindowState(): WindowState {
  try {
    const path = getWindowStatePath()
    if (fs.existsSync(path)) {
      const data = JSON.parse(fs.readFileSync(path, 'utf-8'))
      // Validate bounds are within reasonable screen range
      if (data.width && data.height && data.width > 400 && data.height > 300) {
        return data
      }
    }
  } catch (err) {
    console.warn('[app] Failed to load window state:', err)
  }
  return {}
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const bounds = mainWindow.getBounds()
    const state: WindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      isMaximized: mainWindow.isMaximized(),
      isFullScreen: mainWindow.isFullScreen(),
    }
    fs.writeFileSync(getWindowStatePath(), JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.warn('[app] Failed to save window state:', err)
  }
}

function getIconPath(): string {
  return join(__dirname, '../../resources/icon.png')
}

function createWindow(): void {
  const savedState = loadWindowState()

  // Use saved bounds if available, otherwise use defaults
  const bounds: any = {
    height: savedState.height || 800,
    width: savedState.width || 1200,
  }
  if (savedState.x !== undefined && savedState.y !== undefined) {
    bounds.x = savedState.x
    bounds.y = savedState.y
  }

  mainWindow = new BrowserWindow({
    ...bounds,
    minHeight: 600,
    minWidth: 900,
    show: false,
    // Helps first paint / ready-to-show on macOS vibrancy windows; matches renderer theme
    backgroundColor: '#1a1a2e',
    title: 'Claude Colony',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    vibrancy: 'sidebar',
    icon: getIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
    },
  })

  // Save window state on move, resize, maximize, and fullscreen changes
  const stateChangeHandler = () => saveWindowState()
  mainWindow.on('move', stateChangeHandler)
  mainWindow.on('resize', stateChangeHandler)
  mainWindow.on('maximize', stateChangeHandler)
  mainWindow.on('unmaximize', stateChangeHandler)
  mainWindow.on('enter-full-screen', stateChangeHandler)
  mainWindow.on('leave-full-screen', stateChangeHandler)

  mainWindow.on('close', (event) => {
    saveWindowState()
    if (process.platform === 'darwin' && !app.isQuitting) {
      const keepInTray = getSetting('keepInTray') !== 'false'
      if (keepInTray) {
        event.preventDefault()
        mainWindow?.hide()
      }
    }
  })

  mainWindow.on('hide', () => {
    if (process.platform === 'darwin') {
      app.dock?.hide()
    }
  })

  mainWindow.on('show', () => {
    if (process.platform === 'darwin') {
      app.dock?.show()
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
    // Restore fullscreen state after window is shown
    // Do this in setImmediate to ensure the window is fully visible first
    if (savedState.isFullScreen) {
      setImmediate(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.setFullScreen(true)
        }
      })
    } else if (savedState.isMaximized) {
      // Restore maximized state if not fullscreen
      setImmediate(() => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.maximize()
        }
      })
    }
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
        broadcast('shortcut:zoom-out')
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
          click: () => broadcast('shortcut:new-instance'),
        },
        {
          label: 'Close Instance',
          accelerator: 'CmdOrCtrl+W',
          click: () => broadcast('shortcut:close-instance'),
        },
        {
          label: 'Close Split',
          accelerator: 'CmdOrCtrl+Shift+W',
          click: () => broadcast('shortcut:close-split'),
        },
        { type: 'separator' },
        {
          label: 'Toggle Split View',
          accelerator: 'CmdOrCtrl+\\',
          click: () => broadcast('shortcut:toggle-split'),
        },
        {
          label: 'Focus Left Pane',
          accelerator: 'CmdOrCtrl+Alt+Left',
          click: () => broadcast('shortcut:focus-pane', 'left'),
        },
        {
          label: 'Focus Right Pane',
          accelerator: 'CmdOrCtrl+Alt+Right',
          click: () => broadcast('shortcut:focus-pane', 'right'),
        },
        { type: 'separator' },
        {
          label: 'Command Palette',
          accelerator: 'CmdOrCtrl+K',
          click: () => broadcast('shortcut:command-palette'),
        },
        {
          label: 'Quick Prompt',
          accelerator: 'CmdOrCtrl+Shift+Return',
          click: () => broadcast('shortcut:quick-prompt'),
        },
        {
          label: 'Find in Terminal',
          accelerator: 'CmdOrCtrl+F',
          click: () => broadcast('shortcut:search'),
        },
        { type: 'separator' },
        {
          label: 'Next Instance',
          accelerator: 'Alt+Tab',
          click: () => broadcast('shortcut:cycle-instance', 1),
        },
        {
          label: 'Previous Instance',
          accelerator: 'Alt+Shift+Tab',
          click: () => broadcast('shortcut:cycle-instance', -1),
        },
        { type: 'separator' },
        ...Array.from({ length: 9 }, (_, i) => ({
          label: `Switch to Instance ${i + 1}`,
          accelerator: `CmdOrCtrl+${i + 1}`,
          click: () => broadcast('shortcut:switch-instance', i),
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
          click: () => broadcast('shortcut:zoom-in'),
        },
        {
          label: 'Zoom In (Plus)',
          accelerator: 'CmdOrCtrl+Plus',
          visible: false,
          click: () => broadcast('shortcut:zoom-in'),
        },
        {
          label: 'Zoom Out',
          accelerator: 'CmdOrCtrl+-',
          click: () => broadcast('shortcut:zoom-out'),
        },
        {
          label: 'Zoom Out (Underscore)',
          accelerator: 'CmdOrCtrl+_',
          visible: false,
          click: () => broadcast('shortcut:zoom-out'),
        },
        {
          label: 'Reset Zoom',
          accelerator: 'CmdOrCtrl+0',
          click: () => broadcast('shortcut:zoom-reset'),
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

  // Clean up fork groups from previous run
  try { cleanupStaleForkGroups() } catch { /* ignore */ }

  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    app.dock.setIcon(getIconPath())
  }

  registerIpcHandlers()
  buildAppMenu()
  createWindow()
  createTray(mainWindow)

  // Wire callbacks before daemon connect so no events are missed
  setOnInstanceListChanged(() => updateTrayMenu(mainWindow))
  setOnSessionExit((instanceId) => {
    onPersonaSessionExit(instanceId)
    // Record worker metrics if this is a Worker session
    getAllInstances().then(instances => {
      const inst = instances.find(i => i.id === instanceId)
      if (inst && inst.roleTag === 'Worker') {
        recordWorkerExit(
          inst.name,
          instanceId,
          inst.exitCode,
          Math.round((Date.now() - new Date(inst.createdAt).getTime()) / 1000) * 1000,
          inst.tokenUsage?.cost ?? 0,
        )
      }
    }).catch(() => {})
  })

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
      const binDir = join(app.getPath('home'), '.claude-colony', 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      const cliDst = join(binDir, 'colony')
      fs.writeFileSync(cliDst, COLONY_CLI_SCRIPT, 'utf-8')
      fs.chmodSync(cliDst, 0o755)
    } catch { /* ignore */ }
    // Ensure all repos have bare clones, then pre-warm .colony/ config cache
    try {
      ensureRepoClones()
    } catch { /* ignore */ }
    refreshRepoConfigs().catch(() => { /* ignore */ })
    // Start pipeline polling
    startPipelines().then(() => {
      console.log('[app] pipelines started')
      // Broadcast the loaded list so any renderer that subscribed before startup completes gets it
      broadcast('pipeline:status', getPipelineList())
      // Start webhook server if enabled
      const webhookPort = parseInt(getSetting('webhookPort') || '7474', 10)
      if (getSetting('webhookEnabled') !== 'false') {
        startWebhookServer(webhookPort)
      }
    }).catch((err) => {
      console.error('[app] pipelines failed to start:', err)
    })
    // Load personas and start file watcher
    try {
      loadPersonas()
      startPersonaWatcher()
      startPersonaScheduler()
      initTriggerWatcher(runPersona, getPersonaList, addWhisper)
    } catch { /* ignore */ }
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
  // Snapshot running sessions BEFORE disconnect so we know what to restore
  snapshotRunning()
  // Stop webhook HTTP server
  stopWebhookServer()
  // Just disconnect — daemon keeps instances alive for reconnection
  disconnectDaemon()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  killAllShells()
})

declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean
    }
  }
}
