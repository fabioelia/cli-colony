import { describe, it, expect } from 'vitest'
import { firstErrorOf } from '../pipeline-stats'

describe('firstErrorOf', () => {
  it('returns null when entry has no stages', () => {
    expect(firstErrorOf({})).toBeNull()
    expect(firstErrorOf({ stages: [] })).toBeNull()
  })

  it('returns null when stages have no errors', () => {
    expect(firstErrorOf({
      stages: [
        { error: undefined },
        { error: '' },
      ]
    })).toBeNull()
  })

  it('returns first top-level stage error', () => {
    expect(firstErrorOf({
      stages: [
        { error: 'first error' },
        { error: 'second error' },
      ]
    })).toBe('first error')
  })

  it('recurses into subStages for nested parallel errors', () => {
    expect(firstErrorOf({
      stages: [
        {
          // parallel stage with no direct error
          subStages: [
            { error: undefined },
            { error: 'nested error' },
          ]
        }
      ]
    })).toBe('nested error')
  })
})
