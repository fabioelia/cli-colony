import { useState, useEffect, useCallback, useRef } from 'react'
import {
  User, Plus, Play, Square, Trash2, Send, MessageSquare, FileText, X,
  ChevronDown, ChevronRight, Clock, Hash,
  ToggleLeft, ToggleRight
} from 'lucide-react'
import { marked } from 'marked'
import HelpPopover from './HelpPopover'
import Tooltip from './Tooltip'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'

import type { PersonaInfo, ClaudeInstance } from '../../../shared/types'

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

  // Ask bar — persona assistant
  const [askInput, setAskInput] = useState('')
  const [assistantId, setAssistantId] = useState<string | null>(null)
  const [personasDir, setPersonasDir] = useState<string | null>(null)
  const sendingRef = useRef(false)

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

      {/* Ask bar — always visible */}
      <div className="panel-ask-bar">
        <MessageSquare size={14} className="panel-ask-icon" />
        <input
          className="panel-ask-input"
          placeholder="Describe a persona to create or modify..."
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

      <div className="personas-list">
        {personas.map((persona) => (
          <PersonaCard
            key={persona.id}
            persona={persona}
            expanded={expandedId === persona.id}
            instances={instances}
            onToggleExpand={() => setExpandedId(expandedId === persona.id ? null : persona.id)}
            onRun={() => handleRun(persona.id)}
            onStop={() => handleStop(persona.id)}
            onToggle={(enabled) => handleToggle(persona.id, enabled)}
            onDelete={() => handleDelete(persona.id)}
            onFocusInstance={onFocusInstance}
            onViewFile={() => setViewingPersona(persona)}
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
    </div>
  )
}

/** Collapsible section within the persona card */
function PersonaSection({ title, content, defaultOpen, isOutput, children }: {
  title: string
  content: string | null | undefined
  defaultOpen: boolean
  isOutput?: boolean
  children?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const hasContent = children || (content && !content.trim().startsWith('('))
  if (!hasContent) return null

  return (
    <div className="persona-card-section">
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

interface PersonaCardProps {
  persona: PersonaInfo
  expanded: boolean
  instances: ClaudeInstance[]
  onToggleExpand: () => void
  onRun: () => void
  onStop: () => void
  onToggle: (enabled: boolean) => void
  onDelete: () => void
  onFocusInstance: (id: string) => void
  onViewFile: () => void
}

function PersonaCard({
  persona, expanded, instances, onToggleExpand,
  onRun, onStop, onToggle, onDelete, onFocusInstance, onViewFile
}: PersonaCardProps) {
  const isRunning = persona.activeSessionId !== null
  const statusClass = isRunning ? 'running' : persona.enabled ? 'idle' : 'disabled'
  const allSections = parseSections(persona.content)
  const sections = expanded ? allSections : {}

  // Always parse session log for the preview (even when collapsed)
  const sessionLogLines = (allSections['Session Log'] || '')
    .split('\n')
    .filter(l => l.trim().startsWith('- ['))
    .slice(-3) // last 3 entries

  return (
    <div className="persona-card">
      <div className="persona-card-header" onClick={onToggleExpand}>
        <span className="persona-card-expand">
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </span>
        <span className={`persona-card-status-dot ${statusClass}`} />
        <div className="persona-card-info">
          <span className="persona-card-name">{persona.name}</span>
          <div className="persona-card-meta">
            {persona.schedule && (
              <span title={`Schedule: ${persona.schedule}`}>
                <Clock size={10} /> {persona.schedule}
              </span>
            )}
            <span title={`${persona.runCount} completed runs`}>
              <Hash size={10} /> {persona.runCount}
            </span>
          </div>
        </div>
        <div className="persona-card-actions">
          {!isRunning && (
            <Tooltip text="Run persona">
              <button
                className="persona-action-btn"
                onClick={(e) => { e.stopPropagation(); onRun() }}
              >
                <Play size={12} />
              </button>
            </Tooltip>
          )}
          {isRunning && (
            <Tooltip text="Stop persona">
              <button
                className="persona-action-btn running"
                onClick={(e) => { e.stopPropagation(); onStop() }}
              >
                <Square size={12} />
              </button>
            </Tooltip>
          )}
          <Tooltip text={persona.enabled ? 'Disable scheduled runs' : 'Enable scheduled runs'}>
            <button
              className="persona-action-btn"
              onClick={(e) => { e.stopPropagation(); onToggle(!persona.enabled) }}
            >
              {persona.enabled ? <ToggleRight size={12} /> : <ToggleLeft size={12} />}
            </button>
          </Tooltip>
          <Tooltip text="Delete persona">
            <button
              className="persona-action-btn danger"
              onClick={(e) => { e.stopPropagation(); onDelete() }}
            >
              <Trash2 size={12} />
            </button>
          </Tooltip>
        </div>
      </div>

      {/* Recent activity preview — always visible */}
      {!expanded && sessionLogLines.length > 0 && (
        <div className="persona-card-preview" onClick={onToggleExpand}>
          {sessionLogLines.map((line, i) => {
            // Parse "- [2026-04-02T21:15:00Z] summary text"
            const match = line.match(/^- \[([^\]]+)\]\s*(.*)/)
            if (!match) return null
            const time = new Date(match[1])
            const summary = match[2]
            const timeStr = time.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
            return (
              <div key={i} className="persona-preview-entry">
                <span className="persona-preview-time">{timeStr}</span>
                <span className="persona-preview-text">{summary}</span>
              </div>
            )
          })}
        </div>
      )}

      {expanded && (
        <div className="persona-card-body">
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
            <div className="persona-card-footer-inline">
              <span className={`persona-permission-badge ${persona.canPush ? 'allowed' : 'denied'}`}>Push</span>
              <span className={`persona-permission-badge ${persona.canMerge ? 'allowed' : 'denied'}`}>Merge</span>
              <span className={`persona-permission-badge ${persona.canCreateSessions ? 'allowed' : 'denied'}`}>Sessions</span>
              <span className="persona-card-meta-inline">{persona.model}</span>
              <button className="persona-view-file-btn" onClick={onViewFile} title="View full persona file">
                <FileText size={10} /> View File
              </button>
            </div>
          </div>

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
        </div>
      )}
    </div>
  )
}
