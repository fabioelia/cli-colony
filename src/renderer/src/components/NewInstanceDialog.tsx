import { useState } from 'react'
import type { AgentDef } from '../types'

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

const COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#14b8a6', '#6366f1',
]

const COLOR_MAP: Record<string, string> = {
  red: '#ef4444', green: '#10b981', blue: '#3b82f6', purple: '#8b5cf6',
  orange: '#f97316', yellow: '#f59e0b', cyan: '#06b6d4', pink: '#ec4899',
  teal: '#14b8a6', indigo: '#6366f1',
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

  const handlePickDir = async () => {
    const dir = await window.api.dialog.openDirectory()
    if (dir) setWorkingDirectory(dir)
  }

  const handleCreate = () => {
    const args = extraArgs.trim() ? extraArgs.trim().split(/\s+/) : undefined
    onCreate({
      name: name.trim() || undefined,
      workingDirectory: workingDirectory.trim() || undefined,
      color,
      args,
    })
  }

  return (
    <div className="dialog-overlay" onClick={onClose}>
      <form className="dialog" onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); handleCreate() }}>
        <h2>{prefill ? `Launch: ${prefill.name}` : 'New Claude Instance'}</h2>

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
            <button type="button" onClick={handlePickDir}>Browse</button>
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
          <button type="button" className="cancel" onClick={onClose}>Cancel</button>
          <button type="submit" className="confirm">Create</button>
        </div>
      </form>
    </div>
  )
}
