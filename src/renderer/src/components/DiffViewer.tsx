import React, { useState, useMemo } from 'react'
import { ChevronRight, ChevronDown, Plus, Trash2, Clipboard, Check } from 'lucide-react'
import { hljs, getLangFromFilename } from '../lib/hljs'
import type { PRFile } from '../../../shared/types'

interface DiffLine {
  type: 'add' | 'del' | 'context' | 'hunk'
  content: string
  oldLine: number | null
  newLine: number | null
}

interface WordSegment {
  text: string
  changed: boolean
}

interface SplitRow {
  left: { line: number | null; content: string; type: 'del' | 'context' | 'empty' | 'hunk'; segments?: WordSegment[] }
  right: { line: number | null; content: string; type: 'add' | 'context' | 'empty' | 'hunk'; segments?: WordSegment[] }
}

interface InlineComment {
  author: string
  body: string
  createdAt: string
}

interface DiffViewerSingleProps {
  diff: string
  /** Filename for syntax highlighting language detection */
  filename?: string
  /** Max lines to show before truncation (default 500) */
  maxLines?: number
  /** PR review comments to render inline at matching line positions */
  comments?: Array<{ author: string; body: string; createdAt: string; line?: number; originalLine?: number }>
  /** Called with full patch string when user clicks "stage this hunk" */
  onStageHunk?: (patch: string) => void
  /** Called with full patch string when user clicks "discard this hunk" */
  onDiscardHunk?: (patch: string) => void
}

