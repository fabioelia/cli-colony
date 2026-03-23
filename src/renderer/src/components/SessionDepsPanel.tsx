import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Search, Plus, Trash2, Play, ArrowRight, Link, ChevronDown, ChevronRight,
  CheckCircle, Loader, XCircle, Clock, ArrowDown,
} from 'lucide-react'
import type { ClaudeInstance, AgentChain, AgentChainStep, SessionDependency, CliBackend } from '../types'

// ---- Cross-session search ----

interface SearchResult {
  instanceId: string
  instanceName: string
  instanceColor: string
  matches: Array<{ lineIndex: number; text: string }>
}

function searchInBuffer(buffer: string, query: string): Array<{ lineIndex: number; text: string }> {
  if (!query || query.length < 2) return []
  const q = query.toLowerCase()
  // Strip ANSI for search
  const clean = buffer.replace(/\x1B\[[0-9;]*[a-zA-Z]|\x1B\][\s\S]*?(\x07|\x1B\\)|\x1B[()][AB012]|\x1B\[?\??[0-9;]*[hlm]/g, '')
  const lines = clean.split('\n')
  const matches: Array<{ lineIndex: number; text: string }> = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(q)) {
      matches.push({ lineIndex: i, text: lines[i].trim().slice(0, 200) })
      if (matches.length >= 20) break // cap per-instance
    }
  }
  return matches
}

// ---- Agent chain templates ----

const DEFAULT_CHAINS: AgentChain[] = [
  {
    id: 'design-implement-test-pr',
    name: 'Design > Implement > Test > PR',
    steps: [
      { name: 'Design', prompt: 'Analyze the codebase and design a solution for: {{task}}. Write a design doc with the approach, affected files, and edge cases.', dependsOnPrevious: false },
      { name: 'Implement', prompt: 'Implement the design from the previous step. Follow the plan exactly.', dependsOnPrevious: true },
      { name: 'Test', prompt: 'Write comprehensive tests for the changes made in the previous step. Run the test suite and ensure everything passes.', dependsOnPrevious: true },
      { name: 'PR', prompt: 'Create a pull request for all the changes. Write a clear title, description, and test plan.', dependsOnPrevious: true },
    ],
  },
  {
    id: 'review-fix',
    name: 'Review > Fix',
    steps: [
      { name: 'Review', prompt: 'Review the codebase for: {{task}}. List all issues found with file paths and line numbers.', dependsOnPrevious: false },
      { name: 'Fix', prompt: 'Fix all the issues identified in the previous review step.', dependsOnPrevious: true },
    ],
  },
]

// ---- Component ----

interface Props {
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
  onCreateInstance: (opts: {
    name?: string
    workingDirectory?: string
    args?: string[]
    cliBackend?: CliBackend
  }) => Promise<ClaudeInstance>
}

interface ChainRun {
  chain: AgentChain
  directory: string
  stepStatuses: Array<{
    instanceId: string | null
    state: 'pending' | 'running' | 'done' | 'failed'
  }>
}

