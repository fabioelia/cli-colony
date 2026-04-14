/**
 * Smoke tests for MarkdownViewer.
 *
 * Uses react-dom/server.renderToString — mermaid is lazy-loaded in a
 * useEffect that never fires during SSR, so we only assert the initial
 * markup: mermaid fenced blocks render to a placeholder div carrying the
 * raw source, while other languages keep syntax highlighting.
 */

import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToString } from 'react-dom/server'

describe('MarkdownViewer', () => {
  it('module loads without errors', async () => {
    const mod = await import('../MarkdownViewer')
    expect(mod.default).toBeDefined()
  })

  it('renders a mermaid fenced block as a placeholder div with the raw source', async () => {
    const { default: MarkdownViewer } = await import('../MarkdownViewer')
    const md = '```mermaid\ngraph TD\nA-->B\n```'
    const html = renderToString(React.createElement(MarkdownViewer, { content: md }))
    expect(html).toContain('mermaid-block')
    expect(html).toContain('data-source=')
    // Raw source preserved (HTML-escaped) inside data-source
    expect(html).toContain('graph TD')
    // Still wrapped in copy button scaffolding
    expect(html).toContain('code-copy-btn')
    // Label shows "mermaid"
    expect(html).toContain('>mermaid<')
  })

  it('does not treat non-mermaid code blocks as mermaid', async () => {
    const { default: MarkdownViewer } = await import('../MarkdownViewer')
    const md = '```js\nconst x = 1\n```'
    const html = renderToString(React.createElement(MarkdownViewer, { content: md }))
    expect(html).not.toContain('mermaid-block')
    expect(html).toContain('language-js')
  })

  it('escapes HTML in mermaid source to prevent injection via data-source', async () => {
    const { default: MarkdownViewer } = await import('../MarkdownViewer')
    const md = '```mermaid\ngraph TD\nA["<script>bad</script>"]\n```'
    const html = renderToString(React.createElement(MarkdownViewer, { content: md }))
    expect(html).toContain('mermaid-block')
    expect(html).not.toContain('<script>bad</script>')
    expect(html).toContain('&lt;script&gt;')
  })

  it('renders plain markdown text', async () => {
    const { default: MarkdownViewer } = await import('../MarkdownViewer')
    const html = renderToString(React.createElement(MarkdownViewer, { content: '# Hello' }))
    expect(html).toContain('<h1')
    expect(html).toContain('Hello')
  })
})
