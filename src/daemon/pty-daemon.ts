/**
 * PTY Daemon — standalone Node.js process that owns all PTY file descriptors.
 * Survives Electron app crashes/restarts. Communicates over Unix domain sockets.
 *
 * Launched via: ELECTRON_RUN_AS_NODE=1 <electron-binary> <this-script>
 */

import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { execSync } from 'child_process'
import * as pty from 'node-pty'
import type {
  ClaudeInstance,
  CreateOpts,
  DaemonRequest,
  DaemonResponse,
  DaemonEvent,
} from './protocol'

// ---- Paths ----

const HOME = process.env.HOME || '/'
const COLONY_DIR = path.join(HOME, '.claude-colony')
const SOCKET_PATH = path.join(COLONY_DIR, 'daemon.sock')
const PID_PATH = path.join(COLONY_DIR, 'daemon.pid')

// ---- Shell environment ----

function loadShellEnv(): Record<string, string> {
  // Read shell profile setting
  let shellProfile = ''
  try {
    const settingsPath = path.join(COLONY_DIR, 'settings.json')
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      shellProfile = settings.shellProfile || ''
    }
  } catch { /* */ }

  let cmd: string
  if (shellProfile === 'login') {
    cmd = '/bin/zsh -lc "env"'
  } else if (shellProfile) {
    cmd = `${shellProfile} -lc "env"`
  } else {
    cmd = '/bin/zsh -lc "env"'
  }

  try {
    const envOutput = execSync(cmd, { encoding: 'utf-8', timeout: 5000 })
    const env: Record<string, string> = { ...process.env }
    for (const line of envOutput.split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) {
        env[line.substring(0, idx)] = line.substring(idx + 1)
      }
    }
    log(`loaded shell env from: ${cmd} (${Object.keys(env).length} vars)`)
    return env
  } catch (err) {
    log(`failed to load shell env: ${err}`)
    // Fallback: just grab PATH
    try {
      const shellPath = execSync('/bin/zsh -lc "echo $PATH"', { encoding: 'utf-8', timeout: 5000 }).trim()
      if (shellPath) return { ...process.env, PATH: shellPath } as Record<string, string>
    } catch { /* */ }
    return { ...process.env } as Record<string, string>
  }
}

const shellEnv = loadShellEnv()

// ---- Instance management ----

interface InternalInstance extends ClaudeInstance {
  pty: pty.IPty | null
  outputBuffer: string[]
  cleanupTimer: ReturnType<typeof setTimeout> | null
  _lastSnapshot: string
  _activityInterval: ReturnType<typeof setInterval> | null
}

const instances = new Map<string, InternalInstance>()

// MCP server detection patterns
const MCP_PATTERNS = [
  /Connected to MCP server:\s*(.+)/i,
  /MCP server\s+["']?([^"'\s]+)["']?\s+connected/i,
  /mcp:\s*(\S+)\s+ready/i,
  /Tool from\s+(\S+)\s+MCP/i,
  /MCP\s+server\s*[:\-]\s*(\S+)/i,
]

const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
]
const HEX_TO_NAME: Record<string, string> = {
  '#3b82f6': 'blue',
  '#10b981': 'green',
  '#f59e0b': 'yellow',
  '#ef4444': 'red',
  '#8b5cf6': 'purple',
  '#ec4899': 'pink',
  '#06b6d4': 'cyan',
  '#f97316': 'orange',
  '#14b8a6': 'teal',
  '#6366f1': 'indigo',
}
function nextColor(): string {
  // Pick the color used by the fewest existing instances
  const usedCounts = new Map<string, number>()
  for (const c of COLORS) usedCounts.set(c, 0)
  for (const inst of instances.values()) {
    const count = usedCounts.get(inst.color)
    if (count !== undefined) usedCounts.set(inst.color, count + 1)
  }
  let best = COLORS[0]
  let bestCount = Infinity
  for (const c of COLORS) {
    const count = usedCounts.get(c)!
    if (count < bestCount) {
      bestCount = count
      best = c
    }
  }
  return best
}

