import { useState, useEffect, useMemo } from 'react'
import {
  Home, Play, Plus, Zap, Clock, AlertCircle,
  CheckCircle2, XCircle, Circle, Users, FolderOpen, Activity, GanttChart, BarChart3, X, Eye, Square, Pin, PinOff,
  ChevronLeft, ChevronRight, Calendar, RotateCcw, Search, MessageSquare
} from 'lucide-react'
import HelpPopover from './HelpPopover'
import SessionTimeline from './SessionTimeline'
import { nextRuns } from '../../../shared/cron'
import type { ClaudeInstance, ActivityEvent, PersonaInfo, ApprovalRequest, TaskBoardItem, PersonaHealthEntry, EnvStatus } from '../../../preload'

interface PipelineSummary {
  name: string
  enabled: boolean
  running: boolean
  lastFiredAt: string | null
  lastError: string | null
  fireCount: number
  cron: string | null
}

interface Props {
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
  onNewSession: () => void
  onNavigate: (view: string) => void
  onKill?: (id: string) => void
  onRestart?: (id: string) => void
}

function formatElapsed(ts: string): string {
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000)
  if (mins < 1) return '<1m'
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  const rem = mins % 60
  return rem > 0 ? `${hrs}h ${rem}m` : `${hrs}h`
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

type OverviewTab = 'dashboard' | 'timeline'

