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
  outputs?: string
}

interface QueueDef {
  name: string
  mode: 'parallel' | 'sequential'
  outputs?: string
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

interface RunFile { name: string; path: string; size: number }
interface RunTask { name: string; path: string; files: RunFile[] }
interface RunQueue { name: string; path: string; tasks: RunTask[] }

interface Props {
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
}

function parseQueue(content: string): QueueDef | null {
  try {
    const lines = content.split('\n')
    let name = 'Untitled Queue'
    let mode: 'parallel' | 'sequential' = 'parallel'
    let outputs: string | undefined
    const tasks: TaskDef[] = []
    let inTasks = false
    let currentTask: Partial<TaskDef> | null = null

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue

      if (trimmed.startsWith('name:') && !inTasks) {
        name = trimmed.slice(5).trim().replace(/^["']|["']$/g, '')
      } else if (trimmed.startsWith('mode:')) {
        const m = trimmed.slice(5).trim().toLowerCase()
        mode = m === 'sequential' ? 'sequential' : 'parallel'
      } else if (trimmed.startsWith('outputs:') && !inTasks) {
        outputs = trimmed.slice(8).trim().replace(/^["']|["']$/g, '')
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
        } else if (trimmed.startsWith('outputs:') && currentTask) {
          currentTask.outputs = trimmed.slice(8).trim().replace(/^["']|["']$/g, '')
        }
      }
    }
    if (currentTask?.prompt) tasks.push(currentTask as TaskDef)
    if (tasks.length === 0) return null
    return { name, mode, outputs, tasks }
  } catch {
    return null
  }
}

const TEMPLATE = `name: My Task Batch
mode: parallel
outputs: "~/.claude-colony/outputs/my-task-batch"
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
  const [editorTab, setEditorTab] = useState<'yaml' | 'memory' | 'outputs'>('yaml')
  const [taskMemory, setTaskMemory] = useState('')
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [taskOutputs, setTaskOutputs] = useState<Array<{ name: string; path: string; size: number; modified: number }>>([])
  const [taskOutputPreview, setTaskOutputPreview] = useState<{ name: string; content: string } | null>(null)

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

  // Right panel mode
  const [rightPanel, setRightPanel] = useState<'assistant' | 'preview'>('assistant')
  const [previewContent, setPreviewContent] = useState<{ name: string; content: string } | null>(null)

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

  const TASK_PROMPT = `You are helping the user create and manage task queue YAML files for Claude Colony. Task queues define batch jobs that spawn multiple Claude sessions. The format is:\n\n\`\`\`yaml\nname: Queue Name\nmode: parallel  # or sequential\noutputs: "~/.claude-colony/outputs/my-queue"\ntasks:\n  - prompt: "What to do"\n    directory: /path/to/project\n    name: Task Name\n\`\`\`\n\nTask queue files are stored in ~/.claude-colony/task-queues/. Help the user design task queues, suggest tasks based on their projects, and write YAML files.${colonyContextInstruction}\n\nAsk what they want to accomplish.`

  // Robust prompt sender
  const sendPromptWhenReady = useCallback((id: string, prompt: string, sessionName?: string): Promise<void> => {
    return new Promise((resolve) => {
      let sent = false
      let waitCount = 0
      const unsub = window.api.instance.onActivity(({ id: instId, activity }) => {
        if (instId !== id || sent) return
        if (activity === 'waiting') {
          waitCount++
          if (waitCount === 1) {
            window.api.instance.write(id, '\r')
          } else {
            sent = true
            unsub()
            window.api.instance.write(id, prompt + '\r')
            if (sessionName) setTimeout(() => window.api.instance.rename(id, sessionName), 2000)
            resolve()
          }
        }
      })
      setTimeout(() => { if (!sent && waitCount >= 1) { sent = true; unsub(); window.api.instance.write(id, prompt + '\r'); resolve() } }, 5000)
      setTimeout(() => { if (!sent) { unsub(); resolve() } }, 15000)
    })
  }, [])

  const spawnAssistant = useCallback(async () => {
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
      fontSize: 13, lineHeight: 1.2, cursorBlink: false, cursorStyle: 'underline',
      cursorWidth: 1, cursorInactiveStyle: 'none', scrollback: 10000, allowProposedApi: true,
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
    window.api.instance.buffer(assistantInstance.id).then((buf) => { if (buf) term.write(buf) })
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

  // ---- Handlers ----

  const handleSelectFile = useCallback(async (file: QueueFile) => {
    setSelectedFile(file.name)
    setEditor(file.content)
    setEditingNew(false)
    setEditorTab('yaml')
    const mem = await window.api.taskQueue.getMemory(file.name)
    setTaskMemory(mem || '')
    setMemoryDirty(false)
    setTaskOutputs([])
    setTaskOutputPreview(null)
    const q = parseQueue(file.content)
    if (q?.outputs) {
      const files = await window.api.pipeline.listOutputs(q.outputs)
      setTaskOutputs(files)
    }
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
    setEditorTab('yaml')
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
    const pipelineName = convertNames[0] || queue.name
    const safeName = pipelineName.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '-').toLowerCase()
    const fileName = `${safeName}.yaml`
    const queueFile = selectedFile || 'unknown.yaml'
    const taskList = queue.tasks.map((t, i) => `  ${i + 1}. ${t.name || `Task ${i + 1}`}`).join('\n')

    const yaml = `name: ${pipelineName}
description: Runs task queue "${queue.name}" on schedule
enabled: false

trigger:
  type: cron
  cron: "${convertCron}"

condition:
  type: always

action:
  type: launch-session
  ${convertReuse ? 'reuse: true' : '# reuse: false'}
  name: "${pipelineName}"
  color: "#8b5cf6"
  prompt: |
    Run the task queue defined in ~/.claude-colony/task-queues/${queueFile}

    The queue "${queue.name}" contains ${queue.tasks.length} task${queue.tasks.length !== 1 ? 's' : ''} in ${queue.mode} mode:
${taskList}

    Read the file, then execute each task according to the queue definition.
    For each task, follow the prompt exactly as written.
    ${queue.outputs ? `Write outputs to: ${queue.outputs}` : ''}

dedup:
  key: "${safeName}"
  ttl: 3600
`
    await window.api.pipeline.saveContent(fileName, yaml)
    await window.api.pipeline.reload()
    setConvertResult({ count: 1, names: [pipelineName] })
  }, [editor, convertCron, convertReuse, convertNames, selectedFile])

  const handleRun = useCallback(async () => {
    const queue = parseQueue(editor)
    if (!queue) return
    setRunningQueue(queue)
    setIsRunning(true)
    setShowResults(true)
    stopRef.current = false

    const statuses: TaskStatus[] = queue.tasks.map((_, i) => ({ index: i, instanceId: null, state: 'running' as const, exitCode: null }))
    setTaskStatuses([...statuses])

    // Build combined prompt — one session handles all tasks
    const taskDescriptions = queue.tasks.map((task, i) => {
      const label = task.name || `Task ${i + 1}`
      const dir = task.directory ? `\n   Working directory: ${task.directory}` : ''
      return `### ${i + 1}. ${label}${dir}\n${task.prompt}`
    }).join('\n\n')

    const modeInstruction = queue.mode === 'parallel'
      ? 'Execute ALL tasks. You may work on them in whatever order is most efficient, or interleave work across them.'
      : 'Execute each task IN ORDER. Complete one fully before starting the next.'

    let combinedPrompt = `You have ${queue.tasks.length} task${queue.tasks.length !== 1 ? 's' : ''} to execute (${queue.mode} mode).\n\n${modeInstruction}\n\n${taskDescriptions}`

    // Add outputs dir
    const outputsDir = queue.outputs
    if (outputsDir) {
      const resolved = outputsDir.replace(/^~/, process.env.HOME || '~')
      combinedPrompt += `\n\nWrite any output files to: ${resolved}\nCreate the directory if it doesn't exist: mkdir -p ${resolved}`
    }

    // Add memory
    const memoryFileName = selectedFile?.replace(/\.(yaml|yml)$/, '')
    if (selectedFile) {
      const memory = await window.api.taskQueue.getMemory(selectedFile)
      const memPath = `~/.claude-colony/task-queues/${memoryFileName}-memory.md`
      if (memory?.trim()) {
        combinedPrompt += `\n\n--- Task Memory ---\nLearnings from previous runs:\n\n${memory}\n\nWhen you finish, if you learned anything new, append it to ${memPath}`
      } else {
        combinedPrompt += `\n\nWhen you finish, if you learned anything useful, write it to ${memPath}`
      }
    }

    try {
      const dir = queue.tasks[0]?.directory || workspacePath || undefined
      const inst = await window.api.instance.create({
        name: queue.name,
        workingDirectory: dir,
        args: ['--append-system-prompt', combinedPrompt],
      })

      // All tasks share this session
      for (const s of statuses) s.instanceId = inst.id
      setTaskStatuses([...statuses])

      // Send trigger
      await sendPromptWhenReady(inst.id, 'Execute the tasks defined in your system prompt. Begin now.')

      // Wait for session to exit
      await new Promise<void>((resolve) => {
        const unsub = window.api.instance.onExited(({ id, exitCode }) => {
          if (id !== inst.id) return; unsub()
          for (const s of statuses) {
            s.exitCode = exitCode
            s.state = exitCode === 0 ? 'done' : 'failed'
          }
          setTaskStatuses([...statuses])
          resolve()
        })
      })
    } catch {
      for (const s of statuses) s.state = 'failed'
      setTaskStatuses([...statuses])
    }

    setIsRunning(false)
  }, [editor, workspacePath, sendPromptWhenReady, selectedFile])

  const handleStop = useCallback(() => {
    stopRef.current = true
    // Kill the single session
    const id = taskStatuses.find(s => s.instanceId)?.instanceId
    if (id) window.api.instance.kill(id)
    setIsRunning(false)
  }, [taskStatuses])

  const handlePreviewFile = async (filePath: string, fileName: string) => {
    const result = await window.api.fs.readFile(filePath)
    if (result.content !== undefined) {
      setPreviewContent({ name: fileName, content: result.content })
      setRightPanel('preview')
    }
  }

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
        {/* Left panel */}
        <div className="task-queue-left" style={{ width: `${dividerX}%` }}>
          {/* Header */}
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

          {/* Editor area */}
          {(selectedFile || editingNew) && (
            <div className="task-queue-editor">
              {editingNew && (
                <div className="task-queue-editor-name">
                  <input placeholder="queue-name.yaml" value={newFileName} onChange={(e) => setNewFileName(e.target.value)} autoFocus />
                </div>
              )}

              {/* Tabs + actions bar */}
              <div className="task-queue-toolbar">
                {!editingNew && selectedFile && (
                  <div className="task-queue-editor-tabs">
                    <button className={`task-queue-tab ${editorTab === 'yaml' ? 'active' : ''}`} onClick={() => setEditorTab('yaml')}>
                      <FileText size={11} /> Config
                    </button>
                    <button className={`task-queue-tab ${editorTab === 'memory' ? 'active' : ''}`} onClick={() => setEditorTab('memory')}>
                      <Zap size={11} /> Memory
                    </button>
                    {parsed?.outputs && (
                      <button className={`task-queue-tab ${editorTab === 'outputs' ? 'active' : ''}`} onClick={() => setEditorTab('outputs')}>
                        <FolderOpen size={11} /> Outputs {taskOutputs.length > 0 && `(${taskOutputs.length})`}
                      </button>
                    )}
                  </div>
                )}
                <div className="task-queue-toolbar-actions">
                  {editorTab === 'yaml' && <button className="task-queue-save-btn" onClick={handleSave} title="Save"><Save size={11} /> Save</button>}
                  {editorTab === 'memory' && memoryDirty && <button className="task-queue-save-btn" onClick={handleSaveMemory} title="Save Memory"><Save size={11} /> Save</button>}
                  {parsed && !isRunning && editorTab === 'yaml' && (
                    <>
                      <button className="task-queue-run-btn" onClick={handleRun} title="Run all tasks"><Play size={11} /> Run</button>
                      <button className="task-queue-pipeline-btn" onClick={handleOpenConvertModal} title="Convert to pipeline"><Zap size={11} /> Pipeline</button>
                    </>
                  )}
                  {isRunning && <button className="task-queue-stop-btn" onClick={handleStop} title="Stop"><Square size={11} /> Stop</button>}
                </div>
              </div>

              {/* Parse info */}
              {editorTab === 'yaml' && (
                <div className="task-queue-editor-info">
                  {parsed ? (
                    <>
                      <span className="task-queue-parse-ok"><CheckCircle size={10} /> {parsed.tasks.length} task{parsed.tasks.length !== 1 ? 's' : ''}</span>
                      <span className="task-queue-parse-mode">{parsed.mode === 'parallel' ? <Layers size={10} /> : <ListOrdered size={10} />} {parsed.mode}</span>
                    </>
                  ) : editor.trim() ? (
                    <span className="task-queue-parse-err"><XCircle size={10} /> Invalid YAML format</span>
                  ) : null}
                </div>
              )}

              {/* Content area */}
              <div className="task-queue-content-area">
                {editorTab === 'yaml' || editingNew ? (
                  <textarea className="task-queue-textarea" value={editor} onChange={(e) => setEditor(e.target.value)} spellCheck={false} />
                ) : editorTab === 'outputs' ? (
                  <div className="task-queue-outputs">
                    {taskOutputs.length === 0 ? (
                      <p className="task-queue-empty-hint">No output files yet. Run the task to generate artifacts.</p>
                    ) : (
                      <div className="pipeline-output-list">
                        {taskOutputs.map((f) => (
                          <div key={f.path} className="pipeline-output-file" onClick={() => handlePreviewFile(f.path, f.name)}>
                            <File size={11} />
                            <span className="pipeline-output-file-name">{f.name}</span>
                            <span className="pipeline-output-file-meta">
                              {f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`}
                              {' · '}
                              {new Date(f.modified).toLocaleDateString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <textarea
                    className="task-queue-textarea"
                    value={taskMemory}
                    onChange={(e) => { setTaskMemory(e.target.value); setMemoryDirty(true) }}
                    placeholder="No memories yet. Learnings from runs will appear here, or add them manually."
                    spellCheck={false}
                  />
                )}
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
                    {doneCount}/{totalCount} done{failedCount > 0 && <span className="task-queue-results-failed"> · {failedCount} failed</span>}
                  </span>
                )}
                {isRunning && <Loader size={12} className="spinning" />}
              </div>
              {taskStatuses.map((s) => {
                const task = runningQueue.tasks[s.index]
                return (
                  <div key={s.index} className={`task-queue-result-item ${s.state}`}>
                    <span className="task-queue-result-icon">
                      {s.state === 'pending' && <Clock size={11} />}
                      {s.state === 'running' && <Loader size={11} className="spinning" />}
                      {s.state === 'done' && <CheckCircle size={11} />}
                      {s.state === 'failed' && <XCircle size={11} />}
                    </span>
                    <span className="task-queue-result-name">{task.name || `Task ${s.index + 1}`}</span>
                    {s.instanceId && <button className="task-queue-result-focus" onClick={() => onFocusInstance(s.instanceId!)} title="Focus session">View</button>}
                  </div>
                )
              })}
            </div>
          )}

          {/* Empty state */}
          {!selectedFile && !editingNew && queueFiles.length === 0 && (
            <div className="task-queue-empty-state">
              <ListOrdered size={28} />
              <p>Define batch tasks as YAML</p>
              <p className="task-queue-empty-hint">Each task spawns a Claude session. Use the assistant on the right for help.</p>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="task-queue-divider" onMouseDown={handleDragStart} />

        {/* Right panel */}
        <div className="task-queue-right" style={{ width: `${100 - dividerX}%` }}>
          {rightPanel === 'preview' && previewContent ? (
            <>
              <div className="task-queue-term-header">
                <File size={12} />
                <span title={previewContent.name}>{previewContent.name}</span>
                <button className="task-queue-term-new" onClick={() => { setRightPanel('assistant'); setPreviewContent(null) }}>
                  Back
                </button>
              </div>
              <div className="task-runs-preview">
                <pre className="task-runs-preview-code">
                  {previewContent.content.split('\n').map((line, i) => (
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
                <button className="task-queue-term-new" onClick={() => spawnAssistant()} title="Start a fresh Task Assistant session">
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
                    Creates a pipeline that references <strong>{queue?.name || 'this queue'}</strong> ({queue?.tasks.length} task{queue && queue.tasks.length !== 1 ? 's' : ''}, {queue?.mode}). Edits to the task queue apply automatically.
                  </p>

                  {queue && (
                    <div className="convert-pipeline-tasks">
                      {queue.tasks.map((t, i) => (
                        <div key={i} className="convert-pipeline-task">
                          <CheckCircle size={10} />
                          <span className="convert-pipeline-task-name">{t.name || `Task ${i + 1}`}</span>
                          <span className="convert-pipeline-task-prompt">{t.prompt.slice(0, 50)}…</span>
                        </div>
                      ))}
                    </div>
                  )}

                  <div className="convert-pipeline-field">
                    <label>Pipeline Name</label>
                    <input
                      value={convertNames[0] || ''}
                      onChange={(e) => setConvertNames([e.target.value])}
                      placeholder={queue?.name || 'Pipeline name'}
                      spellCheck={false}
                    />
                  </div>
                  <div className="convert-pipeline-field">
                    <label>Cron Schedule</label>
                    <input value={convertCron} onChange={(e) => setConvertCron(e.target.value)} placeholder="0 9 * * 1-5" spellCheck={false} />
                    <span className="convert-pipeline-hint">min hour dom month dow — e.g. "0 9 * * 1-5" = 9am weekdays</span>
                  </div>
                  <div className="convert-pipeline-field">
                    <label className="convert-pipeline-checkbox">
                      <input type="checkbox" checked={convertReuse} onChange={(e) => setConvertReuse(e.target.checked)} />
                      Reuse existing sessions
                    </label>
                  </div>
                  <div className="convert-pipeline-actions">
                    <button className="convert-pipeline-cancel" onClick={() => setShowConvertModal(false)}>Cancel</button>
                    <button className="convert-pipeline-confirm" onClick={handleConvertConfirm}>
                      <Zap size={12} /> Create Pipeline
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
                      {convertResult.names.map((n, i) => (<li key={i}><Zap size={11} /> {n}</li>))}
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
