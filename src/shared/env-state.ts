/**
 * Environment state file format — lives at <env-dir>/state.json alongside instance.json.
 *
 * This is the source of truth for runtime service state. The daemon writes it,
 * and any process can read it. Survives daemon restarts.
 */

import * as fs from 'fs'
import * as path from 'path'

export interface ServiceState {
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  pid: number | null
  port: number | null
  startedAt: number | null  // epoch ms
  restarts: number
}

export interface EnvState {
  /** Environment ID */
  envId: string
  /** Per-service runtime state */
  services: Record<string, ServiceState>
  /** Whether services should be running (for auto-restart on daemon boot) */
  shouldBeRunning: boolean
  /** Last time this file was written */
  updatedAt: string
}

const STATE_FILENAME = 'state.json'

export function stateFilePath(envDir: string): string {
  return path.join(envDir, STATE_FILENAME)
}

export function readState(envDir: string): EnvState | null {
  const p = stateFilePath(envDir)
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf-8'))
    }
  } catch { /* corrupt or missing */ }
  return null
}

export function writeState(envDir: string, state: EnvState): void {
  const p = stateFilePath(envDir)
  state.updatedAt = new Date().toISOString()
  try {
    fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    console.error(`[env-state] failed to write ${p}:`, err)
  }
}

/** Check if a PID is still alive */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Build an initial empty state for an environment.
 */
export function emptyState(envId: string, serviceNames: string[]): EnvState {
  const services: Record<string, ServiceState> = {}
  for (const name of serviceNames) {
    services[name] = { status: 'stopped', pid: null, port: null, startedAt: null, restarts: 0 }
  }
  return { envId, services, shouldBeRunning: false, updatedAt: new Date().toISOString() }
}

/**
 * Read state and reconcile with reality — mark services whose PIDs are dead as crashed/stopped.
 */
export function readAndReconcileState(envDir: string): EnvState | null {
  const state = readState(envDir)
  if (!state) return null

  let changed = false
  for (const [name, svc] of Object.entries(state.services)) {
    if (svc.pid != null && svc.status === 'running') {
      if (!isPidAlive(svc.pid)) {
        svc.status = 'crashed'
        svc.pid = null
        changed = true
      }
    }
  }

  if (changed) writeState(envDir, state)
  return state
}
