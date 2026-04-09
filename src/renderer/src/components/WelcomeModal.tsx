import { useState, useEffect, useCallback } from 'react'
import {
  CheckCircle2, XCircle, AlertTriangle, Loader2, X as XIcon,
  TerminalSquare, Server, Bot, Zap, Layers, ChevronDown, ChevronRight,
} from 'lucide-react'
import type { PrerequisitesStatus } from '../../../shared/types'

interface Props {
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

const FEATURES = [
  { icon: TerminalSquare, title: 'Sessions', desc: 'Run multiple Claude agents side-by-side on your codebase' },
  { icon: Server, title: 'Environments', desc: 'Spin up full dev stacks from templates — backend, frontend, workers, DB' },
  { icon: Bot, title: 'Personas', desc: 'AI agents with persistent memory that run on a schedule' },
  { icon: Zap, title: 'Pipelines', desc: 'Automated workflows triggered by time, git events, or approvals' },
] as const

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
  const [templateCount, setTemplateCount] = useState<number>(0)
  const [prereqsOpen, setPrereqsOpen] = useState(true)

  const runCheck = useCallback(async () => {
    setLoading(true)
    try {
      const result = await window.api.prerequisites.check()
      setPrereqs(result)
      // Auto-collapse prereqs if everything passes
      if (result.ready) setPrereqsOpen(false)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    runCheck()
    // Count environment templates
    window.api.env.listTemplates().then((t: any[]) => setTemplateCount(t.length)).catch(() => {})
  }, [runCheck])

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
    <div className="welcome-modal-backdrop" onClick={handleSkip}>
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
          title="Skip for now"
          aria-label="Close welcome"
        >
          <XIcon size={14} />
        </button>

        {/* Section A — Value Prop + Feature Discovery */}
        <h2 id="welcome-title" className="welcome-title">Welcome to Colony</h2>
        <p className="welcome-subtitle">
          Orchestrate AI agents, dev environments, and automated workflows — all from one desktop app.
        </p>

        <div className="welcome-features">
          {FEATURES.map(({ icon: Icon, title, desc }) => (
            <div key={title} className="welcome-feature-card">
              <Icon size={20} className="welcome-feature-icon" />
              <div className="welcome-feature-body">
                <div className="welcome-feature-title">{title}</div>
                <div className="welcome-feature-desc">{desc}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="welcome-plus">
          Plus: GitHub PR tracking, task queues, agent definitions, and MCP server management.
        </p>

        {/* Template callout */}
        <div className="welcome-template-callout">
          <Layers size={14} />
          {templateCount > 0 ? (
            <span>You have {templateCount} environment template{templateCount > 1 ? 's' : ''} ready to use.</span>
          ) : (
            <span>Create your first environment template from an existing project — Colony will snapshot your services, ports, and hooks into a reusable blueprint.</span>
          )}
        </div>

        {/* Section B — Prerequisites (collapsible) */}
        <div className="welcome-prereqs">
          <button
            className="welcome-prereqs-header"
            onClick={() => setPrereqsOpen(!prereqsOpen)}
            type="button"
          >
            {prereqsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>Prerequisites</span>
            {!loading && prereqs && (
              <span className={`welcome-prereqs-badge ${ready ? 'ok' : 'missing'}`}>
                {ready ? 'All good' : 'Action needed'}
              </span>
            )}
          </button>
          {prereqsOpen && (
            <div className="welcome-prereqs-body">
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
              <button
                className="welcome-btn-recheck"
                onClick={runCheck}
                disabled={loading}
              >
                Re-check
              </button>
            </div>
          )}
        </div>

        {/* Section C — Actions */}
        <div className="welcome-actions">
          <button
            className="welcome-btn-primary"
            onClick={handleStart}
            disabled={loading || !ready}
            title={ready
              ? 'Close this modal and start using Colony.'
              : 'Install the missing prerequisites above first — or click "Skip for now" to continue anyway.'}
          >
            Get started
          </button>
        </div>
        <button className="welcome-skip" onClick={handleSkip}>
          Skip for now
        </button>
        <p className="welcome-footer-tip">
          Replay this anytime from the command palette (<code>Show Welcome</code>).
        </p>
      </div>
    </div>
  )
}
