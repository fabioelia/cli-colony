/**
 * Pipeline Engine — reactive automation for Claude Colony.
 *
 * Pipelines are YAML files in ~/.claude-colony/pipelines/ that define
 * trigger → condition → action patterns. The engine polls on intervals,
 * evaluates conditions, and fires actions (usually launching sessions).
 */

import { promises as fsp } from 'fs'
import { join, basename } from 'path'
import { createHash } from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { app } from 'electron'
import { createInstance, getAllInstances, getIdleInfo, killInstance, setApprovalCountGetter, updateDockBadge } from './instance-manager'
import { markChecklistItem } from './onboarding-state'
import { getDaemonRouter } from './daemon-router'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { getRepos, fetchPRs, fetchChecks, fetchPRFiles, gh, writePrContext } from './github'
import { findBestRoute } from './session-router'
import { getAllRepoConfigs } from './repo-config-loader'
import { cronMatches } from '../shared/cron'
import { resolveMustacheTemplate, slugify, stripAnsi } from '../shared/utils'
import type { GitHubRepo, GitHubPR, PRChecks, ApprovalRequest } from '../shared/types'
import { appendActivity } from './activity-manager'
import { notify } from './notifications'
import { matchRules, estimateActionCost } from './approval-rules'
import { waitForSessionCompletion, waitForStableIdle } from './session-completion'
import { tagArtifactPipeline } from './session-artifacts'
import { getPlaybook } from './playbook-manager'
import { isRateLimited, getRateLimitState } from './rate-limit-state'
import { isCronsPausedSync } from './cron-pause'
import { resolveCommand } from './resolve-command'

const execFileAsync = promisify(execFile)

export async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true } catch { return false }
}

// ---- Types ----

export interface TriggerDef {
  type: 'git-poll' | 'file-poll' | 'cron' | 'webhook'
  interval?: number // seconds
  cron?: string // cron expression: "min hour dom month dow" (e.g. "0 9 * * 1-5")
  repos?: 'auto' | GitHubRepo[]
  watch?: string[]
  // webhook-specific fields
  secret?: string
  source?: 'github' | 'generic'
  event?: string
}

export type LeafConditionType =
  | 'branch-file-exists'
  | 'pr-checks-failed'
  | 'file-created'
  | 'always'
  | 'files-changed'
  | 'review-requested'
  | 'authored-by'
  | 'not-draft'

export type CompositeConditionType = 'any-of' | 'all-of'

export interface ConditionDef {
  type: LeafConditionType | CompositeConditionType
  branch?: string
  path?: string
  patterns?: string[] // for files-changed: glob patterns (prefix ! for exclusion)
  match?: Record<string, string>
  exclude?: string[] // check names to ignore (substring match)
  /** Sub-conditions for composite types (any-of, all-of). Recursive — composites may nest. */
  conditions?: ConditionDef[]
}

export interface RunOverrides {
  prompt?: string
  model?: string
  workingDirectory?: string
  maxBudget?: number
  templateVarOverrides?: Record<string, string>
}

export interface OutboundWebhookConfig {
  url: string
  method?: 'POST' | 'PUT'
  headers?: Record<string, string>
  body?: string   // Mustache template; vars: pipeline_name, action_name, status, duration_ms, cost, run_id
}

export interface WebhookDeliveryResult {
  url: string
  status: 'success' | 'error' | 'timeout'
  httpStatus?: number
  error?: string
  attemptMs: number
  attempt: number
}

export interface OnFailureConfig {
  notify?: boolean           // send desktop notification on failure
  retry?: { max: number }    // retry up to N times with previous output as context
  run?: string               // fire named action from the action tree (fire-and-forget)
  webhook?: OutboundWebhookConfig
}

export interface OnSuccessConfig {
  notify?: boolean           // send desktop notification on success
  run?: string               // fire named action from the action tree (fire-and-forget)
  chain?: string             // trigger another pipeline by name
  webhook?: OutboundWebhookConfig
}

export interface ActionDef {
  type: 'launch-session' | 'route-to-session' | 'maker-checker' | 'diff_review' | 'parallel' | 'plan' | 'wait_for_session' | 'best-of-n' | 'trigger_pipeline' // route-to-session is deprecated, normalized to launch-session + reuse:true
  reuse?: boolean // try to find/resume a matching session before launching new
  name?: string
  target?: string // trigger_pipeline: name of the target pipeline to trigger
  workingDirectory?: string
  color?: string
  model?: string // Claude model override for this stage (e.g. 'claude-opus-4-6', 'claude-haiku-4-5')
  effort?: string // Claude Code effort level for this stage (e.g. 'low', 'medium', 'high', 'xhigh')
  prompt?: string // required for launch-session; omitted for maker-checker
  match?: {
    gitBranch?: string
    workingDirectory?: string
    role?: string // route to session with this agent role tag (+20 score)
  }
  busyStrategy?: 'wait' | 'launch-new' // default: 'launch-new'
  mcpServers?: string[] // named MCP servers from catalog to inject via --mcp-config
  outputs?: string
  artifactOutputs?: Array<{ name: string; cmd: string }> // capture commands run at fire time; saved to <COLONY_DIR>/artifacts/<name>.txt
  artifactInputs?: string[] // artifact names to inject into prompt preamble (from prior captures)
  handoffInputs?: string[] // artifact names to inject with narrative framing (decisions/context from prior stage)
  specInput?: string // living spec name to inject into prompt preamble (reads from specs/ dir)
  specAppend?: string // living spec name to append decisions to after stage completes
  // maker-checker specific fields
  makerPrompt?: string
  checkerPrompt?: string
  approvedKeyword?: string // keyword to detect approval in checker output (default: 'APPROVED')
  maxIterations?: number   // max maker retries (default: 3)
  checkerMemory?: boolean  // inject review rules memory into checker prompt (default: true)
  // diff_review specific fields
  diffBase?: string             // git ref to diff against (default: 'HEAD~1')
  autoFix?: boolean             // on FAIL, launch fixer session and retry (default: false)
  autoFixMaxIterations?: number // max auto-fix retries (default: 2)
  // parallel specific fields
  stages?: ActionDef[]    // sub-stages to run concurrently (parallel type only)
  fail_fast?: boolean     // abort remaining stages on first failure (default: true)
  // plan specific fields
  require_approval?: boolean // gate on plan before proceeding (default: true)
  plan_keyword?: string      // keyword to detect plan completion (default: PLAN_READY)
  // wait_for_session specific fields
  session_name?: string      // name of the session to wait for
  timeout_minutes?: number   // max wait time in minutes (default: 30)
  stable_waiting_seconds?: number // continuous 'waiting' window before auto-close fires (default: 20)
  artifact_output?: string   // artifact name to write exit reason to
  // idle nudge — auto-whisper when session produces no PTY output for N minutes
  idle_nudge?: {
    after_minutes: number
    message: string
    max_nudges?: number
  }
  // playbook — when set, load named playbook and merge its defaults under explicit action fields
  playbook?: string
  // retry
  max_retries?: number       // retry failed stages up to N times (default: 0 = no retry)
  retry_delay_ms?: number    // base delay between retries in ms, doubles each attempt (default: 5000)
  on_failure?: OnFailureConfig  // handlers triggered when this stage fails (notify, retry, run named action)
  on_success?: OnSuccessConfig  // handlers triggered when this stage succeeds (notify, run named action, chain pipeline)
  // best-of-n specific fields
  n?: number                    // number of parallel contestants (default: 3, clamped 2-8)
  repo?: { owner: string; name: string }  // repo to create worktrees in
  branch?: string               // branch to base worktrees on (default: 'main')
  judge?: {
    type: 'command' | 'llm'
    cmd?: string                // command judge: shell command to run in each worktree
    prompt?: string             // llm judge: prompt for the judge session
  }
  models?: (string | null)[]    // optional per-slot model overrides
  keep_winner?: boolean         // preserve winning worktree (default: true)
}

export interface DedupDef {
  key: string
  ttl?: number // seconds
  maxRetries?: number // re-fire up to N times when same content SHA but spawned session has exited
}

export interface BudgetDef {
  max_cost_usd: number
  warn_at?: number
}

export interface PipelineDef {
  name: string
  description?: string
  enabled: boolean
  requireApproval?: boolean
  approvalTtl?: number // hours; overrides global default
  /** Fallback Claude model for all stages that don't set their own model override. */
  default_model?: string
  trigger: TriggerDef
  condition: ConditionDef
  action: ActionDef
  dedup: DedupDef
  budget?: BudgetDef
  run_condition?: string
  pre_run?: Array<{ type: string }>
  notifications?: 'all' | 'failures' | 'none'
  /** ISO timestamp — pipeline is temporarily paused until this time. null = paused indefinitely until resumed. */
  pausedUntil?: string | null
}

export interface PendingApproval {
  request: ApprovalRequest
  action: ActionDef
  ctx: TriggerContext
  dedupKey: string
  // Optional callbacks for inline approval gates (plan stage) — resolve/reject instead of re-firing action
  resolve?: () => void
  reject?: (reason: string) => void
}

interface FiredKeyEntry {
  timestamp: number
  sessionId?: string
  retryCount: number // 0 = initial fire, 1 = first retry, etc.
}

interface PipelineState {
  enabled?: boolean
  lastPollAt: string | null
  lastMatchAt: string | null
  firedKeys: Record<string, FiredKeyEntry | number> // dedup key -> entry (or legacy timestamp)
  contentHashes: Record<string, string> // dedup key -> last seen content SHA
  fireCount: number
  lastFiredAt: string | null
  lastError: string | null
  consecutiveFailures: number
  debugLog: string[]
  lastRunStoppedBudget?: boolean
}

export interface ActionShape {
  type: string
  name?: string
  target?: string
  stages?: ActionShape[]
}

export interface PipelineInfo {
  name: string
  description: string
  enabled: boolean
  fileName: string
  triggerType: string
  interval: number
  cron: string | null
  running: boolean
  outputsDir: string | null
  lastPollAt: string | null
  lastMatchAt: string | null
  lastFiredAt: string | null
  lastError: string | null
  fireCount: number
  consecutiveFailures: number
  debugLog: string[]
  budget?: { maxCostUsd: number; warnAt: number } | null
  lastRunStoppedBudget?: boolean
  actionShape?: ActionShape
  /** Raw (unresolved) prompt of the first action — used to pre-fill the run-with-override dialog */
  firstActionPrompt?: string
  /** Raw working directory of the first action — used to pre-fill the run-with-options dialog */
  firstActionWorkingDirectory?: string
  /** Effective model for the first action (action.model ?? default_model) — used to pre-fill the run-with-options dialog */
  firstActionModel?: string
  /** Pipeline-level fallback model applied to stages that don't set their own model override */
  defaultModel?: string
  /** If set, cron fires are skipped when this condition is not met (e.g. 'has_changes') */
  runCondition?: string
  /** Structured condition type (e.g. 'files-changed') — undefined when type is 'always' */
  conditionType?: string
  /** Glob patterns for files-changed condition */
  conditionPatterns?: string[]
  /** Hook types configured in pre_run (e.g. ['refresh-prs']) */
  preRunHooks?: string[]
  /** Notification level: all (default), failures (warn+critical only), or none */
  notifications?: 'all' | 'failures' | 'none'
  /** ISO timestamp — pipeline is temporarily paused until this time. null = indefinitely paused. */
  pausedUntil?: string | null
  /** Live progress of the currently-running step. Only present when running === true. */
  currentStep?: { index: number; total: number; name?: string; type: string; startedAt: string }
}

const MAX_DEBUG_ITERATIONS = 20
const DEBUG_ITERATION_SEP = '---'
const CONSECUTIVE_FAILURE_THRESHOLD = 3
export const APPROVAL_DEFAULT_TTL_HOURS = 24

export interface TriggerContext {
  repo?: GitHubRepo
  pr?: GitHubPR
  checks?: PRChecks
  file?: { path: string; name: string; directory: string }
  githubUser?: string
  timestamp: string
  contentSha?: string // SHA of matched file — for change detection
  webhookPayload?: unknown
  /** All configured repos as "owner/name" slugs — available as {{repos}} */
  repoSlugs?: string[]
  /** For files-changed condition: absolute path to the repo to diff */
  repoPath?: string
  /** For files-changed condition: HEAD commit from last successful run */
  lastRunCommit?: string
  /** Populated by evaluateFilesChanged for preview logging */
  filesChangedMatches?: string[]
  /** Injected by on_failure handler — error message from the failed stage */
  error?: string
}

// Cron matching imported from src/shared/cron.ts

// ---- Constants ----

import { colonyPaths } from '../shared/colony-paths'

const COLONY_DIR = colonyPaths.root
export const PIPELINES_DIR = colonyPaths.pipelines
const STATE_PATH = join(COLONY_DIR, 'pipeline-state.json')

// ---- Engine ----

export const pipelines = new Map<string, { def: PipelineDef; state: PipelineState; fileName: string }>()
export const pendingApprovals = new Map<string, PendingApproval>()
export const pendingApprovalKeys = new Set<string>() // dedup keys with a queued approval
const timers = new Map<string, ReturnType<typeof setInterval>>()
const runningPolls = new Set<string>()
/** Stores incoming webhook payloads keyed by pipeline name before runPoll is called */
const webhookPayloads = new Map<string, unknown>()
/** mtime snapshots for file-poll pipelines: pipelineName → (path → mtime-ms) */
const filePollSnapshots = new Map<string, Map<string, number>>()
let githubUser: string | null = null
let started = false
let approvalSweepTimer: ReturnType<typeof setInterval> | null = null
/** Startup setTimeout IDs — cleared on stop to prevent firing on stopped pipelines */
const startupTimers = new Set<ReturnType<typeof setTimeout>>()
/** Tracks pipeline names currently mid-execution for circular chain detection */
const executingPipelines = new Set<string>()
const _currentStep = new Map<string, { index: number; total: number; name?: string; type: string; startedAt: string }>()

export function log(msg: string): void {
  console.log(`[pipeline] ${msg}`)
}

/** Log to both console and a pipeline's in-memory debug buffer */
export function plog(name: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  const entry = `[${ts}] ${msg}`
  log(`${name}: ${msg}`)
  const p = pipelines.get(name)
  if (p) {
    p.state.debugLog.push(entry)
  }
}

import { broadcast } from './broadcast'
import { runMakerChecker, runDiffReview, runPlanStage, runParallel, runWaitForSession, runBestOfN, captureArtifacts, loadArtifactPreamble, loadHandoffPreamble, loadSpecPreamble, appendToSpec } from './pipeline-stages'
import { getPipelineNotes, clearPipelineNotes } from './pipeline-notes'
import { parseYaml as parseYamlShared, parseYamlArray } from '../shared/yaml-parser'
import { request as httpsRequest } from 'https'
import { request as httpRequest } from 'http'

async function fireOutboundWebhook(
  config: OutboundWebhookConfig,
  ctx: { pipeline_name: string; action_name: string; status: string; duration_ms: number; cost: number; run_id: string }
): Promise<WebhookDeliveryResult[]> {
  if (!config.url || (!config.url.startsWith('http://') && !config.url.startsWith('https://'))) {
    log(`outbound webhook: invalid URL (must start with http:// or https://) — skipped`)
    return []
  }
  const defaultBody = JSON.stringify({
    pipeline_name: ctx.pipeline_name,
    action_name: ctx.action_name,
    status: ctx.status,
    duration_ms: ctx.duration_ms,
    cost: ctx.cost,
    run_id: ctx.run_id,
  })
  const bodyStr = config.body
    ? resolveMustacheTemplate(config.body, ctx as unknown as Record<string, string>)
    : defaultBody
  const bodyBuf = Buffer.from(bodyStr, 'utf8')
  const parsedUrl = new URL(config.url)
  const options = {
    hostname: parsedUrl.hostname,
    port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
    path: parsedUrl.pathname + parsedUrl.search,
    method: config.method || 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': bodyBuf.length,
      ...(config.headers || {}),
    },
  }
  const domain = parsedUrl.hostname
  const reqFn = parsedUrl.protocol === 'https:' ? httpsRequest : httpRequest
  const MAX_ATTEMPTS = 3
  const BACKOFF_MS = [2000, 4000, 8000]
  const results: WebhookDeliveryResult[] = []

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const start = Date.now()
    const result = await new Promise<WebhookDeliveryResult>((resolve) => {
      const req = reqFn(options as unknown as Parameters<typeof httpsRequest>[0], (res) => {
        const statusCode = res.statusCode ?? 0
        log(`outbound webhook → ${domain}: HTTP ${statusCode} (attempt ${attempt})`)
        res.resume()
        resolve({
          url: config.url,
          status: statusCode >= 200 && statusCode < 400 ? 'success' : 'error',
          httpStatus: statusCode,
          attemptMs: Date.now() - start,
          attempt,
        })
      })
      req.setTimeout(10_000, () => {
        log(`outbound webhook → ${domain}: timeout (attempt ${attempt})`)
        req.destroy()
        resolve({ url: config.url, status: 'timeout', attemptMs: Date.now() - start, attempt })
      })
      req.on('error', (err) => {
        log(`outbound webhook → ${domain}: error: ${err.message} (attempt ${attempt})`)
        resolve({ url: config.url, status: 'error', error: err.message, attemptMs: Date.now() - start, attempt })
      })
      req.write(bodyBuf)
      req.end()
    })
    results.push(result)

    // Success or 4xx (permanent client error) — stop
    if (result.status === 'success' || (result.httpStatus !== undefined && result.httpStatus >= 400 && result.httpStatus < 500)) {
      break
    }
    // Retry on 5xx, timeout, network error
    if (attempt < MAX_ATTEMPTS) {
      await new Promise(r => setTimeout(r, BACKOFF_MS[attempt - 1]))
    } else {
      console.warn(`[pipeline-engine] outbound webhook → ${domain}: FAILED after ${MAX_ATTEMPTS} attempts`)
    }
  }

  return results
}

