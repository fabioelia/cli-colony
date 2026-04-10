import { useState, useEffect, useMemo } from 'react'
import {
  Home, Play, Plus, Zap, Clock, AlertCircle,
  CheckCircle2, Circle, Users, FolderOpen, Activity
} from 'lucide-react'
import HelpPopover from './HelpPopover'
import type { ClaudeInstance, ActivityEvent, PersonaInfo, ApprovalRequest, TaskBoardItem } from '../../../preload'

interface PipelineSummary {
  name: string
  enabled: boolean
  running: boolean
  lastFiredAt: string | null
  lastError: string | null
  fireCount: number
}

interface Props {
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
  onNewSession: () => void
  onNavigate: (view: string) => void
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function formatCost(cost: number): string {
  if (cost < 0.01) return '<$0.01'
  return `$${cost.toFixed(2)}`
}

export default function ColonyOverviewPanel({ instances, onFocusInstance, onNewSession, onNavigate }: Props) {
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([])
  const [personas, setPersonas] = useState<PersonaInfo[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [tasks, setTasks] = useState<TaskBoardItem[]>([])

  useEffect(() => {
    window.api.activity.list().then(setActivity)
    window.api.pipeline.list().then(setPipelines)
    window.api.persona.list().then(setPersonas)
    window.api.pipeline.listApprovals().then(setApprovals)
    window.api.tasksBoard.list().then(setTasks)
  }, [])

  // Listen for live updates
  useEffect(() => {
    const unsubs = [
      window.api.activity.onNew(({ event }) => {
        setActivity(prev => [event, ...prev].slice(0, 100))
      }),
      window.api.pipeline.onStatus((list) => setPipelines(list)),
      window.api.persona.onStatus((list) => setPersonas(list)),
      window.api.tasksBoard.onUpdated((items) => setTasks(items)),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [])

  const running = useMemo(() => instances.filter(i => i.status === 'running'), [instances])
  const totalCost = useMemo(() => instances.reduce((sum, i) => sum + (i.tokenUsage.cost || 0), 0), [instances])
  const activePipelines = useMemo(() => pipelines.filter(p => p.enabled), [pipelines])
  const errorPipelines = useMemo(() => pipelines.filter(p => p.lastError), [pipelines])
  const runningPersonas = useMemo(() => personas.filter(p => p.activeSessionId), [personas])
  const pendingApprovals = approvals
  const inProgressTasks = useMemo(() => tasks.filter(t => t.status === 'in_progress'), [tasks])
  const blockedTasks = useMemo(() => tasks.filter(t => t.status === 'blocked'), [tasks])
  const recentActivity = useMemo(() => activity.slice(0, 8), [activity])

  return (
    <div className="colony-overview">
      <div className="panel-header" style={{ WebkitAppRegion: 'drag' as any, paddingTop: 44 }}>
        <h2><Home size={16} /> Colony Overview</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="overview" align="right" />
      </div>

      <div className="colony-overview-content">
        {/* Stats row */}
        <div className="colony-overview-stats">
          <div className="overview-stat-card" onClick={() => onNavigate('instances')}>
            <div className="overview-stat-value">{running.length}</div>
            <div className="overview-stat-label">Running Sessions</div>
          </div>
          <div className="overview-stat-card" onClick={() => onNavigate('personas')}>
            <div className="overview-stat-value">{runningPersonas.length}</div>
            <div className="overview-stat-label">Active Personas</div>
          </div>
          <div className="overview-stat-card" onClick={() => onNavigate('pipelines')}>
            <div className="overview-stat-value">{activePipelines.length}</div>
            <div className="overview-stat-label">Pipelines Enabled</div>
          </div>
          <div className="overview-stat-card">
            <div className="overview-stat-value">{formatCost(totalCost)}</div>
            <div className="overview-stat-label">Session Cost</div>
          </div>
        </div>

        {/* Attention needed */}
        {(pendingApprovals.length > 0 || errorPipelines.length > 0 || blockedTasks.length > 0) && (
          <div className="overview-section">
            <h3><AlertCircle size={14} /> Needs Attention</h3>
            <div className="overview-attention-list">
              {pendingApprovals.map(a => (
                <div key={a.id} className="overview-attention-item attention-approval" onClick={() => onNavigate('pipelines')}>
                  <Zap size={13} />
                  <span className="attention-label">Approval: {a.pipelineName}</span>
                  <span className="attention-time">{timeAgo(a.createdAt)}</span>
                </div>
              ))}
              {errorPipelines.map(p => (
                <div key={p.name} className="overview-attention-item attention-error" onClick={() => onNavigate('pipelines')}>
                  <AlertCircle size={13} />
                  <span className="attention-label">{p.name} failed</span>
                </div>
              ))}
              {blockedTasks.map(t => (
                <div key={t.id} className="overview-attention-item attention-blocked" onClick={() => onNavigate('tasks')}>
                  <Circle size={13} />
                  <span className="attention-label">{t.title}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Running sessions */}
        {running.length > 0 && (
          <div className="overview-section">
            <h3><Play size={14} /> Running Sessions</h3>
            <div className="overview-session-list">
              {running.map(inst => (
                <div
                  key={inst.id}
                  className="overview-session-tile"
                  onClick={() => onFocusInstance(inst.id)}
                >
                  <span
                    className="overview-session-dot"
                    style={{ background: inst.color || 'var(--accent)' }}
                  />
                  <span className="overview-session-name">{inst.name || 'Unnamed'}</span>
                  {inst.activity === 'busy' && <span className="overview-badge badge-busy">busy</span>}
                  {inst.activity === 'waiting' && <span className="overview-badge badge-waiting">idle</span>}
                  {inst.roleTag && <span className="overview-badge badge-role">{inst.roleTag}</span>}
                  {inst.tokenUsage.cost ? (
                    <span className="overview-session-cost">{formatCost(inst.tokenUsage.cost)}</span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Active personas */}
        {runningPersonas.length > 0 && (
          <div className="overview-section">
            <h3><Users size={14} /> Active Personas</h3>
            <div className="overview-session-list">
              {runningPersonas.map(p => (
                <div
                  key={p.id}
                  className="overview-session-tile"
                  onClick={() => onNavigate('personas')}
                >
                  <span className="overview-session-dot" style={{ background: 'var(--accent-purple)' }} />
                  <span className="overview-session-name">{p.name}</span>
                  <span className="overview-badge badge-role">{p.model}</span>
                  <span className="overview-session-cost">run #{p.runCount}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* In-progress tasks */}
        {inProgressTasks.length > 0 && (
          <div className="overview-section">
            <h3><CheckCircle2 size={14} /> In-Progress Tasks</h3>
            <div className="overview-session-list">
              {inProgressTasks.map(t => (
                <div
                  key={t.id}
                  className="overview-session-tile"
                  onClick={() => onNavigate('tasks')}
                >
                  <span className="overview-session-dot" style={{ background: 'var(--warning)' }} />
                  <span className="overview-session-name">{t.title}</span>
                  {t.assignee && <span className="overview-badge badge-role">{t.assignee}</span>}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent activity */}
        <div className="overview-section">
          <h3><Activity size={14} /> Recent Activity</h3>
          {recentActivity.length === 0 ? (
            <div className="overview-empty-hint">No activity recorded yet</div>
          ) : (
            <div className="overview-activity-list">
              {recentActivity.map(ev => (
                <div key={ev.id} className="overview-activity-item">
                  <span className={`overview-activity-dot activity-${ev.level}`} />
                  <span className="overview-activity-source">{ev.name}</span>
                  <span className="overview-activity-summary">{ev.summary}</span>
                  <span className="overview-activity-time">{timeAgo(ev.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div className="overview-section overview-actions">
          <button className="overview-action-btn primary" onClick={onNewSession}>
            <Plus size={14} /> New Session
          </button>
          <button className="overview-action-btn" onClick={() => onNavigate('personas')}>
            <Users size={14} /> Run Persona
          </button>
          <button className="overview-action-btn" onClick={() => onNavigate('pipelines')}>
            <Zap size={14} /> Pipelines
          </button>
          <button className="overview-action-btn" onClick={() => onNavigate('environments')}>
            <FolderOpen size={14} /> Environments
          </button>
        </div>
      </div>
    </div>
  )
}
