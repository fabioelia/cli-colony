/**
 * EnvDaemonClient — environment daemon client over Unix socket.
 * Extends BaseDaemonClient for socket lifecycle, NDJSON, and auto-reconnect.
 */

import type { InstanceManifest, EnvStatus } from '../daemon/env-protocol'
import { colonyPaths } from '../shared/colony-paths'
import { BaseDaemonClient } from './base-daemon-client'

export class EnvDaemonClient extends BaseDaemonClient {
  protected socketPath = colonyPaths.envdSock
  protected pidPath = colonyPaths.envdPid
  protected daemonScriptName = 'env-daemon.js'
  protected label = 'env-daemon-client'

  protected handleEvent(msg: any): void {
    switch (msg.type) {
      case 'env-changed':
        this.emit('env-changed', msg.environments)
        break
      case 'service-output':
        this.emit('service-output', msg.envId, msg.service, msg.data)
        break
      case 'service-crashed':
        this.emit('service-crashed', msg.envId, msg.service, msg.exitCode)
        break
      case 'pong':
        break
    }
  }

  // ---- Public API ----

  async register(manifest: InstanceManifest): Promise<void> {
    await this.request({ type: 'register', reqId: this.nextReqId(), manifest })
  }

  async unregister(envId: string): Promise<boolean> {
    return (await this.request({ type: 'unregister', reqId: this.nextReqId(), envId })) as boolean
  }

  async start(envId: string, services?: string[]): Promise<void> {
    // Start runs preStart hooks + waits up to 60s per wave — needs a generous timeout
    await this.request({ type: 'start', reqId: this.nextReqId(), envId, services }, 120000)
  }

  async stop(envId: string, services?: string[]): Promise<void> {
    await this.request({ type: 'stop', reqId: this.nextReqId(), envId, services })
  }

  async restartService(envId: string, service: string): Promise<void> {
    await this.request({ type: 'restart-service', reqId: this.nextReqId(), envId, service })
  }

  async status(): Promise<EnvStatus[]> {
    return (await this.request({ type: 'status', reqId: this.nextReqId() })) as EnvStatus[]
  }

  async statusOne(envId: string): Promise<EnvStatus | null> {
    return (await this.request({ type: 'status-one', reqId: this.nextReqId(), envId })) as EnvStatus | null
  }

  async logs(envId: string, service: string, lines?: number): Promise<string> {
    return (await this.request({ type: 'logs', reqId: this.nextReqId(), envId, service, lines })) as string
  }

  async ping(): Promise<void> {
    await this.request({ type: 'ping', reqId: this.nextReqId() })
  }

  async teardown(envId: string): Promise<void> {
    await this.request({ type: 'teardown', reqId: this.nextReqId(), envId }, 30000)
  }

  async shutdown(): Promise<void> {
    await this.request({ type: 'shutdown', reqId: this.nextReqId() })
  }
}

// ---- Singleton ----

let _envClient: EnvDaemonClient | null = null

export function getEnvDaemonClient(): EnvDaemonClient {
  if (!_envClient) {
    _envClient = new EnvDaemonClient()
  }
  return _envClient
}
