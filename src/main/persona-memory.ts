/**
 * Persona Memory — structured JSON sidecar for persona state.
 *
 * Each persona gets a `<id>.memory.json` file alongside its `.md` file in the
 * personas directory. This replaces hand-edited markdown sections (Active
 * Situations, Learnings, Session Log) with a structured, programmatically
 * managed format.
 *
 * Limits: 30 learnings, 20 session log entries (oldest trimmed on add).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'fs'
import { spawn } from 'child_process'
import { resolveCommand } from './resolve-command'
import { join, dirname, basename } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import type { PersonaMemory, PersonaMemorySituation, PersonaMemoryLearning, PersonaMemoryLogEntry } from '../shared/types'

const PERSONAS_DIR = colonyPaths.personas
const MAX_LEARNINGS = 30
const MAX_SESSION_LOG = 20

function memoryPath(personaId: string): string {
  const safe = basename(personaId.replace(/\.md$/, ''))
  return join(PERSONAS_DIR, `${safe}.memory.json`)
}

function emptyMemory(): PersonaMemory {
  return { activeSituations: [], learnings: [], sessionLog: [] }
}

// ---- Read / Write ----

export function readPersonaMemory(personaId: string): PersonaMemory {
  const p = memoryPath(personaId)
  try {
    if (existsSync(p)) {
      const raw = JSON.parse(readFileSync(p, 'utf-8'))
      return {
        activeSituations: Array.isArray(raw.activeSituations) ? raw.activeSituations : [],
        learnings: Array.isArray(raw.learnings) ? raw.learnings : [],
        sessionLog: Array.isArray(raw.sessionLog) ? raw.sessionLog : [],
      }
    }
  } catch { /* corrupt or missing */ }
  return emptyMemory()
}

function writePersonaMemory(personaId: string, memory: PersonaMemory): void {
  const p = memoryPath(personaId)
  const dir = dirname(p)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(p, JSON.stringify(memory, null, 2), 'utf-8')
}

// ---- Active Situations ----

export function setSituations(personaId: string, situations: PersonaMemorySituation[]): PersonaMemory {
  const mem = readPersonaMemory(personaId)
  mem.activeSituations = situations
  writePersonaMemory(personaId, mem)
  return mem
}

export function addSituation(personaId: string, situation: PersonaMemorySituation): PersonaMemory {
  const mem = readPersonaMemory(personaId)
  mem.activeSituations.push(situation)
  writePersonaMemory(personaId, mem)
  return mem
}

export function updateSituation(personaId: string, index: number, updates: Partial<PersonaMemorySituation>): PersonaMemory {
  const mem = readPersonaMemory(personaId)
  if (index >= 0 && index < mem.activeSituations.length) {
    mem.activeSituations[index] = { ...mem.activeSituations[index], ...updates, updatedAt: new Date().toISOString() }
    writePersonaMemory(personaId, mem)
  }
  return mem
}

export function removeSituation(personaId: string, index: number): PersonaMemory {
  const mem = readPersonaMemory(personaId)
  if (index >= 0 && index < mem.activeSituations.length) {
    mem.activeSituations.splice(index, 1)
    writePersonaMemory(personaId, mem)
  }
  return mem
}

// ---- Learnings ----

export function addLearning(personaId: string, text: string): PersonaMemory {
  const mem = readPersonaMemory(personaId)
  mem.learnings.push({ text, addedAt: new Date().toISOString() })
  if (mem.learnings.length > MAX_LEARNINGS) {
    mem.learnings = mem.learnings.slice(-MAX_LEARNINGS)
  }
  writePersonaMemory(personaId, mem)
  return mem
}

export function removeLearning(personaId: string, index: number): PersonaMemory {
  const mem = readPersonaMemory(personaId)
  if (index >= 0 && index < mem.learnings.length) {
    mem.learnings.splice(index, 1)
    writePersonaMemory(personaId, mem)
  }
  return mem
}

export function setLearnings(personaId: string, learnings: PersonaMemoryLearning[]): PersonaMemory {
  const mem = readPersonaMemory(personaId)
  mem.learnings = learnings.slice(-MAX_LEARNINGS)
  writePersonaMemory(personaId, mem)
  return mem
}

// ---- Session Log ----

export function addSessionLogEntry(personaId: string, summary: string): PersonaMemory {
  const mem = readPersonaMemory(personaId)
  mem.sessionLog.push({ timestamp: new Date().toISOString(), summary })
  if (mem.sessionLog.length > MAX_SESSION_LOG) {
    mem.sessionLog = mem.sessionLog.slice(-MAX_SESSION_LOG)
  }
  writePersonaMemory(personaId, mem)
  return mem
}

export function setSessionLog(personaId: string, entries: PersonaMemoryLogEntry[]): PersonaMemory {
  const mem = readPersonaMemory(personaId)
  mem.sessionLog = entries.slice(-MAX_SESSION_LOG)
  writePersonaMemory(personaId, mem)
  return mem
}