// ---- Pipeline YAML Parsing (uses shared parser + pipeline-specific post-processing) ----

export function validatePipelineYaml(content: string): { valid: boolean; errors: string[]; warnings: string[]; def: PipelineDef | null } {
  const errors: string[] = []
  const warnings: string[] = []
  let result: any
  try {
    result = parseYamlShared(content) as any
  } catch (err) {
    return { valid: false, errors: [`YAML parse error: ${err}`], warnings, def: null }
  }
  if (!result) return { valid: false, errors: ['Empty or invalid YAML'], warnings, def: null }

  // Normalize condition tree
  if (result.condition) normalizeConditionTree(result.condition)

  // Ensure trigger.watch is an array
  if (typeof result.trigger?.watch === 'string') result.trigger.watch = [result.trigger.watch]
  const watchArr = parseYamlArray(content, 'watch')
  if (watchArr && result.trigger) result.trigger.watch = watchArr

  // Re-parse dash lists for leaf conditions
  if (result.condition && !isCompositeCondition(result.condition)) {
    const excludeArr = parseYamlArray(content, 'exclude')
    if (excludeArr) result.condition.exclude = excludeArr
    const patternsArr = parseYamlArray(content, 'patterns')
    if (patternsArr) result.condition.patterns = patternsArr
  }

  // Validate condition tree shape
  if (result.condition && !validateConditionTree(result.condition)) {
    errors.push('Invalid condition tree — any-of/all-of must have non-empty conditions array')
  }

  // Required fields
  if (!result.name) errors.push('Missing required field: name')
  if (!result.trigger?.type) errors.push('Missing required field: trigger.type')

  // Action type validation
  if (result.action?.type === 'maker-checker') {
    if (!result.action?.makerPrompt) errors.push('Missing required field: action.makerPrompt (for maker-checker type)')
    if (!result.action?.checkerPrompt) errors.push('Missing required field: action.checkerPrompt (for maker-checker type)')
  } else if (result.action?.type === 'wait_for_session') {
    if (!result.action?.session_name) errors.push('Missing required field: action.session_name (for wait_for_session type)')
  } else if (result.action?.type === 'trigger_pipeline') {
    if (!result.action?.target) errors.push('Missing required field: action.target (for trigger_pipeline type)')
  } else if (result.action?.type !== 'diff_review' && result.action?.type !== 'parallel' && result.action?.type !== 'route-to-session' && !result.action?.prompt) {
    errors.push('Missing required field: action.prompt')
  }

  // Parallel validation
  if (result.action?.type === 'parallel') {
    const rawStages = result.action.stages
    if (!Array.isArray(rawStages) || rawStages.length === 0) {
      errors.push('Parallel stage: stages must be a non-empty array')
    } else if (rawStages.some((s: any) => s?.type === 'parallel')) {
      errors.push('Parallel stage: nested parallel not supported')
    } else {
      result.action.stages = rawStages.map((s: any) => ({
        ...s,
        type: s.type === 'session' ? 'launch-session' : (s.type || 'launch-session'),
      }))
    }
  }

  // Warnings
  if (result.action?.type === 'route-to-session') {
    warnings.push('Deprecated action type: route-to-session — use launch-session with reuse: true')
  }
  if (result.action?.idle_nudge) {
    const nudge = result.action.idle_nudge
    if (!nudge.after_minutes || nudge.after_minutes <= 0) errors.push('idle_nudge.after_minutes must be > 0')
    if (!nudge.message?.trim()) errors.push('idle_nudge.message must not be empty')
  }
  if (result.action?.on_failure?.run) {
    const target = findNamedAction(result.action, result.action.on_failure.run)
    if (!target) {
      warnings.push(`on_failure.run target '${result.action.on_failure.run}' not found in action tree`)
    } else if (target?.on_failure?.run) {
      warnings.push(`on_failure.run target '${result.action.on_failure.run}' also has on_failure.run — infinite chain risk`)
    }
  }
  if (result.action?.on_success?.run) {
    const target = findNamedAction(result.action, result.action.on_success.run)
    if (!target) warnings.push(`on_success.run target '${result.action.on_success.run}' not found in action tree`)
  }

  if (errors.length > 0) return { valid: false, errors, warnings, def: null }

  // Apply defaults
  if (result.enabled === undefined) result.enabled = true
  if (!result.dedup) result.dedup = { key: '{{timestamp}}', ttl: 3600 }
  if (result.action?.type === 'route-to-session') {
    result.action.type = 'launch-session'
    result.action.reuse = true
  }
  if (result.action && !result.action.busyStrategy) result.action.busyStrategy = 'launch-new'
  result.run_condition = result.run_condition || undefined

  return { valid: true, errors: [], warnings, def: result as PipelineDef }
}

function parsePipelineYaml(content: string): PipelineDef | null {
  const result = validatePipelineYaml(content)
  if (!result.valid) {
    log(`YAML error: ${result.errors.join('; ')}`)
    return null
  }
  for (const w of result.warnings) log(`YAML warning: ${w}`)
  return result.def
}

// ---- Run History ----

export interface PipelineStageTrace {
  index: number
  actionType: string
  sessionName?: string
  sessionId?: string // links to the spawned session (if any)
  model?: string  // per-stage model override if set (resolved concrete model ID)
  autoResolved?: boolean // true when model was resolved from 'auto' via heuristic
  durationMs: number
  startedAt?: number
  completedAt?: number
  success: boolean
  error?: string
  responseSnippet?: string // first ~120 chars of reviewer response (diff_review only)
  subStages?: PipelineStageTrace[] // parallel sub-stage results
  retryCount?: number // how many retry attempts were needed (0 = succeeded first try)
  retryContext?: boolean // true if at least one retry injected PTY output as context
  onFailureFired?: boolean // true if on_failure recovery action was triggered
  cost?: number // USD cost for this stage (including retries)
}

export interface PipelineRunEntry {
  ts: string
  trigger: string
  actionExecuted: boolean
  success: boolean
  durationMs: number
  stages?: PipelineStageTrace[]
  sessionIds?: string[] // all session IDs created during this run
  totalCost?: number
  stoppedBudget?: boolean
  /** 0 = initial attempt, 1 = first retry, etc. Only set when maxRetries > 0 */
  dedupAttempt?: number
  /** Mirrors pipeline dedup.maxRetries — for "Attempt N/M" display */
  dedupMaxRetries?: number
  /** HEAD commit hash at the time of the run — used by files-changed condition as baseline */
  headCommit?: string
  /** Structured trigger context — why this run fired */
  triggerContext?: {
    cronExpr?: string
    scheduledAt?: string
    matchedPRs?: number[]
    newCommits?: string[]
    matchedFiles?: string[]
    githubEvent?: string
    githubAction?: string
  }
  webhookFired?: boolean
  webhookDeliveries?: WebhookDeliveryResult[]
  diffStats?: {
    filesChanged: number
    insertions: number
    deletions: number
  }
}

const MAX_HISTORY_ENTRIES = 20

async function computeDiffStats(
  sessionIds: string[],
  headCommit?: string,
): Promise<PipelineRunEntry['diffStats'] | undefined> {
  if (!headCommit || sessionIds.length === 0) return undefined
  const instances = await getAllInstances()
  let filesChanged = 0, insertions = 0, deletions = 0
  const visitedCwds = new Set<string>()
  for (const id of sessionIds) {
    const inst = instances.find(i => i.id === id)
    const cwd = inst?.workingDirectory
    if (!cwd || visitedCwds.has(cwd)) continue
    visitedCwds.add(cwd)
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--numstat', `${headCommit}..HEAD`], { cwd })
      for (const line of stdout.split('\n')) {
        const parts = line.split('\t')
        if (parts.length < 2) continue
        const ins = parseInt(parts[0], 10)
        const del = parseInt(parts[1], 10)
        if (isNaN(ins) || isNaN(del)) continue // skip binary files (show '-')
        insertions += ins
        deletions += del
        filesChanged++
      }
    } catch { /* not a git repo or no commits — skip */ }
  }
  if (filesChanged === 0 && insertions === 0 && deletions === 0) return undefined
  return { filesChanged, insertions, deletions }
}

function historyPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '-')
  return join(PIPELINES_DIR, `${safe}.history.json`)
}

async function appendHistory(pipelineName: string, entry: PipelineRunEntry): Promise<void> {
  const path = historyPath(pipelineName)
  let entries: PipelineRunEntry[] = []
  try {
    if (await pathExists(path)) {
      entries = JSON.parse(await fsp.readFile(path, 'utf-8'))
    }
  } catch { /* ignore */ }
  entries.push(entry)
  if (entries.length > MAX_HISTORY_ENTRIES) {
    entries = entries.slice(entries.length - MAX_HISTORY_ENTRIES)
  }
  try {
    await fsp.writeFile(path, JSON.stringify(entries, null, 2), 'utf-8')
  } catch { /* ignore */ }
}

export async function getHistory(pipelineName: string): Promise<PipelineRunEntry[]> {
  const path = historyPath(pipelineName)
  try {
    if (await pathExists(path)) {
      return JSON.parse(await fsp.readFile(path, 'utf-8'))
    }
  } catch { /* ignore */ }
  return []
}

export interface HistorySearchResult {
  pipelineName: string
  entry: PipelineRunEntry
  matchField: string
}

export async function searchAllHistory(query: string): Promise<HistorySearchResult[]> {
  if (!await pathExists(PIPELINES_DIR)) return []
  const files = (await fsp.readdir(PIPELINES_DIR)).filter(f => f.endsWith('.history.json'))
  const q = query.trim().toLowerCase()
  const now = Date.now()
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0)
  const hourAgo = now - 3600_000

  const filterFailed = q === 'failed' || q.includes('failed')
  const costMatch = q.match(/^>\s*\$?(\d+(?:\.\d+)?)/)
  const costThreshold = costMatch ? parseFloat(costMatch[1]) : null
  const filterToday = q === 'today'
  const filterLastHour = q === 'last-hour' || q === 'lasthour'
  const textQuery = (!filterFailed && !costThreshold && !filterToday && !filterLastHour) ? q : ''

  const results: HistorySearchResult[] = []
  const loadedNames = new Map<string, string>()
  for (const [, p] of pipelines) {
    const safe = p.def.name.replace(/[^a-zA-Z0-9._-]/g, '-')
    loadedNames.set(safe, p.def.name)
  }

  for (const file of files) {
    const slug = file.replace(/\.history\.json$/, '')
    const pipelineName = loadedNames.get(slug) || slug.replace(/-/g, ' ')
    let entries: PipelineRunEntry[] = []
    try {
      entries = JSON.parse(await fsp.readFile(join(PIPELINES_DIR, file), 'utf-8'))
    } catch { continue }

    for (const entry of entries) {
      const entryTs = new Date(entry.ts).getTime()
      if (filterFailed && entry.success) continue
      if (costThreshold !== null && (entry.totalCost ?? 0) <= costThreshold) continue
      if (filterToday && entryTs < todayStart.getTime()) continue
      if (filterLastHour && entryTs < hourAgo) continue
      if (textQuery) {
        const haystack = [pipelineName, entry.trigger, ...(entry.sessionIds || [])].join(' ').toLowerCase()
        if (!haystack.includes(textQuery)) continue
      }
      const matchField = filterFailed ? 'status' : costThreshold !== null ? 'cost' : filterToday ? 'date' : filterLastHour ? 'date' : textQuery ? 'name' : 'all'
      results.push({ pipelineName, entry, matchField })
    }
  }

  results.sort((a, b) => new Date(b.entry.ts).getTime() - new Date(a.entry.ts).getTime())
  return results.slice(0, 50)
}

// ---- State Persistence ----

export function debugLogPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '-')
  return join(PIPELINES_DIR, `${safe}.debug.json`)
}

export async function getDebugLog(name: string): Promise<string[]> {
  try {
    const raw = await fsp.readFile(debugLogPath(name), 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed.entries) ? parsed.entries : []
  } catch {
    return []
  }
}

async function loadState(): Promise<Record<string, PipelineState>> {
  try {
    if (await pathExists(STATE_PATH)) {
      const raw = JSON.parse(await fsp.readFile(STATE_PATH, 'utf-8'))
      for (const key of Object.keys(raw)) {
        if (!raw[key].debugLog) raw[key].debugLog = []
        if (!raw[key].consecutiveFailures) raw[key].consecutiveFailures = 0
      }
      return raw
    }
  } catch { /* ignore */ }
  return {}
}

async function saveState(): Promise<void> {
  const state: Record<string, any> = {}
  for (const [name, p] of pipelines) {
    const { debugLog, ...rest } = p.state
    state[name] = rest
  }
  try {
    await fsp.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    log(`Failed to save state: ${err}`)
  }
}

/** Persist the last 50 debug log entries per pipeline to disk. */
async function saveDebugLogs(): Promise<void> {
  for (const [name, p] of pipelines) {
    if (p.state.debugLog.length === 0) continue
    const entries = p.state.debugLog.slice(-50)
    try {
      await fsp.writeFile(debugLogPath(name), JSON.stringify({ entries, savedAt: new Date().toISOString() }, null, 2), 'utf-8')
    } catch (err) {
      log(`Failed to save debug log for ${name}: ${err}`)
    }
  }
}

function freshState(): PipelineState {
  return { lastPollAt: null, lastMatchAt: null, firedKeys: {}, contentHashes: {}, fireCount: 0, lastFiredAt: null, lastError: null, consecutiveFailures: 0, debugLog: [] }
}

// ---- Pre-Run Hooks ----

async function executePreRunHooks(hooks: Array<{ type: string }>, pipelineName: string): Promise<void> {
  for (const hook of hooks) {
    const start = Date.now()
    try {
      if (hook.type === 'refresh-prs') {
        const repos = await getRepos()
        const prsByRepo: Record<string, GitHubPR[]> = {}
        for (const repo of repos) {
          prsByRepo[`${repo.owner}/${repo.name}`] = await fetchPRs(repo)
        }
        await writePrContext(prsByRepo)
        broadcast('pipeline:status', getPipelineList())
        plog(pipelineName, `pre_run: refresh-prs completed in ${Date.now() - start}ms (${repos.length} repos)`)
      } else {
        plog(pipelineName, `pre_run: unknown hook type "${hook.type}" — skipping`)
      }
    } catch (err) {
      plog(pipelineName, `pre_run: hook "${hook.type}" failed (${Date.now() - start}ms): ${(err as Error).message}`)
    }
  }
}

// ---- Template Resolution ----

export function resolveTemplate(template: string, ctx: TriggerContext, varOverrides?: Record<string, string>): string {
  // Build a flat context that exposes aliases the pipeline YAML expects:
  // {{github.user}} -> ctx.githubUser, {{timestamp}} -> ctx.timestamp
  const ghPayload = (ctx.webhookPayload as Record<string, unknown> | null) || {}
  const prPayload = (ghPayload['pull_request'] as Record<string, unknown> | null) || {}
  const senderPayload = (ghPayload['sender'] as Record<string, unknown> | null) || {}
  const ghVars = {
    pr_title: String(prPayload['title'] || ghPayload['title'] || ''),
    pr_url: String(prPayload['html_url'] || ghPayload['html_url'] || ''),
    pr_number: String(prPayload['number'] || ghPayload['number'] || ''),
    sender: String(senderPayload['login'] || ''),
  }
  const context: Record<string, unknown> = {
    ...ctx,
    github: { user: ctx.githubUser || '' },
    repos: ctx.repoSlugs?.join(', ') || '',
    webhook_payload: JSON.stringify(ctx.webhookPayload || {}),
    ...ghVars,
  }
  return resolveMustacheTemplate(template, { ...context, ...varOverrides })
}

// ---- Dedup ----

function normalizeFiredEntry(val: FiredKeyEntry | number | undefined): FiredKeyEntry | null {
  if (val === undefined || val === null) return null
  if (typeof val === 'number') return { timestamp: val, retryCount: 0 }
  return val
}

function isDuplicate(pipelineName: string, key: string, ttlSeconds: number, contentSha?: string): boolean {
  const p = pipelines.get(pipelineName)
  if (!p) return false

  // If we have a content SHA, check if the content changed since last fire
  if (contentSha) {
    if (!p.state.contentHashes) p.state.contentHashes = {}
    const lastSha = p.state.contentHashes[key]
    if (lastSha === contentSha) {
      // Content hasn't changed — skip regardless of TTL (retry check happens at call site)
      return true
    }
    // Content is new or changed — allow firing even within TTL
    return false
  }

  // No content SHA — fall back to time-based dedup
  const entry = normalizeFiredEntry(p.state.firedKeys[key])
  if (!entry) return false
  return Date.now() - entry.timestamp < ttlSeconds * 1000
}

