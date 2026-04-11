import { useEffect, useRef, useCallback, useState, useMemo, MutableRefObject } from 'react'
import type { ContextUsage } from '../../../preload'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { TerminalProxy } from '../lib/terminal-proxy'
import { ChevronUp, ChevronDown, X, RotateCcw, GitBranch, TerminalSquare, FolderTree, Columns2, LayoutGrid, GitFork, Server, Play, ScrollText, MessageSquare, AlertTriangle, Trophy, GitCompare, Navigation, ThumbsUp, Bot, BarChart3, Package, Globe, FileDown, CheckCircle, Copy } from 'lucide-react'
import { TeamMetricsPanel } from './TeamMetricsPanel'
import ServicesTab from './ServicesTab'
import FilesTab from './FilesTab'
import ChangesTab from './ChangesTab'
import ArtifactsTab from './ArtifactsTab'
import LogsTab from './LogsTab'
import BrowserTab from './BrowserTab'
import TeamTab from './TeamTab'
import type { EnvStatus } from '../../../shared/types'
import '@xterm/xterm/css/xterm.css'
import type { ClaudeInstance } from '../types'
import Tooltip from './Tooltip'
import HelpPopover from './HelpPopover'
import { usePanelTabKeys } from '../hooks/usePanelTabKeys'

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
  fontSize?: number
  focused?: boolean
  onFocusPane?: () => void
  outputBytes?: number
  layoutMode?: 'single' | '2-up' | '4-up'
  onCycleLayout?: () => void
  onEnterGrid?: () => void
  onNavigateToSession?: (id: string) => void
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

type ViewTab = 'session' | 'shell' | 'files' | 'services' | 'logs' | 'changes' | 'artifacts' | 'team' | 'metrics' | 'browser'