// ---- Migration from Markdown ----

/**
 * Migrate a persona's markdown sections into the structured sidecar.
 * Only migrates if the sidecar doesn't already exist and the markdown has content.
 * Returns true if a migration was performed.
 */
export function migrateFromMarkdown(personaId: string): boolean {
  const p = memoryPath(personaId)
  if (existsSync(p)) return false

  const mdPath = join(PERSONAS_DIR, `${basename(personaId.replace(/\.md$/, ''))}.md`)
  if (!existsSync(mdPath)) return false

  const content = readFileSync(mdPath, 'utf-8')
  const memory = emptyMemory()
  let migrated = false

  // Extract Active Situations
  const situationsSection = extractSection(content, 'Active Situations')
  if (situationsSection) {
    const lines = situationsSection.split('\n').filter(l => l.trim().startsWith('- '))
    for (const line of lines) {
      const statusMatch = line.match(/^\s*-\s*\[(DELEGATED|PENDING|DONE|BLOCKED)\]\s*/i)
      const status = statusMatch ? statusMatch[1].toLowerCase() as PersonaMemorySituation['status'] : 'pending'
      const text = statusMatch ? line.slice(statusMatch[0].length).trim() : line.replace(/^\s*-\s*/, '').trim()
      if (text) {
        memory.activeSituations.push({ status, text, updatedAt: new Date().toISOString() })
        migrated = true
      }
    }
  }

  // Extract Learnings
  const learningsSection = extractSection(content, 'Learnings')
  if (learningsSection) {
    const lines = learningsSection.split('\n').filter(l => l.trim().startsWith('- '))
    for (const line of lines) {
      const text = line.replace(/^\s*-\s*/, '').trim()
      if (text) {
        memory.learnings.push({ text, addedAt: new Date().toISOString() })
        migrated = true
      }
    }
    // Enforce limit
    if (memory.learnings.length > MAX_LEARNINGS) {
      memory.learnings = memory.learnings.slice(-MAX_LEARNINGS)
    }
  }

  // Extract Session Log
  const logSection = extractSection(content, 'Session Log')
  if (logSection) {
    const lines = logSection.split('\n').filter(l => l.trim().startsWith('- '))
    for (const line of lines) {
      const tsMatch = line.match(/^\s*-\s*\[([^\]]+)\]\s*(.+)/)
      if (tsMatch) {
        memory.sessionLog.push({ timestamp: tsMatch[1], summary: tsMatch[2].trim() })
        migrated = true
      } else {
        const text = line.replace(/^\s*-\s*/, '').trim()
        if (text) {
          memory.sessionLog.push({ timestamp: new Date().toISOString(), summary: text })
          migrated = true
        }
      }
    }
    // Enforce limit
    if (memory.sessionLog.length > MAX_SESSION_LOG) {
      memory.sessionLog = memory.sessionLog.slice(-MAX_SESSION_LOG)
    }
  }

  if (migrated) {
    writePersonaMemory(personaId, memory)
  }

  return migrated
}

/** Extract a ## Heading section from markdown content. */
function extractSection(content: string, heading: string): string {
  const regex = new RegExp(`^## ${heading}\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, 'm')
  const match = content.match(regex)
  return match ? match[1].trim() : ''
}

/** Get the memory file path for a persona (for external callers that need the path). */
export function getMemoryPath(personaId: string): string {
  return memoryPath(personaId)
}

// ---- Knowledge Extraction ----

/**
 * Fire-and-forget: extract facts from a session output and append to KNOWLEDGE.md.
 * Uses claude -p with haiku for speed. Errors are swallowed — never blocks session cleanup.
 */
export function extractMemoryInBackground(personaName: string, output: string, durationSec: number): void {
  if (durationSec < 60) return
  if (!output || output.length < 200) return

  const today = new Date().toISOString().slice(0, 10)
  const prompt =
    `Read this session output and extract 1-5 factual learnings about the codebase, ` +
    `decisions made, or patterns discovered. Format each as: [${today} | ${personaName}] <fact>. ` +
    `Only include facts useful to other agents. Output a bare list, nothing else.\n\n---\n${output}`

  try {
    const proc = spawn(resolveCommand('claude'), ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      detached: false,
    })

    let result = ''
    proc.stdout.on('data', (chunk: Buffer) => { result += chunk.toString() })

    proc.on('close', () => {
      try {
        const lines = result
          .split('\n')
          .map(l => l.trim())
          .filter(l => /^\[/.test(l))  // only lines starting with [
        if (lines.length === 0) return

        const knowledgePath = colonyPaths.knowledgeBase
        const entry = '\n' + lines.join('\n') + '\n'
        appendFileSync(knowledgePath, entry, 'utf-8')
        console.log(`[persona] memory extraction: appended ${lines.length} line(s) to KNOWLEDGE.md`)
      } catch { /* non-fatal */ }
    })

    proc.on('error', () => { /* non-fatal */ })
  } catch { /* non-fatal */ }
}
