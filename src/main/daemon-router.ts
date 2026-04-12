/**
 * DaemonRouter — manages one or two PTY daemon clients for rolling upgrades.
 *
 * During normal operation, routes all traffic to the primary daemon.
 * During a rolling upgrade:
 *   1. A "next" daemon is spawned on a separate socket
 *   2. New instance creates go to the next daemon
 *   3. The primary daemon enters drain mode (rejects creates, auto-shuts-down when empty)
 *   4. When the primary drains, the next daemon is promoted to primary
 */

import { EventEmitter } from 'events'
import { DaemonClient } from './daemon-client'
import { colonyPaths } from '../shared/colony-paths'
import type { ClaudeInstance, CreateOpts } from '../daemon/protocol'
import type { ColonyComment } from '../shared/types'

export type UpgradeState = 'idle' | 'upgrading' | 'draining'

export class DaemonRouter extends EventEmitter {
  private primary: DaemonClient
  private next: DaemonClient | null = null
  private _upgradeState: UpgradeState = 'idle'
  private _drainRemaining = 0
  /** Cache: instanceId → daemonId for routing */
  private _instanceDaemonMap = new Map<string, string>()

  constructor() {
    super()
    this.primary = new DaemonClient()
  }

  get upgradeState(): UpgradeState { return this._upgradeState }
  get drainRemaining(): number { return this._drainRemaining }

  // ---- Routing helpers ----

  /** Get the client that owns a specific instance */
  private clientFor(instanceId: string): DaemonClient {
    const daemonId = this._instanceDaemonMap.get(instanceId)
    if (daemonId && this.next && daemonId === this.next.daemonId) return this.next
    return this.primary
  }

  /** The client used for new creates (next daemon if upgrading, else primary) */
  private get activeClient(): DaemonClient {
    return (this._upgradeState !== 'idle' && this.next) ? this.next : this.primary
  }

  /** Rebuild instance → daemon mapping from both daemons */
  private async refreshInstanceMap(): Promise<void> {
    const map = new Map<string, string>()
    try {
      const primary = await this.primary.getAllInstances()
      for (const inst of primary) map.set(inst.id, inst.daemonId || 'primary')
    } catch { /* primary may be gone during upgrade */ }
    if (this.next) {
      try {
        const next = await this.next.getAllInstances()
        for (const inst of next) map.set(inst.id, inst.daemonId || this.next.daemonId)
      } catch { /* */ }
    }
    this._instanceDaemonMap = map
  }

  // ---- Lifecycle ----

  async connect(): Promise<void> {
    await this.primary.connect()
  }

  disconnect(): void {
    this.primary.disconnect()
    this.next?.disconnect()
  }

  // ---- Event wiring ----

  wireEvents(client: DaemonClient): void {
    client.on('output', (id: string, data: string) => this.emit('output', id, data))
    client.on('exited', (id: string, code: number) => {
      this.emit('exited', id, code)
      // During drain, check if old daemon is done
      if (this._upgradeState === 'draining' && client === this.primary) {
        this.checkDrainComplete()
      }
    })
    client.on('activity', (id: string, act: string) => this.emit('activity', id, act))
    client.on('list-changed', () => {
      // Merge lists from both daemons and re-emit
      this.getAllInstances().then(all => this.emit('list-changed', all)).catch(() => {})
    })
    client.on('comments', (id: string, comments: ColonyComment[]) => this.emit('comments', id, comments))
    client.on('tool-deferred', (id: string, sid: string, tool?: string) => this.emit('tool-deferred', id, sid, tool))
    client.on('rateLimitDetected', (id: string, retryAfterSecs: number | null, rawMessage: string) => this.emit('rateLimitDetected', id, retryAfterSecs, rawMessage))
    client.on('version-mismatch', (info: { running: number; expected: number }) => {
      // Only emit mismatch from primary — the next daemon is always the right version
      if (client === this.primary) this.emit('version-mismatch', info)
    })
    client.on('disconnected', () => {
      if (client === this.primary && this._upgradeState === 'draining') {
        // Primary disconnected during drain — it shut itself down
        this.promoteNext()
      } else {
        this.emit('disconnected')
      }
    })
    client.on('connected', () => this.emit('connected'))
    client.on('connection-failed', () => {
      if (client === this.primary && this._upgradeState === 'draining') {
        // Primary failed to reconnect during drain — it's gone
        this.promoteNext()
      } else {
        this.emit('connection-failed')
      }
    })
    client.on('daemon-unresponsive', () => this.emit('daemon-unresponsive'))
  }

