import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Plus, Trash2, Play, Square, Save, FileText, CheckCircle, XCircle,
  Loader, Clock, ListOrdered, Layers, FolderOpen, File, Zap,
  MessageSquare, Send, ChevronDown, ChevronRight, Code, BookOpen
} from 'lucide-react'
import type { ClaudeInstance } from '../types'

interface TaskDef { prompt: string; directory?: string; name?: string }
interface QueueDef { name: string; mode: 'parallel' | 'sequential'; tasks: TaskDef[] }
interface TaskStatus { index: number; instanceId: string | null; state: 'pending' | 'running' | 'done' | 'failed'; exitCode: number | null }
interface QueueFile { name: string; path: string; content: string }

interface Props {
  instances: ClaudeInstance[]
  onFocusInstance: (id: string) => void
  onLaunchInstance: (opts: { name?: string; workingDirectory?: string; color?: string; args?: string[] }) => Promise<string>
}

function parseQueue(content: string): QueueDef | null {
  try {
    const lines = content.split('\n')
    let name = 'Untitled Queue'; let mode: 'parallel' | 'sequential' = 'parallel'
    const tasks: TaskDef[] = []; let inTasks = false; let currentTask: Partial<TaskDef> | null = null
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      if (trimmed.startsWith('name:') && !inTasks) { name = trimmed.slice(5).trim().replace(/^["']|["']$/g, '') }
      else if (trimmed.startsWith('mode:')) { mode = trimmed.slice(5).trim().toLowerCase() === 'sequential' ? 'sequential' : 'parallel' }
      else if (trimmed === 'tasks:') { inTasks = true }
      else if (inTasks) {
        if (trimmed.startsWith('- prompt:') || trimmed.startsWith('-prompt:')) {
          if (currentTask?.prompt) tasks.push(currentTask as TaskDef)
          currentTask = { prompt: trimmed.replace(/^-\s*prompt:\s*/, '').replace(/^["']|["']$/g, '') }
        } else if (trimmed.startsWith('directory:') && currentTask) { currentTask.directory = trimmed.slice(10).trim().replace(/^["']|["']$/g, '') }
        else if (trimmed.startsWith('name:') && currentTask) { currentTask.name = trimmed.slice(5).trim().replace(/^["']|["']$/g, '') }
      }
    }
    if (currentTask?.prompt) tasks.push(currentTask as TaskDef)
    if (tasks.length === 0) return null
    return { name, mode, tasks }
  } catch { return null }
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

const TASK_SYSTEM_PROMPT = `You are a Task Assistant for Claude Colony. You help users create and manage task queue YAML files.

Task queues define batch jobs that run in a single Claude session. The format is:

\`\`\`yaml
name: Queue Name
mode: parallel  # or sequential
tasks:
  - prompt: "What to do"
    directory: /path/to/project
    name: Task Name
\`\`\`

- **parallel**: Agent executes all tasks in whatever order is most efficient
- **sequential**: Agent executes tasks in order, completing one before starting the next
- Task queue files are stored in ~/.claude-colony/task-queues/
- Output directory is injected automatically at runtime (based on queue name) — task prompts should NOT hardcode file paths for outputs

Help the user design task queues, suggest tasks based on their projects, and write YAML files directly to ~/.claude-colony/task-queues/. Ask what they want to accomplish.`

export default function TaskQueuePanel({ instances, onFocusInstance, onLaunchInstance }: Props) {
  const [queueFiles, setQueueFiles] = useState<QueueFile[]>([])
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [editor, setEditor] = useState('')
  const [editingNew, setEditingNew] = useState(false)
  const [newFileName, setNewFileName] = useState('')
  const [editorTab, setEditorTab] = useState<'yaml' | 'memory' | 'outputs'>('yaml')
  const [taskMemory, setTaskMemory] = useState('')
  const [memoryDirty, setMemoryDirty] = useState(false)
  const [outputRuns, setOutputRuns] = useState<Array<{ name: string; path: string; files: Array<{ name: string; path: string; size: number }> }>>([])
  const [outputPreview, setOutputPreview] = useState<{ name: string; content: string } | null>(null)
  const [expandedRun, setExpandedRun] = useState<string | null>(null)
  const [outputViewMode, setOutputViewMode] = useState<'text' | 'markdown'>('markdown')

  const [runningQueue, setRunningQueue] = useState<QueueDef | null>(null)
  const [taskStatuses, setTaskStatuses] = useState<TaskStatus[]>([])
  const [isRunning, setIsRunning] = useState(false)
  const [showResults, setShowResults] = useState(false)
  const stopRef = useRef(false)

  const [showConvertModal, setShowConvertModal] = useState(false)
  const [convertCron, setConvertCron] = useState('0 9 * * 1-5')
  const [convertReuse, setConvertReuse] = useState(true)
  const [convertResult, setConvertResult] = useState<{ count: number; names: string[] } | null>(null)
  const [convertNames, setConvertNames] = useState<string[]>([])

  // Ask bar
  const [askInput, setAskInput] = useState('')
  const [assistantId, setAssistantId] = useState<string | null>(null)
  const [workspacePath, setWorkspacePath] = useState<string | null>(null)
  const sendingRef = useRef(false)

  useEffect(() => { window.api.taskQueue.list().then(setQueueFiles) }, [])
  useEffect(() => { window.api.taskQueue.getWorkspacePath().then(setWorkspacePath) }, [])

  useEffect(() => {
    if (assistantId && !instances.some(i => i.id === assistantId && i.status === 'running')) setAssistantId(null)
  }, [instances, assistantId])

  const sendPromptWhenReady = useCallback((id: string, prompt: string): Promise<void> => {
    return new Promise((resolve) => {
      let sent = false; let waitCount = 0
      const unsub = window.api.instance.onActivity(({ id: instId, activity }) => {
        if (instId !== id || sent) return
        if (activity === 'waiting') {
          waitCount++
          if (waitCount === 1) { window.api.instance.write(id, '\r') }
          else { sent = true; unsub(); window.api.instance.write(id, prompt + '\r'); resolve() }
        }
      })
      setTimeout(() => { if (!sent && waitCount >= 1) { sent = true; unsub(); window.api.instance.write(id, prompt + '\r'); resolve() } }, 5000)
      setTimeout(() => { if (!sent) { unsub(); resolve() } }, 15000)
    })
  }, [])

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
        name: 'Task Assistant',
        workingDirectory: workspacePath || undefined,
        color: '#f59e0b',
        args: ['--append-system-prompt', TASK_SYSTEM_PROMPT],
      })
      setAssistantId(id)
      // Send the user's question once ready
      let sent = false; let wc = 0
      const unsub = window.api.instance.onActivity(({ id: instId, activity }) => {
        if (instId !== id || sent) return
        if (activity === 'waiting') { wc++; if (wc === 1) window.api.instance.write(id, '\r'); else { sent = true; unsub(); window.api.instance.write(id, q + '\r') } }
      })
      setTimeout(() => { if (!sent && wc >= 1) { sent = true; unsub(); window.api.instance.write(id, q + '\r') } }, 5000)
      setTimeout(() => { if (!sent) unsub() }, 15000)
      onFocusInstance(id)
    } finally { sendingRef.current = false }
  }, [askInput, assistantId, instances, workspacePath, onLaunchInstance, onFocusInstance])

  // ---- File handlers ----

  const handleSelectFile = useCallback(async (file: QueueFile) => {
    setSelectedFile(file.name); setEditor(file.content); setEditingNew(false); setEditorTab('yaml')
    const mem = await window.api.taskQueue.getMemory(file.name)
    setTaskMemory(mem || ''); setMemoryDirty(false); setTaskOutputs([])

    // Load output runs — derived from file name (stable, not queue name which user can change)
    const baseName = file.name.replace(/\.(yaml|yml)$/, '')
    const runs = await window.api.taskQueue.listOutputRuns(`~/.claude-colony/outputs/${baseName}`)
    setOutputRuns(runs)
    if (runs.length > 0) setExpandedRun(runs[0].name)
  }, [])

  const handleSave = useCallback(async () => {
    const name = editingNew ? (newFileName.trim() || 'untitled.yaml') : selectedFile
    if (!name) return
    const fileName = name.endsWith('.yaml') || name.endsWith('.yml') ? name : `${name}.yaml`
    await window.api.taskQueue.save(fileName, editor)
    const files = await window.api.taskQueue.list(); setQueueFiles(files); setSelectedFile(fileName); setEditingNew(false)
  }, [editor, selectedFile, editingNew, newFileName])

  const handleDelete = useCallback(async (name: string) => {
    await window.api.taskQueue.delete(name)
    const files = await window.api.taskQueue.list(); setQueueFiles(files)
    if (selectedFile === name) { setSelectedFile(null); setEditor('') }
  }, [selectedFile])

  const handleNew = useCallback(() => { setEditingNew(true); setSelectedFile(null); setNewFileName(''); setEditor(TEMPLATE); setEditorTab('yaml') }, [])

  const handleSaveMemory = useCallback(async () => {
    if (!selectedFile) return
    await window.api.taskQueue.saveMemory(selectedFile, taskMemory); setMemoryDirty(false)
  }, [selectedFile, taskMemory])

  // ---- Run ----

  const handleRun = useCallback(async () => {
    const queue = parseQueue(editor)
    if (!queue) return
    setRunningQueue(queue); setIsRunning(true); setShowResults(true); stopRef.current = false
    const statuses: TaskStatus[] = queue.tasks.map((_, i) => ({ index: i, instanceId: null, state: 'running' as const, exitCode: null }))
    setTaskStatuses([...statuses])

    const taskDescriptions = queue.tasks.map((task, i) => {
      const label = task.name || `Task ${i + 1}`
      const dir = task.directory ? `\n   Working directory: ${task.directory}` : ''
      return `### ${i + 1}. ${label}${dir}\n${task.prompt}`
    }).join('\n\n')
    const modeInstruction = queue.mode === 'parallel'
      ? 'Execute ALL tasks in whatever order is most efficient.'
      : 'Execute each task IN ORDER. Complete one before starting the next.'
    // Inject output directory: outputs/<file-name>/<timestamp>/
    const baseName = selectedFile?.replace(/\.(yaml|yml)$/, '') || queue.name.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '-').toLowerCase()
    const now = new Date()
    const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}-${String(now.getHours()).padStart(2,'0')}${String(now.getMinutes()).padStart(2,'0')}`
    const outputDir = `~/.claude-colony/outputs/${baseName}/${ts}`
    let combinedPrompt = `You have ${queue.tasks.length} task${queue.tasks.length !== 1 ? 's' : ''} (${queue.mode}).\n\n${modeInstruction}\n\n${taskDescriptions}\n\n--- Output Directory ---\nWrite all output files to: ${outputDir}\nCreate it first: mkdir -p ${outputDir}\nDo NOT hardcode output paths from the task prompts — always use this directory.`
    const memFn = selectedFile?.replace(/\.(yaml|yml)$/, '')
    if (selectedFile) {
      const memory = await window.api.taskQueue.getMemory(selectedFile)
      const memPath = `~/.claude-colony/task-queues/${memFn}.memory.md`
      if (memory?.trim()) combinedPrompt += `\n\n--- Task Memory ---\n${memory}\n\nAppend new learnings to ${memPath}`
      else combinedPrompt += `\n\nWrite learnings to ${memPath}`
    }
    try {
      const dir = queue.tasks[0]?.directory || workspacePath || undefined
      const inst = await window.api.instance.create({ name: queue.name, workingDirectory: dir, args: ['--append-system-prompt', combinedPrompt] })
      for (const s of statuses) s.instanceId = inst.id
      setTaskStatuses([...statuses])
      await sendPromptWhenReady(inst.id, 'Execute the tasks in your system prompt. Begin now.')
      await new Promise<void>((resolve) => {
        const unsub = window.api.instance.onExited(({ id, exitCode }) => {
          if (id !== inst.id) return; unsub()
          for (const s of statuses) { s.exitCode = exitCode; s.state = exitCode === 0 ? 'done' : 'failed' }
          setTaskStatuses([...statuses]); resolve()
        })
      })
    } catch { for (const s of statuses) s.state = 'failed'; setTaskStatuses([...statuses]) }
    setIsRunning(false)
  }, [editor, workspacePath, sendPromptWhenReady, selectedFile])

  const handleStop = useCallback(() => {
    stopRef.current = true
    const id = taskStatuses.find(s => s.instanceId)?.instanceId
    if (id) window.api.instance.kill(id)
    setIsRunning(false)
  }, [taskStatuses])

  // ---- Convert to Pipeline ----

  const handleOpenConvertModal = useCallback(() => {
    const queue = parseQueue(editor); if (!queue) return
    setConvertCron('0 9 * * 1-5'); setConvertReuse(true); setConvertResult(null)
    setConvertNames([queue.name]); setShowConvertModal(true)
  }, [editor])

  const handleConvertConfirm = useCallback(async () => {
    const queue = parseQueue(editor); if (!queue) return
    const pipelineName = convertNames[0] || queue.name
    const safeName = pipelineName.replace(/[^a-zA-Z0-9_\- ]/g, '').trim().replace(/\s+/g, '-').toLowerCase()
    const taskList = queue.tasks.map((t, i) => `  ${i + 1}. ${t.name || `Task ${i + 1}`}`).join('\n')
    const yaml = `name: ${pipelineName}\ndescription: Runs task queue "${queue.name}" on schedule\nenabled: false\n\ntrigger:\n  type: cron\n  cron: "${convertCron}"\n\ncondition:\n  type: always\n\naction:\n  type: launch-session\n  ${convertReuse ? 'reuse: true' : '# reuse: false'}\n  name: "${pipelineName}"\n  color: "#8b5cf6"\n  prompt: |\n    Run the task queue defined in ~/.claude-colony/task-queues/${selectedFile || 'unknown.yaml'}\n\n    The queue "${queue.name}" contains ${queue.tasks.length} task${queue.tasks.length !== 1 ? 's' : ''} in ${queue.mode} mode:\n${taskList}\n\n    Read the file, then execute each task.\n    ${queue.outputs ? `Write outputs to: ${queue.outputs}` : ''}\n\ndedup:\n  key: "${safeName}"\n  ttl: 3600\n`
    await window.api.pipeline.saveContent(`${safeName}.yaml`, yaml)
    await window.api.pipeline.reload()
    setConvertResult({ count: 1, names: [pipelineName] })
  }, [editor, convertCron, convertReuse, convertNames, selectedFile])

  const parsed = parseQueue(editor)

  return (
    <div className="task-queue-panel">
      {/* Header */}
      <div className="task-queue-header">
        <h2>Tasks</h2>
        <button className="task-queue-new-btn" onClick={handleNew} title="Create new queue">
          <Plus size={13} /> New
        </button>
      </div>

      {/* Ask bar */}
      <div className="pipeline-ask-bar">
        <MessageSquare size={14} className="pipeline-ask-icon" />
        <input
          className="pipeline-ask-input"
          placeholder="Ask the Task Assistant to create or modify a task queue..."
          value={askInput}
          onChange={(e) => setAskInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAsk() } }}
        />
        <button className="pipeline-ask-send" onClick={handleAsk} disabled={!askInput.trim()} title="Send">
          <Send size={13} />
        </button>
        {assistantId && instances.some(i => i.id === assistantId && i.status === 'running') && (
          <button className="pipeline-ask-focus" onClick={() => onFocusInstance(assistantId!)} title="Focus session">View</button>
        )}
      </div>

      {/* File list */}
      <div className="task-queue-files">
        {queueFiles.map((f) => (
          <div key={f.name} className={`task-queue-file ${selectedFile === f.name ? 'active' : ''}`} onClick={() => handleSelectFile(f)}>
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

          {/* Toolbar */}
          <div className="task-queue-toolbar">
            {!editingNew && selectedFile && (
              <div className="task-queue-editor-tabs">
                <button className={`task-queue-tab ${editorTab === 'yaml' ? 'active' : ''}`} onClick={() => setEditorTab('yaml')}><FileText size={11} /> Config</button>
                <button className={`task-queue-tab ${editorTab === 'memory' ? 'active' : ''}`} onClick={() => setEditorTab('memory')}><Zap size={11} /> Memory</button>
                {outputRuns.length > 0 && (
                  <button className={`task-queue-tab ${editorTab === 'outputs' ? 'active' : ''}`} onClick={() => setEditorTab('outputs')}>
                    <FolderOpen size={11} /> Outputs ({outputRuns.reduce((n, r) => n + r.files.length, 0)})
                  </button>
                )}
              </div>
            )}
            <div className="task-queue-toolbar-actions">
              {editorTab === 'yaml' && <button className="task-queue-save-btn" onClick={handleSave}><Save size={11} /> Save</button>}
              {editorTab === 'memory' && memoryDirty && <button className="task-queue-save-btn" onClick={handleSaveMemory}><Save size={11} /> Save</button>}
              {parsed && !isRunning && editorTab === 'yaml' && (
                <>
                  <button className="task-queue-run-btn" onClick={handleRun}><Play size={11} /> Run</button>
                  <button className="task-queue-pipeline-btn" onClick={handleOpenConvertModal}><Zap size={11} /> Pipeline</button>
                </>
              )}
              {isRunning && <button className="task-queue-stop-btn" onClick={handleStop}><Square size={11} /> Stop</button>}
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
              ) : editor.trim() ? (<span className="task-queue-parse-err"><XCircle size={10} /> Invalid format</span>) : null}
            </div>
          )}

          {/* Content */}
          <div className="task-queue-content-area">
            {editorTab === 'yaml' || editingNew ? (
              <textarea className="task-queue-textarea" value={editor} onChange={(e) => setEditor(e.target.value)} spellCheck={false} />
            ) : editorTab === 'outputs' ? (
              <div className="task-outputs-split">
                {/* Run tree */}
                <div className="task-outputs-tree">
                  {outputRuns.map((run) => (
                    <div key={run.name} className="task-outputs-group">
                      <div
                        className={`task-outputs-date ${expandedRun === run.name ? 'expanded' : ''}`}
                        onClick={() => setExpandedRun(expandedRun === run.name ? null : run.name)}
                      >
                        {expandedRun === run.name ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                        <FolderOpen size={10} />
                        <span>{run.name === '_root' ? 'Legacy' : run.name}</span>
                        <span className="task-outputs-date-count">{run.files.length}</span>
                      </div>
                      {expandedRun === run.name && run.files.map((f) => (
                        <div
                          key={f.path}
                          className={`task-outputs-file ${outputPreview?.name === f.name ? 'active' : ''}`}
                          onClick={async () => {
                            const result = await window.api.fs.readFile(f.path)
                            if (result.content !== undefined) setOutputPreview({ name: f.name, content: result.content })
                          }}
                        >
                          <File size={10} />
                          <span className="task-outputs-file-name">{f.name}</span>
                          <span className="task-outputs-file-size">
                            {f.size < 1024 ? `${f.size}B` : `${(f.size / 1024).toFixed(1)}KB`}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
                {/* Preview */}
                <div className="task-outputs-preview">
                  {outputPreview ? (
                    <>
                      {outputPreview.name.endsWith('.md') && (
                        <div className="task-output-mode-toggle">
                          <button className={outputViewMode === 'markdown' ? 'active' : ''} onClick={() => setOutputViewMode('markdown')}>
                            <BookOpen size={10} /> Rendered
                          </button>
                          <button className={outputViewMode === 'text' ? 'active' : ''} onClick={() => setOutputViewMode('text')}>
                            <Code size={10} /> Source
                          </button>
                        </div>
                      )}
                      {outputViewMode === 'markdown' && outputPreview.name.endsWith('.md') ? (
                        <div className="task-output-markdown" dangerouslySetInnerHTML={{
                          __html: (() => {
                            let md = outputPreview.content
                              .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

                            // Parse tables: find consecutive lines starting with |
                            md = md.replace(/((?:^\|.+\|$\n?)+)/gm, (block) => {
                              const rows = block.trim().split('\n').filter(r => r.trim())
                              if (rows.length < 2) return block
                              const parseRow = (r: string) => r.split('|').slice(1, -1).map(c => c.trim())
                              const isSep = (r: string) => /^\|[\s\-:|]+\|$/.test(r.trim())
                              let html = '<table>'
                              let inBody = false
                              for (let i = 0; i < rows.length; i++) {
                                if (isSep(rows[i])) { inBody = true; continue }
                                const cells = parseRow(rows[i])
                                const tag = !inBody && i === 0 ? 'th' : 'td'
                                html += '<tr>' + cells.map(c => `<${tag}>${c}</${tag}>`).join('') + '</tr>'
                                if (i === 0 && (i + 1 >= rows.length || isSep(rows[i + 1]))) inBody = true
                              }
                              return html + '</table>'
                            })

                            return md
                              .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
                              .replace(/^### (.+)$/gm, '<h3>$1</h3>')
                              .replace(/^## (.+)$/gm, '<h2>$1</h2>')
                              .replace(/^# (.+)$/gm, '<h1>$1</h1>')
                              .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
                              .replace(/\*(.+?)\*/g, '<em>$1</em>')
                              .replace(/`([^`]+)`/g, '<code>$1</code>')
                              .replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>')
                              .replace(/^- \[x\] (.+)$/gm, '<div class="task-md-check checked">$1</div>')
                              .replace(/^- \[ \] (.+)$/gm, '<div class="task-md-check">$1</div>')
                              .replace(/^- (.+)$/gm, '<li>$1</li>')
                              .replace(/^\d+\. (.+)$/gm, '<li>$1</li>')
                              .replace(/^---$/gm, '<hr/>')
                              .replace(/\n\n/g, '</p><p>')
                              .replace(/\n/g, '<br/>')
                          })()
                        }} />
                      ) : (
                        <pre className="task-output-preview-code">
                          {outputPreview.content.split('\n').map((line, i) => (
                            <div key={i} className="task-output-preview-line">
                              <span className="task-output-preview-num">{i + 1}</span>
                              <span>{line}</span>
                            </div>
                          ))}
                        </pre>
                      )}
                    </>
                  ) : (
                    <div className="task-outputs-empty">
                      <File size={20} />
                      <span>Select a file to preview</span>
                    </div>
                  )}
                </div>
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
            {!isRunning && taskStatuses.length > 0 && (
              <span className="task-queue-results-summary">
                {taskStatuses.filter(s => s.state === 'done').length}/{taskStatuses.length} done
              </span>
            )}
            {isRunning && <Loader size={12} className="spinning" />}
          </div>
          {taskStatuses.map((s) => {
            const task = runningQueue.tasks[s.index]
            return (
              <div key={s.index} className={`task-queue-result-item ${s.state}`}>
                <span className="task-queue-result-icon">
                  {s.state === 'running' && <Loader size={11} className="spinning" />}
                  {s.state === 'done' && <CheckCircle size={11} />}
                  {s.state === 'failed' && <XCircle size={11} />}
                </span>
                <span className="task-queue-result-name">{task.name || `Task ${s.index + 1}`}</span>
                {s.instanceId && <button className="task-queue-result-focus" onClick={() => onFocusInstance(s.instanceId!)}>View</button>}
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
          <p className="task-queue-empty-hint">Use the prompt above to create task queues with the assistant.</p>
        </div>
      )}

      {/* Convert Modal */}
      {showConvertModal && (() => {
        const queue = parseQueue(editor)
        return (
          <div className="convert-pipeline-overlay" onClick={() => setShowConvertModal(false)}>
            <div className="convert-pipeline-modal" onClick={(e) => e.stopPropagation()}>
              {!convertResult ? (<>
                <div className="convert-pipeline-header"><Zap size={16} /><h3>Convert to Pipeline</h3></div>
                <p className="convert-pipeline-desc">Creates a pipeline that references <strong>{queue?.name}</strong> ({queue?.tasks.length} tasks, {queue?.mode}).</p>
                {queue && (<div className="convert-pipeline-tasks">{queue.tasks.map((t, i) => (
                  <div key={i} className="convert-pipeline-task"><CheckCircle size={10} /><span className="convert-pipeline-task-name">{t.name || `Task ${i+1}`}</span><span className="convert-pipeline-task-prompt">{t.prompt.slice(0,50)}…</span></div>
                ))}</div>)}
                <div className="convert-pipeline-field"><label>Pipeline Name</label><input value={convertNames[0]||''} onChange={(e) => setConvertNames([e.target.value])} placeholder={queue?.name} spellCheck={false} /></div>
                <div className="convert-pipeline-field"><label>Cron Schedule</label><input value={convertCron} onChange={(e) => setConvertCron(e.target.value)} placeholder="0 9 * * 1-5" spellCheck={false} /><span className="convert-pipeline-hint">min hour dom month dow</span></div>
                <div className="convert-pipeline-field"><label className="convert-pipeline-checkbox"><input type="checkbox" checked={convertReuse} onChange={(e) => setConvertReuse(e.target.checked)} /> Reuse existing sessions</label></div>
                <div className="convert-pipeline-actions"><button className="convert-pipeline-cancel" onClick={() => setShowConvertModal(false)}>Cancel</button><button className="convert-pipeline-confirm" onClick={handleConvertConfirm}><Zap size={12} /> Create Pipeline</button></div>
              </>) : (<>
                <div className="convert-pipeline-header"><CheckCircle size={16} /><h3>Pipeline Created</h3></div>
                <div className="convert-pipeline-result"><p>Created <strong>{convertResult.names[0]}</strong> (disabled)</p><p className="convert-pipeline-hint">Go to the <strong>Pipelines</strong> tab to enable it.</p></div>
                <div className="convert-pipeline-actions"><button className="convert-pipeline-confirm" onClick={() => setShowConvertModal(false)}>Done</button></div>
              </>)}
            </div>
          </div>
        )
      })()}
    </div>
  )
}
