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
    type: 'tcp' | 'process'
    port?: string | number
    interval?: number // seconds
  }
  readyPattern?: string
  dependsOn?: string[]
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
  promptType?: 'file'          // Kind of prompt — currently only file picker
  defaultPath?: string         // Suggested path; used as starting directory for dialog
  alwaysPrompt?: boolean       // Always show the dialog even if defaultPath exists
  target?: string              // Destination to copy the selected file to
  cwd?: string
  name: string
  interactive?: boolean
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
}

// ---- Environment Template ----
// Blueprint for creating instances. Created once per project via Instance Agent.
// Does NOT contain instance-specific data (ports, paths, database names).

export interface EnvironmentTemplate {
  id: string
  name: string                      // e.g. "My Django App", "My Next.js App"
  description?: string
  projectType: string               // e.g. "django-react", "nextjs", "rails", "generic"
  createdAt: string
  updatedAt: string

  // Which repos to clone
  repos: Array<{
    owner: string
    name: string
    localPath?: string              // source to clone from (if local)
    remoteUrl?: string              // git remote URL
    as: string                      // key name, e.g. "backend", "frontend"
  }>

  // Service definitions (with template variables, no concrete ports)
  services: Record<string, ServiceDef>

  // Shared resources needed
  resources?: Record<string, ResourceDef>

  // Port allocation — list of named port slots to allocate dynamically
  // e.g. ["backend", "frontend"] — app finds a free system port for each
  ports?: string[]

  // Branch rules
  branches?: {
    default: string                 // default branch for new instances
    alternatives?: string[]
    sourceDb?: Record<string, string> // branch -> source DB mapping
  }

  // Hooks — run during instance setup/teardown
  hooks?: {
    postClone?: HookStep[]
    postCreate?: HookStep[]
    preStart?: HookStep[]
    postStop?: HookStep[]
    preTeardown?: HookStep[]
  }

  // Logs config
  logs?: {
    maxSizeKb?: number
    retention?: number
  }

  // Agent hints for the Instance Agent (used during template creation)
  agentHints?: string[]

  // Arbitrary metadata
  meta?: Record<string, unknown>
}

// ---- Service Status ----

export type ServiceState = 'running' | 'stopped' | 'crashed' | 'starting'

export interface ServiceStatus {
  name: string
  status: ServiceState
  pid: number | null
  port: number | null
  uptime: number // seconds since started
  restarts: number
}

export type EnvState = 'running' | 'stopped' | 'partial' | 'creating' | 'error'

export interface EnvStatus {
  id: string
  name: string
  displayName?: string
  projectType: string
  branch: string
  status: EnvState
  services: ServiceStatus[]
  urls: Record<string, string>
  ports: Record<string, number>
  paths: Record<string, string>
  createdAt: string
}

// ---- Client -> envd requests ----

export type EnvRequest =
  | { type: 'register'; reqId: string; manifest: InstanceManifest }
  | { type: 'unregister'; reqId: string; envId: string }
  | { type: 'start'; reqId: string; envId: string; services?: string[] }
  | { type: 'stop'; reqId: string; envId: string; services?: string[] }
  | { type: 'restart-service'; reqId: string; envId: string; service: string }
  | { type: 'status'; reqId: string }
  | { type: 'status-one'; reqId: string; envId: string }
  | { type: 'logs'; reqId: string; envId: string; service: string; lines?: number }
  | { type: 'subscribe'; reqId: string }
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
