import { useState, useEffect, useRef } from 'react'
import type { ClaudeInstance } from '../types'

interface Props {
  instance: ClaudeInstance
  onRetry: (opts: { name: string; args: string[] }) => void
  onClose: () => void
}

function extractPrompt(args: string[]): string {
  const pIdx = args.indexOf('-p')
  if (pIdx !== -1 && pIdx + 1 < args.length) return args[pIdx + 1]
  return args.filter(a => !a.startsWith('-')).join(' ')
}

function replacePromptInArgs(args: string[], newPrompt: string): string[] {
  const pIdx = args.indexOf('-p')
  if (pIdx !== -1 && pIdx + 1 < args.length) {
    const next = [...args]
    next[pIdx + 1] = newPrompt
    return next
  }
  return newPrompt ? ['-p', newPrompt, ...args] : args
}

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export default function RetryDialog({ instance, onRetry, onClose }: Props) {
  const [name, setName] = useState(`${instance.name} (retry)`)
  const [prompt, setPrompt] = useState(() => extractPrompt(instance.args))
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  function handleRetry() {
    const args = replacePromptInArgs(instance.args, prompt)
    onRetry({ name: name.trim() || instance.name, args })
  }

  const duration = instance.exitedAt
    ? formatDuration(instance.exitedAt - Date.parse(instance.createdAt))
    : null

  return (
    <div className="dialog-overlay" onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="dialog" style={{ width: 480 }}>
        <h2 style={{ marginBottom: 16 }}>Retry with Editable Prompt</h2>

        <div className="dialog-field">
          <label>Session name</label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleRetry() }}
          />
        </div>

        <div className="dialog-field">
          <label>Working directory</label>
          <input value={instance.workingDirectory || '—'} readOnly style={{ opacity: 0.6 }} />
        </div>

        <div className="dialog-field">
          <label>Prompt</label>
          <textarea
            ref={textareaRef}
            className="dialog-first-prompt"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                handleRetry()
              }
            }}
            rows={4}
            placeholder="Enter prompt for the new session…"
          />
          <div className="dialog-field-hint">Cmd+Enter to launch</div>
        </div>

        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 4 }}>
          {instance.exitCode != null && (
            <span>Exit code: <strong style={{ color: instance.exitCode === 0 ? 'var(--success)' : 'var(--danger)' }}>{instance.exitCode}</strong></span>
          )}
          {duration && <span>Duration: <strong>{duration}</strong></span>}
        </div>

        <div className="dialog-actions">
          <button className="cancel" onClick={onClose}>Cancel</button>
          <button className="confirm" onClick={handleRetry}>Retry</button>
        </div>
      </div>
    </div>
  )
}
