import React, { useState, useEffect, useMemo } from 'react'
import { ArrowLeft, Archive, CheckCircle, XCircle, Clock, DollarSign, Zap, Activity, ChevronRight } from 'lucide-react'
import type { Space } from '../lib/spaces'
import { renameSpace, archiveSpace } from '../lib/spaces'
import type { ClaudeInstance, ActivityEvent } from '../../../shared/types'

interface PipelineRun {
  ts: string
  trigger: string
  actionExecuted: boolean
  success: boolean
  durationMs: number
  totalCost?: number
}

interface PipelineActivity {
  name: string
  runs: PipelineRun[]
}

interface Props {
  space: Space
  instances: ClaudeInstance[]
  activityEvents: ActivityEvent[]
  onNavigateToInstance: (id: string) => void
  onBack: () => void
  onSpaceUpdated: () => void
}

function fmt(ms: number): string {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`
  return `${(ms / 3600000).toFixed(1)}h`
}

function relTime(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  if (diff < 60000) return 'just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
  return `${Math.floor(diff / 86400000)}d ago`
}

export default function SpaceHub({ space, instances, activityEvents, onNavigateToInstance, onBack, onSpaceUpdated }: Props) {
  const [editingName, setEditingName] = useState(false)
  const [nameValue, setNameValue] = useState(space.name)
  const [pipelines, setPipelines] = useState<PipelineActivity[]>([])

  useEffect(() => { setNameValue(space.name) }, [space.name])

  useEffect(() => {
    let cancelled = false
    window.api.pipeline.list().then(async (list: any[]) => {
      if (cancelled) return
      const matching = list.filter((p: any) => p.name.toLowerCase() === space.name.toLowerCase())
      const activities: PipelineActivity[] = []
      for (const p of matching) {
        const runs = await window.api.pipeline.getHistory(p.name).catch(() => [])
        activities.push({ name: p.name, runs: (runs as PipelineRun[]).slice(0, 5) })
      }
      if (!cancelled) setPipelines(activities)
    }).catch(() => {})
    return () => { cancelled = true }
  }, [space.name])

  const sorted = useMemo(() => {
    const running = instances.filter(i => i.status === 'running')
    const stopped = instances.filter(i => i.status !== 'running').sort((a, b) => (b.exitedAt ?? 0) - (a.exitedAt ?? 0))
    return [...running, ...stopped]
  }, [instances])

  const instanceIds = useMemo(() => new Set(instances.map(i => i.id)), [instances])

  const filteredActivity = useMemo(() =>
    activityEvents.filter(e => e.sessionId && instanceIds.has(e.sessionId)).slice(0, 20),
    [activityEvents, instanceIds]
  )

  const stats = useMemo(() => {
    const total = instances.length
    const totalCost = instances.reduce((s, i) => s + (i.tokenUsage?.cost ?? 0), 0)
    const exited = instances.filter(i => i.status !== 'running')
    const succeeded = exited.filter(i => i.exitCode === 0).length
    const successRate = exited.length > 0 ? Math.round((succeeded / exited.length) * 100) : null
    return { total, totalCost, successRate }
  }, [instances])

  const commitName = () => {
    const trimmed = nameValue.trim()
    if (trimmed && trimmed !== space.name) {
      renameSpace(space.id, trimmed)
      onSpaceUpdated()
    }
    setEditingName(false)
  }

  const handleArchive = () => {
    archiveSpace(space.id)
    onSpaceUpdated()
    onBack()
  }

  return (
    <div className="space-hub">
      <div className="space-hub-header">
        <button className="space-hub-back" onClick={onBack} title="Back to sessions">
          <ArrowLeft size={12} />
        </button>
        <span className="space-hub-color-dot" style={{ background: space.color }} />
        {editingName ? (
          <input
            className="space-hub-name-input"
            value={nameValue}
            autoFocus
            onChange={e => setNameValue(e.target.value)}
            onBlur={commitName}
            onKeyDown={e => {
              if (e.key === 'Enter') commitName()
              if (e.key === 'Escape') { setNameValue(space.name); setEditingName(false) }
            }}
          />
        ) : (
          <span className="space-hub-name" onClick={() => setEditingName(true)} title="Click to rename">{space.name}</span>
        )}
        <button className="space-hub-archive" onClick={handleArchive} title="Archive space">
          <Archive size={12} />
        </button>
      </div>

      {/* Quick Stats */}
      <div className="space-hub-stats">
        <div className="space-hub-stat">
          <span className="space-hub-stat-value">{stats.total}</span>
          <span className="space-hub-stat-label">sessions</span>
        </div>
        {stats.totalCost > 0 && (
          <div className="space-hub-stat">
            <span className="space-hub-stat-value"><DollarSign size={10} />{stats.totalCost < 10 ? stats.totalCost.toFixed(2) : stats.totalCost.toFixed(0)}</span>
            <span className="space-hub-stat-label">total cost</span>
          </div>
        )}
        {stats.successRate !== null && (
          <div className="space-hub-stat">
            <span className="space-hub-stat-value" style={{ color: stats.successRate >= 80 ? 'var(--success)' : 'var(--warning)' }}>{stats.successRate}%</span>
            <span className="space-hub-stat-label">success</span>
          </div>
        )}
      </div>

      {/* Sessions */}
      <div className="space-hub-section">
        <div className="space-hub-section-title">Sessions <span className="space-hub-section-count">{sorted.length}</span></div>
        {sorted.length === 0 && <div className="space-hub-empty">No sessions assigned to this space</div>}
        {sorted.map(inst => (
          <div key={inst.id} className="space-hub-session-row" onClick={() => onNavigateToInstance(inst.id)} role="button" tabIndex={0} onKeyDown={e => { if (e.key === 'Enter') onNavigateToInstance(inst.id) }}>
            <span className={`space-hub-status-dot ${inst.status === 'running' ? (inst.activity === 'busy' ? 'busy' : 'waiting') : 'stopped'}`} />
            <span className="space-hub-session-name">{inst.name}</span>
            {inst.pipelineName && <span className="space-hub-session-badge pipeline">{inst.pipelineName}</span>}
            {(inst.tokenUsage?.cost ?? 0) > 0 && (
              <span className="space-hub-session-cost">${(inst.tokenUsage.cost!).toFixed(2)}</span>
            )}
            <ChevronRight size={10} className="space-hub-session-arrow" />
          </div>
        ))}
      </div>

      {/* Pipeline Activity */}
      {pipelines.length > 0 && (
        <div className="space-hub-section">
          <div className="space-hub-section-title"><Zap size={10} /> Pipeline Activity</div>
          {pipelines.map(pa => (
            <div key={pa.name} className="space-hub-pipeline">
              <div className="space-hub-pipeline-name">{pa.name}</div>
              {pa.runs.length === 0 && <div className="space-hub-empty" style={{ paddingLeft: 8 }}>No runs yet</div>}
              {pa.runs.map((run, i) => (
                <div key={i} className="space-hub-run-row">
                  {run.success
                    ? <CheckCircle size={10} style={{ color: 'var(--success)', flexShrink: 0 }} />
                    : <XCircle size={10} style={{ color: 'var(--danger)', flexShrink: 0 }} />
                  }
                  <span className="space-hub-run-trigger">{run.trigger}</span>
                  <span className="space-hub-run-time">{relTime(run.ts)}</span>
                  {run.durationMs > 0 && <span className="space-hub-run-dur"><Clock size={9} /> {fmt(run.durationMs)}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Activity Timeline */}
      {filteredActivity.length > 0 && (
        <div className="space-hub-section">
          <div className="space-hub-section-title"><Activity size={10} /> Recent Activity</div>
          {filteredActivity.map(ev => (
            <div key={ev.id} className={`space-hub-activity-row level-${ev.level}`}>
              <span className="space-hub-activity-source">{ev.name}</span>
              <span className="space-hub-activity-summary">{ev.summary}</span>
              <span className="space-hub-activity-time">{relTime(ev.timestamp)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
