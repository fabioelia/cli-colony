/**
 * DAP (Debug Adapter Protocol) client over TCP.
 *
 * Connects to Node Inspector or debugpy debug adapters.
 * Uses Content-Length framing (same as LSP/DAP wire format):
 *   Content-Length: <n>\r\n\r\n<JSON body>
 */

import * as net from 'net'
import { EventEmitter } from 'events'

export interface DapMessage {
  seq: number
  type: 'request' | 'response' | 'event'
  [key: string]: unknown
}

export interface DapResponse {
  seq: number
  type: 'response'
  request_seq: number
  success: boolean
  command: string
  body?: Record<string, unknown>
  message?: string
}

export interface DapEvent {
  seq: number
  type: 'event'
  event: string
  body?: Record<string, unknown>
}

export class DapClient extends EventEmitter {
  private socket: net.Socket | null = null
  private seq = 1
  private pending = new Map<number, { resolve: (r: DapResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private buffer = ''
  private connected = false

  constructor(
    private host: string,
    private port: number,
    private timeoutMs = 10000,
  ) {
    super()
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.host, port: this.port }, () => {
        this.connected = true
        resolve()
      })
      socket.on('error', (err) => {
        if (!this.connected) {
          reject(err)
        } else {
          this.emit('error', err)
        }
      })
      socket.on('close', () => {
        this.connected = false
        this.emit('close')
        // Reject all pending requests
        for (const [, p] of this.pending) {
          clearTimeout(p.timer)
          p.reject(new Error('connection closed'))
        }
        this.pending.clear()
      })
      socket.on('data', (chunk) => this.onData(chunk.toString()))
      this.socket = socket
    })
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
      this.connected = false
    }
  }

  isConnected(): boolean {
    return this.connected
  }

  /** Send a DAP request and wait for the matching response. */
  async request(command: string, args?: Record<string, unknown>): Promise<DapResponse> {
    if (!this.socket || !this.connected) throw new Error('not connected')

    const seq = this.seq++
    const msg: Record<string, unknown> = { seq, type: 'request', command }
    if (args) msg.arguments = args

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`DAP request '${command}' timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)

      this.pending.set(seq, { resolve, reject, timer })
      this.send(msg)
    })
  }

  private send(msg: Record<string, unknown>): void {
    const body = JSON.stringify(msg)
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`
    this.socket!.write(header + body)
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    while (this.parseMessage()) { /* keep parsing */ }
  }

  private parseMessage(): boolean {
    const headerEnd = this.buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return false

    const header = this.buffer.slice(0, headerEnd)
    const match = /Content-Length:\s*(\d+)/i.exec(header)
    if (!match) {
      // Malformed header — skip to after the double newline
      this.buffer = this.buffer.slice(headerEnd + 4)
      return true
    }

    const contentLength = parseInt(match[1], 10)
    const bodyStart = headerEnd + 4
    if (this.buffer.length < bodyStart + contentLength) return false // incomplete body

    const body = this.buffer.slice(bodyStart, bodyStart + contentLength)
    this.buffer = this.buffer.slice(bodyStart + contentLength)

    try {
      const msg = JSON.parse(body) as DapMessage
      this.handleMessage(msg)
    } catch {
      // Malformed JSON — discard
    }

    return true
  }

  private handleMessage(msg: DapMessage): void {
    if (msg.type === 'response') {
      const resp = msg as DapResponse
      const p = this.pending.get(resp.request_seq)
      if (p) {
        clearTimeout(p.timer)
        this.pending.delete(resp.request_seq)
        p.resolve(resp)
      }
    } else if (msg.type === 'event') {
      this.emit('event', msg as DapEvent)
    }
  }
}
