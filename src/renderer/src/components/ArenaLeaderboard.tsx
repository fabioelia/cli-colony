import React, { useState, useEffect, useCallback } from 'react'
import { Trophy, X, Trash2, Gavel, Brain, Hand, ChevronDown, ChevronRight, RotateCcw } from 'lucide-react'
import type { ArenaStats, ArenaMatchRecord } from '../../../shared/types'

const LS_KEY = 'arena-leaderboard'

interface Props {
  open: boolean
  onClose: () => void
  onReplay?: (match: ArenaMatchRecord) => void
}

interface LeaderboardEntry {
  name: string
  wins: number
  losses: number
  totalRuns: number
  winRate: number
}

function relativeTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  return `${days}d ago`
}

function judgeIcon(type: ArenaMatchRecord['judgeType']): React.ReactNode {
  switch (type) {
    case 'command': return <Gavel size={11} />
    case 'llm': return <Brain size={11} />
    case 'manual': return <Hand size={11} />
  }
}

export default function ArenaLeaderboard({ open, onClose, onReplay }: Props) {
  const [entries, setEntries] = useState<LeaderboardEntry[]>([])
  const [matchHistory, setMatchHistory] = useState<ArenaMatchRecord[]>([])
  const [expandedName, setExpandedName] = useState<string | null>(null)
  const [detailMatch, setDetailMatch] = useState<ArenaMatchRecord | null>(null)

  const load = useCallback(async () => {
    // Merge persisted localStorage stats with live arena-stats.json
    const [live, history] = await Promise.all([
      window.api.arena.getStats(),
      window.api.arena.getMatchHistory(),
    ])
    setMatchHistory(history)

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
          totalRuns: 0, // recomputed below
        }
      }
      merged[key].totalRuns = merged[key].wins + merged[key].losses
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
    if (open) {
      load()
      setExpandedName(null)
      setDetailMatch(null)
    }
  }, [open, load])

  if (!open) return null

  const matchesForName = (name: string) =>
    matchHistory
      .filter(m => m.participants.some(p => p.name === name))
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())

  return (
    <div className="arena-leaderboard-overlay" onClick={onClose}>
      <div className="arena-leaderboard" onClick={e => e.stopPropagation()}>
        <div className="arena-leaderboard-header">
          <span><Trophy size={14} /> Leaderboard</span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <button
              className="fork-modal-close"
              onClick={async () => {
                if (!confirm('Clear all arena stats and match history?')) return
                await window.api.arena.clearStats()
                localStorage.removeItem(LS_KEY)
                setEntries([])
                setMatchHistory([])
                setExpandedName(null)
                setDetailMatch(null)
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
                {entries.map((e, i) => {
                  const isExpanded = expandedName === e.name
                  const matches = isExpanded ? matchesForName(e.name) : []
                  return (
                    <React.Fragment key={e.name}>
                      <tr
                        className={`arena-lb-row${isExpanded ? ' expanded' : ''}`}
                        onClick={() => setExpandedName(isExpanded ? null : e.name)}
                        style={{ cursor: 'pointer' }}
                      >
                        <td className="arena-lb-rank">{i + 1}</td>
                        <td className="arena-lb-name">
                          {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          {' '}{e.name}
                        </td>
                        <td className="arena-lb-wins">{e.wins}</td>
                        <td className="arena-lb-losses">{e.losses}</td>
                        <td className="arena-lb-rate">{Math.round(e.winRate * 100)}%</td>
                      </tr>
                      {isExpanded && (
                        <tr className="arena-lb-expansion">
                          <td colSpan={5}>
                            {matches.length === 0 ? (
                              <div className="arena-lb-no-matches">No match history</div>
                            ) : (
                              <div className="arena-lb-matches">
                                {matches.map(m => {
                                  const won = m.winnerName === e.name
                                  const opponents = m.participants
                                    .filter(p => p.name !== e.name)
                                    .map(p => p.name)
                                    .join(', ')
                                  return (
                                    <div
                                      key={m.id}
                                      className={`arena-match-row${detailMatch?.id === m.id ? ' selected' : ''}`}
                                      onClick={(ev) => {
                                        ev.stopPropagation()
                                        setDetailMatch(detailMatch?.id === m.id ? null : m)
                                      }}
                                    >
                                      <span className={`arena-match-result ${won ? 'win' : 'loss'}`}>
                                        {won ? 'W' : 'L'}
                                      </span>
                                      <span className="arena-match-opponent">{opponents || '—'}</span>
                                      <span className="arena-match-judge">{judgeIcon(m.judgeType)}</span>
                                      <span className="arena-match-prompt">
                                        {m.prompt ? (m.prompt.length > 50 ? m.prompt.slice(0, 50) + '…' : m.prompt) : '—'}
                                      </span>
                                      <span className="arena-match-time">{relativeTime(m.timestamp)}</span>
                                    </div>
                                  )
                                })}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Match detail modal */}
        {detailMatch && (
          <div className="arena-match-detail" onClick={(ev) => ev.stopPropagation()}>
            <div className="arena-match-detail-header">
              <span>Match Details</span>
              <button className="fork-modal-close" onClick={() => setDetailMatch(null)} aria-label="Close detail">
                <X size={12} />
              </button>
            </div>
            <div className="arena-match-detail-body">
              <div className="arena-match-detail-row">
                <span className="arena-match-detail-label">Date</span>
                <span>{new Date(detailMatch.timestamp).toLocaleString()}</span>
              </div>
              <div className="arena-match-detail-row">
                <span className="arena-match-detail-label">Judge</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  {judgeIcon(detailMatch.judgeType)} {detailMatch.judgeType}
                </span>
              </div>
              <div className="arena-match-detail-row">
                <span className="arena-match-detail-label">Winner</span>
                <span className="arena-match-result win">{detailMatch.winnerName}</span>
              </div>
              <div className="arena-match-detail-row">
                <span className="arena-match-detail-label">Participants</span>
                <span>{detailMatch.participants.map(p => p.model ? `${p.name} (${p.model})` : p.name).join(', ')}</span>
              </div>
              {detailMatch.prompt && (
                <div className="arena-match-detail-row" style={{ flexDirection: 'column', gap: 4 }}>
                  <span className="arena-match-detail-label">Prompt</span>
                  <span className="arena-match-detail-prompt">{detailMatch.prompt}</span>
                </div>
              )}
              {detailMatch.verdictText && (
                <div className="arena-match-detail-row" style={{ flexDirection: 'column', gap: 4 }}>
                  <span className="arena-match-detail-label">Verdict</span>
                  <span className="arena-match-detail-verdict">{detailMatch.verdictText}</span>
                </div>
              )}
              {onReplay && detailMatch.prompt && (
                <button
                  className="panel-header-btn primary"
                  style={{ marginTop: 8, alignSelf: 'flex-start' }}
                  onClick={() => onReplay(detailMatch)}
                >
                  <RotateCcw size={12} /> Replay
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
