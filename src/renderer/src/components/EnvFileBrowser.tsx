/**
 * EnvFileBrowser — lightweight file tree + preview for environment worktrees.
 * Reuses the filetree-* CSS classes from the session FilesTab and the
 * existing fs IPC handlers (fs:listDir, fs:readFile).
 */
import { useState, useCallback, useEffect } from 'react'
import {
  ChevronRight, ChevronDown, Folder, FolderOpen, File,
  RefreshCw, X, Search, Copy, ExternalLink, Navigation,
} from 'lucide-react'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

interface Props {
  /** repo-alias → checkout path, from env.paths (root key is excluded by caller) */
  paths: Record<string, string>
}

export default function EnvFileBrowser({ paths }: Props) {
  // Deduplicate by directory path — prefer shorter alias names, exclude root
  const deduped = new Map<string, string>() // dirPath → alias
  for (const [alias, dirPath] of Object.entries(paths)) {
    if (!dirPath) continue
    if (alias === 'root') continue // show root only as fallback below
    const existing = deduped.get(dirPath)
    if (!existing || alias.length < existing.length) {
      deduped.set(dirPath, alias)
    }
  }
  // Fallback: if no repo paths, use root
  if (deduped.size === 0 && paths.root) {
    deduped.set(paths.root, 'root')
  }
  const repoPaths = Array.from(deduped.entries()).map(([dirPath, alias]) => [alias, dirPath] as const)

  const [trees, setTrees] = useState<Record<string, FileNode[]>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [lazyChildren, setLazyChildren] = useState<Map<string, FileNode[]>>(new Map())
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string | null>(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [filter, setFilter] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  // Auto-expand repos on mount (up to 2)
  useEffect(() => {
    if (repoPaths.length > 0 && repoPaths.length <= 2) {
      const toExpand = new Set<string>()
      for (const [, dirPath] of repoPaths) {
        if (!trees[dirPath]) loadDir(dirPath)
        toExpand.add(dirPath)
      }
      setExpanded(toExpand)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loadDir = useCallback(async (dirPath: string) => {
    setLoading(prev => ({ ...prev, [dirPath]: true }))
    try {
      const nodes = await window.api.fs.listDir(dirPath, 2)
      setTrees(prev => ({ ...prev, [dirPath]: nodes }))
    } catch (err) {
      console.error('[env-files] listDir failed:', err)
    }
    setLoading(prev => ({ ...prev, [dirPath]: false }))
  }, [])

  const loadChildren = useCallback(async (dirPath: string) => {
    try {
      const nodes = await window.api.fs.listDir(dirPath, 1)
      setLazyChildren(prev => {
        const next = new Map(prev)
        next.set(dirPath, nodes)
        return next
      })
    } catch {}
  }, [])

  const toggleExpand = useCallback((nodePath: string) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(nodePath)) next.delete(nodePath)
      else next.add(nodePath)
      return next
    })
  }, [])

  const selectFile = useCallback(async (filePath: string) => {
    setSelectedFile(filePath)
    setFileLoading(true)
    try {
      const result = await window.api.fs.readFile(filePath)
      setFileContent(result.error ? `Error: ${result.error}` : (result.content ?? null))
    } catch {
      setFileContent('(failed to read file)')
    }
    setFileLoading(false)
  }, [])

  const refreshAll = useCallback(() => {
    setTrees({})
    setLazyChildren(new Map())
    for (const [, dirPath] of repoPaths) {
      if (expanded.has(dirPath)) loadDir(dirPath)
    }
  }, [repoPaths, expanded, loadDir])

  // Filter matching
  const matchesFilter = useCallback((node: FileNode): boolean => {
    if (!filter) return true
    const q = filter.toLowerCase()
    if (node.name.toLowerCase().includes(q)) return true
    if (node.type === 'directory') {
      const children = node.children || lazyChildren.get(node.path)
      if (children) return children.some(c => matchesFilter(c))
    }
    return false
  }, [filter, lazyChildren])

  const renderNode = useCallback((node: FileNode, depth: number): React.ReactNode => {
    if (filter && !matchesFilter(node)) return null
    const isDir = node.type === 'directory'
    const isExpanded = expanded.has(node.path)
    const children = node.children || lazyChildren.get(node.path)

    return (
      <div key={node.path}>
        <div
          className={`filetree-row ${isDir ? 'dir' : 'file'} ${selectedFile === node.path ? 'selected' : ''}`}
          style={{ paddingLeft: depth * 16 + 8 }}
          onClick={() => {
            if (isDir) {
              toggleExpand(node.path)
              if (!children && !isExpanded) loadChildren(node.path)
            } else {
              selectFile(node.path)
            }
          }}
        >
          {isDir ? (
            <span className={`filetree-chevron ${isExpanded ? 'expanded' : ''}`}>
              <ChevronRight size={12} />
            </span>
          ) : (
            <span className="filetree-chevron-spacer" />
          )}
          <span className={`filetree-icon ${isDir ? 'dir' : 'file'}`}>
            {isDir ? (isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />) : <File size={14} />}
          </span>
          <span className="filetree-name">{node.name}</span>
          <div className="filetree-row-actions" onClick={(e) => e.stopPropagation()}>
            <button
              title="Reveal in Finder"
              onClick={() => {
                const target = isDir ? node.path : node.path.substring(0, node.path.lastIndexOf('/'))
                window.api.shell.openExternal(`file://${target}`)
              }}
            >
              <Navigation size={12} />
            </button>
            <button
              title={copied === node.path ? 'Copied!' : 'Copy Path'}
              onClick={() => {
                navigator.clipboard.writeText(node.path)
                setCopied(node.path)
                setTimeout(() => setCopied(c => c === node.path ? null : c), 1200)
              }}
            >
              {copied === node.path
                ? <span className="filetree-copied-label">Copied</span>
                : <Copy size={12} />}
            </button>
          </div>
        </div>
        {isDir && isExpanded && children && (
          <div>
            {children.map(child => renderNode(child, depth + 1))}
            {children.length === 0 && (
              <div className="filetree-empty" style={{ paddingLeft: (depth + 1) * 16 + 8 }}>Empty</div>
            )}
          </div>
        )}
      </div>
    )
  }, [expanded, lazyChildren, selectedFile, filter, matchesFilter, toggleExpand, loadChildren, selectFile, copied, setCopied])

  if (repoPaths.length === 0) return null

  const lineNumWidth = fileContent ? String(fileContent.split('\n').length).length * 8 + 24 : 40

  return (
    <div className="env-files-browser">
      {/* Toolbar */}
      <div className="env-files-toolbar">
        <div className="env-files-filter">
          <Search size={11} />
          <input
            value={filter}
            onChange={e => setFilter(e.target.value)}
            placeholder="Filter files…"
            spellCheck={false}
          />
          {filter && (
            <button onClick={() => setFilter('')} className="env-files-filter-clear">
              <X size={10} />
            </button>
          )}
        </div>
        <button
          className="env-files-refresh"
          onClick={refreshAll}
          title="Refresh file tree"
        >
          <RefreshCw size={11} />
        </button>
      </div>

      {/* Tree */}
      <div className="env-files-tree">
        {repoPaths.map(([key, dirPath]) => {
          const tree = trees[dirPath]
          const isLoading = loading[dirPath]
          const isExpanded = expanded.has(dirPath)

          return (
            <div key={key}>
              <div
                className="filetree-row dir env-files-root-row"
                onClick={() => {
                  toggleExpand(dirPath)
                  if (!tree && !isExpanded) loadDir(dirPath)
                }}
              >
                <span className={`filetree-chevron ${isExpanded ? 'expanded' : ''}`}>
                  <ChevronRight size={12} />
                </span>
                <span className="filetree-icon dir">
                  {isExpanded ? <FolderOpen size={14} /> : <Folder size={14} />}
                </span>
                <span className="filetree-name" style={{ fontWeight: 600 }}>{key}</span>
              </div>
              {isExpanded && (
                <div>
                  {isLoading && <div className="filetree-loading" style={{ paddingLeft: 32 }}>Loading…</div>}
                  {tree && tree.map(node => renderNode(node, 1))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* File preview */}
      {selectedFile && (
        <div className="env-files-preview">
          <div className="filetree-preview-header">
            <span className="filetree-preview-name">{selectedFile.split('/').pop()}</span>
            <span className="filetree-preview-path">{selectedFile}</span>
            <div className="filetree-preview-actions">
              <button
                title="Reveal in Finder"
                onClick={() => {
                  const parent = selectedFile.substring(0, selectedFile.lastIndexOf('/'))
                  window.api.shell.openExternal(`file://${parent}`)
                }}
              >
                <Navigation size={12} />
              </button>
              <button
                title={copied === selectedFile ? 'Copied!' : 'Copy Path'}
                onClick={() => {
                  navigator.clipboard.writeText(selectedFile)
                  setCopied(selectedFile)
                  setTimeout(() => setCopied(c => c === selectedFile ? null : c), 1200)
                }}
              >
                {copied === selectedFile
                  ? <span className="filetree-copied-label">Copied</span>
                  : <Copy size={12} />}
              </button>
              <button
                title="Open Externally"
                onClick={() => window.api.shell.openExternal(`file://${selectedFile}`)}
              >
                <ExternalLink size={12} />
              </button>
            </div>
            <button
              className="env-files-preview-close"
              onClick={() => { setSelectedFile(null); setFileContent(null) }}
            >
              <X size={12} />
            </button>
          </div>
          <div className="env-files-preview-content">
            {fileLoading ? (
              <div className="filetree-loading" style={{ padding: 12 }}>Loading…</div>
            ) : fileContent !== null ? (
              <pre className="filetree-preview-code">
                {fileContent.split('\n').map((line, i) => (
                  <div key={i} className="filetree-line">
                    <span className="filetree-linenum" style={{ minWidth: lineNumWidth }}>{i + 1}</span>
                    <span className="filetree-linecode">{line}</span>
                  </div>
                ))}
              </pre>
            ) : (
              <div className="filetree-empty" style={{ padding: 12 }}>No content</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