async function getRetryAttempt(pipelineName: string, key: string, maxRetries: number): Promise<number | null> {
  const p = pipelines.get(pipelineName)
  if (!p) return null
  const entry = normalizeFiredEntry(p.state.firedKeys[key])
  if (!entry) return null

  if (entry.retryCount >= maxRetries) {
    // Exhausted — emit attention event (fire once per exhaustion by checking flag)
    const exhaustedKey = `${key}:exhausted:${entry.retryCount}`
    if (!p.state.contentHashes?.[exhaustedKey]) {
      if (!p.state.contentHashes) p.state.contentHashes = {}
      p.state.contentHashes[exhaustedKey] = '1'
      const label = p.def.name
      appendActivity({
        source: 'pipeline',
        name: pipelineName,
        summary: `CI unfixable after ${maxRetries + 1} attempts — pipeline "${label}"`,
        level: 'error',
      })
    }
    return null
  }

  if (!entry.sessionId) return null
  const instances = await getAllInstances()
  const sess = instances.find(i => i.id === entry.sessionId)
  if (sess && sess.status === 'running') return null // still running — wait
  return entry.retryCount // eligible for retry; caller uses this as the current attempt index
}

async function recordFired(pipelineName: string, key: string, contentSha?: string, sessionId?: string): Promise<void> {
  const p = pipelines.get(pipelineName)
  if (!p) return

  const existing = normalizeFiredEntry(p.state.firedKeys[key])
  const sameContent = contentSha && p.state.contentHashes?.[key] === contentSha
  const newRetryCount = sameContent && existing ? existing.retryCount + 1 : 0

  p.state.firedKeys[key] = { timestamp: Date.now(), sessionId, retryCount: newRetryCount }

  if (contentSha) {
    if (!p.state.contentHashes) p.state.contentHashes = {}
    p.state.contentHashes[key] = contentSha
  }
  p.state.fireCount++
  p.state.lastFiredAt = new Date().toISOString()

  // Clean expired keys
  const now = Date.now()
  const ttl = (p.def.dedup?.ttl || 3600) * 1000
  for (const [k, entryVal] of Object.entries(p.state.firedKeys)) {
    const e = normalizeFiredEntry(entryVal)
    if (e && now - e.timestamp > ttl * 2) {
      delete p.state.firedKeys[k]
      if (p.state.contentHashes) delete p.state.contentHashes[k]
    }
  }

  await saveState()
}

// ---- Write prompt to file, send short trigger to PTY ----

export async function writePromptFile(prompt: string): Promise<string> {
  const promptsDir = join(COLONY_DIR, 'pipeline-prompts')
  if (!await pathExists(promptsDir)) await fsp.mkdir(promptsDir, { recursive: true })
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const filePath = join(promptsDir, `${id}.md`)
  await fsp.writeFile(filePath, prompt, 'utf-8')
  return filePath
}

function buildFilePromptTrigger(filePath: string): string {
  return `Read and execute the instructions in ${filePath}`
}

// ---- Send Prompt to Existing Session (no trust prompt handling) ----

async function sendPromptToExistingSession(instanceId: string, prompt: string): Promise<boolean> {
  const client = getDaemonRouter()
  const inst = await client.getInstance(instanceId)
  const filePath = await writePromptFile(prompt)
  const trigger = buildFilePromptTrigger(filePath)

  if (inst?.activity === 'waiting') {
    client.writeToInstance(instanceId, trigger + '\r')
    return true
  }

  // Wait for session to become idle
  return new Promise((resolve) => {
    let sent = false

    const handler = (_id: string, activity: string) => {
      if (_id !== instanceId || sent) return
      if (activity === 'waiting') {
        sent = true
        client.removeListener('activity', handler)
        client.writeToInstance(instanceId, trigger + '\r')
        resolve(true)
      }
    }

    client.on('activity', handler)

    // 15s timeout — if session doesn't idle quickly, caller should launch new
    setTimeout(() => {
      if (!sent) {
        sent = true
        client.removeListener('activity', handler)
        log(`Timed out waiting for session ${instanceId} to become idle (15s) — falling back`)
        resolve(false)
      }
    }, 15000)
  })
}

// ---- Trigger Execution ----

async function executeGitPollTrigger(trigger: TriggerDef, condition?: ConditionDef): Promise<TriggerContext[]> {
  const repos = trigger.repos === 'auto' || !trigger.repos ? await getRepos() : trigger.repos as GitHubRepo[]
  const contexts: TriggerContext[] = []
  const errors: string[] = []

  // Build server-side search filter from condition type to reduce API payload
  let search: string | undefined
  if (condition) {
    const leafTypes = getLeafConditionTypes(condition)
    if (leafTypes.has('review-requested') && githubUser) {
      search = `review-requested:${githubUser}`
    } else if (leafTypes.has('authored-by') && githubUser) {
      search = `author:${githubUser}`
    }
  }

  for (const repo of repos) {
    try {
      const prs = await fetchPRs(repo, search)
      for (const pr of prs) {
        contexts.push({
          repo,
          pr,
          githubUser: githubUser || undefined,
          timestamp: new Date().toISOString(),
        })
      }
    } catch (err) {
      const msg = `Failed to fetch PRs for ${repo.owner}/${repo.name}: ${err}`
      log(msg)
      errors.push(msg)
    }
  }

  if (errors.length > 0) {
    (contexts as any)._fetchErrors = errors
  }

  return contexts
}

// ---- Condition Evaluation ----

async function evaluateBranchFileExists(condition: ConditionDef, ctx: TriggerContext): Promise<boolean> {
  if (!ctx.repo || !ctx.pr) return false

  // Check match filters
  if (condition.match) {
    for (const [key, pattern] of Object.entries(condition.match)) {
      const expected = resolveTemplate(pattern, ctx)
      const parts = key.split('.')
      let actual: any = ctx
      for (const p of parts) {
        if (actual == null) break
        actual = actual[p]
      }
      if (String(actual || '') !== expected) return false
    }
  }

  const branch = resolveTemplate(condition.branch || 'colony-feedback', ctx)
  const filePath = resolveTemplate(condition.path || '', ctx)
  if (!filePath) return false

  const slug = `${ctx.repo.owner}/${ctx.repo.name}`
  try {
    const response = await gh(['api', `repos/${slug}/contents/${filePath}?ref=${branch}`])
    const parsed = JSON.parse(response)
    if (Array.isArray(parsed)) {
      // Directory — compute composite SHA from all file SHAs
      const shas = parsed.map((f: any) => f.sha).filter(Boolean).sort().join('|')
      ctx.contentSha = shas ? createHash('sha256').update(shas).digest('hex').slice(0, 12) : undefined
    } else {
      // Single file
      ctx.contentSha = parsed.sha || undefined
    }
    return true
  } catch {
    return false
  }
}

async function evaluatePrChecksFailed(condition: ConditionDef, ctx: TriggerContext): Promise<boolean> {
  if (!ctx.repo || !ctx.pr) return false

  // Check match filters
  if (condition.match) {
    for (const [key, pattern] of Object.entries(condition.match)) {
      const expected = resolveTemplate(pattern, ctx)
      const parts = key.split('.')
      let actual: any = ctx
      for (const p of parts) {
        if (actual == null) break
        actual = actual[p]
      }
      if (String(actual || '') !== expected) return false
    }
  }

  try {
    const checks = await fetchChecks(ctx.repo, ctx.pr.number)
    ctx.checks = checks

    // Filter out excluded checks
    const excludePatterns = condition.exclude || []
    const failedChecks = checks.checks.filter(c => {
      if (c.conclusion !== 'failure' && c.status !== 'failure') return false
      // Exclude checks matching any exclude pattern (case-insensitive substring)
      for (const pattern of excludePatterns) {
        if (c.name.toLowerCase().includes(pattern.toLowerCase())) return false
      }
      return true
    })

    if (failedChecks.length === 0) return false

    // Generate a content hash from the failing check names so dedup
    // knows when the set of failures changes
    const failureKey = failedChecks.map(c => c.name).sort().join('|')
    ctx.contentSha = createHash('sha256').update(failureKey).digest('hex').slice(0, 12)

    return true
  } catch {
    return false
  }
}

/** Minimal glob matcher supporting `*`, `**`, `?`, and `[...]` character classes. */
function matchGlob(path: string, pattern: string): boolean {
  const regexStr = pattern
    .replace(/[.+^${}()|[\]\\]/g, c => c === '[' || c === ']' ? c : `\\${c}`)
    .replace(/\*\*\//g, '(?:.+/)?')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`^${regexStr}$`).test(path)
}

async function evaluateFilesChanged(condition: ConditionDef, ctx: TriggerContext): Promise<boolean> {
  if (!condition.patterns?.length) return true
  const repoPath = ctx.repoPath
  if (!repoPath) return true // no repo path — can't evaluate, always fire
  const sinceCommit = ctx.lastRunCommit
  if (!sinceCommit) return true // first run — no baseline, always fire

  let changedFiles: string[]
  try {
    const { stdout } = await execFileAsync(
      resolveCommand('git'),
      ['diff', '--name-only', sinceCommit, 'HEAD'],
      { cwd: repoPath, timeout: 10000 },
    )
    changedFiles = stdout.trim().split('\n').filter(Boolean)
  } catch {
    return true // git error — fire anyway
  }

  if (changedFiles.length > 1000) return true // too many files — always fire

  const includePatterns = condition.patterns.filter(p => !p.startsWith('!'))
  const excludePatterns = condition.patterns.filter(p => p.startsWith('!')).map(p => p.slice(1))

  const matched = changedFiles.filter(file => {
    const included = includePatterns.length === 0 || includePatterns.some(p => matchGlob(file, p))
    const excluded = excludePatterns.some(p => matchGlob(file, p))
    return included && !excluded
  })

  ctx.filesChangedMatches = matched
  return matched.length > 0
}

function evaluateReviewRequested(condition: ConditionDef, ctx: TriggerContext): boolean {
  void condition
  if (!ctx.pr || !ctx.githubUser) return false
  return ctx.pr.reviewers.includes(ctx.githubUser)
}

function evaluateAuthoredBy(condition: ConditionDef, ctx: TriggerContext): boolean {
  void condition
  if (!ctx.pr || !ctx.githubUser) return false
  return ctx.pr.author === ctx.githubUser
}

function evaluateNotDraft(condition: ConditionDef, ctx: TriggerContext): boolean {
  void condition
  if (!ctx.pr) return false
  return !ctx.pr.draft
}

// ---- Composite Condition Helpers ----

const COMPOSITE_CONDITION_TYPES = new Set<string>(['any-of', 'all-of'])

export function isCompositeCondition(c: ConditionDef | undefined | null): boolean {
  return !!c && COMPOSITE_CONDITION_TYPES.has(c.type)
}

/** Walk the condition tree depth-first (pre-order). Visits composites and leaves. */
export function walkConditions(c: ConditionDef, fn: (sub: ConditionDef) => void): void {
  fn(c)
  if (isCompositeCondition(c) && Array.isArray(c.conditions)) {
    for (const sub of c.conditions) walkConditions(sub, fn)
  }
}

/** True iff the condition tree contains a leaf of the given type. */
export function hasConditionOfType(c: ConditionDef, type: LeafConditionType): boolean {
  let found = false
  walkConditions(c, sub => { if (sub.type === type) found = true })
  return found
}

/** Collect all leaf condition types from a (possibly composite) condition. */
function getLeafConditionTypes(c: ConditionDef): Set<string> {
  const types = new Set<string>()
  walkConditions(c, sub => { if (!isCompositeCondition(sub)) types.add(sub.type) })
  return types
}

/**
 * Recursively normalize a parsed condition object: coerce match/exclude/patterns
 * into their expected shapes and recurse into composite sub-conditions.
 */
function normalizeConditionTree(c: any): void {
  if (!c || typeof c !== 'object') return
  if (c.match && typeof c.match === 'string') c.match = {}
  if (typeof c.exclude === 'string') c.exclude = [c.exclude]
  if (typeof c.patterns === 'string') c.patterns = [c.patterns]
  if (Array.isArray(c.conditions)) {
    for (const sub of c.conditions) normalizeConditionTree(sub)
  }
}

/** Validate that any-of/all-of nodes have a non-empty conditions array. */
function validateConditionTree(c: any): boolean {
  if (!c || typeof c !== 'object' || typeof c.type !== 'string') return false
  if (c.type === 'any-of' || c.type === 'all-of') {
    if (!Array.isArray(c.conditions) || c.conditions.length === 0) return false
    return c.conditions.every(validateConditionTree)
  }
  return true
}

export interface ConditionMatch {
  matched: boolean
  /** The leaf condition that fired (only set when matched=true). */
  matchedLeaf?: ConditionDef
  /** Human-readable path describing where the match originated, e.g. "any-of[0]: review-requested". */
  viaPath?: string
}

async function evaluateLeafCondition(condition: ConditionDef, ctx: TriggerContext): Promise<boolean> {
  switch (condition.type) {
    case 'branch-file-exists': return evaluateBranchFileExists(condition, ctx)
    case 'pr-checks-failed': return evaluatePrChecksFailed(condition, ctx)
    case 'files-changed': return evaluateFilesChanged(condition, ctx)
    case 'review-requested': return evaluateReviewRequested(condition, ctx)
    case 'authored-by': return evaluateAuthoredBy(condition, ctx)
    case 'not-draft': return evaluateNotDraft(condition, ctx)
    case 'always': return true
    default: return false
  }
}

async function evaluateConditionInternal(condition: ConditionDef, ctx: TriggerContext): Promise<ConditionMatch> {
  if (isCompositeCondition(condition)) {
    const subs = condition.conditions
    if (!Array.isArray(subs) || subs.length === 0) return { matched: false }
    const isAnyOf = condition.type === 'any-of'

    let firstMatchedLeaf: ConditionDef | undefined
    let firstMatchedPath: string | undefined
    let firstMatchedSha: string | undefined

    for (let i = 0; i < subs.length; i++) {
      const sub = subs[i]
      const shaBefore = ctx.contentSha
      const subResult = await evaluateConditionInternal(sub, ctx)
      if (subResult.matched) {
        if (!firstMatchedLeaf) {
          firstMatchedLeaf = subResult.matchedLeaf
          firstMatchedPath = `${condition.type}[${i}]${subResult.viaPath ? ` -> ${subResult.viaPath}` : ''}`
          firstMatchedSha = ctx.contentSha
        }
        if (isAnyOf) {
          // any-of short-circuits on first hit
          return { matched: true, matchedLeaf: firstMatchedLeaf, viaPath: firstMatchedPath }
        }
      } else {
        // Roll back contentSha so a non-matching sub-condition can't poison dedup
        ctx.contentSha = shaBefore
        if (!isAnyOf) {
          // all-of short-circuits on first miss
          return { matched: false }
        }
      }
    }

    if (isAnyOf) return { matched: false }

    // all-of: every sub matched. Use the first matched leaf's contentSha for dedup.
    if (firstMatchedSha !== undefined) ctx.contentSha = firstMatchedSha
    return { matched: true, matchedLeaf: firstMatchedLeaf, viaPath: firstMatchedPath }
  }

  // Leaf
  const matched = await evaluateLeafCondition(condition, ctx)
  return {
    matched,
    matchedLeaf: matched ? condition : undefined,
    viaPath: matched ? condition.type : undefined,
  }
}

export async function evaluateCondition(condition: ConditionDef, ctx: TriggerContext): Promise<boolean> {
  const result = await evaluateConditionInternal(condition, ctx)
  return result.matched
}

/** Evaluate a condition and report which sub-condition (if any) fired. */
export async function evaluateConditionWithPath(condition: ConditionDef, ctx: TriggerContext): Promise<ConditionMatch> {
  return evaluateConditionInternal(condition, ctx)
}

// ---- Action Execution (stage runners imported from ./pipeline-stages) ----

/** Configurable prompt-length threshold for the 'auto' heuristic (default: 400 chars). */
const AUTO_MODEL_THRESHOLD = parseInt(process.env.COLONY_AUTO_MODEL_THRESHOLD ?? '400', 10)

/**
 * Resolve 'auto' model hint to a concrete model ID using the v1 heuristic.
 * Short prompt (≤ threshold) + no handoffInputs + launch-session type → haiku.
 * Otherwise falls back to pipelineDefaultModel (or undefined, letting caller use global default).
 */
function resolveAutoModel(action: ActionDef, pipelineDefaultModel?: string): string | undefined {
  const isShort = (action.prompt?.length ?? 0) <= AUTO_MODEL_THRESHOLD
  const noHandoff = !action.handoffInputs?.length
  const isSession = action.type === 'launch-session'
  if (isShort && noHandoff && isSession) return 'claude-haiku-4-5-20251001'
  return pipelineDefaultModel
}

/**
 * Model resolution precedence: action.model → pipeline.default_model → global default (caller's choice).
 * 'auto' is resolved via the v1 heuristic (see resolveAutoModel).
 * Returns undefined when neither is set, letting createInstance fall through to the global setting.
 */
export function resolveActionModel(action: ActionDef, pipelineDefaultModel?: string): string | undefined {
  if (action.model === 'auto') return resolveAutoModel(action, pipelineDefaultModel)
  return action.model ?? pipelineDefaultModel
}

/**
 * Recursively apply the pipeline's default_model to any action (and its parallel sub-stages)
 * that do not already have an explicit model override. Also resolves 'auto' to a concrete model.
 * Must be called before firing.
 */
function applyDefaultModel(action: ActionDef, defaultModel: string | undefined): ActionDef {
  let concreteModel: string | undefined
  if (action.model === 'auto') {
    concreteModel = resolveAutoModel(action, defaultModel)
  } else {
    if (!defaultModel) return action
    concreteModel = action.model ?? defaultModel
  }
  const resolved: ActionDef = { ...action, model: concreteModel }
  if (resolved.stages) resolved.stages = resolved.stages.map(s => applyDefaultModel(s, defaultModel))
  return resolved
}

function findNamedAction(root: ActionDef, name: string): ActionDef | undefined {
  if (root.name === name) return root
  if (root.stages) {
    for (const s of root.stages) {
      const found = findNamedAction(s, name)
      if (found) return found
    }
  }
  return undefined
}

// Active idle-nudge intervals: instanceId → intervalId (for cleanup)
const _idleNudgeIntervals = new Map<string, ReturnType<typeof setInterval>>()

function setupIdleNudge(
  instanceId: string,
  nudgeConfig: NonNullable<ActionDef['idle_nudge']>,
  pipelineName: string,
): void {
  const maxNudges = nudgeConfig.max_nudges ?? 2
  const thresholdMs = nudgeConfig.after_minutes * 60_000
  let nudgeCount = 0
  const router = getDaemonRouter()

  const interval = setInterval(async () => {
    if (nudgeCount >= maxNudges) {
      clearInterval(interval)
      _idleNudgeIntervals.delete(instanceId)
      return
    }
    const idleList = getIdleInfo()
    const entry = idleList.find(e => e.id === instanceId)
    if (!entry || entry.idleMs < thresholdMs) return

    nudgeCount++
    plog(pipelineName, `Nudging session ${instanceId} after ${Math.round(entry.idleMs / 60000)}m idle (${nudgeCount}/${maxNudges})`)
    try {
      await router.steerInstance(instanceId, nudgeConfig.message + '\n')
    } catch { /* session already gone */ }

    appendActivity({
      source: 'pipeline',
      name: pipelineName,
      summary: `Nudged session after ${nudgeConfig.after_minutes}m idle (${nudgeCount}/${maxNudges})`,
      level: 'info',
    })

    const p = [...pipelines.values()].find(pp => pp.def.name === pipelineName)
    if (p?.def.notifications && p.def.notifications !== 'none') {
      notify(`Colony: nudged session — idle ${nudgeConfig.after_minutes}m`, pipelineName, 'pipelines').catch(() => {})
    }
  }, 30_000) // check every 30s

  _idleNudgeIntervals.set(instanceId, interval)

  // Clean up when session exits
  const exitHandler = (exitedId: string) => {
    if (exitedId !== instanceId) return
    router.removeListener('exited', exitHandler)
    clearInterval(interval)
    _idleNudgeIntervals.delete(instanceId)
  }
  router.on('exited', exitHandler)
}

function setupOnFailureExitListener(
  instanceId: string,
  action: ActionDef,
  onFailure: OnFailureConfig,
  ctx: TriggerContext,
  pipelineName: string,
  runId: string,
  retriesRemaining: number,
): void {
  const maxRetries = onFailure.retry?.max ?? 0
  const router = getDaemonRouter()

  const handler = async (exitedId: string, exitCode: number) => {
    if (exitedId !== instanceId) return
    router.removeListener('exited', handler)
    if (exitCode === 0) return

    const attempt = maxRetries - retriesRemaining + 1
    plog(pipelineName, `on_failure triggered for "${action.name || action.type}" (exit ${exitCode})`)

    if (onFailure.retry && retriesRemaining > 0) {
      let bufferContext = ''
      try {
        const raw = await router.getInstanceBuffer(instanceId)
        const lines = stripAnsi(raw).split('\n').filter((l: string) => l.trim()).slice(-30).join('\n')
        if (lines) bufferContext = lines
      } catch { /* buffer unavailable */ }

      const retryPrefix = `[RETRY ${attempt}/${maxRetries}] Previous run failed (exit ${exitCode}).${bufferContext ? `\n\nLast output:\n${bufferContext}` : ''}\n\n---\n\n`
      const retryAction: ActionDef = {
        ...action,
        name: `${action.name || pipelineName} [RETRY ${attempt}/${maxRetries}]`,
        prompt: retryPrefix + (action.prompt || ''),
        on_failure: undefined,
      }
      try {
        const retryCtx: TriggerContext = { ...ctx, error: `Exit code ${exitCode}` }
        const result = await fireAction(retryAction, retryCtx, pipelineName, runId)
        if (result.sessionId) {
          setupOnFailureExitListener(result.sessionId, action, onFailure, ctx, pipelineName, runId, retriesRemaining - 1)
        }
        return
      } catch (err) {
        plog(pipelineName, `⚠ on_failure retry ${attempt} launch failed: ${String(err)}`)
      }
    }

    if (onFailure.notify) {
      const retryNote = maxRetries > 0 ? ` after ${maxRetries} retries` : ''
      notify(`Pipeline failure: ${pipelineName}`, `"${action.name || action.type}" failed${retryNote} (exit ${exitCode})`, 'pipelines').catch(() => {})
    }

    if (onFailure.run) {
      const p = [...pipelines.values()].find(pp => pp.def.name === pipelineName)
      const target = p ? findNamedAction(p.def.action, onFailure.run) : undefined
      if (target) {
        const safeTarget = { ...target, on_failure: target.on_failure?.run ? { ...target.on_failure, run: undefined } : target.on_failure }
        const failCtx: TriggerContext = { ...ctx, error: `Exit code ${exitCode}` }
        fireAction(safeTarget, failCtx, pipelineName).then(() => {
          plog(pipelineName, `✓ on_failure.run "${onFailure.run}" completed`)
        }).catch(e => {
          plog(pipelineName, `⚠ on_failure.run "${onFailure.run}" failed: ${String(e)}`)
        })
      } else {
        plog(pipelineName, `⚠ on_failure.run: action "${onFailure.run}" not found in pipeline action tree`)
      }
    }
  }

  router.on('exited', handler)
}

// Tracks the last instance ID created by fireAction (or inner helpers).
// Used by fireActionWithRetry to inject PTY context on retry after a failed attempt.
let _lastFireActionInstanceId: string | undefined

async function fireActionWithRetry(
  action: ActionDef,
  ctx: TriggerContext,
  pipelineName: string,
  overrides?: RunOverrides,
): Promise<{ cost: number; responseSnippet?: string; subStages?: PipelineStageTrace[]; retryCount: number; sessionId?: string; retryContext?: boolean }> {
  // wait_for_session is a polling action — never retry it
  const maxRetries = action.type === 'wait_for_session' ? 0 : (action.max_retries ?? 0)
  const baseDelay = action.retry_delay_ms ?? 5000
  let lastError: unknown
  let lastSessionId: string | undefined
  let retryContextUsed = false

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 60000)
        plog(pipelineName, `retry ${attempt}/${maxRetries} after ${delay}ms`)
        await new Promise(r => setTimeout(r, delay))
      }

      let actionToFire = action
      if (attempt > 0 && lastSessionId) {
        const ctxPrefix = await buildRetryContextPrefix(lastSessionId, attempt, maxRetries)
        if (ctxPrefix) {
          actionToFire = { ...action, prompt: ctxPrefix + (action.prompt || '') }
          retryContextUsed = true
          plog(pipelineName, `retry ${attempt}: injected PTY context from session ${lastSessionId}`)
        }
      }

      _lastFireActionInstanceId = undefined
      const result = await fireAction(actionToFire, ctx, pipelineName, undefined, overrides)
      lastSessionId = result.sessionId
      return { ...result, retryCount: attempt, retryContext: retryContextUsed || undefined }
    } catch (err) {
      lastSessionId = lastSessionId ?? _lastFireActionInstanceId
      lastError = err
      if (attempt < maxRetries) {
        plog(pipelineName, `stage failed (attempt ${attempt + 1}/${maxRetries + 1}): ${String(err)}`)
      }
    }
  }
  throw lastError
}