  // ---- Merged instance list ----

  async getAllInstances(): Promise<ClaudeInstance[]> {
    const primary = await this.primary.getAllInstances().catch(() => [])
    const next = this.next ? await this.next.getAllInstances().catch(() => []) : []
    const all = [...primary, ...next]
    // Update routing cache
    for (const inst of all) {
      this._instanceDaemonMap.set(inst.id, inst.daemonId || 'primary')
    }
    return all
  }

  // ---- Routed instance methods ----

  async createInstance(opts: CreateOpts): Promise<ClaudeInstance> {
    const inst = await this.activeClient.createInstance(opts)
    this._instanceDaemonMap.set(inst.id, inst.daemonId || this.activeClient.daemonId)
    return inst
  }

  async writeToInstance(id: string, data: string): Promise<boolean> {
    return this.clientFor(id).writeToInstance(id, data)
  }

  async resizeInstance(id: string, cols: number, rows: number): Promise<boolean> {
    return this.clientFor(id).resizeInstance(id, cols, rows)
  }

  async killInstance(id: string): Promise<boolean> {
    return this.clientFor(id).killInstance(id)
  }

  async removeInstance(id: string): Promise<boolean> {
    const result = await this.clientFor(id).removeInstance(id)
    this._instanceDaemonMap.delete(id)
    return result
  }

  async renameInstance(id: string, name: string): Promise<boolean> {
    return this.clientFor(id).renameInstance(id, name)
  }

  async recolorInstance(id: string, color: string): Promise<boolean> {
    return this.clientFor(id).recolorInstance(id, color)
  }

  async restartInstance(id: string, defaultArgs?: string[]): Promise<ClaudeInstance | null> {
    return this.clientFor(id).restartInstance(id, defaultArgs)
  }

  async pinInstance(id: string): Promise<boolean> {
    return this.clientFor(id).pinInstance(id)
  }

  async unpinInstance(id: string): Promise<boolean> {
    return this.clientFor(id).unpinInstance(id)
  }

  async setNote(id: string, note: string): Promise<boolean> {
    return this.clientFor(id).setNote(id, note)
  }

  async setInstanceRole(id: string, role: string | null): Promise<boolean> {
    return this.clientFor(id).setInstanceRole(id, role)
  }

  async steerInstance(id: string, message: string): Promise<boolean> {
    return this.clientFor(id).steerInstance(id, message)
  }

  async getInstance(id: string): Promise<ClaudeInstance | null> {
    return this.clientFor(id).getInstance(id)
  }

  async getInstanceBuffer(id: string): Promise<string> {
    return this.clientFor(id).getInstanceBuffer(id)
  }

  async getInstanceComments(id: string): Promise<ColonyComment[]> {
    return this.clientFor(id).getInstanceComments(id)
  }

  async clearToolDeferred(id: string): Promise<boolean> {
    return this.clientFor(id).clearToolDeferred(id)
  }

  async shutdownDaemon(): Promise<void> {
    await this.primary.shutdownDaemon()
    if (this.next) await this.next.shutdownDaemon()
  }

  /** Request helper — routes to the correct daemon for an instance (used by IPC handlers) */
  async request(payload: Record<string, unknown>, instanceId?: string): Promise<unknown> {
    const client = instanceId ? this.clientFor(instanceId) : this.primary
    return client.request(payload)
  }

  /** Expose primary client for backward compat with code that needs a raw DaemonClient */
  get primaryClient(): DaemonClient { return this.primary }

  killDaemonProcess(): void {
    this.primary.killDaemonProcess()
  }

  // ---- Rolling upgrade orchestration ----

