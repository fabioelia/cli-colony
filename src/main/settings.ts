import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { CliBackend } from '../daemon/protocol'

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

function ensureDir(): void {
  const dir = getSettingsDir()
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function getSettings(): AppSettings {
  ensureDir()
  const path = getSettingsPath()
  try {
    if (existsSync(path)) {
      const data = JSON.parse(readFileSync(path, 'utf-8'))
      console.log(`[settings] loaded from ${path}:`, JSON.stringify(data))
      return data
    }
  } catch (err) {
    console.error('[settings] failed to read:', err)
  }
  return { defaultArgs: '' }
}

export function getSetting(key: string): string {
  const settings = getSettings()
  return settings[key] || ''
}

export function setSetting(key: string, value: string): void {
  const settings = getSettings()
  settings[key] = value
  ensureDir()
  const path = getSettingsPath()
  writeFileSync(path, JSON.stringify(settings, null, 2), 'utf-8')
  console.log(`[settings] saved ${key}=${value} to ${path}`)
}

/**
 * Build a git remote URL for a GitHub repo based on the user's protocol preference.
 * Setting: gitProtocol = 'ssh' (default) | 'https'
 */
export function gitRemoteUrl(owner: string, name: string): string {
  const protocol = getSetting('gitProtocol') || 'ssh'
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
export function detectGitProtocol(): 'ssh' | 'https' | null {
  try {
    const { execSync } = require('child_process') as typeof import('child_process')
    // GitHub SSH returns exit code 1 with "Hi username!" on success
    const result = execSync('ssh -T git@github.com 2>&1 || true', { encoding: 'utf-8', timeout: 10000 })
    if (result.includes('Hi ') || result.includes('successfully authenticated')) {
      return 'ssh'
    }
    return 'https'
  } catch {
    return 'https' // SSH not working, default to HTTPS
  }
}

export function getDefaultArgs(): string[] {
  const raw = getSetting('defaultArgs').trim()
  if (!raw) return []
  return raw.split(/\s+/)
}

export function getDefaultCliBackend(): CliBackend {
  const raw = getSetting('defaultCliBackend').trim()
  return raw === 'cursor-agent' ? 'cursor-agent' : 'claude'
}
