/**
 * Pipeline Engine — reactive automation for Claude Colony.
 *
 * Pipelines are YAML files in ~/.claude-colony/pipelines/ that define
 * trigger → condition → action patterns. The engine polls on intervals,
 * evaluates conditions, and fires actions (usually launching sessions).
 */

import { promises as fsp } from 'fs'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { join, basename } from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'
import { createInstance, getAllInstances, killInstance } from './instance-manager'
import { getDaemonClient } from './daemon-client'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { getRepos, fetchPRs, fetchChecks, gh } from './github'
import { findBestRoute } from './session-router'
import { getAllRepoConfigs } from './repo-config-loader'
import { cronMatches } from '../shared/cron'
import { resolveMustacheTemplate, slugify } from '../shared/utils'
import type { GitHubRepo, GitHubPR, PRChecks, ApprovalRequest } from '../shared/types'
import { appendActivity } from './activity-manager'
import { notify } from './notifications'
import { matchRules, estimateActionCost } from './approval-rules'

const execFileAsync = promisify(execFileCb)

async function pathExists(p: string): Promise<boolean> {
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

export interface ConditionDef {
  type: 'branch-file-exists' | 'pr-checks-failed' | 'file-created' | 'always'
  branch?: string
  path?: string
  match?: Record<string, string>
  exclude?: string[] // check names to ignore (substring match)
}

export interface ActionDef {
  type: 'launch-session' | 'route-to-session' | 'maker-checker' | 'diff_review' | 'parallel' | 'plan' | 'wait_for_session' // route-to-session is deprecated, normalized to launch-session + reuse:true
  reuse?: boolean // try to find/resume a matching session before launching new
  name?: string
  workingDirectory?: string
  color?: string
  model?: string // Claude model override for this stage (e.g. 'claude-opus-4-6', 'claude-haiku-4-5')
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
  // maker-checker specific fields
  makerPrompt?: string
  checkerPrompt?: string
  approvedKeyword?: string // keyword to detect approval in checker output (default: 'APPROVED')
  maxIterations?: number   // max maker retries (default: 3)
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
  artifact_output?: string   // artifact name to write exit reason to
}

export interface DedupDef {
  key: string
  ttl?: number // seconds
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
  trigger: TriggerDef
  condition: ConditionDef
  action: ActionDef
  dedup: DedupDef
  budget?: BudgetDef
}

interface PendingApproval {
  request: ApprovalRequest
  action: ActionDef
  ctx: TriggerContext
  dedupKey: string
  // Optional callbacks for inline approval gates (plan stage) — resolve/reject instead of re-firing action
  resolve?: () => void
  reject?: (reason: string) => void
}

interface PipelineState {
  lastPollAt: string | null
  lastMatchAt: string | null
  firedKeys: Record<string, number> // dedup key -> timestamp ms
  contentHashes: Record<string, string> // dedup key -> last seen content SHA
  fireCount: number
  lastFiredAt: string | null
  lastError: string | null
  consecutiveFailures: number
  debugLog: string[]
  lastRunStoppedBudget?: boolean
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
}

const MAX_DEBUG_ITERATIONS = 20
const DEBUG_ITERATION_SEP = '---'
const CONSECUTIVE_FAILURE_THRESHOLD = 3
const APPROVAL_DEFAULT_TTL_HOURS = 24

interface TriggerContext {
  repo?: GitHubRepo
  pr?: GitHubPR
  checks?: PRChecks
  file?: { path: string; name: string; directory: string }
  githubUser?: string
  timestamp: string
  contentSha?: string // SHA of matched file — for change detection
  webhookPayload?: unknown
}

// Cron matching imported from src/shared/cron.ts

// ---- Constants ----

import { colonyPaths } from '../shared/colony-paths'

const COLONY_DIR = colonyPaths.root
const PIPELINES_DIR = colonyPaths.pipelines
const STATE_PATH = join(COLONY_DIR, 'pipeline-state.json')

// ---- Engine ----

const pipelines = new Map<string, { def: PipelineDef; state: PipelineState; fileName: string }>()
const pendingApprovals = new Map<string, PendingApproval>()
const pendingApprovalKeys = new Set<string>() // dedup keys with a queued approval
const timers = new Map<string, ReturnType<typeof setInterval>>()
const runningPolls = new Set<string>()
/** Stores incoming webhook payloads keyed by pipeline name before runPoll is called */
const webhookPayloads = new Map<string, unknown>()
/** mtime snapshots for file-poll pipelines: pipelineName → (path → mtime-ms) */
const filePollSnapshots = new Map<string, Map<string, number>>()
let githubUser: string | null = null
let started = false
let approvalSweepTimer: ReturnType<typeof setInterval> | null = null

function log(msg: string): void {
  console.log(`[pipeline] ${msg}`)
}

/** Log to both console and a pipeline's in-memory debug buffer */
function plog(name: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  const entry = `[${ts}] ${msg}`
  log(`${name}: ${msg}`)
  const p = pipelines.get(name)
  if (p) {
    p.state.debugLog.push(entry)
  }
}

import { broadcast } from './broadcast'
import { parseYaml as parseYamlShared, parseYamlArray } from '../shared/yaml-parser'

// ---- Pipeline YAML Parsing (uses shared parser + pipeline-specific post-processing) ----

function parsePipelineYaml(content: string): PipelineDef | null {
  try {
    const result = parseYamlShared(content) as any
    if (!result) return null

    // Parse match as key-value pairs
    if (result.condition?.match && typeof result.condition.match === 'string') {
      result.condition.match = {}
    }

    // Ensure array fields are arrays (single string -> wrapped in array)
    const arrayFields: Array<{ parent: any; key: string }> = []
    if (result.condition?.exclude !== undefined) arrayFields.push({ parent: result.condition, key: 'exclude' })
    if (result.trigger?.watch !== undefined) arrayFields.push({ parent: result.trigger, key: 'watch' })

    for (const { parent, key } of arrayFields) {
      if (typeof parent[key] === 'string') {
        parent[key] = [parent[key]]
      }
    }

    // Also parse dash-list arrays from the raw content for exclude and watch
    const excludeArr = parseYamlArray(content, 'exclude')
    if (excludeArr && result.condition) result.condition.exclude = excludeArr

    const watchArr = parseYamlArray(content, 'watch')
    if (watchArr && result.trigger) result.trigger.watch = watchArr

    if (!result.name || !result.trigger?.type) return null
    if (result.action?.type === 'maker-checker') {
      if (!result.action?.makerPrompt || !result.action?.checkerPrompt) return null
    } else if (result.action?.type === 'wait_for_session') {
      if (!result.action?.session_name) return null
    } else if (result.action?.type !== 'diff_review' && result.action?.type !== 'parallel' && !result.action?.prompt) {
      return null
    }

    // Parallel: validate stages array, normalize sub-stage types
    if (result.action?.type === 'parallel') {
      const rawStages = result.action.stages
      if (!Array.isArray(rawStages) || rawStages.length === 0) return null
      // Guard against nested parallel (not supported)
      if (rawStages.some((s: any) => s?.type === 'parallel')) {
        log(`Parallel stage: nested parallel not supported — skipping`)
        return null
      }
      // Normalize 'session' -> 'launch-session' in sub-stages
      result.action.stages = rawStages.map((s: any) => ({
        ...s,
        type: s.type === 'session' ? 'launch-session' : (s.type || 'launch-session'),
      }))
    }

    if (result.enabled === undefined) result.enabled = true

    // Normalize: route-to-session -> launch-session + reuse:true
    if (result.action?.type === 'route-to-session') {
      result.action.type = 'launch-session'
      result.action.reuse = true
    }

    // Default busyStrategy to launch-new (was 'wait', which silently drops prompts)
    if (result.action && !result.action.busyStrategy) {
      result.action.busyStrategy = 'launch-new'
    }

    return result as PipelineDef
  } catch (err) {
    log(`YAML parse error: ${err}`)
    return null
  }
}

// ---- Run History ----

export interface PipelineStageTrace {
  index: number
  actionType: string
  sessionName?: string
  model?: string  // per-stage model override if set
  durationMs: number
  startedAt?: number
  completedAt?: number
  success: boolean
  error?: string
  responseSnippet?: string // first ~120 chars of reviewer response (diff_review only)
  subStages?: PipelineStageTrace[] // parallel sub-stage results
}

export interface PipelineRunEntry {
  ts: string
  trigger: string
  actionExecuted: boolean
  success: boolean
  durationMs: number
  stages?: PipelineStageTrace[]
  totalCost?: number
  stoppedBudget?: boolean
}

const MAX_HISTORY_ENTRIES = 20

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

// ---- State Persistence ----

function debugLogPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '-')
  return join(PIPELINES_DIR, `${safe}.debug.json`)
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

