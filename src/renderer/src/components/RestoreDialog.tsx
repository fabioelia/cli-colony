import { useState, useMemo } from 'react'
import { RotateCcw, X } from 'lucide-react'
import type { RecentSession } from '../types'

interface Props {
  sessions: RecentSession[]
  onRestore: (selected: RecentSession[]) => void
  onDismiss: () => void
}

export default function RestoreDialog({ sessions, onRestore, onDismiss }: Props) {
  const restorable = useMemo(
    () => sessions.filter((s) => s.sessionId && s.exitType !== 'killed'),
    [sessions]
  )
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(restorable.map((s) => s.sessionId!))
  )

  const allChecked = checked.size === restorable.length
  const toggleAll = () => {
    if (allChecked) {
      setChecked(new Set())
    } else {
      setChecked(new Set(restorable.map((s) => s.sessionId!)))
    }
  }
  const toggle = (id: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const truncatePath = (p: string) => {
    const home = '~'
    const short = p.replace(/^\/Users\/[^/]+/, home)
    return short.length > 45 ? '…' + short.slice(-42) : short
  }

  return (
    <div className="removal-modal-overlay" onClick={onDismiss}>
      <div className="restore-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="restore-dialog-header">
          <RotateCcw size={14} />
          <span>Restore Sessions</span>
          <div style={{ flex: 1 }} />
          <button className="restore-dialog-close" onClick={onDismiss} title="Close"><X size={14} /></button>
        </div>

        <div className="restore-dialog-toggle">
          <label>
            <input type="checkbox" checked={allChecked} onChange={toggleAll} />
            {allChecked ? 'Deselect all' : 'Select all'}
          </label>
          <span className="restore-dialog-count">{checked.size} of {restorable.length} selected</span>
        </div>

        <div className="restore-dialog-list">
          {restorable.map((s) => (
            <label key={s.sessionId} className={`restore-dialog-row${checked.has(s.sessionId!) ? ' selected' : ''}`}>
              <input
                type="checkbox"
                checked={checked.has(s.sessionId!)}
                onChange={() => toggle(s.sessionId!)}
              />
              <span className="instance-color-dot" style={{ background: s.color || 'var(--text-muted)' }} />
              <span className="restore-dialog-name">{s.instanceName || 'Unnamed'}</span>
              <span className="restore-dialog-path" title={s.workingDirectory}>{truncatePath(s.workingDirectory)}</span>
              {s.exitType && (
                <span className={`restore-dialog-exit ${s.exitType}`}>{s.exitType}</span>
              )}
            </label>
          ))}
        </div>

        <div className="restore-dialog-footer">
          <button className="restore-dialog-btn secondary" onClick={onDismiss}>Dismiss</button>
          <button
            className="restore-dialog-btn primary"
            disabled={checked.size === 0}
            onClick={() => onRestore(restorable.filter((s) => checked.has(s.sessionId!)))}
          >
            Restore {checked.size} session{checked.size !== 1 ? 's' : ''}
          </button>
        </div>
      </div>
    </div>
  )
}
