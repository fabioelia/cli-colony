import { useState, useEffect, useCallback, useRef, useLayoutEffect, useMemo } from 'react'
import { useFileDrop } from '../hooks/useFileDrop'
import {
  User, Plus, Play, Square, Trash2, Send, MessageSquare, FileText, X,
  ChevronDown, ChevronRight, Clock, Hash, Pencil, StickyNote, ArrowRightCircle, Save, Loader2,
  Hourglass, ArrowRight, FolderOpen, Search, Check, Bot, BarChart3, ArrowUpDown, DollarSign, TrendingUp, Copy,
  CalendarClock, GitBranch, Brain, ShieldCheck, Bell, Timer, GitCompare, BookOpen,
} from 'lucide-react'
import EmptyStateHook from './EmptyStateHook'
import MarkdownViewer from './MarkdownViewer'
import DiffViewer from './DiffViewer'
import HelpPopover from './HelpPopover'
import Tooltip from './Tooltip'
import CronEditor from './CronEditor'
import PersonaScheduleHeatmap from './PersonaScheduleHeatmap'
import PersonaTriggerMap from './PersonaTriggerMap'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'
import { describeCron, nextRuns } from '../../../shared/cron'

import type { PersonaInfo, ClaudeInstance, PersonaArtifact, PersonaRunEntry, PersonaAnalytics, PersonaMemory, AuditResult } from '../../../shared/types'

function PersonaRunStrip({ runs }: { runs: PersonaRunEntry[] }) {
  const cells = runs.slice(0, 20).reverse()
  const pad = 20 - cells.length
  return (
    <div className="pipeline-run-strip compact">
      {Array.from({ length: pad }, (_, i) => (
        <div key={`pad-${i}`} className="pipeline-run-cell" />
      ))}
      {cells.map((r, i) => (
        <div
          key={i}
          className={`pipeline-run-cell ${r.success ? 'pass' : 'fail'}`}
          title={`${new Date(r.timestamp).toLocaleString()} — ${r.stopReason === 'manual' ? 'stopped' : r.success ? 'success' : 'failed'}${r.costUsd ? ` ($${r.costUsd.toFixed(2)})` : ''}`}
        />
      ))}
    </div>
  )
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 60000) return 'just now'
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`
  if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`
  return `${Math.floor(ms / 86400000)}d ago`
}

interface Props {
  onBack: () => void
  onFocusInstance: (id: string) => void
  onLaunchInstance: (opts: { name?: string; workingDirectory?: string; color?: string; args?: string[] }) => Promise<string>
  instances: ClaudeInstance[]
}

const PERSONA_ASSISTANT_PROMPT = `You are a Persona Assistant for Claude Colony. You help users create and edit persona markdown files.

Personas are .md files stored in ~/.claude-colony/personas/ that define autonomous AI agents with identity, goals, memory, and a planning loop.

## Persona File Format

\`\`\`markdown
---
name: "Display Name"
schedule: "0 */2 9-17 * * 1-5"   # cron expression, or empty string for manual-only
model: sonnet                      # model hint (sonnet, opus, etc.)
max_sessions: 1                    # max concurrent sessions
can_push: false                    # permission to push to git
can_merge: false                   # permission to merge PRs
can_create_sessions: true          # permission to spawn child sessions
working_directory: "~/projects/myapp"  # default cwd for sessions
color: "#a78bfa"                   # session color in sidebar
on_complete_run: []                # persona IDs to ALWAYS trigger when this run completes
can_invoke: []                     # persona IDs this persona MAY trigger dynamically (via trigger file)
conflict_group: my-group           # personas in the same group are serialized (default: persona's own slug)
run_condition: new_commits         # skip run if no new commits since last run in working_directory
---

## Role
(Static — written by the user, never modified by the persona)
Define the persona's identity, expertise, behavioral style, and approach.
Be specific about what kind of work this persona does.

## Objectives
(Static — written by the user)
- Concrete goals the persona should pursue each session
- Written as actionable bullet points
- Should be measurable and specific

## Active Situations
(Dynamic — the persona updates this section each session)
Tracks in-flight work, blockers, pending items. Initially empty.

## Learnings
(Dynamic — the persona appends/prunes this)
Facts, patterns, and context the persona discovers over time. Initially empty.

## Session Log
(Dynamic — one entry per session, auto-pruned to 20)
Format: \`- [ISO timestamp] one-line summary\`. Initially empty.
\`\`\`

## Key Design Principles

1. The **Role** section should be rich and specific — it shapes how the persona thinks and acts
2. **Objectives** should be actionable, not vague — "Monitor PR #42 and post daily status updates" not "Help with PRs"
3. **Permissions** should follow least-privilege — only enable what's needed
4. **Schedule** uses 5-field cron (minute hour day month weekday) — empty string means manual only
5. The persona reads colony-context.md each session to understand the workspace state
6. The persona reads and writes its OWN file for memory continuity

## Example Personas

- **Developer**: picks up tickets, writes code, submits PRs. can_push: true, schedule: every 2 hours during work hours
- **Engineering Manager**: monitors PRs, identifies blockers, writes status reports. can_push: false, schedule: every 4 hours
- **Code Reviewer**: watches for new PRs, reviews code, pushes colony feedback. can_push: true, can_create_sessions: true
- **DevOps**: monitors CI/CD, fixes broken builds, manages environments. can_push: true, schedule: every 30 min

## Completion Triggers

There are two ways to chain personas:

**\`on_complete_run\`** — always fires when this persona's session ends:
\`\`\`yaml
on_complete_run: ["colony-qa", "colony-product"]  # file slugs (no .md), not display names
\`\`\`

**\`can_invoke\`** — declares which personas this one MAY trigger dynamically. Nothing fires automatically; the persona decides at runtime by writing a trigger file before exiting:
\`\`\`yaml
can_invoke: ["colony-developer", "colony-product"]
\`\`\`

To use dynamic triggers, write \`~/.claude-colony/personas/<your-id>.triggers.json\` before ending:
\`\`\`json
{"triggers": [{"persona": "colony-developer", "message": "Optional context for the triggered persona."}]}
\`\`\`
Empty \`triggers: []\` suppresses all completion triggers for the session. File is deleted after reading.

Use the file slug (filename without .md extension). Only enabled personas are triggered. Avoid A→B→A cycles.

## Colony Infrastructure

Personas can create/update pipelines and task queues by writing YAML files directly:
- Pipelines: \`~/.claude-colony/pipelines/<name>.yaml\` (Colony auto-detects new files)
- Task queues: \`~/.claude-colony/task-queues/<name>.yaml\`
- Outputs: \`~/.claude-colony/outputs/<task-slug>.md\`

When the user describes what they want, write the persona .md file directly to ~/.claude-colony/personas/. Ask clarifying questions about the role, objectives, and permissions if the user's request is ambiguous.`

function makePersonaConfigDiff(pair: { a: { name: string; content: string }; b: { name: string; content: string } }): string {
  const linesA = pair.a.content.split('\n')
  const linesB = pair.b.content.split('\n')
  const header = `--- ${pair.a.name}\n+++ ${pair.b.name}\n`
  const maxLen = Math.max(linesA.length, linesB.length)
  const hunks: string[] = []
  let i = 0
  while (i < maxLen) {
    const la = linesA[i] ?? ''
    const lb = linesB[i] ?? ''
    if (la !== lb) {
      const start = Math.max(0, i - 3)
      const end = Math.min(maxLen, i + 4)
      let hunk = `@@ -${start + 1} +${start + 1} @@\n`
      for (let j = start; j < end; j++) {
        const a = linesA[j] ?? ''
        const b = linesB[j] ?? ''
        if (a === b) {
          hunk += ` ${a}\n`
        } else {
          if (j < linesA.length) hunk += `-${a}\n`
          if (j < linesB.length) hunk += `+${b}\n`
        }
      }
      hunks.push(hunk)
      i = end
    } else {
      i++
    }
  }
  if (hunks.length === 0) return `${header}@@ -1 +1 @@\n (no differences)\n`
  return header + hunks.join('')
}

