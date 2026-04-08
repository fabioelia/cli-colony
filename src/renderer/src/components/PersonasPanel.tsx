import { useState, useEffect, useCallback, useRef, useLayoutEffect } from 'react'
import { useFileDrop } from '../hooks/useFileDrop'
import {
  User, Plus, Play, Square, Trash2, Send, MessageSquare, FileText, X,
  ChevronDown, ChevronRight, Clock, Hash, Pencil, StickyNote, ArrowRightCircle, Save, Loader2,
  Hourglass, ArrowRight, FolderOpen, Search, Check,
} from 'lucide-react'
import { marked } from 'marked'
import HelpPopover from './HelpPopover'
import Tooltip from './Tooltip'
import CronEditor from './CronEditor'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'
import { describeCron } from '../../../shared/cron'

import type { PersonaInfo, ClaudeInstance, PersonaArtifact, PersonaRunEntry } from '../../../shared/types'

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

  return (
    <div className="personas-panel">
      <div className="panel-header">
        <h2><User size={16} /> Personas</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="personas" align="right" />
        <div className="panel-header-actions">
          <button className="panel-header-btn primary" onClick={() => setShowNewDialog(true)}>
            <Plus size={13} /> New Persona
          </button>
        </div>
      </div>

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
          <pre>{chatResponse}</pre>
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
        <div style={{ padding: '8px 12px', color: '#ef4444', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {personas.length === 0 && !showNewDialog && (
        <div className="persona-empty">
          <User size={28} />
          <p>No personas defined</p>
          <p style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
            Create a persona to define an autonomous agent with a role, objectives, and schedule.
          </p>
        </div>
      )}

      <div className="personas-list list-mode">
        {personas.map((persona) => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            expanded={expandedId === persona.id}
            instances={instances}
            allPersonas={personas}
            onToggleExpand={() => setExpandedId(expandedId === persona.id ? null : persona.id)}
            onRun={() => handleRun(persona.id)}
            onStop={() => handleStop(persona.id)}
            onToggle={(enabled) => handleToggle(persona.id, enabled)}
            onDelete={() => handleDelete(persona.id)}
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
          />
        ))}
      </div>

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
            <div
              className="persona-modal-content"
              dangerouslySetInnerHTML={{
                __html: marked(viewingPersona.content.replace(/^---\n[\s\S]*?\n---\n?/, '')) as string
              }}
            />
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
          <div
            className={`persona-card-section-content persona-md ${isOutput ? 'persona-run-output' : ''}`}
            dangerouslySetInnerHTML={{ __html: marked(content || '') as string }}
          />
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
          const fill = e.success ? 'var(--accent)' : 'var(--danger, #ef4444)'
          return (
            <rect key={i} x={x} y={MAX_H - h} width={BAR_W} height={h} rx={2} fill={fill} opacity={0.75} />
          )
        })}
      </svg>
      <span className="persona-history-sparkline-label">Last {bars.length} run{bars.length !== 1 ? 's' : ''}</span>
    </div>
  )
}

interface PersonaCardProps {
  persona: PersonaInfo
  expanded: boolean
  instances: ClaudeInstance[]
  allPersonas: PersonaInfo[]
  onToggleExpand: () => void
  onRun: () => void
  onStop: () => void
  onToggle: (enabled: boolean) => void
  onDelete: () => void
  onFocusInstance: (id: string) => void
  onViewFile: () => void
  onEditFile: () => void
  onEditMeta: () => void
  onScheduleSave: (schedule: string) => Promise<void>
  onWhisper: (text: string) => Promise<void>
  onDeleteNote: (index: number) => Promise<void>
}

