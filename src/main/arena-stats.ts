/**
 * Arena Stats — shared read/write for arena-stats.json.
 * Used by both IPC arena handlers and pipeline best-of-n actions.
 */

import { promises as fsp } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { ArenaStats } from '../shared/types'

const STATS_PATH = join(app.getPath('home'), '.claude-colony', 'arena-stats.json')

export async function readArenaStats(): Promise<ArenaStats> {
  try {
    const raw = await fsp.readFile(STATS_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ArenaStats) : {}
  } catch {
    return {}
  }
}

export async function writeArenaStats(stats: ArenaStats): Promise<void> {
  const dir = join(app.getPath('home'), '.claude-colony')
  await fsp.mkdir(dir, { recursive: true })
  await fsp.writeFile(STATS_PATH, JSON.stringify(stats, null, 2), 'utf-8')
}
