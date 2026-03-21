import { useEffect, useRef, useCallback, useState, MutableRefObject } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { SearchAddon } from '@xterm/addon-search'
import { TerminalProxy } from '../lib/terminal-proxy'
import '@xterm/xterm/css/xterm.css'
import type { ClaudeInstance } from '../types'

interface TerminalEntry {
  term: Terminal
  fitAddon: FitAddon
  searchAddon: SearchAddon
  proxy: TerminalProxy
  unsub?: () => void
}

interface Props {
  instance: ClaudeInstance
  onKill: (id: string) => void
  onRestart: (id: string) => void
  onRemove: (id: string) => void
  terminalsRef: MutableRefObject<Map<string, TerminalEntry>>
  searchOpen?: boolean
  onSearchClose?: () => void
  fontSize?: number
}

export default function TerminalView({ instance, onKill, onRestart, onRemove, terminalsRef, searchOpen, onSearchClose, fontSize = 13 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [dragOver, setDragOver] = useState(false)
  const searchInputRef = useRef<HTMLInputElement>(null)

  // Focus search input when search opens
  useEffect(() => {
    if (searchOpen && searchInputRef.current) {
      searchInputRef.current.focus()
      searchInputRef.current.select()
    }
  }, [searchOpen])

  const scrollToBottom = useCallback(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (entry) {
      entry.proxy.onUserInput()
      entry.term.scrollToBottom()
    }
  }, [instance.id, terminalsRef])

  const scrollToTop = useCallback(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (entry) entry.term.scrollToTop()
  }, [instance.id, terminalsRef])

  const handleSearchNext = useCallback(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (entry && searchQuery) entry.searchAddon.findNext(searchQuery)
  }, [instance.id, terminalsRef, searchQuery])

  const handleSearchPrev = useCallback(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (entry && searchQuery) entry.searchAddon.findPrevious(searchQuery)
  }, [instance.id, terminalsRef, searchQuery])

  const handleSearchKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (e.shiftKey) handleSearchPrev()
      else handleSearchNext()
    }
    if (e.key === 'Escape') {
      const entry = terminalsRef.current.get(instance.id)
      entry?.searchAddon.clearDecorations()
      setSearchQuery('')
      onSearchClose?.()
    }
  }, [handleSearchNext, handleSearchPrev, instance.id, onSearchClose, terminalsRef])

  // Live search as you type
  useEffect(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (!entry) return
    if (searchQuery) {
      entry.searchAddon.findNext(searchQuery)
    } else {
      entry.searchAddon.clearDecorations()
    }
  }, [searchQuery, instance.id, terminalsRef])

  useEffect(() => {
    if (!containerRef.current || initializedRef.current) return
    initializedRef.current = true

    let existing = terminalsRef.current.get(instance.id)

    if (!existing) {
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
      const searchAddon = new SearchAddon()
      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        window.api.shell.openExternal(uri)
      })
      term.loadAddon(fitAddon)
      term.loadAddon(searchAddon)
      term.loadAddon(webLinksAddon)

      const proxy = new TerminalProxy(term)

      term.onData((data) => {
        proxy.onUserInput()
        window.api.instance.write(instance.id, data)
      })

      const unsub = window.api.instance.onOutput(({ id, data }) => {
        if (id === instance.id) {
          proxy.write(data)
        }
      })

      existing = { term, fitAddon, searchAddon, proxy, unsub }
      terminalsRef.current.set(instance.id, existing)

      window.api.instance.buffer(instance.id).then((buf) => {
        if (buf) proxy.write(buf)
      })
    }

    existing.term.open(containerRef.current)

    requestAnimationFrame(() => {
      existing!.fitAddon.fit()
      const dims = existing!.fitAddon.proposeDimensions()
      if (dims) {
        window.api.instance.resize(instance.id, dims.cols, dims.rows)
      }
    })

    const instanceId = instance.id
    const fitAddon = existing.fitAddon
    let lastCols = 0
    let lastRows = 0

    const doFit = () => {
      const container = containerRef.current
      if (!container) return
      const wrapper = container.closest('.terminal-wrapper')
      if (wrapper && !wrapper.classList.contains('visible')) return
      if (container.offsetHeight === 0 || container.offsetWidth === 0) return

      try {
        fitAddon.fit()
        const dims = fitAddon.proposeDimensions()
        if (dims && (dims.cols !== lastCols || dims.rows !== lastRows)) {
          lastCols = dims.cols
          lastRows = dims.rows
          window.api.instance.resize(instanceId, dims.cols, dims.rows)
        }
      } catch { /* */ }
    }

    const observer = new ResizeObserver(doFit)
    observer.observe(containerRef.current)

    let resizeTimer: ReturnType<typeof setTimeout> | null = null
    const onWindowResize = () => {
      if (resizeTimer) clearTimeout(resizeTimer)
      resizeTimer = setTimeout(doFit, 50)
    }
    window.addEventListener('resize', onWindowResize)

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', onWindowResize)
      if (resizeTimer) clearTimeout(resizeTimer)
    }
  }, [instance.id])

  // Update font size when prop changes
  useEffect(() => {
    const entry = terminalsRef.current.get(instance.id)
    if (!entry) return
    if (entry.term.options.fontSize !== fontSize) {
      entry.term.options.fontSize = fontSize
      entry.fitAddon.fit()
      const dims = entry.fitAddon.proposeDimensions()
      if (dims && dims.cols > 0 && dims.rows > 0) {
        window.api.instance.resize(instance.id, dims.cols, dims.rows)
      }
    }
  }, [fontSize, instance.id, terminalsRef])

  // Drag & drop — paste file path into terminal
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback(() => {
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const files = e.dataTransfer.files
    if (files.length > 0) {
      const paths = Array.from(files).map((f) => {
        const p = window.api.getPathForFile(f)
        if (!p) return null
        return p.includes(' ') ? `"${p}"` : p
      }).filter(Boolean)
      if (paths.length > 0) {
        // Write each path character by character to the PTY input
        // so the CLI's input handler picks it up naturally
        const text = paths.join(' ') + ' '
        for (const ch of text) {
          window.api.instance.write(instance.id, ch)
        }
      }
    }
  }, [instance.id])

  return (
    <>
      <div className="terminal-header">
        <div className="terminal-header-accent" style={{ backgroundColor: instance.color }} />
        <div className="terminal-header-left">
          <span className="terminal-header-name" style={{ color: instance.color }}>{instance.name}</span>
          <span className="terminal-header-dir">{instance.workingDirectory}</span>
          {instance.gitBranch && (
            <span className="terminal-header-branch">{instance.gitBranch}</span>
          )}
        </div>
        <div className="terminal-header-actions">
          {instance.status === 'running' ? (
            <button className="danger" onClick={() => onKill(instance.id)}>Kill</button>
          ) : (
            <>
              <button onClick={() => onRestart(instance.id)}>Restart</button>
              <button className="danger" onClick={() => onRemove(instance.id)}>Remove</button>
            </>
          )}
        </div>
      </div>
      <div
        className={`terminal-container ${dragOver ? 'drag-over' : ''}`}
        ref={containerRef}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {searchOpen && (
          <div className="terminal-search-bar">
            <input
              ref={searchInputRef}
              className="terminal-search-input"
              placeholder="Find..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            <button className="terminal-search-btn" onClick={handleSearchPrev}>&#9650;</button>
            <button className="terminal-search-btn" onClick={handleSearchNext}>&#9660;</button>
            <button className="terminal-search-btn" onClick={() => { setSearchQuery(''); onSearchClose?.() }}>&#10005;</button>
          </div>
        )}
        {dragOver && (
          <div className="terminal-drop-overlay">Drop to paste path</div>
        )}
        <div className="terminal-scroll-nav">
          <button className="terminal-scroll-btn" onClick={scrollToTop} title="Scroll to top">&#9650;</button>
          <button className="terminal-scroll-btn" onClick={scrollToBottom} title="Scroll to bottom">&#9660;</button>
        </div>
      </div>
    </>
  )
}
