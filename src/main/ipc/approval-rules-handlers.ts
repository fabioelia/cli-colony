/**
 * IPC handlers for approval rules management.
 */

import { ipcMain } from 'electron'
import { loadApprovalRules, createRule, updateRule, deleteRule } from '../approval-rules'
import { ApprovalRule, ApprovalRuleType, ApprovalRuleAction } from '../../shared/types'

export function registerApprovalRulesHandlers(): void {
  ipcMain.handle('approvalRules:list', (): ApprovalRule[] => {
    return loadApprovalRules()
  })

  ipcMain.handle(
    'approvalRules:create',
    (_e, name: string, type: ApprovalRuleType, condition: string, action: ApprovalRuleAction): ApprovalRule => {
      return createRule(name, type, condition, action)
    }
  )

  ipcMain.handle(
    'approvalRules:update',
    (_e, id: string, updates: Partial<ApprovalRule>): boolean => {
      return updateRule(id, updates)
    }
  )

  ipcMain.handle('approvalRules:delete', (_e, id: string): boolean => {
    return deleteRule(id)
  })
}
