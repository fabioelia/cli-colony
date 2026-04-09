import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Server, Play, Square, Trash2, RefreshCw, FileText,
  Plus, ExternalLink, ChevronDown, ChevronRight,
  Circle, AlertTriangle, Clock, X, FolderOpen, Terminal, Loader, CheckCircle, SkipForward, Upload, Download, MessageSquare, Wrench, Stethoscope,
  LayoutList, LayoutGrid
} from 'lucide-react'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'
import { buildTemplateEditPrompt, buildDiagnosePrompt } from '../../../shared/env-prompts'
import Tooltip from './Tooltip'
import HelpPopover from './HelpPopover'
import EmptyStateHook from './EmptyStateHook'
import EnvironmentLogViewer from './EnvironmentLogViewer'
import NewEnvironmentDialog from './NewEnvironmentDialog'
import { usePanelTabKeys } from '../hooks/usePanelTabKeys'

import type { EnvStatus, EnvServiceStatus, EnvironmentTemplate } from '../../../shared/types'

interface Props {
  onLaunchInstance: (opts: { name?: string; workingDirectory?: string; color?: string; args?: string[] }) => Promise<string>
  onFocusInstance: (id: string) => void
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

function statusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--success)'
    case 'stopped': return 'var(--text-muted)'
    case 'partial': return 'var(--warning)'
    case 'creating': return 'var(--accent)'
    case 'crashed': return 'var(--danger)'
    case 'starting': return 'var(--accent)'
    case 'error': return 'var(--danger)'
    default: return 'var(--text-muted)'
  }
}

function serviceStatusColor(status: string): string {
  switch (status) {
    case 'running': return 'var(--success)'
    case 'starting': return 'var(--accent)'
    case 'crashed': return 'var(--danger)'
    default: return 'var(--text-muted)'
  }
}

