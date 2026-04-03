import { useState, useRef, useEffect } from 'react'
import { Info, Pencil, Pin, PinOff, Square, Play, Trash2, RefreshCw, Settings, Plus, GitPullRequest, Columns2, ListChecks, TerminalSquare, Bot, Zap, Server, User } from 'lucide-react'
import type { ClaudeInstance, CliSession, RecentSession } from '../types'
import Tooltip from './Tooltip'
import HelpPopover from './HelpPopover'
import ExternalSessionPopover from './ExternalSessionPopover'
import { COLORS, formatTime, cliBackendLabel, formatInstanceCmd } from '../lib/constants'

export type SidebarView = 'instances' | 'agents' | 'github' | 'sessions' | 'settings' | 'logs' | 'tasks' | 'pipelines' | 'environments' | 'personas'

interface Props {
  instances: ClaudeInstance[]
  activeId: string | null
  view: SidebarView
  onSelect: (id: string) => void
  onNew: () => void
  onKill: (id: string) => void
  onRestart: (id: string) => void
  onRemove: (id: string) => void
  onRename: (id: string, name: string) => void
  onRecolor: (id: string, color: string) => void
  onPin: (id: string) => void
  onUnpin: (id: string) => void
  onViewChange: (view: SidebarView) => void
  onResumeSession: (session: CliSession) => void
  onTakeoverExternal: (ext: { pid: number; name: string; cwd: string; sessionId: string | null }) => void
  onRestoreAll: () => void
  restorableCount: number
  unreadIds: Set<string>
  splitId: string | null
  splitPairs: Map<string, string>
  focusedPane: 'left' | 'right'
  onSplitWith: (id: string) => void
  onCloseSplit: () => void
  onDrop?: (e: React.DragEvent) => void
}

