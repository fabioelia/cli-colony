import { useState, useEffect, useCallback, useRef } from 'react'
import { useFileDrop } from '../hooks/useFileDrop'
import { ArrowLeft, Plus, Trash2, RefreshCw, GitPullRequest, ExternalLink, Play, Pencil, ChevronDown, ChevronRight, MessageSquare, Send, User, Users, Eye, GitBranch, Clock, FileDiff, ShieldCheck, ShieldAlert, ShieldQuestion, Brain, Save, X, FileText, File, Filter, Search, CheckCircle, XCircle, Loader, CircleDot, Wrench, Download, AlertCircle, UserPlus } from 'lucide-react'
import RepoRemovalModal, { type RemovalImpact } from './RepoRemovalModal'
import PromptEnvironmentSelector from './PromptEnvironmentSelector'
import MarkdownViewer from './MarkdownViewer'
import type { GitHubPR, GitHubRepo, QuickPrompt, PRChecks, FeedbackFile } from '../types'
import type { PersonaInfo } from '../../../shared/types'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'
import Tooltip from './Tooltip'
import HelpPopover from './HelpPopover'
import EmptyStateHook from './EmptyStateHook'
import { shouldSyncClaudeSlashCommands } from '../lib/claude-slash-sync'

function resolveRelativeUrl(href: string, repoSlug: string, branch: string): string {
  if (!href || href.startsWith('http') || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('data:')) return href
  const cleanHref = href.startsWith('/') ? href.slice(1) : href
  return `https://github.com/${repoSlug}/blob/${branch}/${cleanHref}`
}

function preprocessGitHubUrls(md: string, repoSlug: string, branch: string): string {
  return md
    // [text](relative-path) → [text](absolute-url)
    .replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_match, text, href) => {
      const resolved = resolveRelativeUrl(href, repoSlug, branch)
      return `[${text}](${resolved})`
    })
    // ![alt](relative-path) → ![alt](raw-url)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, href) => {
      if (!href || href.startsWith('http') || href.startsWith('data:')) return match
      const cleanHref = href.startsWith('/') ? href.slice(1) : href
      return `![${alt}](https://raw.githubusercontent.com/${repoSlug}/${branch}/${cleanHref})`
    })
}

interface Props {
  onBack: () => void
  onLaunchInstance: (opts: { name?: string; workingDirectory?: string; args?: string[] }) => Promise<string> // returns instance id
  onFocusInstance: (id: string) => void
  instances: Array<{ id: string; status: string }>
  visible?: boolean
}

