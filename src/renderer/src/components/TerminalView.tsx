import { useEffect, useRef, useCallback, useState, useMemo, MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { TerminalProxy } from '../lib/terminal-proxy'
import { ChevronUp, ChevronDown, ChevronsDown, ChevronRight, Minimize2, Maximize2, X, RotateCcw, Trash2, GitBranch, TerminalSquare, FolderTree, File, Folder, FolderOpen, RefreshCw, Search, Settings, Columns2, ExternalLink, GitFork, Server, Square, Play, ScrollText, Stethoscope, MessageSquare, AlertTriangle, CheckCircle, Activity, WrapText, ArrowUpDown, History, Clock } from 'lucide-react'
import type { EnvStatus, EnvServiceStatus, ReplayEvent } from '../../../shared/types'
import { buildDiagnosePrompt } from '../../../shared/env-prompts'
import '@xterm/xterm/css/xterm.css'
import type { ClaudeInstance } from '../types'
import Tooltip from './Tooltip'
import HelpPopover from './HelpPopover'

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
  isSplit?: boolean
  terminalsRef: MutableRefObject<Map<string, TerminalEntry>>
  searchOpen?: boolean
  onSearchClose?: () => void
  fontSize?: number
  focused?: boolean
  onFocusPane?: () => void
  outputBytes?: number
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

function levelMatches(line: string, filter: 'all' | 'error' | 'warn'): boolean {
  if (filter === 'all') return true
  if (filter === 'error') return /error|ERROR|FATAL|FAIL/i.test(line)
  return /warn|WARN|WARNING/i.test(line)
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function buildHighlightedHtml(text: string, query: string, activeIndex: number): { html: string; count: number } {
  if (!query) return { html: escapeHtml(text), count: 0 }
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(escaped, 'gi')
  let count = 0
  const html = escapeHtml(text).replace(
    new RegExp(escaped.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), 'gi'),
    (match) => {
      const cls = count === activeIndex ? 'filetree-search-highlight active' : 'filetree-search-highlight'
      count++
      return `<mark class="${cls}">${match}</mark>`
    }
  )
  // Re-count on original text for accuracy
  const total = (text.match(regex) || []).length
  return { html, count: total }
}

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

function sortFileNodes(nodes: FileNode[], mode: 'name' | 'modified'): FileNode[] {
  return [...nodes]
    .sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
      if (mode === 'modified') {
        const extA = a.name.split('.').pop() || ''
        const extB = b.name.split('.').pop() || ''
        const extCmp = extA.localeCompare(extB)
        if (extCmp !== 0) return extCmp
      }
      return a.name.localeCompare(b.name)
    })
    .map((n) =>
      n.type === 'directory' && n.children
        ? { ...n, children: sortFileNodes(n.children, mode) }
        : n
    )
}

interface FileTreeNodeProps {
  node: FileNode
  depth: number
  selectedPath: string | null
  expandedPaths: Set<string>
  filter: string
  onTogglePath: (path: string) => void
  onExpandAll: (path: string) => void
  onCollapseAll: (path: string) => void
  onSelectFile: (path: string) => void
  lazyChildren: Map<string, FileNode[]>
  onLoadChildren: (path: string) => void
}

function nodeMatchesFilter(node: FileNode, filter: string, lazyChildren: Map<string, FileNode[]>): boolean {
  const q = filter.toLowerCase()
  if (node.name.toLowerCase().includes(q)) return true
  if (node.type === 'directory') {
    const children = node.children || lazyChildren.get(node.path)
    if (children) return children.some((c) => nodeMatchesFilter(c, filter, lazyChildren))
  }
  return false
}

function FileTreeNode({ node, depth, selectedPath, expandedPaths, filter, onTogglePath, onExpandAll, onCollapseAll, onSelectFile, lazyChildren, onLoadChildren }: FileTreeNodeProps) {
  const isDir = node.type === 'directory'
  const expanded = expandedPaths.has(node.path) || (!!filter && isDir)
  const children = node.children || lazyChildren.get(node.path) || null

  // Filter: hide nodes that don't match
  if (filter && !nodeMatchesFilter(node, filter, lazyChildren)) return null

  const handleToggle = () => {
    if (!isDir) return
    if (!expanded && !children) {
      onLoadChildren(node.path)
    }
    onTogglePath(node.path)
  }

  return (
    <div className="filetree-node">
      <div
        className={`filetree-row ${isDir ? 'dir' : 'file'} ${node.path === selectedPath ? 'selected' : ''}`}
        style={{ paddingLeft: depth * 16 + 8 }}
        onClick={isDir ? handleToggle : () => onSelectFile(node.path)}
        title={node.path}
      >
        {isDir ? (
          <>
            <ChevronRight size={12} className={`filetree-chevron ${expanded ? 'expanded' : ''}`} />
            {expanded ? <FolderOpen size={14} className="filetree-icon dir" /> : <Folder size={14} className="filetree-icon dir" />}
          </>
        ) : (
          <>
            <span className="filetree-chevron-spacer" />
            <File size={14} className="filetree-icon file" />
          </>
        )}
        <span className="filetree-name">{node.name}</span>
        {isDir && (
          <span className="filetree-dir-actions" onClick={(e) => e.stopPropagation()}>
            <button
              title="Expand all"
              onClick={() => onExpandAll(node.path)}
            >
              <Maximize2 size={11} />
            </button>
            <button
              title="Collapse all"
              onClick={() => onCollapseAll(node.path)}
            >
              <Minimize2 size={11} />
            </button>
          </span>
        )}
      </div>
      {isDir && expanded && (
        <div className="filetree-children">
          {!children && <div className="filetree-loading" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>Loading...</div>}
          {children?.map((child) => (
            <FileTreeNode
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedPath={selectedPath}
              expandedPaths={expandedPaths}
              filter={filter}
              onTogglePath={onTogglePath}
              onExpandAll={onExpandAll}
              onCollapseAll={onCollapseAll}
              onSelectFile={onSelectFile}
              lazyChildren={lazyChildren}
              onLoadChildren={onLoadChildren}
            />
          ))}
          {children && children.length === 0 && (
            <div className="filetree-empty" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>Empty</div>
          )}
        </div>
      )}
    </div>
  )
}

