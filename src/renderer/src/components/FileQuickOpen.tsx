import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, File } from 'lucide-react'

interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
}

interface Props {
  open: boolean
  onClose: () => void
  workingDirectory: string
  onSelectFile: (path: string) => void
}

function flattenFiles(nodes: FileNode[]): string[] {
  const files: string[] = []
  for (const n of nodes) {
    if (n.type === 'file') {
      files.push(n.path)
    } else if (n.children) {
      files.push(...flattenFiles(n.children))
    }
  }
  return files
}

export default function FileQuickOpen({ open, onClose, workingDirectory, onSelectFile }: Props) {
  const [query, setQuery] = useState('')
  const [files, setFiles] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setSelectedIndex(0)
    setLoading(true)
    window.api.fs.listDir(workingDirectory, 5).then((tree) => {
      setFiles(flattenFiles(tree as FileNode[]))
      setLoading(false)
    }).catch(() => {
      setFiles([])
      setLoading(false)
    })
  }, [open, workingDirectory])

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0)
  }, [open])

  const filtered = useMemo(() => {
    if (!query.trim()) return files.slice(0, 50)
    const q = query.toLowerCase()
    return files.filter(p => p.toLowerCase().includes(q)).slice(0, 100)
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
      if (filtered[selectedIndex]) onSelectFile(filtered[selectedIndex])
    }
  }, [filtered, selectedIndex, onClose, onSelectFile])

  if (!open) return null

  const relPath = (p: string) => p.startsWith(workingDirectory + '/') ? p.slice(workingDirectory.length + 1) : p

  return (
    <div className="cmd-palette-overlay" onClick={onClose}>
      <div className="cmd-palette" onClick={e => e.stopPropagation()}>
        <div className="cmd-palette-input-row">
          <Search size={14} className="cmd-palette-search-icon" />
          <input
            ref={inputRef}
            className="cmd-palette-input"
            placeholder="Jump to file..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <kbd className="cmd-palette-kbd">ESC</kbd>
        </div>
        <div className="cmd-palette-list" ref={listRef}>
          {loading && <div className="cmd-palette-empty">Loading files…</div>}
          {!loading && filtered.length === 0 && <div className="cmd-palette-empty">No files found</div>}
          {!loading && filtered.map((p, i) => {
            const rel = relPath(p)
            const slashIdx = rel.lastIndexOf('/')
            const name = slashIdx >= 0 ? rel.slice(slashIdx + 1) : rel
            const dir = slashIdx >= 0 ? rel.slice(0, slashIdx) : ''
            return (
              <div
                key={p}
                className={`cmd-palette-item ${i === selectedIndex ? 'selected' : ''}`}
                onClick={() => onSelectFile(p)}
              >
                <span className="cmd-palette-item-icon"><File size={14} /></span>
                <span className="cmd-palette-item-label">{name}</span>
                {dir && <span className="cmd-palette-item-detail">{dir}</span>}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
