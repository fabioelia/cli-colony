import { useState, useEffect, useCallback, useRef } from 'react'
import { GitCommit, Upload, AlertCircle, AlertTriangle, Check, Loader, GitBranch } from 'lucide-react'
import type { GitDiffEntry } from '../../../shared/types'
import { buildCommitSubject, buildBranchName, buildCommitBody } from '../../../shared/ticket-commit-format'
import type { InstanceTicket } from '../../../shared/ticket-commit-format'

interface CommitDialogProps {
  dir: string
  entries: GitDiffEntry[]
  onClose: () => void
  onCommitted: () => void
  ticket?: InstanceTicket
}

type Phase = 'editing' | 'committing' | 'pushing' | 'done' | 'error'

export default function CommitDialog({ dir, entries, onClose, onCommitted, ticket }: CommitDialogProps) {
  const [message, setMessage] = useState('')
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(() => new Set(entries.map(e => e.file)))
  const [phase, setPhase] = useState<Phase>('editing')
  const [error, setError] = useState<string | null>(null)
  const [branchInfo, setBranchInfo] = useState<{ branch: string; remote: string | null; ahead: number } | null>(null)
  const [commitHash, setCommitHash] = useState('')
  const [newBranchName, setNewBranchName] = useState('')
  const [creatingBranch, setCreatingBranch] = useState(false)
  const [branchError, setBranchError] = useState<string | null>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const ticketSeededRef = useRef(false)

  // Seed message + branch from ticket once on mount — never overwrite user edits
  // Pre-fill the full message (subject + Refs footer) so the textarea shows
  // exactly what will be committed — no silent body addition.
  useEffect(() => {
    if (ticket && !ticketSeededRef.current) {
      ticketSeededRef.current = true
      setMessage(`${buildCommitSubject(ticket)}\n\nRefs ${ticket.key}`)
      setNewBranchName(buildBranchName(ticket))
    }
  }, [ticket])

  useEffect(() => {
    window.api.git.branchInfo(dir).then(setBranchInfo).catch(() => {})
  }, [dir])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  const insertions = entries.filter(e => selectedFiles.has(e.file)).reduce((a, e) => a + e.insertions, 0)
  const deletions = entries.filter(e => selectedFiles.has(e.file)).reduce((a, e) => a + e.deletions, 0)

  const toggleFile = (file: string) => {
    setSelectedFiles(prev => {
      const next = new Set(prev)
      if (next.has(file)) next.delete(file)
      else next.add(file)
      return next
    })
  }

  const toggleAll = () => {
    if (selectedFiles.size === entries.length) {
      setSelectedFiles(new Set())
    } else {
      setSelectedFiles(new Set(entries.map(e => e.file)))
    }
  }

  const isProtectedBranch = branchInfo && /^(main|master)$/i.test(branchInfo.branch)

  const handleCreateBranch = useCallback(async () => {
    if (!newBranchName.trim()) return
    setCreatingBranch(true)
    setBranchError(null)
    try {
      const name = await window.api.git.createBranch(dir, newBranchName.trim())
      setBranchInfo(prev => prev ? { ...prev, branch: name } : prev)
      setNewBranchName('')
    } catch (err) {
      setBranchError(err instanceof Error ? err.message : 'Failed to create branch')
    } finally {
      setCreatingBranch(false)
    }
  }, [dir, newBranchName])

  const handleCommit = useCallback(async (andPush: boolean) => {
    if (!message.trim() || selectedFiles.size === 0) return
    setError(null)
    setPhase('committing')
    try {
      await window.api.git.stage(dir, [...selectedFiles])
      const finalMessage = ticket ? buildCommitBody(message.trim(), ticket) : message.trim()
      const hash = await window.api.git.commit(dir, finalMessage)
      setCommitHash(hash)
      if (andPush) {
        setPhase('pushing')
        await window.api.git.push(dir)
      }
      setPhase('done')
      onCommitted()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('error')
    }
  }, [dir, message, selectedFiles, onCommitted])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleCommit(false)
    }
  }

  const busy = phase === 'committing' || phase === 'pushing'

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  return (
    <div className="dialog-overlay" onClick={busy ? undefined : onClose}>
      <div className="dialog commit-dialog" onClick={e => e.stopPropagation()}>
        <div className="dialog-title">
          <GitCommit size={16} /> Stage & Commit
          {branchInfo && (
            <span className="commit-dialog-branch">
              on <strong>{branchInfo.branch}</strong>
            </span>
          )}
        </div>

        {/* Protected branch warning */}
        {isProtectedBranch && (
          <div className="commit-dialog-branch-warning">
            <AlertTriangle size={13} />
            <span>You're on <strong>{branchInfo!.branch}</strong> — consider creating a branch first.</span>
            <div className="commit-dialog-branch-create">
              <input
                className="commit-dialog-branch-input"
                value={newBranchName}
                onChange={e => { setNewBranchName(e.target.value); setBranchError(null) }}
                placeholder="feature/my-branch"
                disabled={creatingBranch}
                onKeyDown={e => { if (e.key === 'Enter') handleCreateBranch() }}
              />
              <button
                className="dialog-btn dialog-btn-primary"
                onClick={handleCreateBranch}
                disabled={creatingBranch || !newBranchName.trim()}
                style={{ padding: '3px 8px', fontSize: '11px' }}
              >
                {creatingBranch ? 'Creating...' : 'Create Branch'}
              </button>
            </div>
            {branchError && <div className="commit-dialog-branch-error">{branchError}</div>}
          </div>
        )}

        {/* Commit message */}
        <div className="dialog-field">
          <label>Commit message</label>
          <textarea
            ref={textareaRef}
            className="commit-dialog-textarea"
            value={message}
            onChange={e => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe your changes..."
            rows={4}
            disabled={busy || phase === 'done'}
          />
          <div className="dialog-field-hint">
            {selectedFiles.size} file{selectedFiles.size !== 1 ? 's' : ''} selected
            {insertions > 0 && <span style={{ color: 'var(--success)', marginLeft: '6px' }}>+{insertions}</span>}
            {deletions > 0 && <span style={{ color: 'var(--danger)', marginLeft: '4px' }}>-{deletions}</span>}
            <span style={{ marginLeft: 'auto', opacity: 0.5 }}>{navigator.platform.includes('Mac') ? '\u2318' : 'Ctrl'}+Enter to commit</span>
          </div>
        </div>

        {/* File checklist */}
        <div className="commit-dialog-files">
          <div className="commit-dialog-files-header">
            <label>
              <input
                type="checkbox"
                checked={selectedFiles.size === entries.length}
                onChange={toggleAll}
                disabled={busy || phase === 'done'}
              />
              {' '}Select all
            </label>
          </div>
          <div className="commit-dialog-files-list">
            {entries.map(entry => (
              <label key={entry.file} className="commit-dialog-file-row">
                <input
                  type="checkbox"
                  checked={selectedFiles.has(entry.file)}
                  onChange={() => toggleFile(entry.file)}
                  disabled={busy || phase === 'done'}
                />
                <span
                  className="commit-dialog-file-status"
                  style={{
                    color: entry.status === 'A' ? 'var(--success)'
                      : entry.status === 'D' ? 'var(--danger)'
                      : 'var(--warning)',
                  }}
                >
                  {entry.status}
                </span>
                <span className="commit-dialog-file-name">{entry.file}</span>
                <span className="commit-dialog-file-stats">
                  {entry.insertions > 0 && <span style={{ color: 'var(--success)' }}>+{entry.insertions}</span>}
                  {entry.deletions > 0 && <span style={{ color: 'var(--danger)', marginLeft: '3px' }}>-{entry.deletions}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>

        {/* Error display */}
        {error && (
          <div className="commit-dialog-error">
            <AlertCircle size={13} /> {error}
          </div>
        )}

        {/* Success display */}
        {phase === 'done' && (
          <div className="commit-dialog-success">
            <Check size={13} /> Committed{commitHash ? ` (${commitHash})` : ''}
          </div>
        )}

        {/* Actions */}
        <div className="commit-dialog-actions">
          {phase === 'done' ? (
            <button className="dialog-btn dialog-btn-primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button className="dialog-btn" onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                className="dialog-btn dialog-btn-primary"
                onClick={() => handleCommit(false)}
                disabled={busy || !message.trim() || selectedFiles.size === 0}
              >
                {phase === 'committing' ? <><Loader size={12} className="spinning" /> Committing...</> : 'Commit'}
              </button>
              {branchInfo?.remote && (
                <button
                  className="dialog-btn dialog-btn-primary"
                  onClick={() => handleCommit(true)}
                  disabled={busy || !message.trim() || selectedFiles.size === 0}
                  title={`Push to ${branchInfo.remote}`}
                >
                  {phase === 'pushing' ? <><Loader size={12} className="spinning" /> Pushing...</> : <><Upload size={12} /> Commit & Push</>}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
