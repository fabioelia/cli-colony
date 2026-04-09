import React, { useState, useEffect, useCallback, useRef } from 'react'
import { GitCompare, RefreshCw, ChevronDown, ChevronRight, Terminal, GitBranch, Copy, Filter, RotateCw, Clock } from 'lucide-react'
import type { ClaudeInstance } from '../types'
import type { GitDiffEntry } from '../../../shared/types'
import HelpPopover from './HelpPopover'

interface SessionChanges {
  instanceId: string
  name: string
  color: string
  status: 'running' | 'exited'
  dir: string
  branch: string | null
  createdAt: string
  entries: GitDiffEntry[]
  loading: boolean
  error: boolean
}

interface ReviewPanelProps {
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
}

type FilterMode = 'changes' | 'all'

function ReviewPanel({ instances, onFocusInstance }: ReviewPanelProps) {
  const [sessionChanges, setSessionChanges] = useState<SessionChanges[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<FilterMode>('changes')
  const [refreshing, setRefreshing] = useState(false)
  const [copiedBranch, setCopiedBranch] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const instancesWithDir = instances.filter(i => i.workingDirectory)

  const loadAllChanges = useCallback(async () => {
    const results = await Promise.allSettled(
      instancesWithDir.map(async (inst) => {
        const entries = await window.api.session.gitChanges(inst.workingDirectory)
        return {
          instanceId: inst.id,
          name: inst.name,
          color: inst.color,
          status: inst.status,
          dir: inst.workingDirectory,
          branch: inst.gitBranch,
          createdAt: inst.createdAt,
          entries,
          loading: false,
          error: false,
        } as SessionChanges
      })
    )
    setSessionChanges(results.map((r, i) => {
      if (r.status === 'fulfilled') return r.value
      return {
        instanceId: instancesWithDir[i].id,
        name: instancesWithDir[i].name,
        color: instancesWithDir[i].color,
        status: instancesWithDir[i].status,
        dir: instancesWithDir[i].workingDirectory,
        branch: instancesWithDir[i].gitBranch,
        createdAt: instancesWithDir[i].createdAt,
        entries: [],
        loading: false,
        error: true,
      } as SessionChanges
    }))
  }, [instancesWithDir.map(i => i.id).join(',')])

  // Initial load
  useEffect(() => {
    setSessionChanges(instancesWithDir.map(inst => ({
      instanceId: inst.id,
      name: inst.name,
      color: inst.color,
      status: inst.status,
      dir: inst.workingDirectory,
      branch: inst.gitBranch,
      createdAt: inst.createdAt,
      entries: [],
      loading: true,
      error: false,
    })))
    loadAllChanges()
  }, [instancesWithDir.map(i => i.id).join(',')])

  // Poll every 30s
  useEffect(() => {
    pollRef.current = setInterval(loadAllChanges, 30000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [loadAllChanges])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await loadAllChanges()
    setRefreshing(false)
  }, [loadAllChanges])

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopyBranch = (branch: string) => {
    navigator.clipboard.writeText(branch)
    setCopiedBranch(branch)
    setTimeout(() => setCopiedBranch(null), 1500)
  }

  // Apply filter
  const displayed = filter === 'changes'
    ? sessionChanges.filter(s => s.entries.length > 0 || s.loading)
    : sessionChanges

  // Sort: sessions with changes first, then by creation date desc
  const sorted = [...displayed].sort((a, b) => {
    if (a.entries.length > 0 && b.entries.length === 0) return -1
    if (a.entries.length === 0 && b.entries.length > 0) return 1
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })

  const totalChanges = sessionChanges.reduce((sum, s) => sum + s.entries.length, 0)
  const totalInsertions = sessionChanges.reduce((sum, s) => sum + s.entries.reduce((a, e) => a + e.insertions, 0), 0)
  const totalDeletions = sessionChanges.reduce((sum, s) => sum + s.entries.reduce((a, e) => a + e.deletions, 0), 0)

  return (
    <div className="review-panel" style={{ padding: 'var(--titlebar-pad, 44px) 16px 0', WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <div className="panel-header" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <h2><GitCompare size={16} /> Review</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="review" align="right" />
        <div className="panel-header-actions">
          <button
            className={`panel-header-btn${filter === 'changes' ? ' primary' : ''}`}
            onClick={() => setFilter(f => f === 'changes' ? 'all' : 'changes')}
            title={filter === 'changes' ? 'Showing sessions with changes only' : 'Showing all sessions'}
          >
            <Filter size={13} /> {filter === 'changes' ? 'Changed' : 'All'}
          </button>
          <button
            className="panel-header-btn"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh all"
          >
            {refreshing ? <RotateCw size={13} className="spinning" /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>

      {/* Summary bar */}
      {totalChanges > 0 && (
        <div className="review-summary" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          <span>{totalChanges} file{totalChanges !== 1 ? 's' : ''} changed across {sessionChanges.filter(s => s.entries.length > 0).length} session{sessionChanges.filter(s => s.entries.length > 0).length !== 1 ? 's' : ''}</span>
          <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
            {totalInsertions > 0 && <span style={{ color: 'var(--success)' }}>+{totalInsertions}</span>}
            {totalDeletions > 0 && <span style={{ color: 'var(--danger)' }}>-{totalDeletions}</span>}
          </span>
        </div>
      )}

      <div className="review-content" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        {sorted.length === 0 && !refreshing && (
          <div className="changes-empty">
            {filter === 'changes' ? 'No sessions with uncommitted changes.' : 'No sessions with a working directory.'}
          </div>
        )}

        {sorted.map(session => {
          const expanded = expandedIds.has(session.instanceId)
          const insertions = session.entries.reduce((a, e) => a + e.insertions, 0)
          const deletions = session.entries.reduce((a, e) => a + e.deletions, 0)

          return (
            <div key={session.instanceId} className="review-card">
              <div
                className="review-card-header"
                onClick={() => session.entries.length > 0 && toggleExpand(session.instanceId)}
                style={{ cursor: session.entries.length > 0 ? 'pointer' : 'default' }}
              >
                {/* Expand chevron */}
                <span className="review-card-chevron">
                  {session.entries.length > 0 ? (
                    expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
                  ) : (
                    <span style={{ width: 13 }} />
                  )}
                </span>

                {/* Color dot + name */}
                <span className="review-card-dot" style={{ background: session.color }} />
                <span className="review-card-name">{session.name}</span>

                {/* Status badge */}
                <span className={`review-card-status ${session.status}`}>
                  {session.status}
                </span>

                {/* File count + stats */}
                {session.loading ? (
                  <span className="review-card-stats" style={{ opacity: 0.5 }}>loading...</span>
                ) : session.entries.length > 0 ? (
                  <span className="review-card-stats">
                    {session.entries.length} file{session.entries.length !== 1 ? 's' : ''}
                    {insertions > 0 && <span style={{ color: 'var(--success)', marginLeft: '6px' }}>+{insertions}</span>}
                    {deletions > 0 && <span style={{ color: 'var(--danger)', marginLeft: '4px' }}>-{deletions}</span>}
                  </span>
                ) : (
                  <span className="review-card-stats" style={{ opacity: 0.4 }}>no changes</span>
                )}

                {/* Branch */}
                {session.branch && (
                  <span className="review-card-branch" title={session.branch}>
                    <GitBranch size={11} /> {session.branch}
                  </span>
                )}

                {/* Quick actions */}
                <span className="review-card-actions" onClick={e => e.stopPropagation()}>
                  <button
                    className="changes-refresh-btn"
                    title="Open in terminal"
                    onClick={() => onFocusInstance(session.instanceId)}
                  >
                    <Terminal size={12} />
                  </button>
                  {session.branch && (
                    <button
                      className="changes-refresh-btn"
                      title={copiedBranch === session.branch ? 'Copied!' : 'Copy branch name'}
                      onClick={() => handleCopyBranch(session.branch!)}
                      style={copiedBranch === session.branch ? { color: 'var(--success)' } : undefined}
                    >
                      <Copy size={11} />
                    </button>
                  )}
                </span>
              </div>

              {/* Expanded file list */}
              {expanded && (
                <div className="review-card-files">
                  {session.entries.map(entry => (
                    <div key={entry.file} className="review-file-row">
                      <span
                        className="review-file-status"
                        style={{
                          color: entry.status === 'A' ? 'var(--success)'
                            : entry.status === 'D' ? 'var(--danger)'
                            : 'var(--warning)',
                        }}
                      >
                        {entry.status}
                      </span>
                      <span className="review-file-name">{entry.file}</span>
                      <span className="review-file-stats">
                        {entry.insertions > 0 && <span style={{ color: 'var(--success)' }}>+{entry.insertions}</span>}
                        {entry.insertions > 0 && entry.deletions > 0 && ' '}
                        {entry.deletions > 0 && <span style={{ color: 'var(--danger)' }}>-{entry.deletions}</span>}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default React.memo(ReviewPanel)
