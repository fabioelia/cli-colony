import { readFileSync, writeFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import type { PersonaRunEntry, PersonaAnalytics } from '../shared/types'

export interface DailyCostEntry {
  date: string   // YYYY-MM-DD
  cost: number
}

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

/** Return last-run success for each persona with ≥1 run. Lightweight — reads only 1 entry per persona. */
export function getPersonaHealthSummary(): { personaId: string; lastRunSuccess: boolean }[] {
  let files: string[] = []
  try {
    files = readdirSync(colonyPaths.root).filter(f => f.startsWith('persona-run-history-') && f.endsWith('.json'))
  } catch { return [] }

  const results: { personaId: string; lastRunSuccess: boolean }[] = []
  for (const file of files) {
    const personaId = file.replace('persona-run-history-', '').replace('.json', '')
    try {
      const raw = readFileSync(join(colonyPaths.root, file), 'utf-8')
      const entries = JSON.parse(raw)
      if (Array.isArray(entries) && entries.length > 0) {
        results.push({ personaId, lastRunSuccess: !!entries[0].success })
      }
    } catch { /* skip corrupt */ }
  }
  return results
}

/** Aggregate daily cost across all personas for the last 7 days. */
export function getColonyCostTrend(): DailyCostEntry[] {
  // Discover all persona run history files
  let files: string[] = []
  try {
    files = readdirSync(colonyPaths.root).filter(f => f.startsWith('persona-run-history-') && f.endsWith('.json'))
  } catch { return [] }

  // Collect all runs from all personas
  const allRuns: PersonaRunEntry[] = []
  for (const file of files) {
    try {
      const raw = readFileSync(join(colonyPaths.root, file), 'utf-8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) allRuns.push(...parsed)
    } catch { /* skip corrupt */ }
  }

  // Group by date for last 7 days
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const result: DailyCostEntry[] = []
  for (let d = 6; d >= 0; d--) {
    const dayStart = now - (d + 1) * dayMs
    const dayEnd = now - d * dayMs
    const date = new Date(dayEnd).toISOString().slice(0, 10)
    const cost = Math.round(
      allRuns
        .filter(r => { const t = new Date(r.timestamp).getTime(); return t >= dayStart && t < dayEnd })
        .reduce((s, r) => s + (r.costUsd ?? 0), 0) * 100
    ) / 100
    result.push({ date, cost })
  }
  return result
}
