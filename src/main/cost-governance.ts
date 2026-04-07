/**
 * Cost governance module for EU AI Act compliance.
 *
 * Manages:
 * - Hierarchical cost quotas (teams → projects → agents)
 * - Append-only audit log (cost-audit.jsonl)
 * - Quota threshold checks (warn/block)
 * - Per-session and per-team/project spend tracking
 */

import * as fs from 'fs'
import * as path from 'path'
import { colonyPaths } from '../shared/colony-paths'
import { CostQuotaEntry, CostQuotas, CostAuditEntry, CostAuditStatus } from '../shared/types'

// In-memory cache of quotas
let _quotasCache: CostQuotas | null = null
let _quotasCacheMtime = 0

/**
 * Load quotas from disk, with file-based caching
 */
export function loadQuotas(): CostQuotas {
  try {
    const quotasPath = colonyPaths.costQuotasJson
    if (!fs.existsSync(quotasPath)) {
      return getDefaultQuotas()
    }

    const stat = fs.statSync(quotasPath)
    if (_quotasCache && stat.mtimeMs === _quotasCacheMtime) {
      return _quotasCache
    }

    const content = fs.readFileSync(quotasPath, 'utf-8')
    const quotas = JSON.parse(content) as CostQuotas
    _quotasCache = quotas
    _quotasCacheMtime = stat.mtimeMs
    return quotas
  } catch (error) {
    console.error('[cost-governance] Failed to load quotas:', error)
    return getDefaultQuotas()
  }
}

/**
 * Save quotas to disk and invalidate cache
 */
export function saveQuotas(quotas: CostQuotas): void {
  try {
    const quotasPath = colonyPaths.costQuotasJson
    const dir = path.dirname(quotasPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    quotas.metadata.lastUpdated = new Date().toISOString()
    fs.writeFileSync(quotasPath, JSON.stringify(quotas, null, 2))
    _quotasCache = quotas
    _quotasCacheMtime = fs.statSync(quotasPath).mtimeMs
  } catch (error) {
    console.error('[cost-governance] Failed to save quotas:', error)
    throw error
  }
}

/**
 * Get default quotas for a fresh install
 */
function getDefaultQuotas(): CostQuotas {
  return {
    quotas: [
      {
        teamId: 'default',
        projectId: 'ungoverned',
        hardLimitUsd: 1000,
        warnThresholdUsd: 800,
      },
    ],
    metadata: {
      lastUpdated: new Date().toISOString(),
      version: '1.0',
    },
  }
}

/**
 * Check if quotas file exists; create with defaults if not
 */
export function ensureQuotasExist(): void {
  const quotasPath = colonyPaths.costQuotasJson
  if (!fs.existsSync(quotasPath)) {
    const dir = path.dirname(quotasPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
    saveQuotas(getDefaultQuotas())
  }
}

/**
 * Find matching quota entry for a team/project/agent combination
 * Returns the most specific match (agent > project > team level)
 */
function findQuotaEntry(
  teamId: string,
  projectId: string,
  agentId?: string
): CostQuotaEntry | null {
  const quotas = loadQuotas()

  // Try agent-level quota first
  if (agentId) {
    const agentQuota = quotas.quotas.find(
      (q) => q.teamId === teamId && q.projectId === projectId && q.agentId === agentId
    )
    if (agentQuota) return agentQuota
  }

  // Try project-level quota
  const projectQuota = quotas.quotas.find(
    (q) => q.teamId === teamId && q.projectId === projectId && !q.agentId
  )
  if (projectQuota) return projectQuota

  // Try team-level quota
  const teamQuota = quotas.quotas.find(
    (q) => q.teamId === teamId && q.projectId === 'ungoverned' && !q.agentId
  )
  if (teamQuota) return teamQuota

  return null
}

/**
 * Append an entry to the audit log
 */
export function auditLog(entry: CostAuditEntry): void {
  try {
    const logPath = colonyPaths.costAuditLog
    const dir = path.dirname(logPath)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    const jsonLine = JSON.stringify(entry)
    fs.appendFileSync(logPath, jsonLine + '\n')
  } catch (error) {
    console.error('[cost-governance] Failed to append audit log:', error)
  }
}

/**
 * Read audit log entries with optional filtering
 */
export function readAuditLog(filters?: {
  startDate?: Date
  endDate?: Date
  teamId?: string
  projectId?: string
  status?: string
  limit?: number
}): CostAuditEntry[] {
  try {
    const logPath = colonyPaths.costAuditLog
    if (!fs.existsSync(logPath)) {
      return []
    }

    const content = fs.readFileSync(logPath, 'utf-8')
    const lines = content.split('\n').filter((line) => line.trim())

    let entries: CostAuditEntry[] = lines.map((line) => JSON.parse(line) as CostAuditEntry)

    // Apply filters
    if (filters?.startDate) {
      const startMs = filters.startDate.getTime()
      entries = entries.filter((e) => new Date(e.timestamp).getTime() >= startMs)
    }

    if (filters?.endDate) {
      const endMs = filters.endDate.getTime()
      entries = entries.filter((e) => new Date(e.timestamp).getTime() <= endMs)
    }

    if (filters?.teamId) {
      entries = entries.filter((e) => e.teamId === filters.teamId)
    }

    if (filters?.projectId) {
      entries = entries.filter((e) => e.projectId === filters.projectId)
    }

    if (filters?.status) {
      entries = entries.filter((e) => e.status === filters.status)
    }

    // Sort by timestamp (newest first)
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

    // Apply limit (default 1000)
    const limit = filters?.limit ?? 1000
    return entries.slice(0, limit)
  } catch (error) {
    console.error('[cost-governance] Failed to read audit log:', error)
    return []
  }
}

/**
 * Export audit log as CSV string
 */
export function exportAuditCsv(): string {
  const entries = readAuditLog({ limit: 10000 })

  const headers = ['Timestamp', 'Team', 'Project', 'Agent', 'Session', 'Cost (USD)', 'Status', 'Reason']
  const rows = entries.map((e) => [
    e.timestamp,
    e.teamId,
    e.projectId,
    e.agentId || '',
    e.sessionId,
    e.costUsd.toFixed(4),
    e.status,
    e.reason || '',
  ])

  const csv = [headers.join(','), ...rows.map((r) => r.map((cell) => `"${cell}"`).join(','))].join('\n')
  return csv
}

/**
 * Get aggregated spend for a team+project within a time window
 */
export function getTeamProjectSpend(
  teamId: string,
  projectId: string,
  windowDays: number = 30
): number {
  const now = new Date()
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)

  const entries = readAuditLog({
    teamId,
    projectId,
    startDate: windowStart,
  })

  return entries.reduce((sum, e) => sum + e.costUsd, 0)
}

/**
 * Get aggregated spend for a team within a time window
 */
export function getTeamSpend(teamId: string, windowDays: number = 30): number {
  const now = new Date()
  const windowStart = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000)

  const entries = readAuditLog({
    teamId,
    startDate: windowStart,
  })

  return entries.reduce((sum, e) => sum + e.costUsd, 0)
}

