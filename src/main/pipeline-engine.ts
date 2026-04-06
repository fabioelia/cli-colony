/**
 * Pipeline Engine — reactive automation for Claude Colony.
 *
 * Pipelines are YAML files in ~/.claude-colony/pipelines/ that define
 * trigger → condition → action patterns. The engine polls on intervals,
 * evaluates conditions, and fires actions (usually launching sessions).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs'
import { execSync } from 'child_process'
import { join, basename } from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'
import { createInstance, getAllInstances } from './instance-manager'
import { getDaemonClient } from './daemon-client'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { getRepos, fetchPRs, fetchChecks, gh } from './github'
import { findBestRoute } from './session-router'
import { getAllRepoConfigs } from './repo-config-loader'
import { cronMatches } from '../shared/cron'
import { resolveMustacheTemplate } from '../shared/utils'
import type { GitHubRepo, GitHubPR, PRChecks, ApprovalRequest } from '../shared/types'
import { appendActivity } from './activity-manager'
import { notify } from './notifications'

// ---- Types ----

export interface TriggerDef {
  type: 'git-poll' | 'file-poll' | 'cron'
  interval?: number // seconds
  cron?: string // cron expression: "min hour dom month dow" (e.g. "0 9 * * 1-5")
  repos?: 'auto' | GitHubRepo[]
  watch?: string[]
}

export interface ConditionDef {
  type: 'branch-file-exists' | 'pr-checks-failed' | 'file-created' | 'always'
  branch?: string
  path?: string
  match?: Record<string, string>
  exclude?: string[] // check names to ignore (substring match)
}

export interface ActionDef {
  type: 'launch-session' | 'route-to-session' | 'maker-checker' // route-to-session is deprecated, normalized to launch-session + reuse:true
  reuse?: boolean // try to find/resume a matching session before launching new
  name?: string
  workingDirectory?: string
  color?: string
  prompt?: string // required for launch-session; omitted for maker-checker
  match?: {
    gitBranch?: string
    workingDirectory?: string
  }
  busyStrategy?: 'wait' | 'launch-new' // default: 'launch-new'
  mcpServers?: string[] // named MCP servers from catalog to inject via --mcp-config
  outputs?: string
  artifactOutputs?: Array<{ name: string; cmd: string }> // capture commands run at fire time; saved to <COLONY_DIR>/artifacts/<name>.txt
  artifactInputs?: string[] // artifact names to inject into prompt preamble (from prior captures)
  // maker-checker specific fields
  makerPrompt?: string
  checkerPrompt?: string
  approvedKeyword?: string // keyword to detect approval in checker output (default: 'APPROVED')
  maxIterations?: number   // max maker retries (default: 3)
}

export interface DedupDef {
  key: string
  ttl?: number // seconds
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
}

interface PendingApproval {
  request: ApprovalRequest
  action: ActionDef
  ctx: TriggerContext
  dedupKey: string
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
    } else if (!result.action?.prompt) {
      return null
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

// ---- State Persistence ----

function debugLogPath(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '-')
  return join(PIPELINES_DIR, `${safe}.debug.json`)
}

function loadState(): Record<string, PipelineState> {
  try {
    if (existsSync(STATE_PATH)) {
      const raw = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
      for (const key of Object.keys(raw)) {
        if (!raw[key].debugLog) raw[key].debugLog = []
        if (!raw[key].consecutiveFailures) raw[key].consecutiveFailures = 0
      }
      return raw
    }
  } catch { /* ignore */ }
  return {}
}

function saveState(): void {
  const state: Record<string, any> = {}
  for (const [name, p] of pipelines) {
    const { debugLog, ...rest } = p.state
    state[name] = rest
  }
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    log(`Failed to save state: ${err}`)
  }
}

