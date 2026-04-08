import { useState, useEffect, useRef } from 'react'
import { ArrowLeft, Terminal, ScrollText, AlertTriangle, RotateCcw, Bell, Cpu, Settings, Network, Plus, Trash2, Pencil, ChevronDown, ChevronRight, Clock, ClipboardList, GitCommit, Globe, BookTemplate, Copy, X, TrendingUp, Download, Search, Shield } from 'lucide-react'
import HelpPopover from './HelpPopover'
import BatchExecutionSettings from './BatchExecutionSettings'
import AppUpdateSettings from './AppUpdateSettings'
import { parseShellArgs } from '../../../shared/utils'
import type { McpAuditEntry, CommitAttribution, CostQuotas, CostAuditEntry, CostAuditStatus, ApprovalRule, ApprovalRuleType, ApprovalRuleAction } from '../../../preload'
import type { SessionTemplate } from '../../../shared/types'

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
  const [restartError, setRestartError] = useState(false)
  const [showRestartConfirm, setShowRestartConfirm] = useState(false)
  const [logs, setLogs] = useState('')
  const [showLogs, setShowLogs] = useState(false)
  const [showSchedulerLogs, setShowSchedulerLogs] = useState(false)
  const [schedulerLogs, setSchedulerLogs] = useState<string[]>([])
  const [daemonVersion, setDaemonVersion] = useState<{ running: number; expected: number } | null>(null)
  const logsRef = useRef<HTMLPreElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const schedulerIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  type McpServer = { name: string; command?: string; args?: string[]; url?: string; description?: string; env?: Record<string, string> }
  const [mcpServers, setMcpServers] = useState<McpServer[]>([])
  const [showMcpSection, setShowMcpSection] = useState(false)

  const [auditLog, setAuditLog] = useState<McpAuditEntry[]>([])
  const [showAuditSection, setShowAuditSection] = useState(false)
  const [commitAttributions, setCommitAttributions] = useState<CommitAttribution[]>([])
  const [showCommitSection, setShowCommitSection] = useState(false)
  const [mcpForm, setMcpForm] = useState<McpServer | null>(null)
  const [mcpFormType, setMcpFormType] = useState<'command' | 'sse'>('command')
  const [mcpFormArgsString, setMcpFormArgsString] = useState('')
  const [mcpFormEnvVars, setMcpFormEnvVars] = useState<Array<{ key: string; value: string }>>([])
  const [mcpFormError, setMcpFormError] = useState<string | null>(null)
  const [mcpOriginalName, setMcpOriginalName] = useState<string | null>(null)

  const [keepInTray, setKeepInTray] = useState(true)
  const [webhookEnabled, setWebhookEnabled] = useState(true)
  const [webhookPort, setWebhookPort] = useState('7474')

  const [sessionTemplates, setSessionTemplates] = useState<SessionTemplate[]>([])
  const [showTemplatesSection, setShowTemplatesSection] = useState(false)

  const [costQuotas, setCostQuotas] = useState<CostQuotas | null>(null)
  const [governanceAuditLog, setGovernanceAuditLog] = useState<CostAuditEntry[]>([])
  const [showGovernanceSection, setShowGovernanceSection] = useState(false)
  const [governanceSearchTerm, setGovernanceSearchTerm] = useState('')
  const [governanceFilterTeam, setGovernanceFilterTeam] = useState<string>('')
  const [governanceFilterProject, setGovernanceFilterProject] = useState<string>('')
  const [governanceFilterStatus, setGovernanceFilterStatus] = useState<CostAuditStatus | ''>('')

  const [approvalRules, setApprovalRules] = useState<ApprovalRule[]>([])
  const [showApprovalRulesSection, setShowApprovalRulesSection] = useState(false)
  const [approvalRuleForm, setApprovalRuleForm] = useState<Partial<ApprovalRule> | null>(null)

  const [showBatchSection, setShowBatchSection] = useState(false)
  const [showUpdateSection, setShowUpdateSection] = useState(false)
  const [approvalRuleFormError, setApprovalRuleFormError] = useState<string | null>(null)
  const [approvalRuleFormName, setApprovalRuleFormName] = useState('')
  const [approvalRuleFormType, setApprovalRuleFormType] = useState<ApprovalRuleType>('file_pattern')
  const [approvalRuleFormCondition, setApprovalRuleFormCondition] = useState('')
  const [approvalRuleFormAction, setApprovalRuleFormAction] = useState<ApprovalRuleAction>('auto_approve')

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
      setKeepInTray(s.keepInTray !== 'false')
      setWebhookEnabled(s.webhookEnabled !== 'false')
      setWebhookPort(s.webhookPort || '7474')
    })
    window.api.settings.getShells().then(setAvailableShells)
    window.api.daemon.getVersion().then(setDaemonVersion).catch(() => {})
    window.api.settings.detectGitProtocol().then(setDetectedProtocol).catch(() => {})
    window.api.mcp.list().then(setMcpServers).catch(() => {})
    window.api.mcp.getAuditLog().then(setAuditLog).catch(() => {})
    window.api.session.getAttributedCommits().then(setCommitAttributions).catch(() => {})
    window.api.sessionTemplates.list().then(setSessionTemplates).catch(() => {})
    window.api.governance.getQuotas().then(setCostQuotas).catch(() => {})
    window.api.governance.auditLog().then(setGovernanceAuditLog).catch(() => {})
    window.api.approvalRules.list().then(setApprovalRules).catch(() => {})
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

  function formatRelTime(ts: number): string {
    const diffMs = Date.now() - ts
    const diffSec = Math.floor(diffMs / 1000)
    if (diffSec < 60) return `${diffSec}s ago`
    const diffMin = Math.floor(diffSec / 60)
    if (diffMin < 60) return `${diffMin}m ago`
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) return `${diffHr}h ago`
    const diffDay = Math.floor(diffHr / 24)
    return `${diffDay}d ago`
  }

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
      window.api.settings.set('keepInTray', keepInTray ? 'true' : 'false'),
      window.api.settings.set('webhookEnabled', webhookEnabled ? 'true' : 'false'),
      window.api.settings.set('webhookPort', webhookPort),
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

      {/* General */}
      <div className="settings-section">
        <div className="settings-section-title">
          <Settings size={12} />
          General
        </div>
        <div className="settings-row">
          <span className="settings-row-label">Keep running in tray when closed</span>
          <button
            className={`settings-toggle ${keepInTray ? 'active' : ''}`}
            onClick={() => setKeepInTray(!keepInTray)}
            role="switch"
            aria-checked={keepInTray}
            title={keepInTray ? 'Window close hides to tray' : 'Window close quits the app'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        <p className="settings-help settings-help-bottom">Colony continues running pipelines and persona schedules when the window is closed. Access via the menu bar icon.</p>
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
          <Clock size={12} />
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
                          setMcpFormArgsString((s.args ?? []).join(' '))
                          setMcpFormEnvVars(Object.entries(s.env ?? {}).map(([key, value]) => ({ key, value })))
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
                        value={mcpFormArgsString}
                        onChange={(e) => setMcpFormArgsString(e.target.value)}
                        placeholder='e.g. -y @mcp/fs "/path/with spaces" $HOME'
                      />
                    </div>
                    <div className="mcp-form-row">
                      <label>Environment Variables (Optional)</label>
                      <div className="mcp-env-vars">
                        {mcpFormEnvVars.map((envVar, idx) => (
                          <div key={idx} className="mcp-env-var-row">
                            <input
                              type="text"
                              value={envVar.key}
                              onChange={(e) => {
                                const updated = [...mcpFormEnvVars]
                                updated[idx].key = e.target.value
                                setMcpFormEnvVars(updated)
                              }}
                              placeholder="KEY"
                              className="mcp-env-key"
                            />
                            <span className="mcp-env-sep">=</span>
                            <input
                              type="text"
                              value={envVar.value}
                              onChange={(e) => {
                                const updated = [...mcpFormEnvVars]
                                updated[idx].value = e.target.value
                                setMcpFormEnvVars(updated)
                              }}
                              placeholder="value"
                              className="mcp-env-value"
                            />
                            <button
                              className="mcp-env-remove"
                              onClick={() => setMcpFormEnvVars(mcpFormEnvVars.filter((_, i) => i !== idx))}
                              title="Remove"
                            >
                              <X size={16} />
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        className="mcp-env-add"
                        onClick={() => setMcpFormEnvVars([...mcpFormEnvVars, { key: '', value: '' }])}
                        title="Add environment variable"
                      >
                        <Plus size={14} /> Add Variable
                      </button>
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
                    onClick={() => { setMcpForm(null); setMcpFormArgsString(''); setMcpFormEnvVars([]); setMcpFormError(null); setMcpOriginalName(null) }}
                  >
                    Cancel
                  </button>
                  <button
                    className="panel-header-btn primary"
                    onClick={async () => {
                      if (!mcpForm.name.trim()) { setMcpFormError('Name is required'); return }
                      // Parse args string if in command mode
                      let formToSave = mcpFormType === 'command' && mcpFormArgsString
                        ? { ...mcpForm, args: parseShellArgs(mcpFormArgsString) }
                        : mcpForm
                      // Add env vars if any (filter out empty ones)
                      const envVars = mcpFormEnvVars.filter(e => e.key.trim()).reduce((acc, e) => ({ ...acc, [e.key]: e.value }), {})
                      if (Object.keys(envVars).length > 0) {
                        formToSave = { ...formToSave, env: envVars }
                      }
                      const updated = await window.api.mcp.save(formToSave)
                      setMcpServers(updated)
                      setMcpForm(null)
                      setMcpFormArgsString('')
                      setMcpFormEnvVars([])
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
                  setMcpFormArgsString('')
                  setMcpFormEnvVars([])
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

      {/* MCP Audit Log */}
      <div className={`settings-section settings-logs-section ${showAuditSection ? '' : 'collapsed'}`}>
        <div className="settings-section-title">
          <ClipboardList size={12} />
          MCP Audit
          <div className="settings-logs-actions">
            <button
              className="settings-logs-toggle"
              onClick={() => {
                if (!showAuditSection) {
                  window.api.mcp.getAuditLog().then(setAuditLog).catch(() => {})
                }
                setShowAuditSection(!showAuditSection)
              }}
              title={showAuditSection ? 'Hide' : 'Show'}
            >
              {showAuditSection ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {showAuditSection && auditLog.length > 0 && (
              <button
                className="settings-logs-toggle"
                onClick={async () => {
                  if (!confirm('Clear all MCP audit log entries?')) return
                  await window.api.mcp.clearAuditLog()
                  setAuditLog([])
                }}
                title="Clear audit log"
              >
                Clear
              </button>
            )}
          </div>
        </div>
        {showAuditSection && (
          <div className="mcp-audit-log">
            {auditLog.length === 0 ? (
              <p className="settings-help">No MCP calls recorded yet.</p>
            ) : (
              <table className="mcp-audit-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Session</th>
                    <th>Server</th>
                    <th>Tool</th>
                    <th>Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {auditLog.map((entry, i) => {
                    const date = new Date(entry.ts)
                    const relTime = formatRelTime(entry.ts)
                    return (
                      <tr key={i} title={date.toLocaleString()}>
                        <td className="mcp-audit-ts">{relTime}</td>
                        <td className="mcp-audit-session">{entry.sessionName}</td>
                        <td className="mcp-audit-server">{entry.serverName}</td>
                        <td className="mcp-audit-tool">{entry.toolName}</td>
                        <td>
                          <span className={`mcp-audit-outcome mcp-audit-outcome--${entry.outcome}`}>
                            {entry.outcome}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Commit Attribution */}
      <div className={`settings-section settings-logs-section ${showCommitSection ? '' : 'collapsed'}`}>
        <div className="settings-section-title">
          <GitCommit size={12} />
          Commit Attribution
          <div className="settings-logs-actions">
            <button
              className="settings-logs-toggle"
              onClick={() => {
                if (!showCommitSection) {
                  window.api.session.getAttributedCommits().then(setCommitAttributions).catch(() => {})
                }
                setShowCommitSection(!showCommitSection)
              }}
              title={showCommitSection ? 'Hide' : 'Show'}
            >
              {showCommitSection ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
            {showCommitSection && commitAttributions.length > 0 && (
              <button
                className="settings-logs-toggle"
                onClick={async () => {
                  if (!confirm('Clear all commit attribution records?')) return
                  await window.api.session.clearCommitAttributions()
                  setCommitAttributions([])
                }}
                title="Clear"
              >
                <Trash2 size={12} />
              </button>
            )}
          </div>
        </div>
        {showCommitSection && (
          <div className="mcp-audit-log">
            {commitAttributions.length === 0 ? (
              <p className="settings-help">No attributed commits yet. Colony links commits to sessions when sessions exit.</p>
            ) : (
              <table className="mcp-audit-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Message</th>
                    <th>Session</th>
                    <th>Cost</th>
                    <th>Hash</th>
                  </tr>
                </thead>
                <tbody>
                  {commitAttributions.map((entry, i) => {
                    const date = new Date(entry.stoppedAt)
                    const relTime = formatRelTime(entry.stoppedAt)
                    const shortHash = entry.commitHash.slice(0, 7)
                    return (
                      <tr key={i} title={date.toLocaleString()}>
                        <td className="mcp-audit-ts">{relTime}</td>
                        <td className="mcp-audit-tool" title={entry.shortMsg}>{entry.shortMsg.slice(0, 60)}{entry.shortMsg.length > 60 ? '…' : ''}</td>
                        <td className="mcp-audit-session">{entry.sessionName}</td>
                        <td><code>{shortHash}</code></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>

      {/* Webhook Server */}
      <div className="settings-section">
        <div className="settings-section-title">
          <Globe size={12} />
          Webhook Server
        </div>
        <div className="settings-row">
          <span className="settings-row-label">Enable webhook server</span>
          <button
            className={`settings-toggle ${webhookEnabled ? 'active' : ''}`}
            onClick={() => setWebhookEnabled(!webhookEnabled)}
            role="switch"
            aria-checked={webhookEnabled}
            title={webhookEnabled ? 'Webhook server is enabled' : 'Webhook server is disabled'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {webhookEnabled && (
          <>
            <div className="settings-field">
              <label>Port</label>
              <input
                type="number"
                value={webhookPort}
                onChange={(e) => setWebhookPort(e.target.value)}
                placeholder="7474"
                min="1024"
                max="65535"
                style={{ width: '100px' }}
              />
            </div>
            <p className="settings-help">
              Listening at <code>http://127.0.0.1:{webhookPort}</code>
            </p>
            <div className="settings-row">
              <span className="settings-row-label">API URL</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <code style={{ fontSize: '11px' }}>http://127.0.0.1:{webhookPort}/api/</code>
                <button
                  className="panel-header-btn"
                  title="Copy API URL"
                  onClick={() => navigator.clipboard.writeText(`http://127.0.0.1:${webhookPort}/api/`)}
                >
                  <Copy size={12} />
                </button>
              </div>
            </div>
          </>
        )}
        <p className="settings-help settings-help-bottom">
          External webhooks need ngrok or similar to reach this server. Add <code>trigger: &#123;type: webhook&#125;</code> to a pipeline YAML to register a route at <code>/webhook/&lt;slug&gt;</code>.
          <span className="settings-restart-note">Requires app restart to take effect</span>
        </p>
      </div>

      {/* Session Templates */}
      <div className={`settings-section settings-logs-section ${showTemplatesSection ? '' : 'collapsed'}`}>
        <div className="settings-section-title">
          <BookTemplate size={12} />
          Session Templates
          <div className="settings-logs-actions">
            <button
              className="settings-logs-toggle"
              onClick={() => {
                if (!showTemplatesSection) {
                  window.api.sessionTemplates.list().then(setSessionTemplates).catch(() => {})
                }
                setShowTemplatesSection(!showTemplatesSection)
              }}
              title={showTemplatesSection ? 'Hide' : 'Show'}
            >
              {showTemplatesSection ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
        </div>
        {showTemplatesSection && (
          <div className="session-templates-list">
            {sessionTemplates.length === 0 ? (
              <p className="settings-help">No templates yet. Right-click a session and choose "Save as Template" to create one.</p>
            ) : (
              sessionTemplates.map((t) => (
                <div key={t.id} className="session-template-item">
                  <div className="session-template-item-main">
                    <div className="session-template-item-name">{t.name}</div>
                    {t.description && <div className="session-template-item-desc">{t.description}</div>}
                    <div className="session-template-item-meta">
                      {t.model && <span className="template-popover-model">{t.model}</span>}
                      {t.role && <span className={`instance-role-badge role-${t.role.toLowerCase()}`}>{t.role}</span>}
                      {t.workingDir && <span className="session-template-item-dir">{t.workingDir}</span>}
                      {t.lastUsed != null && (
                        <span title={new Date(t.lastUsed).toLocaleString()}>
                          last used {formatRelTime(t.lastUsed)}
                        </span>
                      )}
                      {t.launchCount != null && t.launchCount > 0 && (
                        <span>{t.launchCount} launch{t.launchCount !== 1 ? 'es' : ''}</span>
                      )}
                    </div>
                  </div>
                  <button
                    className="mcp-catalog-delete"
                    title="Delete template"
                    onClick={async () => {
                      if (!confirm(`Delete template "${t.name}"?`)) return
                      await window.api.sessionTemplates.delete(t.id)
                      setSessionTemplates((prev) => prev.filter((x) => x.id !== t.id))
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))
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
        {restartError && (
          <p className="settings-help" style={{ color: 'var(--danger)' }}>Restart failed — check logs for details.</p>
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
                  } catch (_err) {
                    setRestartError(true)
                    setTimeout(() => setRestartError(false), 4000)
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

      {/* Cost Governance */}
      {(() => {
        const teamQuotas = costQuotas?.quotas.filter((q) => !q.projectId || q.projectId === 'ungoverned') ?? []
        const projectQuotas = costQuotas?.quotas.filter((q) => q.projectId && q.projectId !== 'ungoverned') ?? []

        const getTeamSpend = (teamId: string): number => {
          return governanceAuditLog
            .filter((e) => e.teamId === teamId && (new Date().getTime() - new Date(e.timestamp).getTime()) < 30 * 24 * 60 * 60 * 1000)
            .reduce((sum, e) => sum + e.costUsd, 0)
        }

        const getProjectSpend = (teamId: string, projectId: string): number => {
          return governanceAuditLog
            .filter((e) => e.teamId === teamId && e.projectId === projectId && (new Date().getTime() - new Date(e.timestamp).getTime()) < 30 * 24 * 60 * 60 * 1000)
            .reduce((sum, e) => sum + e.costUsd, 0)
        }

        const getStatusColor = (spent: number, limit: number, warned: number): 'ok' | 'warned' | 'blocked' => {
          if (spent >= limit) return 'blocked'
          if (spent >= warned) return 'warned'
          return 'ok'
        }

        const filteredAuditLog = governanceAuditLog.filter((e) => {
          if (governanceSearchTerm && !JSON.stringify(e).toLowerCase().includes(governanceSearchTerm.toLowerCase())) return false
          if (governanceFilterTeam && e.teamId !== governanceFilterTeam) return false
          if (governanceFilterProject && e.projectId !== governanceFilterProject) return false
          if (governanceFilterStatus && e.status !== governanceFilterStatus) return false
          return true
        })

        const handleExportCsv = async () => {
          const csv = await window.api.governance.exportCsv()
          const blob = new Blob([csv], { type: 'text/csv' })
          const url = URL.createObjectURL(blob)
          const a = document.createElement('a')
          a.href = url
          a.download = `governance-audit-${new Date().toISOString().split('T')[0]}.csv`
          a.click()
          URL.revokeObjectURL(url)
        }

        return (
          <div className={`settings-section settings-logs-section ${showGovernanceSection ? '' : 'collapsed'}`}>
            <div className="settings-section-title">
              <TrendingUp size={12} />
              Cost Governance
              <div className="settings-logs-actions">
                <button
                  className="governance-export-btn"
                  onClick={handleExportCsv}
                  title="Export audit log as CSV"
                >
                  <Download size={12} />
                </button>
                <button
                  className="settings-logs-toggle"
                  onClick={() => setShowGovernanceSection(!showGovernanceSection)}
                  title={showGovernanceSection ? 'Hide' : 'Show'}
                >
                  {showGovernanceSection ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              </div>
            </div>
            {showGovernanceSection && (
              <div className="governance-content">
                {/* Team Quotas Table */}
                <div className="governance-subsection">
                  <h3 className="governance-subsection-title">Team Quotas (30-day window)</h3>
                  <div className="governance-table-container">
                    {teamQuotas.length > 0 ? (
                      <table className="governance-table">
                        <thead>
                          <tr>
                            <th>Team</th>
                            <th>Limit (USD)</th>
                            <th>30-Day Spend</th>
                            <th>% Used</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {teamQuotas.map((q) => {
                            const spent = getTeamSpend(q.teamId)
                            const limit = q.hardLimitUsd
                            const percentage = ((spent / limit) * 100).toFixed(1)
                            const status = getStatusColor(spent, limit, q.warnThresholdUsd)
                            return (
                              <tr key={q.teamId}>
                                <td className="team-name">{q.teamId}</td>
                                <td className="number">${limit.toFixed(2)}</td>
                                <td className="number">${spent.toFixed(2)}</td>
                                <td className="number">{percentage}%</td>
                                <td>
                                  <span className={`governance-badge ${status}`}>
                                    {status === 'ok' ? '✓ OK' : status === 'warned' ? '⚠ Warned' : '🚫 Blocked'}
                                  </span>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <p className="governance-empty">No team quotas defined. Create quotas to track and limit spending per team.</p>
                    )}
                  </div>
                </div>

                {/* Project Quotas Table */}
                <div className="governance-subsection">
                  <h3 className="governance-subsection-title">Project Quotas (30-day window)</h3>
                  <div className="governance-table-container">
                    {projectQuotas.length > 0 ? (
                      <table className="governance-table">
                        <thead>
                          <tr>
                            <th>Team</th>
                            <th>Project</th>
                            <th>Limit (USD)</th>
                            <th>30-Day Spend</th>
                            <th>% Used</th>
                            <th>Status</th>
                          </tr>
                        </thead>
                        <tbody>
                          {projectQuotas.map((q) => {
                            const spent = getProjectSpend(q.teamId, q.projectId!)
                            const limit = q.hardLimitUsd
                            const percentage = ((spent / limit) * 100).toFixed(1)
                            const status = getStatusColor(spent, limit, q.warnThresholdUsd)
                            return (
                              <tr key={`${q.teamId}-${q.projectId}`}>
                                <td className="team-name">{q.teamId}</td>
                                <td className="project-name">{q.projectId}</td>
                                <td className="number">${limit.toFixed(2)}</td>
                                <td className="number">${spent.toFixed(2)}</td>
                                <td className="number">{percentage}%</td>
                                <td>
                                  <span className={`governance-badge ${status}`}>
                                    {status === 'ok' ? '✓ OK' : status === 'warned' ? '⚠ Warned' : '🚫 Blocked'}
                                  </span>
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    ) : (
                      <p className="governance-empty">No project quotas defined. Create quotas to track and limit spending per project.</p>
                    )}
                  </div>
                </div>

                {/* Audit Log */}
                <div className="governance-subsection">
                  <h3 className="governance-subsection-title">Audit Log</h3>
                  <div className="governance-filters">
                    <div className="governance-filter-row">
                      <div className="governance-filter-group">
                        <Search size={12} />
                        <input
                          placeholder="Search audit log..."
                          value={governanceSearchTerm}
                          onChange={(e) => setGovernanceSearchTerm(e.target.value)}
                          className="governance-search"
                        />
                        {governanceSearchTerm && (
                          <button className="governance-clear" onClick={() => setGovernanceSearchTerm('')}>
                            <X size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="governance-filter-row">
                      <select
                        value={governanceFilterTeam}
                        onChange={(e) => setGovernanceFilterTeam(e.target.value)}
                        className="governance-filter-select"
                      >
                        <option value="">All Teams</option>
                        {[...new Set(governanceAuditLog.map((e) => e.teamId))].map((team) => (
                          <option key={team} value={team}>{team}</option>
                        ))}
                      </select>
                      <select
                        value={governanceFilterProject}
                        onChange={(e) => setGovernanceFilterProject(e.target.value)}
                        className="governance-filter-select"
                      >
                        <option value="">All Projects</option>
                        {[...new Set(governanceAuditLog.filter((e) => !governanceFilterTeam || e.teamId === governanceFilterTeam).map((e) => e.projectId))].map((proj) => (
                          <option key={proj} value={proj}>{proj}</option>
                        ))}
                      </select>
                      <select
                        value={governanceFilterStatus}
                        onChange={(e) => setGovernanceFilterStatus(e.target.value as CostAuditStatus | '')}
                        className="governance-filter-select"
                      >
                        <option value="">All Statuses</option>
                        <option value="OK">OK</option>
                        <option value="WARNED">Warned</option>
                        <option value="THROTTLED">Throttled</option>
                        <option value="BLOCKED">Blocked</option>
                      </select>
                    </div>
                  </div>
                  {filteredAuditLog.length > 0 ? (
                    <div className="governance-audit-list">
                      {filteredAuditLog.slice().reverse().map((entry, idx) => (
                        <div key={`${entry.timestamp}-${entry.teamId}-${entry.projectId}-${idx}`} className={`governance-audit-entry status-${entry.status.toLowerCase()}`}>
                          <div className="governance-audit-header">
                            <span className="governance-audit-time">
                              {new Date(entry.timestamp).toLocaleString()}
                            </span>
                            <span className={`governance-badge ${entry.status === 'OK' ? 'ok' : entry.status === 'WARNED' ? 'warned' : entry.status === 'THROTTLED' ? 'warned' : 'blocked'}`}>
                              {entry.status}
                            </span>
                          </div>
                          <div className="governance-audit-detail">
                            <span>{entry.teamId} / {entry.projectId}</span>
                            {entry.agentId && <span className="detail-muted">Agent: {entry.agentId}</span>}
                            {entry.sessionId && <span className="detail-muted">Session: {entry.sessionId}</span>}
                            <span className="detail-cost">${entry.costUsd.toFixed(4)}</span>
                          </div>
                          {entry.reason && (
                            <div className="governance-audit-reason">
                              {entry.reason}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="governance-empty">No audit entries match the filters.</p>
                  )}
                </div>
              </div>
            )}
          </div>
        )
      })()}

      {/* Approval Rules */}
      {(() => {
        const handleAddRule = () => {
          setApprovalRuleFormName('')
          setApprovalRuleFormType('file_pattern')
          setApprovalRuleFormCondition('')
          setApprovalRuleFormAction('auto_approve')
          setApprovalRuleFormError(null)
          setApprovalRuleForm({})
        }

        const handleSaveRule = async () => {
          if (!approvalRuleFormName.trim()) {
            setApprovalRuleFormError('Rule name is required')
            return
          }
          if (!approvalRuleFormCondition.trim()) {
            setApprovalRuleFormError('Condition is required')
            return
          }
          try {
            const created = await window.api.approvalRules.create(
              approvalRuleFormName,
              approvalRuleFormType,
              approvalRuleFormCondition,
              approvalRuleFormAction
            )
            setApprovalRules([...approvalRules, created])
            setApprovalRuleForm(null)
            setApprovalRuleFormError(null)
          } catch (error) {
            setApprovalRuleFormError(String(error))
          }
        }

        const handleToggleEnabled = async (rule: ApprovalRule) => {
          try {
            await window.api.approvalRules.update(rule.id, { enabled: !rule.enabled })
            setApprovalRules(
              approvalRules.map((r) => (r.id === rule.id ? { ...r, enabled: !r.enabled } : r))
            )
          } catch (error) {
            console.error('Failed to toggle rule:', error)
          }
        }

        const handleDeleteRule = async (id: string) => {
          if (!confirm('Delete this approval rule?')) return
          try {
            await window.api.approvalRules.delete(id)
            setApprovalRules(approvalRules.filter((r) => r.id !== id))
          } catch (error) {
            console.error('Failed to delete rule:', error)
          }
        }

        const getConditionPlaceholder = () => {
          if (approvalRuleFormType === 'file_pattern') return 'e.g. *.md,*.txt'
          if (approvalRuleFormType === 'cost_threshold') return 'e.g. < 0.10'
          return 'e.g. low|medium'
        }

        return (
          <div className={`settings-section settings-logs-section ${showApprovalRulesSection ? '' : 'collapsed'}`}>
            <div className="settings-section-title">
              <Shield size={12} />
              Approval Rules
              <div className="settings-logs-actions">
                <button
                  className="settings-logs-toggle"
                  onClick={() => setShowApprovalRulesSection(!showApprovalRulesSection)}
                  title={showApprovalRulesSection ? 'Hide' : 'Show'}
                >
                  {showApprovalRulesSection ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
              </div>
            </div>
            {showApprovalRulesSection && (
              <div className="approval-rules-list">
                {approvalRuleForm !== null ? (
                  <div className="approval-rule-form">
                    <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '12px', color: 'var(--text-muted)' }}>
                      Add New Rule
                    </div>
                    <div style={{ marginBottom: '8px' }}>
                      <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Rule Name</label>
                      <input
                        type="text"
                        value={approvalRuleFormName}
                        onChange={(e) => setApprovalRuleFormName(e.target.value)}
                        placeholder="e.g. Auto-Approve Formatting"
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          marginTop: '4px',
                          fontSize: '12px',
                          border: '1px solid var(--border-muted)',
                          borderRadius: '4px',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text)',
                        }}
                      />
                    </div>
                    <div style={{ marginBottom: '8px' }}>
                      <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Rule Type</label>
                      <select
                        value={approvalRuleFormType}
                        onChange={(e) => setApprovalRuleFormType(e.target.value as ApprovalRuleType)}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          marginTop: '4px',
                          fontSize: '12px',
                          border: '1px solid var(--border-muted)',
                          borderRadius: '4px',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text)',
                        }}
                      >
                        <option value="file_pattern">File Pattern</option>
                        <option value="cost_threshold">Cost Threshold</option>
                        <option value="risk_level">Risk Level</option>
                      </select>
                    </div>
                    <div style={{ marginBottom: '8px' }}>
                      <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Condition</label>
                      <input
                        type="text"
                        value={approvalRuleFormCondition}
                        onChange={(e) => setApprovalRuleFormCondition(e.target.value)}
                        placeholder={getConditionPlaceholder()}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          marginTop: '4px',
                          fontSize: '12px',
                          border: '1px solid var(--border-muted)',
                          borderRadius: '4px',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text)',
                        }}
                      />
                    </div>
                    <div style={{ marginBottom: '12px' }}>
                      <label style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Action</label>
                      <select
                        value={approvalRuleFormAction}
                        onChange={(e) => setApprovalRuleFormAction(e.target.value as ApprovalRuleAction)}
                        style={{
                          width: '100%',
                          padding: '6px 8px',
                          marginTop: '4px',
                          fontSize: '12px',
                          border: '1px solid var(--border-muted)',
                          borderRadius: '4px',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text)',
                        }}
                      >
                        <option value="auto_approve">Auto-Approve</option>
                        <option value="require_approval">Require Approval</option>
                        <option value="require_escalation">Require Escalation</option>
                      </select>
                    </div>
                    {approvalRuleFormError && (
                      <div style={{ color: 'var(--color-error)', fontSize: '12px', marginBottom: '8px' }}>
                        {approvalRuleFormError}
                      </div>
                    )}
                    <div className="mcp-form-actions">
                      <button
                        className="settings-logs-toggle"
                        onClick={() => {
                          setApprovalRuleForm(null)
                          setApprovalRuleFormError(null)
                        }}
                        style={{ padding: '4px 12px', fontSize: '12px' }}
                      >
                        Cancel
                      </button>
                      <button
                        className="panel-header-btn primary"
                        onClick={handleSaveRule}
                        style={{ padding: '4px 12px', fontSize: '12px' }}
                      >
                        Save Rule
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border-muted)' }}>
                          <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: '600' }}>Name</th>
                          <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: '600' }}>Type</th>
                          <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: '600' }}>Condition</th>
                          <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: '600' }}>Action</th>
                          <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: '600' }}>Enabled</th>
                          <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: '600' }}>Delete</th>
                        </tr>
                      </thead>
                      <tbody>
                        {approvalRules.map((rule) => (
                          <tr key={rule.id} style={{ borderBottom: '1px solid var(--border-muted)' }}>
                            <td style={{ padding: '6px 8px' }}>{rule.name}</td>
                            <td style={{ padding: '6px 8px' }}>
                              <span style={{ fontSize: '10px', padding: '2px 6px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '2px' }}>
                                {rule.type.replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td style={{ padding: '6px 8px', color: 'var(--text-muted)', fontSize: '10px' }}>
                              {rule.condition}
                            </td>
                            <td style={{ padding: '6px 8px' }}>
                              <span style={{ fontSize: '10px', padding: '2px 6px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '2px' }}>
                                {rule.action.replace(/_/g, ' ')}
                              </span>
                            </td>
                            <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                              <input
                                type="checkbox"
                                checked={rule.enabled}
                                onChange={() => handleToggleEnabled(rule)}
                                style={{ cursor: 'pointer' }}
                              />
                            </td>
                            <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                              <button
                                className="settings-logs-toggle"
                                onClick={() => handleDeleteRule(rule.id)}
                                style={{ padding: '2px 6px', color: 'var(--color-error, #ef4444)', opacity: 0.8 }}
                                title="Delete rule"
                              >
                                <Trash2 size={10} />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <button
                      className="mcp-catalog-add"
                      onClick={handleAddRule}
                      style={{ marginTop: approvalRules.length === 0 ? 0 : '12px' }}
                    >
                      <Plus size={12} /> Add Rule
                    </button>
                  </>
                )}
              </div>
            )}
            <HelpPopover topic="settings" align="right" />
          </div>
        )
      })()}

      {/* App Updates */}
      <AppUpdateSettings
        isExpanded={showUpdateSection}
        onToggleExpand={() => setShowUpdateSection(!showUpdateSection)}
      />

      {/* Batch Execution */}
      <BatchExecutionSettings
        isExpanded={showBatchSection}
        onToggleExpand={() => setShowBatchSection(!showBatchSection)}
      />

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
              {showSchedulerLogs ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
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

      <style>{`
        .mcp-env-vars {
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 8px;
        }
        .mcp-env-var-row {
          display: flex;
          gap: 8px;
          align-items: center;
        }
        .mcp-env-key {
          flex: 0 0 120px;
          padding: 6px;
          border: 1px solid var(--border);
          border-radius: 4px;
          font-family: monospace;
          font-size: 12px;
        }
        .mcp-env-sep {
          color: var(--text-secondary);
          font-weight: 500;
        }
        .mcp-env-value {
          flex: 1;
          padding: 6px;
          border: 1px solid var(--border);
          border-radius: 4px;
          font-family: monospace;
          font-size: 12px;
        }
        .mcp-env-remove {
          width: 28px;
          height: 28px;
          padding: 0;
          border: none;
          border-radius: 4px;
          background: var(--bg-secondary);
          color: var(--text-secondary);
          cursor: pointer;
          font-size: 14px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 200ms;
        }
        .mcp-env-remove:hover {
          background: var(--error);
          color: white;
        }
        .mcp-env-add {
          padding: 6px 12px;
          border: 1px solid var(--border);
          border-radius: 4px;
          background: var(--bg-secondary);
          color: var(--text-primary);
          cursor: pointer;
          font-size: 12px;
          transition: all 200ms;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        .mcp-env-add:hover {
          border-color: var(--accent);
          color: var(--accent);
        }
      `}</style>
    </div>
  )
}
