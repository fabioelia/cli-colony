import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { GitCompare, RefreshCw, ChevronDown, ChevronRight, Terminal, GitBranch, Copy, Filter, RotateCw, Clock, GitCommit, Upload, AlertTriangle, Undo2, Download, ArrowDown, ExternalLink, FolderOpen, Search, X } from 'lucide-react'
import type { ClaudeInstance } from '../types'
import type { GitDiffEntry } from '../../../shared/types'
import HelpPopover from './HelpPopover'
import DiffViewer from './DiffViewer'
import CommitDialog from './CommitDialog'

interface UnpushedCommit {
  hash: string
  subject: string
  author: string
  date: string
}

interface SessionChanges {
  instanceId: string
  name: string
  color: string
  status: 'running' | 'exited'
  dir: string
  branch: string | null
  createdAt: string
  entries: GitDiffEntry[]
  loading: boolean
  error: boolean
  ticket?: { source: 'jira'; key: string; summary: string }
}

interface ReviewPanelProps {
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
}

type FilterMode = 'changes' | 'all'
type ReviewTab = 'changes' | 'commits'

function ReviewPanel({ instances, onFocusInstance }: ReviewPanelProps) {
  const [activeTab, setActiveTab] = useState<ReviewTab>('changes')
  const [sessionChanges, setSessionChanges] = useState<SessionChanges[]>([])
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<FilterMode>('changes')
  const [selectedDiffKey, setSelectedDiffKey] = useState<string | null>(null)
  const [reviewDiffContent, setReviewDiffContent] = useState<string | null>(null)
  const [reviewDiffLoading, setReviewDiffLoading] = useState(false)
  const reviewDiffCache = useRef<Record<string, string>>({})
  const [fileSearch, setFileSearch] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [copiedBranch, setCopiedBranch] = useState<string | null>(null)
  const [revertingFile, setRevertingFile] = useState<string | null>(null)
  const [revertingAllSession, setRevertingAllSession] = useState<string | null>(null)
  const [commitSession, setCommitSession] = useState<SessionChanges | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const initialLoadDone = useRef(false)

  // Commits tab state
  const [unpushedCommits, setUnpushedCommits] = useState<UnpushedCommit[]>([])
  const [commitsLoading, setCommitsLoading] = useState(false)
  const [commitSearch, setCommitSearch] = useState('')
  const [selectedCommitHash, setSelectedCommitHash] = useState<string | null>(null)
  const [commitDiffContent, setCommitDiffContent] = useState<string | null>(null)
  const [commitDiffLoading, setCommitDiffLoading] = useState(false)
  const commitDiffCache = useRef<Record<string, string>>({})
  const [pushing, setPushing] = useState(false)
  const [pushError, setPushError] = useState(false)
  const [pushConfirm, setPushConfirm] = useState(false)
  const [branchName, setBranchName] = useState<string>('')
  const [behindCount, setBehindCount] = useState(0)
  const [pulling, setPulling] = useState(false)
  const [fetching, setFetching] = useState(false)
  const [pullError, setPullError] = useState<string | null>(null)
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean }>>([])
  const [showBranchPicker, setShowBranchPicker] = useState(false)
  const [switching, setSwitching] = useState(false)
  const branchPickerRef = useRef<HTMLDivElement>(null)

  const instancesWithDir = instances.filter(i => i.workingDirectory)
  const instanceIds = instancesWithDir.map(i => i.id).join(',')

  const loadAllChanges = useCallback(async () => {
    const results = await Promise.allSettled(
      instancesWithDir.map(async (inst) => {
        const entries = await window.api.session.gitChanges(inst.workingDirectory)
        return {
          instanceId: inst.id,
          name: inst.name,
          color: inst.color,
          status: inst.status,
          dir: inst.workingDirectory,
          branch: inst.gitBranch,
          createdAt: inst.createdAt,
          ticket: inst.ticket,
          entries,
          loading: false,
          error: false,
        } as SessionChanges
      })
    )
    // Merge results into existing state — preserves old data until new data arrives
    setSessionChanges(prev => {
      const byId = new Map(prev.map(s => [s.instanceId, s]))
      const currentIds = new Set(instancesWithDir.map(i => i.id))
      results.forEach((r, i) => {
        const inst = instancesWithDir[i]
        if (r.status === 'fulfilled') {
          byId.set(inst.id, r.value)
        } else {
          // Keep existing entries on error instead of wiping
          const existing = byId.get(inst.id)
          byId.set(inst.id, {
            instanceId: inst.id,
            name: inst.name,
            color: inst.color,
            status: inst.status,
            dir: inst.workingDirectory,
            branch: inst.gitBranch,
            createdAt: inst.createdAt,
            ticket: inst.ticket,
            entries: existing?.entries ?? [],
            loading: false,
            error: true,
          })
        }
      })
      // Remove sessions no longer present
      return Array.from(byId.values()).filter(s => currentIds.has(s.instanceId))
    })
  }, [instanceIds])

  // Initial load — only reset to loading:true on first mount
  useEffect(() => {
    if (!initialLoadDone.current) {
      initialLoadDone.current = true
      setSessionChanges(instancesWithDir.map(inst => ({
        instanceId: inst.id,
        name: inst.name,
        color: inst.color,
        status: inst.status,
        dir: inst.workingDirectory,
        branch: inst.gitBranch,
        createdAt: inst.createdAt,
        ticket: inst.ticket,
        entries: [],
        loading: true,
        error: false,
      })))
    }
    loadAllChanges()
  }, [instanceIds])

  // Load unpushed commits — uses first instance's workingDirectory as project root
  const projectDir = instancesWithDir[0]?.workingDirectory ?? ''

  const loadUnpushedCommits = useCallback(async () => {
    if (!projectDir) return
    setCommitsLoading(true)
    try {
      const [commits, info, behind, branchList] = await Promise.all([
        window.api.git.unpushedCommits(projectDir),
        window.api.git.branchInfo(projectDir),
        window.api.git.behindCount(projectDir),
        window.api.git.listBranches(projectDir).catch(() => [] as Array<{ name: string; current: boolean }>),
      ])
      setUnpushedCommits(commits)
      setBranchName(info.branch)
      setBehindCount(behind)
      setBranches(branchList)
    } catch {
      setUnpushedCommits([])
    } finally {
      setCommitsLoading(false)
    }
  }, [projectDir])

  // Load commits on tab switch and initial mount
  useEffect(() => {
    if (activeTab === 'commits') loadUnpushedCommits()
  }, [activeTab, loadUnpushedCommits])

  // Poll every 30s — show subtle spinner during background polls
  useEffect(() => {
    pollRef.current = setInterval(async () => {
      setRefreshing(true)
      await Promise.all([
        loadAllChanges(),
        activeTab === 'commits' ? loadUnpushedCommits() : Promise.resolve(),
      ])
      setRefreshing(false)
    }, 30000)
    return () => { if (pollRef.current) clearInterval(pollRef.current) }
  }, [loadAllChanges, loadUnpushedCommits, activeTab])

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    await Promise.all([
      loadAllChanges(),
      activeTab === 'commits' ? loadUnpushedCommits() : Promise.resolve(),
    ])
    setRefreshing(false)
  }, [loadAllChanges, loadUnpushedCommits, activeTab])

  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopyBranch = (branch: string) => {
    navigator.clipboard.writeText(branch)
    setCopiedBranch(branch)
    setTimeout(() => setCopiedBranch(null), 1500)
  }

  const handleRevertFile = useCallback(async (dir: string, file: string) => {
    if (!window.confirm(`Revert "${file}"? This cannot be undone.`)) return
    const key = `${dir}:${file}`
    setRevertingFile(key)
    try {
      await window.api.session.gitRevert(dir, file)
    } finally {
      setRevertingFile(null)
      loadAllChanges()
    }
  }, [loadAllChanges])

  const handleRevertAll = useCallback(async (session: SessionChanges) => {
    if (!window.confirm(`Revert all ${session.entries.length} changed file(s) in "${session.name}"? This cannot be undone.`)) return
    setRevertingAllSession(session.instanceId)
    try {
      await Promise.all(session.entries.map(e => window.api.session.gitRevert(session.dir, e.file).catch(() => {})))
    } finally {
      setRevertingAllSession(null)
      loadAllChanges()
    }
  }, [loadAllChanges])

  const selectCommit = useCallback(async (hash: string) => {
    setSelectedCommitHash(hash)
    if (commitDiffCache.current[hash]) {
      setCommitDiffContent(commitDiffCache.current[hash])
      return
    }
    setCommitDiffLoading(true)
    setCommitDiffContent(null)
    try {
      const raw = await window.api.git.commitDiff(projectDir, hash)
      commitDiffCache.current[hash] = raw
      setCommitDiffContent(raw)
    } catch {
      setCommitDiffContent('')
    } finally {
      setCommitDiffLoading(false)
    }
  }, [projectDir])

  const handlePush = useCallback(async () => {
    if (!projectDir) return
    setPushing(true)
    setPushError(false)
    try {
      await window.api.git.push(projectDir)
      setUnpushedCommits([])
      setSelectedCommitHash(null)
      setCommitDiffContent(null)
      setPushConfirm(false)
    } catch {
      setPushError(true)
      setTimeout(() => setPushError(false), 4000)
    } finally {
      setPushing(false)
    }
  }, [projectDir])

  const handleFetch = useCallback(async () => {
    if (!projectDir) return
    setFetching(true)
    try {
      await window.api.git.fetch(projectDir)
      await loadUnpushedCommits()
    } finally {
      setFetching(false)
    }
  }, [projectDir, loadUnpushedCommits])

  const handlePull = useCallback(async () => {
    if (!projectDir) return
    const hasChanges = sessionChanges.some(s => s.entries.length > 0)
    if (hasChanges) {
      if (!window.confirm('You have uncommitted changes. Pull may fail if there are conflicts. Continue?')) return
    }
    setPulling(true)
    setPullError(null)
    try {
      const result = await window.api.git.pull(projectDir)
      if (!result.success) {
        setPullError(result.error || 'Pull failed')
        setTimeout(() => setPullError(null), 5000)
      }
      await Promise.all([loadUnpushedCommits(), loadAllChanges()])
    } finally {
      setPulling(false)
    }
  }, [projectDir, sessionChanges, loadUnpushedCommits, loadAllChanges])

  const handleSwitchBranch = useCallback(async (branch: string) => {
    if (!projectDir || branch === branchName) return
    const hasChanges = sessionChanges.some(s => s.entries.length > 0)
    if (hasChanges) {
      if (!window.confirm(`You have uncommitted changes. Switch to "${branch}" anyway? Changes will carry over to the new branch.`)) return
    }
    setSwitching(true)
    setShowBranchPicker(false)
    commitDiffCache.current = {}
    setSelectedCommitHash(null)
    setCommitDiffContent(null)
    try {
      const result = await window.api.git.switchBranch(projectDir, branch)
      if (!result.success) {
        window.alert(result.error || 'Failed to switch branch')
      }
      await Promise.all([loadUnpushedCommits(), loadAllChanges()])
    } finally {
      setSwitching(false)
    }
  }, [projectDir, branchName, sessionChanges, loadUnpushedCommits, loadAllChanges])

  // Close branch picker on click outside
  useEffect(() => {
    if (!showBranchPicker) return
    const handler = (e: MouseEvent) => {
      if (branchPickerRef.current && !branchPickerRef.current.contains(e.target as Node)) {
        setShowBranchPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showBranchPicker])

  // Apply filter
  const displayed = filter === 'changes'
    ? sessionChanges.filter(s => s.entries.length > 0 || s.loading)
    : sessionChanges

  // Filter sessions by file search
  const searchFiltered = fileSearch
    ? displayed.filter(s => s.entries.some(e => e.file.toLowerCase().includes(fileSearch.toLowerCase())))
    : displayed

  // Sort: sessions with changes first, then by creation date desc
  const sorted = [...searchFiltered].sort((a, b) => {
    if (a.entries.length > 0 && b.entries.length === 0) return -1
    if (a.entries.length === 0 && b.entries.length > 0) return 1
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  })

  const selectFile = useCallback(async (sessionDir: string, file: string, status: string) => {
    const key = `${sessionDir}:${file}`
    setSelectedDiffKey(key)
    if (reviewDiffCache.current[key]) {
      setReviewDiffContent(reviewDiffCache.current[key])
      return
    }
    setReviewDiffLoading(true)
    setReviewDiffContent(null)
    try {
      const raw = await window.api.session.getFileDiff(sessionDir, file, status)
      reviewDiffCache.current[key] = raw
      setReviewDiffContent(raw)
    } catch {
      setReviewDiffContent('')
    } finally {
      setReviewDiffLoading(false)
    }
  }, [])

  const totalChanges = sessionChanges.reduce((sum, s) => sum + s.entries.length, 0)
  const totalInsertions = sessionChanges.reduce((sum, s) => sum + s.entries.reduce((a, e) => a + e.insertions, 0), 0)
  const totalDeletions = sessionChanges.reduce((sum, s) => sum + s.entries.reduce((a, e) => a + e.deletions, 0), 0)

  // Flat list of visible commits for keyboard nav (respects commitSearch filter)
  const visibleCommits = useMemo(() => commitSearch
    ? unpushedCommits.filter(c =>
        c.subject.toLowerCase().includes(commitSearch.toLowerCase()) ||
        c.hash.toLowerCase().startsWith(commitSearch.toLowerCase()))
    : unpushedCommits, [unpushedCommits, commitSearch])

  // Flat list of visible files for keyboard nav (respects session expand state + fileSearch)
  const visibleFiles = useMemo(() => {
    const files: Array<{dir: string; file: string; status: string; sessionId: string}> = []
    for (const session of sorted) {
      if (!expandedIds.has(session.instanceId)) continue
      const filteredEntries = fileSearch
        ? session.entries.filter(e => e.file.toLowerCase().includes(fileSearch.toLowerCase()))
        : session.entries
      for (const entry of filteredEntries) {
        files.push({ dir: session.dir, file: entry.file, status: entry.status, sessionId: session.instanceId })
      }
    }
    return files
  }, [sorted, expandedIds, fileSearch])

  // Keyboard nav: j/k or ArrowDown/ArrowUp when focus is inside review-content
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (activeTab !== 'changes' && activeTab !== 'commits') return
      if (commitSession !== null) return
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (!document.activeElement?.closest('.review-content')) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'j' && e.key !== 'k' && e.key !== 'Escape') return
      e.preventDefault()
      if (activeTab === 'changes') {
        if (e.key === 'Escape') {
          setSelectedDiffKey(null)
          setReviewDiffContent(null)
          return
        }
        const currentIndex = selectedDiffKey
          ? visibleFiles.findIndex(f => `${f.dir}:${f.file}` === selectedDiffKey)
          : -1
        if (visibleFiles.length === 0) return
        if (e.key === 'ArrowDown' || e.key === 'j') {
          const next = currentIndex < visibleFiles.length - 1 ? currentIndex + 1 : 0
          const f = visibleFiles[next]; selectFile(f.dir, f.file, f.status)
        } else {
          const next = currentIndex > 0 ? currentIndex - 1 : visibleFiles.length - 1
          const f = visibleFiles[next]; selectFile(f.dir, f.file, f.status)
        }
      } else {
        if (e.key === 'Escape') {
          setSelectedCommitHash(null)
          setCommitDiffContent(null)
          return
        }
        const currentIndex = selectedCommitHash
          ? visibleCommits.findIndex(c => c.hash === selectedCommitHash)
          : -1
        if (visibleCommits.length === 0) return
        if (e.key === 'ArrowDown' || e.key === 'j') {
          const next = currentIndex < visibleCommits.length - 1 ? currentIndex + 1 : 0
          selectCommit(visibleCommits[next].hash)
        } else {
          const next = currentIndex > 0 ? currentIndex - 1 : visibleCommits.length - 1
          selectCommit(visibleCommits[next].hash)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activeTab, commitSession, selectedDiffKey, visibleFiles, selectFile, selectedCommitHash, visibleCommits, selectCommit])

  // Clear selection when selected file disappears (reverted / committed externally)
  useEffect(() => {
    if (!selectedDiffKey || visibleFiles.length === 0) return
    const exists = visibleFiles.some(f => `${f.dir}:${f.file}` === selectedDiffKey)
    if (!exists) {
      setSelectedDiffKey(null)
      setReviewDiffContent(null)
    }
  }, [sessionChanges, selectedDiffKey, visibleFiles])

  // Clear commit selection when selected commit disappears (pushed / rebased / branch switched)
  useEffect(() => {
    if (!selectedCommitHash) return
    const exists = visibleCommits.some(c => c.hash === selectedCommitHash)
    if (!exists) {
      setSelectedCommitHash(null)
      setCommitDiffContent(null)
    }
  }, [unpushedCommits, selectedCommitHash, visibleCommits])

  // Memoized commit right pane — only re-renders DiffViewer when commit selection/content changes
  const commitRightPane = useMemo(() => {
    if (selectedCommitHash === null) {
      return (
        <div className="diff-first-pane-empty">
          <GitCommit size={32} />
          <span>Select a commit to view its diff</span>
        </div>
      )
    }
    if (commitDiffLoading) {
      return <div className="diff-first-pane-empty"><span>Loading diff…</span></div>
    }
    if (commitDiffContent === '') {
      return <div className="diff-first-pane-empty"><span>No diff available for this commit</span></div>
    }
    if (commitDiffContent !== null) {
      const commit = visibleCommits.find(c => c.hash === selectedCommitHash)
      const label = commit ? `${commit.hash.slice(0, 7)} ${commit.subject}` : selectedCommitHash.slice(0, 7)
      return <DiffViewer diff={commitDiffContent} filename={label} />
    }
    return (
      <div className="diff-first-pane-empty">
        <GitCommit size={32} />
        <span>Select a commit to view its diff</span>
      </div>
    )
  }, [selectedCommitHash, commitDiffLoading, commitDiffContent, visibleCommits])

  // Memoized right pane — only re-renders DiffViewer when selection/content changes
  const rightPane = useMemo(() => {
    if (selectedDiffKey === null) {
      return (
        <div className="diff-first-pane-empty">
          <GitCompare size={32} />
          <span>Select a changed file to preview the diff</span>
        </div>
      )
    }
    if (reviewDiffLoading) {
      return <div className="diff-first-pane-empty"><span>Loading diff…</span></div>
    }
    if (reviewDiffContent === '') {
      return <div className="diff-first-pane-empty"><span>No diff available for this file</span></div>
    }
    if (reviewDiffContent !== null) {
      const filename = selectedDiffKey.slice(selectedDiffKey.indexOf(':') + 1)
      return <DiffViewer diff={reviewDiffContent} filename={filename} />
    }
    return (
      <div className="diff-first-pane-empty">
        <GitCompare size={32} />
        <span>Select a changed file to preview the diff</span>
      </div>
    )
  }, [selectedDiffKey, reviewDiffLoading, reviewDiffContent])

  return (
    <div className="review-panel" style={{ padding: 'var(--titlebar-pad, 44px) 16px 0', WebkitAppRegion: 'drag' } as React.CSSProperties}>
      <div className="panel-header" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
        <h2><GitCompare size={16} /> Review</h2>
        <div className="panel-header-tabs">
          <button
            className={`panel-header-tab${activeTab === 'changes' ? ' active' : ''}`}
            onClick={() => setActiveTab('changes')}
          >
            Changes
          </button>
          <button
            className={`panel-header-tab${activeTab === 'commits' ? ' active' : ''}`}
            onClick={() => setActiveTab('commits')}
          >
            Commits{unpushedCommits.length > 0 ? ` (${unpushedCommits.length})` : ''}
          </button>
        </div>
        <div className="panel-header-spacer" />
        <HelpPopover topic="review" align="right" />
        <div className="panel-header-actions">
          {activeTab === 'changes' && (
            <div className="review-search-wrapper">
              <Search size={12} className="review-search-icon" />
              <input
                type="text"
                className="review-search-input"
                placeholder="Filter files..."
                value={fileSearch}
                onChange={(e) => setFileSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setFileSearch(''); (e.target as HTMLInputElement).blur() } }}
              />
              {fileSearch && (
                <button className="review-search-clear" onClick={() => setFileSearch('')}>
                  <X size={10} />
                </button>
              )}
            </div>
          )}
          {activeTab === 'changes' && (
            <button
              className={`panel-header-btn${filter === 'changes' ? ' primary' : ''}`}
              onClick={() => setFilter(f => f === 'changes' ? 'all' : 'changes')}
              title={filter === 'changes' ? 'Showing sessions with changes only' : 'Showing all sessions'}
            >
              <Filter size={13} /> {filter === 'changes' ? 'Changed' : 'All'}
            </button>
          )}
          {activeTab === 'commits' && unpushedCommits.length > 0 && (
            <div className="review-search-wrapper">
              <Search size={12} className="review-search-icon" />
              <input
                type="text"
                className="review-search-input"
                placeholder="Filter commits..."
                value={commitSearch}
                onChange={(e) => setCommitSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setCommitSearch(''); (e.target as HTMLInputElement).blur() } }}
              />
              {commitSearch && (
                <button className="review-search-clear" onClick={() => setCommitSearch('')}>
                  <X size={10} />
                </button>
              )}
            </div>
          )}
          {activeTab === 'commits' && (
            <>
              <button
                className="panel-header-btn"
                onClick={handleFetch}
                disabled={fetching}
                title="Fetch from remote"
              >
                <Download size={13} /> {fetching ? 'Fetching...' : 'Fetch'}
              </button>
              {behindCount > 0 && (
                <button
                  className={`panel-header-btn${pullError ? '' : ' primary'}`}
                  onClick={handlePull}
                  disabled={pulling}
                  title={pullError || `Pull ${behindCount} commit${behindCount !== 1 ? 's' : ''} from upstream`}
                  style={pullError ? { color: 'var(--danger)' } : undefined}
                >
                  {pullError ? <><AlertTriangle size={13} /> Failed</> : <><ArrowDown size={13} /> {pulling ? 'Pulling...' : `Pull (${behindCount})`}</>}
                </button>
              )}
            </>
          )}
          {activeTab === 'commits' && unpushedCommits.length > 0 && (
            <button
              className={`panel-header-btn${pushError ? '' : ' primary'}`}
              onClick={() => {
                const isSensitive = /^(main|master)$/i.test(branchName)
                if (isSensitive) setPushConfirm(true)
                else handlePush()
              }}
              disabled={pushing}
              title={pushError ? 'Push failed — try again' : `Push ${unpushedCommits.length} commit${unpushedCommits.length !== 1 ? 's' : ''} to origin`}
              style={pushError ? { color: 'var(--danger)' } : undefined}
            >
              {pushError ? <><AlertTriangle size={13} /> Failed</> : <><Upload size={13} /> {pushing ? 'Pushing...' : 'Push'}</>}
            </button>
          )}
          <button
            className="panel-header-btn"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh all"
          >
            {refreshing ? <RotateCw size={13} className="spinning" /> : <RefreshCw size={13} />}
          </button>
        </div>
      </div>

      {/* Push confirmation dialog */}
      {pushConfirm && (
        <div
          className="review-push-confirm"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
          onKeyDown={e => { if (e.key === 'Escape') setPushConfirm(false) }}
        >
          <div className="review-push-confirm-inner">
            <AlertTriangle size={16} style={{ color: 'var(--warning)' }} />
            <span>Push {unpushedCommits.length} commit{unpushedCommits.length !== 1 ? 's' : ''} to <strong>{branchName}</strong>?</span>
            <button className="panel-header-btn primary" onClick={handlePush} disabled={pushing} autoFocus>
              {pushing ? 'Pushing...' : 'Confirm Push'}
            </button>
            <button className="panel-header-btn" onClick={() => setPushConfirm(false)}>Cancel</button>
          </div>
        </div>
      )}

      {activeTab === 'changes' && (
        <>
          {/* Summary bar */}
          {totalChanges > 0 && (
            <div className="review-summary" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
              <span>{totalChanges} file{totalChanges !== 1 ? 's' : ''} changed across {sessionChanges.filter(s => s.entries.length > 0).length} session{sessionChanges.filter(s => s.entries.length > 0).length !== 1 ? 's' : ''}</span>
              <span style={{ marginLeft: 'auto', display: 'flex', gap: '8px' }}>
                {totalInsertions > 0 && <span style={{ color: 'var(--success)' }}>+{totalInsertions}</span>}
                {totalDeletions > 0 && <span style={{ color: 'var(--danger)' }}>-{totalDeletions}</span>}
              </span>
            </div>
          )}

          <div className="review-content review-content-two-pane" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
            <div className="diff-first-layout">
              {/* Left pane: session/file list */}
              <div className="diff-first-left">
                {sorted.length === 0 && !refreshing && (
                  <div className="changes-empty">
                    {filter === 'changes' ? 'No sessions with uncommitted changes.' : 'No sessions with a working directory.'}
                  </div>
                )}

                {sorted.map(session => {
                  const expanded = expandedIds.has(session.instanceId)
                  const filteredEntries = fileSearch
                    ? session.entries.filter(e => e.file.toLowerCase().includes(fileSearch.toLowerCase()))
                    : session.entries
                  const insertions = filteredEntries.reduce((a, e) => a + e.insertions, 0)
                  const deletions = filteredEntries.reduce((a, e) => a + e.deletions, 0)

                  return (
                    <div key={session.instanceId} className="review-card">
                      <div
                        className="review-card-header"
                        onClick={() => session.entries.length > 0 && toggleExpand(session.instanceId)}
                        style={{ cursor: session.entries.length > 0 ? 'pointer' : 'default' }}
                      >
                        {/* Expand chevron */}
                        <span className="review-card-chevron">
                          {session.entries.length > 0 ? (
                            expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />
                          ) : (
                            <span style={{ width: 13 }} />
                          )}
                        </span>

                        {/* Color dot + name */}
                        <span className="review-card-dot" style={{ background: session.color }} />
                        <span className="review-card-name">{session.name}</span>

                        {/* Status badge */}
                        <span className={`review-card-status ${session.status}`}>
                          {session.status}
                        </span>

                        {/* File count + stats */}
                        {session.loading ? (
                          <span className="review-card-stats" style={{ opacity: 0.5 }}>loading...</span>
                        ) : session.entries.length > 0 ? (
                          <span className="review-card-stats">
                            {fileSearch ? `${filteredEntries.length}/${session.entries.length}` : session.entries.length} file{(fileSearch ? filteredEntries.length : session.entries.length) !== 1 ? 's' : ''}
                            {insertions > 0 && <span style={{ color: 'var(--success)', marginLeft: '6px' }}>+{insertions}</span>}
                            {deletions > 0 && <span style={{ color: 'var(--danger)', marginLeft: '4px' }}>-{deletions}</span>}
                          </span>
                        ) : (
                          <span className="review-card-stats" style={{ opacity: 0.4 }}>no changes</span>
                        )}

                        {/* Branch */}
                        {session.branch && (
                          <span className="review-card-branch" title={session.branch}>
                            <GitBranch size={11} /> {session.branch}
                          </span>
                        )}

                        {/* Quick actions */}
                        <span className="review-card-actions" onClick={e => e.stopPropagation()}>
                          {session.entries.length > 0 && (
                            <button
                              className="changes-refresh-btn"
                              title="Commit changes"
                              onClick={() => setCommitSession(session)}
                            >
                              <GitCommit size={12} />
                            </button>
                          )}
                          {session.entries.length > 0 && (
                            <button
                              className="changes-refresh-btn"
                              title="Revert all changes"
                              onClick={() => handleRevertAll(session)}
                              disabled={revertingAllSession === session.instanceId}
                              style={{ color: revertingAllSession === session.instanceId ? undefined : 'var(--danger)' }}
                            >
                              <Undo2 size={12} className={revertingAllSession === session.instanceId ? 'spinning' : ''} />
                            </button>
                          )}
                          <button
                            className="changes-refresh-btn"
                            title="Open in terminal"
                            onClick={() => onFocusInstance(session.instanceId)}
                          >
                            <Terminal size={12} />
                          </button>
                          {session.branch && (
                            <button
                              className="changes-refresh-btn"
                              title={copiedBranch === session.branch ? 'Copied!' : 'Copy branch name'}
                              onClick={() => handleCopyBranch(session.branch!)}
                              style={copiedBranch === session.branch ? { color: 'var(--success)' } : undefined}
                            >
                              <Copy size={11} />
                            </button>
                          )}
                          <button
                            className="changes-refresh-btn"
                            title="Open folder in Finder"
                            onClick={() => window.api.shell.openExternal(`file://${session.dir}`)}
                          >
                            <FolderOpen size={12} />
                          </button>
                        </span>
                      </div>

                      {/* Expanded file list */}
                      {expanded && (
                        <div className="review-card-files">
                          {filteredEntries.map(entry => {
                            const diffKey = `${session.dir}:${entry.file}`
                            const isSelected = selectedDiffKey === diffKey
                            return (
                              <div
                                key={entry.file}
                                className={`review-file-row${isSelected ? ' selected' : ''}`}
                                style={{ cursor: 'pointer' }}
                                role="button"
                                tabIndex={0}
                                aria-selected={isSelected}
                                onClick={() => selectFile(session.dir, entry.file, entry.status)}
                                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectFile(session.dir, entry.file, entry.status) } }}
                              >
                                <span
                                  className="review-file-status"
                                  style={{
                                    color: entry.status === 'A' ? 'var(--success)'
                                      : entry.status === 'D' ? 'var(--danger)'
                                      : 'var(--warning)',
                                  }}
                                >
                                  {entry.status}
                                </span>
                                <span className="review-file-name">{entry.file}</span>
                                <span className="review-file-stats">
                                  {entry.insertions > 0 && <span style={{ color: 'var(--success)' }}>+{entry.insertions}</span>}
                                  {entry.insertions > 0 && entry.deletions > 0 && ' '}
                                  {entry.deletions > 0 && <span style={{ color: 'var(--danger)' }}>-{entry.deletions}</span>}
                                </span>
                                <button
                                  className="review-file-open-btn"
                                  title={entry.status === 'D' ? 'File was deleted' : `Open ${entry.file}`}
                                  onClick={(e) => { e.stopPropagation(); window.api.shell.openExternal(`file://${session.dir}/${entry.file}`) }}
                                  disabled={entry.status === 'D'}
                                >
                                  <ExternalLink size={10} />
                                </button>
                                <button
                                  className="review-file-revert-btn"
                                  title={entry.status === '?' ? 'Cannot revert untracked files' : `Revert ${entry.file}`}
                                  onClick={(e) => { e.stopPropagation(); handleRevertFile(session.dir, entry.file) }}
                                  disabled={revertingFile === `${session.dir}:${entry.file}` || entry.status === '?'}
                                >
                                  <Undo2 size={10} className={revertingFile === `${session.dir}:${entry.file}` ? 'spinning' : ''} />
                                </button>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>

              {/* Right pane: persistent diff viewer */}
              <div className="diff-first-right">
                {rightPane}
              </div>
            </div>
          </div>
        </>
      )}

      {activeTab === 'commits' && (
        <div className="review-content review-content-two-pane" style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}>
          {commitsLoading && unpushedCommits.length === 0 && (
            <div className="changes-empty" style={{ opacity: 0.5 }}>Loading commits...</div>
          )}
          {!commitsLoading && unpushedCommits.length === 0 && (
            <div className="changes-empty">No unpushed commits. All changes have been pushed to origin.</div>
          )}
          {commitSearch && visibleCommits.length === 0 && unpushedCommits.length > 0 && (
            <div className="changes-empty">No commits match "{commitSearch}"</div>
          )}
          {(unpushedCommits.length > 0 || behindCount > 0 || branchName) && (
            <div className="review-summary" style={{ WebkitAppRegion: 'no-drag', position: 'relative' } as React.CSSProperties}>
              {unpushedCommits.length > 0 ? (
                <span>
                  {unpushedCommits.length} commit{unpushedCommits.length !== 1 ? 's' : ''} ahead
                </span>
              ) : (
                <span>Up to date</span>
              )}
              {behindCount > 0 && (
                <span style={{ color: 'var(--warning)', marginLeft: '6px' }}>
                  · {behindCount} behind
                </span>
              )}
              <span style={{ marginLeft: '6px' }}>·</span>
              <span
                style={{ cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '4px', marginLeft: '6px' }}
                onClick={() => setShowBranchPicker(!showBranchPicker)}
                title="Switch branch"
              >
                <GitBranch size={11} />
                <strong style={{ textDecoration: 'underline dotted' }}>{branchName || 'main'}</strong>
                <ChevronDown size={11} />
              </span>
              {showBranchPicker && (
                <div className="branch-picker-dropdown" ref={branchPickerRef}>
                  {branches.map(b => (
                    <button
                      key={b.name}
                      className={`branch-picker-item${b.current ? ' current' : ''}`}
                      onClick={() => handleSwitchBranch(b.name)}
                      disabled={b.current || switching}
                    >
                      {b.current && <span style={{ color: 'var(--success)' }}>●</span>}
                      {b.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {unpushedCommits.length > 0 && (
            <div className="diff-first-layout" style={{ gridTemplateColumns: 'minmax(280px, 380px) 1fr' }}>
              <div className="diff-first-left">
                {visibleCommits.map(commit => {
                  const isSelected = selectedCommitHash === commit.hash
                  return (
                    <div
                      key={commit.hash}
                      className={`review-card${isSelected ? ' selected' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-selected={isSelected}
                      onClick={() => selectCommit(commit.hash)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectCommit(commit.hash) } }}
                    >
                      <div className="review-card-header" style={{ cursor: 'pointer' }}>
                        <span style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', color: 'var(--accent)', marginRight: '8px', flexShrink: 0 }}>
                          {commit.hash.slice(0, 7)}
                        </span>
                        <span className="review-card-name" style={{ flex: 1 }}>{commit.subject}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px', flexShrink: 0 }}>{commit.author}</span>
                        <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: '8px', flexShrink: 0 }}>{commit.date}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="diff-first-right">
                {commitRightPane}
              </div>
            </div>
          )}
        </div>
      )}

      {commitSession && (
        <CommitDialog
          dir={commitSession.dir}
          entries={commitSession.entries}
          onClose={() => setCommitSession(null)}
          onCommitted={() => { setCommitSession(null); loadAllChanges() }}
          ticket={commitSession.ticket}
        />
      )}
    </div>
  )
}

export default React.memo(ReviewPanel)
