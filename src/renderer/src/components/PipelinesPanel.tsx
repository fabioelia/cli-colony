import { useState, useEffect, useCallback, useRef } from 'react'
import { useFileDrop } from '../hooks/useFileDrop'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'
import {
  Zap, ZapOff, Play, RefreshCw, ChevronDown, ChevronRight,
  FileText, Clock, CheckCircle, XCircle, AlertTriangle, Save, BookOpen,
  MessageSquare, Send, Plus, Search, Pencil, Eye, X, LayoutList, LayoutGrid,
  ShieldCheck, List, Globe
} from 'lucide-react'
import type { AuditResult } from '../../../shared/types'
import HelpPopover from './HelpPopover'
import CronEditor from './CronEditor'
import { describeCron } from '../../../shared/cron'

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
  lastMatchAt: string | null
  lastFiredAt: string | null
  lastError: string | null
  fireCount: number
  debugLog: string[]
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
  type: launch-session
  reuse: true                # try to find/resume a matching session first
  match:
    gitBranch: "{{pr.branch}}"
    workingDirectory: "{{repo.localPath}}"
  busyStrategy: launch-new   # or: wait (15s max)
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
- \`launch-session\`: The only action type. Spawns a new Claude session.
- **\`reuse: true\`**: Searches running sessions and CLI history by branch, repo, PR number, and session name. If found, routes the prompt there. If busy, applies \`busyStrategy\`. Falls back to launching new if nothing matches.
- **\`busyStrategy\`**: \`launch-new\` (default) launches a new session if existing is busy. \`wait\` waits up to 15s for it to become idle.
- **\`route-to-session\`**: Deprecated alias — automatically converted to \`launch-session\` + \`reuse: true\`.

## Condition Types
- \`branch-file-exists\`: Checks if a file exists on a specific branch (uses GitHub API)
- \`pr-checks-failed\`: Fires when CI checks fail on matching PRs. Supports \`exclude\` array to ignore specific checks (e.g. playwright, e2e)
- \`always\`: Always fires (for cron triggers)

## Dedup
Content-hash based: tracks the Git SHA of matched files. Same content = skip. Changed content = fire. TTL is a fallback for conditions without content hashes.

Help the user design pipelines for their use cases. Write the YAML files directly to ~/.claude-colony/pipelines/. Ask what they want to automate.`

