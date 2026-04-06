import React, { useState, useEffect } from 'react'
import { GitFork, Plus, Trash2, X } from 'lucide-react'
import type { ClaudeInstance } from '../types'

interface ForkDef {
  label: string
  directive: string
}

interface Props {
  instance: ClaudeInstance
  /** Last few lines of terminal output, pre-populated as the task summary hint */
  bufferHint: string
  onClose: () => void
  onSubmit: (opts: {
    label: string
    taskSummary: string
    forks: ForkDef[]
  }) => Promise<void>
}

const DEFAULT_LABELS = ['Approach A', 'Approach B', 'Approach C']

export default function ForkModal({ instance, bufferHint, onClose, onSubmit }: Props) {
  const [groupLabel, setGroupLabel] = useState(`Explore from ${instance.name}`)
  const [taskSummary, setTaskSummary] = useState(bufferHint)
  const [forks, setForks] = useState<ForkDef[]>([
    { label: 'Approach A', directive: '' },
    { label: 'Approach B', directive: '' },
  ])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const addFork = () => {
    if (forks.length >= 3) return
    const label = DEFAULT_LABELS[forks.length] ?? `Approach ${forks.length + 1}`
    setForks((prev) => [...prev, { label, directive: '' }])
  }

  const removeFork = (index: number) => {
    if (forks.length <= 1) return
    setForks((prev) => prev.filter((_, i) => i !== index))
  }

  const updateFork = (index: number, field: keyof ForkDef, value: string) => {
    setForks((prev) => prev.map((f, i) => i === index ? { ...f, [field]: value } : f))
  }

  const handleSubmit = async () => {
    if (!groupLabel.trim()) {
      setError('Group label is required')
      return
    }
    for (let i = 0; i < forks.length; i++) {
      if (!forks[i].label.trim()) {
        setError(`Fork ${i + 1} label is required`)
        return
      }
    }
    setError(null)
    setSubmitting(true)
    try {
      await onSubmit({
        label: groupLabel.trim(),
        taskSummary: taskSummary.trim(),
        forks: forks.map((f) => ({
          label: f.label.trim(),
          directive: f.directive.trim() || f.label.trim(),
        })),
      })
      onClose()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to create forks')
      setSubmitting(false)
    }
  }

  return (
    <div className="fork-modal-overlay" onClick={onClose}>
      <div className="fork-modal" onClick={(e) => e.stopPropagation()}>
        <div className="fork-modal-header">
          <span className="fork-modal-title">
            <GitFork size={15} /> Fork Session
          </span>
          <button className="fork-modal-close" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="fork-modal-body">
          <div className="fork-modal-hint">
            Create parallel worktrees to explore multiple approaches simultaneously.
            Pick a winner when ready — losing branches are discarded automatically.
          </div>

          <div className="fork-modal-field">
            <label className="fork-modal-label">Group Label</label>
            <input
              className="fork-modal-input"
              value={groupLabel}
              onChange={(e) => setGroupLabel(e.target.value)}
              placeholder="e.g. Explore sorting strategies"
              disabled={submitting}
            />
          </div>

          <div className="fork-modal-field">
            <label className="fork-modal-label">Task Summary</label>
            <textarea
              className="fork-modal-textarea"
              value={taskSummary}
              onChange={(e) => setTaskSummary(e.target.value)}
              placeholder="What is the session working on? (pre-populated from terminal output)"
              rows={3}
              disabled={submitting}
            />
          </div>

          <div className="fork-modal-forks-header">
            <span className="fork-modal-label">Forks ({forks.length}/3)</span>
            <button
              className="fork-modal-add-btn"
              onClick={addFork}
              disabled={forks.length >= 3 || submitting}
              title={forks.length >= 3 ? 'Maximum 3 forks' : 'Add another fork'}
            >
              <Plus size={12} /> Add Fork
            </button>
          </div>

          {forks.map((fork, i) => (
            <div key={i} className="fork-modal-fork-row">
              <div className="fork-modal-fork-header">
                <span className="fork-modal-fork-number">Fork {i + 1}</span>
                {forks.length > 1 && (
                  <button
                    className="fork-modal-remove-btn"
                    onClick={() => removeFork(i)}
                    disabled={submitting}
                    title="Remove this fork"
                  >
                    <Trash2 size={11} />
                  </button>
                )}
              </div>
              <div className="fork-modal-fork-fields">
                <input
                  className="fork-modal-input fork-modal-fork-label"
                  value={fork.label}
                  onChange={(e) => updateFork(i, 'label', e.target.value)}
                  placeholder={`e.g. ${DEFAULT_LABELS[i] ?? 'Approach ' + (i + 1)}`}
                  disabled={submitting}
                />
                <input
                  className="fork-modal-input fork-modal-fork-directive"
                  value={fork.directive}
                  onChange={(e) => updateFork(i, 'directive', e.target.value)}
                  placeholder="Directive sent to Claude (e.g. use a recursive approach)"
                  disabled={submitting}
                />
              </div>
            </div>
          ))}

          {error && <div className="fork-modal-error">{error}</div>}
        </div>

        <div className="fork-modal-footer">
          <button className="fork-modal-cancel" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            className="fork-modal-submit"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Creating forks...' : `Launch ${forks.length} Fork${forks.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>
    </div>
  )
}
