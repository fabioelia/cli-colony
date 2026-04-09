import { useState, useEffect, useCallback } from 'react'
import { CheckCircle2, XCircle, AlertTriangle, Loader2, X as XIcon } from 'lucide-react'
import type { PrerequisitesStatus } from '../../../shared/types'

interface Props {
  /** Called when the user finishes or skips — the parent closes the modal. */
  onClose: () => void
}

interface RowProps {
  ok: boolean
  optional?: boolean
  label: string
  detail?: string
  error?: string
  loading?: boolean
}

function PrereqRow({ ok, optional, label, detail, error, loading }: RowProps): JSX.Element {
  let icon: JSX.Element
  if (loading) {
    icon = <Loader2 size={18} className="welcome-spin" color="var(--text-muted)" />
  } else if (ok) {
    icon = <CheckCircle2 size={18} color="var(--success)" />
  } else if (optional) {
    icon = <AlertTriangle size={18} color="var(--warning)" />
  } else {
    icon = <XCircle size={18} color="var(--danger)" />
  }
  const subText = loading ? 'Checking…' : (ok ? detail : error) || ''
  return (
    <div className="welcome-prereq-row">
      <div className="welcome-prereq-icon">{icon}</div>
      <div className="welcome-prereq-body">
        <div className="welcome-prereq-label">
          {label}
          {optional && <span className="welcome-prereq-optional"> (optional)</span>}
        </div>
        {subText && <div className="welcome-prereq-detail">{subText}</div>}
      </div>
    </div>
  )
}

export default function WelcomeModal({ onClose }: Props): JSX.Element {
  const [prereqs, setPrereqs] = useState<PrerequisitesStatus | null>(null)
  const [loading, setLoading] = useState(true)

  const runCheck = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.prerequisites.check()
      setPrereqs(result)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    runCheck()
  }, [runCheck])

  // Escape key = Skip for now (dismiss without blocking)
  useEffect(() => {
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleSkip()
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleStart = async (): Promise<void> => {
    await window.api.onboarding.skip()
    onClose()
  }

  const handleSkip = async (): Promise<void> => {
    await window.api.onboarding.skip()
    onClose()
  }

  const ready = prereqs?.ready ?? false

  return (
    <div
      className="welcome-modal-backdrop"
      onClick={handleSkip}
    >
      <div
        className="welcome-modal"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
      >
        <button
          className="welcome-close"
          onClick={handleSkip}
          title="Skip for now — you can replay this from the command palette (Show Welcome)."
          aria-label="Close welcome"
        >
          <XIcon size={14} />
        </button>

        <h2 id="welcome-title" className="welcome-title">Welcome to Colony</h2>
        <p className="welcome-subtitle">Run multiple Claude agents in parallel on your codebase.</p>

        <div className="welcome-prereqs">
          <div className="welcome-prereqs-header">Prerequisites</div>
          <PrereqRow
            loading={loading}
            ok={prereqs?.claude.ok ?? false}
            label="Claude CLI"
            detail={prereqs?.claude.detail}
            error={prereqs?.claude.error}
          />
          <PrereqRow
            loading={loading}
            ok={prereqs?.auth.ok ?? false}
            label="Anthropic auth"
            detail={prereqs?.auth.detail}
            error={prereqs?.auth.error}
          />
          <PrereqRow
            loading={loading}
            ok={prereqs?.git.ok ?? false}
            label="Git user.email"
            detail={prereqs?.git.detail}
            error={prereqs?.git.error}
          />
          <PrereqRow
            loading={loading}
            optional
            ok={prereqs?.github.ok ?? false}
            label="GitHub token"
            detail={prereqs?.github.detail}
            error={prereqs?.github.error}
          />
        </div>

        <div className="welcome-actions">
          <button
            className="welcome-btn-primary"
            onClick={handleStart}
            disabled={loading || !ready}
            title={ready
              ? 'Close this modal and open the Sessions empty state to begin.'
              : 'Install the missing prerequisites above first — or click Skip to continue anyway.'}
          >
            Start your first session
          </button>
          <button
            className="welcome-btn-secondary"
            onClick={runCheck}
            disabled={loading}
            title="Re-run the prerequisite checks after installing something."
          >
            Re-check
          </button>
        </div>
        <button className="welcome-skip" onClick={handleSkip}>
          Skip for now
        </button>
        <p className="welcome-footer-tip">
          Replay this anytime from the command palette (<kbd>Show Welcome</kbd>).
        </p>
      </div>
    </div>
  )
}
