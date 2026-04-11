import { ipcMain } from 'electron'
import { promises as fsp } from 'fs'
import { promisify } from 'util'
import { execFile } from 'child_process'
import { join } from 'path'
import { readArenaStats, writeArenaStats, readMatchHistory, appendMatchRecord, clearMatchHistory } from '../arena-stats'
import type { ArenaMatchRecord } from '../../shared/types'
import { createWorktree, removeWorktree } from '../worktree-manager'
import { createInstance } from '../instance-manager'
import { sendPromptWhenReady } from '../send-prompt-when-ready'
import { getDaemonClient } from '../daemon-client'
import { waitForSessionCompletion } from '../session-completion'
import { colonyPaths } from '../../shared/colony-paths'

const execFileAsync = promisify(execFile)
const MAX_DIFF_BYTES = 8 * 1024 // 8KB per pane

export function registerArenaHandlers(): void {
  ipcMain.handle('arena:recordWinner', async (
    _e,
    winnerKey: string,
    loserKey: string | string[],
    matchCtx?: { prompt?: string; judgeType?: 'manual' | 'command' | 'llm'; models?: (string | null)[] },
  ): Promise<boolean> => {
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

      // Append match record
      const participants = [winnerKey, ...loserKeys].map((name, i) => ({
        name,
        model: matchCtx?.models?.[i] ?? undefined,
      }))
      const record: ArenaMatchRecord = {
        id: `match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: new Date().toISOString(),
        prompt: matchCtx?.prompt,
        participants,
        winnerId: winnerKey,
        winnerName: winnerKey,
        judgeType: matchCtx?.judgeType ?? 'manual',
      }
      await appendMatchRecord(record)

      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('arena:getStats', () => readArenaStats())

  ipcMain.handle('arena:getMatchHistory', () => readMatchHistory())

  ipcMain.handle('arena:clearStats', async (): Promise<void> => {
    await writeArenaStats({})
    await clearMatchHistory()
  })

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

      // Record stats (skip if session name unavailable to avoid UUID keys)
      if (winnerId) {
        try {
          const stats = await readArenaStats()
          const winner = await getDaemonClient().getInstance(winnerId)
          if (winner?.name) {
            const winnerKey = winner.name
            if (!stats[winnerKey]) stats[winnerKey] = { wins: 0, losses: 0, totalRuns: 0 }
            stats[winnerKey].wins++
            stats[winnerKey].totalRuns++
            const allParticipants: Array<{ name: string; instanceId: string }> = [{ name: winnerKey, instanceId: winnerId }]
            for (const r of results) {
              if (r.instanceId === winnerId) continue
              const loser = await getDaemonClient().getInstance(r.instanceId)
              if (!loser?.name) continue
              const loserKey = loser.name
              if (!stats[loserKey]) stats[loserKey] = { wins: 0, losses: 0, totalRuns: 0 }
              stats[loserKey].losses++
              stats[loserKey].totalRuns++
              allParticipants.push({ name: loserKey, instanceId: r.instanceId })
            }
            await writeArenaStats(stats)

            // Append match record
            await appendMatchRecord({
              id: `match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              timestamp: new Date().toISOString(),
              participants: allParticipants,
              winnerId: winnerKey,
              winnerName: winnerKey,
              judgeType: 'command',
              verdictText: results.map(r => `${allParticipants.find(p => p.instanceId === r.instanceId)?.name ?? r.instanceId}: exit ${r.exitCode}`).join('; '),
            })
          }
        } catch { /* stats are best-effort */ }
      }
      return { winnerId, results }
    }

    // LLM judge: launch a judge session with each pane's git diff
    const diffs: string[] = []
    let firstDir = '.'
    for (let i = 0; i < instanceIds.length; i++) {
      const inst = await getDaemonClient().getInstance(instanceIds[i])
      const cwd = inst?.workingDirectory || '.'
      if (i === 0) firstDir = cwd
      try {
        const { stdout } = await execFileAsync('git', ['diff', 'HEAD'], {
          cwd, timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
        })
        const trimmed = stdout.length > MAX_DIFF_BYTES
          ? stdout.slice(0, MAX_DIFF_BYTES) + '\n[...truncated]'
          : stdout
        diffs.push(trimmed || '(no changes)')
      } catch {
        diffs.push('(git diff failed)')
      }
    }

    const diffSections = diffs.map((d, i) => `Pane ${i + 1} diff:\n\`\`\`\n${d}\n\`\`\``).join('\n\n')
    const verdictDir = join(colonyPaths.root, 'artifacts')
    const verdictPath = join(verdictDir, 'arena-judge-verdict.txt')
    await fsp.mkdir(verdictDir, { recursive: true })

    const judgePrompt = `You are judging an arena competition between ${instanceIds.length} agents.

${judgeConfig.prompt}

${diffSections}

After evaluating, write your verdict to a file at ${verdictPath} containing WINNER: <pane-number> (e.g., WINNER: 1). Then explain your reasoning.`

    const judgeInst = await createInstance({
      name: 'Arena Judge',
      workingDirectory: firstDir,
    })

    const completionPromise = waitForSessionCompletion(judgeInst.id, 600_000)
    sendPromptWhenReady(judgeInst.id, { prompt: judgePrompt })
    const completed = await completionPromise

    let winnerId: string | null = null
    let verdictText: string | null = null
    if (completed) {
      try {
        const verdict = await fsp.readFile(verdictPath, 'utf-8')
        verdictText = verdict
        const match = verdict.match(/WINNER:\s*(\d+)/i)
        if (match) {
          const paneIdx = parseInt(match[1], 10) - 1
          if (paneIdx >= 0 && paneIdx < instanceIds.length) {
            winnerId = instanceIds[paneIdx]
          }
        }
      } catch { /* verdict file missing or unreadable */ }
      // Clean up verdict file
      try { await fsp.unlink(verdictPath) } catch { /* ok */ }
    }

    // Record stats
    if (winnerId) {
      try {
        const stats = await readArenaStats()
        const winner = await getDaemonClient().getInstance(winnerId)
        const winnerKey = winner?.name || winnerId
        if (!stats[winnerKey]) stats[winnerKey] = { wins: 0, losses: 0, totalRuns: 0 }
        stats[winnerKey].wins++
        stats[winnerKey].totalRuns++
        const allParticipants: Array<{ name: string; instanceId: string }> = [{ name: winnerKey, instanceId: winnerId }]
        for (const instId of instanceIds) {
          if (instId === winnerId) continue
          const loser = await getDaemonClient().getInstance(instId)
          const loserKey = loser?.name || instId
          if (!stats[loserKey]) stats[loserKey] = { wins: 0, losses: 0, totalRuns: 0 }
          stats[loserKey].losses++
          stats[loserKey].totalRuns++
          allParticipants.push({ name: loserKey, instanceId: instId })
        }
        await writeArenaStats(stats)

        // Append match record with LLM verdict
        await appendMatchRecord({
          id: `match-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: new Date().toISOString(),
          prompt: judgeConfig.prompt,
          participants: allParticipants,
          winnerId: winnerKey,
          winnerName: winnerKey,
          judgeType: 'llm',
          verdictText: verdictText ?? undefined,
        })
      } catch { /* stats are best-effort */ }
    }

    return { winnerId, results: [], verdictText }
  })
}
