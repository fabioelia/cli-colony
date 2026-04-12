import { useState, useEffect } from 'react'
import { AlertCircle, Timer, Clock, GitBranch } from 'lucide-react'
import HelpPopover from './HelpPopover'
import type { EnvStatus } from '../types'

interface Instance {
  id: string
  name: string
  status: string
  startedAt?: number
  costUsd?: number
}

interface Props {
  instances: Instance[]
  onCancel: () => void
  onSelect: (mode: 'create', opts?: { name?: string; workingDirectory?: string; args?: string[] }) => void | Promise<void>
  onSelectReuse: (instanceId: string) => void | Promise<void>
  onSelectWorktreeSwap: (envId: string) => void | Promise<void>
  promptLabel: string
  repoName: string
  prNumber: number
}

export default function PromptEnvironmentSelector({
  instances,
  onCancel,
  onSelect,
  onSelectReuse,
  onSelectWorktreeSwap,
  promptLabel,
  repoName,
  prNumber,
}: Props) {
  const [mode, setMode] = useState<'worktree' | 'create' | 'reuse'>('worktree')
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null)
  const [selectedEnvId, setSelectedEnvId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)
  const [runningEnvs, setRunningEnvs] = useState<EnvStatus[]>([])

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  // Fetch running environments
  useEffect(() => {
    window.api.env.list().then((envs) => {
      setRunningEnvs(envs.filter((e) => e.status === 'running'))
    })
  }, [])

  // Filter running instances
  const runningInstances = instances.filter((inst) => inst.status === 'running')
  const hasRunningInstances = runningInstances.length > 0
  const hasRunningEnvs = runningEnvs.length > 0

  // Default to best available option
  useEffect(() => {
    if (!hasRunningEnvs && mode === 'worktree') {
      setMode('create')
    }
  }, [hasRunningEnvs, mode])

  const handleNext = async () => {
    setIsLoading(true)
    try {
      if (mode === 'worktree' && selectedEnvId) {
        await onSelectWorktreeSwap(selectedEnvId)
      } else if (mode === 'create') {
        await onSelect('create', {
          name: `${promptLabel}: ${repoName}#${prNumber}`,
        })
      } else if (mode === 'reuse' && selectedInstanceId) {
        await onSelectReuse(selectedInstanceId)
      }
    } finally {
      setIsLoading(false)
    }
  }

  const isNextDisabled =
    (mode === 'worktree' && !selectedEnvId) ||
    (mode === 'reuse' && !selectedInstanceId)

  const formatAge = (startedAt: number | undefined) => {
    if (!startedAt) return '—'
    const ageMs = Date.now() - startedAt
    const ageMins = Math.floor(ageMs / 60_000)
    if (ageMins < 1) return 'just now'
    if (ageMins < 60) return `${ageMins}m ago`
    const ageHours = Math.floor(ageMins / 60)
    return `${ageHours}h ago`
  }

  return (
    <div className="dialog-overlay" onClick={onCancel}>
      <div className="dialog" onClick={(e) => e.stopPropagation()}>
        <div className="env-selector-header">
          <h2>Environment for &ldquo;{promptLabel}&rdquo;</h2>
          <HelpPopover topic="github" align="left" />
        </div>

        <div className="env-selector-options">
          {/* Worktree Swap Option (fastest) */}
          <label
            className={`env-selector-option ${mode === 'worktree' ? 'active' : ''} ${!hasRunningEnvs ? 'disabled' : ''}`}
            onClick={() => { if (hasRunningEnvs) setMode('worktree') }}
          >
            <input
              type="radio"
              name="env-mode"
              value="worktree"
              checked={mode === 'worktree'}
              onChange={() => setMode('worktree')}
              disabled={!hasRunningEnvs}
            />
            <div className="env-selector-option-body">
              <div className="env-selector-option-title">
                <GitBranch size={13} /> Swap worktree in running env
                <span className="env-selector-time"><Timer size={11} /> ~5s</span>
              </div>
              <div className="env-selector-option-desc">
                {hasRunningEnvs
                  ? `Create worktree from PR branch, hot-swap into a running environment`
                  : 'No running environments — start one first'}
              </div>
            </div>
          </label>

          {/* Create New Option */}
          <label
            className={`env-selector-option ${mode === 'create' ? 'active' : ''}`}
            onClick={() => setMode('create')}
          >
            <input
              type="radio"
              name="env-mode"
              value="create"
              checked={mode === 'create'}
              onChange={() => setMode('create')}
            />
            <div className="env-selector-option-body">
              <div className="env-selector-option-title">
                Create new environment
                <span className="env-selector-time"><Clock size={11} /> ~60s</span>
              </div>
              <div className="env-selector-option-desc">Set up a fresh instance with all deps installed</div>
            </div>
          </label>

          {/* Reuse Existing Option */}
          <label
            className={`env-selector-option ${mode === 'reuse' ? 'active' : ''} ${!hasRunningInstances ? 'disabled' : ''}`}
            onClick={() => { if (hasRunningInstances) setMode('reuse') }}
          >
            <input
              type="radio"
              name="env-mode"
              value="reuse"
              checked={mode === 'reuse'}
              onChange={() => setMode('reuse')}
              disabled={!hasRunningInstances}
            />
            <div className="env-selector-option-body">
              <div className="env-selector-option-title">
                Continue in existing session
                <span className="env-selector-time"><Timer size={11} /> instant</span>
              </div>
              <div className="env-selector-option-desc">
                {hasRunningInstances
                  ? `${runningInstances.length} running session${runningInstances.length !== 1 ? 's' : ''} available`
                  : 'No running sessions'}
              </div>
            </div>
          </label>
        </div>

        {/* Environment Dropdown for worktree swap */}
        {mode === 'worktree' && hasRunningEnvs && (
          <div className="dialog-field">
            <label>Select environment:</label>
            <select
              value={selectedEnvId || ''}
              onChange={(e) => setSelectedEnvId(e.target.value)}
            >
              <option value="">— Choose environment —</option>
              {runningEnvs.map((env) => (
                <option key={env.id} value={env.id}>
                  {env.displayName || env.name} · {env.branch} · {env.services.filter(s => s.status === 'running').length}/{env.services.length} services
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Instance Dropdown */}
        {mode === 'reuse' && hasRunningInstances && (
          <div className="dialog-field">
            <label>Select session:</label>
            <select
              value={selectedInstanceId || ''}
              onChange={(e) => setSelectedInstanceId(e.target.value)}
            >
              <option value="">— Choose session —</option>
              {runningInstances.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name} · {inst.status} · {formatAge(inst.startedAt)}
                  {inst.costUsd ? ` · $${inst.costUsd.toFixed(2)}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Setup Notices */}
        {mode === 'worktree' && (
          <div className="dialog-notice">
            <AlertCircle size={14} />
            <span>Creates a worktree from the PR branch and swaps it into the environment. Services restart automatically (~5s).</span>
          </div>
        )}
        {mode === 'create' && (
          <div className="dialog-notice">
            <AlertCircle size={14} />
            <span>Setup typically takes 30–60s. You can type in the terminal immediately; input will be queued until ready.</span>
          </div>
        )}

        <div className="dialog-actions">
          <button className="cancel" onClick={onCancel} disabled={isLoading}>Cancel</button>
          <button
            className="confirm"
            onClick={handleNext}
            disabled={isNextDisabled || isLoading}
          >
            {isLoading ? 'Loading…' : mode === 'worktree' ? 'Swap & Launch' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
