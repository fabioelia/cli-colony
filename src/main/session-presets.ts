import { promises as fsp } from 'fs'
import { colonyPaths } from '../shared/colony-paths'
import type { SessionPreset } from '../shared/types'

async function readPresets(): Promise<SessionPreset[]> {
  try {
    const raw = await fsp.readFile(colonyPaths.sessionPresetsJson, 'utf8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

async function writePresets(presets: SessionPreset[]): Promise<void> {
  await fsp.writeFile(colonyPaths.sessionPresetsJson, JSON.stringify(presets, null, 2), 'utf8')
}

export async function getSessionPresets(): Promise<SessionPreset[]> {
  return readPresets()
}

export async function saveSessionPreset(preset: SessionPreset): Promise<boolean> {
  const presets = await readPresets()
  const idx = presets.findIndex(p => p.name === preset.name)
  if (idx >= 0) {
    presets[idx] = preset
  } else {
    presets.push(preset)
  }
  await writePresets(presets)
  return true
}

export async function deleteSessionPreset(name: string): Promise<boolean> {
  const presets = await readPresets()
  const filtered = presets.filter(p => p.name !== name)
  if (filtered.length === presets.length) return false
  await writePresets(filtered)
  return true
}
