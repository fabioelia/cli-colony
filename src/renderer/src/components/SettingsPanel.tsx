import { useState, useEffect, useRef, useMemo } from 'react'
import { ArrowLeft, Terminal, ScrollText, AlertTriangle, RotateCcw, Bell, Cpu, Settings, Network, Plus, Trash2, Pencil, ChevronDown, ChevronRight, Clock, ClipboardList, GitCommit, Globe, BookTemplate, Copy, X, Shield, Sparkles, Check, Circle, Sun, Moon, Palette, Eye, EyeOff, Search, Play, CheckCircle, XCircle, Loader, Download, Upload, Puzzle } from 'lucide-react'
import HelpPopover from './HelpPopover'
import BatchExecutionSettings from './BatchExecutionSettings'
import AppUpdateSettings from './AppUpdateSettings'
import { parseShellArgs } from '../../../shared/utils'
import type { McpAuditEntry, CommitAttribution, ApprovalRule, ApprovalRuleType, ApprovalRuleAction, OnboardingState } from '../../../preload'
import type { SessionTemplate, AgentDef } from '../../../shared/types'

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
  const [notifySources, setNotifySources] = useState<Record<string, boolean>>({
    pipeline: true, persona: true, approval: true, session: true, budget: true, system: true,
  })
  const [soundOnFinish, setSoundOnFinish] = useState(true)
  const [quietHoursEnabled, setQuietHoursEnabled] = useState(false)
  const [quietHoursStart, setQuietHoursStart] = useState('22:00')
  const [quietHoursEnd, setQuietHoursEnd] = useState('07:00')
  const [autoCleanupMinutes, setAutoCleanupMinutes] = useState('5')
  const [dailyCostBudget, setDailyCostBudget] = useState('')
  const [globalHotkey, setGlobalHotkey] = useState('CommandOrControl+Shift+Space')
  const [hotkeyError, setHotkeyError] = useState('')
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

  const [mcpTestResults, setMcpTestResults] = useState<Record<string, { ok: boolean; message: string } | 'testing'>>({})
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
  const [apiToken, setApiToken] = useState('')
  const [showApiToken, setShowApiToken] = useState(false)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [fontSize, setFontSize] = useState(13)
  const [fontFamily, setFontFamily] = useState('Menlo, Monaco, "Courier New", monospace')
  const [cursorStyle, setCursorStyle] = useState<'block' | 'bar' | 'underline'>('underline')
  const [cursorBlink, setCursorBlink] = useState(false)
  const [scrollback, setScrollback] = useState(10000)

  const [sessionTemplates, setSessionTemplates] = useState<SessionTemplate[]>([])
  const [showTemplatesSection, setShowTemplatesSection] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<SessionTemplate | null>(null)
  const [availableAgents, setAvailableAgents] = useState<AgentDef[]>([])

  const [approvalRules, setApprovalRules] = useState<ApprovalRule[]>([])
  const [showApprovalRulesSection, setShowApprovalRulesSection] = useState(false)
  const [approvalRuleForm, setApprovalRuleForm] = useState<Partial<ApprovalRule> | null>(null)

  const [showBatchSection, setShowBatchSection] = useState(false)
  const [showUpdateSection, setShowUpdateSection] = useState(false)
  const [showOnboardingSection, setShowOnboardingSection] = useState(false)
  const [showIntegrationsSection, setShowIntegrationsSection] = useState(false)
  const [jiraDomain, setJiraDomain] = useState('')
  const [jiraEmail, setJiraEmail] = useState('')
  const [jiraApiToken, setJiraApiToken] = useState('')
  const [jiraTransitionOnCommit, setJiraTransitionOnCommit] = useState('')
  const [jiraSessionStartTransition, setJiraSessionStartTransition] = useState('')
  const [jiraSessionEndComment, setJiraSessionEndComment] = useState(false)
  const [jiraTestResult, setJiraTestResult] = useState<{ ok: boolean; message: string } | 'testing' | null>(null)
  const [onboardingState, setOnboardingState] = useState<OnboardingState | null>(null)
  const [approvalRuleFormError, setApprovalRuleFormError] = useState<string | null>(null)
  const [approvalRuleFormName, setApprovalRuleFormName] = useState('')
  const [approvalRuleFormType, setApprovalRuleFormType] = useState<ApprovalRuleType>('file_pattern')
  const [approvalRuleFormCondition, setApprovalRuleFormCondition] = useState('')
  const [approvalRuleFormAction, setApprovalRuleFormAction] = useState<ApprovalRuleAction>('auto_approve')

  const [searchQuery, setSearchQuery] = useState('')

  const SECTION_KEYWORDS: Record<string, string> = {
    cli: 'cli arguments args default backend claude cursor slash commands sync',
    appearance: 'appearance theme dark light font size family cursor style blink scrollback lines terminal monospace',
    general: 'general tray keep running close quit',
    notifications: 'notifications sound desktop alert pipeline persona approval session budget system',
    sessions: 'sessions cleanup auto-cleanup idle cost daily budget hotkey global shortcut',
    mcp: 'mcp server catalog stdio sse environment variables',
    audit: 'mcp audit tool call approval log',
    commit: 'commit attribution git',
    webhook: 'webhook server api token port rest url',
    templates: 'session templates model directory role prompt permissions',
    daemon: 'daemon version restart pty heartbeat liveness',
    logs: 'logs app daemon output debug',
    approval: 'approval rules file pattern cost threshold risk auto-approve escalate',
    updates: 'app updates version download install release check',
    batch: 'batch execution parallel concurrent',
    onboarding: 'onboarding welcome checklist activation reset replay',
    scheduler: 'scheduler log cron schedule',
    integrations: 'integrations jira ticket atlassian domain email api token',
  }

  const sectionVisible = useMemo(() => {
    if (!searchQuery.trim()) return (_id: string) => true
    const q = searchQuery.toLowerCase()
    return (sectionId: string) => {
      const keywords = SECTION_KEYWORDS[sectionId] || ''
      return keywords.includes(q)
    }
  }, [searchQuery])

  const visibleCount = useMemo(() => {
    if (!searchQuery.trim()) return Object.keys(SECTION_KEYWORDS).length
    return Object.keys(SECTION_KEYWORDS).filter(id => sectionVisible(id)).length
  }, [searchQuery, sectionVisible])

  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      setDefaultArgs(s.defaultArgs || '')
      setDefaultCliBackend(s.defaultCliBackend === 'cursor-agent' ? 'cursor-agent' : 'claude')
      setSyncClaudeSlashCommands(s.syncClaudeSlashCommands !== 'false')
      setShellProfile(s.shellProfile || '')
      setGitProtocol((s.gitProtocol === 'https' ? 'https' : 'ssh') as 'ssh' | 'https')
      setNotificationsEnabled(s.notificationsEnabled !== 'false')
      setNotifySources({
        pipeline: s.notifyPipeline !== 'false',
        persona: s.notifyPersona !== 'false',
        approval: s.notifyApproval !== 'false',
        session: s.notifySession !== 'false',
        budget: s.notifyBudget !== 'false',
        system: s.notifySystem !== 'false',
      })
      setSoundOnFinish(s.soundOnFinish !== 'false')
      setQuietHoursEnabled(s.quietHoursEnabled === 'true')
      setQuietHoursStart(s.quietHoursStart || '22:00')
      setQuietHoursEnd(s.quietHoursEnd || '07:00')
      setAutoCleanupMinutes(s.autoCleanupMinutes || '5')
      setDailyCostBudget(s.dailyCostBudgetUsd || '')
      setGlobalHotkey(s.globalHotkey || 'CommandOrControl+Shift+Space')
      setKeepInTray(s.keepInTray !== 'false')
      setWebhookEnabled(s.webhookEnabled !== 'false')
      setWebhookPort(s.webhookPort || '7474')
      setApiToken(s.apiToken || '')
      setJiraDomain(s.jiraDomain || '')
      setJiraEmail(s.jiraEmail || '')
      setJiraApiToken(s.jiraApiToken || '')
      setJiraTransitionOnCommit(s.jiraTransitionOnCommit || '')
      setJiraSessionStartTransition(s.jiraSessionStartTransition || '')
      setJiraSessionEndComment(s.jiraSessionEndComment === 'true')
      setTheme((s.theme === 'light' ? 'light' : 'dark') as 'dark' | 'light')
      if (s.fontSize) setFontSize(parseInt(s.fontSize, 10) || 13)
      if (s.terminalFontFamily) setFontFamily(s.terminalFontFamily)
      if (s.terminalCursorStyle) setCursorStyle(s.terminalCursorStyle as 'block' | 'bar' | 'underline')
      if (s.terminalCursorBlink) setCursorBlink(s.terminalCursorBlink === 'true')
      if (s.terminalScrollback) setScrollback(parseInt(s.terminalScrollback, 10) || 10000)
    })
    window.api.settings.getShells().then(setAvailableShells)
    window.api.daemon.getVersion().then(setDaemonVersion).catch(() => {})
    window.api.settings.detectGitProtocol().then(setDetectedProtocol).catch(() => {})
    window.api.mcp.list().then(setMcpServers).catch(() => {})
    window.api.mcp.getAuditLog().then(setAuditLog).catch(() => {})
    window.api.session.getAttributedCommits().then(setCommitAttributions).catch(() => {})
    window.api.sessionTemplates.list().then(setSessionTemplates).catch(() => {})
    window.api.agents.list().then(setAvailableAgents).catch(() => {})
    window.api.approvalRules.list().then(setApprovalRules).catch(() => {})
    window.api.onboarding.getState().then(setOnboardingState).catch(() => {})
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

  const handleThemeChange = (newTheme: 'dark' | 'light') => {
    setTheme(newTheme)
    window.api.settings.set('theme', newTheme)
    if (newTheme === 'light') {
      document.documentElement.setAttribute('data-theme', 'light')
    } else {
      document.documentElement.removeAttribute('data-theme')
    }
  }

  const handleFontSizeChange = (delta: number) => {
    const next = Math.min(Math.max(fontSize + delta, 8), 28)
    setFontSize(next)
    window.api.settings.set('fontSize', String(next))
    window.dispatchEvent(new CustomEvent('fontSize-changed', { detail: next }))
  }

  const handleFontSizeReset = () => {
    setFontSize(13)
    window.api.settings.set('fontSize', '13')
    window.dispatchEvent(new CustomEvent('fontSize-changed', { detail: 13 }))
  }

  const handleSave = async () => {
    await Promise.all([
      window.api.settings.set('defaultArgs', defaultArgs),
      window.api.settings.set('defaultCliBackend', defaultCliBackend),
      window.api.settings.set('syncClaudeSlashCommands', syncClaudeSlashCommands ? 'true' : 'false'),
      window.api.settings.set('shellProfile', shellProfile),
      window.api.settings.set('gitProtocol', gitProtocol),
      window.api.settings.set('notificationsEnabled', notificationsEnabled ? 'true' : 'false'),
      window.api.settings.set('notifyPipeline', notifySources.pipeline ? 'true' : 'false'),
      window.api.settings.set('notifyPersona', notifySources.persona ? 'true' : 'false'),
      window.api.settings.set('notifyApproval', notifySources.approval ? 'true' : 'false'),
      window.api.settings.set('notifySession', notifySources.session ? 'true' : 'false'),
      window.api.settings.set('notifyBudget', notifySources.budget ? 'true' : 'false'),
      window.api.settings.set('notifySystem', notifySources.system ? 'true' : 'false'),
      window.api.settings.set('soundOnFinish', soundOnFinish ? 'true' : 'false'),
      window.api.settings.set('quietHoursEnabled', quietHoursEnabled ? 'true' : 'false'),
      window.api.settings.set('quietHoursStart', quietHoursStart),
      window.api.settings.set('quietHoursEnd', quietHoursEnd),
      window.api.settings.set('autoCleanupMinutes', autoCleanupMinutes),
      window.api.settings.set('dailyCostBudgetUsd', dailyCostBudget),
      window.api.settings.set('globalHotkey', globalHotkey),
      window.api.settings.set('keepInTray', keepInTray ? 'true' : 'false'),
      window.api.settings.set('webhookEnabled', webhookEnabled ? 'true' : 'false'),
      window.api.settings.set('webhookPort', webhookPort),
      window.api.settings.set('apiToken', apiToken),
      window.api.settings.set('jiraDomain', jiraDomain),
      window.api.settings.set('jiraEmail', jiraEmail),
      window.api.settings.set('jiraApiToken', jiraApiToken),
      window.api.settings.set('jiraTransitionOnCommit', jiraTransitionOnCommit),
      window.api.settings.set('jiraSessionStartTransition', jiraSessionStartTransition),
      window.api.settings.set('jiraSessionEndComment', jiraSessionEndComment ? 'true' : 'false'),
      window.api.settings.set('theme', theme),
    ])
    // Re-register hotkey immediately (no app restart needed)
    const result = await window.api.settings.reregisterHotkey(globalHotkey)
    setHotkeyError(result.success ? '' : (result.error || 'Invalid hotkey'))
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleExport = async () => {
    await window.api.settings.export()
  }

  const handleImport = async () => {
    const result = await window.api.settings.import()
    if (result) {
      // Reload all settings state
      window.api.settings.getAll().then((s) => {
        setDefaultArgs(s.defaultArgs || '')
        setDefaultCliBackend(s.defaultCliBackend === 'cursor-agent' ? 'cursor-agent' : 'claude')
        setSyncClaudeSlashCommands(s.syncClaudeSlashCommands !== 'false')
        setShellProfile(s.shellProfile || '')
        setGitProtocol((s.gitProtocol === 'https' ? 'https' : 'ssh') as 'ssh' | 'https')
        setNotificationsEnabled(s.notificationsEnabled !== 'false')
        setNotifySources({
          pipeline: s.notifyPipeline !== 'false',
          persona: s.notifyPersona !== 'false',
          approval: s.notifyApproval !== 'false',
          session: s.notifySession !== 'false',
          budget: s.notifyBudget !== 'false',
          system: s.notifySystem !== 'false',
        })
        setSoundOnFinish(s.soundOnFinish !== 'false')
        setQuietHoursEnabled(s.quietHoursEnabled === 'true')
        setQuietHoursStart(s.quietHoursStart || '22:00')
        setQuietHoursEnd(s.quietHoursEnd || '07:00')
        setAutoCleanupMinutes(s.autoCleanupMinutes || '5')
        setDailyCostBudget(s.dailyCostBudgetUsd || '')
        setGlobalHotkey(s.globalHotkey || 'CommandOrControl+Shift+Space')
        setKeepInTray(s.keepInTray !== 'false')
        setWebhookEnabled(s.webhookEnabled !== 'false')
        setWebhookPort(s.webhookPort || '7474')
        setApiToken(s.apiToken || '')
        setTheme((s.theme === 'light' ? 'light' : 'dark') as 'dark' | 'light')
        if (s.fontSize) setFontSize(parseInt(s.fontSize, 10) || 13)
        if (s.terminalFontFamily) setFontFamily(s.terminalFontFamily)
        if (s.terminalCursorStyle) setCursorStyle(s.terminalCursorStyle as 'block' | 'bar' | 'underline')
        if (s.terminalCursorBlink) setCursorBlink(s.terminalCursorBlink === 'true')
        if (s.terminalScrollback) setScrollback(parseInt(s.terminalScrollback, 10) || 10000)
      })
      window.api.mcp.list().then(setMcpServers).catch(() => {})
      window.api.sessionTemplates.list().then(setSessionTemplates).catch(() => {})
      window.api.approvalRules.list().then(setApprovalRules).catch(() => {})
    }
  }

  const handleMcpTest = async (server: McpServer) => {
    setMcpTestResults(prev => ({ ...prev, [server.name]: 'testing' }))
    const result = await window.api.mcp.test(server)
    setMcpTestResults(prev => ({ ...prev, [server.name]: result }))
    setTimeout(() => setMcpTestResults(prev => { const next = { ...prev }; delete next[server.name]; return next }), 10000)
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
          <button className="panel-header-btn" onClick={handleExport} title="Export all settings">
            <Download size={12} />
          </button>
          <button className="panel-header-btn" onClick={handleImport} title="Import settings from file">
            <Upload size={12} />
          </button>
          <button className="panel-header-btn" onClick={handleSave} title="Save settings">
            {saved ? 'Saved!' : 'Save'}
          </button>
        </div>
      </div>

      <div className="settings-search">
        <Search size={12} />
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          placeholder="Filter settings..."
        />
        {searchQuery && (
          <button className="settings-search-clear" onClick={() => setSearchQuery('')} title="Clear">
            <X size={12} />
          </button>
        )}
        {searchQuery.trim() && (
          <span className="settings-search-count">
            {visibleCount} section{visibleCount !== 1 ? 's' : ''} matching
          </span>
        )}
      </div>

      {searchQuery.trim() && visibleCount === 0 && (
        <div className="settings-no-results">
          No sections match &ldquo;{searchQuery.trim()}&rdquo;
        </div>
      )}

      {/* CLI */}
      <div className="settings-section" style={{ display: sectionVisible('cli') ? undefined : 'none' }}>
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
              <span className="settings-restart-note" style={{ color: 'var(--warning)' }}>
                Detected: {detectedProtocol} works on this machine
              </span>
            )}
            {detectedProtocol && detectedProtocol === gitProtocol && (
              <span className="settings-restart-note" style={{ color: 'var(--success)' }}>
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
          </p>
          <input
            value={globalHotkey}
            onChange={(e) => { setGlobalHotkey(e.target.value); setHotkeyError('') }}
            placeholder="CommandOrControl+Shift+Space"
          />
          {hotkeyError && <p className="settings-help" style={{ color: 'var(--danger)' }}>Invalid hotkey: {hotkeyError}</p>}
        </div>
      </div>

      {/* Appearance */}
      <div className="settings-section" style={{ display: sectionVisible('appearance') ? undefined : 'none' }}>
        <div className="settings-section-title">
          <Palette size={12} />
          Appearance
        </div>
        <div className="settings-field">
          <label>Theme</label>
          <div className="settings-theme-toggle">
            <button
              className={`settings-theme-btn ${theme === 'dark' ? 'active' : ''}`}
              onClick={() => handleThemeChange('dark')}
            >
              <Moon size={14} /> Dark
            </button>
            <button
              className={`settings-theme-btn ${theme === 'light' ? 'active' : ''}`}
              onClick={() => handleThemeChange('light')}
            >
              <Sun size={14} /> Light
            </button>
          </div>
        </div>
        <div className="settings-field">
          <label>Font size</label>
          <div className="settings-font-size">
            <button className="settings-font-size-btn" onClick={() => handleFontSizeChange(-1)} disabled={fontSize <= 8}>−</button>
            <span className="settings-font-size-value">{fontSize}</span>
            <button className="settings-font-size-btn" onClick={() => handleFontSizeChange(1)} disabled={fontSize >= 28}>+</button>
            {fontSize !== 13 && <button className="settings-font-size-reset" onClick={handleFontSizeReset}>Reset</button>}
          </div>
          <p className="settings-help settings-help-bottom">Also adjustable with ⌘+/⌘− (range 8–28)</p>
        </div>
        <div className="settings-field">
          <label>Font family</label>
          <select
            className="settings-select"
            value={fontFamily}
            onChange={(e) => {
              setFontFamily(e.target.value)
              window.api.settings.set('terminalFontFamily', e.target.value)
              window.dispatchEvent(new CustomEvent('terminalFontFamily-changed', { detail: e.target.value }))
            }}
          >
            <option value='Menlo, Monaco, "Courier New", monospace'>Menlo (default)</option>
            <option value='"JetBrains Mono", Menlo, monospace'>JetBrains Mono</option>
            <option value='"Fira Code", Menlo, monospace'>Fira Code</option>
            <option value='"SF Mono", Menlo, monospace'>SF Mono</option>
            <option value='"Source Code Pro", Menlo, monospace'>Source Code Pro</option>
            <option value='"Cascadia Code", Menlo, monospace'>Cascadia Code</option>
            <option value='monospace'>System Monospace</option>
          </select>
        </div>
        <div className="settings-field">
          <label>Cursor style</label>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {(['block', 'bar', 'underline'] as const).map(style => (
              <button
                key={style}
                className={`settings-theme-btn ${cursorStyle === style ? 'active' : ''}`}
                onClick={() => {
                  setCursorStyle(style)
                  window.api.settings.set('terminalCursorStyle', style)
                  window.dispatchEvent(new CustomEvent('terminalCursorStyle-changed', { detail: style }))
                }}
              >
                {style.charAt(0).toUpperCase() + style.slice(1)}
              </button>
            ))}
            <label style={{ display: 'flex', alignItems: 'center', gap: '4px', fontSize: '12px', color: 'var(--text-secondary)' }}>
              <input
                type="checkbox"
                checked={cursorBlink}
                onChange={(e) => {
                  setCursorBlink(e.target.checked)
                  window.api.settings.set('terminalCursorBlink', String(e.target.checked))
                  window.dispatchEvent(new CustomEvent('terminalCursorBlink-changed', { detail: e.target.checked }))
                }}
              />
              Blink
            </label>
          </div>
        </div>
        <div className="settings-field">
          <label>Scrollback lines</label>
          <div className="settings-font-size">
            <input
              type="number"
              className="settings-input"
              value={scrollback}
              min={1000}
              max={100000}
              step={1000}
              style={{ width: '80px' }}
              onChange={(e) => setScrollback(parseInt(e.target.value, 10) || scrollback)}
              onBlur={() => {
                const val = Math.min(Math.max(scrollback, 1000), 100000)
                setScrollback(val)
                window.api.settings.set('terminalScrollback', String(val))
                window.dispatchEvent(new CustomEvent('terminalScrollback-changed', { detail: val }))
              }}
            />
            {scrollback !== 10000 && (
              <button className="settings-font-size-reset" onClick={() => {
                setScrollback(10000)
                window.api.settings.set('terminalScrollback', '10000')
                window.dispatchEvent(new CustomEvent('terminalScrollback-changed', { detail: 10000 }))
              }}>Reset</button>
            )}
          </div>
          <p className="settings-help settings-help-bottom">Range 1,000–100,000. Higher values use more memory.</p>
        </div>
      </div>

      {/* General */}
      <div className="settings-section" style={{ display: sectionVisible('general') ? undefined : 'none' }}>
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
      <div className="settings-section" style={{ display: sectionVisible('notifications') ? undefined : 'none' }}>
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
        {notificationsEnabled && (
          <div className="settings-notification-sources">
            {(['pipeline', 'persona', 'approval', 'session', 'budget', 'system'] as const).map(source => (
              <div key={source} className="settings-row" style={{ paddingLeft: 24 }}>
                <span className="settings-row-label">{source.charAt(0).toUpperCase() + source.slice(1)}</span>
                <button
                  className={`settings-toggle ${notifySources[source] ? 'active' : ''}`}
                  onClick={() => setNotifySources(prev => ({ ...prev, [source]: !prev[source] }))}
                  role="switch"
                  aria-checked={notifySources[source]}
                  title={notifySources[source] ? `Mute ${source} notifications` : `Enable ${source} notifications`}
                >
                  <span className="settings-toggle-knob" />
                </button>
              </div>
            ))}
          </div>
        )}
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
        <div className="settings-row">
          <span className="settings-row-label">Quiet hours</span>
          <button
            className={`settings-toggle ${quietHoursEnabled ? 'active' : ''}`}
            onClick={() => setQuietHoursEnabled(!quietHoursEnabled)}
            role="switch"
            aria-checked={quietHoursEnabled}
            title={quietHoursEnabled ? 'Disable quiet hours' : 'Enable quiet hours'}
          >
            <span className="settings-toggle-knob" />
          </button>
        </div>
        {quietHoursEnabled && (
          <div className="settings-row" style={{ paddingLeft: 24 }}>
            <span className="settings-row-label">Suppress from</span>
            <input type="time" value={quietHoursStart} onChange={e => setQuietHoursStart(e.target.value)} className="settings-compact-number" style={{ width: 90 }} />
            <span style={{ margin: '0 8px', color: 'var(--text-secondary)' }}>to</span>
            <input type="time" value={quietHoursEnd} onChange={e => setQuietHoursEnd(e.target.value)} className="settings-compact-number" style={{ width: 90 }} />
          </div>
        )}
        <p className="settings-help settings-help-bottom">Suppress desktop notifications during quiet hours. In-app history still records everything.</p>
      </div>

      {/* Sessions */}
      <div className="settings-section" style={{ display: sectionVisible('sessions') ? undefined : 'none' }}>
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
              onBlur={() => { const v = parseInt(autoCleanupMinutes, 10); setAutoCleanupMinutes(String(isNaN(v) ? 0 : Math.max(0, Math.min(60, v)))) }}
              className="settings-compact-number"
            />
            <span className="settings-unit">min</span>
          </div>
        </div>
        <p className="settings-help settings-help-bottom">Set to 0 to keep stopped sessions indefinitely.</p>
        <div className="settings-row">
          <span className="settings-row-label">Daily cost budget</span>
          <div className="settings-row-control">
            <span className="settings-unit">$</span>
            <input
              type="number"
              min="0"
              step="0.50"
              placeholder="e.g. 10.00"
              value={dailyCostBudget}
              onChange={(e) => setDailyCostBudget(e.target.value)}
              onBlur={() => { const v = parseFloat(dailyCostBudget); setDailyCostBudget(isNaN(v) || v <= 0 ? '' : v.toFixed(2)) }}
              className="settings-compact-number"
              style={{ width: 80 }}
            />
          </div>
        </div>
        <p className="settings-help settings-help-bottom">Alert when daily persona run cost exceeds this amount. Leave empty to disable.</p>
      </div>

      {/* MCP Server Catalog */}
      <div className={`settings-section settings-logs-section ${showMcpSection ? '' : 'collapsed'}`} style={{ display: sectionVisible('mcp') ? undefined : 'none' }}>
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
                        title={mcpTestResults[s.name] && typeof mcpTestResults[s.name] === 'object' ? (mcpTestResults[s.name] as { ok: boolean; message: string }).message : 'Test connection'}
                        onClick={() => handleMcpTest(s)}
                        disabled={mcpTestResults[s.name] === 'testing'}
                      >
                        {mcpTestResults[s.name] === 'testing' ? <Loader size={11} className="spinning" />
                          : mcpTestResults[s.name] && typeof mcpTestResults[s.name] === 'object'
                            ? (mcpTestResults[s.name] as { ok: boolean }).ok ? <CheckCircle size={11} style={{ color: 'var(--success)' }} />
                              : <XCircle size={11} style={{ color: 'var(--danger)' }} />
                            : <Play size={11} />}
                        {' '}Test
                      </button>
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
                      const updated = await window.api.mcp.save(formToSave, mcpOriginalName ?? undefined)
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
      <div className={`settings-section settings-logs-section ${showAuditSection ? '' : 'collapsed'}`} style={{ display: sectionVisible('audit') ? undefined : 'none' }}>
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
      <div className={`settings-section settings-logs-section ${showCommitSection ? '' : 'collapsed'}`} style={{ display: sectionVisible('commit') ? undefined : 'none' }}>
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
                        <td style={{ color: 'var(--success)', fontFamily: 'monospace', fontSize: 11 }}>
                          {entry.costUsd != null ? `$${entry.costUsd.toFixed(2)}` : '—'}
                        </td>
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
      <div className="settings-section" style={{ display: sectionVisible('webhook') ? undefined : 'none' }}>
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
                onBlur={() => { const v = parseInt(webhookPort, 10); setWebhookPort(String(isNaN(v) ? 7474 : Math.max(1024, Math.min(65535, v)))) }}
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
            <div className="settings-field">
              <label>API Token</label>
              <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                <input
                  type={showApiToken ? 'text' : 'password'}
                  value={apiToken}
                  onChange={(e) => setApiToken(e.target.value)}
                  placeholder="Leave empty for no auth"
                  style={{ flex: 1 }}
                />
                <button
                  className="panel-header-btn"
                  onClick={() => setShowApiToken(!showApiToken)}
                  title={showApiToken ? 'Hide token' : 'Show token'}
                >
                  {showApiToken ? <EyeOff size={12} /> : <Eye size={12} />}
                </button>
              </div>
              <p className="settings-help">
                When set, API requests require a <code>Bearer</code> token or <code>X-Colony-Token</code> header.
              </p>
            </div>
          </>
        )}
        <p className="settings-help settings-help-bottom">
          External webhooks need ngrok or similar to reach this server. Add <code>trigger: &#123;type: webhook&#125;</code> to a pipeline YAML to register a route at <code>/webhook/&lt;slug&gt;</code>.
          <span className="settings-restart-note">Requires app restart to take effect</span>
        </p>
      </div>

      {/* Integrations */}
      <div className={`settings-section settings-logs-section ${showIntegrationsSection ? '' : 'collapsed'}`} style={{ display: sectionVisible('integrations') ? undefined : 'none' }}>
        <div className="settings-section-title">
          <Puzzle size={12} />
          Integrations
          <div className="settings-logs-actions">
            <button
              className="settings-logs-toggle"
              onClick={() => setShowIntegrationsSection(!showIntegrationsSection)}
              title={showIntegrationsSection ? 'Hide' : 'Show'}
            >
              {showIntegrationsSection ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
        </div>
        {showIntegrationsSection && (
          <div>
            <p className="settings-help">
              Configure Jira Cloud credentials to attach ticket context to sessions. Uses Basic auth (email + API token).{' '}
              <a
                href="https://id.atlassian.com/manage-profile/security/api-tokens"
                onClick={(e) => { e.preventDefault(); window.api.shell.openExternal('https://id.atlassian.com/manage-profile/security/api-tokens') }}
                style={{ color: 'var(--accent)', cursor: 'pointer' }}
              >
                Create API token ↗
              </a>
            </p>
            <div className="settings-field">
              <label>Jira Domain</label>
              <input
                placeholder="e.g. yourcompany.atlassian.net"
                value={jiraDomain}
                onChange={(e) => setJiraDomain(e.target.value)}
              />
            </div>
            <div className="settings-field">
              <label>Jira Email</label>
              <input
                type="email"
                placeholder="you@example.com"
                value={jiraEmail}
                onChange={(e) => setJiraEmail(e.target.value)}
              />
            </div>
            <div className="settings-field">
              <label>Jira API Token</label>
              <input
                type="password"
                placeholder="••••••••"
                value={jiraApiToken}
                onChange={(e) => setJiraApiToken(e.target.value)}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <button
                className="panel-header-btn"
                disabled={jiraTestResult === 'testing' || !jiraDomain || !jiraEmail || !jiraApiToken}
                onClick={async () => {
                  setJiraTestResult('testing')
                  // Save current values first so fetchTicket reads them
                  await Promise.all([
                    window.api.settings.set('jiraDomain', jiraDomain),
                    window.api.settings.set('jiraEmail', jiraEmail),
                    window.api.settings.set('jiraApiToken', jiraApiToken),
                  ])
                  const result = await window.api.jira.fetchTicket('TEST-0')
                  if (result.ok) {
                    setJiraTestResult({ ok: true, message: 'Connected' })
                  } else if (result.error.includes('not found') || result.error.includes('404')) {
                    setJiraTestResult({ ok: true, message: 'Connected' })
                  } else {
                    setJiraTestResult({ ok: false, message: result.error })
                  }
                }}
              >
                {jiraTestResult === 'testing' ? <Loader size={11} className="spinning" /> : <Play size={11} />}
                {' '}Test Connection
              </button>
              {jiraTestResult && jiraTestResult !== 'testing' && (
                <span style={{ fontSize: 12, color: jiraTestResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                  {jiraTestResult.ok ? <CheckCircle size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} /> : <XCircle size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />}
                  {jiraTestResult.message}
                </span>
              )}
            </div>
            <div className="settings-field" style={{ marginTop: 12 }}>
              <label>Transition on Commit</label>
              <input
                placeholder="e.g. In Progress (leave blank to disable)"
                value={jiraTransitionOnCommit}
                onChange={(e) => setJiraTransitionOnCommit(e.target.value)}
              />
              <div className="settings-field-hint">When set, automatically moves the attached ticket to this status after a commit.</div>
            </div>
            <div className="settings-field" style={{ marginTop: 12 }}>
              <label>Status on session start</label>
              <input
                placeholder="e.g. In Progress (leave blank to disable)"
                value={jiraSessionStartTransition}
                onChange={(e) => setJiraSessionStartTransition(e.target.value)}
              />
              <div className="settings-field-hint">Exact status name (case-sensitive). When set, moves the attached ticket to this status when a session is created.</div>
            </div>
            <div className="settings-field" style={{ marginTop: 12 }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={jiraSessionEndComment}
                  onChange={(e) => setJiraSessionEndComment(e.target.checked)}
                  style={{ margin: 0, width: 'auto', padding: 0, border: 'none', background: 'none' }}
                />
                Post comment on session exit
              </label>
              <div className="settings-field-hint">Post a comment to the linked Jira ticket when a session exits with commits.</div>
            </div>
          </div>
        )}
      </div>

      {/* Session Templates */}
      <div className={`settings-section settings-logs-section ${showTemplatesSection ? '' : 'collapsed'}`} style={{ display: sectionVisible('templates') ? undefined : 'none' }}>
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
                      {t.cliBackend && t.cliBackend !== 'claude' && <span className="template-popover-model">{t.cliBackend}</span>}
                      {t.mcpServers && t.mcpServers.length > 0 && <span className="template-popover-model">MCP: {t.mcpServers.length}</span>}
                      {t.agent && <span className="template-popover-model">Agent</span>}
                      {t.color && <span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: '50%', background: t.color, verticalAlign: 'middle' }} />}
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
                    className="mcp-catalog-edit"
                    title="Edit template"
                    onClick={() => setEditingTemplate({ ...t })}
                  >
                    <Pencil size={11} />
                  </button>
                  <button
                    className="mcp-catalog-edit"
                    title="Duplicate template"
                    onClick={async () => {
                      const dup: SessionTemplate = {
                        ...t,
                        id: crypto.randomUUID(),
                        name: `${t.name} (copy)`,
                        launchCount: 0,
                        lastUsed: undefined,
                      }
                      await window.api.sessionTemplates.save(dup)
                      setSessionTemplates(prev => [...prev, dup])
                      setEditingTemplate({ ...dup })
                    }}
                  >
                    <Copy size={11} />
                  </button>
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
      <div className="settings-section" style={{ display: sectionVisible('daemon') ? undefined : 'none' }}>
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
          <p className="settings-help" style={{ color: 'var(--danger)', cursor: 'pointer' }} onClick={() => setRestartError(false)} title="Click to dismiss">Restart failed — check logs for details.</p>
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
                  setRestartError(false)
                  try {
                    await window.api.daemon.restart()
                    // Wait for socket to stabilize after restartDaemon()'s 500ms sleep
                    await new Promise(r => setTimeout(r, 1000))
                    const version = await window.api.daemon.getVersion()
                    setDaemonVersion(version)
                    setShowRestartConfirm(false)
                  } catch (_err) {
                    setRestartError(true)
                  }
                  setRestarting(false)
                }}
              >
                {restarting ? 'Restarting...' : 'Restart'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Logs */}
      <div className={`settings-section settings-logs-section ${showLogs ? '' : 'collapsed'}`} style={{ display: sectionVisible('logs') ? undefined : 'none' }}>
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

      {/* Approval Rules */}
      <div style={{ display: sectionVisible('approval') ? undefined : 'none' }}>
      {(() => {
        const handleAddRule = () => {
          setApprovalRuleFormName('')
          setApprovalRuleFormType('file_pattern')
          setApprovalRuleFormCondition('')
          setApprovalRuleFormAction('auto_approve')
          setApprovalRuleFormError(null)
          setApprovalRuleForm({})
        }

        const handleEditRule = (rule: ApprovalRule) => {
          setApprovalRuleFormName(rule.name)
          setApprovalRuleFormType(rule.type)
          setApprovalRuleFormCondition(rule.condition)
          setApprovalRuleFormAction(rule.action)
          setApprovalRuleFormError(null)
          setApprovalRuleForm({ id: rule.id })
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
            const editId = approvalRuleForm?.id
            if (editId) {
              await window.api.approvalRules.update(editId, {
                name: approvalRuleFormName,
                type: approvalRuleFormType,
                condition: approvalRuleFormCondition,
                action: approvalRuleFormAction,
              })
              setApprovalRules(approvalRules.map(r => r.id === editId ? { ...r, name: approvalRuleFormName, type: approvalRuleFormType, condition: approvalRuleFormCondition, action: approvalRuleFormAction } : r))
            } else {
              const created = await window.api.approvalRules.create(
                approvalRuleFormName,
                approvalRuleFormType,
                approvalRuleFormCondition,
                approvalRuleFormAction
              )
              setApprovalRules([...approvalRules, created])
            }
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
                      {approvalRuleForm?.id ? 'Edit Rule' : 'Add New Rule'}
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
                          border: '1px solid var(--border)',
                          borderRadius: '4px',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
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
                          border: '1px solid var(--border)',
                          borderRadius: '4px',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
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
                          border: '1px solid var(--border)',
                          borderRadius: '4px',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
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
                          border: '1px solid var(--border)',
                          borderRadius: '4px',
                          backgroundColor: 'var(--bg-secondary)',
                          color: 'var(--text-primary)',
                        }}
                      >
                        <option value="auto_approve">Auto-Approve</option>
                        <option value="require_approval">Require Approval</option>
                        <option value="require_escalation">Require Escalation</option>
                      </select>
                    </div>
                    {approvalRuleFormError && (
                      <div style={{ color: 'var(--danger)', fontSize: '12px', marginBottom: '8px' }}>
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
                        {approvalRuleForm?.id ? 'Update Rule' : 'Save Rule'}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <table style={{ width: '100%', fontSize: '11px', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr style={{ borderBottom: '1px solid var(--border)' }}>
                          <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: '600' }}>Name</th>
                          <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: '600' }}>Type</th>
                          <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: '600' }}>Condition</th>
                          <th style={{ padding: '6px 8px', textAlign: 'left', fontWeight: '600' }}>Action</th>
                          <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: '600' }}>Enabled</th>
                          <th style={{ padding: '6px 8px', textAlign: 'center', fontWeight: '600' }}>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {approvalRules.map((rule) => (
                          <tr key={rule.id} style={{ borderBottom: '1px solid var(--border)' }}>
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
                                onClick={() => handleEditRule(rule)}
                                style={{ padding: '2px 6px', color: 'var(--text-muted)', opacity: 0.8 }}
                                title="Edit rule"
                              >
                                <Pencil size={10} />
                              </button>
                              <button
                                className="settings-logs-toggle"
                                onClick={() => handleDeleteRule(rule.id)}
                                style={{ padding: '2px 6px', color: 'var(--danger)', opacity: 0.8 }}
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
      </div>

      {/* App Updates */}
      <div style={{ display: sectionVisible('updates') ? undefined : 'none' }}>
      <AppUpdateSettings
        isExpanded={showUpdateSection}
        onToggleExpand={() => setShowUpdateSection(!showUpdateSection)}
      />
      </div>

      {/* Batch Execution */}
      <div style={{ display: sectionVisible('batch') ? undefined : 'none' }}>
      <BatchExecutionSettings
        isExpanded={showBatchSection}
        onToggleExpand={() => setShowBatchSection(!showBatchSection)}
      />
      </div>

      {/* Onboarding */}
      <div className={`settings-section settings-logs-section ${showOnboardingSection ? '' : 'collapsed'}`} style={{ display: sectionVisible('onboarding') ? undefined : 'none' }}>
        <div className="settings-section-title">
          <Sparkles size={12} />
          Onboarding
          <div className="settings-logs-actions">
            <button
              className="settings-logs-toggle"
              onClick={() => setShowOnboardingSection(!showOnboardingSection)}
              title={showOnboardingSection ? 'Hide' : 'Show'}
            >
              {showOnboardingSection ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            </button>
          </div>
        </div>
        {showOnboardingSection && onboardingState && (
          <div className="onboarding-settings">
            <div className="settings-row">
              <span className="settings-row-label">Replay welcome screen</span>
              <button
                className="panel-header-btn"
                onClick={async () => {
                  const s = await window.api.onboarding.replay()
                  setOnboardingState(s)
                }}
              >
                <RotateCcw size={12} /> Replay
              </button>
            </div>
            <p className="settings-help settings-help-bottom">Re-opens the first-run welcome modal with feature tour and prerequisite checks.</p>

            <div className="onboarding-checklist">
              <label className="settings-row-label" style={{ marginBottom: '6px', display: 'block' }}>Activation checklist</label>
              {([
                ['createdSession', 'Created a session'],
                ['ranFirstPrompt', 'Ran first prompt'],
                ['createdPersona', 'Created a persona'],
                ['connectedGitHub', 'Connected GitHub'],
                ['ranPipeline', 'Ran a pipeline'],
              ] as const).map(([key, label]) => (
                <div key={key} className="onboarding-checklist-item">
                  {onboardingState.checklist[key]
                    ? <Check size={14} style={{ color: 'var(--success)' }} />
                    : <Circle size={14} style={{ color: 'var(--text-secondary)', opacity: 0.4 }} />
                  }
                  <span style={{ color: onboardingState.checklist[key] ? 'var(--text-primary)' : 'var(--text-secondary)' }}>
                    {label}
                  </span>
                </div>
              ))}
            </div>

            <div className="settings-row" style={{ marginTop: '12px' }}>
              <span className="settings-row-label">Reset all onboarding state</span>
              <button
                className="panel-header-btn"
                style={{ color: 'var(--danger)' }}
                onClick={async () => {
                  if (!confirm('Reset all onboarding state? This clears the checklist and re-shows the welcome screen.')) return
                  const s = await window.api.onboarding.reset()
                  setOnboardingState(s)
                }}
              >
                <Trash2 size={12} /> Reset
              </button>
            </div>
            <p className="settings-help settings-help-bottom">Clears the checklist and re-shows the welcome screen on next app open.</p>
          </div>
        )}
      </div>

      {/* Scheduler Log */}
      <div className={`settings-section settings-logs-section ${showSchedulerLogs ? '' : 'collapsed'}`} style={{ display: sectionVisible('scheduler') ? undefined : 'none' }}>
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

      {editingTemplate && (
        <div className="dialog-overlay" onClick={(e) => { if (e.target === e.currentTarget) setEditingTemplate(null) }} onKeyDown={(e) => { if (e.key === 'Escape') setEditingTemplate(null) }}>
          <div className="dialog-content" style={{ width: 480 }}>
            <div className="dialog-header">
              <h2>Edit Template</h2>
              <button className="dialog-close" onClick={() => setEditingTemplate(null)}><X size={16} /></button>
            </div>
            <div className="dialog-body">
              <div className="dialog-field">
                <label>Name</label>
                <input value={editingTemplate.name} onChange={e => setEditingTemplate({ ...editingTemplate, name: e.target.value })} />
              </div>
              <div className="dialog-field">
                <label>Description</label>
                <input value={editingTemplate.description || ''} onChange={e => setEditingTemplate({ ...editingTemplate, description: e.target.value || undefined })} />
              </div>
              <div className="dialog-field">
                <label>Model</label>
                <select value={editingTemplate.model || ''} onChange={e => setEditingTemplate({ ...editingTemplate, model: e.target.value || undefined })} className="settings-select" style={{ width: '100%' }}>
                  <option value="">Default</option>
                  <option value="claude-opus-4-6">Opus (claude-opus-4-6)</option>
                  <option value="claude-sonnet-4-6">Sonnet (claude-sonnet-4-6)</option>
                  <option value="claude-haiku-4-5-20251001">Haiku (claude-haiku-4-5)</option>
                </select>
              </div>
              <div className="dialog-field">
                <label>Working Directory</label>
                <input value={editingTemplate.workingDir || ''} onChange={e => setEditingTemplate({ ...editingTemplate, workingDir: e.target.value || undefined })} placeholder="~/projects/my-app" />
              </div>
              <div className="dialog-field">
                <label>Role</label>
                <select value={editingTemplate.role || ''} onChange={e => setEditingTemplate({ ...editingTemplate, role: e.target.value || undefined })} className="settings-select" style={{ width: '100%' }}>
                  <option value="">None</option>
                  <option value="developer">Developer</option>
                  <option value="reviewer">Reviewer</option>
                  <option value="researcher">Researcher</option>
                  <option value="writer">Writer</option>
                </select>
              </div>
              <div className="dialog-field">
                <label>Initial Prompt</label>
                <textarea rows={3} value={editingTemplate.initialPrompt || ''} onChange={e => setEditingTemplate({ ...editingTemplate, initialPrompt: e.target.value || undefined })} placeholder="Optional first prompt sent on launch" />
              </div>
              <div className="dialog-field" style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <label style={{ flex: 'none', marginBottom: 0 }}>
                  <input type="checkbox" checked={editingTemplate.permissionMode === 'autonomous'} onChange={e => setEditingTemplate({ ...editingTemplate, permissionMode: e.target.checked ? 'autonomous' : 'supervised' })} style={{ marginRight: 6 }} />
                  Autonomous mode
                </label>
                <label style={{ flex: 'none', marginBottom: 0 }}>
                  <input type="checkbox" checked={editingTemplate.planFirst || false} onChange={e => setEditingTemplate({ ...editingTemplate, planFirst: e.target.checked || undefined })} style={{ marginRight: 6 }} />
                  Plan first
                </label>
              </div>

              {/* Color */}
              <div className="dialog-field">
                <label>Color</label>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input
                    type="color"
                    value={editingTemplate.color || '#6b7280'}
                    onChange={e => setEditingTemplate({ ...editingTemplate, color: e.target.value })}
                    style={{ width: 32, height: 24, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                  {editingTemplate.color && (
                    <button className="settings-font-size-reset" onClick={() => setEditingTemplate({ ...editingTemplate, color: undefined })}>Clear</button>
                  )}
                </div>
              </div>

              {/* CLI Backend */}
              <div className="dialog-field">
                <label>CLI Backend</label>
                <select
                  value={editingTemplate.cliBackend || 'claude'}
                  onChange={e => setEditingTemplate({ ...editingTemplate, cliBackend: (e.target.value === 'claude' ? undefined : e.target.value) as any })}
                  className="settings-select" style={{ width: '100%' }}
                >
                  <option value="claude">Claude (default)</option>
                  <option value="cursor-agent">Cursor Agent</option>
                </select>
              </div>

              {/* MCP Servers */}
              <div className="dialog-field">
                <label>MCP Servers</label>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 4 }}>
                  {(editingTemplate.mcpServers || []).map((s, i) => (
                    <span key={s} className="env-tpl-chip">
                      {s}
                      <button onClick={() => {
                        const next = editingTemplate.mcpServers!.filter((_, j) => j !== i)
                        setEditingTemplate({ ...editingTemplate, mcpServers: next.length ? next : undefined })
                      }} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', marginLeft: 4 }}>×</button>
                    </span>
                  ))}
                </div>
                <select
                  value=""
                  onChange={e => {
                    if (!e.target.value) return
                    const current = editingTemplate.mcpServers || []
                    if (!current.includes(e.target.value)) {
                      setEditingTemplate({ ...editingTemplate, mcpServers: [...current, e.target.value] })
                    }
                    e.target.value = ''
                  }}
                  className="settings-select" style={{ width: '100%' }}
                >
                  <option value="">Add MCP server...</option>
                  {mcpServers.filter(s => !(editingTemplate.mcpServers || []).includes(s.name)).map(s => (
                    <option key={s.name} value={s.name}>{s.name}</option>
                  ))}
                </select>
              </div>

              {/* Agent */}
              <div className="dialog-field">
                <label>Agent</label>
                <select
                  value={editingTemplate.agent || ''}
                  onChange={e => setEditingTemplate({ ...editingTemplate, agent: e.target.value || undefined })}
                  className="settings-select" style={{ width: '100%' }}
                >
                  <option value="">None</option>
                  {availableAgents.map(a => (
                    <option key={a.filePath} value={a.filePath}>{a.name} ({a.scope})</option>
                  ))}
                </select>
              </div>

              {/* Environment Variables */}
              <div className="dialog-field">
                <label>Environment Variables</label>
                {Object.entries(editingTemplate.envVars || {}).map(([key, val]) => (
                  <div key={key} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
                    <input value={key} readOnly style={{ width: '40%', opacity: 0.8 }} />
                    <input value={val} onChange={e => {
                      const next = { ...editingTemplate.envVars, [key]: e.target.value }
                      setEditingTemplate({ ...editingTemplate, envVars: next })
                    }} style={{ flex: 1 }} />
                    <button className="settings-font-size-reset" onClick={() => {
                      const next = { ...editingTemplate.envVars }
                      delete next[key]
                      setEditingTemplate({ ...editingTemplate, envVars: Object.keys(next).length ? next : undefined })
                    }}>×</button>
                  </div>
                ))}
                <button className="panel-header-btn" onClick={() => {
                  const key = prompt('Variable name:')
                  if (!key?.trim()) return
                  setEditingTemplate({ ...editingTemplate, envVars: { ...(editingTemplate.envVars || {}), [key.trim()]: '' } })
                }} style={{ marginTop: 4 }}>
                  + Add variable
                </button>
              </div>
            </div>
            <div className="dialog-footer">
              <button className="dialog-btn" onClick={() => setEditingTemplate(null)}>Cancel</button>
              <button className="dialog-btn dialog-btn-primary" disabled={!editingTemplate.name.trim()} onClick={async () => {
                const updated = { ...editingTemplate, name: editingTemplate.name.trim() }
                await window.api.sessionTemplates.save(updated)
                setSessionTemplates(prev => prev.map(t => t.id === updated.id ? updated : t))
                setEditingTemplate(null)
              }}>Save</button>
            </div>
          </div>
        </div>
      )}

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
          background: var(--danger);
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
        .onboarding-checklist {
          margin: 8px 0;
        }
        .onboarding-checklist-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 4px 0;
          font-size: 13px;
        }
      `}</style>
    </div>
  )
}
