import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'

interface AppSettings {
  defaultArgs: string
  [key: string]: string
}

function getSettingsPath(): string {
  const home = app.getPath('home')
  return join(home, '.claude-colony', 'settings.json')
}

function getSettingsDir(): string {
  const home = app.getPath('home')
  return join(home, '.claude-colony')
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

export function getDefaultArgs(): string[] {
  const raw = getSetting('defaultArgs').trim()
  if (!raw) return []
  return raw.split(/\s+/)
}
