import React, { useMemo, useCallback } from 'react'
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

interface Props {
  content: string
  className?: string
  preprocessor?: (md: string) => string
}

export default function MarkdownViewer({ content, className, preprocessor }: Props) {
  const html = useMemo(() => {
    const md = preprocessor ? preprocessor(content) : content
    return markedInstance.parse(md) as string
  }, [content, preprocessor])

  const handleClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const btn = (e.target as HTMLElement).closest('.code-copy-btn') as HTMLElement | null
    if (!btn) return
    const wrapper = btn.closest('.code-block-wrapper')
    const code = wrapper?.querySelector('code')
    if (code) {
      navigator.clipboard.writeText(code.textContent || '')
      btn.textContent = 'Copied!'
      setTimeout(() => { btn.textContent = 'Copy' }, 1500)
    }
  }, [])

  return (
    <div
      className={`md-viewer${className ? ` ${className}` : ''}`}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleClick}
    />
  )
}
