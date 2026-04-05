import { useState, useEffect } from 'react'
import { X, Loader2, MessageSquare, GitBranch, FolderOpen, Send, Plus, FileText } from 'lucide-react'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'
import { buildTemplateAgentPrompt } from '../../../shared/env-prompts'

interface GitHubRepo {
  owner: string
  name: string
  localPath?: string
}

import type { EnvironmentTemplate } from '../../../shared/types'

interface Props {
  onClose: () => void
  onCreated: () => void
  onLaunchInstance: (opts: { name?: string; workingDirectory?: string; color?: string; args?: string[] }) => Promise<string>
  onFocusInstance: (id: string) => void
  mode?: 'template' | 'instance'
  preselectedTemplate?: EnvironmentTemplate | null
}

const TEMPLATE_AGENT_PROMPT = buildTemplateAgentPrompt()

export default function NewEnvironmentDialog({ onClose, onCreated, onLaunchInstance, onFocusInstance, mode: initialMode, preselectedTemplate }: Props) {
  const [mode, setMode] = useState<'template' | 'instance'>(initialMode || (preselectedTemplate ? 'instance' : 'template'))
  const [repos, setRepos] = useState<GitHubRepo[]>([])
  const [templates, setTemplates] = useState<EnvironmentTemplate[]>([])
  const [selectedRepos, setSelectedRepos] = useState<Set<string>>(new Set())
  const [selectedTemplate, setSelectedTemplate] = useState<EnvironmentTemplate | null>(preselectedTemplate || null)
  const [instanceName, setInstanceName] = useState('')
  const [instanceBranch, setInstanceBranch] = useState('')
  const [targetDir, setTargetDir] = useState('')
  const [instructions, setInstructions] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.api.github.getRepos().then(setRepos)
    window.api.env.listTemplates().then(setTemplates)
  }, [])

  // ---- Create Template (launch Template Agent) ----
  const handleCreateTemplate = async () => {
    if (selectedRepos.size === 0 && !instructions.trim()) {
      setError('Select at least one repository or provide instructions')
      return
    }
    setCreating(true); setError(null)
    try {
      const selected = repos.filter(r => selectedRepos.has(`${r.owner}/${r.name}`))
      const repoContext = selected.length > 0
        ? `Repositories:\n${selected.map(r => `- ${r.owner}/${r.name}${r.localPath ? ` (local path: ${r.localPath})` : ''}`).join('\n')}`
        : ''
      const userPrompt = [repoContext, instructions.trim()].filter(Boolean).join('\n\n')
      const label = selected.length > 0 ? selected.map(r => r.name).join(' + ') : 'New Environment'

      // Write system prompt to file (too large for CLI arg)
      let promptArgs: string[]
      try {
        const promptFile = await window.api.fs.writeTempFile('tpl-agent', TEMPLATE_AGENT_PROMPT)
        promptArgs = ['--append-system-prompt-file', promptFile]
      } catch {
        // Fallback to inline if temp file write fails
        promptArgs = ['--append-system-prompt', TEMPLATE_AGENT_PROMPT]
      }

      const id = await onLaunchInstance({
        name: `Template: ${label}`,
        color: '#10b981',
        args: [...promptArgs, '--dangerously-skip-permissions'],
      })

      sendPromptWhenReady(id, { prompt: userPrompt })

      onFocusInstance(id)
      onCreated()
    } catch (err: any) {
      setError(err.message || 'Failed to launch Template Agent')
      setCreating(false)
    }
  }

  // ---- Create Instance from Template ----
  const handleCreateInstance = async () => {
    if (!selectedTemplate) { setError('Select a template'); return }
    if (!instanceName.trim()) { setError('Instance name is required'); return }
    if (!/^[a-zA-Z0-9 _-]+$/.test(instanceName)) { setError('Only letters, numbers, spaces, hyphens, underscores'); return }
    setCreating(true); setError(null)
    try {
      const manifest = await window.api.env.create({
        name: instanceName.trim(),
        branch: instanceBranch.trim() || undefined,
        templateId: selectedTemplate.id,
        projectType: selectedTemplate.projectType,
        targetDir: targetDir.trim() || undefined,
      })

      // Launch a Claude instance in the environment's working directory
      const repos = selectedTemplate.repos || []
      const repoList = repos.map(r => `- ${r.owner}/${r.name} (role: ${r.as})`).join('\n')
      const services = Object.keys(selectedTemplate.services || {})
      const svcList = services.length > 0 ? `\nServices: ${services.join(', ')}` : ''
      const branch = instanceBranch.trim() || selectedTemplate.branches?.default || 'develop'

      const initialPrompt = [
        `Environment "${instanceName.trim()}" created from template "${selectedTemplate.name}" (${selectedTemplate.projectType}).`,
        repoList ? `\nRepositories:\n${repoList}` : '',
        svcList,
        `\nBranch: ${branch}`,
        `\nThe environment is being set up in the background (cloning repos, running hooks). You can start services with \`env:start\` once setup completes.`,
        `\nHow can I help you with this environment?`,
      ].filter(Boolean).join('')

      const id = await onLaunchInstance({
        name: instanceName.trim(),
        workingDirectory: manifest.paths?.root,
        color: '#10b981',
        args: ['--dangerously-skip-permissions'],
      })

      sendPromptWhenReady(id, { prompt: initialPrompt })

      onFocusInstance(id)
      onCreated()
    } catch (err: any) {
      setError(err.message || 'Failed to create instance')
      setCreating(false)
    }
  }

  const handleSelectDir = async () => {
    const dir = await window.api.dialog.openDirectory()
    if (dir) setTargetDir(dir)
  }

  return (
    <div className="env-dialog-overlay" onClick={onClose}>
      <div className="env-dialog env-dialog-create" onClick={e => e.stopPropagation()}>
        <div className="env-dialog-header">
          <h3>{mode === 'template' ? 'New Template' : 'New Environment'}</h3>
          <button className="env-btn env-btn-ghost" onClick={onClose}><X size={16} /></button>
        </div>

        {/* Mode tabs */}
        {!preselectedTemplate && (
          <div className="env-dialog-mode-tabs">
            <button className={mode === 'instance' ? 'active' : ''} onClick={() => { setMode('instance'); setError(null) }}>
              New Environment
            </button>
            <button className={mode === 'template' ? 'active' : ''} onClick={() => { setMode('template'); setError(null) }}>
              New Template
            </button>
          </div>
        )}

        {creating ? (
          <div className="env-setup-progress">
            <Loader2 size={24} className="spinning" />
            <p>{mode === 'template' ? 'Launching Template Agent...' : `Creating "${instanceName}"...`}</p>
            <button className="env-btn env-btn-secondary" onClick={onClose}>Cancel</button>
          </div>
        ) : mode === 'template' ? (
          <>
            {/* Template creation: select repos + instructions */}
            <div className="env-form-group">
              <label><GitBranch size={12} /> Repositories</label>
              {repos.length > 0 ? (
                <div className="env-repo-list">
                  {repos.map(r => {
                    const slug = `${r.owner}/${r.name}`
                    return (
                      <div key={slug} className={`env-repo-chip ${selectedRepos.has(slug) ? 'active' : ''}`}
                        onClick={() => setSelectedRepos(prev => { const n = new Set(prev); n.has(slug) ? n.delete(slug) : n.add(slug); return n })}>
                        <FolderOpen size={11} />
                        <span>{r.name}</span>
                      </div>
                    )
                  })}
                </div>
              ) : (
                <span className="env-form-hint">No repos configured. Add repos in the Pull Requests tab.</span>
              )}
            </div>
            <div className="env-form-group">
              <label><MessageSquare size={12} /> Instructions</label>
              <textarea value={instructions} onChange={e => setInstructions(e.target.value)}
                placeholder="Describe the project stack, any special setup, shared services..." rows={3} />
              <span className="env-form-hint">The Template Agent will explore the project, set up a preview, and extract a reusable template.</span>
            </div>
            {error && <div className="env-form-error">{error}</div>}
            <div className="env-dialog-actions">
              <button className="env-btn env-btn-secondary" onClick={onClose}>Cancel</button>
              <button className="env-btn env-btn-primary" onClick={handleCreateTemplate}><Send size={13} /> Launch Template Agent</button>
            </div>
          </>
        ) : (
          <>
            {/* Instance creation: pick template, name, branch, directory */}
            {!preselectedTemplate && (
              <div className="env-form-group">
                <label><FileText size={12} /> Template</label>
                {templates.length > 0 ? (
                  <div className="env-repo-list">
                    {templates.map(t => (
                      <div key={t.id} className={`env-repo-chip ${selectedTemplate?.id === t.id ? 'active' : ''}`}
                        onClick={() => setSelectedTemplate(t)}>
                        <FileText size={11} />
                        <span>{t.name}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <span className="env-form-hint">No templates yet. Create one first.</span>
                )}
              </div>
            )}
            <div className="env-form-group">
              <label>Environment Name</label>
              <input type="text" value={instanceName} onChange={e => setInstanceName(e.target.value)}
                placeholder="e.g., my-feature, bugfix-123" autoFocus
                onKeyDown={e => e.key === 'Enter' && handleCreateInstance()} />
              <span className="env-form-hint">Used for DB name, URLs, and directory</span>
            </div>
            <div className="env-form-group">
              <label>Branch (optional)</label>
              <input type="text" value={instanceBranch} onChange={e => setInstanceBranch(e.target.value)}
                placeholder={selectedTemplate?.branches?.default || 'develop'} />
            </div>
            <div className="env-form-group">
              <label>Target Directory (optional)</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="text" value={targetDir} onChange={e => setTargetDir(e.target.value)}
                  placeholder="Default: ~/.claude-colony/environments/" style={{ flex: 1 }} />
                <button className="env-btn env-btn-secondary" onClick={handleSelectDir} style={{ flexShrink: 0 }}>Browse</button>
              </div>
              <span className="env-form-hint">Where to create the environment. Leave blank for default location.</span>
            </div>
            {error && <div className="env-form-error">{error}</div>}
            <div className="env-dialog-actions">
              <button className="env-btn env-btn-secondary" onClick={onClose}>Cancel</button>
              <button className="env-btn env-btn-primary" onClick={handleCreateInstance} disabled={!selectedTemplate}>
                <Plus size={13} /> Create Instance
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
