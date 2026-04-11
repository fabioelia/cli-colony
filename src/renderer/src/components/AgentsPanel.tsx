import { useState, useEffect } from 'react'
import { Plus, RefreshCw, Download, Upload, Pencil, Play, ChevronRight, FolderOpen, FileCode, Trash2 } from 'lucide-react'
import EmptyStateHook from './EmptyStateHook'
import type { AgentDef } from '../types'
import { COLOR_MAP } from '../lib/constants'
import Tooltip from './Tooltip'
import HelpPopover from './HelpPopover'

interface Props {
  onLaunchAgent: (agent: AgentDef) => void
  onEditAgent: (agent: AgentDef) => void
}

const MODEL_COLORS: Record<string, string> = {
  opus: 'var(--accent-purple)',
  sonnet: 'var(--accent)',
  haiku: 'var(--success)',
}

export default function AgentsPanel({ onLaunchAgent, onEditAgent }: Props) {
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [newAgentName, setNewAgentName] = useState('')
  const [addingTo, setAddingTo] = useState<{ scope: 'personal' | 'project'; projectPath?: string } | null>(null)

  useEffect(() => {
    window.api.agents.list().then(setAgents)
  }, [])

  const handleCreateAgent = async () => {
    if (!addingTo || !newAgentName.trim()) return
    const agent = await window.api.agents.create(
      newAgentName.trim(),
      addingTo.scope,
      addingTo.projectPath,
    )
    if (agent) {
      const updated = await window.api.agents.list()
      setAgents(updated)
      setNewAgentName('')
      setAddingTo(null)
      onEditAgent(agent)
    }
  }

  const handleExport = async (agentsToExport: AgentDef[]) => {
    if (agentsToExport.length === 0) return
    await window.api.agents.export(agentsToExport.map((a) => a.filePath))
  }

  const handleImport = async (scope: 'personal' | 'project', projectPath?: string) => {
    const targetDir = scope === 'personal' ? '' : (projectPath ? `${projectPath}/.claude/agents` : null)
    if (targetDir === null) return
    const count = await window.api.agents.import(targetDir)
    if (count > 0) refresh()
  }

  const refresh = () => window.api.agents.list().then(setAgents)

  const personal = agents.filter((a) => a.scope === 'personal')
  const byProject = agents
    .filter((a) => a.scope === 'project')
    .reduce<Record<string, { agents: AgentDef[]; path: string }>>((acc, a) => {
      const key = a.projectName || 'unknown'
      if (!acc[key]) acc[key] = { agents: [], path: a.filePath.replace(/\/\.claude\/agents\/.*$/, '') }
      acc[key].agents.push(a)
      return acc
    }, {})

  const renderAgent = (agent: AgentDef) => {
    const isExpanded = expandedId === agent.id
    const accentColor = agent.color ? colorMap(agent.color) : 'var(--text-muted)'
    return (
      <div key={agent.id} className={`agent-card ${isExpanded ? 'expanded' : ''}`}>
        <div
          className="agent-card-header"
          role="button"
          tabIndex={0}
          onClick={() => setExpandedId(isExpanded ? null : agent.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(isExpanded ? null : agent.id) } }}
        >
          <div className="agent-card-accent" style={{ backgroundColor: accentColor }} />
          <div className="agent-card-info">
            <div className="agent-card-top">
              <span className="agent-card-name">{agent.name}</span>
              {agent.model && (
                <span
                  className="agent-card-model"
                  style={{ color: MODEL_COLORS[agent.model] || 'var(--text-secondary)', borderColor: MODEL_COLORS[agent.model] || 'var(--text-secondary)' }}
                >
                  {agent.model}
                </span>
              )}
            </div>
            <div className="agent-card-desc">{agent.description}</div>
          </div>
          <ChevronRight size={14} className={`agent-card-chevron ${isExpanded ? 'expanded' : ''}`} />
        </div>
        {isExpanded && (
          <div className="agent-card-body">
            <div className="agent-card-path">
              <FolderOpen size={11} />
              {agent.filePath}
            </div>
            {agent.tools.length > 0 && (
              <div className="agent-card-tools">
                {agent.tools.map((t) => (
                  <span key={t} className="agent-card-tool">{t}</span>
                ))}
              </div>
            )}
            <div className="agent-card-actions">
              <button className="agent-btn-edit" onClick={() => onEditAgent(agent)} title="Edit agent definition in split view">
                <Pencil size={13} /> Edit
              </button>
              <button className="agent-btn-launch" onClick={() => onLaunchAgent(agent)} title="Launch a new session with this agent">
                <Play size={13} /> Launch
              </button>
              <button className="agent-btn-delete" onClick={async () => {
                if (!window.confirm(`Delete agent "${agent.name}"?`)) return
                const ok = await window.api.agents.delete(agent.filePath)
                if (ok) {
                  setAgents(prev => prev.filter(a => a.filePath !== agent.filePath))
                  if (expandedId === agent.filePath) setExpandedId(null)
                }
              }} title="Delete agent definition">
                <Trash2 size={13} /> Delete
              </button>
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderAddForm = (scope: 'personal' | 'project', projectPath?: string) => {
    const isActive = addingTo?.scope === scope && addingTo?.projectPath === projectPath
    if (!isActive) {
      return (
        <button
          className="agent-add-btn"
          onClick={() => setAddingTo({ scope, projectPath })}
          title="Create a new agent definition"
        >
          <Plus size={13} /> New Agent
        </button>
      )
    }
    return (
      <div className="agent-add-form">
        <input
          autoFocus
          placeholder="Agent name..."
          value={newAgentName}
          onChange={(e) => setNewAgentName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleCreateAgent()
            if (e.key === 'Escape') { setAddingTo(null); setNewAgentName('') }
          }}
        />
        <button className="agent-add-confirm" onClick={handleCreateAgent} title="Create agent">Create</button>
        <button onClick={() => { setAddingTo(null); setNewAgentName('') }} title="Cancel">Cancel</button>
      </div>
    )
  }

  const renderSectionHeader = (
    title: string,
    agentsList: AgentDef[],
    scope: 'personal' | 'project',
    projectPath?: string,
  ) => (
    <div className="agents-section-header">
      <span className="agents-section-label">{title}</span>
      <span className="agents-section-count">{agentsList.length}</span>
      <div className="agents-section-actions">
        {agentsList.length > 0 && (
          <Tooltip text="Export" detail={`Download ${title.toLowerCase()} as a zip file`}>
            <button onClick={() => handleExport(agentsList)}><Download size={12} /></button>
          </Tooltip>
        )}
        <Tooltip text="Import" detail="Import agent definitions from a zip file">
          <button onClick={() => handleImport(scope, projectPath)}><Upload size={12} /></button>
        </Tooltip>
      </div>
    </div>
  )

  return (
    <div className="agents-panel">
      <div className="panel-header">
        <h2><FileCode size={16} /> Agents</h2>
        <div className="panel-header-spacer" />
        <HelpPopover topic="agents" align="right" />
        <div className="panel-header-actions">
          <Tooltip text="Refresh" detail="Rescan agent directories for changes">
            <button className="panel-header-btn" onClick={refresh}>
              <RefreshCw size={13} />
            </button>
          </Tooltip>
        </div>
      </div>

      {agents.length === 0 && (
        <EmptyStateHook
          icon={FileCode}
          title="Agents"
          hook="No agents yet. They encapsulate a specific task with its own instructions."
          keyCap="A"
          cta={{ label: 'Create Agent', onClick: () => setAddingTo({ scope: 'personal' }) }}
        />
      )}

      <div className="agents-section">
        {renderSectionHeader('Personal', personal, 'personal')}
        {personal.map(renderAgent)}
        {renderAddForm('personal')}
      </div>

      {Object.entries(byProject).map(([projName, { agents: projAgents, path }]) => (
        <div key={projName} className="agents-section">
          {renderSectionHeader(projName, projAgents, 'project', path)}
          {projAgents.map(renderAgent)}
          {renderAddForm('project', path)}
        </div>
      ))}
    </div>
  )
}

function colorMap(name: string): string {
  return COLOR_MAP[name] || name
}
