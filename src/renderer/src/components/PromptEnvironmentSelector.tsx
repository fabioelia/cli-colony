import { useState, useEffect } from 'react'
import { AlertCircle } from 'lucide-react'
import HelpPopover from './HelpPopover'

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
  promptLabel: string
  repoName: string
  prNumber: number
}

export default function PromptEnvironmentSelector({
  instances,
  onCancel,
  onSelect,
  onSelectReuse,
  promptLabel,
  repoName,
  prNumber,
}: Props) {
  const [mode, setMode] = useState<'create' | 'reuse'>('create')
  const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null)
  const [isLoading, setIsLoading] = useState(false)

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onCancel])

  // Filter running instances
  const runningInstances = instances.filter((inst) => inst.status === 'running')
  const hasRunningInstances = runningInstances.length > 0

  const handleNext = async () => {
    setIsLoading(true)
    try {
      if (mode === 'create') {
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

  const isNextDisabled = mode === 'reuse' && !selectedInstanceId

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
              <div className="env-selector-option-title">Create new environment</div>
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
              <div className="env-selector-option-title">Reuse existing</div>
              <div className="env-selector-option-desc">
                {hasRunningInstances
                  ? `${runningInstances.length} running instance${runningInstances.length !== 1 ? 's' : ''} available`
                  : 'No running instances'}
              </div>
            </div>
          </label>
        </div>

        {/* Instance Dropdown */}
        {mode === 'reuse' && hasRunningInstances && (
          <div className="dialog-field">
            <label>Select instance:</label>
            <select
              value={selectedInstanceId || ''}
              onChange={(e) => setSelectedInstanceId(e.target.value)}
            >
              <option value="">— Choose instance —</option>
              {runningInstances.map((inst) => (
                <option key={inst.id} value={inst.id}>
                  {inst.name} · {inst.status} · {formatAge(inst.startedAt)}
                  {inst.costUsd ? ` · $${inst.costUsd.toFixed(2)}` : ''}
                </option>
              ))}
            </select>
          </div>
        )}

        {/* Setup Warning */}
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
            {isLoading ? 'Loading…' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
