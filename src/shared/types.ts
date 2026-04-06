/**
 * Shared type definitions used across main, preload, and renderer.
 * Type-only — no runtime code. Safe to import from any build target.
 */

export type CliBackend = 'claude' | 'cursor-agent'

export type SessionRole = 'Orchestrator' | 'Planner' | 'Coder' | 'Tester' | 'Reviewer' | 'Researcher'

export const SESSION_ROLES: SessionRole[] = ['Orchestrator', 'Planner', 'Coder', 'Tester', 'Reviewer', 'Researcher']

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
  gitRepo: string | null
  tokenUsage: { input: number; output: number; cost: number }
  pinned: boolean
  mcpServers: string[]
  parentId: string | null
  childIds: string[]
  roleTag: SessionRole | null
  lastSessionId?: string
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
  headSha: string
}

export interface FeedbackFile {
  pr: number
  reviewer: string
  createdAt: string
  headSha: string
  repo: string
  branch: string
  content: string
  path: string
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

/** Service status for environment panel display */
export type EnvServiceState = 'running' | 'stopped' | 'crashed' | 'starting'

export interface EnvServiceStatus {
  name: string
  status: EnvServiceState
  pid: number | null
  port: number | null
  uptime: number
  restarts: number
}

/** Aggregated environment status */
export type EnvStatusState = 'running' | 'stopped' | 'partial' | 'creating' | 'error'

export interface EnvStatus {
  id: string
  name: string
  displayName?: string
  projectType: string
  branch: string
  status: EnvStatusState
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
  updatedAt?: string
  repos: Array<{ owner: string; name: string; as: string; localPath?: string; remoteUrl?: string }>
  services: Record<string, unknown>
  resources?: Record<string, unknown>
  ports?: string[]
  hooks?: Record<string, unknown[]>
  branches?: { default?: string; alternatives?: string[]; sourceDb?: Record<string, string> }
  logs?: { maxSizeKb?: number; retention?: number }
  agentHints?: string[]
  meta?: Record<string, unknown>
  /** Where this template came from: "user" or "repo:owner/name" */
  source?: string
}

export interface ActivityEvent {
  id: string
  timestamp: string
  source: 'persona' | 'pipeline' | 'env'
  name: string
  summary: string
  level: 'info' | 'warn' | 'error'
  sessionId?: string
  details?: Record<string, unknown>
}

export interface ApprovalRequest {
  id: string
  pipelineName: string
  summary: string
  resolvedVars: Record<string, string>
  createdAt: string
  expiresAt?: string
}

export type TaskStatus = 'todo' | 'in_progress' | 'done' | 'blocked'

export interface TaskBoardItem {
  id: string
  title: string
  status: TaskStatus
  assignee?: string
  notes?: string
  created?: string
  updated?: string
  tags?: string[]
}

export interface ReplayEvent {
  ts: string           // ISO timestamp
  tool: string         // e.g. "Read", "Edit", "Bash"
  inputSummary: string // truncated to 200 chars
  outputSummary: string // truncated to 200 chars
}

export interface PersonaInfo {
  /** File name (without .md extension) */
  id: string
  /** Display name from frontmatter */
  name: string
  /** Cron schedule (empty string = manual only) */
  schedule: string
  /** Model to use (claude-sonnet-4-5-20250514, opus, etc.) */
  model: string
  /** Max concurrent sessions this persona can have */
  maxSessions: number
  /** Permission: can push to git branches */
  canPush: boolean
  /** Permission: can merge PRs */
  canMerge: boolean
  /** Permission: can create new Colony sessions */
  canCreateSessions: boolean
  /** Whether the persona is enabled for scheduled runs */
  enabled: boolean
  /** Currently running session ID (null if not running) */
  activeSessionId: string | null
  /** Timestamp of last run */
  lastRun: string | null
  /** Number of completed runs */
  runCount: number
  /** Full markdown content of the persona file */
  content: string
  /** File path */
  filePath: string
  /** Output from the last completed run (ANSI-stripped, last ~5000 chars) */
  lastRunOutput: string | null
  /** Pending whispers from the user */
  whispers: Array<{ createdAt: string; text: string }>
  /** Persona IDs to trigger when this persona's session completes */
  onCompleteRun: string[]
  /** Persona IDs this persona may dynamically invoke via trigger file (does not auto-fire on completion) */
  canInvoke: string[]
  /** Display name of the persona that triggered this run (handoff trigger only), null otherwise */
  triggeredBy: string | null
  /** Pending trigger queued for this persona (waiting to fire), or null */
  pendingTrigger: { from: string; note?: string } | null
  /** Sum of session costs in the last 7 days (undefined when no cost data) */
  weeklySpend?: number
  /**
   * Conflict group for serializing can_push: true personas. Two personas in the
   * same conflict_group will not run simultaneously. Defaults to the persona's
   * own slug when not set (preserving existing isolated behavior).
   * Ignored for can_push: false personas — they never block each other.
   */
  conflictGroup?: string
  /** Timestamp (ms) of last skipped run due to run_condition check, or null */
  lastSkipped?: number | null
}

export interface AuditResult {
  severity: 'HIGH' | 'MEDIUM' | 'LOW'
  panel: string
  item: string
  issue: string
  fixAction?: string
}

export interface McpAuditEntry {
  ts: number
  sessionId: string
  sessionName: string
  serverName: string
  toolName: string
  outcome: 'approved' | 'denied' | 'auto'
  args?: string
}

export interface CommitAttribution {
  commitHash: string
  shortMsg: string
  sessionId: string
  sessionName: string
  personaName?: string
  cost?: number
  startedAt: number
  stoppedAt: number
  dir: string
}

export interface ArenaStatEntry {
  wins: number
  losses: number
  totalRuns: number
}

export type ArenaStats = Record<string, ArenaStatEntry>
