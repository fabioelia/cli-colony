import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, Terminal, ScrollText, AlertTriangle, RotateCcw, Volume2, Cpu } from 'lucide-react'

interface Props {
  onBack: () => void
}

export default function SettingsPanel({ onBack }: Props) {
  const [defaultArgs, setDefaultArgs] = useState('')
  const [shellProfile, setShellProfile] = useState('')
  const [soundOnFinish, setSoundOnFinish] = useState(true)
  const [autoCleanupMinutes, setAutoCleanupMinutes] = useState('5')
  const [globalHotkey, setGlobalHotkey] = useState('CommandOrControl+Shift+Space')
  const [availableShells, setAvailableShells] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [showRestartConfirm, setShowRestartConfirm] = useState(false)
  const [logs, setLogs] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const logsRef = useRef<HTMLPreElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      setDefaultArgs(s.defaultArgs || '')
      setShellProfile(s.shellProfile || '')
      setSoundOnFinish(s.soundOnFinish !== 'false')
      setAutoCleanupMinutes(s.autoCleanupMinutes || '5')
      setGlobalHotkey(s.globalHotkey || 'CommandOrControl+Shift+Space')
    })
    window.api.settings.getShells().then(setAvailableShells)
  }, [])

  useEffect(() => {
    if (!showLogs) {
      if (intervalRef.current) clearInterval(intervalRef.current)
      return
    }
    const refresh = () => window.api.logs.get().then(setLogs)
    refresh()
    intervalRef.current = setInterval(refresh, 2000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [showLogs])

  useEffect(() => {
    if (logsRef.current) {
      logsRef.current.scrollTop = logsRef.current.scrollHeight
    }
  }, [logs])

  const handleSave = async () => {
    await Promise.all([
      window.api.settings.set('defaultArgs', defaultArgs),
      window.api.settings.set('shellProfile', shellProfile),
      window.api.settings.set('soundOnFinish', soundOnFinish ? 'true' : 'false'),
      window.api.settings.set('autoCleanupMinutes', autoCleanupMinutes),
      window.api.settings.set('globalHotkey', globalHotkey),
    ])
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <button className="settings-back" onClick={onBack} aria-label="Back" title="Back">
          <ArrowLeft size={16} />
        </button>
        <h2>Settings</h2>
        <button className="settings-save-inline" onClick={handleSave} title="Save settings">
          {saved ? 'Saved!' : 'Save'}
        </button>
      </div>

      {/* CLI */}
      <div className="settings-section">
        <div className="settings-section-title">
          <Terminal size={12} />
          CLI
        </div>
        <div className="settings-field">
          <label>Default Arguments</label>
          <p className="settings-help">Prepended to every new session.</p>
          <input
            value={defaultArgs}
            onChange={(e) => setDefaultArgs(e.target.value)}
            placeholder="e.g. --permission-mode bypassPermissions --model sonnet"
          />
        </div>
        <div className="settings-field">
          <label>Shell</label>
          <p className="settings-help">
            Environment for Claude sessions.
            <span className="settings-restart-note">Requires daemon restart</span>
          </p>
          <select
            value={shellProfile}
            onChange={(e) => setShellProfile(e.target.value)}
            className="settings-select"
          >
            <option value="">Default (inherit environment)</option>
            {availableShells.map((shell) => (
              <option key={shell} value={shell}>{shell}</option>
            ))}
            <option value="login">Login shell (loads profile)</option>
          </select>
        </div>
        <div className="settings-field">
          <label>Global Hotkey</label>
          <p className="settings-help">
            Brings the app to front from anywhere.
            <span className="settings-restart-note">Requires app restart</span>
          </p>
          <input
            value={globalHotkey}
            onChange={(e) => setGlobalHotkey(e.target.value)}
            placeholder="CommandOrControl+Shift+Space"
          />
        </div>
      </div>

      {/* Notifications */}
      <div className="settings-section">
        <div className="settings-section-title">
          <Volume2 size={12} />
          Notifications
        </div>
        <div className="settings-row">
          <span className="settings-row-label">Sound when Claude finishes</span>
          <button
            className={`settings-toggle ${soundOnFinish ? 'active' : ''}`}
            onClick={() => setSoundOnFinish(!soundOnFinish)}
            role="switch"
            aria-checked={soundOnFinish}
            title={soundOnFinish ? 'Disable sound' : 'Enable sound'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        <p className="settings-help settings-help-bottom">Plays when a session goes from busy to waiting and the app is not focused.</p>
      </div>

      {/* Sessions */}
      <div className="settings-section">
        <div className="settings-section-title">
          <Terminal size={12} />
          Sessions
        </div>
        <div className="settings-row">
          <span className="settings-row-label">Auto-cleanup stopped sessions</span>
          <div className="settings-row-control">
            <input
              type="number"
              min="0"
              max="60"
              value={autoCleanupMinutes}
              onChange={(e) => setAutoCleanupMinutes(e.target.value)}
              className="settings-compact-number"
            />
            <span className="settings-unit">min</span>
          </div>
        </div>
        <p className="settings-help settings-help-bottom">Set to 0 to keep stopped sessions indefinitely.</p>
      </div>

      {/* Daemon */}
      <div className="settings-section">
        <div className="settings-section-title">
          <Cpu size={12} />
          Daemon
        </div>
        <p className="settings-help">
          Background process that owns all terminal sessions. Restart to apply shell changes.
        </p>
        {!showRestartConfirm ? (
          <button
            className="settings-daemon-restart"
            onClick={() => setShowRestartConfirm(true)}
            title="Restart daemon"
          >
            <RotateCcw size={13} /> Restart Daemon
          </button>
        ) : (
          <div className="settings-daemon-confirm">
            <div className="settings-daemon-warning">
              <AlertTriangle size={14} />
              <span>All running sessions will be terminated.</span>
            </div>
            <div className="settings-daemon-confirm-actions">
              <button
                className="settings-daemon-cancel"
                onClick={() => setShowRestartConfirm(false)}
                title="Cancel"
              >
                Cancel
              </button>
              <button
                className="settings-daemon-confirm-btn"
                disabled={restarting}
                title="Confirm restart"
                onClick={async () => {
                  setRestarting(true)
                  try {
                    await window.api.daemon.restart()
                  } catch (err) {
                    console.error('daemon restart failed:', err)
                  }
                  setRestarting(false)
                  setShowRestartConfirm(false)
                }}
              >
                {restarting ? 'Restarting...' : 'Restart'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Logs */}
      <div className={`settings-section settings-logs-section ${showLogs ? '' : 'collapsed'}`}>
        <div className="settings-section-title">
          <ScrollText size={12} />
          Logs
          <div className="settings-logs-actions">
            <button
              className="settings-logs-toggle"
              onClick={() => setShowLogs(!showLogs)}
              title={showLogs ? 'Hide logs' : 'Show logs'}
            >
              {showLogs ? 'Hide' : 'Show'}
            </button>
            {showLogs && (
              <button
                className="settings-logs-toggle"
                onClick={() => { window.api.logs.clear(); setLogs('') }}
                title="Clear logs"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        {showLogs && (
          <pre className="settings-logs" ref={logsRef}>
            {logs || 'No logs yet.'}
          </pre>
        )}
      </div>

      <div className="settings-footer">
        <span className="settings-config-path">~/.claude-colony/settings.json</span>
      </div>
    </div>
  )
}
