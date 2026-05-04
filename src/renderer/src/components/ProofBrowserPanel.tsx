import { useState, useEffect, useMemo, useCallback } from 'react'
import { Archive, ChevronLeft, ChevronRight, Search, X, ChevronDown } from 'lucide-react'
import HelpPopover from './HelpPopover'
import type { ProofEntry } from '../../../shared/types'

function todayStr(): string {
  return new Date().toISOString().slice(0, 10)
}

function dateMinusDays(days: number): string {
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().slice(0, 10)
}

function parseCostNumber(cost: string): number {
  if (!cost) return 0
  const match = cost.match(/[\d.]+/)
  return match ? parseFloat(match[0]) : 0
}

function formatCost(num: number): string {
  if (num === 0) return '$0.00'
  if (num < 0.01) return `$${num.toFixed(4)}`
  return `$${num.toFixed(2)}`
}

function parseDurationSeconds(dur: string): number {
  if (!dur) return 0
  let total = 0
  const h = dur.match(/(\d+)h/)
  const m = dur.match(/(\d+)m/)
  const s = dur.match(/(\d+)s/)
  if (h) total += parseInt(h[1]) * 3600
  if (m) total += parseInt(m[1]) * 60
  if (s) total += parseInt(s[1])
  return total
}

function formatDurationShort(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`
  const m = Math.floor(secs / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`
}

function heatmapColor(count: number): string {
  if (count === 0) return 'rgba(255,255,255,0.05)'
  if (count <= 2) return 'rgba(52,211,153,0.3)'
  if (count <= 5) return 'rgba(52,211,153,0.6)'
  return 'rgba(52,211,153,0.9)'
}

type SuccessFilter = 'all' | 'success' | 'failure'

