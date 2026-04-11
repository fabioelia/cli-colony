import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { ArrowLeft, RefreshCw, Download, Search } from 'lucide-react'

interface Props {
  envId: string
  envName: string
  serviceNames?: string[]
  onBack: () => void
}

const DEFAULT_SERVICE_NAMES = ['setup']

export default function EnvironmentLogViewer({ envId, envName, serviceNames: propServiceNames, onBack }: Props) {
  const [serviceNames, setServiceNames] = useState<string[]>(propServiceNames || DEFAULT_SERVICE_NAMES)
  const [activeService, setActiveService] = useState(propServiceNames?.[0] || 'setup')
  const [logContent, setLogContent] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [loading, setLoading] = useState(false)
  const [filterText, setFilterText] = useState('')
  const logRef = useRef<HTMLPreElement>(null)
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  // Fetch service names from manifest if not provided via props
  useEffect(() => {
    if (propServiceNames) return
    window.api.env.manifest(envId).then((m: any) => {
      if (m?.services) {
        const names = ['setup', ...Object.keys(m.services)]
        setServiceNames(names)
        if (!names.includes(activeService)) setActiveService(names[0])
      }
    }).catch(() => {})
  }, [envId, propServiceNames])

  const loadLogs = useCallback(async () => {
    setLoading(true)
    try {
      const logs = await window.api.env.logs(envId, activeService, 500)
      setLogContent(logs || '(no logs)')
    } catch (err) {
      setLogContent(`Error loading logs: ${err}`)
    } finally {
      setLoading(false)
    }
  }, [envId, activeService])

  useEffect(() => {
    loadLogs()
    // Auto-refresh every 3 seconds
    refreshTimerRef.current = setInterval(loadLogs, 3000)
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current)
    }
  }, [loadLogs])

  // Auto-scroll to bottom
  useEffect(() => {
    if (autoScroll && logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [logContent, autoScroll])

  // Subscribe to real-time output (cap at ~2MB to prevent memory leaks)
  useEffect(() => {
    const MAX_LOG_LENGTH = 2 * 1024 * 1024
    const unsub = window.api.env.onServiceOutput(({ envId: eid, service, data }) => {
      if (eid === envId && service === activeService) {
        setLogContent(prev => {
          const next = prev + data
          if (next.length <= MAX_LOG_LENGTH) return next
          // Trim from the front, keeping last MAX_LOG_LENGTH chars at a newline boundary
          const trimmed = next.slice(next.length - MAX_LOG_LENGTH)
          const nl = trimmed.indexOf('\n')
          return nl > 0 ? trimmed.slice(nl + 1) : trimmed
        })
      }
    })
    return unsub
  }, [envId, activeService])

  const filteredContent = useMemo(() => {
    if (!filterText.trim()) return logContent
    const lower = filterText.toLowerCase()
    return logContent.split('\n').filter(line => line.toLowerCase().includes(lower)).join('\n')
  }, [logContent, filterText])

  const matchCount = useMemo(() => {
    if (!filterText.trim()) return 0
    const lower = filterText.toLowerCase()
    return logContent.split('\n').filter(line => line.toLowerCase().includes(lower)).length
  }, [logContent, filterText])

  const handleScroll = () => {
    if (!logRef.current) return
    const { scrollTop, scrollHeight, clientHeight } = logRef.current
    // If user scrolled up more than 50px from bottom, disable auto-scroll
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 50)
  }

  const downloadLog = () => {
    const blob = new Blob([logContent], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${envName}-${activeService}.log`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="env-log-viewer">
      {/* Header */}
      <div className="env-log-header-area">
        <div className="panel-header">
          <button className="panel-header-back" onClick={onBack} title="Back"><ArrowLeft size={16} /></button>
          <h2>{envName} Logs</h2>
          <div className="panel-header-spacer" />
          <div className="panel-header-actions">
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <Search size={12} style={{ opacity: 0.5 }} />
              <input
                type="text"
                placeholder="Filter logs..."
                value={filterText}
                onChange={e => setFilterText(e.target.value)}
                style={{ width: 140, fontSize: 11, padding: '2px 6px' }}
              />
              {filterText && (
                <>
                  <span style={{ fontSize: 10, opacity: 0.6 }}>{matchCount} match{matchCount !== 1 ? 'es' : ''}</span>
                  <button className="panel-header-btn" onClick={() => setFilterText('')} title="Clear filter" style={{ padding: '0 4px' }}>×</button>
                </>
              )}
            </div>
            <button className="panel-header-btn" onClick={loadLogs} title="Refresh">
              <RefreshCw size={14} className={loading ? 'spinning' : ''} />
            </button>
            <button className="panel-header-btn" onClick={downloadLog} title="Download log">
              <Download size={14} />
            </button>
            <label className="env-log-autoscroll">
              <input
                type="checkbox"
                checked={autoScroll}
                onChange={e => setAutoScroll(e.target.checked)}
              />
              Follow
            </label>
          </div>
        </div>
      </div>

      {/* Service tabs */}
      <div className="env-log-tabs">
        {serviceNames.map(name => (
          <button
            key={name}
            className={`env-log-tab ${activeService === name ? 'active' : ''}`}
            onClick={() => setActiveService(name)}
          >
            {name}
          </button>
        ))}
      </div>

      {/* Log content */}
      <pre
        ref={logRef}
        className="env-log-content"
        onScroll={handleScroll}
      >
        {filteredContent}
      </pre>
    </div>
  )
}
