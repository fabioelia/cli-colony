/**
 * Persona Manager — loads, validates, watches, and launches persona sessions.
 * Personas are .md files in ~/.claude-colony/personas/ with YAML frontmatter
 * and self-managed sections (Active Situations, Learnings, Session Log).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, watch } from 'fs'
import { join, basename } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { createInstance, getAllInstances } from './instance-manager'
import { getDaemonClient } from './daemon-client'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { updateColonyContext } from './colony-context'
import { broadcast } from './broadcast'
import { cronMatches } from '../shared/cron'
import { slugify, parseFrontmatter as parseRawFrontmatter } from '../shared/utils'
import type { PersonaInfo } from '../shared/types'

const PERSONAS_DIR = colonyPaths.personas
const STATE_PATH = colonyPaths.personaState

// ---- State ----

interface PersonaState {
  lastRunAt: string | null
  runCount: number
  activeSessionId: string | null
  enabled: boolean
  lastRunOutput: string | null
}

const stateFile = new JsonFile<Record<string, PersonaState>>(STATE_PATH, {})
let stateCache: Record<string, PersonaState> = {}

function ensureDir(): void {
  if (!existsSync(PERSONAS_DIR)) mkdirSync(PERSONAS_DIR, { recursive: true })
}

function loadState(): Record<string, PersonaState> {
  stateCache = stateFile.read()
  return stateCache
}

function saveState(): void {
  stateFile.write(stateCache)
}

function getState(name: string): PersonaState {
  if (!stateCache[name]) {
    stateCache[name] = { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: false, lastRunOutput: null }
  }
  return stateCache[name]
}

// ---- Frontmatter Parser ----

interface PersonaFrontmatter {
  name: string
  schedule: string
  model: string
  max_sessions: number
  can_push: boolean
  can_merge: boolean
  can_create_sessions: boolean
  working_directory: string
  color: string
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
  }

  if (!result.name) return null
  return result
}

// ---- Section Extractor ----

function extractSection(content: string, heading: string): string {
  const regex = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$)`, 'm')
  const match = content.match(regex)
  return match ? match[1].trim() : ''
}

// ---- Public API ----

export function loadPersonas(): void {
  ensureDir()
  loadState()
  console.log(`[persona] loaded ${readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.md')).length} persona files`)
}

export function getPersonaList(): PersonaInfo[] {
  ensureDir()
  const files = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.md')).sort()
  const personas: PersonaInfo[] = []

  for (const file of files) {
    const filePath = join(PERSONAS_DIR, file)
    try {
      const content = readFileSync(filePath, 'utf-8')
      const fm = parseFrontmatter(content)
      if (!fm) continue

      const state = getState(fm.name)

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
      })
    } catch { /* skip invalid files */ }
  }

  return personas
}

export function getPersonaContent(fileName: string): string | null {
  const filePath = join(PERSONAS_DIR, fileName.endsWith('.md') ? fileName : `${fileName}.md`)
  try {
    return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null
  } catch {
    return null
  }
}

