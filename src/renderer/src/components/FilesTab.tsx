import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { ChevronUp, ChevronDown, ChevronRight, Minimize2, Maximize2, X, FolderOpen, FolderTree, File, Folder, RefreshCw, Search, Settings, TerminalSquare, WrapText, ArrowUpDown, Eye, Code } from 'lucide-react'
import { getFileIcon } from '../lib/file-icons'
import type { ClaudeInstance } from '../types'
import MarkdownViewer from './MarkdownViewer'

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
  const total = (text.match(regex) || []).length
  return { html, count: total }
}

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

function getParentPaths(filePath: string, rootDir: string): string[] {
  const parts: string[] = []
  let dir = filePath.substring(0, filePath.lastIndexOf('/'))
  while (dir.length > rootDir.length) {
    parts.push(dir)
    dir = dir.substring(0, dir.lastIndexOf('/'))
  }
  if (dir === rootDir) parts.push(dir)
  return parts
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

function fuzzyMatchStr(haystack: string, query: string): boolean {
  let hi = 0
  for (const ch of query) {
    const idx = haystack.indexOf(ch, hi)
    if (idx === -1) return false
    hi = idx + 1
  }
  return true
}

function nodeMatchesFilter(node: FileNode, filter: string, lazyChildren: Map<string, FileNode[]>): boolean {
  const q = filter.toLowerCase()
  if (fuzzyMatchStr(node.name.toLowerCase(), q)) return true
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
            {(() => { const FileIcon = getFileIcon(node.name); return <FileIcon size={14} className="filetree-icon file" /> })()}
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

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'])

interface FilesTabProps {
  instance: ClaudeInstance
  focused: boolean
  onSwitchToSession: () => void
  jumpFilePath?: string | null
  onJumpConsumed?: () => void
}

export default function FilesTab({ instance, focused, onSwitchToSession, jumpFilePath, onJumpConsumed }: FilesTabProps) {
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
  const [showIgnoreSettings, setShowIgnoreSettings] = useState(false)
  const [ignoreRules, setIgnoreRules] = useState<string[]>([])
  const [ignoreInput, setIgnoreInput] = useState('')
  const [filesSortMode, setFilesSortMode] = useState<'name' | 'modified'>('name')
  const [renderMd, setRenderMd] = useState(true)
  const [imageDataUrl, setImageDataUrl] = useState<string | null>(null)
  const [imageDims, setImageDims] = useState<string | null>(null)
  const [envRoots, setEnvRoots] = useState<Array<{alias: string, path: string}>>([])
  const treeFilterInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!jumpFilePath) return

    // Find the correct root for this path (primary or env sibling repo)
    const allRoots = [instance.workingDirectory, ...envRoots.map(r => r.path)]
    const root = allRoots.find(r => jumpFilePath.startsWith(r + '/')) ?? instance.workingDirectory
    const parents = getParentPaths(jumpFilePath, root)

    // Expand all parent directories (union — don't collapse already-open paths)
    setExpandedPaths(prev => {
      const next = new Set(prev)
      for (const p of parents) next.add(p)
      return next
    })

    // Lazy-load children for any unloaded parent directories
    for (const p of parents) {
      if (!lazyChildren.has(p)) {
        window.api.fs.listDir(p, 1).then(children => {
          setLazyChildren(prev => {
            const next = new Map(prev)
            next.set(p, children)
            return next
          })
        })
      }
    }

    handleSelectFile(jumpFilePath)
    onJumpConsumed?.()

    // Scroll selected row into view after React re-renders with expanded tree
    requestAnimationFrame(() => {
      const el = document.querySelector('.filetree-row.selected')
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      } else {
        // Fallback: lazy-loads may not have settled yet — retry after async ops
        setTimeout(() => {
          document.querySelector('.filetree-row.selected')?.scrollIntoView({ block: 'center', behavior: 'smooth' })
        }, 150)
      }
    })
  }, [jumpFilePath])

  const isMarkdown = useMemo(() => {
    if (!selectedFile) return false
    const lower = selectedFile.toLowerCase()
    return lower.endsWith('.md') || lower.endsWith('.markdown')
  }, [selectedFile])

  const isSvg = useMemo(() => selectedFile?.toLowerCase().endsWith('.svg') ?? false, [selectedFile])

  const isHtml = useMemo(() => {
    if (!selectedFile) return false
    const lower = selectedFile.toLowerCase()
    return lower.endsWith('.html') || lower.endsWith('.htm')
  }, [selectedFile])

  // Reset render mode on each new file
  useEffect(() => { setRenderMd(true) }, [selectedFile])

  // Auto-switch to source when in-file search opens on a markdown or HTML file
  useEffect(() => {
    if (fileSearchOpen && (isMarkdown || isHtml) && renderMd) setRenderMd(false)
  }, [fileSearchOpen, isMarkdown, isHtml, renderMd])

  const fileSearchInputRef = useRef<HTMLInputElement>(null)
  const previewContentRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const contentDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadMoreSentinelRef = useRef<HTMLDivElement | null>(null)

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

  // Debounce search input → query (150ms)
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setFileSearchQuery(fileSearchInput)
      setFileSearchIndex(0)
    }, 150)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [fileSearchInput])

  // Auto-load more results — IntersectionObserver
  useEffect(() => {
    const el = loadMoreSentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisibleResultCount((p) => p + 30)
      }
    }, { threshold: 0.1 })
    observer.observe(el)
    return () => observer.disconnect()
  }, [contentResults])

  // Load custom ignore rules
  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      if (s.searchIgnore) {
        setIgnoreRules(s.searchIgnore.split(',').map((r: string) => r.trim()).filter(Boolean))
      }
    })
  }, [])

  // One-shot: find the matching env and compute sibling repo roots
  useEffect(() => {
    if (typeof window.api?.env?.list !== 'function') return
    window.api.env.list().then((envs) => {
      const match = envs.find((e) => Object.values(e.paths).includes(instance.workingDirectory))
      if (!match) return
      const deduped = new Map<string, string>() // path → alias
      for (const [alias, path] of Object.entries(match.paths)) {
        if (!path) continue
        if (alias === 'root') continue
        if (path === instance.workingDirectory) continue
        const existing = deduped.get(path)
        if (!existing || alias.length < existing.length) {
          deduped.set(path, alias)
        }
      }
      setEnvRoots(Array.from(deduped.entries()).map(([path, alias]) => ({ alias, path })))
    })
  }, [instance.workingDirectory])

  // Compute highlighted HTML + match count
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
      const allRoots = [instance.workingDirectory, ...envRoots.map(r => r.path)]
      const perRoot = await Promise.all(
        allRoots.map(root => window.api.fs.searchContent(root, contentSearch, ignoreRules))
      )
      const seen = new Set<string>()
      const merged: Array<{ file: string; matches: Array<{ line: number; text: string }> }> = []
      for (const results of perRoot) {
        for (const result of results) {
          if (!seen.has(result.file)) {
            seen.add(result.file)
            merged.push(result)
          }
        }
      }
      setContentResults(merged)
      setContentSearching(false)
    }, 300)
    return () => { if (contentDebounceRef.current) clearTimeout(contentDebounceRef.current) }
  }, [contentSearch, searchMode, instance.workingDirectory, envRoots])

  // Cmd+F opens file search
  useEffect(() => {
    if (!focused) return
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'f') {
        e.preventDefault()
        e.stopPropagation()
        setFileSearchOpen(true)
        setTimeout(() => fileSearchInputRef.current?.focus(), 0)
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [focused])

  const loadFileTree = useCallback(async () => {
    setFileTreeLoading(true)
    try {
      const tree = await window.api.fs.listDir(instance.workingDirectory, 2)
      setFileTree(tree)
      const initial = new Set<string>()
      initial.add(instance.workingDirectory)
      for (const node of tree) {
        if (node.type === 'directory') initial.add(node.path)
      }
      setExpandedPaths((prev) => {
        const merged = new Set(prev)
        for (const p of initial) merged.add(p)
        return merged
      })
    } catch {
      setFileTree([])
    }
    setFileTreeLoading(false)
  }, [instance.workingDirectory])

  // Load file tree on mount
  useEffect(() => {
    if (!fileTree) {
      loadFileTree()
    }
  }, [fileTree, loadFileTree])

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
    const deepTree = await window.api.fs.listDir(path, 4)
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
      for (const p of prev) {
        if (p === path || p.startsWith(path + '/')) {
          next.delete(p)
        }
      }
      return next
    })
  }, [])

  const handleSelectFile = useCallback(async (filePath: string) => {
    setSelectedFile(filePath)
    setFileContent(null)
    setFileError(null)
    setImageDataUrl(null)
    setImageDims(null)
    setFileLoading(true)
    const ext = `.${filePath.split('.').pop()?.toLowerCase()}`
    if (IMAGE_EXTS.has(ext)) {
      const [binaryResult, textResult] = await Promise.all([
        window.api.fs.readBinary(filePath),
        // For SVG, also fetch text so Source toggle works
        ext === '.svg' ? window.api.fs.readFile(filePath) : Promise.resolve({ content: undefined, error: undefined }),
      ])
      setFileLoading(false)
      if (binaryResult.error) setFileError(binaryResult.error)
      else {
        setImageDataUrl(binaryResult.dataUrl!)
        if (textResult.content != null) setFileContent(textResult.content)
      }
    } else {
      const result = await window.api.fs.readFile(filePath)
      setFileLoading(false)
      if (result.error) setFileError(result.error)
      else setFileContent(result.content ?? '')
    }
  }, [])

  return (
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
                ref={treeFilterInputRef}
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
                  const allRootsForSearch = [
                    { path: instance.workingDirectory, alias: null as string | null },
                    ...envRoots.map(r => ({ path: r.path, alias: r.alias })),
                  ]
                  const byDir = new Map<string, typeof contentResults>()
                  for (const result of contentResults.slice(0, visibleResultCount)) {
                    let relPath = result.file
                    for (const root of allRootsForSearch) {
                      if (result.file.startsWith(root.path + '/')) {
                        const rel = result.file.slice(root.path.length + 1)
                        relPath = root.alias ? `${root.alias}/${rel}` : rel
                        break
                      }
                    }
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
                              {(() => { const FileIcon = getFileIcon(fileName || ''); return <FileIcon size={13} className="filetree-icon file" /> })()}
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
                    ref={loadMoreSentinelRef}
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
            {searchMode === 'files' && envRoots.length > 0 && (
              <>
                <div className="filetree-env-roots-header">
                  <FolderTree size={12} />
                  Env repos ({envRoots.length})
                </div>
                {envRoots.map((root) => (
                  <FileTreeNode
                    key={root.path}
                    node={{ name: root.alias, path: root.path, type: 'directory' }}
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
                ))}
              </>
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
                <span className="filetree-preview-name">
                  {selectedFile.split('/').pop()}
                  {imageDims && <span className="filetree-preview-dims"> ({imageDims})</span>}
                </span>
                <span className="filetree-preview-path">{selectedFile}</span>
                <button
                  className="filetree-preview-paste"
                  onClick={() => {
                    const text = selectedFile.includes(' ') ? `"${selectedFile}"` : selectedFile
                    window.api.instance.write(instance.id, text + ' ')
                    onSwitchToSession()
                  }}
                  title="Paste path to terminal"
                >
                  <TerminalSquare size={12} /> Paste Path
                </button>
                {(isMarkdown || isSvg || isHtml) && (
                  <button
                    className={`filetree-preview-wrap filetree-preview-mode-toggle ${renderMd ? 'active' : ''}`}
                    onClick={() => setRenderMd(!renderMd)}
                    title={renderMd ? 'Switch to source view' : 'Switch to rendered view'}
                  >
                    {renderMd ? <Eye size={12} /> : <Code size={12} />}
                    <span>{renderMd ? 'Rendered' : 'Source'}</span>
                  </button>
                )}
                {!(isMarkdown && renderMd) && !(imageDataUrl && renderMd) && !(isHtml && renderMd) && (
                  <button
                    className={`filetree-preview-wrap ${wordWrap ? 'active' : ''}`}
                    onClick={() => setWordWrap(!wordWrap)}
                    title={wordWrap ? 'Disable word wrap' : 'Enable word wrap'}
                  >
                    <WrapText size={12} />
                  </button>
                )}
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
                {imageDataUrl && renderMd ? (
                  <div className="filetree-preview-image">
                    <img
                      src={imageDataUrl}
                      alt={selectedFile?.split('/').pop()}
                      onLoad={(e) => setImageDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
                    />
                  </div>
                ) : fileContent !== null && isMarkdown && renderMd && !fileSearchQuery ? (
                  <div className="filetree-preview-markdown">
                    <MarkdownViewer content={fileContent} />
                  </div>
                ) : fileContent !== null && isHtml && renderMd && !fileSearchQuery ? (
                  <div className="filetree-preview-html">
                    <iframe
                      srcDoc={fileContent}
                      sandbox="allow-scripts"
                      title="HTML preview"
                      style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
                    />
                  </div>
                ) : fileContent !== null ? (() => {
                  const raw = fileSearchQuery && highlightedHtml ? highlightedHtml : escapeHtml(fileContent)
                  const lines = raw.split('\n')
                  const gutterWidth = String(lines.length).length
                  const html = lines.map((line, i) =>
                    `<span class="filetree-line"><span class="filetree-linenum" style="min-width:${gutterWidth}ch">${i + 1}</span><span class="filetree-linecode">${line || ' '}</span></span>`
                  ).join('\n')
                  return <pre className={`filetree-preview-code ${wordWrap ? 'word-wrap' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
                })() : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
