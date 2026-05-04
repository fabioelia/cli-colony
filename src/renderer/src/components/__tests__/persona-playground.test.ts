import { describe, it, expect } from 'vitest'
import { extractRoleSection, replaceRoleSection, diffLines } from '../PersonaPlayground'

describe('extractRoleSection', () => {
  it('extracts role section between two headings', () => {
    const content = `---
name: Test
---

## Role
You are a test assistant.

## Objectives
- do things
`
    expect(extractRoleSection(content)).toBe('You are a test assistant.')
  })

  it('extracts role section when followed by --- separator', () => {
    const content = `## Role
You are helpful.

---

Some other content`
    expect(extractRoleSection(content)).toBe('You are helpful.')
  })

  it('extracts role section when it is the last section', () => {
    const content = `## Role
You are the last persona.`
    expect(extractRoleSection(content)).toBe('You are the last persona.')
  })

  it('returns empty string when no Role heading found', () => {
    const content = `## Objectives\n- do things\n`
    expect(extractRoleSection(content)).toBe('')
  })

  it('trims whitespace from single-line role without blank separator', () => {
    const content = `## Role\nTrimmed role.   \n\n## Objectives\n`
    expect(extractRoleSection(content)).toBe('Trimmed role.')
  })

  it('captures all lines when role body has multiple lines', () => {
    const content = `## Role\nLine one.\nLine two.\nLine three.\n\n## Objectives\n`
    expect(extractRoleSection(content)).toBe('Line one.\nLine two.\nLine three.')
  })

  it('captures role content even when blank line follows ## Role heading', () => {
    const content = `## Role\n\n  Indented role.\n\n## Objectives\n`
    expect(extractRoleSection(content)).toBe('Indented role.')
  })
})

describe('replaceRoleSection', () => {
  const base = `---
name: Test
---

## Role
Old role content.

## Objectives
- do things
`

  it('replaces role content with new value', () => {
    const result = replaceRoleSection(base, 'New role content.')
    expect(result).toContain('New role content.')
    expect(result).not.toContain('Old role content.')
  })

  it('preserves content before Role heading', () => {
    const result = replaceRoleSection(base, 'New role.')
    expect(result).toContain('name: Test')
  })

  it('preserves content after Role heading', () => {
    const result = replaceRoleSection(base, 'New role.')
    expect(result).toContain('## Objectives')
    expect(result).toContain('- do things')
  })

  it('returns original content unchanged when no Role heading exists', () => {
    const noRole = `## Objectives\n- do things\n`
    expect(replaceRoleSection(noRole, 'New role.')).toBe(noRole)
  })

  it('round-trips: extract then replace produces original role', () => {
    const extracted = extractRoleSection(base)
    const replaced = replaceRoleSection(base, extracted)
    expect(extractRoleSection(replaced)).toBe(extracted)
  })
})

describe('diffLines', () => {
  it('marks identical lines as same', () => {
    const result = diffLines('line1\nline2', 'line1\nline2')
    expect(result).toEqual([
      { type: 'same', text: 'line1' },
      { type: 'same', text: 'line2' }
    ])
  })

  it('marks added lines', () => {
    const result = diffLines('line1', 'line1\nline2')
    expect(result.find(l => l.type === 'add')).toEqual({ type: 'add', text: 'line2' })
  })

  it('marks removed lines', () => {
    const result = diffLines('line1\nline2', 'line1')
    expect(result.find(l => l.type === 'remove')).toEqual({ type: 'remove', text: 'line2' })
  })

  it('marks changed lines as remove+add pair', () => {
    const result = diffLines('old', 'new')
    expect(result).toEqual([
      { type: 'remove', text: 'old' },
      { type: 'add', text: 'new' }
    ])
  })

  it('returns empty array for empty inputs', () => {
    expect(diffLines('', '')).toEqual([{ type: 'same', text: '' }])
  })

  it('handles empty original: empty string becomes remove, added lines become add', () => {
    const result = diffLines('', 'line1\nline2')
    // oLines=[''], mLines=['line1','line2']: first pair mismatches (''!=='line1') → remove''+add'line1', then add'line2'
    expect(result.find(l => l.type === 'remove')).toEqual({ type: 'remove', text: '' })
    expect(result.some(l => l.type === 'add' && l.text === 'line1')).toBe(true)
    expect(result.some(l => l.type === 'add' && l.text === 'line2')).toBe(true)
  })

  it('handles empty modified (all removes)', () => {
    const result = diffLines('line1\nline2', '')
    expect(result.some(l => l.type === 'remove' && l.text === 'line1')).toBe(true)
    expect(result.some(l => l.type === 'remove' && l.text === 'line2')).toBe(true)
  })
})
