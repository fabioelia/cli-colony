import * as pty from 'node-pty'
import { execSync } from 'child_process'
import { v4 as uuidv4 } from 'uuid'
import { BrowserWindow, Notification, shell } from 'electron'
import { getDefaultArgs, getSetting } from './settings'
import { trackOpened, trackClosed } from './recent-sessions'

export interface ClaudeInstance {
  id: string
  name: string
  color: string
  status: 'running' | 'idle' | 'exited'
  workingDirectory: string
  createdAt: string
  exitCode: number | null
  pid: number | null
  args: string[]
  gitBranch: string | null
  tokenUsage: { input: number; output: number; cost: number }
  pinned: boolean
  mcpServers: string[]
}

interface InternalInstance extends ClaudeInstance {
  pty: pty.IPty | null
  outputBuffer: string[]
  cleanupTimer: ReturnType<typeof setTimeout> | null
}

// MCP server detection patterns
const MCP_PATTERNS = [
  /Connected to MCP server:\s*(.+)/i,
  /MCP server\s+["']?([^"'\s]+)["']?\s+connected/i,
  /mcp:\s*(\S+)\s+ready/i,
  /Tool from\s+(\S+)\s+MCP/i,
  /MCP\s+server\s*[:\-]\s*(\S+)/i,
]

// Tray update callback — set from index.ts
let onInstanceListChanged: (() => void) | null = null
export function setOnInstanceListChanged(cb: () => void): void {
  onInstanceListChanged = cb
}

function resolveGitBranch(cwd: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 2000 }).trim() || null
  } catch {
    return null
  }
}

const instances = new Map<string, InternalInstance>()

// Resolve the user's full shell PATH (Electron doesn't inherit it)
// Use non-interactive non-login shell to avoid slow zshrc loading
let shellEnv: Record<string, string> = { ...process.env } as Record<string, string>
try {
  // Try fast: read from a non-interactive login shell (loads /etc/zprofile + .zprofile only)
  const shellPath = execSync('/bin/zsh -lc "echo $PATH"', { encoding: 'utf-8', timeout: 5000 }).trim()
  if (shellPath) {
    shellEnv = { ...process.env, PATH: shellPath } as Record<string, string>
  }
  console.log('[instance-manager] resolved shell PATH:', shellPath.split(':').slice(0, 5).join(':'), '...')
} catch (err) {
  console.error('[instance-manager] failed to resolve shell PATH:', err)
}

const COLORS = [
  '#3b82f6', // blue
  '#10b981', // green
  '#f59e0b', // amber
  '#ef4444', // red
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
  '#14b8a6', // teal
  '#6366f1', // indigo
]

let colorIndex = 0

function nextColor(): string {
  const color = COLORS[colorIndex % COLORS.length]
  colorIndex++
  return color
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, ...args)
    }
  }
}

function toSerializable(inst: InternalInstance): ClaudeInstance {
  return {
    id: inst.id,
    name: inst.name,
    color: inst.color,
    status: inst.status,
    workingDirectory: inst.workingDirectory,
    createdAt: inst.createdAt,
    exitCode: inst.exitCode,
    pid: inst.pid,
    args: inst.args,
    gitBranch: inst.gitBranch,
    tokenUsage: inst.tokenUsage,
    pinned: inst.pinned,
    mcpServers: inst.mcpServers,
  }
}

function notifyListChanged(): void {
  broadcast('instance:list', getAllInstances())
  onInstanceListChanged?.()
}

