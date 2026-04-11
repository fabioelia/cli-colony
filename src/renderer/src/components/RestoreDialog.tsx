import { useState, useMemo, useRef, useEffect } from 'react'
import { RotateCcw, X } from 'lucide-react'
import type { RecentSession } from '../types'

interface Props {
  sessions: RecentSession[]
  onRestore: (selected: RecentSession[]) => void
  onDismiss: () => void
}

function formatDuration(openedAt: string): string {
  const ms = Date.now() - new Date(openedAt).getTime()
  const mins = Math.floor(ms / 60000)
  if (mins < 60) return `${mins}m`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ${mins % 60}m`
  const days = Math.floor(hrs / 24)
  return `${days}d ${hrs % 24}h`
}

export default function RestoreDialog({ sessions, onRestore, onDismiss }: Props) {
  const restorable = useMemo(
    () => sessions.filter((s) => s.sessionId && s.exitType !== 'killed'),
    [sessions]
  )

  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    if (!search.trim()) return restorable
    const q = search.toLowerCase()
    return restorable.filter(s =>
      (s.instanceName || '').toLowerCase().includes(q) ||
      s.workingDirectory.toLowerCase().includes(q)
    )
  }, [restorable, search])

  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(restorable.map((s) => s.sessionId!))
  )

  const allFilteredChecked = filtered.length > 0 && filtered.every(s => checked.has(s.sessionId!))
  const toggleAll = () => {
    setChecked(prev => {
      const next = new Set(prev)
      if (allFilteredChecked) {
        for (const s of filtered) next.delete(s.sessionId!)
      } else {
        for (const s of filtered) next.add(s.sessionId!)
      }
      return next
    })
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

  const dialogRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    dialogRef.current?.focus()
    if (restorable.length > 0) {
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [restorable.length])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { onDismiss(); return }
    if (e.key !== 'Tab') return
    const dialog = dialogRef.current
    if (!dialog) return
    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, input, [tabindex]:not([tabindex="-1"])'
    )
    if (focusable.length === 0) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <div className="removal-modal-overlay" onClick={onDismiss}>
      <div
        className="restore-dialog"
        ref={dialogRef}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="restore-dialog-header">
          <RotateCcw size={14} />
          <span>Restore Sessions</span>
          <div style={{ flex: 1 }} />
          <button className="restore-dialog-close" onClick={onDismiss} title="Close"><X size={14} /></button>
        </div>

        <div className="restore-dialog-toggle">
          <label>
            <input type="checkbox" checked={allFilteredChecked} onChange={toggleAll} />
            {allFilteredChecked ? 'Deselect all' : 'Select all'}
          </label>
          <span className="restore-dialog-count">{checked.size} of {restorable.length} selected</span>
        </div>

        <div className="restore-dialog-search">
          <input
            ref={searchRef}
            type="text"
            placeholder="Search sessions..."
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="restore-dialog-search-input"
          />
        </div>

        <div className="restore-dialog-list">
          {filtered.length === 0 && search.trim() ? (
            <div className="restore-dialog-empty">No sessions match your search</div>
          ) : filtered.map((s) => (
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
              {s.openedAt && (
                <span className="restore-dialog-duration" title={`Opened ${new Date(s.openedAt).toLocaleString()}`}>
                  {formatDuration(s.openedAt)}
                </span>
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
