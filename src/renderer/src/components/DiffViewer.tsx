import React, { useState, useMemo } from 'react'
import { hljs, getLangFromFilename } from '../lib/hljs'

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk'
  content: string
  oldLine: number | null
  newLine: number | null
}

interface SplitRow {
  left: { line: number | null; content: string; type: 'del' | 'context' | 'empty' | 'hunk' }
  right: { line: number | null; content: string; type: 'add' | 'context' | 'empty' | 'hunk' }
}

interface DiffViewerProps {
  diff: string
  /** Filename for syntax highlighting language detection */
  filename?: string
  /** Max lines to show before truncation (default 500) */
  maxLines?: number
}

function parseDiff(raw: string): DiffLine[] {
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0

  for (const line of raw.split('\n')) {
    if (line.startsWith('@@')) {
      // Parse hunk header: @@ -old,count +new,count @@
      const match = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (match) {
        oldLine = parseInt(match[1], 10)
        newLine = parseInt(match[2], 10)
      }
      lines.push({ type: 'hunk', content: line, oldLine: null, newLine: null })
    } else if (line.startsWith('+')) {
      lines.push({ type: 'add', content: line.slice(1), oldLine: null, newLine: newLine })
      newLine++
    } else if (line.startsWith('-')) {
      lines.push({ type: 'del', content: line.slice(1), oldLine: oldLine, newLine: null })
      oldLine++
    } else if (line.startsWith(' ')) {
      lines.push({ type: 'context', content: line.slice(1), oldLine: oldLine, newLine: newLine })
      oldLine++
      newLine++
    }
    // Skip diff headers (diff --git, index, ---, +++)
  }
  return lines
}

function buildSplitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.type === 'hunk') {
      rows.push({
        left: { line: null, content: line.content, type: 'hunk' },
        right: { line: null, content: line.content, type: 'hunk' },
      })
      i++
    } else if (line.type === 'context') {
      rows.push({
        left: { line: line.oldLine, content: line.content, type: 'context' },
        right: { line: line.newLine, content: line.content, type: 'context' },
      })
      i++
    } else {
      // Collect consecutive del+add blocks and pair them
      const dels: DiffLine[] = []
      const adds: DiffLine[] = []
      while (i < lines.length && lines[i].type === 'del') { dels.push(lines[i]); i++ }
      while (i < lines.length && lines[i].type === 'add') { adds.push(lines[i]); i++ }
      const maxLen = Math.max(dels.length, adds.length)
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          left: j < dels.length
            ? { line: dels[j].oldLine, content: dels[j].content, type: 'del' }
            : { line: null, content: '', type: 'empty' },
          right: j < adds.length
            ? { line: adds[j].newLine, content: adds[j].content, type: 'add' }
            : { line: null, content: '', type: 'empty' },
        })
      }
    }
  }
  return rows
}

function highlightContent(content: string, lang: string | null, type: string): React.ReactNode {
  if (!lang || type === 'hunk' || type === 'empty') return content
  const html = hljs.highlight(content, { language: lang }).value
  return <span dangerouslySetInnerHTML={{ __html: html }} />
}

function DiffViewer({ diff, filename, maxLines = 500 }: DiffViewerProps) {
  const [showFull, setShowFull] = useState(false)
  const [mode, setMode] = useState<'unified' | 'split'>(() =>
    (localStorage.getItem('diff-view-mode') as 'unified' | 'split') || 'unified'
  )

  const allLines = useMemo(() => parseDiff(diff), [diff])
  const splitRows = useMemo(() => mode === 'split' ? buildSplitRows(allLines) : [], [allLines, mode])

  const displayCount = mode === 'split' ? splitRows.length : allLines.length
  const isTruncated = !showFull && displayCount > maxLines
  const lines = isTruncated ? allLines.slice(0, maxLines) : allLines
  const visibleSplitRows = isTruncated ? splitRows.slice(0, maxLines) : splitRows

  const lang = useMemo(() => filename ? getLangFromFilename(filename) : null, [filename])

  const toggleMode = () => {
    const next = mode === 'unified' ? 'split' : 'unified'
    setMode(next)
    localStorage.setItem('diff-view-mode', next)
  }

  if (!diff.trim()) {
    return <div className="diff-viewer-empty">No diff content.</div>
  }

  // Detect binary files
  if (/Binary files .* differ/.test(diff)) {
    return <div className="diff-viewer-empty">Binary file — diff not available.</div>
  }

  return (
    <div className="diff-viewer">
      <div className="diff-toolbar">
        <button className="diff-mode-toggle" onClick={toggleMode}>
          {mode === 'unified' ? 'Split' : 'Unified'}
        </button>
      </div>
      {mode === 'split' ? (
        <div className="diff-split">
          {visibleSplitRows.map((row, i) => (
            row.left.type === 'hunk' ? (
              <div key={i} className="diff-split-row diff-split-hunk">
                <div className="diff-split-cell diff-hunk" style={{ gridColumn: '1 / -1' }}>
                  <span className="diff-content">{row.left.content}</span>
                </div>
              </div>
            ) : (
              <div key={i} className="diff-split-row">
                <div className={`diff-split-cell diff-split-left diff-${row.left.type}`}>
                  <span className="diff-gutter">{row.left.line ?? ''}</span>
                  <span className="diff-content">
                    {highlightContent(row.left.content, lang, row.left.type)}
                  </span>
                </div>
                <div className={`diff-split-cell diff-split-right diff-${row.right.type}`}>
                  <span className="diff-gutter">{row.right.line ?? ''}</span>
                  <span className="diff-content">
                    {highlightContent(row.right.content, lang, row.right.type)}
                  </span>
                </div>
              </div>
            )
          ))}
        </div>
      ) : (
        lines.map((line, i) => {
          const highlighted = lang && line.type !== 'hunk'
            ? hljs.highlight(line.content, { language: lang }).value
            : null
          return (
            <div key={i} className={`diff-line diff-${line.type}`}>
              <span className="diff-gutter diff-gutter-old">
                {line.oldLine ?? ''}
              </span>
              <span className="diff-gutter diff-gutter-new">
                {line.newLine ?? ''}
              </span>
              {highlighted ? (
                <span
                  className="diff-content"
                  dangerouslySetInnerHTML={{ __html: highlighted }}
                />
              ) : (
                <span className="diff-content">
                  {line.content}
                </span>
              )}
            </div>
          )
        })
      )}
      {isTruncated && (
        <div className="diff-truncated">
          <button onClick={() => setShowFull(true)}>
            Show full diff ({displayCount} lines)
          </button>
        </div>
      )}
    </div>
  )
}

export default DiffViewer
