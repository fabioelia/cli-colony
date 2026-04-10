import React, { useState, useMemo } from 'react'
import { hljs, getLangFromFilename } from '../lib/hljs'

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk'
  content: string
  oldLine: number | null
  newLine: number | null
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

function DiffViewer({ diff, filename, maxLines = 500 }: DiffViewerProps) {
  const [showFull, setShowFull] = useState(false)

  const allLines = useMemo(() => parseDiff(diff), [diff])
  const isTruncated = !showFull && allLines.length > maxLines
  const lines = isTruncated ? allLines.slice(0, maxLines) : allLines

  const lang = useMemo(() => filename ? getLangFromFilename(filename) : null, [filename])

  if (!diff.trim()) {
    return <div className="diff-viewer-empty">No diff content.</div>
  }

  // Detect binary files
  if (/Binary files .* differ/.test(diff)) {
    return <div className="diff-viewer-empty">Binary file — diff not available.</div>
  }

  return (
    <div className="diff-viewer">
      {lines.map((line, i) => {
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
      })}
      {isTruncated && (
        <div className="diff-truncated">
          <button onClick={() => setShowFull(true)}>
            Show full diff ({allLines.length} lines)
          </button>
        </div>
      )}
    </div>
  )
}

export default DiffViewer
