import { useState, useEffect, useRef } from 'react'
import { stripAnsi } from '../../../shared/utils'
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

function buildFailureContext(exitCode: number, durationMs: number | null, lastLines: string): string {
  const durationStr = durationMs != null ? formatDuration(durationMs) : 'unknown'
  return `[Previous attempt failed — context below]
Exit code: ${exitCode}
Duration: ${durationStr}
Last output (20 lines):
${lastLines}
[End of failure context — retry the task, avoiding the issue above]

`
}

export default function RetryDialog({ instance, onRetry, onClose }: Props) {
  const [name, setName] = useState(`${instance.name} (retry)`)
  const [prompt, setPrompt] = useState(() => extractPrompt(instance.args))
  const [retryWithContext, setRetryWithContext] = useState(true)
  const [lastLines, setLastLines] = useState<string | null>(null)
  const [bufferUnavailable, setBufferUnavailable] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const isFailed = instance.exitCode != null && instance.exitCode !== 0
  const durationMs = instance.exitedAt ? instance.exitedAt - Date.parse(instance.createdAt) : null

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    if (!isFailed) return
    window.api.instance.buffer(instance.id).then((raw: string) => {
      if (!raw) { setBufferUnavailable(true); return }
      const lines = stripAnsi(raw).split('\n').filter(l => l.trim())
      setLastLines(lines.slice(-20).join('\n'))
    }).catch(() => setBufferUnavailable(true))
  }, [instance.id, isFailed])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  function handleRetry() {
    let finalPrompt = prompt
    if (isFailed && retryWithContext && lastLines) {
      finalPrompt = buildFailureContext(instance.exitCode!, durationMs, lastLines) + prompt
    }
    const args = replacePromptInArgs(instance.args, finalPrompt)
    onRetry({ name: name.trim() || instance.name, args })
  }

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

        <div style={{ display: 'flex', gap: 16, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          {instance.exitCode != null && (
            <span>Exit code: <strong style={{ color: instance.exitCode === 0 ? 'var(--success)' : 'var(--danger)' }}>{instance.exitCode}</strong></span>
          )}
          {durationMs != null && <span>Duration: <strong>{formatDuration(durationMs)}</strong></span>}
        </div>

        {isFailed && (
          <label
            style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12, cursor: bufferUnavailable ? 'default' : 'pointer' }}
            title={bufferUnavailable ? 'Output no longer available' : undefined}
          >
            <input
              type="checkbox"
              checked={retryWithContext && !bufferUnavailable}
              disabled={bufferUnavailable}
              onChange={e => setRetryWithContext(e.target.checked)}
              style={{ accentColor: 'var(--accent)' }}
            />
            Include failure context
            {bufferUnavailable && <span style={{ opacity: 0.5 }}>(output no longer available)</span>}
          </label>
        )}

        <div className="dialog-actions">
          <button className="cancel" onClick={onClose}>Cancel</button>
          <button className="confirm" onClick={handleRetry}>Retry</button>
        </div>
      </div>
    </div>
  )
}
