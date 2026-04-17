import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search } from 'lucide-react'
import { getFileIcon } from '../lib/file-icons'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

interface QuickOpenFile {
  name: string
  path: string
  relPath: string
  rootAlias: string
}

interface Props {
  open: boolean
  onClose: () => void
  workingDirectory: string
  onSelectFile: (path: string) => void
}

function flattenRoot(nodes: FileNode[], rootPath: string, alias: string): QuickOpenFile[] {
  const files: QuickOpenFile[] = []
  const walk = (ns: FileNode[]) => {
    for (const n of ns) {
      if (n.type === 'file') {
        const relPath = n.path.startsWith(rootPath + '/') ? n.path.slice(rootPath.length + 1) : n.path
        files.push({ name: relPath.split('/').pop()!, path: n.path, relPath, rootAlias: alias })
      } else if (n.children) {
        walk(n.children)
      }
    }
  }
  walk(nodes)
  return files
}

export default function FileQuickOpen({ open, onClose, workingDirectory, onSelectFile }: Props) {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<QuickOpenFile[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [envRoots, setEnvRoots] = useState<Array<{ alias: string; path: string }>>([])
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Detect sibling env roots (one-shot, same pattern as FilesTab)
  useEffect(() => {
    if (typeof window.api?.env?.list !== 'function') return
    window.api.env.list().then((envs) => {
      const match = envs.find((e) => Object.values(e.paths).includes(workingDirectory))
      if (!match) return
      const deduped = new Map<string, string>()
      for (const [alias, path] of Object.entries(match.paths)) {
        if (!path || alias === 'root' || path === workingDirectory) continue
        const existing = deduped.get(path)
        if (!existing || alias.length < existing.length) deduped.set(path, alias)
      }
      setEnvRoots(Array.from(deduped.entries()).map(([path, alias]) => ({ alias, path })))
    })
  }, [workingDirectory])

  // Load files from all roots in parallel
  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    setLoading(true)
    const roots = [{ path: workingDirectory, alias: '' }, ...envRoots]
    Promise.all(
      roots.map(({ path: rootPath, alias }) =>
        window.api.fs.listDir(rootPath, 5)
          .then((tree) => flattenRoot(tree as FileNode[], rootPath, alias))
          .catch(() => [] as QuickOpenFile[])
      )
    ).then((results) => {
      setFiles(results.flat())
      setLoading(false)
    })
  }, [open, workingDirectory, envRoots])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const filtered = useMemo(() => {
    if (!query.trim()) return files.slice(0, 50)
    const q = query.toLowerCase()
    return files.filter((f) => f.relPath.toLowerCase().includes(q)).slice(0, 100)
  }, [files, query])

  useEffect(() => setSelectedIndex(0), [query])

  useEffect(() => {
    const el = listRef.current?.querySelector('.selected') as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex(i => Math.min(i + 1, filtered.length - 1)); return }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex(i => Math.max(i - 1, 0)); return }
    if (e.key === 'Enter') {
      e.preventDefault()
      if (filtered[selectedIndex]) onSelectFile(filtered[selectedIndex].path)
    }
  }, [filtered, selectedIndex, onClose, onSelectFile])

  if (!open) return null

  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={e => e.stopPropagation()}>
        <div className="cmd-palette-input-row">
          <Search size={14} className="cmd-palette-search-icon" />
          <input
            ref={inputRef}
            className="cmd-palette-input"
            placeholder="Jump to file…"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="cmd-palette-kbd">ESC</kbd>
        </div>
        <div className="cmd-palette-list" ref={listRef}>
          {loading && <div className="cmd-palette-empty">Loading files…</div>}
          {!loading && filtered.length === 0 && <div className="cmd-palette-empty">No files found</div>}
          {!loading && filtered.map((f, i) => {
            const dir = f.relPath.includes('/') ? f.relPath.slice(0, f.relPath.lastIndexOf('/')) : ''
            const FileIcon = getFileIcon(f.name)
            return (
              <div
                key={f.path}
                className={`cmd-palette-item ${i === selectedIndex ? 'selected' : ''}`}
                onClick={() => onSelectFile(f.path)}
              >
                <span className="cmd-palette-item-icon"><FileIcon size={14} /></span>
                <span className="cmd-palette-item-label">{f.name}</span>
                {f.rootAlias && <span className="cmd-palette-item-badge">{f.rootAlias}</span>}
                {dir && <span className="cmd-palette-item-detail">{dir}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
