import { useEffect, useRef, useState } from 'react'
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

export default function LogsTab({ envStatus }: LogsTabProps) {
  const [logsFilter, setLogsFilter] = useState<string | null>(null)
  const [logsLevelFilter, setLogsLevelFilter] = useState<'all' | 'error' | 'warn'>('all')
  const [logsContent, setLogsContent] = useState<Array<{ service: string; line: string; ts: number }>>([])
  const logsEndRef = useRef<HTMLDivElement>(null)
  const [logsAutoScroll, setLogsAutoScroll] = useState(true)
  const logsInitialized = useRef(false)

  // Load initial logs + subscribe to streaming output
  useEffect(() => {
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
    const unsub = window.api.env.onServiceOutput((data) => {
      if (data.envId !== envStatus.id) return
      const lines = data.data.split('\n').filter((l: string) => l.trim())
      if (lines.length === 0) return
      setLogsContent(prev => {
        const newEntries = lines.map((line: string) => ({ service: data.service, line, ts: Date.now() }))
        const combined = [...prev, ...newEntries]
        return combined.length > 2000 ? combined.slice(-2000) : combined
      })
    })
    return () => {
      unsub()
      logsInitialized.current = false
    }
  }, [envStatus])

  // Auto-scroll logs
  useEffect(() => {
    if (logsAutoScroll && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [logsContent, logsAutoScroll])

  // Scroll to bottom on mount
  useEffect(() => {
    if (logsEndRef.current) {
      logsEndRef.current.scrollIntoView()
    }
  }, [])

  const filtered = logsContent.filter(
    entry => (logsFilter === null || entry.service === logsFilter) && levelMatches(entry.line, logsLevelFilter)
  )

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
            onClick={() => { setLogsAutoScroll(v => !v) }}
          >
            <ChevronsDown size={12} />
          </button>
        </div>
      </div>
      <div className="logs-panel-content" onScroll={(e) => {
        const el = e.currentTarget
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        setLogsAutoScroll(atBottom)
      }}>
        {filtered.map((entry, i) => (
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
}
