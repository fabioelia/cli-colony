import { useState, useEffect, useRef } from 'react'

interface Props {
  onBack: () => void
}

export default function LogsViewer({ onBack }: Props) {
  const [logs, setLogs] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const contentRef = useRef<HTMLPreElement>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = () => {
    window.api.logs.get().then(setLogs)
  }

  useEffect(() => {
    refresh()
    intervalRef.current = setInterval(refresh, 2000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [])

  useEffect(() => {
    if (autoScroll && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  const handleClear = async () => {
    await window.api.logs.clear()
    setLogs('')
  }

  return (
    <div className="logs-viewer">
      <div className="logs-viewer-header">
        <div className="logs-viewer-header-left">
          <h2>Logs</h2>
        </div>
        <div className="logs-viewer-actions">
          <button onClick={() => setAutoScroll(!autoScroll)}>
            {autoScroll ? 'Auto-scroll: ON' : 'Auto-scroll: OFF'}
          </button>
          <button onClick={refresh}>Refresh</button>
          <button onClick={handleClear}>Clear</button>
          <button onClick={onBack}>Close</button>
        </div>
      </div>
      <pre className="logs-content" ref={contentRef}>
        {logs || 'No logs yet.'}
      </pre>
    </div>
  )
}
