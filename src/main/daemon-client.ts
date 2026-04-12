/**
 * DaemonClient — PTY daemon client over Unix socket.
 * Extends BaseDaemonClient for socket lifecycle, NDJSON, and auto-reconnect.
 */

import type { ClaudeInstance, CreateOpts } from '../daemon/protocol'
import type { ColonyComment } from '../shared/types'
import { colonyPaths } from '../shared/colony-paths'
import { BaseDaemonClient } from './base-daemon-client'

export interface DaemonClientOpts {
  socketPath?: string
  pidPath?: string
  daemonId?: string
}

export class DaemonClient extends BaseDaemonClient {
  protected socketPath: string
  protected pidPath: string
  protected daemonScriptName = 'pty-daemon.js'
  protected label: string
  private _daemonId: string
  private _extraEnv: Record<string, string>

  constructor(opts?: DaemonClientOpts) {
    super()
    this._daemonId = opts?.daemonId ?? 'primary'
    this.socketPath = opts?.socketPath ?? colonyPaths.daemonSock
    this.pidPath = opts?.pidPath ?? colonyPaths.daemonPid
    this.label = `daemon-client:${this._daemonId}`
    this._extraEnv = {
      COLONY_DAEMON_SOCK: this.socketPath,
      COLONY_DAEMON_PID: this.pidPath,
      COLONY_DAEMON_ID: this._daemonId,
    }
  }

  get daemonId(): string { return this._daemonId }

  protected daemonSpawnEnv(): Record<string, string> {
    return this._extraEnv
  }

  protected handleEvent(msg: any): void {
    switch (msg.type) {
      case 'output':
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
      case 'comments':
        this.emit('comments', msg.instanceId, msg.comments)
        break
      case 'tool-deferred':
        this.emit('tool-deferred', msg.instanceId, msg.sessionId, msg.toolName)
        break
      case 'rateLimitDetected':
        this.emit('rateLimitDetected', msg.instanceId, msg.retryAfterSecs, msg.rawMessage)
        break
      case 'pong':
        break
    }
  }

  // ---- Public API ----

  async createInstance(opts: CreateOpts): Promise<ClaudeInstance> {
    return await this.request({ type: 'create', reqId: this.nextReqId(), opts }) as ClaudeInstance
  }

  async writeToInstance(id: string, data: string): Promise<boolean> {
    return await this.request({
      type: 'write', reqId: this.nextReqId(), instanceId: id,
      data: Buffer.from(data).toString('base64'),
    }) as boolean
  }

  async resizeInstance(id: string, cols: number, rows: number): Promise<boolean> {
    return await this.request({ type: 'resize', reqId: this.nextReqId(), instanceId: id, cols, rows }) as boolean
  }

  async killInstance(id: string): Promise<boolean> {
    return await this.request({ type: 'kill', reqId: this.nextReqId(), instanceId: id }) as boolean
  }

  async removeInstance(id: string): Promise<boolean> {
    return await this.request({ type: 'remove', reqId: this.nextReqId(), instanceId: id }) as boolean
  }

  async renameInstance(id: string, name: string): Promise<boolean> {
    return await this.request({ type: 'rename', reqId: this.nextReqId(), instanceId: id, name }) as boolean
  }

  async recolorInstance(id: string, color: string): Promise<boolean> {
    return await this.request({ type: 'recolor', reqId: this.nextReqId(), instanceId: id, color }) as boolean
  }

  async restartInstance(id: string, defaultArgs?: string[]): Promise<ClaudeInstance | null> {
    return await this.request({ type: 'restart', reqId: this.nextReqId(), instanceId: id, defaultArgs }) as ClaudeInstance | null
  }

  async pinInstance(id: string): Promise<boolean> {
    return await this.request({ type: 'pin', reqId: this.nextReqId(), instanceId: id }) as boolean
  }

  async setNote(id: string, note: string): Promise<boolean> {
    return await this.request({ type: 'set-note', reqId: this.nextReqId(), instanceId: id, note }) as boolean
  }

  async unpinInstance(id: string): Promise<boolean> {
    return await this.request({ type: 'unpin', reqId: this.nextReqId(), instanceId: id }) as boolean
  }

  async setInstanceRole(id: string, role: string | null): Promise<boolean> {
    return await this.request({ type: 'set-role', reqId: this.nextReqId(), instanceId: id, role }) as boolean
  }

  async steerInstance(id: string, message: string): Promise<boolean> {
    return await this.request({ type: 'steer', reqId: this.nextReqId(), instanceId: id, message }) as boolean
  }

  async getAllInstances(): Promise<ClaudeInstance[]> {
    return (await this.request({ type: 'list', reqId: this.nextReqId() }) as ClaudeInstance[]) || []
  }

  async getInstance(id: string): Promise<ClaudeInstance | null> {
    return await this.request({ type: 'get', reqId: this.nextReqId(), instanceId: id }) as ClaudeInstance | null
  }

  async getInstanceBuffer(id: string): Promise<string> {
    const data = await this.request({ type: 'buffer', reqId: this.nextReqId(), instanceId: id })
    return data ? Buffer.from(data as string, 'base64').toString() : ''
  }

  async getInstanceComments(id: string): Promise<ColonyComment[]> {
    return (await this.request({ type: 'get-comments', reqId: this.nextReqId(), instanceId: id }) as ColonyComment[]) || []
  }

  async clearToolDeferred(id: string): Promise<boolean> {
    return await this.request({ type: 'clear-tool-deferred', reqId: this.nextReqId(), instanceId: id }) as boolean
  }

  async drainDaemon(): Promise<{ draining: boolean; remaining: number }> {
    return await this.request({ type: 'drain', reqId: this.nextReqId() }) as { draining: boolean; remaining: number }
  }

  async shutdownDaemon(): Promise<void> {
    try {
      await this.request({ type: 'shutdown', reqId: this.nextReqId() }, 3000)
    } catch { /* daemon may already be gone */ }
  }
}

// ---- Singleton ----

let _client: DaemonClient | null = null

export function getDaemonClient(): DaemonClient {
  if (!_client) {
    _client = new DaemonClient()
  }
  return _client
}
