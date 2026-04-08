/**
 * Team Telemetry — track worker session metrics for team performance analysis.
 *
 * Writes to ~/.claude-colony/team-metrics.jsonl (append-only, trimmed to 90 days).
 * Aggregates on demand into 7d/30d rolling windows with per-worker stats.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import { colonyPaths } from '../shared/colony-paths'
import type { TeamMetricsEntry, TeamMetrics, WorkerStats } from '../shared/types'

const METRICS_PATH = join(colonyPaths.root, 'team-metrics.jsonl')
const RETENTION_DAYS = 90

/**
 * Extract worker ID from session name (e.g., "Worker: deploy-service" → "deploy-service").
 * If name doesn't match pattern, use full name; if null, use fallback.
 */
function extractWorkerId(sessionName: string | null): string {
  if (!sessionName) return 'unknown'
  const match = sessionName.match(/^Worker:\s*(.+)$/)
  return match ? match[1].trim() : sessionName
}

/**
 * Record a worker session exit as a metrics entry.
 */
export function recordWorkerExit(
  sessionName: string | null,
  sessionId: string | undefined,
  exitCode: number | null,
  durationMs: number,
  costUsd: number,
): void {
  const workerId = extractWorkerId(sessionName)
  const entry: TeamMetricsEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    workerId,
    status: exitCode === 0 ? 'success' : 'failed',
    durationMs,
    costUsd,
    sessionId,
  }

  try {
    appendFileSync(METRICS_PATH, JSON.stringify(entry) + '\n', 'utf-8')
    // Trim to 90 days on every append (lightweight filter)
    trimToRetention()
  } catch (err) {
    console.error('[team-metrics] Failed to record worker exit:', err)
  }
}

/**
 * Load all metrics entries from the JSONL file.
 */
function loadAllEntries(): TeamMetricsEntry[] {
  if (!existsSync(METRICS_PATH)) return []
  try {
    const content = readFileSync(METRICS_PATH, 'utf-8')
    return content
      .trim()
      .split('\n')
      .filter(line => line.trim())
      .map(line => {
        try {
          return JSON.parse(line) as TeamMetricsEntry
        } catch {
          return null
        }
      })
      .filter((entry): entry is TeamMetricsEntry => entry !== null)
  } catch {
    return []
  }
}

/**
 * Remove entries older than RETENTION_DAYS.
 */
function trimToRetention(): void {
  const entries = loadAllEntries()
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000
  const kept = entries.filter(e => new Date(e.timestamp).getTime() > cutoff)

  if (kept.length < entries.length) {
    try {
      writeFileSync(METRICS_PATH, kept.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf-8')
    } catch (err) {
      console.error('[team-metrics] Failed to trim file:', err)
    }
  }
}

/**
 * Filter entries by time window (e.g., "7d", "30d").
 */
function filterByWindow(entries: TeamMetricsEntry[], window: '7d' | '30d'): TeamMetricsEntry[] {
  const days = window === '7d' ? 7 : 30
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000
  return entries.filter(e => new Date(e.timestamp).getTime() > cutoff)
}

/**
 * Compute aggregated metrics for a given time window.
 */
export function getTeamMetrics(window: '7d' | '30d' = '7d'): TeamMetrics {
  const allEntries = loadAllEntries()
  const windowEntries = filterByWindow(allEntries, window)

  if (windowEntries.length === 0) {
    return {
      window,
      generatedAt: new Date().toISOString(),
      teamSuccessRate: 0,
      avgDurationMs: 0,
      totalCostYtd: 0,
      activeWorkerCount: 0,
      workers: [],
    }
  }

  // Team-level aggregates
  const successCount = windowEntries.filter(e => e.status === 'success').length
  const teamSuccessRate = (successCount / windowEntries.length) * 100
  const avgDurationMs = Math.round(
    windowEntries.reduce((sum, e) => sum + e.durationMs, 0) / windowEntries.length,
  )

  // Year-to-date cost (all entries, no filter)
  const totalCostYtd = allEntries.reduce((sum, e) => sum + e.costUsd, 0)

  // Per-worker aggregates
  const workerMap = new Map<string, TeamMetricsEntry[]>()
  windowEntries.forEach(e => {
    if (!workerMap.has(e.workerId)) {
      workerMap.set(e.workerId, [])
    }
    workerMap.get(e.workerId)!.push(e)
  })

  const workers: WorkerStats[] = Array.from(workerMap.entries())
    .map(([workerId, entries]) => {
      const successCount = entries.filter(e => e.status === 'success').length
      const successRate = (successCount / entries.length) * 100
      const avgDuration = Math.round(entries.reduce((sum, e) => sum + e.durationMs, 0) / entries.length)
      const totalCost = entries.reduce((sum, e) => sum + e.costUsd, 0)
      const lastRun = entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0]

      return {
        workerId,
        runsCount: entries.length,
        successRate: Math.round(successRate * 100) / 100,
        avgDurationMs: avgDuration,
        totalCostUsd: Math.round(totalCost * 100) / 100,
        lastRunAt: lastRun?.timestamp ?? null,
      }
    })
    .sort((a, b) => b.runsCount - a.runsCount) // descending by runs count

  return {
    window,
    generatedAt: new Date().toISOString(),
    teamSuccessRate: Math.round(teamSuccessRate * 100) / 100,
    avgDurationMs,
    totalCostYtd: Math.round(totalCostYtd * 100) / 100,
    activeWorkerCount: workers.length,
    workers,
  }
}

/**
 * Get historical runs for a specific worker, optionally filtered by status.
 */
export function getWorkerHistory(
  workerId: string,
  limit = 20,
  status?: 'success' | 'failed',
): TeamMetricsEntry[] {
  const allEntries = loadAllEntries()
  let filtered = allEntries.filter(e => e.workerId === workerId)
  if (status) filtered = filtered.filter(e => e.status === status)
  return filtered
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, limit)
}

/**
 * Export metrics as CSV (for download).
 */
export function exportMetricsAsCsv(window: '7d' | '30d' = '7d'): string {
  const metrics = getTeamMetrics(window)
  const lines = [
    'Worker ID,Runs,Success Rate (%),Avg Duration (ms),Total Cost (USD),Last Run',
    ...metrics.workers.map(w =>
      [
        w.workerId,
        w.runsCount,
        w.successRate.toFixed(2),
        w.avgDurationMs,
        w.totalCostUsd.toFixed(4),
        w.lastRunAt || 'Never',
      ].join(','),
    ),
  ]
  return lines.join('\n')
}