export function createInstance(opts: {
  name?: string
  workingDirectory?: string
  color?: string
  args?: string[]
}): ClaudeInstance {
  const id = uuidv4()
  const cwd = opts.workingDirectory || process.env.HOME || '/'
  const name = opts.name || `Claude ${instances.size + 1}`
  const color = opts.color || nextColor()

  // Spawn claude CLI — merge default args from settings with per-instance args
  const defaultArgs = getDefaultArgs()
  const userArgs = opts.args && opts.args.length > 0 ? opts.args : []
  const claudeArgs = ['--add-dir', cwd, '--name', name, ...defaultArgs, ...userArgs]
  console.log(`[instance-manager] defaultArgs=${JSON.stringify(defaultArgs)} userArgs=${JSON.stringify(userArgs)}`)
  console.log(`[instance-manager] creating instance name="${name}" cwd=${cwd} args=${JSON.stringify(claudeArgs)}`)

  let ptyProcess: pty.IPty
  try {
    ptyProcess = pty.spawn('claude', claudeArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: shellEnv,
    })
    console.log(`[instance-manager] spawned claude pid=${ptyProcess.pid} cwd=${cwd} args=${JSON.stringify(claudeArgs)}`)
  } catch (err) {
    console.error(`[instance-manager] failed to spawn claude for ${id}:`, err)
    const instance: InternalInstance = {
      id,
      name,
      color,
      status: 'exited',
      workingDirectory: cwd,
      createdAt: new Date().toISOString(),
      exitCode: -1,
      pid: null,
      args: claudeArgs,
      gitBranch: resolveGitBranch(cwd),
      tokenUsage: { input: 0, output: 0, cost: 0 },
      pinned: false,
      mcpServers: [],
      pty: null,
      outputBuffer: [`Failed to spawn claude: ${err}\r\n`],
      cleanupTimer: null,
    }
    instances.set(id, instance)
    notifyListChanged()
    return toSerializable(instance)
  }

  const instance: InternalInstance = {
    id,
    name,
    color,
    status: 'running',
    workingDirectory: cwd,
    createdAt: new Date().toISOString(),
    exitCode: null,
    pid: ptyProcess.pid,
    args: claudeArgs,
    gitBranch: resolveGitBranch(cwd),
    tokenUsage: { input: 0, output: 0, cost: 0 },
    pinned: false,
    mcpServers: [],
    pty: ptyProcess,
    outputBuffer: [],
    cleanupTimer: null,
  }

  instances.set(id, instance)

  // Track in recent sessions
  const resumeIdx = claudeArgs.indexOf('--resume')
  const sessionIdFromArgs = resumeIdx >= 0 ? claudeArgs[resumeIdx + 1] : null
  trackOpened({
    instanceName: name,
    sessionId: sessionIdFromArgs,
    workingDirectory: cwd,
    color,
    args: claudeArgs,
  })

  // Stream output to renderer + buffer for late-joining terminals
  // Also parse for token usage (strip ANSI first)
  const ansiRegex = /\x1B\[[0-9;]*[a-zA-Z]|\x1B\][\s\S]*?(\x07|\x1B\\)/g
  ptyProcess.onData((data) => {
    instance.outputBuffer.push(data)
    if (instance.outputBuffer.length > 10000) {
      instance.outputBuffer.splice(0, instance.outputBuffer.length - 5000)
    }
    broadcast('instance:output', { id, data })

    // Parse token usage from cleaned output
    const clean = data.replace(ansiRegex, '')
    const costMatch = clean.match(/\$(\d+\.?\d*)\s*(?:cost|spent|total)/i) || clean.match(/cost[:\s]*\$(\d+\.?\d*)/i)
    if (costMatch) {
      instance.tokenUsage.cost = parseFloat(costMatch[1])
    }
    const inputMatch = clean.match(/([\d,]+)\s*input\s*tokens?/i)
    if (inputMatch) {
      instance.tokenUsage.input = parseInt(inputMatch[1].replace(/,/g, ''), 10)
    }
    const outputMatch = clean.match(/([\d,]+)\s*output\s*tokens?/i)
    if (outputMatch) {
      instance.tokenUsage.output = parseInt(outputMatch[1].replace(/,/g, ''), 10)
    }

    // Parse MCP server connections
    for (const pattern of MCP_PATTERNS) {
      const mcpMatch = clean.match(pattern)
      if (mcpMatch && mcpMatch[1]) {
        const serverName = mcpMatch[1].trim()
        if (!instance.mcpServers.includes(serverName)) {
          instance.mcpServers.push(serverName)
          notifyListChanged()
        }
      }
    }
  })

  // Handle exit
  ptyProcess.onExit(({ exitCode }) => {
    console.log(`[instance-manager] instance ${id} (${name}) exited with code ${exitCode}`)
    instance.status = 'exited'
    instance.exitCode = exitCode
    instance.pty = null
    trackClosed(name, 'exited')

    broadcast('instance:exited', { id, exitCode })
    notifyListChanged()

    // Play sound if enabled
    const soundEnabled = getSetting('soundOnFinish') !== 'false'
    if (soundEnabled) {
      console.log(`[instance-manager] playing finish sound for ${name}`)
      try {
        // Use macOS afplay for a reliable, audible sound
        execSync('afplay /System/Library/Sounds/Glass.aiff &', { timeout: 5000, stdio: 'ignore' })
      } catch {
        shell.beep() // fallback
      }
    }

    // Show native notification
    if (Notification.isSupported()) {
      const { join } = require('path') as typeof import('path')
      const iconPath = join(__dirname, '../../resources/icon.png')
      const notif = new Notification({
        title: 'Claude Instance Finished',
        body: `"${name}" exited with code ${exitCode}`,
        silent: false,
        icon: iconPath,
      })
      notif.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (win) {
          win.show()
          win.focus()
          broadcast('instance:focus', { id })
        }
      })
      notif.show()
    }

    // Auto-cleanup after 5 minutes
    const cleanupMins = parseInt(getSetting('autoCleanupMinutes') || '5', 10)
    if (cleanupMins > 0) {
      instance.cleanupTimer = setTimeout(() => {
        if (instances.has(id) && instance.status === 'exited') {
          console.log(`[instance-manager] auto-cleanup: removing ${id} (${name})`)
          removeInstance(id)
        }
      }, cleanupMins * 60 * 1000)
    }
  })

  notifyListChanged()
  return toSerializable(instance)
}

