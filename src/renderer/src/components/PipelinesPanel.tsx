import { useState, useEffect, useCallback, useRef } from 'react'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'
import {
  Zap, ZapOff, Play, RefreshCw, ChevronDown, ChevronRight,
  FileText, Clock, CheckCircle, XCircle, AlertTriangle, Save, BookOpen,
  MessageSquare, Send, Plus
} from 'lucide-react'

interface PipelineInfo {
  name: string
  description: string
  enabled: boolean
  fileName: string
  triggerType: string
  interval: number
  cron: string | null
  running: boolean
  outputsDir: string | null
  lastPollAt: string | null
  lastFiredAt: string | null
  lastError: string | null
  fireCount: number
}

interface Props {
  onLaunchInstance: (opts: { name?: string; workingDirectory?: string; color?: string; args?: string[] }) => Promise<string>
  onFocusInstance: (id: string) => void
  instances: Array<{ id: string; name: string; status: string }>
}

const PIPELINE_SYSTEM_PROMPT = `You are a Pipeline Assistant for Claude Colony. You help users create, edit, and manage pipeline YAML files.

Pipelines are YAML files stored in ~/.claude-colony/pipelines/ that define automated trigger → condition → action workflows.

## Pipeline YAML Format

\`\`\`yaml
name: Pipeline Name
description: What this pipeline does
enabled: false

trigger:
  type: git-poll          # or: file-poll, cron
  interval: 300           # seconds between polls (used when cron matches)
  cron: "0 9 * * 1-5"    # optional: only run during certain times (min hour dom month dow)
  repos: auto             # "auto" = repos from GitHub tab

condition:
  type: branch-file-exists   # or: pr-checks-failed, always
  branch: branch-name
  path: "path/to/file.md"
  match:
    pr.author: "{{github.user}}"

action:
  type: route-to-session     # or: launch-session
  match:
    gitBranch: "{{pr.branch}}"
    workingDirectory: "{{repo.localPath}}"
  busyStrategy: wait         # or: launch-new
  name: "Session Name"
  workingDirectory: "{{repo.localPath}}"
  color: "#f59e0b"
  prompt: |
    Your prompt here with {{template.variables}}

dedup:
  key: "unique-key-per-event"
  ttl: 3600
\`\`\`

## Template Variables
{{pr.number}}, {{pr.title}}, {{pr.branch}}, {{pr.baseBranch}}, {{pr.author}}, {{pr.url}}, {{pr.assignees}}, {{pr.reviewers}}, {{pr.labels}}
{{repo.owner}}, {{repo.name}}, {{repo.localPath}}
{{github.user}}, {{timestamp}}

## Action Types
- \`launch-session\`: Spawns a new Claude session. Add \`reuse: true\` to try finding/resuming a matching session first.
- \`route-to-session\`: Finds an existing session matching the branch/repo, injects the prompt. Falls back to launching new if no match.
- **\`reuse: true\`** flag: works on either action type. Searches running sessions and CLI history by branch, repo, PR number, and session name. Resumes via \`--resume\` if a history match is found.

## Condition Types
- \`branch-file-exists\`: Checks if a file exists on a specific branch (uses GitHub API)
- \`pr-checks-failed\`: Fires when CI checks fail on matching PRs. Supports \`exclude\` array to ignore specific checks (e.g. playwright, e2e)
- \`always\`: Always fires (for cron triggers)

## Dedup
Content-hash based: tracks the Git SHA of matched files. Same content = skip. Changed content = fire. TTL is a fallback for conditions without content hashes.

Help the user design pipelines for their use cases. Write the YAML files directly to ~/.claude-colony/pipelines/. Ask what they want to automate.`

