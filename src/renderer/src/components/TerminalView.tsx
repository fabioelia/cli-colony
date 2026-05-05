import { useEffect, useRef, useCallback, useState, useMemo, memo, MutableRefObject } from 'react'
import type { ContextUsage } from '../../../preload'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { TerminalProxy } from '../lib/terminal-proxy'
import { ChevronUp, ChevronDown, ChevronRight, X, RotateCcw, GitBranch, TerminalSquare, FolderTree, Columns2, LayoutGrid, GitFork, Server, Play, ScrollText, MessageSquare, AlertTriangle, Trophy, GitCompare, Navigation, ThumbsUp, Bot, BarChart3, Package, Globe, FileDown, CheckCircle, Copy, Search, PanelRight, GitMerge, Square, Ticket, Pencil, FileCode, ArrowRight, Network, StickyNote, Sparkles, RefreshCw, Loader2 } from 'lucide-react'
import { TeamMetricsPanel } from './TeamMetricsPanel'
import ServicesTab from './ServicesTab'
import FilesTab from './FilesTab'
import FileQuickOpen from './FileQuickOpen'
import ChangesTab from './ChangesTab'
import ArtifactsTab from './ArtifactsTab'
import LogsTab from './LogsTab'
import BrowserTab from './BrowserTab'
import TeamTab from './TeamTab'
import JiraTab from './JiraTab'
import DiffViewer from './DiffViewer'
import { extractTicketKey } from '../../../shared/ticket-commit-format'
import type { EnvStatus, ErrorSummary } from '../../../shared/types'
import '@xterm/xterm/css/xterm.css'
import type { ClaudeInstance } from '../types'
import Tooltip from './Tooltip'
import HelpPopover from './HelpPopover'
import RetryDialog from './RetryDialog'
import FanOutMonitor from './FanOutMonitor'
import { usePanelTabKeys } from '../hooks/usePanelTabKeys'

function compareChildren(a: ClaudeInstance, b: ClaudeInstance): number {
  const rank = (c: ClaudeInstance): number => {
    if (c.status !== 'running') return 3
    if (c.activity === 'busy') return 0
    if (c.activity === 'waiting') return 1
    return 2
  }
  const ra = rank(a), rb = rank(b)
  if (ra !== rb) return ra - rb
  // Both exited: sort by cost desc
  if (a.status !== 'running' && b.status !== 'running') {
    const ca = a.tokenUsage?.cost ?? 0
    const cb = b.tokenUsage?.cost ?? 0
    if (ca !== cb) return cb - ca
  }
  return (a.name ?? '').localeCompare(b.name ?? '')
}

