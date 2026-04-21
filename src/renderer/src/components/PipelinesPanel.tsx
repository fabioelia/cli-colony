import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useFileDrop } from '../hooks/useFileDrop'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'
import {
  Zap, ZapOff, Play, RefreshCw, ChevronDown, ChevronRight,
  FileText, Clock, CheckCircle, XCircle, AlertTriangle, Save, BookOpen,
  MessageSquare, Send, Plus, Search, Pencil, Eye, X, LayoutList, LayoutGrid,
  ShieldCheck, List, Globe, Wand2, ArrowRight, ArrowLeft, Hourglass, ArrowUpDown,
  GitPullRequest, GitMerge, GitBranch, Sparkles, RotateCw, Copy, Timer, Activity,
  Download, Upload, PauseCircle, PlayCircle, Check, StickyNote,
} from 'lucide-react'
import type { AuditResult, GitHubRepo, SessionArtifact } from '../../../shared/types'
import HelpPopover from './HelpPopover'
import EmptyStateHook from './EmptyStateHook'
import CronEditor from './CronEditor'
import PipelineFlowDiagram from './PipelineFlowDiagram'
import { describeCron, nextRuns, cronFireTimesForDay } from '../../../shared/cron'
import { slugify } from '../../../shared/utils'
import { firstErrorOf } from '../../../shared/pipeline-stats'
import { parseYaml } from '../../../shared/yaml-parser'

interface RecentRun {
  ts: string
  success: boolean
  actionExecuted: boolean
  error: string | null
}

interface PipelineStats {
  rate: number
  successes: number
  total: number
  recent: RecentRun[]
  cumulativeCost: number
}

function PipelineRunStrip({ recent, compact }: { recent: RecentRun[]; compact?: boolean }) {
  return (
    <div className={`pipeline-run-strip${compact ? ' compact' : ''}`}>
      {recent.map((entry, i) => {
        const cls = entry.success ? 'pass' : entry.actionExecuted ? 'fail' : 'no-action'
        const label = entry.success ? 'success' : entry.actionExecuted ? 'failed' : 'no action'
        const errSnippet = entry.error ? ` (${entry.error.slice(0, 80)}${entry.error.length > 80 ? '…' : ''})` : ''
        const title = `${new Date(entry.ts).toLocaleString()} — ${label}${errSnippet}`
        return <div key={i} className={`pipeline-run-cell ${cls}`} title={title} />
      })}
    </div>
  )
}

interface ActionShape {
  type: string
  name?: string
  stages?: ActionShape[]
}

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
  budget?: { maxCostUsd: number; warnAt: number } | null
  lastRunStoppedBudget?: boolean
  consecutiveFailures?: number
  actionShape?: ActionShape
  firstActionPrompt?: string
  firstActionWorkingDirectory?: string
  firstActionModel?: string
  defaultModel?: string
  runCondition?: string
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
  'wait_for_session': 'Wait Session',
  'trigger_pipeline': 'Trigger Pipeline',
}
function stageTypeLabel(type: string): string {
  return STAGE_TYPE_LABELS[type] ?? type
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const secs = Math.floor(ms / 1000)
  if (secs < 60) return `${secs}s`
  const mins = Math.floor(secs / 60)
  const remainSecs = secs % 60
  return remainSecs > 0 ? `${mins}m ${remainSecs}s` : `${mins}m`
}

const TL_COLORS = [
  '#34d399', '#60a5fa', '#f59e0b', '#f87171', '#a78bfa', '#fb923c',
  '#4ade80', '#38bdf8', '#e879f9', '#facc15',
]

function pipelineColor(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0
  return TL_COLORS[Math.abs(h) % TL_COLORS.length]
}