/**
 * Check quota status for a team/project/agent
 * Returns: { status, limitUsd, currentSpend, reason }
 */
export function checkQuotaStatus(
  teamId: string,
  projectId: string,
  agentId: string | undefined,
  _costUsd: number,
  _accumulatedSpend: number
): {
  status: CostAuditStatus
  limitUsd: number
  currentSpend: number
  reason: string
} {
  const quota = findQuotaEntry(teamId, projectId, agentId)

  if (!quota) {
    return {
      status: 'OK',
      limitUsd: Infinity,
      currentSpend: 0,
      reason: 'No quota defined',
    }
  }

  const currentSpend = getTeamProjectSpend(teamId, projectId)
  const limitUsd = quota.hardLimitUsd
  const warnThreshold = quota.warnThresholdUsd

  // If warnThreshold is a percentage (0-100), convert to absolute value
  const warnAbsolute = warnThreshold <= 100 ? (limitUsd * warnThreshold) / 100 : warnThreshold

  if (currentSpend >= limitUsd) {
    return {
      status: 'BLOCKED',
      limitUsd,
      currentSpend,
      reason: `Hard limit reached: $${currentSpend.toFixed(2)} >= $${limitUsd.toFixed(2)}`,
    }
  }

  if (currentSpend >= warnAbsolute) {
    return {
      status: 'WARNED',
      limitUsd,
      currentSpend,
      reason: `Approaching limit: $${currentSpend.toFixed(2)} >= $${warnAbsolute.toFixed(2)} (${(
        (currentSpend / limitUsd) *
        100
      ).toFixed(0)}%)`,
    }
  }

  return {
    status: 'OK',
    limitUsd,
    currentSpend,
    reason: `Within limits: $${currentSpend.toFixed(2)} of $${limitUsd.toFixed(2)} (${(
      (currentSpend / limitUsd) *
      100
    ).toFixed(0)}%)`,
  }
}
