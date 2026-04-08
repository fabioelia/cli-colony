import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, Play, Settings, AlertCircle, CheckCircle, AlertTriangle } from 'lucide-react'
import HelpPopover from './HelpPopover'
import type { BatchConfig, BatchRun } from '../../../shared/types'

interface Props {
  isExpanded: boolean
  onToggleExpand: () => void
}

export default function BatchExecutionSettings({ isExpanded, onToggleExpand }: Props) {
  const [config, setConfig] = useState<BatchConfig | null>(null)
  const [history, setHistory] = useState<BatchRun[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [editMode, setEditMode] = useState(false)
  const [formData, setFormData] = useState<BatchConfig | null>(null)
  const [expandedRun, setExpandedRun] = useState<string | null>(null)

  useEffect(() => {
    loadBatchConfig()
    loadBatchHistory()
  }, [])

  const loadBatchConfig = async () => {
    try {
      const cfg = await window.api.batch.getConfig()
      setConfig(cfg)
      setFormData(cfg)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batch config')
    }
  }

  const loadBatchHistory = async () => {
    try {
      const runs = await window.api.batch.getHistory(20)
      setHistory(runs)
    } catch (err) {
      console.error('Failed to load batch history:', err)
    }
  }

  const handleSaveConfig = async () => {
    if (!formData) return
    setLoading(true)
    try {
      const success = await window.api.batch.setConfig(formData)
      if (success) {
        setConfig(formData)
        setEditMode(false)
        setError(null)
      } else {
        setError('Failed to save batch config. Check values and try again.')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save config')
    } finally {
      setLoading(false)
    }
  }

  const handleRunNow = async () => {
    setLoading(true)
    try {
      const result = await window.api.batch.runNow()
      if (result.success) {
        // Reload history after running
        await loadBatchHistory()
      } else {
        setError(result.error || 'Failed to run batch')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run batch')
    } finally {
      setLoading(false)
    }
  }

  if (!config || !formData) {
    return (
      <div className="settings-section">
        <button className="settings-section-header" onClick={onToggleExpand}>
          <div className="settings-header-left">
            {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
            <h3>Batch Execution</h3>
          </div>
          <Settings size={16} />
        </button>
      </div>
    )
  }

  return (
    <div className="settings-section">
      <button className="settings-section-header" onClick={onToggleExpand}>
        <div className="settings-header-left">
          {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          <h3>Batch Execution</h3>
        </div>
        <div style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
          <HelpPopover topic="tasks" zone="Batch Execution" align="right" />
          <Settings size={16} />
        </div>
      </button>

      {isExpanded && (
        <div className="settings-section-content">
          {error && (
            <div className="settings-error" style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', color: 'var(--danger)', fontSize: '12px' }}>
              <AlertCircle size={14} style={{ marginTop: '2px', flexShrink: 0 }} />
              <span>{error}</span>
            </div>
          )}

          {!editMode ? (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '16px', marginBottom: '16px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Batch Mode</label>
                  <div style={{ fontSize: '14px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                    {config.enabled ? (
                      <>
                        <CheckCircle size={14} style={{ color: 'var(--success)' }} />
                        <span style={{ fontWeight: '600' }}>Enabled</span>
                      </>
                    ) : (
                      <>
                        <AlertCircle size={14} style={{ color: 'var(--text-muted)' }} />
                        <span>Disabled</span>
                      </>
                    )}
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Schedule</label>
                  <div style={{ fontSize: '13px', fontFamily: 'monospace' }}>{config.schedule}</div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Concurrency</label>
                  <div style={{ fontSize: '14px' }}>{config.concurrency} task{config.concurrency !== 1 ? 's' : ''} parallel</div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Timeout</label>
                  <div style={{ fontSize: '14px' }}>{config.timeoutPerTaskMinutes} min per task</div>
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>On Completion</label>
                  <div style={{ fontSize: '14px', textTransform: 'capitalize' }}>{config.onCompletion}</div>
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginBottom: '16px' }}>
                <button
                  onClick={() => setEditMode(true)}
                  className="settings-btn-primary"
                  style={{ flex: 1 }}
                >
                  Edit Config
                </button>
                <button
                  onClick={handleRunNow}
                  disabled={loading}
                  className="settings-btn-secondary"
                  style={{ flex: 1 }}
                >
                  {loading ? '...' : 'Run Now'}
                </button>
              </div>
            </>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '16px', paddingBottom: '12px', borderBottom: '1px solid var(--border)' }}>
                <h4 style={{ margin: 0, fontSize: '13px', fontWeight: '600' }}>Edit Configuration</h4>
              </div>
              <div style={{ display: 'grid', gap: '12px', marginBottom: '16px' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={formData.enabled}
                    onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                  />
                  <span style={{ fontSize: '14px' }}>Enable Batch Mode</span>
                </label>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Cron Schedule</label>
                  <input
                    type="text"
                    value={formData.schedule}
                    onChange={(e) => setFormData({ ...formData, schedule: e.target.value })}
                    placeholder="0 2 * * *"
                    style={{ width: '100%', fontSize: '13px', padding: '6px 8px' }}
                  />
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '2px' }}>Example: "0 2 * * *" = 2am daily</div>
                </div>

                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Concurrency (1–5)</label>
                    <input
                      type="number"
                      min="1"
                      max="5"
                      value={formData.concurrency}
                      onChange={(e) => setFormData({ ...formData, concurrency: Math.min(5, Math.max(1, parseInt(e.target.value) || 1)) })}
                      style={{ width: '100%', fontSize: '13px', padding: '6px 8px' }}
                    />
                  </div>
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Timeout (min)</label>
                    <input
                      type="number"
                      min="1"
                      value={formData.timeoutPerTaskMinutes}
                      onChange={(e) => setFormData({ ...formData, timeoutPerTaskMinutes: Math.max(1, parseInt(e.target.value) || 30) })}
                      style={{ width: '100%', fontSize: '13px', padding: '6px 8px' }}
                    />
                  </div>
                </div>

                <div>
                  <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>On Completion</label>
                  <select
                    value={formData.onCompletion}
                    onChange={(e) => setFormData({ ...formData, onCompletion: e.target.value as any })}
                    style={{ width: '100%', fontSize: '13px', padding: '6px 8px' }}
                  >
                    <option value="nothing">Nothing (silent)</option>
                    <option value="report">Send Report</option>
                    <option value="commit">Commit Changes</option>
                  </select>
                </div>

                {formData.onCompletion === 'report' && (
                  <div>
                    <label style={{ display: 'block', fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Report Recipients</label>
                    <input
                      type="text"
                      value={formData.reportRecipients.join(', ')}
                      onChange={(e) => setFormData({
                        ...formData,
                        reportRecipients: e.target.value.split(',').map(s => s.trim()).filter(Boolean),
                      })}
                      placeholder="user@example.com, team@example.com"
                      style={{ width: '100%', fontSize: '13px', padding: '6px 8px' }}
                    />
                  </div>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px' }}>
                <button
                  onClick={handleSaveConfig}
                  disabled={loading}
                  className="settings-btn-primary"
                  style={{ flex: 1 }}
                >
                  {loading ? 'Saving...' : 'Save'}
                </button>
                <button
                  onClick={() => {
                    setEditMode(false)
                    setFormData(config)
                  }}
                  className="settings-btn-secondary"
                  style={{ flex: 1 }}
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          {history.length > 0 && (
            <div style={{ marginTop: '20px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
              <h4 style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Recent Runs ({history.length})
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '300px', overflowY: 'auto' }}>
                {history.map((run) => (
                  <div key={run.id} style={{
                    padding: '8px',
                    backgroundColor: 'var(--bg-surface)',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '12px',
                  }} onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={{ color: 'var(--text-muted)' }}>
                        {new Date(run.createdAt).toLocaleString()}
                      </span>
                      <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                        <span style={{ color: 'var(--success)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <CheckCircle size={12} />
                          {run.successCount}
                        </span>
                        <span style={{ color: 'var(--warning)', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                          <AlertTriangle size={12} />
                          {run.failedCount}
                        </span>
                        <span style={{ color: 'var(--text-muted)', fontSize: '12px' }}>${run.totalCostUsd.toFixed(2)}</span>
                      </div>
                    </div>
                    {expandedRun === run.id && (
                      <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-muted)', borderTop: '1px solid var(--border)', paddingTop: '8px' }}>
                        <div>Tasks: {run.taskCount} | Success: {run.successCount} | Failed: {run.failedCount} | Timeout: {run.timeoutCount}</div>
                        <div style={{ marginTop: '4px' }}>Duration: {Math.round(run.totalDurationMs / 1000)}s | Cost: ${run.totalCostUsd.toFixed(3)}</div>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
