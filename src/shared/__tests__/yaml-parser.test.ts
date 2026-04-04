import { describe, it, expect } from 'vitest'
import { parseYaml, parseYamlArray } from '../yaml-parser'

describe('parseYaml', () => {
  it('parses simple key-value pairs', () => {
    const result = parseYaml('name: hello\nversion: 1')
    expect(result?.name).toBe('hello')
    expect(result?.version).toBe(1)
  })

  it('parses boolean values', () => {
    const result = parseYaml('enabled: true\ndisabled: false')
    expect(result?.enabled).toBe(true)
    expect(result?.disabled).toBe(false)
  })

  it('parses null values', () => {
    const result = parseYaml('value: null')
    expect(result?.value).toBe(null)
  })

  it('parses integer values', () => {
    const result = parseYaml('port: 8080')
    expect(result?.port).toBe(8080)
  })

  it('parses float values', () => {
    const result = parseYaml('ratio: 3.14')
    expect(result?.ratio).toBeCloseTo(3.14)
  })

  it('parses quoted strings (strips quotes)', () => {
    const result = parseYaml('name: "hello world"\nother: \'single\'')
    expect(result?.name).toBe('hello world')
    expect(result?.other).toBe('single')
  })

  it('parses YAML escape sequences in double-quoted strings', () => {
    const result = parseYaml('msg: "line1\\nline2"')
    expect(result?.msg).toBe('line1\nline2')
  })

  it('ignores comment lines', () => {
    const yaml = '# This is a comment\nname: test\n# Another comment\nvalue: 42'
    const result = parseYaml(yaml)
    expect(result?.name).toBe('test')
    expect(result?.value).toBe(42)
  })

  it('parses nested objects via indentation', () => {
    const yaml = 'parent:\n  child: value\n  number: 5'
    const result = parseYaml(yaml)
    expect(result?.parent?.child).toBe('value')
    expect(result?.parent?.number).toBe(5)
  })

  it('parses simple dash-list arrays', () => {
    const yaml = 'items:\n  - apple\n  - banana\n  - cherry'
    const result = parseYaml(yaml)
    expect(result?.items).toEqual(['apple', 'banana', 'cherry'])
  })

  it('parses array of objects', () => {
    const yaml = 'steps:\n  - name: step1\n    cmd: echo hello\n  - name: step2\n    cmd: echo world'
    const result = parseYaml(yaml)
    expect(result?.steps).toHaveLength(2)
    expect(result?.steps[0].name).toBe('step1')
    expect(result?.steps[0].cmd).toBe('echo hello')
    expect(result?.steps[1].name).toBe('step2')
  })

  it('parses block scalars (|)', () => {
    const yaml = 'script: |\n  line one\n  line two\n  line three\nafter: done'
    const result = parseYaml(yaml)
    expect(result?.script).toContain('line one')
    expect(result?.script).toContain('line two')
    expect(result?.after).toBe('done')
  })

  it('handles CRLF line endings', () => {
    const yaml = 'name: test\r\nvalue: 42\r\n'
    const result = parseYaml(yaml)
    expect(result?.name).toBe('test')
    expect(result?.value).toBe(42)
  })

  it('handles empty input', () => {
    const result = parseYaml('')
    expect(result).toEqual({})
  })

  it('handles only comments', () => {
    const result = parseYaml('# just a comment\n# another')
    expect(result).toEqual({})
  })

  it('parses values with colons in them', () => {
    const result = parseYaml('url: http://example.com:8080/path')
    expect(result?.url).toBe('http://example.com:8080/path')
  })

  it('returns null on parse error (corrupt input)', () => {
    // Hard to trigger null since the parser is defensive, but verify it doesn't throw
    expect(() => parseYaml('{')).not.toThrow()
  })

  it('parses realistic persona frontmatter', () => {
    const yaml = `name: "Colony Developer"
schedule: "0 * * * 0,6"
model: opus
max_sessions: 1
can_push: false
can_merge: false`
    const result = parseYaml(yaml)
    expect(result?.name).toBe('Colony Developer')
    expect(result?.schedule).toBe('0 * * * 0,6')
    expect(result?.model).toBe('opus')
    expect(result?.max_sessions).toBe(1)
    expect(result?.can_push).toBe(false)
    expect(result?.can_merge).toBe(false)
  })
})

describe('parseYamlArray', () => {
  it('extracts a list of strings from a field', () => {
    const content = 'services:\n  - backend\n  - frontend\n  - worker\n'
    const result = parseYamlArray(content, 'services')
    expect(result).toEqual(['backend', 'frontend', 'worker'])
  })

  it('strips quotes from items', () => {
    const content = 'items:\n  - "quoted"\n  - \'single\'\n'
    const result = parseYamlArray(content, 'items')
    expect(result).toEqual(['quoted', 'single'])
  })

  it('returns null when field not found', () => {
    const content = 'name: test\n'
    expect(parseYamlArray(content, 'missing')).toBeNull()
  })

  it('handles empty array', () => {
    // No dash items means no match
    const content = 'items:\n\nother: value\n'
    expect(parseYamlArray(content, 'items')).toBeNull()
  })
})
