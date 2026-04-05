/**
 * Persona Manager — loads, validates, watches, and launches persona sessions.
 * Personas are .md files in ~/.claude-colony/personas/ with YAML frontmatter
 * and self-managed sections (Active Situations, Learnings, Session Log).
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, watch } from 'fs'
import { execSync } from 'child_process'
import { join, basename } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { createInstance, getAllInstances, killInstance } from './instance-manager'
import { getDaemonClient } from './daemon-client'
import { sendPromptWhenReady } from './send-prompt-when-ready'
import { updateColonyContext } from './colony-context'
import { broadcast } from './broadcast'
import { notify } from './notifications'
import { cronMatches } from '../shared/cron'
import { slugify, parseFrontmatter as parseRawFrontmatter } from '../shared/utils'
import type { PersonaInfo } from '../shared/types'
import { JsonFile } from '../shared/json-file'
import { appendActivity } from './activity-manager'

const PERSONAS_DIR = colonyPaths.personas
const STATE_PATH = colonyPaths.personaState

// ---- State ----

interface PersonaState {
  lastRunAt: string | null
  runCount: number
  activeSessionId: string | null
  enabled: boolean
  lastRunOutput: string | null
  sessionStartedAt: string | null
  sessionWorkingDir: string | null
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
    stateCache[name] = { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: false, lastRunOutput: null, sessionStartedAt: null, sessionWorkingDir: null }
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
  on_complete_run: string[]
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
        whispers: parseWhispers(content),
        onCompleteRun: fm.on_complete_run,
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
  const filePath = join(PERSONAS_DIR, id.endsWith('.md') ? id : `${id}.md`)
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

/** Surgically update the schedule field in a persona frontmatter without touching the rest. */
export function setPersonaSchedule(fileName: string, schedule: string): boolean {
  const content = getPersonaContent(fileName)
  if (!content) return false
  const updated = content.replace(/^(schedule:\s*).*$/m, `$1"${schedule}"`)
  return savePersonaContent(fileName, updated)
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

  const whispers = parseWhispers(readFileSync(filePath, 'utf-8'))
  const whispersSection = whispers.length > 0
    ? `## User Notes

The user has sent you the following notes to consider this session:
${whispers.map(w => `- [${w.createdAt}] ${w.text}`).join('\n')}

For each note you address this session, remove its line from the \`## Notes\` section of your file.
If a note requires ongoing work, track it as an Active Situation instead of leaving it as a note.

`
    : ''

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

${whispersSection}## Planning Loop

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

\`\`\`

**Rules for delegation:**
- Always use \`--permission-mode bypassPermissions\` so sub-tasks don't stall on prompts
- Use \`--model sonnet\` for routine tasks (reviews, tests, analysis) — save opus for complex work
- Use \`--add-dir\` to give the sub-task access to the right project directory
- Use \`--agent\` when a specialist agent exists (see Colony Context for the full list)
- Tell the sub-task to write its output to \`~/.claude-colony/outputs/\` so other sessions can find it

**Output convention:** Every delegated task MUST write its results to a predictable path:
\`\`\`
~/.claude-colony/outputs/<persona-name>/<task-slug>.md
\`\`\`
Tell the sub-task in its prompt: "Write your findings to ~/.claude-colony/outputs/${fm.name.toLowerCase()}/<task-slug>.md"

**Capturing quick results:** For short tasks, capture stdout directly:
\`\`\`bash
result=$(claude -p "..." --permission-mode bypassPermissions --model sonnet 2>/dev/null)
\`\`\`

Colony will detect these sub-sessions and show them in the sidebar.

### 5. UPDATE
After completing your actions, update your identity file (${filePath}):

**Active Situations** — This is your supervision board. For every delegated task, track:
\`\`\`
- [DELEGATED] PR #38 review → output: ~/.claude-colony/outputs/${fm.name.toLowerCase()}/pr-38-review.md
- [PENDING] Waiting on test results → output: ~/.claude-colony/outputs/${fm.name.toLowerCase()}/test-failures.md
- [DONE] Auth refactor complete → output: ~/.claude-colony/outputs/${fm.name.toLowerCase()}/auth-refactor.md (reviewed session #14)
\`\`\`
Each entry should have: status (DELEGATED/PENDING/DONE/BLOCKED), what it is, and the output path.
On your next session, check each DELEGATED/PENDING item — read its output file to see if the
sub-task completed, then decide next steps (mark done, re-delegate, escalate).
Remove DONE items after you've reviewed their output.

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
  state.sessionStartedAt = state.lastRunAt
  state.sessionWorkingDir = cwd
  state.runCount++
  saveState()

  broadcast('persona:run', { persona: fm.name, instanceId: inst.id })
  broadcastStatus()
  notify(`Colony: Persona started`, `${fm.name} run #${state.runCount} started`, 'personas')

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
  const triggerPersonaIds: string[] = []

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

      // Compute session outcome stats
      const startedAt = state.sessionStartedAt
      const workingDir = state.sessionWorkingDir
      const durationSec = startedAt ? Math.round((Date.now() - new Date(startedAt).getTime()) / 1000) : null

      let commitsCount = 0
      let filesChanged = 0
      if (workingDir && startedAt && existsSync(workingDir)) {
        try {
          const logOut = execSync(`git log --oneline --after="${startedAt}"`, { encoding: 'utf-8', timeout: 5000, cwd: workingDir }).trim()
          commitsCount = logOut ? logOut.split('\n').length : 0
        } catch { /* not a git repo or no commits */ }
        if (commitsCount > 0) {
          try {
            const filesOut = execSync(`git log --name-only --format="" --after="${startedAt}"`, { encoding: 'utf-8', timeout: 5000, cwd: workingDir }).trim()
            filesChanged = filesOut ? new Set(filesOut.split('\n').filter(l => l.trim())).size : 0
          } catch { /* non-fatal */ }
        }
      }

      const commitLabel = commitsCount > 0 ? ` · ${commitsCount} commit${commitsCount !== 1 ? 's' : ''}` : ''
      state.activeSessionId = null
      changed = true
      console.log(`[persona] session exited for "${name}"`)
      appendActivity({
        source: 'persona',
        name,
        summary: `Persona "${name}" completed session${commitLabel}`,
        level: 'info',
        sessionId: instanceId,
        details: { type: 'session-outcome', duration: durationSec, commitsCount, filesChanged },
      })
      notify(`Colony: ${name} run complete`, `Session finished${commitLabel}`, 'personas')

      // Collect on_complete_run triggers from the persona's frontmatter
      const personaFile = readdirSync(PERSONAS_DIR).find(f => {
        try {
          const c = readFileSync(join(PERSONAS_DIR, f), 'utf-8')
          const fm = parseFrontmatter(c)
          return fm?.name === name
        } catch { return false }
      })
      if (personaFile) {
        try {
          const c = readFileSync(join(PERSONAS_DIR, personaFile), 'utf-8')
          const fm = parseFrontmatter(c)
          if (fm && fm.on_complete_run.length > 0) {
            triggerPersonaIds.push(...fm.on_complete_run)
          }
        } catch { /* non-fatal */ }
      }
    }
  }
  if (changed) {
    saveState()
    broadcastStatus()
  }

  // Dispatch completion triggers after state is saved
  for (const triggerId of triggerPersonaIds) {
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
    console.log(`[persona] trigger: → "${triggerId}"`)
    runPersona(persona.id).catch(err => {
      console.log(`[persona] trigger: launch failed for "${triggerId}": ${err.message}`)
    })
  }
}

