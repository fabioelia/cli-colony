import { app, BrowserWindow, shell, globalShortcut, Menu, nativeImage, screen } from 'electron'

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
import { initRecipes } from './recipe-manager'
import { initTagRulesWatcher } from './tag-rules'
import { initDaemon, disconnectDaemon, setOnInstanceListChanged, setOnSessionExit, getAllInstances } from './instance-manager'
import { initEnvDaemon, refreshRepoConfigs, stopWatching as stopEnvWatching } from './env-manager'
import { createTray, updateTrayMenu } from './tray'
import { initLogger } from './logger'
import { getSetting, getSettingSync, getSettings } from './settings'
import { updateColonyContext } from './colony-context'
import { killAllShells } from './shell-pty'
import { snapshotRunningSync } from './recent-sessions'
import { ensureRepoClones } from './github'
import { loadPersonas, startWatcher as startPersonaWatcher, stopWatcher as stopPersonaWatcher, onSessionExit as onPersonaSessionExit, runPersona, getPersonaList, addWhisper, runStartupPersonas } from './persona-manager'
import { startScheduler as startPersonaScheduler, stopScheduler as stopPersonaScheduler } from './persona-scheduler'
import { startProbe as startRateLimitProbe, stopProbe as stopRateLimitProbe } from './rate-limit-probe'
import { initTriggerWatcher } from './persona-triggers'
import { recordWorkerExit } from './team-metrics'
import { stopTasksBoardWatcher } from './ipc/tasks-board-handlers'
import { collectSessionArtifact } from './session-artifacts'
import { mergeGhSkills } from './mcp-catalog'

// Cross-platform Node.js CLI for controlling Colony environments.
// Written to ~/.claude-colony/bin/colony-cli.js at app startup.
// A thin sh/cmd wrapper in the same bin/ directory delegates to it.
const COLONY_CLI_NODE = `#!/usr/bin/env node
'use strict'
const net = require('net')
const os = require('os')
const path = require('path')

const ROOT = path.join(os.homedir(), '.claude-colony')
const SOCKET = process.platform === 'win32'
  ? '\\\\\\\\.\\\\pipe\\\\claude-colony-envd'
  : path.join(ROOT, 'envd.sock')

function send(msg) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { client.destroy(); reject(new Error('timeout')) }, 5000)
    const client = net.createConnection(SOCKET, () => { client.write(msg + '\\n') })
    let buf = ''
    client.on('data', chunk => {
      buf += chunk
      const line = buf.split('\\n')[0]
      if (line) { clearTimeout(timeout); client.destroy(); resolve(line) }
    })
    client.on('error', err => { clearTimeout(timeout); reject(err) })
  })
}

function parseResponse(resp) {
  try { return JSON.parse(resp) } catch { return null }
}

async function main() {
  const [,, cmd, envId] = process.argv
  try {
    switch (cmd) {
      case 'start': {
        if (!envId) { console.error('Usage: colony start <env-id>'); process.exit(1) }
        const r = parseResponse(await send(JSON.stringify({ type: 'start', reqId: 'cli-' + process.pid, envId })))
        console.log(r && r.type === 'ok' ? 'Started' : 'Error: ' + (r && r.message || 'unknown'))
        break
      }
      case 'stop': {
        if (!envId) { console.error('Usage: colony stop <env-id>'); process.exit(1) }
        const r = parseResponse(await send(JSON.stringify({ type: 'stop', reqId: 'cli-' + process.pid, envId })))
        console.log(r && r.type === 'ok' ? 'Stopped' : 'Error: ' + (r && r.message || 'unknown'))
        break
      }
      case 'status': {
        const msg = envId
          ? JSON.stringify({ type: 'status-one', reqId: 'cli-' + process.pid, envId })
          : JSON.stringify({ type: 'status', reqId: 'cli-' + process.pid })
        const r = parseResponse(await send(msg))
        if (!r || r.type === 'error') { console.error('Error: ' + (r && r.message || 'unknown')); process.exit(1) }
        const envs = Array.isArray(r.data) ? r.data : (r.data ? [r.data] : [])
        if (!envs.length) { console.log('No environments'); break }
        for (const e of envs) {
          const svcs = (e.services || []).map(s => s.name + '=' + s.status).join(', ')
          console.log(e.name + ' [' + e.status + '] id=' + e.id + ' — ' + svcs)
        }
        break
      }
      default:
        console.error('Usage: colony {start|stop|status} [env-id]')
        process.exit(1)
    }
  } catch (err) {
    console.error('colony: ' + err.message)
    process.exit(1)
  }
}

main()
`

