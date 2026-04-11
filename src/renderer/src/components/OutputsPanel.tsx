import React, { useState, useEffect, useCallback, useRef } from 'react'
import { FolderOpen, FileText, Clock, RefreshCw, Search, FileOutput, Copy, Trash2, Send, ClipboardCopy, ChevronDown } from 'lucide-react'
import MarkdownViewer from './MarkdownViewer'
import HelpPopover from './HelpPopover'
import EmptyStateHook from './EmptyStateHook'
import type { OutputEntry, OutputSearchResult, ClaudeInstance } from '../../../shared/types'

type FilterType = 'all' | 'briefs' | 'artifacts'

function formatRelativeTime(ms: number): string {
  const diff = Date.now() - ms
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function isMarkdown(name: string): boolean {
  return name.endsWith('.md')
}

function formatAgentId(id: string): string {
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export default function OutputsPanel() {
  const [entries, setEntries] = useState<OutputEntry[]>([])
  const [filter, setFilter] = useState<FilterType>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<OutputEntry | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [copyFeedback, setCopyFeedback] = useState(false)
  const [sendFeedback, setSendFeedback] = useState<string | null>(null)
  const [sessionPickerOpen, setSessionPickerOpen] = useState(false)
  const [sessionList, setSessionList] = useState<ClaudeInstance[]>([])
  const sessionPickerRef = useRef<HTMLDivElement>(null)
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [contentResults, setContentResults] = useState<OutputSearchResult[]>([])
  const [contentSearching, setContentSearching] = useState(false)

  const loadEntries = useCallback(async () => {
    setRefreshing(true)
    try {
      const list = await window.api.outputs.list()
      setEntries(list)
    } finally {
      setRefreshing(false)
    }
  }, [])

  useEffect(() => {
    loadEntries()
  }, [loadEntries])

  // Debounce search (300ms for content search)
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    searchDebounce.current = setTimeout(() => setDebouncedSearch(search), 300)
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current) }
  }, [search])

  // Fire content search when query ≥ 3 chars
  useEffect(() => {
    if (debouncedSearch.length < 3) { setContentResults([]); return }
    let cancelled = false
    setContentSearching(true)
    window.api.outputs.search(debouncedSearch).then((results) => {
      if (!cancelled) setContentResults(results)
    }).catch(() => {
      if (!cancelled) setContentResults([])
    }).finally(() => {
      if (!cancelled) setContentSearching(false)
    })
    return () => { cancelled = true }
  }, [debouncedSearch])

  const totalContentMatches = contentResults.reduce((sum, r) => sum + r.matches.length, 0)

  const filteredEntries = entries.filter((e) => {
    if (filter === 'briefs' && e.type !== 'brief') return false
    if (filter === 'artifacts' && e.type !== 'artifact') return false
    if (debouncedSearch) {
      const q = debouncedSearch.toLowerCase()
      if (!e.name.toLowerCase().includes(q) && !e.agentId.toLowerCase().includes(q)) return false
    }
    return true
  })

  const handleSelect = useCallback(async (entry: OutputEntry) => {
    setSelected(entry)
    setContent(null)
    setContentError(null)
    setLoading(true)
    try {
      const result = await window.api.outputs.read(entry.path)
      if ('error' in result) {
        setContentError(result.error)
      } else {
        setContent(result.content)
      }
    } finally {
      setLoading(false)
    }
  }, [])

  const handleCopyContent = useCallback(() => {
    if (!content) return
    navigator.clipboard.writeText(content).then(() => {
      setCopyFeedback(true)
      setTimeout(() => setCopyFeedback(false), 1500)
    })
  }, [content])

  const handleOpenSessionPicker = useCallback(async () => {
    if (sessionPickerOpen) { setSessionPickerOpen(false); return }
    const list = await window.api.instance.list()
    setSessionList(list.filter((i: ClaudeInstance) => i.status === 'running' && i.activity === 'waiting'))
    setSessionPickerOpen(true)
  }, [sessionPickerOpen])

  const MAX_SEND_BYTES = 4096

  const handleSendToSession = useCallback((inst: ClaudeInstance) => {
    if (!content) return
    setSessionPickerOpen(false)
    const truncated = content.length > MAX_SEND_BYTES
    const payload = truncated ? content.slice(0, MAX_SEND_BYTES) : content
    window.api.instance.write(inst.id, payload)
    setTimeout(() => window.api.instance.write(inst.id, '\r'), 150)
    setSendFeedback(truncated ? `Sent first 4KB to ${inst.name}` : `Sent to ${inst.name}`)
    setTimeout(() => setSendFeedback(null), 2000)
  }, [content])

  // Close session picker on outside click or Escape
  useEffect(() => {
    if (!sessionPickerOpen) return
    const handleClick = (e: MouseEvent) => {
      if (sessionPickerRef.current && !sessionPickerRef.current.contains(e.target as Node)) {
        setSessionPickerOpen(false)
      }
    }
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSessionPickerOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    document.addEventListener('keydown', handleKey)
    return () => {
      document.removeEventListener('mousedown', handleClick)
      document.removeEventListener('keydown', handleKey)
    }
  }, [sessionPickerOpen])

  return (
    <div className="outputs-panel">
      <div className="panel-header">
        <h2><FolderOpen size={16} /> Outputs</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="outputs" align="right" />
        <div className="panel-header-actions">
          <button
            className="panel-header-btn"
            onClick={loadEntries}
            disabled={refreshing}
            title="Refresh"
          >
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </div>

      <div className="outputs-body">
        {/* Left column: list */}
        <div className="outputs-list-col">
          <div className="outputs-search-bar">
            <Search size={13} className="outputs-search-icon" />
            <input
              className="outputs-search-input"
              placeholder="Search by name, agent, or content…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {totalContentMatches > 0 && (
              <span className="outputs-search-badge">{totalContentMatches} content match{totalContentMatches !== 1 ? 'es' : ''}</span>
            )}
            {contentSearching && <span className="outputs-search-badge searching">searching…</span>}
          </div>
          <div className="outputs-filter-chips">
            {(['all', 'briefs', 'artifacts'] as FilterType[]).map((f) => (
              <button
                key={f}
                className={`outputs-chip ${filter === f ? 'active' : ''}`}
                onClick={() => setFilter(f)}
              >
                {f.charAt(0).toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <div className="outputs-list">
            {(() => {
              // Build content match lookup
              const contentMatchMap = new Map<string, OutputSearchResult>()
              for (const r of contentResults) contentMatchMap.set(r.path, r)

              // Content-only results: files not in filteredEntries
              const filteredPaths = new Set(filteredEntries.map(e => e.path))
              const contentOnlyResults = contentResults.filter(r => !filteredPaths.has(r.path))

              if (filteredEntries.length === 0 && contentOnlyResults.length === 0) {
                return entries.length === 0 ? (
                  <EmptyStateHook
                    icon={FileOutput}
                    title="Outputs"
                    hook="Nothing here yet. Run a persona or pipeline to generate an artifact."
                  />
                ) : (
                  <div className="outputs-empty">No results for this filter.</div>
                )
              }

              const renderRow = (entry: { path: string; name: string; agentId: string; mtime: number; type?: string }, matchResult?: OutputSearchResult) => (
                <button
                  key={entry.path}
                  className={`outputs-row ${selected?.path === entry.path ? 'active' : ''}`}
                  onClick={() => handleSelect(entry as OutputEntry)}
                >
                  <span className="outputs-row-icon">
                    <FileText size={13} />
                  </span>
                  <span className="outputs-row-main">
                    <span className="outputs-row-name">{entry.name}</span>
                    <span className="outputs-row-meta">
                      <span className="outputs-row-agent">{formatAgentId(entry.agentId)}</span>
                      <span className="outputs-row-time">
                        <Clock size={10} /> {formatRelativeTime(entry.mtime)}
                      </span>
                    </span>
                    {matchResult && matchResult.matches.length > 0 && (
                      <div className="outputs-match-snippet">
                        {matchResult.matches[0].contextBefore && (
                          <div className="outputs-match-context">{matchResult.matches[0].contextBefore}</div>
                        )}
                        <div className="outputs-match-line">
                          <span className="outputs-match-linenum">L{matchResult.matches[0].lineNum}</span>
                          {matchResult.matches[0].line}
                        </div>
                        {matchResult.matches[0].contextAfter && (
                          <div className="outputs-match-context">{matchResult.matches[0].contextAfter}</div>
                        )}
                        {matchResult.matches.length > 1 && (
                          <div className="outputs-match-more">+{matchResult.matches.length - 1} more match{matchResult.matches.length > 2 ? 'es' : ''}</div>
                        )}
                      </div>
                    )}
                  </span>
                  {entry.type === 'brief' && (
                    <span className="outputs-type-chip brief">Brief</span>
                  )}
                </button>
              )

              return (
                <>
                  {filteredEntries.map(entry => renderRow(entry, contentMatchMap.get(entry.path)))}
                  {contentOnlyResults.map(r => renderRow(r, r))}
                </>
              )
            })()}
          </div>
        </div>

        {/* Right column: viewer */}
        <div className="outputs-viewer-col">
          {!selected && (
            <div className="outputs-viewer-empty">
              <FolderOpen size={32} style={{ opacity: 0.3, marginBottom: 8 }} />
              <div>Select a file to view its contents</div>
            </div>
          )}
          {selected && loading && (
            <div className="outputs-viewer-loading">Loading…</div>
          )}
          {selected && contentError && (
            <div className="outputs-viewer-error">{contentError}</div>
          )}
          {selected && content !== null && !loading && (
            <div className="outputs-viewer">
              <div className="outputs-viewer-header">
                <span className="outputs-viewer-title">{selected.name}</span>
                <span className="outputs-viewer-subtitle">
                  {formatAgentId(selected.agentId)} · {formatRelativeTime(selected.mtime)} · {formatBytes(selected.sizeBytes)}
                </span>
                <div className="outputs-viewer-actions">
                  <button
                    className="outputs-viewer-btn"
                    onClick={handleCopyContent}
                    title="Copy file contents to clipboard"
                  >
                    <ClipboardCopy size={13} /> {copyFeedback ? 'Copied!' : 'Copy Content'}
                  </button>
                  <div className="outputs-session-picker" ref={sessionPickerRef}>
                    <button
                      className="outputs-viewer-btn"
                      onClick={handleOpenSessionPicker}
                      title="Send content to a running session"
                    >
                      <Send size={13} /> Send to Session <ChevronDown size={10} />
                    </button>
                    {sessionPickerOpen && (
                      <div className="outputs-session-dropdown">
                        {sessionList.length === 0 ? (
                          <div className="outputs-session-empty">No sessions waiting for input</div>
                        ) : (
                          sessionList.map((inst) => (
                            <button
                              key={inst.id}
                              className="outputs-session-item"
                              onClick={() => handleSendToSession(inst)}
                            >
                              <span className="outputs-session-dot" style={{ background: inst.color }} />
                              <span className="outputs-session-name">{inst.name}</span>
                            </button>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                  <button
                    className="outputs-viewer-btn"
                    onClick={() => window.api.outputs.copyPath(selected.path)}
                    title="Copy file path"
                  >
                    <Copy size={13} /> Copy Path
                  </button>
                  <button
                    className="outputs-viewer-btn"
                    onClick={() => window.api.outputs.revealInFinder(selected.path)}
                    title="Show in Finder"
                  >
                    <FolderOpen size={13} /> Reveal
                  </button>
                  <button
                    className="outputs-viewer-btn danger"
                    onClick={async () => {
                      if (!confirm(`Delete "${selected.name}"?`)) return
                      const res = await window.api.outputs.delete(selected.path)
                      if (res.success) { setSelected(null); setContent(null); loadEntries() }
                    }}
                    title="Delete this output"
                  >
                    <Trash2 size={13} /> Delete
                  </button>
                </div>
                {sendFeedback && (
                  <div className="outputs-send-toast">{sendFeedback}</div>
                )}
              </div>
              <div className="outputs-viewer-content">
                {isMarkdown(selected.name) ? (
                  <MarkdownViewer content={content} />
                ) : (
                  <pre className="outputs-raw">{content}</pre>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
