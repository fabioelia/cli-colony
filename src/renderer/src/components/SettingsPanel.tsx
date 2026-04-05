import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, Terminal, ScrollText, AlertTriangle, RotateCcw, Bell, Cpu, Settings, Network, Plus, Trash2, Pencil, ChevronDown, ChevronRight } from 'lucide-react'
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
  const [detectedProtocol, setDetectedProtocol] = useState<'ssh' | 'https' | null>(null)
  const [notificationsEnabled, setNotificationsEnabled] = useState(true)
  const [soundOnFinish, setSoundOnFinish] = useState(true)
  const [autoCleanupMinutes, setAutoCleanupMinutes] = useState('5')
  const [globalHotkey, setGlobalHotkey] = useState('CommandOrControl+Shift+Space')
  const [availableShells, setAvailableShells] = useState<string[]>([])
  const [saved, setSaved] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [showRestartConfirm, setShowRestartConfirm] = useState(false)
  const [logs, setLogs] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const [showSchedulerLogs, setShowSchedulerLogs] = useState(false)
  const [schedulerLogs, setSchedulerLogs] = useState<string[]>([])
  const [daemonVersion, setDaemonVersion] = useState<{ running: number; expected: number } | null>(null)
  const logsRef = useRef<HTMLPreElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const schedulerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  type McpServer = { name: string; command?: string; args?: string[]; url?: string; description?: string }
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [showMcpSection, setShowMcpSection] = useState(false)
  const [mcpForm, setMcpForm] = useState<McpServer | null>(null)
  const [mcpFormType, setMcpFormType] = useState<'command' | 'sse'>('command')
  const [mcpFormError, setMcpFormError] = useState<string | null>(null)
  const [mcpOriginalName, setMcpOriginalName] = useState<string | null>(null)

  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      setDefaultArgs(s.defaultArgs || '')
      setDefaultCliBackend(s.defaultCliBackend === 'cursor-agent' ? 'cursor-agent' : 'claude')
      setSyncClaudeSlashCommands(s.syncClaudeSlashCommands !== 'false')
      setShellProfile(s.shellProfile || '')
      setGitProtocol((s.gitProtocol === 'https' ? 'https' : 'ssh') as 'ssh' | 'https')
      setNotificationsEnabled(s.notificationsEnabled !== 'false')
      setSoundOnFinish(s.soundOnFinish !== 'false')
      setAutoCleanupMinutes(s.autoCleanupMinutes || '5')
      setGlobalHotkey(s.globalHotkey || 'CommandOrControl+Shift+Space')
    })
    window.api.settings.getShells().then(setAvailableShells)
    window.api.daemon.getVersion().then(setDaemonVersion).catch(() => {})
    window.api.settings.detectGitProtocol().then(setDetectedProtocol).catch(() => {})
    window.api.mcp.list().then(setMcpServers).catch(() => {})
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

  useEffect(() => {
    if (!showSchedulerLogs) {
      if (schedulerIntervalRef.current) clearInterval(schedulerIntervalRef.current)
      return
    }
    const refresh = () => window.api.logs.getScheduler().then(setSchedulerLogs)
    refresh()
    schedulerIntervalRef.current = setInterval(refresh, 5000)
    return () => {
      if (schedulerIntervalRef.current) clearInterval(schedulerIntervalRef.current)
    }
  }, [showSchedulerLogs])

  const handleSave = async () => {
    await Promise.all([
      window.api.settings.set('defaultArgs', defaultArgs),
      window.api.settings.set('defaultCliBackend', defaultCliBackend),
      window.api.settings.set('syncClaudeSlashCommands', syncClaudeSlashCommands ? 'true' : 'false'),
      window.api.settings.set('shellProfile', shellProfile),
      window.api.settings.set('gitProtocol', gitProtocol),
      window.api.settings.set('notificationsEnabled', notificationsEnabled ? 'true' : 'false'),
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
            {detectedProtocol && detectedProtocol !== gitProtocol && (
              <span className="settings-restart-note" style={{ color: '#f59e0b' }}>
                Detected: {detectedProtocol} works on this machine
              </span>
            )}
            {detectedProtocol && detectedProtocol === gitProtocol && (
              <span className="settings-restart-note" style={{ color: '#10b981' }}>
                Verified: {detectedProtocol} works
              </span>
            )}
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
          <Bell size={12} />
          Notifications
        </div>
        <div className="settings-row">
          <span className="settings-row-label">Desktop notifications</span>
          <button
            className={`settings-toggle ${notificationsEnabled ? 'active' : ''}`}
            onClick={() => setNotificationsEnabled(!notificationsEnabled)}
            role="switch"
            aria-checked={notificationsEnabled}
            title={notificationsEnabled ? 'Disable notifications' : 'Enable notifications'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        <p className="settings-help">Show system notifications for pipeline fires, approval gates, and persona run events.</p>
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

      {/* MCP Server Catalog */}
      <div className={`settings-section settings-logs-section ${showMcpSection ? '' : 'collapsed'}`}>
        <div className="settings-section-title">
          <Network size={12} />
          MCP Server Catalog
          <div className="settings-logs-actions">
            <button
              className="settings-logs-toggle"
              onClick={() => setShowMcpSection(!showMcpSection)}
              title={showMcpSection ? 'Hide' : 'Show'}
            >
              {showMcpSection ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
        </div>
        {showMcpSection && (
          <div className="mcp-catalog">
            <p className="settings-help">
              Named MCP servers available for sessions and pipeline stages. Reference them by name using <code>mcpServers: ["name"]</code> in pipeline YAML or when creating a session.
            </p>
            {mcpServers.length > 0 && (
              <div className="mcp-catalog-list">
                {mcpServers.map((s) => (
                  <div key={s.name} className="mcp-catalog-item">
                    <div className="mcp-catalog-item-name">{s.name}</div>
                    <div className="mcp-catalog-item-detail">
                      {s.url ? `SSE: ${s.url}` : `${s.command ?? ''} ${(s.args ?? []).join(' ')}`.trim()}
                    </div>
                    {s.description && <div className="mcp-catalog-item-desc">{s.description}</div>}
                    <div className="mcp-catalog-item-actions">
                      <button
                        className="mcp-catalog-edit"
                        title="Edit"
                        onClick={() => {
                          setMcpFormType(s.url ? 'sse' : 'command')
                          setMcpForm({ ...s })
                          setMcpOriginalName(s.name)
                          setMcpFormError(null)
                        }}
                      >
                        <Pencil size={11} /> Edit
                      </button>
                      <button
                        className="mcp-catalog-delete"
                        title="Delete"
                        onClick={async () => {
                          if (!confirm(`Delete MCP server "${s.name}"?`)) return
                          const updated = await window.api.mcp.delete(s.name)
                          setMcpServers(updated)
                        }}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {mcpForm !== null ? (
              <div className="mcp-catalog-form">
                <div className="mcp-form-header">
                  {mcpOriginalName !== null ? `Edit: ${mcpOriginalName}` : 'Add Server'}
                </div>
                <div className="mcp-form-row">
                  <label>Name</label>
                  <input
                    value={mcpForm.name}
                    onChange={(e) => { setMcpForm({ ...mcpForm, name: e.target.value }); setMcpFormError(null) }}
                    placeholder="e.g. filesystem"
                  />
                  {mcpFormError && <span className="mcp-form-error">{mcpFormError}</span>}
                </div>
                <div className="mcp-form-row">
                  <label>Type</label>
                  <select
                    value={mcpFormType}
                    onChange={(e) => setMcpFormType(e.target.value as 'command' | 'sse')}
                  >
                    <option value="command">Command (stdio)</option>
                    <option value="sse">SSE (URL)</option>
                  </select>
                </div>
                {mcpFormType === 'command' ? (
                  <>
                    <div className="mcp-form-row">
                      <label>Command</label>
                      <input
                        value={mcpForm.command ?? ''}
                        onChange={(e) => setMcpForm({ ...mcpForm, command: e.target.value, url: undefined })}
                        placeholder="e.g. npx"
                      />
                    </div>
                    <div className="mcp-form-row">
                      <label>Args</label>
                      <input
                        value={(mcpForm.args ?? []).join(' ')}
                        onChange={(e) => setMcpForm({ ...mcpForm, args: e.target.value.split(' ').filter(Boolean) })}
                        placeholder="e.g. -y @modelcontextprotocol/server-filesystem /path"
                      />
                    </div>
                  </>
                ) : (
                  <div className="mcp-form-row">
                    <label>URL</label>
                    <input
                      value={mcpForm.url ?? ''}
                      onChange={(e) => setMcpForm({ ...mcpForm, url: e.target.value, command: undefined, args: undefined })}
                      placeholder="e.g. http://localhost:3000/sse"
                    />
                  </div>
                )}
                <div className="mcp-form-row">
                  <label>Description</label>
                  <input
                    value={mcpForm.description ?? ''}
                    onChange={(e) => setMcpForm({ ...mcpForm, description: e.target.value || undefined })}
                    placeholder="Optional"
                  />
                </div>
                <div className="mcp-form-actions">
                  <button
                    className="settings-logs-toggle"
                    onClick={() => { setMcpForm(null); setMcpFormError(null); setMcpOriginalName(null) }}
                  >
                    Cancel
                  </button>
                  <button
                    className="panel-header-btn primary"
                    onClick={async () => {
                      if (!mcpForm.name.trim()) { setMcpFormError('Name is required'); return }
                      const updated = await window.api.mcp.save(mcpForm)
                      setMcpServers(updated)
                      setMcpForm(null)
                      setMcpFormError(null)
                      setMcpOriginalName(null)
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            ) : (
              <button
                className="mcp-catalog-add"
                onClick={() => {
                  setMcpFormType('command')
                  setMcpForm({ name: '', command: '', args: [] })
                  setMcpOriginalName(null)
                  setMcpFormError(null)
                }}
                title="Add MCP server"
              >
                <Plus size={12} /> Add Server
              </button>
            )}
          </div>
        )}
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

      {/* Scheduler Log */}
      <div className={`settings-section settings-logs-section ${showSchedulerLogs ? '' : 'collapsed'}`}>
        <div className="settings-section-title">
          <ScrollText size={12} />
          Scheduler Log
          <div className="settings-logs-actions">
            <button
              className="settings-logs-toggle"
              onClick={() => setShowSchedulerLogs(!showSchedulerLogs)}
              title={showSchedulerLogs ? 'Hide scheduler log' : 'Show scheduler log'}
            >
              {showSchedulerLogs ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {showSchedulerLogs && (
          <pre className="settings-logs">
            {schedulerLogs.length > 0 ? schedulerLogs.join('\n') : 'No scheduler log entries yet.'}
          </pre>
        )}
      </div>

      <div className="settings-footer">
        <span className="settings-config-path">~/.claude-colony/settings.json</span>
      </div>
    </div>
  )
}