// ---- Template Resolution ----

function resolveTemplate(template: string, ctx: TriggerContext): string {
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
    webhook_payload: JSON.stringify(ctx.webhookPayload || {}),
    ...ghVars,
  }
  return resolveMustacheTemplate(template, context)
}

// ---- Dedup ----

function isDuplicate(pipelineName: string, key: string, ttlSeconds: number, contentSha?: string): boolean {
  const p = pipelines.get(pipelineName)
  if (!p) return false

  // If we have a content SHA, check if the content changed since last fire
  if (contentSha) {
    if (!p.state.contentHashes) p.state.contentHashes = {}
    const lastSha = p.state.contentHashes[key]
    if (lastSha === contentSha) {
      // Content hasn't changed — skip regardless of TTL
      return true
    }
    // Content is new or changed — allow firing even within TTL
    return false
  }

  // No content SHA — fall back to time-based dedup
  const lastFired = p.state.firedKeys[key]
  if (!lastFired) return false
  return Date.now() - lastFired < ttlSeconds * 1000
}

async function recordFired(pipelineName: string, key: string, contentSha?: string): Promise<void> {
  const p = pipelines.get(pipelineName)
  if (!p) return
  p.state.firedKeys[key] = Date.now()
  if (contentSha) {
    if (!p.state.contentHashes) p.state.contentHashes = {}
    p.state.contentHashes[key] = contentSha
  }
  p.state.fireCount++
  p.state.lastFiredAt = new Date().toISOString()

  // Clean expired keys
  const now = Date.now()
  const ttl = (p.def.dedup.ttl || 3600) * 1000
  for (const [k, ts] of Object.entries(p.state.firedKeys)) {
    if (now - ts > ttl * 2) {
      delete p.state.firedKeys[k]
      if (p.state.contentHashes) delete p.state.contentHashes[k]
    }
  }

  await saveState()
}

// ---- Write prompt to file, send short trigger to PTY ----

