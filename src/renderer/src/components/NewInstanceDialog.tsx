import { useState, useEffect } from 'react'
import type { AgentDef, CliBackend } from '../types'
import { COLORS, COLOR_MAP } from '../lib/constants'

interface Props {
  onCreate: (opts: {
    name?: string
    workingDirectory?: string
    color?: string
    args?: string[]
    cliBackend?: CliBackend
  }) => void | Promise<void>
  onClose: () => void
  prefill?: AgentDef
}

function resolveColor(c?: string): string {
  if (!c) return COLORS[0]
  return COLOR_MAP[c] || c
}

interface EnvOption {
  id: string
  name: string
  paths: Record<string, string>
  branch: string
  status: string
}

export default function NewInstanceDialog({ onCreate, onClose, prefill }: Props) {
  const [name, setName] = useState(prefill?.name || '')
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [color, setColor] = useState(resolveColor(prefill?.color))
  const [extraArgs, setExtraArgs] = useState('')
  const [cliBackend, setCliBackend] = useState<CliBackend>('claude')
  const [creating, setCreating] = useState(false)
  const [environments, setEnvironments] = useState<EnvOption[]>([])

  useEffect(() => {
    window.api.settings.getAll().then((s) => {
      setCliBackend(s.defaultCliBackend === 'cursor-agent' ? 'cursor-agent' : 'claude')
    })
    // Load environments for picker
    window.api.env?.list?.().then((envs: any[]) => {
      if (envs?.length) setEnvironments(envs)
    }).catch(() => {})
  }, [])

  const handlePickDir = async () => {
    const dir = await window.api.dialog.openDirectory()
    if (dir) setWorkingDirectory(dir)
  }

  const handleCreate = async () => {
    if (creating) return
    setCreating(true)
    const args = extraArgs.trim() ? extraArgs.trim().split(/\s+/) : undefined
    try {
      await onCreate({
        name: name.trim() || undefined,
        workingDirectory: workingDirectory.trim() || undefined,
        color,
        args,
        cliBackend,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      window.alert(`Could not create session: ${message}`)
      setCreating(false)
    }
  }

  const handleClose = () => {
    setCreating(false)
    onClose()
  }

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className="dialog-overlay" onClick={handleClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); handleCreate() }}>
        <h2>{prefill ? `Launch: ${prefill.name}` : 'New Session'}</h2>

        {prefill && (
          <div className="dialog-agent-info">
            {prefill.description}
          </div>
        )}

        <div className="dialog-field">
          <label>Name</label>
          <input
            placeholder="My Project"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>

        <div className="dialog-field">
          <label>Working Directory</label>
          <div className="dir-picker">
            <input
              placeholder="~ (home directory)"
              value={workingDirectory}
              onChange={(e) => setWorkingDirectory(e.target.value)}
            />
            <button type="button" onClick={handlePickDir} title="Browse directory">Browse</button>
          </div>
        </div>

        {environments.length > 0 && (
          <div className="dialog-field">
            <label>Environment (optional)</label>
            <div className="dialog-env-picker">
              {environments.map(env => (
                <button
                  key={env.id}
                  type="button"
                  className={`dialog-env-chip ${workingDirectory === (env.paths.root || env.paths.backend) ? 'active' : ''}`}
                  onClick={() => {
                    const dir = env.paths.root || env.paths.backend || ''
                    setWorkingDirectory(dir)
                    if (!name.trim()) setName(`${env.name}`)
                  }}
                >
                  <span className={`dialog-env-dot ${env.status === 'running' ? 'running' : env.status === 'partial' ? 'partial' : ''}`} />
                  {env.name}
                  <span className="dialog-env-branch">{env.branch}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="dialog-field">
          <label>Color</label>
          <div className="color-picker">
            {COLORS.map((c) => (
              <div
                key={c}
                className={`color-swatch ${c === color ? 'selected' : ''}`}
                style={{ backgroundColor: c }}
                onClick={() => setColor(c)}
              />
            ))}
            <input
              type="color"
              className="color-input-native"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              title="Custom color"
            />
          </div>
        </div>

        <div className="dialog-field">
          <label>Extra CLI Arguments (optional)</label>
          <input
            placeholder="e.g. --model sonnet"
            value={extraArgs}
            onChange={(e) => setExtraArgs(e.target.value)}
          />
        </div>

        <div className="dialog-field">
          <label>CLI for this session</label>
          <select
            value={cliBackend}
            onChange={(e) => setCliBackend(e.target.value as CliBackend)}
            className="settings-select"
            style={{ width: '100%' }}
          >
            <option value="claude">Claude Code (claude)</option>
            <option value="cursor-agent">Cursor Agent (agent)</option>
          </select>
        </div>

        <div className="dialog-actions">
          <button type="button" className="cancel" onClick={handleClose} disabled={creating} title="Cancel">Cancel</button>
          <button type="submit" className="confirm" disabled={creating} title="Create session">{creating ? 'Creating...' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}
