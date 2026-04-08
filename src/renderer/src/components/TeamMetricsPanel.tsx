/**
 * Team Metrics Panel — displays worker performance metrics and team-level aggregates.
 */

import React, { useState, useEffect } from 'react'
import { Download, AlertCircle } from 'lucide-react'
import type { TeamMetrics } from '../../../shared/types'
import { BarChart2 } from './BarChart2'

interface TeamMetricsPanelProps {
  coordinatorSessionId?: string  // optional, for contextual filtering
}

export const TeamMetricsPanel: React.FC<TeamMetricsPanelProps> = ({ coordinatorSessionId }) => {
  const [metrics, setMetrics] = useState<TeamMetrics | null>(null)
  const [window, setWindow] = useState<'7d' | '30d'>('7d')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetchMetrics()
  }, [window])

  const fetchMetrics = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await window.api.team.getMetrics(window)
      setMetrics(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load metrics')
      setMetrics(null)
    } finally {
      setLoading(false)
    }
  }

  const handleExportCsv = async () => {
    try {
      const csv = await window.api.team.exportCsv(window)
      const blob = new Blob([csv], { type: 'text/csv' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `team-metrics-${window}.csv`
      link.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      setError('Failed to export metrics')
    }
  }

  if (loading) {
    return <div className="team-metrics-loading">Loading metrics...</div>
  }

  if (error) {
    return (
      <div className="team-metrics-error">
        <AlertCircle size={16} />
        <span>{error}</span>
      </div>
    )
  }

  if (!metrics) {
    return <div className="team-metrics-empty">No metrics data available</div>
  }

  // Prepare chart data: 7 or 30 days of data
  const chartData = Array.from({ length: window === '7d' ? 7 : 30 }, (_, i) => ({
    day: `Day ${i + 1}`,
    value: Math.round(Math.random() * 100), // Placeholder: aggregate daily runs
  }))

  return (
    <div className="team-metrics-panel">
      {/* Header with window selector */}
      <div className="team-metrics-header">
        <div className="team-metrics-title">Team Metrics</div>
        <div className="team-metrics-controls">
          <div className="team-metrics-window-selector">
            <button
              className={`team-metrics-window-btn ${window === '7d' ? 'active' : ''}`}
              onClick={() => setWindow('7d')}
            >
              7d
            </button>
            <button
              className={`team-metrics-window-btn ${window === '30d' ? 'active' : ''}`}
              onClick={() => setWindow('30d')}
            >
              30d
            </button>
          </div>
          <button className="team-metrics-export-btn" onClick={handleExportCsv} title="Export as CSV">
            <Download size={14} />
          </button>
        </div>
      </div>

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
      <div className="team-metrics-chart-container">
        <h3 className="team-metrics-chart-title">Daily Runs ({window})</h3>
        <BarChart2
          data={chartData}
          xKey="day"
          yKey="value"
          height={200}
          width={600}
          tooltip="Daily run count"
        />
      </div>

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
                  <tr key={worker.workerId} className="team-metrics-worker-row">
                    <td className="team-metrics-worker-name">{worker.workerId}</td>
                    <td className="team-metrics-cell-numeric">{worker.runsCount}</td>
                    <td className="team-metrics-cell-numeric">{worker.successRate.toFixed(1)}</td>
                    <td className="team-metrics-cell-numeric">{Math.round(worker.avgDurationMs / 1000)}</td>
                    <td className="team-metrics-cell-numeric">${worker.totalCostUsd.toFixed(4)}</td>
                    <td className="team-metrics-cell-muted">
                      {worker.lastRunAt ? formatLastRun(worker.lastRunAt) : 'Never'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
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
