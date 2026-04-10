import { useState, useEffect, useRef } from 'react'
import { Play } from 'lucide-react'

interface Props {
  onClose: () => void
  onLaunch: (prompt: string, workingDirectory: string) => void
  recentDirs: string[]
  promptHistory: string[]
}

export default function QuickPromptDialog({ onClose, onLaunch, recentDirs, promptHistory }: Props) {
  const [prompt, setPrompt] = useState('')
  const [workingDir, setWorkingDir] = useState('')
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [showDirList, setShowDirList] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    requestAnimationFrame(() => promptRef.current?.focus())
  }, [])

  const filteredDirs = workingDir
    ? recentDirs.filter((d) => d.toLowerCase().includes(workingDir.toLowerCase()))
    : recentDirs

  const handlePromptKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowUp' && historyIndex < promptHistory.length - 1) {
      e.preventDefault()
      const newIdx = historyIndex + 1
      setHistoryIndex(newIdx)
      setPrompt(promptHistory[newIdx] || '')
    } else if (e.key === 'ArrowDown' && historyIndex > -1) {
      e.preventDefault()
      const newIdx = historyIndex - 1
      setHistoryIndex(newIdx)
      setPrompt(newIdx === -1 ? '' : promptHistory[newIdx] || '')
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleLaunch()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  const handleLaunch = () => {
    if (!prompt.trim()) return
    onLaunch(prompt.trim(), workingDir.trim())
  }

  return (
    <div className="dialog-overlay">
      <div className="dialog quick-prompt-dialog" onClick={(e) => e.stopPropagation()}>
        <h2><Play size={16} style={{ display: 'inline', marginRight: 8 }} />Quick Prompt</h2>
        <p className="quick-prompt-hint">Launch a new Claude session with a prompt pre-filled. <kbd>⌘↵</kbd> to launch, <kbd>↑↓</kbd> for history.</p>

        <div className="dialog-field">
          <label>Prompt</label>
          <textarea
            ref={promptRef}
            className="quick-prompt-textarea"
            placeholder="Ask Claude something..."
            value={prompt}
            onChange={(e) => { setPrompt(e.target.value); setHistoryIndex(-1) }}
            onKeyDown={handlePromptKeyDown}
            rows={5}
          />
        </div>

        <div className="dialog-field" style={{ position: 'relative' }}>
          <label>Working Directory</label>
          <div className="dir-picker">
            <input
              placeholder="~ (home directory)"
              value={workingDir}
              onChange={(e) => setWorkingDir(e.target.value)}
              onFocus={() => setShowDirList(true)}
              onBlur={() => setTimeout(() => setShowDirList(false), 150)}
            />
            <button type="button" onClick={async () => {
              const dir = await window.api.dialog.openDirectory()
              if (dir) setWorkingDir(dir)
            }}>Browse</button>
          </div>
          {showDirList && filteredDirs.length > 0 && (
            <div className="quick-prompt-dir-list">
              {filteredDirs.slice(0, 8).map((d) => (
                <div
                  key={d}
                  className="quick-prompt-dir-item"
                  onMouseDown={() => { setWorkingDir(d); setShowDirList(false) }}
                >
                  {d}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="dialog-actions">
          <button className="cancel" onClick={onClose}>Cancel</button>
          <button className="confirm" onClick={handleLaunch} disabled={!prompt.trim()}>Launch</button>
        </div>
      </div>
    </div>
  )
}
