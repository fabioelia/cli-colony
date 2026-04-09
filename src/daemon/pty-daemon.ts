/**
 * PTY Daemon — standalone Node.js process that owns all PTY file descriptors.
 * Survives Electron app crashes/restarts. Communicates over Unix domain sockets.
 *
 * Launched via: ELECTRON_RUN_AS_NODE=1 <electron-binary> <this-script>
 */

import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import * as pty from 'node-pty'
import { execSync, execFile } from 'child_process'
import {
  DAEMON_VERSION,
} from './protocol'
import type {
  ClaudeInstance,
  CliBackend,
  CreateOpts,
  DaemonRequest,
  DaemonResponse,
  DaemonEvent,
} from './protocol'
import type { ColonyComment } from '../shared/types'

// ---- Paths ----

import { colonyPaths } from '../shared/colony-paths'
import { loadShellEnv } from '../shared/shell-env'
import { genId } from '../shared/utils'

const HOME = process.env.HOME || '/'
const COLONY_DIR = colonyPaths.root
const SOCKET_PATH = colonyPaths.daemonSock
const PID_PATH = colonyPaths.daemonPid

// ---- Shell environment ----

const shellEnv = loadShellEnv()

// ---- Instance management ----

interface InternalInstance extends ClaudeInstance {
  pty: pty.IPty | null
  outputBuffer: string[]
  cleanupTimer: ReturnType<typeof setTimeout> | null
  _lastSnapshot: string
  _lastBufferLen: number
  _activityInterval: ReturnType<typeof setInterval> | null
  _handoffRequested: boolean
  _userInputReceived: boolean
  _sessionIdTimer: ReturnType<typeof setTimeout> | null
  /** Inline code annotations emitted by review agents via COLONY_COMMENT sentinels */
  comments: ColonyComment[]
  /** Partial line buffer for sentinel detection across PTY data chunks */
  _lineBuffer: string
  /** Timestamp of last async git branch resolution */
  _gitBranchResolvedAt: number
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

// Synchronous git resolution — only used during initial instance creation (one-time cost)
function resolveGitBranchSync(cwd: string): string | null {
  try {
    return execSync('git rev-parse --abbrev-ref HEAD', { cwd, encoding: 'utf-8', timeout: 2000 }).trim() || null
  } catch {
    return resolveGitInSubdirSync(cwd, 'branch')
  }
}

function resolveGitRepoSync(cwd: string): string | null {
  try {
    const url = execSync('git config --get remote.origin.url', { cwd, encoding: 'utf-8', timeout: 2000 }).trim()
    if (!url) return null
    const match = url.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
    return match ? `${match[1]}/${match[2]}` : null
  } catch {
    return resolveGitInSubdirSync(cwd, 'repo')
  }
}

function resolveGitInSubdirSync(cwd: string, type: 'branch' | 'repo'): string | null {
  try {
    const entries = fs.readdirSync(cwd, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'logs') continue
      const subdir = path.join(cwd, entry.name)
      try {
        if (type === 'branch') {
          return execSync('git rev-parse --abbrev-ref HEAD', { cwd: subdir, encoding: 'utf-8', timeout: 2000 }).trim() || null
        } else {
          const url = execSync('git config --get remote.origin.url', { cwd: subdir, encoding: 'utf-8', timeout: 2000 }).trim()
          if (!url) continue
          const match = url.match(/[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/)
          return match ? `${match[1]}/${match[2]}` : null
        }
      } catch { /* not a git repo, try next */ }
    }
  } catch { /* can't read dir */ }
  return null
}

// Async git resolution — used by periodic background refresh (never blocks event loop)
const GIT_BRANCH_TTL = 15_000 // 15 seconds

function execFileAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { cwd, encoding: 'utf-8', timeout: 3000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve((stdout as string).trim())
    })
  })
}

async function resolveGitBranchAsync(cwd: string): Promise<string | null> {
  try {
    return await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd) || null
  } catch {
    // Try one level of subdirectories
    try {
      const entries = fs.readdirSync(cwd, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'logs') continue
        try {
          return await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], path.join(cwd, entry.name)) || null
        } catch { /* not a git repo */ }
      }
    } catch { /* can't read dir */ }
    return null
  }
}