const COLONY_CLI_SH = `#!/bin/sh
exec node "$(dirname "$0")/colony-cli.js" "$@"
`

const COLONY_CLI_CMD = `@echo off\r\nnode "%~dp0colony-cli.js" %*\r\n`
import { broadcast } from './broadcast'
import { seedDefaultPipelines, startPipelines, stopPipelines, getPipelineList } from './pipeline-engine'
import { cleanupStaleForkGroups } from './fork-manager'
import { cleanupOldDailyLogs } from './activity-manager'
import { startWebhookServer, stopWebhookServer } from './webhook-server'
import { initAppUpdater, shutdownAppUpdater } from './app-updater'
import { stopBatchScheduler } from './batch-runner'
import { startWakeWatcher, stopWakeWatcher } from './session-wake'
import { colonyPaths } from '../shared/colony-paths'
import { registerGlobalHotkey } from './global-hotkey'
import { startUsageMonitor } from './persona-run-history'
import { watchPlaybooks } from './playbook-manager'

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

let _saveWindowTimer: ReturnType<typeof setTimeout> | null = null

function saveWindowState(immediate = false): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!immediate) {
    // Debounce: move/resize fire at 60fps during drag
    if (_saveWindowTimer) clearTimeout(_saveWindowTimer)
    _saveWindowTimer = setTimeout(() => saveWindowState(true), 500)
    return
  }
  _saveWindowTimer = null
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
    // Snap to the nearest display so a disconnected monitor doesn't hide the window.
    const displays = screen.getAllDisplays()
    const cx = savedState.x + (savedState.width || 1200) / 2
    const cy = savedState.y + (savedState.height || 800) / 2
    const onScreen = displays.some(d => {
      const a = d.workArea
      return cx >= a.x && cx <= a.x + a.width && cy >= a.y && cy <= a.y + a.height
    })
    if (onScreen) {
      bounds.x = savedState.x
      bounds.y = savedState.y
    }
  }

  const platformWindowOptions: Partial<Electron.BrowserWindowConstructorOptions> =
    process.platform === 'darwin'
      ? {}
      : {
          titleBarStyle: 'hidden',
          titleBarOverlay: {
            color: '#1a1a2e',
            symbolColor: '#e0e0e0',
            height: 36,
          },
        }

  mainWindow = new BrowserWindow({
    ...bounds,
    ...platformWindowOptions,
    minHeight: 600,
    minWidth: 900,
    show: false,
    // Helps first paint / ready-to-show on macOS vibrancy windows; matches renderer theme
    backgroundColor: '#1a1a2e',
    title: 'Claude Colony',
    icon: getIconPath(),
    // macOS Tahoe native fullscreen is broken for this app (window vanishes
    // into a phantom Space). Disable so the green traffic-light button does
    // zoom/maximize instead. Cmd+Ctrl+F goes through our IPC handler, which
    // uses setSimpleFullScreen — reliable on Tahoe.
    fullscreenable: process.platform !== 'darwin',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      webviewTag: true,
    },
  })
  // Save window state on move, resize, maximize, and fullscreen changes
  const stateChangeHandler = () => saveWindowState()
  mainWindow.on('move', stateChangeHandler)
  mainWindow.on('resize', stateChangeHandler)
  mainWindow.on('maximize', stateChangeHandler)
  mainWindow.on('unmaximize', stateChangeHandler)

  mainWindow.on('enter-full-screen', () => {
    stateChangeHandler()
    mainWindow?.webContents.send('window:fullscreen-changed', true)
  })
  mainWindow.on('leave-full-screen', () => {
    stateChangeHandler()
    mainWindow?.webContents.send('window:fullscreen-changed', false)
  })

  mainWindow.on('close', (event) => {
    saveWindowState(true)
    if (process.platform === 'darwin' && !app.isQuitting) {
      const keepInTray = getSettingSync('keepInTray') !== 'false'
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
    if (savedState.isMaximized) {
      setImmediate(() => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.maximize()
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

  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.executeJavaScript(
      `document.documentElement.dataset.platform = '${process.platform}'`
    )
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

/** Show the main window and center it on the current display. */
function showAndCenter(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.show()
  mainWindow.focus()
  // Center on the display the window is currently on (or primary if off-screen)
  const bounds = mainWindow.getBounds()
  const display = screen.getDisplayNearestPoint({ x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 })
  const { width: dw, height: dh, x: dx, y: dy } = display.workArea
  const x = Math.round(dx + (dw - bounds.width) / 2)
  const y = Math.round(dy + (dh - bounds.height) / 2)
  mainWindow.setPosition(x, y)
  if (process.platform === 'darwin') app.dock?.show()
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
          label: 'Quick Compare',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => broadcast('shortcut:quick-compare'),
        },
        {
          label: 'Find in Terminal',
          accelerator: 'CmdOrCtrl+F',
          click: () => broadcast('shortcut:search'),
        },
        {
          label: 'Search All Sessions',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => broadcast('shortcut:global-search'),
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
        ...(is.dev ? [
          { role: 'reload' as const },
          { role: 'forceReload' as const },
          { role: 'toggleDevTools' as const },
          { type: 'separator' as const },
        ] : []),
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
        {
          label: 'Toggle Full Screen',
          accelerator: process.platform === 'darwin' ? 'Ctrl+Cmd+F' : 'F11',
          click: () => {
            const win = mainWindow
            if (!win || win.isDestroyed()) return
            if (process.platform === 'darwin') {
              const next = !win.isSimpleFullScreen()
              win.setSimpleFullScreen(next)
              win.webContents.send('window:fullscreen-changed', next)
            } else {
              win.setFullScreen(!win.isFullScreen())
            }
          },
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        { role: 'minimize' as const },
        { role: 'zoom' as const },
        { type: 'separator' as const },
        {
          label: 'Center Window',
          accelerator: 'CmdOrCtrl+Shift+C',
          click: () => showAndCenter(),
        },
        { type: 'separator' as const },
        { role: 'front' as const },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  electronApp.setAppUserModelId('com.claude-colony.app')
  app.setName('Claude Colony')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  initLogger()
  console.log('[app] Claude Colony starting up')

  // Clean up fork groups from previous run
  try { cleanupStaleForkGroups() } catch (err) { console.warn('[app] cleanupStaleForkGroups failed:', err) }

  // Clean up daily activity logs older than 30 days
  cleanupOldDailyLogs().catch(err => console.warn('[app] cleanupOldDailyLogs failed:', err))

  // Set dock icon on macOS
  if (process.platform === 'darwin') {
    app.dock?.setIcon(getIconPath())
  }

  // Pre-load settings into cache so sync reads (getSettingSync) work everywhere
  await getSettings()

  registerIpcHandlers()
  initTagRulesWatcher()
  initRecipes().catch(err => console.warn('[app] recipe seeding failed:', err))
  mergeGhSkills().catch(err => console.warn('[app] gh skill discovery failed:', err))
  buildAppMenu()
  createWindow()
  createTray(mainWindow)
  initAppUpdater(mainWindow)

  // Wire callbacks before daemon connect so no events are missed
  setOnInstanceListChanged(() => updateTrayMenu(mainWindow))
  setOnSessionExit((instanceId) => {
    onPersonaSessionExit(instanceId)
    collectSessionArtifact(instanceId).catch(() => {})
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
  await seedDefaultPipelines()

  // Connect to PTY daemon (spawns it if not running)
  initDaemon().then(async () => {
    console.log('[app] daemon connected')
    updateTrayMenu(mainWindow)
    // Generate initial colony context
    await updateColonyContext()
    console.log('[app] colony context initialized')
    // Install colony CLI (Node.js core + platform wrapper)
    try {
      const binDir = join(app.getPath('home'), '.claude-colony', 'bin')
      fs.mkdirSync(binDir, { recursive: true })
      fs.writeFileSync(join(binDir, 'colony-cli.js'), COLONY_CLI_NODE, 'utf-8')
      if (process.platform === 'win32') {
        fs.writeFileSync(join(binDir, 'colony.cmd'), COLONY_CLI_CMD, 'utf-8')
      } else {
        fs.writeFileSync(join(binDir, 'colony'), COLONY_CLI_SH, 'utf-8')
        fs.chmodSync(join(binDir, 'colony'), 0o755)
      }
    } catch (err) { console.warn('[app] colony CLI install failed:', err) }
    // Ensure all repos have bare clones, then pre-warm .colony/ config cache
    ensureRepoClones().catch(() => { /* ignore */ })
    refreshRepoConfigs().catch(() => { /* ignore */ })
    // Start pipeline polling
    startUsageMonitor()
    startPipelines().then(async () => {
      console.log('[app] pipelines started')
      // Broadcast the loaded list so any renderer that subscribed before startup completes gets it
      broadcast('pipeline:status', getPipelineList())
      // Start webhook server if enabled
      const webhookPort = parseInt(await getSetting('webhookPort') || '7474', 10)
      if (await getSetting('webhookEnabled') !== 'false') {
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
      runStartupPersonas().catch(err => console.warn('[app] startup personas failed:', err))
    } catch (err) { console.warn('[app] persona/scheduler init failed:', err) }
    startWakeWatcher().catch(err => console.warn('[app] wake watcher init failed:', err))
    watchPlaybooks().catch(err => console.warn('[app] playbook watcher init failed:', err))
    startRateLimitProbe().catch(err => console.warn('[app] rate-limit probe init failed:', err))
  }).catch((err) => {
    console.error('[app] daemon init failed:', err)
    broadcast('daemon:connection-failed', { error: err instanceof Error ? err.message : String(err) })
  })

  // Connect to environment daemon (spawns it if not running)
  initEnvDaemon().then(() => {
    console.log('[app] envd connected')
  }).catch((err) => {
    console.error('[app] envd init failed:', err)
  })

  // Register global hotkey to bring app to front
  const hotkey = await getSetting('globalHotkey') || 'CommandOrControl+Shift+Space'
  registerGlobalHotkey(hotkey)


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
  // Each cleanup call is independently try-caught so one failure
  // doesn't skip the rest (e.g. snapshot must save, daemon must disconnect)
  try { snapshotRunningSync() } catch (e) { console.error('[quit] snapshotRunningSync:', e) }
  try { stopWebhookServer() } catch (e) { console.error('[quit] stopWebhookServer:', e) }
  try { shutdownAppUpdater() } catch (e) { console.error('[quit] shutdownAppUpdater:', e) }
  try { stopPersonaWatcher() } catch (e) { console.error('[quit] stopPersonaWatcher:', e) }
  try { stopPersonaScheduler() } catch (e) { console.error('[quit] stopPersonaScheduler:', e) }
  try { stopRateLimitProbe() } catch (e) { console.error('[quit] stopRateLimitProbe:', e) }
  try { stopEnvWatching() } catch (e) { console.error('[quit] stopEnvWatching:', e) }
  try { stopTasksBoardWatcher() } catch (e) { console.error('[quit] stopTasksBoardWatcher:', e) }
  try { stopPipelines() } catch (e) { console.error('[quit] stopPipelines:', e) }
  try { stopBatchScheduler() } catch (e) { console.error('[quit] stopBatchScheduler:', e) }
  try { stopWakeWatcher() } catch (e) { console.error('[quit] stopWakeWatcher:', e) }
  try { disconnectDaemon() } catch (e) { console.error('[quit] disconnectDaemon:', e) }
})

app.on('will-quit', () => {
  try { globalShortcut.unregisterAll() } catch (e) { console.error('[quit] unregisterAll:', e) }
  try { killAllShells() } catch (e) { console.error('[quit] killAllShells:', e) }
})

declare global {
  namespace Electron {
    interface App {
      isQuitting?: boolean
    }
  }
}