async function buildRetryContextPrefix(sessionId: string, attempt: number, maxRetries: number): Promise<string> {
  try {
    const router = getDaemonRouter()
    const raw = await router.getInstanceBuffer(sessionId)
    const lines = stripAnsi(raw).split('\n').filter((l: string) => l.trim()).slice(-20)
    if (!lines.length) return `[RETRY ${attempt}/${maxRetries}] Previous attempt failed.\n\n---\n\n`
    return `[RETRY ${attempt}/${maxRetries}] Previous attempt failed. Last 20 lines of output:\n\`\`\`\n${lines.join('\n')}\n\`\`\`\n\n---\n\n`
  } catch {
    return `[RETRY ${attempt}/${maxRetries}] Previous attempt failed.\n\n---\n\n`
  }
}

async function fireAction(action: ActionDef, ctx: TriggerContext, pipelineName: string, runId?: string, overrides?: RunOverrides): Promise<{ cost: number; responseSnippet?: string; subStages?: PipelineStageTrace[]; sessionId?: string }> {
  markChecklistItem('ranPipeline')
  const effectiveRunId = runId || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const pipelineMeta = { pipelineName, pipelineRunId: effectiveRunId }

  // Merge playbook defaults under explicit action fields (action wins)
  if (action.playbook) {
    const pb = getPlaybook(action.playbook)
    if (pb) {
      action = {
        model: pb.model,
        workingDirectory: pb.workingDirectory,
        prompt: pb.prompt,
        ...action, // explicit action fields win
      }
    } else {
      plog(pipelineName, `⚠ playbook "${action.playbook}" not found — running without playbook defaults`)
    }
  }
  if (action.type === 'maker-checker') {
    const mc = await runMakerChecker(action, ctx, pipelineName, pipelineMeta)
    _lastFireActionInstanceId = mc.sessionId
    return { cost: mc.cost, sessionId: mc.sessionId }
  }
  if (action.type === 'diff_review') {
    const dr = await runDiffReview(action, ctx, pipelineName, pipelineMeta)
    _lastFireActionInstanceId = dr.sessionId
    return dr
  }
  if (action.type === 'parallel') {
    return runParallel(action, ctx, pipelineName, (a, c, n) => fireAction(a, c, n, effectiveRunId), pipelineMeta)
  }
  if (action.type === 'plan') {
    return runPlanStage(action, ctx, pipelineName, pipelineMeta)
  }
  if (action.type === 'wait_for_session') {
    return runWaitForSession(action, pipelineName)
  }
  if (action.type === 'best-of-n') {
    return runBestOfN(action, ctx, pipelineName, pipelineMeta)
  }
  if (action.type === 'trigger_pipeline') {
    if (!action.target) throw new Error('trigger_pipeline requires a target pipeline name')
    if (executingPipelines.has(action.target)) {
      plog(pipelineName, `⊘ circular chain: "${action.target}" already executing — skipping`)
      return { cost: 0, responseSnippet: `Skipped: circular chain to "${action.target}"` }
    }
    plog(pipelineName, `→ triggering pipeline "${action.target}"`)
    const triggered = triggerPollNow(action.target)
    if (!triggered) {
      plog(pipelineName, `⚠ trigger_pipeline: pipeline "${action.target}" not found`)
      return { cost: 0, responseSnippet: `Pipeline "${action.target}" not found` }
    }
    return { cost: 0, responseSnippet: `Triggered pipeline "${action.target}"` }
  }

  const rawName = resolveTemplate(action.name || pipelineName || 'Pipeline Session', ctx)
  // Prefix with "Pipe" so pipeline-launched sessions are identifiable
  const name = rawName.startsWith('Pipe') ? rawName : `Pipe (${rawName})`
  const cwd = overrides?.workingDirectory?.trim() || resolveTemplate(action.workingDirectory || '', ctx) || undefined
  // Use overrides.prompt if provided (one-shot manual override); otherwise resolve from action config
  // If templateVarOverrides provided, apply them as extra context variables during resolution
  let prompt = (overrides?.prompt?.trim()) ? overrides.prompt : resolveTemplate(action.prompt || '', ctx, overrides?.templateVarOverrides)

  // Inject configured repos context so sessions know which repos Colony tracks
  if (ctx.repoSlugs?.length) {
    prompt += `\n\n--- Configured Repositories ---\nThe following repositories are tracked by Colony. Use ONLY these repos unless the prompt specifies otherwise:\n${ctx.repoSlugs.map(s => `- ${s}`).join('\n')}\nDo NOT use repositories that are not in this list — they may be stale or deprecated.`
  }

  // Inject artifact preamble (raw data from prior captures)
  if (action.artifactInputs?.length) {
    const preamble = await loadArtifactPreamble(action.artifactInputs)
    if (preamble) prompt = preamble + prompt
  }

  // Inject structured handoff on top — handoff precedes raw artifacts so context comes first
  if (action.handoffInputs?.length) {
    const handoff = await loadHandoffPreamble(action.handoffInputs)
    if (handoff) prompt = handoff + prompt
  }

  // Inject living spec preamble — spec precedes handoff so it's the first thing the session sees
  if (action.specInput) {
    const spec = await loadSpecPreamble(action.specInput)
    if (spec) prompt = spec + prompt
  }

  // Inject timestamped output directory when action.outputs is configured
  if (action.outputs) {
    const resolvedBase = resolveTemplate(action.outputs, ctx).replace(/^~/, app.getPath('home'))
    const now = new Date()
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`
    const outputDir = join(resolvedBase, ts)
    prompt += `\n\n--- Output Directory ---\nWrite all output files to: ${outputDir}\nCreate it first: mkdir -p ${outputDir}\nDo NOT use hardcoded output paths from task prompts — always use this directory instead.`
    log(`Output directory injected: ${outputDir}`)
  }

  // Inject pipeline memory and always tell the session where to write learnings
  const p = [...pipelines.values()].find(pp => pp.def.name === pipelineName)
  if (p) {
    const memPath = join(PIPELINES_DIR, `${p.fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
    if (await pathExists(memPath)) {
      const memory = (await fsp.readFile(memPath, 'utf-8')).trim()
      if (memory) {
        prompt += `\n\n--- Pipeline Memory ---\nThe following are learnings from previous runs. Use these to improve your approach:\n\n${memory}`
      }
    }
    prompt += `\n\nWhen you finish, if you learned anything new about tools, approaches, or useful patterns that would help future runs, append it to ${memPath}`

    // Inject one-shot notes and auto-clear
    const notes = getPipelineNotes(p.fileName)
    if (notes.length > 0) {
      prompt += `\n\n--- User Notes (one-shot) ---\nThe user left these notes specifically for this run. Address them and then disregard — they will not appear again:\n${notes.map(n => `- [${n.createdAt}] ${n.text}`).join('\n')}`
      clearPipelineNotes(p.fileName)
      log(`Injected and cleared ${notes.length} one-shot note(s)`)
    }
  }

  // Inject spec-append instructions — tell the session to write decisions to a known artifact file
  let specDecisionsFile: string | undefined
  if (action.specAppend) {
    const artifactsDir = join(COLONY_DIR, 'artifacts')
    specDecisionsFile = join(artifactsDir, `${action.specAppend}-decisions.txt`)
    prompt += `\n\n--- Spec Decisions ---\nWhen you make key decisions during this task, write a brief summary of each decision to: ${specDecisionsFile}\nOne decision per line. These will be appended to the living spec automatically.`
  }

  // ---- Route to existing session ----
  // ---- Reuse: try to route to existing session ----
  const shouldRoute = action.reuse === true
  if (shouldRoute) {
    const matchDef = action.match || {}
    const resolvedMatch = {
      gitBranch: matchDef.gitBranch ? resolveTemplate(matchDef.gitBranch, ctx) : ctx.pr?.branch,
      workingDirectory: matchDef.workingDirectory ? resolveTemplate(matchDef.workingDirectory, ctx) : undefined,
      repoName: ctx.repo?.name,
      prNumber: ctx.pr?.number,
      role: matchDef.role,
    }

    plog(name, `reuse: looking for branch=${resolvedMatch.gitBranch} dir=${resolvedMatch.workingDirectory} repo=${resolvedMatch.repoName} pr=#${resolvedMatch.prNumber}`)
    const route = await findBestRoute(resolvedMatch, log)

    if (route?.type === 'running') {
      const existing = route.instance
      plog(name, `route: found running session "${existing.name}" (${existing.id}) activity=${existing.activity}`)

      if (existing.activity === 'waiting') {
        const filePath = await writePromptFile(prompt)
        getDaemonRouter().writeToInstance(existing.id, buildFilePromptTrigger(filePath) + '\r')
        broadcast('pipeline:fired', { pipeline: name, instanceId: existing.id, routed: true })
        return { cost: 0, sessionId: existing.id }
      }

      if (action.busyStrategy === 'launch-new') {
        plog(name, `route: session busy, busyStrategy=launch-new → launching new`)
      } else {
        log(`Routing: session busy, waiting for idle (60s timeout)...`)
        const sent = await sendPromptToExistingSession(existing.id, prompt)
        if (sent) {
          broadcast('pipeline:fired', { pipeline: name, instanceId: existing.id, routed: true })
          return { cost: 0, sessionId: existing.id }
        }
        log(`Routing: timed out waiting for session, falling through to launch new`)
      }
    } else if (route?.type === 'resume') {
      plog(name, `route: resuming history session "${route.name}" (${route.sessionId})`)
      const promptFile = await writePromptFile(prompt)
      const inst = await createInstance({
        name: name,
        workingDirectory: route.project,
        color: action.color,
        args: ['--resume', route.sessionId, '--append-system-prompt-file', promptFile],
        mcpServers: action.mcpServers,
        model: action.model,
        ...pipelineMeta,
      })
      await sendPromptWhenReady(inst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
      broadcast('pipeline:fired', { pipeline: name, instanceId: inst.id, routed: true, resumed: true })
      return { cost: 0, sessionId: inst.id }
    } else {
      plog(name, `route: no matching session found → launching new`)
    }
  }

  // ---- Launch new session (fallback when reuse finds nothing) ----
  if (action.type !== 'launch-session') return { cost: 0 }

  // If no working directory resolved, try to infer from running sessions in same repo
  let resolvedCwd = cwd
  if (!resolvedCwd && ctx.repo?.name) {
    const all = await getAllInstances()
    const repoLower = ctx.repo.name.toLowerCase()
    const match = all.find(i =>
      i.status === 'running' &&
      (i.workingDirectory.toLowerCase().endsWith('/' + repoLower) ||
       i.workingDirectory.toLowerCase().includes('/' + repoLower + '/'))
    )
    if (match) {
      // Extract the repo root from the matched session's directory
      const idx = match.workingDirectory.toLowerCase().indexOf('/' + repoLower)
      resolvedCwd = match.workingDirectory.slice(0, idx + 1 + repoLower.length)
      log(`Inferred working directory from session "${match.name}": ${resolvedCwd}`)
    }
  }

  // Capture artifact outputs before launching (captures current env state)
  if (action.artifactOutputs?.length) {
    await captureArtifacts(action.artifactOutputs, resolvedCwd)
  }

  plog(name, `launching session "${name}" in ${resolvedCwd || '$HOME (no cwd resolved!)'}`)

  const promptFile = await writePromptFile(prompt)
  const effortArgs = (action.effort) ? ['--effort', action.effort] : []
  const inst = await createInstance({
    name,
    workingDirectory: resolvedCwd,
    color: action.color,
    args: [...effortArgs, '--append-system-prompt-file', promptFile],
    mcpServers: action.mcpServers,
    model: overrides?.model || action.model,
    ...pipelineMeta,
  })
  _lastFireActionInstanceId = inst.id

  // Full prompt is in the system prompt file — just send a trigger
  await sendPromptWhenReady(inst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })

  // Idle nudge — poke the session if it stalls
  if (action.idle_nudge?.after_minutes && action.idle_nudge.message) {
    setupIdleNudge(inst.id, action.idle_nudge, pipelineName)
  }

  // Auto-close: kill session if still running after timeout (default 10 min).
  // Use stable-idle detection to avoid false-positives from the daemon's
  // 2s PTY-lull heuristic (which fires during tool execution / long reasoning).
  const autoCloseMinutes = action.timeout_minutes || 10
  const stableMs = (action.stable_waiting_seconds ?? 20) * 1000
  const { promise: stablePromise } = waitForStableIdle(inst.id, {
    stableMs,
    absoluteMs: autoCloseMinutes * 60_000,
  })
  stablePromise.then(async (outcome) => {
    if (outcome === 'exited') {
      tagArtifactPipeline(inst.id, effectiveRunId).catch(() => {})
      return
    }
    if (outcome === 'stable') {
      log(`pipeline session ${inst.id} idle ${stableMs}ms, killing in 5s`)
      tagArtifactPipeline(inst.id, effectiveRunId).catch(() => {})
      // Append captured decisions to living spec if specAppend is configured
      if (action.specAppend && specDecisionsFile) {
        try {
          if (await pathExists(specDecisionsFile)) {
            const decisions = (await fsp.readFile(specDecisionsFile, 'utf-8')).trim()
            if (decisions) {
              await appendToSpec(action.specAppend, decisions, action.name || pipelineName)
            }
          }
        } catch (err: any) {
          log(`[spec] failed to append decisions for "${action.specAppend}": ${err?.message}`)
        }
      }
      setTimeout(async () => {
        try { await killInstance(inst.id) } catch { /* already gone */ }
      }, 5000)
    } else {
      log(`pipeline session ${inst.id} still running after ${autoCloseMinutes}min, force-killing`)
      tagArtifactPipeline(inst.id, effectiveRunId).catch(() => {})
      try { await killInstance(inst.id) } catch { /* already gone */ }
    }
  })

  // Notify renderer about pipeline-triggered session
  broadcast('pipeline:fired', { pipeline: name, instanceId: inst.id })
  return { cost: 0, sessionId: inst.id }
}

// ---- Preview (Dry-Run) ----

export interface PreviewMatch {
  description: string
  resolvedVars: Record<string, string>
  wouldBeDeduped: boolean
}

export interface PreviewResult {
  wouldFire: boolean
  matches: PreviewMatch[]
  conditionLog: string[]
  error?: string
}

/**
 * Dry-run a pipeline: evaluate trigger + conditions without launching any sessions.
 * Accepts a fileName (e.g. "ci-auto-fix.yaml") or pipeline name.
 */
export async function previewPipeline(fileNameOrName: string): Promise<PreviewResult> {
  // Find by fileName or name
  let entry = [...pipelines.values()].find(p => p.fileName === fileNameOrName)
  if (!entry) entry = [...pipelines.values()].find(p => p.def.name === fileNameOrName)

  if (!entry) {
    return { wouldFire: false, matches: [], conditionLog: [`Pipeline not found: ${fileNameOrName}`], error: 'Pipeline not found' }
  }

  const { def } = entry
  const conditionLog: string[] = []
  const matches: PreviewMatch[] = []

  function plog(msg: string) {
    const ts = new Date().toISOString().slice(11, 19)
    conditionLog.push(`[${ts}] ${msg}`)
  }

  try {
    const repoSlugs = (await getRepos()).map(r => `${r.owner}/${r.name}`)
    let contexts: TriggerContext[] = []

    if (def.trigger.type === 'git-poll') {
      plog(`Fetching PRs (git-poll, ${def.trigger.repos === 'auto' ? 'auto repos' : 'custom repos'})`)
      contexts = await executeGitPollTrigger(def.trigger, def.condition)
      for (const ctx of contexts) ctx.repoSlugs = repoSlugs
      const previewFetchErrors = (contexts as any)._fetchErrors as string[] | undefined
      if (previewFetchErrors) {
        for (const e of previewFetchErrors) plog(e)
        delete (contexts as any)._fetchErrors
      }
      plog(`Found ${contexts.length} repo/PR context(s) to evaluate`)
    } else if (def.trigger.type === 'cron') {
      plog(`Cron trigger — creating single context`)
      contexts = [{ githubUser: githubUser || undefined, timestamp: new Date().toISOString(), repoSlugs }]
    } else {
      plog(`Trigger type "${def.trigger.type}" not supported for preview`)
    }

    if (contexts.length === 0) {
      plog(`No contexts — check: repos configured? PRs open? gh auth ok?`)
    }

    // files-changed condition: inject repoPath + lastRunCommit for preview evaluation
    if (hasConditionOfType(def.condition, 'files-changed') && contexts.length > 0) {
      const repos = await getRepos()
      const history = await getHistory(def.name)
      const lastSuccess = [...history].reverse().find(e => e.success && e.headCommit)
      const lastCommit = lastSuccess?.headCommit
      for (const ctx of contexts) {
        ctx.repoPath = ctx.repo?.localPath || def.action.workingDirectory || repos[0]?.localPath
        ctx.lastRunCommit = lastCommit
      }
      if (lastCommit) {
        plog(`files-changed: comparing against last run commit ${lastCommit.slice(0, 8)}`)
      } else {
        plog(`files-changed: no prior run — condition will fire (first run)`)
      }
    }

    for (const ctx of contexts) {
      const prLabel = ctx.pr ? `PR #${ctx.pr.number} (${ctx.pr.branch})` : 'cron'
      const repoLabel = ctx.repo ? `${ctx.repo.owner}/${ctx.repo.name}` : ''
      plog(`Evaluating: ${[repoLabel, prLabel].filter(Boolean).join(' ')}`)

      const evalResult = await evaluateConditionWithPath(def.condition, ctx)
      if (!evalResult.matched) {
        const condDetail = def.condition.type === 'files-changed'
          ? `no matching file changes`
          : isCompositeCondition(def.condition)
            ? `no sub-condition matched`
            : `${def.condition.path || def.condition.branch || ''}`
        plog(`  condition not met (${def.condition.type}: ${condDetail})`)
        continue
      }
      const viaSuffix = isCompositeCondition(def.condition) && evalResult.viaPath ? ` via ${evalResult.viaPath}` : ''
      if (hasConditionOfType(def.condition, 'files-changed') && ctx.filesChangedMatches?.length) {
        plog(`  ✓ files-changed: ${ctx.filesChangedMatches.length} file(s) matched — ${ctx.filesChangedMatches.slice(0, 5).join(', ')}${ctx.filesChangedMatches.length > 5 ? `… (+${ctx.filesChangedMatches.length - 5} more)` : ''}${viaSuffix}`)
      } else {
        plog(`  ✓ condition matched (sha=${ctx.contentSha || 'none'})${viaSuffix}`)
      }

      const dedup = def.dedup || { key: '{{timestamp}}', ttl: 3600 }
      const dedupKey = resolveTemplate(dedup.key, ctx)
      const wouldBeDeduped = isDuplicate(def.name, dedupKey, dedup.ttl || 3600, ctx.contentSha)
      if (wouldBeDeduped) {
        plog(`  ⊘ would be deduped (key=${dedupKey})`)
      } else {
        plog(`  → would fire action: ${def.action.type}`)
      }

      // Collect resolved template vars for this context
      const resolvedVars: Record<string, string> = {
        'action.name': resolveTemplate(def.action.name || def.name || 'Pipeline Session', ctx),
        'dedup.key': dedupKey,
      }
      if (def.action.workingDirectory) resolvedVars['action.workingDirectory'] = resolveTemplate(def.action.workingDirectory, ctx)
      if (ctx.pr) {
        resolvedVars['pr.number'] = String(ctx.pr.number)
        resolvedVars['pr.branch'] = ctx.pr.branch
        resolvedVars['pr.title'] = ctx.pr.title || ''
      }
      if (ctx.repo) {
        resolvedVars['repo.owner'] = ctx.repo.owner
        resolvedVars['repo.name'] = ctx.repo.name
      }

      const description = ctx.pr
        ? `PR #${ctx.pr.number}: ${ctx.pr.branch} (${repoLabel})`
        : `cron context (${new Date().toISOString().slice(0, 10)})`

      matches.push({ description, resolvedVars, wouldBeDeduped })
    }
  } catch (err) {
    plog(`✗ Error: ${err}`)
    return { wouldFire: false, matches, conditionLog, error: String(err) }
  }

  const wouldFire = matches.some(m => !m.wouldBeDeduped)
  return { wouldFire, matches, conditionLog }
}

// ---- Poll Loop ----

function shouldNotify(def: PipelineDef, severity: 'info' | 'warning' | 'critical'): boolean {
  const level = def.notifications ?? 'all'
  if (level === 'none') return false
  if (level === 'failures') return severity !== 'info'
  return true
}

async function runPoll(pipelineName: string, overrides?: RunOverrides): Promise<void> {
  const p = pipelines.get(pipelineName)
  if (!p || !p.def.enabled) return
  if (p.def.pausedUntil !== undefined && p.def.pausedUntil !== null) {
    if (new Date(p.def.pausedUntil) > new Date()) return // still paused
    // Auto-resume: expiry passed
    p.def.pausedUntil = undefined
    await savePauseState(pipelineName, undefined)
  } else if (p.def.pausedUntil === null) {
    return // paused indefinitely
  }
  if (runningPolls.has(pipelineName)) return // prevent overlapping polls

  runningPolls.add(pipelineName)
  broadcast('pipeline:status', getPipelineList())

  // Start a new iteration in the debug log
  p.state.debugLog.push(DEBUG_ITERATION_SEP)
  p.state.lastPollAt = new Date().toISOString()
  const pollStartedAt = Date.now()
  let fired = false
  let pollError = false
  const stages: PipelineStageTrace[] = []
  let totalCost = 0
  let stoppedBudget = false
  let webhookFired = false
  let webhookDeliveries: WebhookDeliveryResult[] = []
  let budgetWarnSent = false
  let runDedupAttempt: number | undefined
  let runDedupMaxRetries: number | undefined
  let headCommitForHistory: string | undefined
  const tcMatchedPRs: number[] = []
  const tcNewCommits: string[] = []
  const tcMatchedFiles: string[] = []

  try {
    // Fetch configured repo slugs once for template resolution
    const repoSlugs = (await getRepos()).map(r => `${r.owner}/${r.name}`)
    let contexts: TriggerContext[] = []

    if (p.def.trigger.type === 'git-poll') {
      plog(pipelineName, `polling (git-poll, ${p.def.trigger.repos === 'auto' ? 'auto repos' : 'custom repos'})`)
      contexts = await executeGitPollTrigger(p.def.trigger, p.def.condition)
      // Inject repoSlugs into git-poll contexts (they already have individual repo set)
      for (const ctx of contexts) ctx.repoSlugs = repoSlugs
      const fetchErrors = (contexts as any)._fetchErrors as string[] | undefined
      if (fetchErrors) {
        for (const e of fetchErrors) plog(pipelineName, e)
        delete (contexts as any)._fetchErrors
      }
      plog(pipelineName, `found ${contexts.length} repo/PR contexts to evaluate`)
    } else if (p.def.trigger.type === 'cron') {
      plog(pipelineName, `cron triggered`)
      contexts = [{
        githubUser: githubUser || undefined,
        timestamp: new Date().toISOString(),
        repoSlugs,
      }]
    } else if (p.def.trigger.type === 'file-poll') {
      plog(pipelineName, `file change detected`)
      contexts = [{
        githubUser: githubUser || undefined,
        timestamp: new Date().toISOString(),
        repoSlugs,
      }]
    } else if (p.def.trigger.type === 'webhook') {
      plog(pipelineName, `webhook triggered`)
      const payload = webhookPayloads.get(pipelineName)
      webhookPayloads.delete(pipelineName)
      contexts = [{
        githubUser: githubUser || undefined,
        timestamp: new Date().toISOString(),
        webhookPayload: payload,
        repoSlugs,
      }]
    }

    if (contexts.length === 0) {
      plog(pipelineName, `no contexts — check: repos configured? PRs open? gh auth ok?`)
    }

    // files-changed condition: inject repoPath + lastRunCommit into all contexts
    if (hasConditionOfType(p.def.condition, 'files-changed') && contexts.length > 0) {
      const history = await getHistory(pipelineName)
      const lastSuccess = [...history].reverse().find(e => e.success && e.headCommit)
      const lastCommit = lastSuccess?.headCommit
      const repos = await getRepos()
      for (const ctx of contexts) {
        ctx.repoPath = ctx.repo?.localPath || p.def.action.workingDirectory || repos[0]?.localPath
        ctx.lastRunCommit = lastCommit
      }
      if (lastCommit) {
        plog(pipelineName, `files-changed: comparing against ${lastCommit.slice(0, 8)}`)
      } else {
        plog(pipelineName, `files-changed: no prior run commit — will fire on first run`)
      }
      // Capture current HEAD so we can store it in history after the run
      const repoPathForHead = contexts[0]?.repoPath
      if (repoPathForHead) {
        try {
          const { stdout } = await execFileAsync(
            resolveCommand('git'), ['rev-parse', 'HEAD'], { cwd: repoPathForHead, timeout: 5000 },
          )
          headCommitForHistory = stdout.trim()
        } catch { /* ignore — non-git dir */ }
      }
    }

    // run_condition: has_changes — skip cron-triggered pipelines if no new commits since last fire
    if (p.def.run_condition === 'has_changes' && p.def.trigger.type === 'cron' && p.state.lastFiredAt) {
      const repos = await getRepos()
      const cwd = p.def.action.workingDirectory
        || (repos.length > 0 ? repos[0].localPath : null)
        || process.cwd()
      try {
        const { stdout } = await execFileAsync(resolveCommand('git'), ['log', '--oneline', '-1', `--after=${p.state.lastFiredAt}`], { encoding: 'utf-8', timeout: 5000, cwd })
        if (!stdout.trim()) {
          plog(pipelineName, `⊘ run_condition: no changes since last fire (${p.state.lastFiredAt})`)
          return
        }
      } catch { /* not a git repo — run anyway */ }
    }

    for (const ctx of contexts) {
      const prLabel = ctx.pr ? `PR #${ctx.pr.number} (${ctx.pr.branch})` : 'no PR'
      const repoLabel = ctx.repo ? `${ctx.repo.owner}/${ctx.repo.name}` : 'no repo'
      plog(pipelineName, `evaluating: ${repoLabel} ${prLabel}`)

      if (ctx.repo && !ctx.repo.localPath) {
        plog(pipelineName, `⚠ repo ${repoLabel} has no localPath — session launch will use fallback cwd`)
      }

      const evalResult = await evaluateConditionWithPath(p.def.condition, ctx)
      if (!evalResult.matched) {
        const condDetail = p.def.condition.type === 'files-changed'
          ? `no matching file changes`
          : isCompositeCondition(p.def.condition)
            ? `no sub-condition matched`
            : `${p.def.condition.path || p.def.condition.branch || ''}`
        plog(pipelineName, `condition not met for ${prLabel} (${p.def.condition.type}: ${condDetail})`)
        continue
      }
      p.state.lastMatchAt = new Date().toISOString()
      const viaSuffix = isCompositeCondition(p.def.condition) && evalResult.viaPath ? ` via ${evalResult.viaPath}` : ''
      if (hasConditionOfType(p.def.condition, 'files-changed') && ctx.filesChangedMatches?.length) {
        plog(pipelineName, `✓ files-changed: ${ctx.filesChangedMatches.length} file(s) matched — ${ctx.filesChangedMatches.slice(0, 3).join(', ')}${ctx.filesChangedMatches.length > 3 ? '…' : ''}${viaSuffix}`)
      } else {
        plog(pipelineName, `✓ condition matched for ${prLabel} (sha=${ctx.contentSha || 'none'})${viaSuffix}`)
      }

      const dedup = p.def.dedup || { key: '{{timestamp}}', ttl: 3600 }
      const dedupKey = resolveTemplate(dedup.key, ctx)
      let dedupRetryAttempt: number | null = null
      if (isDuplicate(pipelineName, dedupKey, dedup.ttl || 3600, ctx.contentSha)) {
        const maxRetries = dedup.maxRetries ?? 0
        if (maxRetries > 0 && ctx.contentSha) {
          dedupRetryAttempt = await getRetryAttempt(pipelineName, dedupKey, maxRetries)
        }
        if (dedupRetryAttempt === null) {
          plog(pipelineName, `⊘ dedup: already processed ${dedupKey} with same content`)
          continue
        }
        plog(pipelineName, `↻ dedup retry ${dedupRetryAttempt + 1}/${maxRetries} for ${dedupKey} (session exited)`)
        runDedupAttempt = dedupRetryAttempt + 1
        runDedupMaxRetries = maxRetries
      }
      if (pendingApprovalKeys.has(dedupKey)) {
        plog(pipelineName, `⊘ approval already queued for ${dedupKey}`)
        continue
      }

      // Scoped approval gate: check rules before the binary requireApproval check
      const ruleMatch = await matchRules(p.def.action.type, estimateActionCost(p.def.action.type), [])
      if (ruleMatch) {
        if (ruleMatch.action === 'auto_approve') {
          plog(pipelineName, `✓ auto-approved by rule "${ruleMatch.name}"`)
          appendActivity({
            source: 'pipeline',
            name: pipelineName,
            summary: `Pipeline "${pipelineName}" auto-approved by rule "${ruleMatch.name}"`,
            level: 'info',
          })
          // skip approval gate — fall through to fireAction
        } else if (ruleMatch.action === 'require_approval' || ruleMatch.action === 'require_escalation') {
          // Create approval gate, include rule info in resolvedVars
          const approvalId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
          const summary = ctx.pr
            ? `PR #${ctx.pr.number}: ${ctx.pr.branch}${ctx.repo ? ` (${ctx.repo.owner}/${ctx.repo.name})` : ''}`
            : `${pipelineName} (${ctx.timestamp.slice(0, 10)})`
          const resolvedVars: Record<string, string> = {
            'action.name': resolveTemplate(p.def.action.name || p.def.name || 'Pipeline Session', ctx),
            'dedup.key': dedupKey,
            'rule.name': ruleMatch.name,
          }
          if (p.def.action.workingDirectory) resolvedVars['action.workingDirectory'] = resolveTemplate(p.def.action.workingDirectory, ctx)
          if (ctx.pr) {
            resolvedVars['pr.number'] = String(ctx.pr.number)
            resolvedVars['pr.branch'] = ctx.pr.branch
            resolvedVars['pr.title'] = ctx.pr.title || ''
          }
          if (ctx.repo) {
            resolvedVars['repo.owner'] = ctx.repo.owner
            resolvedVars['repo.name'] = ctx.repo.name
          }
          if (ruleMatch.action === 'require_escalation') {
            resolvedVars['escalation.required'] = 'true'
          }
          const ttlHours = p.def.approvalTtl ?? APPROVAL_DEFAULT_TTL_HOURS
          const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString()
          const request: ApprovalRequest = { id: approvalId, pipelineName, summary, resolvedVars, createdAt: new Date().toISOString(), expiresAt }
          if (ctx.repo) {
            request.repoSlug = `${ctx.repo.owner}/${ctx.repo.name}`
          }
          if (ctx.pr && ctx.repo) {
            try {
              const files = await fetchPRFiles(ctx.repo, ctx.pr.number)
              request.prFiles = files
            } catch (err) {
              plog(pipelineName, '⚠ fetchPRFiles failed: ' + (err as Error).message)
            }
          }
          pendingApprovals.set(approvalId, { request, action: applyDefaultModel(p.def.action, p.def.default_model), ctx, dedupKey })
          pendingApprovalKeys.add(dedupKey)
          broadcast('pipeline:approval:new', request)
          updateDockBadge()
          plog(pipelineName, `→ approval required by rule "${ruleMatch.name}", queued request ${approvalId}`)
          appendActivity({
            source: 'pipeline',
            name: pipelineName,
            summary: `Pipeline "${pipelineName}" approval required by rule "${ruleMatch.name}"`,
            level: 'warn',
          })
          if (shouldNotify(p.def, 'warning')) notify(`Colony: Approval needed`, `Pipeline "${pipelineName}" — ${summary}`, 'pipelines')
          continue
        }
      }

      if (p.def.requireApproval) {
        const approvalId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const summary = ctx.pr
          ? `PR #${ctx.pr.number}: ${ctx.pr.branch}${ctx.repo ? ` (${ctx.repo.owner}/${ctx.repo.name})` : ''}`
          : `${pipelineName} (${ctx.timestamp.slice(0, 10)})`
        const resolvedVars: Record<string, string> = {
          'action.name': resolveTemplate(p.def.action.name || p.def.name || 'Pipeline Session', ctx),
          'dedup.key': dedupKey,
        }
        if (p.def.action.workingDirectory) resolvedVars['action.workingDirectory'] = resolveTemplate(p.def.action.workingDirectory, ctx)
        if (ctx.pr) {
          resolvedVars['pr.number'] = String(ctx.pr.number)
          resolvedVars['pr.branch'] = ctx.pr.branch
          resolvedVars['pr.title'] = ctx.pr.title || ''
        }
        if (ctx.repo) {
          resolvedVars['repo.owner'] = ctx.repo.owner
          resolvedVars['repo.name'] = ctx.repo.name
        }
        const ttlHours = p.def.approvalTtl ?? APPROVAL_DEFAULT_TTL_HOURS
        const expiresAt = new Date(Date.now() + ttlHours * 3600 * 1000).toISOString()
        const request: ApprovalRequest = { id: approvalId, pipelineName, summary, resolvedVars, createdAt: new Date().toISOString(), expiresAt }
        if (ctx.repo) {
          request.repoSlug = `${ctx.repo.owner}/${ctx.repo.name}`
        }
        if (ctx.pr && ctx.repo) {
          try {
            const files = await fetchPRFiles(ctx.repo, ctx.pr.number)
            request.prFiles = files
          } catch (err) {
            plog(pipelineName, '⚠ fetchPRFiles failed: ' + (err as Error).message)
          }
        }
        pendingApprovals.set(approvalId, { request, action: p.def.action, ctx, dedupKey })
        pendingApprovalKeys.add(dedupKey)
        broadcast('pipeline:approval:new', request)
        updateDockBadge()
        plog(pipelineName, `→ approval required, queued request ${approvalId} for ${prLabel}`)
        appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" waiting for approval — ${summary}`, level: 'warn' })
        if (shouldNotify(p.def, 'warning')) notify(`Colony: Approval needed`, `Pipeline "${pipelineName}" — ${summary}`, 'pipelines')
        continue
      }

      if (overrides?.prompt?.trim()) {
        plog(pipelineName, `→ using prompt override (${overrides.prompt.length} chars)`)
        appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" manually triggered with custom prompt`, level: 'info' })
      }

      // Build retry-aware prompt prefix for dedup retries
      let effectiveOverrides: RunOverrides | undefined = overrides
      if (dedupRetryAttempt !== null) {
        const maxRetries = dedup.maxRetries ?? 0
        const failedNames = ctx.checks?.checks
          .filter(c => c.conclusion === 'failure' || c.conclusion === 'error')
          .map(c => c.name).join(', ') || 'unknown'
        const retryPrefix = `[RETRY ${dedupRetryAttempt + 1}/${maxRetries}] Previous fix attempt did not resolve CI failures. Still failing: ${failedNames}.\n\n`
        effectiveOverrides = { ...overrides, prompt: retryPrefix + (overrides?.prompt || '') }
      }

      if (p.def.pre_run?.length) {
        await executePreRunHooks(p.def.pre_run, pipelineName)
      }

      plog(pipelineName, `→ firing action: ${p.def.action.type} for ${prLabel}${dedupRetryAttempt !== null ? ` (retry ${dedupRetryAttempt + 1})` : ''}`)
      const stageStart = Date.now()
      const resolvedAction = applyDefaultModel(p.def.action, p.def.default_model)
      const stageSessionName = resolveTemplate(resolvedAction.name || pipelineName || 'Pipeline Session', ctx)
      let stageError: string | undefined
      let stageCost = 0
      let stageResponseSnippet: string | undefined
      let stageSubStages: PipelineStageTrace[] | undefined
      let stageRetryCount = 0
      let stageRetryContext: boolean | undefined
      let stageSessionId: string | undefined
      let stageOnFailureFired: boolean | undefined
      executingPipelines.add(pipelineName)
      _currentStep.set(pipelineName, {
        index: contexts.indexOf(ctx),
        total: contexts.length,
        name: resolvedAction.name,
        type: resolvedAction.type,
        startedAt: new Date().toISOString(),
      })
      broadcast('pipeline:status', getPipelineList())
      try {
        const result = await fireActionWithRetry(resolvedAction, ctx, p.def.name, effectiveOverrides)
        stageCost = result.cost
        stageResponseSnippet = result.responseSnippet
        stageSubStages = result.subStages
        stageRetryCount = result.retryCount
        stageRetryContext = result.retryContext
        stageSessionId = result.sessionId
      } catch (stageErr) {
        stageError = String(stageErr)
        // Notify on stage failure (gated by pipeline notification level)
        if (shouldNotify(p.def, 'critical')) {
          const errSnippet = String(stageErr).slice(0, 120)
          notify(`Colony: Pipeline failure`, `"${pipelineName}" — "${resolvedAction.name || resolvedAction.type}" failed: ${errSnippet}`, 'pipelines').catch(() => {})
        }
        // Fire on_failure.run named recovery action (fire-and-forget)
        if (resolvedAction.on_failure?.run) {
          const target = findNamedAction(p.def.action, resolvedAction.on_failure.run)
          if (target) {
            const failureCtx: TriggerContext = { ...ctx, error: String(stageErr) }
            const safeTarget: ActionDef = { ...target, on_failure: undefined }
            plog(pipelineName, `→ firing on_failure.run: "${resolvedAction.on_failure.run}"`)
            fireAction(safeTarget, failureCtx, pipelineName).then(r => {
              totalCost += r.cost
              plog(pipelineName, `✓ on_failure.run "${resolvedAction.on_failure!.run}" completed`)
            }).catch(failErr => {
              plog(pipelineName, `⚠ on_failure.run "${resolvedAction.on_failure!.run}" failed: ${String(failErr)}`)
            })
            stageOnFailureFired = true
          } else {
            plog(pipelineName, `⚠ on_failure.run: action "${resolvedAction.on_failure.run}" not found`)
          }
        }
        if (resolvedAction.on_failure?.webhook) {
          plog(pipelineName, `→ firing on_failure.webhook`)
          const deliveries = await fireOutboundWebhook(resolvedAction.on_failure.webhook, {
            pipeline_name: pipelineName,
            action_name: resolvedAction.name || resolvedAction.type,
            status: 'failure',
            duration_ms: Date.now() - pollStartedAt,
            cost: totalCost,
            run_id: '',
          })
          webhookDeliveries.push(...deliveries)
          if (deliveries.length > 0) webhookFired = true
        }
        throw stageErr
      } finally {
        executingPipelines.delete(pipelineName)
        _currentStep.delete(pipelineName)
        const stageEnd = Date.now()
        stages.push({
          index: stages.length,
          actionType: resolvedAction.type,
          sessionName: stageSessionName,
          sessionId: stageSessionId,
          model: resolveActionModel(p.def.action, p.def.default_model),
          autoResolved: p.def.action.model === 'auto',
          durationMs: stageEnd - stageStart,
          startedAt: stageStart,
          completedAt: stageEnd,
          success: !stageError,
          error: stageError,
          responseSnippet: stageResponseSnippet,
          subStages: stageSubStages,
          retryCount: stageRetryCount,
          retryContext: stageRetryContext,
          onFailureFired: stageOnFailureFired,
          cost: stageCost || undefined,
        })
      }
      totalCost += stageCost

      // Budget check
      const effectiveMaxBudget = overrides?.maxBudget ?? p.def.budget?.max_cost_usd
      if (effectiveMaxBudget) {
        const warnAt = p.def.budget?.warn_at ?? effectiveMaxBudget * 0.75
        if (!budgetWarnSent && totalCost >= warnAt) {
          budgetWarnSent = true
          if (shouldNotify(p.def, 'critical')) notify(`Colony: Budget warning`, `Pipeline "${pipelineName}" has spent $${totalCost.toFixed(2)} (warn threshold: $${warnAt.toFixed(2)})`, 'pipelines')
        }
        if (totalCost >= effectiveMaxBudget) {
          plog(pipelineName, `⚠ budget limit reached ($${totalCost.toFixed(2)} >= $${effectiveMaxBudget.toFixed(2)}) — stopping run`)
          if (shouldNotify(p.def, 'critical')) notify(`Colony: Budget limit reached`, `Pipeline "${pipelineName}" stopped after spending $${totalCost.toFixed(2)}`, 'pipelines')
          stoppedBudget = true
          break
        }
      }

      await recordFired(pipelineName, dedupKey, ctx.contentSha, stageSessionId)
      fired = true
      if (ctx.pr?.number != null) tcMatchedPRs.push(ctx.pr.number)
      if (ctx.contentSha) tcNewCommits.push(ctx.contentSha)
      if (ctx.filesChangedMatches) tcMatchedFiles.push(...ctx.filesChangedMatches.slice(0, 10))
      plog(pipelineName, `✓ action fired successfully`)
      const firedSummary = ctx.pr
        ? `Pipeline "${pipelineName}" fired for PR #${ctx.pr.number} (${ctx.pr.branch})`
        : `Pipeline "${pipelineName}" fired`
      appendActivity({ source: 'pipeline', name: pipelineName, summary: firedSummary, level: 'info', project: ctx.repo?.name || (p.def.action.workingDirectory ? basename(resolveTemplate(p.def.action.workingDirectory, ctx)) : undefined) })
      if (shouldNotify(p.def, 'info')) notify(`Colony: Pipeline fired`, firedSummary, 'pipelines')

      // Fire on_success handlers (fire-and-forget)
      if (resolvedAction.on_success) {
        const onSuccess = resolvedAction.on_success
        if (onSuccess.notify && shouldNotify(p.def, 'info')) {
          notify(`Colony: Pipeline succeeded`, `"${pipelineName}" — "${resolvedAction.name || resolvedAction.type}" completed successfully`, 'pipelines').catch(() => {})
        }
        if (onSuccess.run) {
          const target = findNamedAction(p.def.action, onSuccess.run)
          if (target) {
            const safeTarget: ActionDef = { ...target, on_success: undefined }
            plog(pipelineName, `→ firing on_success.run: "${onSuccess.run}"`)
            fireAction(safeTarget, ctx, pipelineName).then(r => {
              totalCost += r.cost
              plog(pipelineName, `✓ on_success.run "${onSuccess.run}" completed`)
            }).catch(succErr => {
              plog(pipelineName, `⚠ on_success.run "${onSuccess.run}" failed: ${String(succErr)}`)
            })
          } else {
            plog(pipelineName, `⚠ on_success.run: action "${onSuccess.run}" not found`)
          }
        }
        if (onSuccess.chain) {
          if (executingPipelines.has(onSuccess.chain)) {
            plog(pipelineName, `⊘ on_success.chain: "${onSuccess.chain}" already executing — skipping`)
          } else {
            plog(pipelineName, `→ on_success.chain: triggering "${onSuccess.chain}"`)
            const triggered = triggerPollNow(onSuccess.chain)
            if (!triggered) plog(pipelineName, `⚠ on_success.chain: pipeline "${onSuccess.chain}" not found`)
          }
        }
        if (onSuccess.webhook) {
          plog(pipelineName, `→ firing on_success.webhook`)
          const deliveries = await fireOutboundWebhook(onSuccess.webhook, {
            pipeline_name: pipelineName,
            action_name: resolvedAction.name || resolvedAction.type,
            status: 'success',
            duration_ms: Date.now() - pollStartedAt,
            cost: totalCost,
            run_id: '',
          })
          webhookDeliveries.push(...deliveries)
          if (deliveries.length > 0) webhookFired = true
        }
      }
    }

    p.state.lastError = null
    p.state.consecutiveFailures = 0
  } catch (err) {
    pollError = true
    p.state.lastError = String(err)
    p.state.consecutiveFailures = (p.state.consecutiveFailures || 0) + 1
    plog(pipelineName, `✗ error: ${err}`)
    appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" failed: ${String(err).slice(0, 120)}`, level: 'error' })

    if (p.state.consecutiveFailures >= CONSECUTIVE_FAILURE_THRESHOLD) {
      const timer = timers.get(pipelineName)
      if (timer) {
        clearInterval(timer)
        timers.delete(pipelineName)
      }
      const filePath = join(PIPELINES_DIR, p.fileName)
      try {
        let content = await fsp.readFile(filePath, 'utf-8')
        content = content.replace(/^enabled:\s*(true|false)/m, `enabled: false`)
        await fsp.writeFile(filePath, content, 'utf-8')
        p.def.enabled = false
      } catch (writeErr) {
        // File write failed — leave in-memory enabled=true so it matches disk.
        // Timer is already cleared; pipeline will resume on next app restart.
        log(`Failed to persist auto-pause for ${p.fileName}: ${writeErr}`)
      }
      plog(pipelineName, `Auto-paused after ${CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures`)
      appendActivity({
        source: 'pipeline',
        name: pipelineName,
        summary: `Pipeline "${pipelineName}" auto-paused after ${CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures`,
        level: 'warn',
      })
    }
  } finally {
    runningPolls.delete(pipelineName)

    p.state.lastRunStoppedBudget = stoppedBudget

    // Collect all session IDs from stages (including sub-stages)
    const allSessionIds: string[] = []
    for (const s of stages) {
      if (s.sessionId) allSessionIds.push(s.sessionId)
      if (s.subStages) {
        for (const sub of s.subStages) {
          if (sub.sessionId) allSessionIds.push(sub.sessionId)
        }
      }
    }

    // Build trigger context for debugging ("why did this fire?")
    let triggerContext: PipelineRunEntry['triggerContext']
    if (p.def.trigger.type === 'cron') {
      triggerContext = {
        cronExpr: p.def.trigger.cron ?? undefined,
        scheduledAt: new Date().toISOString(),
      }
    } else if (p.def.trigger.type === 'git-poll') {
      const uniqueCommits = [...new Set(tcNewCommits)]
      triggerContext = {
        matchedPRs: tcMatchedPRs.length ? tcMatchedPRs : undefined,
        newCommits: uniqueCommits.length ? uniqueCommits : undefined,
        matchedFiles: tcMatchedFiles.length ? [...new Set(tcMatchedFiles)].slice(0, 10) : undefined,
      }
    } else if (p.def.trigger.type === 'file-poll') {
      triggerContext = { scheduledAt: new Date().toISOString() }
    }

    // Record run history
    const diffStats = await computeDiffStats(allSessionIds, headCommitForHistory)
    await appendHistory(pipelineName, {
      ts: new Date().toISOString(),
      trigger: p.def.trigger.type,
      actionExecuted: fired,
      success: !pollError,
      durationMs: Date.now() - pollStartedAt,
      stages: stages.length > 0 ? stages : undefined,
      sessionIds: allSessionIds.length > 0 ? allSessionIds : undefined,
      totalCost: totalCost > 0 ? totalCost : undefined,
      stoppedBudget: stoppedBudget || undefined,
      dedupAttempt: runDedupAttempt,
      dedupMaxRetries: runDedupMaxRetries,
      headCommit: headCommitForHistory,
      triggerContext,
      webhookFired: webhookFired || undefined,
      webhookDeliveries: webhookDeliveries.length > 0 ? webhookDeliveries : undefined,
      diffStats,
    })

    // Trim debug log to the last N iterations
    const sepIndices: number[] = []
    for (let i = 0; i < p.state.debugLog.length; i++) {
      if (p.state.debugLog[i] === DEBUG_ITERATION_SEP) sepIndices.push(i)
    }
    if (sepIndices.length > MAX_DEBUG_ITERATIONS) {
      const cutAt = sepIndices[sepIndices.length - MAX_DEBUG_ITERATIONS]
      p.state.debugLog = p.state.debugLog.slice(cutAt)
    }

    await saveDebugLogs() // persist debug logs after every poll
    if (fired) await saveState()
    broadcast('pipeline:status', getPipelineList())
  }
}

// ---- Public API ----

export async function loadPipelines(): Promise<void> {
  if (!await pathExists(PIPELINES_DIR)) await fsp.mkdir(PIPELINES_DIR, { recursive: true })

  const savedState = await loadState()
  pipelines.clear()

  // 1. User pipelines (from ~/.claude-colony/pipelines/)
  const files = (await fsp.readdir(PIPELINES_DIR)).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
  const userNames = new Set<string>()

  for (const file of files) {
    try {
      const content = await fsp.readFile(join(PIPELINES_DIR, file), 'utf-8')
      const def = parsePipelineYaml(content)
      if (!def) {
        log(`Failed to parse ${file}`)
        continue
      }
      const state = savedState[def.name] || freshState()
      try {
        const lp = debugLogPath(def.name)
        if (await pathExists(lp)) {
          const { entries } = JSON.parse(await fsp.readFile(lp, 'utf-8'))
          if (Array.isArray(entries)) state.debugLog = entries
        }
      } catch { /* ignore */ }
      pipelines.set(def.name, { def, state, fileName: file })
      userNames.add(def.name)
      log(`Loaded pipeline: ${def.name} (${def.enabled ? 'enabled' : 'disabled'})`)
    } catch (err) {
      log(`Error loading ${file}: ${err}`)
    }
  }

  // 2. Repo pipelines (from .colony/pipelines/ — disabled by default, user must enable)
  try {
    for (const repoConfig of getAllRepoConfigs()) {
      for (const repoPipeline of repoConfig.pipelines) {
        if (userNames.has(repoPipeline.name)) continue // user pipeline takes precedence
        const enablementKey = `repo:${repoConfig.repoSlug}:${repoPipeline.name}`
        const enablement = savedState[enablementKey]
        // Repo pipelines are disabled unless user has explicitly enabled them
        const def = repoPipeline as unknown as PipelineDef
        def.enabled = enablement?.enabled ?? false
        const state = enablement || freshState()
        try {
          const lp = debugLogPath(repoPipeline.name)
          if (await pathExists(lp)) {
            const { entries } = JSON.parse(await fsp.readFile(lp, 'utf-8'))
            if (Array.isArray(entries)) state.debugLog = entries
          }
        } catch { /* ignore */ }
        pipelines.set(repoPipeline.name, {
          def,
          state,
          fileName: `${repoConfig.repoSlug}:${repoPipeline.fileName}`,
        })
        log(`Loaded repo pipeline: ${repoPipeline.name} from ${repoConfig.repoSlug} (${def.enabled ? 'enabled' : 'disabled'})`)
      }
    }
  } catch { /* repo config loader not available */ }
}

export async function startPipelines(): Promise<void> {
  if (started) return
  started = true

  setApprovalCountGetter(() => pendingApprovals.size)

  // Resolve GitHub user
  try {
    githubUser = (await gh(['api', 'user', '--jq', '.login'])).trim()
    log(`GitHub user: ${githubUser}`)
  } catch {
    log('Could not resolve GitHub user — pipelines with {{github.user}} may not match')
  }

  await loadPipelines()

  for (const [name, p] of pipelines) {
    if (!p.def.enabled) continue
    await schedulePipeline(name, p.def)
  }

  // Sweep expired approvals every 60 seconds
  approvalSweepTimer = setInterval(() => sweepExpiredApprovals(), 60_000)
}

async function schedulePipeline(name: string, def: PipelineDef): Promise<void> {
  // Webhook pipelines are not timer-driven — they are fired externally via fireWebhookPipeline()
  if (def.trigger.type === 'webhook') {
    log(`Webhook pipeline ${name} registered — no timer needed`)
    return
  }

  const cronExpr = def.trigger.cron

  if (cronExpr) {
    // Cron-based: check every 60s if the cron expression matches
    const intervalMs = (def.trigger.interval || 300) * 1000
    log(`Starting cron pipeline ${name}: "${cronExpr}" (poll interval ${intervalMs / 1000}s when active)`)

    // Track last cron-triggered key (date + minute) to avoid double-firing within same minute
    // Uses date-qualified key so the same minute on consecutive days fires correctly
    let lastCronKey = ''

    const cronCheck = setInterval(() => {
      const now = new Date()
      const currentMinute = now.getHours() * 60 + now.getMinutes()
      const cronKey = `${now.toDateString()}:${currentMinute}`

      if (cronMatches(cronExpr, now) && cronKey !== lastCronKey) {
        lastCronKey = cronKey
        if (isRateLimited()) {
          const rl = getRateLimitState()
          log(`Skipped ${name} — rate limit pause active until ${rl.resetAt ? new Date(rl.resetAt).toLocaleTimeString() : 'unknown'}`)
          return
        }
        if (isCronsPausedSync()) {
          log(`Skipped ${name} — manual cron pause active`)
          return
        }
        log(`Cron matched for ${name} at ${now.toLocaleTimeString()}`)
        runPoll(name)
      }
    }, 60000) // Check every minute

    timers.set(name, cronCheck)

    // Also run on startup if cron matches right now
    const startupTimer = setTimeout(() => {
      startupTimers.delete(startupTimer)
      if (cronMatches(cronExpr)) {
        if (isRateLimited()) {
          log(`Skipped startup fire for ${name} — rate limit pause active`)
        } else if (isCronsPausedSync()) {
          log(`Skipped startup fire for ${name} — manual cron pause active`)
        } else {
          log(`Cron matches on startup for ${name}`)
          runPoll(name)
        }
      }
    }, 10000)
    startupTimers.add(startupTimer)
  } else if (def.trigger.type === 'file-poll') {
    // File-watch: poll mtime of watched paths on a short interval
    const intervalMs = (def.trigger.interval || 30) * 1000
    const watchPaths = def.trigger.watch || []
    log(`Starting file-poll pipeline ${name}: watching ${watchPaths.length} path(s) every ${intervalMs / 1000}s`)

    // Build initial snapshot
    const snapshot = new Map<string, number>()
    filePollSnapshots.set(name, snapshot)
    for (const p of watchPaths) {
      try {
        const s = await fsp.stat(p)
        if (s.isDirectory()) {
          for (const child of await fsp.readdir(p)) {
            try { snapshot.set(`${p}/${child}`, (await fsp.stat(`${p}/${child}`)).mtimeMs) } catch { /* missing */ }
          }
        } else {
          snapshot.set(p, s.mtimeMs)
        }
      } catch { /* path doesn't exist yet */ }
    }

    const timer = setInterval(async () => {
      const COOLDOWN_MS = 10_000
      const pipeline = pipelines.get(name)
      if (pipeline?.state.lastFiredAt) {
        const msSinceLastFire = Date.now() - new Date(pipeline.state.lastFiredAt).getTime()
        if (msSinceLastFire < COOLDOWN_MS) return
      }

      const current = filePollSnapshots.get(name)
      if (!current) return // pipeline stopped between async ticks
      let changed = false

      for (const watchPath of watchPaths) {
        try {
          const s = await fsp.stat(watchPath)
          if (s.isDirectory()) {
            for (const child of await fsp.readdir(watchPath)) {
              const full = `${watchPath}/${child}`
              try {
                const mtime = (await fsp.stat(full)).mtimeMs
                if ((current.get(full) ?? -1) !== mtime) { current.set(full, mtime); changed = true }
              } catch { /* file disappeared */ }
            }
          } else {
            const mtime = s.mtimeMs
            if ((current.get(watchPath) ?? -1) !== mtime) { current.set(watchPath, mtime); changed = true }
          }
        } catch { /* path missing — treat as no change */ }
      }

      if (changed) {
        log(`File change detected for ${name}`)
        runPoll(name)
      }
    }, intervalMs)
    timers.set(name, timer)

  } else {
    // Interval-based: simple fixed interval
    const intervalMs = (def.trigger.interval || 300) * 1000
    log(`Starting interval pipeline ${name} every ${intervalMs / 1000}s`)

    const intervalStartup = setTimeout(() => {
      startupTimers.delete(intervalStartup)
      runPoll(name)
    }, 10000)
    startupTimers.add(intervalStartup)
    const timer = setInterval(() => runPoll(name), intervalMs)
    timers.set(name, timer)
  }
}

export function stopPipelines(): void {
  for (const [name, timer] of timers) {
    clearInterval(timer)
  }
  timers.clear()
  startupTimers.forEach(clearTimeout)
  startupTimers.clear()
  runningPolls.clear()
  executingPipelines.clear()
  _currentStep.clear()
  filePollSnapshots.clear()
  if (approvalSweepTimer) {
    clearInterval(approvalSweepTimer)
    approvalSweepTimer = null
  }
  for (const interval of _idleNudgeIntervals.values()) clearInterval(interval)
  _idleNudgeIntervals.clear()
  started = false
  log('All pipelines stopped')
}

function toActionShape(action: ActionDef): ActionShape {
  return {
    type: action.type,
    name: action.name || undefined,
    target: action.target || undefined,
    stages: action.stages?.map(toActionShape),
  }
}

export function getPipelineList(): PipelineInfo[] {
  const result: PipelineInfo[] = []
  for (const [name, p] of pipelines) {
    result.push({
      name: p.def.name,
      description: p.def.description || '',
      enabled: p.def.enabled,
      fileName: p.fileName,
      triggerType: p.def.trigger.type,
      interval: p.def.trigger.interval || 300,
      cron: p.def.trigger.cron || null,
      running: runningPolls.has(name),
      outputsDir: p.def.action.outputs || null,
      lastPollAt: p.state.lastPollAt,
      lastFiredAt: p.state.lastFiredAt,
      lastMatchAt: p.state.lastMatchAt,
      lastError: p.state.lastError,
      fireCount: p.state.fireCount,
      consecutiveFailures: p.state.consecutiveFailures || 0,
      debugLog: p.state.debugLog || [],
      budget: p.def.budget ? { maxCostUsd: p.def.budget.max_cost_usd, warnAt: p.def.budget.warn_at ?? p.def.budget.max_cost_usd * 0.75 } : null,
      lastRunStoppedBudget: p.state.lastRunStoppedBudget ?? false,
      actionShape: toActionShape(p.def.action),
      firstActionPrompt: p.def.action.prompt || undefined,
      firstActionWorkingDirectory: p.def.action.workingDirectory || undefined,
      firstActionModel: p.def.action.model || p.def.default_model || undefined,
      defaultModel: p.def.default_model || undefined,
      runCondition: p.def.run_condition || undefined,
      conditionType: p.def.condition?.type !== 'always' ? p.def.condition?.type : undefined,
      conditionPatterns: p.def.condition?.patterns?.length ? p.def.condition.patterns : undefined,
      preRunHooks: p.def.pre_run?.length ? p.def.pre_run.map(h => h.type) : undefined,
      notifications: p.def.notifications,
      pausedUntil: p.def.pausedUntil,
      currentStep: _currentStep.get(name),
    })
  }
  return result
}

export async function togglePipeline(name: string, enabled: boolean): Promise<boolean> {
  const p = pipelines.get(name)
  if (!p) return false

  p.def.enabled = enabled

  // Update the YAML file
  const filePath = join(PIPELINES_DIR, p.fileName)
  try {
    let content = await fsp.readFile(filePath, 'utf-8')
    content = content.replace(/^enabled:\s*(true|false)/m, `enabled: ${enabled}`)
    await fsp.writeFile(filePath, content, 'utf-8')
  } catch (err) {
    log(`Failed to update ${p.fileName}: ${err}`)
  }

  if (enabled && !timers.has(name)) {
    await schedulePipeline(name, p.def)
    log(`Enabled pipeline: ${name}`)
  } else if (!enabled && timers.has(name)) {
    clearInterval(timers.get(name)!)
    timers.delete(name)
    log(`Disabled pipeline: ${name}`)
  }

  await saveState()
  broadcast('pipeline:status', getPipelineList())
  return true
}

async function savePauseState(name: string, pausedUntil: string | null | undefined): Promise<void> {
  const p = pipelines.get(name)
  if (!p) return
  const filePath = join(PIPELINES_DIR, p.fileName)
  try {
    let content = await fsp.readFile(filePath, 'utf-8')
    const hasField = /^pausedUntil:/m.test(content)
    if (pausedUntil === undefined) {
      content = content.replace(/^pausedUntil:.*\n?/m, '')
    } else if (hasField) {
      content = content.replace(/^pausedUntil:.*$/m, `pausedUntil: ${pausedUntil === null ? 'null' : JSON.stringify(pausedUntil)}`)
    } else {
      content = content.replace(/^(enabled:.*)$/m, `$1\npausedUntil: ${pausedUntil === null ? 'null' : JSON.stringify(pausedUntil)}`)
    }
    await fsp.writeFile(filePath, content, 'utf-8')
  } catch (err) {
    log(`Failed to save pause state for ${name}: ${err}`)
  }
}

export async function pausePipeline(name: string, durationMs: number | null): Promise<boolean> {
  const p = pipelines.get(name)
  if (!p) return false
  p.def.pausedUntil = durationMs === null ? null : new Date(Date.now() + durationMs).toISOString()
  await savePauseState(name, p.def.pausedUntil)
  broadcast('pipeline:status', getPipelineList())
  return true
}

export async function resumePipeline(name: string): Promise<boolean> {
  const p = pipelines.get(name)
  if (!p) return false
  p.def.pausedUntil = undefined
  await savePauseState(name, undefined)
  broadcast('pipeline:status', getPipelineList())
  return true
}

export function triggerPollNow(name: string, overrides?: RunOverrides | string): boolean {
  const p = pipelines.get(name)
  if (!p) return false
  const normalised: RunOverrides | undefined = typeof overrides === 'string' ? { prompt: overrides } : overrides
  runPoll(name, normalised)
  return true
}

export async function getPipelinesDir(): Promise<string> {
  if (!await pathExists(PIPELINES_DIR)) await fsp.mkdir(PIPELINES_DIR, { recursive: true })
  return PIPELINES_DIR
}

export async function getPipelineContent(fileName: string): Promise<string | null> {
  const filePath = join(PIPELINES_DIR, fileName)
  try {
    return await fsp.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

export async function savePipelineContent(fileName: string, content: string): Promise<boolean> {
  const filePath = join(PIPELINES_DIR, fileName)
  try {
    await fsp.writeFile(filePath, content, 'utf-8')
    // Reload pipelines to pick up changes
    stopPipelines()
    await loadPipelines()
    // Restart enabled ones
    for (const [name, p] of pipelines) {
      if (p.def.enabled) {
        await schedulePipeline(name, p.def)
      }
    }
    started = true
    broadcast('pipeline:status', getPipelineList())
    return true
  } catch (err) {
    log(`Failed to save pipeline: ${err}`)
    return false
  }
}

/** Surgically update the cron field in a pipeline YAML file without touching the rest. */
export async function setPipelineCron(fileName: string, cron: string | null): Promise<boolean> {
  const content = await getPipelineContent(fileName)
  if (!content) return false
  let updated: string
  if (cron) {
    if (/^\s*cron:/m.test(content)) {
      updated = content.replace(/^(\s*cron:\s*).*$/m, `$1"${cron}"`)
    } else {
      // Insert after the interval line
      updated = content.replace(/^(\s*interval:\s*\d+.*)$/m, `$1\n  cron: "${cron}"`)
    }
  } else {
    updated = content.replace(/^\s*cron:\s*.*\n?/m, '')
  }
  return savePipelineContent(fileName, updated)
}

// ---- Approval Sweep ----

/** Auto-expire pending approvals whose `expiresAt` has passed. */
export function sweepExpiredApprovals(): void {
  const now = Date.now()
  for (const [id, entry] of pendingApprovals) {
    const { request, dedupKey, reject } = entry
    if (request.expiresAt && new Date(request.expiresAt).getTime() <= now) {
      pendingApprovals.delete(id)
      pendingApprovalKeys.delete(dedupKey)
      if (reject) {
        reject('Plan approval expired — pipeline run stopped')
      }
      appendActivity({
        source: 'pipeline',
        name: request.pipelineName,
        summary: `Pipeline "${request.pipelineName}" approval expired — ${request.summary}`,
        level: 'warn',
      })
      broadcast('pipeline:approval:update', { id, status: 'expired' })
      updateDockBadge()
      log(`Approval ${id} for "${request.pipelineName}" expired`)
    }
  }
}

// ---- Approval Gate API ----

export function listApprovals(): ApprovalRequest[] {
  return [...pendingApprovals.values()].map(a => a.request)
}

export async function approveAction(id: string): Promise<boolean> {
  const entry = pendingApprovals.get(id)
  if (!entry) return false
  const { request, action, ctx, dedupKey, resolve } = entry
  pendingApprovals.delete(id)
  pendingApprovalKeys.delete(dedupKey)

  if (resolve) {
    // Inline approval gate (plan stage) — resume the blocked pipeline
    resolve()
    appendActivity({ source: 'pipeline', name: request.pipelineName, summary: `Pipeline "${request.pipelineName}" plan approved — proceeding`, level: 'info' })
    broadcast('pipeline:approval:update', { id, status: 'approved' })
    updateDockBadge()
    return true
  }

  try {
    const { cost: _ } = await fireActionWithRetry(action, ctx, request.pipelineName)
    await recordFired(request.pipelineName, dedupKey, ctx.contentSha)
    appendActivity({ source: 'pipeline', name: request.pipelineName, summary: `Pipeline "${request.pipelineName}" approved and fired — ${request.summary}`, level: 'info' })
  } catch (err) {
    appendActivity({ source: 'pipeline', name: request.pipelineName, summary: `Pipeline "${request.pipelineName}" failed after approval: ${String(err).slice(0, 100)}`, level: 'error' })
  }
  broadcast('pipeline:approval:update', { id, status: 'approved' })
  updateDockBadge()
  return true
}

export function dismissAction(id: string): boolean {
  const entry = pendingApprovals.get(id)
  if (!entry) return false
  const { request, dedupKey, reject } = entry
  pendingApprovals.delete(id)
  pendingApprovalKeys.delete(dedupKey)
  if (reject) {
    reject('Plan rejected by user — pipeline run stopped')
  }
  appendActivity({ source: 'pipeline', name: request.pipelineName, summary: `Pipeline "${request.pipelineName}" action dismissed — ${request.summary}`, level: 'warn' })
  broadcast('pipeline:approval:update', { id, status: 'dismissed' })
  updateDockBadge()
  return true
}

// ---- Webhook API ----

/** Returns all enabled pipelines with type === 'webhook', with their slug and trigger info. */
export function getWebhookTriggers(): Array<{ name: string; slug: string; trigger: TriggerDef }> {
  const result: Array<{ name: string; slug: string; trigger: TriggerDef }> = []
  for (const [name, p] of pipelines) {
    if (p.def.enabled && p.def.trigger.type === 'webhook') {
      result.push({ name, slug: slugify(name), trigger: p.def.trigger })
    }
  }
  return result
}

/**
 * Fire a webhook-triggered pipeline by its slug.
 * Stores the payload for runPoll to consume, then calls runPoll.
 */
export function fireWebhookPipeline(slug: string, payload: unknown, overrides?: RunOverrides): { ok: boolean; error?: string } {
  // Find pipeline whose slugified name matches
  let pipelineName: string | null = null
  for (const [name, p] of pipelines) {
    if (p.def.enabled && p.def.trigger.type === 'webhook' && slugify(name) === slug) {
      pipelineName = name
      break
    }
  }

  if (!pipelineName) {
    return { ok: false, error: `No enabled webhook pipeline found for slug: ${slug}` }
  }

  // Store payload and trigger runPoll (async, fire-and-forget)
  webhookPayloads.set(pipelineName, payload)
  runPoll(pipelineName, overrides).catch((err) => {
    log(`Error running webhook poll for ${pipelineName}: ${err}`)
  })

  return { ok: true }
}

// ---- Seed Default Pipeline ----

export async function seedDefaultPipelines(): Promise<void> {
  if (!await pathExists(PIPELINES_DIR)) await fsp.mkdir(PIPELINES_DIR, { recursive: true })

  const feedbackFile = join(PIPELINES_DIR, 'colony-feedback.yaml')
  if (!await pathExists(feedbackFile)) {
    const template = `name: Colony Feedback
description: Route reviewer feedback to existing sessions. When enabled, also adds a Colony-aware Review PR button to the PRs tab.
enabled: false

trigger:
  type: git-poll
  interval: 300
  repos: auto

condition:
  type: branch-file-exists
  branch: colony-feedback
  path: "reviews/{{pr.number}}"
  match:
    pr.author: "{{github.user}}"

action:
  type: launch-session
  reuse: true
  match:
    gitBranch: "{{pr.branch}}"
    workingDirectory: "{{repo.localPath}}"
  busyStrategy: launch-new
  name: "Feedback: {{repo.name}}#{{pr.number}}"
  workingDirectory: "{{repo.localPath}}"
  color: "#f59e0b"
  prompt: |
    A reviewer left feedback on your PR #{{pr.number}} ({{pr.title}}) on branch {{pr.branch}}.

    Read all feedback files:
    1. List them: git show colony-feedback:reviews/{{pr.number}}/ 2>/dev/null || echo "No feedback directory"
    2. For each .md file, read it: git show colony-feedback:reviews/{{pr.number}}/<filename>
    3. Check the YAML frontmatter — if headSha matches the current HEAD of your branch, the feedback is for the latest code
    4. Address each piece of feedback (Critical items first, then Suggestions)
    5. Commit and push your changes to {{pr.branch}}

dedup:
  key: "{{repo.owner}}/{{repo.name}}/{{pr.number}}"
  ttl: 3600
`
    await fsp.writeFile(feedbackFile, template, 'utf-8')
    log('Seeded default pipeline: colony-feedback.yaml')
  }

  const readmeFile = join(PIPELINES_DIR, 'colony-feedback.readme.md')
  if (!await pathExists(readmeFile)) {
    const readme = `# Colony Feedback Pipeline

Automates PR review feedback loops. When a reviewer pushes structured feedback to the \`colony-feedback\` branch, Colony detects it and either routes the feedback to your existing session on that branch (preserving full context) or launches a new session to address it.

## Setup (PR Author)

1. Go to the **Pipelines** tab in Colony (⚡ icon in sidebar)
2. Enable the **Colony Feedback** pipeline
3. Make sure the repo is added in the **Pull Requests** tab with a local path configured

Once enabled, the **Review PR** button on the PRs tab automatically upgrades to include Colony Feedback instructions — it tells the reviewing agent to push structured feedback to the \`colony-feedback\` branch so your app can pick it up.

Colony will poll every 5 minutes. When feedback is detected for a PR you authored, it will be handled automatically.

## Instructions for Reviewers

Share these instructions with anyone reviewing your PRs.

### Steps

**1. Navigate to the repo**

\`\`\`bash
cd /path/to/repo
\`\`\`

**2. Create the \`colony-feedback\` branch**

\`\`\`bash
git fetch origin
git checkout -b colony-feedback origin/main 2>/dev/null || git checkout colony-feedback
\`\`\`

**3. Write your feedback**

Create \`reviews/<pr-number>/feedback.md\`:

\`\`\`bash
mkdir -p reviews/42
\`\`\`

Example \`reviews/42/feedback.md\`:

\`\`\`markdown
# Review Feedback — PR #42

## Critical
- [ ] SQL injection in \\\`src/auth/login.ts:42\\\` — user input interpolated directly into query. Use parameterized queries.
- [ ] Missing null check on \\\`user.profile\\\` in \\\`src/api/users.ts:88\\\` — crashes on new accounts.

## Suggestions
- [ ] Consider using bcrypt instead of SHA-256 for password hashing (\\\`src/auth/hash.ts:15\\\`)
- [ ] The session timeout of 24h seems long — should this be configurable?

## Questions
- Is the rate limiter at 1000 req/min intentional? Seems high for this endpoint.
\`\`\`

**4. Commit and push**

\`\`\`bash
git add reviews/
git commit -m "Review feedback for PR #42"
git push origin colony-feedback
\`\`\`

**5. Done** — Colony picks it up automatically within 5 minutes.

### Feedback Format Tips

- Use checkboxes (\`- [ ]\`) so the agent can mark items as addressed
- Reference specific files and line numbers for precise fixes
- Separate by severity (Critical / Suggestions / Questions) so the agent prioritizes correctly
- The dedup TTL is 1 hour — after that, updated feedback will re-trigger

### How Routing Works

When feedback is detected, Colony looks for a running session that matches the PR branch:
- If found and idle → feedback prompt is injected directly (context preserved)
- If found and busy → waits for it to finish, then sends the feedback
- If no match → launches a new session in the repo directory
`
    await fsp.writeFile(readmeFile, readme, 'utf-8')
    log('Seeded pipeline README: colony-feedback.readme.md')
  }

  // ---- CI Auto-Fix pipeline ----
  const ciFixFile = join(PIPELINES_DIR, 'ci-auto-fix.yaml')
  if (!await pathExists(ciFixFile)) {
    const ciTemplate = `name: CI Auto-Fix
description: Hourly during work hours — find my PRs with failing CI (excluding Playwright) and auto-fix them
enabled: false

trigger:
  type: git-poll
  cron: "0 9-17 * * 1-5"
  interval: 300
  repos: auto

condition:
  type: pr-checks-failed
  match:
    pr.author: "{{github.user}}"
  exclude:
    - playwright
    - e2e

action:
  type: launch-session
  reuse: true
  match:
    gitBranch: "{{pr.branch}}"
    workingDirectory: "{{repo.localPath}}"
  busyStrategy: launch-new
  name: "CI Fix: {{repo.name}}#{{pr.number}}"
  workingDirectory: "{{repo.localPath}}"
  color: "#ef4444"
  prompt: |
    CI checks are failing on PR #{{pr.number}} ({{pr.title}}) on branch {{pr.branch}} in {{repo.owner}}/{{repo.name}}.

    1. Make sure you are on the PR branch: git checkout {{pr.branch}}
    2. Pull latest: git pull origin {{pr.branch}}
    3. Identify which CI checks are failing and why — look at the GitHub Actions logs
    4. Fix the failing tests or build issues
    5. Run the relevant tests locally to verify your fix
    6. Commit and push: git add -A && git commit -m "fix: resolve CI failures" && git push origin {{pr.branch}}

    Focus only on fixing the CI failures. Do not refactor or change unrelated code.

dedup:
  key: "ci-{{repo.owner}}/{{repo.name}}/{{pr.number}}"
  ttl: 3600
`
    await fsp.writeFile(ciFixFile, ciTemplate, 'utf-8')
    log('Seeded default pipeline: ci-auto-fix.yaml')
  }

  // ---- PR Attention Digest pipeline ----
  const digestFile = join(PIPELINES_DIR, 'pr-attention-digest.yaml')
  if (!await pathExists(digestFile)) {
    const digestTemplate = `name: PR Attention Digest
description: Hourly digest of PRs that need your attention — assigned, review requested, or mentioned
enabled: false

trigger:
  type: cron
  cron: "0 9-17 * * 1-5"

condition:
  type: always

action:
  type: launch-session
  name: "PR Digest — {{timestamp}}"
  workingDirectory: "~/.claude-colony/pr-workspace"
  color: "#6366f1"
  outputs: "~/.claude-colony/reports"
  prompt: |
    Generate a PR attention digest for me ({{github.user}}).

    Read the PR context file at ~/.claude-colony/pr-workspace/pr-context.md for all open PRs across my repositories.

    Create a prioritized report of PRs that need my attention:

    ## 1. Review Requested
    PRs where I am a requested reviewer. These are highest priority.

    ## 2. Assigned to Me
    PRs where I am an assignee.

    ## 3. My PRs Needing Action
    PRs I authored that have review comments, requested changes, or failing CI.

    For EACH PR include:
    - PR title with clickable link
    - Author and age (how long ago it was opened/updated)
    - Review status (approved, changes requested, pending)
    - CI status (passing, failing, pending)
    - Risk assessment: 🔴 High / 🟡 Medium / 🟢 Low based on:
      - Lines changed (>500 = high, >100 = medium)
      - Number of files changed
      - Whether it touches critical paths (auth, payments, database migrations, CI config)
      - Age without review (>3 days = higher risk)
      - Whether it has failing CI

    ## Summary
    - Total PRs needing attention: X
    - High risk: X | Medium risk: X | Low risk: X
    - Suggested focus order (most urgent first)

    Write the digest to ~/.claude-colony/reports/pr-digest-$(date +%Y-%m-%d-%H%M).md
    Create the reports directory if it doesn't exist: mkdir -p ~/.claude-colony/reports

dedup:
  key: "pr-digest-{{timestamp}}"
  ttl: 3600
`
    await fsp.writeFile(digestFile, digestTemplate, 'utf-8')
    log('Seeded default pipeline: pr-attention-digest.yaml')
  }
}
