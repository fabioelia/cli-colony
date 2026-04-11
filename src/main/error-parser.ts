/**
 * Parse PTY output buffer for structured error information when a session exits non-zero.
 * Supports Python tracebacks, Node stack traces, and generic error lines.
 */

import type { ErrorSummary } from '../shared/types'
import { stripAnsi } from '../shared/utils'

const MAX_PARSE_BYTES = 2048

/**
 * Attempt to extract a structured error from the tail of a PTY buffer.
 * Returns null if no recognisable error pattern is found.
 */
export function parseErrorSummary(rawBuffer: string): ErrorSummary | null {
  if (!rawBuffer) return null
  const cleaned = stripAnsi(rawBuffer)
  const tail = cleaned.slice(-MAX_PARSE_BYTES)
  const lines = tail.split('\n')

  // Try patterns in specificity order
  return parsePythonTraceback(lines)
    ?? parseNodeStackTrace(lines)
    ?? parseGenericError(lines)
}

/** Python: Traceback (most recent call last): ... SomeError: message */
function parsePythonTraceback(lines: string[]): ErrorSummary | null {
  // Find last Traceback header
  let tbStart = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].includes('Traceback (most recent call last)')) { tbStart = i; break }
  }
  if (tbStart < 0) return null

  // The actual error is the last non-empty line after the traceback
  let errorLine = ''
  for (let i = lines.length - 1; i > tbStart; i--) {
    const trimmed = lines[i].trim()
    if (trimmed) { errorLine = trimmed; break }
  }
  if (!errorLine) return null

  const colonIdx = errorLine.indexOf(':')
  const errorType = colonIdx > 0 ? errorLine.slice(0, colonIdx).trim() : 'Error'
  const message = colonIdx > 0 ? errorLine.slice(colonIdx + 1).trim() : errorLine

  // Try to extract file/line from the last File "..." line
  let file: string | undefined
  let line: number | undefined
  for (let i = lines.length - 1; i > tbStart; i--) {
    const m = lines[i].match(/File "([^"]+)", line (\d+)/)
    if (m) { file = m[1]; line = parseInt(m[2], 10); break }
  }

  // Context: last 5 lines of the traceback
  const contextStart = Math.max(tbStart, lines.length - 5)
  const snippet = lines.slice(contextStart, lines.length).filter(l => l.trim())

  return { errorType, message, file, line, snippet }
}

/** Node: Error: message\n    at Function (file:line:col) */
function parseNodeStackTrace(lines: string[]): ErrorSummary | null {
  // Find a line matching "Error: ..." or "TypeError: ..." etc followed by "    at "
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(\w*Error):\s*(.+)/)
    if (!m) continue
    // Verify at least one "    at " line follows or precedes
    const hasStack = lines.slice(i + 1, i + 6).some(l => l.trimStart().startsWith('at '))
    if (!hasStack && i < lines.length - 1) continue

    const errorType = m[1]
    const message = m[2].trim()

    // Extract file/line from first "at" line
    let file: string | undefined
    let line: number | undefined
    for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
      const atMatch = lines[j].match(/at .+?\((.+?):(\d+):\d+\)/) || lines[j].match(/at (.+?):(\d+):\d+/)
      if (atMatch) { file = atMatch[1]; line = parseInt(atMatch[2], 10); break }
    }

    const contextStart = Math.max(0, i - 1)
    const contextEnd = Math.min(lines.length, i + 5)
    const snippet = lines.slice(contextStart, contextEnd).filter(l => l.trim())

    return { errorType, message, file, line, snippet }
  }
  return null
}

/** Generic: lines containing Error:, FAILED, FATAL (case-insensitive) */
function parseGenericError(lines: string[]): ErrorSummary | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (!trimmed) continue
    const m = trimmed.match(/\b(error|FAILED|FATAL)\b[:\s]*(.*)/i)
    if (!m) continue

    const errorType = m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase()
    const message = m[2]?.trim() || trimmed

    const contextStart = Math.max(0, i - 2)
    const contextEnd = Math.min(lines.length, i + 3)
    const snippet = lines.slice(contextStart, contextEnd).filter(l => l.trim())

    return { errorType, message, snippet }
  }
  return null
}