  async startUpgrade(): Promise<void> {
    if (this._upgradeState !== 'idle') return
    this._upgradeState = 'upgrading'
    this.emit('upgrade-started')
    console.log('[daemon-router] starting rolling upgrade')

    // 1. Spawn new daemon on "next" socket
    this.next = new DaemonClient({
      socketPath: colonyPaths.daemonNextSock,
      pidPath: colonyPaths.daemonNextPid,
      daemonId: 'next',
    })
    this.wireEvents(this.next)
    await this.next.connect()

    // 2. Put old daemon in drain mode
    this._upgradeState = 'draining'
    try {
      const drainResult = await this.primary.drainDaemon()
      this._drainRemaining = drainResult.remaining
    } catch {
      // Old daemon may not support drain — fall back to immediate shutdown
      this._drainRemaining = 0
    }

    this.emit('upgrade-draining', { remaining: this._drainRemaining })
    console.log(`[daemon-router] old daemon draining, ${this._drainRemaining} instances remaining`)

    // 3. If already empty, promote immediately
    if (this._drainRemaining === 0) {
      await this.promoteNext()
    }
  }

  /** Migrate a specific instance from old daemon to new daemon */
  async migrateInstance(instanceId: string): Promise<ClaudeInstance | null> {
    if (!this.next || this._upgradeState === 'idle') return null

    // 1. Get instance metadata from old daemon
    const inst = await this.primary.getInstance(instanceId)
    if (!inst) return null

    // 2. Get output buffer so we can replay it
    const buffer = await this.primary.getInstanceBuffer(instanceId)

    // 3. Kill on old daemon (clean exit)
    await this.primary.killInstance(instanceId)

    // 4. Recreate on new daemon with --resume if session ID available
    const resumeArgs: string[] = inst.lastSessionId
      ? ['--resume', inst.lastSessionId]
      : []

    const newInst = await this.next.createInstance({
      name: inst.name,
      workingDirectory: inst.workingDirectory,
      color: inst.color,
      args: resumeArgs.length > 0 ? resumeArgs : undefined,
      cliBackend: inst.cliBackend,
      permissionMode: inst.permissionMode,
      parentId: inst.parentId || undefined,
    })

    // Update routing cache
    this._instanceDaemonMap.delete(instanceId)
    this._instanceDaemonMap.set(newInst.id, 'next')

    this.emit('instance-migrated', { oldId: instanceId, newId: newInst.id, buffer })
    return newInst
  }

  /** Migrate all running instances from old daemon to new */
  async migrateAll(): Promise<void> {
    if (!this.next || this._upgradeState === 'idle') return
    const instances = await this.primary.getAllInstances().catch(() => [])
    for (const inst of instances) {
      if (inst.status === 'running') {
        await this.migrateInstance(inst.id).catch(err => {
          console.error(`[daemon-router] failed to migrate ${inst.id}:`, err)
        })
      }
    }
  }

  private async checkDrainComplete(): Promise<void> {
    if (this._upgradeState !== 'draining') return
    try {
      const remaining = await this.primary.getAllInstances()
      const running = remaining.filter(i => i.status === 'running')
      this._drainRemaining = running.length
      this.emit('upgrade-draining', { remaining: running.length })
      if (running.length === 0) {
        await this.promoteNext()
      }
    } catch {
      // Old daemon already shut down
      await this.promoteNext()
    }
  }

  private async promoteNext(): Promise<void> {
    if (!this.next) return
    console.log('[daemon-router] promoting next daemon to primary')

    // Disconnect old daemon (intentional — don't reconnect)
    this.primary.disconnect()

    // Promote
    this.primary = this.next
    this.next = null
    this._upgradeState = 'idle'
    this._drainRemaining = 0

    // Refresh routing cache
    await this.refreshInstanceMap()

    this.emit('upgrade-complete')
    console.log('[daemon-router] rolling upgrade complete')
  }

  getUpgradeStatus(): { state: UpgradeState; remaining: number } {
    return { state: this._upgradeState, remaining: this._drainRemaining }
  }
}

// ---- Singleton ----

let _router: DaemonRouter | null = null

export function getDaemonRouter(): DaemonRouter {
  if (!_router) {
    _router = new DaemonRouter()
  }
  return _router
}
