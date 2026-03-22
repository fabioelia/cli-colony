import { useState, useEffect } from 'react'
import { ArrowLeft, Plus, Trash2, RefreshCw, GitPullRequest, ExternalLink, Play, FolderOpen, Pencil, ChevronDown, ChevronRight, MessageSquare, Send, User, Users, Eye, GitBranch, Clock, FileDiff, ShieldCheck, ShieldAlert, ShieldQuestion, Brain, Save, X } from 'lucide-react'
import type { GitHubPR, GitHubRepo, QuickPrompt } from '../types'

interface Props {
  onBack: () => void
  onLaunchInstance: (opts: { name?: string; workingDirectory?: string; args?: string[] }) => Promise<string> // returns instance id
  onFocusInstance: (id: string) => void
  instances: Array<{ id: string; status: string }>
}

export default function GitHubPanel({ onBack, onLaunchInstance, onFocusInstance, instances }: Props) {
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [prompts, setPrompts] = useState<QuickPrompt[]>([])
  const [ghAuth, setGhAuth] = useState<boolean | null>(null)
  const [prsByRepo, setPrsByRepo] = useState<Record<string, GitHubPR[]>>({})
  const [loadingRepo, setLoadingRepo] = useState<string | null>(null)
  const [expandedRepo, setExpandedRepo] = useState<string | null>(null)
  const [expandedPR, setExpandedPR] = useState<string | null>(null) // "owner/name#number"
  const [error, setError] = useState<string | null>(null)

  // Add repo form
  const [showAddRepo, setShowAddRepo] = useState(false)
  const [repoInput, setRepoInput] = useState('')

  // Prompt editor
  const [showPromptEditor, setShowPromptEditor] = useState(false)
  const [editingPrompts, setEditingPrompts] = useState<QuickPrompt[]>([])

  // Ask bar — persistent PR assistant instance
  const [askInput, setAskInput] = useState('')
  const [assistantId, setAssistantId] = useState<string | null>(null)

  // PR Memory
  const [memory, setMemory] = useState('')
  const [memoryPath, setMemoryPath] = useState<string | null>(null)
  const [showMemory, setShowMemory] = useState(false)
  const [editingMemory, setEditingMemory] = useState(false)
  const [memoryDraft, setMemoryDraft] = useState('')

  // Sync PR context file whenever prsByRepo changes
  const [contextPath, setContextPath] = useState<string | null>(null)
  const hasPrs = Object.values(prsByRepo).some((prs) => prs.length > 0)

  useEffect(() => {
    if (!hasPrs) return
    window.api.github.writePrContext(prsByRepo).then(setContextPath)
  }, [prsByRepo, hasPrs])

  // Clear assistant ID if the instance was killed/removed
  useEffect(() => {
    if (assistantId && !instances.some((i) => i.id === assistantId)) {
      setAssistantId(null)
    }
  }, [instances, assistantId])

  const handleAsk = async () => {
    const q = askInput.trim()
    if (!q || !contextPath) return
    setAskInput('')

    // If we have a living assistant, just send the follow-up
    if (assistantId && instances.some((i) => i.id === assistantId && i.status === 'running')) {
      await window.api.instance.write(assistantId, q + '\n')
      onFocusInstance(assistantId)
      return
    }

    // First question — create a new interactive instance in the PR workspace
    const id = await onLaunchInstance({
      name: 'PR Assistant',
      workingDirectory: workspacePath || undefined,
    })
    setAssistantId(id)
    const prompt = `Read the file ${contextPath} which contains all open PRs across my repositories, then answer this question: ${q}${memoryInstructions}`
    sendPromptWhenReady(id, prompt)
  }

  const [workspacePath, setWorkspacePath] = useState<string | null>(null)

  useEffect(() => {
    window.api.github.authStatus().then(setGhAuth)
    window.api.github.getRepos().then(setRepos)
    window.api.github.getPrompts().then(setPrompts)
    window.api.github.getPrMemory().then(setMemory)
    window.api.github.getPrMemoryPath().then(setMemoryPath)
    window.api.github.getPrWorkspacePath().then(setWorkspacePath)
  }, [])

  // Auto-expand first repo and fetch its PRs
  useEffect(() => {
    if (repos.length > 0 && !expandedRepo) {
      const slug = `${repos[0].owner}/${repos[0].name}`
      setExpandedRepo(slug)
      fetchPRsForRepo(repos[0])
    }
  }, [repos])

  const fetchPRsForRepo = async (repo: GitHubRepo) => {
    const slug = `${repo.owner}/${repo.name}`
    setLoadingRepo(slug)
    setError(null)
    try {
      const prs = await window.api.github.fetchPRs(repo)
      setPrsByRepo((prev) => ({ ...prev, [slug]: prs }))
    } catch (err: any) {
      setError(`Failed to fetch PRs for ${slug}: ${err.message}`)
    } finally {
      setLoadingRepo(null)
    }
  }

  const handleAddRepo = async () => {
    const parts = repoInput.trim().split('/')
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      setError('Enter repo as owner/name (e.g. facebook/react)')
      return
    }
    const [owner, name] = parts
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
    const updated = await window.api.github.removeRepo(repo.owner, repo.name)
    setRepos(updated)
    const slug = `${repo.owner}/${repo.name}`
    setPrsByRepo((prev) => {
      const next = { ...prev }
      delete next[slug]
      return next
    })
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

  const sendPromptWhenReady = (id: string, prompt: string) => {
    // Listen for activity changes — send prompt once Claude is waiting for input
    let sent = false
    const unsub = window.api.instance.onActivity(({ id: instId, activity }) => {
      if (instId === id && activity === 'waiting' && !sent) {
        sent = true
        unsub()
        // Auto-answer trust prompt (Enter to confirm), then send actual prompt
        window.api.instance.write(id, '\n')
        setTimeout(() => {
          window.api.instance.write(id, prompt + '\n')
        }, 500)
      }
    })
    // Safety timeout — clean up listener after 15s
    setTimeout(() => { if (!sent) unsub() }, 15000)
  }

  const handleQuickAction = async (prompt: QuickPrompt, pr: GitHubPR, repo: GitHubRepo) => {
    const resolved = await window.api.github.resolvePrompt(prompt, pr, repo)
    const id = await onLaunchInstance({
      name: `${prompt.label}: ${repo.name}#${pr.number}`,
      workingDirectory: repo.localPath || workspacePath || undefined,
    })
    sendPromptWhenReady(id, resolved + memoryInstructions)
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
        <div className="settings-header">
          <button className="settings-back" onClick={onBack}><ArrowLeft size={16} /></button>
          <h2>GitHub</h2>
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
      <div className="settings-header">
        <button className="settings-back" onClick={onBack}><ArrowLeft size={16} /></button>
        <h2>GitHub</h2>
        <div className="github-header-actions">
          <button className="github-header-btn" onClick={handleOpenPromptEditor} title="Edit quick prompts">
            <Pencil size={13} /> Prompts
          </button>
          <button className="github-header-btn" onClick={() => setShowAddRepo(true)} title="Add repository">
            <Plus size={13} /> Add Repo
          </button>
        </div>
      </div>

      {error && (
        <div className="github-error" onClick={() => setError(null)}>
          {error}
        </div>
      )}

      {showAddRepo && (
        <div className="github-add-repo">
          <input
            autoFocus
            placeholder="owner/name (e.g. facebook/react)"
            value={repoInput}
            onChange={(e) => setRepoInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAddRepo()
              if (e.key === 'Escape') { setShowAddRepo(false); setRepoInput('') }
            }}
          />
          <button onClick={handleAddRepo}>Add</button>
          <button onClick={() => { setShowAddRepo(false); setRepoInput('') }}>Cancel</button>
        </div>
      )}

      {repos.length === 0 && !showAddRepo && (
        <div className="github-empty">
          <GitPullRequest size={24} />
          <p>No repositories configured.</p>
          <button className="github-empty-btn" onClick={() => setShowAddRepo(true)}>
            <Plus size={14} /> Add a Repository
          </button>
        </div>
      )}

      <div className="github-repos">
        {repos.map((repo) => {
          const slug = `${repo.owner}/${repo.name}`
          const isExpanded = expandedRepo === slug
          const prs = prsByRepo[slug] || []
          const isLoading = loadingRepo === slug

          return (
            <div key={slug} className="github-repo">
              <div className="github-repo-header" onClick={() => handleToggleRepo(repo)}>
                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                <span className="github-repo-name"><span className="github-repo-owner">{repo.owner}/</span>{repo.name}</span>
                {prs.length > 0 && <span className="github-repo-count">{prs.length}</span>}
                {repo.localPath && (
                  <span className="github-repo-path" title={repo.localPath}>
                    {repo.localPath.split('/').pop()}
                  </span>
                )}
                <div className="github-repo-actions" onClick={(e) => e.stopPropagation()}>
                  <button title="Set local path" onClick={() => handleSetLocalPath(repo)}><FolderOpen size={13} /></button>
                  <button title="Refresh PRs" onClick={() => fetchPRsForRepo(repo)}>
                    <RefreshCw size={13} className={isLoading ? 'spinning' : ''} />
                  </button>
                  <button className="danger" title="Remove repo" onClick={() => handleRemoveRepo(repo)}><Trash2 size={13} /></button>
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
                          <span className="github-pr-number">#{pr.number}</span>
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
                            </div>
                          </div>
                          <button
                            className="github-pr-link"
                            title="Open on GitHub"
                            onClick={(e) => { e.stopPropagation(); window.api.shell.openExternal(pr.url) }}
                          >
                            <ExternalLink size={13} />
                          </button>
                        </div>
                        {isOpen && (
                          <div className="github-pr-actions">
                            {pr.labels.length > 0 && (
                              <div className="github-pr-labels">
                                {pr.labels.map((l) => (
                                  <span key={l} className="github-pr-label">{l}</span>
                                ))}
                              </div>
                            )}
                            <div className="github-pr-quick-actions">
                              {prompts.map((prompt) => (
                                <button
                                  key={prompt.id}
                                  className="github-action-btn"
                                  onClick={() => handleQuickAction(prompt, pr, repo)}
                                >
                                  <Play size={12} />
                                  {prompt.label}
                                </button>
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

      {/* PR Memory */}
      <div className="github-memory-section">
        <div
          className="github-memory-header"
          onClick={() => {
            if (!showMemory) {
              // Refresh memory content when opening
              window.api.github.getPrMemory().then(setMemory)
            }
            setShowMemory(!showMemory)
            setEditingMemory(false)
          }}
        >
          <Brain size={14} />
          <span>PR Memory</span>
          {showMemory ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </div>
        {showMemory && (
          <div className="github-memory-content">
            {editingMemory ? (
              <>
                <textarea
                  className="github-memory-editor"
                  value={memoryDraft}
                  onChange={(e) => setMemoryDraft(e.target.value)}
                  rows={12}
                />
                <div className="github-memory-actions">
                  <button
                    onClick={() => {
                      window.api.github.savePrMemory(memoryDraft).then((ok) => {
                        if (ok) setMemory(memoryDraft)
                        setEditingMemory(false)
                      })
                    }}
                  >
                    <Save size={12} /> Save
                  </button>
                  <button onClick={() => setEditingMemory(false)}>
                    <X size={12} /> Cancel
                  </button>
                </div>
              </>
            ) : (
              <>
                <pre className="github-memory-text">{memory || 'No memories yet. PR conversations will save important context here.'}</pre>
                <button
                  className="github-memory-edit-btn"
                  onClick={() => { setMemoryDraft(memory); setEditingMemory(true) }}
                >
                  <Pencil size={12} /> Edit
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Ask bar — ask questions about visible PRs */}
      {contextPath && (
        <div className="github-ask-bar">
          <MessageSquare size={14} className="github-ask-icon" />
          <input
            placeholder="Ask about these PRs... (e.g. which ones are assigned to me?)"
            value={askInput}
            onChange={(e) => setAskInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAsk() }}
          />
          <button
            className="github-ask-send"
            onClick={handleAsk}
            disabled={!askInput.trim()}
            title="Ask"
          >
            <Send size={14} />
          </button>
        </div>
      )}

      {/* Prompt editor overlay */}
      {showPromptEditor && (
        <div className="dialog-overlay" onClick={() => setShowPromptEditor(false)}>
          <div className="github-prompt-editor" onClick={(e) => e.stopPropagation()}>
            <h3>Quick Action Prompts</h3>
            <p className="github-prompt-help">
              Available variables: <code>{'{{pr.number}}'}</code> <code>{'{{pr.branch}}'}</code> <code>{'{{pr.title}}'}</code> <code>{'{{pr.url}}'}</code> <code>{'{{pr.author}}'}</code> <code>{'{{repo.owner}}'}</code> <code>{'{{repo.name}}'}</code>
            </p>
            <div className="github-prompt-list">
              {editingPrompts.map((p) => (
                <div key={p.id} className="github-prompt-item">
                  <div className="github-prompt-item-header">
                    <input
                      placeholder="Label (e.g. Review PR)"
                      value={p.label}
                      onChange={(e) => handleUpdatePrompt(p.id, 'label', e.target.value)}
                    />
                    <button className="danger" onClick={() => handleRemovePrompt(p.id)}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <textarea
                    placeholder="Prompt template..."
                    value={p.prompt}
                    onChange={(e) => handleUpdatePrompt(p.id, 'prompt', e.target.value)}
                    rows={3}
                  />
                </div>
              ))}
            </div>
            <div className="github-prompt-actions">
              <button className="github-prompt-add" onClick={handleAddPrompt}>
                <Plus size={13} /> Add Prompt
              </button>
              <div className="github-prompt-save-row">
                <button onClick={() => setShowPromptEditor(false)}>Cancel</button>
                <button className="github-prompt-save" onClick={handleSavePrompts}>Save Prompts</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
