import { useState, useEffect, useCallback, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {
  Plus, Trash2, Play, Square, ChevronDown, ChevronRight,
  Save, FileText, CheckCircle, XCircle, Loader, Clock, ListOrdered, Layers
} from 'lucide-react'
import type { ClaudeInstance } from '../types'

interface TaskDef {
  prompt: string
  directory?: string
  name?: string
}

interface QueueDef {
  name: string
  mode: 'parallel' | 'sequential'
  tasks: TaskDef[]
}

interface TaskStatus {
  index: number
  instanceId: string | null
  state: 'pending' | 'running' | 'done' | 'failed'
  exitCode: number | null
}

interface QueueFile {
  name: string
  path: string
  content: string
}

interface Props {
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
}

function parseQueue(content: string): QueueDef | null {
  try {
    const lines = content.split('\n')
    let name = 'Untitled Queue'
    let mode: 'parallel' | 'sequential' = 'parallel'
    const tasks: TaskDef[] = []
    let inTasks = false
    let currentTask: Partial<TaskDef> | null = null

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      if (trimmed.startsWith('name:')) {
        name = trimmed.slice(5).trim().replace(/^["']|["']$/g, '')
      } else if (trimmed.startsWith('mode:')) {
        const m = trimmed.slice(5).trim().toLowerCase()
        mode = m === 'sequential' ? 'sequential' : 'parallel'
      } else if (trimmed === 'tasks:') {
        inTasks = true
      } else if (inTasks) {
        if (trimmed.startsWith('- prompt:') || trimmed.startsWith('-prompt:')) {
          if (currentTask?.prompt) tasks.push(currentTask as TaskDef)
          currentTask = { prompt: trimmed.replace(/^-\s*prompt:\s*/, '').replace(/^["']|["']$/g, '') }
        } else if (trimmed.startsWith('directory:') && currentTask) {
          currentTask.directory = trimmed.slice(10).trim().replace(/^["']|["']$/g, '')
        } else if (trimmed.startsWith('name:') && currentTask) {
          currentTask.name = trimmed.slice(5).trim().replace(/^["']|["']$/g, '')
        }
      }
    }
    if (currentTask?.prompt) tasks.push(currentTask as TaskDef)
    if (tasks.length === 0) return null
    return { name, mode, tasks }
  } catch {
    return null
  }
}

const TEMPLATE = `name: My Task Batch
mode: parallel
tasks:
  - prompt: "Analyze the codebase and list all TODOs"
    directory: /path/to/project
    name: Find TODOs
  - prompt: "Run the test suite and report failures"
    directory: /path/to/project
    name: Run Tests
`

export default function TaskQueuePanel({ instances, onFocusInstance }: Props) {
  const [queueFiles, setQueueFiles] = useState<QueueFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [editor, setEditor] = useState('')
  const [editingNew, setEditingNew] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [dividerX, setDividerX] = useState(50)

  // Running state
  const [runningQueue, setRunningQueue] = useState<QueueDef | null>(null)
  const [taskStatuses, setTaskStatuses] = useState<TaskStatus[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const stopRef = useRef(false)

  // CLI assistant terminal
  const [assistantId, setAssistantId] = useState<string | null>(null)
  const termContainerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ term: Terminal; fitAddon: FitAddon; unsub?: () => void } | null>(null)
  const initRef = useRef(false)

  // Load queue files
  useEffect(() => {
    window.api.taskQueue.list().then(setQueueFiles)
  }, [])

  const [colonyContextInstruction, setColonyCtx] = useState('')
  useEffect(() => { window.api.colony.getContextInstruction().then(setColonyCtx) }, [])

  const TASK_PROMPT = `You are helping the user create and manage task queue YAML files for Claude Colony. Task queues define batch jobs that spawn multiple Claude sessions. The format is:\n\n\`\`\`yaml\nname: Queue Name\nmode: parallel  # or sequential\ntasks:\n  - prompt: "What to do"\n    directory: /path/to/project\n    name: Task Name\n\`\`\`\n\nTask queue files are stored in ~/.claude-colony/task-queues/. Help the user design task queues, suggest tasks based on their projects, and write YAML files.${colonyContextInstruction}\n\nAsk what they want to accomplish.\r`

  const spawnAssistant = useCallback(async () => {
    // Clean up old terminal if it exists
    if (termRef.current) {
      termRef.current.unsub?.()
      termRef.current.term.dispose()
      termRef.current = null
    }

    const inst = await window.api.instance.create({ name: 'Task Assistant', color: '#f59e0b' })
    setAssistantId(inst.id)
    window.api.instance.rename(inst.id, 'Task Assistant')

    // Prime with context
    let sent = false
    let waitCount = 0
    const unsub = window.api.instance.onActivity(({ id, activity }) => {
      if (id !== inst.id || sent) return
      if (activity === 'waiting') {
        waitCount++
        if (waitCount === 1) { window.api.instance.write(inst.id, '\r') }
        else { sent = true; unsub(); window.api.instance.write(inst.id, `/rename Task Assistant\r`); setTimeout(() => window.api.instance.write(inst.id, TASK_PROMPT), 300) }
      }
    })
    setTimeout(() => { if (!sent && waitCount >= 1) { sent = true; unsub(); window.api.instance.write(inst.id, TASK_PROMPT) } }, 5000)
    setTimeout(() => { if (!sent) unsub() }, 15000)

    return inst.id
  }, [])

  // On mount: reuse existing Task Assistant or spawn new
  useEffect(() => {
    if (initRef.current) return
    initRef.current = true

    const existing = instances.find((i) => i.name === 'Task Assistant' && i.status === 'running')
    if (existing) {
      setAssistantId(existing.id)
    } else {
      spawnAssistant()
    }
  }, [])

  // If the assistant instance gets killed/removed, clear the ID
  useEffect(() => {
    if (assistantId && !instances.some((i) => i.id === assistantId)) {
      setAssistantId(null)
      if (termRef.current) {
        termRef.current.unsub?.()
        termRef.current.term.dispose()
        termRef.current = null
      }
    }
  }, [instances, assistantId])

  const assistantInstance = instances.find((i) => i.id === assistantId) || null

  // Setup terminal
  useEffect(() => {
    if (!assistantInstance || !termContainerRef.current || termRef.current) return

    const term = new Terminal({
      theme: { background: '#000000', foreground: '#e0e0e0', cursor: 'transparent', selectionBackground: '#3b82f650' },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: false,
      cursorStyle: 'underline',
      cursorWidth: 1,
      cursorInactiveStyle: 'none',
      scrollback: 10000,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon((_event, uri) => { window.api.shell.openExternal(uri) }))

    term.onData((data) => { window.api.instance.write(assistantInstance.id, data) })

    const unsub = window.api.instance.onOutput(({ id, data }) => {
      if (id === assistantInstance.id) term.write(data)
    })

    termRef.current = { term, fitAddon, unsub }
    term.open(termContainerRef.current)

    window.api.instance.buffer(assistantInstance.id).then((buf) => {
      if (buf) term.write(buf)
    })

    requestAnimationFrame(() => {
      fitAddon.fit()
      const dims = fitAddon.proposeDimensions()
      if (dims) window.api.instance.resize(assistantInstance.id, dims.cols, dims.rows)
    })

    const observer = new ResizeObserver(() => {
      fitAddon.fit()
      const dims = fitAddon.proposeDimensions()
      if (dims && assistantInstance) window.api.instance.resize(assistantInstance.id, dims.cols, dims.rows)
    })
    observer.observe(termContainerRef.current)

    return () => { observer.disconnect(); unsub() }
  }, [assistantInstance])

  const handleSelectFile = useCallback((file: QueueFile) => {
    setSelectedFile(file.name)
    setEditor(file.content)
    setEditingNew(false)
  }, [])

  const handleSave = useCallback(async () => {
    const name = editingNew ? (newFileName.trim() || 'untitled.yaml') : selectedFile
    if (!name) return
    const fileName = name.endsWith('.yaml') || name.endsWith('.yml') ? name : `${name}.yaml`
    await window.api.taskQueue.save(fileName, editor)
    const files = await window.api.taskQueue.list()
    setQueueFiles(files)
    setSelectedFile(fileName)
    setEditingNew(false)
  }, [editor, selectedFile, editingNew, newFileName])

  const handleDelete = useCallback(async (name: string) => {
    await window.api.taskQueue.delete(name)
    const files = await window.api.taskQueue.list()
    setQueueFiles(files)
    if (selectedFile === name) { setSelectedFile(null); setEditor('') }
  }, [selectedFile])

  const handleNew = useCallback(() => {
    setEditingNew(true)
    setSelectedFile(null)
    setNewFileName('')
    setEditor(TEMPLATE)
  }, [])

  const handleRun = useCallback(async () => {
    const queue = parseQueue(editor)
    if (!queue) return
    setRunningQueue(queue)
    setIsRunning(true)
    setShowResults(true)
    stopRef.current = false

    const statuses: TaskStatus[] = queue.tasks.map((_, i) => ({ index: i, instanceId: null, state: 'pending' as const, exitCode: null }))
    setTaskStatuses([...statuses])

    const runTask = async (taskIndex: number): Promise<void> => {
      if (stopRef.current) return
      const task = queue.tasks[taskIndex]
      statuses[taskIndex].state = 'running'
      setTaskStatuses([...statuses])
      try {
        const inst = await window.api.instance.create({ name: task.name || `Task ${taskIndex + 1}`, workingDirectory: task.directory || undefined })
        statuses[taskIndex].instanceId = inst.id
        await new Promise<void>((resolve) => {
          let sent = false; let waitCount = 0
          const unsub = window.api.instance.onActivity(({ id, activity }) => {
            if (id !== inst.id || sent) return
            if (activity === 'waiting') {
              waitCount++
              if (waitCount === 1) { window.api.instance.write(inst.id, '\r') }
              else { sent = true; unsub(); window.api.instance.write(inst.id, task.prompt + '\r'); resolve() }
            }
          })
          setTimeout(() => { if (!sent && waitCount >= 1) { sent = true; unsub(); window.api.instance.write(inst.id, task.prompt + '\r'); resolve() } }, 5000)
          setTimeout(() => { if (!sent) { unsub(); resolve() } }, 15000)
        })
        await new Promise<void>((resolve) => {
          const unsub = window.api.instance.onExited(({ id, exitCode }) => {
            if (id !== inst.id) return; unsub()
            statuses[taskIndex].exitCode = exitCode
            statuses[taskIndex].state = exitCode === 0 ? 'done' : 'failed'
            setTaskStatuses([...statuses]); resolve()
          })
        })
      } catch { statuses[taskIndex].state = 'failed'; setTaskStatuses([...statuses]) }
    }

    if (queue.mode === 'parallel') { await Promise.all(queue.tasks.map((_, i) => runTask(i))) }
    else { for (let i = 0; i < queue.tasks.length; i++) { if (stopRef.current) break; await runTask(i) } }
    setIsRunning(false)
  }, [editor])

  const handleStop = useCallback(() => {
    stopRef.current = true
    for (const s of taskStatuses) { if (s.state === 'running' && s.instanceId) window.api.instance.kill(s.instanceId) }
    setIsRunning(false)
  }, [taskStatuses])

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startPct = dividerX
    const container = (e.target as HTMLElement).parentElement!
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const containerWidth = container.getBoundingClientRect().width
      setDividerX(Math.max(25, Math.min(75, startPct + (delta / containerWidth) * 100)))
    }
    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      termRef.current?.fitAddon.fit()
      if (assistantInstance) {
        const dims = termRef.current?.fitAddon.proposeDimensions()
        if (dims) window.api.instance.resize(assistantInstance.id, dims.cols, dims.rows)
      }
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [dividerX, assistantInstance])

  const parsed = parseQueue(editor)
  const doneCount = taskStatuses.filter((s) => s.state === 'done').length
  const failedCount = taskStatuses.filter((s) => s.state === 'failed').length
  const totalCount = taskStatuses.length

  return (
    <div className="task-queue-panel">
      <div className="task-queue-split">
        {/* Left: editor */}
        <div className="task-queue-left" style={{ width: `${dividerX}%` }}>
          <div className="task-queue-header">
            <h2>Tasks</h2>
            <button className="task-queue-new-btn" onClick={handleNew} title="Create new queue">
              <Plus size={13} /> New
            </button>
          </div>

          {/* File list */}
          <div className="task-queue-files">
            {queueFiles.map((f) => (
              <div
                key={f.name}
                className={`task-queue-file ${selectedFile === f.name ? 'active' : ''}`}
                onClick={() => handleSelectFile(f)}
              >
                <FileText size={13} />
                <span>{f.name}</span>
                <button className="task-queue-file-delete" onClick={(e) => { e.stopPropagation(); handleDelete(f.name) }} title="Delete"><Trash2 size={11} /></button>
              </div>
            ))}
          </div>

          {/* Editor */}
          {(selectedFile || editingNew) && (
            <div className="task-queue-editor">
              {editingNew && (
                <div className="task-queue-editor-name">
                  <input placeholder="queue-name.yaml" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} autoFocus />
                </div>
              )}
              <textarea className="task-queue-textarea" value={editor} onChange={(e) => setEditor(e.target.value)} spellCheck={false} />
              <div className="task-queue-editor-actions">
                <div className="task-queue-editor-info">
                  {parsed ? (
                    <>
                      <span className="task-queue-parse-ok"><CheckCircle size={11} /> {parsed.tasks.length} task{parsed.tasks.length !== 1 ? 's' : ''}</span>
                      <span className="task-queue-parse-mode">{parsed.mode === 'parallel' ? <Layers size={11} /> : <ListOrdered size={11} />} {parsed.mode}</span>
                    </>
                  ) : (
                    <span className="task-queue-parse-err"><XCircle size={11} /> Invalid format</span>
                  )}
                </div>
                <button className="task-queue-save-btn" onClick={handleSave} title="Save"><Save size={12} /> Save</button>
                {parsed && !isRunning && <button className="task-queue-run-btn" onClick={handleRun} title="Run all tasks"><Play size={12} /> Run</button>}
                {isRunning && <button className="task-queue-stop-btn" onClick={handleStop} title="Stop"><Square size={12} /> Stop</button>}
              </div>
            </div>
          )}

          {/* Results */}
          {showResults && runningQueue && (
            <div className="task-queue-results">
              <div className="task-queue-results-header">
                <span>{runningQueue.name}</span>
                {!isRunning && totalCount > 0 && (
                  <span className="task-queue-results-summary">
                    {doneCount}/{totalCount} passed{failedCount > 0 && <span className="task-queue-results-failed"> | {failedCount} failed</span>}
                  </span>
                )}
                {isRunning && <Loader size={12} className="spinning" />}
              </div>
              {taskStatuses.map((s) => {
                const task = runningQueue.tasks[s.index]
                return (
                  <div key={s.index} className={`task-queue-result-item ${s.state}`}>
                    <span className="task-queue-result-icon">
                      {s.state === 'pending' && <Clock size={12} />}
                      {s.state === 'running' && <Loader size={12} className="spinning" />}
                      {s.state === 'done' && <CheckCircle size={12} />}
                      {s.state === 'failed' && <XCircle size={12} />}
                    </span>
                    <span className="task-queue-result-name">{task.name || `Task ${s.index + 1}`}</span>
                    <span className="task-queue-result-prompt">{task.prompt.slice(0, 60)}</span>
                    {s.instanceId && <button className="task-queue-result-focus" onClick={() => onFocusInstance(s.instanceId!)} title="Focus session">View</button>}
                  </div>
                )
              })}
            </div>
          )}

          {!selectedFile && !editingNew && queueFiles.length === 0 && (
            <div className="task-queue-empty-state">
              <ListOrdered size={28} />
              <p>Define batch tasks as YAML</p>
              <p className="task-queue-empty-hint">Each task spawns a Claude session. Ask the assistant on the right for help.</p>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="task-queue-divider" onMouseDown={handleDragStart} />

        {/* Right: CLI assistant */}
        <div className="task-queue-right" style={{ width: `${100 - dividerX}%` }}>
          <div className="task-queue-term-header">
            <span>Task Assistant</span>
            <button
              className="task-queue-term-new"
              onClick={() => spawnAssistant()}
              title="Start a fresh Task Assistant session"
            >
              <Plus size={12} /> New
            </button>
          </div>
          <div className="task-queue-term-container" ref={termContainerRef} />
        </div>
      </div>
    </div>
  )
}
