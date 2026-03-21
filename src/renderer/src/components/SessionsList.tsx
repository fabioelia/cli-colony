import { useState, useEffect } from 'react'
import type { CliSession } from '../types'

interface Props {
  onResume: (session: CliSession) => void
}

export default function SessionsList({ onResume }: Props) {
  const [sessions, setSessions] = useState<CliSession[]>([])
  const [search, setSearch] = useState('')

  useEffect(() => {
    window.api.sessions.list(100).then(setSessions)
  }, [])

  const filtered = search
    ? sessions.filter(
        (s) =>
          s.display.toLowerCase().includes(search.toLowerCase()) ||
          s.projectName.toLowerCase().includes(search.toLowerCase())
      )
    : sessions

  const formatTime = (ts: number) => {
    const d = new Date(ts)
    const now = new Date()
    const diff = now.getTime() - ts
    if (diff < 60000) return 'just now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`
    return d.toLocaleDateString()
  }

  return (
    <div className="sessions-list">
      <div className="sessions-header">
        <h2>Resume a Session</h2>
        <input
          className="sessions-search"
          placeholder="Search sessions..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="sessions-items">
        {filtered.map((s) => (
          <div key={s.sessionId} className="session-item" onClick={() => onResume(s)}>
            <div className="session-item-main">
              <div className="session-item-display">{s.display}</div>
              <div className="session-item-meta">
                <span className="session-project">{s.projectName}</span>
                <span className="session-time">{formatTime(s.timestamp)}</span>
                <span className="session-id">{s.sessionId.slice(0, 8)}</span>
              </div>
            </div>
            <button className="session-resume-btn">Resume</button>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="sessions-empty">
            {search ? 'No sessions match your search' : 'No CLI sessions found'}
          </div>
        )}
      </div>
    </div>
  )
}
