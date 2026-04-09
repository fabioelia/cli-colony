/**
 * Shared type definitions used across main, preload, and renderer.
 * Type-only — no runtime code. Safe to import from any build target.
 */

export type CliBackend = 'claude' | 'cursor-agent'

export type SessionRole = 'Orchestrator' | 'Planner' | 'Coder' | 'Tester' | 'Reviewer' | 'Researcher' | 'Coordinator' | 'Worker'

export const SESSION_ROLES: SessionRole[] = ['Orchestrator', 'Planner', 'Coder', 'Tester', 'Reviewer', 'Researcher', 'Coordinator', 'Worker']

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
  tokenUsage: { input: number; output: number; cost?: number }
  pinned: boolean
  mcpServers: string[]
  parentId: string | null
  childIds: string[]
  roleTag: SessionRole | null
  lastSessionId?: string
  pendingSteer?: string
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

/** Pending session launch — queued by env:launchSessionWhenReady while an environment is setting up */
export type PendingLaunchState = 'waiting' | 'ready' | 'failed' | 'timeout' | 'cancelled'

export interface PendingLaunchRecord {
  id: string
  envId: string
  envName: string
  state: PendingLaunchState
  createdAt: number
  services: EnvServiceStatus[]
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
export type TaskPriority = 'critical' | 'high' | 'medium' | 'low'

export interface TaskBoardItem {
  id: string
  title: string
  status: TaskStatus
  priority?: TaskPriority
  assignee?: string
  notes?: string
  created?: string
  updated?: string
  tags?: string[]
}

/** Inline code annotation emitted by a review agent via COLONY_COMMENT sentinel */
export interface ColonyComment {
  file: string
  line: number
  severity: 'error' | 'warn' | 'info'
  message: string
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

export interface PersonaArtifact {
  name: string
  sizeBytes: number
  modifiedAt: number
  isBrief: boolean
}

export interface PersonaRunEntry {
  personaId: string
  timestamp: string
  durationMs: number
  success: boolean
  costUsd?: number
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

export interface GitDiffEntry {
  file: string
  insertions: number
  deletions: number
  status: 'M' | 'A' | 'D' | 'R' | '?'
}

export interface ScoreCard {
  confidence: number   // 0–5 (0 = error/no changes)
  scopeCreep: boolean
  testCoverage: 'none' | 'partial' | 'good'
  summary: string
  raw: string          // raw response for fallback display
}

export interface CommitAttribution {
  commitHash: string
  shortMsg: string
  sessionId: string
  sessionName: string
  personaName?: string
  startedAt: number
  stoppedAt: number
  dir: string
  costUsd?: number
}

export interface ArenaStatEntry {
  wins: number
  losses: number
  totalRuns: number
}

export type ArenaStats = Record<string, ArenaStatEntry>

export interface ForkEntry {
  id: string
  sessionId: string
  sessionName: string
  branch: string
  worktreePath: string
  contextFilePath: string
  label: string
  directive: string
  status: 'running' | 'waiting' | 'crashed' | 'winner' | 'discarded'
}

export interface ForkGroup {
  id: string
  parentId: string
  parentName: string
  label: string
  created: string
  status: 'active' | 'resolved'
  forks: ForkEntry[]
}

export interface SessionTemplate {
  id: string
  name: string
  description?: string
  model?: string
  workingDir?: string
  role?: string
  initialPrompt?: string
  lastUsed?: number
  launchCount?: number
}

export interface OutputEntry {
  path: string
  name: string
  agentId: string
  mtime: number
  sizeBytes: number
  type: 'brief' | 'artifact'
}

// Scoped Approval Gate Builder types
export type ApprovalRuleType = 'file_pattern' | 'cost_threshold' | 'risk_level'
export type ApprovalRuleAction = 'auto_approve' | 'require_approval' | 'require_escalation'

export interface ApprovalRule {
  id: string
  name: string
  type: ApprovalRuleType
  condition: string  // e.g. "*.md,*.txt" | "< 0.10" | "low|medium"
  action: ApprovalRuleAction
  enabled: boolean
  createdAt: string
}

// Coordinator team types
export interface CoordinatorWorker {
  id: string
  name: string
  status: 'running' | 'exited'
  activity: 'busy' | 'waiting'
  costUsd?: number
  uptime?: number
  currentTask?: string
}

export interface CoordinatorTeam {
  coordinatorId: string
  workers: CoordinatorWorker[]
}

// Batch Task Executor types
export interface BatchConfig {
  enabled: boolean
  schedule: string  // cron expression, e.g. "0 2 * * *"
  concurrency: number  // 1–5, default 1
  timeoutPerTaskMinutes: number  // default 30
  onCompletion: 'nothing' | 'report' | 'commit'  // what to do after batch completes
  reportRecipients: string[]  // email addresses for reports
}

export type BatchTaskStatus = 'running' | 'success' | 'timeout' | 'failed'

export interface BatchTaskRun {
  taskId: string
  status: BatchTaskStatus
  costUsd?: number
  durationMs?: number
  outputPath?: string
  startedAt: string
  completedAt?: string
}

export interface BatchRun {
  id: string  // unique batch run ID
  createdAt: string
  startedAt?: string
  completedAt?: string
  taskCount: number
  successCount: number
  failedCount: number
  timeoutCount: number
  totalCostUsd: number
  totalDurationMs: number
  tasks: BatchTaskRun[]
  reportSent?: boolean
}

// Team Telemetry types
export interface TeamMetricsEntry {
  id: string  // unique ID for this run
  timestamp: string  // ISO 8601
  workerId: string  // extracted from session name (e.g., "Worker: job-name" → "job-name")
  status: 'success' | 'failed'  // based on exitCode === 0
  durationMs: number
  costUsd: number
  sessionId?: string  // reference to the session for detailed logs
}

export interface WorkerStats {
  workerId: string
  runsCount: number  // 7d or 30d
  successRate: number  // 0–100
  avgDurationMs: number
  totalCostUsd: number
  lastRunAt: string | null  // ISO 8601, most recent
}

export interface TeamMetrics {
  window: '7d' | '30d'
  generatedAt: string  // ISO 8601
  teamSuccessRate: number  // 0–100
  avgDurationMs: number
  totalCostYtd: number  // year-to-date
  activeWorkerCount: number
  workers: WorkerStats[]
}

// Context window usage tracking
export interface ContextUsageBreakdown {
  systemPrompt: number  // estimated tokens in system prompt
  history: number  // estimated tokens in conversation history
  artifacts: number  // estimated tokens in handoff artifacts
  other: number  // other tracked data
}

export interface ContextUsage {
  sessionId: string
  tokens: number  // estimated current tokens
  maxTokens: number  // max for this model
  percentage: number  // 0–100
  breakdown: ContextUsageBreakdown
  lastUpdatedAt: string  // ISO 8601
}

// App auto-update status (electron-updater wrapper)
export type UpdateState =
  | 'idle'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'ready'
  | 'error'

export interface UpdateInfo {
  version: string
  releaseNotes?: string
  releaseDate?: string
}

export interface UpdateStatus {
  state: UpdateState
  currentVersion: string
  info: UpdateInfo | null
  downloadPercent: number  // 0–100, only meaningful while downloading
  lastCheckAt: number | null  // epoch ms
  lastError: string | null
  /** True only when running in packaged (production) mode. In dev, checks are skipped. */
  enabledInEnv: boolean
}

// Onboarding — first-run welcome modal + prerequisites + checklist
export type PrerequisiteKey = 'claude' | 'auth' | 'git' | 'github'
export type OnboardingChecklistKey =
  | 'createdSession'
  | 'ranFirstPrompt'
  | 'createdPersona'
  | 'connectedGitHub'
  | 'ranPipeline'

export interface PrerequisiteCheck {
  ok: boolean
  detail?: string
  error?: string
}

export interface PrerequisitesStatus {
  claude: PrerequisiteCheck
  auth: PrerequisiteCheck
  git: PrerequisiteCheck
  github: PrerequisiteCheck
  /** Derived: true when the three hard requirements (claude, auth, git) pass. GitHub is optional. */
  ready: boolean
  /** Epoch ms when this snapshot was produced. */
  checkedAt: number
}

export interface OnboardingState {
  /** ISO string when the user finished or skipped the welcome flow; null means the modal should show. */
  firstRunCompletedAt: string | null
  prerequisitesOk: Record<PrerequisiteKey, boolean>
  checklist: Record<OnboardingChecklistKey, boolean>
}

