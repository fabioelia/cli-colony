import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import type { PersonaRunEntry } from '../shared/types'

const MAX_ENTRIES = 50

function historyPath(personaId: string): string {
  return join(colonyPaths.root, `persona-run-history-${personaId}.json`)
}

/** Prepend a run entry and trim to MAX_ENTRIES. O(n) but n ≤ 50 so fine. */
export function appendRunEntry(personaId: string, entry: PersonaRunEntry): void {
  let entries: PersonaRunEntry[] = []
  try {
    const raw = readFileSync(historyPath(personaId), 'utf-8')
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) entries = parsed
  } catch { /* first write or corrupt */ }
  entries.unshift(entry)
  if (entries.length > MAX_ENTRIES) entries = entries.slice(0, MAX_ENTRIES)
  try {
    writeFileSync(historyPath(personaId), JSON.stringify(entries), 'utf-8')
  } catch { /* non-fatal */ }
}

/** Return the newest-first run history for a persona, capped at `max`. */
export function getRunHistory(personaId: string, max = 20): PersonaRunEntry[] {
  try {
    const raw = readFileSync(historyPath(personaId), 'utf-8')
    const entries = JSON.parse(raw)
    if (!Array.isArray(entries)) return []
    return entries.slice(0, max)
  } catch { return [] }
}
