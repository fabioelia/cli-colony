import { useState, useEffect } from 'react'
import { Plus, RefreshCw } from 'lucide-react'
import type { AgentDef } from '../types'
import { COLOR_MAP } from '../lib/constants'

interface Props {
  onLaunchAgent: (agent: AgentDef) => void
  onEditAgent: (agent: AgentDef) => void
}

const MODEL_COLORS: Record<string, string> = {
  opus: '#8b5cf6',
  sonnet: '#3b82f6',
  haiku: '#10b981',
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
      // Refresh list then open in editor
      const updated = await window.api.agents.list()
      setAgents(updated)
      setNewAgentName('')
      setAddingTo(null)
      onEditAgent(agent)
    }
  }

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
    return (
      <div key={agent.id} className="agent-item">
        <div
          className="agent-item-header"
          role="button"
          tabIndex={0}
          onClick={() => setExpandedId(isExpanded ? null : agent.id)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpandedId(isExpanded ? null : agent.id) } }}
        >
          <div
            className="agent-color-bar"
            style={{ backgroundColor: agent.color ? colorMap(agent.color) : '#6b6b80' }}
          />
          <div className="agent-item-info">
            <div className="agent-item-name">{agent.name}</div>
            <div className="agent-item-desc">{agent.description.slice(0, 80)}{agent.description.length > 80 ? '...' : ''}</div>
          </div>
          {agent.model && (
            <span className="agent-model-badge" style={{ color: MODEL_COLORS[agent.model] || '#a0a0b0' }}>
              {agent.model}
            </span>
          )}
        </div>
        {isExpanded && (
          <div className="agent-item-details">
            <p className="agent-full-desc">{agent.description}</p>
            {agent.tools.length > 0 && (
              <div className="agent-tools">
                {agent.tools.map((t) => (
                  <span key={t} className="agent-tool-tag">{t}</span>
                ))}
              </div>
            )}
            <div className="agent-item-actions-row">
              <button className="agent-edit-btn" onClick={() => onEditAgent(agent)}>
                Edit
              </button>
              <button className="agent-launch-btn" onClick={() => onLaunchAgent(agent)}>
                Launch Instance
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
        >
          <Plus size={13} /> Add Agent
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
        <button onClick={handleCreateAgent}>Create</button>
        <button onClick={() => { setAddingTo(null); setNewAgentName('') }}>Cancel</button>
      </div>
    )
  }

  const refresh = () => window.api.agents.list().then(setAgents)

  return (
    <div className="agents-panel">
      <div className="agents-panel-header">
        <button className="agents-refresh-btn" onClick={refresh} title="Refresh agents">
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="agents-section">
        <div className="agents-section-title">Personal Agents</div>
        {personal.length === 0 && (
          <div className="agents-empty">No personal agents found in ~/.claude/agents/</div>
        )}
        {personal.map(renderAgent)}
        {renderAddForm('personal')}
      </div>

      {Object.entries(byProject).map(([projName, { agents: projAgents, path }]) => (
        <div key={projName} className="agents-section">
          <div className="agents-section-title">{projName}</div>
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