function PersonaCard({
  persona, expanded, instances, allPersonas,
  onToggleExpand, onRun, onStop, onToggle, onDelete, onFocusInstance, onViewFile, onEditFile, onEditMeta, onScheduleSave, onWhisper, onDeleteNote
}: PersonaCardProps) {
  const [editingSchedule, setEditingSchedule] = useState(false)
  const [whisperOpen, setWhisperOpen] = useState(false)
  const [whisperText, setWhisperText] = useState('')
  const [activeTab, setActiveTab] = useState<'content' | 'outputs' | 'history'>('content')
  const [artifacts, setArtifacts] = useState<PersonaArtifact[] | null>(null)
  const [viewingArtifact, setViewingArtifact] = useState<{ name: string; content: string } | null>(null)
  const [runHistory, setRunHistory] = useState<PersonaRunEntry[] | null>(null)
  const whisperRef = useRef<HTMLTextAreaElement>(null)
  const { ref: whisperBarRef, isDragging: whisperDragging } = useFileDrop(paths => {
    const pathText = paths.join('\n')
    setWhisperText(prev => prev ? prev + '\n' + pathText : pathText)
    setWhisperOpen(true)
    setTimeout(() => whisperRef.current?.focus(), 0)
  })
  const [briefContent, setBriefContent] = useState<string | null | 'loading'>(null)
  const [briefMtime, setBriefMtime] = useState<number | null>(null)
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
    <div className={`persona-list-row ${isRunning ? 'running' : persona.enabled ? 'enabled' : 'disabled'}`}>
      {/* List mode — compact single-line row */}
      <div className="persona-list-row-main" onClick={onToggleExpand}>
          <span className="persona-list-expand">
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </span>
          <span className={`persona-card-status-dot ${statusClass}`} />
          <span className="persona-list-name">{persona.name}</span>
          {isRunning && <span className="persona-list-badge running">Running</span>}
          {!isRunning && persona.pendingTrigger && (
            <span className="persona-list-badge pending" title={`Queued by ${fromName(persona.pendingTrigger.from)}${persona.pendingTrigger.note ? `: ${persona.pendingTrigger.note}` : ''}`}>
              <Hourglass size={9} /> queued
            </span>
          )}
          <span className="persona-list-schedule">
            <Clock size={9} /> {persona.schedule ? describeCron(persona.schedule) : 'Manual'}
          </span>
          {persona.lastRun ? (
            <span className="persona-list-lastrun">
              {new Date(persona.lastRun).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </span>
          ) : (
            <span className="persona-list-lastrun muted">—</span>
          )}
          {persona.schedule && (
            <span className="persona-list-cron-chip" title={persona.schedule}>{describeCron(persona.schedule)}</span>
          )}
          <span className="persona-list-model">{persona.model || 'sonnet'}</span>
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
            <Tooltip text="Add a note for this persona's next run">
              <button className={`persona-action-btn${whispers.length > 0 ? ' whisper-active' : ''}`} onClick={() => setWhisperOpen(v => !v)}>
                <StickyNote size={11} />
                {whispers.length > 0 && <span className="persona-whisper-badge">{whispers.length}</span>}
              </button>
            </Tooltip>
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
        <div className="persona-modal-overlay" onClick={() => setViewingArtifact(null)}>
          <div className="persona-modal persona-edit-modal" onClick={(e) => e.stopPropagation()}>
            <div className="persona-modal-header">
              <h3><FolderOpen size={14} /> {viewingArtifact.name}</h3>
              <button className="persona-modal-close" onClick={() => setViewingArtifact(null)}><X size={16} /></button>
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
          </div>

          {activeTab === 'outputs' && (
            <div className="persona-outputs-tab">
              {artifacts === null ? (
                <div className="persona-outputs-loading"><Loader2 size={13} className="spin" /> Loading…</div>
              ) : artifacts.length === 0 ? (
                <div className="persona-outputs-empty">No outputs yet</div>
              ) : (
                artifacts.map((a) => {
                  const kb = (a.sizeBytes / 1024).toFixed(1)
                  const secs = (Date.now() - a.modifiedAt) / 1000
                  const ago = secs < 60 ? 'just now' : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : `${Math.floor(secs / 3600)}h ago`
                  return (
                    <button key={a.name} className="persona-artifact-row" onClick={() => handleViewArtifact(a)}>
                      <span className="persona-artifact-name">
                        {a.isBrief ? <><FileText size={10} /> Session Brief</> : a.name}
                      </span>
                      <span className="persona-artifact-meta">{kb} KB · {ago}</span>
                    </button>
                  )
                })
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
                        <div key={i} className="persona-history-row">
                          <span className={`persona-history-status ${entry.success ? 'success' : 'fail'}`} title={entry.success ? 'Completed successfully' : 'Run failed'}>
                            {entry.success ? <Check size={12} /> : <X size={12} />}
                          </span>
                          <span className="persona-history-time">{ago}</span>
                          <span className="persona-history-dur">{dur}</span>
                        </div>
                      )
                    })}
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
                  <span className="persona-whisper-item-text">{w.text}</span>
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

function EditPersonaModal({ persona, onClose, onSaved }: {
  persona: PersonaInfo
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
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      const updates: Record<string, string | boolean | number> = {
        model,
        enabled,
        max_sessions: maxSessions,
      }
      if (schedule.trim()) {
        updates.schedule = schedule.trim()
      } else {
        updates.schedule = 'null'
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
