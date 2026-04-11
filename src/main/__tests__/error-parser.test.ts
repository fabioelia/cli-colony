import { describe, it, expect } from 'vitest'
import { parseErrorSummary } from '../error-parser'

describe('parseErrorSummary', () => {
  it('returns null for empty buffer', () => {
    expect(parseErrorSummary('')).toBeNull()
    expect(parseErrorSummary(null as any)).toBeNull()
  })

  it('returns null when no error pattern found', () => {
    expect(parseErrorSummary('All good\nDone.\n')).toBeNull()
  })

  // ---- Python tracebacks ----

  it('parses a Python traceback', () => {
    const buffer = [
      'Some earlier output',
      'Traceback (most recent call last):',
      '  File "/app/main.py", line 42, in run',
      '    result = process(data)',
      '  File "/app/utils.py", line 10, in process',
      '    raise ValueError("invalid input")',
      'ValueError: invalid input',
    ].join('\n')

    const result = parseErrorSummary(buffer)
    expect(result).not.toBeNull()
    expect(result!.errorType).toBe('ValueError')
    expect(result!.message).toBe('invalid input')
    expect(result!.file).toBe('/app/utils.py')
    expect(result!.line).toBe(10)
    expect(result!.snippet.length).toBeGreaterThan(0)
    expect(result!.snippet.some(l => l.includes('ValueError'))).toBe(true)
  })

  it('handles Python traceback with multi-word error', () => {
    const buffer = [
      'Traceback (most recent call last):',
      '  File "test.py", line 1, in <module>',
      '    import nonexistent',
      'ModuleNotFoundError: No module named \'nonexistent\'',
    ].join('\n')

    const result = parseErrorSummary(buffer)
    expect(result).not.toBeNull()
    expect(result!.errorType).toBe('ModuleNotFoundError')
    expect(result!.message).toContain('No module named')
  })

  // ---- Node stack traces ----

  it('parses a Node.js stack trace', () => {
    const buffer = [
      'Starting server...',
      'TypeError: Cannot read properties of undefined (reading \'map\')',
      '    at processItems (/app/src/handler.ts:25:10)',
      '    at Object.<anonymous> (/app/src/index.ts:8:1)',
    ].join('\n')

    const result = parseErrorSummary(buffer)
    expect(result).not.toBeNull()
    expect(result!.errorType).toBe('TypeError')
    expect(result!.message).toContain('Cannot read properties')
    expect(result!.file).toBe('/app/src/handler.ts')
    expect(result!.line).toBe(25)
    expect(result!.snippet.length).toBeGreaterThan(0)
  })

  it('parses Node Error without parens in stack', () => {
    const buffer = [
      'Error: ENOENT: no such file or directory',
      '    at /app/loader.js:12:5',
    ].join('\n')

    const result = parseErrorSummary(buffer)
    expect(result).not.toBeNull()
    expect(result!.errorType).toBe('Error')
    expect(result!.message).toContain('ENOENT')
    expect(result!.file).toBe('/app/loader.js')
    expect(result!.line).toBe(12)
  })

  // ---- Generic errors ----

  it('parses a generic FAILED line', () => {
    const buffer = 'Build output\nTests: 5 passed\nFAILED: 2 tests did not pass\nDone.\n'
    const result = parseErrorSummary(buffer)
    expect(result).not.toBeNull()
    expect(result!.errorType).toBe('Failed')
    expect(result!.message).toContain('2 tests did not pass')
  })

  it('parses a generic FATAL line', () => {
    const buffer = 'Starting...\nFATAL: out of memory\n'
    const result = parseErrorSummary(buffer)
    expect(result).not.toBeNull()
    expect(result!.errorType).toBe('Fatal')
    expect(result!.message).toContain('out of memory')
  })

  it('parses a generic Error: line', () => {
    const buffer = 'npm ERR! code E404\nerror: package not found\n'
    const result = parseErrorSummary(buffer)
    expect(result).not.toBeNull()
    expect(result!.errorType).toBe('Error')
  })

  // ---- ANSI stripping ----

  it('strips ANSI codes before parsing', () => {
    const buffer = '\x1b[31mTraceback (most recent call last):\x1b[0m\n  File "x.py", line 1\nKeyError: \'missing\'\n'
    const result = parseErrorSummary(buffer)
    expect(result).not.toBeNull()
    expect(result!.errorType).toBe('KeyError')
    expect(result!.message).toBe("'missing'")
  })

  // ---- Specificity ordering ----

  it('prefers Python traceback over generic error', () => {
    const buffer = [
      'error: something earlier',
      'Traceback (most recent call last):',
      '  File "x.py", line 5, in main',
      '    foo()',
      'RuntimeError: bad state',
    ].join('\n')

    const result = parseErrorSummary(buffer)
    expect(result!.errorType).toBe('RuntimeError')
    expect(result!.file).toBe('x.py')
  })

  // ---- Tail truncation ----

  it('only parses the last 2KB of output', () => {
    // Put the actual error within the last 2KB
    const padding = 'x'.repeat(3000) + '\n'
    const error = 'TypeError: boom\n    at fn (/a.js:1:1)\n'
    const result = parseErrorSummary(padding + error)
    expect(result).not.toBeNull()
    expect(result!.errorType).toBe('TypeError')
  })

  it('ignores errors outside the last 2KB window', () => {
    // Error is beyond the 2KB tail — should not match
    const error = 'TypeError: old error\n    at fn (/a.js:1:1)\n'
    const padding = 'all good line\n'.repeat(200)
    const result = parseErrorSummary(error + padding)
    expect(result).toBeNull()
  })

  // ---- snippet content ----

  it('snippet contains relevant context lines', () => {
    const buffer = [
      'line 1',
      'line 2',
      'Traceback (most recent call last):',
      '  File "main.py", line 10',
      '    do_thing()',
      'NameError: name \'do_thing\' is not defined',
    ].join('\n')

    const result = parseErrorSummary(buffer)
    expect(result!.snippet.length).toBeLessThanOrEqual(5)
    expect(result!.snippet.some(l => l.includes('NameError'))).toBe(true)
  })
})
