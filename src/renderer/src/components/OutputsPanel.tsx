import React, { useState, useEffect, useCallback, useRef } from 'react'
import { FolderOpen, FileText, Clock, RefreshCw } from 'lucide-react'
import { marked } from 'marked'
import HelpPopover from './HelpPopover'
import type { OutputEntry } from '../../../shared/types'

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

export default function OutputsPanel() {
  const [entries, setEntries] = useState<OutputEntry[]>([])
  const [filter, setFilter] = useState<FilterType>('all')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<OutputEntry | null>(null)
  const [content, setContent] = useState<string | null>(null)
  const [contentError, setContentError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const searchDebounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [debouncedSearch, setDebouncedSearch] = useState('')

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

  // Debounce search
  useEffect(() => {
    if (searchDebounce.current) clearTimeout(searchDebounce.current)
    searchDebounce.current = setTimeout(() => setDebouncedSearch(search), 200)
    return () => { if (searchDebounce.current) clearTimeout(searchDebounce.current) }
  }, [search])

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
          <div className="outputs-search-row">
            <input
              className="outputs-search"
              placeholder="Search by name or agent…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
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
            {filteredEntries.length === 0 ? (
              <div className="outputs-empty">
                {entries.length === 0
                  ? 'No outputs yet — run a persona or pipeline to generate artifacts.'
                  : 'No results for this filter.'}
              </div>
            ) : (
              filteredEntries.map((entry) => (
                <button
                  key={entry.path}
                  className={`outputs-row ${selected?.path === entry.path ? 'active' : ''}`}
                  onClick={() => handleSelect(entry)}
                >
                  <span className="outputs-row-icon">
                    <FileText size={13} />
                  </span>
                  <span className="outputs-row-main">
                    <span className="outputs-row-name">{entry.name}</span>
                    <span className="outputs-row-meta">
                      <span className="outputs-row-agent">{entry.agentId}</span>
                      <span className="outputs-row-time">
                        <Clock size={10} /> {formatRelativeTime(entry.mtime)}
                      </span>
                      <span className="outputs-row-size">{formatBytes(entry.sizeBytes)}</span>
                    </span>
                  </span>
                  {entry.type === 'brief' && (
                    <span className="outputs-type-chip brief">Brief</span>
                  )}
                </button>
              ))
            )}
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
                  {selected.agentId} · {formatRelativeTime(selected.mtime)} · {formatBytes(selected.sizeBytes)}
                </span>
              </div>
              <div className="outputs-viewer-content">
                {isMarkdown(selected.name) ? (
                  <div
                    className="outputs-markdown"
                    dangerouslySetInnerHTML={{ __html: marked(content) as string }}
                  />
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
