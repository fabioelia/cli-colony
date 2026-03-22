import { useState, useEffect } from 'react'
import type { AgentDef } from '../types'
import { COLORS, COLOR_MAP } from '../lib/constants'

interface Props {
  onCreate: (opts: {
    name?: string
    workingDirectory?: string
    color?: string
    args?: string[]
  }) => void
  onClose: () => void
  prefill?: AgentDef
}

function resolveColor(c?: string): string {
  if (!c) return COLORS[0]
  return COLOR_MAP[c] || c
}

export default function NewInstanceDialog({ onCreate, onClose, prefill }: Props) {
  const [name, setName] = useState(prefill?.name || '')
  const [workingDirectory, setWorkingDirectory] = useState('')
  const [color, setColor] = useState(resolveColor(prefill?.color))
  const [extraArgs, setExtraArgs] = useState('')
  const [creating, setCreating] = useState(false)

  const handlePickDir = async () => {
    const dir = await window.api.dialog.openDirectory()
    if (dir) setWorkingDirectory(dir)
  }

  const handleCreate = () => {
    if (creating) return
    setCreating(true)
    const args = extraArgs.trim() ? extraArgs.trim().split(/\s+/) : undefined
    onCreate({
      name: name.trim() || undefined,
      workingDirectory: workingDirectory.trim() || undefined,
      color,
      args,
    })
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

        <div className="dialog-actions">
          <button type="button" className="cancel" onClick={handleClose} disabled={creating} title="Cancel">Cancel</button>
          <button type="submit" className="confirm" disabled={creating} title="Create session">{creating ? 'Creating...' : 'Create'}</button>
        </div>
      </form>
    </div>
  )
}
