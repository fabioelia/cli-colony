import { ipcMain } from 'electron'
import { execFile, spawn } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
import { createShell, writeShell, resizeShell, killShell } from '../shell-pty'
import type { GitDiffEntry } from '../../shared/types'
import {
  createInstance,
  killInstance,
  restartInstance,
  getAllInstances,
  restartDaemon,
  getDaemonVersion,
} from '../instance-manager'
import { getDaemonClient } from '../daemon-client'
import { sendPromptWhenReady } from '../send-prompt-when-ready'
import { stripAnsi } from '../../shared/utils'
import { readReplay } from '../replay-manager'

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
  const client = getDaemonClient()
  ipcMain.handle('instance:write', async (_e, id: string, data: string) => {
    try { return await client.writeToInstance(id, data) } catch { return false }
  })
  ipcMain.handle('instance:resize', async (_e, id: string, cols: number, rows: number) => {
    try { return await client.resizeInstance(id, cols, rows) } catch { return false }
  })
  ipcMain.handle('instance:kill', (_e, id: string) => killInstance(id))
  ipcMain.handle('instance:remove', async (_e, id: string) => {
    try { return await client.removeInstance(id) } catch { return false }
  })
  ipcMain.handle('instance:rename', async (_e, id: string, name: string) => {
    try { return await client.renameInstance(id, name) } catch { return false }
  })
  ipcMain.handle('instance:recolor', async (_e, id: string, color: string) => {
    try { return await client.recolorInstance(id, color) } catch { return false }
  })
  ipcMain.handle('instance:restart', (_e, id: string) => restartInstance(id))
  ipcMain.handle('instance:pin', async (_e, id: string) => {
    try { return await client.pinInstance(id) } catch { return false }
  })
  ipcMain.handle('instance:unpin', async (_e, id: string) => {
    try { return await client.unpinInstance(id) } catch { return false }
  })
  ipcMain.handle('instance:set-role', async (_e, id: string, role: string | null) => {
    try { return await client.setInstanceRole(id, role) } catch { return false }
  })
  ipcMain.handle('instance:list', () => getAllInstances())
  ipcMain.handle('instance:get', async (_e, id: string) => {
    try { return await client.getInstance(id) } catch { return null }
  })
  ipcMain.handle('instance:buffer', async (_e, id: string) => {
    try { return await client.getInstanceBuffer(id) } catch { return '' }
  })
  ipcMain.handle('daemon:restart', () => restartDaemon())
  ipcMain.handle('daemon:version', () => getDaemonVersion())

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
    try { inst = await getDaemonClient().getInstance(id) } catch { return [] }
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
        if (!fullCmd.includes(dir)) continue

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
      const { stdout } = await execFileAsync('git', ['log', '--oneline', '-10'], { encoding: 'utf-8', timeout: 5000, cwd })
      return stdout
    } catch {
      return ''
    }
  })

  ipcMain.handle('instance:gitDiff', async (_e, cwd: string): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('git', ['diff', '--stat', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd })
      return stdout
    } catch {
      return ''
    }
  })

  ipcMain.handle('session:gitChanges', async (_e, dir: string): Promise<GitDiffEntry[]> => {
    try {
      // --numstat gives: <insertions>\t<deletions>\t<file>
      const { stdout: numStat } = await execFileAsync('git', ['diff', '--numstat', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd: dir })
      // --name-status gives: <status>\t<file>
      const { stdout: nameStat } = await execFileAsync('git', ['diff', '--name-status', 'HEAD'], { encoding: 'utf-8', timeout: 5000, cwd: dir })

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

  ipcMain.handle('session:gitRevert', async (_e, dir: string, file: string): Promise<boolean> => {
    try {
      await execFileAsync('git', ['checkout', 'HEAD', '--', file], { encoding: 'utf-8', timeout: 10000, cwd: dir })
      return true
    } catch {
      return false
    }
  })

  // AI-generated summary of a session's terminal snapshot.
  // Uses two sources in priority order:
  //   1. Replay log — tool call timeline (≥3 events), unaffected by context compaction
  //   2. Terminal buffer — broader 200-line window with compaction lines filtered
  ipcMain.handle('session:summarize', async (_e, id: string): Promise<string> => {
    let contextText = ''

    // Source 1: replay log (most reliable — independent of context compaction)
    const replayEvents = readReplay(id)
    if (replayEvents.length >= 3) {
      const lines = replayEvents
        .slice(-40)
        .map(e => `[${e.tool}] ${e.inputSummary}${e.outputSummary ? ' → ' + e.outputSummary : ''}`)
      contextText = lines.join('\n')
    }

    // Source 2: terminal buffer — broader window, skip compaction header lines
    if (!contextText) {
      const COMPACTION_RE = /context.*(?:compacted|summarized)|conversation.*continued.*previous.*context/i
      const rawBuf = await client.getInstanceBuffer(id).catch(() => '')
      const clean = stripAnsi(rawBuf)
      const lines = clean.split('\n').filter(l => l.trim())
      // Use a wider window and strip lines that look like compaction headers
      const relevant = lines.slice(-200).filter(l => !COMPACTION_RE.test(l))
      contextText = relevant.slice(-80).join('\n')
    }

    if (contextText.length < 200) {
      return 'Not enough context to summarize.'
    }

    const prompt =
      `Summarize this Claude session in 3-5 sentences. ` +
      `What was accomplished? What files were changed? ` +
      `What's the key context for whoever picks this up next?\n\n---\n${contextText.slice(0, 8000)}`

    return new Promise((resolve, reject) => {
      const proc = spawn('claude', ['-p', prompt, '--model', 'claude-haiku-4-5-20251001'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      })
      let out = ''
      let err = ''
      proc.stdout.on('data', (chunk: Buffer) => { out += chunk.toString() })
      proc.stderr.on('data', (chunk: Buffer) => { err += chunk.toString() })
      proc.on('close', (code) => {
        if (out.trim()) {
          resolve(out.trim())
        } else {
          reject(new Error(err.trim() || `claude exited with code ${code}`))
        }
      })
      proc.on('error', reject)
    })
  })

  // Read session replay events (tool call audit log)
  ipcMain.handle('session:getReplay', (_e, instanceId: string) => {
    return readReplay(instanceId)
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
  ipcMain.handle('shell-pty:create', async (_e, instanceId: string, cwd: string) => {
    return createShell(instanceId, cwd)
  })
  ipcMain.handle('shell-pty:write', (_e, instanceId: string, data: string) => {
    return writeShell(instanceId, data)
  })
  ipcMain.handle('shell-pty:resize', (_e, instanceId: string, cols: number, rows: number) => {
    return resizeShell(instanceId, cols, rows)
  })
  ipcMain.handle('shell-pty:kill', (_e, instanceId: string) => {
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
