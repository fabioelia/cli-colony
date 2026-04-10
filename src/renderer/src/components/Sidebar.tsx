import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { Info, Pencil, Pin, PinOff, Square, Play, Trash2, RefreshCw, Settings, Plus, GitPullRequest, Columns2, ListChecks, TerminalSquare, Bot, Zap, Server, User, Bell, BellRing, FileDown, GitFork, ChevronDown, ChevronRight, Trophy, BookTemplate, FolderOpen, Crown, GitCompare, Layers, CheckSquare, X, Shield, Copy, AlertTriangle, Archive } from 'lucide-react'
import type { ClaudeInstance, CliSession, RecentSession } from '../types'
import { SESSION_ROLES } from '../../../shared/types'
import type { ActivityEvent, ApprovalRequest, ForkGroup, SessionTemplate } from '../../../shared/types'
import { stripAnsi } from '../../../shared/utils'

const ROLE_ABBREV: Record<string, string> = {
  Orchestrator: 'Orch', Planner: 'Plan', Coder: 'Code',
  Tester: 'Test', Reviewer: 'Rev', Researcher: 'Res',
  Coordinator: 'Coord', Worker: 'Work',
}
import Tooltip from './Tooltip'
import HelpPopover from './HelpPopover'
import ExternalSessionPopover from './ExternalSessionPopover'
import WorkspacePresets from './WorkspacePresets'
import NotificationHistory from './NotificationHistory'
import type { WorkspacePreset } from './WorkspacePresets'
import { COLORS, formatTime, cliBackendLabel, formatInstanceCmd } from '../lib/constants'

export type SidebarView = 'instances' | 'agents' | 'github' | 'sessions' | 'settings' | 'logs' | 'tasks' | 'pipelines' | 'environments' | 'personas' | 'outputs' | 'review' | 'artifacts'

// ---- Memoized per-instance row ----

interface InstanceItemCallbacks {
  onSelect: (id: string) => void
  onKill: (id: string) => void
  onRestart: (id: string) => void
  onRemove: (id: string) => void
  onPin: (id: string) => void
  onUnpin: (id: string) => void
  onContextMenu: (id: string, x: number, y: number) => void
  onColorClick: (id: string, e: React.MouseEvent) => void
  onInfoClick: (id: string, e: React.MouseEvent) => void
  onStartRename: (inst: ClaudeInstance) => void
  onCommitRename: () => void
  onCancelRename: () => void
  onRenameChange: (v: string) => void
  onHandoff: (inst: ClaudeInstance) => void
}

interface InstanceItemProps {
  inst: ClaudeInstance
  isActive: boolean
  shortcutIndex: number | null
  isUnread: boolean
  ctxLevel: 'amber' | 'red' | null
  splitBadge: 'left' | 'right' | 'indicator' | null
  focusedPane: 'left' | 'right'
  isRenaming: boolean
  renameValue: string
  renameRef: React.RefObject<HTMLInputElement | null>
  isEditingNote: boolean
  noteValue: string
  noteRef: React.RefObject<HTMLInputElement | null>
  onCommitNote: () => void
  onCancelNote: () => void
  onNoteChange: (v: string) => void
  callbacks: InstanceItemCallbacks
  selectMode: boolean
  isSelected: boolean
  onToggleSelect: (id: string) => void
  conflictFiles: { file: string; otherSessions: { id: string; name: string }[] }[] | null
}

