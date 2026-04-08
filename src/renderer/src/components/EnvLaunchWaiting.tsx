import { useEffect, useState } from 'react'
import { Loader2, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react'
import type { EnvServiceStatus, PendingLaunchRecord } from '../../../preload'

interface Props {
  pendingId: string
  envId: string
  envName: string
  onSpawned: (instanceId: string, autoHeal: boolean, timedOut?: boolean) => void
  onCancel: () => void
}

/**
 * Live progress view for a pending session launch. Subscribes to
 * pendingLaunch:status and pendingLaunch:spawned events and renders
 * the current service roster. The parent dialog should close or
 * navigate away on the `onSpawned` callback.
 */
export default function EnvLaunchWaiting({ pendingId, envId, envName, onSpawned, onCancel }: Props) {
  const [services, setServices] = useState<EnvServiceStatus[]>([])
  const [state, setState] = useState<PendingLaunchRecord['state']>('waiting')

  useEffect(() => {
    const offStatus = window.api.env.onPendingLaunchStatus((record) => {
      if (record.id !== pendingId) return
      setState(record.state)
      setServices(record.services)
    })

    const offSpawned = window.api.env.onPendingLaunchSpawned((data) => {
      if (data.pendingId !== pendingId) return
      onSpawned(data.instanceId, data.autoHeal, data.timedOut)
    })

    // Poll env status every 2s so the service rows refresh even when the
    // env-daemon doesn't broadcast fast enough (e.g. during initial setup).
    const tick = async () => {
      try {
        const env = await window.api.env.get(envId)
        if (env) setServices(env.services)
      } catch { /* non-fatal */ }
    }
    void tick()
    const poll = setInterval(tick, 2000)

    return () => {
      offStatus()
      offSpawned()
      clearInterval(poll)
    }
  }, [pendingId, envId, onSpawned])

  const handleCancel = async () => {
    try { await window.api.env.cancelPendingLaunch(pendingId) } catch { /* non-fatal */ }
    onCancel()
  }

  const renderIcon = (status: string) => {
    if (status === 'running') return <CheckCircle2 size={14} className="env-launch-icon env-launch-icon-ok" />
    if (status === 'crashed') return <XCircle size={14} className="env-launch-icon env-launch-icon-error" />
    if (status === 'starting') return <Loader2 size={14} className="env-launch-icon env-launch-icon-spin" />
    return <div className="env-launch-icon-dot" />
  }

  const crashed = services.some(s => s.status === 'crashed')
  const statusLabel =
    state === 'timeout' ? 'Took too long — launching anyway' :
    crashed ? 'A service failed — preparing auto-heal session' :
    state === 'ready' ? 'Environment ready — launching session…' :
    state === 'failed' ? 'Environment failed — launching auto-heal session' :
    'Building environment — services starting…'

  return (
    <div className="env-launch-waiting">
      <div className="env-launch-header">
        {crashed || state === 'failed' || state === 'timeout' ? (
          <AlertTriangle size={18} className="env-launch-icon env-launch-icon-warn" />
        ) : (
          <Loader2 size={18} className="env-launch-icon env-launch-icon-spin" />
        )}
        <div className="env-launch-title">
          <strong>{envName}</strong>
          <div className={`env-launch-subtitle${crashed || state === 'failed' || state === 'timeout' ? ' env-launch-subtitle-warn' : ''}`}>
            {statusLabel}
          </div>
        </div>
      </div>

      <div className="env-launch-services">
        {services.length === 0 && (
          <div className="env-launch-empty">Waiting for services to register…</div>
        )}
        {services.map(svc => (
          <div key={svc.name} className={`env-launch-service env-launch-service-${svc.status}`}>
            {renderIcon(svc.status)}
            <span className="env-launch-service-name">{svc.name}</span>
            <span className="env-launch-service-status">{svc.status}</span>
          </div>
        ))}
      </div>

      <div className="env-launch-actions">
        <button
          type="button"
          className="env-btn env-btn-ghost"
          onClick={handleCancel}
          title="Cancel the pending session launch. The environment keeps running in the background — you can open a session from the Instances tab later."
        >
          Cancel
        </button>
      </div>
    </div>
  )
}
