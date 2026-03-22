import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Plus, Trash2, Play, Square, ChevronDown, ChevronRight,
  Save, FileText, CheckCircle, XCircle, Loader, Clock, ListOrdered, Layers
} from 'lucide-react'
import type { ClaudeInstance } from '../types'

/**
 * Task definition parsed from YAML-like format:
 * ```yaml
 * name: My batch
 * mode: parallel | sequential
 * tasks:
 *   - prompt: "do something"
 *     directory: /path/to/project
 *     name: Task 1
 * ```
 */

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
    // Simple YAML-like parser
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

function serializeQueue(queue: QueueDef): string {
  const lines = [
    `name: ${queue.name}`,
    `mode: ${queue.mode}`,
    'tasks:',
  ]
  for (const task of queue.tasks) {
    lines.push(`  - prompt: "${task.prompt.replace(/"/g, '\\"')}"`)
    if (task.directory) lines.push(`    directory: ${task.directory}`)
    if (task.name) lines.push(`    name: ${task.name}`)
  }
  return lines.join('\n')
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

  // Running state
  const [runningQueue, setRunningQueue] = useState<QueueDef | null>(null)
  const [taskStatuses, setTaskStatuses] = useState<TaskStatus[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const stopRef = useRef(false)

  // Load queue files
  useEffect(() => {
    window.api.taskQueue.list().then(setQueueFiles)
  }, [])

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
    if (selectedFile === name) {
      setSelectedFile(null)
      setEditor('')
    }
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

    const statuses: TaskStatus[] = queue.tasks.map((_, i) => ({
      index: i,
      instanceId: null,
      state: 'pending',
      exitCode: null,
    }))
    setTaskStatuses([...statuses])

    const runTask = async (taskIndex: number): Promise<void> => {
      if (stopRef.current) return
      const task = queue.tasks[taskIndex]

      statuses[taskIndex].state = 'running'
      setTaskStatuses([...statuses])

      try {
        const inst = await window.api.instance.create({
          name: task.name || `Task ${taskIndex + 1}`,
          workingDirectory: task.directory || undefined,
        })
        statuses[taskIndex].instanceId = inst.id

        // Wait for Claude to be ready, then send the prompt
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
                window.api.instance.write(inst.id, task.prompt + '\r')
                resolve()
              }
            }
          })
          setTimeout(() => {
            if (!sent && waitCount >= 1) {
              sent = true
              unsub()
              window.api.instance.write(inst.id, task.prompt + '\r')
              resolve()
            }
          }, 5000)
          setTimeout(() => { if (!sent) { unsub(); resolve() } }, 15000)
        })

        // Wait for completion (exit)
        await new Promise<void>((resolve) => {
          const unsub = window.api.instance.onExited(({ id, exitCode }) => {
            if (id !== inst.id) return
            unsub()
            statuses[taskIndex].exitCode = exitCode
            statuses[taskIndex].state = exitCode === 0 ? 'done' : 'failed'
            setTaskStatuses([...statuses])
            resolve()
          })
        })
      } catch {
        statuses[taskIndex].state = 'failed'
        setTaskStatuses([...statuses])
      }
    }

    if (queue.mode === 'parallel') {
      await Promise.all(queue.tasks.map((_, i) => runTask(i)))
    } else {
      for (let i = 0; i < queue.tasks.length; i++) {
        if (stopRef.current) break
        await runTask(i)
      }
    }

    setIsRunning(false)
  }, [editor])

  const handleStop = useCallback(() => {
    stopRef.current = true
    // Kill all running tasks
    for (const s of taskStatuses) {
      if (s.state === 'running' && s.instanceId) {
        window.api.instance.kill(s.instanceId)
      }
    }
    setIsRunning(false)
  }, [taskStatuses])

  const parsed = parseQueue(editor)
  const doneCount = taskStatuses.filter((s) => s.state === 'done').length
  const failedCount = taskStatuses.filter((s) => s.state === 'failed').length
  const totalCount = taskStatuses.length

  return (
    <div className="task-queue-panel">
      <div className="task-queue-header">
        <h2>Task Queue</h2>
        <button className="task-queue-new-btn" onClick={handleNew} title="Create new queue">
          <Plus size={13} /> New Queue
        </button>
      </div>

      <div className="task-queue-body">
        {/* File list */}
        <div className="task-queue-files">
          {queueFiles.length === 0 && !editingNew && (
            <div className="task-queue-empty">
              No queues defined.
              <button onClick={handleNew} title="Create first queue">Create one</button>
            </div>
          )}
          {queueFiles.map((f) => (
            <div
              key={f.name}
              className={`task-queue-file ${selectedFile === f.name ? 'active' : ''}`}
              onClick={() => handleSelectFile(f)}
            >
              <FileText size={13} />
              <span>{f.name}</span>
              <button
                className="task-queue-file-delete"
                onClick={(e) => { e.stopPropagation(); handleDelete(f.name) }}
                title="Delete"
              >
                <Trash2 size={11} />
              </button>
            </div>
          ))}
        </div>

        {/* Editor */}
        {(selectedFile || editingNew) && (
          <div className="task-queue-editor">
            {editingNew && (
              <div className="task-queue-editor-name">
                <input
                  placeholder="queue-name.yaml"
                  value={newFileName}
                  onChange={(e) => setNewFileName(e.target.value)}
                  autoFocus
                />
              </div>
            )}
            <textarea
              className="task-queue-textarea"
              value={editor}
              onChange={(e) => setEditor(e.target.value)}
              spellCheck={false}
            />
            <div className="task-queue-editor-actions">
              <div className="task-queue-editor-info">
                {parsed ? (
                  <>
                    <span className="task-queue-parse-ok"><CheckCircle size={11} /> {parsed.tasks.length} task{parsed.tasks.length !== 1 ? 's' : ''}</span>
                    <span className="task-queue-parse-mode">
                      {parsed.mode === 'parallel' ? <Layers size={11} /> : <ListOrdered size={11} />}
                      {parsed.mode}
                    </span>
                  </>
                ) : (
                  <span className="task-queue-parse-err"><XCircle size={11} /> Invalid format</span>
                )}
              </div>
              <button className="task-queue-save-btn" onClick={handleSave} title="Save queue">
                <Save size={12} /> Save
              </button>
              {parsed && !isRunning && (
                <button className="task-queue-run-btn" onClick={handleRun} title="Run all tasks">
                  <Play size={12} /> Run
                </button>
              )}
              {isRunning && (
                <button className="task-queue-stop-btn" onClick={handleStop} title="Stop all tasks">
                  <Square size={12} /> Stop
                </button>
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
                  {doneCount}/{totalCount} passed
                  {failedCount > 0 && <span className="task-queue-results-failed"> | {failedCount} failed</span>}
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
                  {s.instanceId && (
                    <button
                      className="task-queue-result-focus"
                      onClick={() => onFocusInstance(s.instanceId!)}
                      title="Focus this session"
                    >
                      View
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
