/**
 * Base daemon client — shared socket lifecycle, NDJSON protocol, auto-reconnect, and process management.
 * Subclasses provide: socket/PID paths, daemon script name, message handling, and public API.
 */

import * as net from 'net'
import * as fs from 'fs'
import * as path from 'path'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import { DAEMON_VERSION } from '../daemon/protocol'

export type PendingRequest = {
  resolve: (data: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export abstract class BaseDaemonClient extends EventEmitter {
  private socket: net.Socket | null = null
  private pending = new Map<string, PendingRequest>()
  private buffer = ''
  private _connected = false
  private _reconnecting = false
  private _reqCounter = 0

  protected abstract socketPath: string
  protected abstract pidPath: string
  protected abstract daemonScriptName: string // e.g. 'pty-daemon.js'
  protected abstract label: string            // e.g. 'daemon-client'

  /** Subclass handles event dispatch for daemon-specific message types */
  protected abstract handleEvent(msg: any): void

  get connected(): boolean {
    return this._connected
  }

  // ---- Connection lifecycle ----

  async connect(): Promise<void> {
    await this.ensureDaemon()
    await this.connectToSocket()
    await this.request({ type: 'subscribe', reqId: this.nextReqId() })
    this.checkDaemonVersion()
  }

  /** Ask the daemon its version — emit 'version-mismatch' if stale. */
  private async checkDaemonVersion(): Promise<void> {
    try {
      const res = await this.request({ type: 'version', reqId: this.nextReqId() }) as { version?: number } | undefined
      const daemonVersion = res?.version ?? 0
      if (daemonVersion !== DAEMON_VERSION) {
        console.warn(`[${this.label}] daemon version mismatch: running=${daemonVersion} expected=${DAEMON_VERSION}`)
        this.emit('version-mismatch', { running: daemonVersion, expected: DAEMON_VERSION })
      } else {
        console.log(`[${this.label}] daemon version OK: ${daemonVersion}`)
      }
    } catch {
      // Old daemon without version support — always stale
      console.warn(`[${this.label}] daemon does not support version check — needs restart`)
      this.emit('version-mismatch', { running: 0, expected: DAEMON_VERSION })
    }
  }

  private async connectToSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath)
      let settled = false

      socket.on('connect', () => {
        this.socket = socket
        this._connected = true
        this.buffer = ''
        settled = true
        this.emit('connected')
        console.log(`[${this.label}] connected to daemon`)
        resolve()
      })

      socket.on('data', (chunk) => {
        this.buffer += chunk.toString()
        // Safety cap — if buffer exceeds 50MB without a newline, something is broken
        if (this.buffer.length > 50 * 1024 * 1024) {
          console.error(`[${this.label}] buffer overflow (${this.buffer.length} bytes), resetting`)
          this.buffer = ''
          return
        }
        this.processBuffer()
      })

      socket.on('close', () => {
        this._connected = false
        this.socket = null
        for (const [, req] of this.pending) {
          clearTimeout(req.timer)
          req.reject(new Error('daemon connection closed'))
        }
        this.pending.clear()
        this.emit('disconnected')

        if (!settled) {
          settled = true
          reject(new Error('connection closed before established'))
        }

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
    console.log(`[${this.label}] will attempt reconnect in 2s`)
    setTimeout(async () => {
      this._reconnecting = false
      try {
        await this.connect()
        console.log(`[${this.label}] reconnected`)
      } catch (err) {
        console.error(`[${this.label}] reconnect failed:`, err)
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
    if (await this.isDaemonReachable()) return

    try {
      if (fs.existsSync(this.pidPath)) {
        const pid = parseInt(fs.readFileSync(this.pidPath, 'utf-8').trim(), 10)
        if (pid > 0) {
          try {
            process.kill(pid, 0)
            await this.sleep(500)
            if (await this.isDaemonReachable()) return
          } catch {
            try { fs.unlinkSync(this.pidPath) } catch { /* */ }
            try { fs.unlinkSync(this.socketPath) } catch { /* */ }
          }
        }
      }
    } catch { /* */ }

    await this.spawnDaemon()
  }

  private async isDaemonReachable(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!fs.existsSync(this.socketPath)) {
        resolve(false)
        return
      }
      const sock = net.createConnection(this.socketPath)
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
    const daemonScript = path.join(__dirname, 'daemon', this.daemonScriptName)

    if (!fs.existsSync(daemonScript)) {
      throw new Error(`daemon script not found at ${daemonScript}`)
    }

    console.log(`[${this.label}] spawning daemon: ${process.execPath} ${daemonScript}`)

    const child = spawn(process.execPath, [daemonScript], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    })
    child.unref()

    const maxWait = 5000
    const start = Date.now()
    while (Date.now() - start < maxWait) {
      await this.sleep(100)
      if (await this.isDaemonReachable()) {
        console.log(`[${this.label}] daemon is ready`)
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
        const msg = JSON.parse(line)
        this.handleMessage(msg)
      } catch (err) {
        console.error(`[${this.label}] failed to parse message:`, err)
      }
    }
  }

  private handleMessage(msg: any): void {
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

    // Delegate event handling to subclass
    this.handleEvent(msg)
  }

  // ---- Request/response ----

  request(payload: Record<string, unknown>, timeoutMs = 10000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this._connected) {
        reject(new Error('not connected to daemon'))
        return
      }

      const reqId = payload.reqId as string || this.nextReqId()
      payload.reqId = reqId

      const timer = setTimeout(() => {
        this.pending.delete(reqId)
        reject(new Error(`request ${payload.type} timed out after ${timeoutMs}ms`))
      }, timeoutMs)

      this.pending.set(reqId, { resolve, reject, timer })
      this.socket.write(JSON.stringify(payload) + '\n')
    })
  }

  protected nextReqId(): string {
    return `req-${++this._reqCounter}-${Date.now()}`
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
