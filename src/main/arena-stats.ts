/**
 * Arena Stats — shared read/write for arena-stats.json.
 * Used by both IPC arena handlers and pipeline best-of-n actions.
 */

import { promises as fsp } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import type { ArenaStats, ArenaMatchRecord } from '../shared/types'

const COLONY_DIR = join(app.getPath('home'), '.claude-colony')
const STATS_PATH = join(COLONY_DIR, 'arena-stats.json')
const MATCH_HISTORY_PATH = join(COLONY_DIR, 'arena-match-history.json')
const MAX_MATCH_HISTORY = 100

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
  await fsp.mkdir(COLONY_DIR, { recursive: true })
  await fsp.writeFile(STATS_PATH, JSON.stringify(stats, null, 2), 'utf-8')
}

export async function readMatchHistory(): Promise<ArenaMatchRecord[]> {
  try {
    const raw = await fsp.readFile(MATCH_HISTORY_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export async function appendMatchRecord(record: ArenaMatchRecord): Promise<void> {
  const history = await readMatchHistory()
  history.push(record)
  if (history.length > MAX_MATCH_HISTORY) history.splice(0, history.length - MAX_MATCH_HISTORY)
  await fsp.mkdir(COLONY_DIR, { recursive: true })
  await fsp.writeFile(MATCH_HISTORY_PATH, JSON.stringify(history, null, 2), 'utf-8')
}

export async function clearMatchHistory(): Promise<void> {
  try { await fsp.unlink(MATCH_HISTORY_PATH) } catch { /* ok */ }
}