let instanceCounter = 0

function resolveGitBranch(cwd: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 2000 }).trim() || null
  } catch {
    return null
  }
}

function toSerializable(inst: InternalInstance): ClaudeInstance {
  return {
    id: inst.id,
    name: inst.name,
    color: inst.color,
    status: inst.status,
    activity: inst.activity,
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

function getAllInstances(): ClaudeInstance[] {
  return Array.from(instances.values()).map(toSerializable)
}

function broadcastEvent(event: DaemonEvent): void {
  const line = JSON.stringify(event) + '\n'
  for (const client of subscribers) {
    try {
      client.write(line)
    } catch {
      // dead client, will be cleaned up on close
    }
  }
}

function notifyListChanged(): void {
  broadcastEvent({ type: 'list-changed', instances: getAllInstances() })
  resetIdleTimer()
}

// ---- Simple UUID (avoid importing uuid in daemon) ----

function genId(): string {
  const hex = () => Math.random().toString(16).substring(2, 10)
  return `${hex()}${hex()}-${hex()}-${hex()}`
}

// ---- Core operations ----

function createInstance(opts: CreateOpts): ClaudeInstance {
  const id = genId()
  const cwd = opts.workingDirectory || HOME
  instanceCounter++
  const name = opts.name || `Claude ${instanceCounter}`
  const color = opts.color || nextColor()

  const defaultArgs = opts.defaultArgs || []
  const userArgs = opts.args || []
  const claudeArgs = ['--add-dir', cwd, '--name', name, ...defaultArgs, ...userArgs]

  log(`creating instance name="${name}" cwd=${cwd} args=${JSON.stringify(claudeArgs)}`)

  let ptyProcess: pty.IPty
  try {
    ptyProcess = pty.spawn('claude', claudeArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: shellEnv,
    })
    log(`spawned claude pid=${ptyProcess.pid}`)
  } catch (err) {
    log(`failed to spawn claude: ${err}`)
    const instance: InternalInstance = {
      id, name, color, status: 'exited', activity: 'waiting',
      workingDirectory: cwd, createdAt: new Date().toISOString(),
      exitCode: -1, pid: null, args: claudeArgs,
      gitBranch: resolveGitBranch(cwd),
      tokenUsage: { input: 0, output: 0, cost: 0 },
      pinned: false, mcpServers: [],
      pty: null, outputBuffer: [`Failed to spawn claude: ${err}\r\n`],
      cleanupTimer: null, _lastSnapshot: '', _activityInterval: null,
    }
    instances.set(id, instance)
    notifyListChanged()
    return toSerializable(instance)
  }

  const instance: InternalInstance = {
    id, name, color, status: 'running', activity: 'busy',
    workingDirectory: cwd, createdAt: new Date().toISOString(),
    exitCode: null, pid: ptyProcess.pid,
    args: claudeArgs, gitBranch: resolveGitBranch(cwd),
    tokenUsage: { input: 0, output: 0, cost: 0 },
    pinned: false, mcpServers: [],
    pty: ptyProcess, outputBuffer: [],
    cleanupTimer: null, _lastSnapshot: '', _activityInterval: null,
  }

  instances.set(id, instance)

  // Stream output
  const ansiRegex = /\x1B\[[0-9;]*[a-zA-Z]|\x1B\][\s\S]*?(\x07|\x1B\\)/g
  ptyProcess.onData((data) => {
    instance.outputBuffer.push(data)
    if (instance.outputBuffer.length > 10000) {
      instance.outputBuffer.splice(0, instance.outputBuffer.length - 5000)
    }

    // Broadcast to subscribers as base64
    broadcastEvent({ type: 'output', instanceId: id, data: Buffer.from(data).toString('base64') })

    // Parse token usage
    const clean = data.replace(ansiRegex, '')
    const costMatch = clean.match(/\$(\d+\.?\d*)\s*(?:cost|spent|total)/i) || clean.match(/cost[:\s]*\$(\d+\.?\d*)/i)
    if (costMatch) instance.tokenUsage.cost = parseFloat(costMatch[1])
    const inputMatch = clean.match(/([\d,]+)\s*input\s*tokens?/i)
    if (inputMatch) instance.tokenUsage.input = parseInt(inputMatch[1].replace(/,/g, ''), 10)
    const outputMatch = clean.match(/([\d,]+)\s*output\s*tokens?/i)
    if (outputMatch) instance.tokenUsage.output = parseInt(outputMatch[1].replace(/,/g, ''), 10)

    // Parse MCP servers
    for (const pattern of MCP_PATTERNS) {
      const mcpMatch = clean.match(pattern)
      if (mcpMatch?.[1]) {
        const serverName = mcpMatch[1].trim()
        if (!instance.mcpServers.includes(serverName)) {
          instance.mcpServers.push(serverName)
          notifyListChanged()
        }
      }
    }
  })

  // Send /color command once Claude is ready
  let colorSent = false

  // Activity detection
  instance._activityInterval = setInterval(() => {
    if (instance.status !== 'running') {
      if (instance._activityInterval) clearInterval(instance._activityInterval)
      return
    }
    const tail = instance.outputBuffer.slice(-200).join('')
    const changed = tail !== instance._lastSnapshot
    instance._lastSnapshot = tail
    const newActivity = changed ? 'busy' : 'waiting'
    if (newActivity !== instance.activity) {
      instance.activity = newActivity
      broadcastEvent({ type: 'activity', instanceId: id, activity: newActivity })

      // Send /color on first waiting state
      if (newActivity === 'waiting' && !colorSent && instance.pty) {
        colorSent = true
        const colorName = HEX_TO_NAME[instance.color]
        if (colorName) {
          instance.pty.write(`/color ${colorName}\n`)
        }
      }
    }
  }, 2000)

  // Handle exit
  ptyProcess.onExit(({ exitCode }) => {
    if (instance._activityInterval) clearInterval(instance._activityInterval)
    log(`instance ${id} (${name}) exited with code ${exitCode}`)
    instance.status = 'exited'
    instance.activity = 'waiting'
    instance.exitCode = exitCode
    instance.pty = null
    broadcastEvent({ type: 'exited', instanceId: id, exitCode })
    notifyListChanged()
  })

  notifyListChanged()
  return toSerializable(instance)
}

function writeToInstance(id: string, data: string): boolean {
  const inst = instances.get(id)
  if (!inst?.pty) return false
  inst.pty.write(data)
  return true
}

function resizeInstance(id: string, cols: number, rows: number): boolean {
  const inst = instances.get(id)
  if (!inst?.pty) return false
  if (cols < 1 || rows < 1 || !Number.isFinite(cols) || !Number.isFinite(rows)) return false
  inst.pty.resize(cols, rows)
  return true
}

function killInstance(id: string): boolean {
  const inst = instances.get(id)
  if (!inst) return false
  if (inst.pty) {
    try { inst.pty.kill() } catch { /* already dead */ }
  }
  if (inst._activityInterval) clearInterval(inst._activityInterval)
  inst.status = 'exited'
  inst.exitCode = -1
  inst.pty = null
  notifyListChanged()
  return true
}

function removeInstance(id: string): boolean {
  const inst = instances.get(id)
  if (!inst) return false
  if (inst.pty) {
    try { inst.pty.kill() } catch { /* already dead */ }
  }
  if (inst._activityInterval) clearInterval(inst._activityInterval)
  if (inst.cleanupTimer) clearTimeout(inst.cleanupTimer)
  instances.delete(id)
  notifyListChanged()
  return true
}

function renameInstance(id: string, name: string): boolean {
  const inst = instances.get(id)
  if (!inst) return false
  inst.name = name
  if (inst.pty && inst.status === 'running') {
    inst.pty.write(`/rename ${name}\r`)
  }
  notifyListChanged()
  return true
}

function recolorInstance(id: string, color: string): boolean {
  const inst = instances.get(id)
  if (!inst) return false
  inst.color = color
  // Sync color to Claude CLI if instance is running and waiting for input
  if (inst.pty && inst.status === 'running' && inst.activity === 'waiting') {
    const colorName = HEX_TO_NAME[color]
    if (colorName) {
      inst.pty.write(`/color ${colorName}\n`)
    }
  }
  notifyListChanged()
  return true
}

function pinInstance(id: string): boolean {
  const inst = instances.get(id)
  if (!inst) return false
  inst.pinned = true
  notifyListChanged()
  return true
}

function unpinInstance(id: string): boolean {
  const inst = instances.get(id)
  if (!inst) return false
  inst.pinned = false
  notifyListChanged()
  return true
}

function restartInstance(id: string, defaultArgs?: string[]): ClaudeInstance | null {
  const inst = instances.get(id)
  if (!inst) return null
  if (inst.pty) {
    try { inst.pty.kill() } catch { /* already dead */ }
  }
  if (inst._activityInterval) clearInterval(inst._activityInterval)

  // Filter out internal args (--add-dir, --name) that createInstance will re-add
  const userArgs = inst.args.filter((arg, i, arr) => {
    if (arg === '--add-dir' || arg === '--name') return false
    if (i > 0 && (arr[i - 1] === '--add-dir' || arr[i - 1] === '--name')) return false
    return true
  })
  const dArgs = defaultArgs || []
  const filteredArgs = userArgs.filter((arg) => !dArgs.includes(arg))

  instances.delete(id)
  return createInstance({
    name: inst.name,
    workingDirectory: inst.workingDirectory,
    color: inst.color,
    args: filteredArgs.length > 0 ? filteredArgs : undefined,
    defaultArgs: dArgs,
  })
}

function getInstanceBuffer(id: string): string {
  const inst = instances.get(id)
  return inst ? inst.outputBuffer.join('') : ''
}

// ---- Socket server ----

const subscribers = new Set<net.Socket>()

function handleRequest(req: DaemonRequest, socket: net.Socket): void {
  const send = (resp: DaemonResponse) => {
    try { socket.write(JSON.stringify(resp) + '\n') } catch { /* dead */ }
  }

  try {
    switch (req.type) {
      case 'create': {
        const inst = createInstance(req.opts)
        send({ type: 'ok', reqId: req.reqId, data: inst })
        break
      }
      case 'write': {
        const data = Buffer.from(req.data, 'base64').toString()
        const ok = writeToInstance(req.instanceId, data)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'resize': {
        const ok = resizeInstance(req.instanceId, req.cols, req.rows)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'kill': {
        const ok = killInstance(req.instanceId)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'remove': {
        const ok = removeInstance(req.instanceId)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'rename': {
        const ok = renameInstance(req.instanceId, req.name)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'recolor': {
        const ok = recolorInstance(req.instanceId, req.color)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'restart': {
        const inst = restartInstance(req.instanceId, req.defaultArgs)
        send({ type: 'ok', reqId: req.reqId, data: inst })
        break
      }
      case 'pin': {
        const ok = pinInstance(req.instanceId)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'unpin': {
        const ok = unpinInstance(req.instanceId)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'list': {
        send({ type: 'ok', reqId: req.reqId, data: getAllInstances() })
        break
      }
      case 'get': {
        const inst = instances.get(req.instanceId)
        send({ type: 'ok', reqId: req.reqId, data: inst ? toSerializable(inst) : null })
        break
      }
      case 'buffer': {
        const buf = getInstanceBuffer(req.instanceId)
        send({ type: 'ok', reqId: req.reqId, data: Buffer.from(buf).toString('base64') })
        break
      }
      case 'subscribe': {
        subscribers.add(socket)
        send({ type: 'ok', reqId: req.reqId })
        break
      }
      case 'ping': {
        send({ type: 'ok', reqId: req.reqId })
        broadcastEvent({ type: 'pong' })
        break
      }
      case 'shutdown': {
        send({ type: 'ok', reqId: req.reqId })
        log('shutdown requested')
        shutdown()
        break
      }
      default:
        send({ type: 'error', reqId: (req as DaemonRequest).reqId, message: `unknown request type` })
    }
  } catch (err) {
    send({ type: 'error', reqId: req.reqId, message: String(err) })
  }
}

// ---- NDJSON stream parser ----

function setupSocket(socket: net.Socket): void {
  let buffer = ''

  socket.on('data', (chunk) => {
    buffer += chunk.toString()
    let newlineIdx: number
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.substring(0, newlineIdx).trim()
      buffer = buffer.substring(newlineIdx + 1)
      if (!line) continue
      try {
        const req = JSON.parse(line) as DaemonRequest
        handleRequest(req, socket)
      } catch (err) {
        log(`failed to parse request: ${err}`)
      }
    }
  })

  socket.on('close', () => {
    subscribers.delete(socket)
    resetIdleTimer()
  })

  socket.on('error', () => {
    subscribers.delete(socket)
  })
}

// ---- Idle timeout ----

const IDLE_TIMEOUT_MS = 30 * 60 * 1000 // 30 minutes
let idleTimer: ReturnType<typeof setTimeout> | null = null

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer)
  // Only start idle timer if no subscribers and no running instances
  const hasRunning = Array.from(instances.values()).some((i) => i.status === 'running')
  if (subscribers.size === 0 && !hasRunning && instances.size === 0) {
    idleTimer = setTimeout(() => {
      log('idle timeout reached, shutting down')
      shutdown()
    }, IDLE_TIMEOUT_MS)
  }
}

// ---- Lifecycle ----

let server: net.Server | null = null

function shutdown(): void {
  log('shutting down daemon')
  // Kill all running instances
  for (const [id, inst] of instances) {
    if (inst.pty) {
      try { inst.pty.kill() } catch { /* */ }
    }
    if (inst._activityInterval) clearInterval(inst._activityInterval)
    if (inst.cleanupTimer) clearTimeout(inst.cleanupTimer)
  }
  instances.clear()

  if (server) {
    server.close()
    server = null
  }

  // Clean up files
  try { fs.unlinkSync(SOCKET_PATH) } catch { /* */ }
  try { fs.unlinkSync(PID_PATH) } catch { /* */ }

  process.exit(0)
}

function log(msg: string): void {
  const ts = new Date().toISOString().substring(11, 23)
  process.stderr.write(`[daemon ${ts}] ${msg}\n`)
}

function main(): void {
  // Ensure colony dir exists
  if (!fs.existsSync(COLONY_DIR)) {
    fs.mkdirSync(COLONY_DIR, { recursive: true })
  }

  // Clean up stale socket
  try { fs.unlinkSync(SOCKET_PATH) } catch { /* */ }

  // Write PID
  fs.writeFileSync(PID_PATH, String(process.pid), 'utf-8')
  log(`started with pid ${process.pid}`)

  // Create server
  server = net.createServer((socket) => {
    log('client connected')
    setupSocket(socket)
  })

  server.listen(SOCKET_PATH, () => {
    log(`listening on ${SOCKET_PATH}`)
    // Set socket permissions so only the user can connect
    try { fs.chmodSync(SOCKET_PATH, 0o700) } catch { /* */ }
  })

  server.on('error', (err) => {
    log(`server error: ${err}`)
    shutdown()
  })

  // Handle signals
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
  process.on('uncaughtException', (err) => {
    log(`uncaught exception: ${err.stack || err}`)
    // Don't crash — keep instances alive
  })
  process.on('unhandledRejection', (err) => {
    log(`unhandled rejection: ${err}`)
  })

  resetIdleTimer()
}

main()
