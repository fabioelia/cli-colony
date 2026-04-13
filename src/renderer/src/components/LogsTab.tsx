import { useEffect, useRef, useState, memo, useCallback } from 'react'
import { Trash2, ChevronsDown } from 'lucide-react'
import type { EnvStatus } from '../../../shared/types'

interface LogsTabProps {
  envStatus: EnvStatus
}

function levelMatches(line: string, filter: 'all' | 'error' | 'warn'): boolean {
  if (filter === 'all') return true
  if (filter === 'error') return /error|ERROR|FATAL|FAIL/i.test(line)
  return /warn|WARN|WARNING/i.test(line)
}

// Visible DOM cap — keep full buffer in state for filtering, render only tail
const VISIBLE_CAP = 300
const BUFFER_CAP = 2000

export default memo(function LogsTab({ envStatus }: LogsTabProps) {
  const [logsFilter, setLogsFilter] = useState<string | null>(null)
  const [logsLevelFilter, setLogsLevelFilter] = useState<'all' | 'error' | 'warn'>('all')
  const [logsContent, setLogsContent] = useState<Array<{ service: string; line: string; ts: number }>>([])
  const logsEndRef = useRef<HTMLDivElement>(null)
  const logsAutoScrollRef = useRef(true)
  const [logsAutoScroll, setLogsAutoScroll] = useState(true)
  const envIdRef = useRef(envStatus.id)
  envIdRef.current = envStatus.id

  // Batched log ingestion — accumulate in ref, flush on interval
  const pendingRef = useRef<Array<{ service: string; line: string; ts: number }>>([])

  useEffect(() => {
    const interval = setInterval(() => {
      if (pendingRef.current.length === 0) return
      const batch = pendingRef.current
      pendingRef.current = []
      setLogsContent(prev => {
        const combined = [...prev, ...batch]
        return combined.length > BUFFER_CAP ? combined.slice(-BUFFER_CAP) : combined
      })
    }, 150)
    return () => clearInterval(interval)
  }, [])

  // Load initial logs (once per env ID)
  useEffect(() => {
    const envId = envStatus.id
    const loadAll = async () => {
      const entries: Array<{ service: string; line: string; ts: number }> = []
      for (const svc of envStatus.services) {
        try {
          const content = await window.api.env.logs(envId, svc.name, 100)
          if (content) {
            for (const line of content.split('\n')) {
              if (line.trim()) entries.push({ service: svc.name, line, ts: Date.now() })
            }
          }
        } catch { /* skip */ }
      }
      // Only set if we're still on the same env
      if (envIdRef.current === envId) {
        setLogsContent(entries)
      }
    }
    setLogsContent([])
    loadAll()
  }, [envStatus.id])

  // Subscribe to streaming output (stable — only depends on env ID)
  useEffect(() => {
    const envId = envStatus.id
    const unsub = window.api.env.onServiceOutput((data) => {
      if (data.envId !== envId) return
      const lines = data.data.split('\n').filter((l: string) => l.trim())
      if (lines.length === 0) return
      const now = Date.now()
      const newEntries = lines.map((line: string) => ({ service: data.service, line, ts: now }))
      pendingRef.current.push(...newEntries)
    })
    return unsub
  }, [envStatus.id])

  // Auto-scroll logs — instant, not smooth
  useEffect(() => {
    if (logsAutoScrollRef.current && logsEndRef.current) {
      logsEndRef.current.scrollIntoView()
    }
  }, [logsContent])

  // Scroll to bottom on mount
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView()
    }
  }, [])

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
    logsAutoScrollRef.current = atBottom
    // Only trigger re-render when the value actually changes
    setLogsAutoScroll(prev => prev === atBottom ? prev : atBottom)
  }, [])

  const filtered = logsContent.filter(
    entry => (logsFilter === null || entry.service === logsFilter) && levelMatches(entry.line, logsLevelFilter)
  )

  // Only render the visible tail
  const visible = filtered.length > VISIBLE_CAP ? filtered.slice(-VISIBLE_CAP) : filtered
  const hiddenCount = filtered.length - visible.length

  return (
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
            className={`logs-action-btn ${logsAutoScroll ? 'active' : ''}`}
            title="Follow latest output"
            onClick={() => { const next = !logsAutoScrollRef.current; logsAutoScrollRef.current = next; setLogsAutoScroll(next) }}
          >
            <ChevronsDown size={12} />
          </button>
        </div>
      </div>
      <div className="logs-panel-content" onScroll={handleScroll}>
        {hiddenCount > 0 && (
          <div className="logs-hidden-notice">{hiddenCount} older entries hidden</div>
        )}
        {visible.map((entry, i) => (
          <div key={i} className="logs-line">
            <span className={`logs-line-service ${entry.service}`}>{entry.service}</span>
            <span className="logs-line-text">{entry.line}</span>
          </div>
        ))}
        {filtered.length === 0 && (
          <div className="logs-empty">
            {logsContent.length === 0 ? 'No logs yet. Start services to see output.' : 'No logs match the current filters.'}
          </div>
        )}
        <div ref={logsEndRef} />
      </div>
    </div>
  )
}, (prev, next) => prev.envStatus.id === next.envStatus.id)