async function writePromptFile(prompt: string): Promise<string> {
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
  const client = getDaemonClient()
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

async function executeGitPollTrigger(trigger: TriggerDef): Promise<TriggerContext[]> {
  const repos = trigger.repos === 'auto' || !trigger.repos ? await getRepos() : trigger.repos as GitHubRepo[]
  const contexts: TriggerContext[] = []

  for (const repo of repos) {
    try {
      const prs = await fetchPRs(repo)
      for (const pr of prs) {
        contexts.push({
          repo,
          pr,
          githubUser: githubUser || undefined,
          timestamp: new Date().toISOString(),
        })
      }
    } catch (err) {
      log(`Failed to fetch PRs for ${repo.owner}/${repo.name}: ${err}`)
    }
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

async function evaluateCondition(condition: ConditionDef, ctx: TriggerContext): Promise<boolean> {
  switch (condition.type) {
    case 'branch-file-exists': return evaluateBranchFileExists(condition, ctx)
    case 'pr-checks-failed': return evaluatePrChecksFailed(condition, ctx)
    case 'always': return true
    default: return false
  }
}

// ---- Maker-Checker Support ----

/**
 * Wait for an instance to go busy then idle, indicating it has finished
 * processing the last prompt. Returns true on completion, false on timeout.
 */
async function waitForSessionCompletion(instanceId: string, timeoutMs = 600000): Promise<boolean> {
  const client = getDaemonClient()
  return new Promise((resolve) => {
    let done = false
    let seenBusy = false

    const cleanup = () => {
      done = true
      client.removeListener('activity', handler)
      clearTimeout(timeoutId)
    }

    const handler = (id: string, activity: string) => {
      if (id !== instanceId || done) return
      if (activity === 'busy') {
        seenBusy = true
      } else if (activity === 'waiting' && seenBusy) {
        cleanup()
        resolve(true)
      }
    }

    client.on('activity', handler)
    const timeoutId = setTimeout(() => { cleanup(); resolve(false) }, timeoutMs)
  })
}

/** Run artifact capture commands and save stdout to the shared artifacts directory. Never throws. */
async function captureArtifacts(outputs: Array<{ name: string; cmd: string }>, cwd: string | undefined): Promise<void> {
  const artifactsDir = join(COLONY_DIR, 'artifacts')
  await fsp.mkdir(artifactsDir, { recursive: true })
  for (const { name, cmd } of outputs) {
    try {
      const { stdout } = await execFileAsync('sh', ['-c', cmd], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 })
      const result = stdout.trim()
      await fsp.writeFile(join(artifactsDir, `${name}.txt`), result, 'utf-8')
      log(`[artifacts] captured "${name}": ${result.length} bytes`)
    } catch (err: any) {
      log(`[artifacts] warn: capture failed for "${name}" (cmd: ${cmd}): ${err?.message ?? err}`)
    }
  }
}

/** Read artifact files and build a preamble block to prepend to the prompt. */
async function loadArtifactPreamble(inputs: string[]): Promise<string> {
  const artifactsDir = join(COLONY_DIR, 'artifacts')
  const sections: string[] = []
  for (const name of inputs) {
    const filePath = join(artifactsDir, `${name}.txt`)
    if (await pathExists(filePath)) {
      const content = (await fsp.readFile(filePath, 'utf-8')).trim()
      sections.push(`--- Artifact: ${name} ---\n${content}`)
    } else {
      log(`[artifacts] input "${name}" not found at ${filePath} — skipping`)
    }
  }
  return sections.length > 0 ? sections.join('\n\n') + '\n\n' : ''
}

/**
 * Read artifact files and build a structured handoff block with narrative framing.
 * Used for passing decision metadata and constraints between pipeline stages.
 */
async function loadHandoffPreamble(inputs: string[]): Promise<string> {
  const artifactsDir = join(COLONY_DIR, 'artifacts')
  const sections: string[] = []
  for (const name of inputs) {
    const filePath = join(artifactsDir, `${name}.txt`)
    if (await pathExists(filePath)) {
      const content = (await fsp.readFile(filePath, 'utf-8')).trim()
      sections.push(
        `--- Stage Handoff from Prior Stage ---\n` +
        `The previous pipeline stage completed and left this structured briefing. Read it carefully before starting. ` +
        `Respect all "Decisions Made" constraints — do not re-litigate them. Use "Focus for Next Stage" to prioritize your work.\n\n` +
        `${content}\n\n` +
        `--- End of Stage Handoff ---`
      )
    } else {
      log(`[handoff] input "${name}" not found at ${filePath} — skipping`)
    }
  }
  return sections.length > 0 ? sections.join('\n\n') + '\n\n' : ''
}

/** Check if a reviewer response signals approval (APPROVED or LGTM, case-insensitive). */
function isApproved(text: string): boolean {
  const lower = text.toLowerCase()
  return lower.includes('approved') || lower.includes('lgtm')
}

/**
 * Execute a maker-checker loop: maker produces output, checker reviews it.
 * Iterates up to maxIterations times. Completes when checker says APPROVED
 * or iterations are exhausted.
 */
async function runMakerChecker(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<number> {
  const { makerPrompt, checkerPrompt, approvedKeyword = 'APPROVED', maxIterations = 3 } = action
  if (!makerPrompt || !checkerPrompt) {
    log(`maker-checker: missing makerPrompt or checkerPrompt for "${pipelineName}"`)
    return 0
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const safeName = pipelineName.replace(/[^a-zA-Z0-9]/g, '-')
  const runDir = join(COLONY_DIR, 'maker-checker', safeName, runId)
  await fsp.mkdir(runDir, { recursive: true })

  const makerOutputFile = join(runDir, 'maker-output.md')
  const verdictFile = join(runDir, 'checker-verdict.md')
  const cwd = resolveTemplate(action.workingDirectory || '', ctx) || undefined
  const baseName = resolveTemplate(action.name || pipelineName, ctx)

  let prevFeedback = ''
  let accumulatedCost = 0

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    plog(pipelineName, `maker-checker: iteration ${iteration}/${maxIterations}`)

    // ---- Maker ----
    let makerFullPrompt = resolveTemplate(makerPrompt, ctx)
    if (prevFeedback) {
      makerFullPrompt += `\n\n--- Checker Feedback (iteration ${iteration - 1}) ---\n${prevFeedback}\n\nPlease address this feedback in your implementation.`
    }
    makerFullPrompt += `\n\n--- Required Output Step ---\nWhen you are done, write a comprehensive summary of what you did (including relevant file paths, test results, and key decisions) to:\n${makerOutputFile}\nThis MUST be written before you finish — the checker agent depends on it.`

    // Inject pipeline memory
    const p = [...pipelines.values()].find(pp => pp.def.name === pipelineName)
    if (p) {
      const memPath = join(PIPELINES_DIR, `${p.fileName.replace(/\.(yaml|yml)$/, '')}.memory.md`)
      if (await pathExists(memPath)) {
        const memory = (await fsp.readFile(memPath, 'utf-8')).trim()
        if (memory) {
          makerFullPrompt += `\n\n--- Pipeline Memory ---\n${memory}`
        }
      }
    }

    const makerPromptFile = await writePromptFile(makerFullPrompt)
    const makerInst = await createInstance({
      name: `${baseName} [Maker ${iteration}]`,
      workingDirectory: cwd,
      color: action.color,
      args: ['--append-system-prompt-file', makerPromptFile],
      model: action.model,
    })

    const completionPromise = waitForSessionCompletion(makerInst.id)
    await sendPromptWhenReady(makerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
    const makerDone = await completionPromise

    if (!makerDone) {
      plog(pipelineName, `maker-checker: maker timed out on iteration ${iteration}`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" maker timed out (iteration ${iteration})`, level: 'error' })
      return accumulatedCost
    }

    const makerFinalState = await getDaemonClient().getInstance(makerInst.id)
    accumulatedCost += makerFinalState?.tokenUsage.cost ?? 0

    // Read maker output file
    let makerOutput = ''
    try {
      makerOutput = await pathExists(makerOutputFile) ? await fsp.readFile(makerOutputFile, 'utf-8') : '(maker did not write output file)'
    } catch { makerOutput = '(error reading maker output)' }
    plog(pipelineName, `maker-checker: maker output: ${makerOutput.slice(0, 120)}${makerOutput.length > 120 ? '...' : ''}`)

    // ---- Checker ----
    let checkerFullPrompt = `--- Maker Output (iteration ${iteration}) ---\n${makerOutput}\n\n--- End Maker Output ---\n\n`
    checkerFullPrompt += resolveTemplate(checkerPrompt, ctx)
    checkerFullPrompt += `\n\n--- Required Verdict Step ---\nAfter your evaluation, write one of the following to:\n${verdictFile}\n\n- Work is complete and acceptable → write exactly: APPROVED\n- Changes needed → write: NEEDS REVISION: <your specific feedback>\n\nThis file MUST be written before you finish.`

    // Clear any previous verdict
    try { await fsp.writeFile(verdictFile, '', 'utf-8') } catch {}

    const checkerPromptFile = await writePromptFile(checkerFullPrompt)
    const checkerInst = await createInstance({
      name: `${baseName} [Checker ${iteration}]`,
      workingDirectory: cwd,
      color: action.color,
      args: ['--append-system-prompt-file', checkerPromptFile],
      model: action.model,
    })

    const checkerCompletionPromise = waitForSessionCompletion(checkerInst.id)
    await sendPromptWhenReady(checkerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
    const checkerDone = await checkerCompletionPromise

    if (!checkerDone) {
      plog(pipelineName, `maker-checker: checker timed out on iteration ${iteration}`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" checker timed out (iteration ${iteration})`, level: 'error' })
      return accumulatedCost
    }

    const checkerFinalState = await getDaemonClient().getInstance(checkerInst.id)
    accumulatedCost += checkerFinalState?.tokenUsage.cost ?? 0

    // Read verdict
    let verdict = ''
    try { verdict = await pathExists(verdictFile) ? (await fsp.readFile(verdictFile, 'utf-8')).trim() : '' } catch {}
    plog(pipelineName, `maker-checker: checker verdict: ${verdict.slice(0, 120)}`)

    if (isApproved(verdict) || verdict.includes(approvedKeyword)) {
      plog(pipelineName, `maker-checker: APPROVED after ${iteration} iteration(s)`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" APPROVED after ${iteration} iteration(s)`, level: 'info' })
      return accumulatedCost
    }

    prevFeedback = verdict || 'Checker did not write a verdict — please review your work carefully.'
    plog(pipelineName, `maker-checker: not approved (${maxIterations - iteration} retries left)`)
  }

  plog(pipelineName, `maker-checker: exhausted ${maxIterations} iterations without approval`)
  appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" exhausted ${maxIterations} iterations without approval`, level: 'warn' })
  return accumulatedCost
}

// ---- Diff Review Stage ----

const MAX_DIFF_BYTES = 8 * 1024

/**
 * Run a diff-review stage: fetch git diff, dispatch to a reviewer session, check for
 * APPROVED/LGTM. If not approved and auto_fix is set, launch a fixer session and retry.
 * On final failure, creates an approval gate with the review text.
 */
async function runDiffReview(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<{ cost: number; responseSnippet?: string }> {
  const {
    diffBase = 'HEAD~1',
    prompt = 'Review this diff for issues. Reply APPROVED if clean, or list issues.',
    autoFix = false,
    autoFixMaxIterations = 2,
  } = action
  const cwd = (resolveTemplate(action.workingDirectory || '', ctx) || undefined)?.replace(/^~/, app.getPath('home'))

  if (!cwd) {
    throw new Error(`diff-review: workingDirectory is required for git diff`)
  }

  // Validate diff_base ref
  try {
    await execFileAsync('git', ['rev-parse', '--verify', diffBase], { cwd, timeout: 10_000 })
  } catch (err: any) {
    throw new Error(`diff-review: invalid diff_base ref "${diffBase}": ${err?.stderr?.trim() || 'not found'}`)
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const runDir = join(COLONY_DIR, 'diff-reviews', runId)
  await fsp.mkdir(runDir, { recursive: true })
  const verdictFile = join(runDir, 'review-verdict.md')
  const baseName = resolveTemplate(action.name || pipelineName, ctx)
  let accumulatedCost = 0
  let lastResponseSnippet: string | undefined

  const maxIterations = autoFix ? autoFixMaxIterations : 0

  for (let iteration = 0; iteration <= maxIterations; iteration++) {
    // Get diff
    let diff = ''
    try {
      const diffResult = await execFileAsync('git', ['diff', diffBase], { cwd, timeout: 30_000, maxBuffer: 10 * 1024 * 1024 })
      diff = diffResult.stdout || ''
    } catch { /* empty diff */ }
    if (Buffer.byteLength(diff, 'utf-8') > MAX_DIFF_BYTES) {
      const truncBytes = Buffer.from(diff).slice(0, MAX_DIFF_BYTES).toString('utf-8')
      const totalLines = diff.split('\n').length
      const keptLines = truncBytes.split('\n').length
      diff = truncBytes + `\n[... ${totalLines - keptLines} lines truncated]`
    }

    if (!diff.trim()) {
      plog(pipelineName, `diff-review: no diff found against "${diffBase}" — nothing to review`)
      return { cost: accumulatedCost, responseSnippet: 'No changes' }
    }

    const resolvedPrompt = resolveTemplate(prompt, ctx)
    const fullPrompt =
      `--- Git Diff (${diffBase}) ---\n\`\`\`diff\n${diff}\n\`\`\`\n--- End Diff ---\n\n` +
      `${resolvedPrompt}\n\n` +
      `--- Required Output ---\nWrite your verdict to:\n${verdictFile}\n\n` +
      `If the diff looks clean, write exactly: APPROVED\n` +
      `If there are issues, write: NEEDS REVISION: <your specific feedback>\n\n` +
      `This file MUST be written before you finish.`

    try { await fsp.writeFile(verdictFile, '', 'utf-8') } catch { /* ignore */ }

    const reviewerName = iteration === 0 ? `${baseName} [Diff Review]` : `${baseName} [Diff Review ${iteration + 1}]`
    plog(pipelineName, `diff-review: launching reviewer "${reviewerName}" (iteration ${iteration + 1}/${maxIterations + 1})`)

    const promptFile = await writePromptFile(fullPrompt)
    const reviewerInst = await createInstance({
      name: reviewerName,
      workingDirectory: cwd,
      color: action.color,
      args: ['--append-system-prompt-file', promptFile],
      model: action.model,
    })

    const completionPromise = waitForSessionCompletion(reviewerInst.id)
    await sendPromptWhenReady(reviewerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
    const reviewDone = await completionPromise

    if (!reviewDone) {
      plog(pipelineName, `diff-review: reviewer timed out`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Diff review "${pipelineName}" reviewer timed out`, level: 'error' })
      return { cost: accumulatedCost }
    }

    const reviewerState = await getDaemonClient().getInstance(reviewerInst.id)
    accumulatedCost += reviewerState?.tokenUsage.cost ?? 0

    let verdict = ''
    try { verdict = await pathExists(verdictFile) ? (await fsp.readFile(verdictFile, 'utf-8')).trim() : '' } catch { /* ignore */ }
    plog(pipelineName, `diff-review: verdict: ${verdict.slice(0, 120)}`)
    lastResponseSnippet = verdict.slice(0, 120)

    if (isApproved(verdict)) {
      plog(pipelineName, `diff-review: APPROVED`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Diff review "${pipelineName}" approved`, level: 'info' })
      return { cost: accumulatedCost, responseSnippet: lastResponseSnippet }
    }

    // Not approved — auto_fix: launch fixer and loop
    if (iteration < maxIterations) {
      plog(pipelineName, `diff-review: not approved — auto_fix ${iteration + 1}/${maxIterations}`)
      const fixPrompt =
        `The following code diff was reviewed and needs changes:\n\n\`\`\`diff\n${diff}\n\`\`\`\n\n` +
        `Reviewer feedback:\n${verdict}\n\n` +
        `Please address the feedback and make the necessary changes.`
      const fixerPromptFile = await writePromptFile(fixPrompt)
      const fixerInst = await createInstance({
        name: `${baseName} [Auto-fix ${iteration + 1}]`,
        workingDirectory: cwd,
        color: action.color,
        args: ['--append-system-prompt-file', fixerPromptFile],
        model: action.model,
      })
      const fixerCompletion = waitForSessionCompletion(fixerInst.id)
      await sendPromptWhenReady(fixerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
      const fixerDone = await fixerCompletion
      if (!fixerDone) {
        plog(pipelineName, `diff-review: fixer timed out on iteration ${iteration + 1}`)
        break
      }
      const fixerState = await getDaemonClient().getInstance(fixerInst.id)
      accumulatedCost += fixerState?.tokenUsage.cost ?? 0
      continue
    }
  }

  // Failed — create an approval gate with the review text
  plog(pipelineName, `diff-review: not approved — creating approval gate`)
  const reviewText = lastResponseSnippet || 'Review failed'
  const approvalId = `diff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const summary = `Diff review failed — "${pipelineName}": ${reviewText.slice(0, 100)}`
  const expiresAt = new Date(Date.now() + APPROVAL_DEFAULT_TTL_HOURS * 3600 * 1000).toISOString()
  const request: ApprovalRequest = {
    id: approvalId,
    pipelineName,
    summary,
    resolvedVars: { diffBase, reviewText: reviewText.slice(0, 500) },
    createdAt: new Date().toISOString(),
    expiresAt,
  }
  pendingApprovals.set(approvalId, { request, action, ctx, dedupKey: approvalId })
  pendingApprovalKeys.add(approvalId)
  broadcast('pipeline:approval:new', request)
  appendActivity({ source: 'pipeline', name: pipelineName, summary: `Diff review "${pipelineName}" needs attention: ${reviewText.slice(0, 100)}`, level: 'warn' })
  notify(`Colony: Diff Review — ${pipelineName}`, summary, 'pipelines')

  return { cost: accumulatedCost, responseSnippet: lastResponseSnippet }
}

// ---- Parallel Fan-Out Stage ----

// ---- Plan Stage ----

/**
 * Run a pre-execution planning stage: dispatch to an agent session, collect its plan output,
 * then gate on human approval (by default) before the pipeline continues.
 * Writes the plan to an artifact file so subsequent stages can consume it via handoffInputs.
 */
async function runPlanStage(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<{ cost: number; responseSnippet?: string }> {
  const planKeyword = action.plan_keyword ?? 'PLAN_READY'
  const requireApproval = action.require_approval !== false // default true
  const rawPrompt = resolveTemplate(action.prompt || '', ctx)
  const cwd = resolveTemplate(action.workingDirectory || '', ctx) || undefined
  const resolvedCwd = cwd?.replace(/^~/, app.getPath('home'))

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const safePipelineName = pipelineName.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase()
  const planDir = join(COLONY_DIR, 'plan-stages', safePipelineName, runId)
  await fsp.mkdir(planDir, { recursive: true })
  const planOutputFile = join(planDir, 'plan-output.md')

  const artifactsDir = join(COLONY_DIR, 'artifacts')
  await fsp.mkdir(artifactsDir, { recursive: true })
  const artifactName = `${safePipelineName}-${runId}-implementation-plan`
  const artifactPath = join(artifactsDir, `${artifactName}.txt`)

  const fullPrompt =
    `${rawPrompt}\n\n` +
    `--- Output Instructions ---\n` +
    `Write your complete plan to:\n${planOutputFile}\n\n` +
    `When your plan is fully written to that file, output the keyword: ${planKeyword}\n\n` +
    `The plan file MUST be written before you finish.`

  const baseName = resolveTemplate(action.name || pipelineName, ctx)
  const plannerName = `Pipe (${baseName}) [Plan]`
  plog(pipelineName, `plan-stage: launching planner "${plannerName}"`)

  const promptFile = await writePromptFile(fullPrompt)
  const plannerInst = await createInstance({
    name: plannerName,
    workingDirectory: resolvedCwd,
    color: action.color,
    args: ['--append-system-prompt-file', promptFile],
    mcpServers: action.mcpServers,
    model: action.model,
  })

  const completionPromise = waitForSessionCompletion(plannerInst.id, 5 * 60 * 1000)
  await sendPromptWhenReady(plannerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
  const plannerDone = await completionPromise

  const plannerFinalState = await getDaemonClient().getInstance(plannerInst.id)
  const cost = plannerFinalState?.tokenUsage.cost ?? 0

  let planContent = ''
  if (plannerDone) {
    try {
      planContent = await pathExists(planOutputFile) ? (await fsp.readFile(planOutputFile, 'utf-8')).trim() : ''
    } catch { planContent = '' }
  }

  if (!planContent) {
    const reason = !plannerDone ? 'timed out after 5 minutes' : 'did not write output file'
    planContent = `(Planning session ${reason})`
    plog(pipelineName, `plan-stage: warning — ${reason}`)
    appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" plan stage: ${reason}`, level: 'warn' })
  }

  await fsp.writeFile(artifactPath, planContent, 'utf-8')
  plog(pipelineName, `plan-stage: artifact written: ${artifactName}`)

  const snippetRaw = planContent.slice(0, 120)
  const responseSnippet = planContent.length > 120 ? snippetRaw + '…' : snippetRaw

  if (!requireApproval) {
    plog(pipelineName, `plan-stage: require_approval=false — proceeding automatically`)
    appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" plan complete — proceeding automatically`, level: 'info' })
    return { cost, responseSnippet }
  }

  // Create a blocking approval gate — resolves when approved, rejects when dismissed/expired
  const approvalId = `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const truncatedPlan = planContent.length > 2000 ? planContent.slice(0, 2000) + '\n[...truncated]' : planContent

  const request: ApprovalRequest = {
    id: approvalId,
    pipelineName,
    summary: `Implementation plan ready — approve to continue`,
    resolvedVars: {
      'plan.content': truncatedPlan,
      'plan.artifact': artifactName,
    },
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + APPROVAL_DEFAULT_TTL_HOURS * 3600 * 1000).toISOString(),
  }

  return new Promise((resolve, rejectPromise) => {
    pendingApprovals.set(approvalId, {
      request,
      action,
      ctx,
      dedupKey: approvalId,
      resolve: () => resolve({ cost, responseSnippet }),
      reject: (reason: string) => rejectPromise(new Error(reason)),
    })
    pendingApprovalKeys.add(approvalId)
    broadcast('pipeline:approval:new', request)
    plog(pipelineName, `plan-stage: awaiting approval ${approvalId}`)
    appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" waiting for plan approval`, level: 'warn' })
    notify(`Colony: Plan approval needed`, `Pipeline "${pipelineName}" — Approve plan to proceed?`, 'pipelines')
  })
}

/**
 * Dispatch all sub-stages concurrently (Promise.allSettled or Promise.all).
 * Returns total cost + per-sub-stage trace for the history record.
 */
async function runParallel(
  action: ActionDef,
  ctx: TriggerContext,
  pipelineName: string,
): Promise<{ cost: number; subStages: PipelineStageTrace[] }> {
  const { stages = [], fail_fast = true } = action
  const baseName = resolveTemplate(action.name || pipelineName, ctx)
  plog(pipelineName, `parallel: dispatching ${stages.length} sub-stage(s)`)

  const subStages: PipelineStageTrace[] = new Array(stages.length)

  const tasks = stages.map((subAction, i) => async (): Promise<{ cost: number; i: number }> => {
    const start = Date.now()
    const sessionName = resolveTemplate(subAction.name || `${baseName} [${i + 1}]`, ctx)
    let stageError: string | undefined
    let stageCost = 0
    try {
      const result = await fireAction(subAction, ctx, pipelineName)
      stageCost = result.cost
    } catch (err) {
      stageError = String(err)
      throw err
    } finally {
      const end = Date.now()
      subStages[i] = {
        index: i,
        actionType: subAction.type,
        sessionName,
        durationMs: end - start,
        startedAt: start,
        completedAt: end,
        success: !stageError,
        error: stageError,
      }
    }
    return { cost: stageCost, i }
  })

  let totalCost = 0

  if (fail_fast) {
    // Promise.all semantics: abort on first failure
    const results = await Promise.all(tasks.map(t => t()))
    totalCost = results.reduce((sum, r) => sum + r.cost, 0)
  } else {
    // Promise.allSettled semantics: run all regardless of failures
    const settled = await Promise.allSettled(tasks.map(t => t()))
    for (const r of settled) {
      if (r.status === 'fulfilled') totalCost += r.value.cost
    }
  }

  return { cost: totalCost, subStages }
}

/**
 * Poll until a named session exits, optionally writing its exit reason to an artifact.
 * Tolerates "not found" for first 30s (session may not have launched yet).
 * Transient daemon disconnects are ignored — polling continues.
 */
async function runWaitForSession(
  action: ActionDef,
  pipelineName: string
): Promise<{ cost: number; responseSnippet?: string }> {
  const sessionName = action.session_name || ''
  const timeoutMs = (action.timeout_minutes ?? 30) * 60_000
  const GRACE_MS = 30_000
  const POLL_INTERVAL_MS = 5_000
  const startedAt = Date.now()

  plog(pipelineName, `wait_for_session: waiting for "${sessionName}" (timeout ${action.timeout_minutes ?? 30}m)`)

  return new Promise((resolve, reject) => {
    let intervalId: ReturnType<typeof setInterval>

    const check = async () => {
      const elapsed = Date.now() - startedAt

      if (elapsed >= timeoutMs) {
        clearInterval(intervalId)
        reject(new Error(`wait_for_session: timeout after ${action.timeout_minutes ?? 30}m waiting for "${sessionName}"`))
        return
      }

      let instances: import('../shared/types').ClaudeInstance[] = []
      try {
        instances = await getAllInstances()
      } catch {
        return // transient daemon disconnect — keep polling
      }

      const target = instances.find(i => i.name === sessionName)

      if (!target) {
        if (elapsed < GRACE_MS) return // grace period — session may not have launched yet
        clearInterval(intervalId)
        reject(new Error(`wait_for_session: session "${sessionName}" not found after grace period`))
        return
      }

      if (target.status === 'exited') {
        clearInterval(intervalId)
        const exitNote = target.exitCode === 0 || target.exitCode === null
          ? 'exited cleanly'
          : `exited with code ${target.exitCode}`

        if (action.artifact_output) {
          try {
            const artifactsDir = join(COLONY_DIR, 'artifacts')
            await fsp.mkdir(artifactsDir, { recursive: true })
            await fsp.writeFile(join(artifactsDir, `${action.artifact_output}.txt`), exitNote, 'utf-8')
          } catch (err) {
            log(`wait_for_session: failed to write artifact: ${err}`)
          }
        }

        resolve({ cost: 0, responseSnippet: `"${sessionName}" ${exitNote}` })
      }
    }

    check() // immediate check before first interval tick
    intervalId = setInterval(check, POLL_INTERVAL_MS)
  })
}

// ---- Action Execution ----

async function fireAction(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<{ cost: number; responseSnippet?: string; subStages?: PipelineStageTrace[] }> {
  if (action.type === 'maker-checker') {
    return { cost: await runMakerChecker(action, ctx, pipelineName) }
  }
  if (action.type === 'diff_review') {
    return runDiffReview(action, ctx, pipelineName)
  }
  if (action.type === 'parallel') {
    return runParallel(action, ctx, pipelineName)
  }
  if (action.type === 'plan') {
    return runPlanStage(action, ctx, pipelineName)
  }
  if (action.type === 'wait_for_session') {
    return runWaitForSession(action, pipelineName)
  }

  const rawName = resolveTemplate(action.name || 'Pipeline Session', ctx)
  // Prefix with "Pipe" so pipeline-launched sessions are identifiable
  const name = rawName.startsWith('Pipe') ? rawName : `Pipe (${rawName})`
  const cwd = resolveTemplate(action.workingDirectory || '', ctx) || undefined
  let prompt = resolveTemplate(action.prompt || '', ctx)

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
        getDaemonClient().writeToInstance(existing.id, buildFilePromptTrigger(filePath) + '\r')
        broadcast('pipeline:fired', { pipeline: name, instanceId: existing.id, routed: true })
        return { cost: 0 }
      }

      if (action.busyStrategy === 'launch-new') {
        plog(name, `route: session busy, busyStrategy=launch-new → launching new`)
      } else {
        log(`Routing: session busy, waiting for idle (60s timeout)...`)
        const sent = await sendPromptToExistingSession(existing.id, prompt)
        if (sent) {
          broadcast('pipeline:fired', { pipeline: name, instanceId: existing.id, routed: true })
          return { cost: 0 }
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
      })
      await sendPromptWhenReady(inst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
      broadcast('pipeline:fired', { pipeline: name, instanceId: inst.id, routed: true, resumed: true })
      return { cost: 0 }
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
  const inst = await createInstance({
    name,
    workingDirectory: resolvedCwd,
    color: action.color,
    args: ['--append-system-prompt-file', promptFile],
    mcpServers: action.mcpServers,
    model: action.model,
  })

  // Full prompt is in the system prompt file — just send a trigger
  await sendPromptWhenReady(inst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })

  // Auto-close: kill session if still running after timeout (default 10 min)
  const autoCloseMinutes = action.timeout_minutes || 10
  const client = getDaemonClient()
  let autoCloseResolved = false

  const onFinished = (id: string, activity: string) => {
    if (id !== inst.id || activity !== 'waiting') return
    if (autoCloseResolved) return
    autoCloseResolved = true
    client.removeListener('activity', onFinished)
    clearTimeout(autoCloseTimeout)
    log(`pipeline session ${inst.id} finished, killing in 5s`)
    setTimeout(async () => {
      try { await killInstance(inst.id) } catch { /* already gone */ }
    }, 5000)
  }
  client.on('activity', onFinished)

  const autoCloseTimeout = setTimeout(async () => {
    if (autoCloseResolved) return
    autoCloseResolved = true
    client.removeListener('activity', onFinished)
    log(`pipeline session ${inst.id} still running after ${autoCloseMinutes}min, force-killing`)
    try { await killInstance(inst.id) } catch { /* already gone */ }
  }, autoCloseMinutes * 60_000)

  // Notify renderer about pipeline-triggered session
  broadcast('pipeline:fired', { pipeline: name, instanceId: inst.id })
  return { cost: 0 }
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
    let contexts: TriggerContext[] = []

    if (def.trigger.type === 'git-poll') {
      plog(`Fetching PRs (git-poll, ${def.trigger.repos === 'auto' ? 'auto repos' : 'custom repos'})`)
      contexts = await executeGitPollTrigger(def.trigger)
      plog(`Found ${contexts.length} repo/PR context(s) to evaluate`)
    } else if (def.trigger.type === 'cron') {
      plog(`Cron trigger — creating single context`)
      contexts = [{ githubUser: githubUser || undefined, timestamp: new Date().toISOString() }]
    } else {
      plog(`Trigger type "${def.trigger.type}" not supported for preview`)
    }

    if (contexts.length === 0) {
      plog(`No contexts — check: repos configured? PRs open? gh auth ok?`)
    }

    for (const ctx of contexts) {
      const prLabel = ctx.pr ? `PR #${ctx.pr.number} (${ctx.pr.branch})` : 'cron'
      const repoLabel = ctx.repo ? `${ctx.repo.owner}/${ctx.repo.name}` : ''
      plog(`Evaluating: ${[repoLabel, prLabel].filter(Boolean).join(' ')}`)

      const matched = await evaluateCondition(def.condition, ctx)
      if (!matched) {
        plog(`  condition not met (${def.condition.type}: ${def.condition.path || def.condition.branch || ''})`)
        continue
      }
      plog(`  ✓ condition matched (sha=${ctx.contentSha || 'none'})`)

      const dedupKey = resolveTemplate(def.dedup.key, ctx)
      const wouldBeDeduped = isDuplicate(def.name, dedupKey, def.dedup.ttl || 3600, ctx.contentSha)
      if (wouldBeDeduped) {
        plog(`  ⊘ would be deduped (key=${dedupKey})`)
      } else {
        plog(`  → would fire action: ${def.action.type}`)
      }

      // Collect resolved template vars for this context
      const resolvedVars: Record<string, string> = {
        'action.name': resolveTemplate(def.action.name || 'Pipeline Session', ctx),
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

async function runPoll(pipelineName: string): Promise<void> {
  const p = pipelines.get(pipelineName)
  if (!p || !p.def.enabled) return
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
  let budgetWarnSent = false

  try {
    let contexts: TriggerContext[] = []

    if (p.def.trigger.type === 'git-poll') {
      plog(pipelineName, `polling (git-poll, ${p.def.trigger.repos === 'auto' ? 'auto repos' : 'custom repos'})`)
      contexts = await executeGitPollTrigger(p.def.trigger)
      plog(pipelineName, `found ${contexts.length} repo/PR contexts to evaluate`)
    } else if (p.def.trigger.type === 'cron') {
      plog(pipelineName, `cron triggered`)
      contexts = [{
        githubUser: githubUser || undefined,
        timestamp: new Date().toISOString(),
      }]
    } else if (p.def.trigger.type === 'file-poll') {
      plog(pipelineName, `file change detected`)
      contexts = [{
        githubUser: githubUser || undefined,
        timestamp: new Date().toISOString(),
      }]
    } else if (p.def.trigger.type === 'webhook') {
      plog(pipelineName, `webhook triggered`)
      const payload = webhookPayloads.get(pipelineName)
      webhookPayloads.delete(pipelineName)
      contexts = [{
        githubUser: githubUser || undefined,
        timestamp: new Date().toISOString(),
        webhookPayload: payload,
      }]
    }

    if (contexts.length === 0) {
      plog(pipelineName, `no contexts — check: repos configured? PRs open? gh auth ok?`)
    }

    for (const ctx of contexts) {
      const prLabel = ctx.pr ? `PR #${ctx.pr.number} (${ctx.pr.branch})` : 'no PR'
      const repoLabel = ctx.repo ? `${ctx.repo.owner}/${ctx.repo.name}` : 'no repo'
      plog(pipelineName, `evaluating: ${repoLabel} ${prLabel}`)

      if (ctx.repo && !ctx.repo.localPath) {
        plog(pipelineName, `⚠ repo ${repoLabel} has no localPath — session launch will use fallback cwd`)
      }

      const matched = await evaluateCondition(p.def.condition, ctx)
      if (!matched) {
        plog(pipelineName, `condition not met for ${prLabel} (${p.def.condition.type}: ${p.def.condition.path || p.def.condition.branch || ''})`)
        continue
      }
      p.state.lastMatchAt = new Date().toISOString()
      plog(pipelineName, `✓ condition matched for ${prLabel} (sha=${ctx.contentSha || 'none'})`)

      const dedupKey = resolveTemplate(p.def.dedup.key, ctx)
      if (isDuplicate(pipelineName, dedupKey, p.def.dedup.ttl || 3600, ctx.contentSha)) {
        plog(pipelineName, `⊘ dedup: already processed ${dedupKey} with same content`)
        continue
      }
      if (pendingApprovalKeys.has(dedupKey)) {
        plog(pipelineName, `⊘ approval already queued for ${dedupKey}`)
        continue
      }

      // Scoped approval gate: check rules before the binary requireApproval check
      const ruleMatch = matchRules(p.def.action.type, estimateActionCost(p.def.action.type), [])
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
            'action.name': resolveTemplate(p.def.action.name || 'Pipeline Session', ctx),
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
          pendingApprovals.set(approvalId, { request, action: p.def.action, ctx, dedupKey })
          pendingApprovalKeys.add(dedupKey)
          broadcast('pipeline:approval:new', request)
          plog(pipelineName, `→ approval required by rule "${ruleMatch.name}", queued request ${approvalId}`)
          appendActivity({
            source: 'pipeline',
            name: pipelineName,
            summary: `Pipeline "${pipelineName}" approval required by rule "${ruleMatch.name}"`,
            level: 'warn',
          })
          notify(`Colony: Approval needed`, `Pipeline "${pipelineName}" — ${summary}`, 'pipelines')
          continue
        }
      }

      if (p.def.requireApproval) {
        const approvalId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const summary = ctx.pr
          ? `PR #${ctx.pr.number}: ${ctx.pr.branch}${ctx.repo ? ` (${ctx.repo.owner}/${ctx.repo.name})` : ''}`
          : `${pipelineName} (${ctx.timestamp.slice(0, 10)})`
        const resolvedVars: Record<string, string> = {
          'action.name': resolveTemplate(p.def.action.name || 'Pipeline Session', ctx),
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
        pendingApprovals.set(approvalId, { request, action: p.def.action, ctx, dedupKey })
        pendingApprovalKeys.add(dedupKey)
        broadcast('pipeline:approval:new', request)
        plog(pipelineName, `→ approval required, queued request ${approvalId} for ${prLabel}`)
        appendActivity({ source: 'pipeline', name: pipelineName, summary: `Pipeline "${pipelineName}" waiting for approval — ${summary}`, level: 'warn' })
        notify(`Colony: Approval needed`, `Pipeline "${pipelineName}" — ${summary}`, 'pipelines')
        continue
      }

      plog(pipelineName, `→ firing action: ${p.def.action.type} for ${prLabel}`)
      const stageStart = Date.now()
      const stageSessionName = resolveTemplate(p.def.action.name || 'Pipeline Session', ctx)
      let stageError: string | undefined
      let stageCost = 0
      let stageResponseSnippet: string | undefined
      let stageSubStages: PipelineStageTrace[] | undefined
      try {
        const result = await fireAction(p.def.action, ctx, p.def.name)
        stageCost = result.cost
        stageResponseSnippet = result.responseSnippet
        stageSubStages = result.subStages
      } catch (stageErr) {
        stageError = String(stageErr)
        throw stageErr
      } finally {
        const stageEnd = Date.now()
        stages.push({
          index: stages.length,
          actionType: p.def.action.type,
          sessionName: stageSessionName,
          model: p.def.action.model,
          durationMs: stageEnd - stageStart,
          startedAt: stageStart,
          completedAt: stageEnd,
          success: !stageError,
          error: stageError,
          responseSnippet: stageResponseSnippet,
          subStages: stageSubStages,
        })
      }
      totalCost += stageCost

      // Budget check
      if (p.def.budget) {
        const warnAt = p.def.budget.warn_at ?? p.def.budget.max_cost_usd * 0.75
        if (!budgetWarnSent && totalCost >= warnAt) {
          budgetWarnSent = true
          notify(`Colony: Budget warning`, `Pipeline "${pipelineName}" has spent $${totalCost.toFixed(2)} (warn threshold: $${warnAt.toFixed(2)})`, 'pipelines')
        }
        if (totalCost >= p.def.budget.max_cost_usd) {
          plog(pipelineName, `⚠ budget limit reached ($${totalCost.toFixed(2)} >= $${p.def.budget.max_cost_usd.toFixed(2)}) — stopping run`)
          notify(`Colony: Budget limit reached`, `Pipeline "${pipelineName}" stopped after spending $${totalCost.toFixed(2)}`, 'pipelines')
          stoppedBudget = true
          break
        }
      }

      await recordFired(pipelineName, dedupKey, ctx.contentSha)
      fired = true
      plog(pipelineName, `✓ action fired successfully`)
      const firedSummary = ctx.pr
        ? `Pipeline "${pipelineName}" fired for PR #${ctx.pr.number} (${ctx.pr.branch})`
        : `Pipeline "${pipelineName}" fired`
      appendActivity({ source: 'pipeline', name: pipelineName, summary: firedSummary, level: 'info' })
      notify(`Colony: Pipeline fired`, firedSummary, 'pipelines')
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
      p.def.enabled = false
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
      } catch (writeErr) {
        log(`Failed to update ${p.fileName} after auto-pause: ${writeErr}`)
      }
      plog(pipelineName, `Auto-paused after ${CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures`)
      appendActivity({
        source: 'pipeline',
        name: pipelineName,
        summary: `Pipeline "${pipelineName}" auto-paused after ${CONSECUTIVE_FAILURE_THRESHOLD} consecutive failures`,
        level: 'warn',
      })
    }
  }

  runningPolls.delete(pipelineName)

  p.state.lastRunStoppedBudget = stoppedBudget

  // Record run history
  await appendHistory(pipelineName, {
    ts: new Date().toISOString(),
    trigger: p.def.trigger.type,
    actionExecuted: fired,
    success: !pollError,
    durationMs: Date.now() - pollStartedAt,
    stages: stages.length > 0 ? stages : undefined,
    totalCost: totalCost > 0 ? totalCost : undefined,
    stoppedBudget: stoppedBudget || undefined,
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

    // Track last cron-triggered minute to avoid double-firing within same minute
    let lastCronMinute = -1

    const cronCheck = setInterval(() => {
      const now = new Date()
      const currentMinute = now.getHours() * 60 + now.getMinutes()

      if (cronMatches(cronExpr, now) && currentMinute !== lastCronMinute) {
        lastCronMinute = currentMinute
        log(`Cron matched for ${name} at ${now.toLocaleTimeString()}`)
        runPoll(name)
      }
    }, 60000) // Check every minute

    timers.set(name, cronCheck)

    // Also run on startup if cron matches right now
    setTimeout(() => {
      if (cronMatches(cronExpr)) {
        log(`Cron matches on startup for ${name}`)
        runPoll(name)
      }
    }, 10000)
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

      const current = filePollSnapshots.get(name)!
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

    setTimeout(() => runPoll(name), 10000)
    const timer = setInterval(() => runPoll(name), intervalMs)
    timers.set(name, timer)
  }
}

export function stopPipelines(): void {
  for (const [name, timer] of timers) {
    clearInterval(timer)
  }
  timers.clear()
  filePollSnapshots.clear()
  if (approvalSweepTimer) {
    clearInterval(approvalSweepTimer)
    approvalSweepTimer = null
  }
  started = false
  log('All pipelines stopped')
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

export function triggerPollNow(name: string): boolean {
  const p = pipelines.get(name)
  if (!p) return false
  runPoll(name)
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
    return true
  }

  try {
    const { cost: _ } = await fireAction(action, ctx, request.pipelineName)
    await recordFired(request.pipelineName, dedupKey, ctx.contentSha)
    appendActivity({ source: 'pipeline', name: request.pipelineName, summary: `Pipeline "${request.pipelineName}" approved and fired — ${request.summary}`, level: 'info' })
  } catch (err) {
    appendActivity({ source: 'pipeline', name: request.pipelineName, summary: `Pipeline "${request.pipelineName}" failed after approval: ${String(err).slice(0, 100)}`, level: 'error' })
  }
  broadcast('pipeline:approval:update', { id, status: 'approved' })
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
export function fireWebhookPipeline(slug: string, payload: unknown): { ok: boolean; error?: string } {
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
  runPoll(pipelineName).catch((err) => {
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
