import React, { useState, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight, GitCommit, Users, Clock, FileCode, GitCompareArrows } from 'lucide-react'
import DiffViewer from './DiffViewer'
import type { SessionArtifact } from '../../../preload'

type Timeframe = '4h' | '12h' | '24h' | '7d'

const TIMEFRAME_MS: Record<Timeframe, number> = {
  '4h': 4 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
}

interface FileContributor {
  sessionName: string
  personaName?: string
  insertions: number
  deletions: number
  commits: string[]
  workingDirectory: string
  artifactTimestamp: string
}

interface AggregatedFile {
  filePath: string
  insertions: number
  deletions: number
  contributors: FileContributor[]
  workingDirectory: string
  project: string
}

interface ProjectGroup {
  project: string
  workingDirectory: string
  files: AggregatedFile[]
  totalInsertions: number
  totalDeletions: number
  sessionCount: number
}

function timeLabel(tf: Timeframe): string {
  return tf === '7d' ? '7 days' : tf
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p
}

function aggregateArtifacts(artifacts: SessionArtifact[], timeframe: Timeframe): ProjectGroup[] {
  const cutoff = Date.now() - TIMEFRAME_MS[timeframe]
  const recent = artifacts.filter(a => new Date(a.createdAt).getTime() >= cutoff)

  // Map: `${workingDirectory}::${filePath}` → AggregatedFile
  const fileMap = new Map<string, AggregatedFile>()

  for (const artifact of recent) {
    const project = basename(artifact.workingDirectory)
    for (const change of artifact.changes) {
      const key = `${artifact.workingDirectory}::${change.file}`
      const existing = fileMap.get(key)
      const contributor: FileContributor = {
        sessionName: artifact.sessionName,
        personaName: artifact.personaName,
        insertions: change.insertions,
        deletions: change.deletions,
        commits: artifact.commits.map(c => c.hash),
        workingDirectory: artifact.workingDirectory,
        artifactTimestamp: artifact.createdAt,
      }
      if (existing) {
        existing.insertions += change.insertions
        existing.deletions += change.deletions
        existing.contributors.push(contributor)
      } else {
        fileMap.set(key, {
          filePath: change.file,
          insertions: change.insertions,
          deletions: change.deletions,
          contributors: [contributor],
          workingDirectory: artifact.workingDirectory,
          project,
        })
      }
    }
  }

  // Group by workingDirectory
  const projectMap = new Map<string, ProjectGroup>()
  for (const file of fileMap.values()) {
    const existing = projectMap.get(file.workingDirectory)
    const uniqueSessions = new Set(file.contributors.map(c => c.sessionName)).size
    if (existing) {
      existing.files.push(file)
      existing.totalInsertions += file.insertions
      existing.totalDeletions += file.deletions
      existing.sessionCount = Math.max(existing.sessionCount, uniqueSessions)
    } else {
      projectMap.set(file.workingDirectory, {
        project: file.project,
        workingDirectory: file.workingDirectory,
        files: [file],
        totalInsertions: file.insertions,
        totalDeletions: file.deletions,
        sessionCount: uniqueSessions,
      })
    }
  }

  // Sort files within each project: most changed first
  for (const group of projectMap.values()) {
    group.files.sort((a, b) => (b.insertions + b.deletions) - (a.insertions + a.deletions))
  }

  return Array.from(projectMap.values()).sort((a, b) =>
    (b.totalInsertions + b.totalDeletions) - (a.totalInsertions + a.totalDeletions)
  )
}

interface FileDiffState {
  loading: boolean
  diff: string | null
  error: string | null
}