/** Persist the last 50 debug log entries per pipeline to disk. */
function saveDebugLogs(): void {
  for (const [name, p] of pipelines) {
    if (p.state.debugLog.length === 0) continue
    const entries = p.state.debugLog.slice(-50)
    try {
      writeFileSync(debugLogPath(name), JSON.stringify({ entries, savedAt: new Date().toISOString() }, null, 2), 'utf-8')
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
  const context: Record<string, unknown> = {
    ...ctx,
    github: { user: ctx.githubUser || '' },
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

function recordFired(pipelineName: string, key: string, contentSha?: string): void {
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

  saveState()
}

// ---- Write prompt to file, send short trigger to PTY ----

function writePromptFile(prompt: string): string {
  const promptsDir = join(COLONY_DIR, 'pipeline-prompts')
  if (!existsSync(promptsDir)) mkdirSync(promptsDir, { recursive: true })
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const filePath = join(promptsDir, `${id}.md`)
  writeFileSync(filePath, prompt, 'utf-8')
  return filePath
}

function buildFilePromptTrigger(filePath: string): string {
  return `Read and execute the instructions in ${filePath}`
}

// ---- Send Prompt to Existing Session (no trust prompt handling) ----

async function sendPromptToExistingSession(instanceId: string, prompt: string): Promise<boolean> {
  const client = getDaemonClient()
  const inst = await client.getInstance(instanceId)
  const filePath = writePromptFile(prompt)
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
  const repos = trigger.repos === 'auto' || !trigger.repos ? getRepos() : trigger.repos as GitHubRepo[]
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
function captureArtifacts(outputs: Array<{ name: string; cmd: string }>, cwd: string | undefined): void {
  const artifactsDir = join(COLONY_DIR, 'artifacts')
  mkdirSync(artifactsDir, { recursive: true })
  for (const { name, cmd } of outputs) {
    try {
      const result = execSync(cmd, { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 }).toString().trim()
      writeFileSync(join(artifactsDir, `${name}.txt`), result, 'utf-8')
      log(`[artifacts] captured "${name}": ${result.length} bytes`)
    } catch (err: any) {
      log(`[artifacts] warn: capture failed for "${name}" (cmd: ${cmd}): ${err?.message ?? err}`)
    }
  }
}

/** Read artifact files and build a preamble block to prepend to the prompt. */
function loadArtifactPreamble(inputs: string[]): string {
  const artifactsDir = join(COLONY_DIR, 'artifacts')
  const sections: string[] = []
  for (const name of inputs) {
    const filePath = join(artifactsDir, `${name}.txt`)
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8').trim()
      sections.push(`--- Artifact: ${name} ---\n${content}`)
    } else {
      log(`[artifacts] input "${name}" not found at ${filePath} — skipping`)
    }
  }
  return sections.length > 0 ? sections.join('\n\n') + '\n\n' : ''
}

/**
 * Execute a maker-checker loop: maker produces output, checker reviews it.
 * Iterates up to maxIterations times. Completes when checker says APPROVED
 * or iterations are exhausted.
 */
async function runMakerChecker(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<void> {
  const { makerPrompt, checkerPrompt, approvedKeyword = 'APPROVED', maxIterations = 3 } = action
  if (!makerPrompt || !checkerPrompt) {
    log(`maker-checker: missing makerPrompt or checkerPrompt for "${pipelineName}"`)
    return
  }

  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const safeName = pipelineName.replace(/[^a-zA-Z0-9]/g, '-')
  const runDir = join(COLONY_DIR, 'maker-checker', safeName, runId)
  mkdirSync(runDir, { recursive: true })

  const makerOutputFile = join(runDir, 'maker-output.md')
  const verdictFile = join(runDir, 'checker-verdict.md')
  const cwd = resolveTemplate(action.workingDirectory || '', ctx) || undefined
  const baseName = resolveTemplate(action.name || pipelineName, ctx)

  let prevFeedback = ''

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
      if (existsSync(memPath)) {
        const memory = readFileSync(memPath, 'utf-8').trim()
        if (memory) {
          makerFullPrompt += `\n\n--- Pipeline Memory ---\n${memory}`
        }
      }
    }

    const makerPromptFile = writePromptFile(makerFullPrompt)
    const makerInst = await createInstance({
      name: `${baseName} [Maker ${iteration}]`,
      workingDirectory: cwd,
      color: action.color,
      args: ['--append-system-prompt-file', makerPromptFile],
    })

    const completionPromise = waitForSessionCompletion(makerInst.id)
    await sendPromptWhenReady(makerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
    const makerDone = await completionPromise

    if (!makerDone) {
      plog(pipelineName, `maker-checker: maker timed out on iteration ${iteration}`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" maker timed out (iteration ${iteration})`, level: 'error' })
      return
    }

    // Read maker output file
    let makerOutput = ''
    try {
      makerOutput = existsSync(makerOutputFile) ? readFileSync(makerOutputFile, 'utf-8') : '(maker did not write output file)'
    } catch { makerOutput = '(error reading maker output)' }
    plog(pipelineName, `maker-checker: maker output: ${makerOutput.slice(0, 120)}${makerOutput.length > 120 ? '...' : ''}`)

    // ---- Checker ----
    let checkerFullPrompt = `--- Maker Output (iteration ${iteration}) ---\n${makerOutput}\n\n--- End Maker Output ---\n\n`
    checkerFullPrompt += resolveTemplate(checkerPrompt, ctx)
    checkerFullPrompt += `\n\n--- Required Verdict Step ---\nAfter your evaluation, write one of the following to:\n${verdictFile}\n\n- Work is complete and acceptable → write exactly: APPROVED\n- Changes needed → write: NEEDS REVISION: <your specific feedback>\n\nThis file MUST be written before you finish.`

    // Clear any previous verdict
    try { writeFileSync(verdictFile, '', 'utf-8') } catch {}

    const checkerPromptFile = writePromptFile(checkerFullPrompt)
    const checkerInst = await createInstance({
      name: `${baseName} [Checker ${iteration}]`,
      workingDirectory: cwd,
      color: action.color,
      args: ['--append-system-prompt-file', checkerPromptFile],
    })

    const checkerCompletionPromise = waitForSessionCompletion(checkerInst.id)
    await sendPromptWhenReady(checkerInst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
    const checkerDone = await checkerCompletionPromise

    if (!checkerDone) {
      plog(pipelineName, `maker-checker: checker timed out on iteration ${iteration}`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" checker timed out (iteration ${iteration})`, level: 'error' })
      return
    }

    // Read verdict
    let verdict = ''
    try { verdict = existsSync(verdictFile) ? readFileSync(verdictFile, 'utf-8').trim() : '' } catch {}
    plog(pipelineName, `maker-checker: checker verdict: ${verdict.slice(0, 120)}`)

    if (verdict.includes(approvedKeyword)) {
      plog(pipelineName, `maker-checker: APPROVED after ${iteration} iteration(s)`)
      appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" APPROVED after ${iteration} iteration(s)`, level: 'info' })
      return
    }

    prevFeedback = verdict || 'Checker did not write a verdict — please review your work carefully.'
    plog(pipelineName, `maker-checker: not approved (${maxIterations - iteration} retries left)`)
  }

  plog(pipelineName, `maker-checker: exhausted ${maxIterations} iterations without approval`)
  appendActivity({ source: 'pipeline', name: pipelineName, summary: `Maker-checker "${pipelineName}" exhausted ${maxIterations} iterations without approval`, level: 'warn' })
}

// ---- Action Execution ----

async function fireAction(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<void> {
  if (action.type === 'maker-checker') {
    return runMakerChecker(action, ctx, pipelineName)
  }

  const rawName = resolveTemplate(action.name || 'Pipeline Session', ctx)
  // Prefix with "Pipe" so pipeline-launched sessions are identifiable
  const name = rawName.startsWith('Pipe') ? rawName : `Pipe (${rawName})`
  const cwd = resolveTemplate(action.workingDirectory || '', ctx) || undefined
  let prompt = resolveTemplate(action.prompt || '', ctx)

  // Inject artifact preamble when action.artifactInputs is configured
  if (action.artifactInputs?.length) {
    const preamble = loadArtifactPreamble(action.artifactInputs)
    if (preamble) prompt = preamble + prompt
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
    if (existsSync(memPath)) {
      const memory = readFileSync(memPath, 'utf-8').trim()
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
    }

    plog(name, `reuse: looking for branch=${resolvedMatch.gitBranch} dir=${resolvedMatch.workingDirectory} repo=${resolvedMatch.repoName} pr=#${resolvedMatch.prNumber}`)
    const route = await findBestRoute(resolvedMatch, log)

    if (route?.type === 'running') {
      const existing = route.instance
      plog(name, `route: found running session "${existing.name}" (${existing.id}) activity=${existing.activity}`)

      if (existing.activity === 'waiting') {
        const filePath = writePromptFile(prompt)
        getDaemonClient().writeToInstance(existing.id, buildFilePromptTrigger(filePath) + '\r')
        broadcast('pipeline:fired', { pipeline: name, instanceId: existing.id, routed: true })
        return
      }

      if (action.busyStrategy === 'launch-new') {
        plog(name, `route: session busy, busyStrategy=launch-new → launching new`)
      } else {
        log(`Routing: session busy, waiting for idle (60s timeout)...`)
        const sent = await sendPromptToExistingSession(existing.id, prompt)
        if (sent) {
          broadcast('pipeline:fired', { pipeline: name, instanceId: existing.id, routed: true })
          return
        }
        log(`Routing: timed out waiting for session, falling through to launch new`)
      }
    } else if (route?.type === 'resume') {
      plog(name, `route: resuming history session "${route.name}" (${route.sessionId})`)
      const promptFile = writePromptFile(prompt)
      const inst = await createInstance({
        name: name,
        workingDirectory: route.project,
        color: action.color,
        args: ['--resume', route.sessionId, '--append-system-prompt-file', promptFile],
        mcpServers: action.mcpServers,
      })
      await sendPromptWhenReady(inst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })
      broadcast('pipeline:fired', { pipeline: name, instanceId: inst.id, routed: true, resumed: true })
      return
    } else {
      plog(name, `route: no matching session found → launching new`)
    }
  }

  // ---- Launch new session (fallback when reuse finds nothing) ----
  if (action.type !== 'launch-session') return

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
    captureArtifacts(action.artifactOutputs, resolvedCwd)
  }

  plog(name, `launching session "${name}" in ${resolvedCwd || '$HOME (no cwd resolved!)'}`)

  const promptFile = writePromptFile(prompt)
  const inst = await createInstance({
    name,
    workingDirectory: resolvedCwd,
    color: action.color,
    args: ['--append-system-prompt-file', promptFile],
    mcpServers: action.mcpServers,
  })

  // Full prompt is in the system prompt file — just send a trigger
  await sendPromptWhenReady(inst.id, { prompt: 'Execute the instructions in your system prompt. Begin now.' })

  // Notify renderer about pipeline-triggered session
  broadcast('pipeline:fired', { pipeline: name, instanceId: inst.id })
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
  let fired = false

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
      await fireAction(p.def.action, ctx, p.def.name)
      recordFired(pipelineName, dedupKey, ctx.contentSha)
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
        let content = readFileSync(filePath, 'utf-8')
        content = content.replace(/^enabled:\s*(true|false)/m, `enabled: false`)
        writeFileSync(filePath, content, 'utf-8')
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

  // Trim debug log to the last N iterations
  const sepIndices: number[] = []
  for (let i = 0; i < p.state.debugLog.length; i++) {
    if (p.state.debugLog[i] === DEBUG_ITERATION_SEP) sepIndices.push(i)
  }
  if (sepIndices.length > MAX_DEBUG_ITERATIONS) {
    const cutAt = sepIndices[sepIndices.length - MAX_DEBUG_ITERATIONS]
    p.state.debugLog = p.state.debugLog.slice(cutAt)
  }

  saveDebugLogs() // persist debug logs after every poll
  if (fired) saveState()
  broadcast('pipeline:status', getPipelineList())
}

// ---- Public API ----

export function loadPipelines(): void {
  if (!existsSync(PIPELINES_DIR)) mkdirSync(PIPELINES_DIR, { recursive: true })

  const savedState = loadState()
  pipelines.clear()

  // 1. User pipelines (from ~/.claude-colony/pipelines/)
  const files = readdirSync(PIPELINES_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
  const userNames = new Set<string>()

  for (const file of files) {
    try {
      const content = readFileSync(join(PIPELINES_DIR, file), 'utf-8')
      const def = parsePipelineYaml(content)
      if (!def) {
        log(`Failed to parse ${file}`)
        continue
      }
      const state = savedState[def.name] || freshState()
      try {
        const lp = debugLogPath(def.name)
        if (existsSync(lp)) {
          const { entries } = JSON.parse(readFileSync(lp, 'utf-8'))
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
          if (existsSync(lp)) {
            const { entries } = JSON.parse(readFileSync(lp, 'utf-8'))
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

  loadPipelines()

  for (const [name, p] of pipelines) {
    if (!p.def.enabled) continue
    schedulePipeline(name, p.def)
  }

  // Sweep expired approvals every 60 seconds
  approvalSweepTimer = setInterval(() => sweepExpiredApprovals(), 60_000)
}

function schedulePipeline(name: string, def: PipelineDef): void {
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
        const s = statSync(p)
        if (s.isDirectory()) {
          for (const child of readdirSync(p)) {
            try { snapshot.set(`${p}/${child}`, statSync(`${p}/${child}`).mtimeMs) } catch { /* missing */ }
          }
        } else {
          snapshot.set(p, s.mtimeMs)
        }
      } catch { /* path doesn't exist yet */ }
    }

    const timer = setInterval(() => {
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
          const s = statSync(watchPath)
          if (s.isDirectory()) {
            for (const child of readdirSync(watchPath)) {
              const full = `${watchPath}/${child}`
              try {
                const mtime = statSync(full).mtimeMs
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
    })
  }
  return result
}

export function togglePipeline(name: string, enabled: boolean): boolean {
  const p = pipelines.get(name)
  if (!p) return false

  p.def.enabled = enabled

  // Update the YAML file
  const filePath = join(PIPELINES_DIR, p.fileName)
  try {
    let content = readFileSync(filePath, 'utf-8')
    content = content.replace(/^enabled:\s*(true|false)/m, `enabled: ${enabled}`)
    writeFileSync(filePath, content, 'utf-8')
  } catch (err) {
    log(`Failed to update ${p.fileName}: ${err}`)
  }

  if (enabled && !timers.has(name)) {
    schedulePipeline(name, p.def)
    log(`Enabled pipeline: ${name}`)
  } else if (!enabled && timers.has(name)) {
    clearInterval(timers.get(name)!)
    timers.delete(name)
    log(`Disabled pipeline: ${name}`)
  }

  saveState()
  broadcast('pipeline:status', getPipelineList())
  return true
}

export function triggerPollNow(name: string): boolean {
  const p = pipelines.get(name)
  if (!p) return false
  runPoll(name)
  return true
}

export function getPipelinesDir(): string {
  if (!existsSync(PIPELINES_DIR)) mkdirSync(PIPELINES_DIR, { recursive: true })
  return PIPELINES_DIR
}

export function getPipelineContent(fileName: string): string | null {
  const filePath = join(PIPELINES_DIR, fileName)
  try {
    return readFileSync(filePath, 'utf-8')
  } catch {
    return null
  }
}

export function savePipelineContent(fileName: string, content: string): boolean {
  const filePath = join(PIPELINES_DIR, fileName)
  try {
    writeFileSync(filePath, content, 'utf-8')
    // Reload pipelines to pick up changes
    stopPipelines()
    loadPipelines()
    // Restart enabled ones
    for (const [name, p] of pipelines) {
      if (p.def.enabled) {
        schedulePipeline(name, p.def)
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
export function setPipelineCron(fileName: string, cron: string | null): boolean {
  const content = getPipelineContent(fileName)
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
    const { request, dedupKey } = entry
    if (request.expiresAt && new Date(request.expiresAt).getTime() <= now) {
      pendingApprovals.delete(id)
      pendingApprovalKeys.delete(dedupKey)
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
  const { request, action, ctx, dedupKey } = entry
  pendingApprovals.delete(id)
  pendingApprovalKeys.delete(dedupKey)
  try {
    await fireAction(action, ctx, request.pipelineName)
    recordFired(request.pipelineName, dedupKey, ctx.contentSha)
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
  const { request, dedupKey } = entry
  pendingApprovals.delete(id)
  pendingApprovalKeys.delete(dedupKey)
  appendActivity({ source: 'pipeline', name: request.pipelineName, summary: `Pipeline "${request.pipelineName}" action dismissed — ${request.summary}`, level: 'warn' })
  broadcast('pipeline:approval:update', { id, status: 'dismissed' })
  return true
}

// ---- Seed Default Pipeline ----

export function seedDefaultPipelines(): void {
  if (!existsSync(PIPELINES_DIR)) mkdirSync(PIPELINES_DIR, { recursive: true })

  const feedbackFile = join(PIPELINES_DIR, 'colony-feedback.yaml')
  if (!existsSync(feedbackFile)) {
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
    writeFileSync(feedbackFile, template, 'utf-8')
    log('Seeded default pipeline: colony-feedback.yaml')
  }

  const readmeFile = join(PIPELINES_DIR, 'colony-feedback.readme.md')
  if (!existsSync(readmeFile)) {
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
    writeFileSync(readmeFile, readme, 'utf-8')
    log('Seeded pipeline README: colony-feedback.readme.md')
  }

  // ---- CI Auto-Fix pipeline ----
  const ciFixFile = join(PIPELINES_DIR, 'ci-auto-fix.yaml')
  if (!existsSync(ciFixFile)) {
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
    writeFileSync(ciFixFile, ciTemplate, 'utf-8')
    log('Seeded default pipeline: ci-auto-fix.yaml')
  }

  // ---- PR Attention Digest pipeline ----
  const digestFile = join(PIPELINES_DIR, 'pr-attention-digest.yaml')
  if (!existsSync(digestFile)) {
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
    writeFileSync(digestFile, digestTemplate, 'utf-8')
    log('Seeded default pipeline: pr-attention-digest.yaml')
  }
}