const STAGE_TYPE_LABELS: Record<string, string> = {
  'launch-session': 'Launch',
  'route-to-session': 'Route',
  'maker-checker': 'Maker-Checker',
  'diff_review': 'Diff Review',
  'parallel': 'Parallel',
  'plan': 'Plan',
}
function stageTypeLabel(type: string): string {
  return STAGE_TYPE_LABELS[type] ?? type
}

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
  const [expandedTab, setExpandedTab] = useState<'yaml' | 'docs' | 'memory' | 'outputs' | 'history' | 'debug'>('yaml')
  type StageTrace = { index: number; actionType: string; sessionName?: string; durationMs: number; success: boolean; error?: string; responseSnippet?: string; subStages?: StageTrace[] }
  const [historyEntries, setHistoryEntries] = useState<Array<{ ts: string; trigger: string; actionExecuted: boolean; success: boolean; durationMs: number; totalCost?: number; stages?: StageTrace[] }>>([])
  const [expandedHistoryRows, setExpandedHistoryRows] = useState<Set<number>>(new Set())

  const [listMode, setListMode] = useState(() => localStorage.getItem('pipelines-list-mode') !== '0')

  // Cron editor — tracks which pipeline's cron is being edited
  const [cronEditingPipeline, setCronEditingPipeline] = useState<string | null>(null)

  // Pipeline preview (dry-run)
  type PreviewResult = {
    wouldFire: boolean
    matches: Array<{ description: string; resolvedVars: Record<string, string>; wouldBeDeduped: boolean }>
    conditionLog: string[]
    error?: string
  }
  const [previewResult, setPreviewResult] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewPipelineName, setPreviewPipelineName] = useState<string | null>(null)

  // Pipeline assistant
  const [askInput, setAskInput] = useState('')
  const [assistantId, setAssistantId] = useState<string | null>(null)
  const { ref: askBarRef, isDragging: askBarDragging } = useFileDrop(paths => {
    setAskInput(prev => (prev ? prev + '\n' : '') + paths.join('\n'))
  })
  const [pipelinesDir, setPipelinesDir] = useState<string | null>(null)
  const sendingRef = useRef(false)

  // Audit state
  const [auditResults, setAuditResults] = useState<AuditResult[] | null>(null)
  const [auditRunning, setAuditRunning] = useState(false)
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditLastRun, setAuditLastRun] = useState<{ ts: number; issueCount: number } | null>(null)
  const [previewLogOpen, setPreviewLogOpen] = useState(false)

  const loadPipelines = useCallback(async () => {
    const list = await window.api.pipeline.list()
    setPipelines(list)
  }, [])

  useEffect(() => {
    loadPipelines()
    const unsub = window.api.pipeline.onStatus((list) => setPipelines(list))
    return unsub
  }, [loadPipelines])

  // Load pipelines dir + last audit run
  useEffect(() => {
    window.api.pipeline.getDir().then(setPipelinesDir)
    window.api.audit.getLastRun('pipelines').then(setAuditLastRun)
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

  const handlePreview = async (p: PipelineInfo) => {
    setPreviewPipelineName(p.name)
    setPreviewResult(null)
    setPreviewLoading(true)
    setPreviewLogOpen(false)
    const result = await window.api.pipeline.preview(p.fileName)
    setPreviewResult(result)
    setPreviewLoading(false)
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

    // Load run history
    setHistoryEntries([])
    const history = await window.api.pipeline.getHistory(p.name)
    setHistoryEntries(history.slice().reverse()) // most recent first
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

  const handleRunAudit = async () => {
    setAuditRunning(true)
    setAuditResults(null)
    setAuditOpen(true)
    const context = {
      pipelines: pipelines.map(p => ({
        name: p.name,
        enabled: p.enabled,
        fileName: p.fileName,
        yaml: '',
        lastError: p.lastError,
        fireCount: p.fireCount,
      })),
    }
    const results = await window.api.audit.runPanel('pipelines', context)
    setAuditResults(results)
    setAuditRunning(false)
    window.api.audit.getLastRun('pipelines').then(setAuditLastRun)
  }

  const handleAuditFix = (fixAction: string) => {
    if (fixAction.startsWith('open-yaml:')) {
      const fileName = fixAction.slice('open-yaml:'.length)
      const found = pipelines.find(p => p.fileName === fileName)
      if (found) handleExpand(found)
    } else if (fixAction.startsWith('toggle-disable:')) {
      const fileName = fixAction.slice('toggle-disable:'.length)
      const found = pipelines.find(p => p.fileName === fileName)
      if (found) window.api.pipeline.toggle(found.name, false).then(() => loadPipelines())
    }
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
      <div className="panel-header">
        <h2><Zap size={16} /> Pipelines</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="pipelines" align="right" />
        <div className="panel-header-actions">
          <button
            className={`panel-header-btn${listMode ? ' active' : ''}`}
            title={listMode ? 'Switch to card view' : 'Switch to list view'}
            onClick={() => { const next = !listMode; setListMode(next); localStorage.setItem('pipelines-list-mode', next ? '1' : '0') }}
          >
            {listMode ? <LayoutGrid size={13} /> : <LayoutList size={13} />}
          </button>
          <button className="panel-header-btn" onClick={handleReload} title="Reload all pipeline files">
            <RefreshCw size={12} /> Reload
          </button>
          <button
            className={`panel-header-btn${auditResults && auditResults.length > 0 ? ' panel-header-btn--audit-alert' : ''}`}
            onClick={handleRunAudit}
            disabled={auditRunning}
            title={auditLastRun ? `Last run: ${new Date(auditLastRun.ts).toLocaleString()}, ${auditLastRun.issueCount} issue${auditLastRun.issueCount !== 1 ? 's' : ''}` : 'Run AI audit — identify misconfigured or broken pipelines'}
          >
            <ShieldCheck size={12} />
            {auditRunning ? 'Auditing…' : auditLastRun
              ? (() => { const secs = (Date.now() - auditLastRun.ts) / 1000; const ago = secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`; return `Audit (${ago}, ${auditLastRun.issueCount} issue${auditLastRun.issueCount !== 1 ? 's' : ''})` })()
              : 'Audit'}
            {auditResults && auditResults.length > 0 && (
              <span className="audit-badge">{auditResults.length}</span>
            )}
          </button>
        </div>
      </div>

      {auditOpen && (auditRunning || auditResults !== null) && (
        <div className="audit-results-panel">
          <div className="audit-results-header">
            <ShieldCheck size={13} />
            <span>Pipeline Audit</span>
            {!auditRunning && <span className="audit-results-count">{auditResults?.length ?? 0} issue{auditResults?.length !== 1 ? 's' : ''}</span>}
            <button className="audit-results-dismiss" onClick={() => { setAuditOpen(false); setAuditResults(null) }} title="Dismiss">
              <X size={11} />
            </button>
          </div>
          {auditRunning && <div className="audit-results-loading">Running audit with Claude…</div>}
          {!auditRunning && auditResults !== null && auditResults.length === 0 && (
            <div className="audit-results-empty">No issues found.</div>
          )}
          {!auditRunning && auditResults && auditResults.map((r, i) => (
            <div key={i} className={`audit-result-row audit-result-row--${r.severity.toLowerCase()}`}>
              <span className="audit-result-severity">{r.severity}</span>
              <div className="audit-result-body">
                <span className="audit-result-item">{r.item}</span>
                <span className="audit-result-issue">{r.issue}</span>
              </div>
              {r.fixAction && (
                <button
                  className="audit-result-fix"
                  onClick={() => handleAuditFix(r.fixAction!)}
                  title="Apply fix"
                >
                  Fix
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <p className="pipelines-description">
        Pipelines automate trigger → action workflows. Define them as YAML files in <code>~/.claude-colony/pipelines/</code>.
      </p>

      <div ref={askBarRef} className={`panel-ask-bar${askBarDragging ? ' dragging' : ''}`}>
        <MessageSquare size={14} className="panel-ask-icon" />
        <input
          className="panel-ask-input"
          placeholder="Ask the Pipeline Assistant... or drop files to include paths"
          value={askInput}
          onChange={(e) => setAskInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk() } }}
        />
        <button
          className="panel-ask-send"
          onClick={handleAsk}
          disabled={!askInput.trim()}
          title="Send to Pipeline Assistant"
        >
          <Send size={13} />
        </button>
        {assistantId && instances.some(i => i.id === assistantId && i.status === 'running') && (
          <button
            className="panel-ask-focus"
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

      <div className={`pipelines-list${listMode ? ' list-mode' : ''}`}>
        {pipelines.map((p) => (
          <div key={p.name} className={`pipeline-card ${p.enabled ? '' : 'disabled'}${expandedPipeline === p.name ? ' expanded' : ''}`}>
            <div className="pipeline-card-header" onClick={() => handleExpand(p)}>
              <div className="pipeline-card-left">
                {expandedPipeline === p.name ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className={`pipeline-status-dot ${p.running ? 'running' : p.enabled ? 'active' : 'inactive'}`} />
                <span className="pipeline-card-name">{p.name}</span>
                {p.running && <span className="pipeline-running-badge">Running</span>}
              </div>
              <div className="pipeline-card-right">
                {p.triggerType !== 'webhook' && <span className="pipeline-card-trigger">{p.triggerType}</span>}
                {p.triggerType === 'webhook' ? (
                  <span className="pipeline-webhook-badge" title="Triggered by HTTP webhook POST">
                    <Globe size={10} /> Webhook
                  </span>
                ) : (
                  <button
                    className="pipeline-cron-badge"
                    title={p.cron ? `Cron: ${p.cron} — click to edit` : 'Click to set cron schedule'}
                    onClick={(e) => { e.stopPropagation(); setCronEditingPipeline(cronEditingPipeline === p.name ? null : p.name) }}
                  >
                    <Clock size={10} />
                    {p.cron ? describeCron(p.cron) : `${p.interval}s`}
                    <Pencil size={9} className="cron-badge-edit-icon" />
                  </button>
                )}
                {p.fireCount > 0 && (
                  <span className="pipeline-card-fires">
                    <Zap size={10} /> {p.fireCount}
                  </span>
                )}
                {listMode && expandedPipeline !== p.name && p.lastFiredAt && (
                  <span className="pipeline-list-last-fired" title={`Last fired: ${new Date(p.lastFiredAt).toLocaleString()}`}>
                    {timeSince(p.lastFiredAt)}
                  </span>
                )}
                {listMode && expandedPipeline !== p.name && p.lastError && (
                  <span className="pipeline-list-error" title={p.lastError}>
                    <AlertTriangle size={9} />
                  </span>
                )}
                <div className="pipeline-header-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    className={`pipeline-action-btn ${p.enabled ? 'enabled' : ''}`}
                    onClick={() => handleToggle(p.name, !p.enabled)}
                    title={p.enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
                  >
                    {p.enabled ? <Zap size={11} /> : <ZapOff size={11} />}
                  </button>
                  {p.enabled && (
                    <button
                      className="pipeline-action-btn"
                      onClick={() => handleTriggerNow(p.name)}
                      title="Poll now (⌘⇧F fires the first enabled pipeline from anywhere)"
                    >
                      <Play size={11} />
                    </button>
                  )}
                  <button
                    className="pipeline-action-btn"
                    onClick={() => handlePreview(p)}
                    title="Dry-run: evaluate conditions without firing"
                  >
                    <Eye size={11} />
                  </button>
                </div>
              </div>
            </div>

            {cronEditingPipeline === p.name && (
              <CronEditor
                value={p.cron ?? ''}
                onSave={async (val) => {
                  await window.api.pipeline.setCron(p.fileName, val || null)
                  setCronEditingPipeline(null)
                }}
                onClose={() => setCronEditingPipeline(null)}
              />
            )}

            {p.description && (
              <div className="pipeline-card-desc">{p.description}</div>
            )}

            <div className="pipeline-card-meta">
              {p.lastPollAt && (
                <span className="pipeline-meta-item" title={`Last polled: ${p.lastPollAt}`}>
                  <Clock size={10} /> Polled {timeSince(p.lastPollAt)}
                </span>
              )}
              {p.lastMatchAt && (
                <span className="pipeline-meta-item" title={`Last condition match: ${p.lastMatchAt}`}>
                  <Search size={10} /> Matched {timeSince(p.lastMatchAt)}
                </span>
              )}
              {p.lastFiredAt && (
                <span className="pipeline-meta-item pipeline-meta-fired" title={`Last fired: ${p.lastFiredAt}`}>
                  <CheckCircle size={10} /> Fired {timeSince(p.lastFiredAt)}
                </span>
              )}
            </div>
            {p.lastError && (
              <div className="pipeline-error-block">
                <AlertTriangle size={10} />
                <span className="pipeline-error-text">{p.lastError}</span>
              </div>
            )}

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
                      <BookOpen size={11} /> Memory
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
                    <button
                      className={`pipeline-tab ${expandedTab === 'history' ? 'active' : ''}`}
                      onClick={() => setExpandedTab('history')}
                    >
                      <Clock size={11} /> History {historyEntries.length > 0 && `(${historyEntries.length})`}
                    </button>
                    <button
                      className={`pipeline-tab ${expandedTab === 'debug' ? 'active' : ''}`}
                      onClick={() => setExpandedTab('debug')}
                    >
                      <List size={11} /> Logs {(p.debugLog?.filter(l => l !== '---').length ?? 0) > 0 && `(${p.debugLog!.filter(l => l !== '---').length})`}
                    </button>
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
                ) : expandedTab === 'history' ? (
                  <div className="pipeline-history">
                    {historyEntries.length === 0 ? (
                      <p className="pipeline-memory-hint">No runs recorded yet. History is captured after each poll.</p>
                    ) : (
                      <div className="pipeline-history-list">
                        {historyEntries.map((entry, i) => {
                          const hasStages = (entry.stages?.length ?? 0) > 1
                          const isExpanded = expandedHistoryRows.has(i)
                          const prevEntry = i > 0 ? historyEntries[i - 1] : null
                          const toggleExpand = () => setExpandedHistoryRows(prev => {
                            const next = new Set(prev)
                            if (next.has(i)) next.delete(i); else next.add(i)
                            return next
                          })
                          return (
                            <div key={i}>
                              <div
                                className={`pipeline-history-row ${entry.success ? '' : 'error'}${hasStages ? ' has-stages' : ''}`}
                                onClick={hasStages ? toggleExpand : undefined}
                              >
                                {hasStages && (
                                  <span className="pipeline-history-chevron">
                                    {isExpanded ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                                  </span>
                                )}
                                <span className={`pipeline-history-icon ${entry.success ? 'success' : 'failure'}`}>
                                  {entry.success ? <CheckCircle size={11} /> : <XCircle size={11} />}
                                </span>
                                <span className="pipeline-history-ts" title={new Date(entry.ts).toLocaleString()}>
                                  {new Date(entry.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} {new Date(entry.ts).toLocaleDateString([], { month: 'short', day: 'numeric' })}
                                </span>
                                <span className="pipeline-history-trigger">{entry.trigger}</span>
                                <span className={`pipeline-history-action ${entry.actionExecuted ? 'fired' : ''}`}>
                                  {entry.actionExecuted ? 'action fired' : 'no action'}
                                </span>
                                <span className="pipeline-history-duration">{entry.durationMs < 1000 ? `${entry.durationMs}ms` : `${(entry.durationMs / 1000).toFixed(1)}s`}</span>
                                {entry.totalCost && entry.totalCost >= 0.01 && <span className="run-cost-badge" title="Total cost of this pipeline run">${entry.totalCost.toFixed(2)}</span>}
                              </div>
                              {hasStages && isExpanded && (
                                <div className="pipeline-history-stages">
                                  {entry.stages!.map((stage, si) => {
                                    const prevStage = prevEntry?.stages?.[si]
                                    const statusChanged = prevStage !== undefined && prevStage.success !== stage.success
                                    const prevStatus = prevStage?.success ? 'PASS' : 'FAIL'
                                    return (
                                    <div key={stage.index}>
                                      <div className={`pipeline-history-stage-row ${stage.success ? '' : 'error'}`}>
                                        <span className={`pipeline-history-icon ${stage.success ? 'success' : 'failure'}`}>
                                          {stage.success ? <CheckCircle size={10} /> : <XCircle size={10} />}
                                        </span>
                                        <span className="pipeline-history-stage-type">
                                          {stage.actionType === 'plan' && <FileText size={9} style={{ marginRight: 3, verticalAlign: 'middle' }} />}
                                          {stage.actionType === 'parallel' && stage.subStages?.length ? `Parallel (${stage.subStages.length})` : stageTypeLabel(stage.actionType)}
                                        </span>
                                        {statusChanged && <span className="pipeline-history-stage-delta" title={`Changed from ${prevStatus} in prior run`}>△</span>}
                                        {stage.sessionName && <span className="pipeline-history-stage-name">{stage.sessionName}</span>}
                                        {stage.responseSnippet && <span className="pipeline-history-stage-snippet" title={stage.responseSnippet}>{stage.responseSnippet.length > 60 ? stage.responseSnippet.slice(0, 60) + '…' : stage.responseSnippet}</span>}
                                        <span className="pipeline-history-duration">{stage.durationMs < 1000 ? `${stage.durationMs}ms` : `${(stage.durationMs / 1000).toFixed(1)}s`}</span>
                                        {stage.error && <span className="pipeline-history-stage-error" title={stage.error}>err</span>}
                                      </div>
                                      {stage.subStages && stage.subStages.length > 0 && (
                                        <div className="pipeline-history-parallel-group">
                                          {stage.subStages.map(sub => (
                                            <div key={sub.index} className={`pipeline-history-stage-row sub ${sub.success ? '' : 'error'}`}>
                                              <span className={`pipeline-history-icon ${sub.success ? 'success' : 'failure'}`}>
                                                {sub.success ? <CheckCircle size={9} /> : <XCircle size={9} />}
                                              </span>
                                              <span className="pipeline-history-stage-type">{stageTypeLabel(sub.actionType)}</span>
                                              {sub.sessionName && <span className="pipeline-history-stage-name">{sub.sessionName}</span>}
                                              <span className="pipeline-history-duration">{sub.durationMs < 1000 ? `${sub.durationMs}ms` : `${(sub.durationMs / 1000).toFixed(1)}s`}</span>
                                              {sub.error && <span className="pipeline-history-stage-error" title={sub.error}>err</span>}
                                            </div>
                                          ))}
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
                    )}
                  </div>
                ) : expandedTab === 'debug' ? (
                  <div className="pipeline-debug-tab">
                    {p.debugLog?.length ? (
                      <pre className="pipeline-debug-log-content">
                        {p.debugLog.slice().reverse().map(l => l === '---' ? '────────────────────────' : l).join('\n')}
                      </pre>
                    ) : (
                      <p className="pipeline-memory-hint">No logs yet. Click "Poll Now" to generate the first entries.</p>
                    )}
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

      {/* Pipeline Preview Modal */}
      {(previewLoading || previewResult) && previewPipelineName && (
        <div className="pipeline-preview-overlay" onClick={() => { setPreviewResult(null); setPreviewPipelineName(null) }}>
          <div className="pipeline-preview-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pipeline-preview-header">
              <Eye size={14} />
              <span>Preview: {previewPipelineName}</span>
              <button className="pipeline-preview-close" onClick={() => { setPreviewResult(null); setPreviewPipelineName(null) }}>
                <X size={14} />
              </button>
            </div>

            {previewLoading ? (
              <div className="pipeline-preview-loading">Evaluating conditions…</div>
            ) : previewResult ? (
              <div className="pipeline-preview-body">
                {previewResult.error ? (
                  <div className="pipeline-preview-error"><XCircle size={13} /> {previewResult.error}</div>
                ) : (
                  <div className={`pipeline-preview-verdict ${previewResult.wouldFire ? 'would-fire' : 'no-fire'}`}>
                    {previewResult.wouldFire
                      ? <><CheckCircle size={13} /> Would fire for {previewResult.matches.filter(m => !m.wouldBeDeduped).length} match(es)</>
                      : <><XCircle size={13} /> Would not fire</>}
                  </div>
                )}

                {previewResult.matches.length > 0 && (
                  <div className="pipeline-preview-matches">
                    <div className="pipeline-preview-section-title">Matches</div>
                    {previewResult.matches.map((m, i) => (
                      <div key={i} className={`pipeline-preview-match ${m.wouldBeDeduped ? 'deduped' : 'active'}`}>
                        <div className="pipeline-preview-match-desc">
                          {m.wouldBeDeduped ? <span className="pipeline-preview-dedup-badge">deduped</span> : null}
                          {m.description}
                        </div>
                        <div className="pipeline-preview-vars">
                          {Object.entries(m.resolvedVars).map(([k, v]) => (
                            <div key={k} className="pipeline-preview-var">
                              <span className="pipeline-preview-var-key">{k}</span>
                              <span className="pipeline-preview-var-val">{v}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="pipeline-preview-log">
                  <button className="pipeline-preview-log-toggle" onClick={() => setPreviewLogOpen(o => !o)}>
                    {previewLogOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                    Condition log ({previewResult.conditionLog.length} entries)
                  </button>
                  {previewLogOpen && <pre>{previewResult.conditionLog.join('\n')}</pre>}
                </div>
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  )
}