export function savePersonaContent(fileName: string, content: string): boolean {
  ensureDir()
  const filePath = join(PERSONAS_DIR, fileName.endsWith('.md') ? fileName : `${fileName}.md`)
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

export function deletePersona(fileName: string): boolean {
  const filePath = join(PERSONAS_DIR, fileName.endsWith('.md') ? fileName : `${fileName}.md`)
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
  const filePath = join(PERSONAS_DIR, fileName.endsWith('.md') ? fileName : `${fileName}.md`)
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

// ---- Planning Loop Prompt ----

async function getColonySnapshot(): Promise<string> {
  try {
    await updateColonyContext()
    const contextPath = colonyPaths.colonyContext
    if (existsSync(contextPath)) {
      return readFileSync(contextPath, 'utf-8')
    }
  } catch { /* */ }
  return '(Colony context unavailable)'
}

async function buildPlanningPrompt(fm: PersonaFrontmatter, state: PersonaState, filePath: string): Promise<string> {
  const timestamp = new Date().toISOString()
  const runCount = state.runCount + 1

  let permissions = ''
  if (fm.can_push) {
    permissions += '- You MAY push to git remotes\n'
  } else {
    permissions += '- You may NOT push to git remotes. Create branches and commits locally only.\n'
  }
  if (fm.can_merge) {
    permissions += '- You MAY merge pull requests\n'
  } else {
    permissions += '- You may NOT merge pull requests\n'
  }
  if (fm.can_create_sessions) {
    permissions += '- You MAY create child sessions by asking the user to launch them\n'
  } else {
    permissions += '- You may NOT create or request new sessions\n'
  }

  return `# Persona: ${fm.name}

You are a persistent AI agent in Claude Colony. You have identity, memory, and goals
that persist across sessions. This is session #${runCount} for this persona.

## Your Identity File

Your complete identity, objectives, memory, and session history are stored in:
  ${filePath}

Read this file NOW, before doing anything else. It contains your Role, Objectives,
Active Situations, Learnings, and Session Log.

## Colony Context (live snapshot)

${await getColonySnapshot()}

## Planning Loop

Execute this cycle every session:

### 1. READ
- Read your identity file (${filePath})
- Read any other files referenced in your Active Situations

### 2. ASSESS
- What has changed since your last session?
- Are any of your Active Situations resolved?
- Are there new situations that match your Objectives?
- What did you learn in previous sessions that applies now?

### 3. DECIDE
- Pick 1-3 concrete actions for this session
- Prioritize by: urgency > alignment with objectives > effort
- If nothing needs doing, say so and update your session log

### 4. ACT
- **Delegate, don't do.** Your primary job is orchestration. Spin up specialist agents for
  the actual work. Only do tasks yourself if they're trivially small (updating a file, checking
  a status) or require your cross-cutting awareness.
- Stay within your permission scope (see below)

#### Delegation via \`claude -p\`

Use \`claude -p "task" [flags]\` to run sub-tasks. The \`-p\` flag runs non-interactively
and returns the output to you. Key flags:

\`\`\`bash
# Delegate to a specialist agent (recommended — agents have domain expertise)
claude -p "Review PR #38 for architectural issues, write findings to ~/.claude-colony/outputs/reviews/pr-38.md" \\
  --agent ~/.claude/agents/architect-reviewer.md \\
  --add-dir /path/to/repo \\
  --model sonnet \\
  --permission-mode bypassPermissions

# Quick task without a specialist agent
claude -p "Run the test suite and summarize failures" \\
  --add-dir /path/to/project \\
  --permission-mode bypassPermissions \\
  --model sonnet

# Budget-cap expensive tasks
claude -p "Refactor the auth module" \\
  --max-budget-usd 2.00 \\
  --permission-mode bypassPermissions
\`\`\`

**Rules for delegation:**
- Always use \`--permission-mode bypassPermissions\` so sub-tasks don't stall on prompts
- Use \`--model sonnet\` for routine tasks (reviews, tests, analysis) — save opus for complex work
- Use \`--add-dir\` to give the sub-task access to the right project directory
- Use \`--agent\` when a specialist agent exists (see Colony Context for the full list)
- Tell the sub-task to write its output to \`~/.claude-colony/outputs/\` so other sessions can find it
- For long tasks, use \`--max-budget-usd\` to cap spend

**Capturing results:** \`claude -p\` prints its final response to stdout. You can capture it:
\`\`\`bash
result=$(claude -p "Analyze the test failures" --add-dir /path/to/repo --permission-mode bypassPermissions --model sonnet 2>/dev/null)
\`\`\`

Colony will detect these sub-sessions and show them in the sidebar.

### 5. UPDATE
After completing your actions, update your identity file (${filePath}):

**Active Situations** — Replace the entire section content (keep the \`## Active Situations\` heading).
Write a concise summary of all in-flight work, blockers, and items you're tracking.

**Learnings** — Append new entries if you discovered something useful. Remove entries
that are no longer relevant. Keep this section under 30 items.

**Session Log** — Append exactly one entry in this format:
\`- [${timestamp}] <one-line summary of what you did>\`
If there are more than 20 entries, remove the oldest ones.

IMPORTANT: Do NOT modify the \`## Role\` or \`## Objectives\` sections. Those are set by your operator.
IMPORTANT: Write the complete file back, preserving the YAML frontmatter exactly as-is.

## Permissions

${permissions}

## Session Metadata

- Persona: ${fm.name}
- Session number: ${runCount}
- Timestamp: ${timestamp}
- Working directory: ${fm.working_directory || colonyPaths.root}
- Model: ${fm.model}
`
}

// ---- Send trigger when CLI is ready ----

function sendTriggerWhenReady(instanceId: string, message: string): void {
  // Use the shared sendPromptWhenReady, then watch for persona completion
  sendPromptWhenReady(instanceId, {
    prompt: message,
    onSent: () => {
      console.log(`[persona] sent trigger to ${instanceId}`)

      // After sending, watch for the next 'waiting' = persona finished its work
      const client = getDaemonClient()
      const onFinished = (id: string, activity: string) => {
        if (id !== instanceId || activity !== 'waiting') return
        client.removeListener('activity', onFinished)
        console.log(`[persona] session ${instanceId} finished, killing in 5s`)
        setTimeout(async () => {
          try {
            const { killInstance } = await import('./instance-manager')
            await killInstance(instanceId)
          } catch { /* already gone */ }
        }, 5000)
      }
      client.on('activity', onFinished)

      // Safety cleanup after 10 minutes
      setTimeout(() => {
        client.removeListener('activity', onFinished)
      }, 600_000)
    },
  })
}

// ---- Run / Stop ----

export async function runPersona(fileName: string): Promise<string> {
  const filePath = join(PERSONAS_DIR, fileName.endsWith('.md') ? fileName : `${fileName}.md`)
  if (!existsSync(filePath)) throw new Error(`Persona file not found: ${fileName}`)

  const content = readFileSync(filePath, 'utf-8')
  const fm = parseFrontmatter(content)
  if (!fm) throw new Error(`Invalid persona file: ${fileName}`)

  const state = getState(fm.name)

  // Check if already running
  if (state.activeSessionId) {
    const instances = await getAllInstances()
    const existing = instances.find(i => i.id === state.activeSessionId && i.status === 'running')
    if (existing) {
      throw new Error(`Persona "${fm.name}" already has a running session`)
    }
    // Session died — clear it
    state.activeSessionId = null
  }

  // Build planning prompt and write to temp file
  const prompt = await buildPlanningPrompt(fm, state, filePath)
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
    args: ['--append-system-prompt-file', promptFile],
  })

  const kickoff = `Begin your planning loop now. Read your identity file at ${filePath} and the colony context, then assess, decide, and act.`
  sendTriggerWhenReady(inst.id, kickoff)

  // Update state
  state.activeSessionId = inst.id
  state.lastRunAt = new Date().toISOString()
  state.runCount++
  saveState()

  broadcast('persona:run', { persona: fm.name, instanceId: inst.id })
  broadcastStatus()

  console.log(`[persona] launched "${fm.name}" as session ${inst.id}`)
  return inst.id
}

