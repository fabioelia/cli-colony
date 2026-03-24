import { useState, useEffect, useCallback, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import {
  Plus, Trash2, Play, Square, ChevronDown, ChevronRight,
  Save, FileText, CheckCircle, XCircle, Loader, Clock, ListOrdered, Layers,
  FolderOpen, File, RefreshCw, FolderTree, Zap
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

interface RunFile {
  name: string
  path: string
  size: number
}

interface RunTask {
  name: string
  path: string
  files: RunFile[]
}

interface RunQueue {
  name: string
  path: string
  tasks: RunTask[]
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
  const [editorTab, setEditorTab] = useState<'yaml' | 'memory'>('yaml')
  const [taskMemory, setTaskMemory] = useState('')
  const [memoryDirty, setMemoryDirty] = useState(false)

  // Running state
  const [runningQueue, setRunningQueue] = useState<QueueDef | null>(null)
  const [taskStatuses, setTaskStatuses] = useState<TaskStatus[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const stopRef = useRef(false)

  // Convert to pipeline modal
  const [showConvertModal, setShowConvertModal] = useState(false)
  const [convertCron, setConvertCron] = useState('0 9 * * 1-5')
  const [convertReuse, setConvertReuse] = useState(true)
  const [convertResult, setConvertResult] = useState<{ count: number; names: string[] } | null>(null)
  const [convertNames, setConvertNames] = useState<string[]>([])
  const [convertMode, setConvertMode] = useState<'copy' | 'reference'>('reference')

  // Runs & artifacts
  const [runs, setRuns] = useState<RunQueue[]>([])
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set())
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set())
  const [previewFile, setPreviewFile] = useState<{ path: string; content: string; name: string } | null>(null)
  const [showRuns, setShowRuns] = useState(true)

  const loadRuns = useCallback(async () => {
    const data = await window.api.taskQueue.listRuns()
    setRuns(data)
  }, [])

  // Load runs on mount and after a queue finishes running
  useEffect(() => { loadRuns() }, [loadRuns])
  useEffect(() => { if (!isRunning && showResults) loadRuns() }, [isRunning])

  const toggleRunExpand = (key: string) => {
    setExpandedRuns((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const toggleTaskExpand = (key: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      return next
    })
  }

  const handlePreviewFile = async (file: RunFile) => {
    const result = await window.api.fs.readFile(file.path)
    if (result.content !== undefined) {
      setPreviewFile({ path: file.path, content: result.content, name: file.name })
    }
  }

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

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
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  useEffect(() => {
    window.api.colony.getContextInstruction().then(setColonyCtx)
    window.api.taskQueue.getWorkspacePath().then(setWorkspacePath)
  }, [])

  const TASK_PROMPT = `You are helping the user create and manage task queue YAML files for Claude Colony. Task queues define batch jobs that spawn multiple Claude sessions. The format is:\n\n\`\`\`yaml\nname: Queue Name\nmode: parallel  # or sequential\ntasks:\n  - prompt: "What to do"\n    directory: /path/to/project\n    name: Task Name\n\`\`\`\n\nTask queue files are stored in ~/.claude-colony/task-queues/. Help the user design task queues, suggest tasks based on their projects, and write YAML files.${colonyContextInstruction}\n\nAsk what they want to accomplish.`

  // Robust prompt sender — waits for CLI to be ready, dismisses trust prompt
  // Returns a promise that resolves once the prompt has been sent
  // IMPORTANT: Do NOT call instance.rename() before the prompt — the daemon's
  // renameInstance writes /rename to the PTY which concatenates with the prompt
  const sendPromptWhenReady = useCallback((id: string, prompt: string, sessionName?: string): Promise<void> => {
    return new Promise((resolve) => {
      let sent = false
      let waitCount = 0

      const unsub = window.api.instance.onActivity(({ id: instId, activity }) => {
        if (instId !== id || sent) return
        if (activity === 'waiting') {
          waitCount++
          if (waitCount === 1) {
            // First waiting might be trust prompt — dismiss it
            window.api.instance.write(id, '\r')
          } else {
            sent = true
            unsub()
            window.api.instance.write(id, prompt + '\r')
            // Rename after prompt is sent — delayed so CLI processes the prompt first
            if (sessionName) {
              setTimeout(() => window.api.instance.rename(id, sessionName), 2000)
            }
            resolve()
          }
        }
      })
      // Fallback: if only one waiting state (no trust prompt), send after timeout
      setTimeout(() => {
        if (!sent && waitCount >= 1) {
          sent = true
          unsub()
          window.api.instance.write(id, prompt + '\r')
          if (sessionName) {
            setTimeout(() => window.api.instance.rename(id, sessionName), 2000)
          }
          resolve()
        }
      }, 5000)
      // Safety timeout
      setTimeout(() => { if (!sent) { unsub(); resolve() } }, 15000)
    })
  }, [])

  const spawnAssistant = useCallback(async () => {
    // Clean up old terminal if it exists
    if (termRef.current) {
      termRef.current.unsub?.()
      termRef.current.term.dispose()
      termRef.current = null
    }

    const inst = await window.api.instance.create({
      name: 'Task Assistant',
      color: '#f59e0b',
      workingDirectory: workspacePath || undefined,
      args: ['--append-system-prompt', TASK_PROMPT],
    })
    setAssistantId(inst.id)

    return inst.id
  }, [workspacePath, TASK_PROMPT])

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

  const handleSelectFile = useCallback(async (file: QueueFile) => {
    setSelectedFile(file.name)
    setEditor(file.content)
    setEditingNew(false)
    setEditorTab('yaml')
    const mem = await window.api.taskQueue.getMemory(file.name)
    setTaskMemory(mem || '')
    setMemoryDirty(false)
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

  const handleSaveMemory = useCallback(async () => {
    if (!selectedFile) return
    await window.api.taskQueue.saveMemory(selectedFile, taskMemory)
    setMemoryDirty(false)
  }, [selectedFile, taskMemory])

  const handleOpenConvertModal = useCallback(() => {
    const queue = parseQueue(editor)
    if (!queue) return
    setConvertCron('0 9 * * 1-5')
    setConvertReuse(true)
    setConvertResult(null)
    setConvertNames(queue.tasks.map((t, i) => t.name || `Task ${i + 1}`))
    setConvertMode('reference')
    setShowConvertModal(true)
  }, [editor])

  const handleConvertConfirm = useCallback(async () => {
    const queue = parseQueue(editor)
    if (!queue) return
    const resultNames: string[] = []
    for (let i = 0; i < queue.tasks.length; i++) {
      const task = queue.tasks[i]
      const taskName = convertNames[i] || task.name || `Task ${i + 1}`
      const safeName = taskName.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '-').toLowerCase()
      const fileName = `${safeName}.yaml`

      // Reference mode: point to the task queue file; Copy mode: inline the prompt
      const promptSection = convertMode === 'reference'
        ? `    Read the task queue file at ~/.claude-colony/task-queues/${selectedFile || 'unknown.yaml'} and execute the task named "${taskName}" (task #${i + 1}). Follow the prompt defined there exactly.`
        : `    ${task.prompt.split('\n').join('\n    ')}`

      const yaml = `name: ${taskName}
description: ${convertMode === 'reference' ? `References task from "${queue.name}"` : `Converted from task queue "${queue.name}"`}
enabled: false

trigger:
  type: cron
  cron: "${convertCron}"

condition:
  type: always

action:
  type: launch-session
  ${convertReuse ? 'reuse: true' : '# reuse: false'}
  name: "${taskName}"
  ${task.directory ? `workingDirectory: "${task.directory}"` : '# workingDirectory: /path/to/project'}
  color: "#8b5cf6"
  prompt: |
${promptSection}

dedup:
  key: "${safeName}"
  ttl: 3600
`
      await window.api.pipeline.saveContent(fileName, yaml)
      resultNames.push(taskName)
    }
    await window.api.pipeline.reload()
    setConvertResult({ count: resultNames.length, names: resultNames })
  }, [editor, convertCron, convertReuse, convertNames, convertMode, selectedFile])

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
      const taskLabel = task.name || `Task ${taskIndex + 1}`
      const sessionName = `${queue.name} › ${taskLabel}`
      statuses[taskIndex].state = 'running'
      setTaskStatuses([...statuses])
      try {
        // Inject memory if available
        let taskPrompt = task.prompt
        if (selectedFile) {
          const memory = await window.api.taskQueue.getMemory(selectedFile)
          if (memory?.trim()) {
            taskPrompt += `\n\n--- Task Memory ---\nLearnings from previous runs:\n\n${memory}\n\nWhen done, if you learned anything useful about tools, approaches, or patterns, mention it so it can be saved for next time.`
          }
        }

        // Each task gets its own directory unless one is specified
        const dir = task.directory || await window.api.taskQueue.createTaskDir(queue.name, taskLabel)
        const inst = await window.api.instance.create({ name: sessionName, workingDirectory: dir })
        statuses[taskIndex].instanceId = inst.id
        // Don't pass sessionName — create already set it, no need for /rename via PTY
        await sendPromptWhenReady(inst.id, taskPrompt)
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
  }, [editor, workspacePath, sendPromptWhenReady])

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
              {!editingNew && selectedFile && (
                <div className="task-queue-editor-tabs">
                  <button className={`task-queue-tab ${editorTab === 'yaml' ? 'active' : ''}`} onClick={() => setEditorTab('yaml')}>
                    <FileText size={11} /> Config
                  </button>
                  <button className={`task-queue-tab ${editorTab === 'memory' ? 'active' : ''}`} onClick={() => setEditorTab('memory')}>
                    <Zap size={11} /> Memory
                  </button>
                </div>
              )}
              {editorTab === 'yaml' || editingNew ? (
                <textarea className="task-queue-textarea" value={editor} onChange={(e) => setEditor(e.target.value)} spellCheck={false} />
              ) : (
                <div className="task-queue-memory-editor">
                  <p className="task-queue-memory-hint">
                    Learnings from previous runs — tools, patterns, and approaches that help future executions. Injected into prompts automatically.
                  </p>
                  <textarea
                    className="task-queue-textarea"
                    value={taskMemory}
                    onChange={(e) => { setTaskMemory(e.target.value); setMemoryDirty(true) }}
                    placeholder="No memories yet. Run the task and add learnings here, or they'll be captured automatically."
                    spellCheck={false}
                  />
                  {memoryDirty && (
                    <button className="task-queue-save-btn" onClick={handleSaveMemory} style={{ alignSelf: 'flex-end' }}>
                      <Save size={12} /> Save Memory
                    </button>
                  )}
                </div>
              )}
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
                {parsed && !isRunning && <button className="task-queue-pipeline-btn" onClick={handleOpenConvertModal} title="Convert tasks to pipelines (cron-scheduled)"><Zap size={12} /> To Pipeline</button>}
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

          {/* Runs & Artifacts */}
          {runs.length > 0 && (
            <div className="task-runs">
              <div className="task-runs-header" onClick={() => setShowRuns(!showRuns)}>
                {showRuns ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                <FolderTree size={13} />
                <span>Runs & Artifacts</span>
                <span className="task-runs-count">{runs.length} queue{runs.length !== 1 ? 's' : ''}</span>
                <button className="task-runs-refresh" onClick={(e) => { e.stopPropagation(); loadRuns() }} title="Refresh"><RefreshCw size={11} /></button>
              </div>
              {showRuns && (
                <div className="task-runs-tree">
                  {runs.map((queue) => (
                    <div key={queue.name} className="task-runs-queue">
                      <div className="task-runs-queue-row" onClick={() => toggleRunExpand(queue.name)}>
                        {expandedRuns.has(queue.name) ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                        <FolderOpen size={12} />
                        <span className="task-runs-queue-name">{queue.name}</span>
                        <span className="task-runs-task-count">{queue.tasks.length} task{queue.tasks.length !== 1 ? 's' : ''}</span>
                      </div>
                      {expandedRuns.has(queue.name) && queue.tasks.map((task) => (
                        <div key={task.name} className="task-runs-task">
                          <div className="task-runs-task-row" onClick={() => toggleTaskExpand(`${queue.name}/${task.name}`)}>
                            {expandedTasks.has(`${queue.name}/${task.name}`) ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                            <FolderOpen size={11} />
                            <span className="task-runs-task-name">{task.name}</span>
                            {task.files.length > 0 && <span className="task-runs-file-count">{task.files.length} file{task.files.length !== 1 ? 's' : ''}</span>}
                          </div>
                          {expandedTasks.has(`${queue.name}/${task.name}`) && (
                            <div className="task-runs-files">
                              {task.files.length === 0 ? (
                                <div className="task-runs-no-files">No artifacts yet</div>
                              ) : task.files.map((file) => (
                                <div
                                  key={file.name}
                                  className={`task-runs-file ${previewFile?.path === file.path ? 'active' : ''}`}
                                  onClick={() => handlePreviewFile(file)}
                                >
                                  <File size={11} />
                                  <span className="task-runs-file-name">{file.name}</span>
                                  <span className="task-runs-file-size">{formatSize(file.size)}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {!selectedFile && !editingNew && queueFiles.length === 0 && runs.length === 0 && (
            <div className="task-queue-empty-state">
              <ListOrdered size={28} />
              <p>Define batch tasks as YAML</p>
              <p className="task-queue-empty-hint">Each task spawns a Claude session. Ask the assistant on the right for help.</p>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="task-queue-divider" onMouseDown={handleDragStart} />

        {/* Right: CLI assistant or file preview */}
        <div className="task-queue-right" style={{ width: `${100 - dividerX}%` }}>
          {previewFile ? (
            <>
              <div className="task-queue-term-header">
                <File size={12} />
                <span title={previewFile.path}>{previewFile.name}</span>
                <button className="task-queue-term-new" onClick={() => setPreviewFile(null)} title="Back to Task Assistant">
                  Back
                </button>
              </div>
              <div className="task-runs-preview">
                <pre className="task-runs-preview-code">
                  {previewFile.content.split('\n').map((line, i) => (
                    <div key={i} className="task-runs-preview-line">
                      <span className="task-runs-preview-num">{i + 1}</span>
                      <span>{line}</span>
                    </div>
                  ))}
                </pre>
              </div>
            </>
          ) : (
            <>
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
            </>
          )}
        </div>
      </div>

      {/* Convert to Pipeline Modal */}
      {showConvertModal && (() => {
        const queue = parseQueue(editor)
        return (
          <div className="convert-pipeline-overlay" onClick={() => setShowConvertModal(false)}>
            <div className="convert-pipeline-modal" onClick={(e) => e.stopPropagation()}>
              {!convertResult ? (
                <>
                  <div className="convert-pipeline-header">
                    <Zap size={16} />
                    <h3>Convert to Pipeline</h3>
                  </div>

                  <p className="convert-pipeline-desc">
                    {queue ? `${queue.tasks.length} task${queue.tasks.length !== 1 ? 's' : ''}` : 'Tasks'} from <strong>{queue?.name || 'queue'}</strong> will be saved as pipeline{queue && queue.tasks.length !== 1 ? 's' : ''} (disabled).
                  </p>

                  {queue && (
                    <div className="convert-pipeline-tasks">
                      {queue.tasks.map((t, i) => (
                        <div key={i} className="convert-pipeline-task">
                          <Zap size={11} />
                          <input
                            className="convert-pipeline-task-input"
                            value={convertNames[i] || ''}
                            onChange={(e) => {
                              const next = [...convertNames]
                              next[i] = e.target.value
                              setConvertNames(next)
                            }}
                            placeholder={`Task ${i + 1}`}
                          />
                          <span className="convert-pipeline-task-prompt">{t.prompt.slice(0, 40)}…</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="convert-pipeline-field">
                    <label>Mode</label>
                    <div className="convert-pipeline-mode-toggle">
                      <button
                        className={convertMode === 'reference' ? 'active' : ''}
                        onClick={() => setConvertMode('reference')}
                      >
                        Reference
                      </button>
                      <button
                        className={convertMode === 'copy' ? 'active' : ''}
                        onClick={() => setConvertMode('copy')}
                      >
                        Copy
                      </button>
                    </div>
                    <span className="convert-pipeline-hint">
                      {convertMode === 'reference'
                        ? 'Pipeline reads the task queue file at runtime — edits to the task automatically apply'
                        : 'Pipeline gets its own copy of the prompt — independent of the task queue'}
                    </span>
                  </div>

                  <div className="convert-pipeline-field">
                    <label>Cron Schedule</label>
                    <input
                      value={convertCron}
                      onChange={(e) => setConvertCron(e.target.value)}
                      placeholder="0 9 * * 1-5"
                      spellCheck={false}
                    />
                    <span className="convert-pipeline-hint">min hour dom month dow — e.g. "0 9 * * 1-5" = 9am weekdays</span>
                  </div>

                  <div className="convert-pipeline-field">
                    <label className="convert-pipeline-checkbox">
                      <input type="checkbox" checked={convertReuse} onChange={(e) => setConvertReuse(e.target.checked)} />
                      Reuse existing sessions when possible
                    </label>
                  </div>

                  <div className="convert-pipeline-actions">
                    <button className="convert-pipeline-cancel" onClick={() => setShowConvertModal(false)}>Cancel</button>
                    <button className="convert-pipeline-confirm" onClick={handleConvertConfirm}>
                      <Zap size={12} /> Create Pipeline{queue && queue.tasks.length !== 1 ? 's' : ''}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="convert-pipeline-header">
                    <CheckCircle size={16} />
                    <h3>Pipelines Created</h3>
                  </div>

                  <div className="convert-pipeline-result">
                    <p>{convertResult.count} pipeline{convertResult.count !== 1 ? 's' : ''} created (disabled):</p>
                    <ul>
                      {convertResult.names.map((n, i) => (
                        <li key={i}><Zap size={11} /> {n}</li>
                      ))}
                    </ul>
                    <p className="convert-pipeline-hint">Go to the <strong>Pipelines</strong> tab to enable them.</p>
                  </div>

                  <div className="convert-pipeline-actions">
                    <button className="convert-pipeline-confirm" onClick={() => setShowConvertModal(false)}>Done</button>
                  </div>
                </>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
