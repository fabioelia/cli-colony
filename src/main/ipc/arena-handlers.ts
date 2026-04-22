import { ipcMain } from 'electron'
import { promises as fsp } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { promisify } from 'util'
import { execFile } from 'child_process'
import { resolveCommand } from '../resolve-command'
import { join } from 'path'
import { readArenaStats, writeArenaStats, readMatchHistory, appendMatchRecord, clearMatchHistory, buildJudgeHistorySection } from '../arena-stats'
import { getSetting } from '../settings'
import type { ArenaMatchRecord } from '../../shared/types'
import { getWorktree, createWorktree, removeWorktree } from '../worktree-manager'
import { createInstance } from '../instance-manager'
import { sendPromptWhenReady } from '../send-prompt-when-ready'
import { getDaemonRouter } from '../daemon-router'
import { waitForSessionCompletion } from '../session-completion'
import { colonyPaths } from '../../shared/colony-paths'

const execFileAsync = promisify(execFile)
const MAX_DIFF_BYTES = 8 * 1024 // 8KB per pane

export function registerArenaHandlers(): void {
  ipcMain.handle('arena:recordWinner', async (
    _e,
    winnerKey: string,
    loserKey: string | string[],
    matchCtx?: { prompt?: string; judgeType?: 'manual' | 'command' | 'llm'; models?: (string | null)[]; reason?: string },
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
        reason: matchCtx?.reason,
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
   * Promote arena winner: cherry-pick winner's commits onto a new branch from origin/<sourceBranch>.
   */
  ipcMain.handle('arena:promoteWinner', async (
    _e,
    opts: { winnerWorktreeId: string; loserWorktreeIds: string[]; sourceBranch: string },
  ): Promise<{ success: boolean; commitCount?: number; promotedBranch?: string; error?: string; conflictFiles?: string[] }> => {
    const { winnerWorktreeId, loserWorktreeIds, sourceBranch } = opts

    const info = await getWorktree(winnerWorktreeId)
    if (!info) return { success: false, error: 'Winner worktree not found' }

    const worktreePath = info.path
    const bareRepoPath = info.bareRepoPath

    // Find commits to promote (winner branch commits not in origin/sourceBranch)
    const { stdout: commitsRaw } = await execFileAsync('git', [
      '-C', worktreePath, 'log', '--format=%H', `origin/${sourceBranch}..HEAD`,
    ])
    const commits = commitsRaw.trim().split('\n').filter(Boolean).reverse() // oldest first

    if (commits.length === 0) {
      return { success: false, error: 'Nothing to promote — winner made no changes' }
    }

    // Create a temp worktree from origin/sourceBranch in the system tmp dir
    const promotedBranch = `arena-promote-${Date.now()}`
    const tmpPath = path.join(os.tmpdir(), promotedBranch)
    await execFileAsync('git', ['-C', bareRepoPath, 'worktree', 'add', '-b', promotedBranch, tmpPath, `origin/${sourceBranch}`])

    try {
      await execFileAsync('git', ['-C', tmpPath, 'cherry-pick', ...commits], { timeout: 60_000 })

      // Success — remove temp worktree dir but keep the local branch in bare repo
      await execFileAsync('git', ['-C', bareRepoPath, 'worktree', 'remove', '--force', tmpPath]).catch(() => {})

      // Record promote in stats
      try {
        const stats = await readArenaStats()
        const winner = await getDaemonRouter().getInstance(
          (await execFileAsync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'])).stdout.trim()
        )
        const winnerInst = info.id
        if (winnerInst) {
          const key = `worktree:${winnerInst}`
          if (!stats[key]) stats[key] = { wins: 0, losses: 0, totalRuns: 0, promotes: 0 }
          stats[key].promotes = (stats[key].promotes ?? 0) + 1
          await writeArenaStats(stats)
        }
      } catch { /* non-fatal */ }

      // Clean up loser worktrees
      for (const id of loserWorktreeIds) {
        await removeWorktree(id).catch(() => {})
      }

      return { success: true, commitCount: commits.length, promotedBranch }
    } catch (err: any) {
      const output = (err?.stderr || err?.stdout || '').toString()
      const conflictFiles = [...output.matchAll(/CONFLICT[^:]*: (.+)/g)].map(m => m[1].trim())
      await execFileAsync('git', ['-C', tmpPath, 'cherry-pick', '--abort']).catch(() => {})
      await execFileAsync('git', ['-C', bareRepoPath, 'worktree', 'remove', '--force', tmpPath]).catch(() => {})
      await execFileAsync('git', ['-C', bareRepoPath, 'branch', '-D', promotedBranch]).catch(() => {})
      return { success: false, conflictFiles: conflictFiles.length ? conflictFiles : undefined, error: 'Cherry-pick conflict' }
    }
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
  ): Promise<{ winnerId: string | null; results: Array<{ instanceId: string; exitCode: number; stdout: string }>; verdictText?: string | null }> => {
    const { instanceIds, judgeConfig } = opts

    if (judgeConfig.type === 'command') {
      const results: Array<{ instanceId: string; exitCode: number; stdout: string }> = []
      for (const instId of instanceIds) {
        const inst = await getDaemonRouter().getInstance(instId)
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
          const winner = await getDaemonRouter().getInstance(winnerId)
          if (winner?.name) {
            const winnerKey = winner.name
            if (!stats[winnerKey]) stats[winnerKey] = { wins: 0, losses: 0, totalRuns: 0 }
            stats[winnerKey].wins++
            stats[winnerKey].totalRuns++
            const allParticipants: Array<{ name: string; instanceId: string }> = [{ name: winnerKey, instanceId: winnerId }]
            for (const r of results) {
              if (r.instanceId === winnerId) continue
              const loser = await getDaemonRouter().getInstance(r.instanceId)
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
      const inst = await getDaemonRouter().getInstance(instanceIds[i])
      const cwd = inst?.workingDirectory || '.'
      if (i === 0) firstDir = cwd
      try {
        const { stdout } = await execFileAsync(resolveCommand('git'), ['diff', 'HEAD'], {
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

    const useHistory = (await getSetting('arenaJudgeUseHistory')) !== 'false'
    let historySection = ''
    if (useHistory) {
      const history = await readMatchHistory()
      historySection = buildJudgeHistorySection(history)
    }

    const judgePrompt = `You are judging an arena competition between ${instanceIds.length} agents.

${judgeConfig.prompt}${historySection}

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
        const winner = await getDaemonRouter().getInstance(winnerId)
        const winnerKey = winner?.name || winnerId
        if (!stats[winnerKey]) stats[winnerKey] = { wins: 0, losses: 0, totalRuns: 0 }
        stats[winnerKey].wins++
        stats[winnerKey].totalRuns++
        const allParticipants: Array<{ name: string; instanceId: string }> = [{ name: winnerKey, instanceId: winnerId }]
        for (const instId of instanceIds) {
          if (instId === winnerId) continue
          const loser = await getDaemonRouter().getInstance(instId)
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
