import { useState, useEffect, useRef } from 'react'

interface Props {
  onBack: () => void
}

export default function SettingsPanel({ onBack }: Props) {
  const [defaultArgs, setDefaultArgs] = useState('')
  const [saved, setSaved] = useState(false)
  const [logs, setLogs] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const logsRef = useRef<HTMLPreElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      setDefaultArgs(s.defaultArgs || '')
    })
  }, [])

  // Auto-refresh logs when visible
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
    await window.api.settings.set('defaultArgs', defaultArgs)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings-panel">
      <div className="settings-header">
        <h2>Settings</h2>
      </div>

      <div className="settings-section">
        <div className="settings-field">
          <label>Default CLI Arguments</label>
          <p className="settings-help">
            These arguments are prepended to every new Claude instance.
            For example: <code>--permission-mode bypassPermissions</code>
          </p>
          <input
            value={defaultArgs}
            onChange={(e) => setDefaultArgs(e.target.value)}
            placeholder="e.g. --permission-mode bypassPermissions --model sonnet"
          />
        </div>

        <div className="settings-actions">
          <button className="settings-save" onClick={handleSave}>
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-field">
          <label>Config Location</label>
          <p className="settings-help">
            Settings are stored at <code>~/.claude-colony/settings.json</code>
          </p>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-field">
          <div className="settings-logs-header">
            <label>Application Logs</label>
            <div className="settings-logs-actions">
              <button
                className="settings-logs-toggle"
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? 'Hide' : 'Show'}
              </button>
              {showLogs && (
                <button
                  className="settings-logs-toggle"
                  onClick={() => { window.api.logs.clear(); setLogs('') }}
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
      </div>
    </div>
  )
}
