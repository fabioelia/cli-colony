/**
 * Team Metrics Panel — displays worker performance metrics and team-level aggregates.
 */

import React, { useState, useEffect, useCallback } from 'react'
import { Download, AlertCircle, BarChart3, ChevronDown } from 'lucide-react'
import HelpPopover from './HelpPopover'
import type { TeamMetrics, TeamMetricsEntry } from '../../../shared/types'

interface TeamMetricsPanelProps {
  coordinatorSessionId?: string  // optional, for contextual filtering
}

interface BarDatum {
  label: string
  value: number
}

function SimpleBarChart({ data, height = 160 }: { data: BarDatum[]; height?: number }) {
  const max = Math.max(1, ...data.map(d => d.value))
  const barWidth = 14
  const gap = 6
  const width = data.length * (barWidth + gap) + gap

  return (
    <svg
      className="team-metrics-chart"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: '100%', height: `${height}px`, maxWidth: '100%' }}
    >
      {data.map((d, i) => {
        const barH = (d.value / max) * (height - 20)
        const x = gap + i * (barWidth + gap)
        const y = height - barH - 12
        return (
          <g key={i}>
            <rect
              x={x}
              y={y}
              width={barWidth}
              height={barH}
              fill="var(--accent)"
              rx={2}
            >
              <title>{`${d.label}: ${d.value}`}</title>
            </rect>
          </g>
        )
      })}
    </svg>
  )
}

