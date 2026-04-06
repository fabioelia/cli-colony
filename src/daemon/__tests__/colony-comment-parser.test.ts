/**
 * Unit tests for the COLONY_COMMENT sentinel parser used in pty-daemon.ts.
 *
 * The logic under test is in pty-daemon.ts `onData` handler — we replicate it
 * here rather than importing the daemon (which spawns real PTY processes).
 *
 * Sentinel format: COLONY_COMMENT:<file>:<line>:<severity>:<message>
 *
 * Behavior:
 *  - Sentinel lines are stripped from PTY output (not forwarded to terminal)
 *  - Parsed comments are accumulated in instance.comments[]
 *  - Partial-line buffering handles chunks that split mid-line
 */

import { describe, it, expect } from 'vitest'
import type { ColonyComment } from '../../shared/types'

// ---- Replicate exact sentinel-parsing logic from pty-daemon.ts onData ----

const ANSI_REGEX = /\x1B\[[0-9;]*[a-zA-Z]|\x1B\][\s\S]*?(\x07|\x1B\\)/g
const SENTINEL_PREFIX = 'COLONY_COMMENT:'

interface ParseResult {
  comments: ColonyComment[]
  filteredData: string
}

/**
 * Process a single PTY data chunk, extracting COLONY_COMMENT sentinels.
 * Returns the stripped output and any parsed comments.
 * Accepts an optional lineBuffer (partial line carried over from previous chunk).
 */
function parseChunk(data: string, lineBuffer = ''): ParseResult & { lineBuffer: string } {
  const combined = lineBuffer + data
  const rawLines = combined.split('\n')
  const partial = rawLines.pop()! // last element is partial (or empty if trailing \n)
  const comments: ColonyComment[] = []
  const filteredLines: string[] = []

  for (const line of rawLines) {
    const stripped = line.replace(ANSI_REGEX, '').trim()
    if (stripped.startsWith(SENTINEL_PREFIX)) {
      const rest = stripped.slice(SENTINEL_PREFIX.length)
      const colonIdx1 = rest.indexOf(':')
      const colonIdx2 = colonIdx1 >= 0 ? rest.indexOf(':', colonIdx1 + 1) : -1
      const colonIdx3 = colonIdx2 >= 0 ? rest.indexOf(':', colonIdx2 + 1) : -1
      if (colonIdx1 > 0 && colonIdx2 > colonIdx1 && colonIdx3 > colonIdx2) {
        const file = rest.slice(0, colonIdx1)
        const lineNum = parseInt(rest.slice(colonIdx1 + 1, colonIdx2), 10)
        const sev = rest.slice(colonIdx2 + 1, colonIdx3)
        const message = rest.slice(colonIdx3 + 1)
        if (!isNaN(lineNum) && ['error', 'warn', 'info'].includes(sev) && message) {
          comments.push({
            file,
            line: lineNum,
            severity: sev as ColonyComment['severity'],
            message,
          })
        }
      }
    } else {
      filteredLines.push(line)
    }
  }

  const filteredData = filteredLines.length > 0 ? filteredLines.join('\n') + '\n' : ''
  return { comments, filteredData, lineBuffer: partial }
}

// ---- Tests ----

describe('colony-comment-parser: basic parsing', () => {
  it('parses a warn sentinel', () => {
    const { comments } = parseChunk('COLONY_COMMENT:src/foo.ts:42:warn:Null check missing\n')
    expect(comments).toHaveLength(1)
    expect(comments[0]).toEqual({
      file: 'src/foo.ts',
      line: 42,
      severity: 'warn',
      message: 'Null check missing',
    })
  })

  it('parses an error sentinel', () => {
    const { comments } = parseChunk('COLONY_COMMENT:src/bar.ts:10:error:Unsafe cast\n')
    expect(comments[0].severity).toBe('error')
    expect(comments[0].line).toBe(10)
  })

  it('parses an info sentinel', () => {
    const { comments } = parseChunk('COLONY_COMMENT:lib/utils.ts:1:info:Consider extracting helper\n')
    expect(comments[0].severity).toBe('info')
    expect(comments[0].message).toBe('Consider extracting helper')
  })

  it('preserves colons in message', () => {
    const { comments } = parseChunk('COLONY_COMMENT:src/x.ts:5:warn:Expected: string, got: number\n')
    expect(comments[0].message).toBe('Expected: string, got: number')
  })
})

