import React, { useState, useEffect } from 'react'
import { Gavel, X, Loader2 } from 'lucide-react'

interface Props {
  onClose: () => void
  onJudge: (config: { type: 'command'; cmd: string } | { type: 'llm'; prompt: string }) => void
  judging: boolean
}

export default function ArenaJudgeDialog({ onClose, onJudge, judging }: Props) {
  const [judgeType, setJudgeType] = useState<'command' | 'llm'>('command')
  const [cmd, setCmd] = useState('')
  const [prompt, setPrompt] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleRun = () => {
    if (judgeType === 'command' && cmd.trim()) {
      onJudge({ type: 'command', cmd: cmd.trim() })
    } else if (judgeType === 'llm' && prompt.trim()) {
      onJudge({ type: 'llm', prompt: prompt.trim() })
    }
  }

  const isValid = judgeType === 'command' ? cmd.trim().length > 0 : prompt.trim().length > 0

  return (
    <div className="fork-modal-overlay" onClick={onClose}>
      <div className="fork-modal" style={{ maxWidth: 420 }} onClick={e => e.stopPropagation()}>
        <div className="fork-modal-header">
          <span className="fork-modal-title">
            <Gavel size={15} /> Auto-Judge
          </span>
          <button className="fork-modal-close" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="fork-modal-body">
          <div className="fork-modal-hint">
            Automatically pick a winner by running a shell command in each session's working directory.
            The first session whose command exits with code 0 wins.
          </div>

          <div className="fork-modal-field">
            <label className="fork-modal-label">Judge type</label>
            <div className="arena-launch-count">
              <button
                className={`arena-launch-count-btn${judgeType === 'command' ? ' active' : ''}`}
                onClick={() => setJudgeType('command')}
                disabled={judging}
              >
                Command
              </button>
              <button
                className={`arena-launch-count-btn${judgeType === 'llm' ? ' active' : ''}`}
                onClick={() => setJudgeType('llm')}
                disabled={judging}
              >
                LLM
              </button>
            </div>
          </div>

          {judgeType === 'command' ? (
            <div className="fork-modal-field">
              <label className="fork-modal-label">Shell command</label>
              <input
                className="fork-modal-input"
                value={cmd}
                onChange={e => setCmd(e.target.value)}
                placeholder="npm test"
                disabled={judging}
                onKeyDown={e => {
                  if (e.key === 'Enter' && isValid && !judging) handleRun()
                }}
                autoFocus
              />
            </div>
          ) : (
            <div className="fork-modal-field">
              <label className="fork-modal-label">LLM prompt</label>
              <textarea
                className="fork-modal-textarea"
                value={prompt}
                onChange={e => setPrompt(e.target.value)}
                placeholder="Which output is better?"
                rows={3}
                disabled={judging}
                autoFocus
              />
              <div className="fork-modal-hint" style={{ marginTop: 4, fontSize: 11 }}>
                LLM judge is not yet available in arena mode — coming soon.
              </div>
            </div>
          )}
        </div>

        <div className="fork-modal-footer">
          <button className="fork-modal-cancel" onClick={onClose} disabled={judging}>
            Cancel
          </button>
          <button
            className="fork-modal-submit"
            onClick={handleRun}
            disabled={judging || !isValid || judgeType === 'llm'}
          >
            {judging ? <><Loader2 size={13} className="spin" /> Judging...</> : <>Run Judge</>}
          </button>
        </div>
      </div>
    </div>
  )
}
