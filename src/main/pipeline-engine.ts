/**
 * Pipeline Engine — reactive automation for Claude Colony.
 *
 * Pipelines are YAML files in ~/.claude-colony/pipelines/ that define
 * trigger → condition → action patterns. The engine polls on intervals,
 * evaluates conditions, and fires actions (usually launching sessions).
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, statSync } from 'fs'
import { join, basename } from 'path'
import { app, BrowserWindow } from 'electron'
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
  repos?: 'auto' | GitHubRepo[]
  watch?: string[]
}

export interface ConditionDef {
  type: 'branch-file-exists' | 'pr-checks-failed' | 'file-created' | 'always'
  branch?: string
  path?: string
  match?: Record<string, string>
}

export interface ActionDef {
  type: 'launch-session' | 'route-to-session'
  name?: string
  workingDirectory?: string
  color?: string
  prompt: string
  // route-to-session specific:
  match?: {
    gitBranch?: string
    workingDirectory?: string
  }
  busyStrategy?: 'wait' | 'launch-new' // default: 'wait'
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
}

// ---- Constants ----

const COLONY_DIR = join(app.getPath('home'), '.claude-colony')
const PIPELINES_DIR = join(COLONY_DIR, 'pipelines')
const STATE_PATH = join(COLONY_DIR, 'pipeline-state.json')

// ---- Engine ----

const pipelines = new Map<string, { def: PipelineDef; state: PipelineState; fileName: string }>()
const timers = new Map<string, ReturnType<typeof setInterval>>()
let githubUser: string | null = null
let started = false

function log(msg: string): void {
  console.log(`[pipeline] ${msg}`)
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

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
        const colonIdx = trimmed.indexOf(':')
        const key = trimmed.slice(0, colonIdx).trim().replace(/^- /, '')
        let value = trimmed.slice(colonIdx + 1).trim()

        if (!value) {
          // Nested object
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

    // Parse watch array
    if (result.trigger?.watch && typeof result.trigger.watch === 'string') {
      result.trigger.watch = [result.trigger.watch]
    }

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
  return { lastPollAt: null, firedKeys: {}, fireCount: 0, lastFiredAt: null, lastError: null }
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

function isDuplicate(pipelineName: string, key: string, ttlSeconds: number): boolean {
  const p = pipelines.get(pipelineName)
  if (!p) return false
  const lastFired = p.state.firedKeys[key]
  if (!lastFired) return false
  return Date.now() - lastFired < ttlSeconds * 1000
}

function recordFired(pipelineName: string, key: string): void {
  const p = pipelines.get(pipelineName)
  if (!p) return
  p.state.firedKeys[key] = Date.now()
  p.state.fireCount++
  p.state.lastFiredAt = new Date().toISOString()

  // Clean expired dedup keys
  const now = Date.now()
  const ttl = (p.def.dedup.ttl || 3600) * 1000
  for (const [k, ts] of Object.entries(p.state.firedKeys)) {
    if (now - ts > ttl * 2) delete p.state.firedKeys[k]
  }

  saveState()
}

// ---- Send Prompt When Ready (main-process version) ----

async function sendPromptWhenReady(instanceId: string, prompt: string): Promise<void> {
  const client = getDaemonClient()
  return new Promise((resolve) => {
    let sent = false
    let waitCount = 0

    const handler = (_id: string, activity: string) => {
      if (_id !== instanceId || sent) return
      if (activity === 'waiting') {
        waitCount++
        if (waitCount === 1) {
          // Dismiss trust prompt
          writeToInstance(instanceId, '\r')
        } else {
          sent = true
          client.removeListener('activity', handler)
          writeToInstance(instanceId, prompt + '\r')
          resolve()
        }
      }
    }

    client.on('activity', handler)

    setTimeout(() => {
      if (!sent && waitCount >= 1) {
        sent = true
        client.removeListener('activity', handler)
        writeToInstance(instanceId, prompt + '\r')
        resolve()
      }
    }, 5000)

    setTimeout(() => {
      if (!sent) { client.removeListener('activity', handler); resolve() }
    }, 15000)
  })
}

// ---- Send Prompt to Existing Session (no trust prompt handling) ----

async function sendPromptToExistingSession(instanceId: string, prompt: string): Promise<void> {
  const client = getDaemonClient()
  const inst = await client.getInstance(instanceId)

  if (inst?.activity === 'waiting') {
    writeToInstance(instanceId, prompt + '\r')
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
        writeToInstance(instanceId, prompt + '\r')
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
      // Check if repo exists as subdirectory (workspace parent like nri-automation)
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
  //    e.g. session in .../nri-frontend/... should not match repo=nri-server
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
    await gh(['api', `repos/${slug}/contents/${filePath}?ref=${branch}`, '--silent'])
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
    return checks.overall === 'failure'
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

async function fireAction(action: ActionDef, ctx: TriggerContext): Promise<void> {
  const name = resolveTemplate(action.name || 'Pipeline Session', ctx)
  const cwd = resolveTemplate(action.workingDirectory || '', ctx) || undefined
  const prompt = resolveTemplate(action.prompt, ctx)

  // ---- Route to existing session ----
  if (action.type === 'route-to-session') {
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
        writeToInstance(existing.id, prompt + '\r')
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
      const inst = await createInstance({
        name: name,
        workingDirectory: route.project,
        color: action.color,
        args: ['--resume', route.sessionId],
      })
      await sendPromptWhenReady(inst.id, prompt)
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

  const inst = await createInstance({
    name,
    workingDirectory: resolvedCwd,
    color: action.color,
  })

  await sendPromptWhenReady(inst.id, prompt)

  // Notify renderer about pipeline-triggered session
  broadcast('pipeline:fired', { pipeline: name, instanceId: inst.id })
}

// ---- Poll Loop ----

async function runPoll(pipelineName: string): Promise<void> {
  const p = pipelines.get(pipelineName)
  if (!p || !p.def.enabled) return

  p.state.lastPollAt = new Date().toISOString()

  try {
    let contexts: TriggerContext[] = []

    if (p.def.trigger.type === 'git-poll') {
      contexts = await executeGitPollTrigger(p.def.trigger)
    }
    // file-poll and cron can be added later

    for (const ctx of contexts) {
      const matched = await evaluateCondition(p.def.condition, ctx)
      if (!matched) continue

      const dedupKey = resolveTemplate(p.def.dedup.key, ctx)
      if (isDuplicate(pipelineName, dedupKey, p.def.dedup.ttl || 3600)) continue

      await fireAction(p.def.action, ctx)
      recordFired(pipelineName, dedupKey)
    }

    p.state.lastError = null
  } catch (err) {
    p.state.lastError = String(err)
    log(`Poll error for ${pipelineName}: ${err}`)
  }

  saveState()
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
    const intervalMs = (p.def.trigger.interval || 300) * 1000
    log(`Starting poll for ${name} every ${intervalMs / 1000}s`)

    // Run first poll after a short delay (let app fully initialize)
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
    const intervalMs = (p.def.trigger.interval || 300) * 1000
    runPoll(name)
    timers.set(name, setInterval(() => runPoll(name), intervalMs))
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
        const intervalMs = (p.def.trigger.interval || 300) * 1000
        timers.set(name, setInterval(() => runPoll(name), intervalMs))
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

  const readmeFile = join(PIPELINES_DIR, 'colony-feedback-README.md')
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
    log('Seeded pipeline README: colony-feedback-README.md')
  }
}