export default function PipelinesPanel({ onLaunchInstance, onFocusInstance, instances }: Props) {
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([])
  const [expandedPipeline, setExpandedPipeline] = useState<string | null>(null)
  const [editingContent, setEditingContent] = useState<string | null>(null)
  const [editingFileName, setEditingFileName] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [readmeContent, setReadmeContent] = useState<string | null>(null)
  const [pipelineMemory, setPipelineMemory] = useState('')
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [outputFiles, setOutputFiles] = useState<Array<{ name: string; path: string; size: number; modified: number }>>([])
  const [outputPreview, setOutputPreview] = useState<{ name: string; content: string } | null>(null)
  const [expandedTab, setExpandedTab] = useState<'yaml' | 'docs' | 'memory' | 'outputs'>('yaml')

  // Pipeline assistant
  const [askInput, setAskInput] = useState('')
  const [assistantId, setAssistantId] = useState<string | null>(null)
  const [pipelinesDir, setPipelinesDir] = useState<string | null>(null)
  const sendingRef = useRef(false)

  const loadPipelines = useCallback(async () => {
    const list = await window.api.pipeline.list()
    setPipelines(list)
  }, [])

  useEffect(() => {
    loadPipelines()
    const unsub = window.api.pipeline.onStatus((list) => setPipelines(list))
    return unsub
  }, [loadPipelines])

  // Load pipelines dir
  useEffect(() => {
    window.api.pipeline.getDir().then(setPipelinesDir)
  }, [])

  // Track if assistant is still alive
  useEffect(() => {
    if (assistantId && !instances.some(i => i.id === assistantId && i.status === 'running')) {
      setAssistantId(null)
    }
  }, [instances, assistantId])

  const sendPromptToAssistant = useCallback((id: string, prompt: string) => {
    sendPromptWhenReady(id, { prompt })
  }, [])

  const handleAsk = useCallback(async () => {
    const q = askInput.trim()
    if (!q || sendingRef.current) return
    setAskInput('')
    sendingRef.current = true

    try {
      // Reuse existing assistant session
      if (assistantId && instances.some(i => i.id === assistantId && i.status === 'running')) {
        await window.api.instance.write(assistantId, q + '\r')
        onFocusInstance(assistantId)
        return
      }

      // Launch new assistant with system prompt baked in
      const id = await onLaunchInstance({
        name: 'Pipeline Assistant',
        workingDirectory: pipelinesDir || undefined,
        color: '#8b5cf6',
        args: ['--append-system-prompt', PIPELINE_SYSTEM_PROMPT],
      })
      setAssistantId(id)
      // Send user question once CLI is ready
      sendPromptToAssistant(id, q)
      onFocusInstance(id)
    } finally {
      sendingRef.current = false
    }
  }, [askInput, assistantId, instances, pipelinesDir, onLaunchInstance, onFocusInstance, sendPromptToAssistant])

  const handleToggle = async (name: string, enabled: boolean) => {
    await window.api.pipeline.toggle(name, enabled)
    loadPipelines()
  }

  const handleTriggerNow = async (name: string) => {
    await window.api.pipeline.triggerNow(name)
  }

  const handleExpand = async (p: PipelineInfo) => {
    if (expandedPipeline === p.name) {
      setExpandedPipeline(null)
      setEditingContent(null)
      setEditingFileName(null)
      setReadmeContent(null)
      setDirty(false)
      return
    }
    setExpandedPipeline(p.name)
    const content = await window.api.pipeline.getContent(p.fileName)
    setEditingContent(content || '')
    setEditingFileName(p.fileName)
    setDirty(false)
    setExpandedTab('yaml')

    // Try to load companion README
    const readmeName = p.fileName.replace(/\.(yaml|yml)$/, '.readme.md')
    const readme = await window.api.pipeline.getContent(readmeName)
    setReadmeContent(readme)

    // Load memory
    const mem = await window.api.pipeline.getMemory(p.fileName)
    setPipelineMemory(mem || '')
    setMemoryDirty(false)

    // Load outputs
    setOutputFiles([])
    setOutputPreview(null)
    if (p.outputsDir) {
      const files = await window.api.pipeline.listOutputs(p.outputsDir)
      setOutputFiles(files)
    }
  }

  const handleSaveMemory = async () => {
    if (!editingFileName) return
    await window.api.pipeline.saveMemory(editingFileName, pipelineMemory)
    setMemoryDirty(false)
  }

  const handleSave = async () => {
    if (!editingFileName || editingContent == null) return
    await window.api.pipeline.saveContent(editingFileName, editingContent)
    setDirty(false)
    loadPipelines()
  }

  const handleReload = async () => {
    await window.api.pipeline.reload()
    loadPipelines()
  }

  const timeSince = (iso: string) => {
    const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
    if (secs < 60) return `${secs}s ago`
    if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
    if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
    return `${Math.floor(secs / 86400)}d ago`
  }

  return (
    <div className="pipelines-panel">
      <div className="pipelines-header">
        <h2><Zap size={16} /> Pipelines</h2>
        <button className="pipelines-reload-btn" onClick={handleReload} title="Reload all pipeline files">
          <RefreshCw size={12} /> Reload
        </button>
      </div>

      <p className="pipelines-description">
        Pipelines automate trigger → action workflows. Define them as YAML files in <code>~/.claude-colony/pipelines/</code>.
      </p>

      <div className="pipeline-ask-bar">
        <MessageSquare size={14} className="pipeline-ask-icon" />
        <input
          className="pipeline-ask-input"
          placeholder="Ask the Pipeline Assistant to create or modify a pipeline..."
          value={askInput}
          onChange={(e) => setAskInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk() } }}
        />
        <button
          className="pipeline-ask-send"
          onClick={handleAsk}
          disabled={!askInput.trim()}
          title="Send to Pipeline Assistant"
        >
          <Send size={13} />
        </button>
        {assistantId && instances.some(i => i.id === assistantId && i.status === 'running') && (
          <button
            className="pipeline-ask-focus"
            onClick={() => onFocusInstance(assistantId!)}
            title="Focus Pipeline Assistant session"
          >
            View
          </button>
        )}
      </div>

      {pipelines.length === 0 && (
        <div className="pipelines-empty">
          <ZapOff size={28} />
          <p>No pipelines found</p>
          <p className="pipelines-empty-hint">
            Create YAML files in ~/.claude-colony/pipelines/ to get started.
          </p>
        </div>
      )}

      <div className="pipelines-list">
        {pipelines.map((p) => (
          <div key={p.name} className={`pipeline-card ${p.enabled ? '' : 'disabled'}`}>
            <div className="pipeline-card-header" onClick={() => handleExpand(p)}>
              <div className="pipeline-card-left">
                {expandedPipeline === p.name ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className={`pipeline-status-dot ${p.running ? 'running' : p.enabled ? 'active' : 'inactive'}`} />
                <span className="pipeline-card-name">{p.name}</span>
                {p.running && <span className="pipeline-running-badge">Running</span>}
              </div>
              <div className="pipeline-card-right">
                <span className="pipeline-card-trigger">{p.triggerType}</span>
                {p.cron ? (
                  <span className="pipeline-card-cron" title={`Cron: ${p.cron}`}><Clock size={10} /> {p.cron}</span>
                ) : (
                  <span className="pipeline-card-interval">{p.interval}s</span>
                )}
                {p.fireCount > 0 && (
                  <span className="pipeline-card-fires">
                    <Zap size={10} /> {p.fireCount}
                  </span>
                )}
              </div>
            </div>

            {p.description && (
              <div className="pipeline-card-desc">{p.description}</div>
            )}

            <div className="pipeline-card-meta">
              {p.lastPollAt && (
                <span className="pipeline-meta-item" title={`Last polled: ${p.lastPollAt}`}>
                  <Clock size={10} /> Polled {timeSince(p.lastPollAt)}
                </span>
              )}
              {p.lastFiredAt && (
                <span className="pipeline-meta-item pipeline-meta-fired" title={`Last fired: ${p.lastFiredAt}`}>
                  <CheckCircle size={10} /> Fired {timeSince(p.lastFiredAt)}
                </span>
              )}
              {p.lastError && (
                <div className="pipeline-error-block">
                  <AlertTriangle size={10} />
                  <span className="pipeline-error-text">{p.lastError}</span>
                </div>
              )}
            </div>

            <div className="pipeline-card-actions">
              <button
                className={`pipeline-toggle-btn ${p.enabled ? 'enabled' : ''}`}
                onClick={(e) => { e.stopPropagation(); handleToggle(p.name, !p.enabled) }}
              >
                {p.enabled ? <Zap size={11} /> : <ZapOff size={11} />}
                {p.enabled ? 'Enabled' : 'Disabled'}
              </button>
              {p.enabled && (
                <button
                  className="pipeline-trigger-btn"
                  onClick={(e) => { e.stopPropagation(); handleTriggerNow(p.name) }}
                  title="Run poll now"
                >
                  <Play size={11} /> Poll Now
                </button>
              )}
              <button
                className="pipeline-trigger-btn"
                onClick={async (e) => {
                  e.stopPropagation()
                  const content = await window.api.pipeline.getContent(p.fileName)
                  const mem = await window.api.pipeline.getMemory(p.fileName)
                  const memContent = mem ? `\nPipeline memory (learnings):\n${mem}\n` : ''
                  const context = `You are editing the pipeline: ${p.name}\nFile: ~/.claude-colony/pipelines/${p.fileName}\n\nCurrent YAML:\n\`\`\`yaml\n${content}\n\`\`\`\n${memContent}\n${PIPELINE_SYSTEM_PROMPT}\n\nHelp the user modify this pipeline. Write the updated YAML to ~/.claude-colony/pipelines/${p.fileName}`
                  const promptFile = await window.api.colony.writePromptFile(context)
                  onLaunchInstance({
                    name: `Edit: ${p.name}`,
                    workingDirectory: pipelinesDir || undefined,
                    color: '#8b5cf6',
                    args: ['--append-system-prompt-file', promptFile],
                  })
                }}
                title="Edit this pipeline with AI"
              >
                <MessageSquare size={11} /> Edit with AI
              </button>
            </div>

            {expandedPipeline === p.name && editingContent !== null && (
              <div className="pipeline-editor">
                <div className="pipeline-editor-header">
                  <div className="pipeline-editor-tabs">
                    <button
                      className={`pipeline-tab ${expandedTab === 'yaml' ? 'active' : ''}`}
                      onClick={() => setExpandedTab('yaml')}
                    >
                      <FileText size={11} /> Config
                    </button>
                    <button
                      className={`pipeline-tab ${expandedTab === 'memory' ? 'active' : ''}`}
                      onClick={() => setExpandedTab('memory')}
                    >
                      <Zap size={11} /> Memory
                    </button>
                    {p.outputsDir && (
                      <button
                        className={`pipeline-tab ${expandedTab === 'outputs' ? 'active' : ''}`}
                        onClick={() => setExpandedTab('outputs')}
                      >
                        <FileText size={11} /> Outputs {outputFiles.length > 0 && `(${outputFiles.length})`}
                      </button>
                    )}
                    {readmeContent && (
                      <button
                        className={`pipeline-tab ${expandedTab === 'docs' ? 'active' : ''}`}
                        onClick={() => setExpandedTab('docs')}
                      >
                        <BookOpen size={11} /> Docs
                      </button>
                    )}
                  </div>
                  {expandedTab === 'yaml' && dirty && (
                    <button className="pipeline-save-btn" onClick={handleSave}>
                      <Save size={11} /> Save
                    </button>
                  )}
                  {expandedTab === 'yaml' && editingFileName && (
                    <button className="pipeline-save-btn" onClick={async () => {
                      const memContent = pipelineMemory ? `\nPipeline memory (learnings):\n${pipelineMemory}\n` : ''
                      const context = `You are editing the pipeline file: ~/.claude-colony/pipelines/${editingFileName}\n\nCurrent YAML:\n\`\`\`yaml\n${editingContent}\n\`\`\`\n${memContent}\n${PIPELINE_SYSTEM_PROMPT}\n\nThe user wants to edit this pipeline. Help them modify it. When done, write the updated YAML to ~/.claude-colony/pipelines/${editingFileName}`
                      const promptFile = await window.api.colony.writePromptFile(context)
                      onLaunchInstance({
                        name: `Edit: ${p.name}`,
                        workingDirectory: pipelinesDir || undefined,
                        color: '#8b5cf6',
                        args: ['--append-system-prompt-file', promptFile],
                      })
                    }}>
                      <MessageSquare size={11} /> Edit with AI
                    </button>
                  )}
                  {expandedTab === 'memory' && memoryDirty && (
                    <button className="pipeline-save-btn" onClick={handleSaveMemory}>
                      <Save size={11} /> Save
                    </button>
                  )}
                </div>
                {expandedTab === 'yaml' ? (
                  <textarea
                    className="pipeline-editor-textarea"
                    value={editingContent}
                    onChange={(e) => { setEditingContent(e.target.value); setDirty(true) }}
                    spellCheck={false}
                  />
                ) : expandedTab === 'outputs' ? (
                  <div className="pipeline-outputs">
                    {outputPreview ? (
                      <div className="pipeline-output-preview">
                        <div className="pipeline-output-preview-header">
                          <span>{outputPreview.name}</span>
                          <button onClick={() => setOutputPreview(null)}>Back</button>
                        </div>
                        <pre className="pipeline-output-preview-code">
                          {outputPreview.content.split('\n').map((line, i) => (
                            <div key={i} className="pipeline-output-preview-line">
                              <span className="pipeline-output-preview-num">{i + 1}</span>
                              <span>{line}</span>
                            </div>
                          ))}
                        </pre>
                      </div>
                    ) : outputFiles.length === 0 ? (
                      <p className="pipeline-memory-hint">No output files yet. Run the pipeline to generate artifacts.</p>
                    ) : (
                      <div className="pipeline-output-list">
                        {outputFiles.map((f) => (
                          <div
                            key={f.path}
                            className="pipeline-output-file"
                            onClick={async () => {
                              const result = await window.api.fs.readFile(f.path)
                              if (result.content !== undefined) setOutputPreview({ name: f.name, content: result.content })
                            }}
                          >
                            <FileText size={11} />
                            <span className="pipeline-output-file-name">{f.name}</span>
                            <span className="pipeline-output-file-meta">
                              {f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`}
                              {' · '}
                              {new Date(f.modified).toLocaleDateString()} {new Date(f.modified).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : expandedTab === 'memory' ? (
                  <div className="pipeline-memory-editor">
                    <p className="pipeline-memory-hint">
                      Learnings from previous runs — tools, patterns, and approaches that help future executions. Injected into prompts automatically.
                    </p>
                    <textarea
                      className="pipeline-editor-textarea"
                      value={pipelineMemory}
                      onChange={(e) => { setPipelineMemory(e.target.value); setMemoryDirty(true) }}
                      placeholder="No memories yet. Learnings will be captured from pipeline runs, or add them manually here."
                      spellCheck={false}
                    />
                  </div>
                ) : (
                  <div className="pipeline-readme" dangerouslySetInnerHTML={{
                    __html: readmeContent!
                      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
                      .replace(/^### (.+)$/gm, '<h3>$1</h3>')
                      .replace(/^## (.+)$/gm, '<h2>$1</h2>')
                      .replace(/^# (.+)$/gm, '<h1>$1</h1>')
                      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                      .replace(/`([^`]+)`/g, '<code>$1</code>')
                      .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
                      .replace(/\n\n/g, '</p><p>')
                      .replace(/\n/g, '<br/>')
                  }} />
                )}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
