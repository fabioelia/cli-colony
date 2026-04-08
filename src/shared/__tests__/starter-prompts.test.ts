import { describe, it, expect } from 'vitest'
import { STARTER_PROMPTS } from '../starter-prompts'

describe('starter-prompts', () => {
  it('has exactly 4 prompts', () => {
    // The Sessions empty state lays them out in a 2×2 grid — more than 4
    // breaks the layout and paralyzes new users with choices.
    expect(STARTER_PROMPTS).toHaveLength(4)
  })

  it('all ids are unique', () => {
    const ids = STARTER_PROMPTS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('all ids are non-empty slugs', () => {
    for (const p of STARTER_PROMPTS) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/)
    }
  })

  it('all entries have a non-empty title, description, and icon name', () => {
    for (const p of STARTER_PROMPTS) {
      expect(p.title.trim().length).toBeGreaterThan(0)
      expect(p.description.trim().length).toBeGreaterThan(0)
      expect(p.icon.trim().length).toBeGreaterThan(0)
    }
  })

  it('contains a blank-start option with an empty prompt', () => {
    const blank = STARTER_PROMPTS.find((p) => p.id === 'blank')
    expect(blank).toBeDefined()
    expect(blank!.prompt).toBe('')
  })

  it('all non-blank prompts are meaningful (>20 chars) so Claude has something to work with', () => {
    for (const p of STARTER_PROMPTS) {
      if (p.id === 'blank') continue
      expect(p.prompt.length).toBeGreaterThan(20)
    }
  })

  it('icon names are PascalCase Lucide identifiers', () => {
    for (const p of STARTER_PROMPTS) {
      expect(p.icon).toMatch(/^[A-Z][A-Za-z0-9]+$/)
    }
  })
})