function getXtermTheme(variant: 'session' | 'shell') {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light'
  if (variant === 'shell') {
    return isLight
      ? { background: '#f8f9fa', foreground: '#1a1a2e', cursor: '#1a1a2e' }
      : { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#e0e0e0' }
  }
  return isLight
    ? { background: '#ffffff', foreground: '#1a1a2e', cursor: 'transparent', selectionBackground: '#2563eb50' }
    : { background: '#000000', foreground: '#e0e0e0', cursor: 'transparent', selectionBackground: '#3b82f650' }
}

interface TerminalEntry {
  term: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
  proxy: TerminalProxy
  unsub?: () => void
}

interface Props {
  instance: ClaudeInstance
  onKill: (id: string) => void
  onRestart: (id: string) => void
  onRemove: (id: string) => void
  onSplit?: () => void
  onCloseSplit?: () => void
  onSpawnChild?: () => void
  onFork?: () => void
  onFanOut?: () => void
  isSplit?: boolean
  arenaMode?: boolean
  arenaBlind?: boolean
  paneLabel?: 'A' | 'B' | '1' | '2' | '3' | '4'
  arenaVoted?: boolean
  arenaWinnerId?: string | null
  onArenaWin?: () => void
  terminalsRef: MutableRefObject<Map<string, TerminalEntry>>
  searchOpen?: boolean
  onSearchClose?: () => void
  onSearchToggle?: () => void
  fontSize?: number
  fontFamily?: string
  cursorStyle?: 'block' | 'bar' | 'underline'
  cursorBlink?: boolean
  scrollback?: number
  focused?: boolean
  onFocusPane?: () => void
  outputBytes?: number
  layoutMode?: 'single' | '2-up' | '4-up'
  onCycleLayout?: () => void
  onEnterGrid?: () => void
  onNavigateToSession?: (id: string) => void
  errorSummary?: ErrorSummary
  childInstances?: ClaudeInstance[]
  allInstances?: ClaudeInstance[]
  recapBanner?: { text: string; exitSummary?: string }
  onDismissRecap?: () => void
}

const SEARCH_DECORATIONS = {
  matchBackground: '#ffb03b40',
  activeMatchBackground: '#ffb03b80',
  matchBorder: '#ffb03b60',
  activeMatchBorder: '#ffb03bcc',
  matchOverviewRuler: '',
  activeMatchColorOverviewRuler: '',
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

const fmtTokens = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

type ViewTab = 'session' | 'shell' | 'files' | 'services' | 'logs' | 'changes' | 'artifacts' | 'notes' | 'team' | 'metrics' | 'browser' | 'jira'

export default memo(function TerminalView({ instance, onKill, onRestart, onRemove, onSplit, onCloseSplit, onSpawnChild, onFork, onFanOut, isSplit, arenaMode, arenaBlind, paneLabel, arenaVoted, arenaWinnerId, onArenaWin, terminalsRef, searchOpen, onSearchClose, onSearchToggle, fontSize = 13, fontFamily = 'Menlo, Monaco, Consolas, "Courier New", monospace', cursorStyle = 'underline', cursorBlink = false, scrollback = 10000, focused = true, onFocusPane, outputBytes = 0, layoutMode = 'single', onCycleLayout, onEnterGrid, onNavigateToSession, errorSummary, childInstances = [], allInstances = [], recapBanner, onDismissRecap }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<{ resultIndex: number; resultCount: number } | null>(null)
  const [dragOver, setDragOver] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [viewTab, setViewTab] = useState<ViewTab>('session')
  const [notesContent, setNotesContent] = useState<string | null>(null)
  const [notesLoaded, setNotesLoaded] = useState(false)
  const notesSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [fileQuickOpen, setFileQuickOpen] = useState(false)
  const [jumpFilePath, setJumpFilePath] = useState<string | null>(null)
  const [deferredDismissed, setDeferredDismissed] = useState(false)
  // Reset dismissed state when a new deferred event arrives
  const deferredToolRef = useRef(instance.toolDeferredInfo?.toolName)
  if (instance.toolDeferredInfo?.toolName !== deferredToolRef.current) {
    deferredToolRef.current = instance.toolDeferredInfo?.toolName
    if (instance.toolDeferredInfo) setDeferredDismissed(false)
  }
  const shellContainerRef = useRef<HTMLDivElement>(null)
  const sessionTabRef = useRef<HTMLDivElement>(null)
  const shellTabRef = useRef<HTMLDivElement>(null)
  const shellTermRef = useRef<{ term: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon; unsub?: () => void } | null>(null)
  const shellCreatedRef = useRef(false)
  const onDismissRecapRef = useRef(onDismissRecap)
  onDismissRecapRef.current = onDismissRecap
  const [shellResetKey, setShellResetKey] = useState(0)
  const [childrenOpen, setChildrenOpen] = useState(true)
  const sortedChildren = useMemo(() => [...childInstances].sort(compareChildren), [childInstances])

  // Trigger chain: walk up the triggeredBy chain to build root→...→current breadcrumb
  const triggerChain = useMemo<{ id: string; name: string }[]>(() => {
    if (!instance.triggeredBy) return []
    const chain: { id: string; name: string }[] = []
    let currentTriggeredBy: string | undefined = instance.triggeredBy
    let depth = 0
    const seen = new Set<string>()
    while (currentTriggeredBy && depth < 10) {
      if (seen.has(currentTriggeredBy)) break
      seen.add(currentTriggeredBy)
      const parent = allInstances
        .filter(i => i.name === currentTriggeredBy && i.id !== instance.id)
        .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0]
      chain.unshift({ id: parent?.id ?? '', name: currentTriggeredBy })
      if (!parent) break
      currentTriggeredBy = parent.triggeredBy
      depth++
    }
    return chain
  }, [instance.triggeredBy, instance.id, allInstances])

  // Environment detection: match by colony path OR by environment paths.root
  const envName = (() => {
    const marker = '/.claude-colony/environments/'
    const idx = instance.workingDirectory.indexOf(marker)
    if (idx >= 0) {
      const rest = instance.workingDirectory.slice(idx + marker.length)
      return rest.split('/')[0] || null
    }
    return null
  })()
  const [envStatus, setEnvStatusRaw] = useState<EnvStatus | null>(null)
  // Stabilize envStatus — only update state when meaningful fields change
  const setEnvStatus = useCallback((next: EnvStatus | null) => {
    setEnvStatusRaw(prev => {
      if (prev === null && next === null) return prev
      if (prev === null || next === null) return next
      if (prev.id !== next.id) return next
      // Compare fields that actually affect rendering
      if (prev.status !== next.status) return next
      if (prev.services.length !== next.services.length) return next
      if (JSON.stringify(prev.urls) !== JSON.stringify(next.urls)) return next
      if (JSON.stringify(prev.ports) !== JSON.stringify(next.ports)) return next
      for (let i = 0; i < prev.services.length; i++) {
        const a = prev.services[i], b = next.services[i]
        if (a.name !== b.name || a.status !== b.status || a.port !== b.port || a.uptime !== b.uptime || a.restarts !== b.restarts) return next
      }
      return prev
    })
  }, [])
  // Track whether we matched by paths.root (for non-colony-dir sessions)
  const [pathMatchedEnv, setPathMatchedEnv] = useState<string | null>(null)
  const effectiveEnvName = envName || pathMatchedEnv
  // Tab badge counts (pushed from child components)
  const [teamWorkerCount, setTeamWorkerCount] = useState(0)
  const [changeCount, setChangeCount] = useState(0)
  const [artifactCount, setArtifactCount] = useState(0)
  const [exportSuccess, setExportSuccess] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)

  const [showRetryDialog, setShowRetryDialog] = useState(false)

  // Browser — lazy mount, keep alive once opened to avoid webview reloads
  const [browserMounted, setBrowserMounted] = useState(false)
  if (!browserMounted && viewTab === 'browser') setBrowserMounted(true)

  // Lazy-load notes content when tab is first opened
  if (viewTab === 'notes' && !notesLoaded) {
    setNotesLoaded(true)
    window.api.notes.get(instance.id).then(content => setNotesContent(content))
  }

  // Tab split view — any tab can have a secondary pane, persists across tab switches
  const [splitTab, setSplitTabRaw] = useState<ViewTab | null>(null)
  const setSplitTab = useCallback((v: ViewTab | null | ((prev: ViewTab | null) => ViewTab | null)) => setSplitTabRaw(v), [])
  const [splitRatio, setSplitRatio] = useState(() => {
    const saved = localStorage.getItem('colony:splitRatio')
    return saved ? parseFloat(saved) : 0.5
  })
  const [splitDragging, setSplitDragging] = useState(false)

  // Session steering
  const [steerOpen, setSteerOpen] = useState(false)
  const [steerText, setSteerText] = useState('')

  // Shell quick commands
  const [shellQuickOpen, setShellQuickOpen] = useState(() => localStorage.getItem('shell-quick-open') !== 'false')
  const defaultQuickCmds = ['git status', 'git log --oneline -5', 'ls -la', 'npm test']
  const quickCmdsKey = `shell-quick-cmds:${instance.workingDirectory || 'default'}`
  const [quickCmds, setQuickCmds] = useState<string[]>(() => {
    const stored = localStorage.getItem(quickCmdsKey)
    return stored ? JSON.parse(stored) : defaultQuickCmds
  })
  const [editingQuickCmds, setEditingQuickCmds] = useState(false)
  const [newCmdText, setNewCmdText] = useState('')
  const [shellTermReady, setShellTermReady] = useState(false)
  // Context usage tracking
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)

  // Changed files panel state
  const [changedFiles, setChangedFiles] = useState<Array<{ file: string; status: string; staged: boolean }>>([])
  const [changedFilesOpen, setChangedFilesOpen] = useState(() => {
    try { return localStorage.getItem(`session-files-${instance.id}`) === 'open' } catch { return false }
  })
  const [changedFilesDiff, setChangedFilesDiff] = useState<string | null>(null)
  const [changedFilesDiffFile, setChangedFilesDiffFile] = useState<string | null>(null)
  const [aiRecap, setAiRecap] = useState<{ recap: string; generatedAt: string } | null>(null)
  const [aiRecapLoading, setAiRecapLoading] = useState(false)
  const [aiRecapOpen, setAiRecapOpen] = useState(false)

  useEffect(() => {
    localStorage.setItem(quickCmdsKey, JSON.stringify(quickCmds))
  }, [quickCmds, quickCmdsKey])

  useEffect(() => {
    const findMatch = (envs: EnvStatus[]) => {
      // First try exact name/id match (colony-dir sessions)
      if (envName) {
        return envs.find((e) => e.name === envName || e.id === envName) || null
      }
      // Fall back to matching by environment paths — session workingDirectory
      // starts with (or equals) one of the environment's registered paths
      const wd = instance.workingDirectory
      return envs.find((e) =>
        e.paths && Object.values(e.paths).some((p) => typeof p === 'string' && wd.startsWith(p))
      ) || null
    }

    // Initial fetch
    window.api.env.list().then((envs) => {
      const match = findMatch(envs)
      if (match) {
        setEnvStatus(match)
        if (!envName) setPathMatchedEnv(match.name)
      }
    })
    // Subscribe to updates
    const unsub = window.api.env.onStatusUpdate((envs) => {
      const match = findMatch(envs)
      setEnvStatus(match || null)
      if (!envName) setPathMatchedEnv(match?.name || null)
    })
    return unsub
  }, [envName, instance.workingDirectory])

  // Shell terminal — lazy init when tab is first opened, re-init on shellResetKey
  useEffect(() => {
    if (viewTab !== 'shell') return
    if (shellCreatedRef.current && shellTermRef.current) {
      // Already created, just fit
      setTimeout(() => shellTermRef.current?.fitAddon.fit(), 50)
      return
    }
    if (!shellContainerRef.current) return
    shellCreatedRef.current = true

    const term = new Terminal({
      fontSize,
      fontFamily,
      scrollback,
      cursorBlink: true,
      cursorStyle,
      theme: getXtermTheme('shell'),
      allowProposedApi: true,
    })
    const fitAddon = new FitAddon()
    const shellSearchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(shellSearchAddon)
    shellSearchAddon.onDidChangeResults((e) => {
      setSearchResults(e.resultCount > 0 ? e : null)
    })
    term.loadAddon(new WebLinksAddon())
    term.open(shellContainerRef.current)
    fitAddon.fit()

    // Spawn the shell PTY
    window.api.shellPty.create(instance.id, instance.workingDirectory)

    // Stream output
    const unsubOutput = window.api.shellPty.onOutput(({ instanceId, data }) => {
      if (instanceId === instance.id) term.write(data)
    })

    // Forward input
    term.onData((data) => window.api.shellPty.write(instance.id, data))

    // Forward resize
    term.onResize(({ cols, rows }) => window.api.shellPty.resize(instance.id, cols, rows))

    // On exit, show message
    const unsubExit = window.api.shellPty.onExited(({ instanceId }) => {
      if (instanceId === instance.id) term.write('\r\n\x1b[90m[shell exited]\x1b[0m\r\n')
    })

    // ResizeObserver for shell container
    const observer = new ResizeObserver(() => {
      try { fitAddon.fit() } catch { /* */ }
    })
    observer.observe(shellContainerRef.current)

    shellTermRef.current = {
      term, fitAddon, searchAddon: shellSearchAddon,
      unsub: () => { unsubOutput(); unsubExit(); observer.disconnect() },
    }
    setShellTermReady(true)

    setTimeout(() => fitAddon.fit(), 100)
  }, [viewTab, shellResetKey])

  // Clean up shell on unmount
  useEffect(() => {
    return () => {
      if (shellTermRef.current) {
        shellTermRef.current.unsub?.()
        shellTermRef.current.term.dispose()
        shellTermRef.current = null
        setShellTermReady(false)
      }
      if (shellCreatedRef.current) {
        window.api.shellPty.kill(instance.id)
        shellCreatedRef.current = false
      }
    }
  }, [instance.id])

  // Update terminal themes when data-theme changes
  useEffect(() => {
    const observer = new MutationObserver(() => {
      const entry = terminalsRef.current.get(instance.id)
      if (entry) entry.term.options.theme = getXtermTheme('session')
      if (shellTermRef.current) shellTermRef.current.term.options.theme = getXtermTheme('shell')
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => observer.disconnect()
  }, [instance.id])

  // Resize shell terminal on window resize
  useEffect(() => {
    if (viewTab !== 'shell' || !shellTermRef.current) return
    const handleResize = () => shellTermRef.current?.fitAddon.fit()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [viewTab])


  // Track context usage periodically (every 5 seconds)
  useEffect(() => {
    if (instance.status !== 'running') return

    const fetchContextUsage = async () => {
      const usage = await window.api.session.getContextUsage(instance.id)
      setContextUsage(usage)
    }

    // Fetch immediately
    fetchContextUsage()

    // Then fetch every 5 seconds
    const interval = setInterval(fetchContextUsage, 5000)
    return () => clearInterval(interval)
  }, [instance.id, instance.status])

  // Poll changed files while running; do one final fetch on exit to capture last state
  useEffect(() => {
    if (!instance.workingDirectory) return
    if (instance.status === 'exited') {
      window.api.git.changedFiles(instance.workingDirectory).then(setChangedFiles).catch(() => {})
      return
    }
    if (instance.status !== 'running') return
    const poll = async () => {
      try {
        const files = await window.api.git.changedFiles(instance.workingDirectory!)
        setChangedFiles(files)
      } catch { /* ignore */ }
    }
    poll()
    const id = setInterval(poll, 30000)
    return () => clearInterval(id)
  }, [instance.id, instance.status, instance.workingDirectory])

  // Focus and refit terminal when this pane becomes focused/visible
  useEffect(() => {
    if (focused && viewTab === 'session') {
      const entry = terminalsRef.current.get(instance.id)
      if (entry) {
        // Double-RAF: first frame for DOM layout, second for final paint
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            entry.fitAddon.fit()
            const dims = entry.fitAddon.proposeDimensions()
            if (dims && dims.cols > 0 && dims.rows > 0) {
              // Resize bounce: shrink by 1 row then restore — sends SIGWINCH
              // to force Claude CLI to fully redraw its TUI.
              // Uses rows (not cols) to avoid width-sensitive rendering artifacts
              // where a cols-1 repaint leaves residual chars at the last column.
              window.api.instance.resize(instance.id, dims.cols, dims.rows - 1)
              setTimeout(() => {
                window.api.instance.resize(instance.id, dims.cols, dims.rows)
                entry.term.scrollToBottom()
              }, 50)
            }
            entry.term.refresh(0, entry.term.rows - 1)
            if (!searchOpen) entry.term.focus()
          })
        })
      }
    }
  }, [focused, viewTab, searchOpen, instance.id, terminalsRef])

  // Focus search input when search opens
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus()
      searchInputRef.current.select()
    }
  }, [searchOpen])

  const scrollToBottom = useCallback(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (entry) {
      entry.proxy.onUserInput()
      entry.term.scrollToBottom()
    }
  }, [instance.id, terminalsRef])

  const scrollToTop = useCallback(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (entry) entry.term.scrollToTop()
  }, [instance.id, terminalsRef])

  const getActiveSearchAddon = useCallback((): SearchAddon | undefined => {
    if (viewTab === 'shell') return shellTermRef.current?.searchAddon
    return terminalsRef.current.get(instance.id)?.searchAddon
  }, [viewTab, instance.id, terminalsRef])

  const handleSearchNext = useCallback(() => {
    const addon = getActiveSearchAddon()
    if (addon && searchQuery) addon.findNext(searchQuery, { decorations: SEARCH_DECORATIONS })
  }, [getActiveSearchAddon, searchQuery])

  const handleSearchPrev = useCallback(() => {
    const addon = getActiveSearchAddon()
    if (addon && searchQuery) addon.findPrevious(searchQuery, { decorations: SEARCH_DECORATIONS })
  }, [getActiveSearchAddon, searchQuery])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) handleSearchPrev()
      else handleSearchNext()
    }
    if (e.key === 'Escape') {
      getActiveSearchAddon()?.clearDecorations()
      setSearchQuery('')
      setSearchResults(null)
      onSearchClose?.()
    }
  }, [handleSearchNext, handleSearchPrev, getActiveSearchAddon, onSearchClose])

  // Auto-dismiss recap banner after 8s
  useEffect(() => {
    if (!recapBanner) return
    const t = setTimeout(() => onDismissRecapRef.current?.(), 8000)
    return () => clearTimeout(t)
  }, [recapBanner])

  // Live search as you type
  useEffect(() => {
    const addon = getActiveSearchAddon()
    if (!addon) return
    if (searchQuery) {
      addon.findNext(searchQuery, { decorations: SEARCH_DECORATIONS })
    } else {
      addon.clearDecorations()
      setSearchResults(null)
    }
  }, [searchQuery, getActiveSearchAddon])

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return
    initializedRef.current = true

    let existing = terminalsRef.current.get(instance.id)

    if (!existing) {
      const term = new Terminal({
        theme: getXtermTheme('session'),
        fontFamily,
        fontSize,
        lineHeight: 1.2,
        cursorBlink,
        cursorStyle,
        cursorWidth: 1,
        cursorInactiveStyle: 'none',
        scrollback,
        allowProposedApi: true,
        altClickMovesCursor: false,
      })

      const fitAddon = new FitAddon()
      const searchAddon = new SearchAddon()
      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        window.api.shell.openExternal(uri)
      })
      term.loadAddon(fitAddon)
      term.loadAddon(searchAddon)
      searchAddon.onDidChangeResults((e) => {
        setSearchResults(e.resultCount > 0 ? e : null)
      })
      term.loadAddon(webLinksAddon)

      const proxy = new TerminalProxy(term)

      term.onData((data) => {
        proxy.onUserInput()
        onDismissRecapRef.current?.()
        window.api.instance.write(instance.id, data)
      })

      // Queue live events until the buffer replay finishes, then drain.
      // Without this, any output that arrives between subscribing and the
      // buffer resolving would be written twice (once live, once in the buffer).
      let queue: string[] | null = []
      const unsub = window.api.instance.onOutput(({ id, data }) => {
        if (id === instance.id) {
          if (queue) {
            queue.push(data)
          } else {
            proxy.write(data)
          }
        }
      })

      existing = { term, fitAddon, searchAddon, proxy, unsub }
      terminalsRef.current.set(instance.id, existing)

      window.api.instance.buffer(instance.id).then((buf) => {
        if (buf) proxy.write(buf)
        const pending = queue!
        queue = null
        for (const chunk of pending) proxy.write(chunk)
      })
    }

    existing.term.open(containerRef.current)

    requestAnimationFrame(() => {
      existing!.fitAddon.fit()
      const dims = existing!.fitAddon.proposeDimensions()
      if (dims) {
        window.api.instance.resize(instance.id, dims.cols, dims.rows)
      }
    })

    const instanceId = instance.id
    const fitAddon = existing.fitAddon
    let lastCols = 0
    let lastRows = 0

    const doFit = () => {
      const container = containerRef.current
      if (!container) return
      const wrapper = container.closest('.terminal-wrapper')
      if (wrapper && !wrapper.classList.contains('visible')) return
      if (container.offsetHeight === 0 || container.offsetWidth === 0) return

      try {
        fitAddon.fit()
        const dims = fitAddon.proposeDimensions()
        if (dims && (dims.cols !== lastCols || dims.rows !== lastRows)) {
          lastCols = dims.cols
          lastRows = dims.rows
          window.api.instance.resize(instanceId, dims.cols, dims.rows)
          existing!.term.scrollToBottom()
        }
      } catch { /* */ }
    }

    const observer = new ResizeObserver(doFit)
    observer.observe(containerRef.current)

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const onWindowResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doFit, 50)
    }
    window.addEventListener('resize', onWindowResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      if (resizeTimer) clearTimeout(resizeTimer)
    }
  }, [instance.id])

  // Update font size when prop changes
  useEffect(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (!entry) return
    if (entry.term.options.fontSize !== fontSize) {
      entry.term.options.fontSize = fontSize
      entry.fitAddon.fit()
      const dims = entry.fitAddon.proposeDimensions()
      if (dims && dims.cols > 0 && dims.rows > 0) {
        window.api.instance.resize(instance.id, dims.cols, dims.rows)
      }
    }
  }, [fontSize, instance.id, terminalsRef])

  // Update font family when prop changes
  useEffect(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (!entry) return
    if (entry.term.options.fontFamily !== fontFamily) {
      entry.term.options.fontFamily = fontFamily
      entry.fitAddon.fit()
    }
  }, [fontFamily, instance.id, terminalsRef])

  // Update cursor style/blink when props change
  useEffect(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (!entry) return
    entry.term.options.cursorStyle = cursorStyle
    entry.term.options.cursorBlink = cursorBlink
  }, [cursorStyle, cursorBlink, instance.id, terminalsRef])

  // Note: scrollback can only be set at construction time in xterm.js —
  // new value takes effect on next session start.

  // Drag & drop — paste file path into terminal
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent, tab: 'session' | 'shell' = 'session') => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer.files
    if (files.length > 0) {
      const paths = Array.from(files).map((f) => {
        const p = window.api.getPathForFile(f)
        if (!p) return null
        return p.includes(' ') ? `"${p}"` : p
      }).filter(Boolean)
      if (paths.length > 0) {
        const text = paths.join(' ') + ' '
        if (tab === 'shell') {
          window.api.shellPty.write(instance.id, text)
        } else {
          for (const ch of text) {
            window.api.instance.write(instance.id, ch)
          }
        }
      }
    }
  }, [instance.id])

  // Browser split divider drag handler
  const handleSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startRatio = splitRatio
    // For session/shell tabs the divider lives inside an absolute overlay whose width is
    // (1 - splitRatio) * containerWidth — using parentElement.width gives wrong drag math.
    // Use the full-width outer tab ref instead.
    let containerWidth: number
    if (viewTab === 'session' && sessionTabRef.current) {
      containerWidth = sessionTabRef.current.getBoundingClientRect().width
    } else if (viewTab === 'shell' && shellTabRef.current) {
      containerWidth = shellTabRef.current.getBoundingClientRect().width
    } else {
      // browser: divider's parent IS the full-width flex row — original logic correct
      containerWidth = (e.target as HTMLElement).parentElement!.getBoundingClientRect().width
    }
    setSplitDragging(true)
    const onMove = (ev: MouseEvent) => {
      const delta = (ev.clientX - startX) / containerWidth
      const newRatio = Math.max(0.3, Math.min(0.7, startRatio + delta))
      setSplitRatio(newRatio)
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.body.style.cursor = ''
      setSplitDragging(false)
      setSplitRatio(r => { localStorage.setItem('colony:splitRatio', String(r)); return r })
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [splitRatio, viewTab])

  const handleChangedFileDiff = useCallback(async (file: string) => {
    if (!instance.workingDirectory) return
    if (changedFilesDiffFile === file) { setChangedFilesDiffFile(null); setChangedFilesDiff(null); return }
    setChangedFilesDiffFile(file)
    setChangedFilesDiff(null)
    try {
      const diff = await window.api.git.fileDiff(instance.workingDirectory, file)
      setChangedFilesDiff(diff)
    } catch { setChangedFilesDiff('') }
  }, [instance.workingDirectory, changedFilesDiffFile])

  // Paste images — Cmd+Shift+V checks clipboard for image via Electron main process
  useEffect(() => {
    const handler = async (e: KeyboardEvent) => {
      if (viewTab !== 'session' || !focused) return
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'v') {
        e.preventDefault()
        const filePath = await window.api.fs.pasteClipboardImage()
        if (filePath) {
          const text = filePath.includes(' ') ? `"${filePath}"` : filePath
          window.api.instance.write(instance.id, text + ' ')
        }
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [instance.id, viewTab, focused])

  // Cmd+P — open floating file quick-open overlay
  useEffect(() => {
    if (!focused) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'p' && !e.shiftKey && !e.altKey) {
        e.preventDefault()
        e.stopPropagation()
        setFileQuickOpen(true)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [focused])

  // Session tab keyboard navigation — Cmd+Shift+{ (prev) / Cmd+Shift+} (next)
  const hasEnvUrls = effectiveEnvName && envStatus && Object.keys(envStatus.urls).length > 0
  const hasJiraTicket = useMemo(() =>
    !!instance.ticket || !!extractTicketKey(instance.gitBranch || '', '[A-Z]+-\\d+'),
  [instance.ticket, instance.gitBranch])

  const visibleViewTabs = useMemo<ViewTab[]>(() => [
    'session', 'shell', 'files',
    ...(effectiveEnvName ? (['services', 'logs'] as ViewTab[]) : []),
    ...(hasEnvUrls ? (['browser'] as ViewTab[]) : []),
    ...(instance.workingDirectory ? (['changes'] as ViewTab[]) : []),
    'artifacts',
    'notes',
    ...(hasJiraTicket ? (['jira'] as ViewTab[]) : []),
    ...(instance.roleTag === 'Coordinator' ? (['team', 'metrics'] as ViewTab[]) : []),
  ], [effectiveEnvName, instance.workingDirectory, instance.roleTag, hasEnvUrls, hasJiraTicket])
  usePanelTabKeys(visibleViewTabs, viewTab, setViewTab, focused)

  const tabHintMap = useMemo(() => {
    const map: Record<string, string> = {}
    visibleViewTabs.forEach((tab, i) => {
      if (i < 9) map[tab] = `⌥${i + 1}`
    })
    return map
  }, [visibleViewTabs])

  // All visible tabs available in split secondary (including current — user may want same tab in both)
  const splitTabs = useMemo<ViewTab[]>(() => visibleViewTabs, [visibleViewTabs])

  // Same tab in both primary and secondary is allowed — no collision handling

  const renderTabContent = (tab: ViewTab): React.ReactNode => {
    switch (tab) {
      case 'session': return (
        <div className="split-terminal-note"><MessageSquare size={14} /><span>Switch to Session tab to view the terminal</span></div>
      )
      case 'shell': return (
        <div className="split-terminal-note"><TerminalSquare size={14} /><span>Switch to Terminal tab to use the shell</span></div>
      )
      case 'files': return <FilesTab instance={instance} focused={focused} onSwitchToSession={() => setViewTab('session')} jumpFilePath={jumpFilePath} onJumpConsumed={() => setJumpFilePath(null)} />
      case 'services': return envStatus ? <ServicesTab envStatus={envStatus} instance={instance} /> : null
      case 'logs': return envStatus ? <LogsTab envStatus={envStatus} /> : null
      case 'browser': return envStatus ? <BrowserTab envStatus={envStatus} instanceId={instance.id} /> : null
      case 'changes': return <ChangesTab instance={instance} onChangeCount={setChangeCount} />
      case 'artifacts': return <ArtifactsTab instanceId={instance.id} instanceStatus={instance.status} onArtifactCount={setArtifactCount} />
      case 'notes': return (
        <div className="notes-editor-container">
          <textarea
            className="notes-editor"
            placeholder="Add notes about this session — intent, follow-ups, lessons learned..."
            value={notesContent ?? ''}
            onChange={(e) => {
              const val = e.target.value
              setNotesContent(val)
              if (notesSaveTimerRef.current) clearTimeout(notesSaveTimerRef.current)
              notesSaveTimerRef.current = setTimeout(() => {
                window.api.notes.save(instance.id, val)
              }, 2000)
            }}
            onBlur={() => {
              if (notesSaveTimerRef.current) { clearTimeout(notesSaveTimerRef.current); notesSaveTimerRef.current = null }
              if (notesContent !== null) window.api.notes.save(instance.id, notesContent)
            }}
          />
        </div>
      )
      case 'jira': return <JiraTab ticket={instance.ticket} gitBranch={instance.gitBranch} />
      case 'team': return instance.roleTag === 'Coordinator' ? <TeamTab instanceId={instance.id} onWorkerCountChange={setTeamWorkerCount} onNavigateToWorker={onNavigateToSession} /> : null
      case 'metrics': return instance.roleTag === 'Coordinator' ? <div className="changes-panel"><TeamMetricsPanel coordinatorSessionId={instance.id} /></div> : null
      default: return null
    }
  }

  const renderSecondaryPane = () => (
    <>
      <div
        className="browser-split-divider"
        onMouseDown={handleSplitDrag}
        onDoubleClick={() => { setSplitRatio(0.5); localStorage.setItem('colony:splitRatio', '0.5') }}
      >
        <div className="browser-split-divider-grip" />
      </div>
      <div className="browser-split-pane browser-split-secondary" style={{ flex: 1 }}>
        <div className="browser-split-secondary-header">
          <select value={splitTab!} onChange={(e) => {
            const tab = e.target.value as ViewTab
            setSplitTab(tab)
            localStorage.setItem(`colony:splitTab:${instance.id}`, tab)
          }}>
            {splitTabs.map(t => (
              <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
            ))}
          </select>
          <button onClick={() => setSplitTab(null)} title="Close split"><X size={12} /></button>
        </div>
        {renderTabContent(splitTab!)}
      </div>
      {splitDragging && <div className="browser-split-drag-overlay" />}
    </>
  )

  return (
    <>
      <div className={`terminal-header ${focused ? 'focused' : 'unfocused'}`} onClick={onFocusPane}>
        <div className="terminal-header-accent" style={{ backgroundColor: focused ? instance.color : 'transparent' }} />
        <div className="terminal-header-left">
          <span className="terminal-header-name" style={{ color: instance.color }}>
            {arenaBlind ? `Pane ${paneLabel ?? 'A'}` : instance.name}
          </span>
          <div className="terminal-header-tabs">
            <button
              className={`terminal-tab ${viewTab === 'session' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('session') }}
              title="Claude session"
            >
              <MessageSquare size={12} /> Session
              {tabHintMap['session'] && <span className="shortcut-hint">{tabHintMap['session']}</span>}
            </button>
            <button
              className={`terminal-tab ${viewTab === 'shell' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('shell') }}
              title="Shell terminal"
            >
              <TerminalSquare size={12} /> Terminal
              {tabHintMap['shell'] && <span className="shortcut-hint">{tabHintMap['shell']}</span>}
            </button>
            <button
              className={`terminal-tab ${viewTab === 'files' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('files') }}
              title="View files"
            >
              <FolderTree size={12} /> Files
              {tabHintMap['files'] && <span className="shortcut-hint">{tabHintMap['files']}</span>}
            </button>
            {effectiveEnvName && (
              <button
                className={`terminal-tab ${viewTab === 'services' ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setViewTab('services') }}
                title="Environment services"
              >
                <Server size={12} /> Services
                {envStatus && (() => {
                  const crashed = envStatus.services.filter(s => s.status === 'crashed').length
                  const running = envStatus.services.filter(s => s.status === 'running').length
                  if (crashed > 0 && running > 0) return <><span className="services-tab-badge danger">{crashed}</span><span className="services-tab-badge success">{running}</span></>
                  if (crashed > 0) return <span className="services-tab-badge danger">{crashed}</span>
                  if (running > 0) return <span className="services-tab-badge success">{running}</span>
                  return null
                })()}
                {tabHintMap['services'] && <span className="shortcut-hint">{tabHintMap['services']}</span>}
              </button>
            )}
            {effectiveEnvName && (
              <button
                className={`terminal-tab ${viewTab === 'logs' ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setViewTab('logs') }}
                title="Service logs"
              >
                <ScrollText size={12} /> Logs
                {tabHintMap['logs'] && <span className="shortcut-hint">{tabHintMap['logs']}</span>}
              </button>
            )}
            {hasEnvUrls && (
              <button
                className={`terminal-tab ${viewTab === 'browser' ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setViewTab('browser') }}
                title="Embedded browser"
              >
                <Globe size={12} /> Browser
                <span className="services-tab-badge" style={{ background: 'var(--accent)' }}>{Object.keys(envStatus!.urls).length}</span>
                {tabHintMap['browser'] && <span className="shortcut-hint">{tabHintMap['browser']}</span>}
              </button>
            )}
            {instance.workingDirectory && (
              <button
                className={`terminal-tab ${viewTab === 'changes' ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setViewTab('changes') }}
                title="Git changes"
              >
                <GitCompare size={12} /> Changes
                {viewTab !== 'changes' && changeCount > 0 && (
                  <span className="services-tab-badge" style={{ background: 'var(--warning)' }}>{changeCount}</span>
                )}
                {tabHintMap['changes'] && <span className="shortcut-hint">{tabHintMap['changes']}</span>}
              </button>
            )}
            <button
              className={`terminal-tab ${viewTab === 'artifacts' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('artifacts') }}
              title="Session artifacts"
            >
              <Package size={12} /> Artifacts
              {viewTab !== 'artifacts' && artifactCount > 0 && (
                <span className="services-tab-badge" style={{ background: 'var(--accent)' }}>{artifactCount}</span>
              )}
              {tabHintMap['artifacts'] && <span className="shortcut-hint">{tabHintMap['artifacts']}</span>}
            </button>
            <button
              className={`terminal-tab ${viewTab === 'notes' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('notes') }}
              title="Session notes"
            >
              <StickyNote size={12} /> Notes
              {tabHintMap['notes'] && <span className="shortcut-hint">{tabHintMap['notes']}</span>}
            </button>
            {hasJiraTicket && (
              <button
                className={`terminal-tab ${viewTab === 'jira' ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setViewTab('jira') }}
                title="Jira ticket"
              >
                <Ticket size={12} /> Jira
                {tabHintMap['jira'] && <span className="shortcut-hint">{tabHintMap['jira']}</span>}
              </button>
            )}
            {instance.roleTag === 'Coordinator' && (
              <button
                className={`terminal-tab ${viewTab === 'team' ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setViewTab('team') }}
                title="Coordinator team"
              >
                <Bot size={12} /> Team
                {viewTab !== 'team' && teamWorkerCount > 0 ? (
                  <span className="services-tab-badge" style={{ background: 'var(--warning)' }}>{teamWorkerCount}</span>
                ) : null}
                {tabHintMap['team'] && <span className="shortcut-hint">{tabHintMap['team']}</span>}
              </button>
            )}
            {instance.roleTag === 'Coordinator' && (
              <button
                className={`terminal-tab ${viewTab === 'metrics' ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setViewTab('metrics') }}
                title="Team metrics"
              >
                <BarChart3 size={12} /> Metrics
                {tabHintMap['metrics'] && <span className="shortcut-hint">{tabHintMap['metrics']}</span>}
              </button>
            )}
          </div>
          {viewTab === 'session' && <HelpPopover topic="sessionTab" />}
          {viewTab === 'files' && <HelpPopover topic="filesTab" />}
          {viewTab === 'shell' && <HelpPopover topic="terminalTab" />}
          {viewTab === 'services' && <HelpPopover topic="servicesTab" />}
          {viewTab === 'logs' && <HelpPopover topic="logsTab" />}
          {viewTab === 'changes' && <HelpPopover topic="changesTab" />}
          {viewTab === 'artifacts' && <HelpPopover topic="artifactsTab" />}
          {viewTab === 'notes' && <HelpPopover topic="sessionTab" zone="Notes Tab" />}
          {viewTab === 'jira' && <HelpPopover topic="sessionTab" zone="Jira Tab" />}
          {viewTab === 'team' && <HelpPopover topic="teamTab" />}
          {viewTab === 'browser' && <HelpPopover topic="browserTab" />}
          {(instance.gitRepo || instance.gitBranch) && (
            <div className="terminal-header-repo-info">
              {instance.gitRepo && (
                <span className="terminal-header-repo-badge">{instance.gitRepo}</span>
              )}
              {instance.gitBranch && (
                <span className="terminal-header-branch-badge"><GitBranch size={11} /> {instance.gitBranch}</span>
              )}
            </div>
          )}
        </div>
        <div className="terminal-header-spacer" />
        <div className="terminal-header-actions">
          {!splitTab && (
            <Tooltip text="Split View" detail="Show another tab alongside this one" shortcut="Cmd+Shift+\">
              <button onClick={() => {
                const saved = localStorage.getItem(`colony:splitTab:${instance.id}`)
                const defaultTab = splitTabs[0] || 'files'
                setSplitTab((saved && saved !== viewTab ? saved : defaultTab) as ViewTab)
              }} aria-label="Split view">
                <PanelRight size={14} />
                <span className="shortcut-hint">⌘⇧\</span>
              </button>
            </Tooltip>
          )}
          {splitTab && (
            <Tooltip text="Close Split" detail="Close the secondary pane">
              <button onClick={() => setSplitTab(null)} aria-label="Close split">
                <X size={14} />
              </button>
            </Tooltip>
          )}
          {viewTab === 'session' && (
            <Tooltip text="Export Session" detail="Save this session's output as a markdown file" position="bottom">
              <button
                onClick={async () => {
                  const ok = await window.api.session.exportMarkdownToFile(instance.id)
                  if (ok) {
                    setExportSuccess(true)
                    setTimeout(() => setExportSuccess(false), 2000)
                  }
                }}
                aria-label="Export session as markdown"
              >
                {exportSuccess ? <CheckCircle size={14} /> : <FileDown size={14} />}
              </button>
            </Tooltip>
          )}
          {viewTab === 'session' && (
            <Tooltip text="Copy Output" detail="Copy session output as markdown to clipboard" position="bottom">
              <button
                onClick={async () => {
                  const md = await window.api.session.exportMarkdown(instance.id)
                  if (md) {
                    await navigator.clipboard.writeText(md)
                    setCopySuccess(true)
                    setTimeout(() => setCopySuccess(false), 2000)
                  }
                }}
                aria-label="Copy session output to clipboard"
              >
                {copySuccess ? <CheckCircle size={14} /> : <Copy size={14} />}
              </button>
            </Tooltip>
          )}
          {viewTab === 'session' && (
            <Tooltip text="AI Recap" detail="Generate an AI summary of what this session accomplished" position="bottom">
              <button
                className={aiRecapOpen ? 'active' : ''}
                disabled={aiRecapLoading}
                onClick={async () => {
                  if (aiRecapOpen && aiRecap) { setAiRecapOpen(false); return }
                  setAiRecapOpen(true)
                  if (!aiRecap) {
                    setAiRecapLoading(true)
                    const result = await window.api.ai.sessionRecap(instance.id)
                    setAiRecapLoading(false)
                    setAiRecap(result)
                  }
                }}
                aria-label="AI Recap"
              >
                {aiRecapLoading ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              </button>
            </Tooltip>
          )}
          {viewTab === 'session' && instance.status === 'running' && (
            <Tooltip text="Steer Session" detail="Send a mid-run redirect message — delivered immediately if waiting, or queued for next idle" position="bottom">
              <button
                className={steerOpen ? 'active' : ''}
                onClick={() => {
                  if (instance.pendingSteer) {
                    // Pre-populate with queued message (strip prefix)
                    setSteerText(instance.pendingSteer.replace('[Operator steering]: ', '').replace(/\r$/, ''))
                  }
                  setSteerOpen(o => !o)
                }}
                aria-label="Steer session"
              >
                <Navigation size={14} />
              </button>
            </Tooltip>
          )}
          {(viewTab === 'session' || viewTab === 'shell') && (
            <Tooltip text="Reset Terminal" detail="Destroy this terminal and create a fresh one" position="bottom">
              <button onClick={() => {
                if (viewTab === 'shell') {
                  // Kill old shell PTY and dispose terminal, then re-create
                  if (shellTermRef.current) {
                    shellTermRef.current.unsub?.()
                    shellTermRef.current.term.dispose()
                    shellTermRef.current = null
                    setShellTermReady(false)
                  }
                  window.api.shellPty.kill(instance.id)
                  shellCreatedRef.current = false
                  setShellResetKey((k) => k + 1)
                } else {
                  // Session tab: clear xterm and re-replay the daemon buffer.
                  // Must pause the live listener during replay to avoid double-writes.
                  const entry = terminalsRef.current.get(instance.id)
                  if (entry) {
                    entry.term.reset()

                    // Queue live events until buffer replay finishes (same pattern as initial mount)
                    // Subscribe BEFORE unsubscribing old listener to avoid race window where output is lost
                    let queue: string[] | null = []
                    const unsub = window.api.instance.onOutput(({ id, data }) => {
                      if (id === instance.id) {
                        if (queue) {
                          queue.push(data)
                        } else {
                          entry.proxy.write(data)
                        }
                      }
                    })

                    // Now safe to unsubscribe old listener — new one is already attached
                    entry.unsub?.()
                    entry.unsub = unsub

                    window.api.instance.buffer(instance.id).then((buf) => {
                      if (buf) entry.proxy.write(buf)
                      const pending = queue!
                      queue = null
                      for (const chunk of pending) entry.proxy.write(chunk)
                    })
                  }
                }
              }} aria-label="Reset terminal">
                <RotateCcw size={14} />
              </button>
            </Tooltip>
          )}
          {onSpawnChild && (
            <Tooltip text="Spawn Child" detail="Create a child session that reports back to this one when done" position="bottom">
              <button onClick={onSpawnChild} aria-label="Spawn child session">
                <GitFork size={14} />
              </button>
            </Tooltip>
          )}
          {onFork && (
            <Tooltip text="Fork Session" detail="Create parallel worktrees to explore multiple approaches simultaneously" position="bottom">
              <button onClick={onFork} aria-label="Fork session">
                <GitFork size={14} /> Fork
              </button>
            </Tooltip>
          )}
          {onFanOut && (
            <Tooltip text="Fan-Out" detail="Decompose this task into parallel sub-sessions, each handling a different part" position="bottom">
              <button onClick={onFanOut} aria-label="Fan-out session">
                <Network size={14} /> Fan-Out
              </button>
            </Tooltip>
          )}
          {!isSplit && onSplit && (
            <Tooltip text="Split View" detail="Open a second session side-by-side" shortcut="Cmd+\">
              <button onClick={onSplit} aria-label="Split view">
                <Columns2 size={14} /> Split
                <span className="shortcut-hint">⌘\</span>
              </button>
            </Tooltip>
          )}
          {isSplit && layoutMode === '2-up' && onEnterGrid && (
            <Tooltip text="Grid View" detail="Expand to 2×2 grid — monitor 4 sessions at once">
              <button onClick={onEnterGrid} aria-label="Grid view">
                <LayoutGrid size={14} /> Grid
              </button>
            </Tooltip>
          )}
          {layoutMode === '4-up' && onCycleLayout && (
            <Tooltip text="Exit Grid" detail="Return to single session view">
              <button onClick={onCycleLayout} aria-label="Exit grid view">
                <Columns2 size={14} /> Single
              </button>
            </Tooltip>
          )}
          {isSplit && arenaMode && (
            <>
              <span className="arena-chip">{arenaBlind ? 'Blind' : 'Arena'}</span>
              {arenaBlind && !arenaVoted ? (
                <Tooltip text="Vote for this pane as the winner">
                  <button
                    className="arena-vote-btn"
                    onClick={() => onArenaWin?.()}
                    aria-label="Vote for this pane"
                  >
                    <ThumbsUp size={11} /> This one
                  </button>
                </Tooltip>
              ) : (
                <Tooltip
                  text={arenaVoted ? (arenaWinnerId === instance.id ? 'Winner!' : 'Round lost') : 'Pick as winner'}
                >
                  <button
                    className={`arena-trophy-btn${arenaWinnerId === instance.id ? ' winner' : arenaVoted ? ' loser' : ''}`}
                    onClick={() => { if (!arenaVoted) onArenaWin?.() }}
                    disabled={arenaVoted}
                    aria-label="Pick as arena winner"
                  >
                    <Trophy size={12} />
                  </button>
                </Tooltip>
              )}
            </>
          )}
          {onSearchToggle && (
            <Tooltip text="Search" detail="Search terminal output" shortcut="Cmd+F">
              <button className={searchOpen ? 'active' : ''} onClick={() => onSearchToggle()} aria-label="Search terminal">
                <Search size={14} />
                <span className="shortcut-hint">⌘F</span>
              </button>
            </Tooltip>
          )}
          {isSplit && onCloseSplit && (
            <Tooltip text="Close Split" detail="Return to single session view" shortcut="Cmd+Shift+W">
              <button onClick={onCloseSplit} aria-label="Close split">
                <X size={14} /> Close
                <span className="shortcut-hint">⌘⇧W</span>
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {steerOpen && viewTab === 'session' && instance.status === 'running' && (
        <div className="steer-input-bar">
          <Navigation size={13} className="steer-input-icon" />
          <input
            className="steer-input"
            type="text"
            placeholder="Redirect the agent mid-run — press Enter to send, Escape to cancel"
            value={steerText}
            autoFocus
            onChange={e => setSteerText(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && steerText.trim()) {
                window.api.session.steer(instance.id, steerText.trim())
                setSteerText('')
                setSteerOpen(false)
              } else if (e.key === 'Escape') {
                setSteerText('')
                setSteerOpen(false)
              }
            }}
          />
          {instance.pendingSteer && (
            <button
              className="steer-cancel-btn"
              onClick={() => window.api.session.steer(instance.id, '')}
              title="Cancel queued steer"
            >
              <X size={12} /> Clear
            </button>
          )}
        </div>
      )}
      {viewTab === 'session' && instance.status === 'running' && (
        <div className="session-status-strip">
          <div className="session-status-item">
            <span className={`session-status-dot ${instance.activity}`} />
            <span className="session-status-label">{instance.activity === 'waiting' ? 'Waiting' : 'Running'}</span>
          </div>
          {(() => {
            const modelIdx = instance.args.indexOf('--model')
            const model = modelIdx >= 0 ? instance.args[modelIdx + 1] : null
            const parts = model ? model.split('-') : []
            const short = parts.length >= 3 ? parts.slice(1, 3).join('-') : (model || 'claude')
            const effortIdx = instance.args.indexOf('--effort')
            const effortLevel = effortIdx >= 0 ? instance.args[effortIdx + 1] : null
            return (
              <>
                <span className="session-status-item session-status-model">{short}</span>
                {effortLevel && (
                  <span className={`session-status-item session-status-effort effort-${effortLevel}`} title={`Effort: ${effortLevel} (Requires Claude Code 2.1.90+)`}>
                    {effortLevel}
                  </span>
                )}
              </>
            )
          })()}
          <span className="session-status-item session-status-uptime" tabIndex={-1}>
            {formatUptime(Math.max(0, Math.floor((Date.now() - new Date(instance.createdAt).getTime()) / 1000)))}
          </span>
          {instance.tokenUsage.cost != null && instance.tokenUsage.cost > 0 && (
            <span
              className={`session-status-item session-status-cost ${instance.tokenUsage.cost > 5 ? 'red' : instance.tokenUsage.cost > 1 ? 'amber' : 'green'}`}
              tabIndex={-1}
              title={`Session cost: $${instance.tokenUsage.cost.toFixed(4)}`}
            >
              ${instance.tokenUsage.cost < 0.01 ? '<0.01' : instance.tokenUsage.cost.toFixed(2)}
            </span>
          )}
          {instance.cliBackend !== 'cursor-agent' && (instance.tokenUsage.input > 0 || instance.tokenUsage.output > 0) && (
            <span
              className="session-status-item session-status-tokens"
              tabIndex={-1}
              title={`Input: ${instance.tokenUsage.input.toLocaleString()} tokens · Output: ${instance.tokenUsage.output.toLocaleString()} tokens`}
            >
              <span className="token-in">{fmtTokens(instance.tokenUsage.input)}↓</span>{' '}
              <span className="token-out">{fmtTokens(instance.tokenUsage.output)}↑</span>
            </span>
          )}
          {contextUsage && (() => {
            const b = contextUsage.breakdown
            const fmt = (n: number) => n.toLocaleString()
            const tooltip = [
              `Context usage: ${fmt(contextUsage.tokens)} / ${fmt(contextUsage.maxTokens)} tokens (${contextUsage.percentage}%)`,
              '',
              `System prompt: ${fmt(b.systemPrompt)}`,
              `History: ${fmt(b.history)}`,
              `Artifacts: ${fmt(b.artifacts)}`,
              `Other: ${fmt(b.other)}`,
            ].join('\n')
            return (
              <span
                className={`session-status-item session-status-context ${contextUsage.percentage >= 95 ? 'red' : contextUsage.percentage >= 80 ? 'amber' : 'green'}`}
                tabIndex={-1}
                title={tooltip}
              >
                <span className={`session-status-dot ${contextUsage.percentage >= 95 ? 'red' : contextUsage.percentage >= 80 ? 'amber' : 'green'}`} />
                <span className="context-meter-label">{contextUsage.percentage}%</span>
              </span>
            )
          })()}
          {outputBytes >= 250 * 1024 && (
            <span className={`session-status-item session-status-ctx ${outputBytes >= 600 * 1024 ? 'red' : 'amber'}`} tabIndex={-1} title="Context window pressure — terminal output is large, approaching context limit">
              <span className={`session-status-dot ${outputBytes >= 600 * 1024 ? 'red' : 'amber'}`} />
              ctx
            </span>
          )}
          {(triggerChain.length > 0 || childInstances.length > 0) && (
            <span className="session-status-item session-trigger-chain" title={`Trigger chain: ${[...triggerChain.map(n => n.name), instance.name, ...childInstances.map(c => c.name)].join(' → ')}`}>
              {triggerChain.map((node, i) => (
                <span key={node.id || i} className="session-trigger-chain-node">
                  {i > 0 && <ArrowRight size={9} className="session-trigger-chain-arrow" />}
                  {node.id
                    ? <button className="session-trigger-chain-name session-trigger-chain-btn" onClick={() => onNavigateToSession?.(node.id)}>{node.name.length > 20 ? node.name.slice(0, 18) + '…' : node.name}</button>
                    : <span className="session-trigger-chain-name">{node.name.length > 20 ? node.name.slice(0, 18) + '…' : node.name}</span>
                  }
                </span>
              ))}
              {triggerChain.length > 0 && <ArrowRight size={9} className="session-trigger-chain-arrow" />}
              <span className="session-trigger-chain-name session-trigger-chain-current">{instance.name.length > 20 ? instance.name.slice(0, 18) + '…' : instance.name}</span>
              {childInstances.slice(0, 3).map(child => (
                <span key={child.id} className="session-trigger-chain-node">
                  <ArrowRight size={9} className="session-trigger-chain-arrow" />
                  <button className="session-trigger-chain-name session-trigger-chain-btn" onClick={() => onNavigateToSession?.(child.id)}>{child.name.length > 20 ? child.name.slice(0, 18) + '…' : child.name}</button>
                </span>
              ))}
              {childInstances.length > 3 && <span className="session-trigger-chain-name" style={{ opacity: 0.5 }}>+{childInstances.length - 3}</span>}
            </span>
          )}
        </div>
      )}
      {viewTab === 'session' && recapBanner && (
        <div className="session-recap-banner" onClick={() => onDismissRecap?.()}>
          <span className="session-recap-text">{recapBanner.text}</span>
          {recapBanner.exitSummary && (
            <span className="session-recap-exit">{recapBanner.exitSummary}</span>
          )}
        </div>
      )}
      {viewTab === 'session' && aiRecapOpen && (
        <div className="session-ai-recap">
          <div className="session-ai-recap-header">
            <Sparkles size={11} />
            <span>AI Recap</span>
            {aiRecap && (
              <span className="session-ai-recap-time">{new Date(aiRecap.generatedAt).toLocaleTimeString()}</span>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
              {aiRecap && (
                <button
                  className="session-ai-recap-btn"
                  title="Regenerate recap"
                  onClick={async () => {
                    setAiRecapLoading(true)
                    const result = await window.api.ai.sessionRecap(instance.id, true)
                    setAiRecapLoading(false)
                    setAiRecap(result)
                  }}
                  disabled={aiRecapLoading}
                >
                  {aiRecapLoading ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                </button>
              )}
              <button className="session-ai-recap-btn" title="Close recap" onClick={() => setAiRecapOpen(false)}>
                <X size={11} />
              </button>
            </div>
          </div>
          <div className="session-ai-recap-body">
            {aiRecapLoading && !aiRecap && <span className="session-ai-recap-loading">Generating recap…</span>}
            {!aiRecapLoading && !aiRecap && <span className="session-ai-recap-loading">Could not generate recap. Try again.</span>}
            {aiRecap && <pre className="session-ai-recap-text">{aiRecap.recap}</pre>}
          </div>
        </div>
      )}
      {viewTab === 'session' && changedFiles.length > 0 && (
        <div className="session-changed-files">
          <div
            className="session-changed-files-header"
            onClick={() => {
              const next = !changedFilesOpen
              setChangedFilesOpen(next)
              try { localStorage.setItem(`session-files-${instance.id}`, next ? 'open' : 'closed') } catch {}
              if (!next) { setChangedFilesDiffFile(null); setChangedFilesDiff(null) }
            }}
          >
            <FileCode size={11} />
            <span>{changedFiles.length} changed file{changedFiles.length !== 1 ? 's' : ''}{instance.status !== 'running' ? ' (session ended)' : ''}</span>
            <span className="session-changed-files-summary">
              +{changedFiles.filter(f => f.status === 'A' || f.status === '?').length}
              {' '}~{changedFiles.filter(f => f.status === 'M').length}
              {' '}-{changedFiles.filter(f => f.status === 'D').length}
            </span>
            <span style={{ marginLeft: 'auto', opacity: 0.5 }}>{changedFilesOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}</span>
          </div>
          {changedFilesOpen && (
            <div className="session-changed-files-list">
              {changedFiles.filter(f => f.staged).length > 0 && (
                <div className="session-changed-files-group">
                  <span className="session-changed-files-group-label">Staged</span>
                  {changedFiles.filter(f => f.staged).map((f, i) => (
                    <div key={`s-${i}`} className={`session-changed-file-row${changedFilesDiffFile === f.file ? ' active' : ''}`} onClick={() => handleChangedFileDiff(f.file)}>
                      <span className={`session-changed-file-status ${f.status === 'A' ? 'added' : f.status === 'D' ? 'deleted' : 'modified'}`}>{f.status}</span>
                      <span className="session-changed-file-name" title={f.file}>{f.file.split('/').pop()}</span>
                    </div>
                  ))}
                </div>
              )}
              {changedFiles.filter(f => !f.staged).length > 0 && (
                <div className="session-changed-files-group">
                  <span className="session-changed-files-group-label">Unstaged</span>
                  {changedFiles.filter(f => !f.staged).map((f, i) => (
                    <div key={`u-${i}`} className={`session-changed-file-row${changedFilesDiffFile === f.file ? ' active' : ''}`} onClick={() => handleChangedFileDiff(f.file)}>
                      <span className={`session-changed-file-status ${f.status === 'A' || f.status === '?' ? 'added' : f.status === 'D' ? 'deleted' : 'modified'}`}>{f.status === '?' ? 'U' : f.status}</span>
                      <span className="session-changed-file-name" title={f.file}>{f.file.split('/').pop()}</span>
                    </div>
                  ))}
                </div>
              )}
              {changedFilesDiff !== null && (
                <div className="session-changed-files-diff">
                  {changedFilesDiff
                    ? <DiffViewer diff={changedFilesDiff} filename={changedFilesDiffFile || undefined} />
                    : <span style={{ fontSize: '10px', opacity: 0.5, padding: '4px' }}>No diff available</span>}
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {/* Children panel — shows when this session spawned others (pipeline, persona trigger, maker-checker) */}
      {viewTab === 'session' && childInstances.length > 0 && (
        <div className={`session-children-panel${childrenOpen ? ' open' : ''}`}>
          <div className="session-children-summary" onClick={() => setChildrenOpen(o => !o)}>
            <GitMerge size={12} />
            <span>{childInstances.length} child session{childInstances.length > 1 ? 's' : ''}</span>
            {childInstances.some(c => c.status === 'running') && (
              <button
                className="session-children-stop-btn"
                title="Stop all running child sessions"
                onClick={(e) => {
                  e.stopPropagation()
                  if (confirm(`Stop all ${childInstances.filter(c => c.status === 'running').length} running child session(s)?`)) {
                    window.api.instance.stopChildren(instance.id).catch(() => {})
                  }
                }}
              >
                <Square size={10} /> Stop all
              </button>
            )}
          </div>
          {childrenOpen && (
            <div className="session-children-list">
              {sortedChildren.map(child => (
                <div
                  key={child.id}
                  className="session-child-item clickable"
                  onClick={() => onNavigateToSession?.(child.id)}
                  title={`Click to navigate to ${child.name}`}
                >
                  <span className={`session-child-dot ${child.status === 'running' ? child.activity : 'exited'}`} />
                  <span className="session-child-name">{child.name}</span>
                  {child.tokenUsage?.cost != null && child.tokenUsage.cost > 0 && (
                    <span className="session-child-cost">${child.tokenUsage.cost.toFixed(2)}</span>
                  )}
                  <span className={`session-child-status ${child.status === 'running' ? child.activity : 'exited'}`}>
                    {child.status === 'running' ? (child.activity === 'waiting' ? 'waiting' : 'busy') : 'done'}
                  </span>
                  {child.status === 'running' && (
                    <button
                      className="session-child-kill-btn"
                      title={`Stop ${child.name}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        if (confirm(`Stop ${child.name}?`)) {
                          window.api.instance.kill(child.id).catch(() => {})
                        }
                      }}
                    >
                      <Square size={9} />
                    </button>
                  )}
                </div>
              ))}
              {(() => {
                const total = childInstances.reduce((sum, c) => sum + (c.tokenUsage?.cost ?? 0), 0)
                return childInstances.length >= 2 && total > 0 ? (
                  <div className="session-children-total">
                    Σ total: ${total.toFixed(2)} · {childInstances.length} sessions
                  </div>
                ) : null
              })()}
            </div>
          )}
        </div>
      )}
      {/* Fan-Out monitor — shows when this session is a fan-out parent */}
      {viewTab === 'session' && (instance.fanOutChildIds?.length ?? 0) > 0 && (
        <FanOutMonitor
          parentInstance={instance}
          childInstances={allInstances.filter(i => instance.fanOutChildIds!.includes(i.id))}
          onNavigateToChild={id => onNavigateToSession?.(id)}
        />
      )}
      {/* Tab content — browser is persistent; other non-terminal tabs use flex split */}
      {viewTab !== 'session' && viewTab !== 'shell' && viewTab !== 'browser' && splitTab && (
        <div className="browser-split-container">
          <div className="browser-split-pane" style={{ flex: `0 0 ${splitRatio * 100}%` }}>
            {renderTabContent(viewTab)}
          </div>
          {renderSecondaryPane()}
        </div>
      )}
      {viewTab !== 'session' && viewTab !== 'shell' && viewTab !== 'browser' && !splitTab && renderTabContent(viewTab)}
      {viewTab === 'session' && instance.status === 'exited' && !arenaMode && (
        <div className="session-exited-bar">
          <span className={`session-exited-badge ${instance.exitCode === 0 ? 'success' : 'error'}`}>
            {instance.exitCode === 0 ? 'Completed' : instance.exitCode != null ? `Failed (${instance.exitCode})` : 'Failed'}
          </span>
          <span className="session-exited-duration" title={`Started ${new Date(instance.createdAt).toLocaleString()}${instance.exitedAt ? ` — Exited ${new Date(instance.exitedAt).toLocaleString()}` : ''}`}>
            ran {formatUptime(Math.max(0, Math.floor(((instance.exitedAt ?? Date.now()) - new Date(instance.createdAt).getTime()) / 1000)))}
          </span>
          {instance.tokenUsage.cost != null && instance.tokenUsage.cost > 0 && (
            <span
              className={`session-exited-cost ${instance.tokenUsage.cost > 5 ? 'red' : instance.tokenUsage.cost > 1 ? 'amber' : 'green'}`}
              title={`Session cost: $${instance.tokenUsage.cost.toFixed(4)}`}
            >
              ${instance.tokenUsage.cost < 0.01 ? '<0.01' : instance.tokenUsage.cost.toFixed(2)}
            </span>
          )}
          <div className="session-exited-spacer" />
          {(instance.args.length > 0 || instance.workingDirectory) && (
            <button
              className="session-exited-btn"
              onClick={() => setShowRetryDialog(true)}
              title="Retry with editable prompt"
            >
              <Play size={12} /> Retry
            </button>
          )}
          <button
            className="session-exited-btn"
            onClick={() => onRestart(instance.id)}
            title="Restart this session"
          >
            <RotateCcw size={12} /> Restart
          </button>
          <button
            className="session-exited-btn danger"
            onClick={() => onRemove(instance.id)}
            title="Remove this session"
          >
            <X size={12} /> Remove
          </button>
        </div>
      )}
      {viewTab === 'session' && errorSummary && instance.status === 'exited' && (
        <details className="session-error-card" open>
          <summary className="session-error-card-summary">
            <AlertTriangle size={14} />
            <span className="session-error-card-type">{errorSummary.errorType}</span>
            <span className="session-error-card-message">{errorSummary.message}</span>
          </summary>
          <div className="session-error-card-body">
            {errorSummary.file && (
              <div className="session-error-card-location">
                {errorSummary.file}{errorSummary.line != null ? `:${errorSummary.line}` : ''}
              </div>
            )}
            {errorSummary.snippet.length > 0 && (
              <pre className="session-error-card-snippet">{errorSummary.snippet.join('\n')}</pre>
            )}
          </div>
        </details>
      )}
      {viewTab === 'session' && instance.toolDeferredInfo && !deferredDismissed && (
        <div className="tool-deferred-banner">
          <AlertTriangle size={16} className="tool-deferred-icon" />
          <div className="tool-deferred-content">
            <span className="tool-deferred-heading">Tool deferred</span>
            <span className="tool-deferred-tool">{instance.toolDeferredInfo.toolName}</span>
          </div>
          <div className="tool-deferred-actions">
            <button
              className="tool-deferred-btn approve"
              onClick={() => {
                setDeferredDismissed(true)
                onRestart(instance.id)
              }}
            >
              <Play size={12} /> Approve
            </button>
            <button
              className="tool-deferred-btn deny"
              onClick={() => {
                setDeferredDismissed(true)
                window.api.instance.clearToolDeferred(instance.id).catch(() => {})
              }}
            >
              <X size={12} /> Deny
            </button>
          </div>
        </div>
      )}
      {/* Browser — persistent mount to prevent webview reloads on tab switch */}
      {browserMounted && envStatus && (
        <div style={{
          display: viewTab === 'browser' ? 'flex' : 'none',
          flexDirection: 'row' as const,
          flex: 1,
          minHeight: 0,
        }}>
          <div style={{ display: 'flex', flexDirection: 'column', flex: splitTab ? `0 0 ${splitRatio * 100}%` : '1', minWidth: 0, minHeight: 0 }}>
            <BrowserTab envStatus={envStatus} instanceId={instance.id} />
          </div>
          {splitTab && viewTab === 'browser' && renderSecondaryPane()}
        </div>
      )}
      <div ref={sessionTabRef} style={{ display: viewTab === 'session' ? 'flex' : 'none', flex: 1, minHeight: 0, position: 'relative', flexDirection: 'column' }}>
        <div
          className={`terminal-container ${dragOver ? 'drag-over' : ''}`}
          ref={containerRef}
          onClick={() => {
            onFocusPane?.()
            const entry = terminalsRef.current.get(instance.id)
            if (entry) entry.term.focus()
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {searchOpen && (
            <div className="terminal-search-bar">
              <input
                ref={searchInputRef}
                className="terminal-search-input"
                placeholder="Find..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
              {searchQuery && (
                <span className="terminal-search-count">
                  {searchResults
                    ? searchResults.resultIndex >= 0
                      ? `${searchResults.resultIndex + 1} of ${searchResults.resultCount}`
                      : `${searchResults.resultCount}+`
                    : 'No results'}
                </span>
              )}
              <button className="terminal-search-btn" onClick={handleSearchPrev} title="Previous match" aria-label="Previous match"><ChevronUp size={14} /></button>
              <button className="terminal-search-btn" onClick={handleSearchNext} title="Next match" aria-label="Next match"><ChevronDown size={14} /></button>
              <button className="terminal-search-btn" onClick={() => { setSearchQuery(''); setSearchResults(null); onSearchClose?.() }} title="Close search" aria-label="Close search"><X size={14} /></button>
            </div>
          )}
          {dragOver && (
            <div className="terminal-drop-overlay">Drop to paste path</div>
          )}
          <div className="terminal-scroll-nav">
            <button className="terminal-scroll-btn" onClick={scrollToTop} title="Scroll to top" aria-label="Scroll to top"><ChevronUp size={14} /></button>
            <button className="terminal-scroll-btn" onClick={scrollToBottom} title="Scroll to bottom" aria-label="Scroll to bottom"><ChevronDown size={14} /></button>
          </div>
        </div>
        {splitTab && (
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${(1 - splitRatio) * 100}%`, display: 'flex', zIndex: 5, background: 'var(--bg-primary)' }}>
            {renderSecondaryPane()}
          </div>
        )}
      </div>
      <div ref={shellTabRef} style={{ display: viewTab === 'shell' ? 'flex' : 'none', flex: 1, minHeight: 0, position: 'relative', flexDirection: 'column' }}>
        {shellTermReady && (
          <div className="shell-quick-bar">
            <button
              className={`shell-quick-toggle ${shellQuickOpen ? 'open' : ''}`}
              onClick={() => setShellQuickOpen(o => { const next = !o; localStorage.setItem('shell-quick-open', String(next)); return next })}
              tabIndex={-1}
            >
              Quick {shellQuickOpen ? '›' : '‹'}
            </button>
            {shellQuickOpen && (
              <div className="shell-quick-cmds">
                {quickCmds.map(cmd => (
                  <button
                    key={cmd}
                    className="shell-quick-cmd"
                    tabIndex={-1}
                    onClick={() => window.api.shellPty.write(instance.id, cmd + '\n')}
                  >
                    {cmd}
                  </button>
                ))}
                <button
                  className="shell-quick-edit"
                  onClick={() => setEditingQuickCmds(e => !e)}
                  title="Edit commands"
                  tabIndex={-1}
                >
                  <Pencil size={11} />
                </button>
              </div>
            )}
            {shellQuickOpen && editingQuickCmds && (
              <div className="shell-quick-editor">
                <div className="shell-quick-editor-list">
                  {quickCmds.map((cmd, i) => (
                    <div key={i} className="shell-quick-editor-item">
                      <span>{cmd}</span>
                      <button onClick={() => setQuickCmds(prev => prev.filter((_, j) => j !== i))} title="Remove" tabIndex={-1}>
                        <X size={11} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="shell-quick-editor-add">
                  <input
                    value={newCmdText}
                    onChange={e => setNewCmdText(e.target.value)}
                    placeholder="New command..."
                    onKeyDown={e => {
                      if (e.key === 'Enter' && newCmdText.trim()) {
                        setQuickCmds(prev => [...prev, newCmdText.trim()])
                        setNewCmdText('')
                      }
                    }}
                  />
                  <button onClick={() => { if (newCmdText.trim()) { setQuickCmds(prev => [...prev, newCmdText.trim()]); setNewCmdText('') } }} tabIndex={-1}>Add</button>
                </div>
                <button className="shell-quick-editor-reset" onClick={() => setQuickCmds(defaultQuickCmds)} tabIndex={-1}>Reset to defaults</button>
              </div>
            )}
          </div>
        )}
        <div
          className={`terminal-container shell-terminal${dragOver ? ' drag-over' : ''}`}
          ref={shellContainerRef}
          onClick={() => {
            onFocusPane?.()
            shellTermRef.current?.term.focus()
          }}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={(e) => handleDrop(e, 'shell')}
        >
          {searchOpen && viewTab === 'shell' && (
            <div className="terminal-search-bar">
              <input
                ref={searchInputRef}
                className="terminal-search-input"
                placeholder="Find..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={handleSearchKeyDown}
              />
              {searchQuery && (
                <span className="terminal-search-count">
                  {searchResults
                    ? searchResults.resultIndex >= 0
                      ? `${searchResults.resultIndex + 1} of ${searchResults.resultCount}`
                      : `${searchResults.resultCount}+`
                    : 'No results'}
                </span>
              )}
              <button className="terminal-search-btn" onClick={handleSearchPrev} title="Previous match" aria-label="Previous match"><ChevronUp size={14} /></button>
              <button className="terminal-search-btn" onClick={handleSearchNext} title="Next match" aria-label="Next match"><ChevronDown size={14} /></button>
              <button className="terminal-search-btn" onClick={() => { setSearchQuery(''); setSearchResults(null); onSearchClose?.() }} title="Close search" aria-label="Close search"><X size={14} /></button>
            </div>
          )}
          {dragOver && (
            <div className="terminal-drop-overlay">Drop to paste path</div>
          )}
        </div>
        {splitTab && (
          <div style={{ position: 'absolute', right: 0, top: 0, bottom: 0, width: `${(1 - splitRatio) * 100}%`, display: 'flex', zIndex: 5, background: 'var(--bg-primary)' }}>
            {renderSecondaryPane()}
          </div>
        )}
      </div>
      <FileQuickOpen
        open={fileQuickOpen}
        onClose={() => setFileQuickOpen(false)}
        workingDirectory={instance.workingDirectory}
        onSelectFile={(path) => {
          setFileQuickOpen(false)
          if (viewTab === 'files') {
            setJumpFilePath(path)
          } else {
            setSplitTab('files')
            setJumpFilePath(path)
          }
        }}
      />
      {showRetryDialog && (
        <RetryDialog
          instance={instance}
          onRetry={({ name, args }) => {
            window.api.instance.create({
              name,
              workingDirectory: instance.workingDirectory,
              color: instance.color,
              args,
              cliBackend: instance.cliBackend,
              permissionMode: instance.permissionMode,
              mcpServers: instance.mcpServers,
            }).catch(() => {})
            setShowRetryDialog(false)
          }}
          onClose={() => setShowRetryDialog(false)}
        />
      )}
    </>
  )
}, (prev, next) =>
  prev.instance === next.instance &&
  prev.focused === next.focused &&
  prev.searchOpen === next.searchOpen &&
  prev.isSplit === next.isSplit &&
  prev.arenaMode === next.arenaMode &&
  prev.arenaBlind === next.arenaBlind &&
  prev.arenaVoted === next.arenaVoted &&
  prev.arenaWinnerId === next.arenaWinnerId &&
  prev.paneLabel === next.paneLabel &&
  prev.outputBytes === next.outputBytes &&
  prev.layoutMode === next.layoutMode &&
  prev.fontSize === next.fontSize &&
  prev.fontFamily === next.fontFamily &&
  prev.cursorStyle === next.cursorStyle &&
  prev.cursorBlink === next.cursorBlink &&
  prev.scrollback === next.scrollback &&
  prev.errorSummary === next.errorSummary
)