/** Periodically refresh git branches for running instances without blocking the event loop */
function startGitBranchRefresher(): void {
  setInterval(async () => {
    for (const inst of instances.values()) {
      if (inst.status !== 'running') continue
      if (Date.now() - inst._gitBranchResolvedAt < GIT_BRANCH_TTL) continue
      const branch = await resolveGitBranchAsync(inst.workingDirectory)
      inst._gitBranchResolvedAt = Date.now()
      if (branch !== inst.gitBranch) {
        inst.gitBranch = branch
        notifyListChanged()
      }
    }
  }, GIT_BRANCH_TTL)
}

function toSerializable(inst: InternalInstance): ClaudeInstance {
  // Git branch/repo are resolved asynchronously by the background refresher.
  // No blocking I/O here — just return cached values.
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
    cliBackend: inst.cliBackend,
    gitBranch: inst.gitBranch,
    gitRepo: inst.gitRepo,
    tokenUsage: inst.tokenUsage,
    pinned: inst.pinned,
    mcpServers: inst.mcpServers,
    parentId: inst.parentId,
    childIds: inst.childIds,
    roleTag: inst.roleTag,
    lastSessionId: inst.lastSessionId,
    pendingSteer: inst.pendingSteer,
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

// genId imported from shared/utils

function resolveCliBackend(opts: CreateOpts): CliBackend {
  return opts.cliBackend === 'cursor-agent' ? 'cursor-agent' : 'claude'
}

function buildSpawn(
  cliBackend: CliBackend,
  cwd: string,
  name: string,
  defaultArgs: string[],
  userArgs: string[],
  model?: string,
): { command: string; argv: string[] } {
  if (cliBackend === 'cursor-agent') {
    return { command: 'agent', argv: [...defaultArgs, ...userArgs] }
  }
  const agentsMd = path.join(cwd, 'AGENTS.md')
  const agentsArgs = fs.existsSync(agentsMd) ? ['--append-system-prompt-file', agentsMd] : []
  const colonyMemory = path.join(cwd, '.colony', 'memory.md')
  const memoryArgs = fs.existsSync(colonyMemory) ? ['--append-system-prompt-file', colonyMemory] : []
  const modelArgs = model ? ['--model', model] : []
  return {
    command: 'claude',
    argv: ['--dangerously-skip-permissions', ...modelArgs, '--add-dir', cwd, '--name', name, ...agentsArgs, ...memoryArgs, ...defaultArgs, ...userArgs],
  }
}

// ---- Core operations ----

function createInstance(opts: CreateOpts): ClaudeInstance {
  const id = genId()
  const cwd = opts.workingDirectory || HOME
  const cliBackend = resolveCliBackend(opts)
  instanceCounter++
  const defaultName =
    cliBackend === 'cursor-agent' ? `Cursor ${instanceCounter}` : `Claude ${instanceCounter}`
  const name = opts.name || defaultName
  const color = opts.color || nextColor()

  const defaultArgs = opts.defaultArgs || []
  const userArgs = opts.args || []
  const { command, argv } = buildSpawn(cliBackend, cwd, name, defaultArgs, userArgs, opts.model)

  log(`creating instance name="${name}" cwd=${cwd} cliBackend=${cliBackend} command=${command} args=${JSON.stringify(argv)}`)

  let ptyProcess: pty.IPty
  try {
    ptyProcess = pty.spawn(command, argv, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
      cwd,
      env: shellEnv,
    })
    log(`spawned ${command} pid=${ptyProcess.pid}`)
  } catch (err) {
    log(`failed to spawn ${command}: ${err}`)
    const instance: InternalInstance = {
      id, name, color, status: 'exited', activity: 'waiting',
      workingDirectory: cwd, createdAt: new Date().toISOString(),
      exitCode: -1, pid: null, args: argv, cliBackend,
      gitBranch: resolveGitBranchSync(cwd), gitRepo: resolveGitRepoSync(cwd),
      tokenUsage: { input: 0, output: 0 },
      pinned: false, mcpServers: [], roleTag: null,
      parentId: opts.parentId || null, childIds: [],
      pty: null, outputBuffer: [`Failed to spawn ${command}: ${err}\r\n`],
      cleanupTimer: null, _lastSnapshot: '', _lastBufferLen: 0, _activityInterval: null, _handoffRequested: false, _userInputReceived: false,
      _sessionIdTimer: null, comments: [], _lineBuffer: '', _gitBranchResolvedAt: Date.now(),
    }
    instances.set(id, instance)
    notifyListChanged()
    return toSerializable(instance)
  }

  const instance: InternalInstance = {
    id, name, color, status: 'running', activity: 'busy',
    workingDirectory: cwd, createdAt: new Date().toISOString(),
    exitCode: null, pid: ptyProcess.pid,
    args: argv, cliBackend, gitBranch: resolveGitBranchSync(cwd), gitRepo: resolveGitRepoSync(cwd),
    tokenUsage: { input: 0, output: 0 },
    pinned: false, mcpServers: [], roleTag: null,
    parentId: opts.parentId || null, childIds: [],
    pty: ptyProcess, outputBuffer: [],
    cleanupTimer: null, _lastSnapshot: '', _lastBufferLen: 0, _activityInterval: null, _handoffRequested: false, _userInputReceived: false,
    _sessionIdTimer: null, comments: [], _lineBuffer: '', _gitBranchResolvedAt: Date.now(),
  }

  // Register this child with its parent
  if (opts.parentId) {
    const parent = instances.get(opts.parentId)
    if (parent) {
      parent.childIds.push(id)
      notifyListChanged()
    }
  }

  instances.set(id, instance)

  // Stream output
  const ansiRegex = /\x1B\[[0-9;]*[a-zA-Z]|\x1B\][\s\S]*?(\x07|\x1B\\)/g
  const SENTINEL_PREFIX = 'COLONY_COMMENT:'
  ptyProcess.onData((data) => {
    // Fast path: send data immediately (keystroke echo path)
    instance.outputBuffer.push(data)
    if (instance.outputBuffer.length > 5000) {
      // Reassign instead of splice to avoid O(N) in-place shift
      instance.outputBuffer = instance.outputBuffer.slice(-2500)
    }
    broadcastEvent({ type: 'output', instanceId: id, data: Buffer.from(data).toString('base64') })

    // Defer heavy parsing: token usage, MCP servers, and sentinel extraction to next event loop
    // This keeps the keystroke echo path (10-20 bytes) off the blocking path
    setImmediate(() => {
      const clean = data.replace(ansiRegex, '')

      // Extract sentinel comments
      const lines = clean.split('\n')
      for (const line of lines) {
        const stripped = line.trim()
        if (stripped.startsWith(SENTINEL_PREFIX)) {
          const rest = stripped.slice(SENTINEL_PREFIX.length)
          const colonIdx1 = rest.indexOf(':')
          const colonIdx2 = colonIdx1 >= 0 ? rest.indexOf(':', colonIdx1 + 1) : -1
          const colonIdx3 = colonIdx2 >= 0 ? rest.indexOf(':', colonIdx2 + 1) : -1
          if (colonIdx1 > 0 && colonIdx2 > colonIdx1 && colonIdx3 > colonIdx2) {
            const file = rest.slice(0, colonIdx1)
            const lineNum = parseInt(rest.slice(colonIdx1 + 1, colonIdx2), 10)
            const sev = rest.slice(colonIdx2 + 1, colonIdx3)
            const message = rest.slice(colonIdx3 + 1)
            if (!isNaN(lineNum) && ['error', 'warn', 'info'].includes(sev) && message) {
              instance.comments.push({
                file,
                line: lineNum,
                severity: sev as ColonyComment['severity'],
                message,
              })
            }
          }
        }
      }

      // Parse token usage
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
  })

  // Color is tracked internally by Colony — no /color PTY write needed
  // (PTY writes show up in CLI history as user messages)

  const startupEnd = Date.now() + 15000

  // Activity detection — start fast (500ms) for snappy startup, slow to 2s after
  const FAST_INTERVAL = 500
  const NORMAL_INTERVAL = 2000
  let currentInterval = FAST_INTERVAL

  const activityCheck = () => {
    if (instance.status !== 'running') {
      if (instance._activityInterval) clearInterval(instance._activityInterval)
      return
    }

    // Switch to normal interval after startup window
    if (currentInterval === FAST_INTERVAL && Date.now() > startupEnd) {
      currentInterval = NORMAL_INTERVAL
      if (instance._activityInterval) clearInterval(instance._activityInterval)
      instance._activityInterval = setInterval(activityCheck, NORMAL_INTERVAL)
    }

    const currentLen = instance.outputBuffer.length
    const changed = currentLen !== instance._lastBufferLen
    instance._lastBufferLen = currentLen
    const newActivity = changed ? 'busy' : 'waiting'
    if (newActivity !== instance.activity) {
      instance.activity = newActivity
      broadcastEvent({ type: 'activity', instanceId: id, activity: newActivity })

      // Deliver pending steer message on transition to waiting
      if (newActivity === 'waiting' && instance.pendingSteer && instance.pty) {
        const steer = instance.pendingSteer
        instance.pendingSteer = undefined
        instance.pty.write(steer)
        notifyListChanged()
      }

      // When a child goes busy→waiting, ask it to write a handoff document
      // Use a flag to only do this once (not on the handoff write itself)
      if (newActivity === 'waiting' && instance.parentId && instance.pty && !instance._handoffRequested) {
        instance._handoffRequested = true
        const handoffDir = path.join(COLONY_DIR, 'handoffs')
        if (!fs.existsSync(handoffDir)) fs.mkdirSync(handoffDir, { recursive: true })
        const handoffPath = path.join(handoffDir, `${id}.md`)

        // Ask the child to write a handoff summary
        const handoffPrompt = `Write a concise handoff document to ${handoffPath} summarizing: 1) What you were asked to do, 2) What you did, 3) Key decisions made, 4) Current state / what's left. Use the Write tool to create the file. Keep it under 200 lines.\r`
        instance.pty.write(handoffPrompt)
        log(`asked child ${id} to write handoff to ${handoffPath}`)

        // Poll for the handoff file to appear, then notify parent
        let pollCount = 0
        const pollInterval = setInterval(() => {
          pollCount++
          if (fs.existsSync(handoffPath) || pollCount > 30) { // 30 * 2s = 60s max
            clearInterval(pollInterval)
            const parent = instances.get(instance.parentId!)
            if (parent?.pty && parent.status === 'running') {
              if (fs.existsSync(handoffPath)) {
                const relay = `Your child session "${instance.name}" has completed its work and written a handoff document. Read ${handoffPath} for a summary of what was done, decisions made, and current state. Then decide on next steps.\r`
                parent.pty.write(relay)
                log(`notified parent ${instance.parentId} to read handoff from child ${id}`)
              } else {
                const relay = `Your child session "${instance.name}" has completed but did not produce a handoff document. You may want to check its terminal output directly.\r`
                parent.pty.write(relay)
                log(`child ${id} did not produce handoff, notified parent ${instance.parentId}`)
              }
            }
          }
        }, 2000)
      }

      // Dismiss trust prompt on first waiting state
      if (newActivity === 'waiting' && instance.cliBackend === 'claude' && instance.pty && !instance._userInputReceived) {
        // Check recent output for trust prompt
        const recentOutput = instance.outputBuffer.slice(-30).join('')
        if (/trust|safety check/i.test(recentOutput)) {
          instance.pty.write('\r')
        }
      }
    }
  }
  instance._activityInterval = setInterval(activityCheck, FAST_INTERVAL)

  // Handle exit
  ptyProcess.onExit(({ exitCode }) => {
    if (instance._activityInterval) clearInterval(instance._activityInterval)
    if (instance._sessionIdTimer) clearTimeout(instance._sessionIdTimer)
    log(`instance ${id} (${name}) exited with code ${exitCode}`)
    instance.status = 'exited'
    instance.activity = 'waiting'
    instance.exitCode = exitCode
    instance.pty = null
    instance.pendingSteer = undefined
    instance.comments = []
    instance._lineBuffer = ''
    broadcastEvent({ type: 'exited', instanceId: id, exitCode })
    notifyListChanged()
  })

  // Discover Claude session ID via lsof ~5s after startup (used for --resume on restart)
  if (cliBackend === 'claude') {
    instance._sessionIdTimer = setTimeout(() => {
      instance._sessionIdTimer = null
      if (instance.lastSessionId || !instance.pid) return
      try {
        const lsofOut = execSync(`lsof -p ${instance.pid}`, { encoding: 'utf-8', timeout: 3000 })
        const m = lsofOut.match(/\.claude\/projects\/[^\s]+\/([a-f0-9-]{36})\.jsonl/i)
        if (m?.[1]) {
          instance.lastSessionId = m[1]
          log(`instance ${id}: discovered sessionId=${m[1]}`)
          notifyListChanged()
        }
      } catch { /* lsof unavailable or process already exited */ }
    }, 5000)
  }

  notifyListChanged()
  return toSerializable(instance)
}

function writeToInstance(id: string, data: string): boolean {
  const inst = instances.get(id)
  if (!inst?.pty) return false
  inst._userInputReceived = true
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
  if (inst._sessionIdTimer) clearTimeout(inst._sessionIdTimer)
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
  if (inst._sessionIdTimer) clearTimeout(inst._sessionIdTimer)
  if (inst.cleanupTimer) clearTimeout(inst.cleanupTimer)
  instances.delete(id)
  notifyListChanged()
  return true
}

function renameInstance(id: string, name: string): boolean {
  const inst = instances.get(id)
  if (!inst) return false
  const oldName = inst.name
  inst.name = name
  // Only send /rename when user explicitly renames (not at creation — --name handles that)
  // _userInputReceived means the session is past startup, so this is a user-initiated rename
  if (name !== oldName && inst.cliBackend === 'claude' && inst.pty && inst.status === 'running' && inst._userInputReceived) {
    inst.pty.write(`/rename ${name}\r`)
  }
  notifyListChanged()
  return true
}

function recolorInstance(id: string, color: string): boolean {
  const inst = instances.get(id)
  if (!inst) return false
  inst.color = color
  notifyListChanged()
  // Color tracked internally — no /color PTY write (shows in CLI history)
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

function setRoleTag(id: string, role: string | null): boolean {
  const inst = instances.get(id)
  if (!inst) return false
  inst.roleTag = role as typeof inst.roleTag
  notifyListChanged()
  return true
}

function steerInstance(id: string, message: string): boolean {
  const inst = instances.get(id)
  if (!inst || inst.status !== 'running') return false
  // Empty message = clear pending steer without delivering
  if (!message.trim()) {
    inst.pendingSteer = undefined
    notifyListChanged()
    return true
  }
  const prefixed = `[Operator steering]: ${message}\r`
  if (inst.activity === 'waiting' && inst.pty) {
    inst.pty.write(prefixed)
    inst.pendingSteer = undefined
  } else {
    // Queue for delivery when session next transitions to waiting
    inst.pendingSteer = prefixed
  }
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
  if (inst._sessionIdTimer) clearTimeout(inst._sessionIdTimer)

  // Filter out internal args (--add-dir, --name, --resume) that we re-add as needed
  const userArgs = inst.args.filter((arg, i, arr) => {
    if (arg === '--add-dir' || arg === '--name' || arg === '--resume') return false
    if (i > 0 && (arr[i - 1] === '--add-dir' || arr[i - 1] === '--name' || arr[i - 1] === '--resume')) return false
    return true
  })
  const dArgs = defaultArgs || []
  const filteredArgs = userArgs.filter((arg) => !dArgs.includes(arg))

  // Inject --resume when we have a session ID and this is a claude backend
  const resumeArgs = (inst.lastSessionId && inst.cliBackend === 'claude')
    ? ['--resume', inst.lastSessionId]
    : []

  const cliBackend = inst.cliBackend
  instances.delete(id)
  return createInstance({
    name: inst.name,
    workingDirectory: inst.workingDirectory,
    color: inst.color,
    args: [...resumeArgs, ...filteredArgs].length > 0 ? [...resumeArgs, ...filteredArgs] : undefined,
    defaultArgs: dArgs,
    cliBackend,
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
      case 'set-role': {
        const ok = setRoleTag(req.instanceId, req.role)
        send({ type: 'ok', reqId: req.reqId, data: ok })
        break
      }
      case 'steer': {
        const ok = steerInstance(req.instanceId, req.message)
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
      case 'get-comments': {
        const inst = instances.get(req.instanceId)
        send({ type: 'ok', reqId: req.reqId, data: inst ? [...inst.comments] : [] })
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
      case 'version': {
        send({ type: 'ok', reqId: req.reqId, data: { version: DAEMON_VERSION } })
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

const LOG_PATH = path.join(COLONY_DIR, 'daemon.log')

function log(msg: string): void {
  const ts = new Date().toISOString().substring(11, 23)
  const line = `[daemon ${ts}] ${msg}\n`
  try { fs.appendFileSync(LOG_PATH, line) } catch { /* */ }
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
    // Start async git branch resolver (never blocks event loop)
    startGitBranchRefresher()
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
