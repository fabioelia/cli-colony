import React, { useState, useRef, useEffect } from 'react'
import { LayoutGrid, Plus, Trash2, Check } from 'lucide-react'
import type { SidebarView } from './Sidebar'
import Tooltip from './Tooltip'

export interface WorkspacePreset {
  id: string
  name: string
  view: SidebarView
  layout: 'single' | '2-up' | '4-up'
  sidebarWidth: number
}

const LS_KEY = 'workspace-presets'
const MAX_PRESETS = 10

const DEFAULT_PRESETS: WorkspacePreset[] = [
  { id: '_monitor', name: 'Monitor', view: 'personas', layout: 'single', sidebarWidth: 300 },
  { id: '_review', name: 'Review', view: 'review', layout: 'single', sidebarWidth: 380 },
  { id: '_compare', name: 'Compare', view: 'instances', layout: '4-up', sidebarWidth: 300 },
]

export function loadPresets(): WorkspacePreset[] {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return [...DEFAULT_PRESETS]
    const parsed = JSON.parse(raw) as WorkspacePreset[]
    return Array.isArray(parsed) ? parsed : [...DEFAULT_PRESETS]
  } catch {
    return [...DEFAULT_PRESETS]
  }
}

function savePresets(presets: WorkspacePreset[]) {
  localStorage.setItem(LS_KEY, JSON.stringify(presets))
}

interface Props {
  currentView: SidebarView
  currentLayout: 'single' | '2-up' | '4-up'
  onLoadPreset: (preset: WorkspacePreset) => void
}

export default function WorkspacePresets({ currentView, currentLayout, onLoadPreset }: Props) {
  const [open, setOpen] = useState(false)
  const [presets, setPresets] = useState<WorkspacePreset[]>(loadPresets)
  const [saving, setSaving] = useState(false)
  const [saveName, setSaveName] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)

  // Close popover on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false)
        setSaving(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (saving && inputRef.current) inputRef.current.focus()
  }, [saving])

  const handleSave = () => {
    const name = saveName.trim()
    if (!name) return
    const sidebarWidth = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sidebar-width'), 10) || 300
    const preset: WorkspacePreset = {
      id: `preset-${Date.now()}`,
      name,
      view: currentView,
      layout: currentLayout,
      sidebarWidth,
    }
    const next = [...presets, preset].slice(-MAX_PRESETS)
    setPresets(next)
    savePresets(next)
    setSaving(false)
    setSaveName('')
  }

  const handleDelete = (id: string) => {
    const next = presets.filter(p => p.id !== id)
    setPresets(next)
    savePresets(next)
  }

  const handleLoad = (preset: WorkspacePreset) => {
    onLoadPreset(preset)
    setOpen(false)
  }

  return (
    <div style={{ position: 'relative' }} ref={popoverRef}>
      <Tooltip text="Workspace Presets" detail="Save and restore workspace layouts. Cmd+Shift+1-5 for quick-switch." position="top">
        <button
          className={`sidebar-footer-btn ${open ? 'active' : ''}`}
          onClick={() => { setOpen(!open); setSaving(false) }}
        >
          <LayoutGrid size={14} />
        </button>
      </Tooltip>

      {open && (
        <div className="preset-popover" onClick={e => e.stopPropagation()}>
          <div className="preset-popover-header">
            <span>Workspace Presets</span>
            <button
              className="preset-popover-add"
              onClick={() => setSaving(true)}
              disabled={saving || presets.length >= MAX_PRESETS}
              title={presets.length >= MAX_PRESETS ? `Max ${MAX_PRESETS} presets` : 'Save current layout'}
            >
              <Plus size={13} />
            </button>
          </div>

          {saving && (
            <div className="preset-save-row">
              <input
                ref={inputRef}
                className="preset-save-input"
                placeholder="Preset name…"
                value={saveName}
                onChange={e => setSaveName(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') handleSave()
                  if (e.key === 'Escape') { setSaving(false); setSaveName('') }
                }}
                maxLength={30}
              />
              <button className="preset-save-confirm" onClick={handleSave} disabled={!saveName.trim()}>
                <Check size={13} />
              </button>
            </div>
          )}

          <div className="preset-list">
            {presets.length === 0 && (
              <div className="preset-empty">No presets yet. Click + to save your current layout.</div>
            )}
            {presets.map((preset, idx) => (
              <div
                key={preset.id}
                className="preset-item"
                onClick={() => handleLoad(preset)}
              >
                <span className="preset-item-name">{preset.name}</span>
                <span className="preset-item-meta">
                  {preset.view} · {preset.layout}
                </span>
                {idx < 5 && (
                  <span className="preset-item-shortcut">⇧⌘{idx + 1}</span>
                )}
                <button
                  className="preset-item-delete"
                  onClick={e => { e.stopPropagation(); handleDelete(preset.id) }}
                  title="Delete preset"
                >
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
