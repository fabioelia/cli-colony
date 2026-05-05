import { ipcMain } from 'electron'
import { getTagRules, saveTagRules } from '../tag-rules'
import type { TagRule } from '../../shared/types'

export function registerTagRuleHandlers(): void {
  ipcMain.handle('tags:getRules', async () => {
    return getTagRules()
  })

  ipcMain.handle('tags:saveRules', async (_e, rules: TagRule[]) => {
    await saveTagRules(rules)
    return true
  })
}
