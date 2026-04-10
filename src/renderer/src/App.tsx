import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Swords, BarChart3, X as XIcon, EyeOff, Trophy, Rocket, Gavel } from 'lucide-react'
import { useGlobalShortcuts } from './hooks/useGlobalShortcuts'
import { createPortal } from 'react-dom'
import type { ClaudeInstance, AgentDef, CliSession, RecentSession, CliBackend, ArenaStats } from './types'
import Sidebar, { SidebarView } from './components/Sidebar'
import TerminalView from './components/TerminalView'
import NewInstanceDialog, { type CloneSource } from './components/NewInstanceDialog'
import SessionEmptyState from './components/SessionEmptyState'
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
import ReviewPanel from './components/ReviewPanel'
import QuickPromptDialog from './components/QuickPromptDialog'
import ForkModal from './components/ForkModal'
import ArenaLaunchDialog from './components/ArenaLaunchDialog'
import ArenaJudgeDialog from './components/ArenaJudgeDialog'
import ArenaLeaderboard from './components/ArenaLeaderboard'
import ColonyOverviewPanel from './components/ColonyOverviewPanel'
import { loadPresets } from './components/WorkspacePresets'
import type { WorkspacePreset } from './components/WorkspacePresets'
import AppUpdateBanner from './components/AppUpdateBanner'
import WelcomeModal from './components/WelcomeModal'
import { stripAnsi } from '../../shared/utils'
import type { ForkGroup } from '../../shared/types'

type View = SidebarView | 'agent-editor'

/** Shallow-compare two instance lists to avoid unnecessary React re-renders */
function instancesEqual(prev: ClaudeInstance[], next: ClaudeInstance[]): boolean {
  if (prev.length !== next.length) return false
  for (let i = 0; i < prev.length; i++) {
    const a = prev[i], b = next[i]
    if (a.id !== b.id || a.status !== b.status || a.activity !== b.activity ||
        a.name !== b.name || a.color !== b.color || a.gitBranch !== b.gitBranch ||
        a.pinned !== b.pinned || a.roleTag !== b.roleTag ||
        a.tokenUsage.input !== b.tokenUsage.input || a.tokenUsage.output !== b.tokenUsage.output ||
        a.exitCode !== b.exitCode || a.pendingSteer !== b.pendingSteer ||
        a.mcpServers.length !== b.mcpServers.length || a.childIds.length !== b.childIds.length) {
      return false
    }
  }
  return true
}

