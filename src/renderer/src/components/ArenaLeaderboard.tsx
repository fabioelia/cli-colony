import React, { useState, useEffect, useCallback } from 'react'
import { Trophy, X, Trash2 } from 'lucide-react'
import type { ArenaStats } from '../../../shared/types'

const LS_KEY = 'arena-leaderboard'

interface Props {
  open: boolean
  onClose: () => void
}

interface LeaderboardEntry {
  name: string
  wins: number
  losses: number
  totalRuns: number
  winRate: number
}

export default function ArenaLeaderboard({ open, onClose }: Props) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])

  const load = useCallback(async () => {
    // Merge persisted localStorage stats with live arena-stats.json
    const live = await window.api.arena.getStats()
    let stored: ArenaStats = {}
    try {
      const raw = localStorage.getItem(LS_KEY)
      if (raw) stored = JSON.parse(raw)
    } catch { /* ignore */ }

    // Merge: live stats take priority for current-session data
    const merged: ArenaStats = { ...stored }
    for (const [key, val] of Object.entries(live)) {
      if (!merged[key]) {
        merged[key] = val
      } else {
        merged[key] = {
          wins: Math.max(merged[key].wins, val.wins),
          losses: Math.max(merged[key].losses, val.losses),
          totalRuns: Math.max(merged[key].totalRuns, val.totalRuns),
        }
      }
    }

    // Persist merged stats back to localStorage
    localStorage.setItem(LS_KEY, JSON.stringify(merged))

    const sorted = Object.entries(merged)
      .map(([name, s]) => ({
        name,
        wins: s.wins,
        losses: s.losses,
        totalRuns: s.totalRuns,
        winRate: s.totalRuns > 0 ? s.wins / s.totalRuns : 0,
      }))
      .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins)

    setEntries(sorted)
  }, [])

  useEffect(() => {
    if (open) load()
  }, [open, load])

  if (!open) return null

  return (
    <div className="arena-leaderboard-overlay" onClick={onClose}>
      <div className="arena-leaderboard" onClick={e => e.stopPropagation()}>
        <div className="arena-leaderboard-header">
          <span><Trophy size={14} /> Leaderboard</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              className="fork-modal-close"
              onClick={async () => {
                if (!confirm('Clear all arena stats?')) return
                await window.api.arena.clearStats()
                localStorage.removeItem(LS_KEY)
                setEntries([])
              }}
              aria-label="Clear stats"
            >
              <Trash2 size={13} />
            </button>
            <button className="fork-modal-close" onClick={onClose} aria-label="Close">
              <X size={13} />
            </button>
          </div>
        </div>
        <div className="arena-leaderboard-body">
          {entries.length === 0 ? (
            <div className="arena-leaderboard-empty">No arena results yet</div>
          ) : (
            <table className="arena-leaderboard-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Session</th>
                  <th>W</th>
                  <th>L</th>
                  <th>Rate</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr key={e.name}>
                    <td className="arena-lb-rank">{i + 1}</td>
                    <td className="arena-lb-name">{e.name}</td>
                    <td className="arena-lb-wins">{e.wins}</td>
                    <td className="arena-lb-losses">{e.losses}</td>
                    <td className="arena-lb-rate">{Math.round(e.winRate * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
