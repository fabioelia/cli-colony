/**
 * Shell PTY — spawns real shell terminals (zsh/bash) in the main process.
 * Each shell is keyed by the Claude instance ID it belongs to.
 */

import * as pty from 'node-pty'
import { broadcast } from './broadcast'
import { loadShellEnv } from '../shared/shell-env'

interface ShellInstance {
  pty: pty.IPty
  instanceId: string
}

const shells = new Map<string, ShellInstance>()

/** Get the user's shell, platform-aware */
function getShell(): string {
  if (process.platform === 'win32') {
    return process.env.COMSPEC || 'cmd.exe'
  }
  return process.env.SHELL || '/bin/zsh'
}

export function createShell(instanceId: string, cwd: string): { pid: number } {
  // Kill existing shell for this instance
  killShell(instanceId)

  const shellEnv = loadShellEnv()
  const shell = getShell()
  const proc = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols: 120,
    rows: 30,
    cwd,
    env: shellEnv,
  })

  const inst: ShellInstance = { pty: proc, instanceId }
  shells.set(instanceId, inst)

  proc.onData((data) => {
    broadcast('shellPty:output', { instanceId, data })
  })

  proc.onExit(() => {
    shells.delete(instanceId)
    broadcast('shellPty:exited', { instanceId })
  })

  return { pid: proc.pid }
}

export function writeShell(instanceId: string, data: string): boolean {
  const inst = shells.get(instanceId)
  if (!inst) return false
  inst.pty.write(data)
  return true
}

export function resizeShell(instanceId: string, cols: number, rows: number): boolean {
  const inst = shells.get(instanceId)
  if (!inst) return false
  inst.pty.resize(cols, rows)
  return true
}

export function killShell(instanceId: string): boolean {
  const inst = shells.get(instanceId)
  if (!inst) return false
  try { inst.pty.kill() } catch { /* already dead */ }
  shells.delete(instanceId)
  return true
}

/** Clean up all shells (on app quit) */
export function killAllShells(): void {
  for (const [, inst] of shells) {
    try { inst.pty.kill() } catch { /* */ }
  }
  shells.clear()
}
