import { useState, useEffect, useCallback, useRef } from 'react'
import type { ClaudeInstance, AgentDef, CliSession, RecentSession } from './types'
import Sidebar, { SidebarView } from './components/Sidebar'
import TerminalView from './components/TerminalView'
import NewInstanceDialog from './components/NewInstanceDialog'
import AgentsPanel from './components/AgentsPanel'
import AgentEditor from './components/AgentEditor'
import SettingsPanel from './components/SettingsPanel'

type View = SidebarView | 'agent-editor'

export default function App() {
  const [instances, setInstances] = useState<ClaudeInstance[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [showNewDialog, setShowNewDialog] = useState(false)
  const [view, setView] = useState<View>('instances')
  const [editingAgent, setEditingAgent] = useState<AgentDef | null>(null)
  const [editorInstanceId, setEditorInstanceId] = useState<string | null>(null)
  const [restorableSessions, setRestorableSessions] = useState<RecentSession[]>([])
  const [searchOpen, setSearchOpen] = useState(false)
  const [splitId, setSplitId] = useState<string | null>(null)
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set())
  const [fontSize, setFontSize] = useState(13)
  const [theme, setTheme] = useState<string>('midnight')
  const terminalsRef = useRef<Map<string, any>>(new Map())
  const agentToLaunchRef = useRef<AgentDef | null>(null)
  // Track activeId + view in a ref so the output listener always has fresh values
  const activeViewRef = useRef<{ activeId: string | null; view: View }>({ activeId: null, view: 'instances' })
  activeViewRef.current = { activeId, view }
  const instancesRef = useRef(instances)
  instancesRef.current = instances

  useEffect(() => {
    window.api.instance.list().then(setInstances)
    window.api.sessions.restorable().then(setRestorableSessions)
    window.api.settings.getAll().then((s) => {
      if (s.theme) {
        setTheme(s.theme)
      }
      if (s.fontSize) {
        setFontSize(parseInt(s.fontSize, 10) || 13)
      }
    })
  }, [])

  // Apply theme to document
  useEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useEffect(() => {
    const unsub = window.api.instance.onListUpdate(setInstances)
    return unsub
  }, [])

  // Track unread: output on non-visible terminals marks them unread
  useEffect(() => {
    const unsub = window.api.instance.onOutput(({ id }) => {
      const { activeId: currentActive, view: currentView } = activeViewRef.current
      const isVisible = currentView === 'instances' && id === currentActive
      if (!isVisible) {
        setUnreadIds((prev) => {
          if (prev.has(id)) return prev
          const next = new Set(prev)
          next.add(id)
          return next
        })
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.api.instance.onFocus(({ id }) => {
      setActiveId(id)
      setView('instances')
    })
    return unsub
  }, [])

  // Keyboard shortcuts from main process menu — subscribe once, use refs for fresh values
  useEffect(() => {
    const unsubs = [
      window.api.shortcuts.onNewInstance(() => setShowNewDialog(true)),
      window.api.shortcuts.onCloseInstance(() => {
        const { activeId: aid } = activeViewRef.current
        if (aid) {
          const inst = instancesRef.current.find((i) => i.id === aid)
          if (inst?.status === 'running') window.api.instance.kill(aid)
          else window.api.instance.remove(aid)
        }
      }),
      window.api.shortcuts.onClearTerminal(() => {
        const { activeId: aid } = activeViewRef.current
        if (aid) {
          const entry = terminalsRef.current.get(aid)
          entry?.term?.clear()
        }
      }),
      window.api.shortcuts.onSearch(() => {
        const { activeId: aid, view: v } = activeViewRef.current
        if (v === 'instances' && aid) setSearchOpen(true)
      }),
      window.api.shortcuts.onSwitchInstance((idx: number) => {
        const insts = instancesRef.current
        if (idx < insts.length) {
          const id = insts[idx].id
          setActiveId(id)
          setUnreadIds((prev) => {
            if (!prev.has(id)) return prev
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          setView('instances')
        }
      }),
      window.api.shortcuts.onZoomIn(() => {
        setFontSize((prev) => {
          const next = Math.min(prev + 1, 28)
          window.api.settings.set('fontSize', String(next))
          return next
        })
      }),
      window.api.shortcuts.onZoomOut(() => {
        setFontSize((prev) => {
          const next = Math.max(prev - 1, 8)
          window.api.settings.set('fontSize', String(next))
          return next
        })
      }),
      window.api.shortcuts.onZoomReset(() => {
        setFontSize(13)
        window.api.settings.set('fontSize', '13')
      }),
    ]
    return () => unsubs.forEach((u) => u())
  }, []) // empty deps — runs once, uses refs for fresh values

  const handleCreate = useCallback(async (opts: {
    name?: string
    workingDirectory?: string
    color?: string
    args?: string[]
  }) => {
    agentToLaunchRef.current = null
    const inst = await window.api.instance.create(opts)
    setActiveId(inst.id)
    setShowNewDialog(false)
    setView('instances')
  }, [])

  const handleSelect = useCallback((id: string) => {
    setActiveId(id)
    // Clear unread for this instance
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    setView((prev) => {
      return id === editorInstanceId && editingAgent ? 'agent-editor' : 'instances'
    })
  }, [editorInstanceId, editingAgent])

  const handleKill = useCallback(async (id: string) => {
    await window.api.instance.kill(id)
  }, [])

  const handleRemove = useCallback(async (id: string) => {
    await window.api.instance.remove(id)
    if (activeId === id) setActiveId(null)
    if (splitId === id) setSplitId(null)
    if (editorInstanceId === id) {
      setEditorInstanceId(null)
      setEditingAgent(null)
      setView('agents')
    }
  }, [activeId, editorInstanceId, splitId])

  const handleRename = useCallback(async (id: string, name: string) => {
    await window.api.instance.rename(id, name)
  }, [])

  const handleRecolor = useCallback(async (id: string, color: string) => {
    await window.api.instance.recolor(id, color)
  }, [])

  const handlePin = useCallback(async (id: string) => {
    await window.api.instance.pin(id)
  }, [])

  const handleUnpin = useCallback(async (id: string) => {
    await window.api.instance.unpin(id)
  }, [])

  const handleRestart = useCallback(async (id: string) => {
    const newInst = await window.api.instance.restart(id)
    if (newInst) setActiveId(newInst.id)
  }, [])

  const handleLaunchAgent = useCallback((agent: AgentDef) => {
    agentToLaunchRef.current = agent
    setShowNewDialog(true)
  }, [])

  const handleEditAgent = useCallback((agent: AgentDef) => {
    setEditingAgent(agent)
    setEditorInstanceId(null)
    setView('agent-editor')
  }, [])

  const handleCloseEditor = useCallback(() => {
    if (editorInstanceId) window.api.instance.remove(editorInstanceId)
    setEditingAgent(null)
    setEditorInstanceId(null)
    setView('agents')
  }, [editorInstanceId])

  const handleEditorInstanceCreated = useCallback((instanceId: string) => {
    setEditorInstanceId(instanceId)
  }, [])

  const handleViewChange = useCallback((v: SidebarView) => {
    setView(v)
  }, [])

  const handleResumeSession = useCallback(async (session: CliSession) => {
    const existing = instances.find((i) =>
      i.args.includes('--resume') && i.args.includes(session.sessionId)
    )
    if (existing) {
      setActiveId(existing.id)
      setView('instances')
      return
    }
    const inst = await window.api.instance.create({
      name: session.name || session.display.slice(0, 40),
      workingDirectory: session.project,
      args: ['--resume', session.sessionId],
    })
    setActiveId(inst.id)
    setView('instances')
  }, [instances])

  const handleRestoreAll = useCallback(async () => {
    const toRestore = restorableSessions.filter((s) => s.sessionId && s.exitType !== 'killed')
    for (const s of toRestore) {
      await window.api.instance.create({
        name: s.instanceName,
        workingDirectory: s.workingDirectory,
        color: s.color,
        args: ['--resume', s.sessionId!],
      })
    }
    await window.api.sessions.clearRestorable()
    setRestorableSessions([])
  }, [restorableSessions])

  // Drag & drop on sidebar to create instance
  const handleSidebarDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer.files
    if (files.length > 0) {
      const path = (files[0] as any).path as string
      if (path) {
        const inst = await window.api.instance.create({ workingDirectory: path })
        setActiveId(inst.id)
        setView('instances')
      }
    }
  }, [])

  const active = instances.find((i) => i.id === activeId) || null
  const showTerminal = view === 'instances' && active
  const isSplit = splitId && showTerminal && instances.some((i) => i.id === splitId)

  // Refit on view transitions
  const prevShowTerminalRef = useRef(false)
  const prevActiveIdRef = useRef<string | null>(null)
  useEffect(() => {
    const wasShowing = prevShowTerminalRef.current
    const prevId = prevActiveIdRef.current
    prevShowTerminalRef.current = !!showTerminal
    prevActiveIdRef.current = activeId

    const justBecameVisible = showTerminal && (!wasShowing || activeId !== prevId)
    if (!justBecameVisible || !activeId) return

    const entry = terminalsRef.current.get(activeId)
    if (entry) {
      requestAnimationFrame(() => {
        entry.fitAddon.fit()
        const dims = entry.fitAddon.proposeDimensions?.()
        if (dims && dims.cols > 0 && dims.rows > 0) {
          window.api.instance.resize(activeId, dims.cols, dims.rows)
        }
      })
    }
  }, [showTerminal, activeId])

  const regularInstances = instances.filter((i) => i.id !== editorInstanceId)
  const sidebarView: SidebarView = view === 'agent-editor' ? 'agents' : view

  // Status bar data
  const runningCount = instances.filter((i) => i.status === 'running').length
  const activeModel = active?.args.find((_, i, arr) => arr[i - 1] === '--model') || null
  const totalCost = instances.reduce((sum, i) => sum + i.tokenUsage.cost, 0)

  return (
    <div className="app">
      <Sidebar
        instances={instances}
        activeId={activeId}
        view={sidebarView}
        unreadIds={unreadIds}
        onSelect={handleSelect}
        onNew={() => { agentToLaunchRef.current = null; setShowNewDialog(true) }}
        onKill={handleKill}
        onRemove={handleRemove}
        onRename={handleRename}
        onRecolor={handleRecolor}
        onPin={handlePin}
        onUnpin={handleUnpin}
        onViewChange={handleViewChange}
        onResumeSession={handleResumeSession}
        onRestoreAll={handleRestoreAll}
        restorableCount={restorableSessions.filter((s) => s.sessionId && s.exitType !== 'killed').length}
        onDrop={handleSidebarDrop}
      />
      <div className={`main ${isSplit ? 'split' : ''}`}>
        {/* All terminals stay mounted */}
        {regularInstances.map((inst) => {
          const isActive = showTerminal && inst.id === activeId
          const isSplitTarget = isSplit && inst.id === splitId
          return (
            <div
              key={inst.id}
              className={`terminal-wrapper ${isActive || isSplitTarget ? 'visible' : 'hidden'}`}
            >
              <TerminalView
                instance={inst}
                onKill={handleKill}
                onRestart={handleRestart}
                onRemove={handleRemove}
                terminalsRef={terminalsRef}
                searchOpen={isActive && searchOpen}
                onSearchClose={() => setSearchOpen(false)}
                fontSize={fontSize}
              />
            </div>
          )
        })}

        {/* Agent editor */}
        {editingAgent && (
          <div style={{ display: view === 'agent-editor' ? 'contents' : 'none' }}>
            <AgentEditor
              key={editingAgent.id}
              agent={editingAgent}
              onBack={handleCloseEditor}
              onSave={() => {}}
              onInstanceCreated={handleEditorInstanceCreated}
            />
          </div>
        )}

        {/* Panels */}
        {view === 'settings' && (
          <SettingsPanel
            onBack={() => setView('instances')}
            theme={theme}
            onThemeChange={(t) => { setTheme(t); window.api.settings.set('theme', t) }}
          />
        )}
        {view === 'agents' && <AgentsPanel onLaunchAgent={handleLaunchAgent} onEditAgent={handleEditAgent} />}
        {view === 'instances' && !active && (
          <div className="empty-state">
            <h2>No instance selected</h2>
            <p>Create a new Claude CLI instance to get started</p>
            <button onClick={() => setShowNewDialog(true)}>New Instance</button>
          </div>
        )}

        {/* Status bar */}
        <div className="status-bar">
          <span className="status-bar-item">
            {runningCount} running
          </span>
          {active?.gitBranch && (
            <span className="status-bar-item status-bar-branch">
              {active.gitBranch}
            </span>
          )}
          {activeModel && (
            <span className="status-bar-item">{activeModel}</span>
          )}
          {totalCost > 0 && (
            <span className="status-bar-item status-bar-cost">
              ${totalCost.toFixed(4)}
            </span>
          )}
          <span className="status-bar-item">
            {fontSize}px
          </span>
          <span className="status-bar-spacer" />
          {active && (
            <span className="status-bar-item status-bar-right">
              {active.workingDirectory.split('/').pop()}
              {active.pid ? ` · PID ${active.pid}` : ''}
            </span>
          )}
        </div>
      </div>
      {showNewDialog && (
        <NewInstanceDialog
          onCreate={handleCreate}
          onClose={() => { setShowNewDialog(false); agentToLaunchRef.current = null }}
          prefill={agentToLaunchRef.current || undefined}
        />
      )}
    </div>
  )
}
