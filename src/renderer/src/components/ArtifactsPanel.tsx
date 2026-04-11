import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Archive, GitCommit, ChevronRight, Search, Trash2, Clock, DollarSign, FileText } from 'lucide-react'
import HelpPopover from './HelpPopover'
import EmptyStateHook from './EmptyStateHook'
import type { SessionArtifact } from '../../../shared/types'

type SortMode = 'newest' | 'changes' | 'cost'

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}

function statusColor(status: string): string {
  if (status === 'A') return 'var(--success)'
  if (status === 'D') return 'var(--danger)'
  return 'var(--warning)'
}

function statusTitle(status: string): string {
  if (status === 'A') return 'Added'
  if (status === 'D') return 'Deleted'
  if (status === 'R') return 'Renamed'
  return 'Modified'
}

export default function ArtifactsPanel() {
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortMode>('newest')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  const loadArtifacts = useCallback(async () => {
    try {
      const list = await window.api.artifacts.list()
      setArtifacts(list)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadArtifacts()
    const interval = setInterval(loadArtifacts, 60_000)
    return () => clearInterval(interval)
  }, [loadArtifacts])

  const filtered = useMemo(() => {
    let items = artifacts
    if (filter) {
      const q = filter.toLowerCase()
      items = items.filter(
        (a) =>
          a.sessionName.toLowerCase().includes(q) ||
          (a.personaName && a.personaName.toLowerCase().includes(q))
      )
    }
    if (sort === 'changes') {
      items = [...items].sort((a, b) => (b.totalInsertions + b.totalDeletions) - (a.totalInsertions + a.totalDeletions))
    } else if (sort === 'cost') {
      items = [...items].sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0))
    }
    // 'newest' is already default order from API
    return items
  }, [artifacts, filter, sort])

  const handleClear = useCallback(async () => {
    if (!confirm('Clear all session artifacts? This cannot be undone.')) return
    await window.api.artifacts.clear()
    setArtifacts([])
    setExpandedId(null)
  }, [])

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2><Archive size={16} /> Artifacts</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="artifacts" align="right" />
        <div className="panel-header-actions">
          {artifacts.length > 0 && (
            <button className="panel-header-btn" onClick={handleClear} title="Clear all artifacts">
              <Trash2 size={13} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Controls */}
      {artifacts.length > 0 && (
        <div style={{ display: 'flex', gap: 8, padding: '8px 16px', alignItems: 'center' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }} />
            <input
              type="text"
              placeholder="Filter by session or persona..."
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{
                width: '100%',
                paddingLeft: 28,
                padding: '5px 8px 5px 28px',
                background: 'var(--bg-secondary)',
                border: '1px solid var(--border)',
                borderRadius: 4,
                color: 'var(--text-primary)',
                fontSize: 12,
              }}
            />
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortMode)}
            style={{
              background: 'var(--bg-secondary)',
              border: '1px solid var(--border)',
              borderRadius: 4,
              color: 'var(--text-primary)',
              fontSize: 12,
              padding: '5px 8px',
            }}
          >
            <option value="newest">Newest</option>
            <option value="changes">Most changes</option>
            <option value="cost">Highest cost</option>
          </select>
        </div>
      )}

      {/* List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 16px 16px' }}>
        {loading && <div style={{ padding: 16, opacity: 0.5, fontSize: 13 }}>Loading...</div>}

        {!loading && artifacts.length === 0 && (
          <EmptyStateHook topic="artifacts" />
        )}

        {artifacts.length >= 200 && (
          <div style={{ fontSize: 11, opacity: 0.5, padding: '4px 0 8px', textAlign: 'center' }}>
            Showing last 200 sessions
          </div>
        )}

        {filtered.map((artifact) => {
          const expanded = expandedId === artifact.sessionId
          return (
            <div
              key={artifact.sessionId}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 6,
                marginBottom: 6,
                background: expanded ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
                transition: 'background 0.15s',
              }}
            >
              {/* Row header */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '8px 10px',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
                onClick={() => toggleExpand(artifact.sessionId)}
              >
                <ChevronRight
                  size={12}
                  style={{
                    flexShrink: 0,
                    transition: 'transform 0.15s',
                    transform: expanded ? 'rotate(90deg)' : 'none',
                    opacity: 0.5,
                  }}
                />
                <span style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: artifact.exitCode === 0 ? 'var(--success)' : 'var(--danger)',
                  flexShrink: 0,
                }} />
                <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {artifact.sessionName}
                </span>
                {artifact.personaName && (
                  <span style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 3,
                    background: 'var(--accent)',
                    color: '#fff',
                    whiteSpace: 'nowrap',
                  }}>
                    {artifact.personaName}
                  </span>
                )}
                {artifact.gitBranch && (
                  <span style={{
                    fontSize: 10,
                    padding: '1px 6px',
                    borderRadius: 3,
                    background: 'var(--bg-primary)',
                    border: '1px solid var(--border)',
                    whiteSpace: 'nowrap',
                    maxWidth: 120,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {artifact.gitBranch}
                  </span>
                )}
                {artifact.commits.length > 0 && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 3, fontSize: 11, opacity: 0.7, whiteSpace: 'nowrap' }}>
                    <GitCommit size={11} /> {artifact.commits.length}
                  </span>
                )}
                {(artifact.totalInsertions > 0 || artifact.totalDeletions > 0) && (
                  <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                    {artifact.totalInsertions > 0 && <span style={{ color: 'var(--success)' }}>+{artifact.totalInsertions}</span>}
                    {artifact.totalInsertions > 0 && artifact.totalDeletions > 0 && '/'}
                    {artifact.totalDeletions > 0 && <span style={{ color: 'var(--danger)' }}>-{artifact.totalDeletions}</span>}
                  </span>
                )}
                {artifact.costUsd != null && (
                  <span style={{
                    fontSize: 10,
                    padding: '1px 5px',
                    borderRadius: 3,
                    background: 'rgba(16, 185, 129, 0.15)',
                    color: 'var(--success)',
                    whiteSpace: 'nowrap',
                  }}>
                    ${artifact.costUsd.toFixed(2)}
                  </span>
                )}
                <span style={{ fontSize: 11, opacity: 0.5, whiteSpace: 'nowrap' }}>
                  {formatRelativeTime(artifact.createdAt)}
                </span>
              </div>

              {/* Expanded detail */}
              {expanded && (
                <div style={{ padding: '0 10px 10px 30px', fontSize: 12 }}>
                  {/* Meta row */}
                  <div style={{ display: 'flex', gap: 12, marginBottom: 8, opacity: 0.7, fontSize: 11 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                      <Clock size={11} /> {formatDuration(artifact.durationMs)}
                    </span>
                    {artifact.costUsd != null && (
                      <span style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <DollarSign size={11} /> ${artifact.costUsd.toFixed(4)}
                      </span>
                    )}
                    <span>Exit: {artifact.exitCode}</span>
                  </div>

                  {/* Commits */}
                  {artifact.commits.length > 0 && (
                    <div style={{ marginBottom: 8 }}>
                      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em', opacity: 0.6 }}>
                        Commits
                      </div>
                      {artifact.commits.map((c) => (
                        <div key={c.hash} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0' }}>
                          <code style={{ fontSize: 11, opacity: 0.6, fontFamily: 'monospace' }}>{c.hash.slice(0, 7)}</code>
                          <span>{c.shortMsg}</span>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* File changes */}
                  {artifact.changes.length > 0 && (
                    <div>
                      <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.03em', opacity: 0.6 }}>
                        Files changed
                      </div>
                      {artifact.changes.map((entry) => (
                        <div key={entry.file} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '2px 0' }}>
                          <span style={{ color: statusColor(entry.status), fontWeight: 700, fontSize: 11, width: 14, textAlign: 'center', flexShrink: 0 }} title={statusTitle(entry.status)}>
                            {entry.status}
                          </span>
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {entry.file}
                          </span>
                          <span style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                            {entry.insertions > 0 && <span style={{ color: 'var(--success)' }}>+{entry.insertions}</span>}
                            {entry.insertions > 0 && entry.deletions > 0 && ' '}
                            {entry.deletions > 0 && <span style={{ color: 'var(--danger)' }}>-{entry.deletions}</span>}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}

                  {artifact.commits.length === 0 && artifact.changes.length === 0 && (
                    <div style={{ opacity: 0.5, fontStyle: 'italic' }}>
                      No commits or file changes recorded
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
