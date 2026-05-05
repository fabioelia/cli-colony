import { useState, useEffect, useRef, useCallback } from 'react'
import { ChevronDown, ChevronRight, CheckCircle, XCircle, ListTodo, Loader } from 'lucide-react'
import type { AgentDef, CliBackend } from '../types'
import type { JiraTicket, JiraTicketSummary, PlaybookDef, PlaybookInput, SessionPreset } from '../../../shared/types'
import { resolveMustacheTemplate } from '../../../shared/utils'
import { COLORS, COLOR_MAP } from '../lib/constants'
import { getHistory, addToHistory } from '../lib/prompt-history'
import { extractTicketKey } from '../../../shared/ticket-commit-format'

export interface CloneSource {
  name: string
  workingDirectory: string
  color: string
  cliBackend: CliBackend
  permissionMode?: 'autonomous' | 'supervised' | 'auto'
  mcpServers: string[]
  args: string[]
}

function cloneName(name: string): string {
  const match = name.match(/^(.+)\s+\((\d+)\)$/)
  if (match) return `${match[1]} (${parseInt(match[2]) + 1})`
  return `${name} (2)`
}

interface Props {
  onCreate: (opts: {
    name?: string
    workingDirectory?: string
    color?: string
    args?: string[]
    cliBackend?: CliBackend
    mcpServers?: string[]
    initialPrompt?: string
    permissionMode?: 'autonomous' | 'supervised' | 'auto'
    planFirst?: boolean
    env?: Record<string, string>
    jiraTicket?: JiraTicket
    tags?: string[]
    playbook?: string
  }) => void | Promise<void>
  onClose: () => void
  prefill?: AgentDef
  /**
   * Seed text for the optional "First prompt" textarea. When set (even to an
   * empty string), the prompt field is rendered and the provided text becomes
   * the initial value. Used by the Sessions empty-state starter cards.
   */
  initialPrompt?: string
  /**
   * Seed for the working-directory input. Lets callers (e.g. the starter
   * cards) pre-populate the folder the session will run in.
   */
  initialWorkingDirectory?: string
  /** Pre-fill all fields from a source session (Clone action). */
  cloneSource?: CloneSource
  /** Config inherited from a previous session (Continue action). */
  seedModel?: string
  seedAgent?: string
  seedPermissionMode?: 'autonomous' | 'supervised' | 'auto'
  seedMcpServers?: string[]
  seedEffort?: string
  seedName?: string
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  const days = Math.floor(hrs / 24)
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

function resolveColor(c?: string): string {
  if (!c) return COLORS[0]
  return COLOR_MAP[c] || c
}

interface EnvOption {
  id: string
  name: string
  paths: Record<string, string>
  branch: string
  status: string
}

interface McpServer {
  name: string
  command?: string
  url?: string
  description?: string
}

export default function NewInstanceDialog({ onCreate, onClose, prefill, initialPrompt, initialWorkingDirectory, cloneSource, seedModel, seedAgent, seedPermissionMode, seedMcpServers, seedEffort, seedName }: Props) {
  const [name, setName] = useState(cloneSource ? cloneName(cloneSource.name) : seedName || prefill?.name || '')
  const [workingDirectory, setWorkingDirectory] = useState(cloneSource?.workingDirectory || initialWorkingDirectory || '')
  const [color, setColor] = useState(cloneSource ? resolveColor(cloneSource.color) : resolveColor(prefill?.color))
  const [model, setModel] = useState(() => {
    const src = cloneSource?.args || prefill?.args || []
    for (let i = 0; i < src.length; i++) {
      if (src[i] === '--model' && src[i + 1]) return src[i + 1]
    }
    return seedModel || ''
  })
  const [extraArgs, setExtraArgs] = useState(() => {
    if (!cloneSource) return ''
    const filtered: string[] = []
    for (let i = 0; i < cloneSource.args.length; i++) {
      if (cloneSource.args[i] === '--resume') { i++; continue } // skip --resume and its value
      if (cloneSource.args[i] === '--model') { i++; continue } // skip --model (now in dropdown)
      if (cloneSource.args[i] === '--agent') { i++; continue } // skip --agent (now in dropdown)
      if (cloneSource.args[i] === '--effort') { i++; continue } // skip --effort (now in dropdown)
      filtered.push(cloneSource.args[i])
    }
    return filtered.join(' ')
  })
  const [effort, setEffort] = useState<string>(() => {
    if (cloneSource) {
      const i = cloneSource.args.indexOf('--effort')
      return i >= 0 ? cloneSource.args[i + 1] || '' : ''
    }
    return seedEffort || ''
  })
  const [cliBackend, setCliBackend] = useState<CliBackend>(cloneSource?.cliBackend || 'claude')
  const [permissionMode, setPermissionMode] = useState<'autonomous' | 'supervised' | 'auto'>(cloneSource?.permissionMode || seedPermissionMode || 'autonomous')
  const [creating, setCreating] = useState(false)
  const [environments, setEnvironments] = useState<EnvOption[]>([])
  const [mcpServersList, setMcpServersList] = useState<McpServer[]>([])
  const [selectedMcpServers, setSelectedMcpServers] = useState<Set<string>>(new Set())
  const [planFirst, setPlanFirst] = useState(false)
  // Prompt field is always available. It starts expanded when seeded (clone or
  // starter card) and collapsed behind a toggle in the default "New Session" path.
  const promptSeeded = !!cloneSource || initialPrompt !== undefined
  const [promptExpanded, setPromptExpanded] = useState(promptSeeded)
  const [firstPrompt, setFirstPrompt] = useState(initialPrompt || '')
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyRef = useRef<HTMLDivElement | null>(null)
  const [envVars, setEnvVars] = useState<Array<{ key: string; value: string }>>([])
  const [showEnvVars, setShowEnvVars] = useState(false)
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [selectedAgent, setSelectedAgent] = useState<string>('')  // filePath or empty
  const [jiraKey, setJiraKey] = useState('')
  const [jiraPreview, setJiraPreview] = useState<{ ok: boolean; text: string } | null>(null)
  const [jiraTicket, setJiraTicket] = useState<JiraTicket | null>(null)
  const [jiraConfigured, setJiraConfigured] = useState(false)
  const [jiraTicketKeyPattern, setJiraTicketKeyPattern] = useState('[A-Z]+-\\d+')
  const hasAutoAttached = useRef(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerTickets, setPickerTickets] = useState<JiraTicketSummary[]>([])
  const [pickerLoading, setPickerLoading] = useState(false)
  const [pickerError, setPickerError] = useState<string | null>(null)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const [playbooks, setPlaybooks] = useState<PlaybookDef[]>([])
  const [selectedPlaybook, setSelectedPlaybook] = useState<string>('')
  const [playbookTags, setPlaybookTags] = useState<string[]>([])
  const [playbookInputValues, setPlaybookInputValues] = useState<Record<string, string>>({})
  const [playbookMemoryCount, setPlaybookMemoryCount] = useState<number>(0)
  const [memoryModalOpen, setMemoryModalOpen] = useState(false)
  const [memoryContent, setMemoryContent] = useState('')
  const [memoryEditing, setMemoryEditing] = useState(false)
  const [presets, setPresets] = useState<SessionPreset[]>([])
  const [presetSaving, setPresetSaving] = useState(false)

  // When the starter-card / clone path opens the dialog, focus the prompt
  // textarea and place the cursor at the end so the user can just press Enter.
  // Don't auto-focus when the user manually expands the toggle.
  useEffect(() => {
    if (!promptSeeded) return
    const ta = promptRef.current
    if (!ta) return
    ta.focus()
    const len = ta.value.length
    ta.setSelectionRange(len, len)
  }, [promptSeeded])

  useEffect(() => {
    if (!cloneSource) {
      window.api.settings.getAll().then((s) => {
        setCliBackend(s.defaultCliBackend === 'cursor-agent' ? 'cursor-agent' : 'claude')
        setJiraConfigured(!!s.jiraDomain?.trim())
        if (s.jiraTicketKeyPattern?.trim()) setJiraTicketKeyPattern(s.jiraTicketKeyPattern.trim())
      })
    }
    // Load environments for picker
    window.api.env?.list?.().then((envs: any[]) => {
      if (envs?.length) setEnvironments(envs)
    }).catch(() => {})
    // Load agents
    window.api.agents?.list?.().then((a: AgentDef[]) => {
      if (a?.length) {
        setAgents(a)
        // Pre-select from clone source or seed if --agent was used
        if (cloneSource) {
          const ai = cloneSource.args.indexOf('--agent')
          if (ai >= 0 && cloneSource.args[ai + 1]) {
            const path = cloneSource.args[ai + 1]
            if (a.some(ag => ag.filePath === path)) setSelectedAgent(path)
          }
        } else if (seedAgent) {
          if (a.some(ag => ag.filePath === seedAgent)) setSelectedAgent(seedAgent)
        }
      }
    }).catch(() => {})
    // Load MCP servers
    window.api.mcp?.list?.().then((servers: McpServer[]) => {
      if (servers?.length) {
        setMcpServersList(servers)
        // Pre-select servers from clone source or seed once the list arrives
        if (cloneSource?.mcpServers?.length) {
          const available = new Set(servers.map(s => s.name))
          setSelectedMcpServers(new Set(cloneSource.mcpServers.filter(n => available.has(n))))
        } else if (seedMcpServers?.length) {
          const available = new Set(servers.map(s => s.name))
          setSelectedMcpServers(new Set(seedMcpServers.filter(n => available.has(n))))
        }
      }
    }).catch(() => {})
    // Load playbooks
    window.api.playbooks?.list?.().then((pbs: PlaybookDef[]) => {
      if (pbs?.length) setPlaybooks(pbs)
    }).catch(() => {})
    // Load session presets
    window.api.sessionPresets?.list?.().then((ps: SessionPreset[]) => {
      if (ps?.length) setPresets(ps)
    }).catch(() => {})
  }, [])

  // Auto-attach ticket from branch name when an env chip is clicked or on mount
  // with a pre-set working directory. Non-destructive: skips if jiraKey already set.
  const maybeAutoAttachTicket = (branch: string) => {
    if (!jiraConfigured || !branch || jiraKey.trim() || jiraTicket) return
    const match = extractTicketKey(branch, jiraTicketKeyPattern)
    if (match) {
      setJiraKey(match)
      handleJiraFetch(match)
    }
  }

  // Mount effect: if workingDirectory was pre-set and matches an env, auto-attach ticket.
  // Fires once when environments (async) and jiraConfigured have both loaded.
  useEffect(() => {
    if (hasAutoAttached.current || !workingDirectory || !environments.length || !jiraConfigured) return
    const dir = workingDirectory.trim()
    const env = environments.find(e => dir === (e.paths.root || e.paths.backend || ''))
    if (!env?.branch) return
    hasAutoAttached.current = true
    maybeAutoAttachTicket(env.branch)
  }, [environments, jiraConfigured])

  const handlePickDir = async () => {
    const dir = await window.api.dialog.openDirectory()
    if (dir) setWorkingDirectory(dir)
  }

  const handlePlaybookSelect = (playbookName: string) => {
    setSelectedPlaybook(playbookName)
    setPlaybookInputValues({})
    if (!playbookName) { setPlaybookTags([]); setPlaybookMemoryCount(0); return }
    const pb = playbooks.find(p => p.name === playbookName)
    if (!pb) return
    if (!name.trim()) setName(pb.name)
    if (pb.model) setModel(pb.model)
    if (pb.agent) setSelectedAgent(pb.agent)
    if (pb.workingDirectory && !workingDirectory.trim()) {
      setWorkingDirectory(pb.workingDirectory.replace(/^~/, window.api ? '' : ''))
    }
    if (pb.prompt && !pb.inputs?.length) {
      setFirstPrompt(pb.prompt)
      setPromptExpanded(true)
    }
    if (pb.permissionMode) setPermissionMode(pb.permissionMode)
    setPlaybookTags(pb.tags || [])
    // Pre-fill defaults
    if (pb.inputs?.length) {
      const defaults: Record<string, string> = {}
      for (const inp of pb.inputs) {
        if (inp.default !== undefined) defaults[inp.name] = inp.default
        else if (inp.type === 'boolean') defaults[inp.name] = 'false'
      }
      setPlaybookInputValues(defaults)
    }
    // Load memory line count for badge
    window.api.playbooks?.getMemoryLineCount?.(playbookName)
      .then(count => setPlaybookMemoryCount(count))
      .catch(() => setPlaybookMemoryCount(0))
  }

  const handlePresetSelect = (presetName: string) => {
    const preset = presets.find(p => p.name === presetName)
    if (!preset) return
    if (preset.workingDirectory) setWorkingDirectory(preset.workingDirectory)
    if (preset.model) setModel(preset.model)
    if (preset.extraArgs) setExtraArgs(preset.extraArgs)
    if (preset.agent && agents.some(a => a.filePath === preset.agent)) setSelectedAgent(preset.agent)
    if (preset.permissionMode) setPermissionMode(preset.permissionMode as 'autonomous' | 'supervised' | 'auto')
    if (preset.effort) setEffort(preset.effort)
    if (preset.color) setColor(preset.color)
    if (preset.prompt) { setFirstPrompt(preset.prompt); setPromptExpanded(true) }
  }

  const handleSavePreset = async () => {
    const rawName = window.prompt('Preset name:', name.trim() || 'My Preset')
    if (!rawName?.trim()) return
    const presetName = rawName.trim()
    const existing = presets.find(p => p.name === presetName)
    if (existing && !window.confirm(`Overwrite preset "${presetName}"?`)) return
    setPresetSaving(true)
    const preset: SessionPreset = {
      name: presetName,
      workingDirectory,
      model,
      extraArgs,
      agent: selectedAgent,
      permissionMode,
      effort,
      color,
      prompt: firstPrompt || undefined,
    }
    await window.api.sessionPresets?.save?.(preset)
    const updated = await window.api.sessionPresets?.list?.()
    if (updated) setPresets(updated)
    setPresetSaving(false)
  }

  const handleDeletePreset = async (presetName: string, e: React.MouseEvent) => {
    e.stopPropagation()
    await window.api.sessionPresets?.delete?.(presetName)
    setPresets(prev => prev.filter(p => p.name !== presetName))
  }

  const handleJiraFetch = async (key: string) => {
    const trimmed = key.trim().toUpperCase()
    if (!trimmed) return
    setJiraPreview({ ok: true, text: 'Fetching…' })
    setJiraTicket(null)
    const result = await window.api.jira.fetchTicket(trimmed)
    if (result.ok) {
      setJiraTicket(result.ticket)
      setJiraPreview({ ok: true, text: `${result.ticket.key}: ${result.ticket.summary}` })
    } else {
      setJiraPreview({ ok: false, text: `Could not fetch: ${result.error}` })
    }
  }

  const handleCreate = async () => {
    if (creating) return
    setCreating(true)
    const extraParts = extraArgs.trim() ? extraArgs.trim().split(/\s+/) : []
    const modelParts = model ? ['--model', model] : []
    const agentParts = selectedAgent ? ['--agent', selectedAgent] : []
    const effortParts = effort ? ['--effort', effort] : []
    const args = modelParts.length || agentParts.length || effortParts.length || extraParts.length ? [...modelParts, ...agentParts, ...effortParts, ...extraParts] : undefined
    const mcpServers = selectedMcpServers.size > 0 ? Array.from(selectedMcpServers) : undefined

    // Resolve playbook template if inputs are present
    const pb = playbooks.find(p => p.name === selectedPlaybook)
    if (pb?.inputs?.length && pb.prompt) {
      const resolved = resolveMustacheTemplate(pb.prompt, playbookInputValues as Record<string, unknown>)
      setFirstPrompt(resolved)
    }
    const effectivePrompt = pb?.inputs?.length && pb.prompt
      ? resolveMustacheTemplate(pb.prompt, playbookInputValues as Record<string, unknown>)
      : firstPrompt

    const trimmedPrompt = effectivePrompt.trim()
    if (trimmedPrompt) addToHistory(trimmedPrompt)
    const envRecord = envVars.reduce((acc, { key, value }) => {
      if (key.trim()) acc[key.trim()] = value
      return acc
    }, {} as Record<string, string>)
    try {
      await onCreate({
        name: name.trim() || undefined,
        workingDirectory: workingDirectory.trim() || undefined,
        color,
        args,
        cliBackend,
        mcpServers,
        initialPrompt: trimmedPrompt || undefined,
        permissionMode,
        planFirst: planFirst || undefined,
        env: Object.keys(envRecord).length > 0 ? envRecord : undefined,
        jiraTicket: jiraTicket || undefined,
        tags: playbookTags.length > 0 ? playbookTags : undefined,
        playbook: selectedPlaybook || undefined,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      window.alert(`Could not create session: ${message}`)
      setCreating(false)
    }
  }

  const handleClose = () => {
    setCreating(false)
    onClose()
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (pickerOpen) { setPickerOpen(false); e.stopPropagation(); return }
        if (historyOpen) { setHistoryOpen(false); e.stopPropagation(); return }
        handleClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [historyOpen, pickerOpen])

  // Close history dropdown on click outside
  useEffect(() => {
    if (!historyOpen) return
    const handler = (e: MouseEvent) => {
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) {
        setHistoryOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [historyOpen])

  // Close ticket picker on click outside
  useEffect(() => {
    if (!pickerOpen) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [pickerOpen])

  const handleOpenPicker = useCallback(async () => {
    if (pickerOpen) { setPickerOpen(false); return }
    setPickerOpen(true)
    setPickerError(null)
    setPickerLoading(true)
    const result = await window.api.jira.myTickets()
    setPickerLoading(false)
    if (result.ok) {
      setPickerTickets(result.tickets)
    } else {
      setPickerError("Couldn't fetch tickets — check Jira settings.")
    }
  }, [pickerOpen])

  const handlePickTicket = (t: JiraTicketSummary) => {
    setJiraKey(t.key)
    setPickerOpen(false)
    setJiraPreview(null)
    setJiraTicket(null)
    handleJiraFetch(t.key)
  }

  return (
    <div className="dialog-overlay">
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); handleCreate() }}>
        <h2>{cloneSource ? 'Clone Session' : prefill ? `Launch: ${prefill.name}` : 'New Session'}</h2>

        {prefill && (
          <div className="dialog-agent-info">
            {prefill.description}
          </div>
        )}

        {playbooks.length > 0 && !cloneSource && (
          <div className="dialog-field">
            <label>Playbook <span style={{ opacity: 0.5, fontWeight: 'normal' }}>(optional)</span></label>
            <select
              value={selectedPlaybook}
              onChange={e => handlePlaybookSelect(e.target.value)}
              className="settings-select"
              style={{ width: '100%' }}
            >
              <option value="">None — configure manually</option>
              {playbooks.map(pb => (
                <option key={pb.name} value={pb.name}>{pb.name}</option>
              ))}
            </select>
            {selectedPlaybook && (() => {
              const pb = playbooks.find(p => p.name === selectedPlaybook)
              return pb?.description ? (
                <div className="dialog-agent-info">{pb.description}</div>
              ) : null
            })()}
            {selectedPlaybook && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                {playbookTags.length > 0 && (
                  <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                    {playbookTags.map(t => (
                      <span key={t} className="session-tag-pill" style={{ fontSize: 11 }}>{t}</span>
                    ))}
                  </div>
                )}
                <button
                  type="button"
                  className="panel-header-btn"
                  style={{ fontSize: 11, padding: '2px 7px', marginLeft: 'auto' }}
                  onClick={async () => {
                    const mem = await window.api.playbooks?.getMemory?.(selectedPlaybook) ?? ''
                    setMemoryContent(mem)
                    setMemoryEditing(false)
                    setMemoryModalOpen(true)
                  }}
                  title="View or edit playbook memory from previous runs"
                >
                  Memory{playbookMemoryCount > 0 ? ` (${playbookMemoryCount} lines)` : ''}
                </button>
              </div>
            )}
            {!selectedPlaybook && playbookTags.length > 0 && (
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
                {playbookTags.map(t => (
                  <span key={t} className="session-tag-pill" style={{ fontSize: 11 }}>{t}</span>
                ))}
              </div>
            )}
          </div>
        )}

        {presets.length > 0 && !cloneSource && (
          <div className="dialog-field">
            <label>Preset <span style={{ opacity: 0.5, fontWeight: 'normal' }}>(optional)</span></label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                className="settings-select"
                style={{ flex: 1 }}
                defaultValue=""
                onChange={e => { if (e.target.value) handlePresetSelect(e.target.value) }}
              >
                <option value="">— select to fill fields —</option>
                {presets.map(p => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
              {presets.map(p => (
                <span key={p.name} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, background: 'var(--bg-hover)', borderRadius: 4, padding: '2px 6px' }}>
                  {p.name}
                  <button
                    type="button"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', padding: 0, lineHeight: 1, fontSize: 13 }}
                    onClick={e => handleDeletePreset(p.name, e)}
                    title={`Delete preset "${p.name}"`}
                  >×</button>
                </span>
              ))}
            </div>
          </div>
        )}

        {memoryModalOpen && (
          <div
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onClick={() => setMemoryModalOpen(false)}
          >
            <div
              style={{ background: 'var(--bg-panel)', borderRadius: 8, padding: 16, width: 480, maxHeight: 400, display: 'flex', flexDirection: 'column', gap: 8 }}
              onClick={e => e.stopPropagation()}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <strong style={{ fontSize: 13 }}>Playbook Memory — {selectedPlaybook}</strong>
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                  {memoryEditing ? (
                    <button type="button" className="panel-header-btn primary" style={{ fontSize: 11 }} onClick={async () => {
                      await window.api.playbooks?.clearMemory?.(selectedPlaybook)
                      const lines = memoryContent.split('\n').filter(l => l.trim())
                      if (lines.length > 0) {
                        await window.api.playbooks?.appendMemory?.(selectedPlaybook, lines)
                      }
                      setPlaybookMemoryCount(lines.length)
                      setMemoryEditing(false)
                    }}>Save</button>
                  ) : (
                    <button type="button" className="panel-header-btn" style={{ fontSize: 11 }} onClick={() => setMemoryEditing(true)}>Edit</button>
                  )}
                  <button type="button" className="panel-header-btn" style={{ fontSize: 11, color: 'var(--status-error)' }} onClick={async () => {
                    if (!window.confirm('Clear all memory for this playbook?')) return
                    await window.api.playbooks?.clearMemory?.(selectedPlaybook)
                    setMemoryContent('')
                    setPlaybookMemoryCount(0)
                    setMemoryModalOpen(false)
                  }}>Clear</button>
                </div>
              </div>
              {memoryEditing ? (
                <textarea
                  style={{ flex: 1, minHeight: 200, resize: 'vertical', fontFamily: 'monospace', fontSize: 12, padding: 8 }}
                  value={memoryContent}
                  onChange={e => setMemoryContent(e.target.value)}
                />
              ) : memoryContent ? (
                <pre style={{ flex: 1, overflowY: 'auto', fontSize: 12, opacity: 0.85, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0 }}>{memoryContent}</pre>
              ) : (
                <p style={{ opacity: 0.5, fontSize: 12, margin: 0 }}>No memory recorded yet. Memory lines are captured from session output lines prefixed with "MEMORY:".</p>
              )}
            </div>
          </div>
        )}


        {(() => {
          const pb = playbooks.find(p => p.name === selectedPlaybook)
          if (!pb?.inputs?.length) return null
          return (
            <div className="dialog-field" style={{ background: 'var(--bg-hover)', borderRadius: 6, padding: '10px 12px' }}>
              <label style={{ marginBottom: 8, display: 'block' }}>Playbook Inputs</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {pb.inputs.map((inp: PlaybookInput) => (
                  <div key={inp.name}>
                    <label style={{ fontSize: 11, opacity: 0.7, marginBottom: 3, display: 'block' }}>
                      {inp.label || inp.name}{inp.required && <span style={{ color: 'var(--status-error)', marginLeft: 3 }}>*</span>}
                    </label>
                    {inp.type === 'boolean' ? (
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
                        <input
                          type="checkbox"
                          checked={playbookInputValues[inp.name] === 'true'}
                          onChange={e => setPlaybookInputValues(v => ({ ...v, [inp.name]: e.target.checked ? 'true' : 'false' }))}
                        />
                        {inp.placeholder || inp.label || inp.name}
                      </label>
                    ) : inp.type === 'select' ? (
                      <select
                        className="settings-select"
                        style={{ width: '100%' }}
                        value={playbookInputValues[inp.name] ?? inp.default ?? ''}
                        onChange={e => setPlaybookInputValues(v => ({ ...v, [inp.name]: e.target.value }))}
                      >
                        {!inp.required && <option value="">— select —</option>}
                        {(inp.options ?? []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
                      </select>
                    ) : (
                      <input
                        type="text"
                        style={{ width: '100%', boxSizing: 'border-box' }}
                        placeholder={inp.placeholder || inp.name}
                        value={playbookInputValues[inp.name] ?? ''}
                        onChange={e => setPlaybookInputValues(v => ({ ...v, [inp.name]: e.target.value }))}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )
        })()}

        <div className="dialog-field">
          <label>Name</label>
          <input
            placeholder="My Project"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!promptSeeded}
          />
        </div>

        <div className="dialog-field">
          <label
            style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, margin: 0 }}
            onClick={() => setPromptExpanded(!promptExpanded)}
          >
            {promptExpanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            First prompt
            {!promptSeeded && <span style={{ opacity: 0.5, fontWeight: 'normal' }}>(optional)</span>}
            {promptExpanded && getHistory().length > 0 && (
              <div style={{ position: 'relative', marginLeft: 4 }} ref={historyRef} onClick={e => e.stopPropagation()}>
                <button
                  type="button"
                  className="panel-header-btn"
                  style={{ padding: '1px 4px', fontSize: 11 }}
                  onClick={() => setHistoryOpen(!historyOpen)}
                  title="Prompt history"
                >
                  History
                </button>
                {historyOpen && (
                  <div className="prompt-history-dropdown">
                    {getHistory().map((entry, i) => (
                      <button
                        key={i}
                        type="button"
                        className="prompt-history-item"
                        onClick={() => {
                          setFirstPrompt(entry.prompt)
                          setHistoryOpen(false)
                          promptRef.current?.focus()
                        }}
                      >
                        <span className="prompt-history-text">
                          {entry.prompt.length > 80 ? entry.prompt.slice(0, 80) + '...' : entry.prompt}
                        </span>
                        <span className="prompt-history-time">{relativeTime(entry.timestamp)}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </label>
          {promptExpanded && (
            <>
              <textarea
                ref={promptRef}
                className="dialog-first-prompt"
                placeholder="What should Claude work on first?"
                value={firstPrompt}
                onChange={(e) => setFirstPrompt(e.target.value)}
                rows={4}
              />
              <div className="dialog-field-hint">
                Runs automatically as soon as the session is ready. Leave blank to start idle.
              </div>
            </>
          )}
        </div>

        <div className="dialog-field">
          <label>Attach JIRA Ticket <span style={{ opacity: 0.5, fontWeight: 'normal' }}>(optional)</span></label>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              style={{ flex: 1 }}
              placeholder="e.g. NP-7663"
              value={jiraKey}
              onChange={(e) => {
                setJiraKey(e.target.value)
                // Clear preview if user edits after fetch
                if (jiraPreview) { setJiraPreview(null); setJiraTicket(null) }
              }}
              onBlur={() => { if (jiraKey.trim()) handleJiraFetch(jiraKey) }}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (jiraKey.trim()) handleJiraFetch(jiraKey) } }}
            />
            {jiraConfigured && (
              <div style={{ position: 'relative' }} ref={pickerRef} onClick={e => e.stopPropagation()}>
                <button
                  type="button"
                  className="panel-header-btn"
                  title="My open tickets"
                  onClick={handleOpenPicker}
                  style={{ display: 'flex', alignItems: 'center', gap: 4 }}
                >
                  <ListTodo size={13} />
                  My Tickets
                </button>
                {pickerOpen && (
                  <div className="jira-picker-popover">
                    {pickerLoading && (
                      <div className="jira-picker-state">
                        <Loader size={12} className="spinning" /> Loading…
                      </div>
                    )}
                    {pickerError && (
                      <div className="jira-picker-state jira-picker-error">{pickerError}</div>
                    )}
                    {!pickerLoading && !pickerError && pickerTickets.length === 0 && (
                      <div className="jira-picker-state">No open tickets assigned to you.</div>
                    )}
                    {!pickerLoading && !pickerError && pickerTickets.map(t => (
                      <button
                        key={t.key}
                        type="button"
                        className="jira-picker-row"
                        onClick={() => handlePickTicket(t)}
                      >
                        <span className="jira-picker-key">{t.key}</span>
                        <span className="jira-picker-summary">{t.summary}</span>
                        <span className="jira-picker-status">{t.status}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
          {jiraPreview && (
            <div className={`jira-preview ${jiraPreview.ok ? 'ok' : 'err'}`}>
              {jiraPreview.ok
                ? <CheckCircle size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
                : <XCircle size={11} style={{ display: 'inline', verticalAlign: 'middle', marginRight: 4 }} />
              }{jiraPreview.text}
            </div>
          )}
        </div>

        <div className="dialog-field">
          <label>Working Directory</label>
          <div className="dir-picker">
            <input
              placeholder="~ (home directory)"
              value={workingDirectory}
              onChange={(e) => setWorkingDirectory(e.target.value)}
            />
            <button type="button" onClick={handlePickDir} title="Browse directory">Browse</button>
          </div>
        </div>

        {environments.length > 0 && (
          <div className="dialog-field">
            <label>Environment (optional)</label>
            <div className="dialog-env-picker">
              {environments.map(env => (
                <button
                  key={env.id}
                  type="button"
                  className={`dialog-env-chip ${workingDirectory === (env.paths.root || env.paths.backend) ? 'active' : ''}`}
                  onClick={() => {
                    const dir = env.paths.root || env.paths.backend || ''
                    setWorkingDirectory(dir)
                    if (!name.trim()) setName(`${env.name}`)
                    maybeAutoAttachTicket(env.branch)
                  }}
                >
                  <span className={`dialog-env-dot ${env.status === 'running' ? 'running' : env.status === 'partial' ? 'partial' : ''}`} />
                  {env.name}
                  <span className="dialog-env-branch">{env.branch}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="dialog-field">
          <label>Color</label>
          <div className="color-picker">
            {COLORS.map((c) => (
              <div
                key={c}
                className={`color-swatch ${c === color ? 'selected' : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => setColor(c)}
              />
            ))}
            <input
              type="color"
              className="color-input-native"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              title="Custom color"
            />
          </div>
        </div>

        <div className="dialog-field">
          <label style={{ cursor: 'pointer' }} onClick={() => setShowEnvVars(!showEnvVars)}>
            Environment Variables {showEnvVars ? <ChevronDown size={12} style={{ display: 'inline', verticalAlign: 'middle' }} /> : <ChevronRight size={12} style={{ display: 'inline', verticalAlign: 'middle' }} />} <span style={{ opacity: 0.5, fontWeight: 'normal' }}>(optional)</span>
          </label>
          {showEnvVars && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {envVars.map((ev, i) => (
                <div key={i} style={{ display: 'flex', gap: 4 }}>
                  <input placeholder="KEY" value={ev.key} style={{ flex: 1 }}
                    onChange={e => { const updated = [...envVars]; updated[i] = { ...ev, key: e.target.value }; setEnvVars(updated) }} />
                  <input placeholder="value" value={ev.value} style={{ flex: 2 }}
                    onChange={e => { const updated = [...envVars]; updated[i] = { ...ev, value: e.target.value }; setEnvVars(updated) }} />
                  <button type="button" className="panel-header-btn" onClick={() => setEnvVars(envVars.filter((_, j) => j !== i))}>×</button>
                </div>
              ))}
              <button type="button" className="panel-header-btn" style={{ alignSelf: 'flex-start' }}
                onClick={() => setEnvVars([...envVars, { key: '', value: '' }])}>+ Add variable</button>
            </div>
          )}
        </div>

        <div className="dialog-field">
          <label>Model (optional)</label>
          <select value={model} onChange={e => setModel(e.target.value)} className="settings-select" style={{ width: '100%' }}>
            <option value="">Default</option>
            <option value="claude-opus-4-7">Opus 4.7 (claude-opus-4-7)</option>
            <option value="claude-opus-4-6">Opus 4.6 (claude-opus-4-6)</option>
            <option value="claude-sonnet-4-6">Sonnet (claude-sonnet-4-6)</option>
            <option value="claude-haiku-4-5-20251001">Haiku (claude-haiku-4-5)</option>
          </select>
        </div>

        {cliBackend === 'claude' && (
          <div className="dialog-field">
            <label>Effort Level (optional)</label>
            <select value={effort} onChange={e => setEffort(e.target.value)} className="settings-select" style={{ width: '100%' }}>
              <option value="">Default</option>
              <option value="low">Low — fast, minimal reasoning</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">XHigh — deepest reasoning (Opus 4.7+)</option>
            </select>
          </div>
        )}

        {agents.length > 0 && (
          <div className="dialog-field">
            <label>Agent (optional)</label>
            <select
              value={selectedAgent}
              onChange={e => setSelectedAgent(e.target.value)}
              className="settings-select"
              style={{ width: '100%' }}
            >
              <option value="">None</option>
              {['personal', 'project'].map(scope => {
                const scoped = agents.filter(a => a.scope === scope)
                if (scoped.length === 0) return null
                return (
                  <optgroup key={scope} label={scope === 'personal' ? 'Personal' : 'Project'}>
                    {scoped.map(a => (
                      <option key={a.filePath} value={a.filePath}>{a.name}</option>
                    ))}
                  </optgroup>
                )
              })}
            </select>
            {selectedAgent && (() => {
              const ag = agents.find(a => a.filePath === selectedAgent)
              return ag?.description ? (
                <div className="dialog-agent-info">{ag.description}</div>
              ) : null
            })()}
          </div>
        )}

        <div className="dialog-field">
          <label>Extra CLI Arguments (optional)</label>
          <input
            placeholder="e.g. --allowedTools Edit,Write"
            value={extraArgs}
            onChange={(e) => setExtraArgs(e.target.value)}
          />
        </div>

        <div className="dialog-field">
          <label>CLI for this session</label>
          <select
            value={cliBackend}
            onChange={(e) => setCliBackend(e.target.value as CliBackend)}
            className="settings-select"
            style={{ width: '100%' }}
          >
            <option value="claude">Claude Code (claude)</option>
            <option value="cursor-agent">Cursor Agent (agent)</option>
          </select>
        </div>

        <div className="dialog-field">
          <label>Permission Mode</label>
          <div className="dialog-permission-toggle">
            <button
              type="button"
              className={`dialog-permission-btn ${permissionMode === 'autonomous' ? 'active' : ''}`}
              onClick={() => setPermissionMode('autonomous')}
            >
              Autonomous
            </button>
            <button
              type="button"
              className={`dialog-permission-btn ${permissionMode === 'auto' ? 'active' : ''}`}
              onClick={() => setPermissionMode('auto')}
            >
              Auto
            </button>
            <button
              type="button"
              className={`dialog-permission-btn ${permissionMode === 'supervised' ? 'active' : ''}`}
              onClick={() => setPermissionMode('supervised')}
            >
              Supervised
            </button>
          </div>
          <div className="dialog-field-hint">
            {permissionMode === 'supervised'
              ? 'Claude will ask before risky actions (file writes, commands).'
              : permissionMode === 'auto'
              ? 'AI classifier auto-approves safe actions, gates dangerous ones.'
              : 'Claude runs with full permissions (default).'}
          </div>
        </div>

        {promptExpanded && firstPrompt.trim() && (
          <label className="dialog-mcp-checkbox" style={{ padding: '0 4px' }}>
            <input
              type="checkbox"
              checked={planFirst}
              onChange={(e) => setPlanFirst(e.target.checked)}
            />
            <span>Plan first — Claude outlines an approach and waits for approval before acting</span>
          </label>
        )}

        {mcpServersList.length > 0 && (
          <div className="dialog-field">
            <label>MCP Servers (optional)</label>
            <div className="dialog-mcp-servers">
              {mcpServersList.map(server => (
                <label key={server.name} className="dialog-mcp-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedMcpServers.has(server.name)}
                    onChange={(e) => {
                      const updated = new Set(selectedMcpServers)
                      if (e.target.checked) {
                        updated.add(server.name)
                      } else {
                        updated.delete(server.name)
                      }
                      setSelectedMcpServers(updated)
                    }}
                  />
                  <span className="dialog-mcp-name">{server.name}</span>
                  {server.description && <span className="dialog-mcp-desc">{server.description}</span>}
                </label>
              ))}
            </div>
          </div>
        )}

        <div className="dialog-actions">
          <button type="button" className="cancel" onClick={handleClose} disabled={creating} title="Cancel">Cancel</button>
          <button type="button" className="panel-header-btn" onClick={handleSavePreset} disabled={creating || presetSaving} title="Save current fields as a reusable preset" style={{ marginRight: 'auto' }}>
            {presetSaving ? 'Saving…' : 'Save as Preset'}
          </button>
          <button type="submit" className="confirm" disabled={creating || (() => {
            const pb = playbooks.find(p => p.name === selectedPlaybook)
            return (pb?.inputs ?? []).some(inp => inp.required && !playbookInputValues[inp.name])
          })()} title="Create session">{creating ? 'Creating...' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}
