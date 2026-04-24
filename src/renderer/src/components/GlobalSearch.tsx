import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Search, X, ChevronRight, Copy } from 'lucide-react'

interface SearchOutputMatch {
  lineNum: number
  line: string
  contextBefore: string
  contextAfter: string
}

interface SearchOutputResult {
  instanceId: string
  name: string
  matches: SearchOutputMatch[]
}

interface Props {
  open: boolean
  onClose: () => void
  onNavigate: (instanceId: string) => void
}

export default function GlobalSearch({ open, onClose, onNavigate }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchOutputResult[]>([])
  const [searching, setSearching] = useState(false)
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const [selectedIdx, setSelectedIdx] = useState(-1)
  const selectedRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Focus input when panel opens
  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus(), 50)
      setQuery('')
      setResults([])
      setExpandedGroups(new Set())
    }
  }, [open])

  // Close on Escape
  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', handler, true)
    return () => window.removeEventListener('keydown', handler, true)
  }, [open, onClose])

  // Debounced search
  const doSearch = useCallback((q: string) => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (q.length < 2) {
      setResults([])
      setSearching(false)
      return
    }
    setSearching(true)
    timerRef.current = setTimeout(async () => {
      try {
        const res = await window.api.sessions.searchOutput(q)
        setResults(res)
        // Auto-expand all groups
        setExpandedGroups(new Set(res.map(r => r.instanceId)))
      } catch {
        setResults([])
      }
      setSearching(false)
    }, 300)
  }, [])

  useEffect(() => {
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [])

  const flatItems = useMemo(() => {
    const items: Array<{ instanceId: string; matchIdx: number }> = []
    for (const group of results) {
      if (expandedGroups.has(group.instanceId)) {
        for (let i = 0; i < group.matches.length; i++) {
          items.push({ instanceId: group.instanceId, matchIdx: i })
        }
      }
    }
    return items
  }, [results, expandedGroups])

  useEffect(() => { setSelectedIdx(-1) }, [results])

  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  if (!open) return null

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0)

  const toggleGroup = (id: string) => {
    setExpandedGroups(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const highlightMatch = (text: string, q: string) => {
    if (!q) return text
    const idx = text.toLowerCase().indexOf(q.toLowerCase())
    if (idx === -1) return text
    return (
      <>
        {text.slice(0, idx)}
        <mark>{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    )
  }

  return (
    <div className="global-search-panel">
      <div className="panel-header">
        <h2><Search size={16} /> Search All Sessions</h2>
        <div className="panel-header-spacer" />
        <div className="panel-header-actions">
          <button className="panel-header-btn" onClick={onClose} title="Close" aria-label="Close">
            <X size={14} />
          </button>
        </div>
      </div>
      <div className="global-search-body">
        <input
          ref={inputRef}
          className="global-search-input"
          placeholder="Search across all sessions' terminal output..."
          value={query}
          onChange={(e) => { setQuery(e.target.value); doSearch(e.target.value) }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              setSelectedIdx(prev => Math.min(prev + 1, flatItems.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setSelectedIdx(prev => Math.max(prev - 1, -1))
            } else if (e.key === 'Enter' && selectedIdx >= 0 && selectedIdx < flatItems.length) {
              e.preventDefault()
              const item = flatItems[selectedIdx]
              onNavigate(item.instanceId)
              onClose()
            }
          }}
        />
        {searching && <div className="global-search-status">Searching...</div>}
        {!searching && query.length >= 2 && results.length === 0 && (
          <div className="global-search-status">No matches found</div>
        )}
        {!searching && totalMatches > 0 && (
          <div className="global-search-status">
            {totalMatches} match{totalMatches !== 1 ? 'es' : ''} in {results.length} session{results.length !== 1 ? 's' : ''}
          </div>
        )}
        <div className="global-search-results">
          {results.map(group => (
            <div key={group.instanceId} className="global-search-group">
              <div
                className="global-search-group-header"
                onClick={() => toggleGroup(group.instanceId)}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter') toggleGroup(group.instanceId) }}
              >
                <ChevronRight
                  size={12}
                  className={`global-search-chevron${expandedGroups.has(group.instanceId) ? ' expanded' : ''}`}
                />
                <span className="global-search-group-name">{group.name}</span>
                <span className="global-search-group-count">{group.matches.length}</span>
              </div>
              {expandedGroups.has(group.instanceId) && group.matches.map((match, i) => {
                const flatIdx = flatItems.findIndex(f => f.instanceId === group.instanceId && f.matchIdx === i)
                return (
                <div
                  key={i}
                  className={`global-search-match${flatIdx === selectedIdx ? ' selected' : ''}`}
                  ref={flatIdx === selectedIdx ? selectedRef : undefined}
                  onClick={() => { onNavigate(group.instanceId); onClose() }}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter') { onNavigate(group.instanceId); onClose() } }}
                >
                  {match.contextBefore && (
                    <div className="global-search-context">{match.contextBefore}</div>
                  )}
                  <div className="global-search-line">
                    {highlightMatch(match.line, query)}
                  </div>
                  {match.contextAfter && (
                    <div className="global-search-context">{match.contextAfter}</div>
                  )}
                  <button
                    className="global-search-copy"
                    onClick={(e) => {
                      e.stopPropagation()
                      const text = [match.contextBefore, match.line, match.contextAfter].filter(Boolean).join('\n')
                      navigator.clipboard.writeText(text)
                    }}
                    title="Copy match"
                  >
                    <Copy size={12} />
                  </button>
                </div>
              )})}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