export default function GitHubPanel({ onBack, onLaunchInstance, onFocusInstance, instances, visible }: Props) {
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [prompts, setPrompts] = useState<QuickPrompt[]>([])
  const [ghAuth, setGhAuth] = useState<boolean | null>(null)
  const [prsByRepo, setPrsByRepo] = useState<Record<string, GitHubPR[]>>({})
  const [loadingRepo, setLoadingRepo] = useState<string | null>(null)
  const [cloningRepo, setCloningRepo] = useState<string | null>(null)
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null)
  const [expandedPR, setExpandedPR] = useState<string | null>(null) // "owner/name#number"
  const [error, setError] = useState<string | null>(null)

  // Add repo form
  const [showAddRepo, setShowAddRepo] = useState(false)
  const [repoInput, setRepoInput] = useState('')

  // Removal impact modal
  const [removalTarget, setRemovalTarget] = useState<{ owner: string; name: string } | null>(null)
  const [removalImpact, setRemovalImpact] = useState<RemovalImpact | null>(null)
  const [scanningRemoval, setScanningRemoval] = useState(false)

  // Filters
  const [filterText, setFilterText] = useState('')
  const [filterStatus, setFilterStatus] = useState<string[]>([]) // 'open', 'draft'
  const [filterLabels, setFilterLabels] = useState<string[]>([])
  const [filterAuthors, setFilterAuthors] = useState<string[]>([])
  const [filterReviewers, setFilterReviewers] = useState<string[]>([])
  const [filterBaseBranch, setFilterBaseBranch] = useState<string[]>([])
  const [showFilters, setShowFilters] = useState(false)

  // Prompt editor
  const [showPromptEditor, setShowPromptEditor] = useState(false)
  const [editingPrompts, setEditingPrompts] = useState<QuickPrompt[]>([])

  // Ask bar — persistent PR assistant instance
  const [askInput, setAskInput] = useState('')
  const [assistantId, setAssistantId] = useState<string | null>(null)
  const { ref: askBarRef, isDragging: askBarDragging } = useFileDrop(paths => {
    setAskInput(prev => (prev ? prev + '\n' : '') + paths.join('\n'))
  })

  // PR Memory
  const [memory, setMemory] = useState('')
  const [memoryPath, setMemoryPath] = useState<string | null>(null)
  const [showMemory, setShowMemory] = useState(false)
  const [editingMemory, setEditingMemory] = useState(false)
  const [memoryDraft, setMemoryDraft] = useState('')
  const [showContextFile, setShowContextFile] = useState(false)
  const [contextFileContent, setContextFileContent] = useState('')
  const [showCommentsViewer, setShowCommentsViewer] = useState(false)
  const [commentsViewerPR, setCommentsViewerPR] = useState<GitHubPR | null>(null)
  const [commentsViewerSlug, setCommentsViewerSlug] = useState('')
  const [commentsViewerIndex, setCommentsViewerIndex] = useState(0)

  // CI/CD check status per PR (keyed by "owner/name#number")
  const [checksByPR, setChecksByPR] = useState<Record<string, PRChecks>>({})
  const [checksLoading, setChecksLoading] = useState<Set<string>>(new Set())
  const checksFetchedRef = useRef<Set<string>>(new Set())
  const [checkLogContent, setCheckLogContent] = useState<string | null>(null)
  const [checkLogName, setCheckLogName] = useState<string | null>(null)

  // Persona dispatch
  const [personaList, setPersonaList] = useState<PersonaInfo[]>([])
  const [dispatchingPRKey, setDispatchingPRKey] = useState<string | null>(null)
  const [dispatchPersonaId, setDispatchPersonaId] = useState('')
  const [dispatchContext, setDispatchContext] = useState('')
  const [dispatchToast, setDispatchToast] = useState<string | null>(null)

  // GitHub user (for attention badges)
  const [ghUser, setGhUser] = useState<string | null>(null)

  // Feedback files per PR (keyed by "owner/name#number")
  const [feedbackByPR, setFeedbackByPR] = useState<Record<string, FeedbackFile[]>>({})

  // Prompt Environment Selector modal
  const [showEnvSelector, setShowEnvSelector] = useState(false)
  const [pendingPromptAction, setPendingPromptAction] = useState<{ prompt: QuickPrompt; pr: GitHubPR; repo: GitHubRepo } | null>(null)

  // Sync PR context file whenever prsByRepo changes
  const [contextPath, setContextPath] = useState<string | null>(null)
  const hasPrs = Object.values(prsByRepo).some((prs) => prs.length > 0)

  // Fetch GitHub user on mount
  useEffect(() => {
    window.api.github.getUser().then(setGhUser)
  }, [])

  useEffect(() => {
    if (!hasPrs) return
    window.api.github.writePrContext(prsByRepo).then(setContextPath)
  }, [prsByRepo, hasPrs])

  // Ensure all repos have PRs fetched and context file is up-to-date before launching a prompt
  const ensurePRsRefreshed = async (): Promise<string | null> => {
    let updated = { ...prsByRepo }
    let didFetch = false
    for (const repo of repos) {
      const slug = `${repo.owner}/${repo.name}`
      if (!updated[slug]) {
        try {
          const prs = await window.api.github.fetchPRs(repo)
          updated[slug] = prs
          didFetch = true
        } catch { /* skip */ }
      }
    }
    if (didFetch) {
      setPrsByRepo(updated)
    }
    // Always rewrite context file with latest data
    const path = await window.api.github.writePrContext(updated)
    setContextPath(path)
    // Also update colony context so all sessions see fresh state
    await window.api.colony.updateContext()
    return path
  }

  // Clear assistant ID if the instance was killed/removed
  useEffect(() => {
    if (assistantId && !instances.some((i) => i.id === assistantId)) {
      setAssistantId(null)
    }
  }, [instances, assistantId])

  const handleAsk = async (directPrompt?: string) => {
    const q = (directPrompt || askInput).trim()
    if (!q) return
    setAskInput('')

    // Ensure all PRs are fetched and context file is current
    const currentContextPath = await ensurePRsRefreshed()
    if (!currentContextPath) return

    // If we have a living assistant, just send the follow-up
    if (assistantId && instances.some((i) => i.id === assistantId && i.status === 'running')) {
      await window.api.instance.write(assistantId, q + '\r')
      onFocusInstance(assistantId)
      return
    }

    // First question — create a new interactive instance in the PR workspace
    const id = await onLaunchInstance({
      name: 'PR Assistant',
      workingDirectory: workspacePath || undefined,
    })
    setAssistantId(id)
    const prompt = `Read the file ${currentContextPath} which contains all open PRs across my repositories. Each PR may have a comments file referenced — read those too if relevant. Then answer this question: ${q}${memoryInstructions}${colonyContextInstruction}`
    sendPromptToInstance(id, prompt, `PR: ${q.slice(0, 30)}`)
  }

  const [workspacePath, setWorkspacePath] = useState<string | null>(null)

  useEffect(() => {
    window.api.github.authStatus().then(setGhAuth)
    window.api.github.getRepos().then(setRepos)
    window.api.github.getPrompts().then(setPrompts)
    window.api.github.getPrMemory().then(setMemory)
    window.api.github.getPrMemoryPath().then(setMemoryPath)
    window.api.github.getPrWorkspacePath().then(setWorkspacePath)
    window.api.persona.list().then(setPersonaList)
  }, [])

  // Reload prompts when panel becomes visible (picks up pipeline-enabled changes)
  useEffect(() => {
    if (visible) {
      window.api.github.getPrompts().then(setPrompts)
    }
  }, [visible])

  // Escape key closes any open modal
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      if (dispatchingPRKey) { setDispatchingPRKey(null); return }
      if (showCommentsViewer) { setShowCommentsViewer(false); return }
      if (showContextFile) { setShowContextFile(false); return }
      if (showMemory) { setShowMemory(false); setEditingMemory(false); return }
      if (showPromptEditor) { setShowPromptEditor(false); return }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [dispatchingPRKey, showCommentsViewer, showContextFile, showMemory, showPromptEditor])

  // Auto-expand first repo and fetch PRs for all repos sequentially
  useEffect(() => {
    if (repos.length === 0) return
    if (!expandedRepo) {
      setExpandedRepo(`${repos[0].owner}/${repos[0].name}`)
    }
    // Fetch any repos not yet loaded, sequentially to avoid rate limits
    (async () => {
      for (const repo of repos) {
        const slug = `${repo.owner}/${repo.name}`
        if (!prsByRepo[slug]) {
          await fetchPRsForRepo(repo)
        }
      }
    })()
  }, [repos])

  const fetchPRsForRepo = async (repo: GitHubRepo) => {
    const slug = `${repo.owner}/${repo.name}`
    setLoadingRepo(slug)
    setError(null)
    try {
      const prs = await window.api.github.fetchPRs(repo)
      setPrsByRepo((prev) => ({ ...prev, [slug]: prs }))
      // Fetch feedback files for each PR (non-blocking)
      for (const pr of prs) {
        const prKey = `${slug}#${pr.number}`
        window.api.github.fetchFeedback(repo, pr.number)
          .then((files) => { if (files.length > 0) setFeedbackByPR((prev) => ({ ...prev, [prKey]: files })) })
          .catch(() => {})
      }
    } catch (err: any) {
      setError(`Failed to fetch PRs for ${slug}: ${err.message}`)
    } finally {
      setLoadingRepo(null)
    }
  }

  const handleAddRepo = async () => {
    const raw = repoInput.trim().replace(/\/$/, '')
    let owner: string | undefined
    let name: string | undefined

    // Try parsing as a GitHub URL (https://github.com/owner/name/...)
    const urlMatch = raw.match(/(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/)
    if (urlMatch) {
      owner = urlMatch[1]
      name = urlMatch[2]
    } else {
      // Try owner/name format
      const parts = raw.split('/')
      if (parts.length === 2 && parts[0] && parts[1]) {
        owner = parts[0]
        name = parts[1]
      }
    }

    if (!owner || !name) {
      setError('Enter a repo as owner/name or paste a GitHub URL')
      return
    }
    const updated = await window.api.github.addRepo({ owner, name })
    setRepos(updated)
    setRepoInput('')
    setShowAddRepo(false)
    // Auto-fetch PRs for new repo
    const slug = `${owner}/${name}`
    setExpandedRepo(slug)
    fetchPRsForRepo({ owner, name })
  }

  const handleRemoveRepo = async (repo: GitHubRepo) => {
    setScanningRemoval(true)
    setRemovalTarget(repo)
    try {
      const impact = await window.api.github.getRemovalImpact(repo.owner, repo.name)
      setRemovalImpact(impact)
    } finally {
      setScanningRemoval(false)
    }
  }

  const confirmRemoveRepo = async () => {
    if (!removalTarget) return
    const { owner, name } = removalTarget
    const updated = await window.api.github.removeRepo(owner, name)
    setRepos(updated)
    const slug = `${owner}/${name}`
    setPrsByRepo((prev) => {
      const next = { ...prev }
      delete next[slug]
      return next
    })
    setRemovalTarget(null)
    setRemovalImpact(null)
  }

  const handleRemovalLaunchSession = async (prompt: string) => {
    const id = await onLaunchInstance({
      name: `Cleanup: ${removalTarget?.owner}/${removalTarget?.name}`,
      workingDirectory: workspacePath || undefined,
    })
    onFocusInstance(id)
    sendPromptToInstance(id, prompt, 'Repo cleanup')
  }

  const handleSetLocalPath = async (repo: GitHubRepo) => {
    const path = await window.api.dialog.openDirectory()
    if (path) {
      const updated = await window.api.github.updateRepoPath(repo.owner, repo.name, path)
      setRepos(updated)
    }
  }

  const handleToggleRepo = (repo: GitHubRepo) => {
    const slug = `${repo.owner}/${repo.name}`
    if (expandedRepo === slug) {
      setExpandedRepo(null)
    } else {
      setExpandedRepo(slug)
      if (!prsByRepo[slug]) {
        fetchPRsForRepo(repo)
      }
    }
  }

  const memoryInstructions = memoryPath
    ? `\n\nIMPORTANT: A PR memory file exists at ${memoryPath}. Read it for context from previous PR discussions. If you learn something important during this conversation (patterns, decisions, team preferences, recurring issues), append it to that file so it's available in future PR sessions.`
    : ''

  const [colonyContextInstruction, setColonyContextInstruction] = useState('')
  useEffect(() => {
    window.api.colony.getContextInstruction().then(setColonyContextInstruction)
  }, [])

  const sendPromptToInstance = (id: string, prompt: string, sessionName?: string) => {
    const sendNameAndPrompt = async () => {
      if (sessionName) {
        await window.api.instance.rename(id, sessionName)
        if (await shouldSyncClaudeSlashCommands()) {
          await window.api.instance.write(id, `/rename ${sessionName}\r`)
          await new Promise((r) => setTimeout(r, 300))
        }
      }
      window.api.instance.write(id, prompt)
      setTimeout(() => window.api.instance.write(id, '\r'), 150)
    }

    sendPromptWhenReady(id, { onReady: () => void sendNameAndPrompt() })
  }

  const handleDispatch = async (pr: GitHubPR, repo: GitHubRepo) => {
    if (!dispatchPersonaId) return
    const body = pr.body || ''
    const truncBody = body.slice(0, 400) + (body.length > 400 ? '…' : '')
    const noteText = `GitHub PR #${pr.number}: **${pr.title}**\n${pr.url}\n\n${truncBody}${dispatchContext.trim() ? '\n\nUser: ' + dispatchContext.trim() : ''}`
    await window.api.persona.whisper(dispatchPersonaId, noteText)
    const persona = personaList.find(p => p.id === dispatchPersonaId)
    setDispatchToast(`Dispatched PR #${pr.number} to ${persona?.name ?? dispatchPersonaId}`)
    setDispatchingPRKey(null)
    setDispatchContext('')
    setTimeout(() => setDispatchToast(null), 3000)
  }

  const handleQuickAction = async (prompt: QuickPrompt, pr: GitHubPR, repo: GitHubRepo) => {
    // Ensure context file is current before launching
    await ensurePRsRefreshed()
    // Store pending action and show environment selector modal
    setPendingPromptAction({ prompt, pr, repo })
    setShowEnvSelector(true)
  }

  const handleEnvSelectorCreate = async (mode: 'create', opts?: { name?: string; workingDirectory?: string; args?: string[] }) => {
    if (!pendingPromptAction) return
    const { prompt, pr, repo } = pendingPromptAction
    const resolved = await window.api.github.resolvePrompt(prompt, pr, repo)
    const slug = `${repo.owner}/${repo.name}`
    const commentRef = pr.comments?.length > 0
      ? `\n\nThe PR has ${pr.comments.length} comments. Read the comments file at ~/.claude-colony/pr-workspace/comments/${slug.replace(/\//g, '-')}-${pr.number}.md for full details.`
      : ''
    const id = await onLaunchInstance({
      name: opts?.name || `${prompt.label}: ${repo.name}#${pr.number}`,
      workingDirectory: opts?.workingDirectory || repo.localPath || workspacePath || undefined,
      args: opts?.args,
    })
    sendPromptToInstance(id, resolved + commentRef + memoryInstructions + colonyContextInstruction, `${prompt.label}: ${repo.name}#${pr.number}`)
    setShowEnvSelector(false)
    setPendingPromptAction(null)
  }

  const handleEnvSelectorReuse = async (instanceId: string) => {
    if (!pendingPromptAction) return
    const { prompt, pr, repo } = pendingPromptAction
    const resolved = await window.api.github.resolvePrompt(prompt, pr, repo)
    const slug = `${repo.owner}/${repo.name}`
    const commentRef = pr.comments?.length > 0
      ? `\n\nThe PR has ${pr.comments.length} comments. Read the comments file at ~/.claude-colony/pr-workspace/comments/${slug.replace(/\//g, '-')}-${pr.number}.md for full details.`
      : ''
    sendPromptToInstance(instanceId, resolved + commentRef + memoryInstructions + colonyContextInstruction, `${prompt.label}: ${repo.name}#${pr.number}`)
    onFocusInstance(instanceId)
    setShowEnvSelector(false)
    setPendingPromptAction(null)
  }

  const handleOpenPromptEditor = () => {
    setEditingPrompts(prompts.map((p) => ({ ...p })))
    setShowPromptEditor(true)
  }

  const handleSavePrompts = async () => {
    const valid = editingPrompts.filter((p) => p.label.trim() && p.prompt.trim())
    const updated = await window.api.github.savePrompts(valid)
    setPrompts(updated)
    setShowPromptEditor(false)
  }

  const handleAddPrompt = () => {
    setEditingPrompts([...editingPrompts, {
      id: `custom-${Date.now()}`,
      label: '',
      prompt: '',
      scope: 'pr' as const,
    }])
  }

  const handleRemovePrompt = (id: string) => {
    setEditingPrompts(editingPrompts.filter((p) => p.id !== id))
  }

  const handleUpdatePrompt = (id: string, field: 'label' | 'prompt', value: string) => {
    setEditingPrompts(editingPrompts.map((p) =>
      p.id === id ? { ...p, [field]: value } : p
    ))
  }

  // Collect all unique filter options from loaded PRs
  const allPRs = Object.values(prsByRepo).flat()
  const allLabels = [...new Set(allPRs.flatMap((pr) => pr.labels || []))].sort()
  const allAuthors = [...new Set(allPRs.map((pr) => pr.author))].sort()
  const allReviewersList = [...new Set(allPRs.flatMap((pr) => pr.reviewers || []))].sort()
  const allBaseBranches = [...new Set(allPRs.map((pr) => pr.baseBranch).filter(Boolean))].sort()

  const prAgeDays = (pr: GitHubPR) => Math.floor((Date.now() - new Date(pr.createdAt).getTime()) / 86_400_000)

  const filterPR = (pr: GitHubPR): boolean => {
    const q = filterText.toLowerCase()
    if (q) {
      const searchable = [
        pr.title, pr.author, pr.branch, String(pr.number),
        pr.body || '',
        ...(pr.comments || []).map((c) => c.body),
      ].join(' ').toLowerCase()
      if (!searchable.includes(q)) return false
    }
    if (filterStatus.length > 0) {
      const status = pr.draft ? 'draft' : 'open'
      if (!filterStatus.includes(status)) return false
    }
    if (filterLabels.length > 0) {
      if (!filterLabels.some((l) => (pr.labels || []).includes(l))) return false
    }
    if (filterAuthors.length > 0) {
      if (!filterAuthors.includes(pr.author)) return false
    }
    if (filterReviewers.length > 0) {
      if (!filterReviewers.some((r) => (pr.reviewers || []).includes(r))) return false
    }
    if (filterBaseBranch.length > 0) {
      if (!filterBaseBranch.includes(pr.baseBranch)) return false
    }
    return true
  }

  const hasActiveFilters = filterText || filterStatus.length > 0 || filterLabels.length > 0 || filterAuthors.length > 0 || filterReviewers.length > 0 || filterBaseBranch.length > 0

  const attentionPRs: Array<{ pr: GitHubPR; slug: string; prKey: string; reason: string }> = []
  if (ghUser) {
    for (const repo of repos) {
      const slug = `${repo.owner}/${repo.name}`
      for (const pr of (prsByRepo[slug] || []).filter(filterPR)) {
        const prKey = `${slug}#${pr.number}`
        if (pr.reviewers.includes(ghUser)) {
          attentionPRs.push({ pr, slug, prKey, reason: 'Review requested' })
        } else if (pr.assignees.includes(ghUser)) {
          attentionPRs.push({ pr, slug, prKey, reason: 'Assigned to you' })
        } else if (checksByPR[prKey]?.overall === 'failure' && pr.author === ghUser) {
          attentionPRs.push({ pr, slug, prKey, reason: 'Your PR has failing CI' })
        }
      }
    }
  }

  const clearFilters = () => {
    setFilterText('')
    setFilterStatus([])
    setFilterLabels([])
    setFilterAuthors([])
    setFilterReviewers([])
    setFilterBaseBranch([])
  }

  const fetchChecksForPR = useCallback(async (repo: GitHubRepo, pr: GitHubPR) => {
    const slug = `${repo.owner}/${repo.name}`
    const key = `${slug}#${pr.number}`
    setChecksLoading((prev) => new Set(prev).add(key))
    try {
      const checks = await window.api.github.fetchChecks(repo, pr.number)
      setChecksByPR((prev) => ({ ...prev, [key]: checks }))
    } catch (err) {
      console.error(`[CI] failed to fetch checks for ${key}:`, err)
    }
    setChecksLoading((prev) => {
      const next = new Set(prev)
      next.delete(key)
      return next
    })
  }, [])

  // Auto-fetch checks for all loaded PRs across all repos
  useEffect(() => {
    for (const repo of repos) {
      const slug = `${repo.owner}/${repo.name}`
      const prs = prsByRepo[slug] || []
      for (const pr of prs) {
        const key = `${slug}#${pr.number}`
        if (!checksFetchedRef.current.has(key)) {
          checksFetchedRef.current.add(key)
          fetchChecksForPR(repo, pr)
        }
      }
    }
  }, [prsByRepo, repos, fetchChecksForPR])

  const timeSince = (dateStr: string) => {
    const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return `${Math.floor(secs / 86400)}d ago`
  }

  const reviewColor = (decision: string) => {
    if (decision === 'APPROVED') return 'var(--success)'
    if (decision === 'CHANGES_REQUESTED') return 'var(--danger)'
    if (decision === 'REVIEW_REQUIRED') return 'var(--warning)'
    return 'var(--text-muted)'
  }

  if (ghAuth === false) {
    return (
      <div className="github-panel">
        <div className="panel-header">
          <button className="panel-header-back" onClick={onBack} title="Back"><ArrowLeft size={16} /></button>
          <h2><GitPullRequest size={16} /> GitHub</h2>
        </div>
        <div className="github-auth-error">
          <GitPullRequest size={32} />
          <p>GitHub CLI is not authenticated.</p>
          <p className="github-auth-help">Run <code>gh auth login</code> in your terminal, then reopen this panel.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="github-panel">
      <div className="panel-header">
        <button className="panel-header-back" onClick={onBack} title="Back"><ArrowLeft size={16} /></button>
        <h2><GitPullRequest size={16} /> Pull Requests</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="github" align="right" />
        <div className="panel-header-actions">
          <Tooltip text="PR Memory" detail="Persistent knowledge base shared across all PR sessions. CLI reads and writes to this file." position="bottom">
            <button className="panel-header-btn" onClick={() => {
              window.api.github.getPrMemory().then(setMemory)
              setShowMemory(true)
              setEditingMemory(false)
            }}>
              <Brain size={13} /> Memory
            </button>
          </Tooltip>
          {contextPath && (
            <Tooltip text="PR Context File" detail="Auto-generated markdown with all PR data. This is what CLI sessions read for context." position="bottom">
              <button className="panel-header-btn" onClick={async () => {
                const result = await window.api.fs.readFile(contextPath)
                if (result.content) setContextFileContent(result.content)
                setShowContextFile(true)
              }}>
                <FileText size={13} /> Context
              </button>
            </Tooltip>
          )}
          <Tooltip text="Edit Prompts" detail="Configure quick action templates for PRs and global questions" position="bottom">
            <button className="panel-header-btn" onClick={handleOpenPromptEditor}>
              <Pencil size={13} /> Prompts
            </button>
          </Tooltip>
          <Tooltip text="Add Repository" detail="Track a repo by owner/name or paste a GitHub URL" position="bottom">
            <button className="panel-header-btn" onClick={() => setShowAddRepo(true)}>
              <Plus size={13} /> Add Repo
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Ask bar */}
      {contextPath && (
        <div ref={askBarRef} className={`panel-ask-bar${askBarDragging ? ' dragging' : ''}`}>
          <MessageSquare size={14} className="panel-ask-icon" />
          <input
            className="panel-ask-input"
            placeholder="Ask about these PRs... or drop files to include paths"
            value={askInput}
            onChange={(e) => setAskInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleAsk() } }}
          />
          {prompts.filter((p) => p.scope === 'global').length > 0 && (
            <div className="panel-ask-chips">
              {prompts.filter((p) => p.scope === 'global').map((p) => (
                <Tooltip key={p.id} text={p.label} detail={p.prompt.slice(0, 120)} position="bottom">
                  <button className="panel-ask-chip" onClick={() => setAskInput(p.prompt)}>
                    {p.label}
                  </button>
                </Tooltip>
              ))}
            </div>
          )}
          <button className="panel-ask-send" onClick={handleAsk} disabled={!askInput.trim()} title="Ask">
            <Send size={14} />
          </button>
        </div>
      )}

      {error && (
        <div className="github-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showAddRepo && (
        <div className="github-add-repo">
          <input
            autoFocus
            placeholder="owner/name or GitHub URL"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddRepo()
              if (e.key === 'Escape') { setShowAddRepo(false); setRepoInput('') }
            }}
          />
          <button onClick={handleAddRepo} title="Add repository">Add</button>
          <button onClick={() => { setShowAddRepo(false); setRepoInput('') }} title="Cancel">Cancel</button>
        </div>
      )}

      {repos.length === 0 && !showAddRepo && (
        <EmptyStateHook
          icon={GitPullRequest}
          title="Pull Requests"
          hook="No repos connected. Track pull requests from your GitHub repositories."
          keyCap="G"
          cta={{ label: 'Add Repository', onClick: () => setShowAddRepo(true) }}
        />
      )}

      {/* Filters */}
      {allPRs.length > 0 && (
        <div className="github-filters">
          <div className="github-filters-search">
            <Search size={12} />
            <input
              placeholder="Search PRs, comments..."
              value={filterText}
              onChange={(e) => setFilterText(e.target.value)}
            />
            <button
              className={`github-filters-toggle ${showFilters ? 'active' : ''} ${hasActiveFilters ? 'has-filters' : ''}`}
              onClick={() => setShowFilters(!showFilters)}
              title="Filters"
            >
              <Filter size={12} />
              {hasActiveFilters && <span className="github-filters-badge" />}
            </button>
            {hasActiveFilters && (
              <button className="github-filters-clear" onClick={clearFilters} title="Clear filters">Clear</button>
            )}
          </div>
          {showFilters && (
            <div className="github-filters-row">
              <div className="github-filter-group">
                <label>Status</label>
                <div className="github-filter-chips">
                  {['open', 'draft'].map((s) => (
                    <button
                      key={s}
                      className={`github-filter-chip ${filterStatus.includes(s) ? 'active' : ''}`}
                      onClick={() => setFilterStatus((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s])}
                      title={`Filter by ${s}`}
                    >{s}</button>
                  ))}
                </div>
              </div>
              {allAuthors.length > 1 && (
                <div className="github-filter-group">
                  <label>Author</label>
                  <div className="github-filter-chips">
                    {allAuthors.map((a) => (
                      <button
                        key={a}
                        className={`github-filter-chip ${filterAuthors.includes(a) ? 'active' : ''}`}
                        onClick={() => setFilterAuthors((prev) => prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a])}
                        title={`Filter by ${a}`}
                      >{a}</button>
                    ))}
                  </div>
                </div>
              )}
              {allReviewersList.length > 0 && (
                <div className="github-filter-group">
                  <label>Reviewer</label>
                  <div className="github-filter-chips">
                    {allReviewersList.map((r) => (
                      <button
                        key={r}
                        className={`github-filter-chip ${filterReviewers.includes(r) ? 'active' : ''}`}
                        onClick={() => setFilterReviewers((prev) => prev.includes(r) ? prev.filter((x) => x !== r) : [...prev, r])}
                        title={`Filter by ${r}`}
                      >{r}</button>
                    ))}
                  </div>
                </div>
              )}
              {allBaseBranches.length > 1 && (
                <div className="github-filter-group">
                  <label>Base Branch</label>
                  <div className="github-filter-chips">
                    {allBaseBranches.map((b) => (
                      <button
                        key={b}
                        className={`github-filter-chip ${filterBaseBranch.includes(b) ? 'active' : ''}`}
                        onClick={() => setFilterBaseBranch((prev) => prev.includes(b) ? prev.filter((x) => x !== b) : [...prev, b])}
                        title={`Filter by base branch ${b}`}
                      >{b}</button>
                    ))}
                  </div>
                </div>
              )}
              {allLabels.length > 0 && (
                <div className="github-filter-group">
                  <label>Labels</label>
                  <div className="github-filter-chips">
                    {allLabels.map((l) => (
                      <button
                        key={l}
                        className={`github-filter-chip ${filterLabels.includes(l) ? 'active' : ''}`}
                        onClick={() => setFilterLabels((prev) => prev.includes(l) ? prev.filter((x) => x !== l) : [...prev, l])}
                        title={`Filter by ${l}`}
                      >{l}</button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {ghUser && attentionPRs.length > 0 && (
        <div className="github-attention-section">
          <div className="github-attention-header">
            <AlertCircle size={12} /> Needs Your Attention
          </div>
          {attentionPRs.map(({ pr, slug, prKey, reason }) => (
            <div
              key={prKey}
              className="github-attention-row"
              onClick={() => { setExpandedRepo(slug); setExpandedPR(prKey) }}
            >
              <span className="github-attention-repo">{slug}#{pr.number}</span>
              <span className="github-attention-title">{pr.title}</span>
              <span className="github-attention-reason">{reason}</span>
            </div>
          ))}
          <div className="github-attention-actions">
            <button className="panel-ask-chip" onClick={() => handleAsk('Look at the PRs that need my attention (review-requested, assigned, or failing CI) and give me a brief status summary for each: what\'s blocking, what needs my action, and what\'s close to merging.')}>
              Summarize status
            </button>
            {attentionPRs.some(a => a.reason === 'Your PR has failing CI') && (
              <button className="panel-ask-chip" onClick={() => handleAsk('Look at my PRs with failing CI checks and diagnose the failures. For each failing PR, tell me what\'s broken and suggest a fix.')}>
                Fix failing CI
              </button>
            )}
            {attentionPRs.some(a => a.reason === 'Review requested') && (
              <button className="panel-ask-chip" onClick={() => handleAsk('For each PR where my review is requested, read the diff and comments, then draft review notes I can use — highlight concerns, questions, and whether it\'s ready to approve.')}>
                Draft review notes
              </button>
            )}
          </div>
        </div>
      )}

      <div className="github-repos">
        {repos.map((repo) => {
          const slug = `${repo.owner}/${repo.name}`
          const isExpanded = expandedRepo === slug
          const allRepoPRs = prsByRepo[slug] || []
          const prs = allRepoPRs.filter(filterPR)
          const isLoading = loadingRepo === slug

          return (
            <div key={slug} className="github-repo">
              <div className="github-repo-header" onClick={() => handleToggleRepo(repo)}>
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="github-repo-name"><span className="github-repo-owner">{repo.owner}/</span>{repo.name}</span>
                {allRepoPRs.length > 0 && (
                  <span className="github-repo-count">
                    {hasActiveFilters && prs.length !== allRepoPRs.length ? `${prs.length}/` : ''}{allRepoPRs.length}
                  </span>
                )}
                {(repo as any).cloned ? (
                  <span className="github-repo-path" title={repo.localPath || ''}>
                    {(repo.localPath || '').split('/').pop()}
                  </span>
                ) : cloningRepo === slug ? (
                  <span className="github-repo-cloning">cloning...</span>
                ) : (
                  <span className="github-repo-not-cloned">not cloned</span>
                )}
                <div className="github-repo-actions" onClick={(e) => e.stopPropagation()}>
                  {(!(repo as any).cloned || cloningRepo === slug) && (
                    <Tooltip text={cloningRepo === slug ? 'Cloning...' : 'Clone'} detail={cloningRepo === slug ? 'Shallow clone in progress' : 'Shallow clone this repo for template agents and environment setup'}>
                      <button
                        disabled={cloningRepo === slug}
                        className={cloningRepo === slug ? 'cloning' : ''}
                        onClick={async () => {
                          if (cloningRepo) return
                          setCloningRepo(slug)
                          try {
                            await window.api.github.cloneRepo(repo)
                            setRepos(await window.api.github.getRepos())
                          } catch (err: any) {
                            console.error('Clone failed:', err)
                          } finally {
                            setCloningRepo(null)
                          }
                        }}>
                        {cloningRepo === slug ? <Loader size={13} className="spinning" /> : <Download size={13} />}
                      </button>
                    </Tooltip>
                  )}
                  <Tooltip text="Refresh PRs" detail="Re-fetch open PRs, comments, CI status, feedback, and .colony/ templates">
                    <button onClick={() => fetchPRsForRepo(repo)}>
                      <RefreshCw size={13} className={isLoading ? 'spinning' : ''} />
                    </button>
                  </Tooltip>
                  <Tooltip text="Remove Repository" detail="Scan for references then confirm removal">
                    <button
                      className="danger"
                      onClick={() => handleRemoveRepo(repo)}
                      disabled={scanningRemoval}
                      title={scanningRemoval ? 'Scanning…' : 'Remove repository'}
                    >
                      {scanningRemoval && removalTarget?.owner === repo.owner && removalTarget?.name === repo.name
                        ? <RefreshCw size={13} className="spinning" />
                        : <Trash2 size={13} />}
                    </button>
                  </Tooltip>
                </div>
              </div>

              {isExpanded && (
                <div className="github-pr-list">
                  {isLoading && prs.length === 0 && (
                    <div className="github-pr-loading">Loading PRs...</div>
                  )}
                  {!isLoading && prs.length === 0 && (
                    <div className="github-pr-empty">No open PRs</div>
                  )}
                  {prs.map((pr) => {
                    const prKey = `${slug}#${pr.number}`
                    const isOpen = expandedPR === prKey
                    return (
                      <div key={pr.number} className="github-pr-item">
                        <div className="github-pr-row" onClick={() => setExpandedPR(isOpen ? null : prKey)}>
                          <span className="github-pr-number">
                            #{pr.number}
                            {(() => {
                              const days = prAgeDays(pr)
                              const cls = days <= 3 ? '' : days <= 7 ? ' amber' : ' red'
                              return <span className={`github-pr-age${cls}`} title={`Opened ${new Date(pr.createdAt).toLocaleDateString()}`}>{days}d</span>
                            })()}
                          </span>
                          <div className="github-pr-info">
                            <div className="github-pr-title">
                              {pr.draft && <span className="github-pr-draft">draft</span>}
                              {pr.title}
                            </div>
                            <div className="github-pr-meta">
                              <span title="Author"><User size={11} /> {pr.author}</span>
                              {pr.assignees?.length > 0 && <span className="github-pr-assignees" title="Assignees"><Users size={11} /> {pr.assignees.join(', ')}</span>}
                              {pr.reviewers?.length > 0 && <span className="github-pr-reviewers" title="Reviewers"><Eye size={11} /> {pr.reviewers.join(', ')}</span>}
                              <span title="Branch"><GitBranch size={11} /> {pr.branch}</span>
                              <span className="github-pr-diff" title="Changes"><FileDiff size={11} /> +{pr.additions} -{pr.deletions}</span>
                              <span title="Updated"><Clock size={11} /> {timeSince(pr.updatedAt)}</span>
                              {pr.reviewDecision && (
                                <span style={{ color: reviewColor(pr.reviewDecision) }} title="Review status">
                                  {pr.reviewDecision === 'APPROVED' && <ShieldCheck size={11} />}
                                  {pr.reviewDecision === 'CHANGES_REQUESTED' && <ShieldAlert size={11} />}
                                  {pr.reviewDecision !== 'APPROVED' && pr.reviewDecision !== 'CHANGES_REQUESTED' && <ShieldQuestion size={11} />}
                                  {' '}{pr.reviewDecision.toLowerCase().replace(/_/g, ' ')}
                                </span>
                              )}
                              {pr.comments?.length > 0 && (
                                <span
                                  className="github-pr-comment-count clickable"
                                  title={`${pr.comments.length} comment${pr.comments.length !== 1 ? 's' : ''} — click to view`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setCommentsViewerPR(pr)
                                    setCommentsViewerSlug(slug)
                                    setCommentsViewerIndex(0)
                                    setShowCommentsViewer(true)
                                  }}
                                >
                                  <MessageSquare size={11} /> {pr.comments.length}
                                </span>
                              )}
                              {/* CI/CD status badge */}
                              {(() => {
                                const checks = checksByPR[prKey]
                                const loading = checksLoading.has(prKey)
                                if (loading) return <span className="github-pr-ci loading" title="Loading checks..."><Loader size={11} /> CI</span>
                                if (!checks || checks.overall === 'none') return null
                                if (checks.overall === 'success') return <span className="github-pr-ci success" title="All checks passed"><CheckCircle size={11} /> CI</span>
                                if (checks.overall === 'failure') return (
                                  <span
                                    className="github-pr-ci failure clickable"
                                    title="Checks failed — click to see details"
                                    onClick={(e) => { e.stopPropagation(); setExpandedPR(isOpen ? null : prKey) }}
                                  >
                                    <XCircle size={11} /> CI
                                  </span>
                                )
                                return <span className="github-pr-ci pending" title="Checks in progress"><CircleDot size={11} /> CI</span>
                              })()}
                              {/* Merge readiness badge */}
                              {checksByPR[prKey] && !pr.draft && pr.reviewDecision === 'APPROVED' && checksByPR[prKey].overall === 'success' && (
                                <span className="github-pr-merge-ready" title="Ready to merge">
                                  <CheckCircle size={11} /> Ready
                                </span>
                              )}
                              {checksByPR[prKey] && pr.reviewDecision === 'CHANGES_REQUESTED' && (
                                <span className="github-pr-merge-blocked" title="Changes requested — not mergeable">
                                  <X size={11} /> Blocked
                                </span>
                              )}
                              {/* Attention badges */}
                              {ghUser && pr.reviewers.includes(ghUser) && (
                                <span className="github-pr-attention review-requested" title="Your review is requested">
                                  <Eye size={11} /> Review requested
                                </span>
                              )}
                              {ghUser && pr.assignees.includes(ghUser) && !pr.reviewers.includes(ghUser) && (
                                <span className="github-pr-attention assigned" title="You are assigned">
                                  <User size={11} /> Assigned
                                </span>
                              )}
                              {/* Feedback badge */}
                              {(() => {
                                const feedback = feedbackByPR[prKey]
                                if (!feedback || feedback.length === 0) return null
                                const latest = feedback.reduce((a, b) => a.createdAt > b.createdAt ? a : b)
                                const addressed = latest.headSha !== pr.headSha
                                return (
                                  <span
                                    className={`github-pr-feedback ${addressed ? 'addressed' : 'pending'}`}
                                    title={addressed ? 'New commits since last review — ready for re-review' : `Feedback from ${latest.reviewer} — not yet addressed`}
                                  >
                                    <MessageSquare size={11} /> {addressed ? 'Re-review' : 'Feedback'}
                                  </span>
                                )
                              })()}
                            </div>
                          </div>
                          {personaList.filter(p => p.enabled).length > 0 && (
                            <button
                              className={`github-pr-dispatch${dispatchingPRKey === prKey ? ' active' : ''}`}
                              title="Dispatch to persona"
                              onClick={(e) => {
                                e.stopPropagation()
                                if (dispatchingPRKey === prKey) {
                                  setDispatchingPRKey(null)
                                } else {
                                  setDispatchingPRKey(prKey)
                                  setDispatchPersonaId(personaList.filter(p => p.enabled)[0]?.id ?? '')
                                  setDispatchContext('')
                                }
                              }}
                            >
                              <UserPlus size={12} />
                            </button>
                          )}
                          <button
                            className="github-pr-link"
                            title="Open on GitHub"
                            onClick={(e) => { e.stopPropagation(); window.api.shell.openExternal(pr.url) }}
                          >
                            <ExternalLink size={13} />
                          </button>
                        </div>
                        {dispatchingPRKey === prKey && (
                          <div className="github-dispatch-popover" onClick={(e) => e.stopPropagation()}>
                            <div className="github-dispatch-header">
                              <UserPlus size={11} /> Dispatch to persona
                              <button className="github-dispatch-close" onClick={() => setDispatchingPRKey(null)} title="Close"><X size={12} /></button>
                            </div>
                            <div className="github-dispatch-personas">
                              {personaList.filter(p => p.enabled).map(p => (
                                <label key={p.id} className={`github-dispatch-persona-row${dispatchPersonaId === p.id ? ' selected' : ''}`}>
                                  <input
                                    type="radio"
                                    name="dispatch-persona"
                                    value={p.id}
                                    checked={dispatchPersonaId === p.id}
                                    onChange={() => setDispatchPersonaId(p.id)}
                                  />
                                  <span className="github-dispatch-persona-name">{p.name}</span>
                                  <span className="github-dispatch-persona-model">{p.model.includes('-') ? p.model.split('-').slice(1, 3).join('-') : p.model}</span>
                                </label>
                              ))}
                            </div>
                            <textarea
                              className="github-dispatch-context"
                              placeholder="Optional context for the persona..."
                              value={dispatchContext}
                              onChange={(e) => setDispatchContext(e.target.value)}
                              rows={2}
                            />
                            <div className="github-dispatch-actions">
                              <button
                                className="panel-header-btn primary"
                                disabled={!dispatchPersonaId}
                                onClick={() => handleDispatch(pr, repo)}
                              >
                                Dispatch
                              </button>
                              <button className="panel-header-btn" onClick={() => setDispatchingPRKey(null)}>Cancel</button>
                            </div>
                          </div>
                        )}
                        {isOpen && (
                          <div className="github-pr-actions">
                            {pr.body && (
                              <MarkdownViewer
                                content={pr.body}
                                className="github-pr-body"
                                preprocessor={(md) => preprocessGitHubUrls(md, slug, pr.branch || 'main')}
                              />
                            )}
                            {pr.additions + pr.deletions > 0 && (
                              <div className="github-pr-diff-stats">
                                <span className="additions">+{pr.additions}</span>
                                {' / '}
                                <span className="deletions">−{pr.deletions}</span>
                                {' lines'}
                              </div>
                            )}
                            {pr.labels?.length > 0 && (
                              <div className="github-pr-labels">
                                {pr.labels.map((l) => (
                                  <span key={l} className="github-pr-label">{l}</span>
                                ))}
                              </div>
                            )}
                            {pr.comments?.length > 0 && (
                              <button
                                className="github-pr-view-comments"
                                onClick={() => {
                                  setCommentsViewerPR(pr)
                                  setCommentsViewerIndex(0)
                                  setShowCommentsViewer(true)
                                }}
                                title="View comments"
                              >
                                <MessageSquare size={12} /> View {pr.comments.length} comment{pr.comments.length !== 1 ? 's' : ''}
                              </button>
                            )}
                            {/* CI/CD Check Details */}
                            {checksByPR[prKey] && checksByPR[prKey].checks.length > 0 && (
                              <div className="github-pr-checks">
                                <div className="github-pr-checks-header">
                                  CI/CD Checks
                                  <button
                                    className="github-pr-checks-refresh"
                                    onClick={() => fetchChecksForPR(repo, pr)}
                                    title="Refresh checks"
                                  >
                                    <RefreshCw size={11} />
                                  </button>
                                </div>
                                {checksByPR[prKey].checks.map((check) => (
                                  <div key={check.name} className={`github-pr-check-item ${check.conclusion || 'pending'}`}>
                                    <span className="github-pr-check-icon">
                                      {check.conclusion === 'success' && <CheckCircle size={12} />}
                                      {check.conclusion === 'failure' && <XCircle size={12} />}
                                      {check.conclusion === 'skipped' && <CircleDot size={12} />}
                                      {!check.conclusion && <Loader size={12} />}
                                      {check.conclusion && check.conclusion !== 'success' && check.conclusion !== 'failure' && check.conclusion !== 'skipped' && <CircleDot size={12} />}
                                    </span>
                                    <span className="github-pr-check-name">{check.name}</span>
                                    <span className="github-pr-check-status">{check.conclusion || check.status}</span>
                                    {check.url && (
                                      <button
                                        className="github-pr-check-link"
                                        onClick={() => window.api.shell.openExternal(check.url)}
                                        title="Open in browser"
                                      >
                                        <ExternalLink size={10} />
                                      </button>
                                    )}
                                    {check.conclusion === 'failure' && (
                                      <button
                                        className="github-pr-check-logs"
                                        onClick={async () => {
                                          setCheckLogName(check.name)
                                          setCheckLogContent('Loading...')
                                          const logs = await window.api.github.fetchCheckLogs(repo, pr.number, check.name)
                                          setCheckLogContent(logs)
                                        }}
                                        title="View failure details"
                                      >
                                        <FileText size={10} />
                                      </button>
                                    )}
                                  </div>
                                ))}
                                {checksByPR[prKey].overall === 'failure' && (
                                  <button
                                    className="github-action-btn fix-ci-btn"
                                    onClick={async () => {
                                      const failedNames = checksByPR[prKey].checks
                                        .filter((c) => c.conclusion === 'failure')
                                        .map((c) => c.name)
                                        .join(', ')
                                      const prompt = `PR #${pr.number} on branch ${pr.branch} has failing CI checks: ${failedNames}. Investigate the failures, check out the branch, and fix the issues. Run the checks locally to verify your fix before committing.`
                                      const id = await onLaunchInstance({
                                        name: `Fix CI: ${repo.name}#${pr.number}`,
                                        workingDirectory: repo.localPath || undefined,
                                      })
                                      sendPromptToInstance(id, prompt, `Fix CI: ${repo.name}#${pr.number}`)
                                    }}
                                    title="Launch a Claude session to fix failing checks"
                                  >
                                    <Wrench size={12} /> Fix Failing Checks
                                  </button>
                                )}
                              </div>
                            )}

                            <div className="github-pr-quick-actions">
                              {prompts.filter((p) => !p.scope || p.scope === 'pr').map((prompt) => (
                                <Tooltip key={prompt.id} text={prompt.label} detail={prompt.prompt.replace(/\{\{pr\.\w+\}\}/g, (m) => {
                                  const key = m.slice(2, -2).split('.')[1] as keyof typeof pr
                                  return String((pr as any)[key] || m)
                                }).slice(0, 150)} position="top">
                                  <button
                                    className="github-action-btn"
                                    onClick={() => handleQuickAction(prompt, pr, repo)}
                                  >
                                    <Play size={12} />
                                    {prompt.label}
                                </button>
                                </Tooltip>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Memory modal */}
      {showMemory && (
        <div className="dialog-overlay" onClick={() => { setShowMemory(false); setEditingMemory(false) }}>
          <div className="github-context-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="github-context-viewer-header">
              <h3>PR Memory</h3>
              <span className="github-context-viewer-path">Persistent context across PR sessions</span>
              {!editingMemory && (
                <button onClick={() => { setMemoryDraft(memory); setEditingMemory(true) }} title="Edit">
                  <Pencil size={13} />
                </button>
              )}
              <button onClick={() => { setShowMemory(false); setEditingMemory(false) }} title="Close"><X size={14} /></button>
            </div>
            {editingMemory ? (
              <div className="github-memory-edit-area">
                <textarea
                  className="github-memory-editor"
                  value={memoryDraft}
                  onChange={(e) => setMemoryDraft(e.target.value)}
                  rows={16}
                />
                <div className="github-memory-actions">
                  <button className="github-prompt-save" title="Save memory" onClick={() => {
                    window.api.github.savePrMemory(memoryDraft).then((ok) => {
                      if (ok) setMemory(memoryDraft)
                      setEditingMemory(false)
                    })
                  }}>Save</button>
                  <button onClick={() => setEditingMemory(false)} title="Cancel editing">Cancel</button>
                </div>
              </div>
            ) : (
              <pre className="github-context-viewer-content">{memory || 'No memories yet. PR conversations will save important context here.'}</pre>
            )}
          </div>
        </div>
      )}

      {/* Ask bar moved to top — below header */}

      {/* Comments viewer */}
      {showCommentsViewer && commentsViewerPR && (() => {
        // Sort newest first
        const sorted = [...commentsViewerPR.comments].sort((a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        )
        const general = sorted.filter((c) => !c.path)
        const fileComments = sorted.filter((c) => c.path)
        const byFile = fileComments.reduce<Record<string, typeof fileComments>>((acc, c) => {
          const key = c.path!
          if (!acc[key]) acc[key] = []
          acc[key].push(c)
          return acc
        }, {})
        const allGroups = [
          ...(general.length > 0 ? [{ label: 'General', icon: 'general' as const, comments: general }] : []),
          ...Object.entries(byFile).map(([path, comments]) => ({
            label: path.split('/').pop()!,
            fullPath: path,
            icon: 'file' as const,
            comments,
          })),
        ]
        const activeComment = sorted[commentsViewerIndex]

        return (
          <div className="dialog-overlay" onClick={() => setShowCommentsViewer(false)}>
            <div className="github-comments-modal" onClick={(e) => e.stopPropagation()}>
              <div className="github-comments-modal-header">
                <h3>#{commentsViewerPR.number}</h3>
                <span className="github-comments-modal-title">{commentsViewerPR.title}</span>
                <span className="github-comments-modal-count">{commentsViewerPR.comments.length} comments</span>
                <button onClick={() => setShowCommentsViewer(false)} title="Close"><X size={14} /></button>
              </div>
              <div className="github-comments-modal-split">
                <div className="github-comments-sidebar">
                  {allGroups.map((group) => (
                    <div key={group.label} className="github-comments-group">
                      <div className="github-comments-group-header">
                        {group.icon === 'general' ? <MessageSquare size={12} /> : <File size={12} />}
                        <span title={'fullPath' in group ? group.fullPath : undefined}>{group.label}</span>
                        <span className="github-comments-group-count">{group.comments.length}</span>
                      </div>
                      {group.comments.map((c, i) => {
                        const globalIdx = sorted.indexOf(c)
                        return (
                          <button
                            key={i}
                            className={`github-comments-sidebar-item ${globalIdx === commentsViewerIndex ? 'active' : ''}`}
                            onClick={() => setCommentsViewerIndex(globalIdx)}
                            title={`Comment by ${c.author}`}
                          >
                            <div className="github-comments-sidebar-top">
                              <span className="github-comments-sidebar-author">{c.author}</span>
                              <span className="github-comments-sidebar-time">{timeSince(c.createdAt)}</span>
                            </div>
                            <div className="github-comments-sidebar-preview">
                              {c.body.replace(/<[^>]+>/g, '').replace(/[#*`>\-|]/g, '').trim().slice(0, 80)}
                            </div>
                          </button>
                        )
                      })}
                    </div>
                  ))}
                </div>
                <div className="github-comments-content">
                  {activeComment && (
                    <>
                      <div className="github-comments-content-meta">
                        <strong>{activeComment.author}</strong>
                        <span>{new Date(activeComment.createdAt).toLocaleString()}</span>
                        {activeComment.path && <span className="github-comments-content-path">{activeComment.path}</span>}
                      </div>
                      <MarkdownViewer
                        content={activeComment.body}
                        className="github-comments-content-body"
                        preprocessor={(md) => preprocessGitHubUrls(md, commentsViewerSlug, commentsViewerPR!.branch || 'main')}
                      />
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Context file viewer */}
      {showContextFile && (
        <div className="dialog-overlay" onClick={() => setShowContextFile(false)}>
          <div className="github-context-viewer" onClick={(e) => e.stopPropagation()}>
            <div className="github-context-viewer-header">
              <h3>PR Context File</h3>
              <span className="github-context-viewer-path">{contextPath}</span>
              <button onClick={() => setShowContextFile(false)} title="Close"><X size={14} /></button>
            </div>
            <div className="github-context-disclaimer">
              This file is auto-generated when PRs are fetched. Use the refresh button on each repository to update. CLI sessions reference this file for PR context.
            </div>
            <pre className="github-context-viewer-content">{contextFileContent}</pre>
          </div>
        </div>
      )}

      {/* Prompt editor overlay */}
      {showPromptEditor && (
        <div className="dialog-overlay" onClick={() => setShowPromptEditor(false)}>
          <div className="github-prompt-editor" onClick={(e) => e.stopPropagation()}>
            <div className="github-prompt-editor-header">
              <span className="github-prompt-editor-title">
                <MessageSquare size={14} />
                Prompts
              </span>
              <button onClick={() => setShowPromptEditor(false)} title="Close"><X size={14} /></button>
            </div>
            <div className="github-prompt-vars">
              <span className="github-prompt-vars-label">Per PR variables</span>
              {['{{pr.number}}','{{pr.title}}','{{pr.description}}','{{pr.branch}}','{{pr.url}}','{{pr.author}}','{{pr.status}}','{{pr.reviewDecision}}','{{pr.assignees}}','{{pr.reviewers}}','{{pr.labels}}','{{pr.additions}}','{{pr.deletions}}','{{repo.owner}}','{{repo.name}}'].map(v => (
                <code key={v} className="github-prompt-var-chip">{v}</code>
              ))}
            </div>
            <div className="github-prompt-list">
              {editingPrompts.map((p) => (
                <div key={p.id} className={`github-prompt-item ${p.scope === 'global' ? 'is-global' : ''}`}>
                  <div className="github-prompt-item-header">
                    <input
                      placeholder="Label"
                      value={p.label}
                      onChange={(e) => handleUpdatePrompt(p.id, 'label', e.target.value)}
                    />
                    <div className="github-prompt-scope-toggle">
                      <button
                        className={p.scope !== 'global' ? 'active' : ''}
                        onClick={() => setEditingPrompts(editingPrompts.map((ep) =>
                          ep.id === p.id ? { ...ep, scope: 'pr' as const } : ep
                        ))}
                        title="Per-PR scope"
                      >Per PR</button>
                      <button
                        className={p.scope === 'global' ? 'active' : ''}
                        onClick={() => setEditingPrompts(editingPrompts.map((ep) =>
                          ep.id === p.id ? { ...ep, scope: 'global' as const } : ep
                        ))}
                        title="Global scope — runs across all PRs in the ask bar"
                      >Global</button>
                    </div>
                    <button className="github-prompt-delete" onClick={() => handleRemovePrompt(p.id)} title="Remove prompt">
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <textarea
                    placeholder={p.scope === 'global' ? 'Question to ask about all PRs...' : 'Prompt template — use {{pr.number}}, {{pr.title}}, {{repo.name}}...'}
                    value={p.prompt}
                    onChange={(e) => handleUpdatePrompt(p.id, 'prompt', e.target.value)}
                    rows={2}
                  />
                </div>
              ))}
            </div>
            <div className="github-prompt-actions">
              <button className="github-prompt-add" onClick={handleAddPrompt} title="Add prompt">
                <Plus size={13} /> Add prompt
              </button>
              <button className="github-prompt-save" onClick={handleSavePrompts}>Save</button>
            </div>
          </div>
        </div>
      )}

      {/* Repo removal impact modal */}
      {removalTarget && removalImpact && (
        <RepoRemovalModal
          repo={removalTarget}
          impact={removalImpact}
          onConfirm={confirmRemoveRepo}
          onCancel={() => { setRemovalTarget(null); setRemovalImpact(null) }}
          onLaunchSession={handleRemovalLaunchSession}
        />
      )}

      {/* Dispatch toast */}
      {dispatchToast && (
        <div className="github-dispatch-toast">
          <CheckCircle size={12} /> {dispatchToast}
        </div>
      )}

      {/* Check log viewer */}
      {checkLogContent && (
        <div className="dialog-overlay" onClick={() => { setCheckLogContent(null); setCheckLogName(null) }}>
          <div className="dialog" style={{ width: 560, maxHeight: '70vh' }} onClick={(e) => e.stopPropagation()}>
            <h2>Check: {checkLogName || 'Logs'}</h2>
            <pre className="github-check-log-content">{checkLogContent}</pre>
            <div className="dialog-actions">
              <button className="cancel" onClick={() => { setCheckLogContent(null); setCheckLogName(null) }}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Prompt Environment Selector modal */}
      {showEnvSelector && pendingPromptAction && (
        <PromptEnvironmentSelector
          instances={instances}
          promptLabel={pendingPromptAction.prompt.label}
          repoName={pendingPromptAction.repo.name}
          prNumber={pendingPromptAction.pr.number}
          onCancel={() => {
            setShowEnvSelector(false)
            setPendingPromptAction(null)
          }}
          onSelect={handleEnvSelectorCreate}
          onSelectReuse={handleEnvSelectorReuse}
        />
      )}
    </div>
  )
}
