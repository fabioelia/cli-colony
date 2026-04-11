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

const COMMIT_TYPE_REGEX = /^(feat|fix|ux|perf|refactor|test|chore|docs)(\(.*?\))?!?:/
const COMMIT_TYPE_COLORS: Record<string, string> = {
  feat: 'var(--accent)', fix: 'var(--danger)', ux: 'var(--warning)',
  perf: 'var(--warning)', refactor: 'var(--text-secondary)',
  test: 'var(--success)', chore: 'var(--text-muted)', docs: 'var(--text-muted)',
}

function extractCommitTypes(artifact: SessionArtifact): string[] {
  const types = new Set<string>()
  for (const c of artifact.commits) {
    const match = c.shortMsg.match(COMMIT_TYPE_REGEX)
    if (match) types.add(match[1])
  }
  return [...types]
}

export default function ArtifactsPanel() {
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortMode>('newest')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [timeFilter, setTimeFilter] = useState<'today' | '7d' | 'all'>('today')
  const [typeFilter, setTypeFilter] = useState<string | null>(null)

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

  const timeFiltered = useMemo(() => {
    if (timeFilter === 'all') return artifacts
    const now = Date.now()
    const threshold = timeFilter === 'today'
      ? new Date().setHours(0, 0, 0, 0)
      : now - 7 * 24 * 60 * 60 * 1000
    return artifacts.filter(a => new Date(a.createdAt).getTime() >= threshold)
  }, [artifacts, timeFilter])

  const summary = useMemo(() => {
    let commits = 0, ins = 0, del = 0, cost = 0, dur = 0
    for (const a of timeFiltered) {
      commits += a.commits.length
      ins += a.totalInsertions
      del += a.totalDeletions
      cost += a.costUsd ?? 0
      dur += a.durationMs
    }
    return { sessions: timeFiltered.length, commits, insertions: ins, deletions: del, costUsd: cost, durationMs: dur }
  }, [timeFiltered])

  const availableTypes = useMemo(() => {
    const counts = new Map<string, number>()
    for (const a of timeFiltered) {
      for (const t of extractCommitTypes(a)) {
        counts.set(t, (counts.get(t) ?? 0) + 1)
      }
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => ({ type, count }))
  }, [timeFiltered])

  const filtered = useMemo(() => {
    let items = timeFiltered
    if (typeFilter) {
      items = items.filter(a => extractCommitTypes(a).includes(typeFilter))
    }
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
  }, [timeFiltered, typeFilter, filter, sort])

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

      {/* Summary strip */}
      {!loading && artifacts.length > 0 && (
        <div className="artifacts-summary-strip">
          <div className="artifacts-summary-chips">
            {(['today', '7d', 'all'] as const).map(t => (
              <button key={t} className={`activity-filter-chip ${timeFilter === t ? 'active' : ''}`}
                onClick={() => setTimeFilter(t)}>
                {t === 'today' ? 'Today' : t === '7d' ? '7 days' : 'All'}
              </button>
            ))}
          </div>
          {timeFiltered.length === 0 ? (
            <div className="artifacts-summary-stats" style={{ fontStyle: 'italic' }}>
              No sessions completed {timeFilter === 'today' ? 'today' : 'in the last 7 days'}
            </div>
          ) : (
            <div className="artifacts-summary-stats">
              <span>{summary.sessions} sessions</span>
              <span>{summary.commits} commits</span>
              <span style={{ color: 'var(--success)' }}>+{summary.insertions}</span>
              <span style={{ color: 'var(--danger)' }}>−{summary.deletions}</span>
              {summary.costUsd > 0 && <span>${summary.costUsd.toFixed(2)}</span>}
              <span>{formatDuration(summary.durationMs)}</span>
            </div>
          )}
        </div>
      )}

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
          {availableTypes.length > 0 && (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              <button className={`activity-filter-chip ${!typeFilter ? 'active' : ''}`}
                onClick={() => setTypeFilter(null)}>All</button>
              {availableTypes.map(({ type, count }) => (
                <button key={type} className={`activity-filter-chip ${typeFilter === type ? 'active' : ''}`}
                  onClick={() => setTypeFilter(typeFilter === type ? null : type)}>
                  <span style={{ color: typeFilter === type ? 'inherit' : COMMIT_TYPE_COLORS[type] }}>{type}</span>
                  <span style={{ fontSize: 10, opacity: 0.7 }}>{count}</span>
                </button>
              ))}
            </div>
          )}
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
                {extractCommitTypes(artifact).map(t => (
                  <span key={t} className="artifact-commit-tag" style={{ color: COMMIT_TYPE_COLORS[t] }}>{t}</span>
                ))}
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
