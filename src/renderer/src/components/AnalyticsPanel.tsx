import { useState, useEffect } from 'react'
import { ArrowLeft, BarChart2, TrendingUp, TrendingDown, Code2, CheckCircle } from 'lucide-react'
import HelpPopover from './HelpPopover'
import type { AnalyticsSummary } from '../../../shared/types'

interface Props {
  onBack: () => void
}

export default function AnalyticsPanel({ onBack }: Props) {
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    window.api.analytics.getSummary().then(setSummary).catch(() => setSummary(null)).finally(() => setLoading(false))
  }, [])

  const formatCost = (cost: number) => `$${cost.toFixed(3)}`
  const formatDelta = (delta: number) => {
    const prefix = delta > 0 ? '+' : ''
    return `${prefix}${delta}`
  }
  const formatPercent = (rate: number) => `${Math.round(rate * 100)}%`

  return (
    <div className="panel-container">
      {/* Header */}
      <div className="panel-header">
        <button className="panel-header-back" onClick={onBack}>
          <ArrowLeft size={16} />
        </button>
        <h2><BarChart2 size={16} /> Analytics</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="analytics" align="right" />
      </div>

      {/* Content */}
      <div className="panel-content analytics-panel">
        {loading ? (
          <div className="loading">Loading analytics...</div>
        ) : !summary ? (
          <div className="empty-state">Unable to load analytics</div>
        ) : (
          <>
            {/* Summary Tiles */}
            <div className="analytics-tiles">
              <div className="analytics-tile">
                <div className="tile-label">Sessions (7d)</div>
                <div className="tile-value">{summary.sessionCount}</div>
                <div className={`tile-delta ${summary.sessionCountDelta > 0 ? 'positive' : 'negative'}`}>
                  {summary.sessionCountDelta > 0 && <TrendingUp size={12} />}
                  {summary.sessionCountDelta < 0 && <TrendingDown size={12} />}
                  {formatDelta(summary.sessionCountDelta)}
                </div>
              </div>

              <div className="analytics-tile">
                <div className="tile-label">Total Cost (7d)</div>
                <div className="tile-value">{formatCost(summary.totalCost)}</div>
                <div className={`tile-delta ${summary.totalCostDelta > 0 ? 'positive' : 'negative'}`}>
                  {summary.totalCostDelta > 0 && <TrendingUp size={12} />}
                  {summary.totalCostDelta < 0 && <TrendingDown size={12} />}
                  {formatCost(summary.totalCostDelta)}
                </div>
              </div>

              <div className="analytics-tile">
                <div className="tile-label">AI Commits (7d)</div>
                <div className="tile-value">{summary.aiCommitCount}</div>
                {summary.commitPercentage !== undefined && (
                  <div className="tile-delta">{formatPercent(summary.commitPercentage)} of total</div>
                )}
              </div>

              <div className="analytics-tile">
                <div className="tile-label">Pipeline Success (7d)</div>
                <div className="tile-value">{formatPercent(summary.pipelineSuccessRate)}</div>
                <div className="tile-icon"><CheckCircle size={12} /></div>
              </div>
            </div>

            {/* Daily Cost Chart */}
            <div className="analytics-section">
              <h3>Daily Cost (Last 7 Days)</h3>
              <div className="cost-chart">
                {summary.dailyCosts.map((cost, idx) => {
                  const maxCost = Math.max(...summary.dailyCosts, 0.01) // avoid division by zero
                  const height = (cost / maxCost) * 100
                  const daysAgo = 6 - idx
                  const dayLabel = daysAgo === 0 ? 'Today' : `${daysAgo}d`
                  return (
                    <div key={idx} className="chart-bar-wrapper" title={`${dayLabel}: ${formatCost(cost)}`}>
                      <div className="chart-bar" style={{ height: `${height}%` }} />
                      <div className="chart-label">{dayLabel}</div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* Top Spenders */}
            {summary.topSpenders.length > 0 && (
              <div className="analytics-section">
                <h3>Top Spenders (7d)</h3>
                <div className="spenders-table">
                  {summary.topSpenders.map((spender, idx) => (
                    <div key={idx} className="spender-row">
                      <div className="spender-label">{spender.label}</div>
                      <div className="spender-cost">{formatCost(spender.cost)}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <style>{`
        .analytics-panel {
          display: flex;
          flex-direction: column;
          gap: 24px;
          padding: 16px;
        }

        .loading, .empty-state {
          padding: 32px;
          text-align: center;
          color: var(--text-secondary);
          font-size: 14px;
        }

        .analytics-tiles {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
          gap: 12px;
        }

        .analytics-tile {
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 8px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }

        .tile-label {
          font-size: 12px;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.02em;
        }

        .tile-value {
          font-size: 20px;
          font-weight: 600;
          color: var(--text-primary);
        }

        .tile-delta {
          display: flex;
          align-items: center;
          gap: 4px;
          font-size: 12px;
          color: var(--text-secondary);
        }

        .tile-delta.positive {
          color: var(--success);
        }

        .tile-delta.negative {
          color: var(--error);
        }

        .tile-icon {
          opacity: 0.5;
        }

        .analytics-section {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .analytics-section h3 {
          font-size: 13px;
          font-weight: 600;
          color: var(--text-primary);
          margin: 0;
          text-transform: uppercase;
          letter-spacing: 0.02em;
        }

        .cost-chart {
          display: flex;
          gap: 8px;
          align-items: flex-end;
          height: 120px;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 12px;
        }

        .chart-bar-wrapper {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 4px;
          min-height: 100%;
        }

        .chart-bar {
          width: 100%;
          background: var(--accent);
          border-radius: 4px 4px 0 0;
          min-height: 2px;
          transition: background 200ms;
        }

        .chart-bar-wrapper:hover .chart-bar {
          background: var(--accent-bright);
        }

        .chart-label {
          font-size: 11px;
          color: var(--text-secondary);
          text-align: center;
        }

        .spenders-table {
          display: flex;
          flex-direction: column;
          gap: 8px;
          background: var(--bg-secondary);
          border: 1px solid var(--border);
          border-radius: 6px;
          padding: 12px;
        }

        .spender-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 8px 0;
          border-bottom: 1px solid var(--border);
          font-size: 13px;
        }

        .spender-row:last-child {
          border-bottom: none;
        }

        .spender-label {
          color: var(--text-primary);
          flex: 1;
        }

        .spender-cost {
          color: var(--text-secondary);
          font-weight: 500;
        }
      `}</style>
    </div>
  )
}
