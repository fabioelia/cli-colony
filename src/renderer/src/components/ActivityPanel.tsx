import { useState, useEffect, useMemo } from 'react'
import { Bell, Search, Trash2, ChevronDown, ChevronRight } from 'lucide-react'
import HelpPopover from './HelpPopover'
import DiffViewer from './DiffViewer'
import type { ActivityEvent, ApprovalRequest } from '../../../shared/types'

type SourceFilter = 'persona' | 'pipeline' | 'env' | 'session'
type LevelFilter = 'info' | 'warn' | 'error'

interface Props {
  onFocusSession?: (sessionId: string) => void
  onNavigate?: (view: string) => void
}

const formatActivityTime = (iso: string) => {
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60000) return 'now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

const formatApprovalExpiry = (expiresAt: string | undefined) => {
  if (!expiresAt) return null
  const remaining = new Date(expiresAt).getTime() - Date.now()
  if (remaining <= 0) return 'expired'
  if (remaining < 3600000) return `expires in ${Math.ceil(remaining / 60000)}m`
  if (remaining < 86400000) return `expires in ${Math.ceil(remaining / 3600000)}h`
  return `expires in ${Math.ceil(remaining / 86400000)}d`
}

const formatDuration = (sec: number) => {
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
}

type TypeChip = 'all' | 'session' | 'pipeline' | 'persona' | 'approval'