export const TeamMetricsPanel: React.FC<TeamMetricsPanelProps> = ({ coordinatorSessionId: _coordinatorSessionId }) => {
  const [metrics, setMetrics] = useState<TeamMetrics | null>(null)
  const [timeWindow, setTimeWindow] = useState<'7d' | '30d'>('7d')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expandedWorker, setExpandedWorker] = useState<string | null>(null)
  const [workerHistory, setWorkerHistory] = useState<TeamMetricsEntry[]>([])
  const [historyFilter, setHistoryFilter] = useState<'all' | 'success' | 'failed'>('all')
  const [historyLoading, setHistoryLoading] = useState(false)

  const fetchMetrics = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.api.team.getMetrics(timeWindow)
      setMetrics(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load metrics')
      setMetrics(null)
    } finally {
      setLoading(false)
    }
  }, [timeWindow])

  useEffect(() => {
    fetchMetrics()
  }, [fetchMetrics])

  const handleExportCsv = async () => {
    try {
      const csv = await window.api.team.exportCsv(timeWindow)
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `team-metrics-${timeWindow}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch {
      setError('Failed to export metrics')
    }
  }

  const handleWorkerClick = async (workerId: string) => {
    if (expandedWorker === workerId) { setExpandedWorker(null); return }
    setExpandedWorker(workerId)
    setHistoryLoading(true)
    setHistoryFilter('all')
    try {
      const runs = await window.api.team.getWorkerHistory(workerId, 20)
      setWorkerHistory(runs)
    } finally { setHistoryLoading(false) }
  }

  const handleHistoryFilter = async (workerId: string, status: 'all' | 'success' | 'failed') => {
    setHistoryFilter(status)
    setHistoryLoading(true)
    try {
      const runs = await window.api.team.getWorkerHistory(workerId, 20, status === 'all' ? undefined : status)
      setWorkerHistory(runs)
    } finally { setHistoryLoading(false) }
  }

  // Chart data: real per-worker run counts (sorted descending for scanability).
  // The backend aggregates per-worker stats, not per-day, so we chart what we have.
  const chartData: BarDatum[] = (metrics?.workers ?? [])
    .slice()
    .sort((a, b) => b.runsCount - a.runsCount)
    .map((w) => ({ label: w.workerId, value: w.runsCount }))

  return (
    <div className="team-metrics-panel">
      {/* Panel header following convention */}
      <div className="panel-header">
        <h2><BarChart3 size={16} /> Team Metrics</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="teamMetrics" align="right" />
        <div className="panel-header-actions">
          <div className="team-metrics-window-selector">
            <button
              className={`panel-header-btn ${timeWindow === '7d' ? 'primary' : ''}`}
              onClick={() => setTimeWindow('7d')}
            >
              7d
            </button>
            <button
              className={`panel-header-btn ${timeWindow === '30d' ? 'primary' : ''}`}
              onClick={() => setTimeWindow('30d')}
            >
              30d
            </button>
          </div>
          <button
            className="panel-header-btn"
            onClick={handleExportCsv}
            title="Export as CSV"
            disabled={!metrics || metrics.workers.length === 0}
          >
            <Download size={12} /> CSV
          </button>
        </div>
      </div>

      {loading && <div className="team-metrics-loading">Loading metrics...</div>}

      {error && (
        <div className="team-metrics-error">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      {!loading && !error && metrics && (
        <>
          {/* Summary cards */}
          <div className="team-metrics-summary">
            <div className="team-metrics-card">
              <div className="team-metrics-card-label">Success Rate</div>
              <div className="team-metrics-card-value">{metrics.teamSuccessRate.toFixed(1)}%</div>
            </div>
            <div className="team-metrics-card">
              <div className="team-metrics-card-label">Avg Duration</div>
              <div className="team-metrics-card-value">{Math.round(metrics.avgDurationMs / 1000)}s</div>
            </div>
            <div className="team-metrics-card">
              <div className="team-metrics-card-label">Team Cost (YTD)</div>
              <div className="team-metrics-card-value">${metrics.totalCostYtd.toFixed(2)}</div>
            </div>
            <div className="team-metrics-card">
              <div className="team-metrics-card-label">Active Workers</div>
              <div className="team-metrics-card-value">{metrics.activeWorkerCount}</div>
            </div>
          </div>

          {/* Chart */}
          {chartData.length > 0 && (
            <div className="team-metrics-chart-container">
              <h3 className="team-metrics-chart-title">Runs per Worker ({timeWindow})</h3>
              <SimpleBarChart data={chartData} />
            </div>
          )}

          {/* Workers table */}
          <div className="team-metrics-workers">
            <h3 className="team-metrics-table-title">Worker Performance</h3>
            {metrics.workers.length === 0 ? (
              <div className="team-metrics-no-workers">No worker data in selected period</div>
            ) : (
              <div className="team-metrics-table">
                <table className="team-metrics-table-content">
                  <thead>
                    <tr>
                      <th>Worker ID</th>
                      <th>Runs</th>
                      <th>Success Rate (%)</th>
                      <th>Avg Duration (s)</th>
                      <th>Total Cost (USD)</th>
                      <th>Last Run</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.workers.map((worker) => (
                      <React.Fragment key={worker.workerId}>
                        <tr
                          className={`team-metrics-worker-row ${expandedWorker === worker.workerId ? 'expanded' : ''}`}
                          onClick={() => handleWorkerClick(worker.workerId)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td className="team-metrics-worker-name">
                            <ChevronDown size={12} className={`team-metrics-chevron ${expandedWorker === worker.workerId ? 'open' : ''}`} />
                            {worker.workerId}
                          </td>
                          <td className="team-metrics-cell-numeric">{worker.runsCount}</td>
                          <td className="team-metrics-cell-numeric">{worker.successRate.toFixed(1)}</td>
                          <td className="team-metrics-cell-numeric">{Math.round(worker.avgDurationMs / 1000)}</td>
                          <td className="team-metrics-cell-numeric">${worker.totalCostUsd.toFixed(4)}</td>
                          <td className="team-metrics-cell-muted">
                            {worker.lastRunAt ? formatLastRun(worker.lastRunAt) : 'Never'}
                          </td>
                        </tr>
                        {expandedWorker === worker.workerId && (
                          <tr className="team-metrics-history-row">
                            <td colSpan={6}>
                              <div className="team-metrics-history">
                                <div className="team-metrics-history-header">
                                  <span>Recent Runs</span>
                                  <div className="team-metrics-history-filters">
                                    {(['all', 'success', 'failed'] as const).map(s => (
                                      <button
                                        key={s}
                                        className={`team-metrics-history-chip ${historyFilter === s ? 'active' : ''}`}
                                        onClick={(e) => { e.stopPropagation(); handleHistoryFilter(worker.workerId, s) }}
                                      >
                                        {s.charAt(0).toUpperCase() + s.slice(1)}
                                      </button>
                                    ))}
                                  </div>
                                </div>
                                {historyLoading ? <div className="team-metrics-history-loading">Loading…</div> : (
                                  workerHistory.length === 0 ? <div className="team-metrics-history-empty">No runs found</div> : (
                                    <div className="team-metrics-history-list">
                                      {workerHistory.map(run => (
                                        <div key={run.id} className="team-metrics-run">
                                          <span className={`team-metrics-run-status ${run.status}`}>{run.status}</span>
                                          <span className="team-metrics-run-time">{formatLastRun(run.timestamp)}</span>
                                          <span className="team-metrics-run-duration">{Math.round(run.durationMs / 1000)}s</span>
                                          <span className="team-metrics-run-cost">${run.costUsd.toFixed(4)}</span>
                                          {run.sessionId && <span className="team-metrics-run-session">{run.sessionId.slice(0, 8)}</span>}
                                        </div>
                                      ))}
                                    </div>
                                  )
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** Format timestamp as relative time (e.g., "2h ago") */
function formatLastRun(timestamp: string): string {
  const now = new Date()
  const then = new Date(timestamp)
  const msAgo = now.getTime() - then.getTime()
  const secsAgo = Math.floor(msAgo / 1000)
  const minsAgo = Math.floor(secsAgo / 60)
  const hoursAgo = Math.floor(minsAgo / 60)
  const daysAgo = Math.floor(hoursAgo / 24)

  if (secsAgo < 60) return 'just now'
  if (minsAgo < 60) return `${minsAgo}m ago`
  if (hoursAgo < 24) return `${hoursAgo}h ago`
  return `${daysAgo}d ago`
}
