import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Swords, BarChart3, X as XIcon, EyeOff } from 'lucide-react'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import { createPortal } from 'react-dom'
import type { ClaudeInstance, AgentDef, CliSession, RecentSession, CliBackend, ArenaStats } from './types'
import Sidebar, { SidebarView } from './components/Sidebar'
import TerminalView from './components/TerminalView'
import NewInstanceDialog from './components/NewInstanceDialog'
import AgentsPanel from './components/AgentsPanel'
import AgentEditor from './components/AgentEditor'
import SettingsPanel from './components/SettingsPanel'
import GitHubPanel from './components/GitHubPanel'
import CommandPalette from './components/CommandPalette'
import TaskQueuePanel from './components/TaskQueuePanel'
import TaskBoardPanel from './components/TaskBoardPanel'
import PipelinesPanel from './components/PipelinesPanel'
import EnvironmentsPanel from './components/EnvironmentsPanel'
import PersonasPanel from './components/PersonasPanel'
import OutputsPanel from './components/OutputsPanel'
import AnalyticsPanel from './components/AnalyticsPanel'
import QuickPromptDialog from './components/QuickPromptDialog'
import ForkModal from './components/ForkModal'
import { stripAnsi } from '../../shared/utils'
import type { ForkGroup } from '../../shared/types'

type View = SidebarView | 'agent-editor'

/** Older daemons may omit cliBackend; keep renderer stable. */
function withCliBackend(inst: ClaudeInstance): ClaudeInstance {
  if (inst.cliBackend === 'cursor-agent') return inst
  return { ...inst, cliBackend: 'claude' as const }
}

