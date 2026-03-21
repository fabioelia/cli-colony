import { useState, useRef, useEffect } from 'react'
import type { ClaudeInstance, CliSession, RecentSession } from '../types'

const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
]

export type SidebarView = 'instances' | 'agents' | 'sessions' | 'settings' | 'logs'

interface Props {
  instances: ClaudeInstance[]
  activeId: string | null
  view: SidebarView
  onSelect: (id: string) => void
  onNew: () => void
  onKill: (id: string) => void
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
  onDrop?: (e: React.DragEvent) => void
}

export default function Sidebar({ instances, activeId, view, onSelect, onNew, onKill, onRemove, onRename, onRecolor, onPin, onUnpin, onViewChange, onResumeSession, onRestoreAll, restorableCount, unreadIds, onDrop }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [popoverId, setPopoverId] = useState<string | null>(null)
  const [popoverType, setPopoverType] = useState<'color' | 'info' | null>(null)
  const [sessions, setSessions] = useState<CliSession[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
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
    const handler = () => { setPopoverId(null); setPopoverType(null) }
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

  const togglePopover = (id: string, type: 'color' | 'info') => {
    if (popoverId === id && popoverType === type) {
      setPopoverId(null)
      setPopoverType(null)
    } else {
      setPopoverId(id)
      setPopoverType(type)
    }
  }

  const dirName = (path: string) => {
    const parts = path.split('/')
    return parts[parts.length - 1] || path
  }

  const formatTime = (ts: number) => {
    const diff = Date.now() - ts
    if (diff < 60000) return 'now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`
    if (diff < 604800000) return `${Math.floor(diff / 86400000)}d`
    return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' })
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

  const renderInstance = (inst: ClaudeInstance) => (
    <div
      key={inst.id}
      className={`instance-item ${inst.id === activeId ? 'active' : ''}`}
      onClick={() => onSelect(inst.id)}
    >
      <div
        className="instance-dot clickable"
        style={{
          backgroundColor: inst.color,
          opacity: inst.status === 'exited' ? 0.4 : 1,
        }}
        onClick={(e) => {
          e.stopPropagation()
          togglePopover(inst.id, 'color')
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
            {inst.pinned && <span className="instance-pin-icon" title="Pinned">&#128204;</span>}
            {inst.name}
            {unreadIds.has(inst.id) && <span className="instance-unread-dot" style={{ backgroundColor: inst.color }} />}
            {inst.mcpServers.length > 0 && (
              <span className="instance-mcp-badge" title={inst.mcpServers.join(', ')}>
                MCP {inst.mcpServers.length}
              </span>
            )}
          </div>
        )}
        <div className="instance-meta">{dirName(inst.workingDirectory)}</div>
      </div>
      <div className="instance-item-right">
        <span className={`instance-status ${inst.status}`}>
          {inst.status === 'running' ? 'live' : `exit ${inst.exitCode ?? '?'}`}
        </span>
        <div className="instance-item-actions">
          <button title="Info" onClick={(e) => { e.stopPropagation(); togglePopover(inst.id, 'info') }}>i</button>
          <button title="Rename" onClick={(e) => { e.stopPropagation(); startRename(inst) }}>&#9998;</button>
          <button
            title={inst.pinned ? 'Unpin' : 'Pin'}
            onClick={(e) => { e.stopPropagation(); inst.pinned ? onUnpin(inst.id) : onPin(inst.id) }}
          >
            {inst.pinned ? '&#9675;' : '&#9679;'}
          </button>
          {inst.status === 'running' ? (
            <button className="danger" title="Kill" onClick={(e) => { e.stopPropagation(); onKill(inst.id) }}>&#9632;</button>
          ) : (
            <button className="danger" title="Remove" onClick={(e) => { e.stopPropagation(); onRemove(inst.id) }}>&times;</button>
          )}
        </div>
      </div>

      {popoverId === inst.id && popoverType === 'color' && (
        <div className="instance-popover" onClick={(e) => e.stopPropagation()}>
          <div className="inline-color-picker">
            {COLORS.map((c) => (
              <div
                key={c}
                className={`color-swatch small ${c === inst.color ? 'selected' : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => { onRecolor(inst.id, c); setPopoverId(null) }}
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
      )}
      {popoverId === inst.id && popoverType === 'info' && (
        <div className="instance-popover" onClick={(e) => e.stopPropagation()}>
          <div className="instance-info-row"><span>cmd</span> claude {inst.args.join(' ') || '(interactive)'}</div>
          <div className="instance-info-row"><span>dir</span> {inst.workingDirectory}</div>
          <div className="instance-info-row"><span>pid</span> {inst.pid ?? '—'}</div>
          <div className="instance-info-row"><span>started</span> {new Date(inst.createdAt).toLocaleTimeString()}</div>
          {inst.mcpServers.length > 0 && (
            <div className="instance-info-row"><span>mcp</span> {inst.mcpServers.join(', ')}</div>
          )}
        </div>
      )}
    </div>
  )

  return (
    <div className="sidebar" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="sidebar-header">
        <div className="sidebar-tabs">
          <button className={`sidebar-tab ${view === 'instances' ? 'active' : ''}`} onClick={() => onViewChange('instances')}>
            Instances {instances.length > 0 && <span className="sidebar-tab-count">{instances.length}</span>}
          </button>
          <button className={`sidebar-tab ${view === 'agents' ? 'active' : ''}`} onClick={() => onViewChange('agents')}>
            Agents
          </button>
        </div>
      </div>

      {view === 'instances' && (
        <div className="sidebar-instance-actions">
          <button className="sidebar-new-btn" onClick={onNew}>+ New Instance</button>
          {restorableCount > 0 && instances.length === 0 && (
            <button className="sidebar-restore-btn" onClick={onRestoreAll}>
              Restore {restorableCount} session{restorableCount > 1 ? 's' : ''} from last run
            </button>
          )}
        </div>
      )}

      <div className="instance-list">
        {pinned.length > 0 && (
          <>
            <div className="instance-list-divider">Pinned</div>
            {pinned.map(renderInstance)}
          </>
        )}
        {running.length > 0 && (
          <>
            {pinned.length > 0 && <div className="instance-list-divider">Running</div>}
            {running.map(renderInstance)}
          </>
        )}
        {exited.length > 0 && (running.length > 0 || pinned.length > 0) && (
          <div className="instance-list-divider">Stopped</div>
        )}
        {exited.map(renderInstance)}
        {instances.length === 0 && (
          <div className="instance-list-empty">No instances</div>
        )}
      </div>

      <div className="sidebar-sessions">
        <div className="sidebar-sessions-header">
          <span className="sidebar-sessions-title">History</span>
          <span className="sidebar-sessions-count">{filteredSessions.length}</span>
          <button
            className="sidebar-sessions-refresh"
            onClick={() => window.api.sessions.list(100).then(setSessions)}
            title="Refresh"
          >
            &#8635;
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
            <div key={s.sessionId} className="sidebar-session-item" onClick={() => onResumeSession(s)}>
              <div className="sidebar-session-display">
                {s.name || s.display}
                {s.recentlyOpened && <span className="sidebar-session-recent-badge">recent</span>}
              </div>
              {s.name && <div className="sidebar-session-command">{s.display}</div>}
              <div className="sidebar-session-meta">
                <span className="sidebar-session-project">{s.projectName}</span>
                <span>{formatTime(s.timestamp)}</span>
              </div>
            </div>
          ))}
          {filteredSessions.length === 0 && (
            <div className="instance-list-empty">
              {sessionSearch ? 'No matches' : 'No sessions'}
            </div>
          )}
        </div>
      </div>

      <div className="sidebar-footer">
        <button
          className={`sidebar-footer-btn ${view === 'settings' ? 'active' : ''}`}
          onClick={() => onViewChange(view === 'settings' ? 'instances' : 'settings')}
        >
          Settings
        </button>
      </div>
    </div>
  )
}
