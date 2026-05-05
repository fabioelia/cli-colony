import { useState, useMemo } from 'react'
import { AlertTriangle, TrendingUp, Users, Zap, GitCommit } from 'lucide-react'
import type { ActivityEvent, ClaudeInstance } from '../../../preload'

type Window = '8h' | '24h' | 'yesterday5pm' | 'custom'

interface Props {
  activityEvents: ActivityEvent[]
  instances: ClaudeInstance[]
}

function getWindowStart(win: Window, customHours: number): Date {
  const now = new Date()
  if (win === '8h') return new Date(now.getTime() - 8 * 3600 * 1000)
  if (win === '24h') return new Date(now.getTime() - 24 * 3600 * 1000)
  if (win === 'yesterday5pm') {
    const d = new Date(now)
    d.setDate(d.getDate() - 1)
    d.setHours(17, 0, 0, 0)
    return d
  }
  return new Date(now.getTime() - customHours * 3600 * 1000)
}

function fmtCost(c: number): string {
  return c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`
}

export default function ColonyDigestPanel({ activityEvents, instances }: Props) {
  const [win, setWin] = useState<Window>('8h')
  const [customHours, setCustomHours] = useState(12)

  const windowStart = useMemo(() => getWindowStart(win, customHours), [win, customHours])

  const filtered = useMemo(
    () => activityEvents.filter(e => new Date(e.timestamp) >= windowStart),
    [activityEvents, windowStart]
  )

  const errors = useMemo(() => filtered.filter(e => e.level === 'error'), [filtered])

  const personaEvents = useMemo(() => filtered.filter(e => e.source === 'persona'), [filtered])
  const pipelineEvents = useMemo(() => filtered.filter(e => e.source === 'pipeline'), [filtered])

  // Per-persona breakdown
  const personaGroups = useMemo(() => {
    const map = new Map<string, { events: ActivityEvent[]; errors: number }>()
    for (const e of personaEvents) {
      const key = e.name
      if (!map.has(key)) map.set(key, { events: [], errors: 0 })
      const g = map.get(key)!
      g.events.push(e)
      if (e.level === 'error') g.errors++
    }
    return Array.from(map.entries())
      .map(([name, g]) => ({ name, count: g.events.length, errors: g.errors, latest: g.events.at(-1) }))
      .sort((a, b) => b.count - a.count)
  }, [personaEvents])

  // Cost from instances active in window
  const totalCost = useMemo(() => {
    return instances
      .filter(i => i.createdAt && new Date(i.createdAt) >= windowStart)
      .reduce((sum, i) => sum + (i.tokenUsage?.cost ?? 0), 0)
  }, [instances, windowStart])

  // Pipeline success/fail count from events
  const pipelineStats = useMemo(() => {
    const fired = pipelineEvents.length
    const failed = pipelineEvents.filter(e => e.level === 'error').length
    return { fired, failed, passed: fired - failed }
  }, [pipelineEvents])

  const sessionCount = useMemo(
    () => instances.filter(i => i.createdAt && new Date(i.createdAt) >= windowStart).length,
    [instances, windowStart]
  )
  const errorSessionCount = useMemo(
    () => instances.filter(i => i.createdAt && new Date(i.createdAt) >= windowStart && i.exitCode != null && i.exitCode !== 0).length,
    [instances, windowStart]
  )

  const activePersonas = personaGroups.length

  return (
    <div className="colony-digest">
      {/* Time window selector */}
      <div className="colony-digest-toolbar">
        <span className="colony-digest-label">Window:</span>
        {(['8h', '24h', 'yesterday5pm'] as Window[]).map(w => (
          <button
            key={w}
            className={`activity-filter-chip${win === w ? ' active' : ''}`}
            onClick={() => setWin(w)}
          >
            {w === '8h' ? 'Last 8h' : w === '24h' ? 'Last 24h' : 'Since 5pm yesterday'}
          </button>
        ))}
        <button
          className={`activity-filter-chip${win === 'custom' ? ' active' : ''}`}
          onClick={() => setWin('custom')}
        >
          Custom
        </button>
        {win === 'custom' && (
          <input
            type="number"
            className="colony-digest-custom-hours"
            value={customHours}
            min={1}
            max={168}
            onChange={e => setCustomHours(Math.max(1, Math.min(168, Number(e.target.value))))}
          />
        )}
      </div>

      {/* Summary stat cards */}
      <div className="colony-digest-stats">
        <div className="colony-digest-stat-card">
          <Users size={14} />
          <div>
            <div className="colony-digest-stat-value">{sessionCount}</div>
            <div className="colony-digest-stat-label">Sessions{errorSessionCount > 0 ? ` (${errorSessionCount} failed)` : ''}</div>
          </div>
        </div>
        <div className="colony-digest-stat-card">
          <TrendingUp size={14} />
          <div>
            <div className="colony-digest-stat-value">{fmtCost(totalCost)}</div>
            <div className="colony-digest-stat-label">Total Cost</div>
          </div>
        </div>
        <div className="colony-digest-stat-card">
          <Zap size={14} />
          <div>
            <div className="colony-digest-stat-value">{pipelineStats.fired}</div>
            <div className="colony-digest-stat-label">Pipelines{pipelineStats.failed > 0 ? ` (${pipelineStats.failed} failed)` : ''}</div>
          </div>
        </div>
        <div className="colony-digest-stat-card">
          <GitCommit size={14} />
          <div>
            <div className="colony-digest-stat-value">{activePersonas}</div>
            <div className="colony-digest-stat-label">Active Personas</div>
          </div>
        </div>
      </div>

      {/* Error highlights */}
      {errors.length > 0 && (
        <div className="colony-digest-section">
          <div className="colony-digest-section-title"><AlertTriangle size={12} /> Errors ({errors.length})</div>
          {errors.slice(0, 5).map(e => (
            <div key={e.id} className="colony-digest-error-row">
              <span className="colony-digest-error-source">{e.source} / {e.name}</span>
              <span className="colony-digest-error-summary">{e.summary}</span>
            </div>
          ))}
          {errors.length > 5 && <div className="colony-digest-show-more">+{errors.length - 5} more errors</div>}
        </div>
      )}

      {/* Per-persona breakdown */}
      {personaGroups.length > 0 && (
        <div className="colony-digest-section">
          <div className="colony-digest-section-title">Persona Activity</div>
          {personaGroups.map(g => (
            <div key={g.name} className="colony-digest-persona-row">
              <span className="colony-digest-persona-name">{g.name}</span>
              <span className="colony-digest-persona-count">{g.count} event{g.count !== 1 ? 's' : ''}</span>
              {g.errors > 0 && <span className="colony-digest-persona-errors">{g.errors} error{g.errors !== 1 ? 's' : ''}</span>}
              {g.latest && <span className="colony-digest-persona-latest">{g.latest.summary}</span>}
            </div>
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <div className="colony-digest-empty">No activity in this time window.</div>
      )}
    </div>
  )
}
