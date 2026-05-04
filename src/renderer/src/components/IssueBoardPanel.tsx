import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { CircleDot, RefreshCw, ChevronDown, ChevronRight, Play, Search, X, ExternalLink, LayoutList, LayoutGrid } from 'lucide-react'
import type { GitHubIssue } from '../../../shared/types'
import HelpPopover from './HelpPopover'

interface IssueWithSlug extends GitHubIssue {
  repoSlug: string
}

interface Props {
  visible: boolean
  onStartSession: (prompt: string, workingDirectory?: string) => void
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const m = Math.floor(diff / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return `${d}d ago`
}

export default function IssueBoardPanel({ visible, onStartSession }: Props) {
  const [issues, setIssues] = useState<IssueWithSlug[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [labelFilter, setLabelFilter] = useState<string | null>(null)
  const [myIssuesOnly, setMyIssuesOnly] = useState(true)
  const [groupByRepo, setGroupByRepo] = useState(true)
  const [expandedIssue, setExpandedIssue] = useState<number | null>(null)
  const [githubUser, setGithubUser] = useState<string | null>(null)
  const [lastFetched, setLastFetched] = useState(0)

  const fetchIssues = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [data, user] = await Promise.all([
        window.api.github.listIssues(),
        window.api.github.getUser(),
      ])
      setIssues(data)
      setGithubUser(user)
      setLastFetched(Date.now())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!visible) return
    if (Date.now() - lastFetched > 5000) fetchIssues()
    const t = setInterval(fetchIssues, 60000)
    return () => clearInterval(t)
  }, [visible, fetchIssues, lastFetched])

  const allLabels = useMemo(() => {
    const s = new Set<string>()
    for (const i of issues) for (const l of i.labels) s.add(l)
    return Array.from(s).sort()
  }, [issues])

  const filtered = useMemo(() => {
    let out = issues
    if (myIssuesOnly && githubUser) {
      out = out.filter(i => i.assignees.includes(githubUser))
    }
    if (labelFilter) {
      out = out.filter(i => i.labels.includes(labelFilter))
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase()
      out = out.filter(i => i.title.toLowerCase().includes(q) || String(i.number).includes(q))
    }
    return out
  }, [issues, myIssuesOnly, githubUser, labelFilter, search])

  const grouped = useMemo(() => {
    if (!groupByRepo) return { '': filtered }
    const g: Record<string, IssueWithSlug[]> = {}
    for (const i of filtered) {
      ;(g[i.repoSlug] = g[i.repoSlug] || []).push(i)
    }
    return g
  }, [filtered, groupByRepo])

  const handleStartSession = (issue: IssueWithSlug) => {
    const prompt = `Work on issue #${issue.number}: ${issue.title}\n\n${issue.body}\n\nRepo: ${issue.repoSlug}\nIssue URL: ${issue.url}`
    onStartSession(prompt)
  }

  if (!visible) return null

  return (
    <div className="panel-container" style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>
      <div className="panel-header">
        <h2><CircleDot size={16} /> Issues</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="issues" align="right" />
        <div className="panel-header-actions">
          <button
            className={`panel-header-btn ${myIssuesOnly ? 'primary' : ''}`}
            title={myIssuesOnly ? 'Showing assigned to me' : 'Showing all issues'}
            onClick={() => setMyIssuesOnly(v => !v)}
            style={{ fontSize: 11 }}
          >
            {myIssuesOnly ? 'Mine' : 'All'}
          </button>
          <button
            className="panel-header-btn"
            title={groupByRepo ? 'Switch to flat list' : 'Group by repo'}
            onClick={() => setGroupByRepo(v => !v)}
          >
            {groupByRepo ? <LayoutList size={14} /> : <LayoutGrid size={14} />}
          </button>
          <button
            className={`panel-header-btn ${loading ? 'spinning' : ''}`}
            title="Refresh issues"
            onClick={fetchIssues}
            disabled={loading}
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border)', alignItems: 'center', flexShrink: 0 }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <Search size={12} style={{ position: 'absolute', left: 6, top: '50%', transform: 'translateY(-50%)', opacity: 0.4 }} />
          <input
            className="search-input"
            style={{ paddingLeft: 22, width: '100%', boxSizing: 'border-box' }}
            placeholder="Search issues..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && <button onClick={() => setSearch('')} style={{ position: 'absolute', right: 4, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', opacity: 0.5, padding: 2 }}><X size={12} /></button>}
        </div>
        {allLabels.length > 0 && (
          <select
            className="search-input"
            style={{ fontSize: 11, maxWidth: 120 }}
            value={labelFilter || ''}
            onChange={e => setLabelFilter(e.target.value || null)}
          >
            <option value="">All labels</option>
            {allLabels.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
        )}
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
        {error && <div className="pipeline-error-block" style={{ margin: '8px 0' }}>{error}</div>}
        {!loading && filtered.length === 0 && (
          <div className="empty-state" style={{ marginTop: 40 }}>
            <CircleDot size={24} opacity={0.3} />
            <p>{issues.length === 0 ? 'No open issues found across configured repos.' : 'No issues match your filters.'}</p>
          </div>
        )}
        {Object.entries(grouped).map(([repo, repoIssues]) => (
          <div key={repo || '_flat'} style={{ marginBottom: 16 }}>
            {groupByRepo && repo && (
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 6, paddingBottom: 4, borderBottom: '1px solid var(--border)' }}>
                {repo} <span style={{ fontWeight: 400 }}>({repoIssues.length})</span>
              </div>
            )}
            {repoIssues.map(issue => (
              <IssueCard
                key={`${issue.repoSlug}#${issue.number}`}
                issue={issue}
                expanded={expandedIssue === issue.number && (!groupByRepo || true)}
                onToggle={() => setExpandedIssue(v => v === issue.number ? null : issue.number)}
                onStartSession={() => handleStartSession(issue)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}

interface IssueCardProps {
  issue: IssueWithSlug
  expanded: boolean
  onToggle: () => void
  onStartSession: () => void
}

function IssueCard({ issue, expanded, onToggle, onStartSession }: IssueCardProps) {
  const truncatedBody = issue.body.length > 200 ? issue.body.slice(0, 200) + '…' : issue.body

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 6, marginBottom: 6, overflow: 'hidden' }}>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 10px', cursor: 'pointer', background: 'var(--bg-secondary)' }}
        onClick={onToggle}
      >
        {expanded ? <ChevronDown size={12} style={{ flexShrink: 0 }} /> : <ChevronRight size={12} style={{ flexShrink: 0 }} />}
        <CircleDot size={13} style={{ flexShrink: 0, color: 'var(--accent-green, #4ade80)' }} />
        <span style={{ fontSize: 12, fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          #{issue.number} {issue.title}
        </span>
        {issue.labels.map(l => (
          <span key={l} className="pipeline-card-trigger" style={{ fontSize: 10 }}>{l}</span>
        ))}
        <span style={{ fontSize: 10, color: 'var(--text-muted)', flexShrink: 0 }}>{relativeTime(issue.createdAt)}</span>
        <button
          className="panel-header-btn primary"
          style={{ fontSize: 11, padding: '2px 8px', flexShrink: 0 }}
          onClick={e => { e.stopPropagation(); onStartSession() }}
          title="Start a session for this issue"
        >
          <Play size={11} /> Start
        </button>
      </div>
      {expanded && (
        <div style={{ padding: '8px 12px', borderTop: '1px solid var(--border)', background: 'var(--bg-primary)' }}>
          {issue.assignees.length > 0 && (
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 6 }}>
              Assignees: {issue.assignees.join(', ')}
              {issue.comments > 0 && ` · ${issue.comments} comment${issue.comments !== 1 ? 's' : ''}`}
            </div>
          )}
          {issue.body ? (
            <pre style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: 0, fontFamily: 'inherit', color: 'var(--text-primary)' }}>
              {truncatedBody}
            </pre>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-muted)', fontStyle: 'italic' }}>No description</span>
          )}
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <a
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              style={{ fontSize: 11, color: 'var(--accent)', textDecoration: 'none', display: 'flex', alignItems: 'center', gap: 3 }}
              onClick={e => { e.stopPropagation(); window.api.shell.openExternal(issue.url) }}
            >
              <ExternalLink size={11} /> Open on GitHub
            </a>
          </div>
        </div>
      )}
    </div>
  )
}
