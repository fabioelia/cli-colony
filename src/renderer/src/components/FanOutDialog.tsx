import React, { useState, useEffect } from 'react'
import { Network, X, Loader2, Pencil, Play } from 'lucide-react'
import HelpPopover from './HelpPopover'

export interface SubTask {
  title: string
  prompt: string
}

interface Props {
  sourceInstanceId: string
  workingDirectory: string
  onClose: () => void
  onLaunch: (tasks: SubTask[], spaceName: string, model?: string) => Promise<void>
}

const MODELS = [
  { id: '', label: 'Inherit (current session)' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

export default function FanOutDialog({ sourceInstanceId: _sid, workingDirectory, onClose, onLaunch }: Props) {
  const [task, setTask] = useState('')
  const [count, setCount] = useState(3)
  const [model, setModel] = useState('')
  const [decomposing, setDecomposing] = useState(false)
  const [launching, setLaunching] = useState(false)
  const [subtasks, setSubtasks] = useState<SubTask[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [onClose])

  const handleDecompose = async () => {
    if (!task.trim()) return
    setDecomposing(true)
    setError(null)
    setSubtasks(null)
    try {
      const result = await window.api.ai.decomposeTasks(task.trim(), count)
      if (!result || result.length === 0) {
        setError('Decomposition failed — could not parse sub-tasks. Try rephrasing your task.')
      } else {
        setSubtasks(result.slice(0, count))
      }
    } catch {
      setError('Failed to call Claude for decomposition.')
    } finally {
      setDecomposing(false)
    }
  }

  const handleLaunch = async () => {
    if (!subtasks?.length) return
    setLaunching(true)
    const truncated = task.trim().slice(0, 40)
    const spaceName = `Fan-Out: ${truncated}${task.trim().length > 40 ? '…' : ''}`
    try {
      await onLaunch(subtasks, spaceName, model || undefined)
      onClose()
    } catch (e) {
      setError(String(e))
      setLaunching(false)
    }
  }

  return (
    <div className="fanout-overlay" onClick={onClose}>
      <div className="fanout-dialog" onClick={e => e.stopPropagation()}>
        <div className="fanout-header">
          <Network size={14} /> Fan-Out
          <div style={{ flex: 1 }} />
          <HelpPopover topic="session" zone="Fan-Out" align="right" />
          <button className="fanout-close" onClick={onClose}><X size={14} /></button>
        </div>

        <div className="fanout-body">
          <label className="fanout-label">Overall Task</label>
          <textarea
            className="fanout-task-input"
            placeholder="Describe the full task to decompose across parallel sessions…"
            value={task}
            onChange={e => setTask(e.target.value)}
            rows={4}
            disabled={decomposing || launching}
          />

          <div className="fanout-row">
            <div className="fanout-field">
              <label className="fanout-label">Sub-Sessions <span className="fanout-count-badge">{count}</span></label>
              <input
                type="range"
                min={2}
                max={6}
                value={count}
                onChange={e => { setCount(Number(e.target.value)); setSubtasks(null) }}
                disabled={decomposing || launching}
                className="fanout-range"
              />
              <div className="fanout-range-labels"><span>2</span><span>6</span></div>
            </div>
            <div className="fanout-field">
              <label className="fanout-label">Model</label>
              <select className="fanout-select" value={model} onChange={e => setModel(e.target.value)} disabled={decomposing || launching}>
                {MODELS.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          </div>

          <div className="fanout-working-dir">
            <span className="fanout-label">Directory:</span>
            <span className="fanout-dir-path">{workingDirectory}</span>
          </div>

          {!subtasks && (
            <button
              className="fanout-decompose-btn"
              onClick={handleDecompose}
              disabled={!task.trim() || decomposing || launching}
            >
              {decomposing ? <><Loader2 size={13} className="spin" /> Decomposing…</> : 'Decompose with AI →'}
            </button>
          )}

          {error && <div className="fanout-error">{error}</div>}

          {subtasks && (
            <>
              <div className="fanout-subtasks-header">
                <span className="fanout-label">Sub-Tasks — review & edit before launching</span>
                <button className="fanout-redo-btn" onClick={() => { setSubtasks(null); setError(null) }} disabled={launching}>
                  <Pencil size={11} /> Re-decompose
                </button>
              </div>
              <div className="fanout-subtasks">
                {subtasks.map((st, i) => (
                  <div key={i} className="fanout-subtask">
                    <input
                      className="fanout-subtask-title"
                      value={st.title}
                      onChange={e => setSubtasks(prev => prev!.map((s, j) => j === i ? { ...s, title: e.target.value } : s))}
                      disabled={launching}
                    />
                    <textarea
                      className="fanout-subtask-prompt"
                      value={st.prompt}
                      rows={3}
                      onChange={e => setSubtasks(prev => prev!.map((s, j) => j === i ? { ...s, prompt: e.target.value } : s))}
                      disabled={launching}
                    />
                  </div>
                ))}
              </div>
              <button
                className="fanout-launch-btn"
                onClick={handleLaunch}
                disabled={launching || subtasks.some(s => !s.prompt.trim())}
              >
                {launching ? <><Loader2 size={13} className="spin" /> Launching…</> : <><Play size={13} /> Launch {subtasks.length} Sessions</>}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