export default function Sidebar({ instances, activeId, view, onSelect, onNew, onKill, onRestart, onRemove, onRename, onRecolor, onPin, onUnpin, onViewChange, onResumeSession, onTakeoverExternal, onRestoreAll, restorableCount, unreadIds, splitId, splitPairs, focusedPane, onSplitWith, onCloseSplit, onDrop }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [runningEnvCount, setRunningEnvCount] = useState(0)

  useEffect(() => {
    const load = () => {
      window.api.env.list().then(envs => {
        setRunningEnvCount(envs.filter(e => e.status === 'running' || e.status === 'partial').length)
      }).catch(() => {})
    }
    load()
    const unsub = window.api.env.onStatusUpdate((envs) => {
      setRunningEnvCount(envs.filter(e => e.status === 'running' || e.status === 'partial').length)
    })
    const interval = setInterval(load, 5000)
    return () => { unsub(); clearInterval(interval) }
  }, [])
  const [popoverId, setPopoverId] = useState<string | null>(null)
  const [popoverType, setPopoverType] = useState<'color' | 'info' | null>(null)
  const [sessions, setSessions] = useState<CliSession[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [hoveredSessionId, setHoveredSessionId] = useState<string | null>(null)
  const [popoverPos, setPopoverPos] = useState<{ top: number } | null>(null)
  const [instancePopoverPos, setInstancePopoverPos] = useState<{ top: number; left: number } | null>(null)
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null)
  const renameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (renamingId && renameRef.current) {
      renameRef.current.focus()
      renameRef.current.select()
    }
  }, [renamingId])

  const [externalSessions, setExternalSessions] = useState<Array<{ pid: number; name: string; cwd: string; sessionId: string | null; args: string }>>([])
  const [extPopover, setExtPopover] = useState<{ session: { pid: number; name: string; cwd: string; sessionId: string | null; args: string }; rect: { top: number; left: number; bottom: number; right: number } } | null>(null)
  const [childProcesses, setChildProcesses] = useState<Array<{ pid: number; name: string; command: string; cpu: string; mem: string }>>([])
  const [childProcessesId, setChildProcessesId] = useState<string | null>(null)

  useEffect(() => {
    window.api.sessions.list(100).then(setSessions)
    window.api.sessions.external().then(setExternalSessions)
  }, [])

  // Close popovers when clicking outside
  useEffect(() => {
    if (!popoverId) return
    const handler = () => { setPopoverId(null); setPopoverType(null); setInstancePopoverPos(null) }
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [popoverId])

  const startRename = (inst: ClaudeInstance) => {
    setRenamingId(inst.id)
    setRenameValue(inst.name)
  }

  const commitRename = () => {
    if (renamingId && renameValue.trim()) {
      onRename(renamingId, renameValue.trim())
    }
    setRenamingId(null)
  }

  const togglePopover = (id: string, type: 'color' | 'info', e?: React.MouseEvent) => {
    if (popoverId === id && popoverType === type) {
      setPopoverId(null)
      setPopoverType(null)
      setInstancePopoverPos(null)
      setChildProcesses([])
      setChildProcessesId(null)
    } else {
      setPopoverId(id)
      setPopoverType(type)
      if (type === 'info') {
        setChildProcesses([])
        setChildProcessesId(id)
        window.api.instance.processes(id).then(setChildProcesses)
      }
      if (e) {
        const rect = (e.currentTarget as HTMLElement).closest('.instance-item')?.getBoundingClientRect()
        if (rect) {
          const top = Math.min(rect.bottom + 4, window.innerHeight - 200)
          const left = Math.max(8, rect.left)
          setInstancePopoverPos({ top, left })
        }
      }
    }
  }

  const dirName = (path: string) => {
    const parts = path.split('/')
    return parts[parts.length - 1] || path
  }

  const filteredSessions = sessionSearch
    ? sessions.filter((s) => {
        const q = sessionSearch.toLowerCase()
        return s.display.toLowerCase().includes(q) ||
          s.projectName.toLowerCase().includes(q) ||
          (s.name && s.name.toLowerCase().includes(q))
      })
    : sessions

  const pinned = instances.filter((i) => i.pinned)
  const running = instances.filter((i) => i.status === 'running' && !i.pinned)
  const exited = instances.filter((i) => i.status !== 'running' && !i.pinned)
  // Visual order for Cmd+N shortcuts
  const orderedInstances = [...pinned, ...running, ...exited]
  const instanceIndex = (id: string) => {
    const idx = orderedInstances.findIndex((i) => i.id === id)
    return idx >= 0 && idx < 9 ? idx + 1 : null // 1-indexed, max 9
  }

  const handleKeyDown = (e: React.KeyboardEvent, action: () => void) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      action()
    }
  }

  const renderInstance = (inst: ClaudeInstance) => (
    <div
      key={inst.id}
      className={`instance-item ${inst.id === activeId ? 'active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onSelect(inst.id)}
      onKeyDown={(e) => handleKeyDown(e, () => onSelect(inst.id))}
      onContextMenu={(e) => {
        e.preventDefault()
        const x = Math.min(e.clientX, window.innerWidth - 200)
        const y = Math.min(e.clientY, window.innerHeight - 150)
        setContextMenu({ id: inst.id, x, y })
      }}
    >
      {instanceIndex(inst.id) && (
        <span className="instance-shortcut" title={`Cmd+${instanceIndex(inst.id)}`}>{instanceIndex(inst.id)}</span>
      )}
      <div
        className={`instance-dot clickable ${inst.status === 'running' && inst.activity === 'busy' ? 'pulsing' : ''}`}
        style={{
          backgroundColor: inst.color,
          color: inst.color,
          opacity: inst.status === 'exited' ? 0.4 : 1,
        }}
        onClick={(e) => {
          e.stopPropagation()
          togglePopover(inst.id, 'color', e)
        }}
        title="Change color"
      />
      <div className="instance-info">
        {renamingId === inst.id ? (
          <input
            ref={renameRef}
            className="rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') commitRename()
              if (e.key === 'Escape') setRenamingId(null)
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div className="instance-name">
            {inst.pinned && <span className="instance-pin-icon" title="Pinned"><Pin size={11} /></span>}
            {inst.name}
            {splitId && inst.id === activeId && <span className={`split-badge ${focusedPane === 'left' ? 'focused' : ''}`} title="Left split pane">L</span>}
            {splitId && inst.id === splitId && <span className={`split-badge ${focusedPane === 'right' ? 'focused' : ''}`} title="Right split pane">R</span>}
            {inst.id !== activeId && inst.id !== splitId && splitPairs.has(inst.id) && (
              <span className="split-indicator" title={`Split with another session`}><Columns2 size={11} /></span>
            )}
            {inst.status === 'running' && inst.activity === 'waiting' && (
              <span className="instance-attention-badge" title="Waiting for your input">your turn</span>
            )}
            {unreadIds.has(inst.id) && (
              <span className="instance-unread-badge" title="New output you haven't seen">new</span>
            )}
            {inst.mcpServers.length > 0 && (
              <span className="instance-mcp-badge" title={inst.mcpServers.join(', ')}>
                MCP {inst.mcpServers.length}
              </span>
            )}
            <span className="instance-cli-badge" title="CLI for this session">
              {cliBackendLabel(inst.cliBackend)}
            </span>
          </div>
        )}
        <div className="instance-meta">
          {inst.parentId && <span className="instance-child-indicator" title="Child session">↳ </span>}
          {dirName(inst.workingDirectory)}
          {inst.gitBranch && (
            <span className="instance-branch-badge" title={`Branch: ${inst.gitBranch}${inst.gitRepo ? ` · ${inst.gitRepo}` : ''}`}>
              <GitPullRequest size={9} /> {inst.gitBranch}
            </span>
          )}
          {inst.childIds?.length > 0 && <span className="instance-parent-badge" title={`${inst.childIds.length} child session${inst.childIds.length > 1 ? 's' : ''}`}> · {inst.childIds.length} child{inst.childIds.length > 1 ? 'ren' : ''}</span>}
        </div>
      </div>
      <div className="instance-item-right">
        <span className={`instance-status ${inst.status}`}>
          {inst.status === 'running' ? 'live' : `exit ${inst.exitCode ?? '?'}`}
        </span>
        <div className="instance-item-actions">
          <Tooltip text="Session Info" detail="View command, directory, PID, and MCP servers">
            <button aria-label="Info" onClick={(e) => { e.stopPropagation(); togglePopover(inst.id, 'info', e) }}><Info size={13} /></button>
          </Tooltip>
          <Tooltip text="Rename" detail="Change the session display name">
            <button aria-label="Rename" onClick={(e) => { e.stopPropagation(); startRename(inst) }}><Pencil size={13} /></button>
          </Tooltip>
          <Tooltip text={inst.pinned ? 'Unpin Session' : 'Pin Session'} detail={inst.pinned ? 'Remove from pinned section' : 'Keep at the top of the sidebar'}>
            <button
              aria-label={inst.pinned ? 'Unpin' : 'Pin'}
              onClick={(e) => { e.stopPropagation(); inst.pinned ? onUnpin(inst.id) : onPin(inst.id) }}
            >
              {inst.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
          </Tooltip>
          {inst.status === 'running' ? (
            <Tooltip text="Kill Session" detail="Terminate the CLI process for this session">
              <button className="danger" aria-label="Kill" onClick={(e) => { e.stopPropagation(); onKill(inst.id) }}><Square size={13} /></button>
            </Tooltip>
          ) : (
            <>
              <Tooltip text="Restart" detail="Launch a new session in the same directory">
                <button aria-label="Restart" onClick={(e) => { e.stopPropagation(); onRestart(inst.id) }}><Play size={13} /></button>
              </Tooltip>
              <Tooltip text="Remove" detail="Remove this stopped session from the list">
                <button className="danger" aria-label="Remove" onClick={(e) => { e.stopPropagation(); onRemove(inst.id) }}><Trash2 size={13} /></button>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </div>
  )

  return (
    <div className="sidebar" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="sidebar-header">
        <div className="sidebar-nav">
          <Tooltip text="Sessions" detail={`${instances.length} active`} shortcut="Cmd+1-9" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'instances' ? 'active' : ''}`} onClick={() => onViewChange('instances')}>
              <TerminalSquare size={16} />
              {instances.length > 0 && <span className="sidebar-nav-badge">{instances.length}</span>}
            </button>
          </Tooltip>
          <Tooltip text="Agents" detail="Browse and create agent definitions" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'agents' ? 'active' : ''}`} onClick={() => onViewChange('agents')}>
              <Bot size={16} />
            </button>
          </Tooltip>
          <Tooltip text="Pull Requests" detail="GitHub PRs, reviews, comments" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'github' ? 'active' : ''}`} onClick={() => onViewChange('github')}>
              <GitPullRequest size={16} />
            </button>
          </Tooltip>
          <Tooltip text="Tasks" detail="Task queue and batch execution" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'tasks' ? 'active' : ''}`} onClick={() => onViewChange('tasks')}>
              <ListChecks size={16} />
            </button>
          </Tooltip>
          <Tooltip text="Pipelines" detail="Automated triggers and actions" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'pipelines' ? 'active' : ''}`} onClick={() => onViewChange('pipelines')}>
              <Zap size={16} />
            </button>
          </Tooltip>
          <Tooltip text="Environments" detail={runningEnvCount > 0 ? `${runningEnvCount} running` : 'Dev environment management'} position="bottom">
            <button className={`sidebar-nav-btn ${view === 'environments' ? 'active' : ''}`} onClick={() => onViewChange('environments')}>
              <Server size={16} />
              {runningEnvCount > 0 && <span className="sidebar-nav-badge">{runningEnvCount}</span>}
            </button>
          </Tooltip>
          <Tooltip text="Personas" detail="Autonomous AI agents with identity, goals, and memory" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'personas' ? 'active' : ''}`} onClick={() => onViewChange('personas')}>
              <User size={16} />
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="sidebar-instance-actions">
        <button className="sidebar-new-btn" onClick={onNew} title="Launch a new Claude CLI terminal (Cmd+T)"><Plus size={14} /> New Session</button>
        {view === 'instances' && restorableCount > 0 && instances.length === 0 && (
          <button className="sidebar-restore-btn" onClick={onRestoreAll} title="Restore previous sessions">
            Restore {restorableCount} from last run
          </button>
        )}
      </div>

      <div className="instance-list">
        {pinned.length > 0 && (
          <>
            <div className="instance-list-divider">Pinned</div>
            {pinned.map(renderInstance)}
          </>
        )}
        {running.length > 0 && (
          <>
            {pinned.length > 0 && <div className="instance-list-divider">Active</div>}
            {running.map(renderInstance)}
          </>
        )}
        {exited.length > 0 && (running.length > 0 || pinned.length > 0) && (
          <div className="instance-list-divider">Stopped</div>
        )}
        {exited.map(renderInstance)}
        {instances.length === 0 && (
          <div className="instance-list-empty">No sessions</div>
        )}
      </div>

      {/* Instance popovers rendered outside instance-list to avoid clipping (I2) */}
      {popoverId && popoverType === 'color' && instancePopoverPos && (() => {
        const inst = instances.find((i) => i.id === popoverId)
        if (!inst) return null
        return (
          <div className="instance-popover" style={{ top: instancePopoverPos.top, left: instancePopoverPos.left }} onClick={(e) => e.stopPropagation()}>
            <div className="inline-color-picker">
              {COLORS.map((c) => (
                <div
                  key={c}
                  className={`color-swatch small ${c === inst.color ? 'selected' : ''}`}
                  style={{ backgroundColor: c }}
                  onClick={() => { onRecolor(inst.id, c); setPopoverId(null); setInstancePopoverPos(null) }}
                />
              ))}
              <input
                type="color"
                className="color-input-native"
                value={inst.color}
                onChange={(e) => onRecolor(inst.id, e.target.value)}
                title="Custom color"
              />
            </div>
          </div>
        )
      })()}
      {popoverId && popoverType === 'info' && instancePopoverPos && (() => {
        const inst = instances.find((i) => i.id === popoverId)
        if (!inst) return null
        return (
          <div className="instance-popover" style={{ top: instancePopoverPos.top, left: instancePopoverPos.left }} onClick={(e) => e.stopPropagation()}>
            <div className="instance-info-row"><span>cmd</span> {formatInstanceCmd(inst)}</div>
            <div className="instance-info-row"><span>dir</span> {inst.workingDirectory}</div>
            <div className="instance-info-row"><span>pid</span> {inst.pid ?? '—'}</div>
            <div className="instance-info-row"><span>started</span> {new Date(inst.createdAt).toLocaleTimeString()}</div>
            {inst.mcpServers.length > 0 && (
              <div className="instance-info-row"><span>mcp</span> {inst.mcpServers.join(', ')}</div>
            )}
            {childProcessesId === inst.id && childProcesses.length > 0 && (
              <>
                <div className="instance-info-divider" />
                <div className="instance-info-section-label">Processes</div>
                {childProcesses.map((p) => (
                  <div key={p.pid} className="instance-info-process">
                    <div className="instance-info-process-header">
                      <span className="instance-info-process-name">{p.name}</span>
                      <button
                        className="instance-info-process-kill"
                        title={`Kill ${p.name} (pid ${p.pid})`}
                        onClick={() => {
                          window.api.instance.killProcess(p.pid).then(() => {
                            setChildProcesses(prev => prev.filter(cp => cp.pid !== p.pid))
                          })
                        }}
                      >
                        <Square size={10} />
                      </button>
                    </div>
                    <span className="instance-info-process-meta">pid {p.pid} &middot; {p.cpu}% cpu &middot; {p.mem}% mem</span>
                  </div>
                ))}
              </>
            )}
          </div>
        )
      })()}

      {/* External sessions (running outside Colony) */}
      {externalSessions.length > 0 && (
        <div className="sidebar-external">
          <div className="sidebar-sessions-header">
            <span className="sidebar-sessions-title">External Sessions</span>
            <span className="sidebar-sessions-count">{externalSessions.length}</span>
            <button className="sidebar-sessions-refresh" onClick={() => window.api.sessions.external().then(setExternalSessions)} title="Refresh">
              <RefreshCw size={13} />
            </button>
          </div>
          <div className="sidebar-sessions-list">
            {externalSessions.map(ext => (
              <div
                key={ext.pid}
                className={`sidebar-session-item sidebar-session-external ${extPopover?.session.pid === ext.pid ? 'active' : ''}`}
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  if (extPopover?.session.pid === ext.pid) {
                    setExtPopover(null)
                  } else {
                    setExtPopover({
                      session: ext,
                      rect: { top: rect.top, left: rect.right, bottom: rect.bottom, right: rect.right },
                    })
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                    setExtPopover({
                      session: ext,
                      rect: { top: rect.top, left: rect.right, bottom: rect.bottom, right: rect.right },
                    })
                  }
                }}
              >
                <div className="sidebar-session-display">
                  <span className="sidebar-external-dot" />
                  {ext.name}
                </div>
                <div className="sidebar-session-meta">
                  <span className="sidebar-session-project">{ext.cwd.split('/').pop()}</span>
                  <span>pid {ext.pid}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* External session preview popover */}
      {extPopover && (
        <ExternalSessionPopover
          session={extPopover.session}
          anchorRect={extPopover.rect}
          onClose={() => setExtPopover(null)}
          onTakeover={(ext) => {
            setExtPopover(null)
            onTakeoverExternal(ext)
            // Refresh external sessions after takeover
            setTimeout(() => window.api.sessions.external().then(setExternalSessions), 2000)
          }}
        />
      )}

      <div className="sidebar-sessions">
        <div className="sidebar-sessions-header">
          <span className="sidebar-sessions-title">History</span>
          <span className="sidebar-sessions-count">{filteredSessions.length}</span>
          <button
            className="sidebar-sessions-refresh"
            onClick={() => { window.api.sessions.list(100).then(setSessions); window.api.sessions.external().then(setExternalSessions) }}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={13} />
          </button>
        </div>
        <input
          className="sidebar-sessions-search"
          placeholder="Search..."
          value={sessionSearch}
          onChange={(e) => setSessionSearch(e.target.value)}
        />
        <div className="sidebar-sessions-list">
          {filteredSessions.map((s) => (
            <div
              key={s.sessionId}
              className="sidebar-session-item"
              role="button"
              tabIndex={0}
              onClick={() => onResumeSession(s)}
              onKeyDown={(e) => handleKeyDown(e, () => onResumeSession(s))}
              onMouseEnter={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                // Clamp so popover doesn't go off-screen bottom
                const top = Math.min(rect.top, window.innerHeight - 280)
                setPopoverPos({ top })
                setHoveredSessionId(s.sessionId)
              }}
              onMouseLeave={() => setHoveredSessionId(null)}
            >
              <div className="sidebar-session-display">
                {s.name || s.display}
                {s.recentlyOpened && <span className="sidebar-session-recent-badge">recent</span>}
              </div>
              {s.name && <div className="sidebar-session-command">{s.display}</div>}
              <div className="sidebar-session-meta">
                <span className="sidebar-session-project">{s.projectName}</span>
                <span>{s.messageCount} msg{s.messageCount !== 1 ? 's' : ''}</span>
                <span>{formatTime(s.timestamp)}</span>
              </div>
              {hoveredSessionId === s.sessionId && popoverPos && (
                <div className="session-popover" style={{ top: popoverPos.top }}>
                  <div className="session-popover-section">
                    <div className="session-popover-label">First message</div>
                    <div className="session-popover-text">{s.display}</div>
                  </div>
                  {s.lastMessage && (
                    <div className="session-popover-section">
                      <div className="session-popover-label">Last message</div>
                      <div className="session-popover-text">{s.lastMessage}</div>
                    </div>
                  )}
                  <div className="session-popover-footer">
                    {s.projectName} &middot; {s.messageCount} messages &middot; {s.sessionId.slice(0, 8)}
                  </div>
                </div>
              )}
            </div>
          ))}
          {filteredSessions.length === 0 && (
            <div className="instance-list-empty">
              {sessionSearch ? 'No matches' : 'No sessions'}
            </div>
          )}
          {sessions.length >= 100 && !sessionSearch && (
            <div className="sidebar-sessions-cap">Showing most recent 100 sessions</div>
          )}
        </div>
      </div>

      {contextMenu && (
        <div
          className="context-menu-overlay"
          onClick={() => setContextMenu(null)}
        >
          <div
            className="context-menu"
            style={{ top: contextMenu.y, left: contextMenu.x }}
            onClick={(e) => e.stopPropagation()}
          >
            {splitId && (contextMenu.id === activeId || contextMenu.id === splitId) ? (
              <button
                className="context-menu-item"
                onClick={() => {
                  onCloseSplit()
                  setContextMenu(null)
                }}
                title="Close split view"
              >
                Close Split View
              </button>
            ) : contextMenu.id !== activeId ? (
              <button
                className="context-menu-item"
                onClick={() => {
                  onSplitWith(contextMenu.id)
                  setContextMenu(null)
                }}
                title="Open in split view"
              >
                Open in Split View
              </button>
            ) : null}
            <button
              className="context-menu-item"
              onClick={() => {
                startRename(instances.find((i) => i.id === contextMenu.id)!)
                setContextMenu(null)
              }}
              title="Rename session"
            >
              Rename
            </button>
            <button
              className="context-menu-item danger"
              onClick={() => {
                const inst = instances.find((i) => i.id === contextMenu.id)
                if (inst?.status === 'running') onKill(contextMenu.id)
                else onRemove(contextMenu.id)
                setContextMenu(null)
              }}
              title={instances.find((i) => i.id === contextMenu.id)?.status === 'running' ? 'Kill session' : 'Remove session'}
            >
              {instances.find((i) => i.id === contextMenu.id)?.status === 'running' ? 'Kill' : 'Remove'}
            </button>
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        <HelpPopover topic="sessions" align="right" position="above" />
        <Tooltip text="Settings" position="top">
          <button className={`sidebar-footer-btn ${view === 'settings' ? 'active' : ''}`} onClick={() => onViewChange(view === 'settings' ? 'instances' : 'settings')}>
            <Settings size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
