/**
 * DaemonClient — thin client that connects to the PTY daemon over Unix socket.
 * Replaces direct node-pty usage in the Electron main process.
 * If the daemon isn't running, it spawns one automatically.
 */

import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import type {
  ClaudeInstance,
  CreateOpts,
  DaemonRequest,
  DaemonMessage,
} from '../daemon/protocol'

const HOME = process.env.HOME || '/'
const SOCKET_PATH = path.join(HOME, '.claude-colony', 'daemon.sock')
const PID_PATH = path.join(HOME, '.claude-colony', 'daemon.pid')

type PendingRequest = {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Events emitted by DaemonClient:
 * - 'output'       (instanceId: string, data: string)  — raw terminal data (NOT base64)
 * - 'exited'       (instanceId: string, exitCode: number)
 * - 'activity'     (instanceId: string, activity: 'busy' | 'waiting')
 * - 'list-changed' (instances: ClaudeInstance[])
 * - 'connected'    ()
 * - 'disconnected' ()
 */
export class DaemonClient extends EventEmitter {
  private socket: net.Socket | null = null
  private pending = new Map<string, PendingRequest>()
  private buffer = ''
  private _connected = false
  private _reconnecting = false
  private _reqCounter = 0

  get connected(): boolean {
    return this._connected
  }

  // ---- Connection lifecycle ----

  async connect(): Promise<void> {
    await this.ensureDaemon()
    await this.connectToSocket()
    // Subscribe to real-time events
    await this.request({ type: 'subscribe', reqId: this.nextReqId() })
  }

  private async connectToSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH)
      let settled = false

      socket.on('connect', () => {
        this.socket = socket
        this._connected = true
        this.buffer = ''
        settled = true
        this.emit('connected')
        console.log('[daemon-client] connected to daemon')
        resolve()
      })

      socket.on('data', (chunk) => {
        this.buffer += chunk.toString()
        this.processBuffer()
      })

      socket.on('close', () => {
        this._connected = false
        this.socket = null
        // Reject all pending requests
        for (const [id, req] of this.pending) {
          clearTimeout(req.timer)
          req.reject(new Error('daemon connection closed'))
        }
        this.pending.clear()
        this.emit('disconnected')

        if (!settled) {
          settled = true
          reject(new Error('connection closed before established'))
        }

        // Auto-reconnect
        this.scheduleReconnect()
      })

      socket.on('error', (err) => {
        if (!settled) {
          settled = true
          reject(err)
        }
      })
    })
  }

  private scheduleReconnect(): void {
    if (this._reconnecting) return
    this._reconnecting = true
    console.log('[daemon-client] will attempt reconnect in 2s')
    setTimeout(async () => {
      this._reconnecting = false
      try {
        await this.connect()
        console.log('[daemon-client] reconnected')
      } catch (err) {
        console.error('[daemon-client] reconnect failed:', err)
        // Will retry on next operation or schedule again
      }
    }, 2000)
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    this._connected = false
  }

  // ---- Daemon process management ----

  private async ensureDaemon(): Promise<void> {
    // Check if daemon is already running via socket
    if (await this.isDaemonReachable()) return

    // Check PID file
    try {
      if (fs.existsSync(PID_PATH)) {
        const pid = parseInt(fs.readFileSync(PID_PATH, 'utf-8').trim(), 10)
        if (pid > 0) {
          try {
            process.kill(pid, 0) // check if alive
            // Process alive but socket not reachable — wait a moment and retry
            await this.sleep(500)
            if (await this.isDaemonReachable()) return
          } catch {
            // Process dead, clean up stale files
            try { fs.unlinkSync(PID_PATH) } catch { /* */ }
            try { fs.unlinkSync(SOCKET_PATH) } catch { /* */ }
          }
        }
      }
    } catch { /* */ }

    // Spawn new daemon
    await this.spawnDaemon()
  }

  private async isDaemonReachable(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!fs.existsSync(SOCKET_PATH)) {
        resolve(false)
        return
      }
      const sock = net.createConnection(SOCKET_PATH)
      const timeout = setTimeout(() => {
        sock.destroy()
        resolve(false)
      }, 1000)

      sock.on('connect', () => {
        clearTimeout(timeout)
        sock.destroy()
        resolve(true)
      })
      sock.on('error', () => {
        clearTimeout(timeout)
        resolve(false)
      })
    })
  }

  private async spawnDaemon(): Promise<void> {
    // Resolve daemon script path
    // electron-vite compiles it alongside main into out/main/daemon/pty-daemon.js
    // __dirname is out/main/ in both dev and prod
    const daemonScript = path.join(__dirname, 'daemon', 'pty-daemon.js')

    if (!fs.existsSync(daemonScript)) {
      throw new Error(`daemon script not found at ${daemonScript}`)
    }
    const scriptPath = daemonScript

    console.log(`[daemon-client] spawning daemon: ${process.execPath} ${scriptPath}`)

    const child = spawn(process.execPath, [scriptPath], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    })
    child.unref()

    // Wait for socket to appear
    const maxWait = 5000
    const start = Date.now()
    while (Date.now() - start < maxWait) {
      await this.sleep(100)
      if (await this.isDaemonReachable()) {
        console.log('[daemon-client] daemon is ready')
        return
      }
    }
    throw new Error('daemon did not start within 5 seconds')
  }

  // ---- NDJSON protocol ----

  private processBuffer(): void {
    let idx: number
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.substring(0, idx).trim()
      this.buffer = this.buffer.substring(idx + 1)
      if (!line) continue
      try {
        const msg = JSON.parse(line) as DaemonMessage
        this.handleMessage(msg)
      } catch (err) {
        console.error('[daemon-client] failed to parse message:', err)
      }
    }
  }

  private handleMessage(msg: DaemonMessage): void {
    // Response to a pending request
    if ('reqId' in msg && msg.reqId) {
      const pending = this.pending.get(msg.reqId)
      if (pending) {
        this.pending.delete(msg.reqId)
        clearTimeout(pending.timer)
        if (msg.type === 'error') {
          pending.reject(new Error(msg.message))
        } else {
          pending.resolve(msg.data)
        }
        return
      }
    }

    // Event
    switch (msg.type) {
      case 'output':
        // Decode base64 back to raw string for the renderer
        this.emit('output', msg.instanceId, Buffer.from(msg.data, 'base64').toString())
        break
      case 'exited':
        this.emit('exited', msg.instanceId, msg.exitCode)
        break
      case 'activity':
        this.emit('activity', msg.instanceId, msg.activity)
        break
      case 'list-changed':
        this.emit('list-changed', msg.instances)
        break
      case 'pong':
        break
    }
  }

  private nextReqId(): string {
    return `r${++this._reqCounter}`
  }

  private request(req: DaemonRequest, timeoutMs = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this._connected) {
        reject(new Error('not connected to daemon'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(req.reqId)
        reject(new Error(`request ${req.type} timed out`))
      }, timeoutMs)

      this.pending.set(req.reqId, { resolve, reject, timer })
      this.socket.write(JSON.stringify(req) + '\n')
    })
  }

  // ---- Public API (matches old instance-manager exports) ----

  async createInstance(opts: CreateOpts): Promise<ClaudeInstance> {
    const data = await this.request({
      type: 'create',
      reqId: this.nextReqId(),
      opts,
    })
    return data as ClaudeInstance
  }

  async writeToInstance(id: string, data: string): Promise<boolean> {
    const result = await this.request({
      type: 'write',
      reqId: this.nextReqId(),
      instanceId: id,
      data: Buffer.from(data).toString('base64'),
    })
    return result as boolean
  }

  async resizeInstance(id: string, cols: number, rows: number): Promise<boolean> {
    const result = await this.request({
      type: 'resize',
      reqId: this.nextReqId(),
      instanceId: id,
      cols,
      rows,
    })
    return result as boolean
  }

  async killInstance(id: string): Promise<boolean> {
    const result = await this.request({
      type: 'kill',
      reqId: this.nextReqId(),
      instanceId: id,
    })
    return result as boolean
  }

  async removeInstance(id: string): Promise<boolean> {
    const result = await this.request({
      type: 'remove',
      reqId: this.nextReqId(),
      instanceId: id,
    })
    return result as boolean
  }

  async renameInstance(id: string, name: string): Promise<boolean> {
    const result = await this.request({
      type: 'rename',
      reqId: this.nextReqId(),
      instanceId: id,
      name,
    })
    return result as boolean
  }

  async recolorInstance(id: string, color: string): Promise<boolean> {
    const result = await this.request({
      type: 'recolor',
      reqId: this.nextReqId(),
      instanceId: id,
      color,
    })
    return result as boolean
  }

  async restartInstance(id: string, defaultArgs?: string[]): Promise<ClaudeInstance | null> {
    const data = await this.request({
      type: 'restart',
      reqId: this.nextReqId(),
      instanceId: id,
      defaultArgs,
    })
    return data as ClaudeInstance | null
  }

  async pinInstance(id: string): Promise<boolean> {
    const result = await this.request({
      type: 'pin',
      reqId: this.nextReqId(),
      instanceId: id,
    })
    return result as boolean
  }

  async unpinInstance(id: string): Promise<boolean> {
    const result = await this.request({
      type: 'unpin',
      reqId: this.nextReqId(),
      instanceId: id,
    })
    return result as boolean
  }

  async getAllInstances(): Promise<ClaudeInstance[]> {
    const data = await this.request({
      type: 'list',
      reqId: this.nextReqId(),
    })
    return (data as ClaudeInstance[]) || []
  }

  async getInstance(id: string): Promise<ClaudeInstance | null> {
    const data = await this.request({
      type: 'get',
      reqId: this.nextReqId(),
      instanceId: id,
    })
    return data as ClaudeInstance | null
  }

  async getInstanceBuffer(id: string): Promise<string> {
    const data = await this.request({
      type: 'buffer',
      reqId: this.nextReqId(),
      instanceId: id,
    })
    // Daemon sends base64-encoded buffer
    return data ? Buffer.from(data as string, 'base64').toString() : ''
  }

  async shutdownDaemon(): Promise<void> {
    try {
      await this.request({ type: 'shutdown', reqId: this.nextReqId() }, 3000)
    } catch {
      // daemon may already be gone
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// Singleton instance
let client: DaemonClient | null = null

export function getDaemonClient(): DaemonClient {
  if (!client) {
    client = new DaemonClient()
  }
  return client
}
