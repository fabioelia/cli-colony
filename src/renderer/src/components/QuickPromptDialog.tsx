import { useState, useEffect, useRef } from 'react'
import { Play, Bookmark, Trash2, Pencil } from 'lucide-react'
import { getSnippets, saveSnippet, updateSnippet, deleteSnippet } from '../lib/prompt-snippets'

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
  const [tokenCount, setTokenCount] = useState(0)
  const [snippetsOpen, setSnippetsOpen] = useState(false)
  const [savingSnippet, setSavingSnippet] = useState(false)
  const [snippetName, setSnippetName] = useState('')
  const [snippetSearch, setSnippetSearch] = useState('')
  const [editingExisting, setEditingExisting] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const snippetsRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    requestAnimationFrame(() => promptRef.current?.focus())
  }, [])

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    if (!prompt.trim()) { setTokenCount(0); return }
    debounceRef.current = setTimeout(async () => {
      const count = await window.api.session.tokenizeApproximate(prompt)
      setTokenCount(count)
    }, 300)
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current) }
  }, [prompt])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (snippetsRef.current && !snippetsRef.current.contains(e.target as Node)) {
        setSnippetsOpen(false)
      }
    }
    if (snippetsOpen) document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [snippetsOpen])

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
          {tokenCount > 0 && (
            <span className="quick-prompt-token-count">~{tokenCount.toLocaleString()} tokens</span>
          )}
          <div style={{ display: 'flex', gap: 6, marginTop: 4, alignItems: 'center' }}>
            <div style={{ position: 'relative' }} ref={snippetsRef}>
              <button type="button" className="panel-header-btn" onClick={() => setSnippetsOpen(!snippetsOpen)}>
                <Bookmark size={12} /> Snippets
              </button>
              {snippetsOpen && (() => {
                const allSnippets = getSnippets()
                const filtered = allSnippets.filter(s => !snippetSearch.trim() || s.name.toLowerCase().includes(snippetSearch.toLowerCase()))
                return (
                  <div className="prompt-history-dropdown">
                    {allSnippets.length > 0 && (
                      <input
                        placeholder="Filter snippets..."
                        value={snippetSearch}
                        onChange={e => setSnippetSearch(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onMouseDown={e => e.stopPropagation()}
                        style={{ width: '100%', fontSize: 12, padding: '4px 8px', marginBottom: 4, background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', boxSizing: 'border-box' }}
                        autoFocus
                      />
                    )}
                    {filtered.map(s => (
                      <div key={s.name} className="prompt-history-item" style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                        <button type="button" title={s.prompt} style={{ flex: 1, textAlign: 'left', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer', padding: '2px 4px', fontSize: 12 }}
                          onClick={() => { setPrompt(s.prompt); setSnippetsOpen(false); setSnippetSearch('') }}>
                          <span className="prompt-history-text">{s.name}</span>
                        </button>
                        <button type="button" title="Edit snippet" style={{ opacity: 0.5, padding: '2px 4px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setPrompt(s.prompt)
                            setSnippetName(s.name)
                            setSavingSnippet(true)
                            setEditingExisting(true)
                            setSnippetsOpen(false)
                            setSnippetSearch('')
                          }}>
                          <Pencil size={11} />
                        </button>
                        <button type="button" title="Delete snippet" style={{ opacity: 0.5, padding: '2px 4px', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}
                          onClick={(e) => { e.stopPropagation(); deleteSnippet(s.name); setSnippetsOpen(false); setSnippetSearch(''); setTimeout(() => setSnippetsOpen(true), 0) }}>
                          <Trash2 size={11} />
                        </button>
                      </div>
                    ))}
                    {allSnippets.length === 0 && <div style={{ padding: '8px 12px', opacity: 0.5, fontSize: 12 }}>No snippets saved</div>}
                    {allSnippets.length > 0 && filtered.length === 0 && <div style={{ padding: '8px 12px', opacity: 0.5, fontSize: 12 }}>No matching snippets</div>}
                  </div>
                )
              })()}
            </div>
            {prompt.trim() && !savingSnippet && (
              <button type="button" className="panel-header-btn" onClick={() => setSavingSnippet(true)}>Save as snippet</button>
            )}
            {savingSnippet && (
              <>
                <input placeholder="Snippet name..." value={snippetName} onChange={e => setSnippetName(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && snippetName.trim()) {
                      editingExisting ? updateSnippet(snippetName, prompt) : saveSnippet(snippetName, prompt)
                      setSavingSnippet(false); setSnippetName(''); setEditingExisting(false)
                    }
                    if (e.key === 'Escape') { setSavingSnippet(false); setEditingExisting(false) }
                  }}
                  autoFocus style={{ fontSize: 12, padding: '2px 6px', width: 160 }} />
                <button type="button" className="panel-header-btn" disabled={!snippetName.trim()}
                  onClick={() => {
                    editingExisting ? updateSnippet(snippetName, prompt) : saveSnippet(snippetName, prompt)
                    setSavingSnippet(false); setSnippetName(''); setEditingExisting(false)
                  }}>{editingExisting ? 'Update' : 'Save'}</button>
              </>
            )}
          </div>
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
