import { ipcMain } from 'electron'
import { execSync } from 'child_process'
import { join } from 'path'
import { existsSync, writeFileSync, readFileSync } from 'fs'
import { createShell, writeShell, resizeShell, killShell } from '../shell-pty'
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

export interface ChildProcess {
  pid: number
  name: string
  command: string
  cpu: string
  mem: string
}

export function registerInstanceHandlers(): void {
  ipcMain.handle('instance:create', async (_e, opts) => {
    const inst = await createInstance(opts || {})
    // Inject checkpoint preamble if one exists in the working directory
    const checkpointPath = join(inst.workingDirectory, '.colony-checkpoint.md')
    if (existsSync(checkpointPath)) {
      try {
        const content = readFileSync(checkpointPath, 'utf-8')
        const preamble = `The following checkpoint was auto-saved from your previous session in this directory. Resume your work from where you left off:\n\n${content}`
        sendPromptWhenReady(inst.id, { prompt: preamble }).catch(() => {})
      } catch { /* ignore read errors */ }
    }
    return inst
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
      const psOutput = execSync('ps aux', { encoding: 'utf-8', timeout: 5000 })
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

  ipcMain.handle('instance:gitLog', (_e, cwd: string): string => {
    try {
      return execSync('git log --oneline -10', { encoding: 'utf-8', timeout: 5000, cwd })
    } catch {
      return ''
    }
  })

  ipcMain.handle('instance:gitDiff', (_e, cwd: string): string => {
    try {
      return execSync('git diff --stat HEAD', { encoding: 'utf-8', timeout: 5000, cwd })
    } catch {
      return ''
    }
  })

  // Auto-save context checkpoint when the amber threshold fires in the renderer.
  // Writes .colony-checkpoint.md to the instance's working directory.
  ipcMain.handle('instance:saveCheckpoint', async (_e, id: string): Promise<boolean> => {
    const client = getDaemonClient()
    let inst
    try { inst = await client.getInstance(id) } catch { return false }
    if (!inst) return false

    const rawBuf = await client.getInstanceBuffer(id).catch(() => '')
    const clean = stripAnsi(rawBuf)
    const lines = clean.split('\n').filter(l => l.trim())
    const tail = lines.slice(-100).join('\n')

    const parts: string[] = [
      `# Context Checkpoint: ${inst.name}`,
      '',
      `**Saved:** ${new Date().toLocaleString()}`,
      `**Directory:** ${inst.workingDirectory}`,
      `**Status:** ${inst.status} · ${inst.activity}`,
    ]
    if (inst.gitBranch) {
      parts.push(`**Git:** ${inst.gitBranch}${inst.gitRepo ? ` on ${inst.gitRepo}` : ''}`)
    }

    try {
      const gitLog = execSync('git log --oneline -10', { encoding: 'utf-8', timeout: 5000, cwd: inst.workingDirectory })
      if (gitLog.trim()) parts.push('', '## Recent Commits', '```', gitLog.trim(), '```')
    } catch { /* not a git repo */ }
    try {
      const gitDiff = execSync('git diff --stat HEAD', { encoding: 'utf-8', timeout: 5000, cwd: inst.workingDirectory })
      if (gitDiff.trim()) parts.push('', '## Uncommitted Changes', '```', gitDiff.trim(), '```')
    } catch { /* not a git repo */ }

    parts.push(
      '',
      '## Terminal Context (last 100 lines)',
      '```',
      tail || '(empty)',
      '```',
      '',
      '---',
      '*Auto-saved when context budget reached amber threshold. Injected as preamble on next session start in this directory.*',
    )

    try {
      writeFileSync(join(inst.workingDirectory, '.colony-checkpoint.md'), parts.join('\n'), 'utf-8')
      return true
    } catch {
      return false
    }
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
