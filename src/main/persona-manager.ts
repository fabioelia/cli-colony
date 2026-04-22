/**
 * Persona Manager — loads, validates, watches, and launches persona sessions.
 * Personas are .md files in ~/.claude-colony/personas/ with YAML frontmatter
 * and self-managed sections (Active Situations, Learnings, Session Log).
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, watch, promises as fsp } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { basename, join } from 'path'
import { resolveCommand } from './resolve-command'

const execFileAsync = promisify(execFile)
import { getPendingTriggers } from './persona-triggers'
import { colonyPaths } from '../shared/colony-paths'
import { createInstance, getAllInstances, killInstance, wasBudgetStopped, setCostCapResolver, setAttentionCountGetter } from './instance-manager'
import { getDaemonRouter } from './daemon-router'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { waitForStableIdle } from './session-completion'
import { broadcast } from './broadcast'
import { notify } from './notifications'
import { slugify, parseFrontmatter as parseRawFrontmatter, stripAnsi } from '../shared/utils'
import type { PersonaInfo, HandoffMetadata } from '../shared/types'
import { JsonFile } from '../shared/json-file'
import { appendActivity } from './activity-manager'
import { appendRunEntry, checkDailyCostBudget, getPersonaDailyCost, getRunHistory } from './persona-run-history'
import { getSettingSync } from './settings'
import { getRateLimitState } from './rate-limit-state'
import { migrateFromMarkdown, readPersonaMemory, extractMemoryInBackground, trackMonthlyCost } from './persona-memory'
import { buildPlanningPrompt, buildKickoff } from './persona-prompt-builder'
import { getAttentionCount, getAttentionRequests, pruneOldAttention, getAllPendingAttention } from './persona-attention'

const PERSONAS_DIR = colonyPaths.personas
const STATE_PATH = colonyPaths.personaState

/** Returns a safe absolute path for a persona file, rejecting any path traversal. */
function resolvedPersonaPath(fileName: string): string {
  const safe = basename(fileName.endsWith('.md') ? fileName : `${fileName}.md`)
  return join(PERSONAS_DIR, safe)
}

// ---- State ----

export interface PersonaState {
  lastRunAt: string | null
  runCount: number
  activeSessionId: string | null
  enabled: boolean
  lastRunOutput: string | null
  sessionStartedAt: string | null
  sessionWorkingDir: string | null
  triggeredBy: string | null
  triggerType: string | null
  lastSkipped: number | null
  retryCount: number
  draining: boolean
  pendingRuns: Array<{ reason: string; queuedAt: string; context?: string; triggerType?: string; triggeredBy?: string; chainDepth?: number; chainId?: string }>
  chainDepth?: number
  chainId?: string
}

const stateFile = new JsonFile<Record<string, PersonaState>>(STATE_PATH, {})
let stateCache: Record<string, PersonaState> = {}

/** Instance IDs that were explicitly stopped by the user (not natural exits). */
const _manuallyStopped = new Set<string>()
/** Instance IDs killed by idle-completion or timeout — not user error. */
const _normalCompletion = new Set<string>()

function ensureDir(): void {
  if (!existsSync(PERSONAS_DIR)) mkdirSync(PERSONAS_DIR, { recursive: true })
}

function loadState(): Record<string, PersonaState> {
  stateCache = stateFile.read()
  return stateCache
}

export function saveState(): void {
  stateFile.write(stateCache)
}

export function getState(name: string): PersonaState {
  if (!stateCache[name]) {
    stateCache[name] = { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: false, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null, triggerType: null, lastSkipped: null, retryCount: 0, draining: false, pendingRuns: [] }
  }
  return stateCache[name]
}

// ---- Frontmatter Parser ----

export interface PersonaFrontmatter {
  name: string
  schedule: string
  model: string
  max_sessions: number
  can_push: boolean
  can_merge: boolean
  can_create_sessions: boolean
  working_directory: string
  color: string
  on_complete_run: string[]
  /** Personas this persona may dynamically invoke via trigger file (does not auto-fire) */
  can_invoke: string[]
  /** Set false to disable automatic memory extraction after each run */
  auto_memory_extraction: boolean
  /**
   * Serialization group for can_push: true personas. Two personas with the same
   * conflict_group will not run simultaneously. Defaults to the persona's own slug.
   * Not used for can_push: false personas.
   */
  conflict_group?: string
  /** Session timeout in minutes for cron-triggered runs (default: 10). */
  session_timeout_minutes?: number
  /**
   * How many seconds the session must be continuously 'waiting' before we
   * conclude the persona is done. Guards against the daemon's 2s PTY-lull
   * false-positive (tool exec / long reasoning pauses). Default 20.
   */
  stable_waiting_seconds?: number
  /** Per-session cost cap in USD. Session auto-stops when exceeded. */
  max_cost_usd?: number
  /** Per-persona daily cost cap in USD — trailing 24h window. Skips launch when exceeded. */
  max_cost_per_day_usd?: number
  /** Monthly budget in USD. Auto-pauses persona when cumulative monthly cost exceeds this. */
  monthly_budget_usd?: number
  /**
   * Optional run condition. Currently supports 'new_commits' — skip run if no
   * commits have been made since the last run in the persona's working_directory.
   */
  run_condition?: string
  /** Auto-retry on non-zero exit: max retry attempts before firing trigger chain. 0 = disabled. */
  retry_on_failure?: number
  /** Condition that must be met for on_complete_run triggers to fire. Options: 'success', 'has_commits', 'has_changes'. Absent = always trigger. */
  on_complete_run_if?: string
  /** If true, persona fires once on app startup (staggered 2s apart from other startup personas). */
  run_on_startup?: boolean
  /** Minimum minutes between automatic runs (cron/trigger/startup). Manual runs bypass this. */
  min_interval_minutes?: number
}

