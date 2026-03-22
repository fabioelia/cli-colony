import { useEffect, useRef, useCallback, useState, MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { TerminalProxy } from '../lib/terminal-proxy'
import { ChevronUp, ChevronDown, ChevronRight, Minimize2, Maximize2, X, RotateCcw, Trash2, GitBranch, TerminalSquare, FolderTree, File, Folder, FolderOpen, RefreshCw, Search, Settings, Columns2, ExternalLink } from 'lucide-react'
import '@xterm/xterm/css/xterm.css'
import type { ClaudeInstance } from '../types'

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
  isSplit?: boolean
  terminalsRef: MutableRefObject<Map<string, TerminalEntry>>
  searchOpen?: boolean
  onSearchClose?: () => void
  fontSize?: number
  focused?: boolean
  onFocusPane?: () => void
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

type ViewTab = 'terminal' | 'files'

export default function TerminalView({ instance, onKill, onRestart, onRemove, onSplit, onCloseSplit, isSplit, terminalsRef, searchOpen, onSearchClose, fontSize = 13, focused = true, onFocusPane }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [viewTab, setViewTab] = useState<ViewTab>('terminal')
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
  const [fileSearchIndex, setFileSearchIndex] = useState(0)
  const [treeFilter, setTreeFilter] = useState('')
  const [contentSearch, setContentSearch] = useState('')
  const [contentResults, setContentResults] = useState<Array<{ file: string; matches: Array<{ line: number; text: string }> }> | null>(null)
  const [contentSearching, setContentSearching] = useState(false)
  const [searchMode, setSearchMode] = useState<'files' | 'content'>('files')
  const [visibleResultCount, setVisibleResultCount] = useState(20)
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
    if (focused && viewTab === 'terminal') {
      const entry = terminalsRef.current.get(instance.id)
      if (entry) {
        // Double-RAF: first frame for DOM layout, second for final paint
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            entry.fitAddon.fit()
            const dims = entry.fitAddon.proposeDimensions()
            if (dims && dims.cols > 0 && dims.rows > 0) {
              // Resize bounce: shrink by 1 col then restore — sends SIGWINCH
              // to force Claude CLI to fully redraw its TUI
              window.api.instance.resize(instance.id, dims.cols - 1, dims.rows)
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

      const unsub = window.api.instance.onOutput(({ id, data }) => {
        if (id === instance.id) {
          proxy.write(data)
        }
      })

      existing = { term, fitAddon, searchAddon, proxy, unsub }
      terminalsRef.current.set(instance.id, existing)

      window.api.instance.buffer(instance.id).then((buf) => {
        if (buf) proxy.write(buf)
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
          // Resize bounce to trigger SIGWINCH for full TUI redraw
          window.api.instance.resize(instanceId, dims.cols - 1, dims.rows)
          setTimeout(() => {
            window.api.instance.resize(instanceId, dims.cols, dims.rows)
            existing!.term.scrollToBottom()
          }, 50)
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

  const handleDrop = useCallback((e: React.DragEvent) => {
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
        // Write each path character by character to the PTY input
        // so the CLI's input handler picks it up naturally
        const text = paths.join(' ') + ' '
        for (const ch of text) {
          window.api.instance.write(instance.id, ch)
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
              className={`terminal-tab ${viewTab === 'terminal' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('terminal') }}
            >
              <TerminalSquare size={12} /> Terminal
            </button>
            <button
              className={`terminal-tab ${viewTab === 'files' ? 'active' : ''}`}
              onClick={(e) => { e.stopPropagation(); setViewTab('files') }}
            >
              <FolderTree size={12} /> Files
            </button>
          </div>
          {instance.gitBranch && (
            <span className="terminal-header-branch"><GitBranch size={12} /> {instance.gitBranch}</span>
          )}
        </div>
        <div className="terminal-header-actions">
          {!isSplit && onSplit && (
            <button onClick={onSplit} aria-label="Split view" title="Split view">
              <Columns2 size={14} /> Split
            </button>
          )}
          {isSplit && onCloseSplit && (
            <button onClick={onCloseSplit} aria-label="Close split" title="Close split">
              <X size={14} /> Close
            </button>
          )}
        </div>
      </div>
      {viewTab === 'files' && (
        <div className="filetree-panel">
          <div className="filetree-split">
            <div className="filetree-sidebar">
              <div className="filetree-header">
                <span className="filetree-root-path">{instance.workingDirectory.split('/').pop()}</span>
                <button className="filetree-refresh" onClick={() => window.api.shell.openExternal(`file://${instance.workingDirectory}`)} title="Open in Finder">
                  <ExternalLink size={13} />
                </button>
                <button className="filetree-refresh" onClick={() => setShowIgnoreSettings(!showIgnoreSettings)} title="Ignore rules">
                  <Settings size={13} />
                </button>
                <button className="filetree-refresh" onClick={() => { setFileTree(null); loadFileTree() }} title="Refresh">
                  <RefreshCw size={13} />
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
                        <button onClick={() => {
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
                  <button onClick={() => { setTreeFilter(''); setContentSearch(''); setContentResults(null) }}><X size={12} /></button>
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
                {searchMode === 'files' && fileTree && (
                  <FileTreeNode
                    node={{
                      name: instance.workingDirectory.split('/').pop() || '/',
                      path: instance.workingDirectory,
                      type: 'directory',
                      children: fileTree,
                    }}
                    depth={0}
                    selectedPath={selectedFile}
                    expandedPaths={expandedPaths}
                    filter={treeFilter}
                    onTogglePath={handleTogglePath}
                    onExpandAll={handleExpandAll}
                    onCollapseAll={handleCollapseAll}
                    onSelectFile={handleSelectFile}
                    lazyChildren={lazyChildren}
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
                      <button onClick={() => { setFileSearchOpen(false); setFileSearchInput(''); setFileSearchQuery(''); setFileSearchIndex(0) }}><X size={12} /></button>
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
                      return <pre className="filetree-preview-code" dangerouslySetInnerHTML={{ __html: html }} />
                    })()}
                  </div>
                </>
              )}
            </div>
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
        style={{ display: viewTab === 'terminal' ? undefined : 'none' }}
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
    </>
  )
}
