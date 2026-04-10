import { ipcMain } from 'electron'
import { promisify } from 'util'
import { execFile } from 'child_process'
import { readArenaStats, writeArenaStats } from '../arena-stats'
import { createWorktree, removeWorktree } from '../worktree-manager'
import { createInstance } from '../instance-manager'
import { sendPromptWhenReady } from '../send-prompt-when-ready'
import { getDaemonClient } from '../daemon-client'

const execFileAsync = promisify(execFile)

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

  /**
   * Auto-judge: run a command in each arena session's working directory.
   * Winner = first instance whose command exits with code 0.
   * Returns the winner instance ID, or null if no clear winner.
   */
  ipcMain.handle('arena:autoJudge', async (
    _e,
    opts: {
      instanceIds: string[]
      judgeConfig: { type: 'command'; cmd: string } | { type: 'llm'; prompt: string }
    },
  ): Promise<{ winnerId: string | null; results: Array<{ instanceId: string; exitCode: number; stdout: string }> }> => {
    const { instanceIds, judgeConfig } = opts

    if (judgeConfig.type === 'command') {
      const results: Array<{ instanceId: string; exitCode: number; stdout: string }> = []
      for (const instId of instanceIds) {
        const inst = await getDaemonClient().getInstance(instId)
        const cwd = inst?.workingDirectory || '.'
        try {
          const { stdout } = await execFileAsync('sh', ['-c', judgeConfig.cmd], {
            cwd,
            timeout: 300_000,
            maxBuffer: 2 * 1024 * 1024,
          })
          results.push({ instanceId: instId, exitCode: 0, stdout: stdout.trim() })
        } catch (err: any) {
          results.push({
            instanceId: instId,
            exitCode: err?.code ?? 1,
            stdout: (err?.stdout || '').trim(),
          })
        }
      }
      // Winner: first with exit code 0; if none, first with lowest exit code
      const cleanIdx = results.findIndex(r => r.exitCode === 0)
      const winnerIdx = cleanIdx >= 0
        ? cleanIdx
        : results.reduce((best, r, i) => r.exitCode < results[best].exitCode ? i : best, 0)
      const winnerId = results[winnerIdx]?.instanceId ?? null

      // Record stats
      if (winnerId) {
        try {
          const stats = await readArenaStats()
          const winner = await getDaemonClient().getInstance(winnerId)
          const winnerKey = winner?.name || winnerId
          if (!stats[winnerKey]) stats[winnerKey] = { wins: 0, losses: 0, totalRuns: 0 }
          stats[winnerKey].wins++
          stats[winnerKey].totalRuns++
          for (const r of results) {
            if (r.instanceId === winnerId) continue
            const loser = await getDaemonClient().getInstance(r.instanceId)
            const loserKey = loser?.name || r.instanceId
            if (!stats[loserKey]) stats[loserKey] = { wins: 0, losses: 0, totalRuns: 0 }
            stats[loserKey].losses++
            stats[loserKey].totalRuns++
          }
          await writeArenaStats(stats)
        } catch { /* stats are best-effort */ }
      }
      return { winnerId, results }
    }

    // LLM judge: not yet implemented in arena UI — pipeline-only for now
    return { winnerId: null, results: [] }
  })
}
