/**
 * IPC handlers for cost governance operations.
 * Provides governance:* namespace for:
 * - Reading/writing quotas
 * - Querying audit log
 * - Exporting compliance reports
 * - Checking quota status
 */

import { ipcMain } from 'electron'
import {
  loadQuotas,
  saveQuotas,
  readAuditLog,
  exportAuditCsv,
  checkQuotaStatus,
  getTeamProjectSpend,
  getTeamSpend,
  ensureQuotasExist,
} from '../cost-governance'
import { CostQuotas, CostAuditEntry } from '../../shared/types'

export function registerGovernanceHandlers(): void {
  // Ensure quotas file exists on first run
  ensureQuotasExist()

  /**
   * Get current quotas
   */
  ipcMain.handle('governance:getQuotas', (): CostQuotas => {
    return loadQuotas()
  })

  /**
   * Save quotas from UI
   */
  ipcMain.handle('governance:saveQuotas', (_e, quotas: CostQuotas): boolean => {
    saveQuotas(quotas)
    return true
  })

  /**
   * Read audit log with optional filters
   */
  ipcMain.handle(
    'governance:auditLog',
    (
      _e,
      filters?: {
        startDate?: string
        endDate?: string
        teamId?: string
        projectId?: string
        status?: string
        limit?: number
      }
    ): CostAuditEntry[] => {
      const parsedFilters = filters
        ? {
            startDate: filters.startDate ? new Date(filters.startDate) : undefined,
            endDate: filters.endDate ? new Date(filters.endDate) : undefined,
            teamId: filters.teamId,
            projectId: filters.projectId,
            status: filters.status,
            limit: filters.limit,
          }
        : undefined

      return readAuditLog(parsedFilters)
    }
  )

  /**
   * Export audit log as CSV
   */
  ipcMain.handle('governance:exportCsv', (): string => {
    return exportAuditCsv()
  })

  /**
   * Get current spend for a team/project (default 30-day window)
   */
  ipcMain.handle(
    'governance:getSpend',
    (_e, teamId: string, projectId: string, windowDays?: number): number => {
      return getTeamProjectSpend(teamId, projectId, windowDays)
    }
  )

  /**
   * Get current spend for a team (default 30-day window)
   */
  ipcMain.handle('governance:getTeamSpend', (_e, teamId: string, windowDays?: number): number => {
    return getTeamSpend(teamId, windowDays)
  })

  /**
   * Check quota status for a hypothetical action
   */
  ipcMain.handle(
    'governance:checkQuotaStatus',
    (
      _e,
      teamId: string,
      projectId: string,
      agentId: string | undefined,
      costUsd?: number
    ): ReturnType<typeof checkQuotaStatus> => {
      return checkQuotaStatus(teamId, projectId, agentId, costUsd ?? 0, 0)
    }
  )
}
