import { existsSync, readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import type { PersonaAttentionRequest } from '../shared/types'
import { addWhisper } from './persona-manager'

const PERSONAS_DIR = colonyPaths.personas

function attentionPath(personaId: string): string {
  return join(PERSONAS_DIR, `${personaId}.attention.json`)
}

export function getAttentionRequests(personaId: string): PersonaAttentionRequest[] {
  try {
    const raw = readFileSync(attentionPath(personaId), 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (a): a is PersonaAttentionRequest =>
        a && typeof a.id === 'string' && typeof a.message === 'string' && typeof a.resolved === 'boolean'
    )
  } catch {
    return []
  }
}

export function getAllPendingAttention(): PersonaAttentionRequest[] {
  if (!existsSync(PERSONAS_DIR)) return []
  const results: PersonaAttentionRequest[] = []
  try {
    const files = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.attention.json'))
    for (const file of files) {
      const personaId = file.replace('.attention.json', '')
      const items = getAttentionRequests(personaId)
      results.push(...items.filter(a => !a.resolved))
    }
  } catch {
    return []
  }
  return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
}

export function getAttentionCount(personaId: string): number {
  return getAttentionRequests(personaId).filter(a => !a.resolved).length
}

export function resolveAttention(personaId: string, attnId: string, response?: string): boolean {
  const items = getAttentionRequests(personaId)
  const item = items.find(a => a.id === attnId)
  if (!item) return false
  item.resolved = true
  item.resolvedAt = new Date().toISOString()
  if (response) {
    item.response = response
    addWhisper(personaId, `[Attention response] ${response}`)
  }
  try {
    writeFileSync(attentionPath(personaId), JSON.stringify(items, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

export function dismissAttention(personaId: string, attnId: string): boolean {
  const items = getAttentionRequests(personaId)
  const item = items.find(a => a.id === attnId)
  if (!item) return false
  item.resolved = true
  item.resolvedAt = new Date().toISOString()
  try {
    writeFileSync(attentionPath(personaId), JSON.stringify(items, null, 2), 'utf-8')
    return true
  } catch {
    return false
  }
}

export function pruneOldAttention(): void {
  if (!existsSync(PERSONAS_DIR)) return
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000
  try {
    const files = readdirSync(PERSONAS_DIR).filter(f => f.endsWith('.attention.json'))
    for (const file of files) {
      const personaId = file.replace('.attention.json', '')
      const items = getAttentionRequests(personaId)
      const pruned = items.filter(a => !(a.resolved && new Date(a.createdAt).getTime() < cutoff))
      if (pruned.length !== items.length) {
        writeFileSync(attentionPath(personaId), JSON.stringify(pruned, null, 2), 'utf-8')
      }
    }
  } catch { /* best effort */ }
}
