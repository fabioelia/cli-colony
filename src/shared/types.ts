/**
 * Shared type definitions used across main, preload, and renderer.
 * Type-only — no runtime code. Safe to import from any build target.
 */

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
  cliBackend: CliBackend
  gitBranch: string | null
  tokenUsage: { input: number; output: number; cost: number }
  pinned: boolean
  mcpServers: string[]
  parentId: string | null
  childIds: string[]
}

export interface AgentDef {
  id: string
  name: string
  description: string
  tools: string[]
  model?: string
  color?: string
  filePath: string
  scope: 'personal' | 'project'
  projectName?: string
}

export interface CliSession {
  sessionId: string
  name: string | null
  display: string
  lastMessage: string | null
  messageCount: number
  project: string
  timestamp: number
  projectName: string
  recentlyOpened: boolean
}

export interface CheckRun {
  name: string
  status: string
  conclusion: string | null
  url: string
}

export interface PRChecks {
  overall: 'success' | 'failure' | 'pending' | 'none'
  checks: CheckRun[]
}

export interface PRComment {
  author: string
  body: string
  createdAt: string
  path?: string
}

export interface GitHubPR {
  number: number
  title: string
  body: string
  author: string
  assignees: string[]
  reviewers: string[]
  branch: string
  baseBranch: string
  state: string
  draft: boolean
  url: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string
  labels: string[]
  comments: PRComment[]
}

export interface QuickPrompt {
  id: string
  label: string
  prompt: string
  scope: 'pr' | 'global'
}

export interface GitHubRepo {
  owner: string
  name: string
  localPath?: string
}

export interface EnvServiceStatus {
  name: string
  status: 'running' | 'stopped' | 'crashed' | 'starting'
  pid: number | null
  port: number | null
  uptime: number
  restarts: number
}

export interface EnvStatus {
  id: string
  name: string
  displayName?: string
  projectType: string
  branch: string
  status: 'running' | 'stopped' | 'partial' | 'creating' | 'error'
  services: EnvServiceStatus[]
  urls: Record<string, string>
  ports: Record<string, number>
  paths: Record<string, string>
  createdAt: string
}

export interface EnvironmentTemplate {
  id: string
  name: string
  description?: string
  projectType: string
  createdAt: string
  repos: Array<{ owner: string; name: string; as: string; localPath?: string; remoteUrl?: string }>
  services: Record<string, unknown>
  resources?: Record<string, unknown>
  ports?: string[]
  hooks?: Record<string, unknown[]>
  branches?: { default?: string; alternatives?: string[]; sourceDb?: Record<string, string> }
}
