import { useEffect } from 'react'
import { X } from 'lucide-react'
import { helpContent } from '../lib/help-content'

interface Props { onClose: () => void }

const shortcutGroups = Object.values(helpContent)
  .filter(topic => topic.shortcuts && topic.shortcuts.length > 0)
  .map(topic => ({ title: topic.title, shortcuts: topic.shortcuts! }))

export default function ShortcutOverlay({ onClose }: Props) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === '/' && e.metaKey) { e.preventDefault(); onClose() }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  return (
    <div className="shortcut-overlay-backdrop" onClick={onClose}>
      <div className="shortcut-overlay" onClick={e => e.stopPropagation()}>
        <div className="shortcut-overlay-header">
          <h2>Keyboard Shortcuts</h2>
          <button className="shortcut-overlay-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="shortcut-overlay-body">
          {shortcutGroups.map(group => (
            <div key={group.title} className="shortcut-group">
              <h3>{group.title}</h3>
              {group.shortcuts.map((s, i) => (
                <div key={i} className="shortcut-row">
                  <kbd>{s.keys}</kbd>
                  <span>{s.action}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
