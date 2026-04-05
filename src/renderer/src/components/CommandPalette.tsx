import { useState, useEffect, useRef, useMemo } from 'react'
import {
  Plus, Settings, GitPullRequest, Users, Square, Play, Columns2,
  MonitorPlay, History, Search, ArrowRight, Terminal, Server, User, Bot,
} from 'lucide-react'
import type { ClaudeInstance, CliSession, AgentDef } from '../types'
import type { PersonaInfo } from '../../../shared/types'
import { cliBackendLabel } from '../lib/constants'

export interface CommandPaletteAction {
  id: string
  label: string
  detail?: string
  icon: React.ReactNode
  section: string
  onExecute: () => void
  /** Optional color dot for sessions */
  color?: string
  /** Keywords for search matching beyond the label */
  keywords?: string
  /** If true, don't close the palette after executing */
  stayOpen?: boolean
}

interface Props {
  open: boolean
  onClose: () => void
  instances: ClaudeInstance[]
  activeId: string | null
  onSelect: (id: string) => void
  onNew: () => void
  onKill: (id: string) => void
  onRestart: (id: string) => void
  onViewChange: (view: string) => void
  onToggleSplit: () => void
  onResumeSession: (session: CliSession) => void
  sessions: CliSession[]
  onRunPersona: (id: string) => void
  onLaunchAgent: (agent: AgentDef) => void
}