interface DiffViewerProps extends DiffViewerSingleProps {
  /** When provided, render a multi-file collapsible list instead of a single diff */
  files?: PRFile[]
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

function parseHunks(rawDiff: string): { fileHeader: string; hunks: string[]; canApply: boolean } {
  const lines = rawDiff.split('\n')
  const headerLines: string[] = []
  const hunks: string[] = []
  let currentHunk: string[] = []
  let inHunk = false

  for (const line of lines) {
    if (!inHunk) {
      if (line.startsWith('@@')) {
        inHunk = true
        currentHunk = [line]
      } else {
        headerLines.push(line)
      }
    } else {
      if (line.startsWith('@@')) {
        hunks.push(currentHunk.join('\n'))
        currentHunk = [line]
      } else {
        currentHunk.push(line)
      }
    }
  }
  if (inHunk && currentHunk.length > 0) hunks.push(currentHunk.join('\n'))

  const header = headerLines.join('\n')
  const canApply = header.includes('--- ') && header.includes('+++ ')
  return { fileHeader: header, hunks, canApply }
}

function computeWordDiff(oldStr: string, newStr: string): { left: WordSegment[]; right: WordSegment[] } | null {
  const oldWords = oldStr.split(/(\s+)/)
  const newWords = newStr.split(/(\s+)/)

  // Skip when lines are very different (>80% changed) or very short
  if (oldWords.length <= 1 && newWords.length <= 1) return null
  const maxLen = Math.max(oldWords.length, newWords.length)
  if (maxLen === 0) return null

  // LCS on words
  const m = oldWords.length
  const n = newWords.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldWords[i - 1] === newWords[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1])
    }
  }

  // Skip if similarity is too low (less than 20% common words)
  const lcsLen = dp[m][n]
  if (lcsLen / maxLen < 0.2) return null

  // Backtrack to find common words
  const common = new Set<string>()  // "i,j" pairs
  let i = m, j = n
  while (i > 0 && j > 0) {
    if (oldWords[i - 1] === newWords[j - 1]) {
      common.add(`${i - 1},${j - 1}`)
      i--; j--
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--
    } else {
      j--
    }
  }

  // Build segment arrays — track which old/new indices are in LCS
  const oldInLcs = new Set<number>()
  const newInLcs = new Set<number>()
  for (const key of common) {
    const [oi, ni] = key.split(',').map(Number)
    oldInLcs.add(oi)
    newInLcs.add(ni)
  }

  const buildSegments = (words: string[], inLcs: Set<number>): WordSegment[] => {
    const segs: WordSegment[] = []
    let buf = ''
    let bufChanged: boolean | null = null
    for (let k = 0; k < words.length; k++) {
      const changed = !inLcs.has(k)
      if (bufChanged !== null && changed !== bufChanged) {
        if (buf) segs.push({ text: buf, changed: bufChanged })
        buf = ''
      }
      buf += words[k]
      bufChanged = changed
    }
    if (buf && bufChanged !== null) segs.push({ text: buf, changed: bufChanged })
    return segs
  }

  return { left: buildSegments(oldWords, oldInLcs), right: buildSegments(newWords, newInLcs) }
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
        const hasBoth = j < dels.length && j < adds.length
        const wordDiff = hasBoth ? computeWordDiff(dels[j].content, adds[j].content) : null
        rows.push({
          left: j < dels.length
            ? { line: dels[j].oldLine, content: dels[j].content, type: 'del', segments: wordDiff?.left }
            : { line: null, content: '', type: 'empty' },
          right: j < adds.length
            ? { line: adds[j].newLine, content: adds[j].content, type: 'add', segments: wordDiff?.right }
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

function timeSince(dateStr: string): string {
  const secs = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000)
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`
  return `${Math.floor(secs / 86400)}d ago`
}

function buildCommentMaps(comments?: DiffViewerProps['comments']): {
  byNewLine: Map<number, InlineComment[]>
  byOldLine: Map<number, InlineComment[]>
} {
  const byNewLine = new Map<number, InlineComment[]>()
  const byOldLine = new Map<number, InlineComment[]>()
  if (!comments) return { byNewLine, byOldLine }
  for (const c of comments) {
    const entry: InlineComment = { author: c.author, body: c.body, createdAt: c.createdAt }
    if (c.line) {
      const arr = byNewLine.get(c.line) || []
      arr.push(entry)
      byNewLine.set(c.line, arr)
    }
    if (c.originalLine) {
      const arr = byOldLine.get(c.originalLine) || []
      arr.push(entry)
      byOldLine.set(c.originalLine, arr)
    }
  }
  return { byNewLine, byOldLine }
}

function InlineCommentCards({ comments, defaultCollapsed }: { comments: InlineComment[]; defaultCollapsed: boolean }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)
  return (
    <div className="diff-inline-comments">
      {collapsed ? (
        <button className="diff-inline-comments-toggle" onClick={() => setCollapsed(false)}>
          {comments.length} comment{comments.length > 1 ? 's' : ''} — click to expand
        </button>
      ) : (
        <>
          {comments.length > 3 && (
            <button className="diff-inline-comments-toggle" onClick={() => setCollapsed(true)}>
              Collapse {comments.length} comments
            </button>
          )}
          {comments.map((c, i) => (
            <div key={i} className="diff-inline-comment">
              <div className="diff-inline-comment-meta">
                <strong>{c.author}</strong>
                <span>{timeSince(c.createdAt)}</span>
              </div>
              <div className="diff-inline-comment-body">{c.body}</div>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

function DiffViewerSingle({ diff, filename, maxLines = 500, comments, onStageHunk, onDiscardHunk }: DiffViewerSingleProps) {
  const [showFull, setShowFull] = useState(false)
  const [mode, setMode] = useState<'unified' | 'split'>(() =>
    (localStorage.getItem('diff-view-mode') as 'unified' | 'split') || 'unified'
  )

  const allLines = useMemo(() => parseDiff(diff), [diff])
  const splitRows = useMemo(() => mode === 'split' ? buildSplitRows(allLines) : [], [allLines, mode])
  const commentMaps = useMemo(() => buildCommentMaps(comments), [comments])
  const totalComments = comments?.filter(c => c.line || c.originalLine).length || 0
  const defaultCollapsed = totalComments > 3
  const [copiedHunkIdx, setCopiedHunkIdx] = useState<number | null>(null)
  const hunkInfo = useMemo(() => parseHunks(diff), [diff])

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

  const buildHunkPatch = (hunkIdx: number): string => {
    if (!hunkInfo) return ''
    const hunk = hunkInfo.hunks[hunkIdx]
    if (!hunk) return ''
    return hunkInfo.fileHeader + '\n' + hunk + '\n'
  }

  if (!diff.trim()) {
    return <div className="diff-viewer-empty">No diff content.</div>
  }

  // Detect binary files
  if (/Binary files .* differ/.test(diff)) {
    return <div className="diff-viewer-empty">Binary file — diff not available.</div>
  }

  const showHunkActions = !!(hunkInfo?.canApply && (onStageHunk || onDiscardHunk))
  const showCopyHunk = !!hunkInfo?.canApply

  const handleCopyHunk = (hunkIdx: number) => {
    const patch = buildHunkPatch(hunkIdx)
    if (!patch) return
    navigator.clipboard.writeText(patch)
    setCopiedHunkIdx(hunkIdx)
    setTimeout(() => setCopiedHunkIdx(null), 2000)
  }

  return (
    <div className="diff-viewer">
      <div className="diff-toolbar">
        <button className="diff-mode-toggle" onClick={toggleMode}>
          {mode === 'unified' ? 'Split' : 'Unified'}
        </button>
      </div>
      {mode === 'split' ? (() => {
        let hunkIdx = 0
        return (
          <div className="diff-split">
            {visibleSplitRows.map((row, i) => {
              const newLineComments = row.right.line != null ? commentMaps.byNewLine.get(row.right.line) : undefined
              const oldLineComments = row.left.line != null && !newLineComments ? commentMaps.byOldLine.get(row.left.line) : undefined
              const lineComments = newLineComments || oldLineComments
              if (row.left.type === 'hunk') {
                const idx = hunkIdx++
                return (
                  <React.Fragment key={i}>
                    <div className="diff-split-row diff-split-hunk">
                      <div className="diff-split-cell diff-hunk" style={{ gridColumn: '1 / -1' }}>
                        <span className="diff-content">{row.left.content}</span>
                        {(showCopyHunk || showHunkActions) && (
                          <span className="diff-hunk-actions">
                            {showCopyHunk && (
                              <button
                                className="diff-hunk-btn diff-hunk-btn-copy"
                                title="Copy hunk to clipboard"
                                onClick={() => handleCopyHunk(idx)}
                              >
                                {copiedHunkIdx === idx ? <Check size={10} /> : <Clipboard size={10} />}
                              </button>
                            )}
                            {onStageHunk && (
                              <button
                                className="diff-hunk-btn diff-hunk-btn-stage"
                                title="Stage this hunk"
                                onClick={() => onStageHunk(buildHunkPatch(idx))}
                              >
                                <Plus size={10} />
                              </button>
                            )}
                            {onDiscardHunk && (
                              <button
                                className="diff-hunk-btn diff-hunk-btn-discard"
                                title="Discard this hunk"
                                onClick={() => onDiscardHunk(buildHunkPatch(idx))}
                              >
                                <Trash2 size={10} />
                              </button>
                            )}
                          </span>
                        )}
                      </div>
                    </div>
                  </React.Fragment>
                )
              }
              return (
                <React.Fragment key={i}>
                  <div className="diff-split-row">
                    <div className={`diff-split-cell diff-split-left diff-${row.left.type}`}>
                      <span className="diff-gutter">{row.left.line ?? ''}</span>
                      <span className="diff-content">
                        {row.left.segments
                          ? row.left.segments.map((seg, si) => seg.changed
                            ? <span key={si} className="diff-word-change">{seg.text}</span>
                            : <span key={si}>{seg.text}</span>)
                          : highlightContent(row.left.content, lang, row.left.type)}
                      </span>
                    </div>
                    <div className={`diff-split-cell diff-split-right diff-${row.right.type}`}>
                      <span className="diff-gutter">{row.right.line ?? ''}</span>
                      <span className="diff-content">
                        {row.right.segments
                          ? row.right.segments.map((seg, si) => seg.changed
                            ? <span key={si} className="diff-word-change">{seg.text}</span>
                            : <span key={si}>{seg.text}</span>)
                          : highlightContent(row.right.content, lang, row.right.type)}
                      </span>
                    </div>
                  </div>
                  {lineComments && (
                    <div className="diff-split-row diff-split-comment-row">
                      <div style={{ gridColumn: '1 / -1' }}>
                        <InlineCommentCards comments={lineComments} defaultCollapsed={defaultCollapsed} />
                      </div>
                    </div>
                  )}
                </React.Fragment>
              )
            })}
          </div>
        )
      })() : (() => {
        let hunkIdx = 0
        return (
          <>
            {lines.map((line, i) => {
              const highlighted = lang && line.type !== 'hunk'
                ? hljs.highlight(line.content, { language: lang }).value
                : null
              const newLineComments = line.newLine != null ? commentMaps.byNewLine.get(line.newLine) : undefined
              const oldLineComments = line.oldLine != null && !newLineComments ? commentMaps.byOldLine.get(line.oldLine) : undefined
              const lineComments = newLineComments || oldLineComments
              if (line.type === 'hunk') {
                const idx = hunkIdx++
                return (
                  <React.Fragment key={i}>
                    <div className="diff-line diff-hunk">
                      <span className="diff-gutter diff-gutter-old" />
                      <span className="diff-gutter diff-gutter-new" />
                      <span className="diff-content">{line.content}</span>
                      {(showCopyHunk || showHunkActions) && (
                        <span className="diff-hunk-actions">
                          {showCopyHunk && (
                            <button
                              className="diff-hunk-btn diff-hunk-btn-copy"
                              title="Copy hunk to clipboard"
                              onClick={() => handleCopyHunk(idx)}
                            >
                              {copiedHunkIdx === idx ? <Check size={10} /> : <Clipboard size={10} />}
                            </button>
                          )}
                          {onStageHunk && (
                            <button
                              className="diff-hunk-btn diff-hunk-btn-stage"
                              title="Stage this hunk"
                              onClick={() => onStageHunk(buildHunkPatch(idx))}
                            >
                              <Plus size={10} />
                            </button>
                          )}
                          {onDiscardHunk && (
                            <button
                              className="diff-hunk-btn diff-hunk-btn-discard"
                              title="Discard this hunk"
                              onClick={() => onDiscardHunk(buildHunkPatch(idx))}
                            >
                              <Trash2 size={10} />
                            </button>
                          )}
                        </span>
                      )}
                    </div>
                  </React.Fragment>
                )
              }
              return (
                <React.Fragment key={i}>
                  <div className={`diff-line diff-${line.type}`}>
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
                  {lineComments && (
                    <InlineCommentCards comments={lineComments} defaultCollapsed={defaultCollapsed} />
                  )}
                </React.Fragment>
              )
            })}
          </>
        )
      })()}
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

function DiffViewerMultiFile({ files }: { files: PRFile[] }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())

  const toggle = (filename: string) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      if (next.has(filename)) next.delete(filename)
      else next.add(filename)
      return next
    })
  }

  return (
    <div className="diff-viewer-multi">
      {files.map(file => {
        const isCollapsed = collapsed.has(file.filename)
        return (
          <div key={file.filename} className="diff-viewer-multi-file">
            <button
              className="diff-viewer-multi-header"
              onClick={() => toggle(file.filename)}
            >
              {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              <span className="diff-viewer-multi-filename">{file.filename}</span>
              <span className="diff-viewer-multi-stats">
                <span className="diff-stat-add">+{file.additions}</span>
                {' / '}
                <span className="diff-stat-del">-{file.deletions}</span>
              </span>
            </button>
            {!isCollapsed && (
              file.patch
                ? <DiffViewerSingle diff={file.patch} filename={file.filename} />
                : <div className="diff-viewer-empty">{file.filename} (no diff)</div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function DiffViewer({ files, diff, filename, maxLines, comments, onStageHunk, onDiscardHunk }: DiffViewerProps) {
  if (files && files.length > 0) {
    return <DiffViewerMultiFile files={files} />
  }
  return <DiffViewerSingle diff={diff} filename={filename} maxLines={maxLines} comments={comments} onStageHunk={onStageHunk} onDiscardHunk={onDiscardHunk} />
}

export default DiffViewer