// ---- Broadcast ----

function broadcastStatus(): void {
  broadcast('persona:status', getPersonaList())
}

// ---- Cron Scheduling ----
// Cron matching imported from src/shared/cron.ts

function schedulerLog(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}\n`
  try { appendFileSync(colonyPaths.schedulerLog, line, 'utf-8') } catch { /* non-fatal */ }
  console.log(`[persona] ${msg}`)
}

let schedulerInterval: ReturnType<typeof setInterval> | null = null
let lastCronMinute = -1

export function startScheduler(): void {
  if (schedulerInterval) return
  schedulerLog('scheduler started')

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

      if (persona.activeSessionId) {
        schedulerLog(`skip "${persona.name}" — already running (session ${persona.activeSessionId})`)
        continue
      }

      if (cronMatches(persona.schedule)) {
        schedulerLog(`cron matched "${persona.name}" (${persona.schedule}) — launching`)
        runPersona(persona.id).catch(err => {
          schedulerLog(`launch failed for "${persona.name}": ${err.message}`)
        })
      }
    }
  }, 15_000) // check every 15 seconds
}

export function stopScheduler(): void {
  if (schedulerInterval) {
    clearInterval(schedulerInterval)
    schedulerInterval = null
    schedulerLog('scheduler stopped')
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
