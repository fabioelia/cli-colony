import { ipcMain } from 'electron'
import { readArenaStats, writeArenaStats } from '../arena-stats'
import { createWorktree, removeWorktree } from '../worktree-manager'
import { createInstance } from '../instance-manager'
import { sendPromptWhenReady } from '../send-prompt-when-ready'

export function registerArenaHandlers(): void {
  ipcMain.handle('arena:recordWinner', async (_e, winnerKey: string, loserKey: string | string[]): Promise<boolean> => {
    try {
      const stats = await readArenaStats()
      const loserKeys = Array.isArray(loserKey) ? loserKey : [loserKey]
      if (!stats[winnerKey]) stats[winnerKey] = { wins: 0, losses: 0, totalRuns: 0 }
      stats[winnerKey].wins++
      stats[winnerKey].totalRuns++
      for (const lk of loserKeys) {
        if (!stats[lk]) stats[lk] = { wins: 0, losses: 0, totalRuns: 0 }
        stats[lk].losses++
        stats[lk].totalRuns++
      }
      await writeArenaStats(stats)
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('arena:getStats', () => readArenaStats())

  /**
   * Launch N worktrees + N sessions for an arena round.
   * Returns the created instance IDs and worktree IDs so the renderer can populate the grid.
   */
  ipcMain.handle('arena:launchWithWorktrees', async (
    _e,
    opts: {
      owner: string
      repoName: string
      branch: string
      count: number
      prompt?: string
      models?: (string | null)[]
    },
  ): Promise<{ instances: string[]; worktrees: string[] }> => {
    const { owner, repoName, branch, count, prompt, models } = opts
    const clamp = Math.max(2, Math.min(4, count))
    const instanceIds: string[] = []
    const worktreeIds: string[] = []

    for (let i = 0; i < clamp; i++) {
      const wt = await createWorktree(owner, repoName, branch, `arena-${i + 1}`)
      worktreeIds.push(wt.id)

      const model = models?.[i] ?? undefined
      const inst = await createInstance({
        name: `Arena ${i + 1}`,
        workingDirectory: wt.path,
        ...(model ? { args: ['--model', model] } : {}),
      })
      instanceIds.push(inst.id)

      // Queue prompt delivery for this session once it's ready
      if (prompt) {
        sendPromptWhenReady(inst.id, { prompt })
      }
    }

    return { instances: instanceIds, worktrees: worktreeIds }
  })

  /**
   * Clean up arena worktrees by ID list.
   */
  ipcMain.handle('arena:cleanupWorktrees', async (_e, worktreeIds: string[]): Promise<number> => {
    let removed = 0
    for (const id of worktreeIds) {
      try {
        await removeWorktree(id)
        removed++
      } catch (err) {
        console.warn(`[arena] failed to remove worktree ${id}:`, err)
      }
    }
    return removed
  })
}