export default function TerminalView({ instance, onKill, onRestart, onRemove, onSplit, onCloseSplit, onSpawnChild, onFork, isSplit, arenaMode, arenaBlind, paneLabel, arenaVoted, arenaWinnerId, onArenaWin, terminalsRef, searchOpen, onSearchClose, fontSize = 13, focused = true, onFocusPane, outputBytes = 0, layoutMode = 'single', onCycleLayout, onEnterGrid, onNavigateToSession }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [viewTab, setViewTab] = useState<ViewTab>('session')
  const [deferredDismissed, setDeferredDismissed] = useState(false)
  // Reset dismissed state when a new deferred event arrives
  const deferredToolRef = useRef(instance.toolDeferredInfo?.toolName)
  if (instance.toolDeferredInfo?.toolName !== deferredToolRef.current) {
    deferredToolRef.current = instance.toolDeferredInfo?.toolName
    if (instance.toolDeferredInfo) setDeferredDismissed(false)
  }
  const shellContainerRef = useRef<HTMLDivElement>(null)
  const shellTermRef = useRef<{ term: Terminal; fitAddon: FitAddon; searchAddon: SearchAddon; unsub?: () => void } | null>(null)
  const shellCreatedRef = useRef(false)
  const [shellResetKey, setShellResetKey] = useState(0)

  // Environment detection: if workingDirectory is under ~/.claude-colony/environments/<name>/
  const envName = (() => {
    const marker = '/.claude-colony/environments/'
    const idx = instance.workingDirectory.indexOf(marker)
    if (idx < 0) return null
    const rest = instance.workingDirectory.slice(idx + marker.length)
    return rest.split('/')[0] || null
  })()
  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null)
  // Tab badge counts (pushed from child components)
  const [teamWorkerCount, setTeamWorkerCount] = useState(0)
  const [changeCount, setChangeCount] = useState(0)
  const [artifactCount, setArtifactCount] = useState(0)
  const [exportSuccess, setExportSuccess] = useState(false)
  const [copySuccess, setCopySuccess] = useState(false)

  // Session steering
  const [steerOpen, setSteerOpen] = useState(false)
  const [steerText, setSteerText] = useState('')

  // Shell quick commands
  const [shellQuickOpen, setShellQuickOpen] = useState(() => localStorage.getItem('shell-quick-open') !== 'false')
  const [shellTermReady, setShellTermReady] = useState(false)
  // Context usage tracking
  const [contextUsage, setContextUsage] = useState<ContextUsage | null>(null)

  useEffect(() => {
    if (!envName) return
    // Initial fetch
    window.api.env.list().then((envs) => {
      const match = envs.find((e) => e.name === envName || e.id === envName)
      if (match) setEnvStatus(match)
    })
    // Subscribe to updates
    const unsub = window.api.env.onStatusUpdate((envs) => {
      const match = envs.find((e) => e.name === envName || e.id === envName)
      setEnvStatus(match || null)
    })
    return unsub
  }, [envName])

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
      cursorBlink: true,
      theme: getXtermTheme('shell'),
      allowProposedApi: true,
    })
    const fitAddon = new FitAddon()
    const shellSearchAddon = new SearchAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(shellSearchAddon)
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
    if (addon && searchQuery) addon.findNext(searchQuery)
  }, [getActiveSearchAddon, searchQuery])

  const handleSearchPrev = useCallback(() => {
    const addon = getActiveSearchAddon()
    if (addon && searchQuery) addon.findPrevious(searchQuery)
  }, [getActiveSearchAddon, searchQuery])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) handleSearchPrev()
      else handleSearchNext()
    }
    if (e.key === 'Escape') {
      getActiveSearchAddon()?.clearDecorations()
      setSearchQuery('')
      onSearchClose?.()
    }
  }, [handleSearchNext, handleSearchPrev, getActiveSearchAddon, onSearchClose])

  // Live search as you type
  useEffect(() => {
    const addon = getActiveSearchAddon()
    if (!addon) return
    if (searchQuery) {
      addon.findNext(searchQuery)
    } else {
      addon.clearDecorations()
    }
  }, [searchQuery, getActiveSearchAddon])

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return
    initializedRef.current = true

    let existing = terminalsRef.current.get(instance.id)

    if (!existing) {
      const term = new Terminal({
        theme: getXtermTheme('session'),
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
        fontSize: 13,
        lineHeight: 1.2,
        cursorBlink: false,
        cursorStyle: 'underline',
        cursorWidth: 1,
        cursorInactiveStyle: 'none',
        scrollback: 10000,
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
      term.loadAddon(webLinksAddon)

      const proxy = new TerminalProxy(term)

      term.onData((data) => {
        proxy.onUserInput()
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

  // Session tab keyboard navigation — Cmd+Shift+{ (prev) / Cmd+Shift+} (next)
  const hasEnvUrls = envName && envStatus && Object.keys(envStatus.urls).length > 0
  const visibleViewTabs = useMemo<ViewTab[]>(() => [
    'session', 'shell', 'files',
    ...(envName ? (['services', 'logs'] as ViewTab[]) : []),
    ...(hasEnvUrls ? (['browser'] as ViewTab[]) : []),
    ...(instance.workingDirectory ? (['changes'] as ViewTab[]) : []),
    'artifacts',
    ...(instance.roleTag === 'Coordinator' ? (['team', 'metrics'] as ViewTab[]) : []),
  ], [envName, instance.workingDirectory, instance.roleTag, hasEnvUrls])
  usePanelTabKeys(visibleViewTabs, viewTab, setViewTab, focused)

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
            </button>
            <button
              className={`terminal-tab ${viewTab === 'shell' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('shell') }}
              title="Shell terminal"
            >
              <TerminalSquare size={12} /> Terminal
            </button>
            <button
              className={`terminal-tab ${viewTab === 'files' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('files') }}
              title="View files"
            >
              <FolderTree size={12} /> Files
            </button>
            {envName && (
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
              </button>
            )}
            {envName && (
              <button
                className={`terminal-tab ${viewTab === 'logs' ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setViewTab('logs') }}
                title="Service logs"
              >
                <ScrollText size={12} /> Logs
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
            </button>
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
              </button>
            )}
            {instance.roleTag === 'Coordinator' && (
              <button
                className={`terminal-tab ${viewTab === 'metrics' ? 'active' : ''}`}
                onClick={(e) => { e.stopPropagation(); setViewTab('metrics') }}
                title="Team metrics"
              >
                <BarChart3 size={12} /> Metrics
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
        <div className="terminal-header-actions">
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
          {!isSplit && onSplit && (
            <Tooltip text="Split View" detail="Open a second session side-by-side" shortcut="Cmd+\">
              <button onClick={onSplit} aria-label="Split view">
                <Columns2 size={14} /> Split
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
          {isSplit && onCloseSplit && (
            <Tooltip text="Close Split" detail="Return to single session view" shortcut="Cmd+Shift+W">
              <button onClick={onCloseSplit} aria-label="Close split">
                <X size={14} /> Close
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
            return <span className="session-status-item session-status-model">{short}</span>
          })()}
          <span className="session-status-item session-status-uptime" tabIndex={-1}>
            {formatUptime(Math.max(0, Math.floor((Date.now() - new Date(instance.createdAt).getTime()) / 1000)))}
          </span>
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
        </div>
      )}
      {viewTab === 'files' && (
        <FilesTab instance={instance} focused={focused} onSwitchToSession={() => setViewTab('session')} />
      )}
      {viewTab === 'services' && envStatus && (
        <ServicesTab envStatus={envStatus} instance={instance} />
      )}
      {viewTab === 'logs' && envStatus && (
        <LogsTab envStatus={envStatus} />
      )}
      {viewTab === 'browser' && envStatus && (
        <BrowserTab envStatus={envStatus} instanceId={instance.id} />
      )}
      {viewTab === 'changes' && (
        <ChangesTab instance={instance} onChangeCount={setChangeCount} />
      )}
      {viewTab === 'artifacts' && (
        <ArtifactsTab instanceId={instance.id} instanceStatus={instance.status} onArtifactCount={setArtifactCount} />
      )}
      {viewTab === 'team' && instance.roleTag === 'Coordinator' && (
        <TeamTab instanceId={instance.id} onWorkerCountChange={setTeamWorkerCount} onNavigateToWorker={onNavigateToSession} />
      )}
      {viewTab === 'metrics' && instance.roleTag === 'Coordinator' && (
        <div className="changes-panel">
          <TeamMetricsPanel coordinatorSessionId={instance.id} />
        </div>
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
        style={{ display: viewTab === 'session' ? undefined : 'none' }}
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
            <button className="terminal-search-btn" onClick={handleSearchPrev} title="Previous match" aria-label="Previous match"><ChevronUp size={14} /></button>
            <button className="terminal-search-btn" onClick={handleSearchNext} title="Next match" aria-label="Next match"><ChevronDown size={14} /></button>
            <button className="terminal-search-btn" onClick={() => { setSearchQuery(''); onSearchClose?.() }} title="Close search" aria-label="Close search"><X size={14} /></button>
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
      {viewTab === 'shell' && shellTermReady && (
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
              {['git status', 'git log --oneline -5', 'ls -la', 'npm test'].map(cmd => (
                <button
                  key={cmd}
                  className="shell-quick-cmd"
                  tabIndex={-1}
                  onClick={() => window.api.shellPty.write(instance.id, cmd + '\n')}
                >
                  {cmd}
                </button>
              ))}
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
        style={{ display: viewTab === 'shell' ? undefined : 'none' }}
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
            <button className="terminal-search-btn" onClick={handleSearchPrev} title="Previous match" aria-label="Previous match"><ChevronUp size={14} /></button>
            <button className="terminal-search-btn" onClick={handleSearchNext} title="Next match" aria-label="Next match"><ChevronDown size={14} /></button>
            <button className="terminal-search-btn" onClick={() => { setSearchQuery(''); onSearchClose?.() }} title="Close search" aria-label="Close search"><X size={14} /></button>
          </div>
        )}
        {dragOver && (
          <div className="terminal-drop-overlay">Drop to paste path</div>
        )}
      </div>
    </>
  )
}