function parseFrontmatter(content: string): PersonaFrontmatter | null {
  const raw = parseRawFrontmatter(content)
  if (Object.keys(raw).length === 0) return null

  // Strip surrounding quotes from values
  const val = (key: string) => (raw[key] || '').replace(/^["']|["']$/g, '')

  const result: PersonaFrontmatter = {
    name: val('name'),
    schedule: val('schedule'),
    model: val('model') || 'sonnet',
    max_sessions: parseInt(val('max_sessions')) || 1,
    can_push: val('can_push') === 'true',
    can_merge: val('can_merge') === 'true',
    can_create_sessions: val('can_create_sessions') === 'true',
    working_directory: val('working_directory'),
    color: val('color') || '#a78bfa',
    on_complete_run: parseStringArray(val('on_complete_run')),
    can_invoke: parseStringArray(val('can_invoke')),
    auto_memory_extraction: val('auto_memory_extraction') !== 'false',
    session_timeout_minutes: parseInt(val('session_timeout_minutes')) || undefined,
    stable_waiting_seconds: parseInt(val('stable_waiting_seconds')) || undefined,
    max_cost_usd: parseFloat(val('max_cost_usd')) || undefined,
    max_cost_per_day_usd: parseFloat(val('max_cost_per_day_usd')) || undefined,
    monthly_budget_usd: parseFloat(val('monthly_budget_usd')) || undefined,
    conflict_group: val('conflict_group') || undefined,
    run_condition: val('run_condition') || undefined,
    retry_on_failure: parseInt(val('retry_on_failure')) || undefined,
    on_complete_run_if: val('on_complete_run_if') || undefined,
    run_on_startup: val('run_on_startup') === 'true',
    min_interval_minutes: parseInt(val('min_interval_minutes')) || undefined,
  }

  if (!result.name) return null
  return result
}

// ---- Section Extractor ----

function extractSection(content: string, heading: string): string {
  const regex = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm')
  const match = content.match(regex)
  return match ? match[1].trim() : ''
}

/** Parse a YAML inline array string like `["a", "b"]` or `[a, b]` into string[]. */
function parseStringArray(val: string): string[] {
  if (!val) return []
  const match = val.match(/^\[(.+)\]$/)
  if (!match) return []
  return match[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
}

// ---- Public API ----

export function loadPersonas(): void {
  ensureDir()
  loadState()

  // Register cost cap resolver so instance-manager can check persona budgets
  setCostCapResolver(getPersonaCostCap)
  // Register attention count getter so instance-manager can include it in dock badge
  setAttentionCountGetter(() => getAllPendingAttention().length)
  const mdFiles = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.md'))
  // Auto-migrate markdown sections to structured .memory.json sidecars
  let migrated = 0
  for (const file of mdFiles) {
    const personaId = file.replace('.md', '')
    if (migrateFromMarkdown(personaId)) migrated++
  }
  if (migrated > 0) console.log(`[persona] migrated ${migrated} persona(s) to structured memory`)
  console.log(`[persona] loaded ${mdFiles.length} persona files`)

  // Sweep orphaned prompt files (crash leftovers, abandoned sends)
  sweepOrphanedPromptFiles()
}

/** Delete prompt files in pipeline-prompts/ older than 1 hour. Handles crash orphans. */
function sweepOrphanedPromptFiles(): void {
  const promptsDir = join(colonyPaths.root, 'pipeline-prompts')
  if (!existsSync(promptsDir)) return
  const oneHourAgo = Date.now() - 60 * 60 * 1000
  let cleaned = 0
  try {
    for (const file of readdirSync(promptsDir)) {
      try {
        const filePath = join(promptsDir, file)
        const stat = statSync(filePath)
        if (stat.mtimeMs < oneHourAgo) {
          unlinkSync(filePath)
          cleaned++
        }
      } catch { /* skip individual file errors */ }
    }
  } catch { /* directory read failed */ }
  if (cleaned > 0) console.log(`[persona] swept ${cleaned} orphaned prompt file(s)`)
}

type HealthStatus = 'green' | 'yellow' | 'red' | 'unknown'

function computePersonaHealth(personaId: string, fm: PersonaFrontmatter | null): import('../shared/types').PersonaHealthScore {
  const last10 = getRunHistory(personaId, 10)
  const totalRuns = last10.length
  if (totalRuns < 3) {
    return { status: 'unknown', successRate: 0, avgCost: 0, avgDuration: 0, consecutiveFailures: 0, totalRuns }
  }
  const successCount = last10.filter(r => r.success).length
  const successRate = Math.round((successCount / totalRuns) * 100)
  const avgCost = Math.round(last10.reduce((s, r) => s + (r.costUsd ?? 0), 0) / totalRuns * 10000) / 10000
  const avgDuration = Math.round(last10.reduce((s, r) => s + r.durationMs, 0) / totalRuns)
  let consecutiveFailures = 0
  for (const run of last10) { if (!run.success) consecutiveFailures++; else break }
  const anyBudgetExceeded = last10.some(r => r.stopReason === 'budget_exceeded')
  const budgetUsd = fm?.max_cost_usd
  const costRatio = budgetUsd && budgetUsd > 0 ? avgCost / budgetUsd : 0
  let status: HealthStatus
  if (successRate < 50 || consecutiveFailures >= 3 || anyBudgetExceeded) {
    status = 'red'
  } else if (successRate < 80 || costRatio >= 0.8) {
    status = 'yellow'
  } else {
    status = 'green'
  }
  return { status, successRate, avgCost, avgDuration, consecutiveFailures, totalRuns }
}

export function getPersonaList(): PersonaInfo[] {
  ensureDir()
  const files = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.md')).sort()
  const pending = getPendingTriggers()
  const personas: PersonaInfo[] = []

  for (const file of files) {
    const filePath = join(PERSONAS_DIR, file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      const fm = parseFrontmatter(content)
      if (!fm) continue

      const state = getState(fm.name)
      const personaId = file.replace('.md', '')

      personas.push({
        id: file.replace('.md', ''),
        name: fm.name,
        schedule: fm.schedule,
        model: fm.model,
        maxSessions: fm.max_sessions,
        canPush: fm.can_push,
        canMerge: fm.can_merge,
        canCreateSessions: fm.can_create_sessions,
        enabled: state.enabled,
        activeSessionId: state.activeSessionId,
        lastRun: state.lastRunAt,
        runCount: state.runCount,
        content,
        filePath,
        lastRunOutput: state.lastRunOutput || null,
        whispers: parseWhispers(content),
        onCompleteRun: fm.on_complete_run,
        onCompleteRunIf: fm.on_complete_run_if,
        canInvoke: fm.can_invoke,
        triggeredBy: state.triggeredBy ?? null,
        pendingTrigger: pending.get(personaId) ? { from: pending.get(personaId)!.from, note: pending.get(personaId)!.note } : null,
        conflictGroup: fm.conflict_group,
        lastSkipped: state.lastSkipped ?? null,
        maxCostUsd: fm.max_cost_usd,
        maxCostPerDayUsd: fm.max_cost_per_day_usd,
        monthlyBudgetUsd: fm.monthly_budget_usd,
        monthlyCostUsd: fm.monthly_budget_usd ? (() => {
          try { return readPersonaMemory(personaId).costTracking?.totalUsd ?? 0 } catch { return 0 }
        })() : undefined,
        retryCount: state.retryCount ?? 0,
        draining: state.draining ?? false,
        healthScore: computePersonaHealth(personaId, fm),
        attentionCount: getAttentionCount(personaId),
        color: fm.color || undefined,
        pendingRunCount: (state.pendingRuns || []).length,
        runOnStartup: fm.run_on_startup || false,
        minIntervalMinutes: fm.min_interval_minutes || 0,
        briefPreview: (() => {
          const bp = join(PERSONAS_DIR, `${personaId}.brief.md`)
          try {
            if (!existsSync(bp)) return null
            const text = readFileSync(bp, 'utf-8')
            for (const line of text.split('\n')) {
              const trimmed = line.trim()
              if (!trimmed) continue
              if (trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('_')) continue
              return trimmed.length > 120 ? trimmed.slice(0, 117) + '...' : trimmed
            }
            return null
          } catch { return null }
        })(),
        workingStatus: (() => {
          const sp = join(PERSONAS_DIR, `${personaId}.status`)
          try {
            if (!existsSync(sp)) return null
            return readFileSync(sp, 'utf-8').split('\n')[0].slice(0, 120) || null
          } catch { return null }
        })(),
      })
    } catch { /* skip invalid files */ }
  }

  return personas
}

export function getPersonaContent(fileName: string): { content: string | null; mtime: number | null } {
  const filePath = resolvedPersonaPath(fileName)
  try {
    if (!existsSync(filePath)) return { content: null, mtime: null }
    const content = readFileSync(filePath, 'utf-8')
    const mtime = statSync(filePath).mtimeMs
    return { content, mtime }
  } catch {
    return { content: null, mtime: null }
  }
}

/** Parse note entries from a ## Notes section (also reads legacy ## Whispers). */
function parseWhispers(content: string): Array<{ createdAt: string; text: string }> {
  // Support both ## Notes (new) and ## Whispers (legacy)
  const section = extractSection(content, 'Notes') || extractSection(content, 'Whispers')
  if (!section) return []
  return section
    .split('\n')
    .filter(l => l.trim().startsWith('- ['))
    .map(line => {
      const m = line.match(/^-\s*\[([^\]]+)\]\s*(.+)/)
      return m ? { createdAt: m[1], text: m[2].trim() } : null
    })
    .filter(Boolean) as Array<{ createdAt: string; text: string }>
}

/** Append a note to the persona's ## Notes section (creates it if absent). */
export function addWhisper(id: string, text: string): boolean {
  const filePath = resolvedPersonaPath(id)
  if (!existsSync(filePath)) return false
  const content = readFileSync(filePath, 'utf-8')
  const entry = `- [${new Date().toISOString()}] ${text.trim()}`
  let updated: string
  if (/\n## Notes\n/.test(content)) {
    updated = content.replace(/(\n## Notes\n)/, `$1${entry}\n`)
  } else if (/\n## Whispers\n/.test(content)) {
    // Migrate legacy section on first new write
    updated = content.replace(/(\n## Whispers\n)/, `$1${entry}\n`)
  } else {
    updated = content.trimEnd() + `\n\n## Notes\n${entry}\n`
  }
  writeFileSync(filePath, updated, 'utf-8')
  broadcastStatus()
  return true
}

/** Delete a note by index from the ## Notes section. */
export function deleteNote(id: string, index: number): boolean {
  const filePath = resolvedPersonaPath(id)
  if (!existsSync(filePath)) return false
  const content = readFileSync(filePath, 'utf-8')
  const noteLines = (extractSection(content, 'Notes') || extractSection(content, 'Whispers') || '')
    .split('\n')
    .filter((l) => l.trim().startsWith('- ['))
  if (index < 0 || index >= noteLines.length) return false
  const lineToRemove = noteLines[index]
  // Remove only the first matching line (avoids deleting duplicate notes with identical text)
  let removed = false
  const updated = content.split('\n').filter((l) => {
    if (!removed && l === lineToRemove) { removed = true; return false }
    return true
  }).join('\n')
  writeFileSync(filePath, updated, 'utf-8')
  broadcastStatus()
  return true
}

/** Update a note by index in the ## Notes section, preserving its timestamp. */
export function updateNote(id: string, index: number, newText: string): boolean {
  if (!newText.trim()) return false
  const filePath = resolvedPersonaPath(id)
  if (!existsSync(filePath)) return false
  const content = readFileSync(filePath, 'utf-8')
  const noteLines = (extractSection(content, 'Notes') || extractSection(content, 'Whispers') || '')
    .split('\n')
    .filter((l) => l.trim().startsWith('- ['))
  if (index < 0 || index >= noteLines.length) return false
  const oldLine = noteLines[index]
  const timestampMatch = oldLine.match(/^(-\s*\[[^\]]+\])\s*/)
  if (!timestampMatch) return false
  const newLine = `${timestampMatch[1]} ${newText.trim()}`
  let replaced = false
  const updated = content.split('\n').map((l) => {
    if (!replaced && l === oldLine) { replaced = true; return newLine }
    return l
  }).join('\n')
  writeFileSync(filePath, updated, 'utf-8')
  broadcastStatus()
  return true
}

/** Surgically update the schedule field in a persona frontmatter without touching the rest. */
export function setPersonaSchedule(fileName: string, schedule: string): boolean {
  const { content } = getPersonaContent(fileName)
  if (!content) return false
  const updated = content.replace(/^(schedule:\s*).*$/m, `$1"${schedule}"`)
  return savePersonaContent(fileName, updated)
}

export function savePersonaContent(fileName: string, content: string): boolean {
  ensureDir()
  const filePath = resolvedPersonaPath(fileName)
  try {
    writeFileSync(filePath, content, 'utf-8')
    broadcastStatus()
    return true
  } catch {
    return false
  }
}

export function createPersona(name: string): { fileName: string } | null {
  ensureDir()
  const slug = slugify(name)
  if (!slug) return null
  const fileName = `${slug}.md`
  const filePath = join(PERSONAS_DIR, fileName)
  if (existsSync(filePath)) return null

  const template = `---
name: "${name}"
schedule: ""
model: sonnet
max_sessions: 1
can_push: false
can_merge: false
can_create_sessions: true
working_directory: ""
color: "#a78bfa"
---

## Role

(Define this persona's identity, expertise, and behavioral style)

## Objectives

- (What should this persona try to accomplish each session?)

## Active Situations

(No active situations yet — updated by the persona during sessions)

## Learnings

(No learnings yet — the persona will add observations here over time)

## Session Log

(No sessions yet)
`
  writeFileSync(filePath, template, 'utf-8')
  broadcastStatus()
  return { fileName }
}

export function duplicatePersona(sourceId: string): string | null {
  ensureDir()
  const source = getPersonaList().find(p => p.id === sourceId)
  if (!source) return null
  const sourceContent = readFileSync(source.filePath, 'utf-8')

  const newName = `${source.name} (copy)`
  let slug = slugify(newName)
  if (!slug) return null

  // Collision avoidance
  let candidate = slug
  let suffix = 2
  while (existsSync(join(PERSONAS_DIR, `${candidate}.md`))) {
    candidate = `${slug}-${suffix++}`
  }
  slug = candidate

  const newContent = sourceContent
    .replace(/^(name:\s*["']?).*?(["']?\s*)$/m, `$1${newName}$2`)
    .replace(/^enabled:\s*true/m, 'enabled: false')
    .replace(/^schedule:\s*.+/m, 'schedule: ""')

  writeFileSync(join(PERSONAS_DIR, `${slug}.md`), newContent, 'utf-8')
  broadcastStatus()
  return slug
}

export function deletePersona(fileName: string): boolean {
  const filePath = resolvedPersonaPath(fileName)
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
      broadcastStatus()
      return true
    }
    return false
  } catch {
    return false
  }
}

export function togglePersona(fileName: string, enabled: boolean): boolean {
  const filePath = resolvedPersonaPath(fileName)
  if (!existsSync(filePath)) return false
  const content = readFileSync(filePath, 'utf-8')
  const fm = parseFrontmatter(content)
  if (!fm) return false
  const state = getState(fm.name)
  state.enabled = enabled
  saveState()
  broadcastStatus()
  return true
}

export function drainPersona(fileName: string): boolean {
  const filePath = resolvedPersonaPath(fileName)
  if (!existsSync(filePath)) return false
  const content = readFileSync(filePath, 'utf-8')
  const fm = parseFrontmatter(content)
  if (!fm) return false
  const state = getState(fm.name)
  if (state.activeSessionId) {
    state.draining = true
  } else {
    state.enabled = false
  }
  saveState()
  broadcastStatus()
  return true
}

// ---- Planning Loop Prompt (delegated to persona-prompt-builder.ts) ----

// ---- Send trigger when CLI is ready ----

function sendTriggerWhenReady(
  instanceId: string,
  message: string,
  timeoutMinutes?: number,
  onStateCommit?: () => void,
  stableWaitingSeconds?: number,
): void {
  // Use the shared sendPromptWhenReady, then watch for persona completion
  sendPromptWhenReady(instanceId, {
    prompt: message,
    onSent: () => {
      console.log(`[persona] sent trigger to ${instanceId}`)
      if (onStateCommit) onStateCommit()

      // Guard against daemon PTY-diff false-positives: require a continuous
      // `waiting` window before we conclude the persona is done. The daemon
      // flips to 'waiting' after ~2s of no PTY growth, which happens during
      // tool execution and long reasoning pauses — not real completion.
      const stableMs = (stableWaitingSeconds ?? 20) * 1000
      const absoluteMs = timeoutMinutes != null ? timeoutMinutes * 60_000 : undefined
      const { promise } = waitForStableIdle(instanceId, { stableMs, absoluteMs })
      promise.then((outcome) => {
        if (outcome === 'stable') {
          console.log(`[persona] session ${instanceId} idle ${stableMs}ms, killing in 5s`)
          setTimeout(async () => {
            _normalCompletion.add(instanceId)
            try { await killInstance(instanceId) } catch { /* already gone */ }
          }, 5000)
        } else {
          console.log(`[persona] session ${instanceId} still running after ${timeoutMinutes}min, force-killing`)
          ;(async () => {
            _normalCompletion.add(instanceId)
            try { await killInstance(instanceId) } catch { /* already gone */ }
          })()
        }
      })
    },
  })
}

// ---- Run / Stop ----

export type TriggerSource =
  | { type: 'manual' }
  | { type: 'cron'; schedule: string }
  | { type: 'handoff'; from: string; chainId?: string }
  | { type: 'retry' }
  | { type: 'startup' }

export interface PersonaRunOverrides {
  model?: string
  maxCostUsd?: number
  promptPrefix?: string
  chainDepth?: number
  chainId?: string
}

/** Per-instance cost cap overrides — used for "Run with Options" one-shot budget. */
const _sessionCostOverrides = new Map<string, number>()

export async function runPersona(fileName: string, trigger: TriggerSource = { type: 'manual' }, customMessage?: string, parentId?: string, overrides?: PersonaRunOverrides): Promise<string> {
  const filePath = resolvedPersonaPath(fileName)
  if (!existsSync(filePath)) throw new Error(`Persona file not found: ${fileName}`)

  const content = readFileSync(filePath, 'utf-8')
  const fm = parseFrontmatter(content)
  if (!fm) throw new Error(`Invalid persona file: ${fileName}`)

  const state = getState(fm.name)

  // Track trigger chain depth and coordination artifact ID — reset for non-handoff sources
  if (trigger.type === 'handoff') {
    state.chainDepth = overrides?.chainDepth ?? 0
    if (overrides?.chainId) {
      state.chainId = overrides.chainId
    } else {
      state.chainId = `chain-${Date.now()}-${trigger.from.replace(/[^a-z0-9-]/gi, '-')}`
    }
    const coordDir = colonyPaths.coordination
    mkdirSync(coordDir, { recursive: true })
    const coordPath = join(coordDir, `${state.chainId}.md`)
    if (!existsSync(coordPath)) {
      writeFileSync(coordPath, `# Coordination Artifact\n_Chain: ${trigger.from} → ${fm.name} | Started: ${new Date().toISOString()}_\n\n---\n\n`)
    }
  } else {
    state.chainDepth = 0
  }

  // Reset retry count on any non-retry start (manual, cron, handoff)
  if (trigger.type !== 'retry') {
    state.retryCount = 0
  }

  // Check self-duplicate (max_sessions: 1 enforcement — applies to all personas)
  if (state.activeSessionId) {
    const instances = await getAllInstances()
    const existing = instances.find(i => i.id === state.activeSessionId && i.status === 'running')
    if (existing) {
      throw new Error(`Persona "${fm.name}" already has a running session`)
    }
    // Session died — clear it
    state.activeSessionId = null
  }

  // For can_push: true personas, serialize within the conflict_group.
  // can_push: false personas (QA, Product, Research) skip this check entirely —
  // they are read-only and never conflict with write sessions.
  if (fm.can_push) {
    const group = fm.conflict_group || slugify(fm.name)
    const allPersonas = getPersonaList()
    const conflicting = allPersonas.find(p =>
      p.name !== fm.name &&
      p.activeSessionId !== null &&
      p.canPush &&
      (p.conflictGroup || slugify(p.name)) === group
    )
    if (conflicting) {
      throw new Error(
        `Persona "${fm.name}" blocked — "${conflicting.name}" is already running in conflict group "${group}"`
      )
    }
  }

  // Check run_condition: skip if no new commits since last run
  if (fm.run_condition === 'new_commits' && state.lastRunAt) {
    let cwd = fm.working_directory || colonyPaths.root
    if (cwd.startsWith('~')) cwd = cwd.replace('~', process.env.HOME || '/')
    try {
      const { stdout } = await execFileAsync(
        'git', ['log', '--oneline', '-1', `--after=${state.lastRunAt}`],
        { encoding: 'utf-8', timeout: 5000, cwd }
      )
      if (!stdout.trim()) {
        console.log(`[persona] Skipping "${fm.name}" — no new commits since ${state.lastRunAt}`)
        state.lastSkipped = Date.now()
        saveState()
        broadcastStatus()
        throw new Error(`Skipped — no new commits since last run`)
      }
    } catch (err) {
      // Re-throw skip errors; for git failures (not a repo, etc.) fall through and run normally
      if (String(err).includes('Skipped —')) throw err
      console.log(`[persona] run_condition git check failed for "${fm.name}", running anyway: ${err}`)
    }
  }

  // Check min_interval cooldown — skip automatic runs that fire too soon after the last run
  if (fm.min_interval_minutes && fm.min_interval_minutes > 0 && trigger.type !== 'manual') {
    const elapsed = state.lastRunAt ? (Date.now() - new Date(state.lastRunAt).getTime()) / 60000 : Infinity
    if (elapsed < fm.min_interval_minutes) {
      const remaining = Math.ceil(fm.min_interval_minutes - elapsed)
      console.log(`[persona] Skipping "${fm.name}" — cooldown ${fm.min_interval_minutes}m (last run ${elapsed.toFixed(1)}m ago, ${remaining}m remaining)`)
      state.lastSkipped = Date.now()
      saveState()
      broadcastStatus()
      throw new Error(`Skipped — cooldown (${remaining}m remaining)`)
    }
  }

  // Check per-persona daily cost cap (trailing 24h window, independent of global budget)
  if (fm.max_cost_per_day_usd && fm.max_cost_per_day_usd > 0) {
    const personaSlug = basename(filePath, '.md')
    const dailyCost = getPersonaDailyCost(personaSlug)
    if (dailyCost >= fm.max_cost_per_day_usd) {
      console.log(`[persona] Skipping "${fm.name}" — daily cap $${fm.max_cost_per_day_usd} reached (spent $${dailyCost.toFixed(4)} in last 24h)`)
      state.lastSkipped = Date.now()
      saveState()
      broadcastStatus()
      appendActivity({
        source: 'persona',
        name: fm.name,
        summary: `Daily cap reached — $${dailyCost.toFixed(2)} of $${fm.max_cost_per_day_usd.toFixed(2)} used in last 24h`,
        level: 'warn',
      })
      // One-time desktop notification per day, deduped by flag file; suppressed during rate limit pause
      if (!getRateLimitState().paused) {
        const today = new Date().toISOString().slice(0, 10)
        const flagPath = join(colonyPaths.root, `.daily-cap-alert-${personaSlug}`)
        let alreadyNotified = false
        try { alreadyNotified = readFileSync(flagPath, 'utf-8').trim() === today } catch { /* first alert */ }
        if (!alreadyNotified) {
          try { writeFileSync(flagPath, today, 'utf-8') } catch { /* non-fatal */ }
          notify(
            `Colony: ${fm.name} Daily Cap Reached`,
            `Spent $${dailyCost.toFixed(2)} of $${fm.max_cost_per_day_usd.toFixed(2)} in the last 24h. No more runs until the cap resets.`,
            'personas',
          ).catch(() => { /* non-fatal */ })
        }
      }
      throw new Error(`Skipped — daily cost cap of $${fm.max_cost_per_day_usd} reached`)
    }
  }

  // Build planning prompt and write to temp file
  const whispers = parseWhispers(content)
  const prompt = await buildPlanningPrompt(fm, state, filePath, whispers)
  const promptsDir = join(colonyPaths.root, 'pipeline-prompts')
  if (!existsSync(promptsDir)) mkdirSync(promptsDir, { recursive: true })
  const promptId = `persona-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const promptFile = join(promptsDir, `${promptId}.md`)
  writeFileSync(promptFile, prompt, 'utf-8')

  // Resolve working directory
  let cwd = fm.working_directory || colonyPaths.root
  if (cwd.startsWith('~')) cwd = cwd.replace('~', process.env.HOME || '/')

  // Rotate briefs: .brief.4.md→.brief.5.md, ... .brief.md→.brief.1.md
  const personaSlug2 = basename(filePath, '.md')
  const briefPath2 = join(PERSONAS_DIR, `${personaSlug2}.brief.md`)
  if (existsSync(briefPath2)) {
    try {
      for (let i = 4; i >= 1; i--) {
        const src = join(PERSONAS_DIR, `${personaSlug2}.brief.${i}.md`)
        const dst = join(PERSONAS_DIR, `${personaSlug2}.brief.${i + 1}.md`)
        if (existsSync(src)) { try { copyFileSync(src, dst) } catch { /* non-fatal */ } }
      }
      copyFileSync(briefPath2, join(PERSONAS_DIR, `${personaSlug2}.brief.1.md`))
    } catch { /* non-fatal */ }
  }

  // Launch interactive session with system prompt, then send trigger when ready
  const inst = await createInstance({
    name: `Persona: ${fm.name}`,
    workingDirectory: cwd,
    color: fm.color,
    model: overrides?.model || fm.model,
    args: ['--append-system-prompt-file', promptFile],
    parentId,
    triggeredBy: trigger.type === 'handoff' ? (trigger.from ?? undefined) : undefined,
  })

  if (overrides?.maxCostUsd != null) {
    _sessionCostOverrides.set(inst.id, overrides.maxCostUsd)
  }

  const rawKickoff = buildKickoff(filePath, trigger, customMessage)
  const kickoff = overrides?.promptPrefix ? `${overrides.promptPrefix.trim()}\n\n${rawKickoff}` : rawKickoff
  // Only apply auto-close timeout for non-manual triggers
  const timeoutMinutes = trigger.type !== 'manual' ? (fm.session_timeout_minutes || 10) : undefined
  sendTriggerWhenReady(inst.id, kickoff, timeoutMinutes, () => {
    // Defer state mutations until prompt is confirmed delivered.
    // If sendPromptWhenReady abandons (timeout, daemon down), state stays clean.
    state.activeSessionId = inst.id
    state.lastRunAt = new Date().toISOString()
    state.sessionStartedAt = state.lastRunAt
    state.sessionWorkingDir = cwd
    state.triggerType = trigger.type
    state.triggeredBy = trigger.type === 'handoff' ? (trigger.from ?? null) : null
    state.runCount++
    saveState()

    // Clean up prompt file now that the CLI has read it and session is running
    try { unlinkSync(promptFile) } catch { /* already gone */ }

    broadcast('persona:run', { persona: fm.name, instanceId: inst.id })
    broadcastStatus()
    notify(`Colony: Persona started`, `${fm.name} run #${state.runCount} started`, 'personas')
  }, fm.stable_waiting_seconds)

  console.log(`[persona] launched "${fm.name}" as session ${inst.id}`)
  return inst.id
}

export async function stopPersona(fileName: string): Promise<boolean> {
  const filePath = resolvedPersonaPath(fileName)
  if (!existsSync(filePath)) return false

  const content = readFileSync(filePath, 'utf-8')
  const fm = parseFrontmatter(content)
  if (!fm) return false

  const state = getState(fm.name)
  if (state.activeSessionId) {
    _manuallyStopped.add(state.activeSessionId)
    try {
      await killInstance(state.activeSessionId)
    } catch { /* session may already be gone */ }
    state.activeSessionId = null
    saveState()
    broadcastStatus()
    return true
  }
  return false
}

export function getPersonasDir(): string {
  ensureDir()
  return PERSONAS_DIR
}

/** Reverse-lookup: given an instance ID, return the persona's max_cost_usd if any. */
export function getPersonaCostCap(instanceId: string): number | undefined {
  if (_sessionCostOverrides.has(instanceId)) return _sessionCostOverrides.get(instanceId)!
  for (const [name, state] of Object.entries(stateCache)) {
    if (state.activeSessionId === instanceId) {
      // Find the persona file to read frontmatter
      const files = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.md'))
      for (const file of files) {
        try {
          const content = readFileSync(join(PERSONAS_DIR, file), 'utf-8')
          const fm = parseFrontmatter(content)
          if (fm?.name === name) return fm.max_cost_usd
        } catch { /* skip */ }
      }
      return undefined
    }
  }
  return undefined
}

/** Fire enabled personas with run_on_startup: true, staggered 2s apart. */
export async function runStartupPersonas(): Promise<void> {
  // Clean up coordination files older than 7 days
  const coordDir = colonyPaths.coordination
  if (existsSync(coordDir)) {
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
    for (const f of readdirSync(coordDir)) {
      const fp = join(coordDir, f)
      try { if (statSync(fp).mtimeMs < cutoff) unlinkSync(fp) } catch { /* non-fatal */ }
    }
  }

  const personas = getPersonaList()
  let delay = 0
  for (const p of personas) {
    if (!p.runOnStartup || !p.enabled) continue
    const d = delay
    setTimeout(() => {
      runPersona(p.id, { type: 'startup' }).catch(err => {
        console.log(`[persona] startup run failed for "${p.name}": ${err.message}`)
      })
    }, d)
    delay += 2000
  }
}

/** Surgically update one or more frontmatter fields without touching section content. */
export function updatePersonaMeta(fileName: string, updates: Record<string, string | boolean | number | string[]>): boolean {
  const { content } = getPersonaContent(fileName)
  if (!content) return false
  let updated = content
  for (const [key, value] of Object.entries(updates)) {
    let strValue: string
    if (Array.isArray(value)) {
      strValue = JSON.stringify(value)
    } else if (typeof value === 'string') {
      strValue = `"${value}"`
    } else {
      strValue = String(value)
    }
    const regex = new RegExp(`^(${key}:\\s*).*$`, 'm')
    if (regex.test(updated)) {
      updated = updated.replace(regex, `$1${strValue}`)
    } else {
      // Append field inside frontmatter block before closing ---
      updated = updated.replace(/^(---\n[\s\S]*?)\n---/, (_m, body) => `${body}\n${key}: ${strValue}\n---`)
    }
  }
  return savePersonaContent(fileName, updated)
}

/** List output artifacts for a persona (brief + outputs/<id>/ files), newest first. */
export function getPersonaArtifacts(personaId: string): import('../shared/types').PersonaArtifact[] {
  const safeId = basename(personaId)
  const outputsDir = join(colonyPaths.root, 'outputs', safeId)
  const artifacts: import('../shared/types').PersonaArtifact[] = []

  // Brief first, then prev brief (prefer .brief.1.md, fall back to .brief.prev.md legacy)
  const briefPath = join(PERSONAS_DIR, `${safeId}.brief.md`)
  if (existsSync(briefPath)) {
    try {
      const s = statSync(briefPath)
      artifacts.push({ name: `${safeId}.brief.md`, sizeBytes: s.size, modifiedAt: s.mtimeMs, isBrief: true })
    } catch { /* skip */ }
  }
  const prevBriefCandidates = [
    join(PERSONAS_DIR, `${safeId}.brief.1.md`),
    join(PERSONAS_DIR, `${safeId}.brief.prev.md`),
  ]
  for (const prevBriefPath2 of prevBriefCandidates) {
    if (existsSync(prevBriefPath2)) {
      try {
        const s = statSync(prevBriefPath2)
        artifacts.push({ name: basename(prevBriefPath2), sizeBytes: s.size, modifiedAt: s.mtimeMs, isBrief: false, isPrevBrief: true })
      } catch { /* skip */ }
      break
    }
  }

  // Output files
  if (existsSync(outputsDir)) {
    try {
      const files = readdirSync(outputsDir)
      for (const file of files) {
        try {
          const s = statSync(join(outputsDir, file))
          if (s.isFile()) {
            artifacts.push({ name: file, sizeBytes: s.size, modifiedAt: s.mtimeMs, isBrief: false })
          }
        } catch { /* skip */ }
      }
    } catch { /* dir unreadable */ }
  }

  // Sort outputs newest first (brief always leads)
  const brief = artifacts.filter(a => a.isBrief)
  const others = artifacts.filter(a => !a.isBrief).sort((a, b) => b.modifiedAt - a.modifiedAt)
  return [...brief, ...others]
}

/** Read content of a persona artifact (brief or output file). Cap at 50KB. */
export function readPersonaArtifact(personaId: string, filename: string): string | null {
  const safeId = basename(personaId)
  const safeFile = basename(filename)
  let filePath: string
  if (safeFile === `${safeId}.brief.md` || safeFile === `${safeId}.brief.prev.md` || /^.+\.brief\.\d+\.md$/.test(safeFile)) {
    filePath = join(PERSONAS_DIR, safeFile)
  } else {
    filePath = join(colonyPaths.root, 'outputs', safeId, safeFile)
  }
  if (!existsSync(filePath)) return null
  const content = readFileSync(filePath, 'utf-8')
  const MAX = 50 * 1024
  return content.length > MAX ? content.slice(0, MAX) + '\n\n[truncated]' : content
}

/** Generate a unified diff between the previous brief and the current brief. Returns null if no prev brief exists. */
export async function getPersonaBriefDiff(personaId: string): Promise<string | null> {
  const safeId = basename(personaId)
  const currentPath = join(PERSONAS_DIR, `${safeId}.brief.md`)
  // Prefer .brief.1.md (new rotation), fall back to .brief.prev.md (legacy)
  let prevPath = join(PERSONAS_DIR, `${safeId}.brief.1.md`)
  if (!existsSync(prevPath)) prevPath = join(PERSONAS_DIR, `${safeId}.brief.prev.md`)
  if (!existsSync(prevPath) || !existsSync(currentPath)) return null
  try {
    // diff -u returns exit code 1 when files differ (normal), 0 when identical, 2 on error
    const { stdout } = await execFileAsync('diff', ['-u', prevPath, currentPath], { encoding: 'utf-8', timeout: 5000 }).catch(err => {
      if (err.code === 1) return { stdout: err.stdout as string }
      throw err
    })
    return stdout || null
  } catch { return null }
}

/** List brief history entries (indices 1–5) for a persona, newest first. */
export function getPersonaBriefHistory(personaId: string): Array<{ index: number; timestamp: string; preview: string }> {
  const safeId = basename(personaId)
  const entries: Array<{ index: number; timestamp: string; preview: string }> = []
  for (let i = 1; i <= 5; i++) {
    const p = join(PERSONAS_DIR, `${safeId}.brief.${i}.md`)
    if (!existsSync(p)) continue
    try {
      const s = statSync(p)
      const content = readFileSync(p, 'utf-8')
      entries.push({ index: i, timestamp: s.mtime.toISOString(), preview: content.slice(0, 100) })
    } catch { /* skip */ }
  }
  return entries
}

/** Read a specific historical brief (index 1–5). Returns null if not found. */
export function getPersonaBriefAt(personaId: string, index: number): string | null {
  const safeId = basename(personaId)
  const p = join(PERSONAS_DIR, `${safeId}.brief.${index}.md`)
  if (!existsSync(p)) return null
  try { return readFileSync(p, 'utf-8') } catch { return null }
}

/** Query persona activity data via claude -p haiku. */
export async function askPersonas(query: string): Promise<string> {
  ensureDir()
  const files = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.md') && !f.includes('.brief'))
  const MAX_TOTAL = 8000
  let totalChars = 0
  const contextParts: string[] = []

  for (const file of files) {
    const id = file.replace(/\.md$/, '')
    const filePath = join(PERSONAS_DIR, file)
    let content = ''
    try { content = readFileSync(filePath, 'utf-8') } catch { continue }

    // Extract session log lines
    const logMatch = content.match(/## Session Log\n([\s\S]*?)(?=\n## [^#]|$)/)
    const logLines = logMatch
      ? logMatch[1].split('\n').filter(l => l.trim().startsWith('- [')).slice(-20).join('\n')
      : ''

    // Read brief (first 2KB)
    let briefText = ''
    const briefPath = join(PERSONAS_DIR, `${id}.brief.md`)
    if (existsSync(briefPath)) {
      try { briefText = readFileSync(briefPath, 'utf-8').slice(0, 2048) } catch { /* skip */ }
    }

    const nameMatch = content.match(/^name:\s*"?([^"\n]+)"?/m)
    const displayName = nameMatch ? nameMatch[1].trim() : id
    const block = `=== Persona: ${displayName} ===\n${logLines}${briefText ? `\nBrief:\n${briefText}` : ''}`

    if (totalChars + block.length > MAX_TOTAL) break
    contextParts.push(block)
    totalChars += block.length
  }

  const context = contextParts.join('\n\n')
  const contextPrompt = `Given the following Colony persona activity data, answer this question concisely: ${query}\n\n${context}`

  try {
    const { stdout } = await execFileAsync(
      'claude',
      ['-p', contextPrompt, '--model', 'claude-haiku-4-5-20251001', '--permission-mode', 'bypassPermissions'],
      { timeout: 30000 }
    )
    return stdout.trim() || 'No response.'
  } catch (err: any) {
    if (err.killed || (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      return 'Request timed out — try a more specific question'
    }
    return `Error: ${err.message ?? 'Unknown error'}`
  }
}

// ---- Session Exit Tracking ----

function extractErrorSummary(output: string): string | null {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
    const l = lines[i].toLowerCase()
    if (l.includes('error') || l.includes('exception') || l.includes('traceback') || l.includes('failed') || l.includes('fatal') || l.includes('panic')) {
      return lines[i].slice(0, 120)
    }
  }
  return null
}

function extractOutputTail(output: string): string | null {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
  return lines.length > 0 ? lines[lines.length - 1].slice(0, 80) : null
}

function buildTriggerContext(triggeredBy: string, personaId: string, exitCode: number | null, durationSec: number | null, commitsCount: number, filesChanged: number, sessionCost: number, errorSummary: string | null, chainId?: string, chainDepth = 0): { text: string; metadata: HandoffMetadata } {
  const outcome: HandoffMetadata['outcome'] = exitCode === 0 ? 'success' : errorSummary ? 'failed' : 'success'
  const briefPath = join(PERSONAS_DIR, `${personaId}.brief.md`)
  const metadata: HandoffMetadata = {
    triggeredBy,
    outcome,
    exitCode,
    durationSec,
    commitsCount,
    filesChanged,
    costUsd: sessionCost,
    errorSummary,
    briefPath: existsSync(briefPath) ? briefPath : null,
    chainId,
    chainDepth,
  }
  const lines: string[] = [`Upstream: "${triggeredBy}" — ${exitCode === 0 ? 'success' : `failed (exit ${exitCode})`}`]
  if (durationSec !== null) lines.push(`Duration: ${Math.round(durationSec)}s`)
  if (commitsCount > 0) lines.push(`Commits: ${commitsCount}`)
  if (filesChanged > 0) lines.push(`Files changed: ${filesChanged}`)
  if (sessionCost > 0.001) lines.push(`Cost: $${sessionCost.toFixed(4)}`)
  if (errorSummary) lines.push(`Error: ${errorSummary.slice(0, 200)}`)
  if (metadata.briefPath) lines.push(`Brief: ${metadata.briefPath}`)
  return { text: lines.join('\n'), metadata }
}

export async function readHandoffMetadata(handoffId: string): Promise<HandoffMetadata | null> {
  const handoffPath = join(colonyPaths.root, 'handoffs', `${handoffId}.md`)
  try {
    const content = await fsp.readFile(handoffPath, 'utf-8')
    if (!content.startsWith('---json\n')) return null
    const end = content.indexOf('\n---\n', 8)
    if (end < 0) return null
    return JSON.parse(content.slice(8, end)) as HandoffMetadata
  } catch {
    return null
  }
}

/** Called by instance-manager when any session exits — captures output and clears active session */
export async function onSessionExit(instanceId: string): Promise<void> {
  let changed = false
  const triggerPersonas: Array<{ id: string; triggeredBy: string; customMessage?: string; metadata?: HandoffMetadata; chainDepth: number; chainId?: string }> = []
  const drainingExited: string[] = []

  for (const [name, state] of Object.entries(stateCache)) {
    if (state.activeSessionId === instanceId) {
      // Capture the session's output buffer before clearing
      let sessionCost = 0
      let exitCode: number | null = null
      try {
        const buffer = await getDaemonRouter().getInstanceBuffer(instanceId)
        if (buffer) {
          // Strip ANSI codes and keep last ~5000 chars
          const clean = stripAnsi(buffer)
          state.lastRunOutput = clean.length > 5000 ? clean.slice(-5000) : clean
        }
      } catch { /* buffer may be gone */ }
      try {
        const instances = await getAllInstances()
        const inst = instances.find(i => i.id === instanceId)
        sessionCost = inst?.tokenUsage?.cost ?? 0
        exitCode = inst?.exitCode ?? null
      } catch { /* non-fatal */ }

      const manuallyStopped = _manuallyStopped.has(instanceId)
      _manuallyStopped.delete(instanceId)
      const normalCompletion = _normalCompletion.has(instanceId)
      _normalCompletion.delete(instanceId)

      // Compute session outcome stats
      const startedAt = state.sessionStartedAt
      const workingDir = state.sessionWorkingDir
      const durationSec = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : null

      let commitsCount = 0
      let filesChanged = 0
      if (workingDir && startedAt && existsSync(workingDir)) {
        try {
          const { stdout: logOut } = await execFileAsync(resolveCommand('git'), ['log', '--oneline', `--after=${startedAt}`], { encoding: 'utf-8', timeout: 5000, cwd: workingDir })
          commitsCount = logOut.trim() ? logOut.trim().split('\n').length : 0
        } catch { /* not a git repo or no commits */ }
        if (commitsCount > 0) {
          try {
            const { stdout: filesOut } = await execFileAsync(resolveCommand('git'), ['log', '--name-only', '--format=', `--after=${startedAt}`], { encoding: 'utf-8', timeout: 5000, cwd: workingDir })
            filesChanged = filesOut.trim() ? new Set(filesOut.trim().split('\n').filter(l => l.trim())).size : 0
          } catch { /* non-fatal */ }
        }
      }

      const commitLabel = commitsCount > 0 ? ` · ${commitsCount} commit${commitsCount !== 1 ? 's' : ''}` : ''
      const failed = !manuallyStopped && !normalCompletion && exitCode !== null && exitCode !== 0
      const exitLabel = manuallyStopped ? 'stopped' : normalCompletion ? 'completed' : failed ? `failed (exit ${exitCode})` : 'completed'
      const errorSummary = failed && state.lastRunOutput ? extractErrorSummary(state.lastRunOutput) : null
      const outputTail = !failed && !manuallyStopped && state.lastRunOutput ? extractOutputTail(state.lastRunOutput) : null
      const contextSuffix = errorSummary ? ` — ${errorSummary}` : outputTail ? ` — ${outputTail}` : ''
      state.activeSessionId = null
      state.triggeredBy = null
      _sessionCostOverrides.delete(instanceId)
      changed = true
      console.log(`[persona] session exited for "${name}" (${exitLabel})`)
      appendActivity({
        source: 'persona',
        name,
        summary: `Persona "${name}" ${exitLabel} session${commitLabel}${contextSuffix}`,
        level: failed ? 'warn' : 'info',
        sessionId: instanceId,
        project: workingDir ? basename(workingDir) : undefined,
        details: { type: 'session-outcome', duration: durationSec, commitsCount, filesChanged, exitCode, costUsd: sessionCost },
      })
      const notifyTitle = failed ? `Colony: ${name} run failed` : `Colony: ${name} run complete`
      const notifyBody = failed ? `Session failed (exit ${exitCode})${commitLabel}${errorSummary ? `: ${errorSummary}` : ''}` : `Session finished${commitLabel}`
      notify(notifyTitle, notifyBody, 'personas')

      // Check for new attention requests from this session
      const newAttention = getAttentionRequests(name).filter(a => !a.resolved)
      if (newAttention.length > 0) {
        const latest = newAttention[newAttention.length - 1]
        notify(
          `Colony: ${name} needs attention`,
          latest.message.slice(0, 100),
          'personas'
        )
      }

      // Collect on_complete_run triggers from the persona's frontmatter
      const personaFile = readdirSync(PERSONAS_DIR).find(f => {
        try {
          const c = readFileSync(join(PERSONAS_DIR, f), 'utf-8')
          const fm = parseFrontmatter(c)
          return fm?.name === name
        } catch { return false }
      })
      if (personaFile) {
        // Record this run in the per-persona ring buffer
        const personaId = personaFile.replace('.md', '')

        // Clean up working status file
        try { unlinkSync(join(PERSONAS_DIR, `${personaId}.status`)) } catch { /* file may not exist */ }

        const budgetExceeded = wasBudgetStopped(instanceId)
        const stopReason = manuallyStopped ? 'manual' : budgetExceeded ? 'budget_exceeded' : normalCompletion ? 'idle_complete' : undefined
        appendRunEntry(personaId, {
          personaId,
          timestamp: new Date().toISOString(),
          durationMs: durationSec !== null ? durationSec * 1000 : 0,
          costUsd: sessionCost,
          success: !failed, // budget_exceeded counts as success; manual stop does not affect; failed exit = false
          stopReason,
          sessionId: instanceId,
        })
        checkDailyCostBudget()

        // Auto-retry on failure
        if (failed && !budgetExceeded) {
          try {
            const c = readFileSync(join(PERSONAS_DIR, personaFile), 'utf-8')
            const fm = parseFrontmatter(c)
            const retryMax = fm?.retry_on_failure ?? 0
            const currentRetry = state.retryCount ?? 0
            if (retryMax > 0 && currentRetry < retryMax) {
              state.retryCount = currentRetry + 1
              const attempt = state.retryCount
              const errorContext = (state.lastRunOutput || '').slice(-500)
              const retryMessage = `Previous attempt failed (exit code ${exitCode}). Error context:\n${errorContext}\n\nRetry attempt ${attempt} of ${retryMax}.`
              appendActivity({
                source: 'persona',
                name,
                summary: `Persona "${name}" auto-retrying (attempt ${attempt} of ${retryMax})`,
                level: 'info',
                project: workingDir ? basename(workingDir) : undefined,
              })
              const retryFile = personaFile
              setTimeout(() => {
                runPersona(retryFile, { type: 'retry' }, retryMessage).catch(err => {
                  console.log(`[persona] retry launch failed for "${name}": ${err.message}`)
                })
              }, 30_000)
              continue  // Skip trigger chain — retry takes priority
            } else if (retryMax > 0) {
              // All retries exhausted — reset count and notify
              state.retryCount = 0
              notify(
                `Colony: ${name} failed after ${retryMax} retries`,
                `All ${retryMax} retry attempt${retryMax !== 1 ? 's' : ''} exhausted`,
                'personas'
              ).catch(() => {})
            }
          } catch { /* non-fatal */ }
        } else if (!failed) {
          state.retryCount = 0  // Reset on success
        }

        // Track monthly cost and auto-pause if budget exceeded
        if (sessionCost > 0) {
          const tracking = trackMonthlyCost(personaId, sessionCost)
          try {
            const c = readFileSync(join(PERSONAS_DIR, personaFile), 'utf-8')
            const fm = parseFrontmatter(c)
            if (fm?.monthly_budget_usd && tracking.totalUsd >= fm.monthly_budget_usd) {
              state.enabled = false
              appendActivity({
                source: 'persona',
                name,
                summary: `Monthly budget exceeded ($${tracking.totalUsd.toFixed(2)} / $${fm.monthly_budget_usd}) — auto-paused`,
                level: 'warn',
                project: workingDir ? basename(workingDir) : undefined,
              })
              notify(
                `Colony: ${name} paused — monthly budget exceeded`,
                `Spent $${tracking.totalUsd.toFixed(2)} of $${fm.monthly_budget_usd} this month`,
                'personas'
              ).catch(() => {})
            }
          } catch { /* non-fatal */ }
        }

        if (manuallyStopped) {
          // Manual stop: skip trigger chain (both dynamic and on_complete_run), but still extract memory
          try {
            const c = readFileSync(join(PERSONAS_DIR, personaFile), 'utf-8')
            const fm = parseFrontmatter(c)
            if (fm && fm.auto_memory_extraction !== false && state.lastRunOutput && durationSec !== null) {
              extractMemoryInBackground(name, state.lastRunOutput, durationSec)
            }
          } catch { /* non-fatal */ }
        } else {
          const overridePath = join(PERSONAS_DIR, `${personaId}.triggers.json`)
          let dynamicTriggers: Array<{ persona: string; message?: string }> | null = null

          if (existsSync(overridePath)) {
            try {
              const raw = readFileSync(overridePath, 'utf-8')
              const parsed = JSON.parse(raw)
              if (Array.isArray(parsed.triggers)) {
                dynamicTriggers = parsed.triggers
              }
            } catch { /* malformed — fall back to on_complete_run */ }
            try { unlinkSync(overridePath) } catch { /* best effort */ }
          }

          try {
            const c = readFileSync(join(PERSONAS_DIR, personaFile), 'utf-8')
            const fm = parseFrontmatter(c)

            // Evaluate on_complete_run_if condition before dispatching triggers
            const triggerCondition = fm?.on_complete_run_if
            let shouldTrigger = true
            if (triggerCondition === 'success') shouldTrigger = !failed
            else if (triggerCondition === 'has_commits') shouldTrigger = commitsCount > 0
            else if (triggerCondition === 'has_changes') shouldTrigger = filesChanged > 0

            if (!shouldTrigger) {
              appendActivity({
                source: 'persona',
                name,
                summary: `Skipping triggers — condition '${triggerCondition}' not met (${commitsCount} commit${commitsCount !== 1 ? 's' : ''}, ${failed ? 'failed' : 'success'})`,
                level: 'info',
                project: workingDir ? basename(workingDir) : undefined,
              })
            }

            if (shouldTrigger) {
              const nextDepth = (state.chainDepth ?? 0) + 1
              if (dynamicTriggers !== null) {
                // Dynamic override: use file contents (empty array = suppress all triggers)
                console.log(`[persona] trigger: dynamic override for "${name}" — ${dynamicTriggers.length} trigger(s)`)
                for (const t of dynamicTriggers) {
                  triggerPersonas.push({ id: t.persona, triggeredBy: name, customMessage: t.message, chainDepth: nextDepth, chainId: state.chainId })
                }
              } else if (fm && fm.on_complete_run.length > 0) {
                const { text: autoContext, metadata: handoffMeta } = buildTriggerContext(name, personaId, exitCode, durationSec, commitsCount, filesChanged, sessionCost, errorSummary, state.chainId, nextDepth)
                for (const t of fm.on_complete_run) {
                  triggerPersonas.push({ id: t, triggeredBy: name, customMessage: autoContext, metadata: handoffMeta, chainDepth: nextDepth, chainId: state.chainId })
                }
              }
            }

            // Fire memory extraction (fire-and-forget — never blocks)
            if (fm && fm.auto_memory_extraction !== false && state.lastRunOutput && durationSec !== null) {
              extractMemoryInBackground(name, state.lastRunOutput, durationSec)
            }
          } catch { /* non-fatal */ }
        }

        // Track draining personas — will be disabled after triggers fire
        if (state.draining) {
          drainingExited.push(name)
        }
      }
    }
  }
  if (changed) {
    saveState()
    broadcastStatus()
  }

  // Dispatch completion triggers after state is saved
  for (const { id: triggerId, triggeredBy, customMessage, metadata, chainDepth, chainId } of triggerPersonas) {
    const maxDepth = parseInt(getSettingSync('triggerChainDepthLimit') || '') || 10
    if (chainDepth > maxDepth) {
      console.log(`[persona] trigger: chain depth ${chainDepth} exceeds limit ${maxDepth} for "${triggerId}" — skipping`)
      appendActivity({ source: 'persona', name: triggerId, summary: `Trigger chain depth limit (${maxDepth}) reached — skipping trigger from "${triggeredBy}"`, level: 'warn' })
      notify(`Colony: trigger chain halted`, `"${triggeredBy}" reached depth ${chainDepth} — possible cycle`, 'personas')
      continue
    }
    const persona = getPersonaList().find(p => p.id === triggerId || p.name === triggerId)
    if (!persona) {
      console.log(`[persona] trigger: target "${triggerId}" not found — skipping`)
      continue
    }
    if (!persona.enabled) {
      console.log(`[persona] trigger: "${triggerId}" is disabled — skipping`)
      continue
    }
    if (persona.activeSessionId) {
      const pState = getState(persona.name)
      if (!pState.pendingRuns) pState.pendingRuns = []
      if (pState.pendingRuns.length >= 5) {
        console.log(`[persona] trigger: run queue full for "${triggerId}" — dropping trigger from "${triggeredBy}"`)
        appendActivity({ source: 'persona', name: triggerId, summary: `Run queue full for "${triggerId}" — dropping trigger from "${triggeredBy}"`, level: 'warn' })
      } else {
        pState.pendingRuns.push({ reason: `trigger from ${triggeredBy}`, queuedAt: new Date().toISOString(), context: customMessage, triggerType: 'handoff', triggeredBy, chainDepth, chainId })
        appendActivity({ source: 'persona', name: triggerId, summary: `Queued trigger for "${triggerId}" (from "${triggeredBy}") — currently running`, level: 'info' })
        console.log(`[persona] trigger: queued for "${triggerId}" (from "${triggeredBy}") — currently running`)
      }
      saveState()
      broadcastStatus()
      continue
    }
    console.log(`[persona] trigger: → "${triggerId}" (from "${triggeredBy}", depth ${chainDepth})`)
    // Write structured handoff file with JSON frontmatter
    if (metadata) {
      const handoffId = `${Date.now().toString(16)}-${Math.random().toString(36).slice(2, 8)}`
      const handoffDir = join(colonyPaths.root, 'handoffs')
      const handoffPath = join(handoffDir, `${handoffId}.md`)
      const handoffContent = `---json\n${JSON.stringify(metadata, null, 2)}\n---\n\n${customMessage ?? ''}`
      fsp.mkdir(handoffDir, { recursive: true }).then(() => fsp.writeFile(handoffPath, handoffContent, 'utf-8')).catch(() => {})
    }
    runPersona(persona.id, { type: 'handoff', from: triggeredBy, chainId }, customMessage, undefined, { chainDepth, chainId }).catch(err => {
      console.log(`[persona] trigger: launch failed for "${triggerId}": ${err.message}`)
    })
  }

  // Finalize drain: disable personas that were draining and just exited
  if (drainingExited.length > 0) {
    for (const name of drainingExited) {
      const state = stateCache[name]
      if (!state) continue
      const flushed = (state.pendingRuns || []).length
      state.pendingRuns = []
      state.enabled = false
      state.draining = false
      if (flushed > 0) {
        appendActivity({ source: 'persona', name, summary: `Persona "${name}" drained — flushed ${flushed} pending run(s)`, level: 'info' })
      } else {
        appendActivity({ source: 'persona', name, summary: `Persona "${name}" drained — now disabled`, level: 'info' })
      }
    }
    saveState()
    broadcastStatus()
  }

  // Pop from run queue: for the persona that just exited, start its next queued run
  for (const [name, state] of Object.entries(stateCache)) {
    if ((state.pendingRuns || []).length > 0 && !state.activeSessionId && !state.draining && state.enabled) {
      const next = state.pendingRuns!.shift()!
      saveState()
      broadcastStatus()
      const persona = getPersonaList().find(p => p.name === name)
      if (persona) {
        runPersona(persona.id, { type: (next.triggerType as any) || 'handoff', from: next.triggeredBy || 'queue', chainId: next.chainId }, next.context, undefined, { chainDepth: next.chainDepth, chainId: next.chainId }).catch(err => {
          console.log(`[persona] queue pop failed for "${name}": ${err.message}`)
        })
      }
      break // one pop per exit to avoid thundering herd
    }
  }
}

// ---- Broadcast ----

function broadcastStatus(): void {
  broadcast('persona:status', getPersonaList())
}


// ---- File Watcher ----

let watcher: ReturnType<typeof watch> | null = null

export function startWatcher(): void {
  ensureDir()
  pruneOldAttention()
  if (watcher) return
  try {
    watcher = watch(PERSONAS_DIR, (event, filename) => {
      if (filename?.endsWith('.md')) {
        broadcastStatus()
      }
    })
  } catch { /* non-fatal */ }
}

export function stopWatcher(): void {
  if (watcher) {
    watcher.close()
    watcher = null
  }
}

export function getPersonaConfigPair(
  idA: string,
  idB: string,
): { a: { name: string; content: string }; b: { name: string; content: string } } | null {
  const personas = getPersonaList()
  const pA = personas.find(p => p.id === idA)
  const pB = personas.find(p => p.id === idB)
  if (!pA || !pB) return null
  const { content: contentA } = getPersonaContent(pA.id)
  const { content: contentB } = getPersonaContent(pB.id)
  if (!contentA || !contentB) return null
  return { a: { name: pA.name, content: contentA }, b: { name: pB.name, content: contentB } }
}

export async function previewPersonaPrompt(fileName: string): Promise<string> {
  const filePath = resolvedPersonaPath(fileName)
  const content = readFileSync(filePath, 'utf-8')
  const fm = parseFrontmatter(content)
  if (!fm) throw new Error(`Could not parse frontmatter for persona: ${fileName}`)
  const state = getState(fm.name)
  const whispers = parseWhispers(content)
  return buildPlanningPrompt(fm, state, filePath, whispers)
}
