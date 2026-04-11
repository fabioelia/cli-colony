import { useEffect, useState } from 'react'
import { RefreshCw, Sparkles, GitBranch, Clock, Package } from 'lucide-react'
import type { SessionArtifact } from '../../../shared/types'

interface ArtifactsTabProps {
  instanceId: string
  instanceStatus: string
  onArtifactCount?: (count: number) => void
}

export default function ArtifactsTab({ instanceId, instanceStatus, onArtifactCount }: ArtifactsTabProps) {
  const [artifact, setArtifact] = useState<SessionArtifact | null>(null)
  const [artifactLoading, setArtifactLoading] = useState(false)

  // Load artifact on mount
  useEffect(() => {
    setArtifactLoading(true)
    window.api.artifacts.get(instanceId).then(a => {
      setArtifact(a)
      onArtifactCount?.(a ? (a.commits.length || a.changes.length) : 0)
      setArtifactLoading(false)
    }).catch(() => {
      onArtifactCount?.(0)
      setArtifactLoading(false)
    })
  }, [instanceId])

  // Auto-load artifact when session exits
  useEffect(() => {
    if (instanceStatus === 'exited') {
      window.api.artifacts.get(instanceId).then(a => {
        setArtifact(a)
        onArtifactCount?.(a ? (a.commits.length || a.changes.length) : 0)
      }).catch(() => {})
    }
  }, [instanceStatus, instanceId])

  return (
    <div className="changes-panel">
      <div className="changes-panel-header">
        <span className="changes-panel-title">
          <Package size={13} /> Session Artifacts
        </span>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
          <button
            className="changes-refresh-btn"
            title="Refresh"
            onClick={() => {
              setArtifactLoading(true)
              window.api.artifacts.get(instanceId).then(a => {
                setArtifact(a)
                onArtifactCount?.(a ? (a.commits.length || a.changes.length) : 0)
                setArtifactLoading(false)
              }).catch(() => setArtifactLoading(false))
            }}
          >
            <RefreshCw size={12} />
          </button>
          {!artifact && instanceStatus === 'running' && (
            <button
              className="changes-refresh-btn"
              title="Collect artifact now"
              disabled={artifactLoading}
              onClick={() => {
                setArtifactLoading(true)
                window.api.artifacts.collect(instanceId).then(a => {
                  setArtifact(a)
                  onArtifactCount?.(a ? (a.commits.length || a.changes.length) : 0)
                  setArtifactLoading(false)
                }).catch(() => setArtifactLoading(false))
              }}
              style={{ color: 'var(--accent)' }}
            >
              <Sparkles size={12} />
            </button>
          )}
        </div>
      </div>
      <div className="changes-panel-content">
        {artifactLoading && <div className="changes-empty">Loading...</div>}
        {!artifactLoading && !artifact && (
          <div className="changes-empty">No artifact collected yet. Artifacts are auto-generated when sessions exit.</div>
        )}
        {!artifactLoading && artifact && (
          <>
            {/* Summary card */}
            <div style={{
              padding: '8px 10px',
              background: 'var(--bg-secondary)',
              borderRadius: '6px',
              margin: '4px 8px 8px',
              display: 'flex', flexDirection: 'column', gap: '6px',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>
                  {artifact.sessionName}
                </span>
                {artifact.personaName && (
                  <span style={{
                    fontSize: '9px', fontWeight: 600, padding: '1px 5px', borderRadius: '4px',
                    background: 'rgba(59,130,246,0.15)', color: 'var(--accent)',
                    border: '1px solid rgba(59,130,246,0.3)',
                  }}>{artifact.personaName}</span>
                )}
                {artifact.pipelineRunId && (
                  <span style={{
                    fontSize: '9px', fontWeight: 600, padding: '1px 5px', borderRadius: '4px',
                    background: 'rgba(245,158,11,0.15)', color: 'var(--warning)',
                    border: '1px solid rgba(245,158,11,0.3)',
                  }}>Pipeline</span>
                )}
                <span style={{
                  fontSize: '9px', fontWeight: 600, padding: '1px 5px', borderRadius: '4px',
                  background: artifact.exitCode === 0 ? 'rgba(16,185,129,0.15)' : 'rgba(239,68,68,0.12)',
                  color: artifact.exitCode === 0 ? 'var(--success)' : 'var(--danger)',
                  border: artifact.exitCode === 0 ? '1px solid rgba(16,185,129,0.3)' : '1px solid rgba(239,68,68,0.2)',
                }}>exit {artifact.exitCode}</span>
              </div>
              <div style={{ display: 'flex', gap: '12px', fontSize: '10px', opacity: 0.7 }}>
                {artifact.gitBranch && (
                  <span><GitBranch size={10} style={{ verticalAlign: 'middle' }} /> {artifact.gitBranch}</span>
                )}
                <span><Clock size={10} style={{ verticalAlign: 'middle' }} /> {Math.round(artifact.durationMs / 60000)}m</span>
                {artifact.costUsd != null && (
                  <span>${artifact.costUsd.toFixed(2)}</span>
                )}
                <span style={{ color: 'var(--success)' }}>+{artifact.totalInsertions}</span>
                <span style={{ color: 'var(--danger)' }}>-{artifact.totalDeletions}</span>
              </div>
            </div>

            {/* Commits section */}
            {artifact.commits.length > 0 && (
              <>
                <div style={{
                  padding: '4px 10px', fontSize: '10px', fontWeight: 600,
                  color: 'var(--text-secondary)', textTransform: 'uppercase',
                  letterSpacing: '0.04em',
                }}>
                  Commits ({artifact.commits.length})
                </div>
                {artifact.commits.map(c => (
                  <div key={c.hash} className="changes-event" style={{ cursor: 'default' }}>
                    <div className="changes-event-header" style={{ alignItems: 'center' }}>
                      <span style={{ fontFamily: 'monospace', fontSize: '10px', color: 'var(--accent)', minWidth: '56px' }}>
                        {c.hash.slice(0, 7)}
                      </span>
                      <span className="changes-event-input" style={{ flex: 1, fontSize: '11px' }}>
                        {c.shortMsg}
                      </span>
                    </div>
                  </div>
                ))}
              </>
            )}

            {/* Changed files section */}
            {artifact.changes.length > 0 && (
              <>
                <div style={{
                  padding: '4px 10px', fontSize: '10px', fontWeight: 600,
                  color: 'var(--text-secondary)', textTransform: 'uppercase',
                  letterSpacing: '0.04em', marginTop: '4px',
                }}>
                  Changed Files ({artifact.changes.length})
                </div>
                {artifact.changes.map(entry => (
                  <div key={entry.file} className="changes-event" style={{ cursor: 'default' }}>
                    <div className="changes-event-header" style={{ alignItems: 'center' }}>
                      <span style={{
                        color: entry.status === 'A' ? 'var(--success)'
                          : entry.status === 'D' ? 'var(--danger)'
                          : 'var(--warning)',
                        minWidth: '12px', fontSize: '11px',
                      }}>
                        {entry.status}
                      </span>
                      <span style={{ flex: 1, fontFamily: 'monospace', fontSize: '11px' }}>
                        {entry.file}
                      </span>
                      <span style={{ fontSize: '10px', opacity: 0.7 }}>
                        {entry.insertions > 0 && <span style={{ color: 'var(--success)' }}>+{entry.insertions}</span>}
                        {entry.insertions > 0 && entry.deletions > 0 && ' '}
                        {entry.deletions > 0 && <span style={{ color: 'var(--danger)' }}>-{entry.deletions}</span>}
                      </span>
                    </div>
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  )
}