export default function EnvironmentsPanel({ onLaunchInstance, onFocusInstance }: Props) {
  const [environments, setEnvironments] = useState<EnvStatus[]>([])
  const [templates, setTemplates] = useState<EnvironmentTemplate[]>([])
  const [activeTab, setActiveTab] = useState<'instances' | 'templates'>('instances')
  const envTabs = useMemo(() => ['instances', 'templates'] as const, [])
  usePanelTabKeys(envTabs, activeTab, setActiveTab)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [logViewEnv, setLogViewEnv] = useState<{ envId: string; envName: string; serviceNames?: string[] } | null>(null)
  const [showCreateDialog, setShowCreateDialog] = useState(false)
  const [createDialogMode, setCreateDialogMode] = useState<'template' | 'instance'>('instance')
  const [createDialogTemplate, setCreateDialogTemplate] = useState<EnvironmentTemplate | null>(null)
  const [editingTemplateJson, setEditingTemplateJson] = useState<{ id: string; content: string; dirty: boolean } | null>(null)
  const [actionInProgress, setActionInProgress] = useState<Set<string>>(new Set())
  const [confirmTeardown, setConfirmTeardown] = useState<string | null>(null)
  const [setupSteps, setSetupSteps] = useState<Record<string, Array<{ name: string; status: string; error?: string }>>>({})
  const [setupError, setSetupError] = useState<Record<string, string>>({})
  const [fixResult, setFixResult] = useState<{ envId: string; lines: string[]; isError?: boolean } | null>(null)
  const [fixMenuOpen, setFixMenuOpen] = useState<string | null>(null)
  const [fixMenuRect, setFixMenuRect] = useState<DOMRect | null>(null)
  const [restartPolicies, setRestartPolicies] = useState<Record<string, 'manual' | 'on-crash'>>({})
  const [purposeTags, setPurposeTags] = useState<Record<string, 'interactive' | 'background' | 'nightly' | null>>({})
  const [tagFilter, setTagFilter] = useState<'interactive' | 'background' | 'nightly' | null>(null)
  const [listMode, setListMode] = useState(() => localStorage.getItem('envs-list-mode') !== '0')

  const loadEnvironments = useCallback(async () => {
    try {
      const list = await window.api.env.list()
      setEnvironments(list)
    } catch (err) {
      console.error('Failed to load environments:', err)
    }
  }, [])

  const loadTemplates = useCallback(async () => {
    try {
      const list = await window.api.env.listTemplates()
      setTemplates(list)
    } catch (err) {
      console.error('Failed to load templates:', err)
    }
  }, [])

  const [refreshing, setRefreshing] = useState(false)
  const refreshTemplates = useCallback(async () => {
    setRefreshing(true)
    try {
      const list = await window.api.env.refreshTemplates()
      setTemplates(list)
    } catch (err) {
      console.error('Failed to refresh templates:', err)
      // Fallback to regular list if refresh fails
      try { setTemplates(await window.api.env.listTemplates()) } catch {}
    } finally {
      setTimeout(() => setRefreshing(false), 400)
    }
  }, [])

  useEffect(() => {
    loadEnvironments()
    // Just read cached templates — the heavy refresh happens at app boot and on PR refresh
    loadTemplates()
    const unsub = window.api.env.onStatusUpdate((envs) => {
      setEnvironments(envs)
    })
    const unsubTemplates = window.api.env.onTemplatesChanged((tmpls) => {
      setTemplates(tmpls)
    })
    // Poll as fallback — push events handle most updates, this is just a safety net
    const interval = setInterval(loadEnvironments, 30000)
    // Also refresh when the window regains focus (user switches back from a Claude session)
    const onFocus = () => { loadEnvironments() }
    window.addEventListener('focus', onFocus)
    return () => {
      unsub()
      unsubTemplates()
      clearInterval(interval)
      window.removeEventListener('focus', onFocus)
    }
  }, [loadEnvironments, loadTemplates])

  // Poll more aggressively when services are in transitional states
  useEffect(() => {
    const hasTransitional = environments.some(
      e => e.status === 'partial' || e.services.some(s => s.status === 'starting')
    )
    const hasActionsInProgress = actionInProgress.size > 0
    if (!hasTransitional && !hasActionsInProgress) return

    const fastInterval = setInterval(loadEnvironments, 2000)
    return () => clearInterval(fastInterval)
  }, [environments, actionInProgress, loadEnvironments])

  const handleStart = async (envId: string) => {
    setActionInProgress(prev => new Set(prev).add(envId))
    try {
      await window.api.env.start(envId)
      loadEnvironments()
    } catch (err) {
      console.error('Failed to start environment:', err)
    } finally {
      setActionInProgress(prev => {
        const next = new Set(prev)
        next.delete(envId)
        return next
      })
      // Refresh immediately after start completes, plus a delayed refresh
      // to catch services transitioning from 'starting' to 'running'
      loadEnvironments()
      setTimeout(loadEnvironments, 3000)
    }
  }

  const handleStop = async (envId: string) => {
    setActionInProgress(prev => new Set(prev).add(envId))
    try {
      await window.api.env.stop(envId)
      loadEnvironments()
    } catch (err) {
      console.error('Failed to stop environment:', err)
    } finally {
      setActionInProgress(prev => {
        const next = new Set(prev)
        next.delete(envId)
        return next
      })
      // Refresh immediately after stop completes
      loadEnvironments()
    }
  }

  const handleTeardown = async (envId: string) => {
    setConfirmTeardown(envId)
  }

  const executeTeardown = async (envId: string) => {
    setConfirmTeardown(null)
    setActionInProgress(prev => new Set(prev).add(envId))
    try {
      await window.api.env.teardown(envId)
      loadEnvironments()
    } catch (err) {
      console.error('Failed to teardown environment:', err)
    } finally {
      setActionInProgress(prev => {
        const next = new Set(prev)
        next.delete(envId)
        return next
      })
    }
  }

  // Bulk-load purpose tags when environment list changes (for filtering)
  useEffect(() => {
    if (environments.length === 0) return
    environments.forEach(env => {
      window.api.env.manifest(env.id).then((m: any) => {
        const tag = (m?.meta?.purposeTag as 'interactive' | 'background' | 'nightly') || null
        setPurposeTags(prev => ({ ...prev, [env.id]: tag }))
      }).catch(() => {})
    })
  }, [environments])

  // Load restart policy and purpose tag when an environment card is expanded
  useEffect(() => {
    if (!expandedId) return
    window.api.env.manifest(expandedId).then((m: any) => {
      const policy = (m?.meta?.restartPolicy as 'manual' | 'on-crash') || 'manual'
      setRestartPolicies(prev => ({ ...prev, [expandedId]: policy }))
      const tag = (m?.meta?.purposeTag as 'interactive' | 'background' | 'nightly') || null
      setPurposeTags(prev => ({ ...prev, [expandedId]: tag }))
    }).catch(() => {})
  }, [expandedId])

  // Poll setup progress for environments in creating/error state
  // Close fix dropdown when clicking outside
  useEffect(() => {
    if (!fixMenuOpen) return
    const close = () => setFixMenuOpen(null)
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [fixMenuOpen])

  useEffect(() => {
    const creating = environments.filter(e => e.status === 'creating' || e.status === 'error')
    if (creating.length === 0) return
    const poll = async () => {
      for (const env of creating) {
        try {
          const m = await window.api.env.manifest(env.id)
          if (m?.setup?.steps) {
            setSetupSteps(prev => ({ ...prev, [env.id]: m.setup.steps }))
          }
          if (m?.setup?.error) {
            setSetupError(prev => ({ ...prev, [env.id]: m.setup.error }))
          }
        } catch { /* skip */ }
      }
    }
    poll()
    const interval = setInterval(poll, 2000)
    return () => clearInterval(interval)
  }, [environments])

  const handleOpenUrl = (url: string) => {
    window.api.shell.openExternal(url)
  }

  const handleEditTemplateWithAI = async (t: EnvironmentTemplate) => {
    try {
      const full = await window.api.env.getTemplate(t.id)
      const templateJson = JSON.stringify(full, null, 2)
      const safeName = t.name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()
      const templatePath = `~/.claude-colony/environment-templates/${safeName}.json`

      const systemPrompt = buildTemplateEditPrompt(t.name, templatePath, templateJson)

      let promptArgs: string[]
      try {
        const promptFile = await window.api.fs.writeTempFile(`tpl-edit-${safeName}`, systemPrompt)
        promptArgs = ['--append-system-prompt-file', promptFile]
      } catch {
        promptArgs = ['--append-system-prompt', systemPrompt]
      }

      const id = await onLaunchInstance({
        name: `Edit: ${t.name}`,
        color: '#8b5cf6',
        args: promptArgs,
      })

      sendPromptWhenReady(id, {
        prompt: `I want to edit the "${t.name}" environment template. Read the template file at ${templatePath} and tell me what it currently defines, then ask me what I'd like to change.`,
      })

      onFocusInstance(id)
    } catch (err) {
      console.error('Failed to launch template editor:', err)
    }
  }

  const handleDiagnose = async (env: EnvStatus) => {
    try {
      const [manifest, setupLog] = await Promise.all([
        window.api.env.manifest(env.id),
        window.api.env.logs(env.id, 'setup', 200).catch(() => '(no setup log)'),
      ])

      const templateId = manifest?.meta?.templateId as string | undefined
      const template = templateId ? await window.api.env.getTemplate(templateId).catch(() => null) : null
      const isError = env.status === 'error'
      const hasCrashedServices = env.services.some(s => s.status === 'crashed')

      const { systemPrompt, initialPrompt } = buildDiagnosePrompt({
        env, manifest, setupLog, template, isError, hasCrashedServices,
      })

      // Write system prompt to file — too large for CLI arg
      let promptArgs: string[]
      try {
        const promptFile = await window.api.fs.writeTempFile(`env-${env.name}`, systemPrompt)
        promptArgs = ['--append-system-prompt-file', promptFile]
      } catch {
        promptArgs = ['--append-system-prompt', systemPrompt]
      }

      const id = await onLaunchInstance({
        name: `${isError ? 'Diagnose' : 'Manage'}: ${env.displayName || env.name}`,
        workingDirectory: env.paths.root || undefined,
        color: isError ? '#ef4444' : '#8b5cf6',
        args: promptArgs,
      })

      sendPromptWhenReady(id, { prompt: initialPrompt })

      onFocusInstance(id)
    } catch (err) {
      console.error('Failed to launch environment agent:', err)
    }
  }

  const running = environments.filter(e => e.status === 'running').length
  const stopped = environments.filter(e => e.status === 'stopped').length
  const partial = environments.filter(e => e.status === 'partial' || e.status === 'creating').length

  if (logViewEnv) {
    return (
      <EnvironmentLogViewer
        envId={logViewEnv.envId}
        envName={logViewEnv.envName}
        serviceNames={logViewEnv.serviceNames}
        onBack={() => setLogViewEnv(null)}
      />
    )
  }

  return (
    <div className="env-panel">
      {/* Header */}
      <div className="panel-header">
        <h2><Server size={16} /> Environments</h2>
        <div className="panel-header-tabs">
          <button
            className={`panel-header-tab ${activeTab === 'instances' ? 'active' : ''}`}
            onClick={() => setActiveTab('instances')}
            title="Running and stopped environments (Cmd+Shift+{ / Cmd+Shift+})"
          >
            Instances {environments.length > 0 && <span className="panel-header-count">{environments.length}</span>}
          </button>
          <button
            className={`panel-header-tab ${activeTab === 'templates' ? 'active' : ''}`}
            onClick={() => setActiveTab('templates')}
            title="Environment templates (Cmd+Shift+{ / Cmd+Shift+})"
          >
            Templates {templates.length > 0 && <span className="panel-header-count">{templates.length}</span>}
          </button>
        </div>
        <div className="panel-header-spacer" />
        <HelpPopover topic="environments" align="right" />
        <div className="panel-header-actions">
          {activeTab === 'instances' && (
            <>
              <button
                className={`panel-header-btn${listMode ? ' active' : ''}`}
                title={listMode ? 'Switch to card view' : 'Switch to list view'}
                onClick={() => { const next = !listMode; setListMode(next); localStorage.setItem('envs-list-mode', next ? '1' : '0') }}
              >
                {listMode ? <LayoutGrid size={13} /> : <LayoutList size={13} />}
              </button>
              <button className="panel-header-btn primary" onClick={() => { setCreateDialogMode('instance'); setCreateDialogTemplate(null); setShowCreateDialog(true) }}>
                <Plus size={14} /> New Environment
              </button>
            </>
          )}
          {activeTab === 'templates' && (
            <>
              <button className={`panel-header-btn ${refreshing ? 'env-btn-spinning' : ''}`} onClick={refreshTemplates} disabled={refreshing} title="Fetch repos and re-scan for .colony/ configs">
                <RefreshCw size={13} className={refreshing ? 'spin' : ''} /> {refreshing ? 'Scanning...' : 'Refresh'}
              </button>
              <button className="panel-header-btn" onClick={async () => {
                const input = document.createElement('input')
                input.type = 'file'
                input.accept = '.json'
                input.onchange = async (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0]
                  if (!file) return
                  const text = await file.text()
                  try {
                    const template = JSON.parse(text)
                    if (!template.id || !template.name) throw new Error('Invalid template: missing id or name')
                    await window.api.env.saveTemplate(template)
                    loadTemplates()
                  } catch (err: any) { alert(`Import failed: ${err.message}`) }
                }
                input.click()
              }}>
                <Upload size={13} /> Import
              </button>
              <button className="panel-header-btn primary" onClick={() => { setCreateDialogMode('template'); setCreateDialogTemplate(null); setShowCreateDialog(true) }}>
                <Plus size={14} /> New Template
              </button>
            </>
          )}
        </div>
      </div>

      {activeTab === 'instances' && <>
      {/* Environment list */}
      <div className={`env-list${listMode ? ' list-mode' : ''}`}>
        {environments.length > 0 && (
          <div className="env-panel-badges">
            {running > 0 && <span className="env-badge env-badge-running">{running} running</span>}
            {stopped > 0 && <span className="env-badge env-badge-stopped">{stopped} stopped</span>}
            {partial > 0 && <span className="env-badge env-badge-partial">{partial} partial</span>}
            {(['interactive', 'background', 'nightly'] as const).filter(t => Object.values(purposeTags).includes(t)).map(t => (
              <button
                key={t}
                className={`env-purpose-filter-btn env-purpose-${t}${tagFilter === t ? ' active' : ''}`}
                onClick={() => setTagFilter(prev => prev === t ? null : t)}
                title={tagFilter === t ? `Clear ${t} filter` : `Show only ${t} environments`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
        {environments.length === 0 && (
          <EmptyStateHook
            icon={Server}
            title="Environments"
            hook="No environments yet. A sandboxed stack — backend + frontend + workers."
            keyCap="E"
            cta={{ label: 'New Environment', onClick: () => setShowCreateDialog(true) }}
          />
        )}

        {environments.filter(env => !tagFilter || purposeTags[env.id] === tagFilter).map(env => {
          const isExpanded = expandedId === env.id
          const isLoading = actionInProgress.has(env.id)

          return (
            <div key={env.id} className={`env-card env-card-${env.status}${expandedId === env.id ? ' expanded' : ''}`}>
              {/* Live setup progress */}
              {(env.status === 'creating' || env.status === 'error') && (
                <div className="env-setup-tracker">
                  <div className="env-setup-tracker-header">
                    {env.status === 'creating' && <><Loader size={12} className="spinning" /> Setting up...</>}
                    {env.status === 'error' && <><AlertTriangle size={12} /> Setup failed</>}
                  </div>
                  {(setupSteps[env.id] || []).map((step, i) => (
                    <div key={i} className={`env-setup-step env-setup-step-${step.status}`}>
                      <span className="env-setup-step-icon">
                        {step.status === 'pending' && <Circle size={10} color="var(--text-muted)" />}
                        {step.status === 'running' && <Loader size={10} className="spinning" />}
                        {step.status === 'done' && <CheckCircle size={10} />}
                        {step.status === 'error' && <AlertTriangle size={10} />}
                        {step.status === 'skipped' && <SkipForward size={10} color="var(--text-muted)" />}
                      </span>
                      <span className="env-setup-step-name">{step.name}</span>
                      {step.error && (
                        <Tooltip text="Error" detail={step.error} position="bottom">
                          <span className="env-setup-step-error">{step.error.slice(0, 80)}</span>
                        </Tooltip>
                      )}
                    </div>
                  ))}
                  {setupError[env.id] && (
                    <Tooltip text="Setup Error" detail={setupError[env.id]} position="bottom">
                      <div className="env-setup-error-detail">{setupError[env.id].slice(0, 120)}</div>
                    </Tooltip>
                  )}
                  {env.status === 'error' && (
                    <div className="env-setup-recovery">
                      <button className="env-btn env-btn-primary env-btn-sm" onClick={() => handleDiagnose(env)}>
                        <Wrench size={11} /> Diagnose
                      </button>
                      <button className="env-btn env-btn-secondary env-btn-sm" onClick={() => setLogViewEnv({ envId: env.id, envName: env.name, serviceNames: ['setup', ...env.services.map(s => s.name)] })}>
                        <FileText size={11} /> View Log
                      </button>
                      <button className="env-btn env-btn-secondary env-btn-sm" onClick={async () => {
                        try {
                          // Reset steps to pending and re-run setup
                          const m = await window.api.env.manifest(env.id)
                          if (m?.setup) {
                            m.setup.status = 'creating'
                            m.setup.error = null
                            if (m.setup.steps) m.setup.steps.forEach((s: any) => { if (s.status === 'error' || s.status === 'skipped') { s.status = 'pending'; s.error = undefined } })
                            await window.api.env.saveManifest(env.id, m)
                          }
                          // Re-trigger setup
                          await window.api.env.retrySetup(env.id)
                          loadEnvironments()
                        } catch (err: any) { console.error('Retry failed:', err) }
                      }}>
                        <RefreshCw size={11} /> Retry Setup
                      </button>
                      <button className="env-btn env-btn-secondary env-btn-sm" onClick={async () => {
                        if (!confirm('Force environment to ready state without re-running setup? Only use this if you\'ve resolved the issue manually.')) return
                        try {
                          const m = await window.api.env.manifest(env.id)
                          if (m?.setup) {
                            m.setup.status = 'ready'
                            m.setup.error = null
                            await window.api.env.saveManifest(env.id, m)
                          }
                          loadEnvironments()
                        } catch (err: any) { console.error('Force ready failed:', err) }
                      }}>
                        <CheckCircle size={11} /> Mark as Ready
                      </button>
                      <button className="env-btn env-btn-ghost env-btn-sm" onClick={() => handleTeardown(env.id)}>
                        <Trash2 size={11} /> Teardown
                      </button>
                    </div>
                  )}
                </div>
              )}
              {/* Card header */}
              <div
                className="env-card-header"
                onClick={() => setExpandedId(isExpanded ? null : env.id)}
              >
                <div className="env-card-expand">
                  {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>

                <div className="env-card-status-dot" style={{ backgroundColor: statusColor(env.status) }} />

                <div className="env-card-info">
                  <div className="env-card-name">
                    {env.displayName || env.name}
                    {purposeTags[env.id] && (
                      <span className={`env-purpose-badge env-purpose-${purposeTags[env.id]}`}>
                        {purposeTags[env.id]}
                      </span>
                    )}
                  </div>
                  <div className="env-card-meta">
                    <span className="env-card-branch">{env.branch}</span>
                    {env.projectType && <span className="env-card-type">{env.projectType}</span>}
                  </div>
                </div>

                {/* Service dots */}
                <div className="env-card-services">
                  {env.services.map(svc => (
                    <Tooltip
                      key={svc.name}
                      text={svc.name}
                      detail={`${svc.port ? `port ${svc.port}` : ''}${svc.restarts > 0 ? ` · ${svc.restarts} restart${svc.restarts > 1 ? 's' : ''}` : ''}`}
                    >
                      <span className="env-service-dot-row">
                        <div
                          className={`env-service-dot env-service-dot-${svc.status}`}
                          style={{ backgroundColor: serviceStatusColor(svc.status) }}
                        />
                        <span className="env-service-status-label">{svc.status}</span>
                      </span>
                    </Tooltip>
                  ))}
                </div>

                {/* Actions */}
                <div className="env-card-actions" onClick={e => e.stopPropagation()}>
                  {(env.status === 'stopped' || env.status === 'partial') && (
                    <Tooltip text={isLoading ? 'Starting…' : 'Start'} detail="Launch all services">
                      <button
                        className="env-action-btn env-action-start env-action-labeled"
                        onClick={() => handleStart(env.id)}
                        disabled={isLoading}
                      >
                        <Play size={13} />
                        {isLoading ? 'Starting…' : 'Start'}
                      </button>
                    </Tooltip>
                  )}
                  {(env.status === 'running' || env.status === 'partial') && (
                    <Tooltip text={isLoading ? 'Stopping…' : 'Stop'} detail="Halt all services">
                      <button
                        className="env-action-btn env-action-stop env-action-labeled"
                        onClick={() => handleStop(env.id)}
                        disabled={isLoading}
                      >
                        <Square size={13} />
                        {isLoading ? 'Stopping…' : 'Stop'}
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip text="Terminal" detail="Open Claude session in this environment">
                    <button
                      className="env-action-btn"
                      onClick={async () => {
                        if (env.status === 'stopped') {
                          try { await window.api.env.start(env.id); loadEnvironments() } catch { /* ignore */ }
                        }
                        const envContext = `You are working in the "${env.name}" environment.\n\nUpstream branch: ${env.branch} (use for fetching updates and rebasing — do NOT check this branch out)\nServices: ${env.services.map(s => `${s.name} (${s.status})`).join(', ')}\nPorts: ${Object.entries(env.ports).map(([k,v]) => `${k}:${v}`).join(', ')}\nURLs: ${Object.entries(env.urls).map(([k,v]) => `${k}: ${v}`).join(', ')}\nPaths: ${Object.entries(env.paths).map(([k,v]) => `${k}: ${v}`).join(', ')}\n\n## Git workflow for this environment\n- Run \`git branch\` to see what branch you are currently on.\n- You will typically be on a feature branch. Stay on it. Do NOT switch to ${env.branch} or any other branch.\n- To get upstream changes: \`git fetch origin ${env.branch} && git rebase origin/${env.branch}\`\n- When pushing, push the current branch: \`git push origin HEAD\`\n- Only create a new branch if the user explicitly asks for one.\n\nThe instance.json manifest is at ${env.paths.root || ''}/instance.json. You can read it for full configuration details.`
                        onLaunchInstance({
                          name: `Env: ${env.displayName || env.name}`,
                          workingDirectory: env.paths.root || env.paths.backend || undefined,
                          color: '#10b981',
                          args: ['--append-system-prompt', envContext],
                        })
                      }}
                    >
                      <Terminal size={14} />
                    </button>
                  </Tooltip>
                  {env.paths.root && (
                    <Tooltip text="Open Folder" detail="Open environment directory in Finder">
                      <button
                        className="env-action-btn"
                        onClick={() => window.api.shell.openExternal(`file://${env.paths.root}`)}
                      >
                        <FolderOpen size={14} />
                      </button>
                    </Tooltip>
                  )}
                  <div className="env-fix-dropdown-wrap">
                    <Tooltip text="Fix" detail="Repair environment configuration">
                      <button
                        className="env-action-btn"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (fixMenuOpen === env.id) { setFixMenuOpen(null) }
                          else {
                            setFixMenuRect((e.currentTarget as HTMLElement).getBoundingClientRect())
                            setFixMenuOpen(env.id)
                          }
                        }}
                        disabled={isLoading}
                      >
                        <Stethoscope size={14} />
                      </button>
                    </Tooltip>
                    {fixMenuOpen === env.id && fixMenuRect != null && (
                      <div className="env-fix-dropdown" onClick={e => e.stopPropagation()} style={{
                        position: 'fixed',
                        top: (fixMenuRect?.bottom ?? 0) + 4,
                        left: Math.max(8, (fixMenuRect?.right ?? 240) - 240),
                      }}>
                        <button className="env-fix-dropdown-item" onClick={async () => {
                          setFixMenuOpen(null)
                          try {
                            setActionInProgress(prev => new Set(prev).add(env.id))
                            setFixResult(null)
                            await window.api.env.stop(env.id).catch(() => {})
                            const result = await window.api.env.fix(env.id)
                            setFixResult({ envId: env.id, lines: result.fixed })
                            setTimeout(() => setFixResult(prev => prev?.envId === env.id ? null : prev), 8000)
                            loadEnvironments()
                          } catch (err: any) {
                            setFixResult({ envId: env.id, lines: [err.message || String(err)], isError: true })
                            setTimeout(() => setFixResult(prev => prev?.envId === env.id ? null : prev), 8000)
                          } finally {
                            setActionInProgress(prev => { const s = new Set(prev); s.delete(env.id); return s })
                          }
                        }}>
                          <RefreshCw size={12} />
                          <div>
                            <div className="env-fix-dropdown-title">Quick Fix</div>
                            <div className="env-fix-dropdown-desc">Re-resolve ports and variables from template</div>
                          </div>
                        </button>
                        <button className="env-fix-dropdown-item" onClick={() => {
                          setFixMenuOpen(null)
                          handleDiagnose(env)
                        }}>
                          <MessageSquare size={12} />
                          <div>
                            <div className="env-fix-dropdown-title">Diagnose with AI</div>
                            <div className="env-fix-dropdown-desc">Launch AI agent with logs and manifest context</div>
                          </div>
                        </button>
                      </div>
                    )}
                  </div>
                  <Tooltip text="Logs" detail="View service output">
                    <button
                      className="env-action-btn"
                      onClick={() => setLogViewEnv({ envId: env.id, envName: env.name, serviceNames: ['setup', ...env.services.map(s => s.name)] })}
                    >
                      <FileText size={14} />
                    </button>
                  </Tooltip>
                  <Tooltip text="Teardown" detail="Stop and delete environment">
                    <button
                      className="env-action-btn env-action-teardown"
                      onClick={() => handleTeardown(env.id)}
                      disabled={isLoading}
                    >
                      <Trash2 size={14} />
                    </button>
                  </Tooltip>
                </div>
              </div>

              {/* Fix result banner */}
              {fixResult != null && fixResult.envId === env.id && (
                <div className={`env-fix-result ${fixResult.isError ? 'env-fix-error' : 'env-fix-success'}`}>
                  <div className="env-fix-result-header">
                    {fixResult.isError ? <AlertTriangle size={13} /> : <CheckCircle size={13} />}
                    <span>{fixResult.isError ? 'Fix failed' : 'Environment fixed'}</span>
                    <button className="env-fix-dismiss" onClick={() => setFixResult(null)}><X size={11} /></button>
                  </div>
                  <div className="env-fix-result-items">
                    {fixResult.lines.map((line, i) => <div key={i}>{line}</div>)}
                  </div>
                </div>
              )}

              {/* Expanded details */}
              {isExpanded && (
                <div className="env-card-details">
                  {/* URLs */}
                  {Object.keys(env.urls).length > 0 && (
                    <div className="env-detail-section">
                      <div className="env-detail-label">URLs</div>
                      <div className="env-detail-urls">
                        {Object.entries(env.urls).map(([key, url]) => (
                          <button
                            key={key}
                            className="env-url-link"
                            onClick={() => handleOpenUrl(url)}
                          >
                            <ExternalLink size={12} />
                            {key}: {url}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Services */}
                  <div className="env-detail-section">
                    <div className="env-detail-label">Services</div>
                    <div className="env-services-list">
                      {env.services.map(svc => (
                        <div key={svc.name} className="env-service-row">
                          <Circle
                            size={8}
                            fill={serviceStatusColor(svc.status)}
                            color={serviceStatusColor(svc.status)}
                          />
                          <span className="env-service-name">{svc.name}</span>
                          <span className="env-service-status">{svc.status}</span>
                          {svc.port && <span className="env-service-port">:{svc.port}</span>}
                          {svc.uptime > 0 && (
                            <span className="env-service-uptime">
                              <Clock size={10} /> {formatUptime(svc.uptime)}
                            </span>
                          )}
                          {svc.restarts > 0 && (
                            <Tooltip text={`${svc.restarts} restart${svc.restarts > 1 ? 's' : ''}`} detail={`Service crashed and was restarted ${svc.restarts} time${svc.restarts > 1 ? 's' : ''}. Check logs for details.`}>
                              <span className="env-service-restarts">
                                <AlertTriangle size={10} /> {svc.restarts}
                              </span>
                            </Tooltip>
                          )}
                          <div className="env-service-actions">
                            {(svc.status === 'stopped' || svc.status === 'crashed') && (
                              <button className="env-service-btn" onClick={() => { window.api.env.start(env.id, [svc.name]).then(loadEnvironments).then(() => setTimeout(loadEnvironments, 3000)) }} title={`Start ${svc.name}`}>
                                <Play size={11} />
                              </button>
                            )}
                            {svc.status === 'running' && (
                              <button className="env-service-btn" onClick={() => { window.api.env.stop(env.id, [svc.name]).then(loadEnvironments) }} title={`Stop ${svc.name}`}>
                                <Square size={11} />
                              </button>
                            )}
                            <button className="env-service-btn" onClick={() => { window.api.env.restartService(env.id, svc.name).then(loadEnvironments).then(() => setTimeout(loadEnvironments, 3000)) }} title={`Restart ${svc.name}`}>
                              <RefreshCw size={11} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Auto-restart policy */}
                  <div className="env-detail-section env-detail-section-row">
                    <label className="env-restart-toggle" title="When enabled, crashed services automatically restart after 5 seconds">
                      <input
                        type="checkbox"
                        checked={(restartPolicies[env.id] || 'manual') === 'on-crash'}
                        onChange={async (e) => {
                          const policy = e.target.checked ? 'on-crash' : 'manual'
                          setRestartPolicies(prev => ({ ...prev, [env.id]: policy }))
                          await window.api.env.setRestartPolicy(env.id, policy)
                        }}
                      />
                      <span className="env-restart-toggle-label">Auto-restart crashed services</span>
                    </label>
                  </div>

                  {/* Purpose tag */}
                  <div className="env-detail-section env-detail-section-row">
                    <span className="env-restart-toggle-label" style={{ marginRight: 8 }}>Purpose:</span>
                    <div className="env-purpose-selector">
                      {(['interactive', 'background', 'nightly', null] as const).map(tag => (
                        <button
                          key={tag ?? 'none'}
                          className={`env-purpose-btn${(purposeTags[env.id] || null) === tag ? ' active' : ''}`}
                          onClick={async () => {
                            setPurposeTags(prev => ({ ...prev, [env.id]: tag }))
                            await window.api.env.setPurposeTag(env.id, tag)
                          }}
                        >
                          {tag ?? 'none'}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Ports */}
                  <div className="env-detail-section">
                    <div className="env-detail-label">Ports</div>
                    <div className="env-detail-ports">
                      {Object.entries(env.ports).map(([key, port]) => (
                        <span key={key} className="env-port-badge">{key}: {port}</span>
                      ))}
                    </div>
                  </div>

                  {/* Paths */}
                  <div className="env-detail-section">
                    <div className="env-detail-label">Paths</div>
                    <div className="env-detail-paths">
                      {Object.entries(env.paths).map(([key, p]) => (
                        <div key={key} className="env-path-row">
                          <span className="env-path-key">{key}:</span>
                          <span className="env-path-value">{p}</span>
                        </div>
                      ))}
                    </div>
                  </div>

                </div>
              )}
            </div>
          )
        })}
      </div>

      </>}

      {/* Templates tab */}
      {activeTab === 'templates' && (
        <div className="env-list">
          {templates.length === 0 && (
            <div className="env-empty">
              <Server size={32} />
              <p>No templates yet</p>
              <p className="env-empty-detail">Create a template by launching an Instance Agent to explore a project.</p>
            </div>
          )}
          {templates.map(t => {
            const isExpanded = expandedId === t.id
            const isEditing = editingTemplateJson?.id === t.id
            const serviceNames = Object.keys(t.services || {})
            const branches = (t as any).branches
            return (
              <div key={t.id} className={`env-tpl-card ${isExpanded ? 'expanded' : ''}`}>
                {/* Header */}
                <div className="env-tpl-header" onClick={() => { setExpandedId(isExpanded ? null : t.id); if (!isExpanded) setEditingTemplateJson(null) }}>
                  {isExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <div className="env-tpl-title">
                    <span className="env-tpl-name">{t.name}</span>
                    {t.projectType && <span className="env-tpl-type">{t.projectType}</span>}
                    {t.source && t.source !== 'user' && (
                      <span className="env-tpl-source" title={`From ${t.source}`}>{t.source.replace('repo:', '')}</span>
                    )}
                  </div>
                  <button className="env-btn env-btn-primary env-btn-sm" onClick={(e) => { e.stopPropagation(); setCreateDialogMode('instance'); setCreateDialogTemplate(t); setShowCreateDialog(true) }}>
                    <Plus size={11} /> New Instance
                  </button>
                </div>

                {/* Summary row — always visible */}
                {t.description && <div className="env-tpl-desc">{t.description}</div>}
                <div className="env-tpl-summary">
                  {/* Repos */}
                  <div className="env-tpl-section">
                    <span className="env-tpl-label">Repos</span>
                    <div className="env-tpl-chips">
                      {(t.repos || []).map(r => (
                        <span key={r.as} className="env-tpl-chip">
                          <FolderOpen size={10} /> {r.name} <span className="env-tpl-chip-role">{r.as}</span>
                        </span>
                      ))}
                    </div>
                  </div>
                  {/* Services */}
                  <div className="env-tpl-section">
                    <span className="env-tpl-label">Services</span>
                    <div className="env-tpl-chips">
                      {serviceNames.map(name => (
                        <span key={name} className="env-tpl-chip env-tpl-chip-service">
                          <Circle size={6} fill="var(--text-muted)" color="var(--text-muted)" /> {name}
                        </span>
                      ))}
                    </div>
                  </div>
                  {/* Branch */}
                  {branches?.default && (
                    <div className="env-tpl-section">
                      <span className="env-tpl-label">Branch</span>
                      <span className="env-tpl-value">{branches.default}</span>
                      {branches.alternatives?.length > 0 && (
                        <span className="env-tpl-alt">also: {branches.alternatives.join(', ')}</span>
                      )}
                    </div>
                  )}
                </div>

                {/* Expanded details */}
                {isExpanded && (
                  <div className="env-tpl-expanded">
                    <div className="env-tpl-actions">
                      <button className="env-btn env-btn-primary env-btn-sm" onClick={(e) => { e.stopPropagation(); handleEditTemplateWithAI(t) }}>
                        <Wrench size={11} /> Edit with AI
                      </button>
                      <button className={`env-btn env-btn-secondary env-btn-sm ${isEditing ? 'active' : ''}`} onClick={() => {
                        if (isEditing) { setEditingTemplateJson(null) }
                        else { window.api.env.getTemplate(t.id).then((full: any) => { setEditingTemplateJson({ id: t.id, content: JSON.stringify(full, null, 2), dirty: false }) }) }
                      }}>
                        <FileText size={11} /> {isEditing ? 'Hide JSON' : 'Edit JSON'}
                      </button>
                      <button className="env-btn env-btn-ghost env-btn-sm" onClick={async () => {
                        setConfirmTeardown(`tpl-${t.id}`)
                      }}>
                        <Trash2 size={11} /> Delete
                      </button>
                      <button className="env-btn env-btn-ghost env-btn-sm" onClick={async () => {
                        const full = await window.api.env.getTemplate(t.id)
                        const blob = new Blob([JSON.stringify(full, null, 2)], { type: 'application/json' })
                        const url = URL.createObjectURL(blob)
                        const a = document.createElement('a')
                        a.href = url; a.download = `${t.name.replace(/[^a-zA-Z0-9_-]/g, '-')}.json`; a.click()
                        URL.revokeObjectURL(url)
                      }}>
                        <Download size={11} /> Export
                      </button>
                      <span className="env-tpl-created">Created {new Date(t.createdAt).toLocaleDateString()}</span>
                    </div>

                    {isEditing && editingTemplateJson && (
                      <div className="env-template-editor">
                        <textarea
                          className="env-template-json"
                          value={editingTemplateJson.content}
                          onChange={(e) => setEditingTemplateJson({ ...editingTemplateJson, content: e.target.value, dirty: true })}
                          spellCheck={false}
                          placeholder="Paste or edit template JSON here..."
                        />
                        {editingTemplateJson.dirty && (
                          <button className="env-btn env-btn-primary env-btn-sm" onClick={async () => {
                            try {
                              const parsed = JSON.parse(editingTemplateJson.content)
                              await window.api.env.saveTemplate(parsed)
                              setEditingTemplateJson({ ...editingTemplateJson, dirty: false })
                              loadTemplates()
                            } catch (err: any) {
                              alert(`Invalid JSON: ${err.message}`)
                            }
                          }}>
                            Save
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Create dialog (unified: template or instance mode) */}
      {showCreateDialog && (
        <NewEnvironmentDialog
          onClose={() => setShowCreateDialog(false)}
          onCreated={() => {
            setShowCreateDialog(false)
            loadTemplates()
            loadEnvironments()
          }}
          onLaunchInstance={onLaunchInstance}
          onFocusInstance={onFocusInstance}
          mode={createDialogMode}
          preselectedTemplate={createDialogTemplate}
        />
      )}


      {/* Delete/teardown confirmation modal */}
      {confirmTeardown && (() => {
        const isTemplate = confirmTeardown.startsWith('tpl-')
        const templateId = isTemplate ? confirmTeardown.slice(4) : null
        const env = !isTemplate ? environments.find(e => e.id === confirmTeardown) : null
        const tpl = isTemplate ? templates.find(t => t.id === templateId) : null
        const itemName = env?.name || tpl?.name || confirmTeardown
        return (
          <div className="env-dialog-overlay" onClick={() => setConfirmTeardown(null)}>
            <div className="env-dialog" onClick={e => e.stopPropagation()}>
              <div className="env-dialog-header">
                <h3>{isTemplate ? 'Delete Template' : 'Teardown Environment'}</h3>
                <button className="env-btn env-btn-ghost" onClick={() => setConfirmTeardown(null)}><X size={16} /></button>
              </div>
              <p className="env-dialog-description">
                {isTemplate
                  ? <>Delete template <strong>{itemName}</strong>? Existing instances created from it will not be affected.</>
                  : <>This will <strong>stop all services</strong>, <strong>drop the database</strong>, and <strong>delete all files</strong> for <strong>{itemName}</strong>. This cannot be undone.</>
                }
              </p>
              <div className="env-dialog-actions">
                <button className="env-btn env-btn-secondary" onClick={() => setConfirmTeardown(null)}>Cancel</button>
                <button className="env-btn env-btn-danger" onClick={async () => {
                  if (isTemplate && templateId) {
                    await window.api.env.deleteTemplate(templateId)
                    loadTemplates()
                  } else {
                    await executeTeardown(confirmTeardown)
                  }
                  setConfirmTeardown(null)
                }}>
                  <Trash2 size={13} /> {isTemplate ? 'Delete' : 'Teardown'}
                </button>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}