export default function App() {
  const [instances, setInstances] = useState<ClaudeInstance[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showNewDialog, setShowNewDialog] = useState(false)
  // Seed for the next "New Session" dialog open. When a starter-card on the
  // Sessions empty state is clicked, we stash the prompt + cwd here so the
  // dialog opens pre-filled. Cleared on close.
  const [newDialogSeed, setNewDialogSeed] = useState<{
    initialPrompt?: string
    workingDirectory?: string
  } | null>(null)
  const [cloneSource, setCloneSource] = useState<CloneSource | null>(null)
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
  // 4-up grid state (mutually exclusive with 2-up splitPairs)
  const [gridPanes, setGridPanes] = useState<(string | null)[]>([null, null, null, null])
  const [focusedGridIdx, setFocusedGridIdx] = useState(0)
  const [arenaMode, setArenaMode] = useState(false)
  const [arenaBlind, setArenaBlind] = useState(false)
  const [arenaText, setArenaText] = useState('')
  const arenaTextareaRef = useRef<HTMLTextAreaElement>(null)
  const [arenaWinnerId, setArenaWinnerId] = useState<string | null>(null)
  const [arenaStatsOpen, setArenaStatsOpen] = useState(false)
  const [arenaStats, setArenaStats] = useState<ArenaStats>({})
  const [arenaLaunchOpen, setArenaLaunchOpen] = useState(false)
  const [arenaWorktreeIds, setArenaWorktreeIds] = useState<string[]>([])
  const [arenaLeaderboardOpen, setArenaLeaderboardOpen] = useState(false)
  const [arenaJudgeOpen, setArenaJudgeOpen] = useState(false)
  const [arenaJudging, setArenaJudging] = useState(false)
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
  const [daemonFailed, setDaemonFailed] = useState(false)
  const [envPromptRequest, setEnvPromptRequest] = useState<{ requestId: string; envId: string; hookName: string; prompt: string; promptType: string; defaultPath?: string; defaultPathValid?: boolean; options?: string[] } | null>(null)
  const [showWelcome, setShowWelcome] = useState(false)
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
  // Derived: are we in 4-up grid mode?
  const isGrid = gridPanes.some(p => p !== null)

  useEffect(() => {
    window.api.instance.list().then((list) => setInstances(prev => instancesEqual(prev, list) ? prev : list))
    window.api.sessions.restorable().then(setRestorableSessions)
    window.api.settings.getAll().then((s) => {
      if (s.fontSize) {
        setFontSize(parseInt(s.fontSize, 10) || 13)
      }
      if (s.quickPromptHistory) {
        try { setQuickPromptHistory(JSON.parse(s.quickPromptHistory)) } catch { /* ignore */ }
      }
    })
    // Check first-run onboarding state
    window.api.onboarding.getState().then((s) => {
      if (!s.firstRunCompletedAt) setShowWelcome(true)
    }).catch(() => {})
    // Check daemon version on mount (the push event may have fired before we loaded)
    window.api.daemon.getVersion().then((v) => {
      if (v.running !== v.expected) setDaemonStale(true)
    }).catch(() => {})
    // Also listen for push events (e.g. after reconnect)
    const unsubVersion = window.api.daemon.onVersionMismatch(() => {
      setDaemonStale(true)
    })
    const unsubFailed = window.api.daemon.onConnectionFailed(() => {
      setDaemonFailed(true)
    })
    return () => { unsubVersion(); unsubFailed() }
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
    const unsub = window.api.instance.onListUpdate((list) => setInstances(prev => instancesEqual(prev, list) ? prev : list))
    return unsub
  }, [])

  // Single onOutput listener — handles both unread tracking and output byte counting
  useEffect(() => {
    const recentOutput = new Map<string, string>()
    const novelBytes = new Map<string, number>()
    const THRESHOLD = 80

    const unsub = window.api.instance.onOutput(({ id, data }) => {
      // Output byte accumulator (cheap — always runs)
      const acc = outputBytesAccRef.current
      acc.set(id, (acc.get(id) || 0) + data.length)

      // Unread tracking — skip if user is looking at this instance
      const { activeId: currentActive, view: currentView } = activeViewRef.current
      const isVisible = currentView === 'instances' && id === currentActive
      if (isVisible) {
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
        recentOutput.set(id, clean)
        return
      }

      // Check character-level novelty
      const prevChars = new Set(prev.split(''))
      let novelCount = 0
      for (const ch of clean) {
        if (!prevChars.has(ch)) novelCount++
      }
      if (clean.length > 10 && novelCount / clean.length < 0.3) {
        recentOutput.set(id, clean)
        return
      }

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
    // Flush accumulated bytes to state every 15s so renders stay infrequent
    const timer = setInterval(() => {
      setOutputBytes(new Map(outputBytesAccRef.current))
    }, 15_000)
    return () => { unsub(); clearInterval(timer) }
  }, [])

  useEffect(() => {
    const unsub = window.api.instance.onFocus(({ id }) => {
      setActiveId(id)
      setView('instances')
    })
    return unsub
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

  // Toggle body class for fullscreen — lets CSS reduce traffic-light padding
  useEffect(() => {
    return window.api.window.onFullScreenChanged((isFS) => {
      document.body.classList.toggle('fullscreen', isFS)
    })
  }, [])

  // Resource monitor: poll every 15 seconds, only when the window is focused
  useEffect(() => {
    let interval: ReturnType<typeof setInterval> | null = null
    const poll = () => {
      if (document.hidden) return
      window.api.resources.getUsage().then(setResourceUsage).catch(() => {})
    }
    const start = () => {
      poll()
      if (interval) clearInterval(interval)
      interval = setInterval(poll, 15000)
    }
    const stop = () => { if (interval) { clearInterval(interval); interval = null } }
    const onVisChange = () => { document.hidden ? stop() : start() }
    document.addEventListener('visibilitychange', onVisChange)
    if (!document.hidden) start()
    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisChange)
    }
  }, [])

  const handleCreate = useCallback(async (opts: {
    name?: string
    workingDirectory?: string
    color?: string
    args?: string[]
    cliBackend?: CliBackend
    mcpServers?: string[]
    initialPrompt?: string
    permissionMode?: 'autonomous' | 'supervised'
    planFirst?: boolean
  }) => {
    agentToLaunchRef.current = null
    const { initialPrompt, planFirst, ...createOpts } = opts
    const inst = await window.api.instance.create(createOpts)
    // If the caller seeded a first prompt, queue it to run once the session
    // signals it's ready — same path the Quick Prompt flow uses.
    if (initialPrompt && initialPrompt.trim()) {
      const prompt = planFirst
        ? `IMPORTANT: Before taking any action, first create a structured plan:\n1. Summarize your understanding of the task\n2. List the files you expect to modify and why\n3. Outline your step-by-step approach\n4. Note any risks or assumptions\n\nPresent the plan, then WAIT for my approval before proceeding.\nDo not use any tools or make any changes until I confirm.\n\nTask: ${initialPrompt}`
        : initialPrompt
      pendingPromptRef.current = { id: inst.id, prompt }
    }
    setActiveId(inst.id)
    setShowNewDialog(false)
    setNewDialogSeed(null)
    setCloneSource(null)
    setView('instances')
  }, [])

  const handleStarterCard = useCallback(
    (prompt: string, seedOpts: { workingDirectory?: string }) => {
      agentToLaunchRef.current = null
      setNewDialogSeed({
        initialPrompt: prompt,
        workingDirectory: seedOpts.workingDirectory,
      })
      setShowNewDialog(true)
    },
    [],
  )

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

    // In grid mode: if session is already in a pane, focus it; otherwise fill next empty or replace focused
    if (gridPanes.some(p => p !== null)) {
      const existingIdx = gridPanes.indexOf(id)
      if (existingIdx >= 0) {
        setFocusedGridIdx(existingIdx)
        setActiveId(id)
        setView('instances')
        return
      }
      // Fill next empty pane, or replace focused pane
      const emptyIdx = gridPanes.indexOf(null)
      if (emptyIdx >= 0) {
        setGridPanes(prev => { const n = [...prev]; n[emptyIdx] = id; return n })
        setFocusedGridIdx(emptyIdx)
      } else {
        setGridPanes(prev => { const n = [...prev]; n[focusedGridIdx] = id; return n })
      }
      setActiveId(id)
      setView('instances')
      return
    }

    // Just select the instance — if it has a split partner, the split will show automatically
    setActiveId(id)
    setFocusedPane('left')
    setView('instances')
  }, [editorInstanceId, editingAgent, gridPanes, focusedGridIdx])

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
    // Clean up grid panes
    setGridPanes(prev => {
      const idx = prev.indexOf(id)
      if (idx < 0) return prev
      const next = [...prev]
      next[idx] = null
      const remaining = next.filter(p => p !== null)
      if (remaining.length <= 1) {
        if (remaining.length === 1) setActiveId(remaining[0])
        return [null, null, null, null]
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
    // Clean up grid panes
    setGridPanes(prev => {
      const idx = prev.indexOf(id)
      if (idx < 0) return prev
      const next = [...prev]
      next[idx] = null
      const remaining = next.filter(p => p !== null)
      if (remaining.length <= 1) {
        if (remaining.length === 1) setActiveId(remaining[0])
        return [null, null, null, null]
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

  const handleSetNote = useCallback(async (id: string, note: string) => {
    await window.api.instance.setNote(id, note)
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

  const handleNewSession = useCallback(() => { agentToLaunchRef.current = null; setShowNewDialog(true) }, [])

  const handleCloneSession = useCallback((inst: ClaudeInstance) => {
    agentToLaunchRef.current = null
    setCloneSource({
      name: inst.name,
      workingDirectory: inst.workingDirectory,
      color: inst.color,
      cliBackend: inst.cliBackend,
      permissionMode: inst.permissionMode,
      mcpServers: inst.mcpServers,
      args: inst.args,
    })
    setShowNewDialog(true)
  }, [])

  useGlobalShortcuts({
    onNewSession: handleNewSession,
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

  const regularInstances = useMemo(() => instances.filter((i) => i.id !== editorInstanceId), [instances, editorInstanceId])

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
    if (arenaWinnerId !== null) return
    const winner = instances.find((i) => i.id === winnerInstId)
    if (!winner) return
    // Collect losers: all other sessions in the arena
    const arenaIds = gridPanes.some(p => p !== null)
      ? gridPanes.filter((p): p is string => p !== null)
      : [activeId, splitId].filter((p): p is string => !!p)
    const loserNames = arenaIds
      .filter(id => id !== winnerInstId)
      .map(id => instances.find((i) => i.id === id)?.name)
      .filter((n): n is string => !!n)
    if (loserNames.length === 0) return
    setArenaWinnerId(winnerInstId)
    setArenaBlind(false)
    await window.api.arena.recordWinner(winner.name, loserNames)
  }, [activeId, splitId, arenaWinnerId, instances, gridPanes])

  const openArenaStats = useCallback(async () => {
    const stats = await window.api.arena.getStats()
    setArenaStats(stats)
    setArenaStatsOpen(true)
  }, [])

  const handleAutoJudge = useCallback(async (config: { type: 'command'; cmd: string } | { type: 'llm'; prompt: string }) => {
    const arenaIds = gridPanes.some(p => p !== null)
      ? gridPanes.filter((p): p is string => p !== null)
      : [activeId, splitId].filter((p): p is string => !!p)
    if (arenaIds.length < 2) return
    setArenaJudging(true)
    try {
      const { winnerId } = await window.api.arena.autoJudge({ instanceIds: arenaIds, judgeConfig: config })
      if (winnerId) {
        setArenaWinnerId(winnerId)
        setArenaBlind(false)
      }
    } finally {
      setArenaJudging(false)
      setArenaJudgeOpen(false)
    }
  }, [gridPanes, activeId, splitId])

  const handleArenaLaunch = useCallback((result: { instances: string[]; worktrees: string[] }) => {
    const { instances: ids, worktrees: wtIds } = result
    // Populate grid with the new instance IDs
    const panes: (string | null)[] = [null, null, null, null]
    ids.forEach((id, i) => { if (i < 4) panes[i] = id })
    setGridPanes(panes)
    setFocusedGridIdx(0)
    if (ids[0]) setActiveId(ids[0])
    setArenaMode(true)
    setArenaBlind(false)
    setArenaWinnerId(null)
    setArenaWorktreeIds(wtIds)
    setSplitPairs(new Map())
    setView('instances')
  }, [])

  const handleArenaCleanup = useCallback(async () => {
    if (arenaWorktreeIds.length === 0) return
    const ok = confirm(`Remove ${arenaWorktreeIds.length} arena worktree${arenaWorktreeIds.length > 1 ? 's' : ''}?`)
    if (!ok) {
      setArenaWorktreeIds([])
      return
    }
    await window.api.arena.cleanupWorktrees(arenaWorktreeIds)
    setArenaWorktreeIds([])
  }, [arenaWorktreeIds])

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

  // Enter 4-up grid mode from current state
  const handleEnterGrid = useCallback(() => {
    if (!activeId) return
    const panes: (string | null)[] = [activeId, splitId || null, null, null]
    setGridPanes(panes)
    setFocusedGridIdx(0)
    // Clear 2-up split pairs since grid takes over
    setSplitPairs(new Map())
    setFocusedPane('left')
    setArenaMode(false)
    setArenaBlind(false)
    setArenaText('')
    setArenaWinnerId(null)
    // Refit all visible terminals
    requestAnimationFrame(() => {
      for (const p of panes) {
        if (!p) continue
        const entry = terminalsRef.current.get(p)
        if (entry) {
          entry.fitAddon.fit()
          const dims = entry.fitAddon.proposeDimensions?.()
          if (dims && dims.cols > 0 && dims.rows > 0) {
            window.api.instance.resize(p, dims.cols, dims.rows)
          }
        }
      }
    })
  }, [activeId, splitId, terminalsRef])

  // Exit grid mode entirely
  const handleExitGrid = useCallback(() => {
    const first = gridPanes.find(p => p !== null)
    setGridPanes([null, null, null, null])
    setFocusedGridIdx(0)
    if (first) setActiveId(first)
    // Prompt to clean up arena worktrees if any
    if (arenaWorktreeIds.length > 0) handleArenaCleanup()
  }, [gridPanes, arenaWorktreeIds, handleArenaCleanup])

  // Close one grid pane — if 1 or fewer remain, exit grid mode
  const handleCloseGridPane = useCallback((idx: number) => {
    setGridPanes(prev => {
      const next = [...prev]
      next[idx] = null
      const remaining = next.filter(p => p !== null)
      if (remaining.length <= 1) {
        if (remaining.length === 1) setActiveId(remaining[0])
        return [null, null, null, null]
      }
      // If the focused pane was closed, move focus to the first non-null pane
      const focusedId = next[focusedGridIdx]
      if (!focusedId) {
        const newFocusIdx = next.findIndex(p => p !== null)
        if (newFocusIdx >= 0) {
          setFocusedGridIdx(newFocusIdx)
          setActiveId(next[newFocusIdx]!)
        }
      }
      return next
    })
  }, [focusedGridIdx])

  // Focus a grid pane
  const handleGridPaneFocus = useCallback((idx: number) => {
    setFocusedGridIdx(idx)
    const paneId = gridPanes[idx]
    if (paneId) setActiveId(paneId)
  }, [gridPanes])

  // Cycle layout: single → 2-up → 4-up → single
  const handleCycleLayout = useCallback(() => {
    if (!activeId) return
    if (isGrid) {
      // 4-up → single
      handleExitGrid()
    } else if (splitId) {
      // 2-up → 4-up
      handleEnterGrid()
    } else {
      // single → 2-up (existing toggle behavior)
      handleToggleSplit()
    }
  }, [activeId, isGrid, splitId, handleExitGrid, handleEnterGrid, handleToggleSplit])

  // Load a workspace preset: restore view, layout, and sidebar width
  const handleLoadPreset = useCallback((preset: WorkspacePreset) => {
    setView(preset.view)
    // Restore sidebar width
    document.documentElement.style.setProperty('--sidebar-width', preset.sidebarWidth + 'px')
    localStorage.setItem('sidebar-width', String(preset.sidebarWidth))
    // Restore layout mode
    const currentlyGrid = gridPanes.some(p => p !== null)
    const currentlySplit = !currentlyGrid && splitPairs.size > 0
    if (preset.layout === '4-up') {
      if (!currentlyGrid) handleEnterGrid()
    } else if (preset.layout === '2-up') {
      if (currentlyGrid) handleExitGrid()
      if (!splitPairs.has(activeId || '')) handleToggleSplit()
    } else {
      // single
      if (currentlyGrid) handleExitGrid()
      if (currentlySplit) handleCloseSplitView()
    }
  }, [gridPanes, splitPairs, activeId, handleEnterGrid, handleExitGrid, handleToggleSplit, handleCloseSplitView])

  // Cmd+Shift+1-5 for workspace presets
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || !e.shiftKey) return
      const num = parseInt(e.key, 10)
      if (num >= 1 && num <= 5) {
        e.preventDefault()
        const presets = loadPresets()
        if (num - 1 < presets.length) {
          handleLoadPreset(presets[num - 1])
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [handleLoadPreset])

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

  // Clean up split pairs and grid panes if instances no longer exist
  useEffect(() => {
    const ids = new Set(instances.map((i) => i.id))
    let splitChanged = false
    const next = new Map(splitPairs)
    for (const [left, right] of splitPairs) {
      if (!ids.has(left) || !ids.has(right)) {
        next.delete(left)
        splitChanged = true
      }
    }
    if (splitChanged) setSplitPairs(next)

    // Grid cleanup
    let gridChanged = false
    const nextGrid = [...gridPanes]
    for (let i = 0; i < 4; i++) {
      if (nextGrid[i] && !ids.has(nextGrid[i]!)) {
        nextGrid[i] = null
        gridChanged = true
      }
    }
    if (gridChanged) {
      const remaining = nextGrid.filter(p => p !== null)
      if (remaining.length <= 1) {
        setGridPanes([null, null, null, null])
        if (remaining.length === 1) setActiveId(remaining[0])
      } else {
        setGridPanes(nextGrid)
      }
    }
  }, [instances, splitPairs, gridPanes])

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
  const showTerminal = view === 'instances' && (active || isGrid)
  const showGrid = isGrid && view === 'instances'
  const isSplit = !showGrid && !!(splitId && showTerminal && instances.some((i) => i.id === splitId))

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

  // Refit terminals when split/grid changes
  useEffect(() => {
    if (!showTerminal) return
    const ids = showGrid
      ? gridPanes.filter(Boolean) as string[]
      : [activeId, splitId].filter(Boolean) as string[]
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
  }, [isSplit, splitId, showGrid, gridPanes])

  const sidebarView: SidebarView = view === 'agent-editor' ? 'agents' : view

  // Status bar data
  const runningCount = instances.filter((i) => i.status === 'running').length
  const activeModel = active?.args.find((_, i, arr) => arr[i - 1] === '--model') || null

  // Stable per-instance callbacks for TerminalView (avoids new refs every render)
  const regularInstancesRef = useRef(regularInstances)
  regularInstancesRef.current = regularInstances
  const instanceCallbacksRef = useRef(new Map<string, {
    onSplit: () => void
    onSpawnChild: () => void
    onFork: () => void
    onArenaWin: () => void
    onFocusLeft: () => void
    onFocusRight: () => void
  }>())
  const handleSearchClose = useCallback(() => setSearchOpen(false), [])
  const handleForkSession = useCallback(async (id: string) => {
    const inst = instancesRef.current.find((i) => i.id === id)
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
  }, [])
  const restorableCount = useMemo(
    () => restorableSessions.filter((s) => s.sessionId && s.exitType !== 'killed').length,
    [restorableSessions]
  )
  // Create stable callbacks per instance (created once, use refs for current values)
  for (const inst of regularInstances) {
    let cbs = instanceCallbacksRef.current.get(inst.id)
    if (!cbs) {
      const id = inst.id
      cbs = {
        onSplit: () => {
          const others = regularInstancesRef.current.filter((i) => i.id !== id)
          if (others.length === 1) handleSplitWith(others[0].id)
          else if (others.length > 1) setShowSplitPicker(true)
        },
        onSpawnChild: async () => {
          const current = regularInstancesRef.current.find(i => i.id === id)
          if (!current) return
          const child = await window.api.instance.create({
            name: `${current.name} → child`,
            workingDirectory: current.workingDirectory,
            parentId: id,
            cliBackend: current.cliBackend ?? 'claude',
          })
          setActiveId(child.id)
        },
        onFork: async () => {
          const current = regularInstancesRef.current.find(i => i.id === id)
          if (!current) return
          let hint = ''
          try {
            const buf = await window.api.instance.buffer(id)
            const clean = stripAnsi(buf)
            const lines = clean.split('\n').filter((l) => l.trim()).slice(-3)
            hint = lines.join('\n')
          } catch { /* best-effort */ }
          setForkModalHint(hint)
          setForkModalInst(current)
        },
        onArenaWin: () => handleArenaWin(id),
        onFocusLeft: () => setFocusedPane('left'),
        onFocusRight: () => setFocusedPane('right'),
      }
      instanceCallbacksRef.current.set(id, cbs)
    }
  }
  // Clean up stale entries
  const currentIds = new Set(regularInstances.map(i => i.id))
  for (const id of instanceCallbacksRef.current.keys()) {
    if (!currentIds.has(id)) instanceCallbacksRef.current.delete(id)
  }

  return (
    <div className="app">
      {createPortal(<AppUpdateBanner />, document.body)}
      {showWelcome && createPortal(
        <WelcomeModal onClose={() => setShowWelcome(false)} />,
        document.body
      )}
      {daemonStale && createPortal(
        <div className="daemon-update-banner">
          <span>Daemon is outdated — restart to apply updates. Running sessions will be terminated; use resume to restore them.</span>
          <button onClick={async () => {
            setDaemonStale(false)
            await window.api.daemon.restart()
            const list = await window.api.instance.list()
            setInstances(prev => instancesEqual(prev, list) ? prev : list)
          }}>Restart Daemon</button>
          <button className="daemon-update-dismiss" onClick={() => setDaemonStale(false)}>Dismiss</button>
        </div>,
        document.body
      )}
      {daemonFailed && createPortal(
        <div className="daemon-update-banner daemon-failed-banner">
          <span>Daemon connection failed — sessions and environments unavailable.</span>
          <button onClick={async () => {
            setDaemonFailed(false)
            try {
              await window.api.daemon.restart()
              const list = await window.api.instance.list()
              setInstances(prev => instancesEqual(prev, list) ? prev : list)
            } catch {
              setDaemonFailed(true)
            }
          }}>Retry</button>
          <button className="daemon-update-dismiss" onClick={() => setDaemonFailed(false)}>Dismiss</button>
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
        onNew={handleNewSession}
        onKill={handleKill}
        onRestart={handleRestart}
        onRemove={handleRemove}
        onRename={handleRename}
        onSetNote={handleSetNote}
        onRecolor={handleRecolor}
        onPin={handlePin}
        onUnpin={handleUnpin}
        onViewChange={handleViewChange}
        onResumeSession={handleResumeSession}
        onTakeoverExternal={handleTakeoverExternal}
        onRestoreAll={handleRestoreAll}
        restorableCount={restorableCount}
        splitId={splitId}
        splitPairs={splitPairs}
        focusedPane={focusedPane}
        onSplitWith={handleSplitWith}
        onCloseSplit={handleCloseSplitView}
        onDrop={handleSidebarDrop}
        forkGroups={forkGroups}
        onForkSession={handleForkSession}
        gridPanes={showGrid ? gridPanes : undefined}
        currentLayout={showGrid ? '4-up' : isSplit ? '2-up' : 'single'}
        onLoadPreset={handleLoadPreset}
        onCloneSession={handleCloneSession}
      />
      <div className={`main ${showGrid ? 'grid-4' : isSplit ? 'split' : ''}`}>
        {/* All terminals stay mounted (xterm doesn't support re-open); expensive effects gated on focused prop */}
        {regularInstances.map((inst) => {
          const gridIdx = showGrid ? gridPanes.indexOf(inst.id) : -1
          const isGridPane = gridIdx >= 0
          const isLeft = !showGrid && showTerminal && inst.id === activeId
          const isRight = isSplit && inst.id === splitId
          const isVisible = isLeft || isRight || isGridPane
          const isFocused = isVisible && (
            showGrid ? gridIdx === focusedGridIdx :
            !isSplit || (isLeft && focusedPane === 'left') || (isRight && focusedPane === 'right')
          )
          return (
            <div
              key={inst.id}
              className={`terminal-wrapper ${isVisible ? 'visible' : 'hidden'}${isGridPane && isFocused ? ' grid-focused' : ''}`}
              style={showGrid && isGridPane ? {
                gridRow: Math.floor(gridIdx / 2) + 1,
                gridColumn: (gridIdx % 2) + 1,
              } : isSplit && isVisible ? {
                flex: `0 0 calc(${isLeft ? splitRatio * 100 : (1 - splitRatio) * 100}% - 2px)`,
                order: isLeft ? 0 : 2,
              } : undefined}
              onClick={isGridPane ? () => handleGridPaneFocus(gridIdx) : undefined}
            >
              <TerminalView
                instance={inst}
                onKill={handleKill}
                onRestart={handleRestart}
                onRemove={handleRemove}
                onSplit={instanceCallbacksRef.current.get(inst.id)!.onSplit}
                onCloseSplit={showGrid ? () => handleCloseGridPane(gridIdx) : handleCloseSplitView}
                onSpawnChild={instanceCallbacksRef.current.get(inst.id)!.onSpawnChild}
                onFork={instanceCallbacksRef.current.get(inst.id)!.onFork}
                isSplit={isSplit || showGrid}
                arenaMode={(isSplit || showGrid) && arenaMode}
                arenaBlind={(isSplit || showGrid) && arenaMode && arenaBlind}
                paneLabel={showGrid ? (['1','2','3','4'][gridIdx] as any) : isLeft ? 'A' : 'B'}
                arenaVoted={arenaWinnerId !== null}
                arenaWinnerId={arenaWinnerId}
                onArenaWin={instanceCallbacksRef.current.get(inst.id)!.onArenaWin}
                terminalsRef={terminalsRef}
                searchOpen={isFocused && searchOpen}
                onSearchClose={handleSearchClose}
                fontSize={fontSize}
                focused={isFocused}
                onFocusPane={showGrid ? () => handleGridPaneFocus(gridIdx) : isLeft ? instanceCallbacksRef.current.get(inst.id)!.onFocusLeft : instanceCallbacksRef.current.get(inst.id)!.onFocusRight}
                outputBytes={outputBytes.get(inst.id) || 0}
                layoutMode={showGrid ? '4-up' : isSplit ? '2-up' : 'single'}
                onCycleLayout={handleCycleLayout}
                onEnterGrid={handleEnterGrid}
              />
            </div>
          )
        })}

        {/* Grid empty pane placeholders */}
        {showGrid && gridPanes.map((paneId, idx) => {
          if (paneId) return null
          return (
            <div
              key={`empty-${idx}`}
              className="grid-empty-pane"
              style={{
                gridRow: Math.floor(idx / 2) + 1,
                gridColumn: (idx % 2) + 1,
              }}
            >
              <div className="grid-empty-content">
                <p>No session</p>
                <div className="grid-empty-list">
                  {regularInstances.filter(i => !gridPanes.includes(i.id)).slice(0, 6).map(i => (
                    <button
                      key={i.id}
                      className="grid-empty-pick"
                      onClick={() => {
                        setGridPanes(prev => { const n = [...prev]; n[idx] = i.id; return n })
                        setFocusedGridIdx(idx)
                        setActiveId(i.id)
                      }}
                    >
                      <span className="grid-empty-dot" style={{ background: i.color }} />
                      {i.name}
                    </button>
                  ))}
                </div>
                <button className="grid-empty-close" onClick={() => handleCloseGridPane(idx)} title="Remove pane">
                  <XIcon size={12} /> Close pane
                </button>
              </div>
            </div>
          )
        })}

        {/* Grid arena controls — toggle bar spanning both columns */}
        {showGrid && (
          <div className="grid-arena-bar" style={{ gridColumn: '1 / -1' }}>
            <button
              className={`grid-arena-toggle${arenaMode ? ' active' : ''}`}
              onClick={() => {
                const next = !arenaMode
                setArenaMode(next)
                if (!next) { setArenaBlind(false); setArenaWinnerId(null) }
              }}
              title={arenaMode ? 'Disable Arena mode' : 'Enable Arena mode — shared input bar'}
              aria-label="Toggle Arena mode"
            >
              <Swords size={11} /> Arena
            </button>
            {arenaMode && (
              <button
                className={`grid-arena-toggle${arenaBlind ? ' active' : ''}`}
                onClick={() => setArenaBlind((b) => !b)}
                title={arenaBlind ? 'Reveal session identities' : 'Hide session identities until you vote'}
                aria-label="Toggle blind mode"
              >
                <EyeOff size={11} /> Blind
              </button>
            )}
            {arenaMode && (
              <button
                className={`grid-arena-toggle${arenaJudging ? ' active' : ''}`}
                onClick={() => setArenaJudgeOpen(true)}
                disabled={arenaJudging || arenaWinnerId !== null}
                title={arenaWinnerId ? 'Winner already selected' : 'Auto-Judge — run a command to pick a winner'}
                aria-label="Auto-Judge"
              >
                <Gavel size={11} /> {arenaJudging ? 'Judging...' : 'Judge'}
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button
              className="grid-arena-toggle"
              onClick={() => setArenaLaunchOpen(true)}
              title="Launch Arena — create worktrees and spawn parallel sessions"
              aria-label="Launch Arena"
            >
              <Rocket size={11} /> Launch
            </button>
            <button
              className="grid-arena-toggle"
              onClick={() => setArenaLeaderboardOpen(true)}
              title="Arena leaderboard — cumulative win/loss stats"
              aria-label="Leaderboard"
            >
              <Trophy size={11} /> Board
            </button>
          </div>
        )}

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
            {arenaMode && (
              <button
                className={`arena-toggle-btn${arenaJudging ? ' active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setArenaJudgeOpen(true) }}
                disabled={arenaJudging || arenaWinnerId !== null}
                title={arenaWinnerId ? 'Winner already selected' : 'Auto-Judge'}
                aria-label="Auto-Judge"
              >
                <Gavel size={9} />
              </button>
            )}
          </div>
        )}

        {/* Arena input bar — full-width row below panes when active */}
        {(isSplit || showGrid) && arenaMode && (() => {
          const arenaIds = showGrid
            ? gridPanes.filter((p): p is string => p !== null)
            : [activeId, splitId].filter((p): p is string => !!p)
          const sendToAll = () => {
            if (!arenaText.trim() || arenaIds.length < 2) return
            for (const id of arenaIds) window.api.instance.write(id, arenaText + '\n')
            setArenaText('')
            setArenaWinnerId(null)
            setArenaBlind(false)
            if (arenaTextareaRef.current) arenaTextareaRef.current.style.height = ''
          }
          return (
          <div className="arena-input-bar" style={{ order: 100, gridColumn: showGrid ? '1 / -1' : undefined }}>
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
                  sendToAll()
                }
              }}
              placeholder={`Send to ${arenaIds.length} sessions... (Enter to send, Shift+Enter for newline)`}
            />
            <button
              className="arena-send-btn"
              disabled={!arenaText.trim() || arenaIds.length < 2}
              onClick={sendToAll}
            >
              Send to {arenaIds.length}
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
          )
        })()}

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
        {view === 'review' && (
          <ReviewPanel
            instances={instances}
            onFocusInstance={(id) => {
              setActiveId(id)
              setView('instances')
            }}
          />
        )}
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
        {view === 'instances' && !active && regularInstances.length === 0 && (
          <SessionEmptyState
            onSelectCard={handleStarterCard}
            defaultWorkingDirectory={recentDirs[0] || ''}
          />
        )}
        {view === 'instances' && !active && regularInstances.length > 0 && (
          <ColonyOverviewPanel
            instances={instances}
            onFocusInstance={(id) => { setActiveId(id); setView('instances') }}
            onNewSession={() => setShowNewDialog(true)}
            onNavigate={(v) => setView(v as View)}
          />
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
          onClose={() => {
            setShowNewDialog(false)
            setNewDialogSeed(null)
            setCloneSource(null)
            agentToLaunchRef.current = null
          }}
          prefill={agentToLaunchRef.current || undefined}
          initialPrompt={newDialogSeed?.initialPrompt}
          initialWorkingDirectory={newDialogSeed?.workingDirectory}
          cloneSource={cloneSource || undefined}
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
        onNew={handleNewSession}
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
          onClick={() => { window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, cancelled: true }); setEnvPromptRequest(null) }}
          onKeyDown={e => {
            if (e.key === 'Escape') {
              window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, cancelled: true }); setEnvPromptRequest(null)
            }
          }}>
          <div style={{ background: 'var(--bg-primary)', border: '1px solid var(--border)', borderRadius: 10, padding: 24, width: 460, maxWidth: '90vw', boxShadow: '0 20px 60px rgba(0,0,0,0.5)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
                {envPromptRequest.promptType === 'file' ? 'Select File' : 'Select Option'}
              </h3>
              <button style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', padding: 4, display: 'flex', alignItems: 'center' }}
                title="Cancel"
                onClick={() => { window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, cancelled: true }); setEnvPromptRequest(null) }}>
                <XIcon size={14} />
              </button>
            </div>
            <p style={{ margin: '0 0 16px', fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{envPromptRequest.prompt}</p>

            {envPromptRequest.promptType === 'file' && (
              <>
                {envPromptRequest.defaultPath && (
                  <div style={{ background: 'var(--bg-secondary)', borderRadius: 6, padding: '8px 12px', margin: '0 0 20px', fontSize: 12, color: 'var(--text-muted)', wordBreak: 'break-all', fontFamily: 'monospace' }}>
                    {envPromptRequest.defaultPath}
                  </div>
                )}
                <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                  <button style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}
                    onClick={() => { window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, cancelled: true }); setEnvPromptRequest(null) }}>
                    Skip
                  </button>
                  <button style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}
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
                  {envPromptRequest.defaultPathValid && (
                    <button style={{ padding: '7px 16px', borderRadius: 6, border: 'none', background: 'var(--accent)', color: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 500 }}
                      autoFocus
                      onClick={() => {
                        window.api.env.respondToPrompt({ requestId: envPromptRequest.requestId, filePath: envPromptRequest.defaultPath })
                        setEnvPromptRequest(null)
                      }}>
                      Use this file
                    </button>
                  )}
                </div>
              </>
            )}

            {envPromptRequest.promptType === 'select' && envPromptRequest.options && (
              <>
                <div style={{ maxHeight: 300, overflowY: 'auto', margin: '0 0 16px', borderRadius: 6, border: '1px solid var(--border)' }}>
                  {envPromptRequest.options.map((option, i) => (
                    <button key={i}
                      style={{ display: 'block', width: '100%', padding: '10px 14px', background: 'transparent', border: 'none', borderBottom: i < envPromptRequest.options!.length - 1 ? '1px solid var(--border)' : 'none', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13, textAlign: 'left', fontFamily: 'monospace' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'var(--bg-secondary)')}
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
                  <button style={{ padding: '7px 16px', borderRadius: 6, border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-primary)', cursor: 'pointer', fontSize: 13 }}
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
      {arenaLaunchOpen && (
        <ArenaLaunchDialog
          onClose={() => setArenaLaunchOpen(false)}
          onLaunch={handleArenaLaunch}
        />
      )}
      {arenaJudgeOpen && (
        <ArenaJudgeDialog
          onClose={() => { setArenaJudgeOpen(false); setArenaJudging(false) }}
          onJudge={handleAutoJudge}
          judging={arenaJudging}
        />
      )}
      <ArenaLeaderboard
        open={arenaLeaderboardOpen}
        onClose={() => setArenaLeaderboardOpen(false)}
      />
    </div>
  )
}
