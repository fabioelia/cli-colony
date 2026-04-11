/**
 * IPC handlers for approval rules management.
 */

import { ipcMain } from 'electron'
import { loadApprovalRules, createRule, updateRule, deleteRule } from '../approval-rules'
import { ApprovalRule, ApprovalRuleType, ApprovalRuleAction } from '../../shared/types'

export function registerApprovalRulesHandlers(): void {
  ipcMain.handle('approvalRules:list', async (): Promise<ApprovalRule[]> => {
    return await loadApprovalRules()
  })

  ipcMain.handle(
    'approvalRules:create',
    async (_e, name: string, type: ApprovalRuleType, condition: string, action: ApprovalRuleAction): Promise<ApprovalRule> => {
      return await createRule(name, type, condition, action)
    }
  )

  ipcMain.handle(
    'approvalRules:update',
    async (_e, id: string, updates: Partial<ApprovalRule>): Promise<boolean> => {
      return await updateRule(id, updates)
    }
  )

  ipcMain.handle('approvalRules:delete', async (_e, id: string): Promise<boolean> => {
    return await deleteRule(id)
  })
}