function PipelineTimeline({ pipelines }: { pipelines: PipelineInfo[] }) {
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem('pipelines-timeline-collapsed') === '1'
  )
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(id)
  }, [])

  const cronItems = pipelines.filter(p => p.enabled && p.cron)
  const pollItems = pipelines.filter(p => p.enabled && !p.cron && (p.triggerType === 'git-poll' || p.triggerType === 'file-poll'))

  if (cronItems.length === 0 && pollItems.length === 0) return null

  const nowPct = ((now.getHours() * 60 + now.getMinutes()) / 1440) * 100

  const rows = cronItems.map(p => {
    const times = cronFireTimesForDay(p.cron!, now)
    return { p, times, isBand: times.length > 24, color: pipelineColor(p.name) }
  })

  const toggle = () => {
    const next = !collapsed
    setCollapsed(next)
    localStorage.setItem('pipelines-timeline-collapsed', next ? '1' : '0')
  }

  return (
    <div className="pipeline-timeline-wrap">
      <button className="pipeline-timeline-toggle" onClick={toggle}>
        {collapsed ? <ChevronRight size={11} /> : <ChevronDown size={11} />}
        <Clock size={11} />
        <span>Schedule — 24h overview</span>
      </button>
      {!collapsed && (
        <div className="pipeline-timeline">
          <div className="pipeline-tl-strip">
            <div
              className="pipeline-tl-now"
              style={{ left: `${nowPct}%` }}
              title={`Now — ${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`}
            />
            {rows.map(({ p, times, isBand, color }) => {
              if (isBand) {
                const hours = [...new Set(times.map(t => t.hour))]
                return hours.map(h => (
                  <div
                    key={`${p.name}-b-${h}`}
                    className="pipeline-tl-band"
                    style={{ left: `${(h / 24) * 100}%`, width: `${100 / 24}%`, backgroundColor: color }}
                    title={`${p.name} — fires at ${h}:xx`}
                  />
                ))
              }
              return times.map((t, i) => {
                const pct = ((t.hour * 60 + t.minute) / 1440) * 100
                const ts = `${t.hour.toString().padStart(2, '0')}:${t.minute.toString().padStart(2, '0')}`
                return (
                  <div
                    key={`${p.name}-${i}`}
                    className="pipeline-tl-dot"
                    style={{ left: `${pct}%`, backgroundColor: color }}
                    title={`${p.name} — ${ts}`}
                  />
                )
              })
            })}
          </div>
          <div className="pipeline-tl-axis">
            {[0, 6, 12, 18].map(h => (
              <div key={h} className="pipeline-tl-label" style={{ left: `${(h / 24) * 100}%` }}>{h}h</div>
            ))}
            <div className="pipeline-tl-label pipeline-tl-label-end">24h</div>
          </div>
          <div className="pipeline-tl-legend">
            {rows.map(({ p, times, isBand, color }) => (
              <span key={p.name} className="pipeline-tl-legend-item" style={{ color }}>
                <span className={isBand ? 'pipeline-tl-legend-band' : 'pipeline-tl-legend-dot'} style={{ backgroundColor: color }} />
                {p.name}
                <span className="pipeline-tl-legend-count">{times.length}×</span>
              </span>
            ))}
          </div>
          {pollItems.length > 0 && (
            <div className="pipeline-tl-polls">
              {pollItems.map(p => {
                const color = pipelineColor(p.name)
                const iv = p.interval >= 3600 ? `${p.interval / 3600}h` : `${Math.round(p.interval / 60)}m`
                return (
                  <span key={p.name} className="pipeline-tl-poll-tag" style={{ borderColor: color, color }}>
                    <Globe size={9} />
                    {p.name} — polls every {iv}
                  </span>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const RUN_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

function RunWithOptionsDialog({ pipelineName, firstActionPrompt, firstActionModel, firstActionWorkingDirectory, budgetMaxCostUsd, onRun, onClose }: {
  pipelineName: string
  firstActionPrompt: string
  firstActionModel?: string
  firstActionWorkingDirectory?: string
  budgetMaxCostUsd?: number
  onRun: (name: string, overrides: { prompt?: string; model?: string; workingDirectory?: string; maxBudget?: number }) => void
  onClose: () => void
}) {
  const [prompt, setPrompt] = useState(firstActionPrompt)
  const [model, setModel] = useState(firstActionModel || '')
  const [workingDirectory, setWorkingDirectory] = useState(firstActionWorkingDirectory || '')
  const [maxBudget, setMaxBudget] = useState(budgetMaxCostUsd != null ? String(budgetMaxCostUsd) : '')
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, prompt, model, workingDirectory, maxBudget])

  const handleRun = () => {
    const budget = parseFloat(maxBudget)
    onRun(pipelineName, {
      prompt: prompt.trim() || undefined,
      model: model || undefined,
      workingDirectory: workingDirectory.trim() || undefined,
      maxBudget: !isNaN(budget) && budget > 0 ? budget : undefined,
    })
  }

  const fieldStyle: React.CSSProperties = { marginBottom: 12 }
  const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }
  const inputStyle: React.CSSProperties = { width: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 8px', fontSize: 12, boxSizing: 'border-box' }

  return (
    <>
      <div style={fieldStyle}>
        <label style={labelStyle}>Prompt</label>
        <textarea
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
          rows={6}
          style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }}
          placeholder="Session prompt — Mustache {{...}} vars resolved at runtime"
          autoFocus
        />
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Model</label>
          <select value={model} onChange={e => setModel(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="">(pipeline default)</option>
            {RUN_MODELS.map(m => <option key={m.id} value={m.id} title={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Budget cap ($)</label>
          <input
            type="number"
            value={maxBudget}
            onChange={e => setMaxBudget(e.target.value)}
            style={inputStyle}
            placeholder="e.g. 2.50"
            min={0}
            step={0.5}
          />
        </div>
      </div>
      <div style={fieldStyle}>
        <label style={labelStyle}>Working directory</label>
        <input
          type="text"
          value={workingDirectory}
          onChange={e => setWorkingDirectory(e.target.value)}
          style={inputStyle}
          placeholder="e.g. ~/projects/my-repo"
        />
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
        Changes apply to this run only — YAML is not modified. Cmd+Enter to run.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ padding: '5px 12px' }}>Cancel</button>
        <button className="panel-header-btn primary" onClick={handleRun} style={{ padding: '5px 12px' }}>Run</button>
      </div>
    </>
  )
}

export default function PipelinesPanel({ onLaunchInstance, onFocusInstance, instances }: Props) {
  const [pipelines, setPipelines] = useState<PipelineInfo[]>([])
  const [expandedPipeline, setExpandedPipeline] = useState<string | null>(null)
  const [pipelineCtx, setPipelineCtx] = useState<{ name: string; fileName: string; enabled: boolean; x: number; y: number } | null>(null)
  const [editingContent, setEditingContent] = useState<string | null>(null)
  const [editingFileName, setEditingFileName] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [readmeContent, setReadmeContent] = useState<string | null>(null)
  const [pipelineMemory, setPipelineMemory] = useState('')
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [outputFiles, setOutputFiles] = useState<Array<{ name: string; path: string; size: number; modified: number }>>([])
  const [outputPreview, setOutputPreview] = useState<{ name: string; content: string } | null>(null)
  const [expandedTab, setExpandedTab] = useState<'yaml' | 'flow' | 'docs' | 'memory' | 'outputs' | 'history' | 'debug'>('yaml')
  type StageTrace = { index: number; actionType: string; sessionName?: string; sessionId?: string; model?: string; autoResolved?: boolean; durationMs: number; startedAt?: number; completedAt?: number; success: boolean; error?: string; responseSnippet?: string; subStages?: StageTrace[] }
  const [historyEntries, setHistoryEntries] = useState<Array<{ ts: string; trigger: string; actionExecuted: boolean; success: boolean; durationMs: number; totalCost?: number; sessionIds?: string[]; stages?: StageTrace[]; dedupAttempt?: number; dedupMaxRetries?: number }>>([])
  const [expandedHistoryRows, setExpandedHistoryRows] = useState<Set<number>>(new Set())
  const [comparedRuns, setComparedRuns] = useState<Set<number>>(new Set())
  const [showComparison, setShowComparison] = useState(false)
  const [historyFilterFailures, setHistoryFilterFailures] = useState(false)
  const [historySearch, setHistorySearch] = useState('')
  const [historyDateRange, setHistoryDateRange] = useState<'today' | '7d' | '30d' | 'all'>('all')
  const [yamlWarning, setYamlWarning] = useState<string | null>(null)
  const [runArtifacts, setRunArtifacts] = useState<Record<string, SessionArtifact[]>>({})
  const [previewSessionId, setPreviewSessionId] = useState<string | null>(null)

  const [triggeringPipelines, setTriggeringPipelines] = useState<Set<string>>(new Set())
  const [retryingFromHistory, setRetryingFromHistory] = useState(false)
  const [runOverrideDialog, setRunOverrideDialog] = useState<{ name: string; firstActionPrompt: string; firstActionModel?: string; firstActionWorkingDirectory?: string; budgetMaxCostUsd?: number } | null>(null)
  const [listMode, setListMode] = useState(() => localStorage.getItem('pipelines-list-mode') !== '0')
  const [sortBy, setSortBy] = useState<'name' | 'lastFired' | 'fireCount' | 'enabled' | 'successRate'>(() =>
    (localStorage.getItem('pipelines-sort') as 'name' | 'lastFired' | 'fireCount' | 'enabled' | 'successRate') || 'name'
  )
  const [healthView, setHealthView] = useState(() => localStorage.getItem('pipelines-health-view') === '1')
  const [pipelineSearch, setPipelineSearch] = useState('')
  const [pipelineStats, setPipelineStats] = useState<Map<string, PipelineStats | null>>(new Map())
  const [cronsPaused, setCronsPaused] = useState(false)

  // 60s tick for next-run countdown refresh
  const [, setTick] = useState(0)
  useEffect(() => { const id = setInterval(() => setTick(t => t + 1), 60000); return () => clearInterval(id) }, [])
  useEffect(() => {
    window.api.colony.getCronsPaused().then(setCronsPaused).catch(() => {})
    return window.api.colony.onCronsPauseChange(setCronsPaused)
  }, [])

  useEffect(() => {
    if (!pipelineCtx) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setPipelineCtx(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [pipelineCtx])

  // Cron editor — tracks which pipeline's cron is being edited
  const [cronEditingPipeline, setCronEditingPipeline] = useState<string | null>(null)
  const [pipelineNotes, setPipelineNotes] = useState<Record<string, Array<{ createdAt: string; text: string }>>>({})
  const [noteOpenPipeline, setNoteOpenPipeline] = useState<string | null>(null)
  const [editingNoteKey, setEditingNoteKey] = useState<{ fileName: string; index: number } | null>(null)
  const [editNoteText, setEditNoteText] = useState('')
  const [noteText, setNoteText] = useState('')

  // Automation Wizard
  type WizardTrigger = 'pr-opened' | 'pr-merged' | 'cron' | 'git-push'
  const [showAutomationWizard, setShowAutomationWizard] = useState(false)
  const [wizardStep, setWizardStep] = useState(1)
  const [wizardTrigger, setWizardTrigger] = useState<WizardTrigger>('cron')
  const [wizardRepos, setWizardRepos] = useState<GitHubRepo[]>([])
  const [wizardSelectedRepo, setWizardSelectedRepo] = useState('')
  const [wizardCron, setWizardCron] = useState('0 9 * * 1-5')
  const [wizardBranch, setWizardBranch] = useState('main')
  const [wizardWorkingDir, setWizardWorkingDir] = useState('~/')
  const [wizardPrompt, setWizardPrompt] = useState('')
  const [wizardModel, setWizardModel] = useState('auto')
  const [wizardName, setWizardName] = useState('')
  const [wizardSubmitting, setWizardSubmitting] = useState(false)
  const [wizardError, setWizardError] = useState('')

  // AI Generate modal
  const [showGenerateModal, setShowGenerateModal] = useState(false)
  const [generateDescription, setGenerateDescription] = useState('')
  const [generateLoading, setGenerateLoading] = useState(false)
  const [generateResult, setGenerateResult] = useState('')
  const [generateError, setGenerateError] = useState('')
  const [generateSaving, setGenerateSaving] = useState(false)

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

  // Fetch success rates + recent run strip (always, not just in health view)
  useEffect(() => {
    if (pipelines.length === 0) return
    let cancelled = false
    const fetchRates = async () => {
      const stats = new Map<string, PipelineStats | null>()
      await Promise.all(pipelines.map(async (p) => {
        try {
          const history = await window.api.pipeline.getHistory(p.name)
          const last10 = history.slice(-10)
          if (last10.length < 3) { stats.set(p.name, null); return }
          const successes = last10.filter(e => e.success).length
          const total = last10.length
          const last20 = history.slice(-20)
          const recent: RecentRun[] = last20.map(e => ({
            ts: e.ts,
            success: e.success,
            actionExecuted: e.actionExecuted,
            error: e.success ? null : firstErrorOf(e),
          }))
          const cumulativeCost = history.reduce((sum, e) => sum + (e.totalCost || 0), 0)
          stats.set(p.name, { rate: Math.round((successes / total) * 100), successes, total, recent, cumulativeCost })
        } catch { stats.set(p.name, null) }
      }))
      if (!cancelled) setPipelineStats(stats)
    }
    fetchRates()
    return () => { cancelled = true }
  }, [pipelines])

  // Fetch one-shot notes for all pipelines
  useEffect(() => {
    if (pipelines.length === 0) return
    let cancelled = false
    const fetchNotes = async () => {
      const entries: Record<string, Array<{ createdAt: string; text: string }>> = {}
      for (const p of pipelines) {
        const notes = await window.api.pipeline.getNotes(p.fileName)
        if (notes.length > 0) entries[p.fileName] = notes
      }
      if (!cancelled) setPipelineNotes(entries)
    }
    fetchNotes()
    return () => { cancelled = true }
  }, [pipelines])

  // Load pipelines dir + last audit run
  useEffect(() => {
    window.api.pipeline.getDir().then(setPipelinesDir)
    window.api.audit.getLastRun('pipelines').then(setAuditLastRun)
  }, [])

  // Load repos when wizard opens
  useEffect(() => {
    if (!showAutomationWizard) return
    window.api.github.getRepos().then(repos => {
      setWizardRepos(repos)
      if (repos.length > 0 && !wizardSelectedRepo) {
        setWizardSelectedRepo(`${repos[0].owner}/${repos[0].name}`)
      }
    })
  }, [showAutomationWizard])

  // Escape to close wizard
  useEffect(() => {
    if (!showAutomationWizard) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setShowAutomationWizard(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [showAutomationWizard])

  // Track if assistant is still alive
  useEffect(() => {
    if (assistantId && !instances.some(i => i.id === assistantId && i.status === 'running')) {
      setAssistantId(null)
    }
  }, [instances, assistantId])

  useEffect(() => {
    for (const idx of expandedHistoryRows) {
      const entry = historyEntries[idx]
      if (!entry?.stages?.length) continue
      const runKey = entry.ts
      if (runArtifacts[runKey]) continue
      const stageSessionIds = new Set<string>()
      entry.stages.forEach(s => {
        if (s.sessionId) stageSessionIds.add(s.sessionId)
        s.subStages?.forEach(sub => { if (sub.sessionId) stageSessionIds.add(sub.sessionId) })
      })
      if (stageSessionIds.size === 0) continue
      Promise.all(Array.from(stageSessionIds).map(sid => window.api.artifacts.get(sid))).then(results => {
        const arts = results.filter((a): a is SessionArtifact => a !== null)
        setRunArtifacts(prev => ({ ...prev, [runKey]: arts }))
      })
    }
  }, [expandedHistoryRows, historyEntries])

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
    if (triggeringPipelines.has(name)) return
    setTriggeringPipelines(prev => new Set(prev).add(name))
    try {
      await window.api.pipeline.triggerNow(name)
    } finally {
      setTriggeringPipelines(prev => { const next = new Set(prev); next.delete(name); return next })
    }
  }

  const handleRunWithOptions = (name: string) => {
    if (triggeringPipelines.has(name)) return
    const pipeline = pipelines.find(p => p.name === name)
    setRunOverrideDialog({
      name,
      firstActionPrompt: pipeline?.firstActionPrompt || '',
      firstActionModel: pipeline?.firstActionModel,
      firstActionWorkingDirectory: pipeline?.firstActionWorkingDirectory,
      budgetMaxCostUsd: pipeline?.budget?.maxCostUsd ?? undefined,
    })
  }

  const handleRunWithOverride = async (name: string, overrides: { prompt?: string; model?: string; workingDirectory?: string; maxBudget?: number }) => {
    setRunOverrideDialog(null)
    if (triggeringPipelines.has(name)) return
    setTriggeringPipelines(prev => new Set(prev).add(name))
    try {
      await window.api.pipeline.triggerNow(name, overrides)
    } finally {
      setTriggeringPipelines(prev => { const next = new Set(prev); next.delete(name); return next })
    }
  }

  const handleRetryFromHistory = async () => {
    const activePipeline = expandedPipeline ? pipelines.find(pl => pl.name === expandedPipeline) : null
    if (!activePipeline || retryingFromHistory) return
    setRetryingFromHistory(true)
    try {
      await window.api.pipeline.triggerNow(activePipeline.name)
    } finally {
      setRetryingFromHistory(false)
      setTimeout(async () => {
        const history = await window.api.pipeline.getHistory(activePipeline.name)
        setHistoryEntries(history.slice().reverse())
      }, 2000)
    }
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

  const handleDuplicate = async (p: PipelineInfo) => {
    const yaml = await window.api.pipeline.getContent(p.fileName)
    if (!yaml) return
    let modified = yaml.replace(/^(name:\s*["']?)(.+?)(["']?\s*)$/m, '$1$2 (copy)$3')
    modified = modified.replace(/^(enabled:\s*)\S+/m, '$1false')
    if (!/^enabled:/m.test(modified)) {
      modified = modified.replace(/^(name:.*)$/m, '$1\nenabled: false')
    }
    const slug = p.fileName.replace(/\.(yaml|yml)$/, '') + '-copy'
    await window.api.pipeline.createFromTemplate(modified, slug)
    await window.api.pipeline.reload()
  }

  const handleAddNote = async (p: PipelineInfo) => {
    if (!noteText.trim()) return
    await window.api.pipeline.addNote(p.fileName, noteText.trim())
    setNoteText('')
    setNoteOpenPipeline(null)
    const notes = await window.api.pipeline.getNotes(p.fileName)
    setPipelineNotes(prev => ({ ...prev, [p.fileName]: notes }))
  }

  const sortedPipelines = useMemo(() => {
    const sorted = [...pipelines]
    switch (sortBy) {
      case 'lastFired':
        sorted.sort((a, b) => (b.lastFiredAt ? new Date(b.lastFiredAt).getTime() : 0) - (a.lastFiredAt ? new Date(a.lastFiredAt).getTime() : 0))
        break
      case 'fireCount':
        sorted.sort((a, b) => b.fireCount - a.fireCount)
        break
      case 'enabled':
        sorted.sort((a, b) => (b.enabled ? 1 : 0) - (a.enabled ? 1 : 0) || a.name.localeCompare(b.name))
        break
      case 'successRate':
        // Low-to-high: problem pipelines first. Nulls (< 3 runs) sort last.
        sorted.sort((a, b) => {
          const ar = pipelineStats.get(a.name)?.rate ?? 101
          const br = pipelineStats.get(b.name)?.rate ?? 101
          return ar - br
        })
        break
      default:
        sorted.sort((a, b) => a.name.localeCompare(b.name))
    }
    return sorted
  }, [pipelines, sortBy, pipelineStats])

  // Health view: sorted by failures desc, then fire count desc
  const healthPipelines = useMemo(() => {
    return [...pipelines].sort((a, b) => {
      const af = a.consecutiveFailures ?? 0
      const bf = b.consecutiveFailures ?? 0
      if (bf !== af) return bf - af
      return b.fireCount - a.fireCount
    })
  }, [pipelines])

  const healthAggregate = useMemo(() => {
    const total = pipelines.length
    const healthy = pipelines.filter(p => (p.consecutiveFailures ?? 0) === 0).length
    const totalFires = pipelines.reduce((s, p) => s + p.fireCount, 0)
    const totalErrors = pipelines.filter(p => (p.consecutiveFailures ?? 0) > 0).length
    return { total, healthy, totalFires, totalErrors }
  }, [pipelines])

  const handleExpand = async (p: PipelineInfo, opts?: { openFailures?: boolean }) => {
    if (expandedPipeline === p.name) {
      if (opts?.openFailures) {
        // Already expanded — just switch to history + set filter
        setExpandedTab('history')
        setHistoryFilterFailures(true)
        return
      }
      if ((dirty || memoryDirty) && !window.confirm('You have unsaved changes. Discard?')) return
      setExpandedPipeline(null)
      setEditingContent(null)
      setEditingFileName(null)
      setReadmeContent(null)
      setDirty(false)
      setComparedRuns(new Set())
      setShowComparison(false)
      setHistoryFilterFailures(false)
      setHistorySearch('')
      setHistoryDateRange('all')
      setYamlWarning(null)
      return
    }
    if ((dirty || memoryDirty) && expandedPipeline) {
      if (!window.confirm('You have unsaved changes. Discard?')) return
    }
    setExpandedPipeline(p.name)
    setComparedRuns(new Set())
    setShowComparison(false)
    setHistoryFilterFailures(opts?.openFailures ?? false)
    setHistorySearch('')
    setHistoryDateRange('all')
    setYamlWarning(null)
    const content = await window.api.pipeline.getContent(p.fileName)
    setEditingContent(content || '')
    setEditingFileName(p.fileName)
    setDirty(false)
    setExpandedTab(opts?.openFailures ? 'history' : 'yaml')

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
    const parsed = parseYaml(editingContent)
    if (!parsed) {
      setYamlWarning('Warning: YAML may contain syntax errors — pipeline may not load correctly')
    } else {
      const missing: string[] = []
      if (!parsed.name) missing.push('name')
      if (!parsed.trigger?.type) missing.push('trigger.type')
      if (!parsed.actions && !parsed.action) missing.push('actions')
      setYamlWarning(missing.length ? `Missing required field${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}` : null)
    }
    await window.api.pipeline.saveContent(editingFileName, editingContent)
    setDirty(false)
    loadPipelines()
  }

  const [reloading, setReloading] = useState<'idle' | 'loading' | 'done' | 'error'>('idle')

  const handleReload = async () => {
    if (reloading === 'loading') return
    setReloading('loading')
    const start = Date.now()
    try {
      await window.api.pipeline.reload()
      await loadPipelines()
      // Keep the spinner visible for at least 300ms — otherwise the fast
      // path flashes imperceptibly and users double-click thinking nothing happened.
      const elapsed = Date.now() - start
      if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed))
      setReloading('done')
      setTimeout(() => setReloading('idle'), 1200)
    } catch {
      setReloading('error')
      setTimeout(() => setReloading('idle'), 1200)
    }
  }

  const handleExport = async () => {
    if (pipelines.length === 0) return
    await window.api.pipeline.export(pipelines.map(p => p.fileName))
  }

  const handleImport = async () => {
    const count = await window.api.pipeline.import()
    if (count > 0) await handleReload()
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

  const openAutomationWizard = () => {
    setWizardStep(1)
    setWizardTrigger('cron')
    setWizardSelectedRepo('')
    setWizardCron('0 9 * * 1-5')
    setWizardBranch('main')
    setWizardWorkingDir('~/')
    setWizardPrompt('')
    setWizardName('')
    setWizardModel('auto')
    setWizardSubmitting(false)
    setWizardError('')
    setShowAutomationWizard(true)
  }

  const buildAutomationYaml = () => {
    const name = wizardName.trim() || 'My Automation'
    let triggerBlock: string
    let description: string

    if (wizardTrigger === 'pr-opened' || wizardTrigger === 'pr-merged') {
      const eventLabel = wizardTrigger === 'pr-opened' ? 'PR opened' : 'PR merged'
      description = `Run automation on ${eventLabel}${wizardSelectedRepo ? ` in ${wizardSelectedRepo}` : ''}`
      triggerBlock = `trigger:\n  type: webhook\n  source: github\n  secret: ""\n  event: pull_request`
      if (wizardSelectedRepo) {
        triggerBlock += `\n  # Webhook URL: http://localhost:7474/webhook/${slugify(name)}`
        triggerBlock += `\n  # Register at: https://github.com/${wizardSelectedRepo}/settings/hooks`
      }
    } else if (wizardTrigger === 'cron') {
      description = `Run automation on schedule: ${wizardCron}`
      triggerBlock = `trigger:\n  type: cron\n  cron: "${wizardCron}"`
    } else {
      description = `Run automation on git push to ${wizardBranch || 'any branch'}`
      triggerBlock = `trigger:\n  type: git-poll\n  interval: 300\n  repos: auto`
      if (wizardBranch) triggerBlock += `\n  # branch filter: ${wizardBranch}`
    }

    const indentedPrompt = wizardPrompt.trim().split('\n').join('\n    ')
    const modelLine = wizardModel ? `  model: ${wizardModel}\n` : ''

    return `name: ${name}
description: ${description}
enabled: true

${triggerBlock}

condition:
  type: always

action:
  type: launch-session
  workingDirectory: "${wizardWorkingDir.trim() || '~/'}"
${modelLine}  prompt: |
    ${indentedPrompt}
`
  }

  const handleAutomationConfirm = async () => {
    const name = wizardName.trim()
    if (!name) return
    setWizardSubmitting(true)
    const yaml = buildAutomationYaml()
    const ok = await window.api.pipeline.createFromTemplate(yaml, slugify(name))
    setWizardSubmitting(false)
    if (ok) {
      setShowAutomationWizard(false)
      loadPipelines()
    } else {
      setWizardError('Failed to create automation — check the pipelines directory is writable.')
    }
  }

  const handleGeneratePipeline = async () => {
    if (!generateDescription.trim()) return
    setGenerateLoading(true)
    setGenerateResult('')
    setGenerateError('')
    const result = await window.api.pipeline.generate(generateDescription)
    setGenerateLoading(false)
    if (!result) {
      setGenerateError('Generation failed. Check the Claude CLI is available.')
    } else {
      setGenerateResult(result)
    }
  }

  const handleGenerateSave = async () => {
    if (!generateResult.trim()) return
    setGenerateSaving(true)
    // Extract name from YAML (first line that looks like `name: ...`)
    const nameMatch = generateResult.match(/^name:\s*(.+)/m)
    const name = nameMatch ? nameMatch[1].trim() : 'generated-pipeline'
    const ok = await window.api.pipeline.createFromTemplate(generateResult, slugify(name))
    setGenerateSaving(false)
    if (ok) {
      setShowGenerateModal(false)
      setGenerateDescription('')
      setGenerateResult('')
      loadPipelines()
    } else {
      setGenerateError('Failed to save pipeline — check the pipelines directory is writable.')
    }
  }

  return (
    <div className="pipelines-panel">
      {runOverrideDialog && (
        <div className="pipeline-preview-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setRunOverrideDialog(null) }}>
          <div className="pipeline-preview-modal" style={{ maxWidth: 520 }}>
            <div className="pipeline-preview-header">
              <Play size={14} />
              <span>Run with Options: {runOverrideDialog.name}</span>
              <button className="pipeline-preview-close" onClick={() => setRunOverrideDialog(null)}>
                <X size={14} />
              </button>
            </div>
            <div style={{ padding: '14px 16px' }}>
              <RunWithOptionsDialog
                pipelineName={runOverrideDialog.name}
                firstActionPrompt={runOverrideDialog.firstActionPrompt}
                firstActionModel={runOverrideDialog.firstActionModel}
                firstActionWorkingDirectory={runOverrideDialog.firstActionWorkingDirectory}
                budgetMaxCostUsd={runOverrideDialog.budgetMaxCostUsd}
                onRun={handleRunWithOverride}
                onClose={() => setRunOverrideDialog(null)}
              />
            </div>
          </div>
        </div>
      )}
      <div className="panel-header">
        <h2><Zap size={16} /> Pipelines</h2>
        <div className="panel-header-spacer" />
        {!healthView && (
          <div className="persona-sort-dropdown">
            <ArrowUpDown size={11} />
            <select value={sortBy} onChange={(e) => { setSortBy(e.target.value as typeof sortBy); localStorage.setItem('pipelines-sort', e.target.value) }}>
              <option value="name">Name</option>
              <option value="lastFired">Last Fired</option>
              <option value="fireCount">Most Active</option>
              <option value="enabled">Enabled First</option>
              <option value="successRate">Success Rate</option>
            </select>
          </div>
        )}
        <div className="panel-search">
          <Search size={13} />
          <input
            placeholder="Search pipelines..."
            value={pipelineSearch}
            onChange={e => setPipelineSearch(e.target.value)}
          />
        </div>
        <HelpPopover topic="pipelines" align="right" />
        <div className="panel-header-actions">
          <button
            className={`panel-header-btn${cronsPaused ? ' active' : ''}`}
            onClick={() => window.api.colony.setCronsPaused(!cronsPaused)}
            title={cronsPaused ? 'Resume all cron jobs' : 'Pause all cron jobs'}
          >
            {cronsPaused ? <PlayCircle size={12} /> : <PauseCircle size={12} />}
            {cronsPaused ? 'Resume All' : 'Pause All'}
          </button>
          <button className="panel-header-btn" onClick={handleExport} title="Export all pipelines as zip">
            <Download size={12} />
          </button>
          <button className="panel-header-btn" onClick={handleImport} title="Import pipelines from zip">
            <Upload size={12} />
          </button>
          <button className="panel-header-btn primary" onClick={openAutomationWizard} title="Create a new automation with a step-by-step wizard">
            <Wand2 size={12} /> New Automation
          </button>
          <button className="panel-header-btn" onClick={() => { setShowGenerateModal(true); setGenerateDescription(''); setGenerateResult(''); setGenerateError('') }} title="Describe a pipeline in plain English and generate YAML with AI">
            <Sparkles size={12} /> AI Generate
          </button>
          <button
            className={`panel-header-btn${healthView ? ' active' : ''}`}
            title={healthView ? 'Switch to pipeline list' : 'Show health dashboard'}
            onClick={() => { const next = !healthView; setHealthView(next); localStorage.setItem('pipelines-health-view', next ? '1' : '0') }}
          >
            <Activity size={13} />
          </button>
          {!healthView && (
            <button
              className={`panel-header-btn${listMode ? ' active' : ''}`}
              title={listMode ? 'Switch to card view' : 'Switch to list view'}
              onClick={() => { const next = !listMode; setListMode(next); localStorage.setItem('pipelines-list-mode', next ? '1' : '0') }}
            >
              {listMode ? <LayoutGrid size={13} /> : <LayoutList size={13} />}
            </button>
          )}
          <button
            className={`panel-header-btn${reloading === 'done' ? ' panel-header-btn--success' : reloading === 'error' ? ' panel-header-btn--error' : ''}`}
            onClick={handleReload}
            disabled={reloading === 'loading'}
            title="Reload all pipeline files"
          >
            <RefreshCw size={12} className={reloading === 'loading' ? 'spin' : ''} />
            {reloading === 'loading' ? 'Reloading…' : reloading === 'done' ? 'Reloaded' : reloading === 'error' ? 'Failed' : 'Reload'}
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

      <PipelineTimeline pipelines={pipelines} />

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
        <EmptyStateHook
          icon={Zap}
          title="Pipelines"
          hook="No pipelines yet. Automate recurring work with triggers and handoffs."
          keyCap="L"
          cta={{ label: 'New Pipeline', onClick: openAutomationWizard }}
        />
      )}

      {healthView && pipelines.length > 0 && (
        <div className="pipeline-health-table">
          <div className="pipeline-health-aggregate">
            {healthAggregate.healthy}/{healthAggregate.total} healthy · {healthAggregate.totalFires} total fires · {healthAggregate.totalErrors} error{healthAggregate.totalErrors !== 1 ? 's' : ''}
          </div>
          <table>
            <thead>
              <tr>
                <th>Pipeline</th>
                <th>Status</th>
                <th>Last Fired</th>
                <th>Fires</th>
                <th>Failures</th>
                <th>Success Rate</th>
                <th>Last Error</th>
              </tr>
            </thead>
            <tbody>
              {healthPipelines.filter(p => !pipelineSearch || p.name.toLowerCase().includes(pipelineSearch.toLowerCase())).map(p => {
                const failures = p.consecutiveFailures ?? 0
                const rate = pipelineStats.get(p.name)
                const lastFiredAgo = p.lastFiredAt ? (() => {
                  const secs = (Date.now() - new Date(p.lastFiredAt!).getTime()) / 1000
                  if (secs < 60) return 'just now'
                  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
                  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
                  return `${Math.floor(secs / 86400)}d ago`
                })() : '—'
                return (
                  <tr
                    key={p.name}
                    className={failures > 0 ? 'health-row-failing' : ''}
                    onClick={() => { setHealthView(false); localStorage.setItem('pipelines-health-view', '0'); handleExpand(p) }}
                  >
                    <td className="health-name">
                      <span className={`pipeline-status-dot ${p.running ? 'running' : p.enabled ? 'active' : 'inactive'}`} />
                      {p.name}
                    </td>
                    <td>{p.enabled ? <span className="health-badge health-enabled">Enabled</span> : <span className="health-badge health-disabled">Off</span>}</td>
                    <td className="health-mono">{lastFiredAgo}</td>
                    <td className="health-mono">{p.fireCount}</td>
                    <td className={`health-mono${failures > 0 ? ' health-failures' : ''}`}>{failures}</td>
                    <td className="health-mono">{rate != null ? `${rate.rate}%` : '—'}</td>
                    <td className="health-error" title={p.lastError ?? undefined}>{p.lastError ? (p.lastError.length > 80 ? p.lastError.slice(0, 80) + '…' : p.lastError) : '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!healthView && <div className={`pipelines-list${listMode ? ' list-mode' : ''}`}>
        {pipelineSearch && sortedPipelines.length > 0 && sortedPipelines.filter(p => p.name.toLowerCase().includes(pipelineSearch.toLowerCase())).length === 0 && (
          <div className="panel-search-empty">No pipelines matching &ldquo;{pipelineSearch}&rdquo;</div>
        )}
        {sortedPipelines.filter(p => !pipelineSearch || p.name.toLowerCase().includes(pipelineSearch.toLowerCase())).map((p) => (
          <div key={p.name} className={`pipeline-card ${p.enabled ? '' : 'disabled'}${expandedPipeline === p.name ? ' expanded' : ''}`}>
            <div className="pipeline-card-header" onClick={() => handleExpand(p)} onContextMenu={(e) => {
              e.preventDefault()
              setPipelineCtx({ name: p.name, fileName: p.fileName, enabled: p.enabled, x: Math.min(e.clientX, window.innerWidth - 180), y: Math.min(e.clientY, window.innerHeight - 200) })
            }}>
              <div className="pipeline-card-left">
                {expandedPipeline === p.name ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <span className={`pipeline-status-dot ${p.running ? 'running' : p.enabled ? 'active' : 'inactive'}`} />
                <span className="pipeline-card-name">{p.name}</span>
                {p.running && <span className="pipeline-running-badge">Running</span>}
                {p.lastRunStoppedBudget && <span className="pipeline-budget-badge" title="Last run stopped: budget limit reached">$ Cap</span>}
                {p.budget && !p.lastRunStoppedBudget && (
                  <span className="pipeline-budget-badge" title={`Budget: $${p.budget.maxCostUsd.toFixed(2)}/run (warn at $${p.budget.warnAt.toFixed(2)})`}>
                    ${p.budget.maxCostUsd < 1 ? p.budget.maxCostUsd.toFixed(2) : p.budget.maxCostUsd.toFixed(0)}
                  </span>
                )}
                {(() => {
                  const stats = pipelineStats.get(p.name)
                  if (!stats) return null
                  const cls = stats.rate >= 80 ? 'good' : stats.rate >= 50 ? 'warn' : 'bad'
                  const clickable = stats.rate < 100
                  return (
                    <>
                      <span
                        className={`pipeline-success-badge ${cls}${clickable ? ' clickable' : ''}`}
                        title={`${stats.successes}/${stats.total} successful (last ${stats.total} runs)${clickable ? ' — click to see failures' : ''}`}
                        onClick={clickable ? (e) => { e.stopPropagation(); handleExpand(p, { openFailures: true }) } : undefined}
                      >
                        {stats.successes}/{stats.total} <Check size={8} />
                      </span>
                      {stats.recent.length >= 5 && (
                        <PipelineRunStrip recent={stats.recent} />
                      )}
                      {stats.cumulativeCost > 0.01 && (
                        <span className="pipeline-cost-badge" title={`Total cost across ${stats.total} runs`}>
                          ${stats.cumulativeCost < 10 ? stats.cumulativeCost.toFixed(2) : stats.cumulativeCost.toFixed(0)}
                        </span>
                      )}
                    </>
                  )
                })()}
              </div>
              <div className="pipeline-card-right">
                {p.actionShape?.type && p.actionShape.type !== 'launch-session' && (
                  <span className="pipeline-action-type" title={`Action type: ${p.actionShape.type}`}>
                    {({ 'maker-checker': 'Maker-Checker', 'diff_review': 'Diff Review', 'best-of-n': 'Best of N', 'parallel': 'Parallel', 'plan': 'Plan', 'wait_for_session': 'Wait', 'trigger_pipeline': 'Trigger Pipeline' } as Record<string, string>)[p.actionShape.type] || p.actionShape.type}
                  </span>
                )}
                {p.triggerType !== 'webhook' && <span className="pipeline-card-trigger">{p.triggerType}</span>}
                {p.runCondition === 'has_changes' && (
                  <span className="pipeline-run-condition" title="Only fires when new commits exist since last run">if changes</span>
                )}
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
                {p.cron && (() => {
                  if (!p.enabled) return <span className="pipeline-next-run paused">Paused</span>
                  if (cronsPaused) return <span className="pipeline-next-run paused">Paused (manual)</span>
                  const fires = nextRuns(p.cron, 1)
                  if (!fires.length) return null
                  const diffMs = fires[0].getTime() - Date.now()
                  if (diffMs < 0) return null
                  const mins = Math.floor(diffMs / 60000)
                  let label: string
                  if (mins < 1) label = '<1m'
                  else if (mins < 60) label = `${mins}m`
                  else if (mins < 1440) label = `${Math.floor(mins / 60)}h ${mins % 60}m`
                  else label = fires[0].toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
                  return <span className="pipeline-next-run" title={`Next fire: ${fires[0].toLocaleString()}`}>Next: {label}</span>
                })()}
                {listMode && expandedPipeline !== p.name && p.lastFiredAt && (
                  <span className="pipeline-list-last-fired" title={`Last fired: ${new Date(p.lastFiredAt).toLocaleString()}`}>
                    {timeSince(p.lastFiredAt)}
                  </span>
                )}
                {listMode && expandedPipeline !== p.name && (() => {
                  const stats = pipelineStats.get(p.name)
                  if (!stats) return null
                  const cls = stats.rate >= 80 ? 'good' : stats.rate >= 50 ? 'warn' : 'bad'
                  const clickable = stats.rate < 100
                  return (
                    <>
                      <span
                        className={`pipeline-success-badge ${cls}${clickable ? ' clickable' : ''}`}
                        title={`${stats.successes}/${stats.total} successful (last ${stats.total} runs)${clickable ? ' — click to see failures' : ''}`}
                        onClick={clickable ? (e) => { e.stopPropagation(); handleExpand(p, { openFailures: true }) } : undefined}
                      >
                        {stats.rate}%
                      </span>
                      {stats.recent.length >= 5 && (
                        <PipelineRunStrip recent={stats.recent} compact />
                      )}
                    </>
                  )
                })()}
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
                      disabled={triggeringPipelines.has(p.name)}
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
                  <button
                    className="pipeline-action-btn"
                    onClick={() => handleDuplicate(p)}
                    title="Duplicate this pipeline"
                  >
                    <Copy size={11} />
                  </button>
                  <button
                    className={`pipeline-action-btn${(pipelineNotes[p.fileName]?.length ?? 0) > 0 ? ' note-active' : ''}`}
                    onClick={() => { setNoteOpenPipeline(noteOpenPipeline === p.name ? null : p.name); setNoteText('') }}
                    title="Leave a one-shot note for the next run"
                  >
                    <StickyNote size={11} />
                    {(pipelineNotes[p.fileName]?.length ?? 0) > 0 && (
                      <span className="pipeline-note-badge">{pipelineNotes[p.fileName].length}</span>
                    )}
                  </button>
                </div>
              </div>
            </div>

            {noteOpenPipeline === p.name && (
              <div className="pipeline-note-bar" onClick={e => e.stopPropagation()}>
                <StickyNote size={13} className="pipeline-note-icon" />
                <textarea
                  className="pipeline-note-input"
                  placeholder="Note for next run… Enter to save, Shift+Enter for newline"
                  value={noteText}
                  onChange={e => setNoteText(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && noteText.trim()) { e.preventDefault(); handleAddNote(p) } }}
                />
                <button
                  className="pipeline-note-send"
                  disabled={!noteText.trim()}
                  onClick={() => handleAddNote(p)}
                >
                  <Send size={12} />
                </button>
              </div>
            )}

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
            {p.defaultModel && (
              <div className="pipeline-card-default-model">
                <span className="pipeline-default-model-chip" title={`Pipeline default model: ${p.defaultModel}. Applied to stages without their own model override.`}>
                  default: {p.defaultModel.replace(/^claude-/, '')}
                </span>
              </div>
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
            {(p.consecutiveFailures ?? 0) > 0 && (
              <div className="pipeline-error-block warning">
                <AlertTriangle size={10} />
                {/* Threshold hardcoded to match CONSECUTIVE_FAILURE_THRESHOLD in pipeline-engine.ts */}
                <span className="pipeline-error-text">{p.consecutiveFailures}/3 consecutive failures</span>
              </div>
            )}

            {expandedPipeline !== p.name && (pipelineNotes[p.fileName]?.length ?? 0) > 0 && (
              <div className="pipeline-notes-preview">
                {pipelineNotes[p.fileName].slice(0, 2).map((n, i) => (
                  <div key={i} className="pipeline-note-entry">
                    <StickyNote size={10} className="pipeline-note-entry-icon" />
                    <span className="pipeline-note-entry-text">{n.text}</span>
                  </div>
                ))}
                {pipelineNotes[p.fileName].length > 2 && (
                  <span className="pipeline-note-more">+{pipelineNotes[p.fileName].length - 2} more</span>
                )}
              </div>
            )}

            {expandedPipeline === p.name && (pipelineNotes[p.fileName]?.length ?? 0) > 0 && (
              <div className="pipeline-notes-list">
                <div className="pipeline-notes-list-header">
                  <StickyNote size={11} />
                  <span>Notes for next run</span>
                  <span className="pipeline-notes-count">{pipelineNotes[p.fileName].length} pending</span>
                </div>
                {pipelineNotes[p.fileName].map((n, i) => (
                  <div key={i} className="pipeline-note-item">
                    <span className="pipeline-note-item-time">{new Date(n.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    {editingNoteKey?.fileName === p.fileName && editingNoteKey.index === i ? (
                      <textarea
                        className="pipeline-note-edit-input"
                        value={editNoteText}
                        placeholder="Shift+Enter for newline"
                        onChange={e => setEditNoteText(e.target.value)}
                        onKeyDown={async e => {
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault()
                            await window.api.pipeline.updateNote(p.fileName, i, editNoteText)
                            const notes = await window.api.pipeline.getNotes(p.fileName)
                            setPipelineNotes(prev => ({ ...prev, [p.fileName]: notes }))
                            setEditingNoteKey(null)
                          }
                          if (e.key === 'Escape') setEditingNoteKey(null)
                        }}
                        autoFocus
                      />
                    ) : (
                      <span className="pipeline-note-item-text">{n.text}</span>
                    )}
                    {!(editingNoteKey?.fileName === p.fileName && editingNoteKey.index === i) && (
                      <button className="pipeline-note-item-edit" title="Edit note" onClick={e => {
                        e.stopPropagation()
                        setEditingNoteKey({ fileName: p.fileName, index: i })
                        setEditNoteText(n.text)
                      }}><Pencil size={10} /></button>
                    )}
                    <button className="pipeline-note-item-delete" onClick={async (e) => {
                      e.stopPropagation()
                      await window.api.pipeline.deleteNote(p.fileName, i)
                      const notes = await window.api.pipeline.getNotes(p.fileName)
                      setPipelineNotes(prev => {
                        if (notes.length === 0) {
                          const copy = { ...prev }
                          delete copy[p.fileName]
                          return copy
                        }
                        return { ...prev, [p.fileName]: notes }
                      })
                    }} title="Remove this note"><X size={10} /></button>
                  </div>
                ))}
              </div>
            )}

            {expandedPipeline === p.name && editingContent !== null && (
              <div className="pipeline-editor">
                <div className="pipeline-editor-header">
                  <div className="pipeline-editor-tabs">
                    <button
                      className={`pipeline-tab ${expandedTab === 'yaml' ? 'active' : ''}`}
                      onClick={() => { setExpandedTab('yaml'); setComparedRuns(new Set()); setShowComparison(false) }}
                    >
                      <FileText size={11} /> Config
                    </button>
                    <button
                      className={`pipeline-tab ${expandedTab === 'flow' ? 'active' : ''}`}
                      onClick={() => { setExpandedTab('flow'); setComparedRuns(new Set()); setShowComparison(false) }}
                    >
                      <GitBranch size={11} /> Flow
                    </button>
                    <button
                      className={`pipeline-tab ${expandedTab === 'memory' ? 'active' : ''}`}
                      onClick={() => { setExpandedTab('memory'); setComparedRuns(new Set()); setShowComparison(false) }}
                    >
                      <BookOpen size={11} /> Memory
                    </button>
                    {p.outputsDir && (
                      <button
                        className={`pipeline-tab ${expandedTab === 'outputs' ? 'active' : ''}`}
                        onClick={() => { setExpandedTab('outputs'); setComparedRuns(new Set()); setShowComparison(false) }}
                      >
                        <FileText size={11} /> Outputs {outputFiles.length > 0 && `(${outputFiles.length})`}
                      </button>
                    )}
                    {readmeContent && (
                      <button
                        className={`pipeline-tab ${expandedTab === 'docs' ? 'active' : ''}`}
                        onClick={() => { setExpandedTab('docs'); setComparedRuns(new Set()); setShowComparison(false) }}
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
                      onClick={() => { setExpandedTab('debug'); setComparedRuns(new Set()); setShowComparison(false) }}
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
                  <>
                    <textarea
                      className="pipeline-editor-textarea"
                      value={editingContent}
                      onChange={(e) => { setEditingContent(e.target.value); setDirty(true); setYamlWarning(null) }}
                      spellCheck={false}
                    />
                    {yamlWarning && (
                      <div className="pipeline-yaml-warning">
                        <AlertTriangle size={11} /> {yamlWarning}
                      </div>
                    )}
                  </>
                ) : expandedTab === 'flow' ? (
                  <PipelineFlowDiagram
                    actionShape={p.actionShape}
                    triggerType={p.triggerType}
                    cron={p.cron}
                    running={p.running}
                    lastHistory={historyEntries[0]}
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
                      Learnings from previous runs. Maker learnings and review rules are injected into both maker and checker prompts automatically. Use <code>--- Review Rules ---</code> to separate checker-specific rules.
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
                      <>
                        {(() => {
                          const failureCount = historyEntries.filter(e => !e.success).length
                          return (
                            <div className="pipeline-history-filter-bar">
                              <button
                                className={`panel-header-btn${historyFilterFailures ? ' active' : ''}`}
                                onClick={() => setHistoryFilterFailures(f => !f)}
                              >
                                Failures only ({failureCount})
                              </button>
                              <input
                                className="pipeline-history-search"
                                placeholder="Search history..."
                                value={historySearch}
                                onChange={e => setHistorySearch(e.target.value)}
                              />
                              <div className="pipeline-history-date-filter">
                                {(['all', 'today', '7d', '30d'] as const).map(range => (
                                  <button
                                    key={range}
                                    className={`panel-header-btn${historyDateRange === range ? ' active' : ''}`}
                                    onClick={() => setHistoryDateRange(range)}
                                  >
                                    {range === 'all' ? 'All' : range === 'today' ? 'Today' : range}
                                  </button>
                                ))}
                              </div>
                            </div>
                          )
                        })()}
                        {comparedRuns.size > 0 && (
                          <div className="pipeline-comparison-toolbar">
                            <span className="pipeline-comparison-toolbar-label">{comparedRuns.size} selected</span>
                            {comparedRuns.size === 2 && (
                              <button className="panel-header-btn primary" onClick={() => setShowComparison(true)}>
                                <ArrowUpDown size={11} /> Compare
                              </button>
                            )}
                            <button className="panel-header-btn" onClick={() => { setComparedRuns(new Set()); setShowComparison(false) }}>
                              Clear
                            </button>
                          </div>
                        )}
                        <div className="pipeline-history-list">
                          {(() => {
                            const indexed = historyEntries.map((e, i) => ({ e, i }))
                            let filtered = historyFilterFailures ? indexed.filter(({ e }) => !e.success) : indexed
                            if (historySearch.trim()) {
                              const q = historySearch.toLowerCase()
                              filtered = filtered.filter(({ e }) =>
                                e.trigger?.toLowerCase().includes(q) ||
                                e.stages?.some(s => s.error?.toLowerCase().includes(q))
                              )
                            }
                            if (historyDateRange !== 'all') {
                              const now = Date.now()
                              const cutoff = historyDateRange === 'today' ? new Date().setHours(0,0,0,0)
                                : historyDateRange === '7d' ? now - 7 * 86400000
                                : now - 30 * 86400000
                              filtered = filtered.filter(({ e }) => new Date(e.ts).getTime() >= cutoff)
                            }
                            if (filtered.length === 0) {
                              return <p className="pipeline-memory-hint">No matching runs{historyFilterFailures ? ' (failures only)' : ''}{historySearch ? ` for "${historySearch}"` : ''}{historyDateRange !== 'all' ? historyDateRange === 'today' ? ' today' : ` in the last ${historyDateRange === '7d' ? '7 days' : '30 days'}` : ''}.</p>
                            }
                            return filtered.map(({ e: entry, i }) => {
                            const hasStages = (entry.stages?.length ?? 0) >= 1
                            const isExpanded = expandedHistoryRows.has(i)
                            const isChecked = comparedRuns.has(i)
                            const prevEntry = i > 0 ? historyEntries[i - 1] : null
                            const toggleExpand = () => setExpandedHistoryRows(prev => {
                              const next = new Set(prev)
                              if (next.has(i)) next.delete(i); else next.add(i)
                              return next
                            })
                            const toggleCompare = (e: React.MouseEvent) => {
                              e.stopPropagation()
                              setComparedRuns(prev => {
                                const next = new Set(prev)
                                if (next.has(i)) {
                                  next.delete(i)
                                  if (next.size === 0) setShowComparison(false)
                                } else {
                                  if (next.size >= 2) {
                                    // deselect oldest (smallest index)
                                    const oldest = Math.min(...Array.from(next))
                                    next.delete(oldest)
                                  }
                                  next.add(i)
                                }
                                return next
                              })
                            }
                            const firstErr = !entry.success && hasStages && !isExpanded ? firstErrorOf(entry) : null
                            return (
                              <div key={i}>
                                <div
                                  className={`pipeline-history-row ${entry.success ? '' : 'error'}${hasStages ? ' has-stages' : ''}${isChecked ? ' compared' : ''}`}
                                  onClick={hasStages ? toggleExpand : undefined}
                                >
                                  <input
                                    type="checkbox"
                                    className="pipeline-comparison-check"
                                    checked={isChecked}
                                    onClick={toggleCompare}
                                    onChange={() => {/* controlled via onClick */}}
                                  />
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
                                  {entry.totalCost != null && (
                                    <span className={`pipeline-history-cost${entry.totalCost > 1 ? ' high' : entry.totalCost < 0.10 ? ' low' : ''}`}>
                                      ${entry.totalCost.toFixed(2)}
                                    </span>
                                  )}
                                  {entry.sessionIds && entry.sessionIds.length > 0 && (
                                    <span className="pipeline-history-sessions">
                                      {entry.sessionIds.length} sess
                                    </span>
                                  )}
                                  {entry.dedupAttempt != null && entry.dedupMaxRetries != null && (
                                    <span className="pipeline-history-retry-badge" title={`Auto-retry: attempt ${entry.dedupAttempt! + 1} of ${entry.dedupMaxRetries! + 1}`}>
                                      {entry.dedupAttempt + 1}/{entry.dedupMaxRetries + 1}
                                    </span>
                                  )}
                                  {p.budget && entry.totalCost != null && (
                                    <div className="pipeline-budget-bar" title={`$${entry.totalCost.toFixed(2)} of $${p.budget.maxCostUsd.toFixed(2)} budget`}>
                                      <div
                                        className="pipeline-budget-bar-fill"
                                        style={{ width: `${Math.min(100, (entry.totalCost / p.budget.maxCostUsd) * 100).toFixed(1)}%`, background: entry.totalCost >= p.budget.maxCostUsd ? 'var(--danger)' : entry.totalCost >= p.budget.warnAt ? 'var(--warning)' : 'var(--accent)' }}
                                      />
                                    </div>
                                  )}
                                  {!entry.success && (
                                    <button
                                      className="pipeline-history-retry-btn"
                                      title="Retry this pipeline"
                                      onClick={(e) => { e.stopPropagation(); handleRetryFromHistory() }}
                                      disabled={retryingFromHistory}
                                    >
                                      <RefreshCw size={11} className={retryingFromHistory ? 'spin' : ''} />
                                    </button>
                                  )}
                                </div>
                                {!entry.success && !isExpanded && entry.actionExecuted && (
                                  firstErr
                                    ? <div
                                        className="pipeline-history-error-line"
                                        title={firstErr}
                                        onClick={hasStages ? toggleExpand : undefined}
                                      >
                                        {firstErr.length > 120 ? firstErr.slice(0, 120) + '…' : firstErr}
                                      </div>
                                    : <div className="pipeline-history-error-line no-error">action failed (no error captured)</div>
                                )}
                                {hasStages && isExpanded && (() => {
                                  const totalDuration = entry.stages!.reduce((sum, s) => sum + s.durationMs, 0)
                                  const hasTimingData = entry.stages!.some(s => s.startedAt != null)
                                  return (
                                  <div className="pipeline-history-stages">
                                    {hasTimingData && (
                                      <div className="stage-timing-total">Total: {formatDuration(totalDuration)}</div>
                                    )}
                                    {entry.stages!.map((stage, si) => {
                                      const prevStage = prevEntry?.stages?.[si]
                                      const statusChanged = prevStage !== undefined && prevStage.success !== stage.success
                                      const prevStatus = prevStage?.success ? 'PASS' : 'FAIL'
                                      const barWidth = totalDuration > 0 ? Math.max(2, Math.min((stage.durationMs / totalDuration) * 200, 200)) : 2
                                      return (
                                      <div key={stage.index}>
                                        <div className={`pipeline-history-stage-row ${stage.success ? '' : 'error'}`}>
                                          <span className={`pipeline-history-icon ${stage.success ? 'success' : 'failure'}`}>
                                            {stage.success ? <CheckCircle size={10} /> : <XCircle size={10} />}
                                          </span>
                                          <span className="pipeline-history-stage-type">
                                            {stage.actionType === 'plan' && <FileText size={9} style={{ marginRight: 3, verticalAlign: 'middle' }} />}
                                            {stage.actionType === 'wait_for_session' && <Hourglass size={9} style={{ marginRight: 3, verticalAlign: 'middle' }} />}
                                            {stage.actionType === 'parallel' && stage.subStages?.length ? `Parallel (${stage.subStages.length})` : stageTypeLabel(stage.actionType)}
                                          </span>
                                          {statusChanged && <span className="pipeline-history-stage-delta" title={`Changed from ${prevStatus} in prior run`}>△</span>}
                                          {stage.sessionName && (stage.sessionId && instances.some(i => i.id === stage.sessionId)
                                            ? <span className="pipeline-history-stage-name pipeline-session-link" onClick={(e) => { e.stopPropagation(); onFocusInstance(stage.sessionId!) }}>{stage.sessionName}</span>
                                            : stage.sessionId
                                              ? <span className="pipeline-history-stage-name pipeline-session-link ended" onClick={(e) => { e.stopPropagation(); setPreviewSessionId(prev => prev === stage.sessionId ? null : stage.sessionId!) }}>{stage.sessionName}<Eye size={10} style={{ marginLeft: 3, opacity: 0.6, verticalAlign: 'middle' }} /></span>
                                              : <span className="pipeline-history-stage-name">{stage.sessionName}</span>
                                          )}
                                          {stage.model && <span className="pipeline-history-stage-model" title={stage.model}>· {stage.model.replace(/^claude-/, '').split('-')[0]}{stage.autoResolved ? ' · auto' : ''}</span>}
                                          {stage.responseSnippet && <span className="pipeline-history-stage-snippet" title={stage.responseSnippet}>{stage.responseSnippet.length > 60 ? stage.responseSnippet.slice(0, 60) + '…' : stage.responseSnippet}</span>}
                                          <span className="pipeline-history-duration">{stage.durationMs < 1000 ? `${stage.durationMs}ms` : `${(stage.durationMs / 1000).toFixed(1)}s`}</span>
                                          {stage.error && <span className="pipeline-history-stage-error" title={stage.error}>err</span>}
                                        </div>
                                        {stage.startedAt != null && (
                                          <div className="stage-duration-bar-row">
                                            <div className="stage-duration-bar" style={{ width: barWidth }} />
                                          </div>
                                        )}
                                        {previewSessionId === stage.sessionId && (() => {
                                          const art = runArtifacts[entry.ts]?.find(a => a.sessionId === stage.sessionId)
                                          if (!art) return (
                                            <div className="pipeline-session-preview empty">
                                              No artifact recorded for this session.
                                            </div>
                                          )
                                          return (
                                            <div className="pipeline-session-preview">
                                              <div className="pipeline-session-preview-summary">{art.summary}</div>
                                              <div className="pipeline-session-preview-meta">
                                                <span title="Duration">{art.durationMs < 60000 ? `${(art.durationMs / 1000).toFixed(0)}s` : `${(art.durationMs / 60000).toFixed(1)}m`}</span>
                                                {art.costUsd != null && <span title="Cost">${art.costUsd.toFixed(3)}</span>}
                                                <span title="Exit code" style={art.exitCode !== 0 ? { color: 'var(--danger)' } : undefined}>exit {art.exitCode}</span>
                                                {art.commits.length > 0 && <span>{art.commits.length} commit{art.commits.length > 1 ? 's' : ''}</span>}
                                                {art.totalInsertions + art.totalDeletions > 0 && (
                                                  <span className="pipeline-session-preview-diff">+{art.totalInsertions} −{art.totalDeletions}</span>
                                                )}
                                              </div>
                                              {art.commits.length > 0 && (
                                                <div className="pipeline-session-preview-commits">
                                                  {art.commits.slice(0, 5).map(c => (
                                                    <div key={c.hash} className="pipeline-session-preview-commit">
                                                      <code>{c.hash.slice(0, 7)}</code> {c.shortMsg}
                                                    </div>
                                                  ))}
                                                </div>
                                              )}
                                              <button
                                                className="pipeline-session-preview-resume"
                                                disabled={!art.claudeSessionId}
                                                title={art.claudeSessionId ? `Resume session in ${art.workingDirectory}` : 'Claude session ID not available (pre-feature session)'}
                                                onClick={(e) => {
                                                  e.stopPropagation()
                                                  onLaunchInstance({
                                                    name: `Resume: ${art.sessionName}`,
                                                    workingDirectory: art.workingDirectory,
                                                    args: ['--resume', art.claudeSessionId!],
                                                  })
                                                }}
                                              >
                                                <Play size={11} /> Resume
                                              </button>
                                            </div>
                                          )
                                        })()}
                                        {stage.subStages && stage.subStages.length > 0 && (
                                          <div className="pipeline-history-parallel-group">
                                            {stage.subStages.map(sub => (
                                              <div key={sub.index}>
                                                <div className={`pipeline-history-stage-row sub ${sub.success ? '' : 'error'}`}>
                                                  <span className={`pipeline-history-icon ${sub.success ? 'success' : 'failure'}`}>
                                                    {sub.success ? <CheckCircle size={9} /> : <XCircle size={9} />}
                                                  </span>
                                                  <span className="pipeline-history-stage-type">{stageTypeLabel(sub.actionType)}</span>
                                                  {sub.sessionName && (sub.sessionId && instances.some(i => i.id === sub.sessionId)
                                                    ? <span className="pipeline-history-stage-name pipeline-session-link" onClick={(e) => { e.stopPropagation(); onFocusInstance(sub.sessionId!) }}>{sub.sessionName}</span>
                                                    : sub.sessionId
                                                      ? <span className="pipeline-history-stage-name pipeline-session-link ended" onClick={(e) => { e.stopPropagation(); setPreviewSessionId(prev => prev === sub.sessionId ? null : sub.sessionId!) }}>{sub.sessionName}<Eye size={10} style={{ marginLeft: 3, opacity: 0.6, verticalAlign: 'middle' }} /></span>
                                                      : <span className="pipeline-history-stage-name">{sub.sessionName}</span>
                                                  )}
                                                  <span className="pipeline-history-duration">{sub.durationMs < 1000 ? `${sub.durationMs}ms` : `${(sub.durationMs / 1000).toFixed(1)}s`}</span>
                                                  {sub.error && <span className="pipeline-history-stage-error" title={sub.error}>err</span>}
                                                </div>
                                                {previewSessionId === sub.sessionId && (() => {
                                                  const art = runArtifacts[entry.ts]?.find(a => a.sessionId === sub.sessionId)
                                                  if (!art) return (
                                                    <div className="pipeline-session-preview empty">
                                                      No artifact recorded for this session.
                                                    </div>
                                                  )
                                                  return (
                                                    <div className="pipeline-session-preview">
                                                      <div className="pipeline-session-preview-summary">{art.summary}</div>
                                                      <div className="pipeline-session-preview-meta">
                                                        <span title="Duration">{art.durationMs < 60000 ? `${(art.durationMs / 1000).toFixed(0)}s` : `${(art.durationMs / 60000).toFixed(1)}m`}</span>
                                                        {art.costUsd != null && <span title="Cost">${art.costUsd.toFixed(3)}</span>}
                                                        <span title="Exit code" style={art.exitCode !== 0 ? { color: 'var(--danger)' } : undefined}>exit {art.exitCode}</span>
                                                        {art.commits.length > 0 && <span>{art.commits.length} commit{art.commits.length > 1 ? 's' : ''}</span>}
                                                        {art.totalInsertions + art.totalDeletions > 0 && (
                                                          <span className="pipeline-session-preview-diff">+{art.totalInsertions} −{art.totalDeletions}</span>
                                                        )}
                                                      </div>
                                                      {art.commits.length > 0 && (
                                                        <div className="pipeline-session-preview-commits">
                                                          {art.commits.slice(0, 5).map(c => (
                                                            <div key={c.hash} className="pipeline-session-preview-commit">
                                                              <code>{c.hash.slice(0, 7)}</code> {c.shortMsg}
                                                            </div>
                                                          ))}
                                                        </div>
                                                      )}
                                                      <button
                                                        className="pipeline-session-preview-resume"
                                                        disabled={!art.claudeSessionId}
                                                        title={art.claudeSessionId ? `Resume session in ${art.workingDirectory}` : 'Claude session ID not available (pre-feature session)'}
                                                        onClick={(e) => {
                                                          e.stopPropagation()
                                                          onLaunchInstance({
                                                            name: `Resume: ${art.sessionName}`,
                                                            workingDirectory: art.workingDirectory,
                                                            args: ['--resume', art.claudeSessionId!],
                                                          })
                                                        }}
                                                      >
                                                        <Play size={11} /> Resume
                                                      </button>
                                                    </div>
                                                  )
                                                })()}
                                              </div>
                                            ))}
                                          </div>
                                        )}
                                      </div>
                                      )
                                    })}
                                  </div>
                                  )
                                })()}
                              </div>
                            )
                          })
                          })()}
                        </div>
                        {showComparison && comparedRuns.size === 2 && (() => {
                          const [idxA, idxB] = Array.from(comparedRuns).sort((a, b) => {
                            const tsA = new Date(historyEntries[a].ts).getTime()
                            const tsB = new Date(historyEntries[b].ts).getTime()
                            return tsA - tsB
                          })
                          const earlier = historyEntries[idxA]
                          const later = historyEntries[idxB]
                          const durDelta = later.durationMs - earlier.durationMs
                          const hasCost = earlier.totalCost != null && later.totalCost != null
                          const costDelta = hasCost ? later.totalCost! - earlier.totalCost! : 0
                          const stageCount = Math.max(earlier.stages?.length ?? 0, later.stages?.length ?? 0)
                          return (
                            <div className="pipeline-comparison">
                              <div className="pipeline-comparison-header">
                                <ArrowUpDown size={12} />
                                <span>Run Comparison</span>
                                <button className="panel-header-btn" onClick={() => setShowComparison(false)}>
                                  <X size={11} />
                                </button>
                              </div>
                              <div className="pipeline-comparison-summary">
                                <div className="pipeline-comparison-summary-run">
                                  <span className="pipeline-comparison-label">Earlier</span>
                                  <span className="pipeline-comparison-ts">{new Date(earlier.ts).toLocaleString()}</span>
                                  <span className={`pipeline-comparison-status ${earlier.success ? 'success' : 'failure'}`}>
                                    {earlier.success ? <CheckCircle size={10} /> : <XCircle size={10} />}
                                    {earlier.success ? 'passed' : 'failed'}
                                  </span>
                                </div>
                                <div className="pipeline-comparison-arrow"><ArrowRight size={12} /></div>
                                <div className="pipeline-comparison-summary-run">
                                  <span className="pipeline-comparison-label">Later</span>
                                  <span className="pipeline-comparison-ts">{new Date(later.ts).toLocaleString()}</span>
                                  <span className={`pipeline-comparison-status ${later.success ? 'success' : 'failure'}`}>
                                    {later.success ? <CheckCircle size={10} /> : <XCircle size={10} />}
                                    {later.success ? 'passed' : 'failed'}
                                  </span>
                                </div>
                              </div>
                              <div className="pipeline-comparison-metrics">
                                <div className="pipeline-comparison-metric">
                                  <span className="pipeline-comparison-metric-label">Duration</span>
                                  <span className="pipeline-comparison-metric-val">{formatDuration(earlier.durationMs)}</span>
                                  <span className="pipeline-comparison-metric-sep">→</span>
                                  <span className="pipeline-comparison-metric-val">{formatDuration(later.durationMs)}</span>
                                  <span className={`pipeline-comparison-delta ${durDelta > 0 ? 'positive' : durDelta < 0 ? 'negative' : ''}`}>
                                    {durDelta === 0 ? '±0' : `${durDelta > 0 ? '+' : ''}${formatDuration(Math.abs(durDelta))}`}
                                  </span>
                                </div>
                                {hasCost && (
                                  <div className="pipeline-comparison-metric">
                                    <span className="pipeline-comparison-metric-label">Cost</span>
                                    <span className="pipeline-comparison-metric-val">${earlier.totalCost!.toFixed(4)}</span>
                                    <span className="pipeline-comparison-metric-sep">→</span>
                                    <span className="pipeline-comparison-metric-val">${later.totalCost!.toFixed(4)}</span>
                                    <span className={`pipeline-comparison-delta ${costDelta > 0 ? 'positive' : costDelta < 0 ? 'negative' : ''}`}>
                                      {costDelta === 0 ? '±0' : `${costDelta > 0 ? '+' : ''}$${Math.abs(costDelta).toFixed(4)}`}
                                    </span>
                                  </div>
                                )}
                                {earlier.success !== later.success && (
                                  <div className="pipeline-comparison-metric">
                                    <span className="pipeline-comparison-metric-label">Result</span>
                                    <span className={`pipeline-comparison-metric-val ${earlier.success ? 'success' : 'failure'}`}>{earlier.success ? 'pass' : 'fail'}</span>
                                    <span className="pipeline-comparison-metric-sep">→</span>
                                    <span className={`pipeline-comparison-metric-val ${later.success ? 'success' : 'failure'}`}>{later.success ? 'pass' : 'fail'}</span>
                                    <span className={`pipeline-comparison-delta ${later.success ? 'negative' : 'positive'}`}>{later.success ? 'fixed' : 'regressed'}</span>
                                  </div>
                                )}
                              </div>
                              {stageCount > 0 && (
                                <div className="pipeline-comparison-stages">
                                  <div className="pipeline-comparison-stages-header">
                                    <span className="pipeline-comparison-col-stage">Stage</span>
                                    <span className="pipeline-comparison-col-run">Earlier</span>
                                    <span className="pipeline-comparison-col-run">Later</span>
                                    <span className="pipeline-comparison-col-delta">Delta</span>
                                  </div>
                                  {Array.from({ length: stageCount }, (_, si) => {
                                    const stA = earlier.stages?.[si]
                                    const stB = later.stages?.[si]
                                    const stageDurDelta = stA && stB ? stB.durationMs - stA.durationMs : null
                                    const statusChanged = stA !== undefined && stB !== undefined && stA.success !== stB.success
                                    const stageName = stA?.sessionName ?? stB?.sessionName ?? stageTypeLabel(stA?.actionType ?? stB?.actionType ?? '')
                                    const snippetA = stA?.responseSnippet
                                    const snippetB = stB?.responseSnippet
                                    return (
                                      <div key={si} className={`pipeline-comparison-stage-row${statusChanged ? ' pipeline-comparison-stage-changed' : ''}`}>
                                        <span className="pipeline-comparison-col-stage" title={stageName}>{stageName || `Stage ${si + 1}`}</span>
                                        <span className="pipeline-comparison-col-run">
                                          {stA ? (
                                            <>
                                              <span className={`pipeline-history-icon ${stA.success ? 'success' : 'failure'}`}>{stA.success ? <CheckCircle size={9} /> : <XCircle size={9} />}</span>
                                              <span>{formatDuration(stA.durationMs)}</span>
                                            </>
                                          ) : <span className="pipeline-comparison-missing">—</span>}
                                        </span>
                                        <span className="pipeline-comparison-col-run">
                                          {stB ? (
                                            <>
                                              <span className={`pipeline-history-icon ${stB.success ? 'success' : 'failure'}`}>{stB.success ? <CheckCircle size={9} /> : <XCircle size={9} />}</span>
                                              <span>{formatDuration(stB.durationMs)}</span>
                                            </>
                                          ) : <span className="pipeline-comparison-missing">—</span>}
                                        </span>
                                        <span className="pipeline-comparison-col-delta">
                                          {stageDurDelta !== null ? (
                                            <span className={`pipeline-comparison-delta ${stageDurDelta > 0 ? 'positive' : stageDurDelta < 0 ? 'negative' : ''}`}>
                                              {stageDurDelta === 0 ? '±0' : `${stageDurDelta > 0 ? '+' : ''}${formatDuration(Math.abs(stageDurDelta))}`}
                                            </span>
                                          ) : '—'}
                                        </span>
                                        {(snippetA || snippetB) && (
                                          <details className="pipeline-comparison-snippet-details">
                                            <summary>response</summary>
                                            {snippetA && <div className="pipeline-comparison-snippet"><span className="pipeline-comparison-label">Earlier:</span> {snippetA}</div>}
                                            {snippetB && <div className="pipeline-comparison-snippet"><span className="pipeline-comparison-label">Later:</span> {snippetB}</div>}
                                          </details>
                                        )}
                                      </div>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        })()}
                      </>
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
      </div>}

      {/* AI Generate Pipeline Modal */}
      {showGenerateModal && (
        <div className="pipeline-preview-overlay" onClick={() => setShowGenerateModal(false)}>
          <div className="pipeline-preview-modal automation-wizard-modal" onClick={(e) => e.stopPropagation()}>
            <div className="pipeline-preview-header">
              <Sparkles size={14} />
              <span>Generate Pipeline with AI</span>
              <button className="pipeline-preview-close" onClick={() => setShowGenerateModal(false)}>
                <X size={14} />
              </button>
            </div>
            <div className="automation-wizard-body">
              {!generateResult ? (
                <div className="automation-wizard-step-content">
                  <p className="automation-wizard-section-label">Describe what you want this pipeline to do</p>
                  <textarea
                    className="automation-wizard-textarea"
                    value={generateDescription}
                    onChange={(e) => setGenerateDescription(e.target.value)}
                    placeholder="e.g. Run every night: check for outdated npm packages and write a summary to outputs/dep-audit.md&#10;&#10;e.g. When a PR is opened: review the diff for security issues and post findings as a comment&#10;&#10;Press Shift+Enter for new lines"
                    rows={6}
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleGeneratePipeline() } }}
                  />
                  {generateError && (
                    <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>{generateError}</p>
                  )}
                </div>
              ) : (
                <div className="automation-wizard-step-content">
                  <p className="automation-wizard-section-label">Generated pipeline YAML — review and edit before saving</p>
                  <textarea
                    className="pipeline-editor-textarea"
                    value={generateResult}
                    onChange={(e) => setGenerateResult(e.target.value)}
                    spellCheck={false}
                    style={{ minHeight: '260px' }}
                  />
                  {generateError && (
                    <p style={{ fontSize: 11, color: 'var(--danger)', marginTop: 6 }}>{generateError}</p>
                  )}
                  <p className="automation-wizard-hint">
                    Edit the YAML above if needed, then click Save to write it to <code>~/.claude-colony/pipelines/</code>.
                  </p>
                </div>
              )}
            </div>
            <div className="automation-wizard-footer">
              {generateResult && (
                <button className="panel-header-btn" onClick={() => { setGenerateResult(''); setGenerateError('') }}>
                  <ArrowLeft size={12} /> Back
                </button>
              )}
              <div style={{ flex: 1 }} />
              {!generateResult ? (
                <button
                  className="panel-header-btn primary"
                  onClick={handleGeneratePipeline}
                  disabled={generateLoading || !generateDescription.trim()}
                >
                  {generateLoading ? <><RotateCw size={12} className="spinning" /> Generating…</> : <><Sparkles size={12} /> Generate</>}
                </button>
              ) : (
                <button
                  className="panel-header-btn primary"
                  onClick={handleGenerateSave}
                  disabled={generateSaving || !generateResult.trim()}
                >
                  {generateSaving ? 'Saving…' : 'Save Pipeline'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Automation Wizard Modal */}
      {showAutomationWizard && (
        <div className="pipeline-preview-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) setShowAutomationWizard(false) }}>
          <div className="pipeline-preview-modal automation-wizard-modal">
            <div className="pipeline-preview-header">
              <Wand2 size={14} />
              <span>New Automation — Step {wizardStep} of 3</span>
              <button className="pipeline-preview-close" onClick={() => setShowAutomationWizard(false)}>
                <X size={14} />
              </button>
            </div>

            <div className="automation-wizard-body">
              {/* Step indicators */}
              <div className="automation-wizard-steps">
                {['Trigger', 'Action', 'Review'].map((label, i) => (
                  <div key={i} className={`automation-wizard-step-dot${wizardStep === i + 1 ? ' active' : wizardStep > i + 1 ? ' done' : ''}`}>
                    <span className="automation-wizard-step-num">{i + 1}</span>
                    <span className="automation-wizard-step-label">{label}</span>
                  </div>
                ))}
              </div>

              {/* Step 1: Trigger */}
              {wizardStep === 1 && (
                <div className="automation-wizard-step-content">
                  <div className="automation-wizard-field">
                    <label className="automation-wizard-field-label">Automation name</label>
                    <input
                      className="automation-wizard-input"
                      value={wizardName}
                      onChange={(e) => setWizardName(e.target.value)}
                      placeholder="My Automation"
                      autoFocus
                    />
                  </div>
                  <p className="automation-wizard-section-label">When should this automation run?</p>
                  <div className="automation-wizard-options">
                    {([
                      { value: 'pr-opened', label: 'GitHub PR opened', icon: <GitPullRequest size={13} /> },
                      { value: 'pr-merged', label: 'GitHub PR merged', icon: <GitMerge size={13} /> },
                      { value: 'cron', label: 'Cron schedule', icon: <Clock size={13} /> },
                      { value: 'git-push', label: 'Git push to branch', icon: <GitBranch size={13} /> },
                    ] as const).map(opt => (
                      <label key={opt.value} className={`automation-wizard-option${wizardTrigger === opt.value ? ' selected' : ''}`}>
                        <input
                          type="radio"
                          name="trigger"
                          value={opt.value}
                          checked={wizardTrigger === opt.value}
                          onChange={() => setWizardTrigger(opt.value)}
                        />
                        {opt.icon}
                        {opt.label}
                      </label>
                    ))}
                  </div>

                  {(wizardTrigger === 'pr-opened' || wizardTrigger === 'pr-merged') && (
                    <div className="automation-wizard-field">
                      <label className="automation-wizard-field-label">Repository</label>
                      {wizardRepos.length === 0 ? (
                        <p className="automation-wizard-hint">No repos configured — add repos in Settings → GitHub.</p>
                      ) : (
                        <select
                          className="automation-wizard-select"
                          value={wizardSelectedRepo}
                          onChange={(e) => setWizardSelectedRepo(e.target.value)}
                        >
                          <option value="">— Select repo —</option>
                          {wizardRepos.map(r => (
                            <option key={`${r.owner}/${r.name}`} value={`${r.owner}/${r.name}`}>{r.owner}/{r.name}</option>
                          ))}
                        </select>
                      )}
                      <p className="automation-wizard-hint">
                        You'll need to register a webhook at GitHub → Settings → Webhooks pointing to <code>http://localhost:7474/webhook/{'{slug}'}</code>.
                      </p>
                    </div>
                  )}

                  {wizardTrigger === 'cron' && (() => {
                    const cronFields = wizardCron.trim().split(/\s+/)
                    const cronValid = !wizardCron.trim() || cronFields.length === 5
                    const cronRuns = cronValid && wizardCron.trim() ? nextRuns(wizardCron.trim(), 3) : []
                    const fmtRun = (d: Date) => d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
                    return (
                      <div className="automation-wizard-field">
                        <label className="automation-wizard-field-label">Schedule</label>
                        <div className="cron-editor-presets">
                          {[
                            { label: '15 min', value: '*/15 * * * *' },
                            { label: '30 min', value: '*/30 * * * *' },
                            { label: 'Hourly', value: '0 * * * *' },
                            { label: '2 hours', value: '0 */2 * * *' },
                            { label: '4 hours', value: '0 */4 * * *' },
                            { label: 'Daily 9am', value: '0 9 * * *' },
                            { label: 'Weekdays 9am', value: '0 9 * * 1-5' },
                          ].map(p => (
                            <button
                              key={p.value}
                              type="button"
                              className={`cron-preset-btn ${wizardCron.trim() === p.value ? 'active' : ''}`}
                              onClick={() => setWizardCron(p.value)}
                            >
                              {p.label}
                            </button>
                          ))}
                        </div>
                        <div className="cron-editor-input-row">
                          <Clock size={12} className="cron-editor-icon" />
                          <input
                            className={`cron-editor-input ${!cronValid ? 'invalid' : ''}`}
                            value={wizardCron}
                            onChange={(e) => setWizardCron(e.target.value)}
                            placeholder="min hour dom month dow"
                            spellCheck={false}
                          />
                        </div>
                        {wizardCron.trim() && (
                          <div className={`cron-editor-description${!cronValid ? ' invalid' : ''}`}>
                            {!cronValid ? `Needs 5 fields (got ${cronFields.length}): min hour dom month dow` : describeCron(wizardCron)}
                          </div>
                        )}
                        {cronRuns.length > 0 && (
                          <div className="cron-editor-next-runs">
                            <span className="cron-next-label">Next:</span>
                            {cronRuns.map((d, i) => (
                              <span key={i} className="cron-next-run">{fmtRun(d)}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })()}

                  {wizardTrigger === 'git-push' && (
                    <div className="automation-wizard-field">
                      <label className="automation-wizard-field-label">Branch pattern</label>
                      <input
                        className="automation-wizard-input"
                        value={wizardBranch}
                        onChange={(e) => setWizardBranch(e.target.value)}
                        placeholder="main"
                      />
                      <p className="automation-wizard-hint">Polls all configured repos every 5 minutes for activity on this branch.</p>
                    </div>
                  )}
                </div>
              )}

              {/* Step 2: Action */}
              {wizardStep === 2 && (
                <div className="automation-wizard-step-content">
                  <p className="automation-wizard-section-label">What should happen?</p>
                  <div className="automation-wizard-field">
                    <label className="automation-wizard-field-label">Working directory</label>
                    <input
                      className="automation-wizard-input"
                      value={wizardWorkingDir}
                      onChange={(e) => setWizardWorkingDir(e.target.value)}
                      placeholder="~/"
                    />
                  </div>
                  <div className="automation-wizard-field">
                    <label className="automation-wizard-field-label">Prompt</label>
                    <textarea
                      className="automation-wizard-textarea"
                      value={wizardPrompt}
                      onChange={(e) => setWizardPrompt(e.target.value)}
                      placeholder="Describe what Claude should do when this automation fires…"
                      rows={6}
                    />
                    <p className="automation-wizard-hint">
                      Use template vars like {'{{pr.title}}'}, {'{{pr.branch}}'}, {'{{repo.name}}'}, {'{{timestamp}}'}.
                    </p>
                  </div>
                  <div className="automation-wizard-field">
                    <label className="automation-wizard-field-label">Model</label>
                    <select
                      className="settings-select"
                      value={wizardModel}
                      onChange={(e) => setWizardModel(e.target.value)}
                      style={{ width: '100%' }}
                    >
                      <option value="auto">Auto (adaptive — haiku for short steps, default for heavy)</option>
                      <option value="claude-opus-4-6">Opus (claude-opus-4-6)</option>
                      <option value="claude-sonnet-4-6">Sonnet (claude-sonnet-4-6)</option>
                      <option value="claude-haiku-4-5-20251001">Haiku (claude-haiku-4-5-20251001)</option>
                      <option value="">Default (global CLI setting)</option>
                    </select>
                  </div>
                </div>
              )}

              {/* Step 3: Review */}
              {wizardStep === 3 && (
                <div className="automation-wizard-step-content">
                  <p className="automation-wizard-section-label">Generated pipeline YAML</p>
                  <pre className="automation-wizard-yaml-preview">{buildAutomationYaml()}</pre>
                  <p className="automation-wizard-hint">
                    This file will be written to <code>~/.claude-colony/pipelines/{wizardName.trim() ? slugify(wizardName) : 'my-automation'}.yaml</code> and picked up automatically within 15s.
                  </p>
                </div>
              )}
            </div>

            <div className="automation-wizard-footer">
              {wizardStep > 1 && (
                <button className="panel-header-btn" onClick={() => setWizardStep(s => s - 1)}>
                  Back
                </button>
              )}
              <div style={{ flex: 1 }} />
              {wizardError && <span style={{ fontSize: 11, color: 'var(--danger)', marginRight: 8 }}>{wizardError}</span>}
              {wizardStep < 3 ? (
                <button
                  className="panel-header-btn primary"
                  onClick={() => setWizardStep(s => s + 1)}
                  disabled={
                    (wizardStep === 1 && !wizardName.trim()) ||
                    (wizardStep === 1 && (wizardTrigger === 'pr-opened' || wizardTrigger === 'pr-merged') && !wizardSelectedRepo) ||
                    (wizardStep === 2 && !wizardPrompt.trim())
                  }
                >
                  Next <ArrowRight size={12} />
                </button>
              ) : (
                <button
                  className="panel-header-btn primary"
                  onClick={handleAutomationConfirm}
                  disabled={!wizardName.trim() || wizardSubmitting}
                >
                  {wizardSubmitting ? 'Creating…' : 'Create Automation'}
                </button>
              )}
            </div>
          </div>
        </div>
      )}

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
      {pipelineCtx && (
        <div className="context-menu-overlay" onClick={() => setPipelineCtx(null)}>
          <div className="context-menu" style={{ top: pipelineCtx.y, left: pipelineCtx.x }} onClick={(e) => e.stopPropagation()}>
            <div className="context-menu-item" onClick={() => { handleToggle(pipelineCtx.name, !pipelineCtx.enabled); setPipelineCtx(null) }}>
              {pipelineCtx.enabled ? 'Disable' : 'Enable'}
            </div>
            {pipelineCtx.enabled && (
              <div className="context-menu-item" onClick={() => { handleTriggerNow(pipelineCtx.name); setPipelineCtx(null) }}>
                Trigger Now
              </div>
            )}
            {pipelineCtx.enabled && (
              <div className="context-menu-item" onClick={() => { handleRunWithOptions(pipelineCtx.name); setPipelineCtx(null) }}>
                Run with Options...
              </div>
            )}
            <div className="context-menu-item" onClick={() => { const p = pipelines.find(pp => pp.name === pipelineCtx.name); if (p) handleDuplicate(p); setPipelineCtx(null) }}>
              Duplicate
            </div>
            <div className="context-menu-item" onClick={() => { const p = pipelines.find(pp => pp.name === pipelineCtx.name); if (p) handlePreview(p); setPipelineCtx(null) }}>
              Preview Next Run
            </div>
            <div className="context-menu-divider" />
            <div className="context-menu-item danger" onClick={async () => {
              const { fileName, name } = pipelineCtx
              setPipelineCtx(null)
              if (!confirm(`Delete pipeline "${name}"? This removes the YAML file and associated data.`)) return
              await window.api.pipeline.delete(fileName)
            }}>
              Delete
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
