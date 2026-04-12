import React, { useState, useEffect } from 'react'
import { Swords, X, Loader2 } from 'lucide-react'
import HelpPopover from './HelpPopover'
import type { GitHubRepo } from '../types'

interface ArenaPrefill {
  count: number
  models: (string | null)[]
  prompt: string
}

interface QuickContext {
  repo: string  // "owner/name"
  branch: string
}

const QUICK_MODELS = [
  { id: 'claude-opus-4-6', label: 'Opus' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku' },
]

interface Props {
  onClose: () => void
  onLaunch: (result: { instances: string[]; worktrees: string[] }) => void
  prefill?: ArenaPrefill
  mode?: 'quick' | 'full'
  quickContext?: QuickContext
}

export default function ArenaLaunchDialog({ onClose, onLaunch, prefill, mode = 'full', quickContext }: Props) {
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [selectedRepo, setSelectedRepo] = useState<string>(quickContext?.repo ?? '')
  const [branch, setBranch] = useState(quickContext?.branch ?? 'main')
  const [count, setCount] = useState(prefill?.count ?? 2)
  const [prompt, setPrompt] = useState(prefill?.prompt ?? '')
  const [models, setModels] = useState<string[]>(
    prefill?.models?.map(m => m ?? '') ?? ['', '']
  )
  const [checkedModels, setCheckedModels] = useState<Set<string>>(
    new Set(['claude-opus-4-6', 'claude-sonnet-4-6'])
  )
  const [launching, setLaunching] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.github.getRepos().then((r: GitHubRepo[]) => {
      setRepos(r)
      if (!selectedRepo && r.length > 0) setSelectedRepo(`${r[0].owner}/${r[0].name}`)
    })
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  // Keep models array in sync with count
  useEffect(() => {
    setModels(prev => {
      if (prev.length === count) return prev
      const next = [...prev]
      while (next.length < count) next.push('')
      return next.slice(0, count)
    })
  }, [count])

  const handleLaunch = async () => {
    const repo = selectedRepo
    if (!repo) {
      setError('Select a repository')
      return
    }
    if (!branch.trim()) {
      setError('Branch is required')
      return
    }

    // In quick mode, derive count and models from checked models
    const effectiveCount = mode === 'quick' ? checkedModels.size : count
    const effectiveModels = mode === 'quick'
      ? [...checkedModels].map(m => m || null)
      : models.map(m => m.trim() || null)

    if (mode === 'quick' && checkedModels.size < 2) {
      setError('Select at least 2 models to compare')
      return
    }

    setError(null)
    setLaunching(true)
    try {
      const [owner, repoName] = repo.split('/')
      const result = await window.api.arena.launchWithWorktrees({
        owner,
        repoName,
        branch: branch.trim(),
        count: effectiveCount,
        prompt: prompt.trim() || undefined,
        models: effectiveModels,
      })
      onLaunch(result)
      onClose()
    } catch (err: any) {
      setError(err?.message ?? 'Failed to launch arena')
      setLaunching(false)
    }
  }

  return (
    <div className="fork-modal-overlay" onClick={onClose}>
      <div className="fork-modal" style={{ maxWidth: 480 }} onClick={e => e.stopPropagation()}>
        <div className="fork-modal-header">
          <span className="fork-modal-title">
            <Swords size={15} /> {mode === 'quick' ? 'Quick Compare' : 'Launch Arena'}
          </span>
          <HelpPopover topic="arena" align="right" />
          <button className="fork-modal-close" onClick={onClose} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        <div className="fork-modal-body">
          {mode === 'quick' ? (
            <>
              <div className="fork-modal-hint">
                Compare models side-by-side on the same task.
                {quickContext && <span style={{ opacity: 0.7 }}> Using {quickContext.repo} @ {quickContext.branch}</span>}
              </div>

              <div className="fork-modal-field">
                <label className="fork-modal-label">Prompt</label>
                <textarea
                  className="fork-modal-textarea"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="What should each model work on?"
                  rows={3}
                  disabled={launching}
                  autoFocus
                />
              </div>

              <div className="fork-modal-field">
                <label className="fork-modal-label">Models ({checkedModels.size} selected)</label>
                <div className="arena-model-checkboxes">
                  {QUICK_MODELS.map(m => (
                    <label key={m.id} className="arena-model-checkbox">
                      <input
                        type="checkbox"
                        checked={checkedModels.has(m.id)}
                        onChange={e => {
                          setCheckedModels(prev => {
                            const next = new Set(prev)
                            if (e.target.checked) next.add(m.id)
                            else next.delete(m.id)
                            return next
                          })
                        }}
                        disabled={launching}
                      />
                      {m.label}
                    </label>
                  ))}
                </div>
              </div>

              {!quickContext && (
                <>
                  <div className="fork-modal-field">
                    <label className="fork-modal-label">Repository</label>
                    <select
                      className="fork-modal-input"
                      value={selectedRepo}
                      onChange={e => setSelectedRepo(e.target.value)}
                      disabled={launching}
                    >
                      {repos.length === 0 && <option value="">No repos configured</option>}
                      {repos.map(r => (
                        <option key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`}>
                          {r.owner}/{r.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="fork-modal-field">
                    <label className="fork-modal-label">Branch</label>
                    <input
                      className="fork-modal-input"
                      value={branch}
                      onChange={e => setBranch(e.target.value)}
                      placeholder="e.g. main"
                      disabled={launching}
                    />
                  </div>
                </>
              )}
            </>
          ) : (
            <>
              <div className="fork-modal-hint">
                Create isolated worktrees and spawn parallel sessions for side-by-side comparison.
                Each agent gets its own branch checkout.
              </div>

              <div className="fork-modal-field">
                <label className="fork-modal-label">Repository</label>
                <select
                  className="fork-modal-input"
                  value={selectedRepo}
                  onChange={e => setSelectedRepo(e.target.value)}
                  disabled={launching}
                >
                  {repos.length === 0 && <option value="">No repos configured</option>}
                  {repos.map(r => (
                    <option key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`}>
                      {r.owner}/{r.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="fork-modal-field">
                <label className="fork-modal-label">Branch</label>
                <input
                  className="fork-modal-input"
                  value={branch}
                  onChange={e => setBranch(e.target.value)}
                  placeholder="e.g. main, develop, feature/xyz"
                  disabled={launching}
                />
              </div>

              <div className="fork-modal-field">
                <label className="fork-modal-label">Agents ({count})</label>
                <div className="arena-launch-count">
                  {[2, 3, 4].map(n => (
                    <button
                      key={n}
                      className={`arena-launch-count-btn${count === n ? ' active' : ''}`}
                      onClick={() => setCount(n)}
                      disabled={launching}
                    >
                      {n}
                    </button>
                  ))}
                </div>
              </div>

              <div className="fork-modal-field">
                <label className="fork-modal-label">Prompt (optional)</label>
                <textarea
                  className="fork-modal-textarea"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder="Broadcast this prompt to all agents after launch"
                  rows={3}
                  disabled={launching}
                />
              </div>

              <div className="fork-modal-field">
                <label className="fork-modal-label">Model overrides (optional)</label>
                {models.map((m, i) => (
                  <input
                    key={i}
                    className="fork-modal-input"
                    value={m}
                    onChange={e => {
                      const next = [...models]
                      next[i] = e.target.value
                      setModels(next)
                    }}
                    placeholder={`Agent ${i + 1} model (e.g. sonnet, opus)`}
                    disabled={launching}
                    style={{ marginBottom: i < models.length - 1 ? 4 : 0 }}
                  />
                ))}
              </div>
            </>
          )}

          {error && <div className="fork-modal-error">{error}</div>}
        </div>

        <div className="fork-modal-footer">
          <button className="fork-modal-cancel" onClick={onClose} disabled={launching}>
            Cancel
          </button>
          <button
            className="fork-modal-submit"
            onClick={handleLaunch}
            disabled={launching || !selectedRepo || !branch.trim() || (mode === 'quick' && checkedModels.size < 2)}
          >
            {launching ? <><Loader2 size={13} className="spin" /> Creating...</> : mode === 'quick' ? <>Compare</> : <>Launch Arena</>}
          </button>
        </div>
      </div>
    </div>
  )
}
