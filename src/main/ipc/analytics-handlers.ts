import { ipcMain } from 'electron'
import * as fs from 'fs'
import * as path from 'path'
import { colonyPaths } from '../../shared/colony-paths'
import { getAllInstances } from '../instance-manager'
import type { AnalyticsSummary } from '../../shared/types'

/**
 * Get analytics summary for the last 7 days.
 * Aggregates data from:
 * - getAllInstances() for session costs
 * - commit-attribution.json for AI commit count
 * - pipeline run history for success rate
 */
export function getAnalyticsSummary(): AnalyticsSummary {
  const now = Date.now()
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000
  const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000
  const sevenDaysAgo = now - sevenDaysMs
  const fourteenDaysAgo = now - fourteenDaysMs

  // --- Session costs (last 7 days) ---
  const instances = getAllInstances()
  if (!Array.isArray(instances)) {
    // Return safe defaults if instances is not an array
    return {
      sessionCount: 0,
      sessionCountDelta: 0,
      totalCost: 0,
      totalCostDelta: 0,
      aiCommitCount: 0,
      pipelineSuccessRate: 0,
      topSpenders: [],
      dailyCosts: Array(7).fill(0),
    }
  }
  const exited = instances.filter((i) => i.status === 'exited')

  const sessionsLast7 = exited.filter((i) => {
    const ts = new Date(i.createdAt).getTime()
    return ts >= sevenDaysAgo
  })
  const sessionsLast14 = exited.filter((i) => {
    const ts = new Date(i.createdAt).getTime()
    return ts >= fourteenDaysAgo && ts < sevenDaysAgo
  })

  const sessionCount = sessionsLast7.length
  const sessionCountDelta = sessionCount - sessionsLast14.length

  const totalCost = sessionsLast7.reduce((sum, i) => sum + i.tokenUsage.cost, 0)
  const totalCostLast14 = sessionsLast14.reduce((sum, i) => sum + i.tokenUsage.cost, 0)
  const totalCostDelta = totalCost - totalCostLast14

  // Top 5 spenders (by persona name from instance name, or session name)
  const spenderMap = new Map<string, number>()
  for (const inst of sessionsLast7) {
    const label = inst.name
    spenderMap.set(label, (spenderMap.get(label) ?? 0) + inst.tokenUsage.cost)
  }
  const topSpenders = Array.from(spenderMap.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, cost]) => ({ label, cost }))

  // Daily costs for last 7 days
  const dailyCosts = calculateDailyCosts(sessionsLast7, now)

  // --- AI commits (last 7 days) ---
  let aiCommitCount = 0
  let commitPercentage: number | undefined
  try {
    if (fs.existsSync(colonyPaths.commitAttributionJson)) {
      const attrs = JSON.parse(fs.readFileSync(colonyPaths.commitAttributionJson, 'utf-8'))
      const aiCommits = attrs.filter((a: any) => {
        const ts = a.startedAt ?? 0
        return ts >= sevenDaysAgo
      })
      aiCommitCount = aiCommits.length

      // Try to read total commit count if available (this would require a repo check)
      // For now, we'll just show the AI commit count without percentage
    }
  } catch {
    // ignore
  }

  // --- Pipeline success rate (last 7 days) ---
  let pipelineSuccessRate = 0
  try {
    const historyDir = colonyPaths.pipelineRunHistory
    if (fs.existsSync(historyDir)) {
      let totalRuns = 0
      let successfulRuns = 0

      const files = fs.readdirSync(historyDir)
      for (const file of files) {
        try {
          const content = fs.readFileSync(path.join(historyDir, file), 'utf-8')
          const runs = JSON.parse(content)
          if (Array.isArray(runs)) {
            for (const run of runs) {
              const ts = new Date(run.completedAt ?? run.startedAt).getTime()
              if (ts >= sevenDaysAgo) {
                totalRuns++
                if (run.status === 'success') successfulRuns++
              }
            }
          }
        } catch {
          // ignore parse errors
        }
      }

      if (totalRuns > 0) {
        pipelineSuccessRate = successfulRuns / totalRuns
      }
    }
  } catch {
    // ignore
  }

  return {
    sessionCount,
    sessionCountDelta,
    totalCost,
    totalCostDelta,
    aiCommitCount,
    commitPercentage,
    pipelineSuccessRate,
    topSpenders,
    dailyCosts,
  }
}

/**
 * Calculate daily costs for the last 7 days (oldest to newest).
 * Returns array of 7 numbers representing costs for each day.
 */
function calculateDailyCosts(sessions: any[], now: number): number[] {
  const dailyCosts: number[] = Array(7).fill(0)
  const oneDayMs = 24 * 60 * 60 * 1000

  for (const session of sessions) {
    const ts = new Date(session.createdAt).getTime()
    const daysAgo = Math.floor((now - ts) / oneDayMs)
    if (daysAgo >= 0 && daysAgo < 7) {
      const idx = 6 - daysAgo // reverse: index 0 = 7 days ago, index 6 = today
      dailyCosts[idx] += session.tokenUsage.cost
    }
  }

  return dailyCosts
}

export function registerAnalyticsHandlers(): void {
  ipcMain.handle('analytics:getSummary', () => {
    return getAnalyticsSummary()
  })
}
