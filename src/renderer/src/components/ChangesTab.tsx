import { useEffect, useRef, useCallback, useState } from 'react'
import { ChevronRight, RefreshCw, RotateCw, Undo2, Sparkles, X, MessageCircleWarning, GitCompare, GitCommit, Bookmark, Trash2, GitBranch } from 'lucide-react'
import type { GitDiffEntry, ColonyComment, ScoreCard } from '../../../shared/types'
import type { ClaudeInstance } from '../types'
import DiffViewer from './DiffViewer'
import CommitDialog from './CommitDialog'

interface CheckpointTag {
  tag: string
  date: string
  hash: string
}

interface ChangesTabProps {
  instance: ClaudeInstance
  onChangeCount?: (count: number) => void
}

export default function ChangesTab({ instance, onChangeCount }: ChangesTabProps) {
  const [gitChanges, setGitChanges] = useState<GitDiffEntry[]>([])
  const [gitChangesLoading, setGitChangesLoading] = useState(false)
  const [colonyComments, setColonyComments] = useState<ColonyComment[]>([])
  const [reverting, setReverting] = useState<Set<string>>(new Set())
  const [revertingAll, setRevertingAll] = useState(false)
  const [scoreCard, setScoreCard] = useState<ScoreCard | null>(null)
  const [scoreCardLoading, setScoreCardLoading] = useState(false)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [expandedDiffFile, setExpandedDiffFile] = useState<string | null>(null)
  const diffCacheRef = useRef<Record<string, string>>({})
  const [diffContent, setDiffContent] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)

  // Checkpoint state
  const [checkpoints, setCheckpoints] = useState<CheckpointTag[]>([])
  const [checkpointsOpen, setCheckpointsOpen] = useState(true)
  const [savingCheckpoint, setSavingCheckpoint] = useState(false)
  const [expandedCheckpoint, setExpandedCheckpoint] = useState<string | null>(null)
  const [checkpointDiff, setCheckpointDiff] = useState<string | null>(null)
  const [checkpointDiffLoading, setCheckpointDiffLoading] = useState(false)
  const [restoringCheckpoint, setRestoringCheckpoint] = useState<string | null>(null)

  const tagPrefix = `colony-cp/${instance.id}/`

  const loadCheckpoints = useCallback(async () => {
    if (!instance.workingDirectory) return
    try {
      const tags = await window.api.git.listTags(instance.workingDirectory, tagPrefix)
      setCheckpoints(tags)
    } catch {
      setCheckpoints([])
    }
  }, [instance.workingDirectory, tagPrefix])

  const handleSaveCheckpoint = useCallback(async () => {
    if (!instance.workingDirectory) return
    setSavingCheckpoint(true)
    try {
      const ts = new Date().toISOString().replace(/[^0-9T:.Z-]/g, '')
      const tagName = `${tagPrefix}${ts}`
      await window.api.git.createTag(instance.workingDirectory, tagName)
      await loadCheckpoints()
    } catch (err: any) {
      console.error('Failed to create checkpoint:', err)
    } finally {
      setSavingCheckpoint(false)
    }
  }, [instance.workingDirectory, tagPrefix, loadCheckpoints])

  const handleRestoreCheckpoint = useCallback(async (cp: CheckpointTag) => {
    if (!instance.workingDirectory) return
    const branchName = `restore-${cp.hash}-${Date.now()}`
    if (!window.confirm(`Create branch "${branchName}" from checkpoint ${cp.hash}? This is non-destructive — your current branch stays intact.`)) return
    setRestoringCheckpoint(cp.tag)
    try {
      await window.api.git.createBranch(instance.workingDirectory, branchName, cp.tag)
    } catch (err: any) {
      console.error('Restore failed:', err)
    } finally {
      setRestoringCheckpoint(null)
    }
  }, [instance.workingDirectory])

  const handleDeleteCheckpoint = useCallback(async (cp: CheckpointTag) => {
    if (!instance.workingDirectory) return
    try {
      await window.api.git.deleteTag(instance.workingDirectory, cp.tag)
      await loadCheckpoints()
      if (expandedCheckpoint === cp.tag) {
        setExpandedCheckpoint(null)
        setCheckpointDiff(null)
      }
    } catch { /* ignore */ }
  }, [instance.workingDirectory, loadCheckpoints, expandedCheckpoint])

  const toggleCheckpointDiff = useCallback(async (cp: CheckpointTag) => {
    if (expandedCheckpoint === cp.tag) {
      setExpandedCheckpoint(null)
      setCheckpointDiff(null)
      return
    }
    setExpandedCheckpoint(cp.tag)
    setCheckpointDiffLoading(true)
    setCheckpointDiff(null)
    try {
      const result = await window.api.git.diffRange(instance.workingDirectory!, cp.tag)
      setCheckpointDiff(result.diff)
    } catch {
      setCheckpointDiff('')
    } finally {
      setCheckpointDiffLoading(false)
    }
  }, [expandedCheckpoint, instance.workingDirectory])

  // Load checkpoints on mount and when changes are refreshed
  useEffect(() => {
    loadCheckpoints()
  }, [loadCheckpoints])

  const loadGitChanges = useCallback(() => {
    if (!instance.workingDirectory) return
    setGitChangesLoading(true)
    diffCacheRef.current = {}
    window.api.session.gitChanges(instance.workingDirectory).then((entries) => {
      setGitChanges(entries)
      onChangeCount?.(entries.length)
      setGitChangesLoading(false)
    }).catch(() => {
      setGitChanges([])
      onChangeCount?.(0)
      setGitChangesLoading(false)
    })
  }, [instance.workingDirectory])

  // Load git changes on mount
  useEffect(() => {
    loadGitChanges()
  }, [instance.workingDirectory, loadGitChanges])

  // Poll changes every 10s
  useEffect(() => {
    if (!instance.workingDirectory) return
    const pollId = setInterval(loadGitChanges, 10000)
    return () => clearInterval(pollId)
  }, [instance.workingDirectory, loadGitChanges])

  // Load colony comments + subscribe to live push updates
  useEffect(() => {
    if (instance.status !== 'running') return
    window.api.session.getComments(instance.id).then(setColonyComments).catch(() => {})
    const unsub = window.api.session.onComments(({ instanceId, comments }) => {
      if (instanceId === instance.id) setColonyComments(comments)
    })
    return unsub
  }, [instance.id, instance.status])

  const handleRevert = useCallback(async (file: string) => {
    if (!instance.workingDirectory) return
    if (!window.confirm(`Revert "${file}"? This cannot be undone.`)) return
    setReverting(prev => new Set(prev).add(file))
    await window.api.session.gitRevert(instance.workingDirectory, file).catch(() => {})
    setReverting(prev => { const n = new Set(prev); n.delete(file); return n })
    loadGitChanges()
  }, [instance.workingDirectory, loadGitChanges])

  const handleRevertAll = useCallback(async () => {
    if (!instance.workingDirectory || gitChanges.length === 0) return
    if (!window.confirm(`Revert all ${gitChanges.length} changed file(s)? This cannot be undone.`)) return
    setRevertingAll(true)
    await Promise.all(gitChanges.map(e => window.api.session.gitRevert(instance.workingDirectory!, e.file).catch(() => {})))
    setRevertingAll(false)
    loadGitChanges()
  }, [instance.workingDirectory, gitChanges, loadGitChanges])

  const handleScoreOutput = useCallback(async () => {
    if (!instance.workingDirectory || gitChanges.length === 0) return
    setScoreCardLoading(true)
    setScoreCard(null)
    try {
      const result = await window.api.session.scoreOutput(instance.workingDirectory)
      setScoreCard(result)
    } catch {
      setScoreCard({ confidence: 0, scopeCreep: false, testCoverage: 'none', summary: 'Scoring failed.', raw: '' })
    } finally {
      setScoreCardLoading(false)
    }
  }, [instance.workingDirectory, gitChanges.length])

  const toggleFileDiff = useCallback(async (file: string, status: string) => {
    if (expandedDiffFile === file) {
      setExpandedDiffFile(null)
      setDiffContent(null)
      return
    }
    setExpandedDiffFile(file)
    if (diffCacheRef.current[file]) {
      setDiffContent(diffCacheRef.current[file])
      return
    }
    setDiffLoading(true)
    setDiffContent(null)
    try {
      const raw = await window.api.session.getFileDiff(instance.workingDirectory!, file, status)
      diffCacheRef.current[file] = raw
      setDiffContent(raw)
    } catch {
      setDiffContent('')
    } finally {
      setDiffLoading(false)
    }
  }, [expandedDiffFile, instance.workingDirectory])

  return (
    <>
      <div className="changes-panel">
        <div className="changes-panel-header">
          <span className="changes-panel-title">
            <GitCompare size={13} /> Git Changes
          </span>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <button
              className="changes-refresh-btn"
              title="Refresh"
              onClick={loadGitChanges}
            >
              <RefreshCw size={12} />
            </button>
            <button
              className="changes-refresh-btn"
              title="Save checkpoint"
              disabled={savingCheckpoint}
              onClick={handleSaveCheckpoint}
              style={{ color: 'var(--accent)' }}
            >
              {savingCheckpoint ? <RotateCw size={12} className="spinning" /> : <Bookmark size={12} />}
            </button>
            {gitChanges.length > 0 && (
              <>
                <button
                  className="changes-refresh-btn"
                  title="Stage & Commit"
                  onClick={() => setShowCommitDialog(true)}
                  style={{ color: 'var(--success)' }}
                >
                  <GitCommit size={12} />
                </button>
                <button
                  className="changes-refresh-btn"
                  title="Score output quality with AI"
                  disabled={scoreCardLoading}
                  onClick={handleScoreOutput}
                  style={{ color: 'var(--accent)' }}
                >
                  {scoreCardLoading ? <RotateCw size={12} className="spinning" /> : <Sparkles size={12} />}
                </button>
                <button
                  className="changes-refresh-btn"
                  title="Revert all changes"
                  disabled={revertingAll}
                  onClick={handleRevertAll}
                  style={{ color: 'var(--danger)' }}
                >
                  <Undo2 size={12} />
                </button>
              </>
            )}
          </div>
        </div>
        <div className="changes-panel-content">
          {gitChangesLoading && <div className="changes-empty">Loading...</div>}
          {!gitChangesLoading && gitChanges.length === 0 && (
            <div className="changes-empty">No uncommitted changes.</div>
          )}
          {!gitChangesLoading && gitChanges.map((entry) => {
            const fileComments = colonyComments.filter(c => {
              const normalised = c.file.replace(/^b\//, '')
              return normalised === entry.file || normalised.endsWith('/' + entry.file) || entry.file.endsWith('/' + normalised)
            })
            return (
              <div key={entry.file} className={`changes-event${expandedDiffFile === entry.file ? ' expanded' : ''}`}>
                <div className="changes-event-header" style={{ alignItems: 'center', cursor: 'pointer' }} onClick={() => toggleFileDiff(entry.file, entry.status)}>
                  <ChevronRight size={11} style={{ flexShrink: 0, transition: 'transform 0.15s', transform: expandedDiffFile === entry.file ? 'rotate(90deg)' : 'none', opacity: 0.5 }} />
                  <span className="changes-event-tool" title={entry.status === 'A' ? 'Added' : entry.status === 'D' ? 'Deleted' : entry.status === 'R' ? 'Renamed' : 'Modified'} style={{
                    color: entry.status === 'A' ? 'var(--success)'
                      : entry.status === 'D' ? 'var(--danger)'
                      : 'var(--warning)',
                    minWidth: '12px',
                  }}>
                    {entry.status}
                  </span>
                  <span className="changes-event-input" style={{ flex: 1, fontFamily: 'monospace', fontSize: '11px' }}>
                    {entry.file}
                  </span>
                  <span className="changes-event-time" style={{ fontSize: '10px', opacity: 0.7 }}>
                    {entry.insertions > 0 && <span style={{ color: 'var(--success)' }}>+{entry.insertions}</span>}
                    {entry.insertions > 0 && entry.deletions > 0 && ' '}
                    {entry.deletions > 0 && <span style={{ color: 'var(--danger)' }}>-{entry.deletions}</span>}
                  </span>
                  {fileComments.length > 0 && (
                    <span style={{ marginLeft: '4px', fontSize: '10px', color: 'var(--warning)', opacity: 0.85, display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                      <MessageCircleWarning size={11} />
                      {fileComments.length > 1 && fileComments.length}
                    </span>
                  )}
                  <button
                    className="changes-refresh-btn"
                    title={`Revert ${entry.file}`}
                    disabled={reverting.has(entry.file)}
                    onClick={(e) => { e.stopPropagation(); handleRevert(entry.file) }}
                    style={{ marginLeft: '4px', color: 'var(--danger)' }}
                  >
                    {reverting.has(entry.file) ? <RotateCw size={11} className="spinning" /> : <Undo2 size={11} />}
                  </button>
                </div>
                {expandedDiffFile === entry.file && (
                  <div className="changes-diff-container">
                    {diffLoading ? (
                      <div className="diff-viewer-empty">Loading diff...</div>
                    ) : diffContent !== null ? (
                      <DiffViewer diff={diffContent} filename={entry.file} />
                    ) : null}
                  </div>
                )}
                {fileComments.map((comment, i) => (
                  <div key={i} style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: '6px',
                    padding: '4px 8px 4px 24px',
                    borderLeft: `2px solid ${comment.severity === 'error' ? 'var(--danger)' : comment.severity === 'warn' ? 'var(--warning)' : 'var(--accent)'}`,
                    marginTop: '2px',
                    background: 'var(--bg-secondary)',
                  }}>
                    <span style={{
                      fontSize: '9px',
                      fontWeight: 600,
                      letterSpacing: '0.04em',
                      color: comment.severity === 'error' ? 'var(--danger)' : comment.severity === 'warn' ? 'var(--warning)' : 'var(--accent)',
                      textTransform: 'uppercase',
                      minWidth: '28px',
                      paddingTop: '1px',
                    }}>
                      {comment.severity}
                    </span>
                    <span style={{ fontSize: '10px', opacity: 0.7, minWidth: '30px', fontFamily: 'monospace' }}>
                      L{comment.line}
                    </span>
                    <span style={{ fontSize: '11px', flex: 1, lineHeight: 1.4 }}>
                      {comment.message}
                    </span>
                  </div>
                ))}
              </div>
            )
          })}
          {/* Checkpoint Timeline */}
          <div className="checkpoint-section">
            <div className="checkpoint-section-header" onClick={() => setCheckpointsOpen(!checkpointsOpen)}>
              <ChevronRight size={11} style={{ transition: 'transform 0.15s', transform: checkpointsOpen ? 'rotate(90deg)' : 'none', opacity: 0.5 }} />
              <Bookmark size={12} />
              Checkpoints
              {checkpoints.length > 0 && (
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 400 }}>({checkpoints.length})</span>
              )}
            </div>
            {checkpointsOpen && (
              <>
                {checkpoints.length === 0 && (
                  <div className="checkpoint-empty">No checkpoints saved yet. Click the bookmark icon to save one.</div>
                )}
                {checkpoints.map((cp) => {
                  const d = new Date(cp.date)
                  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
                  const isExpanded = expandedCheckpoint === cp.tag
                  return (
                    <div key={cp.tag}>
                      <div
                        className={`checkpoint-row${isExpanded ? ' expanded' : ''}`}
                        onClick={() => toggleCheckpointDiff(cp)}
                      >
                        <ChevronRight size={10} style={{ flexShrink: 0, transition: 'transform 0.15s', transform: isExpanded ? 'rotate(90deg)' : 'none', opacity: 0.4 }} />
                        <span className="checkpoint-row-time">{timeStr}</span>
                        <span className="checkpoint-row-hash">{cp.hash}</span>
                        <span style={{ flex: 1 }} />
                        <div className="checkpoint-row-actions">
                          <button
                            className="checkpoint-restore-btn"
                            title="Create branch from this checkpoint"
                            disabled={restoringCheckpoint === cp.tag}
                            onClick={(e) => { e.stopPropagation(); handleRestoreCheckpoint(cp) }}
                          >
                            {restoringCheckpoint === cp.tag ? <RotateCw size={9} className="spinning" /> : <><GitBranch size={9} /> Restore</>}
                          </button>
                          <button
                            className="changes-refresh-btn"
                            title="Delete checkpoint"
                            onClick={(e) => { e.stopPropagation(); handleDeleteCheckpoint(cp) }}
                            style={{ color: 'var(--danger)' }}
                          >
                            <Trash2 size={10} />
                          </button>
                        </div>
                      </div>
                      {isExpanded && (
                        <div className="checkpoint-diff-container">
                          {checkpointDiffLoading ? (
                            <div className="diff-viewer-empty">Loading diff...</div>
                          ) : checkpointDiff !== null ? (
                            checkpointDiff ? (
                              <DiffViewer diff={checkpointDiff} filename="checkpoint" />
                            ) : (
                              <div className="diff-viewer-empty">No changes since this checkpoint.</div>
                            )
                          ) : null}
                        </div>
                      )}
                    </div>
                  )
                })}
              </>
            )}
          </div>
          {scoreCard && (
            <div style={{
              margin: '8px 8px 4px',
              padding: '10px 12px',
              background: 'var(--bg-secondary)',
              borderRadius: '6px',
              border: '1px solid var(--border)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' }}>
                <Sparkles size={12} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                <span style={{ fontSize: '11px', fontWeight: 600, opacity: 0.9 }}>AI Score</span>
                <div style={{ display: 'flex', gap: '3px', marginLeft: '4px' }}>
                  {[1, 2, 3, 4, 5].map(i => (
                    <div key={i} style={{
                      width: '8px', height: '8px', borderRadius: '50%',
                      background: i <= scoreCard.confidence
                        ? (scoreCard.confidence >= 4 ? 'var(--success)' : scoreCard.confidence >= 2 ? 'var(--warning)' : 'var(--danger)')
                        : 'var(--border)',
                    }} />
                  ))}
                </div>
                {scoreCard.scopeCreep && (
                  <span style={{
                    fontSize: '9px', fontWeight: 600, padding: '1px 5px', borderRadius: '4px',
                    background: 'rgba(245,158,11,0.15)', color: 'var(--warning)',
                    border: '1px solid rgba(245,158,11,0.3)',
                  }}>SCOPE CREEP</span>
                )}
                <span style={{
                  fontSize: '9px', fontWeight: 600, padding: '1px 5px', borderRadius: '4px',
                  background: scoreCard.testCoverage === 'good' ? 'rgba(16,185,129,0.15)' : scoreCard.testCoverage === 'partial' ? 'rgba(245,158,11,0.15)' : 'rgba(239,68,68,0.12)',
                  color: scoreCard.testCoverage === 'good' ? 'var(--success)' : scoreCard.testCoverage === 'partial' ? 'var(--warning)' : 'var(--danger)',
                  border: scoreCard.testCoverage === 'good' ? '1px solid rgba(16,185,129,0.3)' : scoreCard.testCoverage === 'partial' ? '1px solid rgba(245,158,11,0.3)' : '1px solid rgba(239,68,68,0.2)',
                  marginLeft: 'auto',
                  textTransform: 'uppercase',
                }}>
                  {scoreCard.testCoverage === 'good' ? 'Tests OK' : scoreCard.testCoverage === 'partial' ? 'Tests' : 'No Tests'}
                </span>
                <button
                  className="changes-refresh-btn"
                  title="Dismiss"
                  onClick={() => setScoreCard(null)}
                  style={{ marginLeft: '4px' }}
                >
                  <X size={11} />
                </button>
              </div>
              <p style={{ fontSize: '11px', opacity: 0.8, margin: 0, lineHeight: 1.5 }}>
                {scoreCard.summary}
              </p>
            </div>
          )}
        </div>
      </div>
      {showCommitDialog && instance.workingDirectory && (
        <CommitDialog
          dir={instance.workingDirectory}
          entries={gitChanges}
          onClose={() => setShowCommitDialog(false)}
          onCommitted={loadGitChanges}
        />
      )}
    </>
  )
}
