import { ipcMain } from 'electron'
import { getAttributedCommits, clearAttributions } from '../commit-attributor'
import type { CommitAttribution } from '../../shared/types'

export function registerCommitAttributorHandlers(): void {
  ipcMain.handle('session:getAttributedCommits', (_e, dir?: string): CommitAttribution[] => {
    return getAttributedCommits(dir)
  })
  ipcMain.handle('session:clearCommitAttributions', (): void => {
    clearAttributions()
  })
}
