/**
 * Shell environment loader -- resolves the user's login shell PATH and env vars
 * so spawned processes can find tools like git, psql, uv, yarn, etc.
 *
 * Shared between main process (env-manager, shell-pty) and daemon (pty-daemon, env-daemon).
 */

import { execSync } from 'child_process'
import * as os from 'os'
import * as fs from 'fs'
import { colonyPaths } from './colony-paths'

let _cachedEnv: Record<string, string> | null = null

/** Safe execSync wrapper that catches EIO and other pipe errors */
function safeExecSync(cmd: string): string | null {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    })
  } catch {
    return null
  }
}

/**
 * Determine which shell command to use for environment loading.
 * Reads the shellProfile setting from ~/.claude-colony/settings.json:
 *   - empty/"" => user's $SHELL (with fallbacks to /bin/zsh, /bin/bash)
 *   - "login"  => /bin/zsh
 *   - "/path/to/shell" => use that shell directly
 */
function getShellCandidates(): string[] {
  let shellProfile = ''
  try {
    const settingsPath = colonyPaths.settingsJson
    if (fs.existsSync(settingsPath)) {
      const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
      shellProfile = settings.shellProfile || ''
    }
  } catch { /* */ }

  if (process.platform === 'win32') {
    return [process.env.COMSPEC || 'cmd.exe']
  }

  if (shellProfile === 'login') {
    return ['/bin/zsh', '/bin/bash']
  } else if (shellProfile) {
    return [shellProfile, '/bin/zsh', '/bin/bash']
  }

  // Default: user's login shell with fallbacks
  const loginShell = process.env.SHELL || '/bin/zsh'
  return [loginShell, '/bin/zsh', '/bin/bash'].filter((v, i, a) => a.indexOf(v) === i)
}

/**
 * Load the user's login shell environment. Cached after first call.
 * Reads the shellProfile setting from settings.json to determine which shell to use.
 * Tries the configured shell, falls back to /bin/zsh, then /bin/bash.
 */
export function loadShellEnv(): Record<string, string> {
  if (_cachedEnv) return _cachedEnv

  if (process.platform === 'win32') {
    _cachedEnv = { ...process.env } as Record<string, string>
    ensureCriticalVars(_cachedEnv)
    return _cachedEnv
  }

  const shells = getShellCandidates()

  for (const shell of shells) {
    // Try interactive login shell first (-lic) to source .zshrc/.bashrc,
    // then fall back to login-only (-lc) which skips rc files.
    // Many tools (e.g. claude, nvm, pyenv) add to PATH in .zshrc, not .zprofile.
    const envOutput = safeExecSync(`${shell} -lic "env" 2>/dev/null`)
      || safeExecSync(`${shell} -lc "env"`)
    if (envOutput) {
      const env: Record<string, string> = { ...process.env } as Record<string, string>
      for (const line of envOutput.split('\n')) {
        const idx = line.indexOf('=')
        if (idx > 0) {
          env[line.substring(0, idx)] = line.substring(idx + 1)
        }
      }
      _cachedEnv = env
      ensureCriticalVars(_cachedEnv)
      return env
    }

    // Try PATH-only fallback
    const shellPath = safeExecSync(`${shell} -lic "echo $PATH" 2>/dev/null`)
      || safeExecSync(`${shell} -lc "echo $PATH"`)
    if (shellPath?.trim()) {
      _cachedEnv = { ...process.env, PATH: shellPath.trim() } as Record<string, string>
      ensureCriticalVars(_cachedEnv)
      return _cachedEnv
    }
  }

  _cachedEnv = { ...process.env } as Record<string, string>
  ensureCriticalVars(_cachedEnv)
  return _cachedEnv
}

/**
 * Ensure env vars that macOS tools depend on are always present.
 * USER is required for Keychain access (Claude CLI auth).
 * When Electron launches from Dock/Spotlight these may be absent from process.env.
 */
function ensureCriticalVars(env: Record<string, string>): void {
  if (!env.USER) {
    try { env.USER = os.userInfo().username } catch { /* */ }
  }
  if (!env.HOME) {
    env.HOME = os.homedir()
  }
}