function dirName(path: string) {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

interface TriggerChainNode {
  id: string
  name: string
  status: 'running' | 'exited'
  depth: number
}

function buildTriggerChain(inst: ClaudeInstance, allInstances: ClaudeInstance[]): TriggerChainNode[] {
  const byId = new Map(allInstances.map((i) => [i.id, i]))

  // Walk up to root ancestor (cap at depth 5)
  let root = inst
  const ancestors: ClaudeInstance[] = []
  for (let i = 0; i < 5 && root.parentId; i++) {
    const parent = byId.get(root.parentId)
    if (!parent) break
    ancestors.unshift(parent)
    root = parent
  }

  // DFS from root, collecting nodes with depth
  const result: TriggerChainNode[] = []
  const visit = (node: ClaudeInstance, depth: number) => {
    result.push({ id: node.id, name: node.name, status: node.status, depth })
    if (depth >= 5) return
    for (const childId of node.childIds) {
      const child = byId.get(childId)
      if (child) visit(child, depth + 1)
    }
  }
  visit(root, 0)

  // If root is below ancestors (shouldn't happen, but guard against it)
  if (ancestors.length > 0 && result[0]?.id !== ancestors[0]?.id) {
    // ancestors[0] is the true root — build from there
    result.length = 0
    visit(ancestors[0], 0)
  }

  return result
}

const InstanceItem = React.memo(function InstanceItem({ inst, isActive, shortcutIndex, isUnread, ctxLevel, splitBadge, focusedPane, isRenaming, renameValue, renameRef, isEditingNote, noteValue, noteRef, onCommitNote, onCancelNote, onNoteChange, callbacks, selectMode, isSelected, onToggleSelect, conflictFiles }: InstanceItemProps) {
  return (
    <div
      className={`instance-item ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={(e) => {
        if (selectMode) { onToggleSelect(inst.id); return }
        if (e.metaKey || e.ctrlKey) { onToggleSelect(inst.id); return }
        callbacks.onSelect(inst.id)
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          if (selectMode) { onToggleSelect(inst.id) } else { callbacks.onSelect(inst.id) }
        }
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        callbacks.onContextMenu(inst.id, Math.min(e.clientX, window.innerWidth - 200), Math.min(e.clientY, window.innerHeight - 150))
      }}
    >
      {selectMode && (
        <input
          type="checkbox"
          className="instance-item-checkbox"
          checked={isSelected}
          onChange={() => onToggleSelect(inst.id)}
          onClick={(e) => e.stopPropagation()}
        />
      )}
      {shortcutIndex && (
        <span className="instance-shortcut" title={`Cmd+${shortcutIndex}`}>{shortcutIndex}</span>
      )}
      <div
        className={`instance-dot clickable ${inst.status === 'running' && inst.activity === 'busy' ? 'pulsing' : ''}`}
        style={{
          backgroundColor: inst.color,
          color: inst.color,
          opacity: inst.status === 'exited' ? 0.4 : 1,
        }}
        onClick={(e) => { e.stopPropagation(); callbacks.onColorClick(inst.id, e) }}
        title="Change color"
      />
      <div className="instance-info">
        {isRenaming ? (
          <input
            ref={renameRef}
            className="rename-input"
            value={renameValue}
            onChange={(e) => callbacks.onRenameChange(e.target.value)}
            onBlur={callbacks.onCommitRename}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') callbacks.onCommitRename()
              if (e.key === 'Escape') callbacks.onCancelRename()
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <>
          <div className="instance-name">
            {inst.pinned && <span className="instance-pin-icon" title="Pinned"><Pin size={11} /></span>}
            {inst.name}
          </div>
          {(() => {
            const badges: Array<{ node: React.ReactNode; label: string }> = []
            if (splitBadge === 'left')
              badges.push({ node: <span key="sl" className={`split-badge ${focusedPane === 'left' ? 'focused' : ''}`} title="Left split pane">L</span>, label: 'L' })
            if (splitBadge === 'right')
              badges.push({ node: <span key="sr" className={`split-badge ${focusedPane === 'right' ? 'focused' : ''}`} title="Right split pane">R</span>, label: 'R' })
            if (splitBadge === 'indicator')
              badges.push({ node: <span key="si" className="split-indicator" title="Split with another session"><Columns2 size={11} /></span>, label: 'split' })
            if (inst.status === 'running' && inst.activity === 'waiting')
              badges.push({ node: <span key="at" className="instance-attention-badge" title="Waiting for your input">your turn</span>, label: 'your turn' })
            else if (isUnread)
              badges.push({ node: <span key="ur" className="instance-unread-badge" title="New output you haven't seen">new</span>, label: 'new' })
            if (ctxLevel)
              badges.push({ node: <button key="cx" className={`instance-ctx-badge ${ctxLevel}`} title={ctxLevel === 'red' ? 'Context near limit · Click to export handoff doc' : 'Context building up · Click to export handoff doc'} onClick={(e) => { e.stopPropagation(); callbacks.onHandoff(inst) }}>ctx</button>, label: `ctx (${ctxLevel})` })
            if (inst.roleTag) {
              if (inst.roleTag === 'Coordinator') {
                badges.push({ node: <span key="ro" className="instance-coordinator-badge" title="Coordinator role — manages worker sessions"><Crown size={14} /></span>, label: 'Coordinator' })
              } else {
                badges.push({ node: <span key="ro" className={`instance-role-badge role-${inst.roleTag.toLowerCase()}`} title={`Role: ${inst.roleTag}`}>{ROLE_ABBREV[inst.roleTag] ?? inst.roleTag.slice(0, 4)}</span>, label: inst.roleTag })
              }
            }
            if (inst.mcpServers.length > 0)
              badges.push({ node: <span key="mc" className="instance-mcp-badge" title={inst.mcpServers.join(', ')}>MCP {inst.mcpServers.length}</span>, label: `MCP ${inst.mcpServers.length}` })
            if (inst.cliBackend === 'cursor-agent')
              badges.push({ node: <span key="cl" className="instance-cli-badge" title="CLI for this session">{cliBackendLabel(inst.cliBackend)}</span>, label: cliBackendLabel(inst.cliBackend) })
            if (inst.pendingSteer)
              badges.push({ node: <span key="ps" className="instance-steer-badge" title="Steering message queued — will be delivered when session is next idle">Steer</span>, label: 'Steer' })
            if (inst.toolDeferredInfo)
              badges.push({ node: <span key="td" className="instance-deferred-badge" title={`Tool deferred: ${inst.toolDeferredInfo.toolName}`}>Defer</span>, label: 'Defer' })
            if (inst.permissionMode === 'supervised')
              badges.push({ node: <span key="pm" className="instance-supervised-badge" title="Supervised mode — Claude asks before risky actions"><Shield size={11} /></span>, label: 'Supervised' })
            if (conflictFiles && conflictFiles.length > 0)
              badges.push({ node: <span key="cf" className="instance-conflict-badge" title={conflictFiles.map(o => `${o.file} (also in ${o.otherSessions.map(s => s.name).join(', ')})`).join('\n')}><AlertTriangle size={11} /> {conflictFiles.length}</span>, label: `${conflictFiles.length} conflict${conflictFiles.length > 1 ? 's' : ''}` })
            if (badges.length === 0) return null
            return (
              <div className="instance-badges">
                {badges.map(b => b.node)}
              </div>
            )
          })()}
          </>
        )}
        {isEditingNote ? (
          <input
            ref={noteRef}
            className="instance-note-input"
            value={noteValue}
            onChange={(e) => onNoteChange(e.target.value)}
            onBlur={onCommitNote}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') onCommitNote()
              if (e.key === 'Escape') onCancelNote()
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder="Add a note..."
            maxLength={500}
          />
        ) : inst.note ? (
          <div className="instance-note" title={inst.note}>
            {inst.note}
          </div>
        ) : null}
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
        {inst.status !== 'running' && (
          <span className={`instance-status ${(inst.exitCode == null || inst.exitCode === 0) ? 'done' : 'exited'}`}>
            {(inst.exitCode == null || inst.exitCode === 0) ? 'done' : `err ${inst.exitCode}`}
          </span>
        )}
        <div className="instance-item-actions">
          <Tooltip text="Export Handoff Doc" detail="Generate a markdown snapshot to paste into a new session and restore context">
            <button aria-label="Export Handoff Doc" onClick={(e) => { e.stopPropagation(); callbacks.onHandoff(inst) }}><FileDown size={13} /></button>
          </Tooltip>
          <Tooltip text="Session Info" detail="View command, directory, PID, and MCP servers">
            <button aria-label="Info" onClick={(e) => { e.stopPropagation(); callbacks.onInfoClick(inst.id, e) }}><Info size={13} /></button>
          </Tooltip>
          <Tooltip text="Rename" detail="Change the session display name">
            <button aria-label="Rename" onClick={(e) => { e.stopPropagation(); callbacks.onStartRename(inst) }}><Pencil size={13} /></button>
          </Tooltip>
          <Tooltip text={inst.pinned ? 'Unpin Session' : 'Pin Session'} detail={inst.pinned ? 'Remove from pinned section' : 'Keep at the top of the sidebar'}>
            <button
              aria-label={inst.pinned ? 'Unpin' : 'Pin'}
              onClick={(e) => { e.stopPropagation(); inst.pinned ? callbacks.onUnpin(inst.id) : callbacks.onPin(inst.id) }}
            >
              {inst.pinned ? <PinOff size={13} /> : <Pin size={13} />}
            </button>
          </Tooltip>
          {inst.status === 'running' ? (
            <Tooltip text="Kill Session" detail="Terminate the CLI process for this session">
              <button className="danger" aria-label="Kill" onClick={(e) => { e.stopPropagation(); callbacks.onKill(inst.id) }}><Square size={13} /></button>
            </Tooltip>
          ) : (
            <>
              <Tooltip text="Restart" detail="Launch a new session in the same directory">
                <button aria-label="Restart" onClick={(e) => { e.stopPropagation(); callbacks.onRestart(inst.id) }}><Play size={13} /></button>
              </Tooltip>
              <Tooltip text="Remove" detail="Remove this stopped session from the list">
                <button className="danger" aria-label="Remove" onClick={(e) => { e.stopPropagation(); callbacks.onRemove(inst.id) }}><Trash2 size={13} /></button>
              </Tooltip>
            </>
          )}
        </div>
      </div>
    </div>
  )
}, (prev, next) => {
  // Custom comparator — only re-render when this item's data actually changed
  const a = prev.inst, b = next.inst
  return a.id === b.id && a.status === b.status && a.activity === b.activity &&
    a.name === b.name && a.color === b.color && a.pinned === b.pinned &&
    a.gitBranch === b.gitBranch && a.roleTag === b.roleTag &&
    a.exitCode === b.exitCode && a.pendingSteer === b.pendingSteer &&
    a.toolDeferredInfo?.toolName === b.toolDeferredInfo?.toolName &&
    a.permissionMode === b.permissionMode &&
    a.mcpServers.length === b.mcpServers.length &&
    a.cliBackend === b.cliBackend && a.childIds.length === b.childIds.length &&
    a.workingDirectory === b.workingDirectory && a.parentId === b.parentId &&
    (a.gitRepo || '') === (b.gitRepo || '') &&
    prev.isActive === next.isActive &&
    prev.shortcutIndex === next.shortcutIndex &&
    prev.isUnread === next.isUnread &&
    prev.ctxLevel === next.ctxLevel &&
    prev.splitBadge === next.splitBadge &&
    prev.focusedPane === next.focusedPane &&
    prev.isRenaming === next.isRenaming &&
    prev.renameValue === next.renameValue &&
    prev.callbacks === next.callbacks &&
    prev.selectMode === next.selectMode &&
    prev.isSelected === next.isSelected &&
    prev.onToggleSelect === next.onToggleSelect &&
    prev.conflictFiles === next.conflictFiles
})

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
  onSetNote: (id: string, note: string) => void
  onRecolor: (id: string, color: string) => void
  onPin: (id: string) => void
  onUnpin: (id: string) => void
  onViewChange: (view: SidebarView) => void
  onResumeSession: (session: CliSession) => void
  onTakeoverExternal: (ext: { pid: number; name: string; cwd: string; sessionId: string | null }) => void
  onRestoreAll: () => void
  restorableCount: number
  unreadIds: Set<string>
  outputBytes: Map<string, number>
  splitId: string | null
  splitPairs: Map<string, string>
  focusedPane: 'left' | 'right'
  onSplitWith: (id: string) => void
  onCloseSplit: () => void
  onDrop?: (e: React.DragEvent) => void
  forkGroups?: ForkGroup[]
  onForkSession?: (id: string) => void
  gridPanes?: (string | null)[]
  currentLayout?: 'single' | '2-up' | '4-up'
  onLoadPreset?: (preset: WorkspacePreset) => void
  onCloneSession?: (inst: ClaudeInstance) => void
}

function SessionTile({ s, onResumeSession, hoveredSessionId, setHoveredSessionId, popoverPos, setPopoverPos, formatTime }: {
  s: CliSession
  onResumeSession: (session: CliSession) => void
  hoveredSessionId: string | null
  setHoveredSessionId: (id: string | null) => void
  popoverPos: { top: number } | null
  setPopoverPos: (pos: { top: number } | null) => void
  formatTime: (ts: number) => string
}) {
  return (
    <div
      className="sidebar-session-item"
      role="button"
      tabIndex={0}
      onClick={() => onResumeSession(s)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onResumeSession(s) } }}
      onMouseEnter={(e) => {
        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
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
  )
}

function SidebarInner({ instances, activeId, view, onSelect, onNew, onKill, onRestart, onRemove, onRename, onSetNote, onRecolor, onPin, onUnpin, onViewChange, onResumeSession, onTakeoverExternal, onRestoreAll, restorableCount, unreadIds, outputBytes, splitId, splitPairs, focusedPane, onSplitWith, onCloseSplit, onDrop, forkGroups = [], onForkSession, gridPanes, currentLayout = 'single', onLoadPreset, onCloneSession }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null)
  const [noteValue, setNoteValue] = useState('')
  const noteRef = useRef<HTMLInputElement>(null)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [runningEnvCount, setRunningEnvCount] = useState(0)
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [expandedForkGroups, setExpandedForkGroups] = useState<Set<string>>(new Set())
  const [forkSectionOpen, setForkSectionOpen] = useState(true)

  // Concurrent file conflict detection — poll every 30s
  const [fileOverlaps, setFileOverlaps] = useState<Record<string, { file: string; otherSessions: { id: string; name: string }[] }[]>>({})
  useEffect(() => {
    const poll = () => window.api.instance.fileOverlaps().then(setFileOverlaps).catch(() => {})
    poll()
    const id = setInterval(poll, 30000)
    return () => clearInterval(id)
  }, [])

  type GroupBy = 'none' | 'persona' | 'project' | 'status'
  const [groupBy, setGroupBy] = useState<GroupBy>(() => (localStorage.getItem('sidebar-group-by') as GroupBy) || 'none')
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('sidebar-collapsed-groups') || '[]')) } catch { return new Set() }
  })
  const toggleGroupCollapse = useCallback((group: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group); else next.add(group)
      localStorage.setItem('sidebar-collapsed-groups', JSON.stringify([...next]))
      return next
    })
  }, [])
  const handleGroupByChange = useCallback((val: GroupBy) => {
    setGroupBy(val)
    localStorage.setItem('sidebar-group-by', val)
  }, [])

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
    setSelectMode(true)
  }, [])

  const exitSelectMode = useCallback(() => {
    setSelectMode(false)
    setSelectedIds(new Set())
  }, [])

  // Instance ordering + grouping — must be declared before the useEffect that references flatOrderForIndexing
  const { pinned, running, exited, orderedInstances } = useMemo(() => {
    const p = instances.filter((i) => i.pinned)
    const r = instances.filter((i) => i.status === 'running' && !i.pinned)
    const e = instances.filter((i) => i.status !== 'running' && !i.pinned)
    return { pinned: p, running: r, exited: e, orderedInstances: [...p, ...r, ...e] }
  }, [instances])

  const groupedSections = useMemo(() => {
    if (groupBy === 'none') return null
    const getKey = (inst: ClaudeInstance): string => {
      if (groupBy === 'persona') {
        if (inst.name.startsWith('Persona: ')) return inst.name.replace('Persona: ', '').split(' ')[0]
        return 'Manual'
      }
      if (groupBy === 'project') return dirName(inst.workingDirectory)
      // status
      return inst.status === 'running' ? (inst.activity === 'busy' ? 'Busy' : 'Idle') : 'Stopped'
    }
    const groups = new Map<string, ClaudeInstance[]>()
    for (const inst of orderedInstances) {
      const key = getKey(inst)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(inst)
    }
    return [...groups.entries()].map(([label, items]) => ({ label, items }))
  }, [groupBy, orderedInstances])

  const flatOrderForIndexing = useMemo(() => {
    if (!groupedSections) return orderedInstances
    return groupedSections.flatMap(g => g.items)
  }, [groupedSections, orderedInstances])

  const instanceIndexMap = useMemo(() => {
    const m = new Map<string, number | null>()
    for (let idx = 0; idx < flatOrderForIndexing.length; idx++) {
      m.set(flatOrderForIndexing[idx].id, idx < 9 ? idx + 1 : null)
    }
    return m
  }, [flatOrderForIndexing])

  // Escape exits select mode, Cmd+A selects all visible instances
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && selectMode) {
        exitSelectMode()
        e.stopPropagation()
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'a' && view === 'instances' && selectMode) {
        e.preventDefault()
        const visibleIds = flatOrderForIndexing.map(i => i.id)
        setSelectedIds(prev => {
          // If all visible are already selected, deselect all
          if (visibleIds.every(id => prev.has(id))) return new Set()
          return new Set(visibleIds)
        })
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [selectMode, view, flatOrderForIndexing, exitSelectMode])

  // Clean up stale selections (removed instances)
  useEffect(() => {
    if (selectedIds.size === 0) return
    const instanceIds = new Set(instances.map(i => i.id))
    const stale = [...selectedIds].filter(id => !instanceIds.has(id))
    if (stale.length > 0) {
      setSelectedIds(prev => {
        const next = new Set(prev)
        stale.forEach(id => next.delete(id))
        if (next.size === 0) setSelectMode(false)
        return next
      })
    }
  }, [instances, selectedIds])

  useEffect(() => {
    window.api.appUpdate.getStatus().then((s: any) => s?.currentVersion && setAppVersion(s.currentVersion)).catch(() => {})
  }, [])

  useEffect(() => {
    // Load initial count, then rely on push subscription for updates (no polling needed)
    window.api.env.list().then(envs => {
      setRunningEnvCount(envs.filter(e => e.status === 'running' || e.status === 'partial').length)
    }).catch(() => {})
    const unsub = window.api.env.onStatusUpdate((envs) => {
      setRunningEnvCount(envs.filter(e => e.status === 'running' || e.status === 'partial').length)
    })
    return unsub
  }, [])
  const [popoverId, setPopoverId] = useState<string | null>(null)
  const [popoverType, setPopoverType] = useState<'color' | 'info' | null>(null)
  const [templates, setTemplates] = useState<SessionTemplate[]>([])
  const [showTemplatePopover, setShowTemplatePopover] = useState(false)
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(null)
  const [exportedId, setExportedId] = useState<string | null>(null)
  const newSessionBtnRef = useRef<HTMLButtonElement>(null)
  const [sessions, setSessions] = useState<CliSession[]>([])
  const [sessionSearch, setSessionSearch] = useState('')
  const [sessionSort, setSessionSort] = useState<'recent' | 'messages' | 'name'>(() => (localStorage.getItem('colony:sessionSort') as any) || 'recent')
  const [sessionProjectFilter, setSessionProjectFilter] = useState<string | null>(() => localStorage.getItem('colony:sessionProjectFilter') || null)
  type SessionGroupBy = 'none' | 'project' | 'date'
  const [sessionGroupBy, setSessionGroupBy] = useState<SessionGroupBy>(() =>
    (localStorage.getItem('colony:sessionGroupBy') as SessionGroupBy) || 'none')
  const [sessionCollapsedGroups, setSessionCollapsedGroups] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem('colony:sessionCollapsedGroups') || '[]')) } catch { return new Set() }
  })
  const toggleSessionGroupCollapse = useCallback((group: string) => {
    setSessionCollapsedGroups(prev => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group); else next.add(group)
      localStorage.setItem('colony:sessionCollapsedGroups', JSON.stringify([...next]))
      return next
    })
  }, [])
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

  useEffect(() => { localStorage.setItem('colony:sessionSort', sessionSort) }, [sessionSort])
  useEffect(() => {
    if (sessionProjectFilter) localStorage.setItem('colony:sessionProjectFilter', sessionProjectFilter)
    else localStorage.removeItem('colony:sessionProjectFilter')
  }, [sessionProjectFilter])

  // Restore persisted sidebar width on mount, clamped to minimum
  useEffect(() => {
    const saved = localStorage.getItem('sidebar-width')
    if (saved) {
      const width = Math.max(298, parseInt(saved, 10))
      document.documentElement.style.setProperty('--sidebar-width', width + 'px')
    }
  }, [])

  const handleResizeMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || 280
    const onMove = (ev: MouseEvent) => {
      const newWidth = Math.max(298, Math.min(480, startWidth + ev.clientX - startX))
      document.documentElement.style.setProperty('--sidebar-width', newWidth + 'px')
      localStorage.setItem('sidebar-width', String(newWidth))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'ew-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const [externalSessions, setExternalSessions] = useState<Array<{ pid: number; name: string; cwd: string; sessionId: string | null; args: string }>>([])
  const [extPopover, setExtPopover] = useState<{ session: { pid: number; name: string; cwd: string; sessionId: string | null; args: string }; rect: { top: number; left: number; bottom: number; right: number } } | null>(null)
  const [childProcesses, setChildProcesses] = useState<Array<{ pid: number; name: string; command: string; cpu: string; mem: string }>>([])
  const [childProcessesId, setChildProcessesId] = useState<string | null>(null)
  const [activityEvents, setActivityEvents] = useState<ActivityEvent[]>([])
  const [activityUnread, setActivityUnread] = useState(0)
  const [showActivityPopover, setShowActivityPopover] = useState(false)
  const [showNotifPopover, setShowNotifPopover] = useState(false)
  const [notifUnread, setNotifUnread] = useState(0)
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const [handoffInst, setHandoffInst] = useState<ClaudeInstance | null>(null)
  const [handoffDoc, setHandoffDoc] = useState('')
  const [handoffLoading, setHandoffLoading] = useState(false)
  const [handoffCopied, setHandoffCopied] = useState(false)
  const [handoffSummarizing, setHandoffSummarizing] = useState(false)
  const [handoffSummary, setHandoffSummary] = useState<string | null>(null)
  const [handoffSumError, setHandoffSumError] = useState<string | null>(null)

  // Lazy-load session history — defer to avoid blocking initial render
  const sessionsLoadedRef = useRef(false)
  const [sessionsReady, setSessionsReady] = useState(false)
  useEffect(() => {
    if (view !== 'instances' || sessionsLoadedRef.current) return
    sessionsLoadedRef.current = true
    // Defer so initial render completes first
    const timer = setTimeout(() => {
      Promise.all([
        window.api.sessions.list(500).then(setSessions),
        window.api.sessions.external().then(setExternalSessions),
      ]).then(() => setSessionsReady(true))
    }, 1000)
    return () => clearTimeout(timer)
  }, [view])

  useEffect(() => {
    window.api.sessionTemplates.list().then(setTemplates).catch(() => {})
  }, [])

  useEffect(() => {
    window.api.activity.list().then(events => {
      setActivityEvents(events.slice(-20).reverse())
    }).catch(() => {})
    window.api.activity.unreadCount().then(setActivityUnread).catch(() => {})
    const unsubNew = window.api.activity.onNew(({ event, unreadCount }) => {
      setActivityEvents(prev => [event, ...prev].slice(0, 20))
      setActivityUnread(unreadCount)
    })
    const unsubUnread = window.api.activity.onUnread(({ count }) => {
      setActivityUnread(count)
    })
    window.api.pipeline.listApprovals().then(setPendingApprovals).catch(() => {})
    const unsubApprovalNew = window.api.pipeline.onApprovalNew(req => {
      setPendingApprovals(prev => [...prev, req])
    })
    const unsubApprovalUpdate = window.api.pipeline.onApprovalUpdate(({ id }) => {
      setPendingApprovals(prev => prev.filter(r => r.id !== id))
    })
    return () => { unsubNew(); unsubUnread(); unsubApprovalNew(); unsubApprovalUpdate() }
  }, [])

  // Notification history unread count + live updates
  useEffect(() => {
    window.api.notifications.unreadCount().then(setNotifUnread).catch(() => {})
    const unsub = window.api.notifications.onNew(() => {
      setNotifUnread(prev => prev + 1)
    })
    return unsub
  }, [])

  useEffect(() => {
    if (!handoffInst) { setHandoffDoc(''); setHandoffSummary(null); setHandoffSumError(null); return }
    setHandoffLoading(true)
    setHandoffSummary(null)
    setHandoffSumError(null)
    Promise.all([
      window.api.instance.buffer(handoffInst.id),
      window.api.instance.gitLog(handoffInst.workingDirectory),
      window.api.instance.gitDiff(handoffInst.workingDirectory),
    ]).then(([buf, gitLog, gitDiff]) => {
      const clean = stripAnsi(buf)
      const lines = clean.split('\n').filter(l => l.trim())
      const tail = lines.slice(-50).join('\n')
      const parts: string[] = [
        `# Session Handoff: ${handoffInst.name}`,
        '',
        `**Generated:** ${new Date().toLocaleString()}`,
        `**Directory:** ${handoffInst.workingDirectory}`,
        `**Status:** ${handoffInst.status}${handoffInst.status === 'running' ? ` · ${handoffInst.activity}` : ''}`,
      ]
      if (handoffInst.gitBranch) {
        parts.push(`**Git:** ${handoffInst.gitBranch}${handoffInst.gitRepo ? ` on ${handoffInst.gitRepo}` : ''}`)
      }
      parts.push(
        `**CLI:** ${handoffInst.cliBackend}${handoffInst.args.length ? ' ' + handoffInst.args.join(' ') : ''}`,
        `**Started:** ${new Date(handoffInst.createdAt).toLocaleString()}`,
        '',
      )
      if (gitLog.trim()) {
        parts.push('## Recent Git Commits', '```', gitLog.trim(), '```', '')
      }
      if (gitDiff.trim()) {
        parts.push('## Uncommitted Changes', '```', gitDiff.trim(), '```', '')
      }
      parts.push('## Terminal Snapshot (last 50 lines)', '```', tail || '(empty)', '```', '', '---', '*Paste this into a new session to restore context.*')
      setHandoffDoc(parts.join('\n'))
      setHandoffLoading(false)
    }).catch(() => {
      setHandoffDoc('Error generating handoff doc.')
      setHandoffLoading(false)
    })
  }, [handoffInst])

  // Close popovers when clicking outside
  useEffect(() => {
    if (!popoverId) return
    const handler = () => { setPopoverId(null); setPopoverType(null); setInstancePopoverPos(null) }
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [popoverId])

  useEffect(() => {
    if (!showActivityPopover) return
    const handler = () => setShowActivityPopover(false)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [showActivityPopover])

  useEffect(() => {
    if (!showTemplatePopover) return
    const handler = () => setShowTemplatePopover(false)
    window.addEventListener('click', handler)
    return () => window.removeEventListener('click', handler)
  }, [showTemplatePopover])

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

  const startEditNote = (inst: ClaudeInstance) => {
    setEditingNoteId(inst.id)
    setNoteValue(inst.note || '')
    setTimeout(() => noteRef.current?.focus(), 0)
  }

  const commitNote = () => {
    if (editingNoteId) {
      onSetNote(editingNoteId, noteValue.trim())
    }
    setEditingNoteId(null)
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

  const formatActivityTime = (iso: string) => {
    const diff = Date.now() - new Date(iso).getTime()
    if (diff < 60000) return 'now'
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
    return `${Math.floor(diff / 86400000)}d ago`
  }

  const formatApprovalExpiry = (expiresAt: string | undefined) => {
    if (!expiresAt) return null
    const remaining = new Date(expiresAt).getTime() - Date.now()
    if (remaining <= 0) return 'expired'
    if (remaining < 3600000) return `expires in ${Math.ceil(remaining / 60000)}m`
    if (remaining < 86400000) return `expires in ${Math.ceil(remaining / 3600000)}h`
    return `expires in ${Math.ceil(remaining / 86400000)}d`
  }

  const formatDuration = (sec: number) => {
    if (sec < 60) return `${sec}s`
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`
    return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`
  }

  const filteredSessions = useMemo(() => {
    let result = sessions
    if (sessionSearch) {
      const q = sessionSearch.toLowerCase()
      result = result.filter((s) =>
        s.display.toLowerCase().includes(q) ||
        s.projectName.toLowerCase().includes(q) ||
        (s.name && s.name.toLowerCase().includes(q))
      )
    }
    if (sessionProjectFilter) {
      result = result.filter(s => s.projectName === sessionProjectFilter)
    }
    if (sessionSort === 'messages') {
      result = [...result].sort((a, b) => b.messageCount - a.messageCount)
    } else if (sessionSort === 'name') {
      result = [...result].sort((a, b) => a.display.localeCompare(b.display))
    }
    // 'recent' is the default order from the API — no re-sort needed
    return result
  }, [sessions, sessionSearch, sessionProjectFilter, sessionSort])

  const sessionGroupedSections = useMemo(() => {
    if (sessionGroupBy === 'none') return null
    const getKey = (s: CliSession): string => {
      if (sessionGroupBy === 'project') return s.projectName || 'Unknown'
      const todayStart = new Date().setHours(0, 0, 0, 0)
      const DAY = 86400000
      if (s.timestamp >= todayStart) return 'Today'
      if (s.timestamp >= todayStart - DAY) return 'Yesterday'
      if (s.timestamp >= todayStart - 6 * DAY) return 'This Week'
      if (s.timestamp >= todayStart - 29 * DAY) return 'This Month'
      return 'Older'
    }
    const groups = new Map<string, CliSession[]>()
    for (const s of filteredSessions) {
      const key = getKey(s)
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(s)
    }
    return [...groups.entries()].map(([label, items]) => ({ label, items, count: items.length }))
  }, [sessionGroupBy, filteredSessions])

  const uniqueProjects = useMemo(() =>
    [...new Set(sessions.map(s => s.projectName))].sort(),
    [sessions]
  )

  const ctxLevelFor = (bytes: number): 'amber' | 'red' | null => {
    if (bytes >= 600_000) return 'red'
    if (bytes >= 250_000) return 'amber'
    return null
  }

  // Stable callbacks ref for InstanceItem — avoids new objects on every render
  const itemCallbacksRef = useRef<InstanceItemCallbacks>(null!)
  if (!itemCallbacksRef.current) {
    itemCallbacksRef.current = {} as InstanceItemCallbacks
  }
  // Update to latest closures every render (ref identity stays stable)
  Object.assign(itemCallbacksRef.current, {
    onSelect, onKill, onRestart, onRemove, onPin, onUnpin,
    onContextMenu: (id: string, x: number, y: number) => setContextMenu({ id, x, y }),
    onColorClick: (id: string, e: React.MouseEvent) => togglePopover(id, 'color', e),
    onInfoClick: (id: string, e: React.MouseEvent) => togglePopover(id, 'info', e),
    onStartRename: startRename,
    onCommitRename: commitRename,
    onCancelRename: () => setRenamingId(null),
    onRenameChange: setRenameValue,
    onHandoff: (inst: ClaudeInstance) => { setHandoffInst(inst); setHandoffCopied(false) },
  } satisfies InstanceItemCallbacks)

  const renderItem = (inst: ClaudeInstance) => {
    const gridIdx = gridPanes ? gridPanes.indexOf(inst.id) : -1
    const isInGrid = gridIdx >= 0
    const splitBadge: 'left' | 'right' | 'indicator' | null =
      isInGrid ? (gridIdx === 0 ? 'left' : 'indicator') :
      splitId && inst.id === activeId ? 'left' :
      splitId && inst.id === splitId ? 'right' :
      inst.id !== activeId && inst.id !== splitId && splitPairs.has(inst.id) ? 'indicator' : null
    return (
      <InstanceItem
        key={inst.id}
        inst={inst}
        isActive={inst.id === activeId}
        shortcutIndex={instanceIndexMap.get(inst.id) ?? null}
        isUnread={unreadIds.has(inst.id)}
        ctxLevel={inst.status === 'running' ? ctxLevelFor(outputBytes.get(inst.id) || 0) : null}
        splitBadge={splitBadge}
        focusedPane={focusedPane}
        isRenaming={renamingId === inst.id}
        renameValue={renamingId === inst.id ? renameValue : ''}
        renameRef={renameRef}
        isEditingNote={editingNoteId === inst.id}
        noteValue={editingNoteId === inst.id ? noteValue : ''}
        noteRef={noteRef}
        onCommitNote={commitNote}
        onCancelNote={() => setEditingNoteId(null)}
        onNoteChange={setNoteValue}
        callbacks={itemCallbacksRef.current}
        selectMode={selectMode}
        isSelected={selectedIds.has(inst.id)}
        onToggleSelect={toggleSelect}
        conflictFiles={fileOverlaps[inst.id] || null}
      />
    )
  }

  return (
    <div className="sidebar" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="sidebar-resize-handle" onMouseDown={handleResizeMouseDown} />
      <div className="sidebar-header">
        <div className="sidebar-nav">
          <Tooltip text="Sessions" detail={`${instances.filter(i => i.status === 'running').length} running, ${instances.length} total`} shortcut="Cmd+1-9" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'instances' ? 'active' : ''}`} onClick={() => onViewChange('instances')}>
              <span className="sidebar-nav-icon">
                <TerminalSquare size={17} />
                {instances.length > 0 && <span className="sidebar-nav-badge">{instances.length}</span>}
              </span>
              <span className="sidebar-nav-label">Sessions</span>
            </button>
          </Tooltip>
          <Tooltip text="Agents" detail="Browse and create agent definitions" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'agents' ? 'active' : ''}`} onClick={() => onViewChange('agents')}>
              <span className="sidebar-nav-icon"><Bot size={17} /></span>
              <span className="sidebar-nav-label">Agents</span>
            </button>
          </Tooltip>
          <Tooltip text="Pull Requests" detail="GitHub PRs, reviews, comments" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'github' ? 'active' : ''}`} onClick={() => onViewChange('github')}>
              <span className="sidebar-nav-icon"><GitPullRequest size={17} /></span>
              <span className="sidebar-nav-label">PRs</span>
            </button>
          </Tooltip>
          <Tooltip text="Tasks" detail="Task queue and batch execution" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'tasks' ? 'active' : ''}`} onClick={() => onViewChange('tasks')}>
              <span className="sidebar-nav-icon"><ListChecks size={17} /></span>
              <span className="sidebar-nav-label">Tasks</span>
            </button>
          </Tooltip>
          <Tooltip text="Pipelines" detail="Automated triggers and actions" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'pipelines' ? 'active' : ''}`} onClick={() => onViewChange('pipelines')}>
              <span className="sidebar-nav-icon"><Zap size={17} /></span>
              <span className="sidebar-nav-label">Pipes</span>
            </button>
          </Tooltip>
          <Tooltip text="Environments" detail={runningEnvCount > 0 ? `${runningEnvCount} running` : 'Dev environment management'} position="bottom">
            <button className={`sidebar-nav-btn ${view === 'environments' ? 'active' : ''}`} onClick={() => onViewChange('environments')}>
              <span className="sidebar-nav-icon">
                <Server size={17} />
                {runningEnvCount > 0 && <span className="sidebar-nav-badge">{runningEnvCount}</span>}
              </span>
              <span className="sidebar-nav-label">Envs</span>
            </button>
          </Tooltip>
          <Tooltip text="Personas" detail="Autonomous AI agents with identity, goals, and memory" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'personas' ? 'active' : ''}`} onClick={() => onViewChange('personas')}>
              <span className="sidebar-nav-icon"><User size={17} /></span>
              <span className="sidebar-nav-label">Personas</span>
            </button>
          </Tooltip>
          <Tooltip text="Outputs" detail="Browse artifacts, briefs, and pipeline outputs" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'outputs' ? 'active' : ''}`} onClick={() => onViewChange('outputs')}>
              <span className="sidebar-nav-icon"><FolderOpen size={17} /></span>
              <span className="sidebar-nav-label">Outputs</span>
            </button>
          </Tooltip>
          <Tooltip text="Review" detail="Cross-session diff review dashboard" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'review' ? 'active' : ''}`} onClick={() => onViewChange('review')}>
              <span className="sidebar-nav-icon"><GitCompare size={17} /></span>
              <span className="sidebar-nav-label">Review</span>
            </button>
          </Tooltip>
          <Tooltip text="Artifacts" detail="Browse past session artifacts — commits, changes, and costs" position="bottom">
            <button className={`sidebar-nav-btn ${view === 'artifacts' ? 'active' : ''}`} onClick={() => onViewChange('artifacts')}>
              <span className="sidebar-nav-icon"><Archive size={17} /></span>
              <span className="sidebar-nav-label">History</span>
            </button>
          </Tooltip>
        </div>
      </div>

      <div className="sidebar-instance-actions" style={{ position: 'relative' }}>
        <button
          ref={newSessionBtnRef}
          className="sidebar-new-btn"
          onClick={(e) => {
            if (templates.length === 0) {
              onNew()
            } else {
              e.stopPropagation()
              setShowTemplatePopover((v) => !v)
            }
          }}
          title="Launch a new Claude CLI terminal (Cmd+T or Cmd+N)"
        >
          <Plus size={14} /> New Session <span className="sidebar-shortcut-hint">⌘N</span>
        </button>
        {showTemplatePopover && (
          <div
            className="template-popover"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              className="template-popover-item template-popover-blank"
              onClick={() => {
                setShowTemplatePopover(false)
                onNew()
              }}
            >
              <Plus size={12} /> Blank Session
            </button>
            <div className="template-popover-divider">Templates</div>
            <div className="template-popover-list">
              {templates.map((t) => (
                <button
                  key={t.id}
                  className="template-popover-item"
                  onClick={() => {
                    setShowTemplatePopover(false)
                    window.api.sessionTemplates.launch(t.id).then(() => {
                      window.api.sessionTemplates.list().then(setTemplates).catch(() => {})
                    }).catch(console.error)
                  }}
                >
                  <div className="template-popover-name">{t.name}</div>
                  {t.description && <div className="template-popover-desc">{t.description}</div>}
                  {t.model && <span className="template-popover-model">{t.model}</span>}
                  {t.role && <span className={`instance-role-badge role-${t.role.toLowerCase()}`}>{ROLE_ABBREV[t.role] ?? t.role.slice(0, 4)}</span>}
                </button>
              ))}
            </div>
          </div>
        )}
        {view === 'instances' && restorableCount > 0 && (
          <button className="sidebar-restore-btn" onClick={onRestoreAll} title="Restore previous sessions">
            Restore {restorableCount} from last run
          </button>
        )}
      </div>

      {instances.length > 2 && (
        <div className="sidebar-group-selector">
          <Layers size={11} />
          <select
            value={groupBy}
            onChange={(e) => handleGroupByChange(e.target.value as GroupBy)}
            className="sidebar-group-select"
          >
            <option value="none">No grouping</option>
            <option value="persona">By Persona</option>
            <option value="project">By Project</option>
            <option value="status">By Status</option>
          </select>
          <Tooltip text={selectMode ? 'Exit multi-select' : 'Multi-select'} detail="Select multiple sessions for bulk actions (stop, restart, remove)" position="bottom">
            <button
              className={`sidebar-select-toggle ${selectMode ? 'active' : ''}`}
              onClick={() => selectMode ? exitSelectMode() : setSelectMode(true)}
            >
              <CheckSquare size={12} />
            </button>
          </Tooltip>
        </div>
      )}

      <div className="instance-list">
        {/* Fork Groups section — shown above regular session list */}
        {forkGroups.filter(g => g.status === 'active').length > 0 && (
          <>
            <div
              className="instance-list-divider fork-groups-divider"
              style={{ cursor: 'pointer' }}
              onClick={() => setForkSectionOpen(o => !o)}
            >
              <GitFork size={11} /> Fork Groups ({forkGroups.filter(g => g.status === 'active').length})
              {forkSectionOpen ? <ChevronDown size={11} style={{ marginLeft: 'auto' }} /> : <ChevronRight size={11} style={{ marginLeft: 'auto' }} />}
            </div>
            {forkSectionOpen && forkGroups.filter(g => g.status === 'active').map(group => {
              const isExpanded = expandedForkGroups.has(group.id)
              const toggleExpanded = () => setExpandedForkGroups(prev => {
                const next = new Set(prev)
                if (next.has(group.id)) next.delete(group.id)
                else next.add(group.id)
                return next
              })
              return (
                <div key={group.id} className="fork-group">
                  <div
                    className="fork-group-header"
                    role="button"
                    tabIndex={0}
                    onClick={toggleExpanded}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleExpanded() } }}
                  >
                    {isExpanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    <span className="fork-group-label"><GitFork size={11} /> {group.label}</span>
                  </div>
                  {isExpanded && (
                    <div className="fork-group-forks">
                      {group.forks.map(fork => (
                        <div key={fork.id} className="fork-entry">
                          <div className="fork-entry-left">
                            <span className={`fork-entry-dot ${fork.status}`} />
                            <div className="fork-entry-info">
                              <span className="fork-entry-label">{fork.label}</span>
                              <span className="fork-entry-branch">{(() => { const b = fork.branch.replace('colony-fork-', ''); return b.length > 16 ? b.slice(0, 16) + '…' : b })()}</span>
                            </div>
                          </div>
                          <div className="fork-entry-actions">
                            {fork.status === 'crashed' && (
                              <span className="fork-entry-crashed-badge">crashed</span>
                            )}
                            {(fork.status === 'running' || fork.status === 'waiting' || fork.status === 'crashed') && (
                              <>
                                <button
                                  className="fork-entry-btn winner-btn"
                                  title="Pick this fork as the winner"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (confirm(`Pick "${fork.label}" as winner? All other forks will be discarded.`)) {
                                      window.api.fork.pickWinner(group.id, fork.id).catch(console.error)
                                    }
                                  }}
                                >
                                  <Trophy size={10} /> Pick
                                </button>
                                <button
                                  className="fork-entry-btn discard-btn"
                                  title="Discard this fork"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (confirm(`Discard "${fork.label}"? This cannot be undone.`)) {
                                      window.api.fork.discard(group.id, fork.id).catch(console.error)
                                    }
                                  }}
                                >
                                  <Trash2 size={10} />
                                </button>
                              </>
                            )}
                            {fork.status === 'winner' && <span className="fork-entry-winner-badge">winner</span>}
                            {fork.status === 'discarded' && <span className="fork-entry-discarded-badge">discarded</span>}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </>
        )}
        {groupedSections ? (
          /* Grouped view */
          groupedSections.map(({ label, items }) => (
            <React.Fragment key={label}>
              <div
                className="instance-list-divider session-group-header"
                style={{ cursor: 'pointer' }}
                onClick={() => toggleGroupCollapse(label)}
              >
                {collapsedGroups.has(label) ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                {label}
                <span className="session-group-count">{items.length}</span>
              </div>
              {!collapsedGroups.has(label) && items.map(renderItem)}
            </React.Fragment>
          ))
        ) : (
          /* Default flat view */
          <>
            {pinned.length > 0 && (
              <>
                <div className="instance-list-divider">Pinned</div>
                {pinned.map(renderItem)}
              </>
            )}
            {running.length > 0 && (
              <>
                {pinned.length > 0 && <div className="instance-list-divider">Active</div>}
                {running.map(renderItem)}
              </>
            )}
            {exited.length > 0 && (running.length > 0 || pinned.length > 0) && (
              <div className="instance-list-divider">
                Stopped
                {exited.length > 1 && (
                  <button className="clear-stopped-btn" onClick={() => exited.forEach(i => onRemove(i.id))}>
                    Clear all
                  </button>
                )}
              </div>
            )}
            {exited.map(renderItem)}
          </>
        )}
        {instances.length === 0 && (
          <div className="instance-list-empty">No sessions · press Cmd+T or click New Session to start</div>
        )}
      </div>

      {/* Floating bulk action bar */}
      {selectMode && selectedIds.size > 0 && (
        <div className="sidebar-bulk-actions">
          <span className="sidebar-bulk-count">{selectedIds.size} selected</span>
          <Tooltip text="Stop selected" detail="Kill all selected running sessions">
            <button
              className="panel-header-btn"
              disabled={![...selectedIds].some(id => instances.find(i => i.id === id)?.status === 'running')}
              onClick={async () => {
                for (const id of selectedIds) {
                  const inst = instances.find(i => i.id === id)
                  if (inst?.status === 'running') await onKill(id)
                }
              }}
            >
              <Square size={12} /> Stop
            </button>
          </Tooltip>
          <Tooltip text="Restart selected" detail="Restart all selected stopped sessions">
            <button
              className="panel-header-btn"
              disabled={![...selectedIds].some(id => instances.find(i => i.id === id)?.status !== 'running')}
              onClick={async () => {
                for (const id of selectedIds) {
                  const inst = instances.find(i => i.id === id)
                  if (inst?.status !== 'running') await onRestart(id)
                }
              }}
            >
              <Play size={12} /> Restart
            </button>
          </Tooltip>
          <Tooltip text="Remove selected" detail="Remove all selected stopped sessions">
            <button
              className="panel-header-btn danger"
              disabled={![...selectedIds].some(id => instances.find(i => i.id === id)?.status !== 'running')}
              onClick={async () => {
                const removable = [...selectedIds].filter(id => instances.find(i => i.id === id)?.status !== 'running')
                if (removable.length === 0) return
                if (!confirm(`Remove ${removable.length} session${removable.length > 1 ? 's' : ''}? This cannot be undone.`)) return
                for (const id of removable) await onRemove(id)
                exitSelectMode()
              }}
            >
              <Trash2 size={12} /> Remove
            </button>
          </Tooltip>
          <button className="sidebar-bulk-deselect" onClick={exitSelectMode} title="Exit multi-select">
            <X size={12} />
          </button>
        </div>
      )}

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
            {(inst.parentId || (inst.childIds?.length ?? 0) > 0) && (() => {
              const chain = buildTriggerChain(inst, instances)
              return (
                <>
                  <div className="instance-info-divider" />
                  <div className="instance-info-section-label">Trigger Chain</div>
                  {chain.map((node) => (
                    <div
                      key={node.id}
                      className={`trigger-chain-node${node.id === inst.id ? ' current' : ''}`}
                      style={{ paddingLeft: node.depth * 12 }}
                      onClick={() => { onSelect(node.id); setPopoverId(null); setPopoverType(null); setInstancePopoverPos(null) }}
                    >
                      <span className={`trigger-chain-dot ${node.status === 'running' ? 'running' : 'exited'}`} />
                      {node.depth > 0 && <span className="trigger-chain-branch">&ensp;{'└─'}</span>}
                      <span className="trigger-chain-name" title={node.name}>{node.name.length > 30 ? node.name.slice(0, 30) + '…' : node.name}</span>
                    </div>
                  ))}
                </>
              )
            })()}
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
          <span className="sidebar-sessions-title">{sessionProjectFilter ? `History — ${sessionProjectFilter.split('/').pop()}` : 'History'}</span>
          <span className="sidebar-sessions-count">{filteredSessions.length}</span>
          <button
            className="sidebar-sessions-refresh"
            onClick={() => { window.api.sessions.list(500).then(setSessions); window.api.sessions.external().then(setExternalSessions) }}
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
        <div className="sidebar-sessions-filters">
          <select
            className="sidebar-sessions-filter-select"
            value={sessionSort}
            onChange={(e) => setSessionSort(e.target.value as 'recent' | 'messages' | 'name')}
            title="Sort sessions"
          >
            <option value="recent">Recent</option>
            <option value="messages">Most messages</option>
            <option value="name">Name A-Z</option>
          </select>
          <select
            className="sidebar-sessions-filter-select"
            value={sessionProjectFilter ?? ''}
            onChange={(e) => setSessionProjectFilter(e.target.value || null)}
            title="Filter by project"
          >
            <option value="">All Projects</option>
            {uniqueProjects.map(p => <option key={p} value={p}>{p.split('/').pop()}</option>)}
          </select>
          <select
            className="sidebar-sessions-filter-select"
            value={sessionGroupBy}
            onChange={(e) => {
              const val = e.target.value as SessionGroupBy
              setSessionGroupBy(val)
              localStorage.setItem('colony:sessionGroupBy', val)
            }}
            title="Group sessions"
          >
            <option value="none">No grouping</option>
            <option value="project">Group by project</option>
            <option value="date">Group by date</option>
          </select>
          {sessionProjectFilter && (
            <button
              className="sidebar-sessions-filter-clear"
              onClick={() => setSessionProjectFilter(null)}
              title="Clear project filter"
            >
              <X size={11} />
            </button>
          )}
        </div>
        <div className="sidebar-sessions-list">
          {sessionGroupedSections ? (
            sessionGroupedSections.map(({ label, items, count }) => (
              <div key={label}>
                <div className="instance-list-divider session-group-header" style={{ cursor: 'pointer' }} onClick={() => toggleSessionGroupCollapse(label)}>
                  {sessionCollapsedGroups.has(label) ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
                  {label}
                  <span className="session-group-count">{count}</span>
                </div>
                {!sessionCollapsedGroups.has(label) && items.map(s => (
                  <SessionTile key={s.sessionId} s={s} onResumeSession={onResumeSession}
                    hoveredSessionId={hoveredSessionId} setHoveredSessionId={setHoveredSessionId}
                    popoverPos={popoverPos} setPopoverPos={setPopoverPos} formatTime={formatTime} />
                ))}
              </div>
            ))
          ) : (
            filteredSessions.map(s => (
              <SessionTile key={s.sessionId} s={s} onResumeSession={onResumeSession}
                hoveredSessionId={hoveredSessionId} setHoveredSessionId={setHoveredSessionId}
                popoverPos={popoverPos} setPopoverPos={setPopoverPos} formatTime={formatTime} />
            ))
          )}
          {filteredSessions.length === 0 && sessionsReady && (
            <div className="instance-list-empty">
              {sessionSearch ? 'No matches' : 'No sessions'}
            </div>
          )}
          {sessions.length >= 500 && !sessionSearch && (
            <div className="sidebar-sessions-cap">Showing most recent 500 sessions</div>
          )}
        </div>
      </div>

      {handoffInst && (
        <div className="handoff-overlay" onClick={() => setHandoffInst(null)}>
          <div className="handoff-modal" onClick={e => e.stopPropagation()}>
            <div className="handoff-modal-header">
              <span>Handoff Doc — {handoffInst.name}</span>
              <button className="handoff-modal-close" onClick={() => setHandoffInst(null)}>✕</button>
            </div>
            <div className="handoff-modal-body">
              <div className="handoff-modal-hint">Paste into a new Claude session to restore context.</div>
              {handoffLoading ? (
                <div className="handoff-modal-loading">Generating...</div>
              ) : handoffSummary ? (
                <>
                  <textarea className="handoff-doc-textarea" value={handoffSummary} readOnly />
                  <button
                    className="handoff-summary-reset"
                    onClick={() => setHandoffSummary(null)}
                  >Show raw snapshot</button>
                </>
              ) : (
                <>
                  <textarea className="handoff-doc-textarea" value={handoffDoc} readOnly />
                  {handoffSumError && (
                    <div className="handoff-sum-error">{handoffSumError}</div>
                  )}
                  <button
                    className="handoff-summary-btn"
                    disabled={handoffSummarizing}
                    onClick={() => {
                      setHandoffSummarizing(true)
                      setHandoffSumError(null)
                      window.api.instance.summarize(handoffInst.id)
                        .then(summary => {
                          // Replace terminal snapshot section with AI summary
                          const header = handoffDoc.split('## Terminal Snapshot')[0].trimEnd()
                          setHandoffSummary(header + '\n\n## AI Summary\n\n' + summary + '\n\n---\n*Summarized by Claude Haiku. Paste into a new session to restore context.*')
                        })
                        .catch(e => setHandoffSumError(String(e?.message ?? 'Summary failed')))
                        .finally(() => setHandoffSummarizing(false))
                    }}
                  >
                    {handoffSummarizing ? 'Generating...' : '✨ Generate Summary'}
                  </button>
                </>
              )}
            </div>
            <div className="handoff-modal-footer">
              <button
                className="handoff-copy-btn"
                disabled={handoffLoading}
                onClick={() => {
                  const text = handoffSummary ?? handoffDoc
                  navigator.clipboard.writeText(text).then(() => {
                    setHandoffCopied(true)
                    setTimeout(() => setHandoffCopied(false), 2000)
                  })
                }}
              >
                {handoffCopied ? 'Copied!' : 'Copy to Clipboard'}
              </button>
            </div>
          </div>
        </div>
      )}

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
              className="context-menu-item"
              onClick={() => {
                startEditNote(instances.find((i) => i.id === contextMenu.id)!)
                setContextMenu(null)
              }}
              title="Add or edit a note for this session"
            >
              {instances.find((i) => i.id === contextMenu.id)?.note ? 'Edit Note' : 'Add Note'}
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                onForkSession?.(contextMenu.id)
                setContextMenu(null)
              }}
              title="Fork this session into parallel worktrees"
            >
              <GitFork size={12} /> Fork session...
            </button>
            <div className="context-menu-section">
              <div className="context-menu-label">Role</div>
              <div className="context-menu-roles">
                {SESSION_ROLES.map(role => {
                  const inst = instances.find((i) => i.id === contextMenu.id)
                  const active = inst?.roleTag === role
                  return (
                    <button
                      key={role}
                      className={`role-chip${active ? ' active' : ''}`}
                      title={`Tag as ${role}`}
                      onClick={() => {
                        window.api.instance.setRole(contextMenu.id, active ? null : role)
                        setContextMenu(null)
                      }}
                    >
                      {role}
                    </button>
                  )
                })}
              </div>
            </div>
            <button
              className="context-menu-item"
              onClick={() => {
                const inst = instances.find((i) => i.id === contextMenu.id)
                if (inst) onCloneSession?.(inst)
                setContextMenu(null)
              }}
              title="Clone this session's config into a new session"
            >
              <Copy size={12} /> Clone
            </button>
            <button
              className="context-menu-item"
              onClick={async (e) => {
                const id = contextMenu.id
                try {
                  if (e.shiftKey) {
                    setContextMenu(null)
                    await window.api.session.exportMarkdownToFile(id)
                  } else {
                    const md = await window.api.session.exportMarkdown(id)
                    await navigator.clipboard.writeText(md)
                    setExportedId(id)
                    setTimeout(() => { setExportedId(null); setContextMenu(null) }, 800)
                  }
                } catch (err) {
                  console.error('Export failed:', err)
                  setContextMenu(null)
                }
              }}
              title="Export session as markdown (Shift+click to save as file)"
            >
              {exportedId === contextMenu.id ? (
                'Copied!'
              ) : (
                <><FileDown size={12} /> Export Markdown</>
              )}
            </button>
            <button
              className="context-menu-item"
              onClick={() => {
                const inst = instances.find((i) => i.id === contextMenu.id)
                if (!inst) { setContextMenu(null); return }
                const id = Date.now().toString(36) + Math.random().toString(36).slice(2)
                const template: SessionTemplate = {
                  id,
                  name: inst.name,
                  workingDir: inst.workingDirectory,
                  role: inst.roleTag ?? undefined,
                  lastUsed: Date.now(),
                  launchCount: 0,
                }
                window.api.sessionTemplates.save(template).then(() => {
                  window.api.sessionTemplates.list().then(setTemplates).catch(() => {})
                  setSavedTemplateId(inst.id)
                  setTimeout(() => setSavedTemplateId(null), 2000)
                }).catch(console.error)
                setContextMenu(null)
              }}
              title="Save this session's config as a reusable template"
            >
              {savedTemplateId === contextMenu.id ? (
                'Saved!'
              ) : (
                <><BookTemplate size={12} /> Save as Template</>
              )}
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
        <div className="sidebar-footer-activity" style={{ position: 'relative' }}>
          <Tooltip text="Activity Feed" detail="Recent automation events from personas, pipelines, and environments. Amber badge when pipeline actions are waiting for your approval." position="top">
            <button
              className={`sidebar-footer-btn ${showActivityPopover ? 'active' : ''} ${pendingApprovals.length > 0 ? 'has-approvals' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                if (showActivityPopover) {
                  setShowActivityPopover(false)
                } else {
                  window.api.activity.list().then(events => {
                    setActivityEvents(events.slice(-20).reverse())
                  }).catch(() => {})
                  window.api.activity.markRead().catch(() => {})
                  setActivityUnread(0)
                  setShowActivityPopover(true)
                }
              }}
            >
              <Bell size={14} />
              {pendingApprovals.length > 0 ? (
                <span className="sidebar-activity-badge approval-badge">{pendingApprovals.length}</span>
              ) : activityUnread > 0 ? (
                <span className="sidebar-activity-badge">{activityUnread > 99 ? '99+' : activityUnread}</span>
              ) : null}
              {pendingApprovals.length > 0 && activityUnread > 0 && (
                <span className="sidebar-activity-unread-dot" title={`${activityUnread} unread`} />
              )}
            </button>
          </Tooltip>
          {showActivityPopover && (
            <div className="activity-popover" onClick={e => e.stopPropagation()}>
              <div className="activity-popover-header">
                <span>{pendingApprovals.length > 0 ? 'Activity · Action Required' : 'Activity'}</span>
                <button onClick={() => setShowActivityPopover(false)} title="Close">✕</button>
              </div>
              {pendingApprovals.length > 0 && (
                <div className="activity-approvals-section">
                  <div className="activity-approvals-title">Pending Approval</div>
                  {pendingApprovals.map(req => (
                    <div key={req.id} className="activity-approval-card">
                      <div className="activity-approval-header">
                        <span className="activity-approval-pipeline">{req.pipelineName}</span>
                        <span className="activity-approval-time">{formatActivityTime(req.createdAt)}</span>
                      </div>
                      <div className="activity-approval-summary">{req.summary}</div>
                      {req.resolvedVars?.['plan.content'] && (
                        <div className="activity-approval-plan-preview">
                          {req.resolvedVars['plan.content'].length > 280
                            ? req.resolvedVars['plan.content'].slice(0, 280) + '…'
                            : req.resolvedVars['plan.content']}
                        </div>
                      )}
                      {formatApprovalExpiry(req.expiresAt) && (
                        <div className="activity-approval-expiry">{formatApprovalExpiry(req.expiresAt)}</div>
                      )}
                      <div className="activity-approval-actions">
                        <button
                          className="activity-approval-btn approve"
                          onClick={() => window.api.pipeline.approve(req.id).catch(() => {})}
                        >
                          Approve
                        </button>
                        <button
                          className="activity-approval-btn dismiss"
                          onClick={() => window.api.pipeline.dismiss(req.id).catch(() => {})}
                        >
                          Dismiss
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="activity-popover-list">
                {activityEvents.length === 0 && (
                  <div className="activity-popover-empty">Activity appears here when personas, pipelines, or approval gates fire. Start a persona or run a pipeline to see events.</div>
                )}
                {activityEvents.map(ev => (
                  <div key={ev.id} className={`activity-event activity-event-${ev.level}`}>
                    <div className="activity-event-header">
                      <span className={`activity-event-source activity-source-${ev.source}`}>{ev.source}</span>
                      <span className="activity-event-name">{ev.name}</span>
                      <span className="activity-event-time">{formatActivityTime(ev.timestamp)}</span>
                    </div>
                    <div className="activity-event-summary">{ev.summary}</div>
                    {ev.details?.type === 'session-outcome' && (
                      <div className="activity-outcome-stats">
                        {(ev.details.duration as number) !== null && (
                          <span>{formatDuration(ev.details.duration as number)}</span>
                        )}
                        {(ev.details.commitsCount as number) > 0 && (
                          <span>{ev.details.commitsCount as number} commit{(ev.details.commitsCount as number) !== 1 ? 's' : ''}</span>
                        )}
                        {(ev.details.filesChanged as number) > 0 && (
                          <span>{ev.details.filesChanged as number} file{(ev.details.filesChanged as number) !== 1 ? 's' : ''} changed</span>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="sidebar-footer-activity" style={{ position: 'relative' }}>
          <Tooltip text="Notification History" detail="Desktop notifications log — what happened while you were away" position="top">
            <button
              className={`sidebar-footer-btn ${showNotifPopover ? 'active' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                if (showNotifPopover) {
                  setShowNotifPopover(false)
                } else {
                  setShowNotifPopover(true)
                }
              }}
            >
              <BellRing size={14} />
              {notifUnread > 0 && (
                <span className="sidebar-activity-badge">{notifUnread > 99 ? '99+' : notifUnread}</span>
              )}
            </button>
          </Tooltip>
          {showNotifPopover && (
            <NotificationHistory
              onClose={() => {
                setShowNotifPopover(false)
                window.api.notifications.markAllRead().then(() => setNotifUnread(0)).catch(() => {})
              }}
              onNavigate={(route) => {
                if (typeof route === 'string') {
                  const viewRoutes = ['pipelines', 'personas', 'environments', 'tasks', 'outputs', 'agents', 'github', 'sessions', 'settings', 'review'] as const
                  if (viewRoutes.includes(route as any)) {
                    onViewChange(route as SidebarView)
                  }
                } else if (route && typeof route === 'object' && route.type === 'session' && typeof route.id === 'string') {
                  onSelect(route.id)
                }
              }}
            />
          )}
        </div>
        {onLoadPreset && (
          <WorkspacePresets
            currentView={view}
            currentLayout={currentLayout}
            onLoadPreset={onLoadPreset}
          />
        )}
        <Tooltip text="Settings" position="top">
          <button className={`sidebar-footer-btn ${view === 'settings' ? 'active' : ''}`} onClick={() => onViewChange(view === 'settings' ? 'instances' : 'settings')}>
            <Settings size={14} />
          </button>
        </Tooltip>
        {appVersion && <span className="sidebar-version">v{appVersion}</span>}
      </div>
    </div>
  )
}

const Sidebar = React.memo(SidebarInner)

export default Sidebar
