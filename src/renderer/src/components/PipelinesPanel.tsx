import { useState, useEffect, useCallback } from 'react'
import {
  Zap, ZapOff, Play, RefreshCw, ChevronDown, ChevronRight,
  FileText, Clock, CheckCircle, XCircle, AlertTriangle, Save, Edit3
} from 'lucide-react'

interface PipelineInfo {
  name: string
  description: string
  enabled: boolean
  fileName: string
  triggerType: string
  interval: number
  lastPollAt: string | null
  lastFiredAt: string | null
  lastError: string | null
  fireCount: number
}

export default function PipelinesPanel() {
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([])
  const [expandedPipeline, setExpandedPipeline] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState<string | null>(null)
  const [editingFileName, setEditingFileName] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const loadPipelines = useCallback(async () => {
    const list = await window.api.pipeline.list()
    setPipelines(list)
  }, [])

  useEffect(() => {
    loadPipelines()
    const unsub = window.api.pipeline.onStatus((list) => setPipelines(list))
    return unsub
  }, [loadPipelines])

  const handleToggle = async (name: string, enabled: boolean) => {
    await window.api.pipeline.toggle(name, enabled)
    loadPipelines()
  }

  const handleTriggerNow = async (name: string) => {
    await window.api.pipeline.triggerNow(name)
  }

  const handleExpand = async (p: PipelineInfo) => {
    if (expandedPipeline === p.name) {
      setExpandedPipeline(null)
      setEditingContent(null)
      setEditingFileName(null)
      setDirty(false)
      return
    }
    setExpandedPipeline(p.name)
    const content = await window.api.pipeline.getContent(p.fileName)
    setEditingContent(content || '')
    setEditingFileName(p.fileName)
    setDirty(false)
  }

  const handleSave = async () => {
    if (!editingFileName || editingContent == null) return
    await window.api.pipeline.saveContent(editingFileName, editingContent)
    setDirty(false)
    loadPipelines()
  }

  const handleReload = async () => {
    await window.api.pipeline.reload()
    loadPipelines()
  }

  const timeSince = (iso: string) => {
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (secs < 60) return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return `${Math.floor(secs / 86400)}d ago`
  }

  return (
    <div className="pipelines-panel">
      <div className="pipelines-header">
        <h2><Zap size={16} /> Pipelines</h2>
        <button className="pipelines-reload-btn" onClick={handleReload} title="Reload all pipeline files">
          <RefreshCw size={12} /> Reload
        </button>
      </div>

      <p className="pipelines-description">
        Pipelines automate trigger → action workflows. Define them as YAML files in <code>~/.claude-colony/pipelines/</code>.
      </p>

      {pipelines.length === 0 && (
        <div className="pipelines-empty">
          <ZapOff size={28} />
          <p>No pipelines found</p>
          <p className="pipelines-empty-hint">
            Create YAML files in ~/.claude-colony/pipelines/ to get started.
          </p>
        </div>
      )}

      <div className="pipelines-list">
        {pipelines.map((p) => (
          <div key={p.name} className={`pipeline-card ${p.enabled ? '' : 'disabled'}`}>
            <div className="pipeline-card-header" onClick={() => handleExpand(p)}>
              <div className="pipeline-card-left">
                {expandedPipeline === p.name ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className={`pipeline-status-dot ${p.enabled ? 'active' : 'inactive'}`} />
                <span className="pipeline-card-name">{p.name}</span>
              </div>
              <div className="pipeline-card-right">
                <span className="pipeline-card-trigger">{p.triggerType}</span>
                <span className="pipeline-card-interval">{p.interval}s</span>
                {p.fireCount > 0 && (
                  <span className="pipeline-card-fires">
                    <Zap size={10} /> {p.fireCount}
                  </span>
                )}
              </div>
            </div>

            {p.description && (
              <div className="pipeline-card-desc">{p.description}</div>
            )}

            <div className="pipeline-card-meta">
              {p.lastPollAt && (
                <span className="pipeline-meta-item" title={`Last polled: ${p.lastPollAt}`}>
                  <Clock size={10} /> Polled {timeSince(p.lastPollAt)}
                </span>
              )}
              {p.lastFiredAt && (
                <span className="pipeline-meta-item pipeline-meta-fired" title={`Last fired: ${p.lastFiredAt}`}>
                  <CheckCircle size={10} /> Fired {timeSince(p.lastFiredAt)}
                </span>
              )}
              {p.lastError && (
                <span className="pipeline-meta-item pipeline-meta-error" title={p.lastError}>
                  <AlertTriangle size={10} /> Error
                </span>
              )}
            </div>

            <div className="pipeline-card-actions">
              <button
                className={`pipeline-toggle-btn ${p.enabled ? 'enabled' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleToggle(p.name, !p.enabled) }}
              >
                {p.enabled ? <Zap size={11} /> : <ZapOff size={11} />}
                {p.enabled ? 'Enabled' : 'Disabled'}
              </button>
              {p.enabled && (
                <button
                  className="pipeline-trigger-btn"
                  onClick={(e) => { e.stopPropagation(); handleTriggerNow(p.name) }}
                  title="Run poll now"
                >
                  <Play size={11} /> Poll Now
                </button>
              )}
            </div>

            {expandedPipeline === p.name && editingContent !== null && (
              <div className="pipeline-editor">
                <div className="pipeline-editor-header">
                  <span><FileText size={11} /> {p.fileName}</span>
                  {dirty && (
                    <button className="pipeline-save-btn" onClick={handleSave}>
                      <Save size={11} /> Save
                    </button>
                  )}
                </div>
                <textarea
                  className="pipeline-editor-textarea"
                  value={editingContent}
                  onChange={(e) => { setEditingContent(e.target.value); setDirty(true) }}
                  spellCheck={false}
                />
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
