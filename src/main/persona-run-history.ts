import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import type { PersonaRunEntry, PersonaAnalytics } from '../shared/types'

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

/** Compute aggregate analytics from a persona's run history. */
export function getPersonaAnalytics(personaId: string): PersonaAnalytics {
  const allRuns = getRunHistory(personaId, MAX_ENTRIES)
  if (allRuns.length === 0) {
    return { totalRuns: 0, successRate: 0, avgDurationMs: 0, totalCostUsd: 0, costLast7d: 0, recentRuns: [] }
  }

  const successCount = allRuns.filter(r => r.success).length
  const successRate = Math.round((successCount / allRuns.length) * 10000) / 100
  const avgDurationMs = Math.round(allRuns.reduce((s, r) => s + r.durationMs, 0) / allRuns.length)
  const totalCostUsd = Math.round(allRuns.reduce((s, r) => s + (r.costUsd ?? 0), 0) * 100) / 100

  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  const costLast7d = Math.round(
    allRuns
      .filter(r => new Date(r.timestamp).getTime() > sevenDaysAgo)
      .reduce((s, r) => s + (r.costUsd ?? 0), 0) * 100,
  ) / 100

  return { totalRuns: allRuns.length, successRate, avgDurationMs, totalCostUsd, costLast7d, recentRuns: allRuns.slice(0, 20) }
}
