import { useEffect, useState } from 'react'
import type { UpdateStatus } from '../../../preload'

/**
 * Banner shown at the top of the window when an app update is ready to install.
 * Mirrors the daemon-update-banner styling.
 *
 * State machine it cares about:
 * - `available`  → "Update available · vX.Y.Z" + Download button
 * - `downloading` → "Downloading update… N%" (disabled button)
 * - `ready`      → "Update ready · vX.Y.Z" + Install & Restart button
 *
 * Everything else (idle / checking / not-available / error) stays hidden.
 * The user can dismiss for this session only — banner reappears on next launch
 * (or when the state transitions, since dismissal is keyed off the known version).
 */
export default function AppUpdateBanner() {
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [dismissedVersion, setDismissedVersion] = useState<string | null>(null)

  useEffect(() => {
    let unmounted = false
    window.api.appUpdate.getStatus().then((s) => {
      if (!unmounted) setStatus(s)
    }).catch(() => { /* main process not ready yet */ })
    const unsub = window.api.appUpdate.onStatus((s) => {
      if (!unmounted) setStatus(s)
    })
    return () => {
      unmounted = true
      unsub()
    }
  }, [])

  if (!status) return null
  const { state, info } = status
  if (state !== 'available' && state !== 'downloading' && state !== 'ready') return null
  if (info && dismissedVersion === info.version) return null

  const handleDownload = async () => {
    await window.api.appUpdate.download()
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

  const handleDismiss = () => {
    if (info) setDismissedVersion(info.version)
  }

  const version = info?.version || 'new version'
  const isDev = version.includes('commit')

  return (
    <div className="app-update-banner">
      {state === 'available' && (
        <>
          <span>
            <strong>Update available</strong> — {isDev ? version : `v${version} is ready to download`}.
          </span>
          <button
            onClick={handleDownload}
            title={isDev ? 'Pull latest from origin/main and run yarn install' : 'Download the update in the background — your sessions keep running'}
          >
            {isDev ? 'Pull & Install' : 'Download'}
          </button>
          <button
            className="app-update-dismiss"
            onClick={handleDismiss}
            title={`Hide this banner for v${version}. It will reappear on next launch or if a newer version ships.`}
          >
            Dismiss
          </button>
        </>
      )}
      {state === 'downloading' && (
        <>
          <span>
            <strong>Downloading update…</strong> {status.downloadPercent}%
          </span>
          <div
            className="app-update-progress"
            title={`Downloading v${version} — ${status.downloadPercent}%`}
          >
            <div className="app-update-progress-bar" style={{ width: `${status.downloadPercent}%` }} />
          </div>
        </>
      )}
      {state === 'ready' && (
        <>
          <span>
            <strong>Update ready</strong> — {isDev ? 'pulled and installed. Restart to apply.' : `v${version}. Install and restart to apply.`}
          </span>
          <button
            onClick={handleInstall}
            title="Quit Colony and relaunch on the new version. Running sessions will be stopped — resume will attempt to restore them."
          >
            Install &amp; Restart
          </button>
          <button
            className="app-update-dismiss"
            onClick={handleDismiss}
            title="Hide this banner until next launch. The update stays downloaded and ready to install."
          >
            Later
          </button>
        </>
      )}
    </div>
  )
}
