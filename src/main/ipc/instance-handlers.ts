import { ipcMain } from 'electron'
import path from 'path'
import { execFile, spawn } from 'child_process'
import { resolveCommand } from '../resolve-command'
import { promisify } from 'util'
import { createHash } from 'crypto'
import { DEFAULT_SCORING_PROMPT } from '../scoring-config'
import type { ScoreCard } from '../../shared/types'
import { getScoreCard, saveScoreCard, clearScoreCard } from '../scorecard-store'

const execFileAsync = promisify(execFile)
import { createShell, writeShell, resizeShell, killShell } from '../shell-pty'
import type { GitDiffEntry } from '../../shared/types'
import { getLiveChanges } from '../git-utils'
import {
  createInstance,
  killInstance,
  restartInstance,
  getAllInstances,
  restartDaemon,
  getDaemonVersion,
  startDaemonUpgrade,
  migrateInstance,
  migrateAllInstances,
  getUpgradeState,
} from '../instance-manager'
import { getDaemonRouter } from '../daemon-router'
import { sendPromptWhenReady } from '../send-prompt-when-ready'
import { stripAnsi } from '../../shared/utils'

export interface ChildProcess {
  pid: number
  name: string
  command: string
  cpu: string
  mem: string
}

export function registerInstanceHandlers(): void {
  ipcMain.handle('instance:create', async (_e, opts) => {
    return createInstance(opts || {})
  })
  const router = getDaemonRouter()
  ipcMain.on('instance:write', async (_e, id: string, data: string) => {
    // Fire-and-forget — don't wait for reply. Keystroke echo doesn't need confirmation.
    router.writeToInstance(id, data).catch(() => {})
  })
  ipcMain.handle('instance:resize', async (_e, id: string, cols: number, rows: number) => {
    try { return await router.resizeInstance(id, cols, rows) } catch { return false }
  })
  ipcMain.handle('instance:kill', async (_e, id: string) => {
    try { return await killInstance(id) } catch { return false }
  })
  ipcMain.handle('instance:remove', async (_e, id: string) => {
    try { return await router.removeInstance(id) } catch { return false }
  })
  ipcMain.handle('instance:rename', async (_e, id: string, name: string) => {
    try { return await router.renameInstance(id, name) } catch { return false }
  })
  ipcMain.handle('instance:recolor', async (_e, id: string, color: string) => {
    try { return await router.recolorInstance(id, color) } catch { return false }
  })
  ipcMain.handle('instance:restart', (_e, id: string) => restartInstance(id))
  ipcMain.handle('instance:pin', async (_e, id: string) => {
    try { return await router.pinInstance(id) } catch { return false }
  })
  ipcMain.handle('instance:unpin', async (_e, id: string) => {
    try { return await router.unpinInstance(id) } catch { return false }
  })
  ipcMain.handle('instance:set-note', async (_e, id: string, note: string) => {
    try { return await router.setNote(id, note) } catch { return false }
  })
  ipcMain.handle('instance:setRole', async (_e, id: string, role: string | null) => {
    try { return await router.setInstanceRole(id, role) } catch { return false }
  })
  ipcMain.handle('instance:list', () => getAllInstances())

  // Kill all running child sessions of a given parent instance
  ipcMain.handle('instance:stopChildren', async (_e, parentId: string) => {
    const all = await getAllInstances()
    const children = all.filter(i => i.parentId === parentId && i.status === 'running')
    await Promise.allSettled(children.map(c => killInstance(c.id).catch(() => {})))
    return children.length
  })

  // Concurrent file conflict detection — find files changed by multiple running sessions
  ipcMain.handle('instances:fileOverlaps', async (): Promise<Record<string, { file: string; otherSessions: { id: string; name: string }[] }[]>> => {
    const instances = (await getAllInstances()).filter(i => i.status === 'running')

    // Group by working directory + git branch (only same dir + same branch can conflict)
    const groupKey = (i: { workingDirectory: string; gitBranch: string | null }) =>
      `${i.workingDirectory}\0${i.gitBranch ?? ''}`
    const byGroup = new Map<string, typeof instances>()
    for (const inst of instances) {
      const key = groupKey(inst)
      const group = byGroup.get(key) || []
      group.push(inst)
      byGroup.set(key, group)
    }

    const result: Record<string, { file: string; otherSessions: { id: string; name: string }[] }[]> = {}

    for (const [, group] of byGroup) {
      if (group.length < 2) continue

      const changesBySession = await Promise.all(
        group.map(async (inst) => ({
          id: inst.id,
          name: inst.name,
          files: (await getLiveChanges(inst.workingDirectory)).map(e => e.file),
        }))
      )

      for (const session of changesBySession) {
        const overlaps: { file: string; otherSessions: { id: string; name: string }[] }[] = []
        for (const file of session.files) {
          const others = changesBySession
            .filter(s => s.id !== session.id && s.files.includes(file))
            .map(s => ({ id: s.id, name: s.name }))
          if (others.length > 0) overlaps.push({ file, otherSessions: others })
        }
        if (overlaps.length > 0) result[session.id] = overlaps
      }
    }

    return result
  })

  ipcMain.handle('instance:get', async (_e, id: string) => {
    try { return await router.getInstance(id) } catch { return null }
  })
  ipcMain.handle('instance:buffer', async (_e, id: string) => {
    try { return await router.getInstanceBuffer(id) } catch { return '' }
  })
  ipcMain.handle('daemon:restart', () => restartDaemon())
  ipcMain.handle('daemon:version', () => getDaemonVersion())
  ipcMain.handle('daemon:startUpgrade', () => startDaemonUpgrade())
  ipcMain.handle('daemon:migrateInstance', (_e, id: string) => migrateInstance(id))
  ipcMain.handle('daemon:migrateAll', () => migrateAllInstances())
  ipcMain.handle('daemon:upgradeState', () => getUpgradeState())

  ipcMain.handle('instance:killProcess', async (_e, pid: number): Promise<boolean> => {
    try {
      process.kill(pid, 'SIGTERM')
      return true
    } catch {
      return false
    }
  })

  // Find non-Claude child processes running under an instance's working directory
  ipcMain.handle('instance:processes', async (_e, id: string): Promise<ChildProcess[]> => {
    let inst
    try { inst = await getDaemonRouter().getInstance(id) } catch { return [] }
    if (!inst?.workingDirectory) return []
    const dir = inst.workingDirectory

    try {
      const { stdout: psOutput } = await execFileAsync('ps', ['aux'], { encoding: 'utf-8', timeout: 5000 })
      const allInstances = await getAllInstances()
      const managedPids = new Set(allInstances.map(i => i.pid).filter(Boolean))

      const children: ChildProcess[] = []
      for (const line of psOutput.split('\n')) {
        if (!line.trim()) continue
        const parts = line.trim().split(/\s+/)
        const pid = parseInt(parts[1])
        if (isNaN(pid) || managedPids.has(pid)) continue

        const fullCmd = parts.slice(10).join(' ')
        // Skip if this is a Claude CLI process (those are managed sessions)
        const cmdBin = fullCmd.split(/\s/)[0]
        const baseName = (cmdBin.split('/').pop() || '')
        if (baseName === 'claude') continue
        // Skip Electron/Colony processes
        if (/Electron|claude-electron|ShipIt/.test(fullCmd)) continue

        // Match: command path or arguments reference this instance's directory
        // Use boundary check to avoid false positives when dirs are prefixes
        // of each other (e.g. /project matching /project-v2)
        const dirIdx = fullCmd.indexOf(dir)
        if (dirIdx < 0) continue
        const charAfter = fullCmd[dirIdx + dir.length]
        if (charAfter && charAfter !== '/' && charAfter !== ' ' && charAfter !== "'" && charAfter !== '"' && charAfter !== ':') continue

        // Derive a short human-readable name from the command
        const name = deriveProcessName(fullCmd, dir)
        children.push({
          pid,
          name,
          command: fullCmd.slice(0, 200),
          cpu: parts[2],
          mem: parts[3],
        })
      }
      return children
    } catch {
      return []
    }
  })

  ipcMain.handle('instance:gitLog', async (_e, cwd: string): Promise<string> => {
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['log', '--oneline', '-10'], { encoding: 'utf-8', timeout: 5000, cwd })
      return stdout
    } catch {
      return ''
    }
  })

  ipcMain.handle('instance:gitDiff', async (_e, cwd: string): Promise<string> => {
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['diff', '--stat', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd })
      return stdout
    } catch {
      return ''
    }
  })

  ipcMain.handle('session:gitChanges', async (_e, dir: string): Promise<GitDiffEntry[]> => {
    try {
      // --numstat gives: <insertions>\t<deletions>\t<file>
      const { stdout: numStat } = await execFileAsync(resolveCommand('git'), ['diff', '--numstat', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd: dir })
      // --name-status gives: <status>\t<file>
      const { stdout: nameStat } = await execFileAsync(resolveCommand('git'), ['diff', '--name-status', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd: dir })

      const statusMap = new Map<string, string>()
      for (const line of nameStat.split('\n')) {
        const parts = line.split('\t')
        if (parts.length >= 2) {
          const statusChar = parts[0].trim().charAt(0)
          const file = parts[parts.length - 1].trim()
          if (file) statusMap.set(file, statusChar)
        }
      }

      const entries: GitDiffEntry[] = []
      for (const line of numStat.split('\n')) {
        const parts = line.split('\t')
        if (parts.length < 3) continue
        const file = parts[2].trim()
        if (!file) continue
        const ins = parts[0] === '-' ? 0 : parseInt(parts[0], 10)
        const del = parts[1] === '-' ? 0 : parseInt(parts[1], 10)
        const rawStatus = statusMap.get(file) ?? 'M'
        const status = (['M', 'A', 'D', 'R'].includes(rawStatus) ? rawStatus : 'M') as GitDiffEntry['status']
        entries.push({ file, insertions: ins, deletions: del, status })
      }
      return entries
    } catch {
      return []
    }
  })

  ipcMain.handle('session:getFileDiff', async (_e, dir: string, filePath: string, fileStatus?: string, ignoreWhitespace?: boolean): Promise<string> => {
    try {
      if (fileStatus === '?') {
        // Untracked file — show all content as additions
        const { stdout } = await execFileAsync(resolveCommand('cat'), [filePath], { encoding: 'utf-8', timeout: 5000, cwd: dir })
        return stdout.split('\n').map(l => '+' + l).join('\n')
      }
      const wsFlag = ignoreWhitespace ? ['-w'] : []
      // Try staged diff first, fall back to unstaged
      const { stdout: staged } = await execFileAsync(resolveCommand('git'), ['diff', '--cached', ...wsFlag, '--', filePath], { encoding: 'utf-8', timeout: 5000, cwd: dir })
      if (staged.trim()) return staged
      const { stdout } = await execFileAsync(resolveCommand('git'), ['diff', 'HEAD', ...wsFlag, '--', filePath], { encoding: 'utf-8', timeout: 5000, cwd: dir })
      return stdout
    } catch {
      return ''
    }
  })

  ipcMain.handle('session:gitRevert', async (_e, dir: string, file: string): Promise<boolean> => {
    const resolved = path.resolve(dir, file)
    if (!resolved.startsWith(path.resolve(dir) + path.sep) && resolved !== path.resolve(dir)) return false
    try {
      await execFileAsync(resolveCommand('git'), ['checkout', 'HEAD', '--', file], { encoding: 'utf-8', timeout: 10000, cwd: dir })
      return true
    } catch {
      return false
    }
  })

  // LLM-as-Judge scorecard for uncommitted changes in a session's working directory.
  // instanceId is used as the cache key; diffHash is computed from the full pre-truncation diff.
  ipcMain.handle('session:scoreOutput', async (_e, instanceId: string, dir: string): Promise<ScoreCard> => {
    // Get the full git diff (hash before truncation)
    let diff = ''
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['diff', 'HEAD'], { encoding: 'utf-8', timeout: 10000, cwd: dir })
      diff = stdout
    } catch {
      return { confidence: 0, scopeCreep: false, testCoverage: 'none', summary: 'Could not read git diff.', raw: '' }
    }

    if (!diff.trim()) {
      return { confidence: 0, scopeCreep: false, testCoverage: 'none', summary: 'No uncommitted changes to score.', raw: '' }
    }

    // Hash full diff before any truncation — cache hit short-circuits Haiku spawn
    const diffHash = createHash('sha256').update(diff).digest('hex').slice(0, 16)
    const cached = await getScoreCard(instanceId, diffHash)
    if (cached) return cached

    const MAX_DIFF = 8 * 1024
    let scoreDiff = diff
    if (Buffer.byteLength(diff, 'utf-8') > MAX_DIFF) {
      const truncated = Buffer.from(diff).slice(0, MAX_DIFF).toString('utf-8')
      const totalLines = diff.split('\n').length
      const keptLines = truncated.split('\n').length
      scoreDiff = truncated + `\n[... ${totalLines - keptLines} lines truncated]`
    }

    const fullPrompt = DEFAULT_SCORING_PROMPT + scoreDiff

    return new Promise((resolve) => {
      const proc = spawn(resolveCommand('claude'), ['-p', fullPrompt, '--model', 'claude-haiku-4-5-20251001'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      let out = ''
      proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      proc.on('close', () => {
        const raw = out.trim()
        let card: ScoreCard
        try {
          // Strip markdown fences if present
          const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
          const parsed = JSON.parse(cleaned)
          card = {
            confidence: Math.min(5, Math.max(0, Math.round(Number(parsed.confidence) || 0))),
            scopeCreep: Boolean(parsed.scopeCreep),
            testCoverage: (['none', 'partial', 'good'].includes(parsed.testCoverage) ? parsed.testCoverage : 'none') as ScoreCard['testCoverage'],
            summary: String(parsed.summary || '').slice(0, 400),
            raw,
          }
        } catch {
          card = { confidence: 0, scopeCreep: false, testCoverage: 'none', summary: raw.slice(0, 400) || 'Could not parse score response.', raw }
        }
        saveScoreCard(instanceId, diffHash, card).catch(() => {})
        resolve(card)
      })
      proc.on('error', (err) => {
        resolve({ confidence: 0, scopeCreep: false, testCoverage: 'none', summary: `Error: ${err.message}`, raw: '' })
      })
    })
  })

  // Return the current diff hash (sha256 first 16 chars) for the given working directory.
  // Used by ChangesTab to check if cached scorecard is still valid before mounting.
  ipcMain.handle('session:getDiffHash', async (_e, dir: string): Promise<string | null> => {
    try {
      const { stdout } = await execFileAsync(resolveCommand('git'), ['diff', 'HEAD'], { encoding: 'utf-8', timeout: 10000, cwd: dir })
      if (!stdout.trim()) return null
      return createHash('sha256').update(stdout).digest('hex').slice(0, 16)
    } catch {
      return null
    }
  })

  // Return the persisted ScoreCard if the stored diffHash matches the given hash.
  ipcMain.handle('session:getCachedScoreCard', async (_e, instanceId: string, diffHash: string): Promise<ScoreCard | null> => {
    return getScoreCard(instanceId, diffHash)
  })

  // Remove the persisted ScoreCard for an instance (user dismissed).
  ipcMain.handle('session:clearScoreCard', async (_e, instanceId: string): Promise<void> => {
    await clearScoreCard(instanceId)
  })

  // AI-generated summary of a session's terminal buffer.
  ipcMain.handle('instance:summarize', async (_e, id: string): Promise<string> => {
    const COMPACTION_RE = /context.*(?:compacted|summarized)|conversation.*continued.*previous.*context/i
    const rawBuf = await router.getInstanceBuffer(id).catch(() => '')
    const clean = stripAnsi(rawBuf)
    const lines = clean.split('\n').filter(l => l.trim())
    const relevant = lines.slice(-200).filter(l => !COMPACTION_RE.test(l))
    const contextText = relevant.slice(-80).join('\n')

    if (contextText.length < 200) {
      return 'Not enough context to summarize.'
    }

    const prompt =
      `Summarize this Claude session in 3-5 sentences. ` +
      `What was accomplished? What files were changed? ` +
      `What's the key context for whoever picks this up next?\n\n---\n${contextText.slice(0, 8000)}`

    return new Promise((resolve, reject) => {
      const proc = spawn(resolveCommand('claude'), ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      let out = ''
      let err = ''
      let killed = false
      const killTimer = setTimeout(() => {
        killed = true
        proc.kill('SIGTERM')
      }, 30_000)
      proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
      proc.on('close', (code) => {
        clearTimeout(killTimer)
        if (killed) {
          resolve('Summary timed out.')
        } else if (out.trim()) {
          resolve(out.trim())
        } else {
          reject(new Error(err.trim() || `claude exited with code ${code}`))
        }
      })
      proc.on('error', (e) => { clearTimeout(killTimer); reject(e) })
    })
  })

  // Inline code annotations emitted by a session via COLONY_COMMENT sentinels
  ipcMain.handle('session:getComments', async (_e, instanceId: string) => {
    return getDaemonRouter().getInstanceComments(instanceId)
  })

  // Clear tool-deferred info — dismiss the deferred banner without restarting.
  ipcMain.handle('instance:clearToolDeferred', async (_e, instanceId: string): Promise<boolean> => {
    return getDaemonRouter().clearToolDeferred(instanceId)
  })

  // Session steering — queue or immediately deliver a redirect message to a session.
  // If the session is waiting: delivers immediately. If busy: queues for next waiting transition.
  ipcMain.handle('session:steer', async (_e, instanceId: string, message: string): Promise<boolean> => {
    return getDaemonRouter().steerInstance(instanceId, message)
  })

  // Inter-session message bus — send text to a running session by display name.
  // Returns true if the target was found and in waiting state (message queued),
  // false if not running, not waiting, or name not found.
  ipcMain.handle('session:sendMessage', async (_e, targetName: string, text: string): Promise<boolean> => {
    const all = await getAllInstances()
    const target = all.find(
      inst =>
        inst.status === 'running' &&
        inst.name.toLowerCase().includes(targetName.toLowerCase())
    )
    if (!target) return false
    if (target.activity !== 'waiting') return false
    await sendPromptWhenReady(target.id, { prompt: text })
    return true
  })

  // Shell PTY — real shell terminals per instance
  ipcMain.handle('shellPty:create', async (_e, instanceId: string, cwd: string) => {
    return createShell(instanceId, cwd)
  })
  ipcMain.handle('shellPty:write', (_e, instanceId: string, data: string) => {
    return writeShell(instanceId, data)
  })
  ipcMain.handle('shellPty:resize', (_e, instanceId: string, cols: number, rows: number) => {
    return resizeShell(instanceId, cols, rows)
  })
  ipcMain.handle('shellPty:kill', (_e, instanceId: string) => {
    return killShell(instanceId)
  })
}

/** Derive a short label like "vite", "python runserver", "redis-server" from a full command */
function deriveProcessName(fullCmd: string, _dir: string): string {
  const parts = fullCmd.split(/\s+/)
  const bin = (parts[0].split('/').pop() || parts[0])

  // node/python — use the script name or key arg
  if (bin === 'node' || bin === 'python' || bin === 'python3') {
    // Find the script or module argument
    for (let i = 1; i < parts.length; i++) {
      const arg = parts[i]
      if (arg.startsWith('-')) continue
      const script = arg.split('/').pop() || arg
      // For manage.py, include the subcommand
      if (script === 'manage.py' && parts[i + 1] && !parts[i + 1].startsWith('-')) {
        return `${parts[i + 1]}`
      }
      // For foo.js / vite.js, drop extension
      return script.replace(/\.(js|ts|mjs|py)$/, '')
    }
    return bin
  }

  return bin
}