export default function ProofBrowserPanel() {
  const [date, setDate] = useState<string>(todayStr())
  const [proofs, setProofs] = useState<ProofEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [expandedPath, setExpandedPath] = useState<string | null>(null)
  const [expandedContent, setExpandedContent] = useState<string>('')
  const [contentLoading, setContentLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [personaFilter, setPersonaFilter] = useState<string>('all')
  const [successFilter, setSuccessFilter] = useState<SuccessFilter>('all')
  const [analytics30, setAnalytics30] = useState<ProofEntry[]>([])
  const [analyticsOpen, setAnalyticsOpen] = useState<boolean>(() => {
    try { return localStorage.getItem('proof-analytics-open') !== 'false' }
    catch { return true }
  })

  const loadProofs = useCallback(async (d: string) => {
    setLoading(true)
    try {
      const results = await window.api.proofs.list(d, d)
      setProofs(results)
    } catch {
      setProofs([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadProofs(date)
  }, [date, loadProofs])

  useEffect(() => {
    window.api.proofs.list(dateMinusDays(29), todayStr())
      .then(setAnalytics30)
      .catch(() => setAnalytics30([]))
  }, [])

  useEffect(() => {
    const unsub = window.api.proofs.onNewProof(() => {
      loadProofs(date)
      window.api.proofs.list(dateMinusDays(29), todayStr())
        .then(setAnalytics30)
        .catch(() => {})
    })
    return unsub
  }, [date, loadProofs])

  const toggleAnalytics = () => {
    setAnalyticsOpen(v => {
      const next = !v
      try { localStorage.setItem('proof-analytics-open', String(next)) }
      catch {}
      return next
    })
  }

  const analytics = useMemo(() => {
    const all = analytics30
    const total = all.length
    const withCost = all.filter(p => p.cost)
    const withDuration = all.filter(p => p.duration)
    const withExit = all.filter(p => p.exitCode !== undefined && p.exitCode !== null)
    const successCount = withExit.filter(p => p.exitCode === 0).length

    const totalCost = withCost.reduce((acc, p) => acc + parseCostNumber(p.cost), 0)
    const avgCost = withCost.length > 0 ? totalCost / withCost.length : 0
    const totalDurSecs = withDuration.reduce((acc, p) => acc + parseDurationSeconds(p.duration), 0)
    const avgDurSecs = withDuration.length > 0 ? totalDurSecs / withDuration.length : 0
    const successRate = withExit.length > 0 ? Math.round((successCount / withExit.length) * 100) : null

    // Heatmap: count sessions per day for 30 days
    const sessionsByDay: Record<string, number> = {}
    for (let i = 29; i >= 0; i--) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      sessionsByDay[d.toISOString().slice(0, 10)] = 0
    }
    for (const p of all) {
      if (p.date && sessionsByDay[p.date] !== undefined) {
        sessionsByDay[p.date]++
      }
    }

    // Persona breakdown: top 5 + other
    const personaMap: Record<string, number> = {}
    for (const p of all) {
      const key = p.persona || 'ad-hoc'
      personaMap[key] = (personaMap[key] ?? 0) + 1
    }
    const sorted = Object.entries(personaMap).sort((a, b) => b[1] - a[1])
    const top5 = sorted.slice(0, 5)
    const otherCount = sorted.slice(5).reduce((acc, e) => acc + e[1], 0)
    const personaBreakdown = otherCount > 0 ? [...top5, ['other', otherCount]] : top5

    // Hour distribution: extract hour from path timestamp
    const hourDist = new Array(24).fill(0) as number[]
    for (const p of all) {
      const match = p.path.match(/(\d+)\.md$/)
      if (match) {
        const ts = parseInt(match[1])
        if (ts > 1e12) {
          hourDist[new Date(ts).getHours()]++
        }
      }
    }

    return {
      total,
      totalCost,
      avgCost,
      avgDurSecs,
      successRate,
      sessionsByDay,
      personaBreakdown,
      hourDist,
    }
  }, [analytics30])

  const personas = useMemo(() => {
    const set = new Set<string>()
    for (const p of proofs) {
      if (p.persona) set.add(p.persona)
    }
    return Array.from(set).sort()
  }, [proofs])

  const filtered = useMemo(() => {
    return proofs.filter(p => {
      if (successFilter === 'success' && p.exitCode !== 0) return false
      if (successFilter === 'failure' && p.exitCode === 0) return false
      if (personaFilter !== 'all' && p.persona !== personaFilter) return false
      if (search) {
        const q = search.toLowerCase()
        if (!p.name.toLowerCase().includes(q) && !p.branch.toLowerCase().includes(q)) return false
      }
      return true
    })
  }, [proofs, successFilter, personaFilter, search])

  const stats = useMemo(() => {
    const total = proofs.length
    const success = proofs.filter(p => p.exitCode === 0).length
    const totalCost = proofs.reduce((acc, p) => acc + parseCostNumber(p.cost), 0)
    const rate = total > 0 ? Math.round((success / total) * 100) : 0
    return { total, success, totalCost, rate }
  }, [proofs])

  const prevDay = () => {
    const d = new Date(date + 'T12:00:00')
    d.setDate(d.getDate() - 1)
    setDate(d.toISOString().slice(0, 10))
    setExpandedPath(null)
  }

  const nextDay = () => {
    const d = new Date(date + 'T12:00:00')
    d.setDate(d.getDate() + 1)
    const next = d.toISOString().slice(0, 10)
    if (next <= todayStr()) {
      setDate(next)
      setExpandedPath(null)
    }
  }

  const toggleExpand = async (p: ProofEntry) => {
    if (expandedPath === p.path) {
      setExpandedPath(null)
      return
    }
    setExpandedPath(p.path)
    setContentLoading(true)
    try {
      const content = await window.api.proofs.read(p.path)
      setExpandedContent(content)
    } catch {
      setExpandedContent('(Could not load proof content)')
    } finally {
      setContentLoading(false)
    }
  }

  const isToday = date === todayStr()
  const heatmapDays = Object.entries(analytics.sessionsByDay)
  const maxHour = Math.max(1, ...analytics.hourDist)
  const personaTotal = analytics.personaBreakdown.reduce((acc, [, c]) => acc + (c as number), 0)

  const PERSONA_COLORS = [
    'rgba(52,211,153,0.85)',
    'rgba(96,165,250,0.85)',
    'rgba(251,146,60,0.85)',
    'rgba(196,181,253,0.85)',
    'rgba(251,191,36,0.85)',
    'rgba(156,163,175,0.6)',
  ]

  return (
    <div className="proof-browser-panel" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      {/* Panel Header */}
      <div className="panel-header">
        <h2><Archive size={16} /> Proofs</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="proofs" align="right" />
      </div>

      {/* Stats Bar */}
      <div style={{
        display: 'flex', gap: 24, padding: '10px 16px',
        borderBottom: '1px solid var(--border)',
        fontSize: 13, flexShrink: 0,
      }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Today</span>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{stats.total}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Total Cost</span>
          <span style={{ fontWeight: 600, color: 'var(--text)' }}>{formatCost(stats.totalCost)}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Success Rate</span>
          <span style={{ fontWeight: 600, color: stats.rate >= 80 ? 'var(--green)' : stats.rate >= 50 ? 'var(--yellow)' : 'var(--red)' }}>
            {stats.total > 0 ? `${stats.rate}%` : '—'}
          </span>
        </div>
      </div>

      {/* Analytics Section */}
      <div style={{ borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
        <button
          onClick={toggleAnalytics}
          style={{
            width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 16px', background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--text-muted)', fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.05em',
          }}
        >
          <span>Analytics — 30 days</span>
          <ChevronDown size={12} style={{ transition: 'transform 0.15s', transform: analyticsOpen ? 'rotate(180deg)' : 'none' }} />
        </button>

        {analyticsOpen && (
          <div style={{ padding: '0 16px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>

            {/* Summary Stats Row */}
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {[
                { label: 'Sessions', value: String(analytics.total) },
                {
                  label: 'Success',
                  value: analytics.successRate !== null ? `${analytics.successRate}%` : '—',
                  color: analytics.successRate === null ? undefined
                    : analytics.successRate >= 80 ? 'var(--green)'
                    : analytics.successRate >= 50 ? 'var(--yellow)' : 'var(--red)',
                },
                { label: 'Avg Cost', value: analytics.avgCost > 0 ? formatCost(analytics.avgCost) : '—' },
                { label: 'Avg Duration', value: analytics.avgDurSecs > 0 ? formatDurationShort(analytics.avgDurSecs) : '—' },
                { label: 'Total Cost', value: analytics.totalCost > 0 ? formatCost(analytics.totalCost) : '—' },
              ].map(({ label, value, color }) => (
                <div key={label} style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                  borderRadius: 6, padding: '6px 10px', display: 'flex', flexDirection: 'column', gap: 2, minWidth: 60,
                }}>
                  <span style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</span>
                  <span style={{ fontWeight: 600, fontSize: 13, color: color ?? 'var(--text)' }}>{value}</span>
                </div>
              ))}
            </div>

            {/* Activity Heatmap */}
            {analytics.total > 0 && (
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Activity</div>
                <div style={{ overflowX: 'auto' }}>
                  <svg width={heatmapDays.length * 16} height={28} style={{ display: 'block' }}>
                    {heatmapDays.map(([day, count], i) => (
                      <g key={day}>
                        <rect
                          x={i * 16}
                          y={0}
                          width={14}
                          height={14}
                          rx={2}
                          style={{ fill: heatmapColor(count as number) }}
                        >
                          <title>{day}: {count} session{(count as number) !== 1 ? 's' : ''}</title>
                        </rect>
                        {i === 0 || new Date(day + 'T12:00:00').getDate() === 1 ? (
                          <text x={i * 16} y={26} style={{ fill: 'var(--text-muted)', fontSize: 9 }}>
                            {day.slice(5)}
                          </text>
                        ) : null}
                      </g>
                    ))}
                  </svg>
                </div>
              </div>
            )}

            {/* Persona Breakdown */}
            {analytics.personaBreakdown.length > 0 && analytics.total > 0 && (
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>By Persona</div>
                <div style={{ display: 'flex', borderRadius: 4, overflow: 'hidden', height: 16 }}>
                  {analytics.personaBreakdown.map(([name, count], i) => {
                    const pct = personaTotal > 0 ? ((count as number) / personaTotal) * 100 : 0
                    return (
                      <div
                        key={name as string}
                        title={`${name}: ${count} session${(count as number) !== 1 ? 's' : ''} (${Math.round(pct)}%)`}
                        style={{
                          width: `${pct}%`, background: PERSONA_COLORS[i % PERSONA_COLORS.length],
                          minWidth: pct > 0 ? 2 : 0,
                        }}
                      />
                    )
                  })}
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 4, flexWrap: 'wrap' }}>
                  {analytics.personaBreakdown.map(([name, count], i) => (
                    <div key={name as string} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10 }}>
                      <div style={{ width: 8, height: 8, borderRadius: 2, background: PERSONA_COLORS[i % PERSONA_COLORS.length], flexShrink: 0 }} />
                      <span style={{ color: 'var(--text-muted)' }}>{name} ({count})</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Hour Distribution Sparkline */}
            {analytics.hourDist.some(v => v > 0) && (
              <div>
                <div style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6 }}>Peak Hours</div>
                <svg width={24 * 16} height={32} style={{ display: 'block' }}>
                  {analytics.hourDist.map((count, h) => {
                    const barH = count > 0 ? Math.max(3, Math.round((count / maxHour) * 24)) : 2
                    return (
                      <g key={h}>
                        <rect
                          x={h * 16}
                          y={24 - barH}
                          width={14}
                          height={barH}
                          rx={2}
                          style={{ fill: count > 0 ? 'rgba(52,211,153,0.7)' : 'rgba(255,255,255,0.05)' }}
                        >
                          <title>{h}:00 — {count} session{count !== 1 ? 's' : ''}</title>
                        </rect>
                        {h % 6 === 0 && (
                          <text x={h * 16} y={32} style={{ fill: 'var(--text-muted)', fontSize: 9 }}>
                            {h === 0 ? '12a' : h < 12 ? `${h}a` : h === 12 ? '12p' : `${h - 12}p`}
                          </text>
                        )}
                      </g>
                    )
                  })}
                </svg>
              </div>
            )}

            {analytics.total === 0 && (
              <div style={{ color: 'var(--text-muted)', fontSize: 12, textAlign: 'center', padding: '8px 0' }}>
                No proof data in the last 30 days
              </div>
            )}
          </div>
        )}
      </div>

      {/* Date Navigation */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
        borderBottom: '1px solid var(--border)', flexShrink: 0,
      }}>
        <button className="panel-header-btn" onClick={prevDay} title="Previous day">
          <ChevronLeft size={14} />
        </button>
        <input
          type="date"
          value={date}
          max={todayStr()}
          onChange={e => { setDate(e.target.value); setExpandedPath(null) }}
          style={{
            background: 'var(--bg-secondary)', border: '1px solid var(--border)',
            borderRadius: 4, color: 'var(--text)', padding: '2px 6px', fontSize: 13,
          }}
        />
        <button
          className="panel-header-btn"
          onClick={nextDay}
          disabled={isToday}
          title="Next day"
          style={{ opacity: isToday ? 0.4 : 1 }}
        >
          <ChevronRight size={14} />
        </button>
        <span style={{ color: 'var(--text-muted)', fontSize: 12, marginLeft: 4 }}>
          {isToday ? 'Today' : ''}
        </span>
      </div>

      {/* Filter Bar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px',
        borderBottom: '1px solid var(--border)', flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ position: 'relative', flex: '1 1 160px', minWidth: 100 }}>
          <Search size={12} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            placeholder="Search by name or branch…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            style={{
              width: '100%', boxSizing: 'border-box',
              paddingLeft: 26, paddingRight: search ? 26 : 8, paddingTop: 4, paddingBottom: 4,
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 4, color: 'var(--text)', fontSize: 12,
            }}
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, display: 'flex' }}
            >
              <X size={12} />
            </button>
          )}
        </div>

        {personas.length > 0 && (
          <select
            value={personaFilter}
            onChange={e => setPersonaFilter(e.target.value)}
            style={{
              background: 'var(--bg-secondary)', border: '1px solid var(--border)',
              borderRadius: 4, color: 'var(--text)', padding: '4px 6px', fontSize: 12,
            }}
          >
            <option value="all">All personas</option>
            {personas.map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        )}

        <div style={{ display: 'flex', gap: 4 }}>
          {(['all', 'success', 'failure'] as SuccessFilter[]).map(f => (
            <button
              key={f}
              onClick={() => setSuccessFilter(f)}
              style={{
                padding: '3px 8px', borderRadius: 4, fontSize: 11, border: '1px solid var(--border)',
                background: successFilter === f ? 'var(--accent)' : 'var(--bg-secondary)',
                color: successFilter === f ? '#fff' : 'var(--text-muted)',
                cursor: 'pointer', textTransform: 'capitalize',
              }}
            >
              {f}
            </button>
          ))}
        </div>
      </div>

      {/* Proof List */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
        {loading && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32, fontSize: 13 }}>Loading…</div>
        )}
        {!loading && filtered.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: 32 }}>
            <Archive size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
            <div style={{ fontSize: 14 }}>No proofs yet</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Proof bundles are written when sessions exit</div>
          </div>
        )}
        {!loading && filtered.map(p => (
          <div key={p.path}>
            <div
              onClick={() => toggleExpand(p)}
              style={{
                background: 'var(--bg-secondary)', borderRadius: 6, marginBottom: 6,
                padding: '10px 12px', cursor: 'pointer',
                border: `1px solid ${expandedPath === p.path ? 'var(--accent)' : 'var(--border)'}`,
                transition: 'border-color 0.15s',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                  <span
                    style={{
                      display: 'inline-block', borderRadius: 3, fontSize: 11, fontWeight: 700,
                      padding: '1px 6px', flexShrink: 0,
                      background: p.exitCode === 0 ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
                      color: p.exitCode === 0 ? 'var(--green, #22c55e)' : 'var(--red, #ef4444)',
                    }}
                  >
                    {p.exitCode === 0 ? 'exit 0' : `exit ${p.exitCode}`}
                  </span>
                  <span style={{ fontWeight: 500, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--text)' }}>
                    {p.name}
                  </span>
                </div>
                <span style={{ color: 'var(--text-muted)', fontSize: 11, flexShrink: 0 }}>
                  {p.duration && p.duration}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 12, marginTop: 6, flexWrap: 'wrap' }}>
                {p.cost && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    💰 {p.cost}
                  </span>
                )}
                {p.branch && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    🌿 {p.branch}
                  </span>
                )}
                {p.commits > 0 && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    📝 {p.commits} commit{p.commits !== 1 ? 's' : ''}
                  </span>
                )}
                {p.persona && (
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    🤖 {p.persona}
                  </span>
                )}
              </div>
            </div>

            {expandedPath === p.path && (
              <div style={{
                background: 'var(--bg-tertiary, var(--bg))', borderRadius: '0 0 6px 6px',
                border: '1px solid var(--accent)', borderTop: 'none',
                marginBottom: 10, marginTop: -6, padding: '12px',
              }}>
                {contentLoading ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading…</div>
                ) : (
                  <pre style={{
                    margin: 0, fontSize: 11, lineHeight: 1.5,
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                    color: 'var(--text)', maxHeight: 400, overflowY: 'auto',
                    fontFamily: 'var(--font-mono, monospace)',
                  }}>
                    {expandedContent}
                  </pre>
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
