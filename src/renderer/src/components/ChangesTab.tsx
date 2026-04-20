import { useEffect, useRef, useCallback, useState, useMemo } from 'react'
import { ChevronRight, RefreshCw, RotateCw, Undo2, Sparkles, X, MessageCircleWarning, GitCompare, GitCommit, Bookmark, Trash2, GitBranch, Search, Copy, CheckCircle, Archive, ArrowDown, Eye, Cloud, History, ArrowLeft } from 'lucide-react'
import type { GitDiffEntry, ColonyComment, ScoreCard } from '../../../shared/types'
import type { ClaudeInstance } from '../types'
import DiffViewer from './DiffViewer'

function parseFullDiff(diff: string): { entries: GitDiffEntry[]; sections: Map<string, string> } {
  const entries: GitDiffEntry[] = []
  const sections = new Map<string, string>()
  if (!diff.trim()) return { entries, sections }
  const parts = diff.split(/(?=^diff --git )/m)
  for (const part of parts) {
    if (!part.startsWith('diff --git ')) continue
    const fileMatch = part.match(/^diff --git a\/.+ b\/(.+)/)
    if (!fileMatch) continue
    const file = fileMatch[1].trim()
    let status: GitDiffEntry['status'] = 'M'
    if (/^new file mode/m.test(part)) status = 'A'
    else if (/^deleted file mode/m.test(part)) status = 'D'
    else if (/^rename from /m.test(part)) status = 'R'
    let insertions = 0
    let deletions = 0
    for (const line of part.split('\n')) {
      if (line.startsWith('+') && !line.startsWith('+++')) insertions++
      else if (line.startsWith('-') && !line.startsWith('---')) deletions++
    }
    entries.push({ file, insertions, deletions, status })
    sections.set(file, part)
  }
  return { entries, sections }
}
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
  const currentDiffHashRef = useRef<string | null>(null)
  const [showCommitDialog, setShowCommitDialog] = useState(false)
  const [selectedDiffFile, setSelectedDiffFile] = useState<string | null>(null)
  const diffCacheRef = useRef<Record<string, string>>({})
  const [diffContent, setDiffContent] = useState<string | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [fileSearch, setFileSearch] = useState('')
  const [gitError, setGitError] = useState<string | null>(null)
  const [copiedDiffFile, setCopiedDiffFile] = useState<string | null>(null)

  // Stash state
  const [stashes, setStashes] = useState<Array<{ index: number; message: string; date: string }>>([])
  const [stashOpen, setStashOpen] = useState(false)
  const [stashing, setStashing] = useState(false)
  const [stashError, setStashError] = useState<string | null>(null)

  // Branch switcher state
  const [branches, setBranches] = useState<Array<{ name: string; current: boolean; remote: boolean }>>([])
  const [branchDropdownOpen, setBranchDropdownOpen] = useState(false)
  const [currentBranch, setCurrentBranch] = useState('')
  const [behindCount, setBehindCount] = useState(0)
  const [switching, setSwitching] = useState(false)
  const [fetchingBranches, setFetchingBranches] = useState(false)
  const [switchError, setSwitchError] = useState<string | null>(null)
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [forceDeleteConfirm, setForceDeleteConfirm] = useState<string | null>(null)
  const [pruning, setPruning] = useState(false)

  // Stash preview state
  const [stashPreviewIndex, setStashPreviewIndex] = useState<number | null>(null)
  const [stashPreviewDiff, setStashPreviewDiff] = useState<{ stat: string; diff: string } | null>(null)
  const [stashPreviewLoading, setStashPreviewLoading] = useState(false)

  // File history state
  const [fileHistoryFile, setFileHistoryFile] = useState<string | null>(null)
  const [fileHistoryCommits, setFileHistoryCommits] = useState<Array<{ hash: string; subject: string; author: string; date: string }>>([])
  const [fileHistoryLoading, setFileHistoryLoading] = useState(false)
  const [fileHistorySkip, setFileHistorySkip] = useState(0)
  const [hasMoreFileHistory, setHasMoreFileHistory] = useState(true)
  const [expandedFileHistoryHash, setExpandedFileHistoryHash] = useState<string | null>(null)
  const [fileHistoryDiff, setFileHistoryDiff] = useState<string | null>(null)
  const [fileHistoryDiffLoading, setFileHistoryDiffLoading] = useState(false)

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; file: string } | null>(null)

  // Diff mode state
  const [diffMode, setDiffMode] = useState<'working' | 'base'>('working')
  const [baseBranch, setBaseBranch] = useState('main')
  const [baseDiffEntries, setBaseDiffEntries] = useState<GitDiffEntry[]>([])
  const [baseDiffLoading, setBaseDiffLoading] = useState(false)
  const baseDiffSectionsRef = useRef<Map<string, string>>(new Map())

  // Checkpoint state
  const [checkpoints, setCheckpoints] = useState<CheckpointTag[]>([])
  const [checkpointsOpen, setCheckpointsOpen] = useState(true)
  const [savingCheckpoint, setSavingCheckpoint] = useState(false)
  const [expandedCheckpoint, setExpandedCheckpoint] = useState<string | null>(null)
  const [checkpointDiff, setCheckpointDiff] = useState<string | null>(null)
  const [checkpointDiffLoading, setCheckpointDiffLoading] = useState(false)
  const [restoringCheckpoint, setRestoringCheckpoint] = useState<string | null>(null)

  // Pull state
  const [pulling, setPulling] = useState(false)
  const [pullResult, setPullResult] = useState<{ success: boolean; error?: string } | null>(null)

  // Commit history state
  const [commits, setCommits] = useState<Array<{ hash: string; subject: string; author: string; date: string }>>([])
  const [commitsOpen, setCommitsOpen] = useState(false)
  const [unpushedHashes, setUnpushedHashes] = useState<Set<string>>(new Set())
  const [expandedCommit, setExpandedCommit] = useState<string | null>(null)
  const [commitDiff, setCommitDiff] = useState<string | null>(null)
  const [commitDiffLoading, setCommitDiffLoading] = useState(false)
  const [commitSkip, setCommitSkip] = useState(0)
  const [hasMoreCommits, setHasMoreCommits] = useState(true)

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
    setGitError(null)
    window.api.session.gitChanges(instance.workingDirectory).then(async (entries) => {
      setGitChanges(entries)
      onChangeCount?.(entries.length)
      setGitChangesLoading(false)

      // Check for a cached scorecard when diff changes. Silent — no spinner.
      if (entries.length > 0 && instance.workingDirectory) {
        try {
          const hash = await window.api.session.getDiffHash(instance.workingDirectory)
          currentDiffHashRef.current = hash
          if (hash) {
            const cached = await window.api.session.getCachedScoreCard(instance.id, hash)
            if (cached) setScoreCard(cached)
          } else {
            // Diff cleared — stale card no longer valid
            setScoreCard(null)
          }
        } catch {
          // Cache miss is non-fatal
        }
      } else if (entries.length === 0) {
        currentDiffHashRef.current = null
        setScoreCard(null)
      }
    }).catch((err: any) => {
      setGitChanges([])
      onChangeCount?.(0)
      setGitChangesLoading(false)
      const msg: string = err?.message ?? ''
      setGitError(msg.includes('ENOENT') || msg.includes('not a git') ? 'Working directory no longer exists' : null)
    })
  }, [instance.workingDirectory, instance.id])

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

  const refreshStashes = useCallback(async () => {
    if (!instance.workingDirectory) return
    try {
      const list = await window.api.git.stashList(instance.workingDirectory)
      setStashes(list)
    } catch {
      setStashes([])
    }
  }, [instance.workingDirectory])

  useEffect(() => {
    refreshStashes()
  }, [refreshStashes])

  const loadBranchInfo = useCallback(async () => {
    if (!instance.workingDirectory) return
    const [branchList, info, behind] = await Promise.all([
      window.api.git.listBranches(instance.workingDirectory, true),
      window.api.git.branchInfo(instance.workingDirectory),
      window.api.git.behindCount(instance.workingDirectory),
    ]).catch(() => [[], { branch: '', remote: null, ahead: 0 }, 0] as const)
    setBranches(branchList as Array<{ name: string; current: boolean; remote: boolean }>)
    setCurrentBranch((info as { branch: string }).branch)
    setBehindCount(behind as number)
  }, [instance.workingDirectory])

  useEffect(() => { loadBranchInfo() }, [loadBranchInfo])

  // Close branch dropdown on outside click
  useEffect(() => {
    if (!branchDropdownOpen) return
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.branch-switcher')) setBranchDropdownOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [branchDropdownOpen])

  const handleSwitchBranch = useCallback(async (branch: string) => {
    if (!instance.workingDirectory || switching) return
    setSwitching(true)
    setSwitchError(null)
    const result = await window.api.git.switchBranch(instance.workingDirectory, branch)
    if (result.success) {
      setBranchDropdownOpen(false)
      await loadBranchInfo()
      loadGitChanges()
      refreshStashes()
      loadCheckpoints()
    } else {
      setSwitchError(result.error ?? 'Switch failed')
    }
    setSwitching(false)
  }, [instance.workingDirectory, switching, loadBranchInfo, loadGitChanges, refreshStashes, loadCheckpoints])

  const handleFetchBranches = useCallback(async () => {
    if (!instance.workingDirectory) return
    setFetchingBranches(true)
    await window.api.git.fetch(instance.workingDirectory).catch(() => {})
    await loadBranchInfo()
    setFetchingBranches(false)
  }, [instance.workingDirectory, loadBranchInfo])

  const handleDeleteBranch = useCallback(async (branch: string, force = false) => {
    if (!instance.workingDirectory || deletingBranch) return
    setDeletingBranch(branch)
    setDeleteError(null)
    setForceDeleteConfirm(null)
    const result = await window.api.git.deleteBranch(instance.workingDirectory, branch, force)
    if (result.success) {
      await loadBranchInfo()
    } else {
      if (!force && result.error?.includes('not fully merged')) {
        setForceDeleteConfirm(branch)
      } else {
        setDeleteError(result.error ?? 'Delete failed')
      }
    }
    setDeletingBranch(null)
  }, [instance.workingDirectory, deletingBranch, loadBranchInfo])

  const handlePruneRemote = useCallback(async () => {
    if (!instance.workingDirectory || pruning) return
    setPruning(true)
    await window.api.git.pruneRemote(instance.workingDirectory).catch(() => {})
    await loadBranchInfo()
    setPruning(false)
  }, [instance.workingDirectory, pruning, loadBranchInfo])

  const handleStashPreview = useCallback(async (index: number) => {
    if (!instance.workingDirectory) return
    if (stashPreviewIndex === index) {
      setStashPreviewIndex(null)
      setStashPreviewDiff(null)
      return
    }
    setStashPreviewIndex(index)
    setStashPreviewLoading(true)
    setStashPreviewDiff(null)
    setStashOpen(false)
    try {
      const result = await window.api.git.stashShow(instance.workingDirectory, index)
      setStashPreviewDiff(result)
    } catch {
      setStashPreviewDiff({ stat: '', diff: '' })
    } finally {
      setStashPreviewLoading(false)
    }
  }, [instance.workingDirectory, stashPreviewIndex])

  const loadFileHistory = useCallback(async (file: string, skip = 0) => {
    if (!instance.workingDirectory) return
    setFileHistoryLoading(true)
    const batch = await window.api.git.fileLog(instance.workingDirectory, file, 20, skip).catch(() => [])
    if (skip === 0) {
      setFileHistoryCommits(batch)
    } else {
      setFileHistoryCommits(prev => [...prev, ...batch])
    }
    setHasMoreFileHistory(batch.length === 20)
    setFileHistorySkip(skip + batch.length)
    setFileHistoryLoading(false)
  }, [instance.workingDirectory])

  const openFileHistory = useCallback((file: string) => {
    setFileHistoryFile(file)
    setFileHistoryCommits([])
    setFileHistorySkip(0)
    setHasMoreFileHistory(true)
    setExpandedFileHistoryHash(null)
    setFileHistoryDiff(null)
    setContextMenu(null)
    loadFileHistory(file, 0)
  }, [loadFileHistory])

  const closeFileHistory = useCallback(() => {
    setFileHistoryFile(null)
    setFileHistoryCommits([])
    setExpandedFileHistoryHash(null)
    setFileHistoryDiff(null)
  }, [])

  const handleExpandFileHistoryCommit = useCallback(async (hash: string) => {
    if (!instance.workingDirectory || !fileHistoryFile) return
    if (expandedFileHistoryHash === hash) {
      setExpandedFileHistoryHash(null)
      setFileHistoryDiff(null)
      return
    }
    setExpandedFileHistoryHash(hash)
    setFileHistoryDiffLoading(true)
    setFileHistoryDiff(null)
    const diff = await window.api.git.fileCommitDiff(instance.workingDirectory, hash, fileHistoryFile).catch(() => '')
    setFileHistoryDiff(diff)
    setFileHistoryDiffLoading(false)
  }, [instance.workingDirectory, fileHistoryFile, expandedFileHistoryHash])

  const handlePull = useCallback(async () => {
    if (!instance.workingDirectory || pulling) return
    setPulling(true)
    setPullResult(null)
    const result = await window.api.git.pull(instance.workingDirectory).catch((e: any) => ({ success: false, error: e?.message ?? 'Pull failed' }))
    setPullResult(result)
    if (result.success) {
      await loadBranchInfo()
      loadGitChanges()
      refreshStashes()
      loadCheckpoints()
      setCommits([])
      setCommitSkip(0)
      setTimeout(() => setPullResult(null), 3000)
    }
    setPulling(false)
  }, [instance.workingDirectory, pulling, loadBranchInfo, loadGitChanges, refreshStashes, loadCheckpoints])

  const loadCommits = useCallback(async (skip = 0) => {
    if (!instance.workingDirectory) return
    const batch = await window.api.git.log(instance.workingDirectory, 20, skip).catch(() => [])
    if (skip === 0) {
      setCommits(batch)
      const unpushed = await window.api.git.unpushedCommits(instance.workingDirectory).catch(() => [])
      setUnpushedHashes(new Set(unpushed.map((c: { hash: string }) => c.hash)))
    } else {
      setCommits(prev => [...prev, ...batch])
    }
    setHasMoreCommits(batch.length === 20)
    setCommitSkip(skip + batch.length)
  }, [instance.workingDirectory])

  const handleExpandCommit = useCallback(async (hash: string) => {
    if (!instance.workingDirectory) return
    if (expandedCommit === hash) { setExpandedCommit(null); setCommitDiff(null); return }
    setExpandedCommit(hash)
    setCommitDiffLoading(true)
    setCommitDiff(null)
    const diff = await window.api.git.commitDiff(instance.workingDirectory, hash).catch(() => '')
    setCommitDiff(diff)
    setCommitDiffLoading(false)
  }, [instance.workingDirectory, expandedCommit])

  useEffect(() => {
    if (commitsOpen && commits.length === 0) loadCommits(0)
  }, [commitsOpen, commits.length, loadCommits])

  useEffect(() => {
    if (!instance.workingDirectory) return
    window.api.git.defaultBranch(instance.workingDirectory).then(setBaseBranch).catch(() => {})
  }, [instance.workingDirectory])

  useEffect(() => {
    if (diffMode !== 'base' || !instance.workingDirectory) return
    setBaseDiffLoading(true)
    setSelectedDiffFile(null)
    setDiffContent(null)
    window.api.git.diffRange(instance.workingDirectory, baseBranch)
      .then(({ diff }) => {
        const { entries, sections } = parseFullDiff(diff)
        setBaseDiffEntries(entries)
        baseDiffSectionsRef.current = sections
      })
      .catch(() => setBaseDiffEntries([]))
      .finally(() => setBaseDiffLoading(false))
  }, [diffMode, instance.workingDirectory, baseBranch, currentBranch])

  const selectBaseFile = useCallback((file: string) => {
    setSelectedDiffFile(file)
    setDiffContent(baseDiffSectionsRef.current.get(file) ?? '')
  }, [])

  const handleModeSwitch = useCallback((mode: 'working' | 'base') => {
    setDiffMode(mode)
    setSelectedDiffFile(null)
    setDiffContent(null)
  }, [])

  const handleStash = useCallback(async () => {
    if (!instance.workingDirectory) return
    setStashing(true)
    setStashError(null)
    try {
      const msg = `WIP: ${new Date().toLocaleString()}`
      await window.api.git.stashPush(instance.workingDirectory, msg)
      await refreshStashes()
      loadGitChanges()
    } catch (err: any) {
      setStashError(err?.message ?? 'Stash failed')
    } finally {
      setStashing(false)
    }
  }, [instance.workingDirectory, refreshStashes, loadGitChanges])

  const handleStashApply = useCallback(async (index: number) => {
    if (!instance.workingDirectory) return
    setStashError(null)
    try {
      await window.api.git.stashApply(instance.workingDirectory, index)
      await refreshStashes()
      loadGitChanges()
      setStashOpen(false)
    } catch (err: any) {
      setStashError(err?.message ?? 'Apply failed — may have merge conflicts')
    }
  }, [instance.workingDirectory, refreshStashes, loadGitChanges])

  const handleStashPop = useCallback(async (index: number) => {
    if (!instance.workingDirectory) return
    setStashError(null)
    try {
      await window.api.git.stashPop(instance.workingDirectory, index)
      await refreshStashes()
      loadGitChanges()
      setStashOpen(false)
    } catch (err: any) {
      setStashError(err?.message ?? 'Pop failed — may have merge conflicts')
    }
  }, [instance.workingDirectory, refreshStashes, loadGitChanges])

  const handleStashDrop = useCallback(async (index: number) => {
    if (!instance.workingDirectory) return
    if (!window.confirm('Drop this stash? This cannot be undone.')) return
    try {
      await window.api.git.stashDrop(instance.workingDirectory, index)
      await refreshStashes()
    } catch { /* ignore */ }
  }, [instance.workingDirectory, refreshStashes])

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
      const result = await window.api.session.scoreOutput(instance.id, instance.workingDirectory)
      setScoreCard(result)
    } catch {
      setScoreCard({ confidence: 0, scopeCreep: false, testCoverage: 'none', summary: 'Scoring failed.', raw: '' })
    } finally {
      setScoreCardLoading(false)
    }
  }, [instance.id, instance.workingDirectory, gitChanges.length])

  const selectFile = useCallback(async (file: string, status: string) => {
    setSelectedDiffFile(file)
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
  }, [instance.workingDirectory])

  // visibleFiles — filtered by search, structured for keyboard nav
  const visibleFiles = useMemo(() => {
    const entries = diffMode === 'base' ? baseDiffEntries : gitChanges
    return fileSearch ? entries.filter(f => f.file.toLowerCase().includes(fileSearch.toLowerCase())) : entries
  }, [gitChanges, baseDiffEntries, diffMode, fileSearch])

  // Keyboard nav: j/k or ArrowDown/ArrowUp to navigate files, Escape to clear
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (visibleFiles.length === 0) return
      if (showCommitDialog) return
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (document.activeElement?.closest('[contenteditable]')) return
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'j' && e.key !== 'k' && e.key !== 'Escape') return
      e.preventDefault()
      if (e.key === 'Escape') {
        setSelectedDiffFile(null)
        setDiffContent(null)
        return
      }
      const currentIndex = selectedDiffFile
        ? visibleFiles.findIndex(f => f.file === selectedDiffFile)
        : -1
      const activate = (f: GitDiffEntry) => diffMode === 'base' ? selectBaseFile(f.file) : selectFile(f.file, f.status)
      if (e.key === 'ArrowDown' || e.key === 'j') {
        const next = currentIndex < visibleFiles.length - 1 ? currentIndex + 1 : 0
        activate(visibleFiles[next])
      } else {
        const next = currentIndex > 0 ? currentIndex - 1 : visibleFiles.length - 1
        activate(visibleFiles[next])
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [visibleFiles, showCommitDialog, selectedDiffFile, selectFile])

  // Close stash dropdown on outside click
  useEffect(() => {
    if (!stashOpen) return
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement
      if (!target.closest('.stash-dropdown') && !target.closest('.stash-count-btn')) {
        setStashOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [stashOpen])

  // Close context menu on outside click or Escape
  useEffect(() => {
    if (!contextMenu) return
    const handler = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.file-context-menu')) setContextMenu(null)
    }
    const keyHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') setContextMenu(null) }
    document.addEventListener('mousedown', handler)
    document.addEventListener('keydown', keyHandler)
    return () => {
      document.removeEventListener('mousedown', handler)
      document.removeEventListener('keydown', keyHandler)
    }
  }, [contextMenu])

  // Clear selection if selected file disappears (reverted / committed externally)
  useEffect(() => {
    if (!selectedDiffFile) return
    const entries = diffMode === 'base' ? baseDiffEntries : gitChanges
    if (!entries.some(f => f.file === selectedDiffFile)) {
      setSelectedDiffFile(null)
      setDiffContent(null)
    }
  }, [gitChanges, baseDiffEntries, diffMode, selectedDiffFile])

  // Memoized right pane — only re-renders DiffViewer when selection/content changes
  const rightPane = useMemo(() => {
    // File history view
    if (fileHistoryFile !== null) {
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <button className="changes-refresh-btn" onClick={closeFileHistory} title="Back to diff view">
              <ArrowLeft size={12} />
            </button>
            <History size={12} style={{ opacity: 0.5 }} />
            <span style={{ fontSize: '11px', fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.8 }}>{fileHistoryFile}</span>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {fileHistoryLoading && fileHistoryCommits.length === 0 && (
              <div className="diff-first-pane-empty"><span>Loading history…</span></div>
            )}
            {!fileHistoryLoading && fileHistoryCommits.length === 0 && (
              <div className="diff-first-pane-empty"><span>No commit history found.</span></div>
            )}
            {fileHistoryCommits.map(c => {
              const isExpanded = expandedFileHistoryHash === c.hash
              return (
                <div key={c.hash}>
                  <div
                    className={`checkpoint-row${isExpanded ? ' expanded' : ''}`}
                    onClick={() => handleExpandFileHistoryCommit(c.hash)}
                    style={{ cursor: 'pointer' }}
                  >
                    <ChevronRight size={10} style={{ flexShrink: 0, transition: 'transform 0.15s', transform: isExpanded ? 'rotate(90deg)' : 'none', opacity: 0.4 }} />
                    <code style={{ fontSize: '9px', fontFamily: 'monospace', opacity: 0.6, flexShrink: 0, width: '48px' }}>{c.hash.slice(0, 7)}</code>
                    <span style={{ flex: 1, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</span>
                    <span style={{ fontSize: '9px', opacity: 0.4, flexShrink: 0, marginLeft: '4px' }}>{c.date}</span>
                    <span style={{ fontSize: '9px', opacity: 0.4, flexShrink: 0, marginLeft: '4px' }}>{c.author}</span>
                  </div>
                  {isExpanded && (
                    <div className="checkpoint-diff-container">
                      {fileHistoryDiffLoading ? (
                        <div className="diff-viewer-empty">Loading diff…</div>
                      ) : fileHistoryDiff !== null ? (
                        fileHistoryDiff ? (
                          <DiffViewer diff={fileHistoryDiff} filename={`${fileHistoryFile}@${c.hash.slice(0, 7)}`} />
                        ) : (
                          <div className="diff-viewer-empty">No changes to this file in this commit.</div>
                        )
                      ) : null}
                    </div>
                  )}
                </div>
              )
            })}
            {hasMoreFileHistory && fileHistoryCommits.length > 0 && (
              <button
                className="checkpoint-empty"
                style={{ cursor: 'pointer', color: 'var(--accent)', background: 'none', border: 'none', width: '100%', textAlign: 'left', padding: '6px 12px' }}
                onClick={() => loadFileHistory(fileHistoryFile, fileHistorySkip)}
              >
                {fileHistoryLoading ? 'Loading…' : 'Load more...'}
              </button>
            )}
          </div>
        </div>
      )
    }

    // Stash preview view
    if (stashPreviewIndex !== null) {
      const stash = stashes.find(s => s.index === stashPreviewIndex)
      return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 8px', borderBottom: '1px solid var(--border)', flexShrink: 0 }}>
            <button className="changes-refresh-btn" onClick={() => { setStashPreviewIndex(null); setStashPreviewDiff(null) }} title="Back to diff view">
              <ArrowLeft size={12} />
            </button>
            <Archive size={12} style={{ opacity: 0.5 }} />
            <span style={{ fontSize: '11px', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', opacity: 0.8 }}>
              stash@{`{${stashPreviewIndex}}`}{stash ? `: ${stash.message}` : ''}
            </span>
          </div>
          <div style={{ flex: 1, overflow: 'auto' }}>
            {stashPreviewLoading && <div className="diff-first-pane-empty"><span>Loading stash diff…</span></div>}
            {!stashPreviewLoading && stashPreviewDiff && (
              <>
                {stashPreviewDiff.stat && (
                  <pre style={{ fontSize: '10px', opacity: 0.6, padding: '6px 10px', margin: 0, borderBottom: '1px solid var(--border)', overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
                    {stashPreviewDiff.stat}
                  </pre>
                )}
                {stashPreviewDiff.diff ? (
                  <DiffViewer diff={stashPreviewDiff.diff} filename="stash" />
                ) : (
                  <div className="diff-first-pane-empty"><span>Empty stash.</span></div>
                )}
              </>
            )}
          </div>
        </div>
      )
    }

    if (selectedDiffFile === null) {
      return (
        <div className="diff-first-pane-empty">
          <GitCompare size={32} />
          <span>Select a changed file to view its diff</span>
        </div>
      )
    }
    if (diffLoading) {
      return <div className="diff-first-pane-empty"><span>Loading diff…</span></div>
    }
    if (diffContent === '') {
      return <div className="diff-first-pane-empty"><span>No diff available (binary or deleted file)</span></div>
    }
    if (diffContent !== null) {
      const fileComments = colonyComments.filter(c => {
        const normalised = c.file.replace(/^b\//, '')
        return normalised === selectedDiffFile || normalised.endsWith('/' + selectedDiffFile) || selectedDiffFile.endsWith('/' + normalised)
      })
      return (
        <>
          <div className="changes-diff-header">
            <span className="changes-diff-filename">{selectedDiffFile}</span>
            <button
              className="changes-refresh-btn"
              title="Copy diff"
              onClick={() => {
                navigator.clipboard.writeText(diffContent!)
                setCopiedDiffFile(selectedDiffFile)
                setTimeout(() => setCopiedDiffFile(null), 2000)
              }}
            >
              {copiedDiffFile === selectedDiffFile ? <CheckCircle size={12} /> : <Copy size={12} />}
            </button>
          </div>
          <DiffViewer diff={diffContent} filename={selectedDiffFile} />
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
        </>
      )
    }
    return (
      <div className="diff-first-pane-empty">
        <GitCompare size={32} />
        <span>Select a changed file to view its diff</span>
      </div>
    )
  }, [selectedDiffFile, diffLoading, diffContent, colonyComments, copiedDiffFile,
      fileHistoryFile, fileHistoryCommits, fileHistoryLoading, fileHistorySkip, hasMoreFileHistory,
      expandedFileHistoryHash, fileHistoryDiff, fileHistoryDiffLoading,
      stashPreviewIndex, stashPreviewDiff, stashPreviewLoading, stashes,
      closeFileHistory, handleExpandFileHistoryCommit, loadFileHistory])

  return (
    <>
      <div className="changes-panel">
        <div className="changes-panel-header">
          <span className="changes-panel-title">
            <GitCompare size={13} /> Git Changes
          </span>
          <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
            <div className="changes-diff-mode-toggle">
              <button className={diffMode === 'working' ? 'active' : ''} onClick={() => handleModeSwitch('working')}>Working Tree</button>
              <button className={diffMode === 'base' ? 'active' : ''} onClick={() => handleModeSwitch('base')}>vs {baseBranch}</button>
            </div>
            {currentBranch && (
              <div className="branch-switcher" style={{ position: 'relative' }}>
                <button
                  className="changes-branch-chip"
                  onClick={() => { setBranchDropdownOpen(!branchDropdownOpen); setSwitchError(null) }}
                  title="Switch branch"
                >
                  <GitBranch size={11} />
                  <span style={{ maxWidth: '80px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentBranch}</span>
                  {behindCount > 0 && <span className="branch-behind-badge">↓{behindCount}</span>}
                </button>
                {branchDropdownOpen && (
                  <div className="branch-dropdown">
                    <div className="branch-dropdown-header">
                      <span>Branches</span>
                      <div style={{ display: 'flex', gap: '3px' }}>
                        <button
                          className="changes-refresh-btn"
                          onClick={handlePruneRemote}
                          disabled={pruning}
                          title="Prune stale remote refs"
                          style={{ fontSize: '9px', padding: '1px 4px' }}
                        >
                          {pruning ? <RotateCw size={9} className="spinning" /> : 'Prune'}
                        </button>
                        <button
                          className="changes-refresh-btn"
                          onClick={handleFetchBranches}
                          disabled={fetchingBranches}
                          title="Fetch remote"
                        >
                          {fetchingBranches ? <RotateCw size={11} className="spinning" /> : <RefreshCw size={11} />}
                        </button>
                      </div>
                    </div>
                    {(switchError || deleteError) && (
                      <div style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--danger)', borderBottom: '1px solid var(--border)' }}>
                        {switchError || deleteError}
                      </div>
                    )}
                    {forceDeleteConfirm && (
                      <div style={{ padding: '4px 8px', fontSize: '10px', borderBottom: '1px solid var(--border)', background: 'rgba(239,68,68,0.08)' }}>
                        <span style={{ color: 'var(--warning)' }}>Branch not fully merged. Force delete?</span>
                        <div style={{ display: 'flex', gap: '4px', marginTop: '4px' }}>
                          <button className="stash-action-btn danger" onClick={() => handleDeleteBranch(forceDeleteConfirm, true)}>Force Delete</button>
                          <button className="stash-action-btn" onClick={() => setForceDeleteConfirm(null)}>Cancel</button>
                        </div>
                      </div>
                    )}
                    {branches.filter(b => !b.remote).length > 0 && (
                      <div style={{ padding: '3px 8px 2px', fontSize: '9px', fontWeight: 600, opacity: 0.4, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Local</div>
                    )}
                    {branches.filter(b => !b.remote).map(b => (
                      <div key={b.name} className={`branch-list-item${b.current ? ' active' : ''}`} style={{ display: 'flex', alignItems: 'center' }}>
                        <button
                          style={{ flex: 1, display: 'flex', alignItems: 'center', gap: '4px', background: 'none', border: 'none', cursor: b.current ? 'default' : 'pointer', padding: '4px 0', color: 'inherit', textAlign: 'left', minWidth: 0 }}
                          onClick={() => !b.current && handleSwitchBranch(b.name)}
                          disabled={switching || b.current}
                          title={b.name}
                        >
                          {b.current && <CheckCircle size={11} style={{ color: 'var(--accent)', flexShrink: 0 }} />}
                          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px' }}>{b.name}</span>
                          {switching && !b.current && <RotateCw size={9} className="spinning" style={{ flexShrink: 0 }} />}
                        </button>
                        {!b.current && (
                          <button
                            className="changes-refresh-btn"
                            title={`Delete branch ${b.name}`}
                            disabled={!!deletingBranch}
                            onClick={(e) => { e.stopPropagation(); setDeleteError(null); setForceDeleteConfirm(null); handleDeleteBranch(b.name) }}
                            style={{ color: 'var(--danger)', flexShrink: 0, marginLeft: '2px' }}
                          >
                            {deletingBranch === b.name ? <RotateCw size={9} className="spinning" /> : <Trash2 size={9} />}
                          </button>
                        )}
                      </div>
                    ))}
                    {branches.filter(b => b.remote).length > 0 && (
                      <div style={{ padding: '3px 8px 2px', fontSize: '9px', fontWeight: 600, opacity: 0.4, textTransform: 'uppercase', letterSpacing: '0.05em', marginTop: '2px', borderTop: '1px solid var(--border)' }}>Remote</div>
                    )}
                    {branches.filter(b => b.remote).map(b => (
                      <button
                        key={`remote-${b.name}`}
                        className="branch-list-item"
                        onClick={() => handleSwitchBranch(b.name)}
                        disabled={switching}
                        title={`origin/${b.name}`}
                        style={{ opacity: 0.7 }}
                      >
                        <Cloud size={10} style={{ flexShrink: 0, opacity: 0.6 }} />
                        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '11px' }}>{b.name}</span>
                        {switching && <RotateCw size={9} className="spinning" style={{ flexShrink: 0 }} />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {behindCount > 0 && (
              <button
                className="changes-refresh-btn"
                title={`Pull ${behindCount} commit(s) from remote`}
                onClick={handlePull}
                disabled={pulling}
                style={{ color: 'var(--accent)', display: 'flex', alignItems: 'center', gap: '3px', padding: '2px 5px', fontSize: '10px' }}
              >
                {pulling ? <RotateCw size={11} className="spinning" /> : <ArrowDown size={11} />}
                {!pulling && `Pull ${behindCount}`}
              </button>
            )}
            {pullResult && !pullResult.success && (
              <span style={{ fontSize: '10px', color: 'var(--danger)', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={pullResult.error}>
                {pullResult.error?.split('\n')[0]}
              </span>
            )}
            {(visibleFiles.length > 0 || !!fileSearch) && (
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
            <button
              className="changes-refresh-btn"
              title="Refresh"
              onClick={loadGitChanges}
            >
              <RefreshCw size={12} />
            </button>
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '2px' }}>
              <button
                className="changes-refresh-btn"
                title="Stash changes"
                disabled={stashing || gitChanges.length === 0}
                onClick={handleStash}
                style={{ color: 'var(--text-muted)' }}
              >
                {stashing ? <RotateCw size={12} className="spinning" /> : <Archive size={12} />}
              </button>
              {stashes.length > 0 && (
                <button
                  className="changes-refresh-btn stash-count-btn"
                  onClick={() => setStashOpen(!stashOpen)}
                  title={`${stashes.length} stash${stashes.length === 1 ? '' : 'es'} — click to manage`}
                  style={{ padding: '2px 4px', fontSize: '9px', fontWeight: 600, color: 'var(--text-muted)' }}
                >
                  {stashes.length}
                </button>
              )}
              {stashOpen && stashes.length > 0 && (
                <div className="stash-dropdown" onClick={(e) => e.stopPropagation()}>
                  <div style={{ padding: '6px 8px 4px', fontSize: '10px', fontWeight: 600, opacity: 0.6, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Stashes
                  </div>
                  {stashError && (
                    <div style={{ padding: '4px 8px', fontSize: '10px', color: 'var(--danger)', borderBottom: '1px solid var(--border)' }}>
                      {stashError}
                    </div>
                  )}
                  {stashes.map((s) => (
                    <div key={s.index} className="stash-row">
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.message}</div>
                        <div style={{ fontSize: '9px', opacity: 0.5, marginTop: '1px' }}>{s.date}</div>
                      </div>
                      <div style={{ display: 'flex', gap: '3px', flexShrink: 0 }}>
                        <button
                          className="stash-action-btn"
                          onClick={() => handleStashPreview(s.index)}
                          title="Preview diff"
                          style={{ color: stashPreviewIndex === s.index ? 'var(--accent)' : undefined }}
                        >
                          <Eye size={9} />
                        </button>
                        <button className="stash-action-btn" onClick={() => handleStashApply(s.index)} title="Apply (keep stash)">Apply</button>
                        <button className="stash-action-btn" onClick={() => handleStashPop(s.index)} title="Pop (remove stash)">Pop</button>
                        <button className="stash-action-btn danger" onClick={() => handleStashDrop(s.index)} title="Drop stash">
                          <Trash2 size={9} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
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
          {diffMode === 'working' && gitChangesLoading && <div className="changes-empty">Loading...</div>}
          {diffMode === 'working' && !gitChangesLoading && gitError && (
            <div className="changes-empty">{gitError}</div>
          )}
          {diffMode === 'working' && !gitChangesLoading && !gitError && gitChanges.length === 0 && (
            <div className="changes-empty">No uncommitted changes.</div>
          )}
          {diffMode === 'base' && baseDiffLoading && <div className="changes-empty">Loading branch diff…</div>}
          {diffMode === 'base' && !baseDiffLoading && baseDiffEntries.length === 0 && (
            <div className="changes-empty">On {baseBranch} — no branch diff.</div>
          )}
          {((diffMode === 'working' && !gitChangesLoading && gitChanges.length > 0) ||
            (diffMode === 'base' && !baseDiffLoading && baseDiffEntries.length > 0)) && (
            <div className="diff-first-layout">
              {/* Left pane: file list */}
              <div className="diff-first-left">
                {fileSearch && visibleFiles.length === 0 && (
                  <div className="changes-empty">No files match &ldquo;{fileSearch}&rdquo;.</div>
                )}
                {visibleFiles.map((entry) => {
                  const isSelected = selectedDiffFile === entry.file
                  const fileComments = diffMode === 'working' ? colonyComments.filter(c => {
                    const normalised = c.file.replace(/^b\//, '')
                    return normalised === entry.file || normalised.endsWith('/' + entry.file) || entry.file.endsWith('/' + normalised)
                  }) : []
                  return (
                    <div
                      key={entry.file}
                      className={`changes-event${isSelected ? ' selected' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-selected={isSelected}
                      onClick={() => diffMode === 'base' ? selectBaseFile(entry.file) : selectFile(entry.file, entry.status)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); diffMode === 'base' ? selectBaseFile(entry.file) : selectFile(entry.file, entry.status) } }}
                      onContextMenu={(e) => { e.preventDefault(); setContextMenu({ x: e.clientX, y: e.clientY, file: entry.file }) }}
                    >
                      <div className="changes-event-header" style={{ alignItems: 'center', cursor: 'pointer' }}>
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
                        {diffMode === 'working' && (
                          <button
                            className="changes-refresh-btn"
                            title={`Revert ${entry.file}`}
                            disabled={reverting.has(entry.file)}
                            onClick={(e) => { e.stopPropagation(); handleRevert(entry.file) }}
                            style={{ marginLeft: '4px', color: 'var(--danger)' }}
                          >
                            {reverting.has(entry.file) ? <RotateCw size={11} className="spinning" /> : <Undo2 size={11} />}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
              {/* Right pane: diff viewer */}
              <div className="diff-first-right">
                {rightPane}
              </div>
            </div>
          )}
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
          {/* Commit History */}
          <div className="checkpoint-section">
            <div className="checkpoint-section-header" onClick={() => setCommitsOpen(!commitsOpen)}>
              <ChevronRight size={11} style={{ transition: 'transform 0.15s', transform: commitsOpen ? 'rotate(90deg)' : 'none', opacity: 0.5 }} />
              <GitCommit size={12} />
              Commits
              {unpushedHashes.size > 0 && (
                <span style={{ fontSize: '10px', color: 'var(--text-muted)', fontWeight: 400 }}>({unpushedHashes.size} unpushed)</span>
              )}
            </div>
            {commitsOpen && (
              <>
                {commits.length === 0 && (
                  <div className="checkpoint-empty">Loading commits...</div>
                )}
                {commits.map(c => {
                  const isUnpushed = unpushedHashes.has(c.hash)
                  const isExpanded = expandedCommit === c.hash
                  return (
                    <div key={c.hash}>
                      <div
                        className={`checkpoint-row${isExpanded ? ' expanded' : ''}`}
                        onClick={() => handleExpandCommit(c.hash)}
                        style={{ cursor: 'pointer' }}
                      >
                        <ChevronRight size={10} style={{ flexShrink: 0, transition: 'transform 0.15s', transform: isExpanded ? 'rotate(90deg)' : 'none', opacity: 0.4 }} />
                        <code className="commit-hash" style={{ fontSize: '9px', fontFamily: 'monospace', opacity: 0.6, flexShrink: 0, width: '48px' }}>{c.hash.slice(0, 7)}</code>
                        <span style={{ flex: 1, fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.subject}</span>
                        {isUnpushed && (
                          <span style={{ fontSize: '8px', fontWeight: 600, padding: '1px 4px', borderRadius: '3px', background: 'rgba(59,130,246,0.15)', color: 'var(--accent)', border: '1px solid rgba(59,130,246,0.3)', flexShrink: 0 }}>unpushed</span>
                        )}
                        <span style={{ fontSize: '9px', opacity: 0.4, flexShrink: 0, marginLeft: '4px' }}>{c.date}</span>
                      </div>
                      {isExpanded && (
                        <div className="checkpoint-diff-container">
                          {commitDiffLoading ? (
                            <div className="diff-viewer-empty">Loading diff...</div>
                          ) : commitDiff !== null ? (
                            commitDiff ? (
                              <DiffViewer diff={commitDiff} filename={`commit-${c.hash.slice(0, 7)}`} />
                            ) : (
                              <div className="diff-viewer-empty">No changes in this commit.</div>
                            )
                          ) : null}
                        </div>
                      )}
                    </div>
                  )
                })}
                {hasMoreCommits && commits.length > 0 && (
                  <button
                    className="checkpoint-empty"
                    style={{ cursor: 'pointer', color: 'var(--accent)', background: 'none', border: 'none', width: '100%', textAlign: 'left', padding: '6px 12px' }}
                    onClick={() => loadCommits(commitSkip)}
                  >
                    Load more...
                  </button>
                )}
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
                  onClick={() => { window.api.session.clearScoreCard(instance.id).catch(() => {}); setScoreCard(null) }}
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
          ticket={instance.ticket}
        />
      )}
      {contextMenu && (
        <div
          className="file-context-menu"
          style={{
            position: 'fixed',
            top: contextMenu.y,
            left: contextMenu.x,
            background: 'var(--bg-secondary)',
            border: '1px solid var(--border)',
            borderRadius: '6px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.3)',
            zIndex: 9999,
            minWidth: '160px',
            padding: '4px',
          }}
        >
          <button
            style={{
              display: 'flex', alignItems: 'center', gap: '8px',
              width: '100%', padding: '6px 10px', background: 'none',
              border: 'none', cursor: 'pointer', color: 'var(--text-primary)',
              fontSize: '12px', borderRadius: '4px', textAlign: 'left',
            }}
            onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-secondary)')}
            onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
            onClick={() => openFileHistory(contextMenu.file)}
          >
            <History size={13} style={{ opacity: 0.7 }} />
            File History
          </button>
        </div>
      )}
    </>
  )
}
