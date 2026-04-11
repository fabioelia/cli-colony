/**
 * Shared protocol types for the PTY daemon <-> Electron client communication.
 * Uses newline-delimited JSON (NDJSON) over Unix domain sockets.
 * PTY data is base64-encoded to safely transport arbitrary terminal bytes.
 */

// Re-export domain types from the single source of truth
export type { CliBackend, ClaudeInstance } from '../shared/types'
import type { CliBackend, ClaudeInstance } from '../shared/types'

export interface CreateOpts {
  name?: string
  workingDirectory?: string
  color?: string
  args?: string[]
  defaultArgs?: string[]
  parentId?: string
  cliBackend?: CliBackend
  model?: string
  permissionMode?: 'autonomous' | 'supervised'
  env?: Record<string, string>
}

// ---- Client → Daemon requests ----

export type DaemonRequest =
  | { type: 'create'; reqId: string; opts: CreateOpts }
  | { type: 'write'; reqId: string; instanceId: string; data: string } // data is base64
  | { type: 'resize'; reqId: string; instanceId: string; cols: number; rows: number }
  | { type: 'kill'; reqId: string; instanceId: string }
  | { type: 'remove'; reqId: string; instanceId: string }
  | { type: 'rename'; reqId: string; instanceId: string; name: string }
  | { type: 'recolor'; reqId: string; instanceId: string; color: string }
  | { type: 'restart'; reqId: string; instanceId: string; defaultArgs?: string[] }
  | { type: 'pin'; reqId: string; instanceId: string }
  | { type: 'unpin'; reqId: string; instanceId: string }
  | { type: 'set-role'; reqId: string; instanceId: string; role: string | null }
  | { type: 'steer'; reqId: string; instanceId: string; message: string }
  | { type: 'set-note'; reqId: string; instanceId: string; note: string }
  | { type: 'get-comments'; reqId: string; instanceId: string }
  | { type: 'list'; reqId: string }
  | { type: 'get'; reqId: string; instanceId: string }
  | { type: 'buffer'; reqId: string; instanceId: string }
  | { type: 'clear-tool-deferred'; reqId: string; instanceId: string }
  | { type: 'subscribe'; reqId: string }
  | { type: 'ping'; reqId: string }
  | { type: 'version'; reqId: string }
  | { type: 'shutdown'; reqId: string }

// ---- Daemon → Client responses ----

export type DaemonResponse =
  | { type: 'ok'; reqId: string; data?: unknown }
  | { type: 'error'; reqId: string; message: string }

// ---- Daemon → Client events (pushed to subscribers) ----

export type DaemonEvent =
  | { type: 'output'; instanceId: string; data: string } // data is base64
  | { type: 'exited'; instanceId: string; exitCode: number }
  | { type: 'activity'; instanceId: string; activity: 'busy' | 'waiting' }
  | { type: 'list-changed'; instances: ClaudeInstance[] }
  | { type: 'comments'; instanceId: string; comments: unknown[] }
  | { type: 'tool-deferred'; instanceId: string; sessionId: string; toolName?: string }
  | { type: 'pong' }

export type DaemonMessage = DaemonResponse | DaemonEvent

// ---- Constants ----

/**
 * Bump this when the daemon protocol or behavior changes in a way that
 * requires a daemon restart to pick up. The client checks this on connect
 * and shows a banner if stale.
 */
export const DAEMON_VERSION = 28

export const SOCKET_PATH_SUFFIX = '.claude-colony/daemon.sock'
export const PID_PATH_SUFFIX = '.claude-colony/daemon.pid'
