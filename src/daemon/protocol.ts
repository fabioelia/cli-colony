/**
 * Shared protocol types for the PTY daemon <-> Electron client communication.
 * Uses newline-delimited JSON (NDJSON) over Unix domain sockets.
 * PTY data is base64-encoded to safely transport arbitrary terminal bytes.
 */

// ---- Instance types (shared between daemon and client) ----

/** Which CLI binary this PTY session runs (`claude` vs Cursor `agent`). */
export type CliBackend = 'claude' | 'cursor-agent'

export interface ClaudeInstance {
  id: string
  name: string
  color: string
  status: 'running' | 'exited'
  activity: 'busy' | 'waiting'
  workingDirectory: string
  createdAt: string
  exitCode: number | null
  pid: number | null
  args: string[]
  /** CLI used for this session (drives spawn command and integrations like /color). */
  cliBackend: CliBackend
  gitBranch: string | null
  gitRepo: string | null
  tokenUsage: { input: number; output: number; cost: number }
  pinned: boolean
  mcpServers: string[]
  parentId: string | null
  childIds: string[]
}

export interface CreateOpts {
  name?: string
  workingDirectory?: string
  color?: string
  args?: string[]
  defaultArgs?: string[]
  parentId?: string
  cliBackend?: CliBackend
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
  | { type: 'list'; reqId: string }
  | { type: 'get'; reqId: string; instanceId: string }
  | { type: 'buffer'; reqId: string; instanceId: string }
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
  | { type: 'pong' }

export type DaemonMessage = DaemonResponse | DaemonEvent

// ---- Constants ----

/**
 * Bump this when the daemon protocol or behavior changes in a way that
 * requires a daemon restart to pick up. The client checks this on connect
 * and shows a banner if stale.
 */
export const DAEMON_VERSION = 4

export const SOCKET_PATH_SUFFIX = '.claude-colony/daemon.sock'
export const PID_PATH_SUFFIX = '.claude-colony/daemon.pid'
