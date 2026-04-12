/**
 * Resolve a CLI command to its absolute path using the user's shell environment.
 * Prevents posix_spawnp failures when the command is on a PATH that the
 * spawned process doesn't inherit (common with Electron + node-pty).
 *
 * Caches results so we only shell out once per command per process lifetime.
 * Call `clearResolvedCommand(name)` to invalidate after an auto-update.
 */

import { execSync } from 'child_process'
import { loadShellEnv } from '../shared/shell-env'

const cache = new Map<string, string>()

export function resolveCommand(cmd: string): string {
  if (cmd.startsWith('/')) return cmd
  const cached = cache.get(cmd)
  if (cached) return cached
  try {
    const resolved = execSync(`which ${cmd}`, {
      encoding: 'utf-8',
      timeout: 3000,
      env: loadShellEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (resolved) {
      cache.set(cmd, resolved)
      return resolved
    }
  } catch { /* fall through */ }
  return cmd
}

export function clearResolvedCommand(cmd: string): void {
  cache.delete(cmd)
}
