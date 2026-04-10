import { useState, useEffect, useRef } from 'react'
import type { AgentDef, CliBackend } from '../types'
import { COLORS, COLOR_MAP } from '../lib/constants'
import { getHistory, addToHistory } from '../lib/prompt-history'

export interface CloneSource {
  name: string
  workingDirectory: string
  color: string
  cliBackend: CliBackend
  permissionMode?: 'autonomous' | 'supervised'
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
    permissionMode?: 'autonomous' | 'supervised'
    planFirst?: boolean
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

export default function NewInstanceDialog({ onCreate, onClose, prefill, initialPrompt, initialWorkingDirectory, cloneSource }: Props) {
  const [name, setName] = useState(cloneSource ? cloneName(cloneSource.name) : prefill?.name || '')
  const [workingDirectory, setWorkingDirectory] = useState(cloneSource?.workingDirectory || initialWorkingDirectory || '')
  const [color, setColor] = useState(cloneSource ? resolveColor(cloneSource.color) : resolveColor(prefill?.color))
  const [extraArgs, setExtraArgs] = useState(() => {
    if (!cloneSource) return ''
    const filtered: string[] = []
    for (let i = 0; i < cloneSource.args.length; i++) {
      if (cloneSource.args[i] === '--resume') { i++; continue } // skip --resume and its value
      filtered.push(cloneSource.args[i])
    }
    return filtered.join(' ')
  })
  const [cliBackend, setCliBackend] = useState<CliBackend>(cloneSource?.cliBackend || 'claude')
  const [permissionMode, setPermissionMode] = useState<'autonomous' | 'supervised'>(cloneSource?.permissionMode || 'autonomous')
  const [creating, setCreating] = useState(false)
  const [environments, setEnvironments] = useState<EnvOption[]>([])
  const [mcpServersList, setMcpServersList] = useState<McpServer[]>([])
  const [selectedMcpServers, setSelectedMcpServers] = useState<Set<string>>(new Set())
  const [planFirst, setPlanFirst] = useState(false)
  // Show prompt field when cloning (so user can add a fresh prompt) or when
  // the caller passed a seed (starter cards).
  const showPromptField = !!cloneSource || initialPrompt !== undefined
  const [firstPrompt, setFirstPrompt] = useState(initialPrompt || '')
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const historyRef = useRef<HTMLDivElement | null>(null)

  // When the starter-card path opens the dialog, focus the prompt textarea
  // and place the cursor at the end so the user can just press Enter.
  useEffect(() => {
    if (!showPromptField) return
    const ta = promptRef.current
    if (!ta) return
    ta.focus()
    const len = ta.value.length
    ta.setSelectionRange(len, len)
  }, [showPromptField])

  useEffect(() => {
    if (!cloneSource) {
      window.api.settings.getAll().then((s) => {
        setCliBackend(s.defaultCliBackend === 'cursor-agent' ? 'cursor-agent' : 'claude')
      })
    }
    // Load environments for picker
    window.api.env?.list?.().then((envs: any[]) => {
      if (envs?.length) setEnvironments(envs)
    }).catch(() => {})
    // Load MCP servers
    window.api.mcp?.list?.().then((servers: McpServer[]) => {
      if (servers?.length) {
        setMcpServersList(servers)
        // Pre-select servers from clone source once the list arrives
        if (cloneSource?.mcpServers?.length) {
          const available = new Set(servers.map(s => s.name))
          setSelectedMcpServers(new Set(cloneSource.mcpServers.filter(n => available.has(n))))
        }
      }
    }).catch(() => {})
  }, [])

  const handlePickDir = async () => {
    const dir = await window.api.dialog.openDirectory()
    if (dir) setWorkingDirectory(dir)
  }

  const handleCreate = async () => {
    if (creating) return
    setCreating(true)
    const args = extraArgs.trim() ? extraArgs.trim().split(/\s+/) : undefined
    const mcpServers = selectedMcpServers.size > 0 ? Array.from(selectedMcpServers) : undefined
    const trimmedPrompt = firstPrompt.trim()
    if (trimmedPrompt) addToHistory(trimmedPrompt)
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
        if (historyOpen) { setHistoryOpen(false); e.stopPropagation(); return }
        handleClose()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [historyOpen])

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

  return (
    <div className="dialog-overlay">
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); handleCreate() }}>
        <h2>{cloneSource ? 'Clone Session' : prefill ? `Launch: ${prefill.name}` : 'New Session'}</h2>

        {prefill && (
          <div className="dialog-agent-info">
            {prefill.description}
          </div>
        )}

        <div className="dialog-field">
          <label>Name</label>
          <input
            placeholder="My Project"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus={!showPromptField}
          />
        </div>

        {showPromptField && (
          <div className="dialog-field">
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <label style={{ margin: 0 }}>First prompt</label>
              {getHistory().length > 0 && (
                <div style={{ position: 'relative' }} ref={historyRef}>
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
            </div>
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
          </div>
        )}

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
          <label>Extra CLI Arguments (optional)</label>
          <input
            placeholder="e.g. --model sonnet"
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
              className={`dialog-permission-btn ${permissionMode === 'supervised' ? 'active' : ''}`}
              onClick={() => setPermissionMode('supervised')}
            >
              Supervised
            </button>
          </div>
          <div className="dialog-field-hint">
            {permissionMode === 'supervised'
              ? 'Claude will ask before risky actions (file writes, commands).'
              : 'Claude runs with full permissions (default).'}
          </div>
        </div>

        {showPromptField && firstPrompt.trim() && (
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
          <button type="submit" className="confirm" disabled={creating} title="Create session">{creating ? 'Creating...' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}
