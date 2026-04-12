import { promises as fsp } from 'fs'
import { execFile } from 'child_process'
import { resolveCommand } from './resolve-command'
import { join } from 'path'
import type { CliBackend } from '../shared/types'

interface AppSettings {
  defaultArgs: string
  [key: string]: string
}

import { colonyPaths } from '../shared/colony-paths'

function getSettingsPath(): string {
  return colonyPaths.settingsJson
}

function getSettingsDir(): string {
  return colonyPaths.root
}

async function ensureDir(): Promise<void> {
  await fsp.mkdir(getSettingsDir(), { recursive: true })
}

let _cache: AppSettings | null = null
let _cacheMtimeMs: number | null = null

export async function getSettings(): Promise<AppSettings> {
  if (_cache) {
    // Check if file has been modified externally
    try {
      const stat = await fsp.stat(getSettingsPath())
      if (stat.mtimeMs === _cacheMtimeMs) return _cache
    } catch {
      // File deleted — return cached defaults
      return _cache
    }
  }
  await ensureDir()
  const path = getSettingsPath()
  try {
    const stat = await fsp.stat(path)
    const data = JSON.parse(await fsp.readFile(path, 'utf-8'))
    _cache = data
    _cacheMtimeMs = stat.mtimeMs
    return data
  } catch {
    // File doesn't exist or invalid JSON
  }
  const defaults = { defaultArgs: '' }
  _cache = defaults
  _cacheMtimeMs = null
  return defaults
}

export async function getSetting(key: string): Promise<string> {
  const settings = await getSettings()
  return settings[key] || ''
}

/**
 * Sync cache-only read — returns '' if settings haven't been loaded yet.
 * Use only in sync contexts (e.g. event handlers) where awaiting isn't possible.
 * Call getSettings() at startup to ensure the cache is populated.
 */
export function getSettingSync(key: string): string {
  return _cache?.[key] || ''
}

export async function setSetting(key: string, value: string): Promise<void> {
  const settings = await getSettings()
  settings[key] = value
  _cache = settings
  await ensureDir()
  const path = getSettingsPath()
  await fsp.writeFile(path, JSON.stringify(settings, null, 2), 'utf-8')
  try { _cacheMtimeMs = (await fsp.stat(path)).mtimeMs } catch { /* */ }
  console.log(`[settings] saved ${key}=${value} to ${path}`)
}

/**
 * Build a git remote URL for a GitHub repo based on the user's protocol preference.
 * Setting: gitProtocol = 'ssh' (default) | 'https'
 */
export async function gitRemoteUrl(owner: string, name: string): Promise<string> {
  const protocol = await getSetting('gitProtocol') || 'ssh'
  if (protocol === 'https') {
    return `https://github.com/${owner}/${name}.git`
  }
  return `git@github.com:${owner}/${name}.git`
}

/**
 * Auto-detect whether SSH git access to GitHub works.
 * Returns 'ssh' if `ssh -T git@github.com` succeeds (exit 1 is success for GitHub),
 * 'https' if it fails, null if can't determine.
 */
export async function detectGitProtocol(): Promise<'ssh' | 'https' | null> {
  try {
    const result = await new Promise<string>((resolve, reject) => {
      execFile(resolveCommand('ssh'), ['-T', 'git@github.com'], { encoding: 'utf-8', timeout: 10000 }, (err, stdout, stderr) => {
        // GitHub SSH returns exit code 1 with "Hi username!" on success
        resolve((stdout || '') + (stderr || ''))
      })
    })
    if (result.includes('Hi ') || result.includes('successfully authenticated')) {
      return 'ssh'
    }
    return 'https'
  } catch {
    return 'https' // SSH not working, default to HTTPS
  }
}

export async function getDefaultArgs(): Promise<string[]> {
  const raw = (await getSetting('defaultArgs')).trim()
  if (!raw) return []
  return raw.split(/\s+/)
}

export async function getDefaultCliBackend(): Promise<CliBackend> {
  const raw = (await getSetting('defaultCliBackend')).trim()
  return raw === 'cursor-agent' ? 'cursor-agent' : 'claude'
}