function FileRow({ file }: { file: AggregatedFile }) {
  const [expanded, setExpanded] = useState(false)
  const [diffState, setDiffState] = useState<FileDiffState>({ loading: false, diff: null, error: null })

  const uniqueSessions = new Set(file.contributors.map(c => c.sessionName))
  const isMultiTouch = uniqueSessions.size > 1

  const fetchDiff = async () => {
    if (diffState.diff !== null || diffState.loading) return
    setDiffState({ loading: true, diff: null, error: null })
    try {
      // Collect all commits from all contributors, sorted by timestamp
      const allContributors = [...file.contributors].sort(
        (a, b) => new Date(a.artifactTimestamp).getTime() - new Date(b.artifactTimestamp).getTime()
      )
      const allCommits = allContributors.flatMap(c => c.commits).filter(Boolean)
      if (allCommits.length === 0) {
        setDiffState({ loading: false, diff: '', error: null })
        return
      }
      const from = allCommits[0]
      const to = allCommits[allCommits.length - 1]
      let diff: string
      if (from === to) {
        // Single commit — use commitDiff
        diff = await window.api.git.commitDiff(file.workingDirectory, from)
        // Extract the section for this file
        diff = extractFilePatch(diff, file.filePath)
      } else {
        diff = await window.api.git.diffRangeFile(file.workingDirectory, `${from}^`, to, file.filePath)
      }
      setDiffState({ loading: false, diff, error: null })
    } catch (err) {
      setDiffState({ loading: false, diff: null, error: String(err) })
    }
  }

  const handleToggle = () => {
    if (!expanded) fetchDiff()
    setExpanded(e => !e)
  }

  return (
    <div className={`overview-changes-file-row ${isMultiTouch ? 'overview-changes-multi-touch' : ''}`}>
      <button className="overview-changes-file-header" onClick={handleToggle}>
        <span className="overview-changes-file-chevron">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className="overview-changes-file-path">{file.filePath}</span>
        <span className="overview-changes-file-stats">
          <span className="diff-stat-add">+{file.insertions}</span>
          {' / '}
          <span className="diff-stat-del">-{file.deletions}</span>
        </span>
        {isMultiTouch && (
          <span className="overview-changes-multi-touch-badge" title={`Touched by ${uniqueSessions.size} sessions`}>
            <Users size={10} /> {uniqueSessions.size} sessions
          </span>
        )}
        <span className="overview-changes-file-chips">
          {file.contributors.slice(0, 3).map((c, i) => (
            <span key={i} className="overview-changes-chip" title={c.sessionName}>
              {c.personaName ?? c.sessionName.split(' ').slice(0, 2).join(' ')}
            </span>
          ))}
          {file.contributors.length > 3 && (
            <span className="overview-changes-chip overview-changes-chip-more">+{file.contributors.length - 3}</span>
          )}
        </span>
      </button>
      {expanded && (
        <div className="overview-changes-diff">
          {diffState.loading && <div className="overview-changes-diff-loading">Loading diff…</div>}
          {diffState.error && <div className="overview-changes-diff-error">Failed to load diff: {diffState.error}</div>}
          {diffState.diff !== null && !diffState.loading && (
            diffState.diff.trim()
              ? <DiffViewer diff={diffState.diff} filename={file.filePath} />
              : <div className="overview-changes-diff-empty">No diff available for this file.</div>
          )}
        </div>
      )}
    </div>
  )
}

function extractFilePatch(fullDiff: string, filePath: string): string {
  const escaped = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(diff --git [^\n]*${escaped}[^\n]*\n)`)
  const idx = fullDiff.search(re)
  if (idx === -1) return ''
  const next = fullDiff.indexOf('\ndiff --git ', idx + 1)
  return next === -1 ? fullDiff.slice(idx) : fullDiff.slice(idx, next)
}

export default function OverviewChangesTab() {
  const [artifacts, setArtifacts] = useState<SessionArtifact[]>([])
  const [timeframe, setTimeframe] = useState<Timeframe>('24h')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    window.api.artifacts.list().then(list => {
      setArtifacts(list)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [])

  const groups = useMemo(() => aggregateArtifacts(artifacts, timeframe), [artifacts, timeframe])

  const totalFiles = groups.reduce((s, g) => s + g.files.length, 0)
  const totalSessions = useMemo(() => {
    const cutoff = Date.now() - TIMEFRAME_MS[timeframe]
    return new Set(
      artifacts
        .filter(a => new Date(a.createdAt).getTime() >= cutoff && a.changes.length > 0)
        .map(a => a.sessionName)
    ).size
  }, [artifacts, timeframe])
  const totalInsertions = groups.reduce((s, g) => s + g.totalInsertions, 0)
  const totalDeletions = groups.reduce((s, g) => s + g.totalDeletions, 0)

  return (
    <div className="overview-changes-tab">
      <div className="overview-changes-header">
        <div className="overview-changes-summary">
          {loading ? (
            <span className="overview-changes-loading">Loading…</span>
          ) : (
            <>
              <span className="overview-changes-summary-stat">
                <FileCode size={12} /> {totalFiles} file{totalFiles !== 1 ? 's' : ''} changed
              </span>
              <span className="overview-changes-summary-sep">·</span>
              <span className="overview-changes-summary-stat">
                <GitCommit size={12} /> {totalSessions} session{totalSessions !== 1 ? 's' : ''}
              </span>
              <span className="overview-changes-summary-sep">·</span>
              <span className="diff-stat-add">+{totalInsertions}</span>
              {' '}
              <span className="diff-stat-del">-{totalDeletions}</span>
            </>
          )}
        </div>
        <div className="overview-changes-timeframe">
          <Clock size={11} />
          {(['4h', '12h', '24h', '7d'] as Timeframe[]).map(tf => (
            <button
              key={tf}
              className={`overview-changes-tf-btn${timeframe === tf ? ' active' : ''}`}
              onClick={() => setTimeframe(tf)}
            >
              {tf}
            </button>
          ))}
        </div>
      </div>

      {!loading && groups.length === 0 && (
        <div className="overview-changes-empty">
          No changes in the last {timeLabel(timeframe)}.
        </div>
      )}

      {groups.map(group => (
        <div key={group.workingDirectory} className="overview-changes-project">
          {groups.length > 1 && (
            <div className="overview-changes-project-header">
              <span className="overview-changes-project-name">{group.project}</span>
              <span className="overview-changes-project-stats">
                <span className="diff-stat-add">+{group.totalInsertions}</span>
                {' / '}
                <span className="diff-stat-del">-{group.totalDeletions}</span>
              </span>
            </div>
          )}
          <div className="overview-changes-file-list">
            {group.files.map(file => (
              <FileRow key={`${file.workingDirectory}::${file.filePath}`} file={file} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
