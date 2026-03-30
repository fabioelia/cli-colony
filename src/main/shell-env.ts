/**
 * Shell environment loader — resolves the user's login shell PATH and env vars
 * so spawned processes can find tools like git, psql, uv, yarn, etc.
 * Shared between env-manager and env-daemon.
 */

import { execSync } from 'child_process'

let _cachedEnv: Record<string, string> | null = null

/**
 * Load the user's login shell environment. Cached after first call.
 * Tries the user's default shell, falls back to /bin/zsh, then /bin/bash.
 */
export function loadShellEnv(): Record<string, string> {
  if (_cachedEnv) return _cachedEnv

  const loginShell = process.env.SHELL || '/bin/zsh'
  const shells = [loginShell, '/bin/zsh', '/bin/bash'].filter((v, i, a) => a.indexOf(v) === i)

  for (const shell of shells) {
    try {
      const envOutput = execSync(`${shell} -lc "env"`, { encoding: 'utf-8', timeout: 5000 })
      const env: Record<string, string> = { ...process.env } as Record<string, string>
      for (const line of envOutput.split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) {
          env[line.substring(0, idx)] = line.substring(idx + 1)
        }
      }
      _cachedEnv = env
      return env
    } catch {
      // Try PATH-only fallback for this shell
      try {
        const shellPath = execSync(`${shell} -lc "echo $PATH"`, { encoding: 'utf-8', timeout: 5000 }).trim()
        if (shellPath) {
          _cachedEnv = { ...process.env, PATH: shellPath } as Record<string, string>
          return _cachedEnv
        }
      } catch { /* try next shell */ }
    }
  }

  _cachedEnv = { ...process.env } as Record<string, string>
  return _cachedEnv
}
