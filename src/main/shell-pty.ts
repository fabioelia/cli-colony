/**
 * Shell PTY — spawns real shell terminals (zsh/bash) in the main process.
 * Each shell is keyed by the Claude instance ID it belongs to.
 */

import * as pty from 'node-pty'
import { broadcast } from './broadcast'

interface ShellInstance {
  pty: pty.IPty
  instanceId: string
}

const shells = new Map<string, ShellInstance>()

/** Get the user's shell from $SHELL or default to zsh */
function getShell(): string {
  return process.env.SHELL || '/bin/zsh'
}

/** Load a login shell environment for PATH etc. */
function getShellEnv(): Record<string, string> {
  const { execSync } = require('child_process') as typeof import('child_process')
  try {
    const shell = getShell()
    const envOutput = execSync(`${shell} -lic "env"`, { encoding: 'utf-8', timeout: 5000 })
    const env: Record<string, string> = { ...process.env }
    for (const line of envOutput.split('\n')) {
      const idx = line.indexOf('=')
      if (idx > 0) env[line.substring(0, idx)] = line.substring(idx + 1)
    }
    return env
  } catch {
    return { ...process.env } as Record<string, string>
  }
}

let shellEnv: Record<string, string> | null = null

export function createShell(instanceId: string, cwd: string): { pid: number } {
  // Kill existing shell for this instance
  killShell(instanceId)

  if (!shellEnv) shellEnv = getShellEnv()

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
    broadcast('shell-pty:output', { instanceId, data })
  })

  proc.onExit(() => {
    shells.delete(instanceId)
    broadcast('shell-pty:exited', { instanceId })
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