export function writeToInstance(id: string, data: string): boolean {
  const instance = instances.get(id)
  if (!instance?.pty) return false
  instance.pty.write(data)
  return true
}

export function resizeInstance(id: string, cols: number, rows: number): boolean {
  const instance = instances.get(id)
  if (!instance?.pty) return false
  if (cols < 1 || rows < 1 || !Number.isFinite(cols) || !Number.isFinite(rows)) return false
  instance.pty.resize(cols, rows)
  return true
}

export function killInstance(id: string): boolean {
  const instance = instances.get(id)
  if (!instance) return false

  if (instance.pty) {
    try {
      instance.pty.kill()
    } catch {
      // already dead
    }
  }

  instance.status = 'exited'
  instance.exitCode = -1
  instance.pty = null
  trackClosed(instance.name, 'killed')

  notifyListChanged()
  return true
}

export function removeInstance(id: string): boolean {
  const instance = instances.get(id)
  if (!instance) return false

  // Kill if still running
  if (instance.pty) {
    try {
      instance.pty.kill()
    } catch {
      // already dead
    }
  }

  instances.delete(id)
  notifyListChanged()
  return true
}

export function renameInstance(id: string, name: string): boolean {
  const instance = instances.get(id)
  if (!instance) return false
  instance.name = name
  // Send /name command to the running Claude CLI session
  if (instance.pty && instance.status === 'running') {
    instance.pty.write(`/rename ${name}\r`)
  }
  notifyListChanged()
  return true
}

export function recolorInstance(id: string, color: string): boolean {
  const instance = instances.get(id)
  if (!instance) return false
  instance.color = color
  notifyListChanged()
  return true
}

export function pinInstance(id: string): boolean {
  const instance = instances.get(id)
  if (!instance) return false
  instance.pinned = true
  notifyListChanged()
  return true
}

export function unpinInstance(id: string): boolean {
  const instance = instances.get(id)
  if (!instance) return false
  instance.pinned = false
  notifyListChanged()
  return true
}

export function restartInstance(id: string): ClaudeInstance | null {
  const instance = instances.get(id)
  if (!instance) return null

  // Kill if still running
  if (instance.pty) {
    try {
      instance.pty.kill()
    } catch {
      // already dead
    }
  }

  // Remove the old one, create a new one with same name/color/dir
  const opts = {
    name: instance.name,
    workingDirectory: instance.workingDirectory,
    color: instance.color,
  }
  instances.delete(id)
  return createInstance(opts)
}

export function getAllInstances(): ClaudeInstance[] {
  return Array.from(instances.values()).map(toSerializable)
}

export function getInstance(id: string): ClaudeInstance | null {
  const instance = instances.get(id)
  return instance ? toSerializable(instance) : null
}

export function getInstanceBuffer(id: string): string {
  const instance = instances.get(id)
  return instance ? instance.outputBuffer.join('') : ''
}

export function killAllInstances(): void {
  for (const [id] of instances) {
    killInstance(id)
  }
}
