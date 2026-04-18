import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { Archive, GitCommit, ChevronRight, Search, Trash2, Clock, DollarSign, FileText, Zap, ArrowLeftRight, ArrowLeft, CheckSquare } from 'lucide-react'
import HelpPopover from './HelpPopover'
import EmptyStateHook from './EmptyStateHook'
import type { SessionArtifact, GitDiffEntry } from '../../../shared/types'

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

function pctDelta(a: number, b: number): string {
  if (a === 0 && b === 0) return '—'
  if (a === 0) return '+∞'
  const pct = ((b - a) / a) * 100
  const sign = pct > 0 ? '+' : ''
  return `${sign}${Math.round(pct)}%`
}

function fileOverlap(a: GitDiffEntry[], b: GitDiffEntry[]): { onlyA: string[]; onlyB: string[]; both: string[] } {
  const filesA = new Set(a.map(e => e.file))
  const filesB = new Set(b.map(e => e.file))
  const both: string[] = []
  const onlyA: string[] = []
  const onlyB: string[] = []
  for (const f of filesA) {
    if (filesB.has(f)) both.push(f)
    else onlyA.push(f)
  }
  for (const f of filesB) {
    if (!filesA.has(f)) onlyB.push(f)
  }
  return { onlyA, onlyB, both }
}