type ViewTab = 'session' | 'shell' | 'files' | 'services' | 'logs' | 'replay'

export default function TerminalView({ instance, onKill, onRestart, onRemove, onSplit, onCloseSplit, onSpawnChild, isSplit, terminalsRef, searchOpen, onSearchClose, fontSize = 13, focused = true, onFocusPane, outputBytes = 0 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [viewTab, setViewTab] = useState<ViewTab>('session')
  const shellContainerRef = useRef<HTMLDivElement>(null)
  const shellTermRef = useRef<{ term: Terminal; fitAddon: FitAddon; unsub?: () => void } | null>(null)
  const shellCreatedRef = useRef(false)
  const [shellResetKey, setShellResetKey] = useState(0)
  const [fileTree, setFileTree] = useState<FileNode[] | null>(null)
  const [fileTreeLoading, setFileTreeLoading] = useState(false)
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
  const [lazyChildren, setLazyChildren] = useState<Map<string, FileNode[]>>(new Map())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [fileSearchInput, setFileSearchInput] = useState('')
  const [fileSearchQuery, setFileSearchQuery] = useState('')
  const [fileSearchOpen, setFileSearchOpen] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [fileSearchIndex, setFileSearchIndex] = useState(0)
  const [treeFilter, setTreeFilter] = useState('')
  const [contentSearch, setContentSearch] = useState('')
  const [contentResults, setContentResults] = useState<Array<{ file: string; matches: Array<{ line: number; text: string }> }> | null>(null)
  const [contentSearching, setContentSearching] = useState(false)
  const [searchMode, setSearchMode] = useState<'files' | 'content'>('files')
  const [visibleResultCount, setVisibleResultCount] = useState(20)

  // Environment detection: if workingDirectory is under ~/.claude-colony/environments/<name>/
  const envName = (() => {
    const marker = '/.claude-colony/environments/'
    const idx = instance.workingDirectory.indexOf(marker)
    if (idx < 0) return null
    const rest = instance.workingDirectory.slice(idx + marker.length)
    return rest.split('/')[0] || null
  })()
  const [envStatus, setEnvStatus] = useState<EnvStatus | null>(null)
  const [envLogs, setEnvLogs] = useState<{ service: string; content: string } | null>(null)
  const [fixMenuOpen, setFixMenuOpen] = useState(false)
  const [fixResult, setFixResult] = useState<{ lines: string[]; isError?: boolean } | null>(null)
  const [fixInProgress, setFixInProgress] = useState(false)
  // Logs tab state
  const [logsFilter, setLogsFilter] = useState<string | null>(null) // null = all services
  const [logsLevelFilter, setLogsLevelFilter] = useState<'all' | 'error' | 'warn'>('all')
  const [logsContent, setLogsContent] = useState<Array<{ service: string; line: string; ts: number }>>([])
  const logsEndRef = useRef<HTMLDivElement>(null)
  const logsAutoScroll = useRef(true)
  const logsInitialized = useRef(false)
  // Replay tab state
  const [replayEvents, setReplayEvents] = useState<ReplayEvent[]>([])
  const [replayLoading, setReplayLoading] = useState(false)
  const [replayExpanded, setReplayExpanded] = useState<Set<number>>(new Set())
  // Files tab sort
  const [filesSortMode, setFilesSortMode] = useState<'name' | 'modified'>('name')
  const sortedFileTree = useMemo(() => {
    if (!fileTree) return null
    return sortFileNodes(fileTree, filesSortMode)
  }, [fileTree, filesSortMode])

  const sortedLazyChildren = useMemo(() => {
    if (!lazyChildren.size) return lazyChildren
    const next = new Map<string, FileNode[]>()
    for (const [k, v] of lazyChildren) next.set(k, sortFileNodes(v, filesSortMode))
    return next
  }, [lazyChildren, filesSortMode])
  // Shell quick commands
  const [shellQuickOpen, setShellQuickOpen] = useState(() => localStorage.getItem('shell-quick-open') !== 'false')
  const [shellTermReady, setShellTermReady] = useState(false)

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

  // Logs tab: load initial logs + subscribe to streaming output
  useEffect(() => {
    if (viewTab !== 'logs' || !envStatus) return
    // Load initial logs for all services (only once)
    if (!logsInitialized.current) {
      logsInitialized.current = true
      const loadAll = async () => {
        const entries: Array<{ service: string; line: string; ts: number }> = []
        for (const svc of envStatus.services) {
          try {
            const content = await window.api.env.logs(envStatus.id, svc.name, 100)
            if (content) {
              for (const line of content.split('\n')) {
                if (line.trim()) entries.push({ service: svc.name, line, ts: Date.now() })
              }
            }
          } catch { /* skip */ }
        }
        setLogsContent(entries)
      }
      loadAll()
    }
    // Subscribe to streaming output
    const unsub = window.api.env.onServiceOutput((data) => {
      if (data.envId !== envStatus.id) return
      const lines = data.data.split('\n').filter((l: string) => l.trim())
      if (lines.length === 0) return
      setLogsContent(prev => {
        const newEntries = lines.map((line: string) => ({ service: data.service, line, ts: Date.now() }))
        const combined = [...prev, ...newEntries]
        // Keep last 2000 lines to avoid memory bloat
        return combined.length > 2000 ? combined.slice(-2000) : combined
      })
    })
    return unsub
  }, [viewTab, envStatus])

  // Auto-scroll logs
  useEffect(() => {
    if (logsAutoScroll.current && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logsContent])
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
      theme: { background: '#1a1a2e', foreground: '#e0e0e0', cursor: '#e0e0e0' },
      allowProposedApi: true,
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
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
      term, fitAddon,
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

  // Resize shell terminal on window resize
  useEffect(() => {
    if (viewTab !== 'shell' || !shellTermRef.current) return
    const handleResize = () => shellTermRef.current?.fitAddon.fit()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [viewTab])

  const fileSearchInputRef = useRef<HTMLInputElement>(null)
  const previewContentRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [showIgnoreSettings, setShowIgnoreSettings] = useState(false)
  const [ignoreRules, setIgnoreRules] = useState<string[]>([])
  const [ignoreInput, setIgnoreInput] = useState('')

  // Debounce search input → query (150ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setFileSearchQuery(fileSearchInput)
      setFileSearchIndex(0)
    }, 150)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fileSearchInput])

  // Auto-load more results — use callback ref for the sentinel
  const loadMoreCallbackRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisibleResultCount((p) => p + 30)
      }
    }, { threshold: 0.1 })
    observer.observe(el)
    // Cleanup on unmount via MutationObserver trick — observer disconnects when element is removed
    const parent = el.parentElement
    if (parent) {
      const mo = new MutationObserver(() => {
        if (!parent.contains(el)) { observer.disconnect(); mo.disconnect() }
      })
      mo.observe(parent, { childList: true })
    }
  }, [])

  // Load custom ignore rules
  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      if (s.searchIgnore) {
        setIgnoreRules(s.searchIgnore.split(',').map((r: string) => r.trim()).filter(Boolean))
      }
    })
  }, [])

  // Compute highlighted HTML + match count (memoized, only recomputes when inputs change)
  const { highlightedHtml, fileMatchCount } = (() => {
    if (!fileContent || !fileSearchQuery) return { highlightedHtml: '', fileMatchCount: 0 }
    const { html, count } = buildHighlightedHtml(fileContent, fileSearchQuery, fileSearchIndex)
    return { highlightedHtml: html, fileMatchCount: count }
  })()

  // Scroll to active match
  useEffect(() => {
    if (!fileSearchQuery || !previewContentRef.current) return
    requestAnimationFrame(() => {
      const el = previewContentRef.current?.querySelector('.filetree-search-highlight.active')
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' })
    })
  }, [fileSearchIndex, fileSearchQuery, fileContent])

  // Debounce content search (300ms)
  useEffect(() => {
    if (searchMode !== 'content' || !contentSearch || contentSearch.length < 2) {
      setContentResults(null)
      return
    }
    if (contentDebounceRef.current) clearTimeout(contentDebounceRef.current)
    setContentSearching(true)
    setVisibleResultCount(20)
    contentDebounceRef.current = setTimeout(async () => {
      const results = await window.api.fs.searchContent(instance.workingDirectory, contentSearch, ignoreRules)
      setContentResults(results)
      setContentSearching(false)
    }, 300)
    return () => { if (contentDebounceRef.current) clearTimeout(contentDebounceRef.current) }
  }, [contentSearch, searchMode, instance.workingDirectory])

  // Cmd+F on Files tab opens file search
  useEffect(() => {
    if (viewTab !== 'files' || !focused) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setFileSearchOpen(true)
        setTimeout(() => fileSearchInputRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', handler, true) // capture phase to beat terminal search
    return () => window.removeEventListener('keydown', handler, true)
  }, [viewTab, focused])

  const loadFileTree = useCallback(async () => {
    setFileTreeLoading(true)
    try {
      const tree = await window.api.fs.listDir(instance.workingDirectory, 2)
      setFileTree(tree)
      // Auto-expand root + top-level directories
      const initial = new Set<string>()
      initial.add(instance.workingDirectory)
      for (const node of tree) {
        if (node.type === 'directory') initial.add(node.path)
      }
      setExpandedPaths((prev) => {
        // Merge with existing expanded paths so user state is preserved on refresh
        const merged = new Set(prev)
        for (const p of initial) merged.add(p)
        return merged
      })
    } catch {
      setFileTree([])
    }
    setFileTreeLoading(false)
  }, [instance.workingDirectory])

  // Load file tree when tab switches to files
  useEffect(() => {
    if (viewTab === 'files' && !fileTree) {
      loadFileTree()
    }
  }, [viewTab, fileTree, loadFileTree])

  // Load replay events when tab switches to replay
  useEffect(() => {
    if (viewTab !== 'replay') return
    setReplayLoading(true)
    window.api.session.getReplay(instance.id).then((events) => {
      setReplayEvents(events)
      setReplayLoading(false)
    }).catch(() => {
      setReplayEvents([])
      setReplayLoading(false)
    })
  }, [viewTab, instance.id])

  const handleTogglePath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const handleLoadChildren = useCallback(async (path: string) => {
    const result = await window.api.fs.listDir(path, 1)
    setLazyChildren((prev) => {
      const next = new Map(prev)
      next.set(path, result)
      return next
    })
  }, [])

  const handleExpandAll = useCallback(async (path: string) => {
    // Fetch a deep tree from this path
    const deepTree = await window.api.fs.listDir(path, 4)

    // Flatten all directory→children mappings into lazyChildren
    const toStore = new Map<string, FileNode[]>()
    const toExpand = new Set<string>()
    toExpand.add(path)
    toStore.set(path, deepTree)

    const walk = (nodes: FileNode[]) => {
      for (const n of nodes) {
        if (n.type === 'directory') {
          toExpand.add(n.path)
          if (n.children) {
            toStore.set(n.path, n.children)
            walk(n.children)
          }
        }
      }
    }
    walk(deepTree)

    setLazyChildren((prev) => {
      const next = new Map(prev)
      for (const [k, v] of toStore) next.set(k, v)
      return next
    })
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      for (const p of toExpand) next.add(p)
      return next
    })
  }, [])

  const handleCollapseAll = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev)
      // Remove the path itself and anything under it
      for (const p of prev) {
        if (p === path || p.startsWith(path + '/')) {
          next.delete(p)
        }
      }
      return next
    })
  }, [])

  const handleSelectFile = useCallback(async (path: string) => {
    setSelectedFile(path)
    setFileContent(null)
    setFileError(null)
    setFileLoading(true)
    const result = await window.api.fs.readFile(path)
    setFileLoading(false)
    if (result.error) {
      setFileError(result.error)
    } else {
      setFileContent(result.content ?? '')
    }
  }, [])

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

  const handleSearchNext = useCallback(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (entry && searchQuery) entry.searchAddon.findNext(searchQuery)
  }, [instance.id, terminalsRef, searchQuery])

  const handleSearchPrev = useCallback(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (entry && searchQuery) entry.searchAddon.findPrevious(searchQuery)
  }, [instance.id, terminalsRef, searchQuery])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) handleSearchPrev()
      else handleSearchNext()
    }
    if (e.key === 'Escape') {
      const entry = terminalsRef.current.get(instance.id)
      entry?.searchAddon.clearDecorations()
      setSearchQuery('')
      onSearchClose?.()
    }
  }, [handleSearchNext, handleSearchPrev, instance.id, onSearchClose, terminalsRef])

  // Live search as you type
  useEffect(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (!entry) return
    if (searchQuery) {
      entry.searchAddon.findNext(searchQuery)
    } else {
      entry.searchAddon.clearDecorations()
    }
  }, [searchQuery, instance.id, terminalsRef])

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return
    initializedRef.current = true

    let existing = terminalsRef.current.get(instance.id)

    if (!existing) {
      const term = new Terminal({
        theme: {
          background: '#000000',
          foreground: '#e0e0e0',
          cursor: 'transparent',
          selectionBackground: '#3b82f650',
        },
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
      if (viewTab !== 'terminal' || !focused) return
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

  return (
    <>
      <div className={`terminal-header ${focused ? 'focused' : 'unfocused'}`} onClick={onFocusPane}>
        <div className="terminal-header-accent" style={{ backgroundColor: focused ? instance.color : 'transparent' }} />
        <div className="terminal-header-left">
          <span className="terminal-header-name" style={{ color: instance.color }}>{instance.name}</span>
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
            <button
              className={`terminal-tab ${viewTab === 'replay' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('replay') }}
              title="Tool call replay log"
            >
              <History size={12} /> Replay
            </button>
          </div>
          {viewTab === 'session' && <HelpPopover topic="sessionTab" />}
          {viewTab === 'files' && <HelpPopover topic="filesTab" />}
          {viewTab === 'shell' && <HelpPopover topic="terminalTab" />}
          {viewTab === 'services' && <HelpPopover topic="servicesTab" />}
          {viewTab === 'logs' && <HelpPopover topic="logsTab" />}
          {viewTab === 'replay' && <HelpPopover topic="replayTab" />}
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
                    // Unsubscribe old listener
                    entry.unsub?.()

                    entry.term.reset()

                    // Queue live events until buffer replay finishes (same pattern as initial mount)
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
          {!isSplit && onSplit && (
            <Tooltip text="Split View" detail="Open a second session side-by-side" shortcut="Cmd+\">
              <button onClick={onSplit} aria-label="Split view">
                <Columns2 size={14} /> Split
              </button>
            </Tooltip>
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
          <span className={`session-status-item session-status-cost ${instance.tokenUsage.cost >= 1.0 ? 'red' : instance.tokenUsage.cost >= 0.10 ? 'amber' : 'green'}`} tabIndex={-1}>
            ${instance.tokenUsage.cost.toFixed(3)}
          </span>
          {outputBytes >= 250 * 1024 && (
            <span className={`session-status-item session-status-ctx ${outputBytes >= 600 * 1024 ? 'red' : 'amber'}`} tabIndex={-1} title="Context window pressure — terminal output is large, approaching context limit">
              <span className={`session-status-dot ${outputBytes >= 600 * 1024 ? 'red' : 'amber'}`} />
              ctx
            </span>
          )}
        </div>
      )}
      {viewTab === 'files' && (
        <div className="filetree-panel">
          <div className="filetree-split">
            <div className="filetree-sidebar">
              <div className="filetree-header">
                <span className="filetree-root-path">{instance.workingDirectory.split('/').pop()}</span>
                <button className="filetree-refresh" onClick={() => window.api.shell.openExternal(`file://${instance.workingDirectory}`)} title="Open in Finder">
                  <FolderOpen size={13} />
                </button>
                <button className="filetree-refresh" onClick={() => setShowIgnoreSettings(!showIgnoreSettings)} title="Ignore rules">
                  <Settings size={13} />
                </button>
                <button className="filetree-refresh" onClick={() => { setFileTree(null); loadFileTree() }} title="Refresh">
                  <RefreshCw size={13} />
                </button>
                <button
                  className={`filetree-refresh filetree-sort-toggle ${filesSortMode === 'modified' ? 'active' : ''}`}
                  onClick={() => setFilesSortMode(m => m === 'name' ? 'modified' : 'name')}
                  title={filesSortMode === 'name' ? 'Currently: Name — click to group by file type' : 'Currently: Type (grouped by extension) — click for Name'}
                  aria-label={filesSortMode === 'name' ? 'Sort by name' : 'Sort by type'}
                >
                  <ArrowUpDown size={13} />
                  <span style={{ fontSize: '10px', marginLeft: '2px' }}>{filesSortMode === 'name' ? 'Name' : 'Type'}</span>
                </button>
              </div>
              {showIgnoreSettings && (
                <div className="filetree-ignore-panel">
                  <div className="filetree-ignore-label">Ignored directories</div>
                  <div className="filetree-ignore-defaults">
                    Default: .git, node_modules, dist, build, out, .cache, coverage
                  </div>
                  <div className="filetree-ignore-tags">
                    {ignoreRules.map((rule) => (
                      <span key={rule} className="filetree-ignore-tag">
                        {rule}
                        <button title="Remove rule" onClick={() => {
                          const updated = ignoreRules.filter((r) => r !== rule)
                          setIgnoreRules(updated)
                          window.api.settings.set('searchIgnore', updated.join(','))
                        }}><X size={10} /></button>
                      </span>
                    ))}
                  </div>
                  <div className="filetree-ignore-add">
                    <input
                      placeholder="Add ignore pattern..."
                      value={ignoreInput}
                      onChange={(e) => setIgnoreInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && ignoreInput.trim()) {
                          const updated = [...ignoreRules, ignoreInput.trim()]
                          setIgnoreRules(updated)
                          window.api.settings.set('searchIgnore', updated.join(','))
                          setIgnoreInput('')
                        }
                        if (e.key === 'Escape') setShowIgnoreSettings(false)
                      }}
                    />
                  </div>
                </div>
              )}
              <div className="filetree-filter">
                <div className="filetree-search-mode">
                  <button
                    className={searchMode === 'files' ? 'active' : ''}
                    onClick={() => { setSearchMode('files'); setContentSearch(''); setContentResults(null) }}
                    title="Filter by filename"
                  >
                    <File size={11} />
                  </button>
                  <button
                    className={searchMode === 'content' ? 'active' : ''}
                    onClick={() => { setSearchMode('content'); setTreeFilter('') }}
                    title="Search file contents"
                  >
                    <Search size={11} />
                  </button>
                </div>
                {searchMode === 'files' ? (
                  <input
                    placeholder="Filter files..."
                    value={treeFilter}
                    onChange={(e) => setTreeFilter(e.target.value)}
                  />
                ) : (
                  <input
                    placeholder="Search in files..."
                    value={contentSearch}
                    onChange={(e) => setContentSearch(e.target.value)}
                  />
                )}
                {(treeFilter || contentSearch) && (
                  <button title="Clear filter" onClick={() => { setTreeFilter(''); setContentSearch(''); setContentResults(null) }}><X size={12} /></button>
                )}
              </div>
              {searchMode === 'content' && contentResults && contentResults.length > 0 && (
                <div className="filetree-search-result-count">
                  {contentResults.length} file{contentResults.length !== 1 ? 's' : ''} matched
                </div>
              )}
              <div className="filetree-scroll">
                {searchMode === 'content' && contentSearch.length >= 2 && (
                  <>
                    {contentSearching && <div className="filetree-loading">Searching...</div>}
                    {contentResults && contentResults.length === 0 && !contentSearching && (
                      <div className="filetree-empty" style={{ padding: '12px' }}>No matches found</div>
                    )}
                    {(() => {
                      if (!contentResults) return null
                      // Group results by directory for tree view
                      const byDir = new Map<string, typeof contentResults>()
                      for (const result of contentResults.slice(0, visibleResultCount)) {
                        const relPath = result.file.replace(instance.workingDirectory + '/', '')
                        const dirParts = relPath.split('/')
                        const dir = dirParts.length > 1 ? dirParts.slice(0, -1).join('/') : '.'
                        if (!byDir.has(dir)) byDir.set(dir, [])
                        byDir.get(dir)!.push(result)
                      }
                      return Array.from(byDir.entries()).map(([dir, results]) => (
                        <div key={dir} className="filetree-search-group">
                          <div className="filetree-search-group-header">
                            <Folder size={12} className="filetree-icon dir" />
                            <span>{dir}</span>
                          </div>
                          {results.map((result) => {
                            const fileName = result.file.split('/').pop()
                            return (
                              <div key={result.file} className="filetree-search-result">
                                <div
                                  className="filetree-search-result-file"
                                  onClick={() => handleSelectFile(result.file)}
                                >
                                  <File size={13} className="filetree-icon file" />
                                  <span className="filetree-search-result-name">{fileName}</span>
                                </div>
                                {result.matches.map((m, i) => (
                                  <div
                                    key={i}
                                    className="filetree-search-result-line"
                                    onClick={() => {
                                      handleSelectFile(result.file)
                                      setFileSearchInput(contentSearch)
                                      setFileSearchQuery(contentSearch)
                                      setFileSearchOpen(true)
                                    }}
                                  >
                                    <span className="filetree-search-result-linenum">{m.line}</span>
                                    <span className="filetree-search-result-text">{m.text}</span>
                                  </div>
                                ))}
                              </div>
                            )
                          })}
                        </div>
                      ))
                    })()}
                    {contentResults && visibleResultCount < contentResults.length && (
                      <div
                        ref={loadMoreCallbackRef}
                        className="filetree-search-load-more"
                        onClick={() => setVisibleResultCount((p) => p + 30)}
                      >
                        Show more ({contentResults.length - visibleResultCount} remaining)
                      </div>
                    )}
                  </>
                )}
                {searchMode === 'files' && fileTreeLoading && <div className="filetree-loading">Loading...</div>}
                {searchMode === 'files' && sortedFileTree && (
                  <FileTreeNode
                    node={{
                      name: instance.workingDirectory.split('/').pop() || '/',
                      path: instance.workingDirectory,
                      type: 'directory',
                      children: sortedFileTree,
                    }}
                    depth={0}
                    selectedPath={selectedFile}
                    expandedPaths={expandedPaths}
                    filter={treeFilter}
                    onTogglePath={handleTogglePath}
                    onExpandAll={handleExpandAll}
                    onCollapseAll={handleCollapseAll}
                    onSelectFile={handleSelectFile}
                    lazyChildren={sortedLazyChildren}
                    onLoadChildren={handleLoadChildren}
                  />
                )}
              </div>
            </div>
            <div className="filetree-preview">
              {!selectedFile && (
                <div className="filetree-preview-empty">Select a file to preview</div>
              )}
              {selectedFile && (
                <>
                  <div className="filetree-preview-header">
                    <span className="filetree-preview-name">{selectedFile.split('/').pop()}</span>
                    <span className="filetree-preview-path">{selectedFile}</span>
                    <button
                      className="filetree-preview-paste"
                      onClick={() => {
                        const text = selectedFile.includes(' ') ? `"${selectedFile}"` : selectedFile
                        window.api.instance.write(instance.id, text + ' ')
                        setViewTab('terminal')
                      }}
                      title="Paste path to terminal"
                    >
                      <TerminalSquare size={12} /> Paste Path
                    </button>
                    <button
                      className={`filetree-preview-wrap ${wordWrap ? 'active' : ''}`}
                      onClick={() => setWordWrap(!wordWrap)}
                      title={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
                    >
                      <WrapText size={12} />
                    </button>
                  </div>
                  {fileSearchOpen && (
                    <div className="filetree-search-bar">
                      <Search size={12} />
                      <input
                        ref={fileSearchInputRef}
                        placeholder="Search in file..."
                        value={fileSearchInput}
                        onChange={(e) => setFileSearchInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') { setFileSearchOpen(false); setFileSearchInput(''); setFileSearchQuery(''); setFileSearchIndex(0) }
                          if (e.key === 'Enter' && fileMatchCount > 0) {
                            if (e.shiftKey) {
                              setFileSearchIndex((prev) => (prev - 1 + fileMatchCount) % fileMatchCount)
                            } else {
                              setFileSearchIndex((prev) => (prev + 1) % fileMatchCount)
                            }
                          }
                        }}
                      />
                      {fileSearchQuery && fileMatchCount > 0 && (
                        <span className="filetree-search-count">
                          {fileSearchIndex + 1} / {fileMatchCount}
                        </span>
                      )}
                      {fileSearchQuery && fileMatchCount === 0 && (
                        <span className="filetree-search-count">No matches</span>
                      )}
                      <button title="Previous (Shift+Enter)" onClick={() => fileMatchCount > 0 && setFileSearchIndex((prev) => (prev - 1 + fileMatchCount) % fileMatchCount)}><ChevronUp size={13} /></button>
                      <button title="Next (Enter)" onClick={() => fileMatchCount > 0 && setFileSearchIndex((prev) => (prev + 1) % fileMatchCount)}><ChevronDown size={13} /></button>
                      <button title="Close search" onClick={() => { setFileSearchOpen(false); setFileSearchInput(''); setFileSearchQuery(''); setFileSearchIndex(0) }}><X size={12} /></button>
                    </div>
                  )}
                  <div className="filetree-preview-content" ref={previewContentRef}>
                    {fileLoading && <div className="filetree-preview-empty">Loading...</div>}
                    {fileError && <div className="filetree-preview-error">{fileError}</div>}
                    {fileContent !== null && (() => {
                      const raw = fileSearchQuery && highlightedHtml ? highlightedHtml : escapeHtml(fileContent)
                      const lines = raw.split('\n')
                      const gutterWidth = String(lines.length).length
                      const html = lines.map((line, i) =>
                        `<span class="filetree-line"><span class="filetree-linenum" style="min-width:${gutterWidth}ch">${i + 1}</span><span class="filetree-linecode">${line || ' '}</span></span>`
                      ).join('\n')
                      return <pre className={`filetree-preview-code ${wordWrap ? 'word-wrap' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
                    })()}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
      {viewTab === 'services' && envStatus && (
        <div className="services-panel">
          {/* Header: name, status, actions */}
          <div className="services-panel-header">
            <span className="services-panel-env-name">{envStatus.displayName || envStatus.name}</span>
            <span className={`services-panel-env-status ${envStatus.status}`}>{envStatus.status}</span>
            <div className="services-panel-actions">
              {(envStatus.status === 'stopped' || envStatus.status === 'partial' || envStatus.services.some(s => s.status === 'crashed' || s.status === 'stopped')) && (
                <button className="services-panel-btn" onClick={() => window.api.env.start(envStatus.id)} title="Start all services">
                  <Play size={12} /> Start All
                </button>
              )}
              {(envStatus.status === 'running' || envStatus.status === 'partial') && (
                <button className="services-panel-btn" onClick={() => window.api.env.stop(envStatus.id)} title="Stop all services">
                  <Square size={10} /> Stop All
                </button>
              )}
              {envStatus.paths?.root && (
                <button className="services-panel-btn" onClick={() => window.api.shell.openExternal(`file://${envStatus.paths.root}`)} title="Open environment folder in Finder">
                  <FolderOpen size={12} />
                </button>
              )}
              <div className="services-panel-fix-wrap">
                <button
                  className={`services-panel-btn ${fixMenuOpen ? 'active' : ''}`}
                  onClick={() => setFixMenuOpen(!fixMenuOpen)}
                  title="Fix / diagnose environment"
                >
                  <Stethoscope size={12} />
                </button>
                {fixMenuOpen && (
                  <div className="services-panel-fix-dropdown" onClick={(e) => e.stopPropagation()}>
                    <button className="services-panel-fix-item" onClick={async () => {
                      setFixMenuOpen(false)
                      try {
                        setFixInProgress(true)
                        setFixResult(null)
                        await window.api.env.stop(envStatus.id).catch(() => {})
                        const result = await window.api.env.fix(envStatus.id)
                        setFixResult({ lines: result.fixed })
                        setTimeout(() => setFixResult(prev => prev && !prev.isError ? null : prev), 8000)
                      } catch (err: any) {
                        setFixResult({ lines: [err.message || String(err)], isError: true })
                        setTimeout(() => setFixResult(prev => prev?.isError ? null : prev), 8000)
                      } finally {
                        setFixInProgress(false)
                      }
                    }}>
                      <RefreshCw size={12} />
                      <div>
                        <div className="services-panel-fix-title">Quick Fix</div>
                        <div className="services-panel-fix-desc">Re-resolve ports and variables from template</div>
                      </div>
                    </button>
                    <button className="services-panel-fix-item" onClick={async () => {
                      setFixMenuOpen(false)
                      try {
                        const [manifest, setupLog] = await Promise.all([
                          window.api.env.manifest(envStatus.id),
                          window.api.env.logs(envStatus.id, 'setup', 200).catch(() => '(no setup log)'),
                        ])
                        const templateId = manifest?.meta?.templateId as string | undefined
                        const template = templateId ? await window.api.env.getTemplate(templateId).catch(() => null) : null
                        const hasCrashedServices = envStatus.services.some(s => s.status === 'crashed')
                        const { systemPrompt, initialPrompt } = buildDiagnosePrompt({
                          env: envStatus, manifest, setupLog, template,
                          isError: envStatus.status === 'error', hasCrashedServices,
                        })
                        let promptArgs: string[]
                        try {
                          const promptFile = await window.api.fs.writeTempFile(`env-${envStatus.name}`, systemPrompt)
                          promptArgs = ['--append-system-prompt-file', promptFile]
                        } catch {
                          promptArgs = ['--append-system-prompt', systemPrompt]
                        }
                        await window.api.instance.create({
                          name: `Fix: ${envStatus.displayName || envStatus.name}`,
                          workingDirectory: envStatus.paths.root || instance.workingDirectory,
                          color: '#ef4444',
                          args: [...promptArgs, '--prompt', initialPrompt],
                        })
                      } catch (err: any) {
                        setFixResult({ lines: [err.message || String(err)], isError: true })
                        setTimeout(() => setFixResult(prev => prev?.isError ? null : prev), 8000)
                      }
                    }}>
                      <MessageSquare size={12} />
                      <div>
                        <div className="services-panel-fix-title">Diagnose with AI</div>
                        <div className="services-panel-fix-desc">Launch AI agent with logs and manifest context</div>
                      </div>
                    </button>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Fix result banner */}
          {fixResult && (
            <div className={`services-panel-fix-result ${fixResult.isError ? 'error' : 'success'}`}>
              <div className="services-panel-fix-result-header">
                {fixResult.isError ? <AlertTriangle size={13} /> : <CheckCircle size={13} />}
                <span>{fixResult.isError ? 'Fix failed' : 'Environment fixed'}</span>
                <button onClick={() => setFixResult(null)}><X size={11} /></button>
              </div>
              <div className="services-panel-fix-result-items">
                {fixResult.lines.map((line, i) => <div key={i}>{line}</div>)}
              </div>
            </div>
          )}

          {/* URLs — prominent, at top */}
          {Object.keys(envStatus.urls).length > 0 && (
            <div className="services-panel-urls">
              <div className="services-panel-section-label">URLs</div>
              <div className="services-panel-url-list">
                {Object.entries(envStatus.urls).map(([name, url]) => (
                  <button key={name} className="services-panel-url" onClick={() => window.api.shell.openExternal(url)} title={url}>
                    <ExternalLink size={11} /> <span className="services-panel-url-name">{name}</span> <span className="services-panel-url-value">{url}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Services list */}
          <div className="services-panel-list">
            <div className="services-panel-section-label">Services</div>
            {envStatus.services.map((svc) => {
              const isActive = envLogs?.service === svc.name
              const matchingUrl = Object.entries(envStatus.urls).find(([k]) => k.toLowerCase() === svc.name.toLowerCase())?.[1]
                || (svc.port ? `http://localhost:${svc.port}` : null)
              return (
                <div key={svc.name} className={`services-panel-row ${isActive ? 'active' : ''} ${svc.status === 'crashed' ? 'crashed' : ''}`}>
                  <div className="services-panel-row-main">
                    <div className="services-panel-row-left">
                      <span className={`services-panel-status-dot ${svc.status}`} />
                      <span className="services-panel-svc-name">{svc.name}</span>
                      <span className={`services-panel-svc-badge ${svc.status}`}>{svc.status}</span>
                    </div>
                    <div className="services-panel-row-meta">
                      {svc.port && <span className="services-panel-port">:{svc.port}</span>}
                      {svc.status === 'running' && svc.uptime > 0 && (
                        <span className="services-panel-uptime"><Activity size={10} /> {formatUptime(svc.uptime)}</span>
                      )}
                      {svc.restarts > 0 && (
                        <span className="services-panel-restarts" title={`${svc.restarts} restart${svc.restarts > 1 ? 's' : ''}`}>
                          <AlertTriangle size={10} /> {svc.restarts}
                        </span>
                      )}
                    </div>
                    <div className="services-panel-row-actions">
                      {matchingUrl && svc.status === 'running' && (
                        <button title={`Open ${matchingUrl}`} onClick={() => window.api.shell.openExternal(matchingUrl)}>
                          <ExternalLink size={12} />
                        </button>
                      )}
                      <button
                        title="View logs"
                        className={isActive ? 'active' : ''}
                        onClick={() => {
                          if (isActive) { setEnvLogs(null) }
                          else { window.api.env.logs(envStatus.id, svc.name, 200).then((content) => setEnvLogs({ service: svc.name, content })) }
                        }}
                      >
                        <ScrollText size={13} />
                      </button>
                      <button title={`Restart ${svc.name}`} onClick={() => window.api.env.restartService(envStatus.id, svc.name)}>
                        <RotateCcw size={13} />
                      </button>
                      {svc.status === 'running' ? (
                        <button title={`Stop ${svc.name}`} onClick={() => window.api.env.stop(envStatus.id, [svc.name])}>
                          <Square size={11} />
                        </button>
                      ) : (
                        <button title={`Start ${svc.name}`} onClick={() => window.api.env.start(envStatus.id, [svc.name])}>
                          <Play size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Inline log viewer */}
          {envLogs && (
            <div className="services-panel-logs">
              <div className="services-panel-logs-header">
                <span><ScrollText size={11} /> {envLogs.service} logs</span>
                <div className="services-panel-logs-actions">
                  <button title="Refresh" onClick={() => window.api.env.logs(envStatus.id, envLogs.service, 200).then((content) => setEnvLogs({ service: envLogs.service, content }))}><RefreshCw size={11} /></button>
                  <button title="Close" onClick={() => setEnvLogs(null)}><X size={12} /></button>
                </div>
              </div>
              <pre className="services-panel-logs-content">{envLogs.content}</pre>
            </div>
          )}

          {/* Ports & Paths */}
          {(Object.keys(envStatus.ports).length > 0 || Object.keys(envStatus.paths).length > 0) && (
            <div className="services-panel-meta">
              {Object.keys(envStatus.ports).length > 0 && (
                <div className="services-panel-meta-group">
                  <div className="services-panel-section-label">Ports</div>
                  <div className="services-panel-badges">
                    {Object.entries(envStatus.ports).map(([name, port]) => (
                      <span key={name} className="services-panel-badge">{name}: {port}</span>
                    ))}
                  </div>
                </div>
              )}
              {Object.keys(envStatus.paths).length > 0 && (
                <div className="services-panel-meta-group">
                  <div className="services-panel-section-label">Paths</div>
                  <div className="services-panel-paths">
                    {Object.entries(envStatus.paths).map(([name, path]) => (
                      <div key={name} className="services-panel-path-row">
                        <span className="services-panel-path-label">{name}</span>
                        <span className="services-panel-path-value" title={path}>{path}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {viewTab === 'logs' && envStatus && (
        <div className="logs-panel">
          <div className="logs-panel-header">
            <div className="logs-panel-filters-wrap">
              <div className="logs-panel-filters">
                <button
                  className={`logs-filter-btn ${logsFilter === null ? 'active' : ''}`}
                  onClick={() => setLogsFilter(null)}
                >
                  All
                </button>
                {envStatus.services.map(svc => (
                  <button
                    key={svc.name}
                    className={`logs-filter-btn ${logsFilter === svc.name ? 'active' : ''}`}
                    onClick={() => setLogsFilter(logsFilter === svc.name ? null : svc.name)}
                  >
                    <span className={`logs-filter-dot ${svc.status}`} />
                    {svc.name}
                  </button>
                ))}
              </div>
              <div className="logs-level-filters">
                {(['all', 'error', 'warn'] as const).map(level => (
                  <button
                    key={level}
                    className={`logs-filter-btn logs-level-btn ${logsLevelFilter === level ? 'active' : ''} ${level !== 'all' ? level : ''}`}
                    onClick={() => setLogsLevelFilter(level)}
                  >
                    {level === 'all' ? 'All' : level.charAt(0).toUpperCase() + level.slice(1)}
                  </button>
                ))}
              </div>
            </div>
            <div className="logs-panel-actions">
              <button
                className="logs-action-btn"
                title="Clear logs"
                onClick={() => setLogsContent([])}
              >
                <Trash2 size={12} />
              </button>
              <button
                className={`logs-action-btn ${logsAutoScroll.current ? 'active' : ''}`}
                title="Follow latest output"
                onClick={() => { logsAutoScroll.current = !logsAutoScroll.current }}
              >
                <ChevronsDown size={12} />
              </button>
            </div>
          </div>
          <div className="logs-panel-content" onScroll={(e) => {
            const el = e.currentTarget
            const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
            logsAutoScroll.current = atBottom
          }}>
            {logsContent
              .filter(entry => (logsFilter === null || entry.service === logsFilter) && levelMatches(entry.line, logsLevelFilter))
              .map((entry, i) => (
                <div key={i} className="logs-line">
                  <span className={`logs-line-service ${entry.service}`}>{entry.service}</span>
                  <span className="logs-line-text">{entry.line}</span>
                </div>
              ))
            }
            {logsContent.filter(entry => (logsFilter === null || entry.service === logsFilter) && levelMatches(entry.line, logsLevelFilter)).length === 0 && (
              <div className="logs-empty">
                {logsContent.length === 0 ? 'No logs yet. Start services to see output.' : 'No logs match the current filters.'}
              </div>
            )}
            <div ref={logsEndRef} />
          </div>
        </div>
      )}
      {viewTab === 'replay' && (
        <div className="replay-panel">
          <div className="replay-panel-header">
            <span className="replay-panel-title">
              <History size={13} /> Tool Call Replay
            </span>
            <button
              className="replay-refresh-btn"
              title="Refresh"
              onClick={() => {
                setReplayLoading(true)
                window.api.session.getReplay(instance.id).then((events) => {
                  setReplayEvents(events)
                  setReplayLoading(false)
                }).catch(() => {
                  setReplayEvents([])
                  setReplayLoading(false)
                })
              }}
            >
              <RefreshCw size={12} />
            </button>
          </div>
          <div className="replay-panel-content">
            {replayLoading && (
              <div className="replay-empty">Loading...</div>
            )}
            {!replayLoading && replayEvents.length === 0 && (
              <div className="replay-empty">No tool calls recorded yet.</div>
            )}
            {!replayLoading && replayEvents.map((event, i) => {
              const expanded = replayExpanded.has(i)
              const tsDate = new Date(event.ts)
              const relTime = (() => {
                const diffMs = Date.now() - tsDate.getTime()
                const diffSec = Math.floor(diffMs / 1000)
                if (diffSec < 60) return `${diffSec}s ago`
                if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
                const h = Math.floor(diffSec / 3600)
                const m = Math.floor((diffSec % 3600) / 60)
                return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`
              })()
              return (
                <div
                  key={i}
                  className={`replay-event ${expanded ? 'expanded' : ''}`}
                  onClick={() => setReplayExpanded(prev => {
                    const next = new Set(prev)
                    if (next.has(i)) next.delete(i)
                    else next.add(i)
                    return next
                  })}
                >
                  <div className="replay-event-header">
                    <span className="replay-event-tool">{event.tool}</span>
                    <span className="replay-event-input">{event.inputSummary}</span>
                    <span className="replay-event-time" title={event.ts}>
                      <Clock size={10} /> {relTime}
                    </span>
                    <ChevronRight size={12} className={`replay-event-chevron ${expanded ? 'expanded' : ''}`} />
                  </div>
                  {expanded && (
                    <div className="replay-event-body">
                      <div className="replay-event-section">
                        <span className="replay-event-label">Input (preview)</span>
                        <pre className="replay-event-pre">{event.inputSummary || '(none)'}</pre>
                      </div>
                      <div className="replay-event-section">
                        <span className="replay-event-label">Output (preview)</span>
                        <pre className="replay-event-pre">{event.outputSummary || '(none)'}</pre>
                      </div>
                      <div className="replay-event-section">
                        <span className="replay-event-label">Timestamp</span>
                        <span className="replay-event-ts">{event.ts}</span>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
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
        {dragOver && (
          <div className="terminal-drop-overlay">Drop to paste path</div>
        )}
      </div>
    </>
  )
}