/** Parse `## Section` blocks from persona markdown content */
function parseSections(content: string): Record<string, string> {
  const sections: Record<string, string> = {}
  // Strip frontmatter
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '')
  // Split on ## headings (but not ### or deeper)
  const parts = body.split(/^(?=## [^#])/m)
  for (const part of parts) {
    const match = part.match(/^## (.+)\n([\s\S]*)/)
    if (match) {
      sections[match[1].trim()] = match[2].trim()
    }
  }
  return sections
}

export default function PersonasPanel({ onBack, onFocusInstance, onLaunchInstance, instances }: Props) {
  const [personas, setPersonas] = useState<PersonaInfo[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [newName, setNewName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [showTemplateDialog, setShowTemplateDialog] = useState(false)
  const [templates, setTemplates] = useState<{ id: string; name: string; description: string; builtIn: boolean }[]>([])
  const [templateCreating, setTemplateCreating] = useState<string | null>(null)
  const [viewingPersona, setViewingPersona] = useState<PersonaInfo | null>(null)
  const [editingPersona, setEditingPersona] = useState<PersonaInfo | null>(null)
  const [editContent, setEditContent] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  // Ask bar — persona assistant
  const [askInput, setAskInput] = useState('')
  const [assistantId, setAssistantId] = useState<string | null>(null)
  const { ref: askBarRef, isDragging: askBarDragging } = useFileDrop(paths => {
    setAskInput(prev => (prev ? prev + '\n' : '') + paths.join('\n'))
  })
  const [personasDir, setPersonasDir] = useState<string | null>(null)
  const sendingRef = useRef(false)

  // Persona Chat — inline query over session logs + briefs
  const [chatQuery, setChatQuery] = useState('')
  const [chatResponse, setChatResponse] = useState<string | null>(null)
  const [chatLoading, setChatLoading] = useState(false)

  // Sort + search
  const [sortBy, setSortBy] = useState<'name' | 'lastRun' | 'runs' | 'cost' | 'successRate'>('name')
  const [personaSearch, setPersonaSearch] = useState('')
  const [panelView, setPanelView] = useState<'list' | 'schedule' | 'triggers'>('list')

  // Cron pause
  const [cronsPaused, setCronsPaused] = useState(false)

  // Batch selection
  const [selectedPersonas, setSelectedPersonas] = useState<Set<string>>(new Set())

  // Learning search
  const [learningSearchOpen, setLearningSearchOpen] = useState(false)
  const [learningQuery, setLearningQuery] = useState('')
  const [learningResults, setLearningResults] = useState<Array<{ personaId: string; personaName: string; type: string; text: string; matchIndex: number }>>([])
  const [learningLoading, setLearningLoading] = useState(false)
  const learningSearchRef = useRef<HTMLInputElement>(null)

  // Compare mode
  const [compareMode, setCompareMode] = useState(false)
  const [compareSelection, setCompareSelection] = useState<string[]>([])
  const [comparePair, setComparePair] = useState<{ a: { name: string; content: string }; b: { name: string; content: string } } | null>(null)
  const [compareLoading, setCompareLoading] = useState(false)

  // Audit
  const [auditResults, setAuditResults] = useState<AuditResult[] | null>(null)
  const [auditRunning, setAuditRunning] = useState(false)

  // Right-click context menu
  const [personaCtx, setPersonaCtx] = useState<{ persona: PersonaInfo; x: number; y: number } | null>(null)
  const [runWithOptionsPersona, setRunWithOptionsPersona] = useState<PersonaInfo | null>(null)

  useEffect(() => {
    if (!personaCtx) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setPersonaCtx(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [personaCtx])
  const [auditOpen, setAuditOpen] = useState(false)
  const [auditLastRun, setAuditLastRun] = useState<{ ts: number; issueCount: number } | null>(null)
  const [previewPromptPersona, setPreviewPromptPersona] = useState<string | null>(null)
  const [previewPromptText, setPreviewPromptText] = useState<string>('')
  const [previewPromptLoading, setPreviewPromptLoading] = useState(false)

  // Tick every 60s to refresh next-run countdowns
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 60000)
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    window.api.colony.getCronsPaused().then(setCronsPaused).catch(() => {})
    return window.api.colony.onCronsPauseChange(setCronsPaused)
  }, [])

  // Analytics cache — keyed by persona ID
  const [analyticsCache, setAnalyticsCache] = useState<Record<string, PersonaAnalytics>>({})
  const fetchAnalytics = useCallback(async (personaId: string) => {
    if (analyticsCache[personaId]) return
    try {
      const a = await window.api.persona.getAnalytics(personaId)
      setAnalyticsCache(prev => ({ ...prev, [personaId]: a }))
    } catch { /* non-fatal */ }
  }, [analyticsCache])

  // Fetch analytics for all personas on mount
  useEffect(() => {
    personas.forEach(p => fetchAnalytics(p.id))
  }, [personas]) // eslint-disable-line react-hooks/exhaustive-deps

  // Sort personas
  const sortedPersonas = [...personas].sort((a, b) => {
    const aa = analyticsCache[a.id]
    const ab = analyticsCache[b.id]
    switch (sortBy) {
      case 'lastRun': {
        const ta = a.lastRun ? new Date(a.lastRun).getTime() : 0
        const tb = b.lastRun ? new Date(b.lastRun).getTime() : 0
        return tb - ta
      }
      case 'runs':
        return (ab?.totalRuns ?? b.runCount) - (aa?.totalRuns ?? a.runCount)
      case 'cost':
        return (ab?.totalCostUsd ?? 0) - (aa?.totalCostUsd ?? 0)
      case 'successRate':
        return (ab?.successRate ?? 0) - (aa?.successRate ?? 0)
      default:
        return a.name.localeCompare(b.name)
    }
  })

  // Filter sorted personas by search term
  const visiblePersonas = useMemo(() => {
    const q = personaSearch.trim().toLowerCase()
    if (!q) return sortedPersonas
    return sortedPersonas.filter(p =>
      p.name.toLowerCase().includes(q) || p.id.toLowerCase().includes(q)
    )
  }, [sortedPersonas, personaSearch])

  // Persona Edit Modal state
  const [editMetaPersona, setEditMetaPersona] = useState<PersonaInfo | null>(null)

  const handleChat = useCallback(async () => {
    const q = chatQuery.trim()
    if (!q || chatLoading) return
    setChatLoading(true)
    setChatResponse(null)
    try {
      const result = await window.api.persona.ask(q)
      setChatResponse(result)
    } catch {
      setChatResponse('Failed to get response.')
    } finally {
      setChatLoading(false)
    }
  }, [chatQuery, chatLoading])

  const handleRunAudit = useCallback(async () => {
    setAuditRunning(true)
    setAuditResults(null)
    setAuditOpen(true)
    const context = {
      personas: personas.map(p => ({
        name: p.name, id: p.id, enabled: p.enabled, schedule: p.schedule,
        model: p.model, maxSessions: p.maxSessions, canPush: p.canPush,
        canMerge: p.canMerge, runCount: p.runCount, lastRun: p.lastRun,
        learningsCount: 0, situationsCount: 0,
      })),
    }
    const results = await window.api.audit.runPanel('personas', context)
    setAuditResults(results)
    setAuditRunning(false)
    window.api.audit.getLastRun('personas').then(setAuditLastRun)
  }, [personas])

  const loadPersonas = useCallback(async () => {
    try {
      const list = await window.api.persona.list()
      setPersonas(list)
    } catch (err) {
      console.error('Failed to load personas:', err)
      setError('Failed to load personas')
    }
  }, [])

  useEffect(() => {
    loadPersonas()
    const unsub = window.api.persona.onStatus((list) => setPersonas(list))
    return unsub
  }, [loadPersonas])

  useEffect(() => {
    window.api.persona.getDir().then(setPersonasDir)
  }, [])

  useEffect(() => {
    window.api.audit.getLastRun('personas').then(setAuditLastRun).catch(() => {})
  }, [])

  // Track if assistant is still alive
  useEffect(() => {
    if (assistantId && !instances.some(i => i.id === assistantId && i.status === 'running')) {
      setAssistantId(null)
    }
  }, [instances, assistantId])

  const handleAsk = useCallback(async () => {
    const q = askInput.trim()
    if (!q || sendingRef.current) return
    setAskInput('')
    sendingRef.current = true
    try {
      if (assistantId && instances.some(i => i.id === assistantId && i.status === 'running')) {
        await window.api.instance.write(assistantId, q + '\r')
        onFocusInstance(assistantId)
        return
      }
      const id = await onLaunchInstance({
        name: 'Persona Assistant',
        workingDirectory: personasDir || undefined,
        color: '#a78bfa',
        args: ['--append-system-prompt', PERSONA_ASSISTANT_PROMPT],
      })
      setAssistantId(id)
      sendPromptWhenReady(id, { prompt: q })
      onFocusInstance(id)
    } finally {
      sendingRef.current = false
    }
  }, [askInput, assistantId, instances, personasDir, onLaunchInstance, onFocusInstance])

  const handleRun = async (id: string) => {
    try {
      const instanceId = await window.api.persona.run(id)
      if (instanceId) {
        onFocusInstance(instanceId)
      }
    } catch (err) {
      console.error('Failed to run persona:', err)
    }
  }

  const handleRunWithOptions = async (personaId: string, overrides: { model?: string; maxCostUsd?: number; promptPrefix?: string }) => {
    setRunWithOptionsPersona(null)
    try {
      const instanceId = await window.api.persona.runWithOptions(personaId, overrides)
      if (instanceId) onFocusInstance(instanceId)
    } catch (err) {
      console.error('Failed to run persona with options:', err)
    }
  }

  const handleStop = async (id: string) => {
    try {
      await window.api.persona.stop(id)
    } catch (err) {
      console.error('Failed to stop persona:', err)
    }
  }

  const handleToggle = async (id: string, enabled: boolean) => {
    try {
      await window.api.persona.toggle(id, enabled)
    } catch (err) {
      console.error('Failed to toggle persona:', err)
    }
  }

  const handleDrain = async (id: string) => {
    try {
      await window.api.persona.drain(id)
    } catch (err) {
      console.error('Failed to drain persona:', err)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm(`Delete persona "${id}"? This cannot be undone.`)) return
    try {
      await window.api.persona.delete(id)
      if (expandedId === id) setExpandedId(null)
    } catch (err) {
      console.error('Failed to delete persona:', err)
    }
  }

  const handleEditSave = async () => {
    if (!editingPersona) return
    setEditSaving(true)
    try {
      await window.api.persona.saveContent(editingPersona.id, editContent)
      setEditingPersona(null)
      loadPersonas()
    } catch (err) {
      console.error('Failed to save persona:', err)
    } finally {
      setEditSaving(false)
    }
  }

  const handleDuplicate = async (id: string) => {
    const newSlug = await window.api.persona.duplicate(id)
    if (newSlug) {
      await loadPersonas()
      setExpandedId(newSlug)
    }
  }

  const handlePreviewPrompt = async (fileName: string) => {
    setPreviewPromptPersona(fileName)
    setPreviewPromptLoading(true)
    setPreviewPromptText('')
    try {
      const text = await window.api.persona.previewPrompt(fileName)
      setPreviewPromptText(text)
    } catch (e) {
      setPreviewPromptText('Error loading prompt preview')
    } finally {
      setPreviewPromptLoading(false)
    }
  }

  const handleCreate = async () => {
    const name = newName.trim()
    if (!name) return
    try {
      const result = await window.api.persona.create(name)
      if (result) {
        setShowNewDialog(false)
        setNewName('')
        loadPersonas()
      }
    } catch (err) {
      console.error('Failed to create persona:', err)
    }
  }

  const handleOpenTemplateDialog = async () => {
    try {
      const list = await window.api.persona.getTemplates()
      setTemplates(list)
      setShowTemplateDialog(true)
    } catch (err) {
      console.error('Failed to load templates:', err)
    }
  }

  const handleCreateFromTemplate = async (templateId: string) => {
    setTemplateCreating(templateId)
    try {
      const result = await window.api.persona.createFromTemplate(templateId)
      if (result) {
        setShowTemplateDialog(false)
        loadPersonas()
      } else {
        setShowTemplateDialog(false)
        setError('Failed to create persona from template.')
      }
    } catch (err) {
      setShowTemplateDialog(false)
      setError('Failed to create persona from template.')
    } finally {
      setTemplateCreating(null)
    }
  }

  // Batch operations
  const handleToggleSelect = useCallback((id: string) => {
    setSelectedPersonas(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const handleSelectAll = useCallback(() => {
    if (selectedPersonas.size === visiblePersonas.length) {
      setSelectedPersonas(new Set())
    } else {
      setSelectedPersonas(new Set(visiblePersonas.map(p => p.id)))
    }
  }, [visiblePersonas, selectedPersonas.size])

  const handleBatchEnable = useCallback(async () => {
    for (const id of selectedPersonas) await window.api.persona.toggle(id, true)
    setSelectedPersonas(new Set())
  }, [selectedPersonas])

  const handleBatchDisable = useCallback(async () => {
    for (const id of selectedPersonas) await window.api.persona.toggle(id, false)
    setSelectedPersonas(new Set())
  }, [selectedPersonas])

  const handleBatchRun = useCallback(async () => {
    const ids = [...selectedPersonas]
    setSelectedPersonas(new Set())
    for (let i = 0; i < ids.length; i++) {
      const p = personas.find(pp => pp.id === ids[i])
      if (p?.activeSessionId) continue // already running
      await window.api.persona.run(ids[i])
      if (i < ids.length - 1) await new Promise(r => setTimeout(r, 2000))
    }
  }, [selectedPersonas, personas])

  const handleBatchStop = useCallback(async () => {
    for (const id of selectedPersonas) await window.api.persona.stop(id)
    setSelectedPersonas(new Set())
  }, [selectedPersonas])

  // Clear selection on tab switch or Escape
  useEffect(() => {
    setSelectedPersonas(new Set())
  }, [panelView])

  useEffect(() => {
    if (selectedPersonas.size === 0) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedPersonas(new Set())
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [selectedPersonas.size])

  useEffect(() => {
    if (!compareMode) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setCompareMode(false); setCompareSelection([]); setComparePair(null) }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [compareMode])

  useEffect(() => {
    if (learningSearchOpen) setTimeout(() => learningSearchRef.current?.focus(), 50)
  }, [learningSearchOpen])

  useEffect(() => {
    if (!learningSearchOpen) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { setLearningSearchOpen(false); setLearningQuery(''); setLearningResults([]) }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [learningSearchOpen])

  useEffect(() => {
    if (learningQuery.length < 2) { setLearningResults([]); return }
    setLearningLoading(true)
    const timer = setTimeout(async () => {
      try {
        const results = await window.api.persona.searchLearnings(learningQuery)
        setLearningResults(results)
      } catch { /* non-fatal */ }
      setLearningLoading(false)
    }, 300)
    return () => clearTimeout(timer)
  }, [learningQuery])

  useEffect(() => {
    if (compareSelection.length !== 2) return
    setCompareLoading(true)
    window.api.persona.compareConfig(compareSelection[0], compareSelection[1])
      .then(pair => { setComparePair(pair); setCompareLoading(false) })
      .catch(() => setCompareLoading(false))
  }, [compareSelection])

  return (
    <div className="personas-panel">
      <div className="panel-header">
        <h2><User size={16} /> Personas</h2>
        <div className="panel-header-tabs">
          <button className={`panel-header-tab${panelView === 'list' ? ' active' : ''}`} onClick={() => setPanelView('list')}>List</button>
          <button className={`panel-header-tab${panelView === 'schedule' ? ' active' : ''}`} onClick={() => setPanelView('schedule')}><CalendarClock size={11} /> Schedule</button>
          <button className={`panel-header-tab${panelView === 'triggers' ? ' active' : ''}`} onClick={() => setPanelView('triggers')}><GitBranch size={11} /> Triggers</button>
        </div>
        <div className="panel-header-spacer" />
        {panelView === 'list' && (
          <>
            <div className="review-search-wrapper">
              <Search size={11} className="review-search-icon" />
              <input
                className="review-search-input"
                placeholder="Filter personas…"
                value={personaSearch}
                onChange={(e) => setPersonaSearch(e.target.value)}
              />
              {personaSearch && (
                <button className="review-search-clear" onClick={() => setPersonaSearch('')} title="Clear">
                  <X size={10} />
                </button>
              )}
            </div>
            <div className="persona-sort-dropdown">
              <ArrowUpDown size={11} />
              <select value={sortBy} onChange={(e) => setSortBy(e.target.value as typeof sortBy)}>
                <option value="name">Name</option>
                <option value="lastRun">Last Run</option>
                <option value="runs">Runs</option>
                <option value="cost">Cost</option>
                <option value="successRate">Success Rate</option>
              </select>
            </div>
          </>
        )}
        {panelView === 'list' && (
          <button
            className={`panel-header-btn${learningSearchOpen ? ' active' : ''}`}
            onClick={() => { setLearningSearchOpen(o => !o); setLearningQuery(''); setLearningResults([]) }}
            title="Search across all persona learnings and situations"
          >
            <BookOpen size={12} /> Search Learnings
          </button>
        )}
        {panelView === 'list' && (
          <button
            className={`panel-header-btn${compareMode ? ' active' : ''}`}
            onClick={() => { setCompareMode(m => !m); setCompareSelection([]); setComparePair(null) }}
            title="Compare two persona configs side-by-side"
          >
            <GitCompare size={12} /> Compare
          </button>
        )}
        <HelpPopover topic="personas" align="right" />
        <div className="panel-header-actions">
          <button
            className={`panel-header-btn${auditResults && auditResults.length > 0 ? ' panel-header-btn--audit-alert' : ''}`}
            onClick={handleRunAudit}
            disabled={auditRunning}
            title={auditLastRun ? `Last run: ${new Date(auditLastRun.ts).toLocaleString()}, ${auditLastRun.issueCount} issue${auditLastRun.issueCount !== 1 ? 's' : ''}` : 'Run AI audit — identify misconfigured personas'}
          >
            <ShieldCheck size={12} />
            {auditRunning ? 'Auditing…' : auditLastRun
              ? (() => { const secs = (Date.now() - auditLastRun.ts) / 1000; const ago = secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`; return `Audit (${ago}, ${auditLastRun.issueCount} issue${auditLastRun.issueCount !== 1 ? 's' : ''})` })()
              : 'Audit'}
            {auditResults && auditResults.length > 0 && (
              <span className="audit-badge">{auditResults.length}</span>
            )}
          </button>
          <button className="panel-header-btn" onClick={handleOpenTemplateDialog} title="Create persona from a built-in or custom template">
            <Copy size={12} /> From Template
          </button>
          <button className="panel-header-btn primary" onClick={() => setShowNewDialog(true)}>
            <Plus size={13} /> New Persona
          </button>
        </div>
      </div>

      {auditOpen && (auditRunning || auditResults !== null) && (
        <div className="audit-results-panel">
          <div className="audit-results-header">
            <ShieldCheck size={13} />
            <span>Persona Audit</span>
            {!auditRunning && <span className="audit-results-count">{auditResults?.length ?? 0} issue{auditResults?.length !== 1 ? 's' : ''}</span>}
            <button className="audit-results-dismiss" onClick={() => { setAuditOpen(false); setAuditResults(null) }} title="Dismiss">
              <X size={11} />
            </button>
          </div>
          {auditRunning && <div className="audit-results-loading">Running audit with Claude…</div>}
          {!auditRunning && auditResults !== null && auditResults.length === 0 && (
            <div className="audit-results-empty">No issues found</div>
          )}
          {!auditRunning && auditResults?.map((r, i) => (
            <div key={i} className={`audit-result-item audit-severity-${r.severity.toLowerCase()}`}>
              <span className="audit-result-severity">{r.severity}</span>
              <span className="audit-result-item-name">{r.item}</span>
              <span className="audit-result-issue">{r.issue}</span>
            </div>
          ))}
        </div>
      )}

      {panelView === 'schedule' && (
        <PersonaScheduleHeatmap personas={personas} />
      )}

      {panelView === 'triggers' && (
        <PersonaTriggerMap
          personas={personas}
          onSelectPersona={(id) => {
            setPanelView('list')
            setExpandedId(id)
          }}
        />
      )}

      {panelView === 'list' && <>
      {/* Bulk action bar */}
      {selectedPersonas.size > 0 && (
        <div className="persona-bulk-bar">
          <button className="persona-bulk-select-all" onClick={handleSelectAll}>
            {selectedPersonas.size === visiblePersonas.length ? 'Deselect All' : 'Select All'}
          </button>
          <span className="persona-bulk-count">{selectedPersonas.size} selected</span>
          <div className="persona-bulk-actions">
            <button className="persona-bulk-btn" onClick={handleBatchEnable} title="Enable selected personas">Enable</button>
            <button className="persona-bulk-btn" onClick={handleBatchDisable} title="Disable selected personas">Disable</button>
            <button className="persona-bulk-btn primary" onClick={handleBatchRun} title="Run selected personas (2s stagger)"><Play size={11} /> Run Now</button>
            <button className="persona-bulk-btn danger" onClick={handleBatchStop} title="Stop selected personas"><Square size={11} /> Stop</button>
          </div>
        </div>
      )}

      {/* Compare mode banner */}
      {compareMode && (
        <div className="persona-compare-bar">
          <GitCompare size={13} />
          {compareSelection.length === 0 && <span>Select 2 personas to compare their configs</span>}
          {compareSelection.length === 1 && <span>Select one more persona to compare</span>}
          {compareSelection.length === 2 && compareLoading && <span>Loading diff…</span>}
          {compareSelection.length === 2 && !compareLoading && <span>{visiblePersonas.find(p => p.id === compareSelection[0])?.name} vs {visiblePersonas.find(p => p.id === compareSelection[1])?.name}</span>}
          {compareSelection.length > 0 && <button className="persona-compare-clear" onClick={() => { setCompareSelection([]); setComparePair(null) }} title="Clear selection"><X size={11} /></button>}
          <button className="persona-compare-exit" onClick={() => { setCompareMode(false); setCompareSelection([]); setComparePair(null) }} title="Exit compare mode (Esc)"><X size={11} /> Exit</button>
        </div>
      )}
      {compareMode && comparePair && (
        <div className="persona-compare-diff">
          <DiffViewer diff={makePersonaConfigDiff(comparePair)} filename="persona-config.md" />
        </div>
      )}

      {/* Learning search bar + results */}
      {learningSearchOpen && (
        <div className="learning-search-panel">
          <div className="learning-search-bar">
            <Search size={13} className="learning-search-icon" />
            <input
              ref={learningSearchRef}
              className="learning-search-input"
              placeholder="Search across all persona learnings…"
              value={learningQuery}
              onChange={(e) => setLearningQuery(e.target.value)}
            />
            {learningLoading && <Loader2 size={13} className="spin" />}
            {learningQuery && !learningLoading && (
              <button className="review-search-clear" onClick={() => { setLearningQuery(''); setLearningResults([]) }} title="Clear"><X size={10} /></button>
            )}
          </div>
          {learningQuery.length >= 2 && !learningLoading && learningResults.length === 0 && (
            <div className="learning-search-empty">No matches found</div>
          )}
          {learningResults.length > 0 && (() => {
            const byPersona: Record<string, typeof learningResults> = {}
            for (const r of learningResults) {
              if (!byPersona[r.personaId]) byPersona[r.personaId] = []
              byPersona[r.personaId].push(r)
            }
            return (
              <div className="learning-search-results">
                {Object.entries(byPersona).map(([personaId, items]) => (
                  <div key={personaId} className="learning-search-group">
                    <div className="learning-search-group-header">{items[0].personaName}</div>
                    {items.map((item, i) => {
                      const before = item.text.slice(Math.max(0, item.matchIndex - 40), item.matchIndex)
                      const match = item.text.slice(item.matchIndex, item.matchIndex + learningQuery.length)
                      const after = item.text.slice(item.matchIndex + learningQuery.length, item.matchIndex + learningQuery.length + 80)
                      return (
                        <div
                          key={i}
                          className="learning-search-result"
                          onClick={() => {
                            setLearningSearchOpen(false); setLearningQuery(''); setLearningResults([])
                            setExpandedId(personaId)
                          }}
                        >
                          <span className={`learning-search-type ${item.type}`}>{item.type}</span>
                          <span className="learning-search-text">
                            {before.length < item.matchIndex ? '…' : ''}{before}<mark>{match}</mark>{after}{after.length === 80 ? '…' : ''}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}

      {/* Persona Chat — ask about session logs and briefs */}
      <div className="personas-ask-bar">
        <Search size={13} className="personas-ask-icon" />
        <input
          className="personas-ask-input"
          placeholder="Ask what's been happening across personas…"
          value={chatQuery}
          onChange={(e) => setChatQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChat() } }}
          disabled={chatLoading}
        />
        <button
          className="personas-ask-send"
          onClick={handleChat}
          disabled={!chatQuery.trim() || chatLoading}
          title="Ask about persona activity"
        >
          {chatLoading ? <Loader2 size={13} className="spin" /> : <ArrowRight size={13} />}
        </button>
      </div>
      {chatResponse !== null && (
        <div className="personas-ask-response">
          <button className="personas-ask-response-close" onClick={() => { setChatResponse(null); setChatQuery('') }} title="Dismiss">
            <X size={11} />
          </button>
          <MarkdownViewer content={chatResponse} />
        </div>
      )}

      {/* Ask bar — always visible */}
      <div ref={askBarRef} className={`panel-ask-bar${askBarDragging ? ' dragging' : ''}`}>
        <MessageSquare size={14} className="panel-ask-icon" />
        <input
          className="panel-ask-input"
          placeholder="Describe a persona to create or modify... or drop files to include paths"
          value={askInput}
          onChange={(e) => setAskInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk() } }}
        />
        {assistantId && instances.some(i => i.id === assistantId && i.status === 'running') && (
          <button className="panel-ask-focus" onClick={() => onFocusInstance(assistantId!)} title="Focus Persona Assistant">View</button>
        )}
        <button className="panel-ask-send" onClick={handleAsk} disabled={!askInput.trim()} title="Ask Persona Assistant">
          <Send size={13} />
        </button>
      </div>

      {/* Quick create dialog */}
      {showNewDialog && (
        <div className="panel-ask-bar" style={{ borderColor: 'var(--accent)' }}>
          <Plus size={14} className="panel-ask-icon" />
          <input
            className="panel-ask-input"
            placeholder="Persona name..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleCreate() }
              if (e.key === 'Escape') { setShowNewDialog(false); setNewName('') }
            }}
            autoFocus
          />
          <button className="panel-ask-send" onClick={handleCreate} disabled={!newName.trim()} title="Create">
            <Plus size={13} />
          </button>
        </div>
      )}

      {error && (
        <div style={{ padding: '8px 12px', color: 'var(--danger)', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {showTemplateDialog && (
        <div className="persona-modal-overlay" onClick={() => setShowTemplateDialog(false)}>
          <div className="persona-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 460 }}>
            <div className="persona-modal-header">
              <h3>Create from Template</h3>
              <div style={{ flex: 1 }} />
              <button className="panel-header-btn" onClick={() => setShowTemplateDialog(false)}><X size={14} /></button>
            </div>
            <div style={{ padding: '14px 18px' }}>
              {templates.length === 0 ? (
                <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No templates available.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {templates.map(t => (
                    <div key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 10px', background: 'var(--bg-secondary)', borderRadius: 6 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 500 }}>{t.name}{t.builtIn && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent)', background: 'rgba(59, 130, 246, 0.12)', borderRadius: 3, padding: '1px 5px' }}>built-in</span>}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{t.description}</div>
                      </div>
                      <button
                        className="panel-header-btn primary"
                        onClick={() => handleCreateFromTemplate(t.id)}
                        disabled={templateCreating === t.id}
                        style={{ flexShrink: 0 }}
                      >
                        {templateCreating === t.id ? <Loader2 size={11} style={{ animation: 'spin 1s linear infinite' }} /> : <Plus size={11} />}
                        Create
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {personas.length === 0 && !showNewDialog && !showTemplateDialog && (
        <EmptyStateHook
          icon={Bot}
          title="Personas"
          hook="No personas yet. They shape how your agents think and schedule."
          keyCap="P"
          cta={{ label: 'Create Persona', onClick: () => setShowNewDialog(true) }}
        />
      )}

      {visiblePersonas.length === 0 && personas.length > 0 && (
        <div className="panel-search-empty">No personas match &ldquo;{personaSearch}&rdquo;</div>
      )}

      <div className="personas-list list-mode">
        {visiblePersonas.map((persona) => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            expanded={expandedId === persona.id}
            instances={instances}
            allPersonas={personas}
            analytics={analyticsCache[persona.id] ?? null}
            selected={selectedPersonas.has(persona.id)}
            onToggleSelect={() => handleToggleSelect(persona.id)}
            compareMode={compareMode}
            compareSelected={compareSelection.includes(persona.id)}
            onCompareToggle={() => {
              setCompareSelection(prev => {
                if (prev.includes(persona.id)) return prev.filter(id => id !== persona.id)
                if (prev.length >= 2) return prev
                return [...prev, persona.id]
              })
              setComparePair(null)
            }}
            onToggleExpand={() => setExpandedId(expandedId === persona.id ? null : persona.id)}
            onRun={() => handleRun(persona.id)}
            onStop={() => handleStop(persona.id)}
            onToggle={(enabled) => handleToggle(persona.id, enabled)}
            onDrain={() => handleDrain(persona.id)}
            onDelete={() => handleDelete(persona.id)}
            onDuplicate={() => handleDuplicate(persona.id)}
            onFocusInstance={onFocusInstance}
            onViewFile={() => setViewingPersona(persona)}
            onEditFile={() => { setEditingPersona(persona); setEditContent(persona.content) }}
            onEditMeta={() => setEditMetaPersona(persona)}
            onScheduleSave={async (schedule) => {
              await window.api.persona.setSchedule(persona.id, schedule)
            }}
            onWhisper={async (text) => {
              await window.api.persona.whisper(persona.id, text)
            }}
            onDeleteNote={async (index) => {
              await window.api.persona.deleteNote(persona.id, index)
            }}
            onUpdateNote={async (index, newText) => {
              await window.api.persona.updateNote(persona.id, index, newText)
            }}
            cronsPaused={cronsPaused}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              setPersonaCtx({ persona, x: Math.min(e.clientX, window.innerWidth - 200), y: Math.min(e.clientY, window.innerHeight - 220) })
            }}
          />
        ))}
      </div>

      {/* Right-click context menu */}
      {personaCtx && (
        <div className="context-menu-overlay" onClick={() => setPersonaCtx(null)}>
          <div className="context-menu" style={{ top: personaCtx.y, left: personaCtx.x }} onClick={(e) => e.stopPropagation()}>
            <div className="context-menu-item" onClick={() => { handleRun(personaCtx.persona.id); setPersonaCtx(null) }}>Run Now</div>
            {personaCtx.persona.enabled && (
              <div className="context-menu-item" onClick={() => { setRunWithOptionsPersona(personaCtx.persona); setPersonaCtx(null) }}>Run with Options...</div>
            )}
            <div className="context-menu-divider" />
            <div className="context-menu-item" onClick={() => { handleToggle(personaCtx.persona.id, !personaCtx.persona.enabled); setPersonaCtx(null) }}>
              {personaCtx.persona.enabled ? 'Disable' : 'Enable'}
            </div>
            <div className="context-menu-item" onClick={() => { handleDrain(personaCtx.persona.id); setPersonaCtx(null) }}>Drain</div>
            <div className="context-menu-item" onClick={() => { handleDuplicate(personaCtx.persona.id); setPersonaCtx(null) }}>Duplicate</div>
            <div className="context-menu-item" onClick={() => { setEditingPersona(personaCtx.persona); setEditContent(personaCtx.persona.content); setPersonaCtx(null) }}>Edit</div>
            <div className="context-menu-item" onClick={() => { handlePreviewPrompt(personaCtx.persona.id); setPersonaCtx(null) }}>Preview Prompt</div>
          </div>
        </div>
      )}

      {/* Run with Options dialog */}
      {runWithOptionsPersona && (
        <div className="modal-overlay" onClick={() => setRunWithOptionsPersona(null)}>
          <div className="cmd-palette" style={{ maxWidth: 480 }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '12px 16px 0', borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
              <span style={{ fontSize: 13, fontWeight: 600 }}>Run with Options — {runWithOptionsPersona.name}</span>
            </div>
            <div style={{ padding: '0 16px 16px' }}>
              <PersonaRunWithOptionsDialog
                persona={runWithOptionsPersona}
                onRun={(overrides) => handleRunWithOptions(runWithOptionsPersona.id, overrides)}
                onClose={() => setRunWithOptionsPersona(null)}
              />
            </div>
          </div>
        </div>
      )}

      </>}

      {/* Prompt Preview modal */}
      {previewPromptPersona && (
        <div className="modal-overlay" onClick={() => setPreviewPromptPersona(null)}>
          <div className="modal-box" style={{ width: 640, maxHeight: '80vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <h3 style={{ margin: 0, flex: 1 }}>Prompt Preview</h3>
              <button className="modal-btn" onClick={async () => {
                await navigator.clipboard.writeText(previewPromptText)
              }}>Copy</button>
              <button className="modal-btn" onClick={() => setPreviewPromptPersona(null)}>Close</button>
            </div>
            {previewPromptLoading ? (
              <p style={{ color: 'var(--text-secondary)' }}>Loading...</p>
            ) : (
              <pre style={{ margin: 0, overflowY: 'auto', fontSize: 11, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-tertiary)', padding: 12, borderRadius: 4, flex: 1 }}>
                {previewPromptText}
              </pre>
            )}
          </div>
        </div>
      )}

      {/* Markdown viewer modal */}
      {viewingPersona && (
        <div className="persona-modal-overlay" onClick={() => setViewingPersona(null)}>
          <div className="persona-modal" onClick={(e) => e.stopPropagation()}>
            <div className="persona-modal-header">
              <h3>{viewingPersona.name}</h3>
              <span className="persona-modal-path">{viewingPersona.filePath}</span>
              <button className="persona-modal-close" onClick={() => setViewingPersona(null)}>
                <X size={16} />
              </button>
            </div>
            <div className="persona-modal-content">
              <MarkdownViewer content={viewingPersona.content.replace(/^---\n[\s\S]*?\n---\n?/, '')} />
            </div>
          </div>
        </div>
      )}

      {/* Raw markdown editor modal */}
      {editingPersona && (
        <div className="persona-modal-overlay" onClick={() => !editSaving && setEditingPersona(null)}>
          <div className="persona-modal persona-edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="persona-modal-header">
              <h3><Pencil size={14} /> Edit: {editingPersona.name}</h3>
              <span className="persona-modal-path">{editingPersona.filePath}</span>
              <button className="persona-modal-close" onClick={() => setEditingPersona(null)} disabled={editSaving}>
                <X size={16} />
              </button>
            </div>
            <textarea
              className="persona-edit-textarea"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              spellCheck={false}
              autoFocus
            />
            <div className="persona-edit-footer">
              <button className="persona-edit-cancel" onClick={() => setEditingPersona(null)} disabled={editSaving}>
                Cancel
              </button>
              <button className="persona-edit-save" onClick={handleEditSave} disabled={editSaving}>
                {editSaving ? <><Loader2 size={13} className="spin" /> Saving…</> : <><Save size={13} /> Save</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Meta Modal — schedule, model, enabled, max sessions */}
      {editMetaPersona && (
        <EditPersonaModal
          persona={editMetaPersona}
          allPersonaIds={personas.filter(p => p.id !== editMetaPersona.id).map(p => p.id)}
          onClose={() => setEditMetaPersona(null)}
          onSaved={loadPersonas}
        />
      )}
    </div>
  )
}

/** Collapsible section within the persona card */
function PersonaSection({ title, content, defaultOpen, isOutput, isBrief, children }: {
  title: string
  content: string | null | undefined
  defaultOpen: boolean
  isOutput?: boolean
  isBrief?: boolean
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const hasContent = children || (content && !content.trim().startsWith('('))
  if (!hasContent) return null

  return (
    <div className={`persona-card-section${isBrief ? ' persona-brief-section' : ''}`}>
      <button className="persona-section-toggle" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        <h4>{title}</h4>
        {!open && content && <span className="persona-section-preview">{content.split('\n').find(l => l.trim())?.trim().slice(0, 80)}...</span>}
      </button>
      {open && (
        children || (
          <div className={`persona-card-section-content${isOutput ? ' persona-run-output' : ''}`}>
            <MarkdownViewer content={content || ''} />
          </div>
        )
      )}
    </div>
  )
}

function PersonaRunSparkline({ entries }: { entries: PersonaRunEntry[] }) {
  const bars = entries.slice(0, 7).reverse()
  if (bars.length === 0) return null
  const BAR_W = 16
  const BAR_GAP = 4
  const MAX_H = 24
  const totalW = bars.length * (BAR_W + BAR_GAP) - BAR_GAP
  return (
    <div className="persona-history-sparkline">
      <svg width={totalW} height={MAX_H} style={{ display: 'block', overflow: 'visible' }}>
        {bars.map((e, i) => {
          const h = MAX_H
          const x = i * (BAR_W + BAR_GAP)
          const fill = e.success ? 'var(--accent)' : 'var(--danger)'
          return (
            <rect key={i} x={x} y={MAX_H - h} width={BAR_W} height={h} rx={2} fill={fill} opacity={0.75} />
          )
        })}
      </svg>
      <span className="persona-history-sparkline-label">Last {bars.length} run{bars.length !== 1 ? 's' : ''}</span>
    </div>
  )
}

function PersonaAnalyticsTab({ analytics, personaName, onRun, instances, onFocusInstance }: {
  analytics: PersonaAnalytics | null
  personaName: string
  onRun: () => void
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
}) {
  const [selectedRunIndex, setSelectedRunIndex] = useState<number | null>(null)
  const [showAllRuns, setShowAllRuns] = useState(false)
  if (!analytics || analytics.totalRuns === 0) {
    return (
      <div className="persona-outputs-tab">
        <div className="persona-analytics-empty">
          <BarChart3 size={24} style={{ opacity: 0.3, marginBottom: 8 }} />
          <div>No runs yet</div>
          <button className="persona-analytics-run-btn" onClick={onRun}>
            <Play size={11} /> Run Now
          </button>
        </div>
      </div>
    )
  }

  const avgDurMin = Math.floor(analytics.avgDurationMs / 60000)
  const avgDurSec = Math.floor((analytics.avgDurationMs % 60000) / 1000)
  const avgDur = avgDurMin > 0 ? `${avgDurMin}m ${avgDurSec}s` : `${avgDurSec}s`

  // Build daily cost bars for last 7 days
  const now = Date.now()
  const dayMs = 24 * 60 * 60 * 1000
  const dailyCosts: number[] = []
  for (let d = 6; d >= 0; d--) {
    const dayStart = now - (d + 1) * dayMs
    const dayEnd = now - d * dayMs
    const cost = analytics.recentRuns
      .filter(r => { const t = new Date(r.timestamp).getTime(); return t >= dayStart && t < dayEnd })
      .reduce((s, r) => s + (r.costUsd ?? 0), 0)
    dailyCosts.push(cost)
  }
  const maxCost = Math.max(...dailyCosts, 0.01)

  // Sparkline: last 30 runs, x=time, y=duration, color=success/fail
  const sparkRuns = analytics.recentRuns.slice(0, 20).reverse()
  const maxDur = Math.max(...sparkRuns.map(r => r.durationMs), 1)

  return (
    <div className="persona-outputs-tab persona-analytics-tab">
      {/* Summary stats */}
      <div className="persona-analytics-stats">
        <div className="persona-analytics-stat">
          <span className="persona-analytics-stat-value">{analytics.totalRuns}</span>
          <span className="persona-analytics-stat-label">Total Runs</span>
        </div>
        <div className="persona-analytics-stat">
          <span className={`persona-analytics-stat-value ${analytics.successRate >= 80 ? 'good' : analytics.successRate >= 50 ? 'warn' : 'bad'}`}>
            {analytics.successRate.toFixed(1)}%
          </span>
          <span className="persona-analytics-stat-label">Success Rate</span>
        </div>
        <div className="persona-analytics-stat">
          <span className="persona-analytics-stat-value">{avgDur}</span>
          <span className="persona-analytics-stat-label">Avg Duration</span>
        </div>
        <div className="persona-analytics-stat">
          <span className="persona-analytics-stat-value">${analytics.totalCostUsd.toFixed(2)}</span>
          <span className="persona-analytics-stat-label">Total Cost</span>
        </div>
        <div className="persona-analytics-stat">
          <span className="persona-analytics-stat-value">${analytics.costLast7d.toFixed(2)}</span>
          <span className="persona-analytics-stat-label">Cost (7d)</span>
        </div>
      </div>

      {/* Run history sparkline */}
      {sparkRuns.length > 1 && (
        <div className="persona-analytics-chart">
          <div className="persona-analytics-chart-label">Run Duration</div>
          <svg width="100%" height={40} viewBox={`0 0 ${sparkRuns.length * 14} 40`} preserveAspectRatio="none">
            {sparkRuns.map((r, i) => {
              const h = Math.max(4, (r.durationMs / maxDur) * 36)
              return (
                <rect
                  key={i}
                  x={i * 14}
                  y={40 - h}
                  width={10}
                  height={h}
                  rx={2}
                  fill={r.success ? 'var(--accent)' : 'var(--danger)'}
                  opacity={selectedRunIndex === i ? 1 : 0.75}
                  style={{ cursor: 'pointer' }}
                  stroke={selectedRunIndex === i ? 'var(--text-primary)' : 'none'}
                  strokeWidth={1}
                  onClick={() => setSelectedRunIndex(i === selectedRunIndex ? null : i)}
                />
              )
            })}
          </svg>
          {selectedRunIndex !== null && sparkRuns[selectedRunIndex] && (() => {
            const run = sparkRuns[selectedRunIndex]
            const durMin = Math.floor(run.durationMs / 60000)
            const durSec = Math.floor((run.durationMs % 60000) / 1000)
            const dur = durMin > 0 ? `${durMin}m ${durSec}s` : `${durSec}s`
            const ts = new Date(run.timestamp)
            const sessionExists = run.sessionId ? instances.some(inst => inst.id === run.sessionId) : false
            return (
              <div className={`persona-run-detail${run.success ? '' : ' failed'}`}>
                <div className="persona-run-detail-row">
                  <span className="persona-run-detail-label">Time</span>
                  <span>{ts.toLocaleString()}</span>
                </div>
                <div className="persona-run-detail-row">
                  <span className="persona-run-detail-label">Duration</span>
                  <span>{dur}</span>
                </div>
                <div className="persona-run-detail-row">
                  <span className="persona-run-detail-label">Cost</span>
                  <span>{run.costUsd !== undefined ? `$${run.costUsd.toFixed(2)}` : '—'}</span>
                </div>
                <div className="persona-run-detail-row">
                  <span className="persona-run-detail-label">Outcome</span>
                  <span className={`persona-run-detail-badge ${run.success ? 'success' : 'fail'}`}>
                    {run.success
                      ? (run.stopReason === 'budget_exceeded' ? 'Budget stopped' : run.stopReason === 'manual' ? 'Stopped' : 'Success')
                      : 'Failed'}
                  </span>
                </div>
                {run.stopReason && run.stopReason !== 'budget_exceeded' && run.stopReason !== 'manual' && (
                  <div className="persona-run-detail-row">
                    <span className="persona-run-detail-label">Stop Reason</span>
                    <span>{run.stopReason}</span>
                  </div>
                )}
                {run.sessionId && (
                  <div className="persona-run-detail-row">
                    <span className="persona-run-detail-label">Session</span>
                    {sessionExists
                      ? <button className="persona-run-detail-session-btn" onClick={() => onFocusInstance(run.sessionId!)}>View Session</button>
                      : <span className="persona-run-detail-ended">Session cleaned up</span>
                    }
                  </div>
                )}
              </div>
            )
          })()}
        </div>
      )}

      {/* Daily cost bar chart */}
      {analytics.costLast7d > 0 && (
        <div className="persona-analytics-chart">
          <div className="persona-analytics-chart-label">Daily Cost (7d)</div>
          <svg width="100%" height={40} viewBox="0 0 98 40" preserveAspectRatio="none">
            {dailyCosts.map((c, i) => {
              const h = Math.max(c > 0 ? 4 : 0, (c / maxCost) * 36)
              return (
                <rect
                  key={i}
                  x={i * 14}
                  y={40 - h}
                  width={10}
                  height={h}
                  rx={2}
                  fill="var(--accent)"
                  opacity={0.75}
                />
              )
            })}
          </svg>
        </div>
      )}

      {/* Recent runs table */}
      <div className="persona-analytics-table" style={showAllRuns ? { maxHeight: 400, overflowY: 'auto' } : undefined}>
        <div className="persona-analytics-table-header">
          <span>Status</span>
          <span>When</span>
          <span>Duration</span>
          <span>Cost</span>
        </div>
        {(showAllRuns ? analytics.recentRuns : analytics.recentRuns.slice(0, 10)).map((r, i) => {
          const secs = (Date.now() - new Date(r.timestamp).getTime()) / 1000
          const ago = secs < 60 ? 'just now' : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : secs < 86400 ? `${Math.floor(secs / 3600)}h ago` : `${Math.floor(secs / 86400)}d ago`
          const durMin = Math.floor(r.durationMs / 60000)
          const durSec = Math.floor((r.durationMs % 60000) / 1000)
          const dur = durMin > 0 ? `${durMin}m ${durSec}s` : `${durSec}s`
          return (
            <div key={i} className="persona-analytics-table-row">
              <span className={`persona-history-status ${r.success ? 'success' : 'fail'}`}>
                {r.success ? <Check size={11} /> : <X size={11} />}
              </span>
              <span>{ago}</span>
              <span>{dur}</span>
              <span>{r.costUsd !== undefined ? `$${r.costUsd.toFixed(2)}` : '—'}</span>
            </div>
          )
        })}
      </div>
      {analytics.recentRuns.length > 10 && (
        <button className="persona-analytics-show-more" onClick={() => setShowAllRuns(!showAllRuns)}>
          {showAllRuns ? 'Show less' : `Show all ${analytics.recentRuns.length} runs`}
        </button>
      )}
    </div>
  )
}

const PERSONA_RUN_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: 'claude-opus-4-6', label: 'Opus 4.6' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

function PersonaRunWithOptionsDialog({ persona, onRun, onClose }: {
  persona: PersonaInfo
  onRun: (overrides: { model?: string; maxCostUsd?: number; promptPrefix?: string }) => void
  onClose: () => void
}) {
  const [promptPrefix, setPromptPrefix] = useState('')
  const [model, setModel] = useState('')
  const [maxCostUsd, setMaxCostUsd] = useState('')

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleRun()
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose, promptPrefix, model, maxCostUsd])

  const handleRun = () => {
    const budget = parseFloat(maxCostUsd)
    onRun({
      promptPrefix: promptPrefix.trim() || undefined,
      model: model || undefined,
      maxCostUsd: !isNaN(budget) && budget > 0 ? budget : undefined,
    })
  }

  const fieldStyle: React.CSSProperties = { marginBottom: 12 }
  const labelStyle: React.CSSProperties = { display: 'block', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 4 }
  const inputStyle: React.CSSProperties = { width: '100%', background: 'var(--bg-primary)', color: 'var(--text-primary)', border: '1px solid var(--border)', borderRadius: 4, padding: '5px 8px', fontSize: 12, boxSizing: 'border-box' }

  return (
    <>
      <div style={fieldStyle}>
        <label style={labelStyle}>Prompt prefix</label>
        <textarea
          value={promptPrefix}
          onChange={e => setPromptPrefix(e.target.value)}
          rows={4}
          style={{ ...inputStyle, fontFamily: 'monospace', resize: 'vertical' }}
          placeholder="Additional context prepended to the persona prompt for this run only"
          autoFocus
        />
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Model override</label>
          <select value={model} onChange={e => setModel(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
            <option value="">(persona default: {persona.model || 'CLI default'})</option>
            {PERSONA_RUN_MODELS.map(m => <option key={m.id} value={m.id} title={m.id}>{m.label}</option>)}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label style={labelStyle}>Budget cap ($)</label>
          <input
            type="number"
            value={maxCostUsd}
            onChange={e => setMaxCostUsd(e.target.value)}
            style={inputStyle}
            placeholder="e.g. 2.50"
            min={0}
            step={0.5}
          />
        </div>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 0, marginBottom: 12 }}>
        Overrides apply to this run only — persona file is not modified. Cmd+Enter to run.
      </p>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose} style={{ padding: '5px 12px' }}>Cancel</button>
        <button className="panel-header-btn primary" onClick={handleRun} style={{ padding: '5px 12px' }}>Run</button>
      </div>
    </>
  )
}

interface PersonaCardProps {
  persona: PersonaInfo
  expanded: boolean
  instances: ClaudeInstance[]
  allPersonas: PersonaInfo[]
  analytics: PersonaAnalytics | null
  selected: boolean
  onToggleSelect: () => void
  compareMode?: boolean
  compareSelected?: boolean
  onCompareToggle?: () => void
  onToggleExpand: () => void
  onRun: () => void
  onStop: () => void
  onToggle: (enabled: boolean) => void
  onDrain: () => void
  onDelete: () => void
  onFocusInstance: (id: string) => void
  onViewFile: () => void
  onEditFile: () => void
  onEditMeta: () => void
  onDuplicate: () => void
  onScheduleSave: (schedule: string) => Promise<void>
  onWhisper: (text: string) => Promise<void>
  onDeleteNote: (index: number) => Promise<void>
  onUpdateNote: (index: number, newText: string) => Promise<void>
  cronsPaused: boolean
  onContextMenu?: (e: React.MouseEvent) => void
}

function PersonaCard({
  persona, expanded, instances, allPersonas, analytics, selected, onToggleSelect,
  compareMode, compareSelected, onCompareToggle,
  onToggleExpand, onRun, onStop, onToggle, onDrain, onDelete, onDuplicate, onFocusInstance, onViewFile, onEditFile, onEditMeta, onScheduleSave, onWhisper, onDeleteNote, onUpdateNote, cronsPaused, onContextMenu
}: PersonaCardProps) {
  const [editingSchedule, setEditingSchedule] = useState(false)
  const [whisperOpen, setWhisperOpen] = useState(false)
  const [whisperText, setWhisperText] = useState('')
  const [editingNoteIndex, setEditingNoteIndex] = useState<number | null>(null)
  const [editNoteText, setEditNoteText] = useState('')
  const [activeTab, setActiveTab] = useState<'content' | 'outputs' | 'history' | 'analytics' | 'memory'>('content')
  const [artifacts, setArtifacts] = useState<PersonaArtifact[] | null>(null)
  const [viewingArtifact, setViewingArtifact] = useState<{ name: string; content: string } | null>(null)
  const [copiedArtifact, setCopiedArtifact] = useState(false)
  const [runHistory, setRunHistory] = useState<PersonaRunEntry[] | null>(null)
  const [memory, setMemory] = useState<PersonaMemory | null>(null)
  const [addingSituation, setAddingSituation] = useState(false)
  const [addingLearning, setAddingLearning] = useState(false)
  const [newSituationText, setNewSituationText] = useState('')
  const [newLearningText, setNewLearningText] = useState('')
  const [editingIdx, setEditingIdx] = useState<{ section: 'situation' | 'learning'; index: number } | null>(null)
  const [editingText, setEditingText] = useState('')
  const [addingLogEntry, setAddingLogEntry] = useState(false)
  const [newLogText, setNewLogText] = useState('')
  const whisperRef = useRef<HTMLTextAreaElement>(null)
  const { ref: whisperBarRef, isDragging: whisperDragging } = useFileDrop(paths => {
    const pathText = paths.join('\n')
    setWhisperText(prev => prev ? prev + '\n' + pathText : pathText)
    setWhisperOpen(true)
    setTimeout(() => whisperRef.current?.focus(), 0)
  })
  const [briefContent, setBriefContent] = useState<string | null | 'loading'>(null)
  const [briefMtime, setBriefMtime] = useState<number | null>(null)
  const [briefDiff, setBriefDiff] = useState<string | null | 'loading'>(null)
  const [briefDiffOpen, setBriefDiffOpen] = useState(false)
  const fromName = (id: string) => allPersonas.find(p => p.id === id)?.name ?? id

  useLayoutEffect(() => {
    if (whisperOpen) whisperRef.current?.focus()
  }, [whisperOpen])

  useEffect(() => {
    if (!expanded || briefContent !== null) return
    setBriefContent('loading')
    window.api.persona.getContent(persona.id + '.brief').then(({ content, mtime }) => {
      setBriefContent(content ?? '')  // '' = "attempted, not found" — prevents re-fetch loop
      setBriefMtime(mtime)
    })
  }, [expanded, persona.id, briefContent])

  useEffect(() => {
    if (!expanded || activeTab !== 'outputs' || artifacts !== null) return
    window.api.persona.getArtifacts(persona.id).then(setArtifacts)
  }, [expanded, activeTab, persona.id, artifacts])

  useEffect(() => {
    if (!expanded || activeTab !== 'history' || runHistory !== null) return
    window.api.persona.getRunHistory(persona.id).then(setRunHistory)
  }, [expanded, activeTab, persona.id, runHistory])

  useEffect(() => {
    if (!expanded || activeTab !== 'memory' || memory !== null) return
    window.api.personaMemory.get(persona.id).then(setMemory)
  }, [expanded, activeTab, persona.id, memory])

  const handleViewArtifact = async (artifact: PersonaArtifact) => {
    const content = await window.api.persona.readArtifact(persona.id, artifact.name)
    if (content !== null) setViewingArtifact({ name: artifact.name, content })
  }

  const handleWhisperSubmit = async () => {
    const text = whisperText.trim()
    if (!text) return
    setWhisperText('')
    setWhisperOpen(false)
    await onWhisper(text)
  }
  const isRunning = persona.activeSessionId !== null
  const statusClass = isRunning ? 'running' : persona.enabled ? 'idle' : 'disabled'
  const whispers = persona.whispers ?? []
  const allSections = parseSections(persona.content)
  const sections = expanded ? allSections : {}

  return (
    <div className={`persona-list-row ${isRunning ? 'running' : persona.enabled ? 'enabled' : 'disabled'}${compareSelected ? ' compare-selected' : ''}`}>
      {/* List mode — compact single-line row */}
      <div
        className="persona-list-row-main"
        onClick={compareMode ? (e) => { e.stopPropagation(); onCompareToggle?.() } : onToggleExpand}
        onContextMenu={onContextMenu}
      >
          <input
            type="checkbox"
            className="persona-select-checkbox"
            checked={selected}
            onChange={(e) => { e.stopPropagation(); onToggleSelect() }}
            onClick={(e) => e.stopPropagation()}
          />
          <span className="persona-list-expand">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
          <span className={`persona-card-status-dot ${statusClass}`} />
          <span className="persona-list-name-col">
            <span className="persona-list-name">{persona.name}</span>
            {persona.briefPreview && (
              <span className="persona-list-brief" title={persona.briefPreview}>{persona.briefPreview}</span>
            )}
          </span>
          {(() => {
            const hs = persona.healthScore
            if (!hs || hs.status === 'unknown') return null
            const statusClass = hs.status
            const tooltip = `${hs.totalRuns} run${hs.totalRuns !== 1 ? 's' : ''} · ${hs.successRate}% success · avg $${hs.avgCost.toFixed(2)} · avg ${Math.round(hs.avgDuration / 60000)}m${hs.consecutiveFailures > 0 ? ` · ${hs.consecutiveFailures} consecutive failure${hs.consecutiveFailures !== 1 ? 's' : ''}` : ''}`
            return (
              <Tooltip text={tooltip}>
                <span className={`persona-health-dot health-${statusClass}`} />
              </Tooltip>
            )
          })()}
          {isRunning && <span className="persona-list-badge running">Running</span>}
          {persona.runOnStartup && <span className="persona-list-badge startup" title="Fires on app startup">Startup</span>}
          {(persona.minIntervalMinutes ?? 0) > 0 && persona.lastRun && (() => {
            const elapsed = (Date.now() - new Date(persona.lastRun).getTime()) / 60000
            const remaining = Math.ceil((persona.minIntervalMinutes ?? 0) - elapsed)
            if (remaining > 0) return (
              <span className="persona-list-badge cooldown" title={`Cooldown active — ${remaining}m until next auto-run allowed`}>
                <Timer size={9} />{remaining}m
              </span>
            )
            return null
          })()}
          {persona.draining && <span className="persona-list-badge draining" title="Draining — will disable after current session and triggers complete">Draining</span>}
          {!isRunning && (persona.retryCount ?? 0) > 0 && (
            <span className="persona-list-badge retry" title={`Auto-retrying: attempt ${persona.retryCount}`}>
              ↺ {persona.retryCount}
            </span>
          )}
          {isRunning && persona.triggeredBy && (
            <span className="persona-list-badge triggered-by" title={`Triggered by ${persona.triggeredBy}`}>
              ↳ {persona.triggeredBy.length > 18 ? persona.triggeredBy.slice(0, 16) + '…' : persona.triggeredBy}
            </span>
          )}
          {!isRunning && persona.pendingTrigger && (
            <span className="persona-list-badge pending" title={`Queued by ${fromName(persona.pendingTrigger.from)}${persona.pendingTrigger.note ? `: ${persona.pendingTrigger.note}` : ''}`}>
              <Hourglass size={9} /> queued
            </span>
          )}
          {(persona.pendingRunCount ?? 0) > 0 && (
            <span className="persona-list-badge queued-runs" title={`${persona.pendingRunCount} run(s) queued — will start after current session exits`}>
              <Hourglass size={9} /> {persona.pendingRunCount} in queue
            </span>
          )}
          <span className="persona-list-schedule">
            <Clock size={9} /> {persona.schedule ? describeCron(persona.schedule) : 'Manual'}
          </span>
          {persona.lastRun ? (
            <span className="persona-list-lastrun" title={new Date(persona.lastRun).toLocaleString()}>
              {formatRelativeTime(persona.lastRun)}
            </span>
          ) : (
            <span className="persona-list-lastrun muted">—</span>
          )}
          {persona.schedule && (
            <span className="persona-list-cron-chip" title={persona.schedule}>{describeCron(persona.schedule)}</span>
          )}
          {persona.schedule && (() => {
            if (!persona.enabled) return <span className="persona-list-next-run paused">Paused</span>
            if (cronsPaused) return <span className="persona-list-next-run paused">Paused (manual)</span>
            const fires = nextRuns(persona.schedule, 1)
            if (fires.length === 0) return <span className="persona-list-next-run">—</span>
            const diffMs = fires[0].getTime() - Date.now()
            if (diffMs < 0) return <span className="persona-list-next-run">—</span>
            const mins = Math.floor(diffMs / 60000)
            let label: string
            if (mins < 1) label = '<1m'
            else if (mins < 60) label = `${mins}m`
            else if (mins < 1440) label = `${Math.floor(mins / 60)}h ${mins % 60}m`
            else label = fires[0].toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
            return <span className="persona-list-next-run" title={fires[0].toLocaleString()}>Next: {label}</span>
          })()}
          <span className="persona-list-model">{persona.model || 'sonnet'}</span>
          {persona.maxCostUsd != null && <span className="persona-list-cost-cap" title={`Session cost cap: $${persona.maxCostUsd.toFixed(2)}`}>${persona.maxCostUsd.toFixed(2)} cap</span>}
          {persona.maxCostPerDayUsd != null && analytics != null && (() => {
            const pct = analytics.dailyCostUsd / persona.maxCostPerDayUsd! * 100
            const cls = pct >= 100 ? 'persona-list-daily-cap danger' : pct >= 75 ? 'persona-list-daily-cap warn' : 'persona-list-daily-cap'
            return <span className={cls} title={`Daily cap (trailing 24h): $${analytics.dailyCostUsd.toFixed(2)} of $${persona.maxCostPerDayUsd!.toFixed(2)}`}>${analytics.dailyCostUsd.toFixed(2)} / ${persona.maxCostPerDayUsd!.toFixed(2)} today</span>
          })()}
          {persona.monthlyBudgetUsd != null && persona.monthlyCostUsd != null && (() => {
            const spent = persona.monthlyCostUsd!
            const budget = persona.monthlyBudgetUsd!
            const ratio = spent / budget
            const pct = Math.min(100, ratio * 100)
            const barColor = ratio >= 0.95 ? 'var(--danger)' : ratio >= 0.8 ? 'var(--warning)' : 'var(--success)'
            return (
              <div className="persona-budget-bar" title={`Monthly budget: $${spent.toFixed(2)} of $${budget.toFixed(2)}`}>
                <div className="persona-budget-fill" style={{ width: `${pct}%`, background: barColor }} />
              </div>
            )
          })()}
          {analytics && analytics.totalRuns > 0 && (
            <span className="persona-list-stats">
              <span className={`persona-stat-chip ${analytics.successRate >= 80 ? 'good' : analytics.successRate >= 50 ? 'warn' : 'bad'}`} title={`Success rate: ${analytics.successRate}%`}>
                {Math.round(analytics.successRate)}%
              </span>
              {analytics.costLast7d > 0 && (
                <span className="persona-stat-chip cost" title={`Cost last 7 days: $${analytics.costLast7d.toFixed(2)}`}>
                  ${analytics.costLast7d < 1 ? analytics.costLast7d.toFixed(2) : analytics.costLast7d.toFixed(0)}
                </span>
              )}
            </span>
          )}
          {analytics && analytics.recentRuns.length > 0 && (
            <PersonaRunStrip runs={analytics.recentRuns} />
          )}
          <div className="persona-list-actions" onClick={(e) => e.stopPropagation()}>
            {!isRunning ? (
              <Tooltip text="Run persona">
                <button className="persona-action-btn" onClick={onRun}><Play size={11} /></button>
              </Tooltip>
            ) : (
              <Tooltip text="Stop persona">
                <button className="persona-action-btn running" onClick={onStop}><Square size={11} /></button>
              </Tooltip>
            )}
            <Tooltip text="Edit schedule, model, and settings">
              <button className="persona-action-btn" onClick={onEditMeta}><Pencil size={11} /></button>
            </Tooltip>
            <Tooltip text="Duplicate persona">
              <button className="persona-action-btn" onClick={onDuplicate}><Copy size={11} /></button>
            </Tooltip>
            <Tooltip text="Add a note for this persona's next run">
              <button className={`persona-action-btn${whispers.length > 0 ? ' whisper-active' : ''}`} onClick={() => setWhisperOpen(v => !v)}>
                <StickyNote size={11} />
                {whispers.length > 0 && <span className="persona-whisper-badge">{whispers.length}</span>}
              </button>
            </Tooltip>
            {persona.attentionCount > 0 && (
              <Tooltip text={`${persona.attentionCount} unresolved attention request${persona.attentionCount !== 1 ? 's' : ''}`}>
                <button className="persona-action-btn attention-active">
                  <Bell size={11} />
                  <span className="persona-attention-badge">{persona.attentionCount}</span>
                </button>
              </Tooltip>
            )}
            {persona.enabled && !persona.draining && (
              <Tooltip text="Drain — finish current session and triggers, then disable">
                <button className="persona-action-btn" onClick={onDrain}><Timer size={11} /></button>
              </Tooltip>
            )}
            <button
              className="persona-toggle"
              onClick={() => onToggle(!persona.enabled)}
              title={persona.enabled ? 'Disable scheduled runs' : 'Enable scheduled runs'}
            >
              <div className={`persona-toggle-track${persona.enabled ? ' enabled' : ''}`}>
                <div className="persona-toggle-thumb" />
              </div>
            </button>
            <Tooltip text="Delete persona">
              <button className="persona-action-btn danger" onClick={onDelete}><Trash2 size={11} /></button>
            </Tooltip>
          </div>
        </div>

      {editingSchedule && (
        <CronEditor
          value={persona.schedule}
          onSave={async (val) => {
            await onScheduleSave(val)
            setEditingSchedule(false)
          }}
          onClose={() => setEditingSchedule(false)}
        />
      )}

      {whisperOpen && (
        <div ref={whisperBarRef} className={`persona-whisper-bar${whisperDragging ? ' dragging' : ''}`} onClick={(e) => e.stopPropagation()}>
          <StickyNote size={13} className="persona-whisper-icon" />
          <textarea
            ref={whisperRef}
            className="persona-whisper-input"
            placeholder="Leave a note for next run… or drop files to include paths. Enter to save, Shift+↵ for newline"
            rows={2}
            value={whisperText}
            onChange={(e) => setWhisperText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleWhisperSubmit() }
              if (e.key === 'Escape') { setWhisperOpen(false); setWhisperText('') }
            }}
            onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) e.preventDefault() }}
            onDrop={(e) => e.preventDefault()}
          />
          <button
            className="persona-whisper-send"
            disabled={!whisperText.trim()}
            onClick={handleWhisperSubmit}
          >
            <Send size={12} />
          </button>
        </div>
      )}

      {/* Pending notes preview — visible when collapsed in both card and list mode */}
      {!expanded && !whisperOpen && whispers.length > 0 && (
        <div className="persona-whispers-preview" onClick={onToggleExpand}>
          {whispers.slice(0, 2).map((w, i) => (
            <div key={i} className="persona-whisper-entry">
              <StickyNote size={10} className="persona-whisper-entry-icon" />
              <span className="persona-whisper-entry-text">{w.text}</span>
            </div>
          ))}
          {whispers.length > 2 && (
            <span className="persona-whisper-more">+{whispers.length - 2} more</span>
          )}
        </div>
      )}

      {viewingArtifact && (
        <div className="persona-modal-overlay" onClick={() => { setViewingArtifact(null); setCopiedArtifact(false) }}>
          <div className="persona-modal persona-edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="persona-modal-header">
              <h3><FolderOpen size={14} /> {viewingArtifact.name}</h3>
              <button
                className="persona-modal-close"
                onClick={async () => {
                  await navigator.clipboard.writeText(viewingArtifact.content)
                  setCopiedArtifact(true)
                  setTimeout(() => setCopiedArtifact(false), 1000)
                }}
                title="Copy to clipboard"
              >
                {copiedArtifact ? <Check size={16} /> : <Copy size={16} />}
              </button>
              <button className="persona-modal-close" onClick={() => { setViewingArtifact(null); setCopiedArtifact(false) }}><X size={16} /></button>
            </div>
            <pre className="persona-artifact-content">{viewingArtifact.content}</pre>
          </div>
        </div>
      )}

      {expanded && (
        <div className="persona-card-body">
          {/* Content / Outputs tab bar */}
          <div className="persona-card-tabs">
            <button
              className={`persona-card-tab${activeTab === 'content' ? ' active' : ''}`}
              onClick={() => setActiveTab('content')}
            >Content</button>
            <button
              className={`persona-card-tab${activeTab === 'outputs' ? ' active' : ''}`}
              onClick={() => setActiveTab('outputs')}
            ><FolderOpen size={10} /> Outputs</button>
            <button
              className={`persona-card-tab${activeTab === 'history' ? ' active' : ''}`}
              onClick={() => setActiveTab('history')}
            ><Clock size={10} /> History</button>
            <button
              className={`persona-card-tab${activeTab === 'analytics' ? ' active' : ''}`}
              onClick={() => setActiveTab('analytics')}
            ><BarChart3 size={10} /> Analytics</button>
            <button
              className={`persona-card-tab${activeTab === 'memory' ? ' active' : ''}`}
              onClick={() => setActiveTab('memory')}
            ><Brain size={10} /> Memory</button>
          </div>

          {activeTab === 'outputs' && (
            <div className="persona-outputs-tab">
              {artifacts === null ? (
                <div className="persona-outputs-loading"><Loader2 size={13} className="spin" /> Loading…</div>
              ) : artifacts.length === 0 ? (
                <div className="persona-outputs-empty">No outputs yet</div>
              ) : (
                <>
                  {artifacts.filter(a => !a.isPrevBrief).map((a) => {
                    const kb = (a.sizeBytes / 1024).toFixed(1)
                    const secs = (Date.now() - a.modifiedAt) / 1000
                    const ago = secs < 60 ? 'just now' : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`
                    const hasPrevBrief = a.isBrief && artifacts.some(x => x.isPrevBrief)
                    return (
                      <div key={a.name} className="persona-artifact-row-wrap">
                        <div className="persona-artifact-row-inner">
                          <button className="persona-artifact-row" onClick={() => handleViewArtifact(a)}>
                            <span className="persona-artifact-name">
                              {a.isBrief ? <><FileText size={10} /> Session Brief</> : a.name}
                            </span>
                            <span className="persona-artifact-meta">{kb} KB · {ago}</span>
                          </button>
                          {hasPrevBrief && (
                            <button
                              className={`persona-artifact-diff-btn${briefDiffOpen ? ' active' : ''}`}
                              title="Show diff from previous run"
                              onClick={async () => {
                                if (briefDiffOpen) { setBriefDiffOpen(false); return }
                                setBriefDiffOpen(true)
                                if (briefDiff === null) {
                                  setBriefDiff('loading')
                                  const d = await window.api.persona.briefDiff(persona.id)
                                  setBriefDiff(d)
                                }
                              }}
                            >
                              <GitCompare size={11} />
                            </button>
                          )}
                        </div>
                        {hasPrevBrief && briefDiffOpen && briefDiff !== null && (
                          <div className="persona-brief-diff">
                            {briefDiff === 'loading' ? (
                              <div className="persona-outputs-loading"><Loader2 size={13} className="spin" /> Loading diff…</div>
                            ) : briefDiff ? (
                              <DiffViewer diff={briefDiff} filename="brief.md" />
                            ) : (
                              <div className="persona-outputs-empty">No changes since previous run.</div>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </>
              )}
            </div>
          )}

          {activeTab === 'history' && (
            <div className="persona-outputs-tab">
              {runHistory === null ? (
                <div className="persona-outputs-loading"><Loader2 size={13} className="spin" /> Loading…</div>
              ) : runHistory.length === 0 ? (
                <div className="persona-outputs-empty">No run history yet — history records after each session completes.</div>
              ) : (
                <>
                  <PersonaRunSparkline entries={runHistory} />
                  <div className="persona-history-list">
                    {runHistory.map((entry, i) => {
                      const secs = (Date.now() - new Date(entry.timestamp).getTime()) / 1000
                      const ago = secs < 60 ? 'just now' : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : secs < 86400 ? `${Math.floor(secs / 3600)}h ago` : `${Math.floor(secs / 86400)}d ago`
                      const durMin = Math.floor(entry.durationMs / 60000)
                      const durSec = Math.floor((entry.durationMs % 60000) / 1000)
                      const dur = durMin > 0 ? `${durMin}m ${durSec}s` : `${durSec}s`
                      return (
                        <div key={i} className={`persona-history-row${entry.sessionId ? ' clickable' : ''}`}
                          onClick={() => entry.sessionId && onFocusInstance?.(entry.sessionId)}
                          title={entry.sessionId ? 'Click to focus session' : undefined}
                        >
                          <span className={`persona-history-status ${entry.success ? 'success' : 'fail'}`} title={entry.stopReason === 'manual' ? 'Manually stopped' : entry.success ? 'Completed successfully' : 'Run failed'}>
                            {entry.success ? <Check size={12} /> : <X size={12} />}
                          </span>
                          {!entry.success && entry.stopReason !== 'manual' && (
                            <span className="persona-history-reason">
                              {entry.stopReason === 'budget_exceeded' ? 'budget exceeded'
                                : entry.stopReason === 'timeout' ? 'timed out'
                                : 'failed'}
                            </span>
                          )}
                          <span className="persona-history-time">{ago}</span>
                          <span className="persona-history-dur">{dur}</span>
                          {entry.costUsd != null && entry.costUsd > 0 && (
                            <span className="persona-history-cost">${entry.costUsd.toFixed(2)}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'analytics' && (
            <PersonaAnalyticsTab analytics={analytics} personaName={persona.name} onRun={onRun} instances={instances} onFocusInstance={onFocusInstance} />
          )}

          {activeTab === 'memory' && (
            <div className="persona-memory-tab">
              {memory === null ? (
                <div className="persona-outputs-loading"><Loader2 size={13} className="spin" /> Loading…</div>
              ) : (
                <>
                  <div className="persona-memory-section">
                    <h4 className="persona-memory-heading">
                      Active Situations
                      <button
                        className="persona-memory-add"
                        onClick={() => setAddingSituation(!addingSituation)}
                        title="Add situation"
                      ><Plus size={10} /></button>
                    </h4>
                    {addingSituation && (
                      <div className="persona-memory-add-form">
                        <input
                          type="text"
                          value={newSituationText}
                          onChange={e => setNewSituationText(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && newSituationText.trim()) {
                              window.api.personaMemory.addSituation(persona.id, {
                                status: 'pending',
                                text: newSituationText.trim(),
                                updatedAt: new Date().toISOString()
                              }).then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                              setNewSituationText('')
                              setAddingSituation(false)
                            }
                          }}
                          placeholder="Describe the situation…"
                          autoFocus
                        />
                        <button
                          className="persona-memory-add-btn"
                          onClick={() => {
                            if (!newSituationText.trim()) return
                            window.api.personaMemory.addSituation(persona.id, {
                              status: 'pending',
                              text: newSituationText.trim(),
                              updatedAt: new Date().toISOString()
                            }).then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                            setNewSituationText('')
                            setAddingSituation(false)
                          }}
                        >Add</button>
                      </div>
                    )}
                    {memory.activeSituations.length === 0 && !addingSituation ? (
                      <div className="persona-memory-empty">No active situations</div>
                    ) : memory.activeSituations.map((s, i) => (
                      <div key={i} className="persona-memory-situation">
                        <span
                          className={`persona-memory-status ${s.status}`}
                          onClick={() => {
                            const order = ['pending', 'done', 'delegated', 'blocked'] as const
                            const next = order[(order.indexOf(s.status as typeof order[number]) + 1) % order.length]
                            window.api.personaMemory.updateSituation(persona.id, i, { status: next })
                              .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                          }}
                          title={`Click to cycle status (current: ${s.status})`}
                          style={{ cursor: 'pointer' }}
                        >{s.status}</span>
                        {editingIdx?.section === 'situation' && editingIdx.index === i ? (
                          <input
                            className="persona-memory-edit-input"
                            value={editingText}
                            onChange={e => setEditingText(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && editingText.trim()) {
                                window.api.personaMemory.updateSituation(persona.id, i, { text: editingText.trim() })
                                  .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                                setEditingIdx(null)
                              } else if (e.key === 'Escape') setEditingIdx(null)
                            }}
                            onBlur={() => {
                              if (editingText.trim() && editingText.trim() !== s.text) {
                                window.api.personaMemory.updateSituation(persona.id, i, { text: editingText.trim() })
                                  .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                              }
                              setEditingIdx(null)
                            }}
                            autoFocus
                          />
                        ) : (
                          <span
                            className="persona-memory-text"
                            onDoubleClick={() => { setEditingIdx({ section: 'situation', index: i }); setEditingText(s.text) }}
                          >{s.text}</span>
                        )}
                        <button
                          className="persona-memory-remove"
                          onClick={() => {
                            window.api.personaMemory.removeSituation(persona.id, i)
                              .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                          }}
                          title="Remove situation"
                        ><X size={10} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="persona-memory-section">
                    <h4 className="persona-memory-heading">
                      Learnings
                      <button
                        className="persona-memory-add"
                        onClick={() => setAddingLearning(!addingLearning)}
                        title="Add learning"
                      ><Plus size={10} /></button>
                    </h4>
                    {addingLearning && (
                      <div className="persona-memory-add-form">
                        <input
                          type="text"
                          value={newLearningText}
                          onChange={e => setNewLearningText(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && newLearningText.trim()) {
                              window.api.personaMemory.addLearning(persona.id, newLearningText.trim())
                                .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                              setNewLearningText('')
                              setAddingLearning(false)
                            }
                          }}
                          placeholder="What did the persona learn?"
                          autoFocus
                        />
                        <button
                          className="persona-memory-add-btn"
                          onClick={() => {
                            if (!newLearningText.trim()) return
                            window.api.personaMemory.addLearning(persona.id, newLearningText.trim())
                              .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                            setNewLearningText('')
                            setAddingLearning(false)
                          }}
                        >Add</button>
                      </div>
                    )}
                    {memory.learnings.length === 0 && !addingLearning ? (
                      <div className="persona-memory-empty">No learnings yet</div>
                    ) : memory.learnings.map((l, i) => (
                      <div key={i} className="persona-memory-learning">
                        {editingIdx?.section === 'learning' && editingIdx.index === i ? (
                          <input
                            className="persona-memory-edit-input"
                            value={editingText}
                            onChange={e => setEditingText(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === 'Enter' && editingText.trim()) {
                                const updated = memory.learnings.map((l2, j) =>
                                  j === i ? { ...l2, text: editingText.trim() } : l2
                                )
                                window.api.personaMemory.setLearnings(persona.id, updated)
                                  .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                                setEditingIdx(null)
                              } else if (e.key === 'Escape') setEditingIdx(null)
                            }}
                            onBlur={() => {
                              if (editingText.trim() && editingText.trim() !== l.text) {
                                const updated = memory.learnings.map((l2, j) =>
                                  j === i ? { ...l2, text: editingText.trim() } : l2
                                )
                                window.api.personaMemory.setLearnings(persona.id, updated)
                                  .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                              }
                              setEditingIdx(null)
                            }}
                            autoFocus
                          />
                        ) : (
                          <span
                            className="persona-memory-text"
                            onDoubleClick={() => { setEditingIdx({ section: 'learning', index: i }); setEditingText(l.text) }}
                          >{l.text}</span>
                        )}
                        <span className="persona-memory-time">{formatRelativeTime(l.addedAt)}</span>
                        <button
                          className="persona-memory-remove"
                          onClick={() => {
                            window.api.personaMemory.removeLearning(persona.id, i)
                              .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                          }}
                          title="Remove learning"
                        ><X size={10} /></button>
                      </div>
                    ))}
                  </div>
                  <div className="persona-memory-section">
                    <h4 className="persona-memory-heading">
                      Session Log
                      <button
                        className="persona-memory-add"
                        onClick={() => setAddingLogEntry(!addingLogEntry)}
                        title="Add manual note"
                      ><Plus size={10} /></button>
                      {memory.sessionLog.length > 5 && (
                        <button
                          className="persona-memory-clear"
                          onClick={() => {
                            window.api.personaMemory.setLog(persona.id, memory.sessionLog.slice(-5))
                              .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                          }}
                          title="Keep only last 5 entries"
                        ><Trash2 size={10} /></button>
                      )}
                    </h4>
                    {addingLogEntry && (
                      <div className="persona-memory-add-form">
                        <input
                          type="text"
                          value={newLogText}
                          onChange={e => setNewLogText(e.target.value)}
                          onKeyDown={e => {
                            if (e.key === 'Enter' && newLogText.trim()) {
                              window.api.personaMemory.addLogEntry(persona.id, newLogText.trim())
                                .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                              setNewLogText('')
                              setAddingLogEntry(false)
                            }
                          }}
                          placeholder="Add a manual note..."
                          autoFocus
                        />
                        <button
                          className="persona-memory-add-btn"
                          onClick={() => {
                            if (!newLogText.trim()) return
                            window.api.personaMemory.addLogEntry(persona.id, newLogText.trim())
                              .then(() => window.api.personaMemory.get(persona.id).then(setMemory))
                            setNewLogText('')
                            setAddingLogEntry(false)
                          }}
                        >Add</button>
                      </div>
                    )}
                    {memory.sessionLog.length === 0 && !addingLogEntry ? (
                      <div className="persona-memory-empty">No session log</div>
                    ) : [...memory.sessionLog].reverse().map((entry, i) => (
                      <div key={i} className="persona-memory-log-entry">
                        <span className="persona-memory-time">{formatRelativeTime(entry.timestamp)}</span>
                        <span className="persona-memory-text">{entry.summary}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'content' && <>
          {/* Status bar */}
          <div className="persona-card-status-bar">
            {isRunning && persona.activeSessionId ? (
              <>
                <span className="persona-status-badge running">
                  <span className="persona-card-status-dot running" /> Running
                </span>
                <button className="persona-status-view-btn" onClick={() => onFocusInstance(persona.activeSessionId!)}>
                  View Session
                </button>
              </>
            ) : (
              <span className="persona-status-badge idle">Idle</span>
            )}
            {persona.lastRun && (
              <span className="persona-status-last-run">
                Last run: {new Date(persona.lastRun).toLocaleString()}
              </span>
            )}
            {persona.lastSkipped && Date.now() - persona.lastSkipped < 2 * 60 * 60 * 1000 && (
              <span className="persona-status-last-run" style={{ color: 'var(--text-muted)' }}>
                No new commits — checked {(() => {
                  const secs = Math.floor((Date.now() - persona.lastSkipped) / 1000)
                  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
                  return `${Math.floor(secs / 3600)}h ago`
                })()}
              </span>
            )}
            <div className="persona-card-footer-inline">
              <span className={`persona-permission-badge ${persona.canPush ? 'allowed' : 'denied'}`}>Push</span>
              <span className={`persona-permission-badge ${persona.canMerge ? 'allowed' : 'denied'}`}>Merge</span>
              <span className={`persona-permission-badge ${persona.canCreateSessions ? 'allowed' : 'denied'}`}>Sessions</span>
              <span className="persona-card-meta-inline">{persona.model}</span>
              <button className="persona-view-file-btn" onClick={onViewFile} title="View full persona file">
                <FileText size={10} /> View File
              </button>
              <button className="persona-view-file-btn" onClick={onEditFile} title="Edit persona file directly">
                <Pencil size={10} /> Edit File
              </button>
            </div>
          </div>

          {/* Queued notes */}
          {whispers.length > 0 && (
            <div className="persona-whispers-list">
              <div className="persona-whispers-list-header">
                <StickyNote size={11} />
                <span>Queued Notes</span>
                <span className="persona-whispers-count">{whispers.length} pending</span>
              </div>
              {whispers.map((w, i) => (
                <div key={i} className="persona-whisper-item">
                  <span className="persona-whisper-item-time">
                    {new Date(w.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                  </span>
                  {editingNoteIndex === i ? (
                    <textarea
                      className="persona-whisper-edit-input"
                      value={editNoteText}
                      placeholder="Shift+Enter for newline"
                      onChange={e => setEditNoteText(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          onUpdateNote(i, editNoteText)
                          setEditingNoteIndex(null)
                        }
                        if (e.key === 'Escape') setEditingNoteIndex(null)
                      }}
                      autoFocus
                    />
                  ) : (
                    <span className="persona-whisper-item-text">{w.text}</span>
                  )}
                  {editingNoteIndex !== i && (
                    <button
                      className="persona-whisper-item-edit"
                      title="Edit note"
                      onClick={(e) => { e.stopPropagation(); setEditingNoteIndex(i); setEditNoteText(w.text) }}
                    >
                      <Pencil size={10} />
                    </button>
                  )}
                  <button
                    className="persona-whisper-item-delete"
                    title="Delete note"
                    onClick={(e) => { e.stopPropagation(); onDeleteNote(i) }}
                  >
                    <X size={10} />
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Session brief — latest run summary written by the persona itself */}
          {briefContent && briefContent !== 'loading' && (
            <PersonaSection
              title={briefMtime ? (() => { const secs = (Date.now() - briefMtime) / 1000; const ago = secs < 60 ? 'just now' : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`; return `Latest Brief · ${ago}` })() : 'Latest Brief'}
              content={briefContent}
              defaultOpen={true}
              isBrief
            />
          )}

          {/* Collapsible sections — dynamic ones open, static ones collapsed */}
          <PersonaSection title="Active Situations" content={sections['Active Situations']} defaultOpen={true} />
          <PersonaSection title="Session Log" content={null} defaultOpen={true}>
            {sections['Session Log'] && (
              <div className="persona-session-log">
                {sections['Session Log'].split('\n').filter(l => l.trim()).reverse().map((line, i) => {
                  const match = line.match(/^-\s*\[([^\]]+)\]\s*(.*)/)
                  if (!match) return <div key={i} className="persona-session-log-entry"><span className="persona-log-text">{line.replace(/^-\s*/, '')}</span></div>
                  const time = new Date(match[1])
                  const isValid = !isNaN(time.getTime())
                  const timeStr = isValid ? time.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : match[1]
                  // Extract session number if present
                  const sessionMatch = match[2].match(/^(Session \d+):?\s*(.*)/)
                  return (
                    <div key={i} className="persona-session-log-entry">
                      <span className="persona-log-time">{timeStr}</span>
                      {sessionMatch ? (
                        <span className="persona-log-text">
                          <span className="persona-log-session-num">{sessionMatch[1]}</span>
                          {sessionMatch[2]}
                        </span>
                      ) : (
                        <span className="persona-log-text">{match[2]}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </PersonaSection>
          <PersonaSection title="Learnings" content={sections['Learnings']} defaultOpen={false} />
          {persona.lastRunOutput && (
            <PersonaSection title="Last Run Output" content={persona.lastRunOutput} defaultOpen={false} isOutput />
          )}
          <PersonaSection title="Role" content={sections['Role']} defaultOpen={false} />
          <PersonaSection title="Objectives" content={sections['Objectives']} defaultOpen={false} />
          </>}
        </div>
      )}
    </div>
  )
}

const MODEL_OPTIONS = [
  { label: 'Opus 4.6', value: 'claude-opus-4-6' },
  { label: 'Sonnet 4.6', value: 'claude-sonnet-4-6' },
  { label: 'Haiku 4.5', value: 'claude-haiku-4-5-20251001' },
]

function EditPersonaModal({ persona, allPersonaIds, onClose, onSaved }: {
  persona: PersonaInfo
  allPersonaIds: string[]
  onClose: () => void
  onSaved: () => void
}) {
  const [schedule, setSchedule] = useState(persona.schedule ?? '')
  const [model, setModel] = useState(() => {
    if (persona.model.includes('opus')) return 'claude-opus-4-6'
    if (persona.model.includes('haiku')) return 'claude-haiku-4-5-20251001'
    return 'claude-sonnet-4-6'
  })
  const [enabled, setEnabled] = useState(persona.enabled)
  const [maxSessions, setMaxSessions] = useState(persona.maxSessions ?? 1)
  const [maxCostUsd, setMaxCostUsd] = useState(persona.maxCostUsd?.toString() ?? '')
  const [maxCostPerDayUsd, setMaxCostPerDayUsd] = useState(persona.maxCostPerDayUsd?.toString() ?? '')
  const [monthlyBudgetUsd, setMonthlyBudgetUsd] = useState(persona.monthlyBudgetUsd?.toString() ?? '')
  const [runOnStartup, setRunOnStartup] = useState(persona.runOnStartup ?? false)
  const [minIntervalMinutes, setMinIntervalMinutes] = useState(persona.minIntervalMinutes?.toString() ?? '')
  const [onCompleteRun, setOnCompleteRun] = useState<string[]>(persona.onCompleteRun ?? [])
  const [onCompleteRunIf, setOnCompleteRunIf] = useState(persona.onCompleteRunIf ?? '')
  const [canInvoke, setCanInvoke] = useState<string[]>(persona.canInvoke ?? [])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const updates: Record<string, string | boolean | number | string[]> = {
        model,
        enabled,
        max_sessions: maxSessions,
        on_complete_run: onCompleteRun,
        on_complete_run_if: onCompleteRunIf || '',
        can_invoke: canInvoke,
        run_on_startup: runOnStartup,
      }
      const parsedInterval = parseInt(minIntervalMinutes)
      if (parsedInterval > 0) {
        updates.min_interval_minutes = parsedInterval
      } else if (persona.minIntervalMinutes) {
        updates.min_interval_minutes = 0
      }
      if (schedule.trim()) {
        updates.schedule = schedule.trim()
      } else {
        updates.schedule = 'null'
      }
      const parsedCost = parseFloat(maxCostUsd)
      if (parsedCost > 0) {
        updates.max_cost_usd = parsedCost
      } else if (persona.maxCostUsd != null) {
        // Clear the field by setting to 0 (parseFrontmatter treats 0/NaN as undefined)
        updates.max_cost_usd = 0
      }
      const parsedDailyCost = parseFloat(maxCostPerDayUsd)
      if (parsedDailyCost > 0) {
        updates.max_cost_per_day_usd = parsedDailyCost
      } else if (persona.maxCostPerDayUsd != null) {
        updates.max_cost_per_day_usd = 0
      }
      const parsedMonthlyBudget = parseFloat(monthlyBudgetUsd)
      if (parsedMonthlyBudget > 0) {
        updates.monthly_budget_usd = parsedMonthlyBudget
      } else if (persona.monthlyBudgetUsd != null) {
        updates.monthly_budget_usd = 0
      }
      const ok = await window.api.persona.updateMeta(persona.id, updates)
      if (ok) {
        await onSaved()
        onClose()
      } else {
        setError('Save failed.')
      }
    } catch (err: any) {
      setError(err?.message ?? 'Unknown error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="persona-modal-overlay" onClick={onClose}>
      <div className="persona-modal persona-edit-meta-modal" onClick={(e) => e.stopPropagation()}>
        <div className="persona-modal-header">
          <h3><Pencil size={14} /> Edit {persona.name}</h3>
          <button className="persona-modal-close" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="persona-edit-meta-body">
          <label className="persona-edit-meta-field">
            <span>Schedule</span>
            <div className="persona-edit-meta-schedule-wrap">
              <input
                className="persona-edit-meta-input"
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="e.g. */30 * * * * — clear to disable"
                spellCheck={false}
              />
              {schedule.trim() && (
                <span className="persona-edit-meta-cron-hint">{describeCron(schedule.trim())}</span>
              )}
            </div>
          </label>
          <label className="persona-edit-meta-field" style={{ cursor: 'pointer' }}>
            <span>Run on Startup</span>
            <input
              type="checkbox"
              checked={runOnStartup}
              onChange={(e) => setRunOnStartup(e.target.checked)}
              style={{ width: 'auto', cursor: 'pointer' }}
            />
          </label>
          <label className="persona-edit-meta-field">
            <span>Min interval (min)</span>
            <input
              className="persona-edit-meta-input"
              type="number"
              min={0}
              step={1}
              value={minIntervalMinutes}
              onChange={(e) => setMinIntervalMinutes(e.target.value)}
              placeholder="No cooldown"
            />
          </label>
          <label className="persona-edit-meta-field">
            <span>Model</span>
            <select className="persona-edit-meta-select" value={model} onChange={(e) => setModel(e.target.value)}>
              {MODEL_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </label>
          <label className="persona-edit-meta-field">
            <span>Max Sessions</span>
            <input
              className="persona-edit-meta-input"
              type="number"
              min={1}
              max={10}
              value={maxSessions}
              onChange={(e) => setMaxSessions(Number(e.target.value))}
            />
          </label>
          <label className="persona-edit-meta-field">
            <span>Cost Cap (USD)</span>
            <input
              className="persona-edit-meta-input"
              type="number"
              min={0}
              step={0.5}
              value={maxCostUsd}
              onChange={(e) => setMaxCostUsd(e.target.value)}
              placeholder="No limit"
            />
          </label>
          <label className="persona-edit-meta-field">
            <span>Daily Cap (USD)</span>
            <input
              className="persona-edit-meta-input"
              type="number"
              min={0}
              step={1}
              value={maxCostPerDayUsd}
              onChange={(e) => setMaxCostPerDayUsd(e.target.value)}
              placeholder="No limit (trailing 24h)"
            />
          </label>
          <label className="persona-edit-meta-field">
            <span>Monthly Budget (USD)</span>
            <input
              className="persona-edit-meta-input"
              type="number"
              min={0}
              step={1}
              value={monthlyBudgetUsd}
              onChange={(e) => setMonthlyBudgetUsd(e.target.value)}
              placeholder="No limit (auto-pauses when exceeded)"
            />
          </label>
          <div className="persona-edit-meta-field">
            <span>On Complete Run</span>
            <div className="persona-chain-chips">
              {onCompleteRun.map(id => (
                <span key={id} className="persona-chain-chip">
                  {id}
                  <button type="button" onClick={() => setOnCompleteRun(prev => prev.filter(x => x !== id))}>
                    <X size={10} />
                  </button>
                </span>
              ))}
              <select
                className="persona-chain-add"
                value=""
                onChange={(e) => {
                  if (e.target.value && !onCompleteRun.includes(e.target.value)) {
                    setOnCompleteRun(prev => [...prev, e.target.value])
                  }
                  e.target.value = ''
                }}
              >
                <option value="">+ Add…</option>
                {allPersonaIds.filter(id => !onCompleteRun.includes(id)).map(id => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </div>
          </div>
          <label className="persona-edit-meta-field">
            <span>Fire Triggers When</span>
            <select
              className="persona-edit-meta-select"
              value={onCompleteRunIf}
              onChange={(e) => setOnCompleteRunIf(e.target.value)}
            >
              <option value="">Always (default)</option>
              <option value="success">Success only (exit 0)</option>
              <option value="has_commits">Has commits</option>
              <option value="has_changes">Has changes</option>
            </select>
          </label>
          <div className="persona-edit-meta-field">
            <span>Can Invoke</span>
            <div className="persona-chain-chips">
              {canInvoke.map(id => (
                <span key={id} className="persona-chain-chip">
                  {id}
                  <button type="button" onClick={() => setCanInvoke(prev => prev.filter(x => x !== id))}>
                    <X size={10} />
                  </button>
                </span>
              ))}
              <select
                className="persona-chain-add"
                value=""
                onChange={(e) => {
                  if (e.target.value && !canInvoke.includes(e.target.value)) {
                    setCanInvoke(prev => [...prev, e.target.value])
                  }
                  e.target.value = ''
                }}
              >
                <option value="">+ Add…</option>
                {allPersonaIds.filter(id => !canInvoke.includes(id)).map(id => (
                  <option key={id} value={id}>{id}</option>
                ))}
              </select>
            </div>
          </div>
          <label className="persona-edit-meta-field persona-edit-meta-toggle">
            <span>Enabled</span>
            <button
              className="persona-toggle"
              onClick={() => setEnabled(v => !v)}
              type="button"
            >
              <div className={`persona-toggle-track${enabled ? ' enabled' : ''}`}>
                <div className="persona-toggle-thumb" />
              </div>
              <span className="persona-toggle-label">{enabled ? 'On' : 'Off'}</span>
            </button>
          </label>
          {error && <div className="persona-edit-meta-error">{error}</div>}
        </div>
        <div className="persona-edit-footer">
          <button className="persona-edit-cancel" onClick={onClose} disabled={saving}>Cancel</button>
          <button className="persona-edit-save" onClick={handleSave} disabled={saving}>
            {saving ? <><Loader2 size={13} className="spin" /> Saving…</> : <><Save size={13} /> Save</>}
          </button>
        </div>
      </div>
    </div>
  )
}
