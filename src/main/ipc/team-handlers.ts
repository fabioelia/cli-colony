/**
 * IPC handlers for team metrics queries.
 */

import { ipcMain } from 'electron'
import { getTeamMetrics, getWorkerHistory, exportMetricsAsCsv } from '../team-metrics'

export function registerTeamHandlers(): void {
  ipcMain.handle('team:getMetrics', (_event, window: '7d' | '30d' = '7d') => {
    return getTeamMetrics(window)
  })

  ipcMain.handle('team:getWorkerHistory', (_event, workerId: string, limit = 20, status?: 'success' | 'failed') => {
    return getWorkerHistory(workerId, limit, status)
  })

  ipcMain.handle('team:exportCsv', (_event, window: '7d' | '30d' = '7d') => {
    return exportMetricsAsCsv(window)
  })
}
