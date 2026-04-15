import { describe, it, expect } from 'vitest'
import { extractTicketKey } from '../ticket-commit-format'

describe('extractTicketKey', () => {
  it('extracts ticket key from a branch name (case-insensitive, uppercased)', () => {
    expect(extractTicketKey('np-7663/mcp-tools-as-code', '[A-Z]+-\\d+')).toBe('NP-7663')
  })

  it('returns null when branch does not contain a ticket key', () => {
    expect(extractTicketKey('develop', '[A-Z]+-\\d+')).toBeNull()
  })

  it('returns null for an invalid regex pattern', () => {
    expect(extractTicketKey('NP-7663/foo', '[invalid')).toBeNull()
  })
})
