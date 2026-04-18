/**
 * Shared protocol types for envd (Environment Daemon) <-> Electron client communication.
 * Uses newline-delimited JSON (NDJSON) over Unix domain sockets.
 * Separate from pty-daemon protocol — different concerns, different lifetimes.
 */

// ---- Instance Manifest (v2) ----

export interface ServiceDef {
  command: string
  cwd: string
  env?: Record<string, string>
  port?: string | number
  healthCheck?: {
    type: 'tcp' | 'process' | 'http'
    port?: string | number
    interval?: number    // seconds (tcp/process)
    intervalMs?: number  // milliseconds (overrides interval)
    url?: string         // http only
    expectedStatus?: number // http only
    timeoutMs?: number   // http only
  }
  readyPattern?: string
  dependsOn?: string[]
  debug?: {
    enabled: boolean
    port?: number          // allocated debug port (127.0.0.1 only)
    language?: 'node' | 'python'  // auto-detected from command if omitted
  }
}

export interface ResourceDef {
  type: 'shared' | 'per-instance'
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  sourceDatabase?: string
  db?: number // redis db index
}

export interface HookStep {
  type: 'command' | 'prompt'
  command?: string
  prompt?: string              // Message shown to user for prompt-type hooks
  promptType?: 'file' | 'select'  // file = file picker, select = choose from list
  defaultPath?: string         // Suggested path for file picker
  alwaysPrompt?: boolean       // Always show the dialog even if defaultPath exists
  target?: string              // Destination to copy the selected file to
  optionsCommand?: string      // Shell command that outputs one option per line (for select type)
  cwd?: string
  name: string
  interactive?: boolean
  continueOnError?: boolean    // If true, failure doesn't block subsequent hooks
}

export interface SetupStep {
  name: string
  status: 'pending' | 'running' | 'done' | 'error' | 'skipped'
  error?: string
}

export interface InstanceManifest {
  version: 2
  id: string
  name: string          // slug — filesystem/DB-safe, used for dirs, URLs, ${name}
  displayName?: string  // original user input, UI only
  projectType: string
  createdAt: string

  git?: {
    branch: string
    baseBranch?: string
    remotes?: Record<string, string>
  }

  services: Record<string, ServiceDef>

  ports: Record<string, number>

  paths: Record<string, string>

  resources?: Record<string, ResourceDef>

  urls?: Record<string, string>

  browserTabs?: string[]

  logs?: {
    dir?: string
    maxSizeKb?: number
    retention?: number
  }

  hooks?: {
    postClone?: HookStep[]
    postCreate?: HookStep[]
    preStart?: HookStep[]
    postStop?: HookStep[]
    preTeardown?: HookStep[]
  }

  setup?: {
    status: 'creating' | 'ready' | 'error' | 'tearing-down'
    steps?: SetupStep[]
    error?: string | null
  }

  meta?: Record<string, unknown>

  /** ID of the currently mounted worktree (set after worktree swap) */
  activeWorktreeId?: string
  /** Which repo alias is the session cwd (e.g. "backend") */
  primaryRepo?: string
}

// ---- Domain types (single source of truth in shared/types.ts) ----

import type { EnvStatus } from '../shared/types'
export type { EnvironmentTemplate, EnvStatus, EnvServiceStatus, EnvServiceState, EnvStatusState } from '../shared/types'
// Aliases used by env-daemon.ts (legacy names)
export type { EnvServiceStatus as ServiceStatus, EnvServiceState as ServiceState, EnvStatusState as EnvState } from '../shared/types'

// ---- Client -> envd requests ----

export type EnvRequest =
  | { type: 'register'; reqId: string; manifest: InstanceManifest }
  | { type: 'unregister'; reqId: string; envId: string }
  | { type: 'start'; reqId: string; envId: string; services?: string[] }
  | { type: 'stop'; reqId: string; envId: string; services?: string[] }
  | { type: 'restart-service'; reqId: string; envId: string; service: string }
  | { type: 'remount'; reqId: string; envId: string; manifest: InstanceManifest }
  | { type: 'status'; reqId: string }
  | { type: 'status-one'; reqId: string; envId: string }
  | { type: 'logs'; reqId: string; envId: string; service: string; lines?: number }
  | { type: 'subscribe'; reqId: string }
  | { type: 'teardown'; reqId: string; envId: string }
  | { type: 'toggle-debug'; reqId: string; envId: string; service?: string; enabled: boolean }
  | { type: 'ping'; reqId: string }
  | { type: 'shutdown'; reqId: string }

// ---- envd -> client responses ----

export type EnvResponse =
  | { type: 'ok'; reqId: string; data?: unknown }
  | { type: 'error'; reqId: string; message: string }

// ---- envd -> subscriber events ----

export type EnvEvent =
  | { type: 'env-changed'; environments: EnvStatus[] }
  | { type: 'service-output'; envId: string; service: string; data: string }
  | { type: 'service-crashed'; envId: string; service: string; exitCode: number }
  | { type: 'pong' }

export type EnvMessage = EnvResponse | EnvEvent

// ---- Constants ----

export const ENV_SOCKET_PATH_SUFFIX = '.claude-colony/envd.sock'
export const ENV_PID_PATH_SUFFIX = '.claude-colony/envd.pid'
export const ENV_INDEX_PATH_SUFFIX = '.claude-colony/environments.json'
export const ENVIRONMENTS_DIR_SUFFIX = '.claude-colony/environments'
