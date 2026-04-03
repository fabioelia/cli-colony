import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, Terminal, ScrollText, AlertTriangle, RotateCcw, Volume2, Cpu, Settings } from 'lucide-react'
import HelpPopover from './HelpPopover'

interface Props {
  onBack: () => void
}

export default function SettingsPanel({ onBack }: Props) {
  const [defaultArgs, setDefaultArgs] = useState('')
  const [defaultCliBackend, setDefaultCliBackend] = useState<'claude' | 'cursor-agent'>('claude')
  const [syncClaudeSlashCommands, setSyncClaudeSlashCommands] = useState(true)
  const [shellProfile, setShellProfile] = useState('')
  const [gitProtocol, setGitProtocol] = useState<'ssh' | 'https'>('ssh')
  const [soundOnFinish, setSoundOnFinish] = useState(true)
  const [autoCleanupMinutes, setAutoCleanupMinutes] = useState('5')
  const [globalHotkey, setGlobalHotkey] = useState('CommandOrControl+Shift+Space')
  const [availableShells, setAvailableShells] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [showRestartConfirm, setShowRestartConfirm] = useState(false)
  const [logs, setLogs] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const [daemonVersion, setDaemonVersion] = useState<{ running: number; expected: number } | null>(null)
  const logsRef = useRef<HTMLPreElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      setDefaultArgs(s.defaultArgs || '')
      setDefaultCliBackend(s.defaultCliBackend === 'cursor-agent' ? 'cursor-agent' : 'claude')
      setSyncClaudeSlashCommands(s.syncClaudeSlashCommands !== 'false')
      setShellProfile(s.shellProfile || '')
      setGitProtocol((s.gitProtocol === 'https' ? 'https' : 'ssh') as 'ssh' | 'https')
      setSoundOnFinish(s.soundOnFinish !== 'false')
      setAutoCleanupMinutes(s.autoCleanupMinutes || '5')
      setGlobalHotkey(s.globalHotkey || 'CommandOrControl+Shift+Space')
    })
    window.api.settings.getShells().then(setAvailableShells)
    window.api.daemon.getVersion().then(setDaemonVersion).catch(() => {})
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
      window.api.settings.set('defaultCliBackend', defaultCliBackend),
      window.api.settings.set('syncClaudeSlashCommands', syncClaudeSlashCommands ? 'true' : 'false'),
      window.api.settings.set('shellProfile', shellProfile),
      window.api.settings.set('gitProtocol', gitProtocol),
      window.api.settings.set('soundOnFinish', soundOnFinish ? 'true' : 'false'),
      window.api.settings.set('autoCleanupMinutes', autoCleanupMinutes),
      window.api.settings.set('globalHotkey', globalHotkey),
    ])
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  return (
    <div className="settings-panel">
      <div className="panel-header">
        <button className="panel-header-back" onClick={onBack} title="Back">
          <ArrowLeft size={16} />
        </button>
        <h2><Settings size={16} /> Settings</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="settings" align="right" />
        <div className="panel-header-actions">
          <button className="panel-header-btn" onClick={handleSave} title="Save settings">
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
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
          <label>Default CLI</label>
          <p className="settings-help">
            New sessions spawn this program in the terminal. Claude Code uses <code>claude</code> with Colony&apos;s
            extra flags; Cursor uses the <code>agent</code> binary on your PATH.
          </p>
          <select
            value={defaultCliBackend}
            onChange={(e) => setDefaultCliBackend(e.target.value as 'claude' | 'cursor-agent')}
            className="settings-select"
          >
            <option value="claude">Claude Code (claude)</option>
            <option value="cursor-agent">Cursor Agent (agent)</option>
          </select>
        </div>
        <div className="settings-row">
          <span className="settings-row-label">Sync /rename and /color to Claude Code</span>
          <button
            className={`settings-toggle ${syncClaudeSlashCommands ? 'active' : ''}`}
            onClick={() => setSyncClaudeSlashCommands(!syncClaudeSlashCommands)}
            role="switch"
            aria-checked={syncClaudeSlashCommands}
            title={syncClaudeSlashCommands ? 'Colony will inject slash commands into Claude sessions' : 'Colony will not send /rename or /color into the PTY'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        <p className="settings-help settings-help-bottom">
          When on, Colony sends Claude Code TUI commands so the in-terminal session name and color match the sidebar.
          Turn off if those lines in the transcript bother you. Sidebar names still update; Cursor Agent sessions never receive these.
        </p>
        <div className="settings-field">
          <label>Shell</label>
          <p className="settings-help">
            Environment for terminal sessions.
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
          <label>Git Protocol</label>
          <p className="settings-help">
            Protocol for cloning GitHub repos (environments, bare repos, colony feedback).
          </p>
          <select
            value={gitProtocol}
            onChange={(e) => setGitProtocol(e.target.value as 'ssh' | 'https')}
            className="settings-select"
          >
            <option value="ssh">SSH (git@github.com:owner/repo.git)</option>
            <option value="https">HTTPS (https://github.com/owner/repo.git)</option>
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
        {daemonVersion && (
          <div className="settings-daemon-version">
            <span>Running: v{daemonVersion.running}</span>
            <span>Expected: v{daemonVersion.expected}</span>
            {daemonVersion.running !== daemonVersion.expected && (
              <span className="settings-daemon-stale">outdated</span>
            )}
          </div>
        )}
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
                    window.api.daemon.getVersion().then(setDaemonVersion).catch(() => {})
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