export async function stopPersona(fileName: string): Promise<boolean> {
  const filePath = join(PERSONAS_DIR, fileName.endsWith('.md') ? fileName : `${fileName}.md`)
  if (!existsSync(filePath)) return false

  const content = readFileSync(filePath, 'utf-8')
  const fm = parseFrontmatter(content)
  if (!fm) return false

  const state = getState(fm.name)
  if (state.activeSessionId) {
    try {
      const { killInstance } = await import('./instance-manager')
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

// ---- Session Exit Tracking ----

/** Called by instance-manager when any session exits — captures output and clears active session */
export async function onSessionExit(instanceId: string): Promise<void> {
  let changed = false
  for (const [name, state] of Object.entries(stateCache)) {
    if (state.activeSessionId === instanceId) {
      // Capture the session's output buffer before clearing
      try {
        const buffer = await getDaemonClient().getInstanceBuffer(instanceId)
        if (buffer) {
          // Strip ANSI codes and keep last ~5000 chars
          const clean = buffer.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\r/g, '')
          state.lastRunOutput = clean.length > 5000 ? clean.slice(-5000) : clean
        }
      } catch { /* buffer may be gone */ }

      state.activeSessionId = null
      changed = true
      console.log(`[persona] session exited for "${name}"`)
    }
  }
  if (changed) {
    saveState()
    broadcastStatus()
  }
}

// ---- Broadcast ----

function broadcastStatus(): void {
  broadcast('persona:status', getPersonaList())
}

// ---- Cron Scheduling ----
// Cron matching imported from src/shared/cron.ts

let schedulerInterval: ReturnType<typeof setInterval> | null = null
let lastCronMinute = -1

export function startScheduler(): void {
  if (schedulerInterval) return
  console.log('[persona] scheduler started')

  schedulerInterval = setInterval(async () => {
    // Reconcile stale activeSessionId — clear if the session no longer exists
    const personas = getPersonaList()
    try {
      const instances = await getAllInstances()
      let reconciled = false
      for (const persona of personas) {
        if (!persona.activeSessionId) continue
        const exists = instances.find(i => i.id === persona.activeSessionId && i.status === 'running')
        if (!exists) {
          const state = getState(persona.name)
          state.activeSessionId = null
          reconciled = true
        }
      }
      if (reconciled) {
        saveState()
        broadcastStatus()
      }
    } catch { /* daemon may be down */ }

    const currentMinute = new Date().getMinutes()
    if (currentMinute === lastCronMinute) return // only check once per minute
    lastCronMinute = currentMinute

    for (const persona of personas) {
      if (!persona.enabled || !persona.schedule) continue
      if (persona.activeSessionId) continue // already running

      if (cronMatches(persona.schedule)) {
        console.log(`[persona] cron matched for "${persona.name}", launching`)
        runPersona(persona.id).catch(err => {
          console.error(`[persona] scheduled run failed for "${persona.name}":`, err.message)
        })
      }
    }
  }, 15_000) // check every 15 seconds
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
  }
}

// ---- File Watcher ----

let watcher: ReturnType<typeof watch> | null = null

export function startWatcher(): void {
  ensureDir()
  if (watcher) return
  try {
    watcher = watch(PERSONAS_DIR, (event, filename) => {
      if (filename?.endsWith('.md')) {
        broadcastStatus()
      }
    })
  } catch { /* non-fatal */ }
}
