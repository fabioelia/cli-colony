/**
 * Persona Manager — loads, validates, watches, and launches persona sessions.
 * Personas are .md files in ~/.claude-colony/personas/ with YAML frontmatter
 * and self-managed sections (Active Situations, Learnings, Session Log).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, statSync, watch } from 'fs'
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
import type { PersonaInfo } from '../shared/types'
import { JsonFile } from '../shared/json-file'
import { appendActivity } from './activity-manager'
import { appendRunEntry, checkDailyCostBudget, getPersonaDailyCost } from './persona-run-history'
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
}

const stateFile = new JsonFile<Record<string, PersonaState>>(STATE_PATH, {})
let stateCache: Record<string, PersonaState> = {}

/** Instance IDs that were explicitly stopped by the user (not natural exits). */
const _manuallyStopped = new Set<string>()

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
    stateCache[name] = { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: false, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null, triggeredBy: null, triggerType: null, lastSkipped: null }
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
        attentionCount: getAttentionCount(personaId),
        color: fm.color || undefined,
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
            try { await killInstance(instanceId) } catch { /* already gone */ }
          }, 5000)
        } else {
          console.log(`[persona] session ${instanceId} still running after ${timeoutMinutes}min, force-killing`)
          ;(async () => {
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
  | { type: 'handoff'; from: string }

export async function runPersona(fileName: string, trigger: TriggerSource = { type: 'manual' }, customMessage?: string, parentId?: string): Promise<string> {
  const filePath = resolvedPersonaPath(fileName)
  if (!existsSync(filePath)) throw new Error(`Persona file not found: ${fileName}`)

  const content = readFileSync(filePath, 'utf-8')
  const fm = parseFrontmatter(content)
  if (!fm) throw new Error(`Invalid persona file: ${fileName}`)

  const state = getState(fm.name)

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

  // Launch interactive session with system prompt, then send trigger when ready
  const inst = await createInstance({
    name: `Persona: ${fm.name}`,
    workingDirectory: cwd,
    color: fm.color,
    model: fm.model,
    args: ['--append-system-prompt-file', promptFile],
    parentId,
    triggeredBy: trigger.type === 'handoff' ? (trigger.from ?? undefined) : undefined,
  })

  const kickoff = buildKickoff(filePath, trigger, customMessage)
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

  // Brief first
  const briefPath = join(PERSONAS_DIR, `${safeId}.brief.md`)
  if (existsSync(briefPath)) {
    try {
      const s = statSync(briefPath)
      artifacts.push({ name: `${safeId}.brief.md`, sizeBytes: s.size, modifiedAt: s.mtimeMs, isBrief: true })
    } catch { /* skip */ }
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
  if (safeFile === `${safeId}.brief.md`) {
    filePath = join(PERSONAS_DIR, safeFile)
  } else {
    filePath = join(colonyPaths.root, 'outputs', safeId, safeFile)
  }
  if (!existsSync(filePath)) return null
  const content = readFileSync(filePath, 'utf-8')
  const MAX = 50 * 1024
  return content.length > MAX ? content.slice(0, MAX) + '\n\n[truncated]' : content
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

/** Called by instance-manager when any session exits — captures output and clears active session */
export async function onSessionExit(instanceId: string): Promise<void> {
  let changed = false
  const triggerPersonas: Array<{ id: string; triggeredBy: string; customMessage?: string }> = []

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
      const failed = !manuallyStopped && exitCode !== null && exitCode !== 0
      const exitLabel = manuallyStopped ? 'stopped' : failed ? `failed (exit ${exitCode})` : 'completed'
      state.activeSessionId = null
      state.triggeredBy = null
      changed = true
      console.log(`[persona] session exited for "${name}" (${exitLabel})`)
      appendActivity({
        source: 'persona',
        name,
        summary: `Persona "${name}" ${exitLabel} session${commitLabel}`,
        level: failed ? 'warn' : 'info',
        sessionId: instanceId,
        details: { type: 'session-outcome', duration: durationSec, commitsCount, filesChanged, exitCode, costUsd: sessionCost },
      })
      const notifyTitle = failed ? `Colony: ${name} run failed` : `Colony: ${name} run complete`
      const notifyBody = failed ? `Session failed (exit ${exitCode})${commitLabel}` : `Session finished${commitLabel}`
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
        const budgetExceeded = wasBudgetStopped(instanceId)
        const stopReason = manuallyStopped ? 'manual' : budgetExceeded ? 'budget_exceeded' : undefined
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

            if (dynamicTriggers !== null) {
              // Dynamic override: use file contents (empty array = suppress all triggers)
              console.log(`[persona] trigger: dynamic override for "${name}" — ${dynamicTriggers.length} trigger(s)`)
              for (const t of dynamicTriggers) {
                triggerPersonas.push({ id: t.persona, triggeredBy: name, customMessage: t.message })
              }
            } else if (fm && fm.on_complete_run.length > 0) {
              for (const t of fm.on_complete_run) {
                triggerPersonas.push({ id: t, triggeredBy: name, customMessage: undefined })
              }
            }

            // Fire memory extraction (fire-and-forget — never blocks)
            if (fm && fm.auto_memory_extraction !== false && state.lastRunOutput && durationSec !== null) {
              extractMemoryInBackground(name, state.lastRunOutput, durationSec)
            }
          } catch { /* non-fatal */ }
        }
      }
    }
  }
  if (changed) {
    saveState()
    broadcastStatus()
  }

  // Dispatch completion triggers after state is saved
  for (const { id: triggerId, triggeredBy, customMessage } of triggerPersonas) {
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
      console.log(`[persona] trigger: "${triggerId}" already running — skipping`)
      continue
    }
    console.log(`[persona] trigger: → "${triggerId}" (from "${triggeredBy}")`)
    runPersona(persona.id, { type: 'handoff', from: triggeredBy }, customMessage).catch(err => {
      console.log(`[persona] trigger: launch failed for "${triggerId}": ${err.message}`)
    })
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
