/**
 * Pipeline Engine — reactive automation for Claude Colony.
 *
 * Pipelines are YAML files in ~/.claude-colony/pipelines/ that define
 * trigger → condition → action patterns. The engine polls on intervals,
 * evaluates conditions, and fires actions (usually launching sessions).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { app } from 'electron'
import { createInstance, writeToInstance, getAllInstances } from './instance-manager'
import type { ClaudeInstance } from './instance-manager'
import { getDaemonClient } from './daemon-client'
import { getRepos, fetchPRs, fetchChecks, gh } from './github'
import { scanSessions } from './session-scanner'
import type { CliSession } from './session-scanner'
import type { GitHubRepo, GitHubPR, PRChecks } from './github'

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
  type: 'launch-session' | 'route-to-session'
  reuse?: boolean // shorthand: when true, launch-session tries to find/resume a matching session first
  name?: string
  workingDirectory?: string
  color?: string
  prompt: string
  // route-to-session specific (also used when reuse: true):
  match?: {
    gitBranch?: string
    workingDirectory?: string
  }
  busyStrategy?: 'wait' | 'launch-new' // default: 'wait'
  outputs?: string // directory to scan for generated artifacts (template supported)
}

export interface DedupDef {
  key: string
  ttl?: number // seconds
}

export interface PipelineDef {
  name: string
  description?: string
  enabled: boolean
  trigger: TriggerDef
  condition: ConditionDef
  action: ActionDef
  dedup: DedupDef
}

interface PipelineState {
  lastPollAt: string | null
  firedKeys: Record<string, number> // dedup key -> timestamp ms
  contentHashes: Record<string, string> // dedup key -> last seen content SHA
  fireCount: number
  lastFiredAt: string | null
  lastError: string | null
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
  lastFiredAt: string | null
  lastError: string | null
  fireCount: number
}

interface TriggerContext {
  repo?: GitHubRepo
  pr?: GitHubPR
  checks?: PRChecks
  file?: { path: string; name: string; directory: string }
  githubUser?: string
  timestamp: string
  contentSha?: string // SHA of matched file — for change detection
}

// ---- Cron Expression Matcher ----
// Supports: "min hour dom month dow" (5 fields)
// Each field: number, *, */N, N-M, comma-separated, named days (mon-sun)

const DAY_NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }

function cronFieldMatches(field: string, value: number, max: number): boolean {
  if (field === '*') return true
  for (const part of field.split(',')) {
    const trimmed = part.trim().toLowerCase()
    // */N step
    if (trimmed.startsWith('*/')) {
      const step = parseInt(trimmed.slice(2))
      if (!isNaN(step) && step > 0 && value % step === 0) return true
      continue
    }
    // N-M range
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-')
      const start = DAY_NAMES[startStr] ?? parseInt(startStr)
      const end = DAY_NAMES[endStr] ?? parseInt(endStr)
      if (!isNaN(start) && !isNaN(end) && value >= start && value <= end) return true
      continue
    }
    // Named day
    if (DAY_NAMES[trimmed] !== undefined) {
      if (DAY_NAMES[trimmed] === value) return true
      continue
    }
    // Exact number
    const num = parseInt(trimmed)
    if (!isNaN(num) && num === value) return true
  }
  return false
}

function cronMatches(expression: string, date?: Date): boolean {
  const d = date || new Date()
  const fields = expression.trim().split(/\s+/)
  if (fields.length < 5) return false
  const [minute, hour, dom, month, dow] = fields
  return (
    cronFieldMatches(minute, d.getMinutes(), 59) &&
    cronFieldMatches(hour, d.getHours(), 23) &&
    cronFieldMatches(dom, d.getDate(), 31) &&
    cronFieldMatches(month, d.getMonth() + 1, 12) &&
    cronFieldMatches(dow, d.getDay(), 6)
  )
}

// ---- Constants ----

import { colonyPaths } from '../shared/colony-paths'

