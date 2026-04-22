import { useState, useEffect, useMemo } from 'react'
import { Filter } from 'lucide-react'

type CommitEntry = { hash: string; subject: string; author: string; date: string; filesChanged?: number }

type CommitType = 'feat' | 'fix' | 'ux' | 'refactor' | 'test' | 'chore' | 'docs' | 'perf' | 'other'

const TYPE_COLORS: Record<CommitType, string> = {
  feat: 'var(--success)',
  fix: '#f59e0b',
  ux: '#3b82f6',
  perf: '#8b5cf6',
  refactor: 'var(--text-muted)',
  test: 'var(--text-muted)',
  chore: 'var(--text-muted)',
  docs: 'var(--text-muted)',
  other: 'var(--text-muted)',
}

const VISIBLE_TYPES: CommitType[] = ['feat', 'fix', 'ux', 'perf', 'refactor', 'test', 'chore', 'docs']

function parseType(subject: string): CommitType {
  const m = subject.match(/^(\w+)(!|\(.+\))?:/)
  if (!m) return 'other'
  const t = m[1].toLowerCase()
  if (VISIBLE_TYPES.includes(t as CommitType)) return t as CommitType
  return 'other'
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

function dayLabel(iso: string): string {
  const d = new Date(iso)
  const today = new Date()
  const diff = Math.floor((today.getTime() - d.getTime()) / 86_400_000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
}

export default function ChangelogTab({ workingDirectory }: { workingDirectory?: string }) {
  const [commits, setCommits] = useState<CommitEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [typeFilter, setTypeFilter] = useState<CommitType | null>(null)
  const [dayFilter, setDayFilter] = useState<string | null>(null)

  const cwd = workingDirectory || '.'

  useEffect(() => {
    setLoading(true)
    window.api.git.log(cwd, 100).then(entries => {
      // Filter to last 7 days
      const cutoff = Date.now() - 7 * 86_400_000
      setCommits(entries.filter(e => new Date(e.date).getTime() > cutoff))
    }).catch(() => setCommits([])).finally(() => setLoading(false))
  }, [cwd])

  const annotated = useMemo(() => commits.map(c => ({
    ...c,
    type: parseType(c.subject),
    day: dayLabel(c.date),
  })), [commits])

  const filtered = useMemo(() => annotated.filter(c => {
    if (typeFilter && c.type !== typeFilter) return false
    if (dayFilter && c.day !== dayFilter) return false
    return true
  }), [annotated, typeFilter, dayFilter])

  const days = useMemo(() => [...new Set(annotated.map(c => c.day))], [annotated])

  const summary = useMemo(() => {
    const counts: Partial<Record<CommitType, number>> = {}
    for (const c of annotated) counts[c.type] = (counts[c.type] || 0) + 1
    return counts
  }, [annotated])

  if (loading) return <div className="changelog-loading">Loading git history…</div>

  return (
    <div className="changelog-tab">
      <div className="changelog-summary">
        {(['feat', 'fix', 'ux'] as CommitType[]).map(t => summary[t] ? (
          <span key={t} className="changelog-summary-stat" style={{ color: TYPE_COLORS[t] }}>
            {summary[t]} {t === 'feat' ? 'features' : t === 'fix' ? 'fixes' : 'UX'}
          </span>
        ) : null)}
        <span className="changelog-summary-total">{annotated.length} commits in 7 days</span>
      </div>

      <div className="changelog-filters">
        <Filter size={10} />
        {VISIBLE_TYPES.map(t => (
          <button
            key={t}
            className={`changelog-type-chip${typeFilter === t ? ' active' : ''}`}
            style={{ '--chip-color': TYPE_COLORS[t] } as React.CSSProperties}
            onClick={() => setTypeFilter(typeFilter === t ? null : t)}
          >
            {t}
          </button>
        ))}
        <span className="changelog-filter-sep" />
        {days.map(d => (
          <button
            key={d}
            className={`changelog-day-chip${dayFilter === d ? ' active' : ''}`}
            onClick={() => setDayFilter(dayFilter === d ? null : d)}
          >
            {d}
          </button>
        ))}
        {(typeFilter || dayFilter) && (
          <button className="changelog-clear-btn" onClick={() => { setTypeFilter(null); setDayFilter(null) }}>Clear</button>
        )}
      </div>

      {filtered.length === 0 ? (
        <div className="changelog-empty">No commits match the current filters.</div>
      ) : (
        <div className="changelog-list">
          {filtered.map(c => (
            <div key={c.hash} className="changelog-entry">
              <span
                className="changelog-type-badge"
                style={{ background: TYPE_COLORS[c.type] + '22', color: TYPE_COLORS[c.type] }}
              >
                {c.type}
              </span>
              <div className="changelog-entry-body">
                <span className="changelog-subject">{c.subject.replace(/^\w+(!|\(.+\))?:\s*/, '')}</span>
                <div className="changelog-meta">
                  <code
                    className="changelog-hash"
                    title="Click to copy"
                    onClick={() => navigator.clipboard.writeText(c.hash)}
                  >
                    {c.hash.slice(0, 7)}
                  </code>
                  <span className="changelog-author">{c.author}</span>
                  <span className="changelog-time">{relativeTime(c.date)}</span>
                  {c.filesChanged != null && c.filesChanged > 0 && (
                    <span className="changelog-files">{c.filesChanged}f</span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