export default function ActivityPanel({ onFocusSession, onNavigate }: Props) {
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const [sourceFilters, setSourceFilters] = useState<Set<SourceFilter>>(new Set(['persona', 'pipeline', 'env', 'session']))
  const [levelFilters, setLevelFilters] = useState<Set<LevelFilter>>(new Set(['info', 'warn', 'error']))
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [showAll, setShowAll] = useState(false)
  const [typeChip, setTypeChip] = useState<TypeChip>('all')
  const [expandedApprovals, setExpandedApprovals] = useState<Set<string>>(new Set())

  useEffect(() => {
    window.api.activity.list().then(all => {
      setEvents([...all].reverse())
    }).catch(() => {})
    window.api.activity.markRead().catch(() => {})

    window.api.pipeline.listApprovals().then(setPendingApprovals).catch(() => {})

    const unsubNew = window.api.activity.onNew(({ event }) => {
      setEvents(prev => [event, ...prev].slice(0, 100))
    })
    const unsubApprovalNew = window.api.pipeline.onApprovalNew(req => {
      setPendingApprovals(prev => [...prev, req])
    })
    const unsubApprovalUpdate = window.api.pipeline.onApprovalUpdate(({ id }) => {
      setPendingApprovals(prev => prev.filter(r => r.id !== id))
    })
    return () => { unsubNew(); unsubApprovalNew(); unsubApprovalUpdate() }
  }, [])

  const toggleSource = (s: SourceFilter) => {
    setSourceFilters(prev => {
      const next = new Set(prev)
      if (next.has(s)) { if (next.size > 1) next.delete(s) } else next.add(s)
      return next
    })
  }

  const toggleLevel = (l: LevelFilter) => {
    setLevelFilters(prev => {
      const next = new Set(prev)
      if (next.has(l)) { if (next.size > 1) next.delete(l) } else next.add(l)
      return next
    })
  }

  const query = searchQuery.toLowerCase().trim()
  const projectChips = useMemo(() => {
    const projects = [...new Set(events.map(e => e.project || 'unknown'))]
    return projects.length >= 2 ? projects : []
  }, [events])
  const filteredAll = useMemo(() => {
    return events.filter(ev => {
      if (!sourceFilters.has(ev.source)) return false
      if (!levelFilters.has(ev.level)) return false
      if (typeChip !== 'all' && typeChip !== 'approval' && ev.source !== typeChip) return false
      if (projectFilter !== 'all' && (ev.project || 'unknown') !== projectFilter) return false
      if (query && !ev.name.toLowerCase().includes(query) && !ev.summary.toLowerCase().includes(query)) return false
      return true
    })
  }, [events, sourceFilters, levelFilters, typeChip, projectFilter, query])
  const filtered = useMemo(() => showAll ? filteredAll : filteredAll.slice(0, 20), [filteredAll, showAll])

  const typeCounts = useMemo(() => ({
    session: events.filter(e => e.source === 'session').length,
    pipeline: events.filter(e => e.source === 'pipeline').length,
    persona: events.filter(e => e.source === 'persona').length,
    approval: pendingApprovals.length,
  }), [events, pendingApprovals])

  const sourceCounts = useMemo(() => {
    const c: Record<SourceFilter, number> = { persona: 0, pipeline: 0, env: 0, session: 0 }
    for (const ev of events) c[ev.source]++
    return c
  }, [events])

  const levelCounts = useMemo(() => {
    const c = { info: 0, warn: 0, error: 0 }
    for (const ev of events) c[ev.level]++
    return c
  }, [events])

  return (
    <div className="activity-panel" style={{ padding: '44px 16px 0', WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <div className="panel-header" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <h2><Bell size={16} /> Activity</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="activity" align="right" />
        <div className="panel-header-actions">
          <button
            className="panel-header-btn"
            onClick={async () => {
              if (!confirm('Clear all activity events?')) return
              await window.api.activity.clear()
              setEvents([])
            }}
            title="Clear all activity events"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div style={{ WebkitAppRegion: 'no-drag', overflowY: 'auto', flex: 1 } as React.CSSProperties}>
        {/* Type filter chips */}
        <div className="activity-filters" style={{ marginTop: 8 }}>
          <div className="activity-filter-row">
            {(['all', 'session', 'pipeline', 'persona', 'approval'] as TypeChip[]).map(t => (
              <button
                key={t}
                className={`activity-filter-chip${typeChip === t ? ' active' : ''}`}
                onClick={() => setTypeChip(t)}
              >
                {t === 'all' ? 'All' : t === 'session' ? 'Sessions' : t === 'pipeline' ? 'Pipelines' : t === 'persona' ? 'Personas' : 'Approvals'}
                {t !== 'all' && typeCounts[t] > 0 && <span className="filter-badge">{typeCounts[t]}</span>}
              </button>
            ))}
          </div>
          <div className="activity-filter-row">
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4, alignSelf: 'center' }}>Source:</span>
            {(['persona', 'pipeline', 'env', 'session'] as SourceFilter[]).map(s => (
              <button
                key={s}
                className={`activity-filter-chip ${sourceFilters.has(s) ? 'active' : ''}`}
                onClick={() => toggleSource(s)}
              >
                <span className={`activity-event-source activity-source-${s}`} style={{ padding: '0 4px', borderRadius: 3, fontSize: 10 }}>{s}</span>
                <span style={{ fontSize: 10, opacity: 0.7 }}>{sourceCounts[s]}</span>
              </button>
            ))}
          </div>
          <div className="activity-filter-row">
            <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4, alignSelf: 'center' }}>Level:</span>
            {(['info', 'warn', 'error'] as LevelFilter[]).map(l => (
              <button
                key={l}
                className={`activity-filter-chip ${levelFilters.has(l) ? 'active' : ''}`}
                onClick={() => toggleLevel(l)}
              >
                {l}
                {l === 'warn' && levelCounts.warn > 0 && <span className="filter-badge warn">{levelCounts.warn}</span>}
                {l === 'error' && levelCounts.error > 0 && <span className="filter-badge error">{levelCounts.error}</span>}
              </button>
            ))}
          </div>
          {projectChips.length >= 2 && (
            <div className="activity-filter-row">
              <span style={{ fontSize: 11, color: 'var(--text-muted)', marginRight: 4, alignSelf: 'center' }}>Project:</span>
              <button className={`activity-filter-chip${projectFilter === 'all' ? ' active' : ''}`} onClick={() => setProjectFilter('all')}>All</button>
              {projectChips.map(p => (
                <button key={p} className={`activity-filter-chip${projectFilter === p ? ' active' : ''}`} onClick={() => setProjectFilter(p)}>{p}</button>
              ))}
            </div>
          )}
          <div className="activity-panel-search">
            <Search size={12} />
            <input
              type="text"
              placeholder="Filter events..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
        </div>

        {/* Pending Approvals */}
        {pendingApprovals.length > 0 && (typeChip === 'all' || typeChip === 'approval') && (
          <div className="activity-approvals-section" style={{ marginBottom: 12 }}>
            <div className="activity-approvals-title">Pending Approval ({pendingApprovals.length})</div>
            {pendingApprovals.map(req => (
              <div key={req.id} className="activity-approval-card">
                <div className="activity-approval-header">
                  <span className="activity-approval-pipeline">{req.pipelineName}</span>
                  <span className="activity-approval-time">{formatActivityTime(req.createdAt)}</span>
                </div>
                <div className="activity-approval-summary">{req.summary}</div>
                {req.resolvedVars?.['plan.content'] && (
                  <div className="activity-approval-plan-preview">
                    {req.resolvedVars['plan.content'].length > 280
                      ? req.resolvedVars['plan.content'].slice(0, 280) + '…'
                      : req.resolvedVars['plan.content']}
                  </div>
                )}
                {/* Diff toggle */}
                {req.prFiles && req.prFiles.length > 0 && (() => {
                  const totalAdd = req.prFiles.reduce((s, f) => s + f.additions, 0)
                  const totalDel = req.prFiles.reduce((s, f) => s + f.deletions, 0)
                  const expanded = expandedApprovals.has(req.id)
                  return (
                    <>
                      <button
                        className="activity-approval-diff-toggle"
                        onClick={() => setExpandedApprovals(prev => {
                          const next = new Set(prev)
                          expanded ? next.delete(req.id) : next.add(req.id)
                          return next
                        })}
                      >
                        {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        View changes ({req.prFiles.length} file{req.prFiles.length !== 1 ? 's' : ''} · +{totalAdd}/-{totalDel})
                      </button>
                      {expanded && (
                        <div className="activity-approval-diff-body">
                          <DiffViewer files={req.prFiles} diff="" />
                        </div>
                      )}
                    </>
                  )
                })()}
                {!req.prFiles && req.repoSlug && (
                  <div className="activity-approval-diff-unavailable">Diff unavailable</div>
                )}
                {formatApprovalExpiry(req.expiresAt) && (
                  <div className="activity-approval-expiry">{formatApprovalExpiry(req.expiresAt)}</div>
                )}
                <div className="activity-approval-actions">
                  <button
                    className="activity-approval-btn approve"
                    onClick={() => window.api.pipeline.approve(req.id).catch(() => {})}
                  >Approve</button>
                  <button
                    className="activity-approval-btn dismiss"
                    onClick={() => window.api.pipeline.dismiss(req.id).catch(() => {})}
                  >Dismiss</button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Approval-only empty state */}
        {typeChip === 'approval' && pendingApprovals.length === 0 && (
          <div className="activity-popover-empty" style={{ textAlign: 'center', padding: 24 }}>
            No pending approvals. Approvals appear when pipelines require manual authorization.
          </div>
        )}

        {/* Event List */}
        {typeChip !== 'approval' && (
        <div className="activity-panel-list">
          {filtered.length === 0 && (
            <div className="activity-popover-empty" style={{ textAlign: 'center', padding: 24 }}>
              {events.length === 0
                ? 'Activity appears here when personas, pipelines, or approval gates fire. Start a persona or run a pipeline to see events.'
                : 'No matching activity. Adjust filters or wait for personas and pipelines to fire.'}
            </div>
          )}
          {filtered.map(ev => {
            const isClickable = (ev.sessionId && onFocusSession) || (onNavigate && (ev.source === 'persona' || ev.source === 'pipeline' || ev.source === 'env'))
            return (
            <div key={ev.id} className={`activity-event activity-event-${ev.level}`}
              style={isClickable ? { cursor: 'pointer' } : undefined}
              onClick={() => {
                if (ev.sessionId && onFocusSession) onFocusSession(ev.sessionId)
                else if (ev.source === 'persona' && onNavigate) onNavigate('personas')
                else if (ev.source === 'pipeline' && onNavigate) onNavigate('pipelines')
                else if (ev.source === 'env' && onNavigate) onNavigate('environments')
              }}
            >
              <div className="activity-event-header">
                <span className={`activity-event-source activity-source-${ev.source}`}>{ev.source}</span>
                <span className={`activity-event-name${isClickable ? ' activity-event-link' : ''}`}>{ev.name}</span>
                <span className="activity-event-time">{formatActivityTime(ev.timestamp)}</span>
              </div>
              <div className="activity-event-summary">{ev.summary}</div>
              {ev.details?.type === 'session-outcome' && (
                <div className="activity-outcome-stats">
                  {(ev.details.duration as number) !== null && (
                    <span>{formatDuration(ev.details.duration as number)}</span>
                  )}
                  {(ev.details.commitsCount as number) > 0 && (
                    <span>{ev.details.commitsCount as number} commit{(ev.details.commitsCount as number) !== 1 ? 's' : ''}</span>
                  )}
                  {(ev.details.filesChanged as number) > 0 && (
                    <span>{ev.details.filesChanged as number} file{(ev.details.filesChanged as number) !== 1 ? 's' : ''} changed</span>
                  )}
                </div>
              )}
            </div>
          )})}
          {!showAll && filteredAll.length > 20 && (
            <button className="activity-show-more" onClick={() => setShowAll(true)}>
              Show all ({filteredAll.length - 20} more)
            </button>
          )}
          {showAll && filteredAll.length > 20 && (
            <button className="activity-show-more" onClick={() => setShowAll(false)}>
              Show less
            </button>
          )}
        </div>
        )}
      </div>
    </div>
  )
}
