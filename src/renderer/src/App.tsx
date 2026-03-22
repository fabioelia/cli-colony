import { useState, useEffect, useCallback, useRef } from 'react'
import type { ClaudeInstance, AgentDef, CliSession, RecentSession } from './types'
import Sidebar, { SidebarView } from './components/Sidebar'
import TerminalView from './components/TerminalView'
import NewInstanceDialog from './components/NewInstanceDialog'
import AgentsPanel from './components/AgentsPanel'
import AgentEditor from './components/AgentEditor'
import SettingsPanel from './components/SettingsPanel'
import GitHubPanel from './components/GitHubPanel'

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
  const [focusedPane, setFocusedPane] = useState<'left' | 'right'>('left')
  const [showSplitPicker, setShowSplitPicker] = useState(false)
  const [splitRatio, setSplitRatio] = useState(0.5)
  const [unreadIds, setUnreadIds] = useState<Set<string>>(new Set())
  const [fontSize, setFontSize] = useState(13)
  const terminalsRef = useRef<Map<string, any>>(new Map())
  const agentToLaunchRef = useRef<AgentDef | null>(null)
  // Track activeId + view in a ref so the output listener always has fresh values
  const activeViewRef = useRef<{ activeId: string | null; view: View }>({ activeId: null, view: 'instances' })
  activeViewRef.current = { activeId, view }
  const instancesRef = useRef(instances)
  instancesRef.current = instances
  const splitRef = useRef<{ splitId: string | null; focusedPane: 'left' | 'right' }>({ splitId: null, focusedPane: 'left' })
  splitRef.current = { splitId, focusedPane }

  useEffect(() => {
    window.api.instance.list().then(setInstances)
    window.api.sessions.restorable().then(setRestorableSessions)
    window.api.settings.getAll().then((s) => {
      if (s.fontSize) {
        setFontSize(parseInt(s.fontSize, 10) || 13)
      }
    })
  }, [])

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
        const { splitId: sid, focusedPane: fp } = splitRef.current
        // In split: kill the focused pane's instance
        const targetId = sid ? (fp === 'left' ? aid : sid) : aid
        if (targetId) {
          const inst = instancesRef.current.find((i) => i.id === targetId)
          if (inst?.status === 'running') window.api.instance.kill(targetId)
          else window.api.instance.remove(targetId)
        }
      }),
      window.api.shortcuts.onToggleSplit(() => {
        // Trigger via state update — handleToggleSplit uses stale refs in the closure,
        // so we dispatch an event the effect can pick up
        window.dispatchEvent(new CustomEvent('colony:toggle-split'))
      }),
      window.api.shortcuts.onCloseSplit(() => {
        window.dispatchEvent(new CustomEvent('colony:close-split'))
      }),
      window.api.shortcuts.onFocusPane((side) => {
        setFocusedPane(side)
      }),
      window.api.shortcuts.onSearch(() => {
        const { activeId: aid, view: v } = activeViewRef.current
        if (v === 'instances' && aid) setSearchOpen(true)
      }),
      window.api.shortcuts.onSwitchInstance((idx: number) => {
        // Match visual order: pinned, then running, then exited
        const all = instancesRef.current
        const pinned = all.filter((i) => i.pinned)
        const running = all.filter((i) => i.status === 'running' && !i.pinned)
        const exited = all.filter((i) => i.status !== 'running' && !i.pinned)
        const insts = [...pinned, ...running, ...exited]
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
      window.api.shortcuts.onCycleInstance((direction: number) => {
        const all = instancesRef.current
        const pinned = all.filter((i) => i.pinned)
        const running = all.filter((i) => i.status === 'running' && !i.pinned)
        const exited = all.filter((i) => i.status !== 'running' && !i.pinned)
        const ordered = [...pinned, ...running, ...exited]
        if (ordered.length === 0) return
        const { activeId: aid } = activeViewRef.current
        const currentIdx = ordered.findIndex((i) => i.id === aid)
        const nextIdx = currentIdx === -1 ? 0 : (currentIdx + direction + ordered.length) % ordered.length
        const id = ordered[nextIdx].id
        setActiveId(id)
        setUnreadIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setView('instances')
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
    // Clear unread
    setUnreadIds((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })

    // Editor instance check
    if (id === editorInstanceId && editingAgent) {
      setActiveId(id)
      setView('agent-editor')
      return
    }

    // In split mode: clicking replaces focused pane, or swaps if clicking unfocused pane's instance
    if (splitId) {
      if (id === splitId && focusedPane === 'left') {
        // Clicking the right pane's instance — swap
        setSplitId(activeId)
        setActiveId(id)
      } else if (id === activeId && focusedPane === 'right') {
        // Clicking the left pane's instance — swap focus
        setFocusedPane('left')
      } else if (focusedPane === 'left') {
        setActiveId(id)
      } else {
        setSplitId(id)
      }
    } else {
      setActiveId(id)
    }
    setView('instances')
  }, [editorInstanceId, editingAgent, splitId, activeId, focusedPane])

  const handleKill = useCallback(async (id: string) => {
    await window.api.instance.kill(id)
    // If we killed a split instance, collapse to the surviving one
    if (splitId && (id === activeId || id === splitId)) {
      const survivingId = id === activeId ? splitId : activeId
      setActiveId(survivingId)
      setSplitId(null)
      setFocusedPane('left')
    }
  }, [splitId, activeId])

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
      const inst = await window.api.instance.create({
        name: s.instanceName,
        workingDirectory: s.workingDirectory,
        color: s.color,
        args: ['--resume', s.sessionId!],
      })
      if (s.pinned) {
        await window.api.instance.pin(inst.id)
      }
    }
    await window.api.sessions.clearRestorable()
    setRestorableSessions([])
  }, [restorableSessions])

  // Drag & drop on sidebar to create instance
  const handleSidebarDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault()
    const files = e.dataTransfer.files
    if (files.length > 0) {
      const path = window.api.getPathForFile(files[0])
      if (path) {
        const inst = await window.api.instance.create({ workingDirectory: path })
        setActiveId(inst.id)
        setView('instances')
      }
    }
  }, [])

  const regularInstances = instances.filter((i) => i.id !== editorInstanceId)

  // Open split with a specific instance
  const handleSplitWith = useCallback((id: string) => {
    if (id === activeId) return
    setSplitId(id)
    setFocusedPane('left')
    setSplitRatio(0.5)
    setView('instances')
  }, [activeId])

  // Toggle split on/off (Cmd+\)
  const handleToggleSplit = useCallback(() => {
    if (splitId) {
      // Close split, keep focused pane's instance
      const keepId = focusedPane === 'left' ? activeId : splitId
      setActiveId(keepId)
      setSplitId(null)
      setFocusedPane('left')
    } else {
      // Open split — auto-pick if 2 instances, show picker if more
      const others = regularInstances.filter((i) => i.id !== activeId)
      if (others.length === 1) {
        setSplitId(others[0].id)
        setFocusedPane('left')
        setSplitRatio(0.5)
      } else if (others.length > 1) {
        setShowSplitPicker(true)
      }
    }
  }, [splitId, focusedPane, activeId, regularInstances])

  // Close split, keep both instances alive (Cmd+Shift+W)
  const handleCloseSplitView = useCallback(() => {
    if (!splitId) return
    const keepId = focusedPane === 'left' ? activeId : splitId
    setActiveId(keepId)
    setSplitId(null)
    setFocusedPane('left')
  }, [splitId, focusedPane, activeId])

  const handlePickSplit = useCallback((id: string) => {
    setSplitId(id)
    setFocusedPane('left')
    setSplitRatio(0.5)
    setShowSplitPicker(false)
  }, [])

  // I5: Clear splitId if the split instance no longer exists
  useEffect(() => {
    if (splitId && !instances.some((i) => i.id === splitId)) {
      setSplitId(null)
      setFocusedPane('left')
    }
  }, [instances, splitId])

  // Bridge custom events to handlers (so shortcuts can call stateful handlers)
  useEffect(() => {
    const onToggle = () => handleToggleSplit()
    const onClose = () => handleCloseSplitView()
    window.addEventListener('colony:toggle-split', onToggle)
    window.addEventListener('colony:close-split', onClose)
    return () => {
      window.removeEventListener('colony:toggle-split', onToggle)
      window.removeEventListener('colony:close-split', onClose)
    }
  }, [handleToggleSplit, handleCloseSplitView])

  const active = instances.find((i) => i.id === activeId) || null
  const showTerminal = view === 'instances' && active
  const isSplit = !!(splitId && showTerminal && instances.some((i) => i.id === splitId))

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

  // Refit both terminals when split changes
  useEffect(() => {
    if (!showTerminal) return
    const ids = [activeId, splitId].filter(Boolean) as string[]
    requestAnimationFrame(() => {
      for (const id of ids) {
        const entry = terminalsRef.current.get(id)
        if (entry) {
          entry.fitAddon.fit()
          const dims = entry.fitAddon.proposeDimensions?.()
          if (dims && dims.cols > 0 && dims.rows > 0) {
            window.api.instance.resize(id, dims.cols, dims.rows)
          }
        }
      }
    })
  }, [isSplit, splitId])

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
        onRestart={handleRestart}
        onRemove={handleRemove}
        onRename={handleRename}
        onRecolor={handleRecolor}
        onPin={handlePin}
        onUnpin={handleUnpin}
        onViewChange={handleViewChange}
        onResumeSession={handleResumeSession}
        onRestoreAll={handleRestoreAll}
        restorableCount={restorableSessions.filter((s) => s.sessionId && s.exitType !== 'killed').length}
        splitId={splitId}
        focusedPane={focusedPane}
        onSplitWith={handleSplitWith}
        onCloseSplit={handleCloseSplitView}
        onDrop={handleSidebarDrop}
      />
      <div className={`main ${isSplit ? 'split' : ''}`}>
        {/* All terminals stay mounted */}
        {regularInstances.map((inst) => {
          const isLeft = showTerminal && inst.id === activeId
          const isRight = isSplit && inst.id === splitId
          const isVisible = isLeft || isRight
          const isFocused = isVisible && (
            !isSplit || (isLeft && focusedPane === 'left') || (isRight && focusedPane === 'right')
          )
          return (
            <div
              key={inst.id}
              className={`terminal-wrapper ${isVisible ? 'visible' : 'hidden'}`}
              style={isSplit && isVisible ? {
                flex: `0 0 calc(${isLeft ? splitRatio * 100 : (1 - splitRatio) * 100}% - 2px)`,
                order: isLeft ? 0 : 2,
              } : undefined}
            >
              <TerminalView
                instance={inst}
                onKill={handleKill}
                onRestart={handleRestart}
                onRemove={handleRemove}
                terminalsRef={terminalsRef}
                searchOpen={isFocused && searchOpen}
                onSearchClose={() => setSearchOpen(false)}
                fontSize={fontSize}
                focused={isFocused}
                onFocusPane={() => setFocusedPane(isLeft ? 'left' : 'right')}
              />
            </div>
          )
        })}

        {/* Split divider */}
        {isSplit && (
          <div
            className="split-divider"
            style={{ order: 1 }}
            onMouseDown={(e) => {
              e.preventDefault()
              const startX = e.clientX
              const startRatio = splitRatio
              const container = (e.target as HTMLElement).parentElement!
              const containerWidth = container.getBoundingClientRect().width
              let lastFit = 0

              const refitTerminals = () => {
                ;[activeId, splitId].filter(Boolean).forEach((id) => {
                  const entry = terminalsRef.current.get(id!)
                  if (entry) {
                    entry.fitAddon.fit()
                    const dims = entry.fitAddon.proposeDimensions?.()
                    if (dims && dims.cols > 0 && dims.rows > 0) {
                      window.api.instance.resize(id!, dims.cols, dims.rows)
                    }
                  }
                })
              }

              const onMove = (ev: MouseEvent) => {
                const delta = ev.clientX - startX
                const newRatio = Math.max(0.3, Math.min(0.7, startRatio + delta / containerWidth))
                setSplitRatio(newRatio)
                // N8: Debounced refit during drag
                const now = Date.now()
                if (now - lastFit > 100) {
                  lastFit = now
                  requestAnimationFrame(refitTerminals)
                }
              }
              const onUp = () => {
                document.removeEventListener('mousemove', onMove)
                document.removeEventListener('mouseup', onUp)
                // Final refit
                refitTerminals()
              }
              document.addEventListener('mousemove', onMove)
              document.addEventListener('mouseup', onUp)
            }}
            onDoubleClick={() => setSplitRatio(0.5)}
          />
        )}

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
          />
        )}
        {view === 'agents' && <AgentsPanel onLaunchAgent={handleLaunchAgent} onEditAgent={handleEditAgent} />}
        <div style={{ display: view === 'github' ? 'contents' : 'none' }}>
          <GitHubPanel
            onBack={() => setView('instances')}
            instances={instances}
            onLaunchInstance={async (opts) => {
              const inst = await window.api.instance.create(opts)
              setActiveId(inst.id)
              setView('instances')
              return inst.id
            }}
            onFocusInstance={(id) => {
              setActiveId(id)
              setView('instances')
            }}
          />
        </div>
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
          {totalCost > 0.001 && (
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
      {showSplitPicker && (
        <div className="dialog-overlay" onClick={() => setShowSplitPicker(false)}>
          <div className="dialog" onClick={(e) => e.stopPropagation()}>
            <h2>Split with...</h2>
            <div className="split-picker-list">
              {regularInstances
                .filter((i) => i.id !== activeId)
                .map((i) => (
                  <div
                    key={i.id}
                    className="split-picker-item"
                    role="button"
                    tabIndex={0}
                    onClick={() => handlePickSplit(i.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handlePickSplit(i.id) } }}
                  >
                    <div className="instance-dot" style={{ backgroundColor: i.color }} />
                    <span>{i.name}</span>
                    <span className="split-picker-dir">{i.workingDirectory.split('/').pop()}</span>
                  </div>
                ))
              }
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
