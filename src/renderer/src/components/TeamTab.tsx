import { useEffect, useState } from 'react'
import { Bot, RefreshCw } from 'lucide-react'
import type { CoordinatorTeam, CoordinatorWorker } from '../../../shared/types'

interface TeamTabProps {
  instanceId: string
  onWorkerCountChange?: (count: number) => void
  onNavigateToWorker?: (id: string) => void
}

export default function TeamTab({ instanceId, onWorkerCountChange, onNavigateToWorker }: TeamTabProps) {
  const [coordinatorTeam, setCoordinatorTeam] = useState<CoordinatorTeam | null>(null)
  const [teamLoading, setTeamLoading] = useState(false)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; worker: CoordinatorWorker } | null>(null)

  useEffect(() => {
    setTeamLoading(true)
    window.api.session.getCoordinatorTeam(instanceId).then((team) => {
      setCoordinatorTeam(team)
      setTeamLoading(false)
      onWorkerCountChange?.(team?.workers?.length ?? 0)
    }).catch(() => {
      setCoordinatorTeam(null)
      setTeamLoading(false)
      onWorkerCountChange?.(0)
    })
  }, [instanceId])

  const refresh = () => {
    setTeamLoading(true)
    window.api.session.getCoordinatorTeam(instanceId).then((team) => {
      setCoordinatorTeam(team)
      setTeamLoading(false)
      onWorkerCountChange?.(team?.workers?.length ?? 0)
    }).catch(() => {
      setCoordinatorTeam(null)
      setTeamLoading(false)
      onWorkerCountChange?.(0)
    })
  }

  useEffect(() => {
    if (!ctxMenu) return
    const handler = () => setCtxMenu(null)
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [ctxMenu])

  return (
    <div className="changes-panel">
      <div className="changes-panel-header">
        <span className="changes-panel-title">
          <Bot size={13} /> Coordinator Team
        </span>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button
            className="changes-refresh-btn"
            title="Refresh"
            onClick={refresh}
          >
            <RefreshCw size={12} />
          </button>
        </div>
      </div>
      <div className="changes-panel-content">
        {teamLoading && <div className="changes-empty">Loading workers...</div>}
        {!teamLoading && (!coordinatorTeam || coordinatorTeam.workers.length === 0) && (
          <div className="changes-empty">No worker sessions active.</div>
        )}
        {!teamLoading && coordinatorTeam && coordinatorTeam.workers.map((worker: CoordinatorWorker) => (
          <div
            key={worker.id}
            className="changes-event"
            style={{ cursor: 'pointer' }}
            onClick={() => onNavigateToWorker?.(worker.id)}
            onContextMenu={(e) => { e.preventDefault(); setCtxMenu({ x: e.clientX, y: e.clientY, worker }) }}
          >
            <div className="changes-event-header" style={{ alignItems: 'center' }}>
              <span style={{
                fontSize: '11px',
                fontWeight: 600,
                flex: 1,
              }}>
                {worker.name}
              </span>
              <span style={{
                fontSize: '10px',
                padding: '2px 6px',
                borderRadius: '3px',
                background: worker.status === 'running'
                  ? 'rgba(16,185,129,0.15)'
                  : 'rgba(107,114,128,0.15)',
                color: worker.status === 'running'
                  ? 'var(--success)'
                  : 'var(--text-muted)',
                textTransform: 'capitalize',
              }}>
                {worker.status}
              </span>
              {worker.activity && (
                <span style={{
                  fontSize: '10px',
                  padding: '2px 6px',
                  borderRadius: '3px',
                  background: worker.activity === 'busy'
                    ? 'rgba(245,158,11,0.15)'
                    : 'rgba(16,185,129,0.15)',
                  color: worker.activity === 'busy'
                    ? 'var(--warning)'
                    : 'var(--success)',
                  textTransform: 'capitalize',
                  marginLeft: '6px',
                }}>
                  {worker.activity}
                </span>
              )}
              {worker.costUsd !== undefined && (
                <span style={{
                  fontSize: '10px',
                  opacity: 0.7,
                  marginLeft: '6px',
                }}>
                  ${worker.costUsd.toFixed(3)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>
      {ctxMenu && (
        <div className="context-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }}>
          <button className="context-menu-item" onClick={() => { onNavigateToWorker?.(ctxMenu.worker.id); setCtxMenu(null) }}>Focus</button>
          <button className="context-menu-item" onClick={async () => { await window.api.instance.kill(ctxMenu.worker.id); setCtxMenu(null); refresh() }}>Kill</button>
          <button className="context-menu-item" onClick={async () => { await window.api.instance.restart(ctxMenu.worker.id); setCtxMenu(null); refresh() }}>Restart</button>
        </div>
      )}
    </div>
  )
}