export default function CommandPalette({
  open, onClose, instances, activeId, onSelect, onNew,
  onKill, onRestart, onViewChange, onToggleSplit, onResumeSession, sessions,
  onRunPersona, onLaunchAgent,
}: Props) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [terminalMatches, setTerminalMatches] = useState<CommandPaletteAction[]>([])
  const [searchMode, setSearchMode] = useState<'commands' | 'sessions'>('commands')
  const [allSessions, setAllSessions] = useState<CliSession[]>([])
  const [personas, setPersonas] = useState<PersonaInfo[]>([])
  const [agents, setAgents] = useState<AgentDef[]>([])
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Build all available actions
  const actions = useMemo<CommandPaletteAction[]>(() => {
    const items: CommandPaletteAction[] = []

    // Session switching
    for (const inst of instances) {
      items.push({
        id: `switch-${inst.id}`,
        label: inst.name,
        detail: `${cliBackendLabel(inst.cliBackend)} · ${inst.workingDirectory.split('/').pop()} · ${inst.status === 'running' ? 'running' : `exited (${inst.exitCode})`}`,
        icon: <MonitorPlay size={14} />,
        section: 'Sessions',
        color: inst.color,
        keywords: `${inst.workingDirectory} ${cliBackendLabel(inst.cliBackend)}`,
        onExecute: () => onSelect(inst.id),
      })
    }

    // Quick actions
    items.push({
      id: 'new-session',
      label: 'New Session',
      detail: 'Launch a new Claude CLI instance',
      icon: <Plus size={14} />,
      section: 'Actions',
      onExecute: onNew,
    })

    const active = instances.find((i) => i.id === activeId)
    if (active?.status === 'running') {
      items.push({
        id: 'kill-active',
        label: 'Kill Active Session',
        detail: active.name,
        icon: <Square size={14} />,
        section: 'Actions',
        onExecute: () => onKill(activeId!),
      })
    }
    if (active?.status === 'exited') {
      items.push({
        id: 'restart-active',
        label: 'Restart Active Session',
        detail: active.name,
        icon: <Play size={14} />,
        section: 'Actions',
        onExecute: () => onRestart(activeId!),
      })
    }
    if (instances.length >= 2) {
      items.push({
        id: 'toggle-split',
        label: 'Toggle Split View',
        detail: 'Open or close side-by-side terminals',
        icon: <Columns2 size={14} />,
        section: 'Actions',
        onExecute: onToggleSplit,
      })
    }

    // Navigation
    items.push({
      id: 'nav-settings',
      label: 'Open Settings',
      icon: <Settings size={14} />,
      section: 'Navigate',
      onExecute: () => onViewChange('settings'),
    })
    items.push({
      id: 'nav-agents',
      label: 'Open Agents',
      icon: <Users size={14} />,
      section: 'Navigate',
      onExecute: () => onViewChange('agents'),
    })
    items.push({
      id: 'nav-github',
      label: 'Open GitHub PRs',
      icon: <GitPullRequest size={14} />,
      section: 'Navigate',
      onExecute: () => onViewChange('github'),
    })
    items.push({
      id: 'nav-tasks',
      label: 'Open Task Queue',
      detail: 'Define and run batch tasks',
      icon: <Search size={14} />,
      section: 'Navigate',
      keywords: 'batch queue yaml parallel sequential',
      onExecute: () => onViewChange('tasks'),
    })
    items.push({
      id: 'nav-pipelines',
      label: 'Open Pipelines',
      detail: 'Automated triggers and actions',
      icon: <Search size={14} />,
      section: 'Navigate',
      keywords: 'pipeline automation trigger cron',
      onExecute: () => onViewChange('pipelines'),
    })
    items.push({
      id: 'nav-environments',
      label: 'Open Environments',
      detail: 'Manage dev environments and services',
      icon: <Server size={14} />,
      section: 'Navigate',
      keywords: 'environment docker service start stop',
      onExecute: () => onViewChange('environments'),
    })
    items.push({
      id: 'nav-personas',
      label: 'Open Personas',
      detail: 'Autonomous scheduled agents',
      icon: <User size={14} />,
      section: 'Navigate',
      keywords: 'persona agent schedule autonomous',
      onExecute: () => onViewChange('personas'),
    })

    // Persona quick-run
    for (const p of personas) {
      const isRunning = p.activeSessionId !== null
      items.push({
        id: `run-persona-${p.id}`,
        label: `Run: ${p.name}`,
        detail: isRunning ? 'Already running' : p.schedule ? `Schedule: ${p.schedule}` : 'Manual only',
        icon: <User size={14} />,
        section: 'Personas',
        keywords: `persona ${p.id} ${p.model}`,
        onExecute: () => {
          onRunPersona(p.id)
          onViewChange('personas')
        },
      })
    }

    // Agent quick-launch
    for (const a of agents) {
      items.push({
        id: `launch-agent-${a.id}`,
        label: `Launch: ${a.name}`,
        detail: a.description || (a.scope === 'personal' ? 'Personal agent' : `Project: ${a.projectName}`),
        icon: <Bot size={14} />,
        section: 'Agents',
        keywords: `agent ${a.scope} ${a.projectName || ''} ${a.model || ''}`,
        onExecute: () => {
          onLaunchAgent(a)
        },
      })
    }

    items.push({
      id: 'search-sessions',
      label: 'Search All Sessions',
      detail: 'Deep search across session names, messages, and projects',
      icon: <Search size={14} />,
      section: 'Actions',
      keywords: 'find session history search',
      stayOpen: true,
      onExecute: () => {
        setSearchMode('sessions')
        setQuery('')
        window.api.sessions.list(500).then(setAllSessions)
      },
    })

    // Recent sessions (limit to 10)
    for (const session of sessions.slice(0, 10)) {
      items.push({
        id: `resume-${session.sessionId}`,
        label: session.name || session.display.slice(0, 60),
        detail: `${session.projectName} -- ${session.messageCount} msgs`,
        icon: <History size={14} />,
        section: 'History',
        keywords: `${session.projectName} ${session.display}`,
        onExecute: () => onResumeSession(session),
      })
    }

    return items
  }, [instances, activeId, sessions, personas, agents, onSelect, onNew, onKill, onRestart, onViewChange, onToggleSplit, onResumeSession, onRunPersona, onLaunchAgent])

  // Search terminal output buffers when query is 3+ chars
  useEffect(() => {
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current)
    if (query.trim().length < 3) { setTerminalMatches([]); return }

    searchTimerRef.current = setTimeout(async () => {
      const q = query.trim().toLowerCase()
      const matches: CommandPaletteAction[] = []
      const running = instances.filter(i => i.status === 'running')

      for (const inst of running) {
        try {
          const buf = await window.api.instance.buffer(inst.id)
          if (!buf) continue
          // Strip ANSI codes for searching
          const clean = buf.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
          const lines = clean.split('\n')
          const matchingLines: string[] = []
          for (const line of lines) {
            if (line.toLowerCase().includes(q)) {
              matchingLines.push(line.trim().slice(0, 80))
              if (matchingLines.length >= 3) break
            }
          }
          if (matchingLines.length > 0) {
            matches.push({
              id: `terminal-${inst.id}`,
              label: inst.name,
              detail: matchingLines[0],
              icon: <Terminal size={14} />,
              section: 'Terminal Output',
              color: inst.color,
              keywords: matchingLines.join(' '),
              onExecute: () => onSelect(inst.id),
            })
          }
        } catch { /* skip */ }
      }
      setTerminalMatches(matches)
    }, 300)

    return () => { if (searchTimerRef.current) clearTimeout(searchTimerRef.current) }
  }, [query, instances, onSelect])

  // Filter actions by query
  const filtered = useMemo(() => {
    if (!query.trim()) return actions
    const q = query.toLowerCase()
    return actions.filter((a) => {
      const haystack = `${a.label} ${a.detail || ''} ${a.keywords || ''} ${a.section}`.toLowerCase()
      // Support simple fuzzy: all query chars must appear in order
      let hi = 0
      for (const ch of q) {
        const idx = haystack.indexOf(ch, hi)
        if (idx === -1) return false
        hi = idx + 1
      }
      return true
    })
  }, [query, actions])

  // Deep session search (when in sessions mode) — async, debounced
  const [sessionResults, setSessionResults] = useState<CommandPaletteAction[]>([])
  const [sessionSearching, setSessionSearching] = useState(false)
  const sessionSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (searchMode !== 'sessions') { setSessionResults([]); return }
    if (sessionSearchTimerRef.current) clearTimeout(sessionSearchTimerRef.current)

    const q = query.trim()
    if (q.length < 2) {
      // Show recent sessions when no query
      setSessionResults(allSessions.slice(0, 30).map(s => ({
        id: `session-${s.sessionId}`,
        label: s.name || s.display.slice(0, 60),
        detail: `${s.projectName} · ${s.messageCount} msgs`,
        icon: <History size={14} />,
        section: 'Recent Sessions',
        onExecute: () => onResumeSession(s),
      })))
      return
    }

    setSessionSearching(true)
    sessionSearchTimerRef.current = setTimeout(async () => {
      try {
        const results = await window.api.sessions.search(q)
        setSessionResults(results.map(r => ({
          id: `session-${r.sessionId}`,
          label: r.name || r.sessionId.slice(0, 12),
          detail: `${r.project} · ${r.match}`,
          icon: <History size={14} />,
          section: 'Matching Sessions',
          onExecute: () => onResumeSession({ sessionId: r.sessionId, name: r.name, display: r.match, lastMessage: null, messageCount: 0, project: '', timestamp: 0, projectName: r.project, recentlyOpened: false }),
        })))
      } catch { setSessionResults([]) }
      setSessionSearching(false)
    }, 400)

    return () => { if (sessionSearchTimerRef.current) clearTimeout(sessionSearchTimerRef.current) }
  }, [searchMode, query, allSessions, onResumeSession])

  // Combine filtered actions with terminal matches (or session results in session mode)
  const allFiltered = useMemo(() => {
    if (searchMode === 'sessions') return sessionResults
    return [...filtered, ...terminalMatches]
  }, [searchMode, filtered, terminalMatches, sessionResults])

  // Group by section for display
  const grouped = useMemo(() => {
    const map = new Map<string, CommandPaletteAction[]>()
    for (const item of allFiltered) {
      if (!map.has(item.section)) map.set(item.section, [])
      map.get(item.section)!.push(item)
    }
    return map
  }, [allFiltered])

  // Clamp selected index when results change
  useEffect(() => {
    setSelectedIndex(0)
  }, [query])

  // Load personas and agents when palette opens
  useEffect(() => {
    if (!open) return
    window.api.persona.list().then(setPersonas).catch(() => {})
    window.api.agents.list().then(setAgents).catch(() => {})
  }, [open])

  // Focus input when opened
  useEffect(() => {
    if (open) {
      setQuery('')
      setSelectedIndex(0)
      setSearchMode('commands')
      setTerminalMatches([])
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  // Scroll selected item into view
  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector('.cmd-palette-item.selected')
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.min(prev + 1, allFiltered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((prev) => Math.max(prev - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (allFiltered[selectedIndex]) {
        allFiltered[selectedIndex].onExecute()
        if (!allFiltered[selectedIndex].stayOpen) onClose()
      }
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (searchMode === 'sessions') {
        setSearchMode('commands')
        setQuery('')
        setSelectedIndex(0)
      } else {
        onClose()
      }
    }
  }

  if (!open) return null

  let flatIndex = 0

  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()}>
        <div className="cmd-palette-input-row">
          {searchMode === 'sessions' && (
            <button className="cmd-palette-back" onClick={() => { setSearchMode('commands'); setQuery(''); setSelectedIndex(0) }} title="Back to commands">
              <ArrowRight size={14} style={{ transform: 'rotate(180deg)' }} />
            </button>
          )}
          <Search size={14} className="cmd-palette-search-icon" />
          <input
            ref={inputRef}
            className="cmd-palette-input"
            placeholder={searchMode === 'sessions' ? 'Search sessions by name, message, project...' : 'Type a command or session name...'}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="cmd-palette-kbd">{searchMode === 'sessions' ? 'esc: back' : 'esc'}</kbd>
        </div>
        <div className="cmd-palette-list" ref={listRef}>
          {allFiltered.length === 0 && (
            <div className="cmd-palette-empty">No matching commands</div>
          )}
          {Array.from(grouped.entries()).map(([section, items]) => (
            <div key={section}>
              <div className="cmd-palette-section">{section}</div>
              {items.map((item) => {
                const idx = flatIndex++
                return (
                  <div
                    key={item.id}
                    className={`cmd-palette-item ${idx === selectedIndex ? 'selected' : ''}`}
                    onClick={() => { item.onExecute(); if (!item.stayOpen) onClose() }}
                    onMouseEnter={() => setSelectedIndex(idx)}
                  >
                    <span className="cmd-palette-item-icon">{item.icon}</span>
                    {item.color && (
                      <span
                        className="cmd-palette-dot"
                        style={{ backgroundColor: item.color }}
                      />
                    )}
                    <span className="cmd-palette-item-label">{item.label}</span>
                    {item.detail && (
                      <span className="cmd-palette-item-detail">{item.detail}</span>
                    )}
                    <ArrowRight size={12} className="cmd-palette-item-arrow" />
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