export default function ColonyOverviewPanel({ instances, onFocusInstance, onNewSession, onNavigate, onKill, onRestart }: Props) {
  const [tab, setTab] = useState<OverviewTab>('dashboard')
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; inst: ClaudeInstance } | null>(null)
  const [activity, setActivity] = useState<ActivityEvent[]>([])
  const [pipelines, setPipelines] = useState<PipelineSummary[]>([])
  const [personas, setPersonas] = useState<PersonaInfo[]>([])
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([])
  const [tasks, setTasks] = useState<TaskBoardItem[]>([])
  const [costTrend, setCostTrend] = useState<{ date: string; cost: number }[]>([])
  const [personaHealth, setPersonaHealth] = useState<PersonaHealthEntry[]>([])
  const [idleMap, setIdleMap] = useState<Map<string, number>>(new Map())
  const [costLeaderboard, setCostLeaderboard] = useState<Array<{ name: string; id: string; cost: number }>>([])
  const [environments, setEnvironments] = useState<EnvStatus[]>([])
  const [dailyCostBudget, setDailyCostBudget] = useState(0)
  const [tick, setTick] = useState(0)
  const [triggeredIds, setTriggeredIds] = useState<Set<string>>(new Set())

  useEffect(() => {
    window.api.activity.list().then(setActivity)
    window.api.pipeline.list().then(setPipelines)
    window.api.persona.list().then(setPersonas)
    window.api.pipeline.listApprovals().then(setApprovals)
    window.api.tasksBoard.list().then(setTasks)
    window.api.persona.getColonyCostTrend().then(setCostTrend)
    window.api.persona.healthSummary().then(setPersonaHealth)
    window.api.env.list().then(setEnvironments)
    window.api.settings.getAll().then(s => setDailyCostBudget(parseFloat(s.dailyCostBudgetUsd) || 0))
    window.api.sessions.idleInfo().then(entries => {
      const m = new Map<string, number>()
      for (const e of entries) m.set(e.id, e.idleMs)
      setIdleMap(m)
    }).catch(() => {})
  }, [])

  // Fetch per-persona cost analytics once personas are loaded
  useEffect(() => {
    if (personas.length === 0) return
    Promise.all(personas.map(p =>
      window.api.persona.getAnalytics(p.id).then(a => ({ name: p.name, id: p.id, cost: a.costLast7d })).catch(() => ({ name: p.name, id: p.id, cost: 0 }))
    )).then(results => {
      setCostLeaderboard(results.filter(r => r.cost > 0).sort((a, b) => b.cost - a.cost))
    })
  }, [personas])

  // Listen for live updates
  useEffect(() => {
    const unsubs = [
      window.api.activity.onNew(({ event }) => {
        setActivity(prev => [event, ...prev].slice(0, 100))
      }),
      window.api.pipeline.onStatus((list) => setPipelines(list)),
      window.api.persona.onStatus((list) => setPersonas(list)),
      window.api.tasksBoard.onUpdated((items) => setTasks(items)),
      window.api.pipeline.onApprovalNew((request) => {
        setApprovals(prev => [...prev, request])
      }),
      window.api.pipeline.onApprovalUpdate(({ id, status }) => {
        if (status === 'approved' || status === 'dismissed' || status === 'expired') {
          setApprovals(prev => prev.filter(a => a.id !== id))
        }
      }),
      window.api.env.onStatusUpdate((list) => setEnvironments(list)),
    ]
    return () => unsubs.forEach(fn => fn())
  }, [])

  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [])

  const upcomingRuns = useMemo(() => {
    const items: Array<{ name: string; id: string; type: 'persona' | 'pipeline'; nextAt: Date; model?: string }> = []
    for (const p of personas) {
      if (!p.enabled || !p.schedule) continue
      const fires = nextRuns(p.schedule, 1)
      if (fires.length > 0 && fires[0].getTime() > Date.now()) {
        items.push({ name: p.name, id: p.id, type: 'persona', nextAt: fires[0], model: p.model })
      }
    }
    for (const pl of pipelines) {
      if (!pl.enabled || !pl.cron) continue
      const fires = nextRuns(pl.cron, 1)
      if (fires.length > 0 && fires[0].getTime() > Date.now()) {
        items.push({ name: pl.name, id: pl.name, type: 'pipeline', nextAt: fires[0] })
      }
    }
    items.sort((a, b) => a.nextAt.getTime() - b.nextAt.getTime())
    return items.slice(0, 8)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personas, pipelines, tick])

  const running = useMemo(() => instances.filter(i => i.status === 'running'), [instances])
  const totalCost = useMemo(() => instances.reduce((sum, i) => sum + (i.tokenUsage.cost || 0), 0), [instances])
  const activePipelines = useMemo(() => pipelines.filter(p => p.enabled), [pipelines])
  const errorPipelines = useMemo(() => pipelines.filter(p => p.lastError), [pipelines])
  const runningPersonas = useMemo(() => personas.filter(p => p.activeSessionId), [personas])
  const pendingApprovals = approvals
  const inProgressTasks = useMemo(() => tasks.filter(t => t.status === 'in_progress'), [tasks])
  const blockedTasks = useMemo(() => tasks.filter(t => t.status === 'blocked'), [tasks])
  const staleSessions = useMemo(() => running.filter(inst =>
    inst.activity === 'busy' && (idleMap.get(inst.id) || 0) > 900000
  ), [running, idleMap])
  const recentlyExited = useMemo(() =>
    instances
      .filter(i => i.status === 'exited')
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 5),
    [instances]
  )
  const runningEnvs = useMemo(() => environments.filter(e => e.status === 'running'), [environments])
  const unhealthyEnvs = useMemo(() => environments.filter(e => e.status === 'error' || e.status === 'partial'), [environments])
  const failedPersonas = useMemo(() => personaHealth.filter(ph =>
    !ph.lastRunSuccess && personas.some(p => p.id === ph.personaId && p.enabled)
  ), [personaHealth, personas])
  // Health score: weighted composite of persona, pipeline, session, and environment health
  const healthScore = useMemo(() => {
    // Persona health (35%): of enabled personas with run history, % whose last run succeeded
    const enabledWithHistory = personaHealth.filter(ph =>
      personas.some(p => p.id === ph.personaId && p.enabled)
    )
    const personaScore = enabledWithHistory.length > 0
      ? enabledWithHistory.filter(ph => ph.lastRunSuccess).length / enabledWithHistory.length
      : 1 // No history = assume healthy

    // Pipeline health (25%): of enabled pipelines, % without lastError
    const enabledPipelines = pipelines.filter(p => p.enabled)
    const pipelineScore = enabledPipelines.length > 0
      ? enabledPipelines.filter(p => !p.lastError).length / enabledPipelines.length
      : 1

    // Session health (25%): all running sessions counted as healthy (errors handled by #179)
    const sessionScore = 1

    // Environment health (15%): of all environments, % that are running
    const envScore = environments.length > 0
      ? environments.filter(e => e.status === 'running').length / environments.length
      : 1

    const composite = personaScore * 0.35 + pipelineScore * 0.25 + sessionScore * 0.25 + envScore * 0.15
    const pct = Math.round(composite * 100)
    const color = pct >= 80 ? 'green' : pct >= 50 ? 'amber' : 'red'
    return {
      pct,
      color,
      personaPct: Math.round(personaScore * 100),
      pipelinePct: Math.round(pipelineScore * 100),
      sessionPct: Math.round(sessionScore * 100),
      envPct: Math.round(envScore * 100),
    }
  }, [personas, pipelines, personaHealth, instances, environments])

  // Track actioned attention items for brief feedback (checkmark for 3s)
  const [actionedIds, setActionedIds] = useState<Set<string>>(new Set())
  function markActioned(id: string) {
    setActionedIds(prev => new Set(prev).add(id))
    setTimeout(() => setActionedIds(prev => { const next = new Set(prev); next.delete(id); return next }), 3000)
  }

  const [showHealthBreakdown, setShowHealthBreakdown] = useState(false)

  const [activitySourceFilter, setActivitySourceFilter] = useState<'all' | 'persona' | 'pipeline' | 'env'>('all')
  const [activityLevelFilter, setActivityLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all')
  const [activityExpanded, setActivityExpanded] = useState(false)
  const [activityTextSearch, setActivityTextSearch] = useState('')

  // Date navigation for activity history
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), [])
  const [selectedDate, setSelectedDate] = useState(todayStr)
  const [historicalActivity, setHistoricalActivity] = useState<ActivityEvent[] | null>(null)
  const isToday = selectedDate === todayStr

  useEffect(() => {
    if (isToday) {
      setHistoricalActivity(null)
    } else {
      window.api.activity.forDate(selectedDate).then(setHistoricalActivity)
    }
  }, [selectedDate, isToday])

  const displayActivity = isToday ? activity : (historicalActivity ?? [])

  function shiftDate(days: number) {
    const d = new Date(selectedDate + 'T12:00:00')
    d.setDate(d.getDate() + days)
    const next = d.toISOString().slice(0, 10)
    if (next <= todayStr) setSelectedDate(next)
  }

  function formatDateLabel(date: string): string {
    if (date === todayStr) return 'Today'
    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    if (date === yesterday.toISOString().slice(0, 10)) return 'Yesterday'
    return new Date(date + 'T12:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  const filteredActivity = useMemo(() => {
    let items = displayActivity
    if (activitySourceFilter !== 'all') items = items.filter(e => e.source === activitySourceFilter)
    if (activityLevelFilter !== 'all') items = items.filter(e => e.level === activityLevelFilter)
    if (activityTextSearch.trim()) {
      const q = activityTextSearch.toLowerCase()
      items = items.filter(e => e.name.toLowerCase().includes(q) || e.summary.toLowerCase().includes(q))
    }
    return items.slice(0, activityExpanded ? 100 : 20)
  }, [displayActivity, activitySourceFilter, activityLevelFilter, activityTextSearch, activityExpanded])

  const warnCount = useMemo(() => displayActivity.filter(e => e.level === 'warn').length, [displayActivity])
  const errorCount = useMemo(() => displayActivity.filter(e => e.level === 'error').length, [displayActivity])
  const activitySummary = useMemo(() => ({
    total: displayActivity.length,
    warns: displayActivity.filter(e => e.level === 'warn').length,
    errors: displayActivity.filter(e => e.level === 'error').length,
  }), [displayActivity])

  return (
    <div className="colony-overview">
      <div className="panel-header" style={{ WebkitAppRegion: 'drag' as any, paddingTop: 44 }}>
        <h2><Home size={16} /> Colony Overview</h2>
        <div className="panel-header-tabs">
          <button className={`panel-header-tab${tab === 'dashboard' ? ' active' : ''}`} onClick={() => setTab('dashboard')}>Dashboard</button>
          <button className={`panel-header-tab${tab === 'timeline' ? ' active' : ''}`} onClick={() => setTab('timeline')}><GanttChart size={11} /> Timeline</button>
        </div>
        <div className="panel-header-spacer" />
        <HelpPopover topic="overview" align="right" />
      </div>

      {tab === 'timeline' ? (
        <SessionTimeline instances={instances} onFocusInstance={onFocusInstance} />
      ) : (
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
          <div className="overview-stat-card" onClick={() => onNavigate('environments')}>
            <div className={`overview-stat-value${unhealthyEnvs.some(e => e.status === 'error') ? ' env-error' : unhealthyEnvs.length > 0 ? ' env-warn' : ''}`}>
              {runningEnvs.length}/{environments.length}
            </div>
            <div className="overview-stat-label">Environments</div>
          </div>
          <div
            className={`overview-stat-card${showHealthBreakdown ? ' active' : ''}`}
            onClick={() => setShowHealthBreakdown(prev => !prev)}
            title={`Personas: ${healthScore.personaPct}% | Pipelines: ${healthScore.pipelinePct}% | Sessions: ${healthScore.sessionPct}% | Environments: ${healthScore.envPct}%`}
          >
            <div className="overview-stat-value">
              <span className={`health-score-badge health-${healthScore.color}`}>{healthScore.pct}%</span>
            </div>
            <div className="overview-stat-label">Colony Health</div>
          </div>
          <div className="overview-stat-card" onClick={() => onNavigate('instances')}>
            <div className="overview-stat-value">{formatCost(totalCost)}</div>
            <div className="overview-stat-label">Session Cost</div>
          </div>
        </div>

        {/* Health score breakdown */}
        {showHealthBreakdown && (
          <div className="overview-health-breakdown">
            {[
              { label: 'Personas', pct: healthScore.personaPct, nav: 'personas' },
              { label: 'Pipelines', pct: healthScore.pipelinePct, nav: 'pipelines' },
              { label: 'Sessions', pct: healthScore.sessionPct, nav: 'instances' },
              { label: 'Environments', pct: healthScore.envPct, nav: 'environments' },
            ].map(row => (
              <div key={row.label} className="health-breakdown-row" onClick={() => onNavigate(row.nav)}>
                <span className={`health-dot health-${row.pct >= 80 ? 'green' : row.pct >= 50 ? 'amber' : 'red'}`} />
                <span className="health-breakdown-label">{row.label}</span>
                <div className="health-breakdown-bar">
                  <div className="health-breakdown-fill" style={{ width: `${row.pct}%`, background: row.pct >= 80 ? 'var(--success)' : row.pct >= 50 ? 'var(--warning)' : 'var(--danger)' }} />
                </div>
                <span className="health-breakdown-pct">{row.pct}%</span>
              </div>
            ))}
          </div>
        )}

        {/* Daily cost trend chart */}
        {costTrend.some(d => d.cost > 0) && (() => {
          const chartMax = dailyCostBudget > 0
            ? Math.max(...costTrend.map(d => d.cost), dailyCostBudget * 1.1, 0.01)
            : Math.max(...costTrend.map(d => d.cost), 0.01)
          const totalWeek = costTrend.reduce((s, d) => s + d.cost, 0)
          const dayNames = costTrend.map(d => {
            const dt = new Date(d.date + 'T12:00:00')
            return dt.toLocaleDateString(undefined, { weekday: 'short' })
          })
          const budgetLinePct = dailyCostBudget > 0 ? Math.min((dailyCostBudget / chartMax) * 100, 100) : 0
          return (
            <div className="overview-section">
              <h3><Activity size={14} /> Daily Cost (7d) <span className="overview-cost-total">${totalWeek.toFixed(2)}</span></h3>
              <div className="overview-cost-chart">
                {dailyCostBudget > 0 && (
                  <div className="cost-budget-line" style={{ bottom: `${budgetLinePct}%` }}>
                    <span className="cost-budget-label">${dailyCostBudget.toFixed(0)}</span>
                  </div>
                )}
                {costTrend.map((d, i) => {
                  const pct = d.cost > 0 ? Math.max(8, (d.cost / chartMax) * 100) : 0
                  const overBudget = dailyCostBudget > 0 && d.cost > dailyCostBudget
                  const warnBudget = dailyCostBudget > 0 && d.cost > dailyCostBudget * 0.75 && !overBudget
                  const barClass = `overview-cost-bar${overBudget ? ' cost-bar-over-budget' : warnBudget ? ' cost-bar-warn' : ''}`
                  return (
                    <div key={d.date} className="overview-cost-bar-col" title={`${d.date}: $${d.cost.toFixed(2)}`}>
                      <div className="overview-cost-bar-track">
                        <div className={barClass} style={{ height: `${pct}%` }} />
                      </div>
                      <span className="overview-cost-bar-label">{dayNames[i]}</span>
                    </div>
                  )
                })}
              </div>
            </div>
          )
        })()}

        {/* Top Spenders (7d) */}
        {costLeaderboard.length > 0 && (() => {
          const shown = costLeaderboard.slice(0, 10)
          const maxCost = shown[0]?.cost || 1
          const totalCost7d = costLeaderboard.reduce((s, r) => s + r.cost, 0)
          return (
            <div className="overview-section">
              <h3><BarChart3 size={14} /> Top Spenders (7d)</h3>
              <div className="overview-cost-leaderboard">
                {shown.map(entry => (
                  <div key={entry.id} className="cost-leader-row" onClick={() => onNavigate('personas')} title={`${entry.name}: $${entry.cost.toFixed(2)} (${totalCost7d > 0 ? ((entry.cost / totalCost7d) * 100).toFixed(0) : 0}%)`}>
                    <span className="cost-leader-name">{entry.name}</span>
                    <span className="cost-leader-pct">{totalCost7d > 0 ? `${((entry.cost / totalCost7d) * 100).toFixed(0)}%` : ''}</span>
                    <div className="cost-leader-bar-track">
                      <div className="cost-leader-bar" style={{ width: `${(entry.cost / maxCost) * 100}%` }} />
                    </div>
                    <span className="cost-leader-amount">{formatCost(entry.cost)}</span>
                  </div>
                ))}
                {costLeaderboard.length > 10 && (
                  <div className="cost-leader-more" onClick={() => onNavigate('personas')}>and {costLeaderboard.length - 10} more</div>
                )}
              </div>
            </div>
          )
        })()}

        {/* Attention needed */}
        {(pendingApprovals.length > 0 || errorPipelines.length > 0 || blockedTasks.length > 0 || staleSessions.length > 0 || unhealthyEnvs.length > 0 || failedPersonas.length > 0) && (
          <div className="overview-section">
            <h3><AlertCircle size={14} /> Needs Attention</h3>
            <div className="overview-attention-list">
              {staleSessions.map(inst => (
                <div key={inst.id} className="overview-attention-item attention-stale" onClick={() => onFocusInstance(inst.id)} title={`No output for ${Math.floor((idleMap.get(inst.id) || 0) / 60000)} minutes`}>
                  <Clock size={13} />
                  <span className="attention-label">{inst.name || 'Unnamed'} — stale</span>
                  <span className="attention-time">{Math.floor((idleMap.get(inst.id) || 0) / 60000)}m idle</span>
                  {onKill && (actionedIds.has(`stale-${inst.id}`) ? (
                    <span className="attention-action-btn approve"><CheckCircle2 size={13} /></span>
                  ) : (
                    <button className="attention-action-btn dismiss" title="Stop" onClick={(e) => { e.stopPropagation(); onKill(inst.id); markActioned(`stale-${inst.id}`) }}>
                      <Square size={13} />
                    </button>
                  ))}
                </div>
              ))}
              {pendingApprovals.map(a => (
                <div key={a.id} className="overview-attention-item attention-approval">
                  <Zap size={13} style={{ cursor: 'pointer' }} onClick={() => onNavigate('pipelines')} />
                  <span className="attention-label" onClick={() => onNavigate('pipelines')} style={{ cursor: 'pointer' }}>{a.pipelineName}</span>
                  {a.summary && <span className="attention-summary">{a.summary}</span>}
                  <span className="attention-time">{a.expiresAt ? `expires ${timeAgo(a.expiresAt)}` : timeAgo(a.createdAt)}</span>
                  <button className="attention-action-btn approve" title="Approve" onClick={(e) => { e.stopPropagation(); window.api.pipeline.approve(a.id).then(() => setApprovals(prev => prev.filter(x => x.id !== a.id))) }}>
                    <CheckCircle2 size={13} />
                  </button>
                  <button className="attention-action-btn dismiss" title="Dismiss" onClick={(e) => { e.stopPropagation(); window.api.pipeline.dismiss(a.id).then(() => setApprovals(prev => prev.filter(x => x.id !== a.id))) }}>
                    <X size={13} />
                  </button>
                </div>
              ))}
              {errorPipelines.map(p => (
                <div key={p.name} className="overview-attention-item attention-error" onClick={() => onNavigate('pipelines')} title={p.lastError || undefined}>
                  <AlertCircle size={13} />
                  <span className="attention-label">{p.name} failed</span>
                  {actionedIds.has(`pipe-${p.name}`) ? (
                    <span className="attention-action-btn approve"><CheckCircle2 size={13} /></span>
                  ) : (
                    <button className="attention-action-btn" title="Retry" onClick={(e) => { e.stopPropagation(); window.api.pipeline.triggerNow(p.name); markActioned(`pipe-${p.name}`) }}>
                      <RotateCcw size={13} />
                    </button>
                  )}
                </div>
              ))}
              {blockedTasks.map(t => (
                <div key={t.id} className="overview-attention-item attention-blocked" onClick={() => onNavigate('tasks')}>
                  <Circle size={13} />
                  <span className="attention-label">{t.title}</span>
                </div>
              ))}
              {unhealthyEnvs.map(e => (
                <div key={e.id} className="overview-attention-item attention-error" onClick={() => onNavigate('environments')}>
                  <AlertCircle size={13} />
                  <span className="attention-label">{e.name} — {e.status}</span>
                  {actionedIds.has(`env-${e.id}`) ? (
                    <span className="attention-action-btn approve"><CheckCircle2 size={13} /></span>
                  ) : (
                    <button className="attention-action-btn" title={e.status === 'error' ? 'Retry Setup' : 'Restart'} onClick={(ev) => {
                      ev.stopPropagation()
                      if (e.status === 'error') window.api.env.retrySetup(e.id)
                      else window.api.env.start(e.id)
                      markActioned(`env-${e.id}`)
                    }}>
                      <RotateCcw size={13} />
                    </button>
                  )}
                </div>
              ))}
              {failedPersonas.slice(0, 5).map(ph => {
                const p = personas.find(pp => pp.id === ph.personaId)
                return (
                  <div key={ph.personaId} className="overview-attention-item attention-error" onClick={() => onNavigate('personas')}>
                    <Users size={13} />
                    <span className="attention-label">{p?.name || ph.personaId} — last run failed</span>
                    {actionedIds.has(`persona-${ph.personaId}`) ? (
                      <span className="attention-action-btn approve"><CheckCircle2 size={13} /></span>
                    ) : (
                      <button className="attention-action-btn" title="Run Now" onClick={(ev) => { ev.stopPropagation(); window.api.persona.run(ph.personaId); markActioned(`persona-${ph.personaId}`) }}>
                        <Play size={13} />
                      </button>
                    )}
                  </div>
                )
              })}
              {failedPersonas.length > 5 && (
                <div className="overview-attention-item attention-error" onClick={() => onNavigate('personas')}>
                  <Users size={13} />
                  <span className="attention-label">and {failedPersonas.length - 5} more failed</span>
                </div>
              )}
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
                  onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, inst }) }}
                >
                  <span
                    className="overview-session-dot"
                    style={{ background: inst.color || 'var(--accent)' }}
                  />
                  <span className="overview-session-name">{inst.name || 'Unnamed'}</span>
                  {inst.activity === 'busy' && (idleMap.get(inst.id) || 0) > 900000 && <span className="overview-badge badge-stale">stale</span>}
                  {inst.activity === 'busy' && (idleMap.get(inst.id) || 0) > 300000 && (idleMap.get(inst.id) || 0) <= 900000 && <span className="overview-badge badge-idle">quiet</span>}
                  {inst.activity === 'busy' && (idleMap.get(inst.id) || 0) <= 300000 && <span className="overview-badge badge-busy">busy</span>}
                  {inst.activity === 'waiting' && <span className="overview-badge badge-waiting">idle</span>}
                  {inst.roleTag && <span className="overview-badge badge-role">{inst.roleTag}</span>}
                  <span className="overview-session-elapsed" title={`Running since ${new Date(inst.createdAt).toLocaleTimeString()}`}>
                    {formatElapsed(inst.createdAt)}
                  </span>
                  {inst.tokenUsage.cost ? (
                    <span className="overview-session-cost">{formatCost(inst.tokenUsage.cost)}</span>
                  ) : null}
                  {onKill && (
                    <button
                      className="attention-action-btn dismiss"
                      title="Stop session"
                      onClick={(e) => {
                        e.stopPropagation()
                        onKill(inst.id)
                        const key = `stop-${inst.id}`
                        setTriggeredIds(prev => new Set(prev).add(key))
                        setTimeout(() => setTriggeredIds(prev => { const n = new Set(prev); n.delete(key); return n }), 2000)
                      }}
                    >
                      {triggeredIds.has(`stop-${inst.id}`) ? <CheckCircle2 size={13} /> : <Square size={13} />}
                    </button>
                  )}
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

        {/* Just Finished */}
        {recentlyExited.length > 0 && (
          <div className="overview-section">
            <h3><CheckCircle2 size={14} /> Just Finished</h3>
            <div className="overview-session-list">
              {recentlyExited.map(inst => (
                <div key={inst.id} className="overview-session-tile" onClick={() => onFocusInstance(inst.id)}>
                  {inst.exitCode === 0 || inst.exitCode == null
                    ? <CheckCircle2 size={13} className="overview-exit-ok" />
                    : <XCircle size={13} className="overview-exit-err" />}
                  <span className="overview-session-name">{inst.name}</span>
                  {inst.exitSummary && (
                    <span className="overview-exit-summary" title={inst.exitSummary}>
                      {inst.exitSummary.length > 60 ? inst.exitSummary.slice(0, 57) + '...' : inst.exitSummary}
                    </span>
                  )}
                  <span className="overview-badge badge-role">{timeAgo(inst.createdAt)}</span>
                  {(inst.tokenUsage.cost || 0) > 0.01 && (
                    <span className="overview-session-cost">{formatCost(inst.tokenUsage.cost || 0)}</span>
                  )}
                  {onRestart && (
                    <button
                      className="attention-action-btn"
                      title="Restart session"
                      onClick={(e) => {
                        e.stopPropagation()
                        onRestart(inst.id)
                        const key = `restart-${inst.id}`
                        setTriggeredIds(prev => new Set(prev).add(key))
                        setTimeout(() => setTriggeredIds(prev => { const n = new Set(prev); n.delete(key); return n }), 2000)
                      }}
                    >
                      {triggeredIds.has(`restart-${inst.id}`) ? <CheckCircle2 size={13} /> : <Play size={13} />}
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Coming Up */}
        {upcomingRuns.length > 0 && (
          <div className="overview-section">
            <h3><Clock size={14} /> Coming Up</h3>
            <div className="overview-session-list">
              {upcomingRuns.map((item, i) => {
                const diffMs = item.nextAt.getTime() - Date.now()
                const mins = Math.floor(diffMs / 60000)
                const h = Math.floor(mins / 60), m = mins % 60
                const label = mins < 1 ? '<1m' : mins < 60 ? `${mins}m` : m ? `${h}h ${m}m` : `${h}h`
                const triggeredKey = `${item.type}-${item.id}`
                return (
                  <div key={`${item.type}-${item.name}-${i}`} className="overview-session-tile"
                    onClick={() => onNavigate(item.type === 'persona' ? 'personas' : 'pipelines')}>
                    <span className="overview-session-dot" style={{ background: item.type === 'persona' ? 'var(--accent-purple)' : 'var(--accent)' }} />
                    {item.type === 'persona' ? <Users size={11} /> : <Zap size={11} />}
                    <span className="overview-session-name">{item.name}</span>
                    <span className="overview-badge badge-role">in {label}</span>
                    {item.model && <span className="overview-session-cost">{item.model}</span>}
                    <button
                      className="attention-action-btn"
                      title="Run now"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (item.type === 'persona') window.api.persona.run(item.id)
                        else window.api.pipeline.triggerNow(item.id)
                        setTriggeredIds(prev => new Set(prev).add(triggeredKey))
                        setTimeout(() => setTriggeredIds(prev => { const n = new Set(prev); n.delete(triggeredKey); return n }), 2000)
                      }}
                    >
                      {triggeredIds.has(triggeredKey) ? <CheckCircle2 size={13} /> : <Play size={13} />}
                    </button>
                  </div>
                )
              })}
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
          <div className="activity-date-nav">
            <button className="activity-date-btn" onClick={() => shiftDate(-1)} title="Previous day">
              <ChevronLeft size={14} />
            </button>
            <span className="activity-date-label">{formatDateLabel(selectedDate)}</span>
            <button className="activity-date-btn" onClick={() => shiftDate(1)} disabled={isToday} title="Next day">
              <ChevronRight size={14} />
            </button>
            {!isToday && (
              <button className="activity-date-btn activity-date-today" onClick={() => setSelectedDate(todayStr)} title="Jump to today">
                Today
              </button>
            )}
          </div>
          <div className="activity-summary-line">
            {activitySummary.total} events
            {activitySummary.errors > 0 && <span className="activity-summary-errors">{activitySummary.errors} errors</span>}
            {activitySummary.warns > 0 && <span className="activity-summary-warns">{activitySummary.warns} warnings</span>}
          </div>
          <div className="settings-search" style={{ marginBottom: 8 }}>
            <Search size={13} />
            <input
              placeholder="Search events..."
              value={activityTextSearch}
              onChange={e => setActivityTextSearch(e.target.value)}
            />
            {activityTextSearch && (
              <button className="settings-search-clear" onClick={() => setActivityTextSearch('')}>
                <X size={13} />
              </button>
            )}
          </div>
          <div className="activity-filters">
            <div className="activity-filter-row">
              {(['all', 'persona', 'pipeline', 'env'] as const).map(s => (
                <button key={s} className={`activity-filter-chip${activitySourceFilter === s ? ' active' : ''}`} onClick={() => setActivitySourceFilter(s)}>
                  {s === 'all' ? 'All' : s === 'env' ? 'Env' : s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
            <div className="activity-filter-row">
              {(['all', 'info', 'warn', 'error'] as const).map(l => (
                <button key={l} className={`activity-filter-chip${activityLevelFilter === l ? ' active' : ''}`} onClick={() => setActivityLevelFilter(l)}>
                  {l === 'all' ? 'All' : l.charAt(0).toUpperCase() + l.slice(1)}
                  {l === 'warn' && warnCount > 0 && <span className="filter-badge warn">{warnCount}</span>}
                  {l === 'error' && errorCount > 0 && <span className="filter-badge error">{errorCount}</span>}
                </button>
              ))}
            </div>
          </div>
          {filteredActivity.length === 0 ? (
            <div className="overview-empty-hint">{
              (activityTextSearch.trim() || activitySourceFilter !== 'all' || activityLevelFilter !== 'all')
                ? 'No matching events'
                : isToday ? 'No activity recorded yet' : `No activity on ${formatDateLabel(selectedDate)}`
            }</div>
          ) : (
            <div className="overview-activity-list">
              {filteredActivity.map(ev => (
                <div key={ev.id} className="overview-activity-item"
                  onClick={() => {
                    if (ev.source === 'session' && ev.sessionId) onFocusInstance(ev.sessionId)
                    else if (ev.source === 'persona') onNavigate('personas')
                    else if (ev.source === 'pipeline') onNavigate('pipelines')
                    else if (ev.source === 'env') onNavigate('environments')
                  }}
                >
                  <span className={`overview-activity-dot activity-${ev.level}`} />
                  <span className="overview-activity-source">{ev.name}</span>
                  <span className="overview-activity-summary">{ev.summary}</span>
                  <span className="overview-activity-time">{timeAgo(ev.timestamp)}</span>
                </div>
              ))}
            </div>
          )}
          {!activityExpanded && displayActivity.length > 20 && (
            <button className="activity-show-more" onClick={() => setActivityExpanded(true)}>
              Show more ({displayActivity.length - 20} older)
            </button>
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
      )}
      {ctxMenu && (
        <div className="context-menu-overlay" onClick={() => setCtxMenu(null)}>
          <div
            className="context-menu"
            style={{ top: ctxMenu.y, left: ctxMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            <button className="context-menu-item" onClick={() => { onFocusInstance(ctxMenu.inst.id); setCtxMenu(null) }}>
              <Eye size={12} /> Focus
            </button>
            <button className="context-menu-item" onClick={() => {
              const text = window.prompt('Send message to session:')
              if (text?.trim()) {
                window.api.session.steer(ctxMenu.inst.id, text.trim())
                markActioned(`whisper-${ctxMenu.inst.id}`)
              }
              setCtxMenu(null)
            }}>
              <MessageSquare size={12} /> Whisper
            </button>
            {onKill && (
              <button className="context-menu-item" onClick={() => { onKill(ctxMenu.inst.id); setCtxMenu(null) }}>
                <Square size={12} /> Stop
              </button>
            )}
            <button
              className="context-menu-item"
              onClick={() => {
                const id = ctxMenu.inst.id
                if (ctxMenu.inst.pinned) {
                  window.api.instance.unpin(id)
                } else {
                  window.api.instance.pin(id)
                }
                setCtxMenu(null)
              }}
            >
              {ctxMenu.inst.pinned ? <><PinOff size={12} /> Unpin</> : <><Pin size={12} /> Pin</>}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