function ArtifactCompareView({ a, b, onBack }: { a: SessionArtifact; b: SessionArtifact; onBack: () => void }) {
  const overlap = useMemo(() => fileOverlap(a.changes, b.changes), [a, b])

  const metrics = [
    { label: 'Duration', valA: formatDuration(a.durationMs), valB: formatDuration(b.durationMs), delta: pctDelta(a.durationMs, b.durationMs), better: b.durationMs < a.durationMs ? 'b' : b.durationMs > a.durationMs ? 'a' : null },
    { label: 'Cost', valA: a.costUsd != null ? `$${a.costUsd.toFixed(2)}` : '—', valB: b.costUsd != null ? `$${b.costUsd.toFixed(2)}` : '—', delta: a.costUsd != null && b.costUsd != null ? pctDelta(a.costUsd, b.costUsd) : '—', better: (a.costUsd ?? 0) > (b.costUsd ?? 0) ? 'b' : (a.costUsd ?? 0) < (b.costUsd ?? 0) ? 'a' : null },
    { label: 'Commits', valA: String(a.commits.length), valB: String(b.commits.length), delta: pctDelta(a.commits.length, b.commits.length), better: null },
    { label: 'Insertions', valA: `+${a.totalInsertions}`, valB: `+${b.totalInsertions}`, delta: pctDelta(a.totalInsertions, b.totalInsertions), better: null },
    { label: 'Deletions', valA: `-${a.totalDeletions}`, valB: `-${b.totalDeletions}`, delta: pctDelta(a.totalDeletions, b.totalDeletions), better: null },
    { label: 'Exit code', valA: String(a.exitCode), valB: String(b.exitCode), delta: a.exitCode === b.exitCode ? '=' : '≠', better: a.exitCode === 0 && b.exitCode !== 0 ? 'a' : b.exitCode === 0 && a.exitCode !== 0 ? 'b' : null },
  ]

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="panel-header">
        <button className="panel-header-back" onClick={onBack} title="Back to list">
          <ArrowLeft size={14} />
        </button>
        <h2><ArrowLeftRight size={16} /> Compare</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="artifacts" zone="Compare" align="right" />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: 16 }}>
        {/* Session names header */}
        <div className="artifact-compare-header">
          <div className="artifact-compare-label">
            <span className="artifact-compare-dot" style={{ background: 'var(--accent)' }} />
            <span className="artifact-compare-name">{a.sessionName}</span>
            {a.personaName && <span className="artifact-compare-persona">{a.personaName}</span>}
          </div>
          <div style={{ width: 80, textAlign: 'center', fontSize: 11, opacity: 0.5 }}>Delta</div>
          <div className="artifact-compare-label">
            <span className="artifact-compare-dot" style={{ background: 'var(--warning)' }} />
            <span className="artifact-compare-name">{b.sessionName}</span>
            {b.personaName && <span className="artifact-compare-persona">{b.personaName}</span>}
          </div>
        </div>

        {/* Metrics grid */}
        <div className="artifact-compare-metrics">
          {metrics.map(m => (
            <div key={m.label} className="artifact-compare-row">
              <div className={`artifact-compare-val ${m.better === 'a' ? 'better' : ''}`}>{m.valA}</div>
              <div className="artifact-compare-metric-label">
                <span className="artifact-compare-metric-name">{m.label}</span>
                <span className="artifact-compare-delta">{m.delta}</span>
              </div>
              <div className={`artifact-compare-val ${m.better === 'b' ? 'better' : ''}`}>{m.valB}</div>
            </div>
          ))}
        </div>

        {/* File overlap */}
        <div style={{ marginTop: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 12, marginBottom: 8, textTransform: 'uppercase', letterSpacing: '0.03em', opacity: 0.6 }}>
            Files Changed
          </div>

          {overlap.both.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--warning)', marginBottom: 4 }}>
                Both sessions ({overlap.both.length})
              </div>
              {overlap.both.map(f => (
                <div key={f} className="artifact-compare-file both">{f}</div>
              ))}
            </div>
          )}

          {overlap.onlyA.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', marginBottom: 4 }}>
                Only {a.sessionName} ({overlap.onlyA.length})
              </div>
              {overlap.onlyA.map(f => (
                <div key={f} className="artifact-compare-file only-a">{f}</div>
              ))}
            </div>
          )}

          {overlap.onlyB.length > 0 && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--warning)', marginBottom: 4 }}>
                Only {b.sessionName} ({overlap.onlyB.length})
              </div>
              {overlap.onlyB.map(f => (
                <div key={f} className="artifact-compare-file only-b">{f}</div>
              ))}
            </div>
          )}

          {overlap.both.length === 0 && overlap.onlyA.length === 0 && overlap.onlyB.length === 0 && (
            <div style={{ opacity: 0.5, fontStyle: 'italic', fontSize: 12 }}>No file changes in either session</div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ArtifactsPanel() {
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortMode>('newest')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [timeFilter, setTimeFilter] = useState<'today' | '7d' | 'all'>('today')
  const [typeFilter, setTypeFilter] = useState<string | null>(null)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [selectModeActive, setSelectModeActive] = useState(false)
  const [comparing, setComparing] = useState(false)

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
    setSelectedIds(new Set())
    setSelectModeActive(false)
  }, [])

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) { next.delete(id) } else if (next.size < 2) { next.add(id) }
      return next
    })
  }, [])

  const handleCompare = useCallback(() => {
    if (selectedIds.size === 2) setComparing(true)
  }, [selectedIds])

  const handleBackFromCompare = useCallback(() => {
    setComparing(false)
    setSelectModeActive(false)
    setSelectedIds(new Set())
  }, [])

  // Resolve the two selected artifacts for comparison
  const compareArtifacts = useMemo(() => {
    if (!comparing || selectedIds.size !== 2) return null
    const ids = [...selectedIds]
    const a = artifacts.find(x => x.sessionId === ids[0])
    const b = artifacts.find(x => x.sessionId === ids[1])
    if (!a || !b) return null
    // Order by creation time (older first = "A")
    return new Date(a.createdAt) <= new Date(b.createdAt) ? { a, b } : { a: b, b: a }
  }, [comparing, selectedIds, artifacts])

  if (comparing && compareArtifacts) {
    return <ArtifactCompareView a={compareArtifacts.a} b={compareArtifacts.b} onBack={handleBackFromCompare} />
  }

  const selectMode = selectModeActive || selectedIds.size > 0

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2><Archive size={16} /> Artifacts</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="artifacts" align="right" />
        <div className="panel-header-actions">
          {artifacts.length > 0 && (
            <>
              {selectMode && (
                <button className="panel-header-btn" onClick={() => { setSelectedIds(new Set()); setSelectModeActive(false) }} title="Cancel selection">
                  Cancel
                </button>
              )}
              {selectedIds.size === 2 && (
                <button className="panel-header-btn primary" onClick={handleCompare} title="Compare selected sessions">
                  <ArrowLeftRight size={13} /> Compare
                </button>
              )}
              {!selectMode && (
                <button className="panel-header-btn" onClick={() => setSelectModeActive(true)} title="Select sessions to compare">
                  <CheckSquare size={13} /> Select
                </button>
              )}
              <button className="panel-header-btn" onClick={handleClear} title="Clear all artifacts">
                <Trash2 size={13} /> Clear
              </button>
            </>
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
          <EmptyStateHook icon={Archive} title="Session Artifacts" hook="No session artifacts yet. Completed sessions appear here with their git commits, cost, and summary." />
        )}

        {artifacts.length >= 200 && (
          <div style={{ fontSize: 11, opacity: 0.5, padding: '4px 0 8px', textAlign: 'center' }}>
            Showing last 200 sessions
          </div>
        )}

        {selectMode && selectedIds.size < 2 && (
          <div style={{ fontSize: 12, opacity: 0.6, padding: '4px 0 8px', textAlign: 'center' }}>
            Select {2 - selectedIds.size} more session{selectedIds.size === 0 ? 's' : ''} to compare
          </div>
        )}

        {filtered.map((artifact) => {
          const expanded = expandedId === artifact.sessionId
          const selected = selectedIds.has(artifact.sessionId)
          return (
            <div
              key={artifact.sessionId}
              style={{
                border: `1px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 6,
                marginBottom: 6,
                background: selected ? 'rgba(59, 130, 246, 0.08)' : expanded ? 'var(--bg-tertiary)' : 'var(--bg-secondary)',
                transition: 'background 0.15s, border-color 0.15s',
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
                onClick={() => selectMode ? toggleSelect(artifact.sessionId) : toggleExpand(artifact.sessionId)}
              >
                {selectMode ? (
                  <input
                    type="checkbox"
                    checked={selected}
                    disabled={!selected && selectedIds.size >= 2}
                    onChange={() => toggleSelect(artifact.sessionId)}
                    onClick={e => e.stopPropagation()}
                    style={{ flexShrink: 0, cursor: 'pointer', accentColor: 'var(--accent)' }}
                  />
                ) : (
                  <ChevronRight
                    size={12}
                    style={{
                      flexShrink: 0,
                      transition: 'transform 0.15s',
                      transform: expanded ? 'rotate(90deg)' : 'none',
                      opacity: 0.5,
                    }}
                  />
                )}
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
                {artifact.pipelineRunId && (
                  <span
                    title={`Pipeline run: ${artifact.pipelineRunId}`}
                    style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 3,
                      background: 'rgba(245, 158, 11, 0.15)',
                      color: 'var(--warning)',
                      whiteSpace: 'nowrap',
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 3,
                    }}
                  >
                    <Zap size={10} /> Pipeline
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
                  {/* Summary line */}
                  {artifact.summary && (
                    <div style={{ marginBottom: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                      {artifact.summary}
                    </div>
                  )}

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
