/**
 * Shell environment loader — resolves the user's login shell PATH and env vars
 * so spawned processes can find tools like git, psql, uv, yarn, etc.
 * Shared between env-manager and env-daemon.
 */

import { execSync } from 'child_process'

let _cachedEnv: Record<string, string> | null = null

/** Safe execSync wrapper that catches EIO and other pipe errors */
function safeExecSync(cmd: string): string | null {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Prevent EIO from crashing the process — ignore stdin errors
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    })
  } catch {
    return null
  }
}

/**
 * Load the user's login shell environment. Cached after first call.
 * Tries the user's default shell, falls back to /bin/zsh, then /bin/bash.
 */
export function loadShellEnv(): Record<string, string> {
  if (_cachedEnv) return _cachedEnv

  const loginShell = process.env.SHELL || '/bin/zsh'
  const shells = [loginShell, '/bin/zsh', '/bin/bash'].filter((v, i, a) => a.indexOf(v) === i)

  for (const shell of shells) {
    // Try full env dump
    const envOutput = safeExecSync(`${shell} -lc "env"`)
    if (envOutput) {
      const env: Record<string, string> = { ...process.env } as Record<string, string>
      for (const line of envOutput.split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) {
          env[line.substring(0, idx)] = line.substring(idx + 1)
        }
      }
      _cachedEnv = env
      return env
    }

    // Try PATH-only fallback
    const shellPath = safeExecSync(`${shell} -lc "echo $PATH"`)
    if (shellPath?.trim()) {
      _cachedEnv = { ...process.env, PATH: shellPath.trim() } as Record<string, string>
      return _cachedEnv
    }
  }

  _cachedEnv = { ...process.env } as Record<string, string>
  return _cachedEnv
}
