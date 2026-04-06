import { ipcMain, app } from 'electron'
import * as fs from 'fs'
import { join } from 'path'
import type { ArenaStats } from '../../shared/types'

const STATS_PATH = join(app.getPath('home'), '.claude-colony', 'arena-stats.json')

function readStats(): ArenaStats {
  try {
    if (!fs.existsSync(STATS_PATH)) return {}
    const raw = fs.readFileSync(STATS_PATH, 'utf-8')
    const parsed = JSON.parse(raw)
    return typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as ArenaStats) : {}
  } catch {
    return {}
  }
}

export function registerArenaHandlers(): void {
  ipcMain.handle('arena:recordWinner', (_e, winnerKey: string, loserKey: string): boolean => {
    try {
      const stats = readStats()
      if (!stats[winnerKey]) stats[winnerKey] = { wins: 0, losses: 0, totalRuns: 0 }
      if (!stats[loserKey]) stats[loserKey] = { wins: 0, losses: 0, totalRuns: 0 }
      stats[winnerKey].wins++
      stats[winnerKey].totalRuns++
      stats[loserKey].losses++
      stats[loserKey].totalRuns++
      const dir = join(app.getPath('home'), '.claude-colony')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(STATS_PATH, JSON.stringify(stats, null, 2), 'utf-8')
      return true
    } catch {
      return false
    }
  })

  ipcMain.handle('arena:getStats', (): ArenaStats => readStats())
}
