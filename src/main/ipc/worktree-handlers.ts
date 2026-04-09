import { ipcMain } from 'electron'
import {
  createWorktree,
  listWorktrees,
  getWorktree,
  mountWorktree,
  unmountWorktree,
  removeWorktree,
  getWorktreesForEnv,
} from '../worktree-manager'

export function registerWorktreeHandlers(): void {
  ipcMain.handle('worktree:list', () => listWorktrees())

  ipcMain.handle('worktree:get', (_e, id: string) => getWorktree(id))

  ipcMain.handle('worktree:create', async (
    _e,
    owner: string,
    name: string,
    branch: string,
    repoAlias: string,
    remoteUrl?: string,
  ) => {
    return createWorktree(owner, name, branch, repoAlias, remoteUrl)
  })

  ipcMain.handle('worktree:mount', async (_e, worktreeId: string, envId: string) => {
    return mountWorktree(worktreeId, envId)
  })

  ipcMain.handle('worktree:unmount', async (_e, worktreeId: string) => {
    return unmountWorktree(worktreeId)
  })

  ipcMain.handle('worktree:remove', async (_e, worktreeId: string) => {
    await removeWorktree(worktreeId)
    return true
  })

  ipcMain.handle('worktree:forEnv', (_e, envId: string) => getWorktreesForEnv(envId))
}