export default function App() {
  const [instances, setInstances] = useState<ClaudeInstance[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [view, setView] = useState<View>('instances')
  const [tasksTab, setTasksTab] = useState<'queue' | 'board'>('queue')
  const [editingAgent, setEditingAgent] = useState<AgentDef | null>(null)
  const [editorInstanceId, setEditorInstanceId] = useState<string | null>(null)
  const [restorableSessions, setRestorableSessions] = useState<RecentSession[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [splitPairs, setSplitPairs] = useState<Map<string, string>>(new Map()) // leftId → rightId
  const [focusedPane, setFocusedPane] = useState<'left' | 'right'>('left')
  const [showSplitPicker, setShowSplitPicker] = useState(false)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [arenaMode, setArenaMode] = useState(false)
  const [arenaBlind, setArenaBlind] = useState(false)
  const [arenaText, setArenaText] = useState('')
  const arenaTextareaRef = useRef<HTMLTextAreaElement>(null)
  const [arenaWinnerId, setArenaWinnerId] = useState<string | null>(null)
  const [arenaStatsOpen, setArenaStatsOpen] = useState(false)
  const [arenaStats, setArenaStats] = useState<ArenaStats>({})
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set())
  const [fontSize, setFontSize] = useState(13)
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false)
  const [cmdPaletteSessions, setCmdPaletteSessions] = useState<import('./types').CliSession[]>([])
  const [quickPromptOpen, setQuickPromptOpen] = useState(false)
  const [quickPromptHistory, setQuickPromptHistory] = useState<string[]>([])
  const pendingPromptRef = useRef<{ id: string; prompt: string } | null>(null)
  const [outputBytes, setOutputBytes] = useState<Map<string, number>>(new Map())
  const outputBytesAccRef = useRef<Map<string, number>>(new Map())
  const [resourceUsage, setResourceUsage] = useState<{
    perInstance: Record<string, { cpu: number; memory: number }>
    total: { cpu: number; memory: number }
  } | null>(null)
  const [daemonStale, setDaemonStale] = useState(false)
  const [envPromptRequest, setEnvPromptRequest] = useState<{ requestId: string; envId: string; hookName: string; prompt: string; promptType: string; defaultPath?: string; options?: string[] } | null>(null)
  const [forkModalInst, setForkModalInst] = useState<ClaudeInstance | null>(null)
  const [forkModalHint, setForkModalHint] = useState('')
  const [forkGroups, setForkGroups] = useState<ForkGroup[]>([])
  const terminalsRef = useRef<Map<string, any>>(new Map())
  const agentToLaunchRef = useRef<AgentDef | null>(null)
  // Track activeId + view in a ref so the output listener always has fresh values
  const activeViewRef = useRef<{ activeId: string | null; view: View }>({ activeId: null, view: 'instances' })
  activeViewRef.current = { activeId, view }
  const instancesRef = useRef(instances)
  instancesRef.current = instances
  // Derived: the split partner for the currently active instance (if any)
  const splitId = activeId ? (splitPairs.get(activeId) || null) : null
  const splitRef = useRef<{ splitId: string | null; focusedPane: 'left' | 'right' }>({ splitId: null, focusedPane: 'left' })
  splitRef.current = { splitId, focusedPane }

  useEffect(() => {
    window.api.instance.list().then((list) => setInstances(list.map(withCliBackend)))
    window.api.sessions.restorable().then(setRestorableSessions)
    window.api.settings.getAll().then((s) => {
      if (s.fontSize) {
        setFontSize(parseInt(s.fontSize, 10) || 13)
      }
      if (s.quickPromptHistory) {
        try { setQuickPromptHistory(JSON.parse(s.quickPromptHistory)) } catch { /* ignore */ }
      }
    })
    // Check daemon version on mount (the push event may have fired before we loaded)
    window.api.daemon.getVersion().then((v) => {
      if (v.running !== v.expected) setDaemonStale(true)
    }).catch(() => {})
    // Also listen for push events (e.g. after reconnect)
    const unsubVersion = window.api.daemon.onVersionMismatch(() => {
      setDaemonStale(true)
    })
    return unsubVersion
  }, [])

  // Listen for environment prompt requests (file picker etc.) — must be at app level
  // so it works regardless of which panel is active
  useEffect(() => {
    return window.api.env.onPromptRequest((data) => setEnvPromptRequest(data))
  }, [])

  // Fork groups: load on mount, subscribe to updates
  useEffect(() => {
    window.api.fork.getGroups().then(setForkGroups).catch(() => {})
    return window.api.fork.onGroups(setForkGroups)
  }, [])

  useEffect(() => {
    const unsub = window.api.instance.onListUpdate((list) => setInstances(list.map(withCliBackend)))
    return unsub
  }, [])

  // Track unread: output on non-visible terminals marks them unread
  // Smart dedup: track recent output per instance, only trigger on genuinely new content
  useEffect(() => {
    const recentOutput = new Map<string, string>() // last seen clean text per instance
    const novelBytes = new Map<string, number>()   // accumulated novel bytes
    const THRESHOLD = 80

    const unsub = window.api.instance.onOutput(({ id, data }) => {
      const { activeId: currentActive, view: currentView } = activeViewRef.current
      const isVisible = currentView === 'instances' && id === currentActive
      if (isVisible) {
        // Reset tracking when user is looking at it
        novelBytes.delete(id)
        recentOutput.delete(id)
        return
      }

      // Strip ANSI escapes and control chars
      const clean = stripAnsi(data)
        .replace(/[\x00-\x1F\x7F]/g, '')
        .trim()
      if (clean.length < 3) return

      // Compare against recent output — if the new text is a substring of
      // what we've already seen (or vice versa), it's a TUI redraw
      const prev = recentOutput.get(id) || ''
      if (prev.includes(clean) || clean.includes(prev)) {
        // Redraw — update the snapshot but don't count as novel
        recentOutput.set(id, clean)
        return
      }

      // Check character-level novelty: how many chars in `clean` are NOT in `prev`?
      // This catches status line updates where only the timer/counter changes
      const prevChars = new Set(prev.split(''))
      let novelCount = 0
      for (const ch of clean) {
        if (!prevChars.has(ch)) novelCount++
      }
      // If less than 30% of chars are novel, it's a minor update (timer tick, spinner)
      if (clean.length > 10 && novelCount / clean.length < 0.3) {
        recentOutput.set(id, clean)
        return
      }

      // Genuinely new content
      recentOutput.set(id, clean)
      const total = (novelBytes.get(id) || 0) + clean.length
      novelBytes.set(id, total)

      if (total >= THRESHOLD) {
        novelBytes.delete(id)
        setUnreadIds((prev) => {
          if (prev.has(id)) return prev
          const next = new Set(prev)
          next.add(id)
          return next
        })
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.instance.onFocus(({ id }) => {
      setActiveId(id)
      setView('instances')
    })
    return unsub
  }, [])

  // Track total PTY bytes per session as a proxy for context budget consumption
  useEffect(() => {
    const unsub = window.api.instance.onOutput(({ id, data }) => {
      const acc = outputBytesAccRef.current
      acc.set(id, (acc.get(id) || 0) + data.length)
    })
    // Flush accumulated bytes to state every 15s so renders stay infrequent
    const timer = setInterval(() => {
      setOutputBytes(new Map(outputBytesAccRef.current))
    }, 15_000)
    return () => { unsub(); clearInterval(timer) }
  }, [])

  // Remove stale entries when sessions are removed
  useEffect(() => {
    const ids = new Set(instances.map(i => i.id))
    outputBytesAccRef.current.forEach((_, id) => {
      if (!ids.has(id)) outputBytesAccRef.current.delete(id)
    })
  }, [instances])

  // Write pending quick-prompts when the target session becomes ready
  useEffect(() => {
    return window.api.instance.onActivity(({ id, activity }) => {
      if (activity === 'waiting' && pendingPromptRef.current?.id === id) {
        const prompt = pendingPromptRef.current.prompt
        pendingPromptRef.current = null
        window.api.instance.write(id, prompt + '\n')
      }
    })
  }, [])

  // Keyboard shortcuts from main process menu — subscribe once, use refs for fresh values
  useEffect(() => {
    const unsubs = [
      window.api.shortcuts.onNewInstance(() => setShowNewDialog(true)),
      window.api.shortcuts.onCloseInstance(() => {
        const { activeId: aid } = activeViewRef.current
        const { splitId: sid, focusedPane: fp } = splitRef.current
        // In split: kill the focused pane's instance
        const targetId = sid ? (fp === 'left' ? aid : sid) : aid
        if (targetId) {
          const inst = instancesRef.current.find((i) => i.id === targetId)
          if (inst?.status === 'running') window.api.instance.kill(targetId)
          else window.api.instance.remove(targetId)
        }
      }),
      window.api.shortcuts.onToggleSplit(() => {
        // Trigger via state update — handleToggleSplit uses stale refs in the closure,
        // so we dispatch an event the effect can pick up
        window.dispatchEvent(new CustomEvent('colony:toggle-split'))
      }),
      window.api.shortcuts.onCloseSplit(() => {
        window.dispatchEvent(new CustomEvent('colony:close-split'))
      }),
      window.api.shortcuts.onFocusPane((side) => {
        setFocusedPane(side)
      }),
      window.api.shortcuts.onSearch(() => {
        const { activeId: aid, view: v } = activeViewRef.current
        if (v === 'instances' && aid) setSearchOpen(true)
      }),
      window.api.shortcuts.onSwitchInstance((idx: number) => {
        // Match visual order: pinned, then running, then exited
        const all = instancesRef.current
        const pinned = all.filter((i) => i.pinned)
        const running = all.filter((i) => i.status === 'running' && !i.pinned)
        const exited = all.filter((i) => i.status !== 'running' && !i.pinned)
        const insts = [...pinned, ...running, ...exited]
        if (idx < insts.length) {
          const id = insts[idx].id
          setActiveId(id)
          setUnreadIds((prev) => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          setView('instances')
        }
      }),
      window.api.shortcuts.onCycleInstance((direction: number) => {
        const all = instancesRef.current
        const pinned = all.filter((i) => i.pinned)
        const running = all.filter((i) => i.status === 'running' && !i.pinned)
        const exited = all.filter((i) => i.status !== 'running' && !i.pinned)
        const ordered = [...pinned, ...running, ...exited]
        if (ordered.length === 0) return
        const { activeId: aid } = activeViewRef.current
        const currentIdx = ordered.findIndex((i) => i.id === aid)
        const nextIdx = currentIdx === -1 ? 0 : (currentIdx + direction + ordered.length) % ordered.length
        const id = ordered[nextIdx].id
        setActiveId(id)
        setUnreadIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setView('instances')
      }),
      window.api.shortcuts.onZoomIn(() => {
        setFontSize((prev) => {
          const next = Math.min(prev + 1, 28)
          window.api.settings.set('fontSize', String(next))
          return next
        })
      }),
      window.api.shortcuts.onZoomOut(() => {
        setFontSize((prev) => {
          const next = Math.max(prev - 1, 8)
          window.api.settings.set('fontSize', String(next))
          return next
        })
      }),
      window.api.shortcuts.onZoomReset(() => {
        setFontSize(13)
        window.api.settings.set('fontSize', '13')
      }),
      window.api.shortcuts.onCommandPalette(() => {
        setCmdPaletteOpen((prev) => !prev)
        // Refresh sessions list for the palette
        window.api.sessions.list(50).then(setCmdPaletteSessions)
      }),
      window.api.shortcuts.onQuickPrompt(() => {
        setQuickPromptOpen(true)
      }),
      window.api.shortcuts.onNavigate((route) => {
        if (typeof route === 'string') {
          setView(route as import('./components/Sidebar').SidebarView)
        } else if (route && typeof route === 'object' && route.type === 'session' && typeof route.id === 'string') {
          setActiveId(route.id)
          setView('instances')
        }
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, []) // empty deps — runs once, uses refs for fresh values

  // Resource monitor: poll every 5 seconds
  useEffect(() => {
    const poll = () => {
      window.api.resources.getUsage().then(setResourceUsage).catch(() => {})
    }
    poll() // initial
    const interval = setInterval(poll, 5000)
    return () => clearInterval(interval)
  }, [])

  const handleCreate = useCallback(async (opts: {
    name?: string
    workingDirectory?: string
    color?: string
    args?: string[]
    cliBackend?: CliBackend
    mcpServers?: string[]
  }) => {
    agentToLaunchRef.current = null
    const inst = await window.api.instance.create(opts)
    setActiveId(inst.id)
    setShowNewDialog(false)
    setView('instances')
  }, [])

  const handleSelect = useCallback((id: string) => {
    // Clear unread
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })

    // Editor instance check
    if (id === editorInstanceId && editingAgent) {
      setActiveId(id)
      setView('agent-editor')
      return
    }

    // Just select the instance — if it has a split partner, the split will show automatically
    setActiveId(id)
    setFocusedPane('left')
    setView('instances')
  }, [editorInstanceId, editingAgent])

  const handleKill = useCallback(async (id: string) => {
    await window.api.instance.kill(id)
    // Remove any split pairs involving this instance
    setSplitPairs((prev) => {
      const next = new Map(prev)
      next.delete(id) // remove if it was a left pane
      for (const [left, right] of prev) { // remove if it was a right pane
        if (right === id) next.delete(left)
      }
      return next
    })
    if (id === activeId) {
      // If it had a split partner, switch to the partner
      const partner = splitPairs.get(id)
      setActiveId(partner || null)
      setFocusedPane('left')
    }
  }, [activeId, splitPairs])

  const handleRemove = useCallback(async (id: string) => {
    await window.api.instance.remove(id)
    setSplitPairs((prev) => {
      const next = new Map(prev)
      next.delete(id)
      for (const [left, right] of prev) {
        if (right === id) next.delete(left)
      }
      return next
    })
    if (activeId === id) setActiveId(null)
    if (editorInstanceId === id) {
      setEditorInstanceId(null)
      setEditingAgent(null)
      setView('agents')
    }
  }, [activeId, editorInstanceId, splitPairs])

  const handleRename = useCallback(async (id: string, name: string) => {
    await window.api.instance.rename(id, name)
  }, [])

  const handleRecolor = useCallback(async (id: string, color: string) => {
    await window.api.instance.recolor(id, color)
  }, [])

  const handlePin = useCallback(async (id: string) => {
    await window.api.instance.pin(id)
  }, [])

  const handleUnpin = useCallback(async (id: string) => {
    await window.api.instance.unpin(id)
  }, [])

  const handleRestart = useCallback(async (id: string) => {
    const newInst = await window.api.instance.restart(id)
    if (newInst) setActiveId(newInst.id)
  }, [])

  const handleLaunchAgent = useCallback((agent: AgentDef) => {
    agentToLaunchRef.current = agent
    setShowNewDialog(true)
  }, [])

  const handleEditAgent = useCallback((agent: AgentDef) => {
    setEditingAgent(agent)
    setEditorInstanceId(null)
    setView('agent-editor')
  }, [])

  const handleCloseEditor = useCallback(() => {
    if (editorInstanceId) window.api.instance.remove(editorInstanceId)
    setEditingAgent(null)
    setEditorInstanceId(null)
    setView('agents')
  }, [editorInstanceId])

  const handleEditorInstanceCreated = useCallback((instanceId: string) => {
    setEditorInstanceId(instanceId)
  }, [])

  const handleViewChange = useCallback((v: SidebarView) => {
    setView(v)
  }, [])

  useGlobalShortcuts({
    onNewSession: useCallback(() => { agentToLaunchRef.current = null; setShowNewDialog(true) }, []),
    onNavigate: handleViewChange,
    currentView: view as SidebarView,
  })

  const handleResumeSession = useCallback(async (session: CliSession) => {
    // If already running with this session, just focus it
    // Match by: session ID in args, OR same name + same working directory
    const sessionName = session.name || session.display.slice(0, 40)
    const running = instances.find((i) =>
      i.status === 'running' && (
        (i.args.includes('--resume') && i.args.includes(session.sessionId)) ||
        (i.name === sessionName && i.workingDirectory === session.project)
      )
    )
    if (running) {
      setActiveId(running.id)
      setView('instances')
      return
    }
    // Remove any stopped instance with this session ID to avoid duplicates
    const stopped = instances.find((i) =>
      i.status !== 'running' && i.args.includes('--resume') && i.args.includes(session.sessionId)
    )
    if (stopped) {
      await window.api.instance.remove(stopped.id)
    }
    const inst = await window.api.instance.create({
      name: session.name || session.display.slice(0, 40),
      workingDirectory: session.project,
      args: ['--resume', session.sessionId],
      cliBackend: 'claude',
    })
    setActiveId(inst.id)
    setView('instances')
  }, [instances])

  const handleTakeoverExternal = useCallback(async (ext: { pid: number; name: string; cwd: string; sessionId: string | null }) => {
    // Kill the external process and resume the session in Colony
    const result = await window.api.sessions.takeover({
      pid: ext.pid,
      sessionId: ext.sessionId,
      name: ext.name,
      cwd: ext.cwd,
    })
    const inst = await window.api.instance.create({
      name: result.name,
      workingDirectory: result.cwd,
      args: result.args.length > 0 ? result.args : undefined,
      cliBackend: 'claude',
    })
    setActiveId(inst.id)
    setView('instances')
  }, [])

  const handleRestoreAll = useCallback(async () => {
    const toRestore = restorableSessions.filter((s) => s.sessionId && s.exitType !== 'killed')
    for (const s of toRestore) {
      const inst = await window.api.instance.create({
        name: s.instanceName,
        workingDirectory: s.workingDirectory,
        color: s.color,
        args: ['--resume', s.sessionId!],
        cliBackend: s.cliBackend ?? 'claude',
      })
      if (s.pinned) {
        await window.api.instance.pin(inst.id)
      }
    }
    await window.api.sessions.clearRestorable()
    setRestorableSessions([])
  }, [restorableSessions])

  // Drag & drop on sidebar to create instance
  const handleSidebarDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer.files
    if (files.length > 0) {
      const path = window.api.getPathForFile(files[0])
      if (path) {
        const inst = await window.api.instance.create({ workingDirectory: path })
        setActiveId(inst.id)
        setView('instances')
      }
    }
  }, [])

  const regularInstances = instances.filter((i) => i.id !== editorInstanceId)

  // Unique recent working directories from current instances (for quick prompt dir picker)
  const recentDirs = useMemo(() => {
    return [...new Set(instances.map((i) => i.workingDirectory).filter(Boolean))]
  }, [instances])

  const handleQuickPromptLaunch = useCallback(async (prompt: string, workingDirectory: string) => {
    // Save to history (deduplicated, max 20)
    setQuickPromptHistory((prev) => {
      const next = [prompt, ...prev.filter((h) => h !== prompt)].slice(0, 20)
      window.api.settings.set('quickPromptHistory', JSON.stringify(next))
      return next
    })
    const inst = await window.api.instance.create({
      workingDirectory: workingDirectory || undefined,
    })
    // Queue the prompt to be written once the session signals it's ready
    pendingPromptRef.current = { id: inst.id, prompt }
    setActiveId(inst.id)
    setView('instances')
    setQuickPromptOpen(false)
  }, [])

  // Open split with a specific instance as the right pane
  const handleSplitWith = useCallback((id: string) => {
    if (!activeId || id === activeId) return
    setSplitPairs((prev) => {
      const next = new Map(prev)
      next.set(activeId!, id)
      return next
    })
    setFocusedPane('left')
    setSplitRatio(0.5)
    setView('instances')
    // Scroll both terminals to bottom after split renders
    requestAnimationFrame(() => {
      for (const tid of [activeId, id]) {
        const entry = terminalsRef.current.get(tid)
        if (entry) entry.term.scrollToBottom()
      }
    })
  }, [activeId, terminalsRef])

  // Toggle split on/off (Cmd+\)
  const handleToggleSplit = useCallback(() => {
    if (!activeId) return
    if (splitId) {
      // Close split for this instance
      setSplitPairs((prev) => {
        const next = new Map(prev)
        next.delete(activeId!)
        return next
      })
      setFocusedPane('left')
      setArenaMode(false)
      setArenaBlind(false)
      setArenaText('')
      setArenaWinnerId(null)
    } else {
      // Open split — auto-pick if 2 instances, show picker if more
      const others = regularInstances.filter((i) => i.id !== activeId)
      if (others.length === 1) {
        const partnerId = others[0].id
        setSplitPairs((prev) => {
          const next = new Map(prev)
          next.set(activeId!, partnerId)
          return next
        })
        setFocusedPane('left')
        setSplitRatio(0.5)
        requestAnimationFrame(() => {
          for (const tid of [activeId!, partnerId]) {
            const entry = terminalsRef.current.get(tid)
            if (entry) entry.term.scrollToBottom()
          }
        })
      } else if (others.length > 1) {
        setShowSplitPicker(true)
      }
    }
  }, [splitId, activeId, regularInstances, terminalsRef])

  // Close split for the active instance
  const handleCloseSplitView = useCallback(() => {
    if (!activeId || !splitId) return
    setSplitPairs((prev) => {
      const next = new Map(prev)
      next.delete(activeId!)
      return next
    })
    setFocusedPane('left')
    setArenaMode(false)
    setArenaBlind(false)
    setArenaText('')
    setArenaWinnerId(null)
  }, [splitId, activeId])

  const handleArenaWin = useCallback(async (winnerInstId: string) => {
    if (!activeId || !splitId || arenaWinnerId !== null) return
    const winner = instances.find((i) => i.id === winnerInstId)
    const loserInstId = winnerInstId === activeId ? splitId : activeId
    const loser = instances.find((i) => i.id === loserInstId)
    if (!winner || !loser) return
    setArenaWinnerId(winnerInstId)
    setArenaBlind(false)
    await window.api.arena.recordWinner(winner.name, loser.name)
  }, [activeId, splitId, arenaWinnerId, instances])

  const openArenaStats = useCallback(async () => {
    const stats = await window.api.arena.getStats()
    setArenaStats(stats)
    setArenaStatsOpen(true)
  }, [])

  const handlePickSplit = useCallback((id: string) => {
    if (!activeId) return
    setSplitPairs((prev) => {
      const next = new Map(prev)
      next.set(activeId!, id)
      return next
    })
    setFocusedPane('left')
    setSplitRatio(0.5)
    setShowSplitPicker(false)
    requestAnimationFrame(() => {
      for (const tid of [activeId!, id]) {
        const entry = terminalsRef.current.get(tid)
        if (entry) entry.term.scrollToBottom()
      }
    })
  }, [activeId, terminalsRef])

  // Direct keyboard handler for zoom (fallback for when menu accelerators don't fire)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key === '=' || e.key === '+') {
        e.preventDefault()
        setFontSize((prev) => {
          const next = Math.min(prev + 1, 28)
          window.api.settings.set('fontSize', String(next))
          return next
        })
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault()
        setFontSize((prev) => {
          const next = Math.max(prev - 1, 8)
          window.api.settings.set('fontSize', String(next))
          return next
        })
      } else if (e.key === '0') {
        e.preventDefault()
        setFontSize(13)
        window.api.settings.set('fontSize', '13')
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [])

  // Clean up split pairs if either instance no longer exists
  useEffect(() => {
    const ids = new Set(instances.map((i) => i.id))
    let changed = false
    const next = new Map(splitPairs)
    for (const [left, right] of splitPairs) {
      if (!ids.has(left) || !ids.has(right)) {
        next.delete(left)
        changed = true
      }
    }
    if (changed) setSplitPairs(next)
  }, [instances, splitPairs])

  // Bridge custom events to handlers (so shortcuts can call stateful handlers)
  useEffect(() => {
    const onToggle = () => handleToggleSplit()
    const onClose = () => handleCloseSplitView()
    window.addEventListener('colony:toggle-split', onToggle)
    window.addEventListener('colony:close-split', onClose)
    return () => {
      window.removeEventListener('colony:toggle-split', onToggle)
      window.removeEventListener('colony:close-split', onClose)
    }
  }, [handleToggleSplit, handleCloseSplitView])

  // Escape to close modals (capture phase to beat xterm)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (cmdPaletteOpen) { setCmdPaletteOpen(false); e.stopPropagation(); return }
        if (quickPromptOpen) { setQuickPromptOpen(false); e.stopPropagation(); return }
        if (showSplitPicker) { setShowSplitPicker(false); e.stopPropagation() }
        if (showNewDialog) { setShowNewDialog(false); e.stopPropagation() }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [showSplitPicker, showNewDialog, cmdPaletteOpen, quickPromptOpen])

  const active = instances.find((i) => i.id === activeId) || null
  const showTerminal = view === 'instances' && active
  const isSplit = !!(splitId && showTerminal && instances.some((i) => i.id === splitId))

  // Refit on view transitions
  const prevShowTerminalRef = useRef(false)
  const prevActiveIdRef = useRef<string | null>(null)
  useEffect(() => {
    const wasShowing = prevShowTerminalRef.current
    const prevId = prevActiveIdRef.current
    prevShowTerminalRef.current = !!showTerminal
    prevActiveIdRef.current = activeId

    const justBecameVisible = showTerminal && (!wasShowing || activeId !== prevId)
    if (!justBecameVisible || !activeId) return

    const entry = terminalsRef.current.get(activeId)
    if (entry) {
      requestAnimationFrame(() => {
        entry.fitAddon.fit()
        const dims = entry.fitAddon.proposeDimensions?.()
        if (dims && dims.cols > 0 && dims.rows > 0) {
          window.api.instance.resize(activeId, dims.cols, dims.rows)
        }
      })
    }
  }, [showTerminal, activeId])

  // Refit both terminals when split changes
  useEffect(() => {
    if (!showTerminal) return
    const ids = [activeId, splitId].filter(Boolean) as string[]
    requestAnimationFrame(() => {
      for (const id of ids) {
        const entry = terminalsRef.current.get(id)
        if (entry) {
          entry.fitAddon.fit()
          const dims = entry.fitAddon.proposeDimensions?.()
          if (dims && dims.cols > 0 && dims.rows > 0) {
            window.api.instance.resize(id, dims.cols, dims.rows)
          }
        }
      }
    })
  }, [isSplit, splitId])

  const sidebarView: SidebarView = view === 'agent-editor' ? 'agents' : view

  // Status bar data
  const runningCount = instances.filter((i) => i.status === 'running').length
  const activeModel = active?.args.find((_, i, arr) => arr[i - 1] === '--model') || null
  const totalCost = instances.reduce((sum, i) => sum + i.tokenUsage.cost, 0)

  return (
    <div className="app">
      {daemonStale && createPortal(
        <div className="daemon-update-banner">
          <span>Daemon is outdated — restart to apply updates. Running sessions will be terminated; use resume to restore them.</span>
          <button onClick={async () => {
            setDaemonStale(false)
            await window.api.daemon.restart()
            const list = await window.api.instance.list()
            setInstances(list.map(withCliBackend))
          }}>Restart Daemon</button>
          <button className="daemon-update-dismiss" onClick={() => setDaemonStale(false)}>Dismiss</button>
        </div>,
        document.body
      )}
      <Sidebar
        instances={instances}
        activeId={activeId}
        view={sidebarView}
        unreadIds={unreadIds}
        outputBytes={outputBytes}
        onSelect={handleSelect}
        onNew={() => { agentToLaunchRef.current = null; setShowNewDialog(true) }}
        onKill={handleKill}
        onRestart={handleRestart}
        onRemove={handleRemove}
        onRename={handleRename}
        onRecolor={handleRecolor}
        onPin={handlePin}
        onUnpin={handleUnpin}
        onViewChange={handleViewChange}
        onResumeSession={handleResumeSession}
        onTakeoverExternal={handleTakeoverExternal}
        onRestoreAll={handleRestoreAll}
        restorableCount={restorableSessions.filter((s) => s.sessionId && s.exitType !== 'killed').length}
        splitId={splitId}
        splitPairs={splitPairs}
        focusedPane={focusedPane}
        onSplitWith={handleSplitWith}
        onCloseSplit={handleCloseSplitView}
        onDrop={handleSidebarDrop}
        forkGroups={forkGroups}
        onForkSession={async (id) => {
          const inst = instances.find((i) => i.id === id)
          if (!inst) return
          let hint = ''
          try {
            const buf = await window.api.instance.buffer(id)
            const clean = stripAnsi(buf)
            const lines = clean.split('\n').filter((l) => l.trim()).slice(-3)
            hint = lines.join('\n')
          } catch { /* best-effort */ }
          setForkModalHint(hint)
          setForkModalInst(inst)
        }}
      />
      <div className={`main ${isSplit ? 'split' : ''}`}>
        {/* All terminals stay mounted */}
        {regularInstances.map((inst) => {
          const isLeft = showTerminal && inst.id === activeId
          const isRight = isSplit && inst.id === splitId
          const isVisible = isLeft || isRight
          const isFocused = isVisible && (
            !isSplit || (isLeft && focusedPane === 'left') || (isRight && focusedPane === 'right')
          )
          return (
            <div
              key={inst.id}
              className={`terminal-wrapper ${isVisible ? 'visible' : 'hidden'}`}
              style={isSplit && isVisible ? {
                flex: `0 0 calc(${isLeft ? splitRatio * 100 : (1 - splitRatio) * 100}% - 2px)`,
                order: isLeft ? 0 : 2,
              } : undefined}
            >
              <TerminalView
                instance={inst}
                onKill={handleKill}
                onRestart={handleRestart}
                onRemove={handleRemove}
                onSplit={() => {
                  // Open split with a picker for the right pane
                  const others = regularInstances.filter((i) => i.id !== inst.id)
                  if (others.length === 1) {
                    handleSplitWith(others[0].id)
                  } else if (others.length > 1) {
                    setShowSplitPicker(true)
                  }
                }}
                onCloseSplit={handleCloseSplitView}
                onSpawnChild={async () => {
                  const child = await window.api.instance.create({
                    name: `${inst.name} → child`,
                    workingDirectory: inst.workingDirectory,
                    parentId: inst.id,
                    cliBackend: inst.cliBackend ?? 'claude',
                  })
                  setActiveId(child.id)
                }}
                onFork={async () => {
                  // Pre-populate with last 3 lines of terminal output as hint
                  let hint = ''
                  try {
                    const buf = await window.api.instance.buffer(inst.id)
                    const clean = stripAnsi(buf)
                    const lines = clean.split('\n').filter((l) => l.trim()).slice(-3)
                    hint = lines.join('\n')
                  } catch { /* best-effort */ }
                  setForkModalHint(hint)
                  setForkModalInst(inst)
                }}
                isSplit={isSplit}
                arenaMode={isSplit && arenaMode}
                arenaBlind={isSplit && arenaMode && arenaBlind}
                paneLabel={isLeft ? 'A' : 'B'}
                arenaVoted={arenaWinnerId !== null}
                arenaWinnerId={arenaWinnerId}
                onArenaWin={() => handleArenaWin(inst.id)}
                terminalsRef={terminalsRef}
                searchOpen={isFocused && searchOpen}
                onSearchClose={() => setSearchOpen(false)}
                fontSize={fontSize}
                focused={isFocused}
                onFocusPane={() => setFocusedPane(isLeft ? 'left' : 'right')}
                outputBytes={outputBytes.get(inst.id) || 0}
              />
            </div>
          )
        })}

        {/* Split divider */}
        {isSplit && (
          <div
            className="split-divider"
            style={{ order: 1 }}
            title={arenaMode ? 'Arena mode active — shared input bar below' : 'Drag to resize | Double-click to reset'}
            onMouseDown={(e) => {
              e.preventDefault()
              const startX = e.clientX
              const startRatio = splitRatio
              const container = (e.target as HTMLElement).parentElement!
              const containerWidth = container.getBoundingClientRect().width
              let lastFit = 0

              const refitTerminals = () => {
                ;[activeId, splitId].filter(Boolean).forEach((id) => {
                  const entry = terminalsRef.current.get(id!)
                  if (entry) {
                    entry.fitAddon.fit()
                    const dims = entry.fitAddon.proposeDimensions?.()
                    if (dims && dims.cols > 0 && dims.rows > 0) {
                      window.api.instance.resize(id!, dims.cols, dims.rows)
                    }
                  }
                })
              }

              const onMove = (ev: MouseEvent) => {
                const delta = ev.clientX - startX
                const newRatio = Math.max(0.3, Math.min(0.7, startRatio + delta / containerWidth))
                setSplitRatio(newRatio)
                // N8: Debounced refit during drag
                const now = Date.now()
                if (now - lastFit > 100) {
                  lastFit = now
                  requestAnimationFrame(refitTerminals)
                }
              }
              const onUp = () => {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                // Final refit
                refitTerminals()
              }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }}
            onDoubleClick={() => setSplitRatio(0.5)}
          >
            <button
              className={`arena-toggle-btn${arenaMode ? ' active' : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                const next = !arenaMode
                setArenaMode(next)
                if (!next) setArenaBlind(false)
              }}
              title={arenaMode ? 'Disable Arena mode' : 'Enable Arena mode — shared input bar'}
              aria-label="Toggle Arena mode"
            >
              <Swords size={9} />
            </button>
            {arenaMode && (
              <button
                className={`arena-toggle-btn${arenaBlind ? ' active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setArenaBlind((b) => !b) }}
                title={arenaBlind ? 'Reveal session identities' : 'Hide session identities until you vote'}
                aria-label="Toggle blind mode"
              >
                <EyeOff size={9} />
              </button>
            )}
          </div>
        )}

        {/* Arena input bar — full-width row below both panes when active */}
        {isSplit && arenaMode && (
          <div className="arena-input-bar" style={{ order: 100 }}>
            <textarea
              ref={arenaTextareaRef}
              className="arena-textarea"
              value={arenaText}
              onChange={(e) => {
                setArenaText(e.target.value)
                e.target.style.height = 'auto'
                e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px'
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  if (!arenaText.trim() || !activeId || !splitId) return
                  window.api.instance.write(activeId, arenaText + '\n')
                  window.api.instance.write(splitId, arenaText + '\n')
                  setArenaText('')
                  setArenaWinnerId(null)
                  setArenaBlind(false)
                  if (arenaTextareaRef.current) arenaTextareaRef.current.style.height = ''
                }
              }}
              placeholder="Send to both sessions... (Enter to send, Shift+Enter for newline)"
            />
            <button
              className="arena-send-btn"
              disabled={!arenaText.trim()}
              onClick={() => {
                if (!arenaText.trim() || !activeId || !splitId) return
                window.api.instance.write(activeId, arenaText + '\n')
                window.api.instance.write(splitId, arenaText + '\n')
                setArenaText('')
                setArenaWinnerId(null)
                setArenaBlind(false)
                if (arenaTextareaRef.current) arenaTextareaRef.current.style.height = ''
              }}
            >
              Send to both
            </button>
            <div className="arena-stats-container">
              <button
                className="arena-stats-btn"
                onClick={openArenaStats}
                title="Arena win statistics"
                aria-label="View arena statistics"
              >
                <BarChart3 size={14} />
              </button>
              {arenaStatsOpen && (() => {
                const sorted = Object.entries(arenaStats).sort(([, a], [, b]) => {
                  const ra = a.totalRuns > 0 ? a.wins / a.totalRuns : 0
                  const rb = b.totalRuns > 0 ? b.wins / b.totalRuns : 0
                  return rb - ra
                })
                return (
                  <>
                    <div className="arena-stats-backdrop" onClick={() => setArenaStatsOpen(false)} />
                    <div className="arena-stats-popover">
                      <div className="arena-stats-header">
                        <span>Arena Stats</span>
                        <button onClick={() => setArenaStatsOpen(false)} aria-label="Close stats"><XIcon size={12} /></button>
                      </div>
                      {sorted.length === 0 ? (
                        <div className="arena-stats-empty">No rounds recorded yet.</div>
                      ) : (
                        sorted.map(([key, s]) => (
                          <div key={key} className="arena-stats-row">
                            <span className="arena-stats-name">{key}</span>
                            <span className="arena-stats-score">
                              {s.wins}W / {s.losses}L ({s.totalRuns > 0 ? Math.round((s.wins / s.totalRuns) * 100) : 0}%)
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  </>
                )
              })()}
            </div>
          </div>
        )}

        {/* Agent editor */}
        {editingAgent && (
          <div style={{ display: view === 'agent-editor' ? 'contents' : 'none' }}>
            <AgentEditor
              key={editingAgent.id}
              agent={editingAgent}
              onBack={handleCloseEditor}
              onSave={() => {}}
              onInstanceCreated={handleEditorInstanceCreated}
            />
          </div>
        )}

        {/* Panels */}
        {view === 'settings' && (
          <SettingsPanel
            onBack={() => setView('instances')}
          />
        )}
        {view === 'agents' && <AgentsPanel onLaunchAgent={handleLaunchAgent} onEditAgent={handleEditAgent} />}
        {view === 'tasks' && (
          <div className="tasks-view-wrapper">
            <div className="tasks-view-tabs">
              <button
                className={`tasks-view-tab${tasksTab === 'queue' ? ' active' : ''}`}
                onClick={() => setTasksTab('queue')}
              >
                Queue
              </button>
              <button
                className={`tasks-view-tab${tasksTab === 'board' ? ' active' : ''}`}
                onClick={() => setTasksTab('board')}
              >
                Board
              </button>
            </div>
            {tasksTab === 'queue' ? (
              <TaskQueuePanel
                instances={instances}
                onFocusInstance={(id) => { setActiveId(id); setView('instances') }}
                onLaunchInstance={async (opts) => {
                  const inst = await window.api.instance.create(opts)
                  setActiveId(inst.id)
                  setView('instances')
                  return inst.id
                }}
              />
            ) : (
              <TaskBoardPanel />
            )}
          </div>
        )}
        <div style={{ display: view === 'pipelines' ? 'contents' : 'none' }}>
          <PipelinesPanel
            instances={instances}
            onLaunchInstance={async (opts) => {
              const inst = await window.api.instance.create(opts)
              setActiveId(inst.id)
              setView('instances')
              return inst.id
            }}
            onFocusInstance={(id) => {
              setActiveId(id)
              setView('instances')
            }}
          />
        </div>
        {view === 'environments' && (
          <EnvironmentsPanel
            onLaunchInstance={async (opts) => {
              const inst = await window.api.instance.create(opts)
              setActiveId(inst.id)
              setView('instances')
              return inst.id
            }}
            onFocusInstance={(id) => {
              setActiveId(id)
              setView('instances')
            }}
          />
        )}
        {view === 'personas' && (
          <PersonasPanel
            onBack={() => setView('instances')}
            onFocusInstance={(id) => {
              setActiveId(id)
              setView('instances')
            }}
            onLaunchInstance={async (opts) => {
              const inst = await window.api.instance.create(opts)
              setActiveId(inst.id)
              setView('instances')
              return inst.id
            }}
            instances={instances}
          />
        )}
        {view === 'outputs' && <OutputsPanel />}
        {view === 'analytics' && <AnalyticsPanel onBack={() => setView('instances')} />}
        <div style={{ display: view === 'github' ? 'contents' : 'none' }}>
          <GitHubPanel
            onBack={() => setView('instances')}
            instances={instances}
            visible={view === 'github'}
            onLaunchInstance={async (opts) => {
              const inst = await window.api.instance.create(opts)
              setActiveId(inst.id)
              setView('instances')
              return inst.id
            }}
            onFocusInstance={(id) => {
              setActiveId(id)
              setView('instances')
            }}
          />
        </div>
        {view === 'instances' && !active && (
          <div className="empty-state">
            <h2>No session selected</h2>
            <p>Create a new Claude session to get started</p>
            <button onClick={() => setShowNewDialog(true)}>New Session</button>
          </div>
        )}

        {/* Status bar */}
        <div className="status-bar">
          <span className="status-bar-item">
            {runningCount} running
          </span>
          {active?.gitBranch && (
            <span className="status-bar-item status-bar-branch">
              {active.gitBranch}
            </span>
          )}
          {activeModel && (
            <span className="status-bar-item">{activeModel}</span>
          )}
          {totalCost >= 0.01 && (
            <span className="status-bar-item status-bar-cost">
              ${totalCost.toFixed(4)}
            </span>
          )}
          <span className="status-bar-item">
            {fontSize}px
          </span>
          {resourceUsage && resourceUsage.total.cpu > 0 && (
            <span className="status-bar-item status-bar-resources" title={`Colony total: CPU ${resourceUsage.total.cpu.toFixed(1)}%, Memory ${resourceUsage.total.memory.toFixed(1)}MB`}>
              CPU {resourceUsage.total.cpu.toFixed(1)}% | {resourceUsage.total.memory.toFixed(1)}MB
            </span>
          )}
          {active && resourceUsage?.perInstance[active.id] && (
            <span className="status-bar-item status-bar-session-resources" title={`This session: CPU ${resourceUsage.perInstance[active.id].cpu.toFixed(1)}%, Memory ${resourceUsage.perInstance[active.id].memory.toFixed(1)}MB`}>
              [{resourceUsage.perInstance[active.id].cpu.toFixed(1)}% / {resourceUsage.perInstance[active.id].memory.toFixed(1)}MB]
            </span>
          )}
          <span className="status-bar-spacer" />
          {active && (
            <span className="status-bar-item status-bar-right">
              {active.workingDirectory.split('/').pop()}
              {active.pid ? ` · PID ${active.pid}` : ''}
            </span>
          )}
        </div>
      </div>
      {showNewDialog && (
        <NewInstanceDialog
          onCreate={handleCreate}
          onClose={() => { setShowNewDialog(false); agentToLaunchRef.current = null }}
          prefill={agentToLaunchRef.current || undefined}
        />
      )}
      {forkModalInst && (
        <ForkModal
          instance={forkModalInst}
          bufferHint={forkModalHint}
          onClose={() => setForkModalInst(null)}
          onSubmit={async (opts) => {
            await window.api.fork.create(forkModalInst.id, opts)
          }}
        />
      )}
      {quickPromptOpen && (
        <QuickPromptDialog
          onClose={() => setQuickPromptOpen(false)}
          onLaunch={handleQuickPromptLaunch}
          recentDirs={recentDirs}
          promptHistory={quickPromptHistory}
        />
      )}
      {showSplitPicker && (
        <div className="dialog-overlay" onClick={() => setShowSplitPicker(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Split with...</h2>
            <div className="split-picker-list">
              {regularInstances
                .filter((i) => i.id !== activeId)
                .map((i) => (
                  <div
                    key={i.id}
                    className="split-picker-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => handlePickSplit(i.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePickSplit(i.id) } }}
                  >
                    <div className="instance-dot" style={{ backgroundColor: i.color }} />
                    <span>{i.name}</span>
                    <span className="split-picker-dir">{i.workingDirectory.split('/').pop()}</span>
                  </div>
                ))
              }
            </div>
          </div>
        </div>
      )}
      <CommandPalette
        open={cmdPaletteOpen}
        onClose={() => setCmdPaletteOpen(false)}
        instances={regularInstances}
        activeId={activeId}
        onSelect={(id) => { handleSelect(id); setView('instances') }}
        onNew={() => { agentToLaunchRef.current = null; setShowNewDialog(true) }}
        onKill={handleKill}
        onRestart={handleRestart}
        onViewChange={(v) => setView(v as View)}
        onToggleSplit={handleToggleSplit}
        onResumeSession={handleResumeSession}
        sessions={cmdPaletteSessions}
        onRunPersona={(id) => { window.api.persona.run(id); setView('personas') }}
        onLaunchAgent={handleLaunchAgent}
        onOpenQuickPrompt={() => { setCmdPaletteOpen(false); setQuickPromptOpen(true) }}
      />

      {/* Environment prompt modal — rendered at app root so it works on any panel */}
      {envPromptRequest && createPortal(
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }}
          onClick={() => { window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, cancelled: true }); setEnvPromptRequest(null) }}>
          <div style={{ background: 'var(--bg-primary, #1e1e2e)', border: '1px solid var(--border, #333)', borderRadius: 10, padding: 24, width: 460, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                {envPromptRequest.promptType === 'file' ? 'Select File' : 'Select Option'}
              </h3>
              <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4 }}
                onClick={() => { window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, cancelled: true }); setEnvPromptRequest(null) }}>
                ✕
              </button>
            </div>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary, #aaa)', lineHeight: 1.5 }}>{envPromptRequest.prompt}</p>

            {envPromptRequest.promptType === 'file' && (
              <>
                {envPromptRequest.defaultPath && (
                  <div style={{ background: 'var(--bg-secondary, #282838)', borderRadius: 6, padding: '8px 12px', margin: '0 0 20px', fontSize: 12, color: 'var(--text-muted, #666)', wordBreak: 'break-all' }}>
                    Default: <code style={{ color: 'var(--text-primary, #ccc)' }}>{envPromptRequest.defaultPath}</code>
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--border, #444)', background: 'transparent', color: 'var(--text-primary, #ccc)', cursor: 'pointer', fontSize: 13 }}
                    onClick={() => { window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, cancelled: true }); setEnvPromptRequest(null) }}>
                    Skip
                  </button>
                  <button style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--accent, #7c5cfc)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                    onClick={async () => {
                      const filePath = await window.api.env.pickFile({
                        title: 'Select .env file',
                        message: envPromptRequest.prompt,
                        defaultPath: envPromptRequest.defaultPath,
                      })
                      if (filePath) {
                        window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, filePath })
                        setEnvPromptRequest(null)
                      }
                    }}>
                    Browse…
                  </button>
                </div>
              </>
            )}

            {envPromptRequest.promptType === 'select' && envPromptRequest.options && (
              <>
                <div style={{ maxHeight: 300, overflowY: 'auto', margin: '0 0 16px', borderRadius: 6, border: '1px solid var(--border, #333)' }}>
                  {envPromptRequest.options.map((option, i) => (
                    <button key={i}
                      style={{ display: 'block', width: '100%', padding: '10px 14px', background: 'transparent', border: 'none', borderBottom: i < envPromptRequest.options!.length - 1 ? '1px solid var(--border, #333)' : 'none', color: 'var(--text-primary, #ccc)', cursor: 'pointer', fontSize: 13, textAlign: 'left', fontFamily: 'monospace' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary, #282838)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                      onClick={() => {
                        window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, selectedValue: option })
                        setEnvPromptRequest(null)
                      }}>
                      {option}
                    </button>
                  ))}
                </div>
                <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
                  <button style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--border, #444)', background: 'transparent', color: 'var(--text-primary, #ccc)', cursor: 'pointer', fontSize: 13 }}
                    onClick={() => { window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, cancelled: true }); setEnvPromptRequest(null) }}>
                    Skip
                  </button>
                </div>
              </>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