describe('colony-comment-parser: stripping from output', () => {
  it('strips sentinel line from filteredData', () => {
    const { filteredData } = parseChunk('COLONY_COMMENT:src/foo.ts:42:warn:msg\n')
    expect(filteredData).toBe('')
  })

  it('strips sentinel and keeps surrounding lines', () => {
    const data = 'Line before\nCOLONY_COMMENT:src/foo.ts:5:warn:Bad code\nLine after\n'
    const { filteredData, comments } = parseChunk(data)
    expect(filteredData).toBe('Line before\nLine after\n')
    expect(comments).toHaveLength(1)
  })

  it('keeps normal output when no sentinels', () => {
    const data = 'Some output\nMore output\n'
    const { filteredData, comments } = parseChunk(data)
    expect(filteredData).toBe(data)
    expect(comments).toHaveLength(0)
  })
})

describe('colony-comment-parser: multiple sentinels in one chunk', () => {
  it('parses two sentinels from the same chunk', () => {
    const data = [
      'COLONY_COMMENT:src/a.ts:1:warn:First',
      'COLONY_COMMENT:src/b.ts:2:error:Second',
      '',
    ].join('\n')
    const { comments, filteredData } = parseChunk(data)
    expect(comments).toHaveLength(2)
    expect(comments[0].file).toBe('src/a.ts')
    expect(comments[1].file).toBe('src/b.ts')
    expect(filteredData).toBe('')
  })

  it('parses sentinel mixed with normal output', () => {
    const data = 'Normal 1\nCOLONY_COMMENT:x.ts:3:info:Note\nNormal 2\n'
    const { comments, filteredData } = parseChunk(data)
    expect(comments).toHaveLength(1)
    expect(filteredData).toBe('Normal 1\nNormal 2\n')
  })
})

describe('colony-comment-parser: partial-line buffering', () => {
  it('buffers a partial sentinel across two chunks', () => {
    const chunk1 = 'COLONY_COMM'
    const r1 = parseChunk(chunk1)
    expect(r1.comments).toHaveLength(0)
    expect(r1.lineBuffer).toBe('COLONY_COMM') // partial line buffered

    const chunk2 = 'ENT:src/x.ts:7:warn:Partial\n'
    const r2 = parseChunk(chunk2, r1.lineBuffer)
    expect(r2.comments).toHaveLength(1)
    expect(r2.comments[0].file).toBe('src/x.ts')
    expect(r2.comments[0].line).toBe(7)
  })

  it('handles normal output split across chunks', () => {
    const r1 = parseChunk('Hello ')
    expect(r1.filteredData).toBe('')
    expect(r1.lineBuffer).toBe('Hello ')

    const r2 = parseChunk('World\n', r1.lineBuffer)
    expect(r2.filteredData).toBe('Hello World\n')
  })
})

describe('colony-comment-parser: invalid sentinels are ignored', () => {
  it('ignores sentinel with unknown severity', () => {
    const { comments } = parseChunk('COLONY_COMMENT:src/x.ts:1:debug:msg\n')
    expect(comments).toHaveLength(0)
  })

  it('ignores sentinel with non-numeric line number', () => {
    const { comments } = parseChunk('COLONY_COMMENT:src/x.ts:abc:warn:msg\n')
    expect(comments).toHaveLength(0)
  })

  it('ignores sentinel with empty message', () => {
    const { comments } = parseChunk('COLONY_COMMENT:src/x.ts:1:warn:\n')
    expect(comments).toHaveLength(0)
  })

  it('ignores malformed sentinel with too few parts', () => {
    const { comments } = parseChunk('COLONY_COMMENT:src/x.ts:1\n')
    expect(comments).toHaveLength(0)
  })

  it('does not strip non-sentinel lines starting with COLONY_COMMENT prefix substring', () => {
    const data = 'COLONY_COMMENTS_ARE_COOL\n'
    const { filteredData, comments } = parseChunk(data)
    // "COLONY_COMMENTS_ARE_COOL" does not start with COLONY_COMMENT:
    expect(filteredData).toBe(data)
    expect(comments).toHaveLength(0)
  })
})

describe('colony-comment-parser: ANSI stripping', () => {
  it('strips ANSI codes before sentinel detection', () => {
    // Sentinel wrapped in ANSI color codes
    const ansiLine = '\x1B[32mCOLONY_COMMENT:src/z.ts:99:info:Green note\x1B[0m\n'
    const { comments, filteredData } = parseChunk(ansiLine)
    expect(comments).toHaveLength(1)
    expect(comments[0].line).toBe(99)
    expect(filteredData).toBe('')
  })
})
