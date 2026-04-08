import { useState } from 'react'
import { AlertCircle } from 'lucide-react'

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
    <div className="fixed inset-0 flex items-center justify-center z-50 bg-black/30">
      <div className="bg-bg-secondary rounded-lg shadow-lg p-6 w-96 border border-border">
        <h2 className="text-lg font-semibold mb-4">Environment for "{promptLabel}"</h2>

        <div className="space-y-4 mb-6">
          {/* Create New Option */}
          <label className="flex items-start gap-3 cursor-pointer p-3 rounded border border-border hover:bg-bg-tertiary transition-colors" style={{ borderColor: mode === 'create' ? 'var(--accent)' : undefined }}>
            <input
              type="radio"
              name="env-mode"
              value="create"
              checked={mode === 'create'}
              onChange={() => setMode('create')}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="font-medium">Create new environment</div>
              <div className="text-xs text-text-tertiary mt-1">Set up a fresh instance with all deps installed</div>
            </div>
          </label>

          {/* Reuse Existing Option */}
          <label className="flex items-start gap-3 cursor-pointer p-3 rounded border border-border hover:bg-bg-tertiary transition-colors" style={{ borderColor: mode === 'reuse' ? 'var(--accent)' : undefined, opacity: hasRunningInstances ? 1 : 0.5 }}>
            <input
              type="radio"
              name="env-mode"
              value="reuse"
              checked={mode === 'reuse'}
              onChange={() => setMode('reuse')}
              disabled={!hasRunningInstances}
              className="mt-1"
            />
            <div className="flex-1">
              <div className="font-medium">Reuse existing</div>
              <div className="text-xs text-text-tertiary mt-1">
                {hasRunningInstances ? `${runningInstances.length} running instance${runningInstances.length !== 1 ? 's' : ''} available` : 'No running instances'}
              </div>
            </div>
          </label>
        </div>

        {/* Instance Dropdown */}
        {mode === 'reuse' && hasRunningInstances && (
          <div className="mb-6">
            <label className="text-xs font-medium text-text-secondary mb-2 block">Select instance:</label>
            <select
              value={selectedInstanceId || ''}
              onChange={(e) => setSelectedInstanceId(e.target.value)}
              className="w-full px-3 py-2 rounded border border-border bg-bg-tertiary text-text-primary text-sm"
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

        {/* Gotcha Warning */}
        {mode === 'create' && (
          <div className="flex gap-2 p-3 rounded bg-amber-900/20 border border-amber-700/40 text-sm text-amber-100 mb-6">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <div>
              Setup typically takes 30–60s. You can type in the terminal immediately; input will be queued until ready.
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 justify-end">
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="px-4 py-2 rounded border border-border hover:bg-bg-tertiary disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleNext}
            disabled={isNextDisabled || isLoading}
            className="px-4 py-2 rounded bg-accent text-text-primary hover:opacity-90 disabled:opacity-50 transition-colors"
          >
            {isLoading ? 'Loading...' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  )
}