export default function SessionDepsPanel({ instances, onFocusInstance, onCreateInstance }: Props) {
  const [tab, setTab] = useState<'search' | 'chains' | 'deps'>('search')

  // Cross-session search
  const [searchQuery, setSearchQuery] = useState('')
  const [searchResults, setSearchResults] = useState<SearchResult[]>([])
  const [searching, setSearching] = useState(false)

  // Agent chains
  const [chains] = useState<AgentChain[]>(DEFAULT_CHAINS)
  const [chainRuns, setChainRuns] = useState<ChainRun[]>([])
  const [chainTask, setChainTask] = useState('')
  const [chainDir, setChainDir] = useState('')
  const [selectedChainId, setSelectedChainId] = useState<string | null>(null)
  const [expandedRunIndex, setExpandedRunIndex] = useState<number | null>(null)

  // Dependencies
  const [deps, setDeps] = useState<Map<string, SessionDependency>>(new Map())

  const handleSearch = useCallback(async () => {
    if (!searchQuery || searchQuery.length < 2) return
    setSearching(true)
    const results: SearchResult[] = []
    for (const inst of instances) {
      try {
        const buffer = await window.api.instance.buffer(inst.id)
        const matches = searchInBuffer(buffer, searchQuery)
        if (matches.length > 0) {
          results.push({
            instanceId: inst.id,
            instanceName: inst.name,
            instanceColor: inst.color,
            matches,
          })
        }
      } catch { /* skip */ }
    }
    setSearchResults(results)
    setSearching(false)
  }, [searchQuery, instances])

  const handleRunChain = useCallback(async (chain: AgentChain) => {
    if (!chainDir) return
    const task = chainTask.trim()
    const run: ChainRun = {
      chain,
      directory: chainDir,
      stepStatuses: chain.steps.map(() => ({ instanceId: null, state: 'pending' })),
    }
    const runIndex = chainRuns.length
    setChainRuns((prev) => [...prev, run])
    setExpandedRunIndex(runIndex)

    const updateStatus = (stepIdx: number, update: Partial<ChainRun['stepStatuses'][number]>) => {
      setChainRuns((prev) => {
        const next = [...prev]
        const r = { ...next[runIndex] }
        r.stepStatuses = [...r.stepStatuses]
        r.stepStatuses[stepIdx] = { ...r.stepStatuses[stepIdx], ...update }
        next[runIndex] = r
        return next
      })
    }

    for (let i = 0; i < chain.steps.length; i++) {
      const step = chain.steps[i]
      updateStatus(i, { state: 'running' })

      const prompt = step.prompt.replace(/\{\{task\}\}/g, task)
      try {
        const inst = await onCreateInstance({
          name: `[${chain.name}] ${step.name}`,
          workingDirectory: chainDir,
        })
        updateStatus(i, { instanceId: inst.id })

        // Wait for ready, send prompt
        await new Promise<void>((resolve) => {
          let sent = false
          let waitCount = 0
          const unsub = window.api.instance.onActivity(({ id, activity }) => {
            if (id !== inst.id || sent) return
            if (activity === 'waiting') {
              waitCount++
              if (waitCount === 1) {
                window.api.instance.write(inst.id, '\r')
              } else {
                sent = true
                unsub()
                window.api.instance.write(inst.id, prompt + '\r')
                resolve()
              }
            }
          })
          setTimeout(() => {
            if (!sent && waitCount >= 1) { sent = true; unsub(); window.api.instance.write(inst.id, prompt + '\r'); resolve() }
          }, 5000)
          setTimeout(() => { if (!sent) { unsub(); resolve() } }, 15000)
        })

        // Wait for exit
        await new Promise<void>((resolve) => {
          const unsub = window.api.instance.onExited(({ id, exitCode }) => {
            if (id !== inst.id) return
            unsub()
            updateStatus(i, { state: exitCode === 0 ? 'done' : 'failed' })
            resolve()
          })
        })

        // Check if this step failed
        const latestRuns = chainRuns[runIndex] || run
        // Re-read from state via setChainRuns callback
      } catch {
        updateStatus(i, { state: 'failed' })
        break
      }
    }
  }, [chainTask, chainDir, chainRuns, onCreateInstance])

  const handleAddDep = useCallback((instanceId: string, dependsOn: string) => {
    setDeps((prev) => {
      const next = new Map(prev)
      next.set(instanceId, { dependsOn, action: 'auto-start' })
      return next
    })
  }, [])

  const handleRemoveDep = useCallback((instanceId: string) => {
    setDeps((prev) => {
      const next = new Map(prev)
      next.delete(instanceId)
      return next
    })
  }, [])

  // Watch for dependency completion and auto-start
  useEffect(() => {
    if (deps.size === 0) return
    for (const [instanceId, dep] of deps) {
      const depInst = instances.find((i) => i.id === dep.dependsOn)
      if (depInst && depInst.status === 'exited') {
        // Dependency completed -- find our instance
        const ourInst = instances.find((i) => i.id === instanceId)
        if (ourInst && ourInst.status === 'running' && ourInst.activity === 'waiting') {
          // Auto-notify: write a message telling it the dependency is done
          window.api.instance.write(instanceId, `[Dependency "${depInst.name}" has completed with exit code ${depInst.exitCode}. You may proceed.]\r`)
          handleRemoveDep(instanceId)
        }
      }
    }
  }, [instances, deps, handleRemoveDep])

  const totalMatches = searchResults.reduce((sum, r) => sum + r.matches.length, 0)

  return (
    <div className="session-deps-panel">
      <div className="session-deps-header">
        <div className="session-deps-tabs">
          <button className={`session-deps-tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>
            <Search size={12} /> Search
          </button>
          <button className={`session-deps-tab ${tab === 'chains' ? 'active' : ''}`} onClick={() => setTab('chains')}>
            <ArrowDown size={12} /> Chains
          </button>
          <button className={`session-deps-tab ${tab === 'deps' ? 'active' : ''}`} onClick={() => setTab('deps')}>
            <Link size={12} /> Dependencies
          </button>
        </div>
      </div>

      {/* Cross-session search */}
      {tab === 'search' && (
        <div className="session-search">
          <div className="session-search-bar">
            <Search size={13} />
            <input
              placeholder="Search across all session output..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSearch() }}
            />
            <button onClick={handleSearch} disabled={searching || searchQuery.length < 2}>
              {searching ? <Loader size={12} className="spinning" /> : 'Search'}
            </button>
          </div>
          {searchResults.length > 0 && (
            <div className="session-search-summary">
              {totalMatches} match{totalMatches !== 1 ? 'es' : ''} in {searchResults.length} session{searchResults.length !== 1 ? 's' : ''}
            </div>
          )}
          <div className="session-search-results">
            {searchResults.map((r) => (
              <div key={r.instanceId} className="session-search-group">
                <div
                  className="session-search-group-header"
                  onClick={() => onFocusInstance(r.instanceId)}
                >
                  <span className="session-search-dot" style={{ backgroundColor: r.instanceColor }} />
                  <span className="session-search-name">{r.instanceName}</span>
                  <span className="session-search-count">{r.matches.length}</span>
                </div>
                {r.matches.slice(0, 5).map((m, i) => (
                  <div
                    key={i}
                    className="session-search-match"
                    onClick={() => onFocusInstance(r.instanceId)}
                  >
                    <span className="session-search-line">L{m.lineIndex}</span>
                    <span className="session-search-text">{m.text}</span>
                  </div>
                ))}
                {r.matches.length > 5 && (
                  <div className="session-search-more">+{r.matches.length - 5} more</div>
                )}
              </div>
            ))}
            {!searching && searchResults.length === 0 && searchQuery.length >= 2 && (
              <div className="session-search-empty">No results found</div>
            )}
          </div>
        </div>
      )}

      {/* Agent chains */}
      {tab === 'chains' && (
        <div className="session-chains">
          <div className="session-chains-setup">
            <div className="session-chains-field">
              <label>Task description</label>
              <input
                placeholder="What should the chain accomplish?"
                value={chainTask}
                onChange={(e) => setChainTask(e.target.value)}
              />
            </div>
            <div className="session-chains-field">
              <label>Working directory</label>
              <div className="session-chains-dir">
                <input
                  placeholder="/path/to/project"
                  value={chainDir}
                  onChange={(e) => setChainDir(e.target.value)}
                />
                <button onClick={async () => {
                  const dir = await window.api.dialog.openDirectory()
                  if (dir) setChainDir(dir)
                }}>Browse</button>
              </div>
            </div>
          </div>

          <div className="session-chains-list">
            {chains.map((chain) => (
              <div key={chain.id} className="session-chain-card">
                <div
                  className="session-chain-header"
                  onClick={() => setSelectedChainId(selectedChainId === chain.id ? null : chain.id)}
                >
                  {selectedChainId === chain.id ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                  <span className="session-chain-name">{chain.name}</span>
                  <span className="session-chain-step-count">{chain.steps.length} steps</span>
                  <button
                    className="session-chain-run"
                    onClick={(e) => { e.stopPropagation(); handleRunChain(chain) }}
                    disabled={!chainDir || !chainTask}
                    title="Run this chain"
                  >
                    <Play size={11} /> Run
                  </button>
                </div>
                {selectedChainId === chain.id && (
                  <div className="session-chain-steps">
                    {chain.steps.map((step, i) => (
                      <div key={i} className="session-chain-step">
                        <span className="session-chain-step-num">{i + 1}</span>
                        <span className="session-chain-step-name">{step.name}</span>
                        {step.dependsOnPrevious && i > 0 && (
                          <span className="session-chain-step-dep">waits for {chain.steps[i - 1].name}</span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Running chains */}
          {chainRuns.length > 0 && (
            <div className="session-chain-runs">
              <div className="session-chain-runs-title">Running Chains</div>
              {chainRuns.map((run, runIdx) => (
                <div key={runIdx} className="session-chain-run-item">
                  <div
                    className="session-chain-run-header"
                    onClick={() => setExpandedRunIndex(expandedRunIndex === runIdx ? null : runIdx)}
                  >
                    {expandedRunIndex === runIdx ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                    <span>{run.chain.name}</span>
                    <span className="session-chain-run-progress">
                      {run.stepStatuses.filter((s) => s.state === 'done').length}/{run.chain.steps.length}
                    </span>
                  </div>
                  {expandedRunIndex === runIdx && (
                    <div className="session-chain-run-steps">
                      {run.stepStatuses.map((s, i) => (
                        <div key={i} className={`session-chain-run-step ${s.state}`}>
                          <span className="session-chain-run-step-icon">
                            {s.state === 'pending' && <Clock size={11} />}
                            {s.state === 'running' && <Loader size={11} className="spinning" />}
                            {s.state === 'done' && <CheckCircle size={11} />}
                            {s.state === 'failed' && <XCircle size={11} />}
                          </span>
                          <span>{run.chain.steps[i].name}</span>
                          {s.instanceId && (
                            <button
                              className="session-chain-run-step-focus"
                              onClick={() => onFocusInstance(s.instanceId!)}
                            >
                              View
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Session dependencies */}
      {tab === 'deps' && (
        <div className="session-deps-list">
          <div className="session-deps-info">
            Link sessions so one waits for another to finish before proceeding.
          </div>
          {instances.filter((i) => i.status === 'running').length < 2 && (
            <div className="session-deps-empty">
              Need at least 2 running sessions to create dependencies.
            </div>
          )}
          {instances.filter((i) => i.status === 'running').length >= 2 && (
            <DependencyAdder
              instances={instances.filter((i) => i.status === 'running')}
              deps={deps}
              onAdd={handleAddDep}
              onRemove={handleRemoveDep}
            />
          )}
          {deps.size > 0 && (
            <div className="session-deps-active">
              <div className="session-deps-active-title">Active Dependencies</div>
              {Array.from(deps.entries()).map(([instanceId, dep]) => {
                const inst = instances.find((i) => i.id === instanceId)
                const depInst = instances.find((i) => i.id === dep.dependsOn)
                if (!inst || !depInst) return null
                return (
                  <div key={instanceId} className="session-dep-item">
                    <span className="session-dep-dot" style={{ backgroundColor: inst.color }} />
                    <span>{inst.name}</span>
                    <ArrowRight size={11} />
                    <span className="session-dep-waits">waits for</span>
                    <span className="session-dep-dot" style={{ backgroundColor: depInst.color }} />
                    <span>{depInst.name}</span>
                    <button
                      className="session-dep-remove"
                      onClick={() => handleRemoveDep(instanceId)}
                      title="Remove dependency"
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Sub-component for adding dependencies
function DependencyAdder({ instances, deps, onAdd, onRemove }: {
  instances: ClaudeInstance[]
  deps: Map<string, SessionDependency>
  onAdd: (id: string, dependsOn: string) => void
  onRemove: (id: string) => void
}) {
  const [fromId, setFromId] = useState('')
  const [toId, setToId] = useState('')

  return (
    <div className="session-dep-adder">
      <select value={fromId} onChange={(e) => setFromId(e.target.value)}>
        <option value="">Session that waits...</option>
        {instances.map((i) => (
          <option key={i.id} value={i.id}>{i.name}</option>
        ))}
      </select>
      <span className="session-dep-arrow">waits for</span>
      <select value={toId} onChange={(e) => setToId(e.target.value)}>
        <option value="">Session to complete...</option>
        {instances.filter((i) => i.id !== fromId).map((i) => (
          <option key={i.id} value={i.id}>{i.name}</option>
        ))}
      </select>
      <button
        className="session-dep-add-btn"
        disabled={!fromId || !toId}
        onClick={() => { onAdd(fromId, toId); setFromId(''); setToId('') }}
      >
        <Plus size={11} /> Link
      </button>
    </div>
  )
}
