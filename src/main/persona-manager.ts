/**
 * Persona Manager — loads, validates, watches, and launches persona sessions.
 * Personas are .md files in ~/.claude-colony/personas/ with YAML frontmatter
 * and self-managed sections (Active Situations, Learnings, Session Log).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync, watch } from 'fs'
import { join, basename } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { createInstance, getAllInstances, writeToInstance } from './instance-manager'
import { broadcast } from './broadcast'
import type { PersonaInfo } from '../shared/types'

const PERSONAS_DIR = colonyPaths.personas
const STATE_PATH = colonyPaths.personaState

// ---- State ----

interface PersonaState {
  lastRunAt: string | null
  runCount: number
  activeSessionId: string | null
  enabled: boolean
}

let stateCache: Record<string, PersonaState> = {}

function ensureDir(): void {
  if (!existsSync(PERSONAS_DIR)) mkdirSync(PERSONAS_DIR, { recursive: true })
}

function loadState(): Record<string, PersonaState> {
  try {
    if (existsSync(STATE_PATH)) {
      stateCache = JSON.parse(readFileSync(STATE_PATH, 'utf-8'))
    }
  } catch { stateCache = {} }
  return stateCache
}

function saveState(): void {
  writeFileSync(STATE_PATH, JSON.stringify(stateCache, null, 2), 'utf-8')
}

function getState(name: string): PersonaState {
  if (!stateCache[name]) {
    stateCache[name] = { lastRunAt: null, runCount: 0, activeSessionId: null, enabled: false }
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
  const match = content.match(/^---\n([\s\S]*?)\n---/)
  if (!match) return null

  const defaults: PersonaFrontmatter = {
    name: '',
    schedule: '',
    model: 'sonnet',
    max_sessions: 1,
    can_push: false,
    can_merge: false,
    can_create_sessions: false,
    working_directory: '',
    color: '#a78bfa',
  }

  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    const key = line.substring(0, idx).trim()
    const val = line.substring(idx + 1).trim().replace(/^["']|["']$/g, '')

    switch (key) {
      case 'name': defaults.name = val; break
      case 'schedule': defaults.schedule = val; break
      case 'model': defaults.model = val; break
      case 'max_sessions': defaults.max_sessions = parseInt(val) || 1; break
      case 'can_push': defaults.can_push = val === 'true'; break
      case 'can_merge': defaults.can_merge = val === 'true'; break
      case 'can_create_sessions': defaults.can_create_sessions = val === 'true'; break
      case 'working_directory': defaults.working_directory = val; break
      case 'color': defaults.color = val; break
      case 'enabled': /* handled via state file */ break
    }
  }

  if (!defaults.name) return null
  return defaults
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
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
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

function buildPlanningPrompt(fm: PersonaFrontmatter, state: PersonaState, filePath: string): string {
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

## Colony Context

The Colony workspace state is described in:
  ${colonyPaths.colonyContext}

Read this file to understand what sessions are running, what PRs are open, what
repos are tracked, and what other agents/personas exist.

## Planning Loop

Execute this cycle every session:

### 1. READ
- Read your identity file (${filePath})
- Read the colony context (${colonyPaths.colonyContext})
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
- Execute your chosen actions
- Use the tools available to you (file read/write, shell commands, etc.)
- Stay within your permission scope (see below)
- To launch a sub-task session: \`claude --name "Task Name" --max-turns 100 -p "Your task instructions here"\`
  The -p flag sends the prompt directly. --max-turns caps it so it doesn't run forever.
- To resume an existing session: \`claude --resume <session-id> -p "Continue with..."\`
- Colony will detect these sessions and show them in the sidebar

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
IMPORTANT: After updating your identity file, your work is done for this session. Use /exit to close the session cleanly.

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
  let attempts = 0
  const maxAttempts = 30 // ~15 seconds
  const interval = setInterval(async () => {
    attempts++
    try {
      const instances = await getAllInstances()
      const inst = instances.find(i => i.id === instanceId)
      if (!inst || inst.status === 'exited') {
        clearInterval(interval)
        return
      }
      if (inst.activity === 'waiting') {
        clearInterval(interval)
        await writeToInstance(instanceId, message + '\r')
        console.log(`[persona] sent trigger to ${instanceId}`)
      }
    } catch { /* retry */ }
    if (attempts >= maxAttempts) {
      clearInterval(interval)
      // Force-send anyway
      writeToInstance(instanceId, message + '\r').catch(() => {})
      console.log(`[persona] force-sent trigger to ${instanceId} after timeout`)
    }
  }, 500)
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
  const prompt = buildPlanningPrompt(fm, state, filePath)
  const promptsDir = join(colonyPaths.root, 'pipeline-prompts')
  if (!existsSync(promptsDir)) mkdirSync(promptsDir, { recursive: true })
  const promptId = `persona-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  const promptFile = join(promptsDir, `${promptId}.md`)
  writeFileSync(promptFile, prompt, 'utf-8')

  // Resolve working directory
  let cwd = fm.working_directory || colonyPaths.root
  if (cwd.startsWith('~')) cwd = cwd.replace('~', process.env.HOME || '/')

  // Launch session
  const inst = await createInstance({
    name: `Persona: ${fm.name}`,
    workingDirectory: cwd,
    color: fm.color,
    args: ['--append-system-prompt-file', promptFile],
  })

  // Send kick-off message once CLI is ready
  // The CLI starts, shows trust prompt, then waits for input.
  // We poll activity status and send the trigger when it's 'waiting'.
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

/** Called by instance-manager when any session exits — clears active persona sessions */
export function onSessionExit(instanceId: string): void {
  let changed = false
  for (const [name, state] of Object.entries(stateCache)) {
    if (state.activeSessionId === instanceId) {
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
