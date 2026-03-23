import { useState, useRef, useEffect } from 'react'
import { Info, Pencil, Pin, PinOff, Square, Play, Trash2, RefreshCw, Settings, Plus, GitPullRequest, Columns2, ListChecks, Workflow, TerminalSquare, Bot } from 'lucide-react'
import type { ClaudeInstance, CliSession, RecentSession } from '../types'
import Tooltip from './Tooltip'
import { COLORS, formatTime } from '../lib/constants'

export type SidebarView = 'instances' | 'agents' | 'github' | 'sessions' | 'settings' | 'logs' | 'tasks' | 'orchestrate'

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

export default function Sidebar({ instances, activeId, view, onSelect, onNew, onKill, onRestart, onRemove, onRename, onRecolor, onPin, onUnpin, onViewChange, onResumeSession, onRestoreAll, restorableCount, unreadIds, splitId, splitPairs, focusedPane, onSplitWith, onCloseSplit, onDrop }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
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

  useEffect(() => {
    window.api.sessions.list(100).then(setSessions)
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
    } else {
      setPopoverId(id)
      setPopoverType(type)
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
          </div>
        )}
        <div className="instance-meta">
          {inst.parentId && <span className="instance-child-indicator" title="Child session">↳ </span>}
          {dirName(inst.workingDirectory)}
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
            <Tooltip text="Kill Session" detail="Terminate the Claude CLI process">
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
          <Tooltip text="Orchestrate" detail="Session search, chains, dependencies" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'orchestrate' ? 'active' : ''}`} onClick={() => onViewChange('orchestrate')}>
              <Workflow size={16} />
            </button>
          </Tooltip>
          <div className="sidebar-nav-spacer" />
          <Tooltip text="Settings" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'settings' ? 'active' : ''}`} onClick={() => onViewChange(view === 'settings' ? 'instances' : 'settings')}>
              <Settings size={16} />
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
            <div className="instance-info-row"><span>cmd</span> claude {inst.args.join(' ') || '(interactive)'}</div>
            <div className="instance-info-row"><span>dir</span> {inst.workingDirectory}</div>
            <div className="instance-info-row"><span>pid</span> {inst.pid ?? '—'}</div>
            <div className="instance-info-row"><span>started</span> {new Date(inst.createdAt).toLocaleTimeString()}</div>
            {inst.mcpServers.length > 0 && (
              <div className="instance-info-row"><span>mcp</span> {inst.mcpServers.join(', ')}</div>
            )}
          </div>
        )
      })()}

      <div className="sidebar-sessions">
        <div className="sidebar-sessions-header">
          <span className="sidebar-sessions-title">History</span>
          <span className="sidebar-sessions-count">{filteredSessions.length}</span>
          <button
            className="sidebar-sessions-refresh"
            onClick={() => window.api.sessions.list(100).then(setSessions)}
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
      </div>
    </div>
  )
}