const COLONY_DIR = colonyPaths.root
const PIPELINES_DIR = colonyPaths.pipelines
const STATE_PATH = join(COLONY_DIR, 'pipeline-state.json')

// ---- Engine ----

const pipelines = new Map<string, { def: PipelineDef; state: PipelineState; fileName: string }>()
const timers = new Map<string, ReturnType<typeof setInterval>>()
const runningPolls = new Set<string>()
let githubUser: string | null = null
let started = false

function log(msg: string): void {
  console.log(`[pipeline] ${msg}`)
}

import { broadcast } from './broadcast'

// ---- YAML Parser (simple, no dependency) ----

function parseYaml(content: string): PipelineDef | null {
  try {
    const lines = content.split('\n')
    const result: any = {}
    const stack: { obj: any; indent: number }[] = [{ obj: result, indent: -1 }]

    for (const rawLine of lines) {
      const line = rawLine.replace(/\r$/, '')
      if (!line.trim() || line.trim().startsWith('#')) continue

      const indent = line.search(/\S/)
      const trimmed = line.trim()

      // Pop stack to find parent
      while (stack.length > 1 && stack[stack.length - 1].indent >= indent) {
        stack.pop()
      }
      const parent = stack[stack.length - 1].obj

      if (trimmed.includes(':')) {
        // Only split on the FIRST colon that's followed by a space or end-of-line
        // This preserves colons in values like "Fix the bug: it crashes" and URLs
        const colonMatch = trimmed.match(/^(-\s+)?([^:]+?):\s(.*)/) || trimmed.match(/^(-\s+)?([^:]+?):$/)
        if (colonMatch) {
          const key = (colonMatch[2] || '').trim()
          let value = (colonMatch[3] || '').trim()

          if (!value) {
            // Nested object or block scalar
            const child: any = {}
            parent[key] = child
            stack.push({ obj: child, indent })
          } else {
            // Remove quotes
            value = value.replace(/^["']|["']$/g, '')
            // Parse booleans and numbers
            if (value === 'true') parent[key] = true
            else if (value === 'false') parent[key] = false
            else if (/^\d+$/.test(value)) parent[key] = parseInt(value)
            else parent[key] = value
          }
        }
      }
    }

    // Parse multiline prompt (look for prompt: |)
    const promptMatch = content.match(/prompt:\s*\|\n([\s\S]*?)(?=\n\w|\ndedup:|\n$)/m)
    if (promptMatch) {
      const promptLines = promptMatch[1].split('\n')
      const baseIndent = promptLines[0]?.search(/\S/) ?? 4
      const prompt = promptLines
        .map(l => l.slice(baseIndent))
        .join('\n')
        .trim()
      if (result.action) result.action.prompt = prompt
    }

    // Parse match as key-value pairs
    if (result.condition?.match && typeof result.condition.match === 'string') {
      // Single-line match — shouldn't happen with proper YAML but handle gracefully
      result.condition.match = {}
    }

    // Parse YAML arrays: lines starting with "- value" under a key
    // This handles exclude, watch, and any other array fields
    const arrayFields: Array<{ parent: any; key: string }> = []
    if (result.condition?.exclude !== undefined) arrayFields.push({ parent: result.condition, key: 'exclude' })
    if (result.trigger?.watch !== undefined) arrayFields.push({ parent: result.trigger, key: 'watch' })

    for (const { parent, key } of arrayFields) {
      if (typeof parent[key] === 'string') {
        parent[key] = [parent[key]]
      }
    }

    // Also parse dash-list arrays from the raw content for exclude and watch
    const parseArrayField = (section: string, field: string): string[] | null => {
      const regex = new RegExp(`${field}:\\s*\\n((?:\\s+-\\s+.+\\n?)+)`, 'm')
      const m = content.match(regex)
      if (!m) return null
      return m[1].split('\n')
        .map(l => l.trim())
        .filter(l => l.startsWith('- '))
        .map(l => l.slice(2).trim().replace(/^["']|["']$/g, ''))
    }

    const excludeArr = parseArrayField('condition', 'exclude')
    if (excludeArr && result.condition) result.condition.exclude = excludeArr

    const watchArr = parseArrayField('trigger', 'watch')
    if (watchArr && result.trigger) result.trigger.watch = watchArr

    if (!result.name || !result.trigger?.type || !result.action?.prompt) return null
    if (result.enabled === undefined) result.enabled = true

    return result as PipelineDef
  } catch (err) {
    log(`YAML parse error: ${err}`)
    return null
  }
}

// ---- State Persistence ----

function loadState(): Record<string, PipelineState> {
  try {
    if (existsSync(STATE_PATH)) {
      return JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    }
  } catch { /* ignore */ }
  return {}
}

function saveState(): void {
  const state: Record<string, PipelineState> = {}
  for (const [name, p] of pipelines) {
    state[name] = p.state
  }
  try {
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8')
  } catch (err) {
    log(`Failed to save state: ${err}`)
  }
}

function freshState(): PipelineState {
  return { lastPollAt: null, firedKeys: {}, contentHashes: {}, fireCount: 0, lastFiredAt: null, lastError: null }
}

// ---- Template Resolution ----

function resolveTemplate(template: string, ctx: TriggerContext): string {
  return template.replace(/\{\{(\w+(?:\.\w+)*)\}\}/g, (_match, key: string) => {
    const parts = key.split('.')
    let val: any = ctx

    // Top-level aliases
    if (parts[0] === 'github' && parts[1] === 'user') return ctx.githubUser || ''
    if (parts[0] === 'timestamp') return ctx.timestamp

    for (const part of parts) {
      if (val == null) return ''
      val = val[part]
    }

    if (Array.isArray(val)) return val.join(', ')
    return val != null ? String(val) : ''
  })
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

// ---- Send Prompt When Ready (main-process version) ----

async function sendPromptWhenReady(instanceId: string, prompt: string): Promise<void> {
  const client = getDaemonClient()

  return new Promise((resolve) => {
    let sent = false
    let waitCount = 0
    let forceTimer: ReturnType<typeof setTimeout>

    const fire = () => {
      if (sent) return
      sent = true
      client.removeListener('activity', handler)
      clearTimeout(forceTimer)
      clearTimeout(abandonTimer)
      // Write text first, then submit after a short delay so the TUI
      // has time to process the input before receiving the Enter key.
      writeToInstance(instanceId, prompt)
      setTimeout(() => {
        writeToInstance(instanceId, '\r')
        resolve()
      }, 150)
    }

    const handler = (_id: string, activity: string) => {
      if (_id !== instanceId || sent) return
      if (activity === 'waiting') {
        waitCount++
        if (waitCount === 1) {
          // Dismiss trust/directory prompt
          writeToInstance(instanceId, '\r')
          // If no second waiting arrives, force-send after 3s
          forceTimer = setTimeout(() => fire(), 3000)
        } else {
          fire()
        }
      }
    }

    client.on('activity', handler)

    const abandonTimer = setTimeout(() => {
      if (!sent) {
        sent = true
        client.removeListener('activity', handler)
        resolve()
      }
    }, 15000)
  })
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

async function sendPromptToExistingSession(instanceId: string, prompt: string): Promise<void> {
  const client = getDaemonClient()
  const inst = await client.getInstance(instanceId)
  const filePath = writePromptFile(prompt)
  const trigger = buildFilePromptTrigger(filePath)

  if (inst?.activity === 'waiting') {
    writeToInstance(instanceId, trigger + '\r')
    return
  }

  // Wait for session to become idle
  return new Promise((resolve) => {
    let sent = false

    const handler = (_id: string, activity: string) => {
      if (_id !== instanceId || sent) return
      if (activity === 'waiting') {
        sent = true
        client.removeListener('activity', handler)
        writeToInstance(instanceId, trigger + '\r')
        resolve()
      }
    }

    client.on('activity', handler)

    // 60s timeout — existing session might be mid-task
    setTimeout(() => {
      if (!sent) {
        sent = true
        client.removeListener('activity', handler)
        log(`Timed out waiting for session ${instanceId} to become idle`)
        resolve()
      }
    }, 60000)
  })
}

// ---- Session Routing ----

// Check the live git branch for a directory (not the stale metadata)
function getLiveBranch(dir: string): string | null {
  try {
    const { execFileSync } = require('child_process') as typeof import('child_process')
    return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: dir, timeout: 3000, encoding: 'utf-8',
    }).trim() || null
  } catch { return null }
}

// Check branch in a subdirectory matching the repo name (for monorepo/workspace parents)
function getLiveBranchInSubdir(dir: string, repoName: string): string | null {
  if (!repoName) return null
  try {
    const { readdirSync, statSync } = require('fs') as typeof import('fs')
    const entries = readdirSync(dir)
    for (const entry of entries) {
      if (entry.toLowerCase() === repoName.toLowerCase()) {
        const sub = join(dir, entry)
        try { if (!statSync(sub).isDirectory()) continue } catch { continue }
        return getLiveBranch(sub)
      }
    }
  } catch { /* ignore */ }
  return null
}

// Check if a session name partially matches a branch name
function nameMatchesBranch(sessionName: string, branch: string): boolean {
  if (!sessionName || !branch || sessionName.length < 4) return false
  const nameLower = sessionName.toLowerCase().trim()
  const branchLower = branch.toLowerCase()
  if (nameLower.length < 4) return false
  // Exact substring (name in branch or branch in name)
  if (branchLower.includes(nameLower)) return true
  if (nameLower.includes(branchLower)) return true
  // Word-level: split name into words, check all significant words appear in branch
  const nameWords = nameLower.split(/[\s\-_\/]+/).filter(w => w.length > 2)
  return nameWords.length > 0 && nameWords.every(w => branchLower.includes(w))
}

// Shared scoring function for both running instances and history sessions
function scoreSessionDir(
  dir: string,
  sessionName: string,
  metadataBranch: string | null,
  match: { gitBranch?: string; workingDirectory?: string; repoName?: string; prNumber?: number }
): number {
  let score = 0

  // 1. Git branch check — check live branch first, then subdirectory, then metadata
  if (match.gitBranch) {
    const liveBranch = getLiveBranch(dir)
    if (liveBranch === match.gitBranch) {
      score += 15
    } else if (match.repoName) {
      // If dir is a parent workspace, check for repo subdirectory
      // But only if the dir seems related (contains repo as direct child, not a generic parent)
      const subBranch = getLiveBranchInSubdir(dir, match.repoName)
      if (subBranch === match.gitBranch) {
        // Only give full points if the dir seems repo-specific (not e.g. ~/projects)
        const dirDepth = dir.split('/').length
        const homeDepth = (process.env.HOME || '').split('/').length
        if (dirDepth > homeDepth + 1) {
          score += 12
        } else {
          score += 3 // generic parent — weak signal
        }
      }
    }
    // Stale metadata branch
    if (score === 0 && metadataBranch === match.gitBranch) {
      score += 10
    }
  }

  // 2. Working directory match
  if (match.workingDirectory) {
    if (dir === match.workingDirectory) score += 5
    else if (dir.startsWith(match.workingDirectory + '/')) score += 3
  }

  // 3. Repo name in directory path (direct child or in path)
  if (match.repoName && !match.workingDirectory) {
    const dirLower = dir.toLowerCase()
    const repoLower = match.repoName.toLowerCase()
    if (dirLower.endsWith('/' + repoLower) || dirLower.includes('/' + repoLower + '/')) {
      score += 4
    } else {
      // Check if repo exists as subdirectory (workspace parent containing multiple repos)
      try {
        const sub = join(dir, match.repoName)
        const { statSync } = require('fs') as typeof import('fs')
        if (statSync(sub).isDirectory()) score += 3
      } catch { /* ignore */ }
    }
  }

  // 4. Session name matches PR number
  if (match.prNumber && sessionName) {
    const nameLower = sessionName.toLowerCase()
    if (nameLower.includes(`#${match.prNumber}`) || nameLower.includes(`pr ${match.prNumber}`)) {
      score += 8
    }
  }

  // 5. Session name matches branch (exact or partial)
  if (match.gitBranch && sessionName) {
    if (sessionName.toLowerCase().includes(match.gitBranch.toLowerCase())) {
      score += 6
    } else if (nameMatchesBranch(sessionName, match.gitBranch)) {
      score += 5
    }
  }

  // 6. Penalty: if directory is clearly inside a DIFFERENT repo
  //    e.g. session in .../repo-a/... should not match repo=repo-b
  if (match.repoName && score > 0) {
    const dirLower = dir.toLowerCase()
    const repoLower = match.repoName.toLowerCase()
    // Get all configured repos to detect siblings
    const allRepos = getRepos()
    for (const r of allRepos) {
      const otherLower = r.name.toLowerCase()
      if (otherLower === repoLower) continue // same repo, no penalty
      // If the dir path contains this other repo name as a segment
      if (dirLower.includes('/' + otherLower + '/') || dirLower.endsWith('/' + otherLower)) {
        score = Math.max(0, score - 10) // strong penalty for wrong repo
        break
      }
    }
  }

  return score
}

type RouteResult = {
  type: 'running'
  instance: ClaudeInstance
  score: number
} | {
  type: 'resume'
  sessionId: string
  project: string
  name: string
  score: number
  messageCount: number
}

async function findBestRoute(match: {
  gitBranch?: string
  workingDirectory?: string
  repoName?: string
  prNumber?: number
}): Promise<RouteResult | null> {
  const candidates: RouteResult[] = []

  // ---- 1. Score running instances ----
  const all = await getAllInstances()
  const running = all.filter(i => i.status === 'running')

  for (const inst of running) {
    const score = scoreSessionDir(inst.workingDirectory, inst.name || '', inst.gitBranch, match)

    if (score > 0) {
      const adjusted = inst.activity === 'waiting' ? score + 1 : score
      candidates.push({ type: 'running', instance: inst, score: adjusted })
    }
  }

  // ---- 2. Score CLI history sessions (for --resume) ----
  // Only consider if no strong running match found
  const bestRunning = candidates.length > 0 ? Math.max(...candidates.map(c => c.score)) : 0

  if (bestRunning < 10) {
    try {
      const history = scanSessions(100)
      // Exclude sessions that are already running in Colony
      const runningArgs = all.flatMap(i => i.args || [])

      for (const session of history) {
        if (runningArgs.includes(session.sessionId)) continue

        const sessionName = session.name || session.display || ''
        const score = scoreSessionDir(session.project, sessionName, null, match)

        if (score > 0) {
          candidates.push({
            type: 'resume',
            sessionId: session.sessionId,
            project: session.project,
            name: session.name || session.display.slice(0, 40),
            score: score - 2,
            messageCount: session.messageCount,
          })
        }
      }
    } catch (err) {
      log(`Failed to scan session history: ${err}`)
    }
  }

  if (candidates.length === 0) return null

  // Sort by score descending, then prefer running over resume, then most messages (deeper context)
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (a.type !== b.type) return a.type === 'running' ? -1 : 1
    // Among resume candidates, prefer more messages (deeper context)
    const aMsgs = a.type === 'resume' ? a.messageCount : 0
    const bMsgs = b.type === 'resume' ? b.messageCount : 0
    return bMsgs - aMsgs
  })

  const best = candidates[0]
  if (best.type === 'running') {
    log(`Routing: best match is running session "${best.instance.name}" score=${best.score}`)
  } else {
    log(`Routing: best match is history session "${best.name}" (${best.sessionId}) score=${best.score} — will resume`)
  }
  return best
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
    const response = await gh(['api', `repos/${slug}/contents/${filePath}?ref=${branch}`, '--jq', '.sha'])
    ctx.contentSha = response.trim() || undefined
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
    const { createHash } = require('crypto') as typeof import('crypto')
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

// ---- Action Execution ----

async function fireAction(action: ActionDef, ctx: TriggerContext, pipelineName: string): Promise<void> {
  const rawName = resolveTemplate(action.name || 'Pipeline Session', ctx)
  // Prefix with "Pipe" so pipeline-launched sessions are identifiable
  const name = rawName.startsWith('Pipe') ? rawName : `Pipe (${rawName})`
  const cwd = resolveTemplate(action.workingDirectory || '', ctx) || undefined
  let prompt = resolveTemplate(action.prompt, ctx)

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
  // reuse: true on launch-session acts like route-to-session
  const shouldRoute = action.type === 'route-to-session' || (action.type === 'launch-session' && action.reuse)
  if (shouldRoute) {
    const matchDef = action.match || {}
    const resolvedMatch = {
      gitBranch: matchDef.gitBranch ? resolveTemplate(matchDef.gitBranch, ctx) : ctx.pr?.branch,
      workingDirectory: matchDef.workingDirectory ? resolveTemplate(matchDef.workingDirectory, ctx) : undefined,
      repoName: ctx.repo?.name,
      prNumber: ctx.pr?.number,
    }

    log(`Routing: looking for session matching branch=${resolvedMatch.gitBranch} dir=${resolvedMatch.workingDirectory} repo=${resolvedMatch.repoName} pr=#${resolvedMatch.prNumber}`)
    const route = await findBestRoute(resolvedMatch)

    if (route?.type === 'running') {
      const existing = route.instance
      log(`Routing: found running session "${existing.name}" (${existing.id}) activity=${existing.activity}`)

      if (existing.activity === 'waiting') {
        const filePath = writePromptFile(prompt)
        writeToInstance(existing.id, buildFilePromptTrigger(filePath) + '\r')
        broadcast('pipeline:fired', { pipeline: name, instanceId: existing.id, routed: true })
        return
      }

      if (action.busyStrategy === 'launch-new') {
        log(`Routing: session busy, busyStrategy=launch-new, launching new session`)
      } else {
        log(`Routing: session busy, waiting for idle...`)
        await sendPromptToExistingSession(existing.id, prompt)
        broadcast('pipeline:fired', { pipeline: name, instanceId: existing.id, routed: true })
        return
      }
    } else if (route?.type === 'resume') {
      log(`Routing: resuming history session "${route.name}" (${route.sessionId})`)
      const promptFile = writePromptFile(prompt)
      const inst = await createInstance({
        name: name,
        workingDirectory: route.project,
        color: action.color,
        args: ['--resume', route.sessionId, '--append-system-prompt-file', promptFile],
      })
      await sendPromptWhenReady(inst.id, 'Execute the instructions in your system prompt. Begin now.')
      broadcast('pipeline:fired', { pipeline: name, instanceId: inst.id, routed: true, resumed: true })
      return
    } else {
      log(`Routing: no matching session found, launching new`)
    }
  }

  // ---- Launch new session (or route-to-session fallback) ----
  if (action.type !== 'launch-session' && action.type !== 'route-to-session') return

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

  log(`Firing action: launching "${name}" in ${resolvedCwd || '$HOME'}`)

  const promptFile = writePromptFile(prompt)
  const inst = await createInstance({
    name,
    workingDirectory: resolvedCwd,
    color: action.color,
    args: ['--append-system-prompt-file', promptFile],
  })

  // Full prompt is in the system prompt file — just send a trigger
  await sendPromptWhenReady(inst.id, 'Execute the instructions in your system prompt. Begin now.')

  // Notify renderer about pipeline-triggered session
  broadcast('pipeline:fired', { pipeline: name, instanceId: inst.id })
}

// ---- Poll Loop ----

async function runPoll(pipelineName: string): Promise<void> {
  const p = pipelines.get(pipelineName)
  if (!p || !p.def.enabled) return
  if (runningPolls.has(pipelineName)) return // prevent overlapping polls

  runningPolls.add(pipelineName)
  broadcast('pipeline:status', getPipelineList())

  p.state.lastPollAt = new Date().toISOString()
  let fired = false

  try {
    let contexts: TriggerContext[] = []

    if (p.def.trigger.type === 'git-poll') {
      contexts = await executeGitPollTrigger(p.def.trigger)
    } else if (p.def.trigger.type === 'cron') {
      contexts = [{
        githubUser: githubUser || undefined,
        timestamp: new Date().toISOString(),
      }]
    }

    for (const ctx of contexts) {
      const matched = await evaluateCondition(p.def.condition, ctx)
      if (!matched) continue

      const dedupKey = resolveTemplate(p.def.dedup.key, ctx)
      if (isDuplicate(pipelineName, dedupKey, p.def.dedup.ttl || 3600, ctx.contentSha)) continue

      await fireAction(p.def.action, ctx, p.def.name)
      recordFired(pipelineName, dedupKey, ctx.contentSha)
      fired = true
    }

    p.state.lastError = null
  } catch (err) {
    p.state.lastError = String(err)
    log(`Poll error for ${pipelineName}: ${err}`)
  }

  runningPolls.delete(pipelineName)
  if (fired) saveState() // only write to disk if something fired
  broadcast('pipeline:status', getPipelineList())
}

// ---- Public API ----

export function loadPipelines(): void {
  if (!existsSync(PIPELINES_DIR)) mkdirSync(PIPELINES_DIR, { recursive: true })

  const savedState = loadState()
  pipelines.clear()

  const files = readdirSync(PIPELINES_DIR).filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))

  for (const file of files) {
    try {
      const content = readFileSync(join(PIPELINES_DIR, file), 'utf-8')
      const def = parseYaml(content)
      if (!def) {
        log(`Failed to parse ${file}`)
        continue
      }
      const state = savedState[def.name] || freshState()
      pipelines.set(def.name, { def, state, fileName: file })
      log(`Loaded pipeline: ${def.name} (${def.enabled ? 'enabled' : 'disabled'})`)
    } catch (err) {
      log(`Error loading ${file}: ${err}`)
    }
  }
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
      lastError: p.state.lastError,
      fireCount: p.state.fireCount,
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
  path: "reviews/{{pr.number}}/feedback.md"
  match:
    pr.author: "{{github.user}}"

action:
  type: route-to-session
  match:
    gitBranch: "{{pr.branch}}"
    workingDirectory: "{{repo.localPath}}"
  busyStrategy: wait
  name: "Feedback: {{repo.name}}#{{pr.number}}"
  workingDirectory: "{{repo.localPath}}"
  color: "#f59e0b"
  prompt: |
    A reviewer left feedback on PR #{{pr.number}} ({{pr.title}}) on branch {{pr.branch}}.

    The feedback file is at: reviews/{{pr.number}}/feedback.md on the colony-feedback branch.

    1. Read the feedback: git show colony-feedback:reviews/{{pr.number}}/feedback.md
    2. You should already be on the PR branch, if not: git checkout {{pr.branch}}
    3. Address each piece of feedback
    4. Commit and push your changes
    5. Write a response to the feedback file summarizing what you changed

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
  type: route-to-session
  match:
    gitBranch: "{{pr.branch}}"
    workingDirectory: "{{repo.localPath}}"
  busyStrategy: wait
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
