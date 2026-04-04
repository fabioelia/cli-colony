import { useState, useEffect } from 'react'
import { Clock, X, Check } from 'lucide-react'
import { describeCron, nextRuns } from '../../../shared/cron'

interface Props {
  value: string
  onSave: (value: string) => Promise<void>
  onClose: () => void
}

const PRESETS = [
  { label: 'Manual', value: '' },
  { label: '15 min', value: '*/15 * * * *' },
  { label: '30 min', value: '*/30 * * * *' },
  { label: 'Hourly', value: '0 * * * *' },
  { label: '2 hours', value: '0 */2 * * *' },
  { label: '4 hours', value: '0 */4 * * *' },
  { label: 'Daily 9am', value: '0 9 * * *' },
  { label: 'Weekdays 9am', value: '0 9 * * 1-5' },
]

function validateCron(expr: string): string | null {
  if (!expr.trim()) return null
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return `Needs 5 fields (got ${fields.length}): min hour dom month dow`
  return null
}

export default function CronEditor({ value, onSave, onClose }: Props) {
  const [draft, setDraft] = useState(value)
  const [saving, setSaving] = useState(false)

  const trimmed = draft.trim()
  const error = validateCron(trimmed)
  const valid = !error
  const description = error ?? describeCron(trimmed)
  const runs = valid && trimmed ? nextRuns(trimmed, 3) : []

  // Select preset chip matching current draft
  const activePreset = PRESETS.find(p => p.value === trimmed)?.value ?? '__custom__'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const handleSave = async () => {
    if (!valid || saving) return
    setSaving(true)
    try {
      await onSave(trimmed)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const fmtRun = (d: Date) =>
    d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })

  return (
    <div className="cron-editor" onClick={e => e.stopPropagation()}>
      <div className="cron-editor-presets">
        {PRESETS.map(p => (
          <button
            key={p.value}
            className={`cron-preset-btn ${trimmed === p.value ? 'active' : ''}`}
            onClick={() => setDraft(p.value)}
          >
            {p.label}
          </button>
        ))}
        {activePreset === '__custom__' && trimmed && (
          <span className="cron-preset-btn active">Custom</span>
        )}
      </div>

      <div className="cron-editor-input-row">
        <Clock size={12} className="cron-editor-icon" />
        <input
          className={`cron-editor-input ${!valid ? 'invalid' : ''}`}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          placeholder="min hour dom month dow  (empty = manual only)"
          spellCheck={false}
          onKeyDown={e => { if (e.key === 'Enter') handleSave() }}
          autoFocus={activePreset === '__custom__'}
        />
      </div>

      <div className="cron-editor-description">
        {description}
      </div>

      {runs.length > 0 && (
        <div className="cron-editor-next-runs">
          <span className="cron-next-label">Next:</span>
          {runs.map((d, i) => (
            <span key={i} className="cron-next-run">{fmtRun(d)}</span>
          ))}
        </div>
      )}

      <div className="cron-editor-actions">
        <button className="cron-editor-cancel" onClick={onClose}>
          <X size={11} /> Cancel
        </button>
        <button
          className="cron-editor-save"
          onClick={handleSave}
          disabled={!valid || saving}
        >
          <Check size={11} /> {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  )
}
