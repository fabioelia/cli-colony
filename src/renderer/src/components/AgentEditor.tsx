import { useEffect, useRef, useState, useCallback } from 'react'
import { sendPromptWhenReady } from '../lib/send-prompt-when-ready'
import { RefreshCw, ArrowLeft } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { AgentDef, ClaudeInstance } from '../types'
import { shouldSyncClaudeSlashCommands } from '../lib/claude-slash-sync'

interface Props {
  agent: AgentDef
  onBack: () => void
  onSave: () => void
  onInstanceCreated?: (instanceId: string) => void
}

export default function AgentEditor({ agent, onBack, onSave, onInstanceCreated }: Props) {
  const [content, setContent] = useState('')
  const [originalContent, setOriginalContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [instance, setInstance] = useState<ClaudeInstance | null>(null)
  const termContainerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<{ term: Terminal; fitAddon: FitAddon; unsub?: () => void } | null>(null)
  const [dividerX, setDividerX] = useState(50) // percentage
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Load file content
  useEffect(() => {
    window.api.agents.read(agent.filePath).then((text) => {
      if (text !== null) {
        setContent(text)
        setOriginalContent(text)
      }
    })
  }, [agent.filePath])

  const [colonyCtx, setColonyCtx] = useState('')
  useEffect(() => { window.api.colony.getContextInstruction().then(setColonyCtx) }, [])

  // Spawn a claude instance for this agent edit session (guard against StrictMode double-fire)
  const spawnedRef = useRef(false)
  const instanceIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (spawnedRef.current) return
    spawnedRef.current = true

    const agentDir = agent.filePath.replace(/\/[^/]+$/, '')
    window.api.instance.create({
      name: `Edit: ${agent.name}`,
      workingDirectory: agentDir,
      color: '#6366f1',
    }).then((inst) => {
      setInstance(inst)
      instanceIdRef.current = inst.id
      onInstanceCreated?.(inst.id)

      // Prime the instance with context about the agent file
      const prompt = `You are helping the user build and refine the Claude Code agent definition at ${agent.filePath}. Read that file now. Your job is to help them:\n- Write a clear, effective system prompt\n- Choose the right tools and model\n- Test and iterate on the agent's behavior\n\nThe agent file uses markdown frontmatter (name, description, tools, model, color) followed by the system prompt body.${colonyCtx}\n\nStart by reading the file and suggesting improvements or asking what the user wants this agent to do.`

      // Wait for Claude to be ready, then set name and send the prompt
      sendPromptWhenReady(inst.id, {
        onReady: () => {
          const sessionName = `Edit: ${agent.name}`
          void (async () => {
            await window.api.instance.rename(inst.id, sessionName)
            if (await shouldSyncClaudeSlashCommands()) {
              await window.api.instance.write(inst.id, `/rename ${sessionName}\r`)
              await new Promise((r) => setTimeout(r, 300))
            }
            window.api.instance.write(inst.id, prompt)
            setTimeout(() => window.api.instance.write(inst.id, '\r'), 150)
          })()
        },
      })
    })

    return () => {
      if (instanceIdRef.current) {
        window.api.instance.kill(instanceIdRef.current)
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Setup terminal when instance is ready and container is mounted
  useEffect(() => {
    if (!instance || !termContainerRef.current || termRef.current) return

    const term = new Terminal({
      theme: {
        background: '#000000',
        foreground: '#e0e0e0',
        cursor: '#e0e0e0',
        selectionBackground: '#3b82f650',
      },
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon((_event, uri) => {
      window.api.shell.openExternal(uri)
    }))

    term.onData((data) => {
      window.api.instance.write(instance.id, data)
    })

    // Queue live events until the buffer replay finishes, then drain.
    // Without this, output arriving between subscribing and the buffer
    // resolving would be written twice (once live, once in the buffer).
    let queue: string[] | null = []
    const unsub = window.api.instance.onOutput(({ id, data }) => {
      if (id === instance.id) {
        if (queue) {
          queue.push(data)
        } else {
          term.write(data)
        }
      }
    })

    termRef.current = { term, fitAddon, unsub }

    term.open(termContainerRef.current)

    // Replay buffer then drain queued live events
    window.api.instance.buffer(instance.id).then((buf) => {
      if (buf) term.write(buf)
      const pending = queue!
      queue = null
      for (const chunk of pending) term.write(chunk)
    })

    requestAnimationFrame(() => {
      fitAddon.fit()
      const dims = fitAddon.proposeDimensions()
      if (dims) {
        window.api.instance.resize(instance.id, dims.cols, dims.rows)
      }
    })

    const observer = new ResizeObserver(() => {
      fitAddon.fit()
      const dims = fitAddon.proposeDimensions()
      if (dims && instance) {
        window.api.instance.resize(instance.id, dims.cols, dims.rows)
      }
    })
    observer.observe(termContainerRef.current)

    return () => {
      observer.disconnect()
      unsub()
    }
  }, [instance])

  const reloadFile = useCallback(() => {
    window.api.agents.read(agent.filePath).then((text) => {
      if (text !== null) {
        setContent(text)
        setOriginalContent(text)
      }
    })
  }, [agent.filePath])

  // Auto-reload file when CLI finishes (busy → waiting)
  useEffect(() => {
    if (!instance) return
    let wasBusy = false
    const unsub = window.api.instance.onActivity(({ id, activity }) => {
      if (id !== instance.id) return
      if (activity === 'busy') wasBusy = true
      if (activity === 'waiting' && wasBusy) {
        wasBusy = false
        reloadFile()
      }
    })
    return unsub
  }, [instance, reloadFile])

  const handleSave = useCallback(async () => {
    setSaving(true)
    const ok = await window.api.agents.write(agent.filePath, content)
    setSaving(false)
    if (ok) {
      setOriginalContent(content)
      onSave()
    }
  }, [agent.filePath, content, onSave])

  const isDirty = content !== originalContent

  // Drag to resize
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startPct = dividerX
    const container = (e.target as HTMLElement).parentElement!

    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX
      const containerWidth = container.getBoundingClientRect().width
      const newPct = Math.max(20, Math.min(80, startPct + (delta / containerWidth) * 100))
      setDividerX(newPct)
    }

    const onUp = () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      // Re-fit terminal after resize
      termRef.current?.fitAddon.fit()
      if (instance) {
        const dims = termRef.current?.fitAddon.proposeDimensions()
        if (dims) window.api.instance.resize(instance.id, dims.cols, dims.rows)
      }
    }

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }, [dividerX, instance])

  // Keyboard shortcut: Cmd+S to save (only when textarea is focused)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        // Only save if the textarea has focus
        if (textareaRef.current && document.activeElement === textareaRef.current) {
          e.preventDefault()
          if (isDirty) handleSave()
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [isDirty, handleSave])

  return (
    <div className="agent-editor">
      <div className="agent-editor-header">
        <div className="agent-editor-header-left">
          <button className="agent-editor-back" onClick={onBack} title="Back"><ArrowLeft size={14} /></button>
          <span className="agent-editor-title">{agent.name}</span>
          <span className="agent-editor-path">{agent.filePath}</span>
        </div>
        <div className="agent-editor-header-right">
          <button
            className="agent-editor-reload"
            onClick={reloadFile}
            title="Reload file from disk"
          >
            <RefreshCw size={13} />
          </button>
          {isDirty && <span className="agent-editor-dirty">unsaved</span>}
          <button
            className="agent-editor-save"
            onClick={handleSave}
            disabled={!isDirty || saving}
            title="Save changes"
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
        </div>
      </div>
      <div className="agent-editor-split">
        <div className="agent-editor-file" style={{ width: `${dividerX}%` }}>
          <textarea
            ref={textareaRef}
            className="agent-editor-textarea"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="agent-editor-divider" onMouseDown={handleDragStart} />
        <div className="agent-editor-terminal" style={{ width: `${100 - dividerX}%` }}>
          <div className="agent-editor-term-container" ref={termContainerRef} />
        </div>
      </div>
    </div>
  )
}
