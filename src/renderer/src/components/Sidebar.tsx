import React, { useState, useRef, useEffect } from 'react'
import { Info, Pencil, Pin, PinOff, Square, Play, Trash2, RefreshCw, Settings, Plus, GitPullRequest, Columns2, ListChecks, TerminalSquare, Bot, Zap, Server, User, Bell, FileDown, GitFork, ChevronDown, ChevronRight, Trophy, BookTemplate } from 'lucide-react'
import type { ClaudeInstance, CliSession, RecentSession } from '../types'
import { SESSION_ROLES } from '../../../shared/types'
import type { ActivityEvent, ApprovalRequest, ForkGroup, SessionTemplate } from '../../../shared/types'
import { stripAnsi } from '../../../shared/utils'

const ROLE_ABBREV: Record<string, string> = {
  Orchestrator: 'Orch', Planner: 'Plan', Coder: 'Code',
  Tester: 'Test', Reviewer: 'Rev', Researcher: 'Res',
}
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
  outputBytes: Map<string, number>
  splitId: string | null
  splitPairs: Map<string, string>
  focusedPane: 'left' | 'right'
  onSplitWith: (id: string) => void
  onCloseSplit: () => void
  onDrop?: (e: React.DragEvent) => void
  forkGroups?: ForkGroup[]
  onForkSession?: (id: string) => void
}

