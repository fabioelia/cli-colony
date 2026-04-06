import { describe, it, expect } from 'vitest'
import { genId, slugify, resolveMustacheTemplate, parseFrontmatter, stripAnsi } from '../utils'

describe('genId', () => {
  it('returns a non-empty string', () => {
    expect(typeof genId()).toBe('string')
    expect(genId().length).toBeGreaterThan(0)
  })

  it('has the expected format with hyphens', () => {
    const id = genId()
    const parts = id.split('-')
    // format: xxxxxxxxxxxxxxxx-xxxxxxxx-xxxxxxxx (one or more hyphen-separated segments)
    expect(parts.length).toBeGreaterThanOrEqual(2)
  })

  it('generates unique IDs', () => {
    const ids = new Set(Array.from({ length: 100 }, () => genId()))
    expect(ids.size).toBe(100)
  })
})

describe('slugify', () => {
  it('lowercases input', () => {
    expect(slugify('Hello World')).toBe('hello-world')
  })

  it('replaces spaces with hyphens', () => {
    expect(slugify('foo bar baz')).toBe('foo-bar-baz')
  })

  it('removes leading and trailing hyphens', () => {
    expect(slugify('  hello  ')).toBe('hello')
    expect(slugify('-hello-')).toBe('hello')
  })

  it('collapses multiple non-alphanumeric chars into one hyphen', () => {
    expect(slugify('hello---world')).toBe('hello-world')
    expect(slugify('hello   world')).toBe('hello-world')
    expect(slugify('hello!@#world')).toBe('hello-world')
  })

  it('returns "unnamed" for empty or all-symbol input', () => {
    expect(slugify('')).toBe('unnamed')
    expect(slugify('!!!!')).toBe('unnamed')
  })

  it('caps length at 60 characters', () => {
    const long = 'a'.repeat(80)
    expect(slugify(long).length).toBe(60)
  })

  it('handles mixed alphanumeric', () => {
    expect(slugify('My Feature v2.0')).toBe('my-feature-v2-0')
  })
})

describe('resolveMustacheTemplate', () => {
  it('replaces simple keys', () => {
    expect(resolveMustacheTemplate('Hello {{name}}!', { name: 'world' })).toBe('Hello world!')
  })

  it('resolves dot-separated paths', () => {
    expect(
      resolveMustacheTemplate('{{user.email}}', { user: { email: 'a@b.com' } })
    ).toBe('a@b.com')
  })

  it('joins arrays with comma', () => {
    expect(
      resolveMustacheTemplate('{{items}}', { items: ['a', 'b', 'c'] })
    ).toBe('a, b, c')
  })

  it('returns empty string for missing keys', () => {
    expect(resolveMustacheTemplate('{{missing}}', {})).toBe('')
  })

  it('returns empty string for null/undefined values', () => {
    expect(resolveMustacheTemplate('{{val}}', { val: null })).toBe('')
    expect(resolveMustacheTemplate('{{val}}', { val: undefined })).toBe('')
  })

  it('leaves non-template text unchanged', () => {
    expect(resolveMustacheTemplate('no templates here', {})).toBe('no templates here')
  })

  it('handles multiple replacements', () => {
    expect(
      resolveMustacheTemplate('{{a}} and {{b}}', { a: 'foo', b: 'bar' })
    ).toBe('foo and bar')
  })

  it('handles deeply nested path where intermediate is null', () => {
    expect(
      resolveMustacheTemplate('{{a.b.c}}', { a: null })
    ).toBe('')
  })
})

describe('stripAnsi', () => {
  it('strips standard CSI SGR sequences (colors)', () => {
    expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
  })

  it('strips DEC private sequences like [?2026l and [?2026h', () => {
    expect(stripAnsi('\x1b[?2026l\x1b[?2026hthinking')).toBe('thinking')
  })

  it('strips cursor movement CSI sequences', () => {
    expect(stripAnsi('\x1b[1A\x1b[2Ktext')).toBe('text')
  })

  it('strips OSC sequences (window title, etc.)', () => {
    expect(stripAnsi('\x1b]0;window title\x07text')).toBe('text')
    expect(stripAnsi('\x1b]2;title\x1b\\text')).toBe('text')
  })

  it('strips bare ESC + letter (DECSC, RIS)', () => {
    expect(stripAnsi('\x1b7saved\x1b8')).toBe('saved')
  })

  it('removes carriage returns', () => {
    expect(stripAnsi('line1\r\nline2')).toBe('line1\nline2')
  })

  it('returns plain text unchanged', () => {
    expect(stripAnsi('hello world')).toBe('hello world')
  })

  it('handles mixed escape sequences with real content', () => {
    const raw = '\x1b[?2026l\x1b[?2026h⏺\n\x1b[?2026l\x1b[?2026hthinking with high effort'
    expect(stripAnsi(raw)).toBe('⏺\nthinking with high effort')
  })
})

describe('parseFrontmatter', () => {
  it('parses basic key-value pairs', () => {
    const content = '---\nname: test\nvalue: hello\n---\nBody'
    const result = parseFrontmatter(content)
    expect(result.name).toBe('test')
    expect(result.value).toBe('hello')
  })

  it('returns empty object when no frontmatter', () => {
    expect(parseFrontmatter('No frontmatter here')).toEqual({})
    expect(parseFrontmatter('')).toEqual({})
  })

  it('handles values with colons in them', () => {
    const content = '---\nurl: http://example.com\n---'
    const result = parseFrontmatter(content)
    expect(result.url).toBe('http://example.com')
  })

  it('trims whitespace around keys and values', () => {
    const content = '---\n  name :  test value  \n---'
    const result = parseFrontmatter(content)
    expect(result.name).toBe('test value')
  })

  it('ignores lines without colon', () => {
    const content = '---\nname: test\nno-colon-line\n---'
    const result = parseFrontmatter(content)
    expect(result.name).toBe('test')
    expect(Object.keys(result)).toHaveLength(1)
  })

  it('returns only the first frontmatter block', () => {
    const content = '---\nfirst: yes\n---\nBody\n---\nsecond: yes\n---'
    const result = parseFrontmatter(content)
    expect(result.first).toBe('yes')
    expect(result.second).toBeUndefined()
  })
})
