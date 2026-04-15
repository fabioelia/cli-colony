import React, { useState, useEffect, useCallback } from 'react'
import { FileText, X, RefreshCw, ExternalLink, AlertCircle } from 'lucide-react'
import MarkdownViewer from './MarkdownViewer'

interface Props {
  envId: string
  envName: string
  hasWorktree: boolean
  onClose: () => void
}

type TabTarget = 'root' | 'worktree'

interface FileResult {
  exists: boolean
  content: string
  path: string
}

export default function EnvClaudeMdModal({ envId, envName, hasWorktree, onClose }: Props) {
  const [activeTab, setActiveTab] = useState<TabTarget>('root')
  const [rootFile, setRootFile] = useState<FileResult | null>(null)
  const [worktreeFile, setWorktreeFile] = useState<FileResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [regenerating, setRegenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const currentFile = activeTab === 'root' ? rootFile : worktreeFile

  const load = useCallback(async (target: TabTarget) => {
    setLoading(true)
    setError(null)
    try {
      const result = await window.api.env.readClaudeMd(envId, target)
      if (target === 'root') setRootFile(result)
      else setWorktreeFile(result)
    } catch (err: any) {
      setError(err?.message ?? 'Failed to read CLAUDE.md')
    } finally {
      setLoading(false)
    }
  }, [envId])

  useEffect(() => {
    load('root')
    if (hasWorktree) load('worktree')
  }, [load, hasWorktree])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const handleRegenerate = async () => {
    setRegenerating(true)
    setError(null)
    try {
      await window.api.env.regenerateClaudeMd(envId)
      // Re-read both targets to show merged content
      const [root, worktree] = await Promise.all([
        window.api.env.readClaudeMd(envId, 'root'),
        hasWorktree ? window.api.env.readClaudeMd(envId, 'worktree') : Promise.resolve(null),
      ])
      setRootFile(root)
      if (worktree) setWorktreeFile(worktree)
      setToast('Regenerated')
      setTimeout(() => setToast(null), 2000)
    } catch (err: any) {
      setError(err?.message ?? 'Regeneration failed')
    } finally {
      setRegenerating(false)
    }
  }

  const handleOpenInEditor = () => {
    if (currentFile?.path) {
      window.api.shell.openExternal(`file://${currentFile.path}`)
    }
  }

  return (
    <div className="env-claudemd-overlay" onClick={onClose}>
      <div className="env-claudemd-modal" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="env-claudemd-header">
          <span className="env-claudemd-title">
            <FileText size={15} />
            Context — {envName}
          </span>
          <div className="env-claudemd-header-right">
            {hasWorktree && (
              <div className="env-claudemd-tabs">
                <button
                  className={`env-claudemd-tab${activeTab === 'root' ? ' active' : ''}`}
                  onClick={() => setActiveTab('root')}
                >
                  Env Root
                </button>
                <button
                  className={`env-claudemd-tab${activeTab === 'worktree' ? ' active' : ''}`}
                  onClick={() => setActiveTab('worktree')}
                >
                  Worktree Bundle
                </button>
              </div>
            )}
            <button className="env-claudemd-close" onClick={onClose} aria-label="Close">
              <X size={14} />
            </button>
          </div>
        </div>

        {/* Path bar */}
        {currentFile && (
          <div className="env-claudemd-path">
            {currentFile.path}
          </div>
        )}

        {/* Body */}
        <div className="env-claudemd-body">
          {error && (
            <div className="env-claudemd-error">
              <AlertCircle size={13} />
              {error}
            </div>
          )}

          {loading && !currentFile && (
            <div className="env-claudemd-loading">Loading…</div>
          )}

          {!loading && !error && currentFile && !currentFile.exists && (
            <div className="env-claudemd-empty">
              <FileText size={28} />
              <p>No CLAUDE.md found at this location.</p>
              <button
                className="env-claudemd-generate-btn"
                onClick={handleRegenerate}
                disabled={regenerating}
              >
                {regenerating ? 'Generating…' : 'Generate'}
              </button>
            </div>
          )}

          {!error && currentFile && currentFile.exists && (
            <div className="env-claudemd-content">
              <MarkdownViewer content={currentFile.content} />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="env-claudemd-footer">
          {toast && <span className="env-claudemd-toast">{toast}</span>}
          <div className="env-claudemd-footer-right">
            <button
              className="env-claudemd-footer-btn"
              onClick={handleRegenerate}
              disabled={regenerating}
              title="Regenerate CLAUDE.md from current env config"
            >
              <RefreshCw size={13} className={regenerating ? 'spinning' : ''} />
              {regenerating ? 'Regenerating…' : 'Regenerate'}
            </button>
            <button
              className="env-claudemd-footer-btn"
              onClick={handleOpenInEditor}
              disabled={!currentFile?.path}
              title="Open in default editor"
            >
              <ExternalLink size={13} />
              Open in Editor
            </button>
            <button className="env-claudemd-footer-close" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