export default function Sidebar({ instances, activeId, view, onSelect, onNew, onKill, onRestart, onRemove, onRename, onRecolor, onPin, onUnpin, onViewChange, onResumeSession, onTakeoverExternal, onRestoreAll, restorableCount, unreadIds, outputBytes, splitId, splitPairs, focusedPane, onSplitWith, onCloseSplit, onDrop, forkGroups = [], onForkSession }: Props) {
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [runningEnvCount, setRunningEnvCount] = useState(0)
  const [expandedForkGroups, setExpandedForkGroups] = useState<Set<string>>(new Set())
  const [forkSectionOpen, setForkSectionOpen] = useState(true)

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
  const [templates, setTemplates] = useState<SessionTemplate[]>([])
  const [showTemplatePopover, setShowTemplatePopover] = useState(false)
  const [savedTemplateId, setSavedTemplateId] = useState<string | null>(null)
  const newSessionBtnRef = useRef<HTMLButtonElement>(null)
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
  const [pendingApprovals, setPendingApprovals] = useState<ApprovalRequest[]>([])
  const [handoffInst, setHandoffInst] = useState<ClaudeInstance | null>(null)
  const [handoffDoc, setHandoffDoc] = useState('')
  const [handoffLoading, setHandoffLoading] = useState(false)
  const [handoffCopied, setHandoffCopied] = useState(false)
  const [handoffSummarizing, setHandoffSummarizing] = useState(false)
  const [handoffSummary, setHandoffSummary] = useState<string | null>(null)
  const [handoffSumError, setHandoffSumError] = useState<string | null>(null)

  useEffect(() => {
    window.api.sessions.list(500).then(setSessions)
    window.api.sessions.external().then(setExternalSessions)
  }, [])

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

  const ctxLevel = (bytes: number): 'amber' | 'red' | null => {
    if (bytes >= 600_000) return 'red'
    if (bytes >= 250_000) return 'amber'
    return null
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
          <>
          <div className="instance-name">
            {inst.pinned && <span className="instance-pin-icon" title="Pinned"><Pin size={11} /></span>}
            {inst.name}
          </div>
          {(() => {
            // Build ordered badge list for the dedicated badge row
            const badges: Array<{ node: React.ReactNode; label: string }> = []
            if (splitId && inst.id === activeId)
              badges.push({ node: <span key="sl" className={`split-badge ${focusedPane === 'left' ? 'focused' : ''}`} title="Left split pane">L</span>, label: 'L' })
            if (splitId && inst.id === splitId)
              badges.push({ node: <span key="sr" className={`split-badge ${focusedPane === 'right' ? 'focused' : ''}`} title="Right split pane">R</span>, label: 'R' })
            if (inst.id !== activeId && inst.id !== splitId && splitPairs.has(inst.id))
              badges.push({ node: <span key="si" className="split-indicator" title="Split with another session"><Columns2 size={11} /></span>, label: 'split' })
            // "your turn" and "new" both mean "look at this" — show at most one
            if (inst.status === 'running' && inst.activity === 'waiting')
              badges.push({ node: <span key="at" className="instance-attention-badge" title="Waiting for your input">your turn</span>, label: 'your turn' })
            else if (unreadIds.has(inst.id))
              badges.push({ node: <span key="ur" className="instance-unread-badge" title="New output you haven't seen">new</span>, label: 'new' })
            const level = inst.status === 'running' ? ctxLevel(outputBytes.get(inst.id) || 0) : null
            if (level)
              badges.push({ node: <button key="cx" className={`instance-ctx-badge ${level}`} title={level === 'red' ? 'Context near limit · Click to export handoff doc' : 'Context building up · Click to export handoff doc'} onClick={(e) => { e.stopPropagation(); setHandoffInst(inst); setHandoffCopied(false) }}>ctx</button>, label: `ctx (${level})` })
            if ((inst.tokenUsage?.cost ?? 0) >= 0.01)
              badges.push({ node: <span key="co" className="instance-cost-badge" title={`API cost: $${inst.tokenUsage.cost.toFixed(4)}`}>${inst.tokenUsage.cost.toFixed(2)}</span>, label: `$${inst.tokenUsage.cost.toFixed(2)}` })
            if (inst.roleTag)
              badges.push({ node: <span key="ro" className={`instance-role-badge role-${inst.roleTag.toLowerCase()}`} title={`Role: ${inst.roleTag}`}>{ROLE_ABBREV[inst.roleTag] ?? inst.roleTag.slice(0, 4)}</span>, label: inst.roleTag })
            if (inst.mcpServers.length > 0)
              badges.push({ node: <span key="mc" className="instance-mcp-badge" title={inst.mcpServers.join(', ')}>MCP {inst.mcpServers.length}</span>, label: `MCP ${inst.mcpServers.length}` })
            if (inst.cliBackend === 'cursor-agent')
              badges.push({ node: <span key="cl" className="instance-cli-badge" title="CLI for this session">{cliBackendLabel(inst.cliBackend)}</span>, label: cliBackendLabel(inst.cliBackend) })
            if (inst.pendingSteer)
              badges.push({ node: <span key="ps" className="instance-steer-badge" title="Steering message queued — will be delivered when session is next idle">Steer</span>, label: 'Steer' })
            if (badges.length === 0) return null
            return (
              <div className="instance-badges">
                {badges.map(b => b.node)}
              </div>
            )
          })()}
          </>
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
        {inst.status !== 'running' && (
          <span className={`instance-status ${(inst.exitCode == null || inst.exitCode === 0) ? 'done' : 'exited'}`}>
            {(inst.exitCode == null || inst.exitCode === 0) ? 'done' : `err ${inst.exitCode}`}
          </span>
        )}
        <div className="instance-item-actions">
          <Tooltip text="Export Handoff Doc" detail="Generate a markdown snapshot to paste into a new session and restore context">
            <button aria-label="Export Handoff Doc" onClick={(e) => { e.stopPropagation(); setHandoffInst(inst); setHandoffCopied(false) }}><FileDown size={13} /></button>
          </Tooltip>
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
          <div className="instance-list-divider">
            Stopped
            {exited.length > 1 && (
              <button className="clear-stopped-btn" onClick={() => exited.forEach(i => onRemove(i.id))}>
                Clear all
              </button>
            )}
          </div>
        )}
        {exited.map(renderInstance)}
        {instances.length === 0 && (
          <div className="instance-list-empty">No sessions · press Cmd+T or click New Session to start</div>
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
        <Tooltip text="Settings" position="top">
          <button className={`sidebar-footer-btn ${view === 'settings' ? 'active' : ''}`} onClick={() => onViewChange(view === 'settings' ? 'instances' : 'settings')}>
            <Settings size={14} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
