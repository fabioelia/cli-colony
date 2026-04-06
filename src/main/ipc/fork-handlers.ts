import { ipcMain } from 'electron'
import {
  getForkGroups,
  createForkGroup,
  pickWinner,
  discardFork,
} from '../fork-manager'
import type { ForkOpts } from '../fork-manager'

export function registerForkHandlers(): void {
  ipcMain.handle('fork:getGroups', () => {
    return getForkGroups()
  })

  ipcMain.handle('fork:create', async (_e, parentId: string, opts: ForkOpts) => {
    return createForkGroup(parentId, opts)
  })

  ipcMain.handle('fork:pickWinner', async (_e, groupId: string, winnerId: string) => {
    await pickWinner(groupId, winnerId)
    return true
  })

  ipcMain.handle('fork:discard', async (_e, groupId: string, forkId: string) => {
    await discardFork(groupId, forkId)
    return true
  })
}
