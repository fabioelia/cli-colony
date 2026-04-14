import React, { useMemo, useCallback, useEffect, useRef } from 'react'
import { Marked } from 'marked'
import { markedHighlight } from 'marked-highlight'
import { hljs } from '../lib/hljs'

// Configure marked with syntax highlighting
const markedInstance = new Marked(
  markedHighlight({
    highlight(code, lang) {
      if (lang && hljs.getLanguage(lang)) {
        return hljs.highlight(code, { language: lang }).value
      }
      return code
    }
  }),
  {
    renderer: {
      code({ text, lang }) {
        if (lang === 'mermaid') {
          return `<div class="code-block-wrapper mermaid-wrapper"><span class="code-lang-label">mermaid</span><button class="code-copy-btn" title="Copy source">Copy</button><div class="mermaid-block" data-source="${escapeHtml(text)}"></div></div>`
        }
        const langLabel = lang || ''
        const highlighted = lang && hljs.getLanguage(lang)
          ? hljs.highlight(text, { language: lang }).value
          : escapeHtml(text)
        return `<div class="code-block-wrapper">${
          langLabel ? `<span class="code-lang-label">${escapeHtml(langLabel)}</span>` : ''
        }<button class="code-copy-btn" title="Copy code">Copy</button><pre><code class="hljs${lang ? ` language-${escapeHtml(lang)}` : ''}">${highlighted}</code></pre></div>`
      }
    }
  }
)

function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function unescapeHtml(str: string): string {
  return str.replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&')
}

let mermaidPromise: Promise<typeof import('mermaid').default> | null = null
async function getMermaid(): Promise<typeof import('mermaid').default> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        theme: 'dark',
        securityLevel: 'strict',
        fontFamily: 'inherit'
      })
      return m.default
    })
  }
  return mermaidPromise
}

let mermaidCounter = 0

interface Props {
  content: string
  className?: string
  preprocessor?: (md: string) => string
}

export default function MarkdownViewer({ content, className, preprocessor }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  const html = useMemo(() => {
    const md = preprocessor ? preprocessor(content) : content
    return markedInstance.parse(md) as string
  }, [content, preprocessor])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const blocks = container.querySelectorAll<HTMLDivElement>('.mermaid-block:not([data-rendered="true"])')
    if (blocks.length === 0) return
    let cancelled = false
    ;(async () => {
      const mermaid = await getMermaid()
      if (cancelled) return
      for (const block of Array.from(blocks)) {
        if (block.dataset.rendered === 'true') continue
        const source = unescapeHtml(block.dataset.source || '')
        const id = `mermaid-${++mermaidCounter}`
        try {
          const { svg } = await mermaid.render(id, source)
          if (cancelled) return
          block.innerHTML = svg
          block.dataset.rendered = 'true'
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          block.innerHTML = `<div class="mermaid-error">Diagram error: ${escapeHtml(msg)}</div><pre>${escapeHtml(source)}</pre>`
          block.dataset.rendered = 'true'
        }
      }
    })()
    return () => { cancelled = true }
  }, [html])

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null
    if (!btn) return
    const wrapper = btn.closest('.code-block-wrapper')
    if (!wrapper) return
    const mermaidBlock = wrapper.querySelector<HTMLElement>('.mermaid-block')
    const text = mermaidBlock
      ? unescapeHtml(mermaidBlock.dataset.source || '')
      : (wrapper.querySelector('code')?.textContent || '')
    navigator.clipboard.writeText(text)
    btn.textContent = 'Copied!'
    setTimeout(() => { btn.textContent = 'Copy' }, 1500)
  }, [])

  return (
    <div
      ref={containerRef}
      className={`md-viewer${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  )
}
