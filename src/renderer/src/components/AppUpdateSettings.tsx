import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, DownloadCloud, AlertTriangle, CheckCircle, Loader2, RefreshCw } from 'lucide-react'
import HelpPopover from './HelpPopover'
import type { UpdateStatus } from '../../../preload'

interface Props {
  isExpanded: boolean
  onToggleExpand: () => void
}

function formatLastCheck(ts: number | null): string {
  if (!ts) return 'Never'
  const ageMs = Date.now() - ts
  if (ageMs < 60_000) return 'Just now'
  if (ageMs < 3_600_000) return `${Math.round(ageMs / 60_000)}m ago`
  if (ageMs < 86_400_000) return `${Math.round(ageMs / 3_600_000)}h ago`
  return `${Math.round(ageMs / 86_400_000)}d ago`
}

/**
 * Settings → Updates section. Mirrors the BatchExecutionSettings layout
 * so the panel stays visually consistent.
 *
 * Shows:
 * - Current version + last-checked timestamp + update state
 * - Toggle: auto-check daily (default on)
 * - "Check for updates now" button (always enabled in packaged builds)
 * - "Download" button when update-available, "Install & Restart" when ready
 * - Warning banner in dev mode ("Updates disabled in development build")
 */
export default function AppUpdateSettings({ isExpanded, onToggleExpand }: Props) {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [autoEnabled, setAutoEnabled] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let unmounted = false

    const loadInitial = async () => {
      try {
        const [s, enabled] = await Promise.all([
          window.api.appUpdate.getStatus(),
          window.api.appUpdate.getAutoEnabled(),
        ])
        if (unmounted) return
        setStatus(s)
        setAutoEnabled(enabled)
      } catch (err) {
        console.warn('[AppUpdateSettings] failed to load:', err)
      }
    }
    loadInitial()

    const unsub = window.api.appUpdate.onStatus((s) => {
      if (!unmounted) setStatus(s)
    })

    return () => {
      unmounted = true
      unsub()
    }
  }, [])

  const handleToggleAuto = async (enabled: boolean) => {
    setAutoEnabled(enabled)
    await window.api.appUpdate.setAutoEnabled(enabled)
  }

  const handleCheckNow = async () => {
    setBusy(true)
    try {
      await window.api.appUpdate.checkNow()
    } finally {
      setBusy(false)
    }
  }

  const handleDownload = async () => {
    setBusy(true)
    try {
      await window.api.appUpdate.download()
    } finally {
      setBusy(false)
    }
  }

  const handleInstall = async () => {
    const running = await window.api.instance.list()
    const activeCount = running.filter((i: any) => i.status === 'running').length
    if (activeCount > 0) {
      const ok = confirm(
        `Install update now? ${activeCount} running session${activeCount === 1 ? '' : 's'} will be stopped.\n\n` +
        `Resume after restart will attempt to restore them.`
      )
      if (!ok) return
    }
    await window.api.appUpdate.quitAndInstall()
  }

  if (!status) {
    return (
      <div className="settings-section">
        <button className="settings-section-header" onClick={onToggleExpand}>
          <div className="settings-header-left">
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <h3>Updates</h3>
          </div>
          <DownloadCloud size={16} />
        </button>
      </div>
    )
  }

  const statusLine = (() => {
    switch (status.state) {
      case 'checking': return { icon: <Loader2 size={14} className="spin" />, text: 'Checking for updates…', color: '#888' }
      case 'available': return { icon: <DownloadCloud size={14} />, text: `Update available: v${status.info?.version}`, color: '#60a5fa' }
      case 'downloading': return { icon: <Loader2 size={14} className="spin" />, text: `Downloading: ${status.downloadPercent}%`, color: '#60a5fa' }
      case 'ready': return { icon: <CheckCircle size={14} />, text: `Update ready: v${status.info?.version}`, color: '#4ade80' }
      case 'not-available': return { icon: <CheckCircle size={14} />, text: 'Up to date', color: '#4ade80' }
      case 'error': return { icon: <AlertTriangle size={14} />, text: status.lastError || 'Update check failed', color: '#ef4444' }
      default: return { icon: null, text: 'Idle', color: '#888' }
    }
  })()

  return (
    <div className="settings-section">
      <button className="settings-section-header" onClick={onToggleExpand}>
        <div className="settings-header-left">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <h3>Updates</h3>
        </div>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <HelpPopover topic="settings" zone="Updates" align="right" />
          <DownloadCloud size={16} />
        </div>
      </button>

      {isExpanded && (
        <div className="settings-section-content">
          {!status.enabledInEnv && (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', padding: '8px 10px', marginBottom: '12px', border: '1px solid #333', borderRadius: '4px', fontSize: '12px', color: '#888' }}>
              <AlertTriangle size={14} style={{ marginTop: '2px', flexShrink: 0, color: '#fbbf24' }} />
              <span>Updates are disabled in development builds. Run a packaged build (<code>yarn package</code>) to enable update checks.</span>
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '16px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '4px' }}>Current Version</label>
              <div style={{ fontSize: '14px', fontFamily: 'monospace' }}>v{status.currentVersion}</div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '4px' }}>Last Checked</label>
              <div style={{ fontSize: '14px' }}>{formatLastCheck(status.lastCheckAt)}</div>
            </div>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '4px' }}>Status</label>
              <div style={{ fontSize: '13px', display: 'flex', alignItems: 'center', gap: '6px', color: statusLine.color }}>
                {statusLine.icon}
                <span>{statusLine.text}</span>
              </div>
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: '16px' }}>
            <input
              type="checkbox"
              checked={autoEnabled}
              onChange={(e) => handleToggleAuto(e.target.checked)}
              disabled={!status.enabledInEnv}
            />
            <span style={{ fontSize: '13px' }}>Automatically check for updates daily</span>
          </label>

          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              onClick={handleCheckNow}
              disabled={busy || !status.enabledInEnv || status.state === 'checking' || status.state === 'downloading'}
              className="settings-btn-secondary"
              style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
            >
              <RefreshCw size={12} />
              {status.state === 'checking' ? 'Checking…' : 'Check for updates now'}
            </button>
            {status.state === 'available' && (
              <button
                onClick={handleDownload}
                disabled={busy}
                className="settings-btn-primary"
                style={{ flex: 1 }}
              >
                Download Update
              </button>
            )}
            {status.state === 'ready' && (
              <button
                onClick={handleInstall}
                className="settings-btn-primary"
                style={{ flex: 1 }}
              >
                Install &amp; Restart
              </button>
            )}
          </div>

          {status.info?.releaseNotes && (status.state === 'available' || status.state === 'ready') && (
            <div style={{ marginTop: '16px', padding: '10px', background: '#1a1a1a', borderRadius: '4px', fontSize: '12px', maxHeight: '200px', overflowY: 'auto' }}>
              <div style={{ fontWeight: 600, marginBottom: '6px' }}>Release notes</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', color: '#bbb' }}>{status.info.releaseNotes}</pre>
            </div>
          )}
        </div>
      )}

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}
