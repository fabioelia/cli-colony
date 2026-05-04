import React from 'react'
import { Network, CheckCircle, XCircle, Loader2, Clock, DollarSign, ExternalLink } from 'lucide-react'
import type { ClaudeInstance } from '../../../shared/types'

interface Props {
  parentInstance: ClaudeInstance
  childInstances: ClaudeInstance[]
  onNavigateToChild: (id: string) => void
}

function duration(inst: ClaudeInstance): string {
  if (!inst.createdAt) return ''
  const endMs = inst.exitedAt ?? Date.now()
  const ms = endMs - new Date(inst.createdAt).getTime()
  if (ms < 60000) return `${Math.round(ms / 1000)}s`
  if (ms < 3600000) return `${Math.round(ms / 60000)}m`
  return `${(ms / 3600000).toFixed(1)}h`
}

export default function FanOutMonitor({ parentInstance: _p, childInstances, onNavigateToChild }: Props) {
  const allDone = childInstances.length > 0 && childInstances.every(c => c.status !== 'running')
  const anyFailed = childInstances.some(c => c.status !== 'running' && c.exitCode !== 0)
  const totalCost = childInstances.reduce((s, c) => s + (c.tokenUsage?.cost ?? 0), 0)

  return (
    <div className="fanout-monitor">
      <div className="fanout-monitor-header">
        <Network size={12} />
        <span>Fan-Out — {childInstances.length} sub-sessions</span>
        {allDone && (
          <span className={`fanout-monitor-status ${anyFailed ? 'failed' : 'done'}`}>
            {anyFailed ? <><XCircle size={10} /> Some failed</> : <><CheckCircle size={10} /> All done</>}
          </span>
        )}
        {totalCost > 0 && (
          <span className="fanout-monitor-cost"><DollarSign size={9} />{totalCost.toFixed(2)}</span>
        )}
      </div>
      <div className="fanout-monitor-rows">
        {childInstances.map(child => (
          <div
            key={child.id}
            className="fanout-monitor-row"
            onClick={() => onNavigateToChild(child.id)}
            role="button"
            tabIndex={0}
            onKeyDown={e => { if (e.key === 'Enter') onNavigateToChild(child.id) }}
          >
            <span className="fanout-monitor-row-icon">
              {child.status === 'running'
                ? <Loader2 size={11} className="spin" style={{ color: 'var(--accent)' }} />
                : child.exitCode === 0
                  ? <CheckCircle size={11} style={{ color: 'var(--success)' }} />
                  : <XCircle size={11} style={{ color: 'var(--danger)' }} />
              }
            </span>
            <span className="fanout-monitor-row-name">{child.name}</span>
            <span className="fanout-monitor-row-dur"><Clock size={9} /> {duration(child)}</span>
            {(child.tokenUsage?.cost ?? 0) > 0.001 && (
              <span className="fanout-monitor-row-cost">${child.tokenUsage.cost!.toFixed(2)}</span>
            )}
            <ExternalLink size={9} className="fanout-monitor-row-link" />
          </div>
        ))}
      </div>
    </div>
  )
}
