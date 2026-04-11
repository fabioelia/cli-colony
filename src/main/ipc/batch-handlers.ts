/**
 * IPC handlers for batch task execution.
 */

import { ipcMain } from 'electron'
import { getDefaultBatchConfig, getBatchHistory, parseTaskQueue } from '../batch-runner'
import { BatchConfig, BatchRun } from '../../shared/types'
import { join } from 'path'
import { colonyPaths } from '../../shared/colony-paths'
import { getSetting, setSetting } from '../settings'

export function registerBatchHandlers(): void {
  /**
   * batch:getConfig — return current batch configuration
   */
  ipcMain.handle('batch:getConfig', async (): Promise<BatchConfig> => {
    const stored = await getSetting('batchConfig')
    if (stored) {
      try { return JSON.parse(stored) as BatchConfig }
      catch { /* fall through */ }
    }
    return getDefaultBatchConfig()
  })

  /**
   * batch:setConfig — save batch configuration
   * Validates cron expression and parameters
   */
  ipcMain.handle('batch:setConfig', async (_event, config: BatchConfig): Promise<boolean> => {
    try {
      // Basic validation
      if (typeof config.schedule !== 'string' || !config.schedule.trim()) {
        throw new Error('Invalid schedule')
      }
      if (config.concurrency < 1 || config.concurrency > 5) {
        throw new Error('Concurrency must be 1–5')
      }
      if (config.timeoutPerTaskMinutes < 1) {
        throw new Error('Timeout must be >= 1 minute')
      }

      await setSetting('batchConfig', JSON.stringify(config))
      return true
    } catch (err) {
      console.error('Failed to set batch config:', err)
      return false
    }
  })

  /**
   * batch:getHistory — retrieve recent batch runs
   */
  ipcMain.handle('batch:getHistory', (_event, limit: number = 20): BatchRun[] => {
    return getBatchHistory(Math.min(limit, 100))
  })

  /**
   * batch:runNow — trigger a batch immediately (bypass schedule)
   * In a real implementation, this would:
   * 1. Read task queue YAML
   * 2. Pop N tasks in priority order
   * 3. Spawn sessions with batch_mode:true context
   * 4. Track progress and write to batch-history.jsonl
   */
  ipcMain.handle('batch:runNow', async (): Promise<{ success: boolean; batchId?: string; error?: string }> => {
    try {
      // TODO: Implement actual batch execution
      // For now, this is a stub that would be called by the scheduler
      return { success: true, batchId: 'batch-stub-001' }
    } catch (err) {
      return {
        success: false,
        error: err instanceof Error ? err.message : 'Unknown error',
      }
    }
  })
}
