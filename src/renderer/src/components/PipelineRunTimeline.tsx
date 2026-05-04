import { CheckCircle, XCircle, Zap, GitCommit, Webhook, AlertTriangle, Clock, Users } from 'lucide-react'

interface TriggerContext {
  cronExpr?: string
  scheduledAt?: string
  matchedPRs?: number[]
  newCommits?: string[]
  matchedFiles?: string[]
  githubEvent?: string
  githubAction?: string
}

interface DiffStats {
  filesChanged: number
  insertions: number
  deletions: number
}

interface StageTrace {
  index: number
  actionType: string
  sessionName?: string
  sessionId?: string
  durationMs: number
  success: boolean
  cost?: number
  error?: string
}

export interface RunEntry {
  ts: string
  trigger: string
  actionExecuted: boolean
  success: boolean
  durationMs: number
  totalCost?: number
  sessionIds?: string[]
  stages?: StageTrace[]
  stoppedBudget?: boolean
  webhookFired?: boolean
  diffStats?: DiffStats
  triggerContext?: TriggerContext
}

interface Props {
  run: RunEntry
  onFocusSession?: (id: string) => void
}

interface TimelineEntry {
  icon: React.ReactNode
  label: React.ReactNode
  tone: 'success' | 'failure' | 'warn' | 'neutral' | 'info'
}

function formatDur(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export default function PipelineRunTimeline({ run, onFocusSession }: Props) {
  const entries: TimelineEntry[] = []

  // Trigger
  const triggerLabel = run.trigger === 'cron'
    ? `Cron fired${run.triggerContext?.cronExpr ? ` (${run.triggerContext.cronExpr})` : ''}`
    : run.trigger === 'webhook'
    ? `Webhook received${run.triggerContext?.githubEvent ? ` — ${run.triggerContext.githubEvent}` : ''}`
    : run.trigger === 'manual'
    ? 'Manual trigger'
    : run.trigger === 'git-poll'
    ? 'Git poll trigger'
    : run.trigger === 'file-poll'
    ? 'File poll trigger'
    : `Trigger: ${run.trigger}`
  entries.push({ icon: <Zap size={10} />, label: triggerLabel, tone: 'info' })

  // Conditions matched
  if (run.triggerContext) {
    const tc = run.triggerContext
    if (tc.matchedPRs && tc.matchedPRs.length > 0) {
      entries.push({ icon: <GitCommit size={10} />, label: `Matched PRs: ${tc.matchedPRs.map(n => `#${n}`).join(', ')}`, tone: 'neutral' })
    }
    if (tc.newCommits && tc.newCommits.length > 0) {
      entries.push({ icon: <GitCommit size={10} />, label: `New commits: ${tc.newCommits.slice(0, 3).map(h => h.slice(0, 7)).join(', ')}${tc.newCommits.length > 3 ? ` +${tc.newCommits.length - 3} more` : ''}`, tone: 'neutral' })
    }
    if (tc.matchedFiles && tc.matchedFiles.length > 0) {
      entries.push({ icon: <GitCommit size={10} />, label: `Files changed: ${tc.matchedFiles.length} matching`, tone: 'neutral' })
    }
  }

  // Stages
  if (run.stages && run.stages.length > 0) {
    for (const stage of run.stages) {
      const label = (
        <span>
          Stage {stage.index + 1}: {stage.actionType}
          {stage.sessionName && (
            <span
              className={onFocusSession && stage.sessionId ? 'timeline-session-link' : ''}
              onClick={onFocusSession && stage.sessionId ? (e) => { e.stopPropagation(); onFocusSession(stage.sessionId!) } : undefined}
            >
              {' '}— {stage.sessionName}
            </span>
          )}
          <span className="timeline-meta"> {formatDur(stage.durationMs)}{stage.cost != null && stage.cost > 0.001 ? ` · $${stage.cost.toFixed(3)}` : ''}</span>
          {stage.error && <span className="timeline-error" title={stage.error}> · err</span>}
        </span>
      )
      entries.push({ icon: stage.success ? <CheckCircle size={10} /> : <XCircle size={10} />, label, tone: stage.success ? 'success' : 'failure' })
    }
  } else if (run.sessionIds && run.sessionIds.length > 0) {
    for (const id of run.sessionIds) {
      entries.push({
        icon: <Users size={10} />,
        label: (
          <span
            className={onFocusSession ? 'timeline-session-link' : ''}
            onClick={onFocusSession ? (e) => { e.stopPropagation(); onFocusSession(id) } : undefined}
          >
            Session spawned: {id.slice(0, 8)}…
          </span>
        ),
        tone: 'neutral',
      })
    }
  }

  // Budget stopped
  if (run.stoppedBudget) {
    entries.push({ icon: <AlertTriangle size={10} />, label: 'Stopped: budget exceeded', tone: 'warn' })
  }

  // Webhook delivery
  if (run.webhookFired) {
    entries.push({ icon: <Webhook size={10} />, label: 'Webhook delivered', tone: 'neutral' })
  }

  // Diff stats
  if (run.diffStats && run.diffStats.filesChanged > 0) {
    const { filesChanged, insertions, deletions } = run.diffStats
    entries.push({
      icon: <GitCommit size={10} />,
      label: <span>Changes: <span className="diff-ins">+{insertions}</span> <span className="diff-del">−{deletions}</span> in {filesChanged} file{filesChanged !== 1 ? 's' : ''}</span>,
      tone: 'neutral',
    })
  }

  // Final result
  entries.push({
    icon: run.success ? <CheckCircle size={10} /> : <XCircle size={10} />,
    label: (
      <span>
        {run.success ? '✓ Run succeeded' : '✗ Run failed'} · {formatDur(run.durationMs)}
        {run.totalCost != null ? ` · $${run.totalCost.toFixed(3)}` : ''}
      </span>
    ),
    tone: run.success ? 'success' : 'failure',
  })

  return (
    <div className="pipeline-run-timeline">
      {entries.map((entry, i) => (
        <div key={i} className={`timeline-entry tone-${entry.tone}`}>
          <div className="timeline-dot">{entry.icon}</div>
          {i < entries.length - 1 && <div className="timeline-line" />}
          <div className="timeline-label">{entry.label}</div>
        </div>
      ))}
    </div>
  )
}
